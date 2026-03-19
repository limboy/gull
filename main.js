const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const cheerio = require('cheerio');

function getBooksDir() {
  const dir = path.join(app.getPath('userData'), 'books');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getMetadataPath() {
  return path.join(app.getPath('userData'), 'books.json');
}

function readMetadata() {
  const p = getMetadataPath();
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return [];
  }
}

function writeMetadata(data) {
  fs.writeFileSync(getMetadataPath(), JSON.stringify(data, null, 2));
}

function parseToc(zip, opfDir, manifest, $opf) {
  // Try EPUB3 nav document first
  const navItem = Object.values(manifest).find(m => m.properties.includes('nav'));
  if (navItem) {
    try {
      const navXhtml = zip.readAsText(opfDir + navItem.href);
      const $ = cheerio.load(navXhtml, { xmlMode: true });
      const navEl = $('nav[*|type="toc"], nav[epub\\:type="toc"], nav').first();
      if (navEl.length) {
        return parseNavOl(navEl.children('ol').first(), $);
      }
    } catch {
      // fall through to NCX
    }
  }

  // Fall back to EPUB2 toc.ncx
  const tocId = $opf('spine').attr('toc');
  const ncxItem = tocId ? manifest[tocId] : Object.values(manifest).find(m => m.mediaType === 'application/x-dtbncx+xml');
  if (ncxItem) {
    try {
      const ncxXml = zip.readAsText(opfDir + ncxItem.href);
      const $ = cheerio.load(ncxXml, { xmlMode: true });
      return parseNcxNavMap($('navMap').first(), $);
    } catch {
      // no TOC
    }
  }

  return [];
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
  navMap.children('navPoint').each((_, np) => {
    const $np = $(np);
    const title = $np.children('navLabel').first().find('text').first().text().trim();
    const href = $np.children('content').first().attr('src') || '';
    const children = parseNcxNavMap($np, $);
    if (title) items.push({ title, href, children });
  });
  return items;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadFile('index.html');
}

app.whenReady().then(() => {
  // IPC handlers
  ipcMain.handle('get-books', () => {
    return readMetadata();
  });

  ipcMain.handle('import-books', (_event, filePaths) => {
    const metadata = readMetadata();
    const booksDir = getBooksDir();

    for (const filePath of filePaths) {
      if (!filePath.toLowerCase().endsWith('.epub')) continue;

      const id = crypto.randomUUID();
      const filename = id + '.epub';
      const dest = path.join(booksDir, filename);
      const title = path.basename(filePath, path.extname(filePath));

      fs.copyFileSync(filePath, dest);
      metadata.push({ id, title, filename, addedAt: new Date().toISOString() });
    }

    writeMetadata(metadata);
    return metadata;
  });

  ipcMain.handle('open-book', (_event, id) => {
    const metadata = readMetadata();
    const entry = metadata.find(b => b.id === id);
    if (!entry) throw new Error('Book not found');

    const epubPath = path.join(getBooksDir(), entry.filename);
    const zip = new AdmZip(epubPath);

    // Parse container.xml to find OPF path
    const containerXml = zip.readAsText('META-INF/container.xml');
    const $container = cheerio.load(containerXml, { xmlMode: true });
    const opfPath = $container('rootfile').attr('full-path');
    const opfDir = path.dirname(opfPath) === '.' ? '' : path.dirname(opfPath) + '/';

    // Parse content.opf
    const opfXml = zip.readAsText(opfPath);
    const $opf = cheerio.load(opfXml, { xmlMode: true });

    // Build manifest map: id -> { href, mediaType, properties }
    const manifest = {};
    $opf('manifest item').each((_, el) => {
      const $el = $opf(el);
      manifest[$el.attr('id')] = {
        href: $el.attr('href'),
        mediaType: $el.attr('media-type'),
        properties: $el.attr('properties') || '',
      };
    });

    // Spine order
    const spine = [];
    $opf('spine itemref').each((_, el) => {
      spine.push($opf(el).attr('idref'));
    });

    // Parse TOC
    const toc = parseToc(zip, opfDir, manifest, $opf);

    // Process chapters
    const chapters = [];
    for (const idref of spine) {
      const item = manifest[idref];
      if (!item) continue;
      const chapterPath = opfDir + item.href;
      let xhtml;
      try {
        xhtml = zip.readAsText(chapterPath);
      } catch {
        continue;
      }
      const chapterDir = path.dirname(chapterPath);
      const $ = cheerio.load(xhtml, { xmlMode: true });

      // Remove styles
      $('link[rel="stylesheet"], style').remove();
      $('[style]').removeAttr('style');

      // Convert images to base64 data URIs
      $('img, image').each((_, el) => {
        const $el = $(el);
        const src = $el.attr('src') || $el.attr('xlink:href');
        if (!src || src.startsWith('data:')) return;
        const imgPath = path.posix.normalize(chapterDir + '/' + src);
        try {
          const imgData = zip.readFile(imgPath);
          if (imgData) {
            const ext = path.extname(src).toLowerCase().replace('.', '');
            const mime = ext === 'svg' ? 'image/svg+xml'
              : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
              : ext === 'png' ? 'image/png'
              : ext === 'gif' ? 'image/gif'
              : ext === 'webp' ? 'image/webp'
              : 'image/png';
            const b64 = imgData.toString('base64');
            $el.attr('src', `data:${mime};base64,${b64}`);
          }
        } catch {
          // skip missing images
        }
      });

      // Extract body innerHTML
      const body = $('body');
      const html = body.length ? body.html() : $.html();
      chapters.push({ id: idref, html });
    }

    return { chapters, toc };
  });

  ipcMain.handle('delete-book', (_event, id) => {
    let metadata = readMetadata();
    const entry = metadata.find(b => b.id === id);
    if (entry) {
      const filePath = path.join(getBooksDir(), entry.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      metadata = metadata.filter(b => b.id !== id);
      writeMetadata(metadata);
    }
    return metadata;
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
