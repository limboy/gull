# Gull (native)

A native macOS rewrite of [Gull](../gull), the typography-first e-book reader, in Swift with AppKit and SwiftUI. Requires **macOS 26** on Apple Silicon.

It reads DRM-free EPUB, MOBI / AZW3 / AZW / PRC (Kindle KF8 and legacy Mobipocket), and PDF, with the same features as the Electron app: library folders from disk (live-updated), pinned and finished books, cover thumbnails, table of contents, the segmented chapter scrollbar, in-book search, persistent highlights, footnote popovers, reading-style controls (font, size, line height, paragraph spacing, full width), PDF zoom, standalone book windows from Finder, and light/dark appearance.

## Build

```bash
xcodegen generate            # project.yml → Gull.xcodeproj
xcodebuild -scheme Gull build
xcodebuild -scheme Gull test
```

## Architecture

| Area | Electron | Native |
| --- | --- | --- |
| Shell / windows / menus | Electron main process | `App/AppDelegate.swift`, `App/MainMenu.swift` (AppKit lifecycle, `NSHostingController` windows) |
| Library, inspector, settings, popups | React + DOM runtime | SwiftUI (`Views/`), `@Observable` stores (`Model/`) |
| ZIP | `adm-zip` | `Parsing/ZipArchive.swift` (Compression framework) |
| EPUB parse + sanitize | `cheerio` | `Parsing/EPUBParser.swift`, `Parsing/ContentSanitizer.swift` (`XMLDocument`) |
| MOBI / KF8 | `@lingo-reader/mobi-parser` | `Parsing/MOBIParser.swift` (PalmDOC, HUFF/CDIC, INDX, skeleton/fragments) |
| Reflowable rendering | Chromium renderer | `WKWebView` + `Resources/Web/reader.js`, served by the `gull://` scheme handler with a strict CSP and no network |
| PDF | pdf.js + worker + wasm | PDFKit (`Reader/PDFReaderController.swift`) |
| Covers | `nativeImage` + renderer pdf.js | `Model/CoverService.swift` (ImageIO, PDFKit), disk-cached |
| Folder watching | `fs.watch` | FSEvents (`Model/FolderScanner.swift`) |
| Persistence | `settings.json` + localStorage | `UserDefaults` + JSON in `~/Library/Application Support/me.limboy.gull` |

Book markup reaches the web view only after sanitizing (no scripts, handlers, remote URLs, or book typography), images are served from the open book by an unguessable per-load token, and every navigation besides the reader shell is cancelled.

## Differences from the Electron app

- No auto-updater yet (electron-updater has no direct equivalent; Sparkle would be the native choice).
- Library state, highlights, and positions start fresh — Electron's localStorage is not migrated.
- MOBI6 `filepos` links and TOC entries now resolve (anchors are inserted at their byte offsets).
- Reading positions are saved for standalone book windows too, anchored to a chapter rather than a raw scroll ratio.
