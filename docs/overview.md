---
summary: "High-level overview of Gull: what it is, its tech stack, and top-level layout."
read_when:
  - First time working in this repository
  - Deciding which subsystem owns a feature or bug
  - Onboarding a new contributor
title: "Project Overview"
---

Gull is a minimalist, macOS-first EPUB reader built on Electron. It parses `.epub` files in the main process and reflows chapter content in a React + Vite renderer using its own typography controls instead of book-defined styles.

## Stack

- **Shell**: Electron 41 (`main.js`, `preload.js`)
- **Renderer**: React 19 + Vite 8, entry `src/reader-main.jsx`
- **Runtime logic**: Vanilla JS module `src/reader-runtime.js` that drives the DOM rendered by React (the React tree is essentially a static skeleton; imperative code attaches behavior by element id).
- **Styling**: Tailwind CSS v4 + hand-written CSS in `styles/*.css`, imported through `src/reader/App.css`
- **EPUB parsing**: `adm-zip` (ZIP reads) + `cheerio` (XHTML/XML)
- **Distribution**: `electron-builder` (mac DMG + ZIP), `electron-updater` against GitHub releases

## Top-level layout

```
main.js              Electron main process: windows, IPC, EPUB parsing, auto-update
preload.js           contextBridge exposing `window.epub`, `window.settings`, `window.updater`
src/
  reader-main.jsx    React skeleton (DOM + ids only)
  reader-runtime.js  All renderer behavior: tabs, TOC, search, highlights, scrollbar, styles
  reader/            CSS imports, fonts
  components/ui/     (empty shell for shadcn-style components)
styles/              Hand-written CSS (main, main-area, sidebar-right, resize)
scripts/             CHANGELOG generator
build/               Mac entitlements
```

## Key flows to know

- File open: Finder / drag-drop / CLI → `main.js` `openFileInApp` → IPC `open-file` → renderer opens a tab.
- Chapter render: renderer calls `window.epub.parse(filePath)` → main parses EPUB → returns `{title, chapters, toc}` with inline base64 images and filtered CSS.
- Settings: `window.settings.get/set` persist to `<userData>/settings.json` and broadcast via `settings-changed`.

See `architecture.md`, `epub-parsing.md`, and `reader-runtime.md` for details.
