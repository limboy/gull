import CoreServices
import Foundation

/// Walks a book folder into a tree, like `readFolderTree` in the Electron main
/// process: subfolders nest (so Calibre's `Author/Title/book.epub` keeps its
/// shape), empty branches are pruned, dotfiles and symlinks are skipped.
nonisolated enum FolderScanner {
    static let maxDepth = 4
    static let maxBooks = 500

    static func scan(_ url: URL) -> FolderScan? {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            return nil // unmounted or deleted: callers keep the saved listing
        }
        var budget = maxBooks
        return readTree(url.standardizedFileURL, depth: 0, budget: &budget)
    }

    private static let keys: Set<URLResourceKey> = [
        .isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .creationDateKey, .contentModificationDateKey,
    ]

    private static func createdAt(_ values: URLResourceValues?) -> Double {
        (values?.creationDate ?? values?.contentModificationDate).map { $0.timeIntervalSince1970 * 1000 } ?? 0
    }

    private static func readTree(_ url: URL, depth: Int, budget: inout Int) -> FolderScan {
        var node = FolderScan(
            path: url.path, name: url.lastPathComponent.isEmpty ? url.path : url.lastPathComponent,
            createdAt: createdAt(try? url.resourceValues(forKeys: keys)))
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: url, includingPropertiesForKeys: Array(keys), options: [.skipsHiddenFiles])
        else { return node }

        var subdirectories: [URL] = []
        for entry in entries.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            let values = try? entry.resourceValues(forKeys: keys)
            if values?.isSymbolicLink == true { continue }
            if values?.isDirectory == true {
                if entry.pathExtension.lowercased() != "app" { subdirectories.append(entry) }
            } else if values?.isRegularFile == true, BookFormat.isSupported(entry), budget > 0 {
                budget -= 1
                node.books.append(.init(
                    filePath: entry.path, title: entry.deletingPathExtension().lastPathComponent,
                    createdAt: createdAt(values)))
            }
        }

        if depth < maxDepth {
            for directory in subdirectories where budget > 0 {
                let child = readTree(directory, depth: depth + 1, budget: &budget)
                if !child.books.isEmpty || !child.folders.isEmpty { node.folders.append(child) }
            }
        }
        return node
    }

    /// iCloud Drive evicts files to `.<name>.icloud` placeholders; treat those as present.
    static func existsOrPlaceholder(_ path: String) -> Bool {
        if FileManager.default.fileExists(atPath: path) { return true }
        let url = URL(fileURLWithPath: path)
        let placeholder = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).icloud")
        return FileManager.default.fileExists(atPath: placeholder.path)
    }
}

/// Watches the library's root folders with FSEvents and reports which root
/// changed, debounced so a Finder copy or sync burst triggers one rescan.
final class FolderWatcher {
    private var stream: FSEventStreamRef?
    private var roots: [String] = []
    private var pending: Set<String> = []
    private var debounce: Task<Void, Never>?
    private let onChange: (String) -> Void

    static let maxWatched = 50

    init(onChange: @escaping (String) -> Void) {
        self.onChange = onChange
    }

    isolated deinit {
        if let stream {
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
        }
    }

    func watch(_ paths: [String]) {
        let next = Array(paths.prefix(Self.maxWatched)).filter { FileManager.default.fileExists(atPath: $0) }
        guard next != roots || stream == nil else { return }
        stop()
        roots = next
        guard !roots.isEmpty else { return }

        var context = FSEventStreamContext(
            version: 0, info: Unmanaged.passUnretained(self).toOpaque(), retain: nil, release: nil, copyDescription: nil)
        let callback: FSEventStreamCallback = { _, info, count, paths, _, _ in
            guard let info else { return }
            let watcher = Unmanaged<FolderWatcher>.fromOpaque(info).takeUnretainedValue()
            let changed = (unsafeBitCast(paths, to: NSArray.self) as? [String]) ?? []
            MainActor.assumeIsolated { watcher.handle(Array(changed.prefix(count))) }
        }
        stream = FSEventStreamCreate(
            nil, callback, &context, roots as CFArray, FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.4,
            FSEventStreamCreateFlags(kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagFileEvents
                | kFSEventStreamCreateFlagNoDefer))
        if let stream {
            FSEventStreamSetDispatchQueue(stream, .main)
            FSEventStreamStart(stream)
        }
    }

    private func stop() {
        guard let stream else { return }
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
        self.stream = nil
    }

    /// Only names that can change the listing matter: book files, and
    /// extension-less names (folders). Calibre metadata and cover art don't.
    private func affectsListing(_ path: String) -> Bool {
        let name = (path as NSString).lastPathComponent
        if name.hasPrefix(".") { return false }
        let ext = (name as NSString).pathExtension.lowercased()
        return ext.isEmpty || BookFormat.supportedExtensions.contains(ext)
    }

    private func handle(_ paths: [String]) {
        for path in paths where affectsListing(path) {
            if let root = roots.first(where: { LibraryRules.isInside(path, $0) }) { pending.insert(root) }
        }
        guard !pending.isEmpty else { return }
        debounce?.cancel()
        debounce = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard let self, !Task.isCancelled else { return }
            let roots = pending
            pending.removeAll()
            roots.forEach(onChange)
        }
    }
}
