import Foundation

// MARK: - Byte helpers

nonisolated extension Array where Element == UInt8 {
    func be16(_ offset: Int) -> Int {
        guard offset >= 0, offset + 2 <= count else { return 0 }
        return Int(self[offset]) << 8 | Int(self[offset + 1])
    }

    func be32(_ offset: Int) -> Int {
        guard offset >= 0, offset + 4 <= count else { return 0xFFFF_FFFF }
        return Int(self[offset]) << 24 | Int(self[offset + 1]) << 16 | Int(self[offset + 2]) << 8 | Int(self[offset + 3])
    }

    func ascii(_ offset: Int, _ length: Int) -> String {
        guard offset >= 0, offset + length <= count else { return "" }
        return String(decoding: self[offset..<(offset + length)], as: UTF8.self)
    }

    func slice(_ start: Int, _ end: Int) -> [UInt8] {
        let lower = Swift.max(0, Swift.min(start, count))
        let upper = Swift.max(lower, Swift.min(end, count))
        return Array(self[lower..<upper])
    }
}

/// Forward variable-width integer used by INDX/CNCX records.
nonisolated private func varLen(_ bytes: [UInt8], _ start: Int) -> (value: Int, length: Int) {
    var value = 0
    var length = 0
    var i = start
    while i < bytes.count, length < 4 {
        let byte = bytes[i]
        value = value << 7 | Int(byte & 0x7F)
        length += 1
        i += 1
        if byte & 0x80 != 0 { break }
    }
    return (value, Swift.max(length, 1))
}

nonisolated private func popCount(_ x: Int) -> Int { x.nonzeroBitCount }

nonisolated private func trailingZeros(_ x: Int) -> Int { x == 0 ? 0 : x.trailingZeroBitCount }

// MARK: - PalmDB / MOBI headers

