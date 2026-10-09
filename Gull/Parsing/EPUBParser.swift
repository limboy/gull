import Foundation

/// Builds the URLs book markup uses to load its images through the reader's
/// `gull://` scheme handler. Everything lives under one origin (`gull://app`)
/// so the reader page can fetch book content without CORS.
nonisolated enum ResourceURL {
    static let scheme = "gull"
    static let origin = "gull://app"

    static func make(token: String, path: String) -> String {
        let encoded = path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(["?", "#"])) ?? path
        return "\(origin)/book/\(token)/res/\(encoded)"
    }

    static func content(token: String) -> String { "\(origin)/book/\(token)/content.json" }
}

nonisolated struct ZipResources: BookResourceProvider {
    let zip: ZipArchive

    func resource(at path: String) -> (data: Data, mimeType: String)? {
        guard let data = zip.read(path) else { return nil }
        return (data, MimeType.sniff(data) ?? MimeType.forImagePath(path))
    }
}

/// EPUB 2/3 parsing, ported from `lib/epub-parser.js`.
nonisolated enum EPUBParser {
    struct PackageDocument {
        let opf: XMLDocument
        let opfDir: String
        let manifest: [String: ManifestItem]
        let manifestOrder: [String]
    }

    struct ManifestItem {
        let href: String
        let mediaType: String
        let properties: [String]
    }

    static func readPackage(_ zip: ZipArchive) throws -> PackageDocument {
        guard let containerData = zip.read("META-INF/container.xml"),
              let container = ContentSanitizer.parseDocument(containerData),
              let rootfile = ContentSanitizer.firstElement(in: container, named: "rootfile"),
              let opfPathRaw = ContentSanitizer.attribute(rootfile, "full-path")
        else { throw BookError.malformed("EPUB container does not reference a package document") }

        let opfPath = BookPath.normalize(opfPathRaw)
        guard let opfData = zip.read(opfPath), let opf = ContentSanitizer.parseDocument(opfData) else {
            throw BookError.malformed("EPUB package document is missing or unreadable")
        }

        var manifest: [String: ManifestItem] = [:]
        var order: [String] = []
        if let manifestElement = ContentSanitizer.firstElement(in: opf, named: "manifest") {
            for item in ContentSanitizer.childElements(of: manifestElement, named: "item") {
                guard let id = ContentSanitizer.attribute(item, "id"),
                      let href = ContentSanitizer.attribute(item, "href") else { continue }
                manifest[id] = ManifestItem(
                    href: href,
                    mediaType: ContentSanitizer.attribute(item, "media-type") ?? "",
                    properties: (ContentSanitizer.attribute(item, "properties") ?? "")
                        .split(whereSeparator: \.isWhitespace).map(String.init))
                order.append(id)
            }
        }
        return PackageDocument(opf: opf, opfDir: BookPath.directory(of: opfPath), manifest: manifest, manifestOrder: order)
    }

    // MARK: Full parse

    static func parse(url: URL, token: String) throws -> ReflowableBook {
        let zip = try ZipArchive(url: url)
        try zip.assertReasonable()
        if zip.contains("META-INF/encryption.xml"), hasEncryptedContent(zip) { throw BookError.encrypted }
        let package = try readPackage(zip)
        let opf = package.opf

        var spine: [String] = []
        if let spineElement = ContentSanitizer.firstElement(in: opf, named: "spine") {
            spine = ContentSanitizer.childElements(of: spineElement, named: "itemref")
                .compactMap { ContentSanitizer.attribute($0, "idref") }
        }
        if spine.count > BookLimits.maxSpineItems { throw BookError.malformed("EPUB spine contains too many items") }

        let metadata = ContentSanitizer.firstElement(in: opf, named: "metadata")
        func meta(_ name: String) -> String {
            guard let metadata else { return "" }
            return ContentSanitizer.firstElement(in: metadata, named: name)?.stringValue?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        }
        let title = meta("title").isEmpty ? url.deletingPathExtension().lastPathComponent : meta("title")

        let toc = parseToc(zip, package: package)
        var chapters: [Chapter] = []
        var cssParts: [String] = []
        // Each distinct set of chapter styles gets a class on the chapters that
        // use it, so one page's rules (a cover's `body { text-align: center }`)
        // don't restyle the whole book.
        var styleScopes: [String: String] = [:]
        var stylesheetCache: [String: String] = [:]

        for idref in spine {
            guard let item = package.manifest[idref] else { continue }
            let chapterPath = BookPath.join(package.opfDir, item.href.removingPercentEncoding ?? item.href)
            guard let data = zip.read(chapterPath),
                  let document = ContentSanitizer.parseDocument(data) else { continue }
            let chapterDir = BookPath.directory(of: chapterPath)

            // Collect stylesheets before the head goes away. Only real CSS links:
            // some books link Adobe page templates (XML) with rel="stylesheet".
            var chapterCSS = ""
            for link in ContentSanitizer.elements(in: document, named: "link") {
                let rel = (ContentSanitizer.attribute(link, "rel") ?? "").lowercased()
                guard rel.split(separator: " ").contains("stylesheet"),
                      let href = ContentSanitizer.attribute(link, "href") else { continue }
                let type = (ContentSanitizer.attribute(link, "type") ?? "text/css").lowercased()
                guard type == "text/css" else { continue }
                let cssPath = BookPath.join(chapterDir, BookPath.splitFragment(href).path.removingPercentEncoding ?? href)
                if let cached = stylesheetCache[cssPath] {
                    chapterCSS += cached
                } else if let css = zip.readText(cssPath) {
                    stylesheetCache[cssPath] = css + "\n"
                    chapterCSS += css + "\n"
                }
            }
            for style in ContentSanitizer.elements(in: document, named: "style") {
                chapterCSS += (style.stringValue ?? "") + "\n"
                style.detach()
            }
            for link in ContentSanitizer.elements(in: document, named: "link") { link.detach() }

            ContentSanitizer.sanitize(document)
            ContentSanitizer.filterStyleAttributes(document)
            ContentSanitizer.rewriteImages(document) { source in
                let path = BookPath.join(chapterDir, BookPath.splitFragment(source).path.removingPercentEncoding ?? source)
                return zip.contains(path) ? ResourceURL.make(token: token, path: path) : nil
            }
            let chapterHref = item.href.removingPercentEncoding ?? item.href
            ContentSanitizer.rewriteLinks(document) { href in
                let (path, fragment) = BookPath.splitFragment(href)
                let target: String
                if path.isEmpty {
                    target = chapterHref
                } else {
                    let absolute = BookPath.join(chapterDir, path.removingPercentEncoding ?? path)
                    target = relative(absolute, to: package.opfDir)
                }
                return fragment.map { "\(target)#\($0)" } ?? target
            }

            let (html, text) = ContentSanitizer.bodyHTML(of: document)
            let trimmedCSS = chapterCSS.trimmingCharacters(in: .whitespacesAndNewlines)
            var styleScope = ""
            if !trimmedCSS.isEmpty {
                if let existing = styleScopes[trimmedCSS] {
                    styleScope = existing
                } else {
                    styleScope = "gull-css-\(styleScopes.count)"
                    styleScopes[trimmedCSS] = styleScope
                    // `:where` keeps the book's selectors at their usual specificity.
                    cssParts.append(ContentSanitizer.filterStylesheet(
                        trimmedCSS, scope: ".book-content :where(.\(styleScope))"))
                }
            }
            chapters.append(Chapter(id: idref, href: chapterHref, html: html, text: text, styleScope: styleScope))
        }

        if chapters.isEmpty { throw BookError.malformed("This book has no readable chapters.") }
        return ReflowableBook(
            title: title, language: meta("language"), identifier: meta("identifier"),
            chapters: chapters, css: cssParts.joined(separator: "\n"), toc: toc,
            resources: ZipResources(zip: zip))
    }

    /// Encrypted or obfuscated fonts are harmless (the reader drops book fonts),
    /// but encrypted chapters or images mean DRM.
    private static func hasEncryptedContent(_ zip: ZipArchive) -> Bool {
        guard let data = zip.read("META-INF/encryption.xml"),
              let document = ContentSanitizer.parseDocument(data) else { return false }
        let fontExtensions: Set<String> = ["ttf", "otf", "woff", "woff2", "eot"]
        for reference in ContentSanitizer.elements(in: document, named: "cipherreference") {
            let uri = ContentSanitizer.attribute(reference, "URI") ?? ""
            if fontExtensions.contains((uri as NSString).pathExtension.lowercased()) { continue }
            return true
        }
        return false
    }

    static func relative(_ path: String, to base: String) -> String {
        guard !base.isEmpty else { return path }
        if path.hasPrefix(base + "/") { return String(path.dropFirst(base.count + 1)) }
        return path
    }

    // MARK: Table of contents

    static func parseToc(_ zip: ZipArchive, package: PackageDocument) -> [TocItem] {
        // EPUB 3: the navigation document.
        if let navItem = package.manifest.values.first(where: { $0.properties.contains("nav") }) {
            let navPath = BookPath.join(package.opfDir, navItem.href.removingPercentEncoding ?? navItem.href)
            if let data = zip.read(navPath), let document = ContentSanitizer.parseDocument(data) {
                let navs = ContentSanitizer.elements(in: document, named: "nav")
                let typed = navs.first { nav in
                    let type = ContentSanitizer.attribute(nav, "epub:type") ?? ContentSanitizer.attribute(nav, "type") ?? ""
                    return type.split(whereSeparator: \.isWhitespace).contains("toc")
                }
                if let nav = typed ?? navs.first, let ol = ContentSanitizer.firstElement(in: nav, named: "ol") {
                    let items = parseNavList(ol, baseDir: BookPath.directory(of: navPath), opfDir: package.opfDir)
                    if !items.isEmpty { return items }
                }
            }
        }

        // EPUB 2: the NCX.
        let spine = ContentSanitizer.firstElement(in: package.opf, named: "spine")
        let tocId = spine.flatMap { ContentSanitizer.attribute($0, "toc") }
        let ncxItem = tocId.flatMap { package.manifest[$0] }
            ?? package.manifest.values.first { $0.mediaType == "application/x-dtbncx+xml" }
        if let ncxItem {
            let ncxPath = BookPath.join(package.opfDir, ncxItem.href.removingPercentEncoding ?? ncxItem.href)
            if let data = zip.read(ncxPath), let document = ContentSanitizer.parseDocument(data),
               let navMap = ContentSanitizer.firstElement(in: document, named: "navmap") {
                return parseNavMap(navMap, baseDir: BookPath.directory(of: ncxPath), opfDir: package.opfDir)
            }
        }
        return []
    }

    /// TOC hrefs are relative to the navigation document; rebase them onto the
    /// package directory so they match `Chapter.href`.
    private static func rebase(_ href: String, baseDir: String, opfDir: String) -> String {
        if ContentSanitizer.scheme(of: href) != nil { return "" }
        let (path, fragment) = BookPath.splitFragment(href)
        let absolute = BookPath.join(baseDir, path.removingPercentEncoding ?? path)
        let rebased = relative(absolute, to: opfDir)
        return fragment.map { "\(rebased)#\($0)" } ?? rebased
    }

    private static func parseNavList(_ ol: XMLElement, baseDir: String, opfDir: String) -> [TocItem] {
        ContentSanitizer.childElements(of: ol, named: "li").compactMap { li in
            let label = ContentSanitizer.childElements(of: li, named: "a").first
                ?? ContentSanitizer.childElements(of: li, named: "span").first
            let title = collapseWhitespace(label?.stringValue ?? "")
            let href = label.flatMap { ContentSanitizer.attribute($0, "href") } ?? ""
            let children = ContentSanitizer.childElements(of: li, named: "ol").first
                .map { parseNavList($0, baseDir: baseDir, opfDir: opfDir) } ?? []
            guard !title.isEmpty else { return nil }
            return TocItem(title: title, href: href.isEmpty ? "" : rebase(href, baseDir: baseDir, opfDir: opfDir),
                           children: children)
        }
    }

    private static func parseNavMap(_ parent: XMLElement, baseDir: String, opfDir: String) -> [TocItem] {
        ContentSanitizer.childElements(of: parent, named: "navpoint").compactMap { point in
            let label = ContentSanitizer.childElements(of: point, named: "navlabel").first
            let title = collapseWhitespace(label.flatMap { ContentSanitizer.firstElement(in: $0, named: "text") }?.stringValue ?? "")
            let src = ContentSanitizer.childElements(of: point, named: "content").first
                .flatMap { ContentSanitizer.attribute($0, "src") } ?? ""
            guard !title.isEmpty else { return nil }
            return TocItem(title: title, href: src.isEmpty ? "" : rebase(src, baseDir: baseDir, opfDir: opfDir),
                           children: parseNavMap(point, baseDir: baseDir, opfDir: opfDir))
        }
    }

    static func collapseWhitespace(_ text: String) -> String {
        text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    // MARK: Cover

    /// Reads only the cover image: EPUB 3 `cover-image`, EPUB 2 `<meta name="cover">`,
    /// a manifest image named "cover", then the guide's cover page.
    static func cover(url: URL) throws -> Data? {
        let zip = try ZipArchive(url: url)
        let package = try readPackage(zip)
        let resolve = { (item: ManifestItem) in BookPath.join(package.opfDir, item.href.removingPercentEncoding ?? item.href) }
        let isImage = { (item: ManifestItem?) -> Bool in
            guard let item else { return false }
            return item.mediaType.hasPrefix("image/")
                || item.href.range(of: #"\.(png|jpe?g|gif|webp|svg)$"#, options: [.regularExpression, .caseInsensitive]) != nil
        }

        var coverPath: String?
        if let item = package.manifest.values.first(where: { $0.properties.contains("cover-image") }) {
            coverPath = resolve(item)
        }
        if coverPath == nil, let metadata = ContentSanitizer.firstElement(in: package.opf, named: "metadata") {
            let metaId = ContentSanitizer.childElements(of: metadata, named: "meta")
                .first { ContentSanitizer.attribute($0, "name") == "cover" }
                .flatMap { ContentSanitizer.attribute($0, "content") }
            if let metaId, isImage(package.manifest[metaId]) { coverPath = resolve(package.manifest[metaId]!) }
        }
        if coverPath == nil {
            for id in package.manifestOrder {
                guard let item = package.manifest[id], isImage(item) else { continue }
                if id.range(of: "cover", options: .caseInsensitive) != nil
                    || item.href.range(of: "cover", options: .caseInsensitive) != nil {
                    coverPath = resolve(item); break
                }
            }
        }
        if coverPath == nil, let guide = ContentSanitizer.firstElement(in: package.opf, named: "guide") {
            let href = ContentSanitizer.childElements(of: guide, named: "reference")
                .first { ContentSanitizer.attribute($0, "type") == "cover" }
                .flatMap { ContentSanitizer.attribute($0, "href") }
            if let href {
                let pagePath = BookPath.join(package.opfDir, BookPath.splitFragment(href).path)
                if let data = zip.read(pagePath), let document = ContentSanitizer.parseDocument(data) {
                    let image = ContentSanitizer.firstElement(in: document, named: "img").flatMap { ContentSanitizer.attribute($0, "src") }
                        ?? ContentSanitizer.firstElement(in: document, named: "image").flatMap {
                            ContentSanitizer.attribute($0, "xlink:href") ?? ContentSanitizer.attribute($0, "href")
                        }
                    if let image, !image.hasPrefix("data:") {
                        coverPath = BookPath.join(BookPath.directory(of: pagePath), BookPath.splitFragment(image).path)
                    }
                }
            }
        }
        guard let coverPath else { return nil }
        return zip.read(coverPath, maxSize: BookLimits.maxCoverSize)
    }
}
