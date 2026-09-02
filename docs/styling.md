---
summary: "Where styles live, how book CSS interacts with app CSS, and how the reading-style controls work."
read_when:
  - Tweaking layout, theme colors, or typography defaults
  - A book's styles are leaking through and overriding the reader
  - Adding a new theme or font option
title: "Styling & Theming"
---

## Source layout

- `styles/main.css` — base variables, typography defaults, theme tokens
- `styles/main-area.css` — books sidebar (folders, book rows, context menu), content area, chapter rendering
- `styles/sidebar-right.css` — TOC / search / highlights panel
- `styles/resize.css` — resize handles
- `styles/pdf.css` — PDF page boxes and the pdf.js text layer
- `src/reader/App.css` — imports all of the above (single entry)
- `src/reader/fonts.css` — `@fontsource` declarations (Inter, Open Sans, Geist Mono) + bundled Charter
- Tailwind v4 is enabled via `@tailwindcss/vite` but the reader chrome is almost entirely hand-written CSS; Tailwind is available for new components.

## Theme

The reader always follows the operating system's current appearance. `applySystemTheme` resolves `prefers-color-scheme` onto `document.documentElement`, and the renderer listens for appearance changes so every open window updates immediately. Theme is not a user setting.

## Reading style controls

State in `reader-runtime.js`:

```js
const readingStyle = { font, fontSize, lineHeight, paraSpacing };
const FONT_SIZE_STEPS   = [12,13,14,15,16,17,18,19,20,22,24];
const LINE_HEIGHT_STEPS = [1.2,1.4,1.6,1.8,2.0,2.2,2.4];
const PARA_SPACING_STEPS= [0,0.3,0.6,1.0,1.5,2.0];
```

The saved style is synchronously written to root CSS variables by `reader-main.jsx`, then mirrored by `applyReadingStyle` in the runtime. Before restoring a book, `ensureReadingFontsLoaded` awaits the selected regular, semibold, bold, and italic font faces so the first visible layout uses final font metrics. The top-right `SettingsMenu.jsx` owns subsequent updates and persists them in `gull-reading-style` local storage. It also contains the chapter-scrollbar and full-width layout toggles.

While a PDF is open the menu replaces all four typography controls with **Page Zoom** — a fixed-layout page has no font or line height to set. See `pdf-rendering.md`.

## PDF pages

`.book-content.pdf-book` is a centered column of fixed-size page boxes rather
than a text column, and it is excluded from the reader's `font-family`,
`color`, and `word-wrap` overrides: pdf.js positions every text-layer span with
its own inline font metrics, which those rules would flatten. Keep new
`.book-content *` rules scoped with `:not(.pdf-book)`.

## Why so much book CSS is stripped

See `epub-parsing.md` — `font-family`, sizes, line heights, colors, and positioning are removed from book CSS so the reader's own typography wins. Drop-cap selectors (`.dropcap`, `.drop-cap`) are the only carve-out; they keep their `font-size` and `line-height`. If you need to respect more book styles, adjust `STRIP_CSS_PROPS` in `lib/book-content.js` — not CSS in this directory.
