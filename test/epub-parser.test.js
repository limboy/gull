'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const AdmZip = require('adm-zip');
const { parseEpub } = require('../lib/epub-parser');

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
