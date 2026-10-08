# Gull (native)

A native macOS rewrite of [Gull](../gull), the typography-first e-book reader, in Swift with AppKit and SwiftUI. Requires **macOS 26** on Apple Silicon.

It reads DRM-free EPUB, MOBI / AZW3 / AZW / PRC (Kindle KF8 and legacy Mobipocket), and PDF, with the same features as the Electron app: library folders from disk (live-updated), pinned and finished books, cover thumbnails, table of contents, the segmented chapter scrollbar, in-book search, persistent highlights, footnote popovers, reading-style controls (font, size, line height, paragraph spacing, full width), PDF zoom, standalone book windows from Finder, and light/dark appearance.

## Build

```bash
xcodegen generate            # project.yml → Gull.xcodeproj
xcodebuild -scheme Gull build
xcodebuild -scheme Gull test
```

## Releases and auto-update

Gull updates itself with [Sparkle](https://sparkle-project.org). It checks at launch and every 6 hours, downloads in the background, and installs on quit; once an update is ready, a **Restart to Update** button appears in the toolbar. **Gull › Check for Updates…** checks on demand.

The feed is `https://github.com/limboy/gull/releases/latest/download/appcast.xml`, so every GitHub release carries the appcast alongside the app.

One-time setup: create Sparkle's signing key (stored in your login Keychain, so back it up):

```bash
build/release/DerivedData/SourcePackages/artifacts/sparkle/Sparkle/bin/generate_keys
```

(Run `xcodebuild -resolvePackageDependencies -derivedDataPath build/release/DerivedData` first if the tool isn't there yet.)

Each release:

```bash
scripts/release.sh 3.0.1 notes.md   # archive, Developer ID sign, notarize, zip, sign appcast
gh release create v3.0.1 dist/Gull-3.0.1.zip dist/appcast.xml --repo limboy/gull --notes-file notes.md
```

The script reads `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` from the environment or `.env`, injects the Keychain key's public half as `SUPublicEDKey`, and uses the commit count as the build number (Sparkle compares `CFBundleVersion`). Builds without a public key — every Debug build and plain local builds — never start the updater.

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

- Updates come through Sparkle instead of electron-updater. Electron releases can't update into the native app on their own; users need to install the first native release by hand.
- Library state, highlights, and positions start fresh — Electron's localStorage is not migrated.
- MOBI6 `filepos` links and TOC entries now resolve (anchors are inserted at their byte offsets).
- Reading positions are saved for standalone book windows too, anchored to a chapter rather than a raw scroll ratio.
