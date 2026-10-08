import AppKit
import Foundation
import Observation
import PDFKit

/// One table-of-contents row, flattened for the inspector list.
struct FlatTocItem: Identifiable, Hashable {
    let id: Int
    let title: String
    let level: Int
    let href: String
}

/// What the native chapter scrollbar draws: segment start offsets in document
/// units (pixels for reflowable books, page units for PDFs) plus the viewport.
struct ScrollMap: Equatable {
    struct Segment: Equatable {
        var top: Double
        var title: String
    }

    var segments: [Segment] = []
    var total: Double = 0
    var viewportTop: Double = 0
    var viewportHeight: Double = 0
}

struct SelectionPopupState: Equatable {
    var rect: CGRect
    var existingId: String?
}

struct FootnoteState: Equatable, Identifiable {
    let id = UUID()
    var text: String
    var rect: CGRect
}

enum InspectorMode: String, CaseIterable, Identifiable {
    case toc, highlights, search
    var id: String { rawValue }

    var title: String {
        switch self {
        case .toc: "Contents"
        case .highlights: "Highlights"
        case .search: "Search"
        }
    }

    var symbol: String {
        switch self {
        case .toc: "list.bullet"
        case .highlights: "highlighter"
        case .search: "magnifyingglass"
        }
    }
}

/// The reader state of one window: which book is open, its outline, search,
/// highlights, and the scroll map. The library window and standalone book
/// windows each own one.
@Observable
final class ReaderModel {
    enum Phase: Equatable {
        case empty
        case loading
        case reflowable
        case pdf
        case failed(String)
    }

    let isStandalone: Bool

    private(set) var filePath: String?
    private(set) var title = ""
    private(set) var phase: Phase = .empty
    private(set) var toc: [FlatTocItem] = []
    private(set) var activeTocIndex: Int?
    private(set) var scrollMap = ScrollMap()
    private(set) var highlightKey = ""
    private(set) var searchResults: [SearchIndex.Result] = []
    private(set) var isIndexing = false

    var inspectorMode: InspectorMode = .toc
    var searchQuery = "" { didSet { if oldValue != searchQuery { scheduleSearch() } } }
    var selection: SelectionPopupState?
    var footnote: FootnoteState?
    var searchFocusRequest = 0

    var showInspector: Bool {
        didSet { UserDefaults.standard.set(showInspector, forKey: isStandalone ? "bookInspectorShown" : "inspectorShown") }
    }

    var isPDF: Bool { phase == .pdf }
    var hasBook: Bool { phase == .reflowable || phase == .pdf }

    var highlights: [Highlight] {
        HighlightStore.shared.highlights(for: highlightKey).sorted { $0.createdAt > $1.createdAt }
    }

    var currentTocTitle: String? { activeTocIndex.flatMap { toc[safe: $0]?.title } }

    @ObservationIgnored private(set) lazy var web = WebReaderController(model: self)
    @ObservationIgnored private(set) lazy var pdf = PDFReaderController(model: self)
    @ObservationIgnored private var token: String?
    @ObservationIgnored private var chapterHrefs: [String: String] = [:]
    @ObservationIgnored private var searchIndex: SearchIndex?
    @ObservationIgnored private var searchTask: Task<Void, Never>?
    @ObservationIgnored private var loadTask: Task<Void, Never>?
    @ObservationIgnored private var tocTargets: [(index: Int, top: Double)] = []
    @ObservationIgnored private var rendered = false

    init(standalone: Bool) {
        isStandalone = standalone
        let key = standalone ? "bookInspectorShown" : "inspectorShown"
        UserDefaults.standard.register(defaults: [key: true])
        showInspector = UserDefaults.standard.bool(forKey: key)
    }

    // MARK: Opening

    func open(_ path: String?) {
        guard path != filePath else { return }
        close()
        filePath = path
        guard let path else { phase = .empty; title = ""; return }

        let url = URL(fileURLWithPath: path)
        title = LibraryStore.shared.book(at: path)?.title ?? url.deletingPathExtension().lastPathComponent
        phase = .loading
        let isPDF = BookFormat(url: url) == .pdf

        loadTask = Task { [weak self] in
            if isPDF { await self?.openPDF(url) } else { await self?.openReflowable(url) }
        }
    }

    /// Releases the open book (its registry entry, PDF document, and index).
    func close() {
        loadTask?.cancel()
        loadTask = nil
        searchTask?.cancel()
        if let token { BookRegistry.shared.unregister(token) }
        token = nil
        rendered = false
        chapterHrefs = [:]
        toc = []
        tocTargets = []
        activeTocIndex = nil
        scrollMap = ScrollMap()
        searchIndex = nil
        searchResults = []
        selection = nil
        footnote = nil
        highlightKey = ""
        pdf.unload()
        PositionStore.shared.flush()
    }

