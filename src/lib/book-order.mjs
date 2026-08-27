export function groupPinnedBooks(books) {
  const pinned = [];
  const unpinned = [];

  for (const book of books) {
    (book.pinned === true ? pinned : unpinned).push(book);
  }

  return [...pinned, ...unpinned];
}

export function toggleBookPin(books, filePath) {
  const index = books.findIndex(book => book.filePath === filePath);
  if (index === -1) return null;

  const book = books[index];
  const remainingBooks = groupPinnedBooks(
    books.filter((_, bookIndex) => bookIndex !== index)
  );
  book.pinned = book.pinned !== true;

  if (book.pinned) {
    remainingBooks.unshift(book);
  } else {
    const firstUnpinnedIndex = remainingBooks.findIndex(
      candidate => candidate.pinned !== true
    );
    remainingBooks.splice(
      firstUnpinnedIndex === -1 ? remainingBooks.length : firstUnpinnedIndex,
      0,
      book
    );
  }

  books.splice(0, books.length, ...remainingBooks);
  return book.pinned;
}

export function toggleBookFinished(books, filePath) {
  const book = books.find(candidate => candidate.filePath === filePath);
  if (!book) return null;

  book.finished = book.finished !== true;
  return book.finished;
}

export const DEFAULT_SORT = { key: 'name', direction: 'asc', foldersFirst: true };

export function normalizeSort(rawSort) {
  return {
    key: rawSort?.key === 'created' ? 'created' : 'name',
    direction: rawSort?.direction === 'desc' ? 'desc' : 'asc',
    foldersFirst: rawSort?.foldersFirst !== false,
  };
}

function compareEntries(a, b, sort) {
  const byName = String(a.sortName).localeCompare(String(b.sortName));
  const comparison = sort.key === 'created'
    // Undated rows (books opened outside a folder) keep a stable spot by name.
    ? (a.sortDate || 0) - (b.sortDate || 0) || byName
    : byName;
  return sort.direction === 'desc' ? -comparison : comparison;
}

function sortEntries(entries, sort) {
  const sorted = [...entries].sort((a, b) => compareEntries(a, b, sort));
  if (!sort.foldersFirst) return sorted;

  return [
    ...sorted.filter(entry => entry.type === 'folder'),
    ...sorted.filter(entry => entry.type !== 'folder'),
  ];
}

/** Sidebar folders are real directories; the path is their identity. */
export function normalizeFolders(rawFolders) {
  if (!Array.isArray(rawFolders)) return [];

  const seenPaths = new Set();
  const folders = [];

  for (const raw of rawFolders) {
    const folderPath = String(raw?.path || '').trim();
    if (!folderPath || seenPaths.has(folderPath)) continue;

    seenPaths.add(folderPath);
    folders.push({
      path: folderPath,
      name: String(raw?.name || '').trim() || folderPath.split('/').pop() || folderPath,
      createdAt: Number(raw?.createdAt) || 0,
      collapsed: raw?.collapsed === true,
      folders: normalizeFolders(raw?.folders),
    });
  }

  return folders;
}

export function addFolder(folders, scan) {
  const existing = folders.find(folder => folder.path === scan.path);
  const merged = mergeFolderTree(existing, scan);
  if (existing) {
    Object.assign(existing, merged);
    return existing;
  }

  folders.push(merged);
  return merged;
}

/** Fold a fresh scan into the saved tree, keeping each folder's collapsed state. */
export function mergeFolderTree(existing, scan) {
  const previousChildren = new Map(
    (existing?.folders || []).map(child => [child.path, child])
  );

  return {
    path: scan.path,
    name: scan.name,
    createdAt: scan.createdAt || 0,
    collapsed: existing?.collapsed === true,
    folders: (scan.folders || []).map(
      child => mergeFolderTree(previousChildren.get(child.path), child)
    ),
  };
}

/** Every book in a scanned tree, tagged with the folder that directly holds it. */
export function flattenScannedBooks(scan, collected = []) {
  for (const book of scan.books || []) {
    collected.push({ ...book, folderPath: scan.path });
  }
  for (const child of scan.folders || []) {
    flattenScannedBooks(child, collected);
  }
  return collected;
}

export function findFolder(folders, folderPath) {
  for (const folder of folders) {
    if (folder.path === folderPath) return folder;
    const found = findFolder(folder.folders || [], folderPath);
    if (found) return found;
  }
  return null;
}

function isInsideFolder(candidatePath, rootPath) {
  return candidatePath === rootPath || String(candidatePath).startsWith(rootPath + '/');
}

