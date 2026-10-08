import AppKit
import Foundation
import Observation

/// The library sidebar's state: folders added from disk, the books found in
/// them, sort order, and which book is being read. The disk is the source of
/// truth; folders are rescanned at launch, on FSEvents, and on app activation.
@Observable
final class LibraryStore {
    static let shared = LibraryStore()

    private(set) var books: [LibraryBook] = []
    private(set) var folders: [LibraryFolder] = []
    var sort = SortOptions() { didSet { saver.schedule() } }
    var activePath: String? { didSet { if oldValue != activePath { saver.schedule() } } }

    private struct Snapshot: Codable {
        var books: [LibraryBook]
        var folders: [LibraryFolder]
        var sort: SortOptions
        var activePath: String?
    }

    @ObservationIgnored private lazy var saver = DebouncedSaver { [weak self] in self?.save() }
    @ObservationIgnored private lazy var watcher = FolderWatcher { [weak self] root in
        Task { await self?.refreshFolder(root) }
    }
    @ObservationIgnored private var refreshChain: Task<Void, Never>?
    @ObservationIgnored private var lastRefresh = Date.distantPast

    private init() {
        if let snapshot = Storage.load(Snapshot.self, from: "library.json") {
            folders = snapshot.folders
            books = LibraryRules.groupPinned(snapshot.books)
            sort = snapshot.sort
            activePath = snapshot.activePath
        }
        // Folder rows are reconciled by the rescan; only drop the selection if its
        // file is gone (iCloud placeholders count as present).
        if let path = activePath, !FolderScanner.existsOrPlaceholder(path) {
            activePath = books.first(where: { FolderScanner.existsOrPlaceholder($0.filePath) })?.filePath
        }
    }

    private func save() {
        Storage.save(Snapshot(books: books, folders: folders, sort: sort, activePath: activePath), to: "library.json")
    }

    func flush() { saver.flush() }

    func sections(filter: String = "") -> (pinned: [LibraryBook], folders: [SidebarFolderSection], unfiled: [LibraryBook]) {
        LibraryRules.sections(books: books, folders: folders, sort: sort,
                              filter: filter.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    func book(at path: String) -> LibraryBook? { books.first { $0.filePath == path } }

    // MARK: Book state

    func togglePin(_ path: String) {
        LibraryRules.togglePin(&books, path)
        saver.schedule()
    }

    func toggleFinished(_ path: String) {
        LibraryRules.toggleFinished(&books, path)
        saver.schedule()
    }

    // MARK: Folders

    func setCollapsed(_ path: String, _ collapsed: Bool) {
        _ = LibraryRules.updateFolder(&folders, path) { $0.collapsed = collapsed }
        saver.schedule()
    }

    func setTreeCollapsed(_ path: String, _ collapsed: Bool) {
        _ = LibraryRules.updateFolder(&folders, path) { LibraryRules.setTreeCollapsed(&$0, collapsed) }
        saver.schedule()
    }

    func removeFolder(_ path: String) {
        let removed = LibraryRules.removeFolder(&folders, &books, path)
        forget(removed)
        saver.schedule()
        updateWatchers()
    }

    private func forget(_ paths: [String]) {
        guard let active = activePath, paths.contains(active) else { return }
        activePath = books.first?.filePath
    }

    private func apply(_ scan: FolderScan) {
        LibraryRules.addFolder(&folders, scan)
        forget(LibraryRules.syncFolderBooks(&books, root: scan.path, scanned: LibraryRules.flattenScannedBooks(scan)))
    }

    /// Shows the folder picker and adds the chosen folder.
    func addFolderFromPanel(window: NSWindow?) {
        let panel = NSOpenPanel()
        panel.title = "Add Book Folder"
        panel.prompt = "Add Folder"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = true
        let handler: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard response == .OK else { return }
            Task { await self?.addFolders(panel.urls) }
        }
        if let window { panel.beginSheetModal(for: window, completionHandler: handler) }
        else { handler(panel.runModal()) }
    }

    /// Adds folders (from the picker or a Finder drop). Non-folders are ignored.
    func addFolders(_ urls: [URL]) async {
        let scans = await Task.detached { urls.compactMap { FolderScanner.scan($0) } }.value
        guard !scans.isEmpty else { return }
        scans.forEach(apply)
        saver.schedule()
        updateWatchers()
    }

    private func enqueue(_ work: @escaping () async -> Void) async {
        let previous = refreshChain
        let task = Task { await previous?.value; await work() }
        refreshChain = task
        await task.value
    }

    /// Re-reads one folder after FSEvents reports a change under it.
    func refreshFolder(_ root: String) async {
        await enqueue { [weak self] in
            guard let self, LibraryRules.findFolder(folders, root) != nil else { return }
            lastRefresh = .now
            let url = URL(fileURLWithPath: root)
            guard let scan = await Task.detached(operation: { FolderScanner.scan(url) }).value else { return }
            apply(scan)
            saver.schedule()
        }
    }

    /// Re-reads every folder. A folder whose scan fails (unmounted drive) keeps its saved listing.
    func refreshAll() async {
        await enqueue { [weak self] in
            guard let self else { return }
            lastRefresh = .now
            updateWatchers()
            let urls = folders.map { URL(fileURLWithPath: $0.path) }
            let scans = await Task.detached { urls.compactMap { FolderScanner.scan($0) } }.value
            scans.forEach(apply)
            saver.schedule()
        }
    }

    /// Fallback for changes no watcher saw (a folder missing at launch, or deleted and recreated).
    func refreshOnActivation() {
        guard Date.now.timeIntervalSince(lastRefresh) > 2 else { return }
        Task { await refreshAll() }
    }

    private func updateWatchers() {
        watcher.watch(folders.map(\.path))
    }
}
