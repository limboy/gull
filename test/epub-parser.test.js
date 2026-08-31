'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const AdmZip = require('adm-zip');
const { parseEpub, parseEpubCover } = require('../lib/epub-parser');

function createFixtureEpub() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gull-epub-test-'));
  const epubPath = path.join(directory, 'fixture.epub');
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile('META-INF/container.xml', Buffer.from(`
    <?xml version="1.0"?>
    <container><rootfiles><rootfile full-path="OEBPS/content.opf" /></rootfiles></container>
  `));
  zip.addFile('OEBPS/content.opf', Buffer.from(`
    <package xmlns:dc="http://purl.org/dc/elements/1.1/">
      <metadata><dc:title>Fixture Book</dc:title><dc:language>en</dc:language><dc:identifier>urn:gull:test</dc:identifier></metadata>
      <manifest>
        <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
        <item id="chapter" href="text/chapter.xhtml" media-type="application/xhtml+xml" />
        <item id="css" href="styles/book.css" media-type="text/css" />
        <item id="image" href="images/pixel.png" media-type="image/png" />
        <item id="art" href="images/cover.png" media-type="image/png" properties="cover-image" />
      </manifest>
      <spine><itemref idref="chapter" /></spine>
    </package>
  `));
  zip.addFile('OEBPS/nav.xhtml', Buffer.from(`
    <html xmlns:epub="http://www.idpf.org/2007/ops"><body>
      <nav epub:type="toc"><ol><li><a href="text/chapter.xhtml">Chapter One</a></li></ol></nav>
    </body></html>
  `));
  zip.addFile('OEBPS/styles/book.css', Buffer.from('p { color: red; margin: 1em; }'));
  zip.addFile('OEBPS/text/chapter.xhtml', Buffer.from(`
    <html><head><link rel="stylesheet" href="../styles/book.css" /></head><body>
      <script>window.settings.set('theme', 'dark')</script>
      <p onclick="alert(1)">Hello <img src="../images/pixel.png" /></p>
      <div class="page" />
    </body></html>
  `));
  zip.addFile('OEBPS/images/pixel.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  zip.addFile('OEBPS/images/cover.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]));
  zip.writeZip(epubPath);
  return { directory, epubPath };
}

