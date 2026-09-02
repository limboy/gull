const test = require('node:test');
const assert = require('node:assert');

let pdfView;

test.before(async () => {
  pdfView = await import('../src/lib/pdf-view.mjs');
});

test('isPdfPath only matches the pdf extension', () => {
  assert.strictEqual(pdfView.isPdfPath('/books/a.pdf'), true);
  assert.strictEqual(pdfView.isPdfPath('/books/A.PDF'), true);
  assert.strictEqual(pdfView.isPdfPath('/books/a.epub'), false);
  assert.strictEqual(pdfView.isPdfPath(null), false);
});

test('normalizePdfView keeps known zooms and rejects the rest', () => {
  assert.deepStrictEqual(pdfView.normalizePdfView({ zoom: 'fit-page' }), { zoom: 'fit-page' });
  assert.deepStrictEqual(pdfView.normalizePdfView({ zoom: 1.5 }), { zoom: 1.5 });
  assert.deepStrictEqual(pdfView.normalizePdfView({ zoom: '1.25' }), { zoom: 1.25 });
  assert.deepStrictEqual(pdfView.normalizePdfView({ zoom: 99 }), pdfView.DEFAULT_PDF_VIEW);
  assert.deepStrictEqual(pdfView.normalizePdfView({ zoom: 'huge' }), pdfView.DEFAULT_PDF_VIEW);
  assert.deepStrictEqual(pdfView.normalizePdfView(null), pdfView.DEFAULT_PDF_VIEW);
});

test('computePageLayout fits the page to the column', () => {
  const page = { width: 600, height: 800 };

  const width = pdfView.computePageLayout('fit-width', page, { width: 900, height: 500 });
  assert.strictEqual(width.width, 900);
  assert.strictEqual(width.height, 1200);

  // Fit page is bounded by whichever axis runs out first.
  const whole = pdfView.computePageLayout('fit-page', page, { width: 900, height: 400 });
  assert.strictEqual(whole.height, 400);
  assert.strictEqual(whole.width, 300);
});

test('computePageLayout renders fixed zooms at CSS pixel size', () => {
  const layout = pdfView.computePageLayout(1, { width: 612, height: 792 }, { width: 300 });
  // 100% means actual size on a 96 dpi display, not one point per pixel.
  assert.strictEqual(layout.width, Math.round(612 * (96 / 72)));
  assert.strictEqual(layout.height, Math.round(792 * (96 / 72)));
});

test('computePageLayout survives a missing page size', () => {
  assert.deepStrictEqual(
    pdfView.computePageLayout('fit-width', { width: 0, height: 0 }, { width: 800 }),
    { scale: 1, width: 0, height: 0 }
  );
});

test('buildPdfChapters produces one page-shaped chapter per page', () => {
  const chapters = pdfView.buildPdfChapters(3);
  assert.strictEqual(chapters.length, 3);
  assert.strictEqual(chapters[0].id, 'page-1');
  assert.strictEqual(chapters[0].href, 'page-1');
  assert.strictEqual(chapters[2].pageNumber, 3);
  assert.match(chapters[1].html, /data-pdf-page="2"/);
  assert.deepStrictEqual(pdfView.buildPdfChapters(0), []);
});

test('buildPdfToc maps bookmarks onto page hrefs', () => {
  const outline = [
    { title: 'Part One', dest: 'p1', items: [{ title: ' Chapter\n1 ', dest: 'c1', items: [] }] },
    { title: 'Appendix', dest: 'missing', items: [] },
  ];
  const pages = new Map([[outline[0], 1], [outline[0].items[0], 4]]);

  assert.deepStrictEqual(pdfView.buildPdfToc(outline, item => pages.get(item) ?? null), [
    { title: 'Part One', href: 'page-1', children: [{ title: 'Chapter 1', href: 'page-4', children: [] }] },
  ]);
});

test('buildPdfToc keeps the children of an unresolvable bookmark', () => {
  const child = { title: 'Section', dest: 'c', items: [] };
  const outline = [{ title: 'Broken', dest: null, items: [child] }];

  assert.deepStrictEqual(pdfView.buildPdfToc(outline, item => (item === child ? 2 : null)), [
    { title: 'Section', href: 'page-2', children: [] },
  ]);
});

test('samplePdfChapters caps the chapter scrollbar segment count', () => {
  const chapters = pdfView.buildPdfChapters(500);
  const sampled = pdfView.samplePdfChapters(chapters, 40);
  assert.strictEqual(sampled.length, 40);
  assert.strictEqual(sampled[0].pageNumber, 1);
  // Evenly spaced, and never repeating a page.
  assert.strictEqual(new Set(sampled.map(c => c.pageNumber)).size, 40);

  const short = pdfView.buildPdfChapters(10);
  assert.strictEqual(pdfView.samplePdfChapters(short, 40), short);
});

test('cleanPdfTitle drops authoring-tool leftovers', () => {
  assert.strictEqual(pdfView.cleanPdfTitle('  The   Annotated Turing '), 'The Annotated Turing');
  assert.strictEqual(pdfView.cleanPdfTitle('Microsoft Word - draft3.doc'), '');
  assert.strictEqual(pdfView.cleanPdfTitle('report.pdf'), '');
  assert.strictEqual(pdfView.cleanPdfTitle('Untitled'), '');
  assert.strictEqual(pdfView.cleanPdfTitle(''), '');
  assert.strictEqual(pdfView.cleanPdfTitle(undefined), '');
});
