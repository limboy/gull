import Foundation
import Testing
@testable import Gull

// Ports of the Electron app's book-content, book-order, and highlight tests,
// plus parser round-trips over synthetic books.

@Suite struct ContentSanitizerTests {
    @Test func stripsTypographyButKeepsLayout() {
        let filtered = ContentSanitizer.filterInlineStyle("font-family: Georgia; margin: 1em; color: red; text-indent: 2em")
        #expect(filtered == "margin: 1em; text-indent: 2em")
    }

    @Test func dropCapsKeepMetrics() {
        #expect(ContentSanitizer.filterInlineStyle("font-size: 3em; line-height: 1", preserveMetrics: true)
            == "font-size: 3em; line-height: 1")
    }

    @Test func rejectsActiveCSS() {
        #expect(ContentSanitizer.filterInlineStyle("background-image: url(http://x); margin: 0") == "margin: 0")
        #expect(ContentSanitizer.filterStylesheet("@import url(x.css); p { margin: 0 }").contains("@import") == false)
    }

    @Test func scopesSelectorsIncludingMedia() {
        let css = ContentSanitizer.filterStylesheet("body { margin: 0 } p, li { text-indent: 1em } @media (min-width: 1px) { h1 { margin: 0 } } @font-face { src: x }")
        #expect(css.contains(".book-content { margin: 0; }"))
        #expect(css.contains(".book-content p, .book-content li { text-indent: 1em; }"))
        #expect(css.contains("@media (min-width: 1px) {\n.book-content h1 { margin: 0; }"))
        #expect(!css.contains("font-face"))
    }

    @Test func keepsBodyQualifiersWhenScoping() {
        let css = ContentSanitizer.filterStylesheet(
            "body.Copyright p { border-left: solid 0.2em } html body { margin: 0 }", scope: ".book-content :where(.s)")
        #expect(css.contains(".book-content :where(.s).Copyright p { border-left: solid 0.2em; }"))
        let document = ContentSanitizer.parseDocument(
            Data(#"<html><body class="Copyright  gull-x bad\"x"><p>x</p></body></html>"#.utf8))!
        #expect(ContentSanitizer.bodyClasses(of: document) == "Copyright")
    }

    @Test func urlSafety() {
        #expect(ContentSanitizer.isSafePublicationURL("chapter.xhtml#x", tag: "a", attribute: "href"))
        #expect(ContentSanitizer.isSafePublicationURL("https://example.com", tag: "a", attribute: "href"))
        #expect(!ContentSanitizer.isSafePublicationURL("javascript:alert(1)", tag: "a", attribute: "href"))
        #expect(!ContentSanitizer.isSafePublicationURL("java\nscript:alert(1)", tag: "a", attribute: "href"))
        #expect(!ContentSanitizer.isSafePublicationURL("//evil.com/x.png", tag: "img", attribute: "src"))
        #expect(!ContentSanitizer.isSafePublicationURL("https://evil.com/x.png", tag: "img", attribute: "src"))
        #expect(ContentSanitizer.isSafePublicationURL("data:image/png;base64,AAAA", tag: "img", attribute: "src"))
        #expect(!ContentSanitizer.isSafePublicationURL("data:text/html;base64,AAAA", tag: "img", attribute: "src"))
    }

    @Test func expandsSelfClosingNonVoidTags() {
        #expect(ContentSanitizer.normalizeXHTMLFragment("<div class=\"a\"/><br/><a id=\"x\"/>")
            == "<div class=\"a\"></div><br><a id=\"x\"></a>")
        #expect(ContentSanitizer.normalizeXHTMLFragment("<br class=\"a\"></br>") == "<br class=\"a\">")
    }

    @Test func sanitizeRemovesExecutableContent() throws {
        let html = """
        <html xmlns="http://www.w3.org/1999/xhtml"><body>
        <p onclick="evil()" style="color: red; margin: 0">Hi&nbsp;there</p>
        <script>evil()</script><iframe src="x"></iframe>
        <a href="javascript:evil()" target="_blank">x</a>
        </body></html>
        """
        let document = try #require(ContentSanitizer.parseDocument(Data(html.utf8)))
        ContentSanitizer.sanitize(document)
        ContentSanitizer.filterStyleAttributes(document)
        let (body, text) = ContentSanitizer.bodyHTML(of: document)
        #expect(!body.contains("script"))
        #expect(!body.contains("iframe"))
        #expect(!body.contains("onclick"))
        #expect(!body.contains("javascript"))
        #expect(!body.contains("target"))
        #expect(body.contains("style=\"margin: 0\""))
        #expect(text.contains("Hi\u{00A0}there"))
    }
}

