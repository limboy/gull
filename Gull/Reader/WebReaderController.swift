import AppKit
import WebKit

/// Owns the window's `WKWebView` and translates between `ReaderModel` and the
/// page runtime in `reader.js`.
final class WebReaderController: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    let webView: ReaderWebView
    private weak var model: ReaderModel?
    private var pageReady = false
    private var pendingLoad: [String: Any]?
    private var appliedStyle: ReadingStyle?
    private var appliedHideScrollbar: Bool?
    private var trailingInset: CGFloat = 0

    private static let schemeHandler = ReaderSchemeHandler()
    private static let readerURL = URL(string: "\(ResourceURL.origin)/reader.html")!

    init(model: ReaderModel) {
        self.model = model
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(Self.schemeHandler, forURLScheme: ResourceURL.scheme)
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.isTextInteractionEnabled = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.suppressesIncrementalRendering = false
        webView = ReaderWebView(frame: .zero, configuration: configuration)
        super.init()

        configuration.userContentController.add(WeakScriptMessageHandler(self), name: "gull")
        webView.navigationDelegate = self
        webView.allowsLinkPreview = false
        webView.allowsMagnification = false
        webView.allowsBackForwardNavigationGestures = false
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = .clear
        webView.unregisterDraggedTypes()
        webView.onHighlight = { [weak self] in self?.model?.highlightSelection() }
        webView.onRemoveHighlight = { [weak self] id in self?.model?.removeHighlight(id) }
        webView.onSearch = { [weak self] text in self?.model?.searchInBook(text) }
        webView.onLookUp = { [weak self] point in self?.lookUp(at: point) }
        #if DEBUG
        webView.isInspectable = true
        #endif
        webView.load(URLRequest(url: Self.readerURL))
    }

    // MARK: Commands

    private func call(_ body: String, _ arguments: [String: Any] = [:]) {
        guard pageReady else { return }
        webView.callAsyncJavaScript(body, arguments: arguments, in: nil, in: .page) { result in
            if case .failure(let error) = result { NSLog("Gull reader: \(error.localizedDescription)") }
        }
    }

    func load(token: String, position: ReadingPosition?, highlights: [Highlight], searchTerms: [String]) {
        let settings = ReaderSettings.shared
        let style = settings.style(theme: settings.currentTheme)
        var positionValue: [String: Any] = [:]
        if let position {
            positionValue["progress"] = position.progress
            if let chapterId = position.chapterId { positionValue["chapterId"] = chapterId }
            if let ratio = position.ratio { positionValue["ratio"] = ratio }
        }
        let config: [String: Any] = [
            "contentURL": ResourceURL.content(token: token),
            "position": positionValue,
            "highlights": highlights.map(Self.dictionary),
            "style": Self.dictionary(style),
            "hideScrollbar": settings.chapterScrollbar,
            "trailingInset": trailingInset,
            "searchTerms": searchTerms,
        ]
        appliedStyle = style
        appliedHideScrollbar = settings.chapterScrollbar
        if pageReady { call("Gull.load(config)", ["config": config]) } else { pendingLoad = config }
        webView.window?.makeFirstResponder(webView)
    }

    func apply(style: ReadingStyle, hideScrollbar: Bool) {
        // WebKit fills the areas the page doesn't cover (the obscured strip under the
        // chapter scrollbar, overscroll) with this, so it takes the theme's page color.
        webView.underPageBackgroundColor = NSColor(hex: style.theme.background)
        if style != appliedStyle {
            appliedStyle = style
            call("Gull.setStyle(style)", ["style": Self.dictionary(style)])
        }
        if hideScrollbar != appliedHideScrollbar {
            appliedHideScrollbar = hideScrollbar
            call("Gull.setScrollbarHidden(hidden)", ["hidden": hideScrollbar])
        }
    }

    /// How much of the web view the toolbar (top) and chapter scrollbar (trailing) cover.
    /// Only the top is an obscured inset: WebKit draws an opaque panel over any obscured
    /// edge, so the page pads itself for the scrollbar instead.
    func setInsets(top: CGFloat, trailing: CGFloat) {
        if webView.obscuredContentInsets.top != top {
            webView.obscuredContentInsets = NSEdgeInsets(top: top, left: 0, bottom: 0, right: 0)
        }
        if trailingInset != trailing {
            trailingInset = trailing
            call("Gull.setTrailingInset(inset)", ["inset": trailing])
        }
    }

    func scrollToHref(_ href: String) { call("Gull.scrollToHref(href, null)", ["href": href]) }
    func scrollTo(offset: Double) { call("Gull.scrollToOffset(top)", ["top": offset]) }
    func setSearchTerms(_ terms: [String]) { call("Gull.setSearchTerms(terms)", ["terms": terms]) }
    func highlightSelection() { call("Gull.highlightSelection()") }
    func removeHighlight(_ id: String) { call("Gull.removeHighlight(id)", ["id": id]) }

    /// Shows the system dictionary popover for the selection, as ⌃⌘D does in native text views.
    func lookUpSelection() { showDefinition("return Gull.selectionForLookUp()") }

    /// Shows the dictionary popover for the selection or word at `point` (three-finger tap).
    private func lookUp(at point: NSPoint) {
        showDefinition("return Gull.lookUpAt(x, y)", ["x": point.x, "y": point.y])
    }

    private func showDefinition(_ body: String, _ arguments: [String: Any] = [:]) {
        guard pageReady else { return }
        webView.callAsyncJavaScript(body, arguments: arguments, in: nil, in: .page) { [weak self] result in
            guard let self, case .success(let value) = result, let dict = value as? [String: Any],
                  let text = dict["text"] as? String else { return }
            func number(_ key: String) -> Double { (dict[key] as? NSNumber)?.doubleValue ?? 0 }
            let size = number("fontSize")
            let font = NSFont(name: dict["fontFamily"] as? String ?? "", size: size) ?? .systemFont(ofSize: size)
            // The page's coordinates match the (flipped) web view's; the popover wants the text baseline.
            let baseline = NSPoint(x: number("x"), y: number("bottom") + font.descender)
            webView.showDefinition(for: NSAttributedString(string: text, attributes: [.font: font]), at: baseline)
        }
    }

    func jumpToSearchResult(_ result: SearchIndex.Result) {
        call("Gull.jumpToSearchResult(chapterId, href, term, matchIndex)", [
            "chapterId": result.chapterId, "href": result.href, "term": result.term, "matchIndex": result.matchIndex,
        ])
    }

    func jumpToHighlight(_ highlight: Highlight) {
        call("Gull.jumpToHighlight(id, chapterId)", ["id": highlight.id, "chapterId": highlight.chapterId])
    }

    private static func dictionary(_ style: ReadingStyle) -> [String: Any] {
        ["fontFamily": style.font.cssFamily, "fontSize": style.fontSize, "lineHeight": style.lineHeight,
         "paraSpacing": style.paraSpacing, "fullWidth": style.fullWidth,
         "theme": ["dark": style.theme.isDark, "background": style.theme.background, "text": style.theme.text, "secondary": style.theme.secondary,
                   "accent": style.theme.accent, "border": style.theme.border]]
    }

    private static func dictionary(_ highlight: Highlight) -> [String: Any] {
        var value: [String: Any] = [
            "id": highlight.id, "chapterId": highlight.chapterId, "start": highlight.start, "end": highlight.end,
            "text": highlight.text, "createdAt": highlight.createdAt,
        ]
        if let prefix = highlight.prefix { value["prefix"] = prefix }
        if let suffix = highlight.suffix { value["suffix"] = suffix }
        return value
    }

    private static func highlight(from value: Any?) -> Highlight? {
        guard let dict = value as? [String: Any], let id = dict["id"] as? String,
              let chapterId = dict["chapterId"] as? String else { return nil }
        return Highlight(
            id: id, chapterId: chapterId,
            start: (dict["start"] as? NSNumber)?.intValue ?? 0, end: (dict["end"] as? NSNumber)?.intValue ?? 0,
            text: dict["text"] as? String ?? "", prefix: dict["prefix"] as? String, suffix: dict["suffix"] as? String,
            createdAt: (dict["createdAt"] as? NSNumber)?.doubleValue ?? Date.now.timeIntervalSince1970 * 1000)
    }

    private static func rect(_ value: Any?) -> CGRect? {
        guard let dict = value as? [String: Any] else { return nil }
        func number(_ key: String) -> Double { (dict[key] as? NSNumber)?.doubleValue ?? 0 }
        return CGRect(x: number("x"), y: number("y"), width: number("width"), height: number("height"))
    }

    // MARK: Messages from the page

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == ResourceURL.scheme,
              let body = message.body as? [String: Any], let type = body["type"] as? String, let model
        else { return }
        let number = { (key: String) in (body[key] as? NSNumber)?.doubleValue ?? 0 }

        switch type {
        case "ready":
            pageReady = true
            if let pendingLoad {
                self.pendingLoad = nil
                call("Gull.load(config)", ["config": pendingLoad])
            }
        case "rendered":
            model.readerRendered()
        case "layout":
            let targets = (body["targets"] as? [[String: Any]] ?? []).compactMap { item -> (Int, Double)? in
                guard let index = (item["index"] as? NSNumber)?.intValue,
                      let top = (item["top"] as? NSNumber)?.doubleValue else { return nil }
                return (index, top)
            }
            let chapters = (body["chapters"] as? [[String: Any]] ?? []).compactMap { item -> (String, Double)? in
                guard let id = item["id"] as? String, let top = (item["top"] as? NSNumber)?.doubleValue else { return nil }
                return (id, top)
            }
            model.readerLayout(height: number("height"), viewport: number("viewport"),
                               targets: targets.map { (index: $0.0, top: $0.1) },
                               chapters: chapters.map { (id: $0.0, top: $0.1) })
        case "scroll":
            let position = ReadingPosition(
                progress: number("progress"), chapterId: body["chapterId"] as? String, ratio: number("ratio"))
            model.readerScrolled(top: number("top"), height: number("height"), viewport: number("viewport"),
                                 position: position)
        case "contextMenu":
            webView.contextHighlightId = body["highlightId"] as? String
            webView.contextText = body["text"] as? String ?? ""
        case "highlightCreated":
            if let highlight = Self.highlight(from: body["highlight"]) {
                model.addHighlight(highlight, replacing: body["removedIds"] as? [String] ?? [])
            }
        case "highlightsRepaired":
            model.repairHighlights((body["highlights"] as? [Any] ?? []).compactMap(Self.highlight(from:)))
        case "footnote":
            if let text = body["text"] as? String, let rect = Self.rect(body["rect"]) {
                model.footnote = FootnoteState(text: text, rect: rect)
            }
        case "dismissFootnote":
            if model.footnote != nil { model.footnote = nil }
        case "openExternal":
            if let string = body["url"] as? String, let url = URL(string: string),
               ["http", "https", "mailto", "tel"].contains(url.scheme?.lowercased() ?? "") {
                NSWorkspace.shared.open(url)
            }
        case "error":
            NSLog("Gull reader error: \(body["message"] as? String ?? "")")
        default:
            break
        }
    }

    // MARK: Navigation policy

    /// The page is a single document; links are handled by the runtime and
    /// never navigate the web view.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        if action.navigationType == .other, action.request.url == Self.readerURL, action.targetFrame?.isMainFrame == true {
            return .allow
        }
        return .cancel
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // Recover from a crashed content process by reloading the shell and the book.
        pageReady = false
        webView.load(URLRequest(url: Self.readerURL))
        if let model, let path = model.filePath {
            model.open(nil)
            model.open(path)
        }
    }
}

