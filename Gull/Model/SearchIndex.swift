import Foundation

/// A flat full-text index of one book: one entry per chapter (or PDF page),
/// ported from `indexBookForSearch` / `findSearchMatches`.
nonisolated struct SearchIndex: Sendable {
    struct Entry: Sendable {
        let chapterId: String
        let href: String
        let title: String
        let text: String
        let lower: String
    }

    struct Result: Identifiable, Hashable, Sendable {
        let chapterId: String
        let href: String
        let title: String
        let snippet: String
        let matchIndex: Int
        let term: String
        var id: String { "\(chapterId)#\(matchIndex)#\(term)" }
    }

    static let minQueryLength = 2
    static let maxResults = 120

    let entries: [Entry]

    static func normalize(_ text: String) -> String {
        text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// Chapter titles come from the TOC entry for their file; untitled
    /// chapters inherit the last title seen (a chapter split across files).
    init(chapters: [(id: String, href: String, text: String, title: String?)], toc: [TocItem]) {
        var titleMap: [String: String] = [:]
        var tocFiles = Set<String>()
        func walk(_ items: [TocItem]) {
            for item in items {
                let file = Self.fileName(item.href)
                if !file.isEmpty {
                    tocFiles.insert(file)
                    if titleMap[file] == nil, !item.title.isEmpty { titleMap[file] = item.title }
                }
                walk(item.children)
            }
        }
        walk(toc)

        var inherited = ""
        var entries: [Entry] = []
        for chapter in chapters {
            let text = Self.normalize(chapter.text)
            guard !text.isEmpty else { continue }
            let file = Self.fileName(chapter.href)
            if tocFiles.contains(file), let title = titleMap[file] { inherited = title }
            let title = titleMap[file] ?? (inherited.isEmpty ? (chapter.title ?? "") : inherited)
            entries.append(Entry(chapterId: chapter.id, href: chapter.href, title: title, text: text, lower: text.lowercased()))
        }
        self.entries = entries
    }

    private static func fileName(_ href: String) -> String {
        let path = BookPath.splitFragment(href).path
        return path.split(separator: "/").last.map(String.init) ?? path
    }

    static func terms(for query: String) -> [String] {
        let normalized = normalize(query).lowercased()
        guard normalized.count >= minQueryLength else { return [] }
        return normalized.split(separator: " ").map(String.init)
    }

    /// Chapters containing every term; up to three snippets per chapter for the first term.
    func matches(for query: String) -> [Result] {
        let terms = Self.terms(for: query)
        guard let first = terms.first else { return [] }
        var results: [Result] = []
        for entry in entries {
            guard terms.allSatisfy({ entry.lower.contains($0) }) else { continue }
            var from = entry.lower.startIndex
            var hits = 0
            while results.count < Self.maxResults, hits < 3,
                  let range = entry.lower.range(of: first, range: from..<entry.lower.endIndex) {
                let offset = entry.lower.distance(from: entry.lower.startIndex, to: range.lowerBound)
                results.append(Result(
                    chapterId: entry.chapterId, href: entry.href, title: entry.title,
                    snippet: Self.snippet(entry.text, around: offset), matchIndex: hits, term: first))
                from = range.upperBound
                hits += 1
            }
            if results.count >= Self.maxResults { break }
        }
        return results
    }

    static func snippet(_ text: String, around offset: Int, radius: Int = 46) -> String {
        let characters = Array(text)
        let start = max(0, min(offset, characters.count) - radius)
        let end = min(characters.count, offset + radius)
        return (start > 0 ? "…" : "") + String(characters[start..<end]) + (end < characters.count ? "…" : "")
    }
}
