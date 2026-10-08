import AppKit
import CryptoKit
import ImageIO
import PDFKit

/// Sidebar cover thumbnails. Extraction is deduped, capped at three at a time,
/// and cached on disk keyed by path + size + mtime, so replacing a book on disk
/// invalidates its thumbnail. A `.none` marker records "this book has no cover";
/// failures are left uncached so a book that was mid-sync retries later.
actor CoverService {
    static let shared = CoverService()
    static let thumbnailHeight: CGFloat = 96

    private let memory = NSCache<NSString, NSImage>()
    private var noCover = Set<String>()
    private var inFlight: [String: Task<NSImage?, Never>] = [:]
    private var running = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private let directory: URL = {
        let url = Storage.cachesDirectory.appendingPathComponent("covers", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    func cover(for path: String) async -> NSImage? {
        if let image = memory.object(forKey: path as NSString) { return image }
        if noCover.contains(path) { return nil }
        if let task = inFlight[path] { return await task.value }

        let task = Task<NSImage?, Never> { await self.load(path) }
        inFlight[path] = task
        let image = await task.value
        inFlight[path] = nil
        if let image { memory.setObject(image, forKey: path as NSString) } else { noCover.insert(path) }
        return image
    }

    private func cacheKey(_ path: String) -> String? {
        guard let values = try? URL(fileURLWithPath: path).resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey]),
              values.isRegularFile == true, let size = values.fileSize, size <= BookLimits.maxBookFileSize
        else { return nil }
        let mtime = Int((values.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000)
        let digest = Insecure.SHA1.hash(data: Data("\(path)\n\(size)\n\(mtime)".utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private func load(_ path: String) async -> NSImage? {
        guard let key = cacheKey(path) else { return nil }
        let file = directory.appendingPathComponent("\(key).jpg")
        let marker = directory.appendingPathComponent("\(key).none")
        if let image = NSImage(contentsOf: file) { return image }
        if FileManager.default.fileExists(atPath: marker.path) { return nil }

        await acquire()
        defer { release() }
        let result = await Task.detached(priority: .utility) { () -> Result<Data?, Error> in
            Result { try Self.extract(URL(fileURLWithPath: path)) }
        }.value

        switch result {
        case .success(let jpeg?):
            try? jpeg.write(to: file, options: .atomic)
            return NSImage(data: jpeg)
        case .success(nil):
            FileManager.default.createFile(atPath: marker.path, contents: nil)
            return nil
        case .failure:
            return nil
        }
    }

    private func acquire() async {
        if running < 3 { running += 1; return }
        await withCheckedContinuation { waiters.append($0) }
    }

    private func release() {
        if waiters.isEmpty { running -= 1 } else { waiters.removeFirst().resume() }
    }

    /// Returns a JPEG thumbnail, nil when the book has no cover.
    nonisolated static func extract(_ url: URL) throws -> Data? {
        guard let format = BookFormat(url: url) else { return nil }
        let source: CGImage?
        switch format {
        case .pdf:
            guard let page = PDFDocument(url: url)?.page(at: 0) else { return nil }
            let bounds = page.bounds(for: .cropBox)
            let scale = thumbnailHeight * 2 / max(bounds.height, 1)
            let image = page.thumbnail(of: CGSize(width: bounds.width * scale, height: bounds.height * scale), for: .cropBox)
            source = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
        case .epub:
            guard let data = try EPUBParser.cover(url: url) else { return nil }
            source = downsample(data)
        default:
            guard let data = try MOBIParser.cover(url: url) else { return nil }
            source = downsample(data)
        }
        guard let source else { return nil }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, "public.jpeg" as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, source, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return output as Data
    }

    nonisolated private static func downsample(_ data: Data) -> CGImage? {
        if let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0 {
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: thumbnailHeight * 2,
            ]
            if let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) { return image }
        }
        // SVG covers: let AppKit rasterize them.
        guard let image = NSImage(data: data) else { return nil }
        let size = NSSize(width: thumbnailHeight * 2 * image.size.width / max(image.size.height, 1), height: thumbnailHeight * 2)
        var rect = NSRect(origin: .zero, size: size)
        return image.cgImage(forProposedRect: &rect, context: nil, hints: nil)
    }
}