/**
 * Reconcile a folder's rows with what the scan just found on disk.
 *
 * Books already open outside a folder are adopted rather than duplicated, and
 * rows anywhere under the folder whose file disappeared are dropped — the disk
 * is the source of truth. Returns the file paths that are no longer listed.
 */
export function syncFolderBooks(books, rootPath, scannedBooks) {
  const scannedPaths = new Set(scannedBooks.map(book => book.filePath));
  const removed = [];

  for (let index = books.length - 1; index >= 0; index--) {
    const book = books[index];
    if (!book.folderPath || !isInsideFolder(book.folderPath, rootPath)) continue;
    if (scannedPaths.has(book.filePath)) continue;
    removed.push(book.filePath);
    books.splice(index, 1);
  }

  const byPath = new Map(books.map(book => [book.filePath, book]));
  for (const scanned of scannedBooks) {
    const existing = byPath.get(scanned.filePath);
    if (existing) {
      existing.folderPath = scanned.folderPath;
      existing.createdAt = scanned.createdAt;
      existing.title = existing.title || scanned.title;
    } else {
      books.push({ ...scanned });
    }
  }

  return removed;
}

/** Removing a folder also removes its rows; they live on disk, not in the app. */
export function removeFolder(folders, books, folderPath) {
  const index = folders.findIndex(folder => folder.path === folderPath);
  if (index === -1) return [];

  folders.splice(index, 1);
  const removed = [];
  for (let bookIndex = books.length - 1; bookIndex >= 0; bookIndex--) {
    const book = books[bookIndex];
    if (!book.folderPath || !isInsideFolder(book.folderPath, folderPath)) continue;
    removed.push(book.filePath);
    books.splice(bookIndex, 1);
  }
  return removed;
}

function buildFolderSection(folder, booksByFolder, sort, depth) {
  const childSections = (folder.folders || []).map(
    child => buildFolderSection(child, booksByFolder, sort, depth + 1)
  );
  const entries = [
    ...childSections.map(section => ({
      type: 'folder',
      section,
      sortName: section.title,
      sortDate: section.createdAt,
    })),
    ...(booksByFolder.get(folder.path) || []).map(book => ({
      type: 'book',
      book,
      sortName: book.title,
      sortDate: book.createdAt,
    })),
  ];

  return {
    kind: 'folder',
    id: folder.path,
    title: folder.name,
    createdAt: folder.createdAt || 0,
    collapsed: folder.collapsed === true,
    depth,
    // Rows and subfolders share one ordering, so "folders first" can hoist the
    // subfolders out of it the way Finder does.
    items: sortEntries(entries, sort),
    bookCount: countBooks(folder, booksByFolder),
  };
}

function countBooks(folder, booksByFolder) {
  return (booksByFolder.get(folder.path) || []).length
    + (folder.folders || []).reduce(
      (total, child) => total + countBooks(child, booksByFolder), 0
    );
}

/**
 * Split the sidebar into its rendered groups.
 *
 * Pinned books are lifted out of their folder so they always sit above every
 * folder; they keep `folderPath` so unpinning returns them to where they were.
 * Books opened from Finder or File > Open belong to no folder and are returned
 * separately: they render as loose rows under the folders.
 */
export function buildSidebarSections(books, folders = [], rawSort = DEFAULT_SORT) {
  const sort = normalizeSort(rawSort);
  const pinnedBooks = books.filter(book => book.pinned === true);
  const filableBooks = books.filter(book => book.pinned !== true);
  const sections = [];

  if (pinnedBooks.length > 0) {
    sections.push({ kind: 'pinned', id: 'pinned', title: 'Pinned', collapsed: false, books: pinnedBooks });
  }

  const booksByFolder = new Map();
  const filedPaths = new Set();
  for (const book of filableBooks) {
    if (!book.folderPath || !findFolder(folders, book.folderPath)) continue;
    if (!booksByFolder.has(book.folderPath)) booksByFolder.set(book.folderPath, []);
    booksByFolder.get(book.folderPath).push(book);
    filedPaths.add(book.filePath);
  }

  for (const folder of folders) {
    sections.push(buildFolderSection(folder, booksByFolder, sort, 0));
  }

  const unfiledBooks = sortEntries(
    filableBooks
      .filter(book => !filedPaths.has(book.filePath))
      .map(book => ({ type: 'book', book, sortName: book.title, sortDate: book.createdAt })),
    sort
  ).map(entry => entry.book);

  return { sections, unfiledBooks };
}