@Suite struct LibraryRulesTests {
    private func book(_ path: String, pinned: Bool = false, folder: String? = nil) -> LibraryBook {
        LibraryBook(filePath: path, title: (path as NSString).lastPathComponent, pinned: pinned, folderPath: folder)
    }

    @Test func pinningMovesToTopAndUnpinningAfterPinnedGroup() {
        var books = [book("/a"), book("/b", pinned: true), book("/c")]
        LibraryRules.togglePin(&books, "/c")
        #expect(books.map(\.filePath) == ["/c", "/b", "/a"])
        LibraryRules.togglePin(&books, "/c")
        #expect(books.map(\.filePath) == ["/b", "/c", "/a"])
    }

    @Test func syncDropsMissingAndAddsNew() {
        var books = [book("/lib/a.epub", folder: "/lib"), book("/lib/sub/b.epub", folder: "/lib/sub"), book("/other/c.epub")]
        let removed = LibraryRules.syncFolderBooks(&books, root: "/lib", scanned: [
            book("/lib/a.epub", folder: "/lib"), book("/lib/d.epub", folder: "/lib"),
        ])
        #expect(removed == ["/lib/sub/b.epub"])
        #expect(Set(books.map(\.filePath)) == ["/lib/a.epub", "/other/c.epub", "/lib/d.epub"])
    }

    @Test func sectionsSortWithFoldersFirst() {
        let folders = [LibraryFolder(path: "/lib", name: "lib", folders: [LibraryFolder(path: "/lib/z", name: "z")])]
        let books = [book("/lib/b.epub", folder: "/lib"), book("/lib/a.epub", folder: "/lib"),
                     book("/lib/z/c.epub", folder: "/lib/z"), book("/p.epub", pinned: true)]
        let sections = LibraryRules.sections(books: books, folders: folders, sort: SortOptions())
        #expect(sections.pinned.map(\.filePath) == ["/p.epub"])
        let ids = sections.folders[0].items.map(\.id)
        #expect(ids == ["folder:/lib/z", "book:/lib/a.epub", "book:/lib/b.epub"])

        let interleaved = LibraryRules.sections(books: books, folders: folders,
                                                sort: SortOptions(key: .name, direction: .desc, foldersFirst: false))
        #expect(interleaved.folders[0].items.map(\.id) == ["folder:/lib/z", "book:/lib/b.epub", "book:/lib/a.epub"])
    }

    @Test func filterKeepsMatchingFileNamesAndExpandsTheirFolders() {
        let folders = [LibraryFolder(path: "/lib", name: "lib", collapsed: true,
                                     folders: [LibraryFolder(path: "/lib/z", name: "z", collapsed: true),
                                               LibraryFolder(path: "/lib/y", name: "y")])]
        let books = [book("/lib/Animal Farm.epub", folder: "/lib"), book("/lib/z/1984.epub", folder: "/lib/z"),
                     book("/lib/y/Dune.epub", folder: "/lib/y"), book("/farm-notes.pdf")]
        let sections = LibraryRules.sections(books: books, folders: folders, sort: SortOptions(), filter: "farm")
        #expect(sections.unfiled.map(\.filePath) == ["/farm-notes.pdf"])
        #expect(sections.folders.count == 1)
        #expect(!sections.folders[0].collapsed)
        #expect(sections.folders[0].items.map(\.id) == ["book:/lib/Animal Farm.epub"])

        let nested = LibraryRules.sections(books: books, folders: folders, sort: SortOptions(), filter: "1984")
        #expect(nested.folders[0].items.map(\.id) == ["folder:/lib/z"])
    }

    @Test func mergeKeepsCollapsedState() {
        let existing = LibraryFolder(path: "/lib", name: "lib", collapsed: true,
                                     folders: [LibraryFolder(path: "/lib/a", name: "a", collapsed: true)])
        let scan = FolderScan(path: "/lib", name: "lib", createdAt: 0,
                              folders: [FolderScan(path: "/lib/a", name: "a", createdAt: 0), FolderScan(path: "/lib/b", name: "b", createdAt: 0)])
        let merged = LibraryRules.mergeFolderTree(existing, scan)
        #expect(merged.collapsed)
        #expect(merged.folders.map(\.collapsed) == [true, false])
    }
}

@Suite struct SearchIndexTests {
    @Test func findsAllTermsAndTitles() {
        let toc = [TocItem(title: "One", href: "c1.xhtml"), TocItem(title: "Two", href: "c2.xhtml#x")]
        let index = SearchIndex(chapters: [
            ("c1", "c1.xhtml", "The quick brown fox", nil),
            ("c1b", "c1b.xhtml", "jumps over the lazy fox", nil),
            ("c2", "c2.xhtml", "nothing   here", nil),
        ], toc: toc)
        let results = index.matches(for: "the FOX")
        #expect(results.map(\.chapterId) == ["c1", "c1b"])
        #expect(results.map(\.title) == ["One", "One"])
        #expect(index.matches(for: "x").isEmpty)
    }
}