nonisolated final class MobiFile {
    struct Header {
        var compression = 0
        var numTextRecords = 0
        var encryption = 0
        var length = 0
        var encoding = 65001
        var uid = 0
        var version = 0
        var title = ""
        var localeLanguage = 0
        var resourceStart = 0xFFFF_FFFF
        var huffcdic = 0
        var numHuffcdic = 0
        var exthFlag = 0
        var trailingFlags = 0
        var indx = 0xFFFF_FFFF
        // KF8
        var fdst = 0xFFFF_FFFF
        var frag = 0xFFFF_FFFF
        var skel = 0xFFFF_FFFF
        var guide = 0xFFFF_FFFF
    }

    struct Exth {
        var title: String?
        var creators: [String] = []
        var language: String?
        var asin: String?
        var boundary: Int?
        var coverOffset: Int?
        var thumbnailOffset: Int?
    }

    let bytes: [UInt8]
    private(set) var records: [(start: Int, end: Int)] = []
    private(set) var start = 0
    private(set) var header = Header()
    private(set) var exth = Exth()
    private(set) var isKF8 = false
    private(set) var resourceStart = 0xFFFF_FFFF
    private var huffman: HuffmanDecoder?

    init(bytes: [UInt8]) throws {
        self.bytes = bytes
        guard bytes.count >= 78 else { throw BookError.malformed("Not a MOBI file") }
        let numRecords = bytes.be16(76)
        guard numRecords > 0, 78 + numRecords * 8 <= bytes.count else { throw BookError.malformed("Not a MOBI file") }
        let starts = (0..<numRecords).map { bytes.be32(78 + $0 * 8) }
        records = starts.enumerated().map { index, start in
            (start, index + 1 < starts.count ? starts[index + 1] : bytes.count)
        }

        try parseFirstRecord(loadRecord(0))
        resourceStart = header.resourceStart
        if !isKF8, let boundary = exth.boundary, boundary < 0xFFFF_FFFF, boundary < records.count {
            // A combined MOBI6 + KF8 file: prefer the KF8 section.
            let saved = (header, exth)
            do {
                start = boundary
                try parseFirstRecord(loadRecord(0))
                isKF8 = true
            } catch {
                start = 0
                (header, exth) = saved
                isKF8 = false
            }
        }
        if header.encryption != 0 { throw BookError.encrypted }
        if header.compression == 17480 {
            huffman = try HuffmanDecoder(file: self)
        } else if header.compression != 1, header.compression != 2 {
            throw BookError.unsupported("Unsupported MOBI compression")
        }
    }

    func pdbRecord(_ index: Int) -> [UInt8] {
        guard index >= 0, index < records.count else { return [] }
        let (s, e) = records[index]
        return bytes.slice(s, e)
    }

    func loadRecord(_ index: Int) -> [UInt8] { pdbRecord(start + index) }

    var stringEncoding: String.Encoding { header.encoding == 1252 ? .windowsCP1252 : .utf8 }

    func decode(_ data: [UInt8]) -> String {
        if header.encoding == 1252 { return String(data: Data(data), encoding: .windowsCP1252) ?? "" }
        return String(decoding: data, as: UTF8.self)
    }

    private func parseFirstRecord(_ record: [UInt8]) throws {
        guard record.ascii(16, 4) == "MOBI" else { throw BookError.malformed("Missing MOBI header") }
        var h = Header()
        h.compression = record.be16(0)
        h.numTextRecords = record.be16(8)
        h.encryption = record.be16(12)
        h.length = record.be32(20)
        h.encoding = record.be32(28)
        h.uid = record.be32(32)
        h.version = record.be32(36)
        let titleOffset = record.be32(84)
        let titleLength = record.be32(88)
        h.localeLanguage = record.count > 95 ? Int(record[95]) : 0
        h.resourceStart = record.be32(108)
        h.huffcdic = record.be32(112)
        h.numHuffcdic = record.be32(116)
        h.exthFlag = record.be32(128)
        if h.length >= 0xE4, h.version >= 5 { h.trailingFlags = record.be32(240) }
        h.indx = record.be32(244)
        if h.version >= 8 {
            h.fdst = record.be32(192)
            h.frag = record.be32(248)
            h.skel = record.be32(252)
            h.guide = record.be32(260)
        }
        header = h
        isKF8 = h.version >= 8
        let titleBytes = record.slice(titleOffset, titleOffset + titleLength)
        header.title = decode(titleBytes)
        exth = (h.exthFlag & 0x40) != 0 ? parseExth(record.slice(h.length + 16, record.count)) : Exth()
    }

    private func parseExth(_ buffer: [UInt8]) -> Exth {
        var result = Exth()
        guard buffer.ascii(0, 4) == "EXTH" else { return result }
        let count = buffer.be32(8)
        var offset = 12
        for _ in 0..<min(count, 10_000) {
            let type = buffer.be32(offset)
            let length = buffer.be32(offset + 4)
            guard length >= 8, offset + length <= buffer.count else { break }
            let data = buffer.slice(offset + 8, offset + length)
            let uint = data.count == 4 ? data.be32(0) : nil
            switch type {
            case 100: result.creators.append(decode(data))
            case 113: result.asin = decode(data)
            case 121: result.boundary = uint
            case 201: result.coverOffset = uint
            case 202: result.thumbnailOffset = uint
            case 503: result.title = decode(data)
            case 524: if result.language == nil { result.language = decode(data) }
            default: break
            }
            offset += length
        }
        return result
    }

    // MARK: Text

    /// Strips the extra data entries trailing a text record.
    private func removeTrailingEntries(_ input: [UInt8]) -> [UInt8] {
        var array = input
        let flags = header.trailingFlags
        let multibyte = flags & 1
        for _ in 0..<popCount(flags >> 1) {
            var value = 0
            for byte in array.suffix(4) {
                if byte & 0x80 != 0 { value = 0 }
                value = value << 7 | Int(byte & 0x7F)
            }
            guard value > 0, value <= array.count else { break }
            array.removeLast(value)
        }
        if multibyte != 0, let last = array.last {
            let length = Int(last & 3) + 1
            if length <= array.count { array.removeLast(length) }
        }
        return array
    }

    func loadTextRecord(_ index: Int) -> [UInt8] {
        let raw = removeTrailingEntries(loadRecord(index + 1))
        switch header.compression {
        case 2: return Self.decompressPalmDOC(raw)
        case 17480: return huffman?.decompress(raw) ?? []
        default: return raw
        }
    }

    func loadAllText() -> [UInt8] {
        var output: [UInt8] = []
        for index in 0..<header.numTextRecords { output += loadTextRecord(index) }
        return output
    }

    static func decompressPalmDOC(_ input: [UInt8]) -> [UInt8] {
        var output: [UInt8] = []
        output.reserveCapacity(input.count * 2)
        var i = 0
        while i < input.count {
            let byte = input[i]
            if byte == 0 {
                output.append(0)
            } else if byte <= 8 {
                let end = min(input.count, i + 1 + Int(byte))
                output.append(contentsOf: input[(i + 1)..<end])
                i += Int(byte)
            } else if byte <= 0x7F {
                output.append(byte)
            } else if byte <= 0xBF {
                guard i + 1 < input.count else { break }
                let pair = Int(byte) << 8 | Int(input[i + 1])
                i += 1
                let distance = (pair & 0x3FFF) >> 3
                let length = (pair & 7) + 3
                if distance > 0, distance <= output.count {
                    for _ in 0..<length { output.append(output[output.count - distance]) }
                }
            } else {
                output.append(0x20)
                output.append(byte ^ 0x80)
            }
            i += 1
        }
        return output
    }

    // MARK: Resources

    func loadResource(_ index: Int) -> [UInt8]? {
        guard resourceStart < 0xFFFF_FFFF else { return nil }
        let record = pdbRecord(resourceStart + index)
        guard !record.isEmpty else { return nil }
        switch record.ascii(0, 4) {
        case "FONT", "VIDE", "AUDI", "RESC", "FDST", "DATP", "SRCS", "CMET", "BOUN", "FLIS", "FCIS":
            return nil
        default:
            return record
        }
    }

    func coverImage() -> [UInt8]? {
        let offset = [exth.coverOffset, exth.thumbnailOffset].compactMap { $0 }.first { $0 < 0xFFFF_FFFF }
        return offset.flatMap(loadResource)
    }

    var language: String {
        if let language = exth.language, !language.isEmpty { return language }
        let map: [Int: String] = [
            4: "zh", 7: "de", 9: "en", 10: "es", 12: "fr", 16: "it", 17: "ja", 18: "ko", 19: "nl",
            21: "pl", 22: "pt", 25: "ru", 29: "sv",
        ]
        return map[header.localeLanguage] ?? ""
    }

    // MARK: Indexes

    struct IndexEntry {
        let name: String
        let tagMap: [Int: [Int]]
    }

    func indexData(_ indxIndex: Int) throws -> (table: [IndexEntry], cncx: [Int: String]) {
        let indxRecord = loadRecord(indxIndex)
        guard indxRecord.ascii(0, 4) == "INDX" else { throw BookError.malformed("Invalid INDX record") }
        let length = indxRecord.be32(4)
        let numRecords = indxRecord.be32(24)
        let encoding = indxRecord.be32(28)
        let numCncx = indxRecord.be32(52)
        let decodeCncx: ([UInt8]) -> String = { bytes in
            encoding == 1252
                ? (String(data: Data(bytes), encoding: .windowsCP1252) ?? "")
                : String(decoding: bytes, as: UTF8.self)
        }

        var cncx: [Int: String] = [:]
        var cncxRecordOffset = 0
        for i in 0..<min(numCncx, 1000) {
            let record = loadRecord(indxIndex + numRecords + i + 1)
            var pos = 0
            while pos < record.count {
                let index = pos
                let (value, len) = varLen(record, pos)
                pos += len
                cncx[cncxRecordOffset + index] = decodeCncx(record.slice(pos, pos + value))
                pos += value
            }
            cncxRecordOffset += 0x10000
        }

        let tagx = indxRecord.slice(length, indxRecord.count)
        guard tagx.ascii(0, 4) == "TAGX" else { throw BookError.malformed("Invalid TAGX section") }
        let tagxLength = tagx.be32(4)
        let numControlBytes = tagx.be32(8)
        let numTags = max(0, (tagxLength - 12) / 4)
        let tagTable: [[Int]] = (0..<numTags).map { i in
            (0..<4).map { Int(tagx[safe: 12 + i * 4 + $0] ?? 0) }
        }

        var table: [IndexEntry] = []
        for i in 0..<min(numRecords, 10_000) {
            let record = loadRecord(indxIndex + 1 + i)
            guard record.ascii(0, 4) == "INDX" else { throw BookError.malformed("Invalid INDX record") }
            let idxt = record.be32(20)
            let entryCount = record.be32(24)
            for j in 0..<min(entryCount, 100_000) {
                let offset = record.be16(idxt + 4 + 2 * j)
                let nameLength = Int(record[safe: offset] ?? 0)
                let name = record.ascii(offset + 1, nameLength)
                let startPos = offset + 1 + nameLength
                var controlByteIndex = 0
                var pos = startPos + numControlBytes
                var tags: [(tag: Int, valueCount: Int, valueBytes: Int, numValues: Int)] = []
                for entry in tagTable {
                    let (tag, numValues, mask, end) = (entry[0], entry[1], entry[2], entry[3])
                    if end & 1 != 0 { controlByteIndex += 1; continue }
                    let value = Int(record[safe: startPos + controlByteIndex] ?? 0) & mask
                    if value == mask, mask != 0 {
                        if popCount(mask) > 1 {
                            let (bytesValue, len) = varLen(record, pos)
                            tags.append((tag, 0, bytesValue, numValues))
                            pos += len
                        } else {
                            tags.append((tag, 1, 0, numValues))
                        }
                    } else if mask != 0 {
                        tags.append((tag, value >> trailingZeros(mask), 0, numValues))
                    }
                }
                var tagMap: [Int: [Int]] = [:]
                for (tag, valueCount, valueBytes, numValues) in tags {
                    var values: [Int] = []
                    if valueCount != 0 {
                        for _ in 0..<(valueCount * numValues) {
                            let (value, len) = varLen(record, pos)
                            values.append(value); pos += len
                        }
                    } else {
                        var consumed = 0
                        while consumed < valueBytes, pos < record.count {
                            let (value, len) = varLen(record, pos)
                            values.append(value); pos += len; consumed += len
                        }
                    }
                    tagMap[tag] = values
                }
                table.append(IndexEntry(name: name, tagMap: tagMap))
            }
        }
        return (table, cncx)
    }

    struct NCXEntry {
        let index: Int
        let label: String
        let headingLevel: Int
        let pos: [Int]
        let offset: Int?
        let parent: Int?
        var children: [NCXEntry] = []
    }

    func ncx() -> [NCXEntry]? {
        guard header.indx < 0xFFFF_FFFF, let data = try? indexData(header.indx) else { return nil }
        let items = data.table.enumerated().map { index, entry in
            NCXEntry(
                index: index,
                label: entry.tagMap[3]?.first.flatMap { data.cncx[$0] } ?? "",
                headingLevel: entry.tagMap[4]?.first ?? 0,
                pos: entry.tagMap[6] ?? [],
                offset: entry.tagMap[1]?.first,
                parent: entry.tagMap[21]?.first)
        }
        func withChildren(_ item: NCXEntry, depth: Int) -> NCXEntry {
            var item = item
            if depth < 16 {
                item.children = items.filter { $0.parent == item.index }.map { withChildren($0, depth: depth + 1) }
            }
            return item
        }
        return items.filter { $0.headingLevel == 0 }.map { withChildren($0, depth: 0) }
    }
}

