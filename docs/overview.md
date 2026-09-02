---
summary: "High-level overview of Gull: what it is, its tech stack, and top-level layout."
read_when:
  - First time working in this repository
  - Deciding which subsystem owns a feature or bug
  - Onboarding a new contributor
title: "Project Overview"
---

Gull is a minimalist, macOS-first EPUB reader built on Electron. It requires **macOS 12.0 (Monterey) or later** and runs exclusively on **Apple Silicon**. It parses `.epub` files in the main process and reflows chapter content in a React + Vite renderer using its own typography controls instead of book-defined styles. PDFs are also supported, but they are fixed-layout: the renderer paints their pages with pdf.js instead of reflowing them (see `pdf-rendering.md`).

## Stack

- **Shell**: Electron 41 (`main.js`, `preload.js`)
- **Renderer**: React 19 + Vite 8, entry `src/reader-main.jsx`
- **Runtime logic**: Vanilla JS module `src/reader-runtime.js` that drives the DOM rendered by React (the React tree is essentially a static skeleton; imperative code attaches behavior by element id).
- **Styling**: Tailwind CSS v4 + hand-written CSS in `styles/*.css`, imported through `src/reader/App.css`
- **EPUB parsing**: `adm-zip` (ZIP reads) + `cheerio` (XHTML/XML), executed in a Node worker so large books do not block the Electron main thread
- **PDF rendering**: `pdfjs-dist` in the renderer, loaded on demand the first time a PDF is opened
- **Distribution**: `electron-builder` (mac DMG + ZIP), `electron-updater` against GitHub releases

## Top-level layout

```
main.js              Electron main process: windows, validated IPC, settings, book folders, auto-update
preload.js           contextBridge exposing `window.epub`, `window.settings`, `window.updater`
lib/                 Publication sanitizing plus the EPUB parser and its worker entry
src/
  reader-main.jsx    React skeleton (DOM + ids only)
  reader-runtime.js  All renderer behavior: tabs, TOC, search, highlights, scrollbar, styles
  pdf-book.js        pdf.js glue: opens a PDF and renders its pages into the reader
  reader/            CSS imports, fonts
  components/ui/     (empty shell for shadcn-style components)
styles/              Hand-written CSS (main, main-area, sidebar-right, resize)
scripts/             CHANGELOG generator
build/               Mac entitlements
```

## Key flows to know

- File open: Finder / CLI / `File > Open` → `main.js` `openFileInApp` → a standalone reader window receives IPC `open-file`; the file is not added to the library sidebar.
- Book folders: sidebar **Add Book Folder** → IPC `select-book-folder` → main walks the directory into a book tree → renderer renders it as nested, collapsible sidebar folders.
- Chapter render: renderer calls `window.epub.parse(filePath)` → main validates the request → the EPUB worker returns `{title, chapters, toc}` with sanitized markup, inline base64 images, and filtered CSS.
- PDF render: the renderer asks main for the file's bytes (`read-book-file`) and hands them to pdf.js, which produces the same `{title, chapters, toc}` shape with one chapter per page.
- Settings: `window.settings.get/set` persist to `<userData>/settings.json` and broadcast via `settings-changed`.

See `architecture.md`, `epub-parsing.md`, `pdf-rendering.md`, and `reader-runtime.md` for details.
