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

test('sidebar sections list pinned books above every folder', async () => {
  const { buildSidebarSections } = await import('../src/lib/book-order.mjs');
  const folders = [
    { path: '/library/fiction', name: 'fiction', collapsed: false, folders: [] },
    { path: '/library/papers', name: 'papers', collapsed: true, folders: [] }
  ];
  const books = [
    { filePath: '/library/fiction/a.epub', title: 'A', pinned: true, folderPath: '/library/fiction' },
    { filePath: '/library/fiction/c.epub', title: 'C', folderPath: '/library/fiction' },
    { filePath: '/library/fiction/b.epub', title: 'B', folderPath: '/library/fiction' },
    { filePath: '/library/papers/d.epub', title: 'D', folderPath: '/library/papers' },
    { filePath: '/downloads/e.epub', title: 'E' }
  ];

  const { sections, unfiledBooks } = buildSidebarSections(books, folders);

  assert.deepEqual(
    sections.map(section => [
      section.kind,
      section.id,
      (section.items || section.books).map(item => item.book?.title ?? item.title)
    ]),
    [
      ['pinned', 'pinned', ['A']],
      ['folder', '/library/fiction', ['B', 'C']],
      ['folder', '/library/papers', ['D']]
    ]
  );
  assert.equal(sections[2].collapsed, true);
  // Books outside every folder render loose, not in a group of their own.
  assert.deepEqual(unfiledBooks.map(book => book.title), ['E']);
});

test('subfolders nest inside their parent and count toward its total', async () => {
  const { buildSidebarSections } = await import('../src/lib/book-order.mjs');
  const folders = [{
    path: '/library', name: 'library', folders: [
      { path: '/library/authors', name: 'authors', folders: [] }
    ]
  }];
  const books = [
    { filePath: '/library/root.epub', title: 'Root', folderPath: '/library' },
    { filePath: '/library/authors/deep.epub', title: 'Deep', folderPath: '/library/authors' }
  ];

  const { sections } = buildSidebarSections(books, folders);
  const [root] = sections;

  assert.equal(root.bookCount, 2); // includes books nested below
  assert.deepEqual(root.items.map(item => item.type), ['folder', 'book']);
  const nested = root.items[0].section;
  assert.equal(nested.title, 'authors');
  assert.equal(nested.depth, 1);
  assert.deepEqual(nested.items.map(item => item.book.title), ['Deep']);
});

test('sort orders rows by name or creation date in either direction', async () => {
  const { buildSidebarSections } = await import('../src/lib/book-order.mjs');
  const folders = [{ path: '/library', name: 'library', folders: [] }];
  const books = [
    { filePath: '/library/b.epub', title: 'Bravo', createdAt: 300, folderPath: '/library' },
    { filePath: '/library/a.epub', title: 'Alpha', createdAt: 100, folderPath: '/library' },
    { filePath: '/library/c.epub', title: 'Charlie', createdAt: 200, folderPath: '/library' }
  ];
  const titles = (sort) => buildSidebarSections(books, folders, sort)
    .sections[0].items.map(item => item.book.title);

  assert.deepEqual(titles({ key: 'name', direction: 'asc' }), ['Alpha', 'Bravo', 'Charlie']);
  assert.deepEqual(titles({ key: 'name', direction: 'desc' }), ['Charlie', 'Bravo', 'Alpha']);
  assert.deepEqual(titles({ key: 'created', direction: 'asc' }), ['Alpha', 'Charlie', 'Bravo']);
  assert.deepEqual(titles({ key: 'created', direction: 'desc' }), ['Bravo', 'Charlie', 'Alpha']);
});

test('folders first hoists subfolders above books, and off interleaves them', async () => {
  const { buildSidebarSections } = await import('../src/lib/book-order.mjs');
  const folders = [{
    path: '/library', name: 'library', folders: [
      { path: '/library/mid', name: 'Mid', createdAt: 150, folders: [] }
    ]
  }];
  const books = [
    { filePath: '/library/a.epub', title: 'Alpha', createdAt: 100, folderPath: '/library' },
    { filePath: '/library/z.epub', title: 'Zulu', createdAt: 200, folderPath: '/library' }
  ];
  const labels = (sort) => buildSidebarSections(books, folders, sort)
    .sections[0].items.map(item => item.book?.title ?? item.section.title);

  assert.deepEqual(
    labels({ key: 'name', direction: 'asc', foldersFirst: true }),
    ['Mid', 'Alpha', 'Zulu']
  );
  assert.deepEqual(
    labels({ key: 'name', direction: 'asc', foldersFirst: false }),
    ['Alpha', 'Mid', 'Zulu']
  );
});