nonisolated extension Array {
    subscript(safe index: Int) -> Element? {
        index >= 0 && index < count ? self[index] : nil
    }
}

// MARK: - HUFF/CDIC

nonisolated final class HuffmanDecoder {
    private var table1: [(found: Bool, codeLength: Int, value: Int)] = []
    private var table2: [(min: Int, max: Int)] = []
    private var dictionary: [(bytes: [UInt8], decompressed: Bool)] = []
    private var depth = 0

    init(file: MobiFile) throws {
        let huff = file.loadRecord(file.header.huffcdic)
        guard huff.ascii(0, 4) == "HUFF" else { throw BookError.malformed("Invalid HUFF record") }
        let offset1 = huff.be32(8)
        let offset2 = huff.be32(12)
        table1 = (0..<256).map { i in
            let x = huff.be32(offset1 + i * 4)
            return (x & 0x80 != 0, x & 0x1F, x >> 8)
        }
        table2 = [(0, 0)] + (0..<32).map { i in
            (huff.be32(offset2 + i * 8), huff.be32(offset2 + i * 8 + 4))
        }
        for i in 1..<max(1, file.header.numHuffcdic) {
            let record = file.loadRecord(file.header.huffcdic + i)
            guard record.ascii(0, 4) == "CDIC" else { throw BookError.malformed("Invalid CDIC record") }
            let headerLength = record.be32(4)
            let numEntries = record.be32(8)
            let codeLength = record.be32(12)
            let n = min(1 << min(codeLength, 30), numEntries - dictionary.count)
            let buffer = record.slice(headerLength, record.count)
            for j in 0..<max(0, n) {
                let offset = buffer.be16(j * 2)
                let x = buffer.be16(offset)
                let length = x & 0x7FFF
                dictionary.append((buffer.slice(offset + 2, offset + 2 + length), x & 0x8000 != 0))
            }
        }
    }

    private func read32Bits(_ bytes: [UInt8], _ from: Int) -> UInt64 {
        let startByte = from >> 3
        var word: UInt64 = 0
        for k in 0..<8 {
            word = word << 8 | UInt64(bytes[safe: startByte + k] ?? 0)
        }
        return (word << UInt64(from & 7)) >> 32 & 0xFFFF_FFFF
    }

    func decompress(_ input: [UInt8]) -> [UInt8] {
        depth += 1
        defer { depth -= 1 }
        guard depth < 32 else { return [] }
        var output: [UInt8] = []
        let bitLength = input.count * 8
        var i = 0
        while i < bitLength {
            let bits = read32Bits(input, i)
            var (found, codeLength, value) = table1[Int(bits >> 24)]
            if !found {
                while codeLength < 32, (bits >> UInt64(32 - codeLength)) < UInt64(table2[codeLength].min) {
                    codeLength += 1
                }
                value = table2[min(codeLength, 32)].max
            }
            guard codeLength > 0 else { break }
            i += codeLength
            if i > bitLength { break }
            let code = value - Int(bits >> UInt64(32 - codeLength))
            guard code >= 0, code < dictionary.count else { break }
            var (result, decompressed) = dictionary[code]
            if !decompressed {
                result = decompress(result)
                dictionary[code] = (result, true)
            }
            output += result
        }
        return output
    }
}

