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

test('detects overlapping highlights and merges them', async () => {
  const { isOverlappingHighlight, mergeOverlappingHighlights } = await import('../src/lib/highlight-anchor.mjs');

  const h1 = { id: '1', chapterId: 'ch1', start: 0, end: 5, text: 'See? ', createdAt: 100 };
  const h2 = { id: '2', chapterId: 'ch1', start: 5, end: 27, text: 'This is a weak point,', createdAt: 200 };
  const h3 = { id: '3', chapterId: 'ch2', start: 10, end: 15, text: 'other', createdAt: 150 };

  assert.equal(isOverlappingHighlight(h1, h2), true);
  assert.equal(isOverlappingHighlight(h1, h3), false);

  const merged = mergeOverlappingHighlights([h1, h2, h3]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], { id: '1', chapterId: 'ch1', start: 0, end: 27, text: 'See? ', createdAt: 200 });
  assert.deepEqual(merged[1], h3);
});


