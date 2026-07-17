'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');
const {
  filterEpubCss,
  filterInlineStyle,
  isSafePublicationUrl,
  normalizeXhtmlFragment,
  sanitizePublicationDocument,
} = require('../lib/book-content');

test('sanitizes executable publication markup while preserving reading content', () => {
  const $ = cheerio.load(`
    <html><body>
      <script>window.settings.set('theme', 'dark')</script>
      <iframe src="https://example.com"></iframe>
      <svg><foreignObject><div>unsafe</div></foreignObject></svg>
      <p id="safe" onclick="alert(1)" style="font-weight: bold">Readable</p>
      <a id="bad-link" href="java\nscript:alert(1)" target="_blank">Bad</a>
      <a id="external" href="https://example.com">External</a>
      <img id="remote" src="https://example.com/tracker.png" onerror="alert(1)" />
      <img id="inline" src="data:image/png;base64,AAAA" />
    </body></html>
  `, { xmlMode: true });

  sanitizePublicationDocument($);

  assert.equal($('script, iframe, foreignObject').length, 0);
  assert.equal($('#safe').text(), 'Readable');
  assert.equal($('#safe').attr('onclick'), undefined);
  assert.equal($('#bad-link').attr('href'), undefined);
  assert.equal($('#bad-link').attr('target'), undefined);
  assert.equal($('#external').attr('href'), 'https://example.com');
  assert.equal($('#remote').attr('src'), undefined);
  assert.equal($('#remote').attr('onerror'), undefined);
  assert.match($('#inline').attr('src'), /^data:image\/png;base64,/);
});

test('allows only expected publication URL forms', () => {
  assert.equal(isSafePublicationUrl('../chapter.xhtml#part', {
    tagName: 'a', attributeName: 'href',
  }), true);
  assert.equal(isSafePublicationUrl('mailto:reader@example.com', {
    tagName: 'a', attributeName: 'href',
  }), true);
  assert.equal(isSafePublicationUrl('javascript:alert(1)', {
    tagName: 'a', attributeName: 'href',
  }), false);
  assert.equal(isSafePublicationUrl('data:text/html;base64,AAAA', {
    tagName: 'img', attributeName: 'src',
  }), false);
  assert.equal(isSafePublicationUrl('//example.com/tracker.png', {
    tagName: 'img', attributeName: 'src',
  }), false);
});

test('filters reader overrides and active CSS values', () => {
  assert.equal(
    filterInlineStyle('font-size: 20px; color: red; font-weight: 700; background-image: url(https://example.com/a.png)'),
    'font-weight: 700'
  );
  assert.equal(
    filterInlineStyle('font-size: 3em; line-height: 1; float: left', true),
    'font-size: 3em; line-height: 1; float: left'
  );

  const filtered = filterEpubCss(`
    @import url('https://example.com/book.css');
    p { color: red; margin: 1em; }
    .dropcap { font-size: 3em; line-height: 1; float: left; }
    .tracker { list-style-image: url('https://example.com/pixel.png'); }
  `);
  assert.doesNotMatch(filtered, /@import|color\s*:|url\s*\(/i);
  assert.match(filtered, /margin: 1em/);
  assert.match(filtered, /font-size: 3em/);
  assert.match(filtered, /float: left/);
});

test('normalizes self-closing non-void XHTML elements', () => {
  assert.equal(
    normalizeXhtmlFragment('<div class="page"/><img src="cover.png"/><br/>'),
    '<div class="page"></div><img src="cover.png"><br>'
  );
});