// MARK: - Book assembly

nonisolated struct MobiResources: BookResourceProvider {
    let embeds: [String: (Data, String)]

    func resource(at path: String) -> (data: Data, mimeType: String)? {
        embeds[path].map { ($0.0, $0.1) }
    }
}

nonisolated enum MOBIParser {
    private static let kindleEmbed = try! NSRegularExpression(
        pattern: #"kindle:(flow|embed):([0-9A-Va-v]+)(?:\?mime=([\w/+.-]+))?"#)
    private static let kindlePos = try! NSRegularExpression(
        pattern: #"kindle:pos:fid:([0-9A-Va-v]+):off:([0-9A-Va-v]+)"#)
    private static let anchorAttribute = try! NSRegularExpression(
        pattern: #"<[^>]+\s(id|name|aid)\s*=\s*['"]([^'"]+)['"]"#, options: .caseInsensitive)

    static func parse(url: URL, token: String) throws -> ReflowableBook {
        let data = try Data(contentsOf: url, options: .alwaysMapped)
        let file = try MobiFile(bytes: [UInt8](data))
        let fallbackTitle = url.deletingPathExtension().lastPathComponent
        let title = (file.exth.title?.isEmpty == false ? file.exth.title : nil)
            ?? (file.header.title.isEmpty ? fallbackTitle : file.header.title)
        let identifier = file.exth.asin ?? String(file.header.uid)
        return file.isKF8
            ? try parseKF8(file, title: title, identifier: identifier, token: token)
            : try parseMOBI6(file, title: title, identifier: identifier, token: token)
    }

    static func cover(url: URL) throws -> Data? {
        let data = try Data(contentsOf: url, options: .alwaysMapped)
        let file = try MobiFile(bytes: [UInt8](data))
        return file.coverImage().map { Data($0) }
    }

    static func base32(_ string: String) -> Int { Int(string, radix: 32) ?? 0 }

    // MARK: KF8

    private struct Skeleton { let numFrag: Int; let offset: Int; let length: Int }
    private struct Fragment { let insertOffset: Int; let index: Int; let offset: Int; let length: Int }
    private struct KF8Chapter { let id: String; let skeleton: Skeleton; let fragments: [Fragment]; let length: Int }

    private static func parseKF8(_ file: MobiFile, title: String, identifier: String, token: String) throws -> ReflowableBook {
        let fdstRecord = file.loadRecord(file.header.fdst)
        guard fdstRecord.ascii(0, 4) == "FDST" else { throw BookError.malformed("Missing FDST record") }
        let flows: [(Int, Int)] = (0..<fdstRecord.be32(8)).map {
            (fdstRecord.be32(12 + $0 * 8), fdstRecord.be32(16 + $0 * 8))
        }
        let text = file.loadAllText()

        let skeletons = try file.indexData(file.header.skel).table.map {
            Skeleton(numFrag: $0.tagMap[1]?.first ?? 0, offset: $0.tagMap[6]?[safe: 0] ?? 0, length: $0.tagMap[6]?[safe: 1] ?? 0)
        }
        let fragments = try file.indexData(file.header.frag).table.map {
            Fragment(insertOffset: Int($0.name) ?? 0, index: $0.tagMap[4]?.first ?? 0,
                     offset: $0.tagMap[6]?[safe: 0] ?? 0, length: $0.tagMap[6]?[safe: 1] ?? 0)
        }

        var chapters: [KF8Chapter] = []
        var fragmentChapter: [Int] = [] // fragment table position → chapter index
        var fragStart = 0
        for (index, skeleton) in skeletons.enumerated() {
            let end = min(fragments.count, fragStart + skeleton.numFrag)
            let frags = Array(fragments[min(fragStart, end)..<end])
            fragmentChapter += Array(repeating: index, count: frags.count)
            chapters.append(KF8Chapter(id: String(index), skeleton: skeleton, fragments: frags,
                                       length: skeleton.length + frags.reduce(0) { $0 + $1.length }))
            fragStart = end
        }

        // Assemble every chapter's markup by splicing fragments into skeletons.
        var assembled: [[UInt8]] = []
        for chapter in chapters {
            let raw = text.slice(chapter.skeleton.offset, chapter.skeleton.offset + chapter.length)
            var skeleton = raw.slice(0, chapter.skeleton.length)
            for fragment in chapter.fragments {
                let insertAt = max(0, min(skeleton.count, fragment.insertOffset - chapter.skeleton.offset))
                let start = chapter.skeleton.length + fragment.offset
                skeleton.insert(contentsOf: raw.slice(start, start + fragment.length), at: insertAt)
            }
            assembled.append(skeleton)
        }

        // kindle:pos:fid:X:off:Y → "chapterId#anchor" (fid indexes the fragment table).
        var posCache: [String: String] = [:]
        func resolvePosition(fid: Int, off: Int) -> String? {
            let key = "\(fid):\(off)"
            if let cached = posCache[key] { return cached }
            guard let fragment = fragments[safe: fid],
                  let chapterIndex = fragmentChapter[safe: fid] else { return nil }
            let chapter = chapters[chapterIndex]
            let markup = assembled[chapterIndex]
            let position = max(0, min(markup.count, fragment.insertOffset - chapter.skeleton.offset + off))
            var href = chapter.id
            if let anchor = anchorBefore(position, in: markup) { href += "#" + anchor }
            posCache[key] = href
            return href
        }

        var embeds: [String: (Data, String)] = [:]
        func resolveEmbed(_ reference: String) -> String? {
            let ns = reference as NSString
            guard let match = kindleEmbed.firstMatch(in: reference, range: NSRange(location: 0, length: ns.length)) else { return nil }
            let kind = ns.substring(with: match.range(at: 1))
            let id = ns.substring(with: match.range(at: 2))
            let path = "\(kind)/\(id)"
            if embeds[path] == nil {
                if kind == "embed", let bytes = file.loadResource(base32(id) - 1) {
                    let data = Data(bytes)
                    embeds[path] = (data, MimeType.sniff(data) ?? "image/jpeg")
                } else if kind == "flow", let (s, e) = flows[safe: base32(id)] {
                    embeds[path] = (Data(text.slice(s, e)), "image/svg+xml")
                } else {
                    return nil
                }
            }
            return ResourceURL.make(token: token, path: path)
        }

        var bookChapters: [Chapter] = []
        var cssParts: [String] = []
        var seenFlows = Set<Int>()
        for (index, chapter) in chapters.enumerated() {
            var markup = file.decode(assembled[index])
            markup = replacing(kindlePos, in: markup) { groups in
                resolvePosition(fid: base32(groups[1]), off: base32(groups[2])) ?? "#"
            }
            guard let document = ContentSanitizer.parseDocument(Data(markup.utf8)) else { continue }

            for link in ContentSanitizer.elements(in: document, named: "link") {
                if let href = ContentSanitizer.attribute(link, "href"), href.hasPrefix("kindle:flow:"),
                   href.contains("text/css") {
                    let id = base32(String(href.dropFirst("kindle:flow:".count).prefix { $0 != "?" }))
                    if seenFlows.insert(id).inserted, let (s, e) = flows[safe: id] {
                        cssParts.append(ContentSanitizer.filterStylesheet(file.decode(text.slice(s, e))))
                    }
                }
                link.detach()
            }
            for style in ContentSanitizer.elements(in: document, named: "style") {
                cssParts.append(ContentSanitizer.filterStylesheet(style.stringValue ?? ""))
                style.detach()
            }

            ContentSanitizer.sanitize(document)
            ContentSanitizer.filterStyleAttributes(document)
            ContentSanitizer.rewriteImages(document) { resolveEmbed($0) }
            ContentSanitizer.rewriteLinks(document) { href in
                if href.hasPrefix("#"), href.count > 1 { return chapter.id + href }
                return href.hasPrefix("kindle:") ? nil : href
            }
            let (html, plain) = ContentSanitizer.bodyHTML(of: document)
            bookChapters.append(Chapter(id: chapter.id, href: chapter.id, html: html, text: plain))
        }

        func mapToc(_ entries: [MobiFile.NCXEntry]) -> [TocItem] {
            entries.map { entry in
                let href = entry.pos.count >= 2 ? (resolvePosition(fid: entry.pos[0], off: entry.pos[1]) ?? "") : ""
                return TocItem(title: entry.label, href: href, children: mapToc(entry.children))
            }
        }

        if bookChapters.isEmpty { throw BookError.malformed("This book has no readable chapters.") }
        return ReflowableBook(
            title: title, language: file.language, identifier: identifier, chapters: bookChapters,
            css: cssParts.joined(separator: "\n"), toc: mapToc(file.ncx() ?? []),
            resources: MobiResources(embeds: embeds))
    }

    /// The closest element at or before `position` that carries an id, name or aid.
    private static func anchorBefore(_ position: Int, in markup: [UInt8]) -> String? {
        // Include the tag `position` points into, if any.
        var end = position
        if let close = markup[position...].firstIndex(of: UInt8(ascii: ">")) {
            let open = markup[position...].firstIndex(of: UInt8(ascii: "<"))
            if open == position || open == nil || close < open! { end = close + 1 }
        }
        let window = markup.slice(max(0, end - 16_384), end)
        let string = String(decoding: window, as: UTF8.self)
        let ns = string as NSString
        guard let match = anchorAttribute.matches(in: string, range: NSRange(location: 0, length: ns.length)).last
        else { return nil }
        return ns.substring(with: match.range(at: 2))
    }

    private static func replacing(_ regex: NSRegularExpression, in string: String,
                                  with transform: ([String]) -> String) -> String {
        let ns = string as NSString
        var output = ""
        var last = 0
        for match in regex.matches(in: string, range: NSRange(location: 0, length: ns.length)) {
            output += ns.substring(with: NSRange(location: last, length: match.range.location - last))
            let groups = (0..<match.numberOfRanges).map {
                match.range(at: $0).location == NSNotFound ? "" : ns.substring(with: match.range(at: $0))
            }
            output += transform(groups)
            last = match.range.location + match.range.length
        }
        output += ns.substring(from: last)
        return output
    }

    // MARK: MOBI6

    private static let fileposPattern = try! NSRegularExpression(
        pattern: #"filepos\s*=\s*['"]?0*(\d+)['"]?"#, options: .caseInsensitive)
    private static let pagebreakPattern = try! NSRegularExpression(
        pattern: #"<\s*(?:mbp:)?pagebreak[^>]*>"#, options: .caseInsensitive)
    private static let recindexPattern = try! NSRegularExpression(
        pattern: #"\brecindex\s*=\s*['"]?0*(\d+)['"]?"#, options: .caseInsensitive)
    private static let tocEntryPattern = try! NSRegularExpression(
        pattern: #"<a\b[^>]*?filepos\s*=\s*['"]?0*(\d+)['"]?[^>]*>([\s\S]*?)</a\s*>"#, options: .caseInsensitive)
    private static let tagPattern = try! NSRegularExpression(pattern: #"<[^>]*>"#)

    private static func parseMOBI6(_ file: MobiFile, title: String, identifier: String, token: String) throws -> ReflowableBook {
        var bytes = file.loadAllText()
        // Latin-1 maps bytes 1:1 onto scalars, so regex offsets are byte offsets.
        var latin = latin1String(bytes)

        // Drop anchors at every filepos target so links and the TOC can land there.
        let positions = Set(fileposPattern.matches(in: latin, range: NSRange(location: 0, length: (latin as NSString).length))
            .compactMap { Int((latin as NSString).substring(with: $0.range(at: 1))) })
            .filter { $0 < bytes.count }
        for position in positions.sorted(by: >) {
            var at = position
            // Never split a tag: move to its start.
            if let open = bytes[..<at].lastIndex(of: UInt8(ascii: "<")) {
                let close = bytes[..<at].lastIndex(of: UInt8(ascii: ">"))
                if close == nil || close! < open { at = open }
            }
            bytes.insert(contentsOf: Array("<a id=\"filepos\(position)\"></a>".utf8), at: at)
        }
        latin = latin1String(bytes)
        let ns = latin as NSString

        // Split into chapters at page breaks.
        var bounds: [(Int, Int)] = []
        var cursor = 0
        for match in pagebreakPattern.matches(in: latin, range: NSRange(location: 0, length: ns.length)) {
            bounds.append((cursor, match.range.location))
            cursor = match.range.location + match.range.length
        }
        bounds.append((cursor, ns.length))

        let lowered = latin.lowercased() as NSString
        let bodyOpen = lowered.range(of: "<body")
        let bodyStart: Int = {
            guard bodyOpen.location != NSNotFound else { return 0 }
            let close = lowered.range(of: ">", range: NSRange(location: bodyOpen.location, length: lowered.length - bodyOpen.location))
            return close.location == NSNotFound ? 0 : close.location + 1
        }()
        let bodyCloseRange = lowered.range(of: "</body", options: .backwards)
        let bodyEnd = bodyCloseRange.location == NSNotFound ? ns.length : bodyCloseRange.location
        let headRegion = bodyOpen.location == NSNotFound ? "" : ns.substring(to: bodyOpen.location)

        var rawChapters: [(id: String, latin: String)] = []
        for (index, (start, end)) in bounds.enumerated() {
            let s = max(start, bodyStart)
            let e = min(end, bodyEnd)
            guard e > s else { continue }
            rawChapters.append((String(index), ns.substring(with: NSRange(location: s, length: e - s))))
        }

        // filepos N → the chapter holding its anchor.
        var chapterForPosition: [Int: String] = [:]
        for chapter in rawChapters {
            for position in positions where chapterForPosition[position] == nil {
                if chapter.latin.contains("id=\"filepos\(position)\"") { chapterForPosition[position] = chapter.id }
            }
        }
        func href(for position: Int) -> String {
            guard let chapter = chapterForPosition[position] else { return "" }
            return "\(chapter)#filepos\(position)"
        }

        var chapters: [Chapter] = []
        var embeds: [String: (Data, String)] = [:]
        for raw in rawChapters {
            var html = file.decode(raw.latin.unicodeScalars.map { UInt8(truncatingIfNeeded: $0.value) })
            // <a filepos=N> → <a href="chapter#fileposN">
            html = replacing(fileposPattern, in: html) { groups in
                "href=\"\(href(for: Int(groups[1]) ?? -1))\""
            }
            // <img recindex=N> → a kindle: reference the sanitizer lets through.
            html = replacing(recindexPattern, in: html) { groups in "src=\"kindle:rec:\(Int(groups[1]) ?? 0)\"" }

            guard let document = ContentSanitizer.parseDocument(Data("<html><body>\(html)</body></html>".utf8), preferHTML: true)
            else { continue }
            ContentSanitizer.sanitize(document)
            ContentSanitizer.filterStyleAttributes(document)
            ContentSanitizer.rewriteImages(document) { source in
                guard source.hasPrefix("kindle:rec:"), let index = Int(source.dropFirst("kindle:rec:".count)) else { return nil }
                let path = "rec/\(index)"
                if embeds[path] == nil {
                    guard let bytes = file.loadResource(index - 1) else { return nil }
                    let data = Data(bytes)
                    embeds[path] = (data, MimeType.sniff(data) ?? "image/jpeg")
                }
                return ResourceURL.make(token: token, path: path)
            }
            let (body, plain) = ContentSanitizer.bodyHTML(of: document)
            chapters.append(Chapter(id: raw.id, href: raw.id, html: body, text: plain))
        }

        // The guide's TOC reference points at a page of filepos links.
        var toc: [TocItem] = []
        if let reference = headRegion.range(of: #"<reference[^>]*type\s*=\s*['"]?toc['"]?[^>]*>"#, options: [.regularExpression, .caseInsensitive]),
           let fileposMatch = headRegion[reference].range(of: #"filepos\s*=\s*['"]?0*(\d+)"#, options: .regularExpression) {
            let digits = headRegion[fileposMatch].filter(\.isNumber)
            if let position = Int(digits), let chapterId = chapterForPosition[position],
               let raw = rawChapters.first(where: { $0.id == chapterId }) {
                // The original bytes still carry the filepos attributes.
                toc = parseMOBI6Toc(file.decode(raw.latin.unicodeScalars.map { UInt8(truncatingIfNeeded: $0.value) }),
                                     href: href(for:))
            }
        }

        if chapters.isEmpty { throw BookError.malformed("This book has no readable chapters.") }
        return ReflowableBook(title: title, language: file.language, identifier: identifier, chapters: chapters,
                              css: "", toc: toc, resources: MobiResources(embeds: embeds))
    }

    private static func latin1String(_ bytes: [UInt8]) -> String {
        String(String.UnicodeScalarView(bytes.map { Unicode.Scalar($0) }))
    }

    /// TOC pages nest entries with `<blockquote>`; depth becomes the outline level.
    private static func parseMOBI6Toc(_ html: String, href: (Int) -> String) -> [TocItem] {
        let ns = html as NSString
        var flat: [(level: Int, item: TocItem)] = []
        var last = 0
        var depth = 0
        for match in tocEntryPattern.matches(in: html, range: NSRange(location: 0, length: ns.length)) {
            let between = ns.substring(with: NSRange(location: last, length: match.range.location - last)).lowercased()
            depth += between.components(separatedBy: "<blockquote").count - 1
            depth -= between.components(separatedBy: "</blockquote").count - 1
            depth = max(0, depth)
            last = match.range.location + match.range.length
            let position = Int(ns.substring(with: match.range(at: 1))) ?? -1
            let labelHTML = ns.substring(with: match.range(at: 2))
            let label = EPUBParser.collapseWhitespace(
                tagPattern.stringByReplacingMatches(in: labelHTML, range: NSRange(location: 0, length: (labelHTML as NSString).length), withTemplate: "")
                    .replacingOccurrences(of: "&amp;", with: "&").replacingOccurrences(of: "&nbsp;", with: " "))
            let target = href(position)
            guard !label.isEmpty, !target.isEmpty else { continue }
            flat.append((depth, TocItem(title: label, href: target)))
        }
        return nest(flat[...], level: flat.map(\.level).min() ?? 0)
    }

    private static func nest(_ items: ArraySlice<(level: Int, item: TocItem)>, level: Int) -> [TocItem] {
        var result: [TocItem] = []
        var index = items.startIndex
        while index < items.endIndex {
            var item = items[index].item
            var next = index + 1
            while next < items.endIndex, items[next].level > level { next += 1 }
            if next > index + 1 { item.children = nest(items[(index + 1)..<next], level: level + 1) }
            result.append(item)
            index = next
        }
        return result
    }
}
