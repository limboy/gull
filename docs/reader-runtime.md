---
summary: "Map of `src/reader-runtime.js` — the imperative module that owns all renderer behavior: tabs, content rendering, TOC, search, highlights, scrollbar, and reading-style controls."
read_when:
  - Changing anything that happens after a book is opened
  - Adding a sidebar panel, keyboard shortcut, or persistence key
  - Debugging state desync between tabs, TOC, and the chapter scrollbar
title: "Renderer Runtime Module"
---

`reader-main.jsx` renders a static DOM skeleton (elements identified by id). On mount it dynamically imports `reader-runtime.js`, which does all the real work imperatively. Treat it as the renderer's single controller.

## Central state

```js
const state = {
  openBooks,        // [{ filePath, title, cover, position: { scrollTop, progress } }]
  activeBookPath,
  bookContent,      // filePath -> { chapters, toc }
  bookSearchIndex,  // filePath -> [{ id, href, title, text, textLower }]
  sidebarMode,      // 'toc' | 'search' | 'highlights'
  searchQuery,
  highlights,       // filePath -> [{ id, chapterId, start, end, text, createdAt }]
};
```

Persisted via `window.settings.set`:
- `readerState` — open books + positions + active tab (see `saveReaderState` / `loadReaderState`)
- `highlights` — per-book highlight lists
- `readingStyle` — font/size/line-height/paragraph spacing
- `theme` — via `applyTheme`
- `sidebarStates` — left/right sidebar visibility
- `chapterScrollbar`, `fullWidth` — viewport layout preferences

Persisted via `localStorage`:
- `gull-sidebar-widths` — left/right panel widths (`saveSidebarWidths`)
- `gull-open-books` — open books + positions + active tab (`saveReaderState` / `loadReaderState`)

`loadReaderState` filters out books whose files no longer exist for the current session but never re-writes the pruned list back to `gull-open-books`. Reason: a transient miss (iCloud-evicted files, unmounted drives) would otherwise permanently erase the user's tabs.

On startup, the saved `activeBookPath` is restored when that book is still available. If it is missing, the first available book in the saved tab order becomes active instead.

## Feature map (by function)

| Concern | Key functions |
|---|---|
| Tabs | `openBook`, `closeBook`, `setActiveBook`, `renderTabs` |
| Chapter render | `renderContent`, `stripEpubFonts`, `bindImageFallback` |
| TOC | `renderOutline`, `initOutlineScrollTracking`, `setActiveOutlineItem`, `scrollToHref`, `findChapterByHref` |
| Search | `indexBookForSearch`, `findSearchMatches`, `renderSearchResults`, `highlightTermsInContent`, `clearContentSearchHighlights` |
| Highlights | `addHighlight`, `removeHighlight`, `applyHighlightsToChapter`, `wrapHighlight`, `getSelectionOffsets`, `handleSelectionChange`, `renderHighlights`, `saveHighlights`, `loadHighlights` |
| Chapter scrollbar | `initChapterScrollbar` (segmented bar visualizing book structure) |
| Resize | `initResize`, `setupHandle`, `saveSidebarWidths`, `loadSidebarWidths` |
| Reading style | `loadReadingStyle`, `applyReadingStyle`, `ensureReadingFontsLoaded`, `updateStyleDisplay`, `stepValue`, `FONT_SIZE_STEPS`, `LINE_HEIGHT_STEPS`, `PARA_SPACING_STEPS` |
| Theme | `applyTheme` |
| Update pill | `initUpdatePill` |
| Drag & drop / broken images | `initDragAndDrop`, `initBrokenImageHandling` |
| Bootstrap | `initApp` (bottom of file) |

## Rendering model

Chapters are injected as HTML strings into `#content-area`. Scroll position + progress per book is captured in `state.openBooks[i].position` and restored on tab switch. The chapter scrollbar is redrawn whenever content or viewport changes.

At startup, `reader-main.jsx` synchronously seeds sidebar visibility, sidebar widths, chapter-scrollbar mode, full-width mode, and the saved reading-style CSS variables before creating the layout. When saved books are queued for restoration, the first content placeholder is `Loading…`; the drag-and-drop empty state is rendered only when no books are saved. `initApp` applies the same layout snapshot and awaits the selected reading-font faces before restoring the active book, so its scroll position is measured against the final viewport and final font metrics. The initial book is revealed without the normal content/sidebar transitions; later tab and sidebar interactions retain their transitions.

## Multi-book EPUB collections

`findChapterByHref` resolves TOC hrefs to spine chapters. Multi-book collections (e.g. "Hunger Games 4-Book Collection") reuse filenames like `cover.xhtml` across books in different directories. The helper disambiguates via: exact match → suffix match → filename-only (only when unambiguous) → longest common suffix. Used by `scrollToHref`, `resolveHrefTarget` (inside `initChapterScrollbar`), and `initOutlineScrollTracking`.

## Search

Built on a flat text index per book (chapter id, href, title, normalized text). Query is debounced `SEARCH_DEBOUNCE_MS=100`, min length `SEARCH_MIN_QUERY_LENGTH=2`, capped at `SEARCH_MAX_RESULTS=120`. Matches are highlighted in the sidebar snippet and in the live content via `highlightTermsInContent`; clearing or switching books calls `clearContentSearchHighlights`.

## Highlights

Selection offsets are captured relative to the chapter container (`getSelectionOffsets`) so they survive re-renders. `wrapHighlight` walks text nodes between `startOffset` and `endOffset` and wraps them in `<mark class="reader-highlight">`. Highlights are persisted by `saveHighlights` in the `gull-highlights` local-storage entry.

The selection action popup keeps a live anchor to either the selected `Range` or an existing highlight element. Its fixed viewport position is recalculated when the content area scrolls or resizes, so the action follows the selected text instead of remaining at its original screen coordinates.

## Why imperative?

The DOM structure is stable and defined once by React. Keeping dynamic behavior in plain JS avoids a full React state model for what is largely one long document and a few panels. If you add a feature, follow the existing pattern: grab elements by id at the top of the module, add an `init…` function, and call it from `initApp`.