test('restoring folders keeps collapsed state and drops malformed records', async () => {
  const { normalizeFolders, mergeFolderTree } = await import('../src/lib/book-order.mjs');

  const restored = normalizeFolders([
    { path: '/library', name: 'Library', collapsed: true, folders: [
      { path: '/library/sub', collapsed: true, folders: [] },
      { path: '', name: 'No path' }
    ] },
    { path: '/library', name: 'Duplicate' },
    null
  ]);
  assert.deepEqual(restored.map(folder => [folder.path, folder.collapsed]), [['/library', true]]);
  assert.deepEqual(restored[0].folders.map(child => [child.path, child.name]), [['/library/sub', 'sub']]);

  // A rescan keeps collapsed flags for folders that are still there.
  const merged = mergeFolderTree(restored[0], {
    path: '/library', name: 'library', createdAt: 5, folders: [
      { path: '/library/sub', name: 'sub', createdAt: 6, folders: [] },
      { path: '/library/new', name: 'new', createdAt: 7, folders: [] }
    ]
  });
  assert.equal(merged.collapsed, true);
  assert.deepEqual(merged.folders.map(child => [child.path, child.collapsed]), [
    ['/library/sub', true],
    ['/library/new', false]
  ]);
});

test('syncing a folder adopts open books and drops vanished files at any depth', async () => {
  const { syncFolderBooks, flattenScannedBooks } = await import('../src/lib/book-order.mjs');
  const books = [
    { filePath: '/library/a.epub', title: 'A', folderPath: '/library', position: { scrollTop: 40 } },
    { filePath: '/library/sub/gone.epub', title: 'Gone', folderPath: '/library/sub' },
    { filePath: '/library/b.epub', title: 'B' } // already open ad-hoc
  ];
  const scan = {
    path: '/library', name: 'library', books: [
      { filePath: '/library/a.epub', title: 'A', createdAt: 1 },
      { filePath: '/library/b.epub', title: 'B', createdAt: 2 }
    ],
    folders: [{
      path: '/library/sub', name: 'sub',
      books: [{ filePath: '/library/sub/new.epub', title: 'New', createdAt: 3 }],
      folders: []
    }]
  };

  const removed = syncFolderBooks(books, '/library', flattenScannedBooks(scan));

  assert.deepEqual(removed, ['/library/sub/gone.epub']);
  assert.deepEqual(
    books.map(book => [book.filePath, book.folderPath]),
    [
      ['/library/a.epub', '/library'],
      ['/library/b.epub', '/library'],
      ['/library/sub/new.epub', '/library/sub']
    ]
  );
  // Reading position of a book that is still on disk survives the rescan.
  assert.deepEqual(books[0].position, { scrollTop: 40 });
});

test('removing a folder also removes rows from its subfolders', async () => {
  const { removeFolder } = await import('../src/lib/book-order.mjs');
  const folders = [{ path: '/library', name: 'library', folders: [] }, { path: '/papers', name: 'papers', folders: [] }];
  const books = [
    { filePath: '/library/a.epub', folderPath: '/library' },
    { filePath: '/library/sub/b.epub', folderPath: '/library/sub' },
    { filePath: '/papers/c.epub', folderPath: '/papers' },
    { filePath: '/downloads/d.epub' }
  ];

  assert.deepEqual(removeFolder(folders, books, '/library'), [
    '/library/sub/b.epub',
    '/library/a.epub'
  ]);
  assert.deepEqual(folders.map(folder => folder.path), ['/papers']);
  assert.deepEqual(books.map(book => book.filePath), ['/papers/c.epub', '/downloads/d.epub']);
  assert.deepEqual(removeFolder(folders, books, '/missing'), []);
});

test('sort settings fall back to sensible defaults', async () => {
  const { normalizeSort, DEFAULT_SORT } = await import('../src/lib/book-order.mjs');

  assert.deepEqual(normalizeSort(undefined), DEFAULT_SORT);
  assert.deepEqual(normalizeSort({ key: 'bogus', direction: 'sideways' }), DEFAULT_SORT);
  assert.deepEqual(
    normalizeSort({ key: 'created', direction: 'desc', foldersFirst: false }),
    { key: 'created', direction: 'desc', foldersFirst: false }
  );
});

test('adding a folder twice refreshes it instead of duplicating it', async () => {
  const { addFolder } = await import('../src/lib/book-order.mjs');
  const folders = [];
  const scan = { path: '/library', name: 'library', createdAt: 1, books: [], folders: [] };

  addFolder(folders, scan);
  folders[0].collapsed = true;
  addFolder(folders, { ...scan, name: 'Library' });

  assert.equal(folders.length, 1);
  assert.equal(folders[0].name, 'Library');
  assert.equal(folders[0].collapsed, true); // a rescan must not expand what the user closed
});
