'use strict';

const path = require('path');
const AdmZip = require('adm-zip');
const cheerio = require('cheerio');
const {
  filterEpubCss,
  filterInlineStyle,
  normalizeXhtmlFragment,
  sanitizePublicationDocument,
} = require('./book-content');

const MAX_ENTRY_SIZE = 128 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_SIZE = 1024 * 1024 * 1024;
const MAX_SPINE_ITEMS = 10_000;

function assertReasonableArchive(zip) {
  let totalSize = 0;
  for (const entry of zip.getEntries()) {
    const size = Number(entry.header?.size || 0);
    if (!Number.isFinite(size) || size < 0 || size > MAX_ENTRY_SIZE) {
      throw new Error(`EPUB entry is too large: ${entry.entryName}`);
    }
    totalSize += size;
    if (totalSize > MAX_TOTAL_UNCOMPRESSED_SIZE) {
      throw new Error('EPUB expands beyond the supported size limit');
    }
  }
}

function parseNavOl(ol, $) {
  const items = [];
  ol.children('li').each((_, li) => {
    const $li = $(li);
    const a = $li.children('a').first();
    const title = a.text().trim();
    const href = a.attr('href') || '';
    const childOl = $li.children('ol').first();
    const children = childOl.length ? parseNavOl(childOl, $) : [];
    if (title) items.push({ title, href, children });
  });
  return items;
}

function parseNcxNavMap(navMap, $) {
  const items = [];
  navMap.children('navPoint').each((_, navPoint) => {
    const $navPoint = $(navPoint);
    const title = $navPoint.children('navLabel').first().find('text').first().text().trim();
    const href = $navPoint.children('content').first().attr('src') || '';
    const children = parseNcxNavMap($navPoint, $);
    if (title) items.push({ title, href, children });
  });
  return items;
}

function parseToc(zip, opfDir, manifest, $opf) {
  const navItem = Object.values(manifest).find(item => item.properties.includes('nav'));
  if (navItem) {
    try {
      const navXhtml = zip.readAsText(path.posix.normalize(opfDir + navItem.href));
      const $ = cheerio.load(navXhtml, { xmlMode: true });
      sanitizePublicationDocument($);
      const navElements = $('nav');
      const typedNav = navElements.filter((_, element) => {
        const type = $(element).attr('epub:type') || $(element).attr('type') || '';
        return type.split(/\s+/).includes('toc');
      }).first();
      const navElement = typedNav.length ? typedNav : navElements.first();
      if (navElement.length) return parseNavOl(navElement.children('ol').first(), $);
    } catch {
      // Fall through to the EPUB 2 NCX document.
    }
  }

  const tocId = $opf('spine').attr('toc');
  const ncxItem = tocId
    ? manifest[tocId]
    : Object.values(manifest).find(item => item.mediaType === 'application/x-dtbncx+xml');
  if (ncxItem) {
    try {
      const ncxXml = zip.readAsText(path.posix.normalize(opfDir + ncxItem.href));
      const $ = cheerio.load(ncxXml, { xmlMode: true });
      sanitizePublicationDocument($);
      return parseNcxNavMap($('navMap').first(), $);
    } catch {
      // A missing or malformed TOC should not prevent reading the spine.
    }
  }
  return [];
}

