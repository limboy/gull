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
  openBooks,        // [{ filePath, title, position: { scrollTop, progress } }]
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
- `theme` — via `applyTheme` / `loadTheme`

Persisted via `localStorage`:
- `gull-sidebar-widths` — left/right panel widths (`saveSidebarWidths`)
- `gull-open-books` — open books + positions + active tab (`saveReaderState` / `loadReaderState`)

`loadReaderState` filters out books whose files no longer exist for the current session but never re-writes the pruned list back to `gull-open-books`. Reason: a transient miss (iCloud-evicted files, unmounted drives) would otherwise permanently erase the user's tabs.

## Feature map (by function)

| Concern | Key functions |
|---|---|
| Tabs | `openBook`, `closeBook`, `setActiveBook`, `renderTabs` |
| Chapter render | `renderContent`, `stripEpubFonts`, `bindImageFallback` |
| TOC | `renderOutline`, `initOutlineScrollTracking`, `setActiveOutlineItem`, `scrollToHref` |
| Search | `indexBookForSearch`, `findSearchMatches`, `renderSearchResults`, `highlightTermsInContent`, `clearContentSearchHighlights` |
| Highlights | `addHighlight`, `removeHighlight`, `applyHighlightsToChapter`, `wrapHighlight`, `getSelectionOffsets`, `handleSelectionChange`, `renderHighlights`, `saveHighlights`, `loadHighlights` |
| Chapter scrollbar | `initChapterScrollbar` (segmented bar visualizing book structure) |
| Resize | `initResize`, `setupHandle`, `saveSidebarWidths`, `loadSidebarWidths` |
| Reading style | `loadReadingStyle`, `applyReadingStyle`, `updateStyleDisplay`, `stepValue`, `FONT_SIZE_STEPS`, `LINE_HEIGHT_STEPS`, `PARA_SPACING_STEPS` |
| Theme | `applyTheme`, `loadTheme` |
| Update pill | `initUpdatePill` |
| Drag & drop / broken images | `initDragAndDrop`, `initBrokenImageHandling` |
| Bootstrap | `initApp` (bottom of file) |

## Rendering model

Chapters are injected as HTML strings into `#content-area`. Scroll position + progress per book is captured in `state.openBooks[i].position` and restored on tab switch. The chapter scrollbar is redrawn whenever content or viewport changes.

## Search

Built on a flat text index per book (chapter id, href, title, normalized text). Query is debounced `SEARCH_DEBOUNCE_MS=100`, min length `SEARCH_MIN_QUERY_LENGTH=2`, capped at `SEARCH_MAX_RESULTS=120`. Matches are highlighted in the sidebar snippet and in the live content via `highlightTermsInContent`; clearing or switching books calls `clearContentSearchHighlights`.

## Highlights

Selection offsets are captured relative to the chapter container (`getSelectionOffsets`) so they survive re-renders. `wrapHighlight` walks text nodes between `startOffset` and `endOffset` and wraps them in `<span class="gull-highlight">`. Persisted through `saveHighlights` → `window.settings.set('highlights', …)`.

## Why imperative?

The DOM structure is stable and defined once by React. Keeping dynamic behavior in plain JS avoids a full React state model for what is largely one long document and a few panels. If you add a feature, follow the existing pattern: grab elements by id at the top of the module, add an `init…` function, and call it from `initApp`.
