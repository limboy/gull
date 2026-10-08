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

Gull updates itself with [Sparkle](https://sparkle-project.org). Release builds check at launch and every 6 hours, download in the background, and install on quit; once an update is ready, a **Restart to Update** button appears in the toolbar. **Gull › Check for Updates…** checks on demand (Debug builds only check from the menu). The feed is the `appcast.xml` attached to the latest [GitHub release](https://github.com/limboy/gull-native/releases/latest).

```bash
scripts/release.sh 3.0.0 notes.md
```

This sets the version, commits it, tags `v3.0.0` (with the notes as its message) and pushes. The Release workflow (`.github/workflows/release.yml`) then builds the app, signs it with the Developer ID, notarizes it, signs the zip for Sparkle, builds a signed and notarized DMG, writes `appcast.xml`, and publishes the GitHub release with all three. Without a notes file, the notes are the commit subjects since the last tag.

The workflow needs these repository secrets: `CSC_LINK` (the Developer ID Application certificate as a base64 `.p12`), `CSC_KEY_PASSWORD` (if the `.p12` has one), `APPLE_API_KEY` (an App Store Connect API key's `.p8` contents), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, and `SPARKLE_PRIVATE_KEY` (from `generate_keys -x`; the same key as Magpie, whose public half is `SUPublicEDKey` in `Gull/Info.plist`).

`LOCAL=1 scripts/release.sh …` builds and publishes from your Mac instead, signing updates with the Sparkle key in your Keychain; set `DEVELOPER_ID` and the `APPLE_API_*` variables to sign and notarize too. `scripts/build-release.sh` alone builds into `dist/` without touching git or GitHub. It builds the committed `Gull.xcodeproj`, so run `xcodegen generate` after editing `project.yml`.

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