    private func openReflowable(_ url: URL) async {
        let token = UUID().uuidString
        let result = await Task.detached(priority: .userInitiated) { () -> Result<(ReflowableBook, Data), Error> in
            Result {
                try BookLimits.validate(url)
                let format = BookFormat(url: url)
                let book = format == .epub
                    ? try EPUBParser.parse(url: url, token: token)
                    : try MOBIParser.parse(url: url, token: token)
                let payload = try JSONSerialization.data(withJSONObject: [
                    "chapters": book.chapters.map { ["id": $0.id, "href": $0.href, "html": $0.html] },
                    "css": book.css,
                    "language": book.language,
                    "tocHrefs": Self.flatten(book.toc).map(\.href),
                ])
                return (book, payload)
            }
        }.value
        guard !Task.isCancelled, url.path == filePath else { return }

        switch result {
        case .failure(let error):
            phase = .failed(error.localizedDescription)
        case .success(let (book, payload)):
            BookRegistry.shared.register(token: token, content: payload, resources: book.resources)
            self.token = token
            chapterHrefs = Dictionary(book.chapters.map { ($0.id, $0.href) }, uniquingKeysWith: { a, _ in a })
            toc = Self.flatten(book.toc)
            didLoad(title: book.title, identifier: book.identifier, path: url.path)
            phase = .reflowable
            web.load(token: token, position: PositionStore.shared.position(for: url.path), highlights: highlights,
                     searchTerms: SearchIndex.terms(for: searchQuery))
            buildSearchIndex {
                SearchIndex(chapters: book.chapters.map { ($0.id, $0.href, $0.text, nil) }, toc: book.toc)
            }
        }
    }

