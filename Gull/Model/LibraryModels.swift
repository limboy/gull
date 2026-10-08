import Foundation

/// A row in the library sidebar: a book file found in one of the user's folders.
nonisolated struct LibraryBook: Codable, Hashable, Identifiable, Sendable {
    var filePath: String
    var title: String
    var pinned = false
    var finished = false
    var folderPath: String?
    var createdAt: Double = 0

    var id: String { filePath }
    var url: URL { URL(fileURLWithPath: filePath) }
}

/// A folder on disk the sidebar lists. The path is its identity.
nonisolated struct LibraryFolder: Codable, Hashable, Identifiable, Sendable {
    var path: String
    var name: String
    var createdAt: Double = 0
    var collapsed = false
    var folders: [LibraryFolder] = []

    var id: String { path }
}

nonisolated struct SortOptions: Codable, Hashable, Sendable {
    enum Key: String, Codable, Sendable { case name, created }
    enum Direction: String, Codable, Sendable { case asc, desc }

    var key: Key = .name
    var direction: Direction = .asc
    var foldersFirst = true
}

/// What a folder scan found on disk.
nonisolated struct FolderScan: Sendable {
    struct Book: Sendable {
        var filePath: String
        var title: String
        var createdAt: Double
    }

    var path: String
    var name: String
    var createdAt: Double
    var books: [Book] = []
    var folders: [FolderScan] = []
}

/// The sidebar's rendered structure. Derived on demand, never stored.
nonisolated struct SidebarFolderSection: Identifiable, Hashable, Sendable {
    var path: String
    var title: String
    var createdAt: Double
    var collapsed: Bool
    var depth: Int
    var items: [SidebarEntry]

    var id: String { path }
}

nonisolated enum SidebarEntry: Identifiable, Hashable, Sendable {
    case book(LibraryBook)
    case folder(SidebarFolderSection)

    var id: String {
        switch self {
        case .book(let book): "book:" + book.filePath
        case .folder(let section): "folder:" + section.path
        }
    }
}

