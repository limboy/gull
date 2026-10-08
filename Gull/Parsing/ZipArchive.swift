import Compression
import Foundation

/// A minimal read-only ZIP reader: enough for EPUB containers.
///
/// The file is memory-mapped and only the central directory is parsed up front;
/// entries are inflated on demand, so reading a cover costs one entry, not the
/// whole book.
nonisolated final class ZipArchive: Sendable {
    struct Entry: Sendable {
        let name: String
        let method: UInt16
        let compressedSize: Int
        let uncompressedSize: Int
        let localHeaderOffset: Int
    }

    private let data: Data
    let entries: [String: Entry]

    init(url: URL) throws {
        data = try Data(contentsOf: url, options: .alwaysMapped)
        entries = try Self.readCentralDirectory(data)
    }

    init(data: Data) throws {
        self.data = data
        entries = try Self.readCentralDirectory(data)
    }

    /// Rejects archives whose entries expand past the reader's limits (zip bombs).
    func assertReasonable() throws {
        var total = 0
        for entry in entries.values {
            if entry.uncompressedSize > BookLimits.maxEntrySize {
                throw BookError.malformed("EPUB entry is too large: \(entry.name)")
            }
            total += entry.uncompressedSize
            if total > BookLimits.maxTotalUncompressedSize {
                throw BookError.malformed("EPUB expands beyond the supported size limit")
            }
        }
    }

    /// Looks an entry up by its path, tolerating percent-encoded hrefs.
    func entry(_ path: String) -> Entry? {
        let normalized = BookPath.normalize(path)
        if let entry = entries[normalized] { return entry }
        if let decoded = normalized.removingPercentEncoding, let entry = entries[decoded] { return entry }
        // Some producers disagree with themselves about letter case.
        let lowered = normalized.lowercased()
        return entries.first { $0.key.lowercased() == lowered }?.value
    }

    func contains(_ path: String) -> Bool { entry(path) != nil }

    func read(_ path: String, maxSize: Int = BookLimits.maxEntrySize) -> Data? {
        guard let entry = entry(path), entry.uncompressedSize <= maxSize else { return nil }
        return try? read(entry)
    }

    func readText(_ path: String) -> String? {
        guard let data = read(path) else { return nil }
        return Self.decodeText(data)
    }

    static func decodeText(_ data: Data) -> String {
        if data.starts(with: [0xEF, 0xBB, 0xBF]) {
            return String(decoding: data.dropFirst(3), as: UTF8.self)
        }
        if data.starts(with: [0xFF, 0xFE]) || data.starts(with: [0xFE, 0xFF]) {
            return String(data: data, encoding: .utf16) ?? String(decoding: data, as: UTF8.self)
        }
        return String(data: data, encoding: .utf8)
            ?? String(data: data, encoding: .windowsCP1252)
            ?? String(decoding: data, as: UTF8.self)
    }

    func read(_ entry: Entry) throws -> Data {
        let base = entry.localHeaderOffset
        guard base + 30 <= data.count, data.u32(at: base) == 0x0403_4B50 else {
            throw BookError.malformed("Corrupt ZIP entry: \(entry.name)")
        }
        let nameLength = Int(data.u16(at: base + 26))
        let extraLength = Int(data.u16(at: base + 28))
        let start = base + 30 + nameLength + extraLength
        guard start + entry.compressedSize <= data.count else {
            throw BookError.malformed("Truncated ZIP entry: \(entry.name)")
        }
        let compressed = data.subdata(in: start..<(start + entry.compressedSize))
        switch entry.method {
        case 0:
            return compressed
        case 8:
            return try Self.inflate(compressed, expectedSize: entry.uncompressedSize)
        default:
            throw BookError.unsupported("Unsupported ZIP compression method \(entry.method)")
        }
    }

    /// Raw DEFLATE (RFC 1951), which is what `COMPRESSION_ZLIB` decodes.
    static func inflate(_ input: Data, expectedSize: Int) throws -> Data {
        if expectedSize == 0 { return Data() }
        var output = Data(count: expectedSize)
        let written = output.withUnsafeMutableBytes { (dst: UnsafeMutableRawBufferPointer) -> Int in
            input.withUnsafeBytes { (src: UnsafeRawBufferPointer) -> Int in
                compression_decode_buffer(
                    dst.bindMemory(to: UInt8.self).baseAddress!, expectedSize,
                    src.bindMemory(to: UInt8.self).baseAddress!, input.count,
                    nil, COMPRESSION_ZLIB)
            }
        }
        guard written > 0 else { throw BookError.malformed("Failed to inflate ZIP entry") }
        if written < expectedSize { output.count = written }
        return output
    }

    private static func readCentralDirectory(_ data: Data) throws -> [String: Entry] {
        // The end-of-central-directory record sits in the last 64 KiB + 22 bytes.
        let minimum = 22
        guard data.count >= minimum else { throw BookError.malformed("Not a ZIP archive") }
        var eocd = -1
        var position = data.count - minimum
        let floor = max(0, data.count - minimum - 65_535)
        while position >= floor {
            if data.u32(at: position) == 0x0605_4B50 { eocd = position; break }
            position -= 1
        }
        guard eocd >= 0 else { throw BookError.malformed("Not a ZIP archive") }

        var count = Int(data.u16(at: eocd + 10))
        var offset = Int(data.u32(at: eocd + 16))

        // ZIP64: the real values live in a separate record.
        if count == 0xFFFF || offset == 0xFFFF_FFFF, eocd >= 20, data.u32(at: eocd - 20) == 0x0706_4B50 {
            let zip64 = Int(data.u64(at: eocd - 20 + 8))
            if zip64 + 56 <= data.count, data.u32(at: zip64) == 0x0606_4B50 {
                count = Int(data.u64(at: zip64 + 32))
                offset = Int(data.u64(at: zip64 + 48))
            }
        }

        var entries: [String: Entry] = [:]
        entries.reserveCapacity(count)
        var cursor = offset
        for _ in 0..<count {
            guard cursor + 46 <= data.count, data.u32(at: cursor) == 0x0201_4B50 else {
                throw BookError.malformed("Corrupt ZIP central directory")
            }
            let flags = data.u16(at: cursor + 8)
            let method = data.u16(at: cursor + 10)
            var compressed = Int(data.u32(at: cursor + 20))
            var uncompressed = Int(data.u32(at: cursor + 24))
            let nameLength = Int(data.u16(at: cursor + 28))
            let extraLength = Int(data.u16(at: cursor + 30))
            let commentLength = Int(data.u16(at: cursor + 32))
            var localOffset = Int(data.u32(at: cursor + 42))
            let nameStart = cursor + 46
            guard nameStart + nameLength + extraLength <= data.count else {
                throw BookError.malformed("Corrupt ZIP central directory")
            }
            let nameData = data.subdata(in: nameStart..<(nameStart + nameLength))
            let name = (flags & 0x0800 != 0)
                ? String(decoding: nameData, as: UTF8.self)
                : (String(data: nameData, encoding: .utf8) ?? String(data: nameData, encoding: .isoLatin1) ?? "")

            // ZIP64 extended information extra field.
            var extra = nameStart + nameLength
            let extraEnd = extra + extraLength
            while extra + 4 <= extraEnd {
                let id = data.u16(at: extra)
                let size = Int(data.u16(at: extra + 2))
                if id == 0x0001 {
                    var field = extra + 4
                    if uncompressed == 0xFFFF_FFFF, field + 8 <= extraEnd { uncompressed = Int(data.u64(at: field)); field += 8 }
                    if compressed == 0xFFFF_FFFF, field + 8 <= extraEnd { compressed = Int(data.u64(at: field)); field += 8 }
                    if localOffset == 0xFFFF_FFFF, field + 8 <= extraEnd { localOffset = Int(data.u64(at: field)) }
                }
                extra += 4 + size
            }

            if flags & 0x0001 != 0 {
                // Encrypted entries are DRM or password protection; skip them.
            } else if !name.hasSuffix("/") {
                entries[name] = Entry(
                    name: name, method: method, compressedSize: compressed,
                    uncompressedSize: uncompressed, localHeaderOffset: localOffset)
            }
            cursor = nameStart + nameLength + extraLength + commentLength
        }
        return entries
    }
}

nonisolated extension Data {
    func u16(at offset: Int) -> UInt16 {
        guard offset >= 0, offset + 2 <= count else { return 0 }
        let i = startIndex + offset
        return UInt16(self[i]) | UInt16(self[i + 1]) << 8
    }

    func u32(at offset: Int) -> UInt32 {
        guard offset >= 0, offset + 4 <= count else { return 0 }
        let i = startIndex + offset
        return UInt32(self[i]) | UInt32(self[i + 1]) << 8 | UInt32(self[i + 2]) << 16 | UInt32(self[i + 3]) << 24
    }

    func u64(at offset: Int) -> UInt64 {
        UInt64(u32(at: offset)) | UInt64(u32(at: offset + 4)) << 32
    }
}