function getImageMime(source) {
  const pathname = String(source || '').split(/[?#]/, 1)[0];
  const extension = path.extname(pathname).toLowerCase().replace('.', '');
  return extension === 'svg' ? 'image/svg+xml'
    : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg'
    : extension === 'png' ? 'image/png'
    : extension === 'gif' ? 'image/gif'
    : extension === 'webp' ? 'image/webp'
    : 'image/png';
}

function parseEpub(epubPath) {
  const zip = new AdmZip(epubPath);
  assertReasonableArchive(zip);

  const containerXml = zip.readAsText('META-INF/container.xml');
  const $container = cheerio.load(containerXml, { xmlMode: true });
  const opfPath = $container('rootfile').attr('full-path');
  if (!opfPath) throw new Error('EPUB container does not reference a package document');
  const normalizedOpfPath = path.posix.normalize(opfPath);
  const opfDir = path.posix.dirname(normalizedOpfPath) === '.'
    ? ''
    : path.posix.dirname(normalizedOpfPath) + '/';

  const opfXml = zip.readAsText(normalizedOpfPath);
  const $opf = cheerio.load(opfXml, { xmlMode: true });
  const manifest = {};
  $opf('manifest item').each((_, element) => {
    const $element = $opf(element);
    const id = $element.attr('id');
    const href = $element.attr('href');
    if (!id || !href) return;
    manifest[id] = {
      href,
      mediaType: $element.attr('media-type') || '',
      properties: $element.attr('properties') || '',
    };
  });

  const spine = [];
  $opf('spine itemref').each((_, element) => {
    const idref = $opf(element).attr('idref');
    if (idref) spine.push(idref);
  });
  if (spine.length > MAX_SPINE_ITEMS) throw new Error('EPUB spine contains too many items');

  const toc = parseToc(zip, opfDir, manifest, $opf);
  const title = $opf('metadata dc\\:title, metadata title').first().text().trim()
    || path.basename(epubPath, '.epub');
  const language = $opf('metadata dc\\:language, metadata language').first().text().trim() || '';
  const identifier = $opf('metadata dc\\:identifier, metadata identifier').first().text().trim() || '';
  const chapters = [];

  for (const idref of spine) {
    const item = manifest[idref];
    if (!item) continue;
    const chapterPath = path.posix.normalize(opfDir + item.href);
    let xhtml;
    try {
      xhtml = zip.readAsText(chapterPath);
    } catch {
      continue;
    }

    const chapterDir = path.posix.dirname(chapterPath);
    const $ = cheerio.load(xhtml, { xmlMode: true });
    sanitizePublicationDocument($);
    let collectedCss = '';
    $('link[rel="stylesheet"]').each((_, element) => {
      const href = $(element).attr('href');
      if (!href) return;
      const cssPath = path.posix.normalize(chapterDir + '/' + href);
      try { collectedCss += zip.readAsText(cssPath) + '\n'; } catch {}
    });
    $('style').each((_, element) => {
      collectedCss += ($(element).html() || '') + '\n';
    });
    $('link[rel="stylesheet"], style').remove();

    $('[style]').each((_, element) => {
      const $element = $(element);
      const className = ($element.attr('class') || '').toLowerCase();
      const cleaned = filterInlineStyle(
        $element.attr('style') || '',
        className.includes('dropcap') || className.includes('drop-cap')
      );
      if (cleaned) $element.attr('style', cleaned);
      else $element.removeAttr('style');
    });

    $('img, image').each((_, element) => {
      const $element = $(element);
      const source = $element.attr('src') || $element.attr('xlink:href') || $element.attr('href');
      if (!source || source.startsWith('data:')) return;
      const imagePath = path.posix.normalize(chapterDir + '/' + source.split(/[?#]/, 1)[0]);
      try {
        const imageData = zip.readFile(imagePath);
        if (!imageData) return;
        const dataUri = `data:${getImageMime(source)};base64,${imageData.toString('base64')}`;
        if (element.name === 'img') $element.attr('src', dataUri);
        else {
          $element.attr('href', dataUri);
          $element.attr('xlink:href', dataUri);
          $element.removeAttr('src');
        }
      } catch {
        // Broken image handling in the renderer provides the visible fallback.
      }
    });

    const body = $('body');
    const rawHtml = body.length ? body.html() : $.html();
    chapters.push({
      id: idref,
      href: item.href,
      html: normalizeXhtmlFragment(rawHtml),
      css: collectedCss.trim() ? filterEpubCss(collectedCss) : '',
    });
  }

  return { title, language, identifier, chapters, toc };
}

module.exports = { parseEpub };