test('parses, sanitizes, and normalizes an EPUB fixture', () => {
  const fixture = createFixtureEpub();
  try {
    const result = parseEpub(fixture.epubPath);
    assert.equal(result.title, 'Fixture Book');
    assert.equal(result.language, 'en');
    assert.equal(result.identifier, 'urn:gull:test');
    assert.deepEqual(result.toc, [{
      title: 'Chapter One', href: 'text/chapter.xhtml', children: [],
    }]);
    assert.equal(result.chapters.length, 1);
    assert.doesNotMatch(result.chapters[0].html, /script|onclick/i);
    assert.match(result.chapters[0].html, /data:image\/png;base64,/);
    assert.match(result.chapters[0].html, /<div class="page"><\/div>/);
    assert.doesNotMatch(result.chapters[0].css, /color\s*:/i);
    assert.match(result.chapters[0].css, /margin: 1em/);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('ignores non-CSS stylesheet links (e.g. Adobe page-template XML)', () => {
  // Adobe Digital Editions page templates are linked with rel="stylesheet"
  // but aren't CSS. Their XML can contain a stray "{...}" that, if fed
  // into the CSS filter, corrupts the selector of whatever rule follows.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gull-epub-test-'));
  const epubPath = path.join(directory, 'fixture.epub');
  try {
    const zip = new AdmZip();
    zip.addFile('mimetype', Buffer.from('application/epub+zip'));
    zip.addFile('META-INF/container.xml', Buffer.from(`
      <?xml version="1.0"?>
      <container><rootfiles><rootfile full-path="OEBPS/content.opf" /></rootfiles></container>
    `));
    zip.addFile('OEBPS/content.opf', Buffer.from(`
      <package xmlns:dc="http://purl.org/dc/elements/1.1/">
        <metadata><dc:title>Fixture Book</dc:title></metadata>
        <manifest>
          <item id="chapter" href="text/chapter.xhtml" media-type="application/xhtml+xml" />
          <item id="css" href="styles/book.css" media-type="text/css" />
          <item id="template" href="page-template.xpgt" media-type="application/adobe-page-template+xml" />
        </manifest>
        <spine><itemref idref="chapter" /></spine>
      </package>
    `));
    zip.addFile('OEBPS/styles/book.css', Buffer.from('p { color: red; margin: 1em; }'));
    zip.addFile('OEBPS/page-template.xpgt', Buffer.from(
      '<ade:template><ade:style><ade:styling-rule selector=".img" condition="{ade:page-width() &gt; 0}" /></ade:style></ade:template>'
    ));
    zip.addFile('OEBPS/text/chapter.xhtml', Buffer.from(`
      <html><head>
        <link rel="stylesheet" href="../styles/book.css" />
        <link rel="stylesheet" type="application/adobe-page-template+xml" href="../page-template.xpgt" />
      </head><body>
        <p>Hello</p>
      </body></html>
    `));
    zip.writeZip(epubPath);

    const result = parseEpub(epubPath);
    assert.match(result.chapters[0].css, /^p\s*\{/);
    assert.doesNotMatch(result.chapters[0].css, /ade:template|ade:style/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('parses EPUB fixtures through the worker protocol', async () => {
  const fixture = createFixtureEpub();
  const worker = new Worker(path.join(__dirname, '..', 'lib', 'epub-parser-worker.js'));
  try {
    const result = await new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.once('message', message => {
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      });
      worker.postMessage({ id: 1, filePath: fixture.epubPath });
    });
    assert.equal(result.title, 'Fixture Book');
    assert.equal(result.identifier, 'urn:gull:test');
    assert.equal(result.chapters.length, 1);
  } finally {
    await worker.terminate();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('extracts the cover named by an EPUB 3 manifest property', () => {
  const fixture = createFixtureEpub();
  try {
    const cover = parseEpubCover(fixture.epubPath);
    assert.equal(cover.mime, 'image/png');
    assert.deepEqual([...cover.data], [0x89, 0x50, 0x4e, 0x47, 0x0d]);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('falls back to the EPUB 2 cover metadata and reports books without art', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gull-epub-test-'));
  const withCover = path.join(directory, 'with-cover.epub');
  const withoutCover = path.join(directory, 'without-cover.epub');
  const container = Buffer.from(`
    <?xml version="1.0"?>
    <container><rootfiles><rootfile full-path="OEBPS/content.opf" /></rootfiles></container>
  `);
  const opf = manifestExtra => Buffer.from(`
    <package xmlns:dc="http://purl.org/dc/elements/1.1/">
      <metadata><dc:title>Fixture Book</dc:title><meta name="cover" content="art" /></metadata>
      <manifest>
        <item id="chapter" href="text/chapter.xhtml" media-type="application/xhtml+xml" />
        ${manifestExtra}
      </manifest>
      <spine><itemref idref="chapter" /></spine>
    </package>
  `);
  try {
    const zip = new AdmZip();
    zip.addFile('META-INF/container.xml', container);
    zip.addFile('OEBPS/content.opf', opf('<item id="art" href="images/art.jpg" media-type="image/jpeg" />'));
    zip.addFile('OEBPS/text/chapter.xhtml', Buffer.from('<html><body><p>Hello</p></body></html>'));
    zip.addFile('OEBPS/images/art.jpg', Buffer.from([0xff, 0xd8, 0xff]));
    zip.writeZip(withCover);

    const bare = new AdmZip();
    bare.addFile('META-INF/container.xml', container);
    bare.addFile('OEBPS/content.opf', opf(''));
    bare.addFile('OEBPS/text/chapter.xhtml', Buffer.from('<html><body><p>Hello</p></body></html>'));
    bare.writeZip(withoutCover);

    const cover = parseEpubCover(withCover);
    assert.equal(cover.mime, 'image/jpeg');
    assert.deepEqual([...cover.data], [0xff, 0xd8, 0xff]);
    assert.equal(parseEpubCover(withoutCover), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('reads covers through the worker protocol', async () => {
  const fixture = createFixtureEpub();
  const worker = new Worker(path.join(__dirname, '..', 'lib', 'epub-parser-worker.js'));
  try {
    const result = await new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.once('message', message => {
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      });
      worker.postMessage({ id: 1, task: 'cover', filePath: fixture.epubPath });
    });
    assert.equal(result.mime, 'image/png');
    assert.deepEqual([...result.data], [0x89, 0x50, 0x4e, 0x47, 0x0d]);
  } finally {
    await worker.terminate();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});