    private func openPDF(_ url: URL) async {
        do {
            try BookLimits.validate(url)
        } catch {
            phase = .failed(error.localizedDescription); return
        }
        guard let document = PDFDocument(url: url) else {
            phase = .failed("This PDF could not be opened."); return
        }
        if document.isLocked {
            phase = .failed("This PDF is password protected."); return
        }
        guard url.path == filePath else { return }
        let metadataTitle = (document.documentAttributes?[PDFDocumentAttribute.titleAttribute] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let outline = PDFReaderController.outline(of: document)
        toc = Self.flatten(outline)
        let identifier = "pdf:" + url.lastPathComponent
        didLoad(title: Self.looksIntentional(metadataTitle) ? metadataTitle! : title, identifier: identifier, path: url.path)
        phase = .pdf
        pdf.load(document: document, position: PositionStore.shared.position(for: url.path))

        // Page text for the search index is extracted off the main thread.
        let pageCount = document.pageCount
        let documentURL = url
        buildSearchIndex {
            guard let copy = PDFDocument(url: documentURL) else { return SearchIndex(chapters: [], toc: []) }
            let pages = (0..<pageCount).map { index in
                (id: "page-\(index)", href: "page-\(index)", text: copy.page(at: index)?.string ?? "",
                 title: Optional("Page \(index + 1)"))
            }
            return SearchIndex(chapters: pages, toc: outline)
        }
    }

    /// PDF titles are often junk like "Microsoft Word - draft3.doc".
    private static func looksIntentional(_ title: String?) -> Bool {
        guard let title, title.count > 2 else { return false }
        let lower = title.lowercased()
        return !lower.hasPrefix("microsoft word") && !lower.hasSuffix(".doc") && !lower.hasSuffix(".docx")
            && !lower.hasSuffix(".pdf") && lower != "untitled"
    }

    private func didLoad(title: String, identifier: String, path: String) {
        // The window shows the book's own title; the sidebar keeps the file name.
        if !title.isEmpty { self.title = title }
        let key = HighlightStore.key(filePath: path, identifier: identifier.hasPrefix("pdf:") ? nil : identifier)
        HighlightStore.shared.migrate(from: path, to: key)
        highlightKey = key
    }

    private func buildSearchIndex(_ build: @Sendable @escaping () -> SearchIndex) {
        isIndexing = true
        let path = filePath
        Task { [weak self] in
            let index = await Task.detached(priority: .utility) { build() }.value
            guard let self, self.filePath == path else { return }
            self.searchIndex = index
            self.isIndexing = false
            self.runSearch()
        }
    }

    nonisolated static func flatten(_ items: [TocItem]) -> [FlatTocItem] {
        var output: [FlatTocItem] = []
        func walk(_ items: [TocItem], level: Int) {
            for item in items {
                output.append(FlatTocItem(id: output.count, title: item.title, level: min(level, 3), href: item.href))
                walk(item.children, level: level + 1)
            }
        }
        walk(items, level: 1)
        return output
    }

    // MARK: Navigation

    func goToToc(_ item: FlatTocItem) {
        switch phase {
        case .reflowable: web.scrollToHref(item.href)
        case .pdf: pdf.go(toHref: item.href)
        default: return
        }
        activeTocIndex = item.id
    }

    func scrollTo(offset: Double) {
        switch phase {
        case .reflowable: web.scrollTo(offset: offset)
        case .pdf: pdf.scrollTo(unit: offset)
        default: break
        }
    }

    // MARK: Web reader events

    func readerRendered() {
        rendered = true
    }

    func readerLayout(height: Double, viewport: Double, targets: [(index: Int, top: Double)], chapters: [(id: String, top: Double)]) {
        tocTargets = targets
        var segments: [ScrollMap.Segment]
        if !targets.isEmpty {
            segments = targets.sorted { $0.top < $1.top }.map { .init(top: $0.top, title: toc[safe: $0.index]?.title ?? "") }
        } else {
            let titles = Dictionary(toc.map { (BookPath.splitFragment($0.href).path, $0.title) }, uniquingKeysWith: { a, _ in a })
            segments = chapters.map { .init(top: $0.top, title: chapterHrefs[$0.id].flatMap { titles[$0] } ?? "") }
        }
        scrollMap.segments = segments
        scrollMap.total = height
        scrollMap.viewportHeight = viewport
        updateActiveToc()
    }

    func readerScrolled(top: Double, height: Double, viewport: Double, position: ReadingPosition) {
        scrollMap.viewportTop = top
        scrollMap.total = height
        scrollMap.viewportHeight = viewport
        updateActiveToc()
        if rendered, let filePath { PositionStore.shared.setPosition(position, for: filePath) }
    }

    /// The active entry is the last one (in TOC order) whose target has scrolled past the top.
    private func updateActiveToc() {
        guard let first = tocTargets.first else { return }
        let threshold = scrollMap.viewportTop + 60
        var active = first.index
        for target in tocTargets where target.top <= threshold { active = target.index }
        if active != activeTocIndex { activeTocIndex = active }
    }

    // MARK: PDF reader events

    func pdfScrolled(map: ScrollMap, activeToc: Int?) {
        if map != scrollMap { scrollMap = map }
        if activeToc != activeTocIndex { activeTocIndex = activeToc }
    }

    // MARK: Search

    private func scheduleSearch() {
        searchTask?.cancel()
        searchTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(100))
            guard !Task.isCancelled else { return }
            self?.runSearch()
        }
    }

    private func runSearch() {
        let terms = SearchIndex.terms(for: searchQuery)
        searchResults = searchIndex?.matches(for: searchQuery) ?? []
        switch phase {
        case .reflowable: web.setSearchTerms(terms)
        case .pdf: pdf.setSearchTerms(terms)
        default: break
        }
    }

    var searchStatus: String? {
        guard hasBook else { return "Open a book to search." }
        let normalized = SearchIndex.normalize(searchQuery)
        if normalized.isEmpty { return "Type to search in the current book." }
        if normalized.count < SearchIndex.minQueryLength { return "Enter at least \(SearchIndex.minQueryLength) characters." }
        if isIndexing { return "Indexing…" }
        if searchResults.isEmpty { return "No matches for “\(normalized)”." }
        return nil
    }

    func openSearchResult(_ result: SearchIndex.Result) {
        switch phase {
        case .reflowable: web.jumpToSearchResult(result)
        case .pdf: pdf.jumpToSearchResult(result)
        default: return
        }
        if let index = toc.firstIndex(where: { $0.href == result.href }) { activeTocIndex = index }
    }

    func focusSearch() {
        showInspector = true
        inspectorMode = .search
        searchFocusRequest += 1
    }

    // MARK: Highlights

    func highlightSelection() {
        switch phase {
        case .reflowable: web.highlightSelection()
        case .pdf: pdf.highlightSelection()
        default: break
        }
    }

    func addHighlight(_ highlight: Highlight, replacing removed: [String]) {
        guard !highlightKey.isEmpty else { return }
        HighlightStore.shared.add(highlight, replacing: removed, key: highlightKey)
        selection = nil
    }

    func repairHighlights(_ repaired: [Highlight]) {
        guard !highlightKey.isEmpty else { return }
        HighlightStore.shared.update(repaired, key: highlightKey)
    }

    func removeHighlight(_ id: String) {
        guard !highlightKey.isEmpty else { return }
        HighlightStore.shared.remove(id, key: highlightKey)
        switch phase {
        case .reflowable: web.removeHighlight(id)
        case .pdf: pdf.removeHighlight(id)
        default: break
        }
        selection = nil
    }

    func openHighlight(_ highlight: Highlight) {
        switch phase {
        case .reflowable: web.jumpToHighlight(highlight)
        case .pdf: pdf.jumpToHighlight(highlight)
        default: break
        }
    }

    func popupAction() {
        guard let selection else { return }
        if let id = selection.existingId { removeHighlight(id) } else { highlightSelection() }
    }

    // MARK: Style

    func applySettings(_ settings: ReaderSettings) {
        web.apply(style: settings.style, hideScrollbar: settings.chapterScrollbar)
        pdf.apply(zoom: settings.pdfZoom)
    }
}
