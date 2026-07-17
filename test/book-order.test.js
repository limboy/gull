const test = require('node:test');
const assert = require('node:assert/strict');

test('pinning moves a book to the first sidebar slot', async () => {
  const { toggleBookPin } = await import('../src/lib/book-order.mjs');
  const books = [
    { filePath: '/a.epub', title: 'A' },
    { filePath: '/b.epub', title: 'B' },
    { filePath: '/c.epub', title: 'C' }
  ];

  assert.equal(toggleBookPin(books, '/c.epub'), true);
  assert.deepEqual(books.map(book => book.filePath), [
    '/c.epub',
    '/a.epub',
    '/b.epub'
  ]);
  assert.equal(books[0].pinned, true);
});

test('newly pinned books move ahead of books that were already pinned', async () => {
  const { toggleBookPin } = await import('../src/lib/book-order.mjs');
  const books = [
    { filePath: '/a.epub', pinned: true },
    { filePath: '/b.epub', pinned: true },
    { filePath: '/c.epub' }
  ];

  toggleBookPin(books, '/c.epub');

  assert.deepEqual(books.map(book => book.filePath), [
    '/c.epub',
    '/a.epub',
    '/b.epub'
  ]);
});

test('unpinning moves a book after the remaining pinned group', async () => {
  const { toggleBookPin } = await import('../src/lib/book-order.mjs');
  const books = [
    { filePath: '/a.epub', pinned: true },
    { filePath: '/b.epub', pinned: true },
    { filePath: '/c.epub' }
  ];

  assert.equal(toggleBookPin(books, '/a.epub'), false);
  assert.deepEqual(books.map(book => book.filePath), [
    '/b.epub',
    '/a.epub',
    '/c.epub'
  ]);
  assert.equal(books[1].pinned, false);
});

test('grouping restored books preserves order within pin groups', async () => {
  const { groupPinnedBooks } = await import('../src/lib/book-order.mjs');
  const books = [
    { filePath: '/a.epub' },
    { filePath: '/b.epub', pinned: true },
    { filePath: '/c.epub' },
    { filePath: '/d.epub', pinned: true }
  ];

  assert.deepEqual(
    groupPinnedBooks(books).map(book => book.filePath),
    ['/b.epub', '/d.epub', '/a.epub', '/c.epub']
  );
});