@Suite struct ParserTests {
    private func makeEPUB(extra: [(String, String)] = []) throws -> URL {
        let files: [(String, String)] = extra + [
            ("mimetype", "application/epub+zip"),
            ("META-INF/container.xml", """
             <?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
             <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>
             """),
            ("OEBPS/content.opf", """
             <?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">
             <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Test Book</dc:title><dc:identifier>id-1</dc:identifier><dc:language>en</dc:language></metadata>
             <manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
             <item id="cover" href="titlepage.xhtml" media-type="application/xhtml+xml"/>
             <item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/>
             <item id="css" href="style.css" media-type="text/css"/>
             <item id="img" href="images/cover.png" media-type="image/png" properties="cover-image"/></manifest>
             <spine><itemref idref="cover"/><itemref idref="c1"/></spine></package>
             """),
            ("OEBPS/nav.xhtml", """
             <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
             <nav epub:type="toc"><ol><li><a href="text/c1.xhtml#start">Chapter One</a></li></ol></nav></body></html>
             """),
            ("OEBPS/titlepage.xhtml", """
             <html xmlns="http://www.w3.org/1999/xhtml"><head><style>body { text-align: center }</style></head>
             <body><div>Cover</div></body></html>
             """),
            ("OEBPS/style.css", "p { color: red; text-indent: 1em }"),
            ("OEBPS/text/c1.xhtml", """
             <html xmlns="http://www.w3.org/1999/xhtml"><head><link rel="stylesheet" type="text/css" href="../style.css"/></head>
             <body><h1 id="start">One</h1><p>Hello&nbsp;world <img src="../images/cover.png"/></p><div/></body></html>
             """),
            ("OEBPS/images/cover.png", "\u{89}PNG"),
        ]
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for (name, content) in files {
            let url = directory.appendingPathComponent(name)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(content.utf8).write(to: url)
        }
        let output = directory.appendingPathComponent("book.epub")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/zip")
        process.currentDirectoryURL = directory
        process.arguments = ["-q", "-r", output.path, "mimetype", "META-INF", "OEBPS"]
        try process.run()
        process.waitUntilExit()
        return output
    }

    private func encryption(_ uri: String) -> (String, String) {
        ("META-INF/encryption.xml", """
         <encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
         <enc:EncryptedData><enc:CipherData><enc:CipherReference URI="\(uri)"/></enc:CipherData></enc:EncryptedData></encryption>
         """)
    }

    @Test func encryptionOnlyCountsEntriesThatExist() throws {
        // DuoKan lists an encrypted `dkagent.css` that isn't in the archive.
        let missing = try makeEPUB(extra: [encryption("OEBPS/Styles/dkagent.css")])
        #expect(try EPUBParser.parse(url: missing, token: "tok").chapters.count == 2)
        let present = try makeEPUB(extra: [encryption("OEBPS/text/c1.xhtml")])
        #expect(throws: BookError.self) { try EPUBParser.parse(url: present, token: "tok") }
    }

    @Test func parsesEPUB() throws {
        let url = try makeEPUB()
        let book = try EPUBParser.parse(url: url, token: "tok")
        #expect(book.title == "Test Book")
        #expect(book.identifier == "id-1")
        #expect(book.chapters.count == 2)
        #expect(book.chapters[1].href == "text/c1.xhtml")
        #expect(book.toc.first?.title == "Chapter One")
        #expect(book.toc.first?.href == "text/c1.xhtml#start")
        let html = book.chapters[1].html
        #expect(html.contains("gull://app/book/tok/res/OEBPS/images/cover.png"))
        #expect(html.contains("<div></div>"))
        // Each page's styles apply only to the chapters that use them.
        let cover = book.chapters[0].styleScope, chapter = book.chapters[1].styleScope
        #expect(!cover.isEmpty && !chapter.isEmpty && cover != chapter)
        #expect(book.css.contains(".book-content :where(.\(cover)) { text-align: center; }"))
        #expect(book.css.contains(".book-content :where(.\(chapter)) p { text-indent: 1em; }"))
        #expect(book.resources.resource(at: "OEBPS/images/cover.png") != nil)
        #expect(try EPUBParser.cover(url: url) != nil)
    }

    @Test func palmDOCDecompression() {
        // Literal bytes, a back-reference ("abc" repeated), and a space+char pair.
        let compressed: [UInt8] = [0x61, 0x62, 0x63, 0x80, 0x18, 0xE1]
        #expect(MobiFile.decompressPalmDOC(compressed) == Array("abcabc a".utf8))
    }
}
