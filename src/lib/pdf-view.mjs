// Pure helpers for the PDF reader. Kept free of pdf.js and DOM access so the
// page/zoom math and outline mapping can be unit tested.

export const PDF_VIEW_STORAGE_KEY = 'gull-pdf-view';

export const DEFAULT_PDF_VIEW = { zoom: 'fit-width' };

export const PDF_ZOOM_OPTIONS = [
  { label: 'Fit Width', value: 'fit-width' },
  { label: 'Fit Page', value: 'fit-page' },
  { label: '100%', value: 1 },
  { label: '125%', value: 1.25 },
  { label: '150%', value: 1.5 },
  { label: '200%', value: 2 },
];

const MIN_SCALE = 0.1;
const MAX_SCALE = 6;

// PDF pages are measured in points; a fixed zoom of 100% means "actual size"
// on a 96 dpi display, which is what every other PDF reader shows.
export const PDF_TO_CSS_UNITS = 96 / 72;

export function isPdfPath(filePath) {
  return typeof filePath === 'string' && filePath.toLowerCase().endsWith('.pdf');
}

/** Accept only zoom values the menu can round-trip; anything else falls back. */
export function normalizePdfView(saved) {
  const zoom = saved && typeof saved === 'object' ? saved.zoom : undefined;
  if (zoom === 'fit-width' || zoom === 'fit-page') return { zoom };
  const numeric = Number(zoom);
  if (Number.isFinite(numeric) && numeric >= MIN_SCALE && numeric <= MAX_SCALE) {
    return { zoom: numeric };
  }
  return { ...DEFAULT_PDF_VIEW };
}

/**
 * CSS pixel box for one page at the current zoom.
 *
 * `page` is in PDF points (a viewport at scale 1), `viewport` is the space the
 * content column offers. Fit modes need that space; fixed zooms ignore it.
 */
export function computePageLayout(zoom, page, viewport = {}) {
  const pageWidth = Number(page?.width) || 0;
  const pageHeight = Number(page?.height) || 0;
  if (pageWidth <= 0 || pageHeight <= 0) return { scale: 1, width: 0, height: 0 };

  const availableWidth = Number(viewport.width) || 0;
  const availableHeight = Number(viewport.height) || 0;

  let scale;
  if (zoom === 'fit-width') {
    scale = availableWidth > 0 ? availableWidth / pageWidth : 1;
  } else if (zoom === 'fit-page') {
    const widthScale = availableWidth > 0 ? availableWidth / pageWidth : 1;
    const heightScale = availableHeight > 0 ? availableHeight / pageHeight : widthScale;
    scale = Math.min(widthScale, heightScale);
  } else {
    scale = (Number(zoom) || 1) * PDF_TO_CSS_UNITS;
  }

  scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
  return {
    scale,
    width: Math.round(pageWidth * scale),
    height: Math.round(pageHeight * scale),
  };
}

/**
 * PDF metadata titles are frequently the authoring tool's leftovers
 * ("Microsoft Word - draft3.doc"), which read worse in the tab bar than the
 * file name the sidebar already shows. Keep only titles that look intentional.
 */
export function cleanPdfTitle(raw) {
  const title = String(raw || '').replace(/\s+/g, ' ').trim();
  if (title.length < 2 || title.length > 200) return '';
  if (/\.(pdf|doc|docx|indd|qxd|tex|pages|ppt|pptx)$/i.test(title)) return '';
  if (/^(untitled|document\d*|microsoft word)$/i.test(title)) return '';
  if (/^microsoft word - /i.test(title)) return '';
  return title;
}

/** Page sections reuse the chapter shape so tabs, TOC, and search work unchanged. */
export function pdfPageChapterId(pageNumber) {
  return `page-${pageNumber}`;
}

export function pdfPageHtml(pageNumber) {
  return `<div class="pdf-page" data-pdf-page="${pageNumber}">`
    + '<div class="pdf-page-canvas"></div>'
    + '<div class="pdf-text-layer"></div>'
    + '</div>';
}

export function buildPdfChapters(pageCount) {
  const total = Math.max(0, Math.floor(Number(pageCount) || 0));
  const chapters = [];
  for (let pageNumber = 1; pageNumber <= total; pageNumber++) {
    const id = pdfPageChapterId(pageNumber);
    chapters.push({
      id,
      href: id,
      pageNumber,
      title: `Page ${pageNumber}`,
      html: pdfPageHtml(pageNumber),
      css: '',
      text: '',
    });
  }
  return chapters;
}

/**
 * Map a pdf.js outline onto the reader's `{title, href, children}` ToC shape.
 *
 * `resolvePageNumber(item)` is supplied by the caller because resolving a PDF
 * destination is asynchronous; entries it cannot place are dropped, but their
 * children are kept so a bookmark tree never loses its leaves.
 */
export function buildPdfToc(outline, resolvePageNumber) {
  const items = Array.isArray(outline) ? outline : [];
  const out = [];
  for (const item of items) {
    if (!item) continue;
    const children = buildPdfToc(item.items, resolvePageNumber);
    const pageNumber = resolvePageNumber(item);
    const title = String(item.title || '').replace(/\s+/g, ' ').trim();
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || !title) {
      out.push(...children);
      continue;
    }
    out.push({ title, href: pdfPageChapterId(pageNumber), children });
  }
  return out;
}

/**
 * The chapter scrollbar draws one segment per entry, so a 900-page PDF without
 * bookmarks would cost 900 nodes updated on every scroll frame. Evenly spaced
 * pages keep the bar readable and cheap while still mapping to the document.
 */
export function samplePdfChapters(chapters, max = 40) {
  const list = Array.isArray(chapters) ? chapters : [];
  const limit = Math.max(1, Math.floor(max));
  if (list.length <= limit) return list;
  const step = list.length / limit;
  const sampled = [];
  for (let i = 0; i < limit; i++) {
    sampled.push(list[Math.floor(i * step)]);
  }
  return sampled;
}
