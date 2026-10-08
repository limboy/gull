import Foundation
import Observation

/// A persistent text highlight. Offsets are character offsets into the
/// chapter's text (DOM `textContent` for reflowable books, `PDFPage.string`
/// for PDF pages), with quote context so it can be relocated if they drift.
nonisolated struct Highlight: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var chapterId: String
    var start: Int
    var end: Int
    var text: String
    var prefix: String?
    var suffix: String?
    var createdAt: Double
}

/// Highlights for every book, keyed by publication identifier when the book
/// has one (so they survive a renamed file), else by file path.
@Observable
final class HighlightStore {
    static let shared = HighlightStore()

    private(set) var byBook: [String: [Highlight]] = [:]
    @ObservationIgnored private lazy var saver = DebouncedSaver { [weak self] in
        guard let self else { return }
        Storage.save(byBook, to: "highlights.json")
    }

    private init() {
        byBook = Storage.load([String: [Highlight]].self, from: "highlights.json") ?? [:]
    }

    static func key(filePath: String, identifier: String?) -> String {
        let trimmed = identifier?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? filePath : "publication:\(trimmed)"
    }

    func highlights(for key: String) -> [Highlight] { byBook[key] ?? [] }

    /// Moves highlights saved under the file path to the publication key.
    func migrate(from filePath: String, to key: String) {
        guard key != filePath, let legacy = byBook[filePath] else { return }
        var existing = byBook[key] ?? []
        let known = Set(existing.map(\.id))
        existing += legacy.filter { !known.contains($0.id) }
        byBook[key] = existing
        byBook[filePath] = nil
        saver.schedule()
    }

    func add(_ highlight: Highlight, replacing removedIds: [String] = [], key: String) {
        var list = (byBook[key] ?? []).filter { !removedIds.contains($0.id) }
        list.append(highlight)
        byBook[key] = list
        saver.schedule()
    }

    func remove(_ id: String, key: String) {
        byBook[key]?.removeAll { $0.id == id }
        saver.schedule()
    }

    /// Applies offsets the reader relocated using the quote context.
    func update(_ repaired: [Highlight], key: String) {
        guard var list = byBook[key] else { return }
        let byId = Dictionary(repaired.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for index in list.indices {
            if let fixed = byId[list[index].id] {
                list[index].start = fixed.start
                list[index].end = fixed.end
                list[index].text = fixed.text
            }
        }
        byBook[key] = list
        saver.schedule()
    }

    func flush() { saver.flush() }
}

/// Where the reader was in a book. Reflowable books anchor to a chapter and a
/// fraction of it, which survives font and window changes better than a raw
/// scroll ratio; `progress` is the fallback (and the PDF position).
nonisolated struct ReadingPosition: Codable, Hashable, Sendable {
    var progress: Double
    var chapterId: String?
    var ratio: Double?
}

/// Reading positions for every book, library or standalone.
final class PositionStore {
    static let shared = PositionStore()

    private var positions: [String: ReadingPosition]
    private lazy var saver = DebouncedSaver(delay: .seconds(1)) { [weak self] in
        guard let self else { return }
        Storage.save(positions, to: "positions.json")
    }

    private init() {
        positions = Storage.load([String: ReadingPosition].self, from: "positions.json") ?? [:]
    }

    func position(for path: String) -> ReadingPosition? { positions[path] }

    func setPosition(_ position: ReadingPosition, for path: String) {
        guard position.progress.isFinite else { return }
        var clamped = position
        clamped.progress = min(1, max(0, position.progress))
        positions[path] = clamped
        saver.schedule()
    }

    func flush() { saver.flush() }
}
