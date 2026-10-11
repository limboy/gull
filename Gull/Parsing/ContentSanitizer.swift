import Foundation

/// Publication sanitizing and normalization, ported from `lib/book-content.js`.
///
/// The reader reflows with its own typography, so book CSS loses the properties
/// that would override the user's settings, and anything executable or able to
/// reach the network is removed before markup reaches the web view.
nonisolated enum ContentSanitizer {
    static let stripCSSProperties: Set<String> = [
        "font-family", "color", "background", "background-color",
        "background-image", "border-color",
        "font-size", "line-height",
        "position", "top", "right", "bottom", "left",
        "inset", "inset-block", "inset-block-start", "inset-block-end",
        "inset-inline", "inset-inline-start", "inset-inline-end",
        "transform", "z-index", "-webkit-app-region",
        "behavior", "-moz-binding",
    ]

    static let htmlVoidTags: Set<String> = [
        "area", "base", "br", "col", "embed", "hr", "img",
        "input", "link", "meta", "param", "source", "track", "wbr",
    ]

    static let blockedElements: Set<String> = [
        "script", "iframe", "frame", "frameset", "object", "embed",
        "portal", "webview", "base", "form", "input", "button", "select",
        "textarea", "option", "audio", "video", "track", "source",
        "foreignobject", "noscript",
    ]

    static let urlAttributes: Set<String> = ["href", "src", "xlink:href", "poster", "action", "formaction"]
    static let linkSchemes: Set<String> = ["http", "https", "mailto", "tel"]

    // MARK: CSS

    private static let unsafeCSS = try! NSRegularExpression(
        pattern: #"(?:url\s*\(|expression\s*\(|javascript\s*:|vbscript\s*:|@import\b)"#,
        options: .caseInsensitive)
    private static let cssComment = try! NSRegularExpression(pattern: #"/\*[\s\S]*?\*/"#)
    private static let dropCap = try! NSRegularExpression(pattern: "drop-?cap", options: .caseInsensitive)
    private static let rootSelector = try! NSRegularExpression(
        pattern: #"^\s*(html|body)\b([^\s>+~]*)"#, options: .caseInsensitive)

    static func hasUnsafeCSSValue(_ value: String) -> Bool {
        unsafeCSS.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
    }

    static func isDropCap(_ text: String) -> Bool {
        dropCap.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    private static func stripComments(_ css: String) -> String {
        cssComment.stringByReplacingMatches(in: css, range: NSRange(css.startIndex..., in: css), withTemplate: "")
    }

    /// Filters one declaration block (or a `style` attribute).
    static func filterInlineStyle(_ style: String, preserveMetrics: Bool = false) -> String {
        stripComments(style)
            .split(separator: ";")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { declaration in
                guard let colon = declaration.firstIndex(of: ":"), colon > declaration.startIndex,
                      !hasUnsafeCSSValue(declaration) else { return false }
                let property = declaration[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
                if preserveMetrics, property == "font-size" || property == "line-height" { return true }
                return !stripCSSProperties.contains(property)
            }
            .joined(separator: "; ")
    }

    /// Filters a stylesheet and scopes every selector under `.book-content`.
    ///
    /// Unlike the regex the Electron build used, this walks braces, so rules
    /// nested in `@media` / `@supports` are filtered and scoped too.
    static func filterStylesheet(_ css: String, scope: String = ".book-content") -> String {
        let source = Array(stripComments(css).unicodeScalars)
        var index = 0
        return filterRules(source, &index, scope: scope, depth: 0)
    }

    private static func filterRules(_ s: [Unicode.Scalar], _ i: inout Int, scope: String, depth: Int) -> String {
        var output = ""
        while i < s.count {
            // Prelude: everything up to `{`, `;` (statement at-rule) or `}` (end of block).
            var prelude = ""
            while i < s.count, s[i] != "{", s[i] != ";", s[i] != "}" {
                prelude.unicodeScalars.append(s[i]); i += 1
            }
            if i >= s.count { break }
            if s[i] == "}" { i += 1; break }
            if s[i] == ";" { i += 1; continue } // @import / @charset / @namespace: dropped

            i += 1 // consume `{`
            let trimmed = prelude.trimmingCharacters(in: .whitespacesAndNewlines)
            let lower = trimmed.lowercased()
            if lower.hasPrefix("@media") || lower.hasPrefix("@supports") || lower.hasPrefix("@container")
                || lower.hasPrefix("@layer") {
                let inner = depth < 8 ? filterRules(s, &i, scope: scope, depth: depth + 1) : skipBlock(s, &i)
                if !inner.isEmpty, !hasUnsafeCSSValue(trimmed) { output += "\(trimmed) {\n\(inner)}\n" }
                continue
            }
            let block = readBlock(s, &i)
            if trimmed.hasPrefix("@") { continue } // @font-face, @page, @keyframes…: dropped
            if trimmed.isEmpty || hasUnsafeCSSValue(trimmed) || hasUnsafeCSSValue(block) { continue }
            let filtered = filterInlineStyle(block, preserveMetrics: isDropCap(trimmed))
            if filtered.isEmpty { continue }
            output += "\(scopeSelector(trimmed, scope: scope)) { \(filtered); }\n"
        }
        return output
    }

    /// Reads a declaration block up to its closing brace (nested braces skipped).
    private static func readBlock(_ s: [Unicode.Scalar], _ i: inout Int) -> String {
        var block = ""
        var depth = 0
        while i < s.count {
            let c = s[i]; i += 1
            if c == "{" { depth += 1 } else if c == "}" {
                if depth == 0 { break }
                depth -= 1
            }
            if depth == 0 { block.unicodeScalars.append(c) }
        }
        return block
    }

    private static func skipBlock(_ s: [Unicode.Scalar], _ i: inout Int) -> String {
        _ = readBlock(s, &i)
        return ""
    }

    static func scopeSelector(_ selectorList: String, scope: String) -> String {
        selectorList.split(separator: ",").map { part -> String in
            let selector = part.trimmingCharacters(in: .whitespacesAndNewlines)
            let range = NSRange(selector.startIndex..., in: selector)
            if let match = rootSelector.firstMatch(in: selector, range: range),
               let swiftRange = Range(match.range, in: selector) {
                // `body.Copyright p` keeps its qualifier, so it only matches chapters
                // whose `<body>` carried that class (see `bodyClasses`).
                let qualifier = Range(match.range(at: 2), in: selector).map { String(selector[$0]) } ?? ""
                return scope + qualifier + selector[swiftRange.upperBound...]
            }
            return "\(scope) \(selector)"
        }.joined(separator: ", ")
    }

    // MARK: URLs

    static func scheme(of value: String) -> String? {
        let compact = value.unicodeScalars.filter { $0.value > 0x20 && $0.value != 0x7F }
        let string = String(String.UnicodeScalarView(compact))
        guard let colon = string.firstIndex(of: ":") else { return nil }
        let candidate = string[..<colon]
        guard let first = candidate.first, first.isLetter,
              candidate.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "+" || $0 == "." || $0 == "-" })
        else { return nil }
        return candidate.lowercased()
    }

    static func isSafePublicationURL(_ value: String, tag: String, attribute: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return true }
        if trimmed.hasPrefix("//") { return false }
        guard let scheme = scheme(of: trimmed) else { return true }
        let isImageReference = (tag == "img" || tag == "image")
            && (attribute == "src" || attribute == "href" || attribute == "xlink:href")
        // Kindle-internal references are rewritten by the MOBI parser after this runs.
        if scheme == "kindle" { return true }
        if scheme == "data" {
            return isImageReference
                && trimmed.range(of: #"^data:image/(?:png|jpe?g|gif|webp|svg\+xml);base64,"#,
                                 options: [.regularExpression, .caseInsensitive]) != nil
        }
        if tag == "a", attribute == "href" { return linkSchemes.contains(scheme) }
        return false
    }

    static func isExternalLink(_ href: String) -> Bool {
        guard let scheme = scheme(of: href) else { return false }
        return linkSchemes.contains(scheme)
    }

    // MARK: Markup

    /// Parses (X)HTML into a document, falling back progressively for markup
    /// that is not well-formed XML (named HTML entities, MOBI's tag soup).
    static func parseDocument(_ data: Data, preferHTML: Bool = false) -> XMLDocument? {
        let xmlOptions: XMLNode.Options = [.nodeLoadExternalEntitiesNever, .nodePreserveWhitespace,
                                           .nodePreserveCDATA]
        if !preferHTML {
            if let document = try? XMLDocument(data: data, options: xmlOptions) { return document }
            let text = HTMLEntities.replaceNamedEntities(ZipArchive.decodeText(data))
            if let document = try? XMLDocument(data: Data(text.utf8), options: xmlOptions) { return document }
        }
        return try? XMLDocument(data: data, options: [.documentTidyHTML, .nodeLoadExternalEntitiesNever,
                                                      .nodePreserveWhitespace])
    }

    static func elements(in node: XMLNode, named name: String) -> [XMLElement] {
        var result: [XMLElement] = []
        func walk(_ node: XMLNode) {
            for child in node.children ?? [] {
                guard let element = child as? XMLElement else { continue }
                if (element.localName ?? element.name)?.lowercased() == name { result.append(element) }
                walk(element)
            }
        }
        walk(node)
        return result
    }

    static func firstElement(in node: XMLNode, named name: String) -> XMLElement? {
        for child in node.children ?? [] {
            guard let element = child as? XMLElement else { continue }
            if (element.localName ?? element.name)?.lowercased() == name { return element }
            if let found = firstElement(in: element, named: name) { return found }
        }
        return nil
    }

    static func childElements(of element: XMLElement, named name: String) -> [XMLElement] {
        (element.children ?? []).compactMap { $0 as? XMLElement }
            .filter { ($0.localName ?? $0.name)?.lowercased() == name }
    }

    static func attribute(_ element: XMLElement, _ name: String) -> String? {
        if let value = element.attribute(forName: name)?.stringValue { return value }
        // Prefixed names (`xlink:href`, `epub:type`) may be stored under their local name.
        let lowered = name.lowercased()
        return element.attributes?.first {
            ($0.name ?? "").lowercased() == lowered || ($0.localName ?? "").lowercased() == lowered
        }?.stringValue
    }

    /// Removes executable/embedded elements, event handlers, popup targets and
    /// unsafe URLs, in place.
    static func sanitize(_ root: XMLNode) {
        for child in root.children ?? [] {
            guard let element = child as? XMLElement else { continue }
            let tag = (element.localName ?? element.name ?? "").lowercased()
            if blockedElements.contains(tag) || (tag == "meta" && attribute(element, "http-equiv") != nil) {
                element.detach()
                continue
            }
            for attr in element.attributes ?? [] {
                guard let rawName = attr.name else { continue }
                let name = rawName.lowercased()
                if name.hasPrefix("on") || name == "srcdoc" || name == "target" {
                    element.removeAttribute(forName: rawName)
                    continue
                }
                if urlAttributes.contains(name),
                   !isSafePublicationURL(attr.stringValue ?? "", tag: tag, attribute: name) {
                    element.removeAttribute(forName: rawName)
                }
            }
            sanitize(element)
        }
    }

    /// Filters `style` attributes, keeping drop-cap metrics.
    static func filterStyleAttributes(_ root: XMLNode) {
        for child in root.children ?? [] {
            guard let element = child as? XMLElement else { continue }
            if let style = element.attribute(forName: "style")?.stringValue {
                let className = (attribute(element, "class") ?? "").lowercased()
                let cleaned = filterInlineStyle(
                    style, preserveMetrics: className.contains("dropcap") || className.contains("drop-cap"))
                if cleaned.isEmpty { element.removeAttribute(forName: "style") }
                else { element.attribute(forName: "style")?.stringValue = cleaned }
            }
            filterStyleAttributes(element)
        }
    }

    /// Rewrites every image reference through `resolve`, which returns the URL
    /// to load it from, or nil when the book lacks that resource.
    static func rewriteImages(_ root: XMLNode, resolve: (String) -> String?) {
        for element in elements(in: root, named: "img") + elements(in: root, named: "image") {
            let tag = (element.localName ?? element.name ?? "").lowercased()
            let source = attribute(element, "src") ?? attribute(element, "xlink:href") ?? attribute(element, "href")
            guard let source, !source.hasPrefix("data:") else { continue }
            guard let url = resolve(source) else { continue }
            if tag == "img" {
                element.removeAttribute(forName: "src")
                element.addAttribute(XMLNode.attribute(withName: "src", stringValue: url) as! XMLNode)
            } else {
                for attr in element.attributes ?? [] {
                    let name = (attr.name ?? "").lowercased()
                    if name == "href" || name == "xlink:href" || name == "src" { element.removeAttribute(forName: attr.name!) }
                }
                element.addAttribute(XMLNode.attribute(withName: "href", stringValue: url) as! XMLNode)
            }
        }
    }

    /// Rewrites internal `<a href>` targets with `resolve` (external links are left alone).
    static func rewriteLinks(_ root: XMLNode, resolve: (String) -> String?) {
        for element in elements(in: root, named: "a") {
            guard let attr = element.attribute(forName: "href"), let href = attr.stringValue,
                  !href.isEmpty, !isExternalLink(href) else { continue }
            if let resolved = resolve(href) { attr.stringValue = resolved }
            else { element.removeAttribute(forName: "href") }
        }
    }

    /// The `<body>` classes, to carry onto the chapter's section so `body.X`
    /// rules from the book's CSS keep applying only where the book meant them.
    static func bodyClasses(of document: XMLDocument) -> String {
        guard let body = firstElement(in: document, named: "body") else { return "" }
        return (attribute(body, "class") ?? "")
            .split(whereSeparator: \.isWhitespace)
            .filter { name in
                !name.hasPrefix("gull-") && name.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
            }
            .joined(separator: " ")
    }

    /// Serializes the children of `<body>` (or the whole document) as HTML that
    /// survives `innerHTML`: non-void self-closing tags are expanded.
    static func bodyHTML(of document: XMLDocument) -> (html: String, text: String) {
        let container: XMLNode = firstElement(in: document, named: "body") ?? document.rootElement() ?? document
        let html = (container.children ?? []).map { $0.xmlString(options: [.nodePreserveWhitespace]) }.joined()
        return (normalizeXHTMLFragment(html), container.stringValue ?? "")
    }

    private static let selfClosing = try! NSRegularExpression(pattern: #"<([a-zA-Z][\w:-]*)(\s[^<>]*?)?\s*/>"#)

    static func normalizeXHTMLFragment(_ html: String) -> String {
        let ns = html as NSString
        var output = ""
        var last = 0
        for match in selfClosing.matches(in: html, range: NSRange(location: 0, length: ns.length)) {
            output += ns.substring(with: NSRange(location: last, length: match.range.location - last))
            let tag = ns.substring(with: match.range(at: 1))
            let attrs = match.range(at: 2).location != NSNotFound ? ns.substring(with: match.range(at: 2)) : ""
            output += htmlVoidTags.contains(tag.lowercased()) ? "<\(tag)\(attrs)>" : "<\(tag)\(attrs)></\(tag)>"
            last = match.range.location + match.range.length
        }
        output += ns.substring(from: last)
        // XMLDocument writes empty void elements as `<br></br>`; HTML parses the
        // stray `</br>` as a second line break.
        return voidClosingTag.stringByReplacingMatches(
            in: output, range: NSRange(location: 0, length: (output as NSString).length), withTemplate: "")
    }

    private static let voidClosingTag = try! NSRegularExpression(
        pattern: "</(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\\s*>",
        options: .caseInsensitive)
}
