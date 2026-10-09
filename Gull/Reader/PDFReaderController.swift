import AppKit
import PDFKit

/// Drives the window's `PDFView`: zoom, outline navigation, search matches,
/// highlights (as in-memory highlight annotations), and the scroll map.
/// Positions are measured in page units: page index + fraction down the page.
final class PDFReaderController: NSObject {
    let pdfView = ReaderPDFView()
    private weak var model: ReaderModel?
    private var zoom: PDFZoom = ReaderSettings.shared.pdfZoom
    private var annotations: [String: [(page: PDFPage, annotation: PDFAnnotation)]] = [:]
    private var tocUnits: [(index: Int, unit: Double)] = []
    private var observers: [NSObjectProtocol] = []
    private var restoring = false

    private static let pdfUnitMarker = "pdf-unit"

    init(model: ReaderModel) {
        self.model = model
        super.init()
        pdfView.displayMode = .singlePageContinuous
        pdfView.displaysPageBreaks = true
        pdfView.autoScales = true
        pdfView.onHighlightMenu = { [weak self] in self?.highlightSelection() }
        pdfView.onRemoveHighlightMenu = { [weak self] id in self?.model?.removeHighlight(id) }
        pdfView.onSearchMenu = { [weak self] text in self?.model?.searchInBook(text) }

        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: .PDFViewPageChanged, object: pdfView, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.reportScroll() }
        })
        observers.append(center.addObserver(forName: .PDFViewScaleChanged, object: pdfView, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.reportScroll() }
        })
        observers.append(center.addObserver(forName: NSView.frameDidChangeNotification, object: pdfView, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, case .fitPage = self.zoom else { return }
                self.applyZoom(preservingPosition: true)
            }
        })
        pdfView.postsFrameChangedNotifications = true
    }

    isolated deinit {
        if let scrollObserver { NotificationCenter.default.removeObserver(scrollObserver) }
        observers.forEach(NotificationCenter.default.removeObserver)
    }

    // MARK: Loading

    func load(document: PDFDocument, position: ReadingPosition?) {
        annotations.removeAll()
        pdfView.document = document
        observeScrolling()
        applyScrollView()
        tocUnits = (model?.toc ?? []).compactMap { item in unit(forHref: item.href).map { (item.id, $0) } }
        applyHighlights()
        applyZoom(preservingPosition: false)
        restoring = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if let position, position.chapterId == Self.pdfUnitMarker, let unit = position.ratio {
                scrollTo(unit: unit)
            } else if let position {
                scrollTo(unit: position.progress * Double(document.pageCount))
            }
            restoring = false
            reportScroll()
        }
        pdfView.window?.makeFirstResponder(pdfView)
    }

    func unload() {
        guard pdfView.document != nil else { return }
        pdfView.document = nil
        annotations.removeAll()
        tocUnits = []
    }

    private var insets = NSEdgeInsets()

    /// How much of the view the toolbar (top) and chapter scrollbar (trailing) cover. Set
    /// by hand: the scroll view's automatic insets only know about the toolbar.
    func setInsets(top: CGFloat, trailing: CGFloat) {
        guard insets.top != top || insets.right != trailing else { return }
        insets = NSEdgeInsets(top: top, left: 0, bottom: 0, right: trailing)
        applyScrollView()
    }

    private var hidesScroller = false

    /// Hides PDFView's own scroller while the chapter scrollbar stands in for it.
    func setScrollerHidden(_ hidden: Bool) {
        guard hidden != hidesScroller else { return }
        hidesScroller = hidden
        applyScrollView()
    }

    /// The scroll view inside PDFView is only there once a document is set, so this
    /// runs again on every load.
    private func applyScrollView() {
        guard let scrollView = pdfView.documentView?.enclosingScrollView else { return }
        scrollView.automaticallyAdjustsContentInsets = false
        scrollView.contentInsets = insets
        // PDFView turns its scroller back on as it lays out and scrolls, so rather than
        // turning it off, swap in one that never draws.
        if hidesScroller != (scrollView.verticalScroller is InvisibleScroller) {
            scrollView.verticalScroller = hidesScroller ? InvisibleScroller() : NSScroller()
        }
        if pdfView.autoScales { pdfView.autoScales = true }
    }

    private var scrollObserver: NSObjectProtocol?

    private func observeScrolling() {
        if let scrollObserver { NotificationCenter.default.removeObserver(scrollObserver) }
        guard let clipView = pdfView.documentView?.enclosingScrollView?.contentView else { return }
        clipView.postsBoundsChangedNotifications = true
        scrollObserver = NotificationCenter.default.addObserver(
            forName: NSView.boundsDidChangeNotification, object: clipView, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.reportScroll() }
        }
    }

    // MARK: Outline

    /// The PDF's bookmarks as TOC items with `page-<index>#<y>` hrefs.
    static func outline(of document: PDFDocument) -> [TocItem] {
        func children(of outline: PDFOutline, depth: Int) -> [TocItem] {
            guard depth < 12 else { return [] }
            return (0..<outline.numberOfChildren).compactMap { index in
                guard let child = outline.child(at: index) else { return nil }
                var href = ""
                if let destination = child.destination ?? (child.action as? PDFActionGoTo)?.destination,
                   let page = destination.page {
                    let pageIndex = document.index(for: page)
                    let y = destination.point.y
                    href = y.isFinite && y < 1_000_000 && y > -1_000_000 ? "page-\(pageIndex)#\(Int(y))" : "page-\(pageIndex)"
                }
                let title = EPUBParser.collapseWhitespace(child.label ?? "")
                guard !title.isEmpty else { return nil }
                return TocItem(title: title, href: href, children: children(of: child, depth: depth + 1))
            }
        }
        return document.outlineRoot.map { children(of: $0, depth: 0) } ?? []
    }

    private func pageIndex(fromHref href: String) -> (index: Int, y: Double?)? {
        let (path, fragment) = BookPath.splitFragment(href)
        guard path.hasPrefix("page-"), let index = Int(path.dropFirst(5)) else { return nil }
        return (index, fragment.flatMap(Double.init))
    }

    private func unit(forHref href: String) -> Double? {
        guard let (index, y) = pageIndex(fromHref: href), let page = pdfView.document?.page(at: index) else { return nil }
        guard let y else { return Double(index) }
        let bounds = page.bounds(for: pdfView.displayBox)
        return Double(index) + max(0, min(1, (bounds.maxY - y) / max(bounds.height, 1)))
    }

    func go(toHref href: String) {
        guard let (index, y) = pageIndex(fromHref: href), let page = pdfView.document?.page(at: index) else { return }
        let bounds = page.bounds(for: pdfView.displayBox)
        pdfView.go(to: PDFDestination(page: page, at: NSPoint(x: bounds.minX, y: y ?? bounds.maxY)))
    }

    // MARK: Units

    private var isFlipped: Bool { pdfView.isFlipped }

    private func unit(at point: NSPoint) -> Double? {
        guard let document = pdfView.document, let page = pdfView.page(for: point, nearest: true) else { return nil }
        let local = pdfView.convert(point, to: page)
        let bounds = page.bounds(for: pdfView.displayBox)
        let fraction = max(0, min(1, (bounds.maxY - local.y) / max(bounds.height, 1)))
        return Double(document.index(for: page)) + fraction
    }

    func scrollTo(unit: Double) {
        guard let document = pdfView.document, document.pageCount > 0 else { return }
        let clamped = max(0, min(Double(document.pageCount) - 0.0001, unit))
        guard let page = document.page(at: Int(clamped)) else { return }
        let bounds = page.bounds(for: pdfView.displayBox)
        let y = bounds.maxY - (clamped - floor(clamped)) * bounds.height
        pdfView.go(to: PDFDestination(page: page, at: NSPoint(x: bounds.minX, y: y)))
    }

    private func reportScroll() {
        guard !restoring, let document = pdfView.document, document.pageCount > 0, let model else { return }
        let bounds = pdfView.bounds
        let topPoint = NSPoint(x: bounds.midX, y: isFlipped ? bounds.minY + 1 : bounds.maxY - 1)
        let bottomPoint = NSPoint(x: bounds.midX, y: isFlipped ? bounds.maxY - 1 : bounds.minY + 1)
        guard let top = unit(at: topPoint), let bottom = unit(at: bottomPoint) else { return }

        let pageCount = Double(document.pageCount)
        var map = ScrollMap(total: pageCount, viewportTop: top, viewportHeight: max(0.01, bottom - top))
        if !tocUnits.isEmpty {
            map.segments = tocUnits.sorted { $0.unit < $1.unit }.map { .init(top: $0.unit, title: model.toc[safe: $0.index]?.title ?? "") }
        } else {
            // Without bookmarks, sample pages so a long document doesn't draw hundreds of segments.
            let step = max(1, document.pageCount / 60)
            map.segments = stride(from: 0, to: document.pageCount, by: step).map { .init(top: Double($0), title: "Page \($0 + 1)") }
        }

        var active: Int?
        for target in tocUnits where target.unit <= top + 0.05 { active = target.index }
        if active == nil { active = tocUnits.first?.index }

        let maxTop = max(0.0001, pageCount - map.viewportHeight)
        model.pdfScrolled(map: map, activeToc: active)
        PositionStore.shared.setPosition(
            ReadingPosition(progress: min(1, top / maxTop), chapterId: Self.pdfUnitMarker, ratio: top),
            for: model.filePath ?? "")
    }

    // MARK: Zoom

    /// PDFView paints its own background (white when clear), so it takes the theme's page color.
    func apply(background: String) {
        pdfView.backgroundColor = NSColor(hex: background)
    }

    func apply(zoom: PDFZoom) {
        guard zoom != self.zoom else { return }
        self.zoom = zoom
        applyZoom(preservingPosition: true)
    }

    private func applyZoom(preservingPosition: Bool) {
        guard let document = pdfView.document else { return }
        let bounds = pdfView.bounds
        let anchor = preservingPosition ? unit(at: NSPoint(x: bounds.midX, y: isFlipped ? bounds.minY + 1 : bounds.maxY - 1)) : nil
        switch zoom {
        case .fitWidth:
            pdfView.autoScales = true
        case .fitPage:
            pdfView.autoScales = false
            let page = pdfView.currentPage ?? document.page(at: 0)
            if let page {
                let size = page.bounds(for: pdfView.displayBox).size
                let available = pdfView.bounds.insetBy(dx: 8, dy: 8).size
                pdfView.scaleFactor = max(0.1, min(available.width / max(size.width, 1), available.height / max(size.height, 1)))
            }
        case .scale(let value):
            pdfView.autoScales = false
            pdfView.scaleFactor = value
        }
        if let anchor { scrollTo(unit: anchor) }
    }

    // MARK: Search

    func setSearchTerms(_ terms: [String]) {
        guard let document = pdfView.document, let first = terms.first else {
            pdfView.highlightedSelections = nil
            return
        }
        let matches = document.findString(first, withOptions: [.caseInsensitive])
        let limited = Array(matches.prefix(500))
        limited.forEach { $0.color = NSColor.systemYellow.withAlphaComponent(0.5) }
        pdfView.highlightedSelections = limited
    }

    func jumpToSearchResult(_ result: SearchIndex.Result) {
        guard let (index, _) = pageIndex(fromHref: result.href), let page = pdfView.document?.page(at: index),
              let text = page.string else { return }
        let ns = text as NSString
        var searchRange = NSRange(location: 0, length: ns.length)
        var found: NSRange?
        for _ in 0...result.matchIndex {
            let range = ns.range(of: result.term, options: .caseInsensitive, range: searchRange)
            guard range.location != NSNotFound else { break }
            found = range
            searchRange = NSRange(location: range.upperBound, length: ns.length - range.upperBound)
        }
        if let found, let selection = page.selection(for: found) {
            pdfView.go(to: selection)
            pdfView.setCurrentSelection(selection, animate: true)
        } else {
            go(toHref: result.href)
        }
    }

    // MARK: Highlights

    private func applyHighlights() {
        guard let model, let document = pdfView.document else { return }
        for highlight in model.highlights {
            guard let index = Int(highlight.chapterId.dropFirst("page-".count)), let page = document.page(at: index)
            else { continue }
            addAnnotations(for: highlight, on: page)
        }
    }

    private func addAnnotations(for highlight: Highlight, on page: PDFPage) {
        guard let length = page.string?.utf16.count, highlight.end <= length,
              let selection = page.selection(for: NSRange(location: highlight.start, length: highlight.end - highlight.start))
        else { return }
        for line in selection.selectionsByLine() {
            let annotation = PDFAnnotation(bounds: line.bounds(for: page), forType: .highlight, withProperties: nil)
            annotation.color = NSColor.systemYellow.withAlphaComponent(0.45)
            annotation.userName = "gull:\(highlight.id)"
            page.addAnnotation(annotation)
            annotations[highlight.id, default: []].append((page, annotation))
        }
    }

    func highlightSelection() {
        guard let model, let selection = pdfView.currentSelection, let document = pdfView.document else { return }
        for page in selection.pages {
            guard selection.numberOfTextRanges(on: page) > 0, let text = page.string else { continue }
            let first = selection.range(at: 0, on: page)
            let last = selection.range(at: selection.numberOfTextRanges(on: page) - 1, on: page)
            let range = NSRange(location: first.location, length: last.upperBound - first.location)
            guard range.length > 0, range.upperBound <= (text as NSString).length else { continue }
            let ns = text as NSString
            let chapterId = "page-\(document.index(for: page))"

            // Merge with highlights it overlaps or touches, like the reflowable reader.
            let overlapping = model.highlights.filter {
                $0.chapterId == chapterId && $0.start <= range.upperBound && $0.end >= range.location
            }
            let start = overlapping.map(\.start).reduce(range.location, min)
            let end = overlapping.map(\.end).reduce(range.upperBound, max)
            overlapping.forEach { removeAnnotations($0.id) }

            let highlight = Highlight(
                id: UUID().uuidString, chapterId: chapterId, start: start, end: end,
                text: ns.substring(with: NSRange(location: start, length: end - start)),
                prefix: ns.substring(with: NSRange(location: max(0, start - 32), length: start - max(0, start - 32))),
                suffix: ns.substring(with: NSRange(location: end, length: min(32, ns.length - end))),
                createdAt: Date.now.timeIntervalSince1970 * 1000)
            model.addHighlight(highlight, replacing: overlapping.map(\.id))
            addAnnotations(for: highlight, on: page)
        }
        pdfView.clearSelection()
    }

    private func removeAnnotations(_ id: String) {
        for (page, annotation) in annotations[id] ?? [] { page.removeAnnotation(annotation) }
        annotations[id] = nil
    }

    func removeHighlight(_ id: String) { removeAnnotations(id) }

    /// Shows the system dictionary popover for the first line of the selection.
    func lookUpSelection() {
        guard let line = pdfView.currentSelection?.selectionsByLine().first, let page = line.pages.first,
              let text = pdfView.currentSelection?.string?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty else { return }
        let bounds = pdfView.convert(line.bounds(for: page), from: page)
        let pageFont = line.attributedString?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont
        let size = (pageFont?.pointSize ?? bounds.height * 0.8) * pdfView.scaleFactor
        let font = pageFont.flatMap { NSFont(descriptor: $0.fontDescriptor, size: size) } ?? .systemFont(ofSize: size)
        let baseline = NSPoint(x: bounds.minX, y: pdfView.isFlipped ? bounds.maxY + font.descender
                                                                     : bounds.minY - font.descender)
        pdfView.showDefinition(for: NSAttributedString(string: text, attributes: [.font: font]), at: baseline)
    }

    func jumpToHighlight(_ highlight: Highlight) {
        guard let index = Int(highlight.chapterId.dropFirst("page-".count)),
              let page = pdfView.document?.page(at: index),
              let selection = page.selection(for: NSRange(location: highlight.start, length: highlight.end - highlight.start))
        else { return }
        pdfView.go(to: selection)
        pdfView.setCurrentSelection(selection, animate: true)
    }
}

