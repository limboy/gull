'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('keeps valid highlight offsets and relocates stale offsets by context', async () => {
  const { resolveHighlightOffsets } = await import('../src/lib/highlight-anchor.mjs');
  const content = 'First quote. Some inserted text. Second quote.';
  assert.deepEqual(resolveHighlightOffsets(content, {
    start: 0, end: 5, text: 'First', prefix: '', suffix: ' quote.',
  }), { start: 0, end: 5 });
  assert.deepEqual(resolveHighlightOffsets(content, {
    start: 12,
    end: 17,
    text: 'quote',
    prefix: 'Second ',
    suffix: '.',
  }), { start: 40, end: 45 });
  assert.equal(resolveHighlightOffsets(content, {
    start: 0, end: 7, text: 'missing', prefix: '', suffix: '',
  }), null);
});
