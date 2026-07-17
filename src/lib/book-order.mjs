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