/// `WKUserContentController` retains its handlers; this breaks the cycle.
private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: (any WKScriptMessageHandler)?

    init(_ target: any WKScriptMessageHandler) { self.target = target }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

/// Adds "Highlight", "Search in Book" and "Remove Highlight" to the context
/// menu and drops items that make no sense in a reader (Reload, Back, Forward).
final class ReaderWebView: WKWebView {
    var onHighlight: (() -> Void)?
    var onRemoveHighlight: ((String) -> Void)?
    var onSearch: ((String) -> Void)?
    var onLookUp: ((NSPoint) -> Void)?
    /// The highlight under the last right-click and the selected text, reported by
    /// the page just before the menu opens.
    var contextHighlightId: String?
    var contextText = ""

    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        super.willOpenMenu(menu, with: event)
        let unwanted = ["WKMenuItemIdentifierReload", "WKMenuItemIdentifierGoBack", "WKMenuItemIdentifierGoForward",
                        "WKMenuItemIdentifierOpenLinkInNewWindow", "WKMenuItemIdentifierDownloadLinkedFile",
                        "WKMenuItemIdentifierOpenImageInNewWindow", "WKMenuItemIdentifierDownloadImage"]
        for item in menu.items where unwanted.contains(item.identifier?.rawValue ?? "") { menu.removeItem(item) }
        let hasSelection = menu.items.contains { $0.identifier?.rawValue == "WKMenuItemIdentifierCopy" }
        var items: [NSMenuItem] = []
        if contextHighlightId != nil {
            items.append(menuItem("Remove Highlight", "eraser", #selector(removeHighlightFromMenu)))
        } else if hasSelection {
            items.append(menuItem("Highlight", "highlighter", #selector(highlightFromMenu)))
        }
        if hasSelection, !contextText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            items.append(menuItem("Search in Book", "magnifyingglass", #selector(searchFromMenu)))
        }
        if !items.isEmpty { menu.insertItem(.separator(), at: 0) }
        for (index, item) in items.enumerated() { menu.insertItem(item, at: index) }
        while menu.items.first?.isSeparatorItem == true { menu.removeItem(at: 0) }
        while menu.items.last?.isSeparatorItem == true { menu.removeItem(at: menu.items.count - 1) }
    }

    @objc private func highlightFromMenu() { onHighlight?() }
    @objc private func removeHighlightFromMenu() { if let id = contextHighlightId { onRemoveHighlight?(id) } }
    @objc private func searchFromMenu() { onSearch?(contextText) }

    /// The system Look Up gesture (three-finger tap). WebKit doesn't act on it in an
    /// app's web view, so look the word up ourselves.
    override func quickLook(with event: NSEvent) {
        onLookUp?(convert(event.locationInWindow, from: nil))
    }

    private func menuItem(_ title: String, _ symbol: String, _ action: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        return item
    }
}
