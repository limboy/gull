import Foundation

/// The file extensions Gull can open.
nonisolated enum BookFormat: String, Sendable {
    case epub, mobi, azw3, azw, prc, pdf

    static let supportedExtensions: Set<String> = ["epub", "mobi", "azw3", "azw", "prc", "pdf"]

    init?(url: URL) {
        self.init(rawValue: url.pathExtension.lowercased())
    }

    var isKindle: Bool { self == .mobi || self == .azw3 || self == .azw || self == .prc }

    static func isSupported(_ url: URL) -> Bool {
        supportedExtensions.contains(url.pathExtension.lowercased())
    }
}

/// One table-of-contents entry. `href` is either `chapterHref#fragment` or a
/// chapter href on its own, using the same form as `Chapter.href`.
nonisolated struct TocItem: Sendable, Hashable, Codable {
    var title: String
    var href: String
    var children: [TocItem] = []
}

/// A reflowable chapter, already sanitized and ready to inject into the reader.
nonisolated struct Chapter: Sendable, Codable {
    var id: String
    var href: String
    var html: String
    /// Plain text used for the search index.
    var text: String
}

/// The payload a reflowable book is reduced to, whatever its source format.
nonisolated struct ReflowableBook: Sendable {
    var title: String
    var language: String
    var identifier: String
    var chapters: [Chapter]
    var css: String
    var toc: [TocItem]
    var resources: any BookResourceProvider
}

/// Serves the images a book's markup references through the `gull://` scheme.
nonisolated protocol BookResourceProvider: Sendable {
    func resource(at path: String) -> (data: Data, mimeType: String)?
}

nonisolated enum BookError: LocalizedError {
    case invalidPath
    case tooLarge(Int)
    case malformed(String)
    case unsupported(String)
    case encrypted

    var errorDescription: String? {
        switch self {
        case .invalidPath: "The book could not be found."
        case .tooLarge(let limit): "Book exceeds the \(limit / 1024 / 1024) MB size limit."
        case .malformed(let detail): detail
        case .unsupported(let detail): detail
        case .encrypted: "This book is protected and cannot be opened."
        }
    }
}

nonisolated enum BookLimits {
    static let maxBookFileSize = 512 * 1024 * 1024
    static let maxEntrySize = 128 * 1024 * 1024
    static let maxTotalUncompressedSize = 1024 * 1024 * 1024
    static let maxSpineItems = 10_000
    static let maxCoverSize = 32 * 1024 * 1024

    /// Validates a book path the same way the Electron main process did.
    static func validate(_ url: URL) throws {
        guard url.isFileURL, BookFormat.isSupported(url) else { throw BookError.invalidPath }
        let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values?.isRegularFile == true else { throw BookError.invalidPath }
        if let size = values?.fileSize, size > maxBookFileSize {
            throw BookError.tooLarge(maxBookFileSize)
        }
    }
}

nonisolated enum MimeType {
    static func forImagePath(_ path: String) -> String {
        let clean = path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? path
        switch (clean as NSString).pathExtension.lowercased() {
        case "svg": return "image/svg+xml"
        case "jpg", "jpeg": return "image/jpeg"
        case "png": return "image/png"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "bmp": return "image/bmp"
        default: return "image/png"
        }
    }

    /// Sniffs an image type from its magic bytes (MOBI resources carry no names).
    static func sniff(_ data: Data) -> String? {
        let bytes = [UInt8](data.prefix(12))
        func starts(_ sig: [UInt8]) -> Bool { bytes.count >= sig.count && Array(bytes[0..<sig.count]) == sig }
        if starts([0xFF, 0xD8, 0xFF]) { return "image/jpeg" }
        if starts([0x89, 0x50, 0x4E, 0x47]) { return "image/png" }
        if starts([0x47, 0x49, 0x46, 0x38]) { return "image/gif" }
        if starts([0x42, 0x4D]) { return "image/bmp" }
        if starts([0x3C, 0x73, 0x76, 0x67]) || starts([0x3C, 0x3F, 0x78, 0x6D]) { return "image/svg+xml" }
        if bytes.count >= 12, starts([0x52, 0x49, 0x46, 0x46]), Array(bytes[8..<12]) == [0x57, 0x45, 0x42, 0x50] {
            return "image/webp"
        }
        return nil
    }
}

nonisolated enum BookPath {
    /// POSIX-style normalization (`a/./b/../c` → `a/c`), like `path.posix.normalize`.
    static func normalize(_ path: String) -> String {
        var parts: [Substring] = []
        for part in path.split(separator: "/", omittingEmptySubsequences: true) {
            if part == "." { continue }
            if part == ".." {
                if !parts.isEmpty, parts.last != ".." { parts.removeLast() } else { parts.append(part) }
                continue
            }
            parts.append(part)
        }
        return parts.joined(separator: "/")
    }

    static func directory(of path: String) -> String {
        guard let slash = path.lastIndex(of: "/") else { return "" }
        return String(path[..<slash])
    }

    static func join(_ dir: String, _ relative: String) -> String {
        normalize(dir.isEmpty ? relative : dir + "/" + relative)
    }

    /// Splits `file.xhtml#frag` into its parts, stripping any query.
    static func splitFragment(_ href: String) -> (path: String, fragment: String?) {
        let pieces = href.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)
        var path = String(pieces.first ?? "")
        if let query = path.firstIndex(of: "?") { path = String(path[..<query]) }
        let fragment = pieces.count > 1 ? String(pieces[1]) : nil
        return (path, fragment)
    }
}