/// A scroller that takes up no room and never draws or takes clicks.
private final class InvisibleScroller: NSScroller {
    override class var isCompatibleWithOverlayScrollers: Bool { true }
    override class func scrollerWidth(for controlSize: NSControl.ControlSize, scrollerStyle: NSScroller.Style) -> CGFloat { 0 }
    override func draw(_ dirtyRect: NSRect) {}
    override func drawKnob() {}
    override func drawKnobSlot(in slotRect: NSRect, highlight flag: Bool) {}
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// A `PDFView` whose context menu offers "Highlight" and "Search in Book" for a
/// selection and "Remove Highlight" over an existing Gull highlight.
final class ReaderPDFView: PDFView {
    var onHighlightMenu: (() -> Void)?
    var onRemoveHighlightMenu: ((String) -> Void)?
    var onSearchMenu: ((String) -> Void)?

    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = super.menu(for: event) ?? NSMenu()
        var index = 0
        let highlightId = highlightId(at: event)
        if let id = highlightId {
            let item = NSMenuItem(title: "Remove Highlight", action: #selector(removeHighlightFromMenu), keyEquivalent: "")
            item.target = self
            item.image = NSImage(systemSymbolName: "eraser", accessibilityDescription: nil)
            item.representedObject = id
            menu.insertItem(item, at: index)
            index += 1
        }
        if let selection = currentSelection, !(selection.string ?? "").isEmpty {
            if highlightId == nil {
                let item = NSMenuItem(title: "Highlight", action: #selector(highlightFromMenu), keyEquivalent: "")
                item.target = self
                item.image = NSImage(systemSymbolName: "highlighter", accessibilityDescription: nil)
                menu.insertItem(item, at: index)
                index += 1
            }
            let search = NSMenuItem(title: "Search in Book", action: #selector(searchFromMenu), keyEquivalent: "")
            search.target = self
            search.image = NSImage(systemSymbolName: "magnifyingglass", accessibilityDescription: nil)
            menu.insertItem(search, at: index)
            index += 1
        }
        if index > 0, menu.items.count > index { menu.insertItem(.separator(), at: index) }
        return menu
    }

    private func highlightId(at event: NSEvent) -> String? {
        let point = convert(event.locationInWindow, from: nil)
        guard let page = page(for: point, nearest: false),
              let name = page.annotation(at: convert(point, to: page))?.userName, name.hasPrefix("gull:")
        else { return nil }
        return String(name.dropFirst(5))
    }

    @objc private func highlightFromMenu() { onHighlightMenu?() }
    @objc private func searchFromMenu() { if let text = currentSelection?.string { onSearchMenu?(text) } }
    @objc private func removeHighlightFromMenu(_ sender: NSMenuItem) {
        if let id = sender.representedObject as? String { onRemoveHighlightMenu?(id) }
    }
}