/// Pure library rules, ported from `src/lib/book-order.mjs`.
nonisolated enum LibraryRules {
    static func groupPinned(_ books: [LibraryBook]) -> [LibraryBook] {
        books.filter(\.pinned) + books.filter { !$0.pinned }
    }

    /// Pinning moves a book to the first slot; unpinning moves it directly after the pinned group.
    @discardableResult
    static func togglePin(_ books: inout [LibraryBook], _ filePath: String) -> Bool? {
        guard let index = books.firstIndex(where: { $0.filePath == filePath }) else { return nil }
        var book = books.remove(at: index)
        var remaining = groupPinned(books)
        book.pinned.toggle()
        if book.pinned {
            remaining.insert(book, at: 0)
        } else {
            let firstUnpinned = remaining.firstIndex { !$0.pinned } ?? remaining.endIndex
            remaining.insert(book, at: firstUnpinned)
        }
        books = remaining
        return book.pinned
    }

    @discardableResult
    static func toggleFinished(_ books: inout [LibraryBook], _ filePath: String) -> Bool? {
        guard let index = books.firstIndex(where: { $0.filePath == filePath }) else { return nil }
        books[index].finished.toggle()
        return books[index].finished
    }

    static func findFolder(_ folders: [LibraryFolder], _ path: String) -> LibraryFolder? {
        for folder in folders {
            if folder.path == path { return folder }
            if let found = findFolder(folder.folders, path) { return found }
        }
        return nil
    }

    static func updateFolder(_ folders: inout [LibraryFolder], _ path: String, _ change: (inout LibraryFolder) -> Void) -> Bool {
        for index in folders.indices {
            if folders[index].path == path { change(&folders[index]); return true }
            if updateFolder(&folders[index].folders, path, change) { return true }
        }
        return false
    }

    static func setTreeCollapsed(_ folder: inout LibraryFolder, _ collapsed: Bool) {
        folder.collapsed = collapsed
        for index in folder.folders.indices { setTreeCollapsed(&folder.folders[index], collapsed) }
    }

    /// Folds a fresh scan into the saved tree, keeping each folder's collapsed state.
    static func mergeFolderTree(_ existing: LibraryFolder?, _ scan: FolderScan) -> LibraryFolder {
        let previous = Dictionary((existing?.folders ?? []).map { ($0.path, $0) }, uniquingKeysWith: { a, _ in a })
        return LibraryFolder(
            path: scan.path, name: scan.name, createdAt: scan.createdAt,
            collapsed: existing?.collapsed ?? false,
            folders: scan.folders.map { mergeFolderTree(previous[$0.path], $0) })
    }

    static func addFolder(_ folders: inout [LibraryFolder], _ scan: FolderScan) {
        if let index = folders.firstIndex(where: { $0.path == scan.path }) {
            folders[index] = mergeFolderTree(folders[index], scan)
        } else {
            folders.append(mergeFolderTree(nil, scan))
        }
    }

    /// Every book in a scanned tree, tagged with the folder that directly holds it.
    static func flattenScannedBooks(_ scan: FolderScan) -> [LibraryBook] {
        scan.books.map {
            LibraryBook(filePath: $0.filePath, title: $0.title, folderPath: scan.path, createdAt: $0.createdAt)
        } + scan.folders.flatMap(flattenScannedBooks)
    }

    static func isInside(_ candidate: String, _ root: String) -> Bool {
        candidate == root || candidate.hasPrefix(root + "/")
    }

    /// Reconciles a folder's rows with a scan. The disk is the source of truth:
    /// rows whose file vanished are dropped, new files appended. Returns the
    /// file paths that are no longer listed.
    static func syncFolderBooks(_ books: inout [LibraryBook], root: String, scanned: [LibraryBook]) -> [String] {
        let scannedPaths = Set(scanned.map(\.filePath))
        var removed: [String] = []
        books.removeAll { book in
            guard let folder = book.folderPath, isInside(folder, root), !scannedPaths.contains(book.filePath) else { return false }
            removed.append(book.filePath)
            return true
        }
        var indexByPath = Dictionary(books.enumerated().map { ($1.filePath, $0) }, uniquingKeysWith: { a, _ in a })
        for book in scanned {
            if let index = indexByPath[book.filePath] {
                books[index].folderPath = book.folderPath
                books[index].createdAt = book.createdAt
                if books[index].title.isEmpty { books[index].title = book.title }
            } else {
                indexByPath[book.filePath] = books.count
                books.append(book)
            }
        }
        return removed
    }

    /// Removing a folder unlists it and every row beneath it. Nothing is deleted from disk.
    static func removeFolder(_ folders: inout [LibraryFolder], _ books: inout [LibraryBook], _ path: String) -> [String] {
        guard let index = folders.firstIndex(where: { $0.path == path }) else { return [] }
        folders.remove(at: index)
        var removed: [String] = []
        books.removeAll { book in
            guard let folder = book.folderPath, isInside(folder, path) else { return false }
            removed.append(book.filePath)
            return true
        }
        return removed
    }

    private struct SortEntry {
        let entry: SidebarEntry
        let name: String
        let date: Double
        let isFolder: Bool
    }

    private static func sortEntries(_ entries: [SortEntry], _ sort: SortOptions) -> [SidebarEntry] {
        let sorted = entries.sorted { a, b in
            var order = a.name.localizedStandardCompare(b.name)
            if sort.key == .created, a.date != b.date { order = a.date < b.date ? .orderedAscending : .orderedDescending }
            return sort.direction == .asc ? order == .orderedAscending : order == .orderedDescending
        }
        guard sort.foldersFirst else { return sorted.map(\.entry) }
        return sorted.filter(\.isFolder).map(\.entry) + sorted.filter { !$0.isFolder }.map(\.entry)
    }

    private static func folderSection(_ folder: LibraryFolder, _ booksByFolder: [String: [LibraryBook]],
                                      _ sort: SortOptions, depth: Int) -> SidebarFolderSection {
        let children = folder.folders.map { folderSection($0, booksByFolder, sort, depth: depth + 1) }
        let entries = children.map { SortEntry(entry: .folder($0), name: $0.title, date: $0.createdAt, isFolder: true) }
            + (booksByFolder[folder.path] ?? []).map {
                SortEntry(entry: .book($0), name: $0.title, date: $0.createdAt, isFolder: false)
            }
        return SidebarFolderSection(
            path: folder.path, title: folder.name, createdAt: folder.createdAt,
            collapsed: folder.collapsed, depth: depth, items: sortEntries(entries, sort))
    }

    /// Splits the library into pinned books, folder sections, and loose rows.
    /// Pinned books are lifted out of their folder but keep `folderPath`.
    static func sections(books: [LibraryBook], folders: [LibraryFolder], sort: SortOptions)
        -> (pinned: [LibraryBook], folders: [SidebarFolderSection], unfiled: [LibraryBook])
    {
        let pinned = books.filter(\.pinned)
        var booksByFolder: [String: [LibraryBook]] = [:]
        var unfiled: [LibraryBook] = []
        for book in books where !book.pinned {
            if let folder = book.folderPath, findFolder(folders, folder) != nil {
                booksByFolder[folder, default: []].append(book)
            } else {
                unfiled.append(book)
            }
        }
        let sections = folders.map { folderSection($0, booksByFolder, sort, depth: 0) }
        let loose = sortEntries(unfiled.map { SortEntry(entry: .book($0), name: $0.title, date: $0.createdAt, isFolder: false) }, sort)
            .compactMap { if case .book(let book) = $0 { book } else { nil } }
        return (pinned, sections, loose)
    }
}
