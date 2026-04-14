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
- `styles/main-area.css` — content area, chapter rendering
- `styles/sidebar-right.css` — TOC / search / highlights panel
- `styles/resize.css` — resize handles
- `src/reader/App.css` — imports all of the above (single entry)
- `src/reader/fonts.css` — `@fontsource` declarations (Inter, Open Sans, Geist Mono) + bundled Charter
- Tailwind v4 is enabled via `@tailwindcss/vite` but the reader chrome is almost entirely hand-written CSS; Tailwind is available for new components.

## Theme

`theme` is one of `light` | `dark`, persisted in `settings.json`. `applyTheme` toggles a class on `document.documentElement` (see `reader-runtime.js`). Main broadcasts `theme-changed` on every `set-setting` with key `theme` so other windows (if any) stay in sync.

## Reading style controls

State in `reader-runtime.js`:

```js
const readingStyle = { font, fontSize, lineHeight, paraSpacing };
const FONT_SIZE_STEPS   = [12,13,14,15,16,17,18,19,20,22,24];
const LINE_HEIGHT_STEPS = [1.2,1.4,1.6,1.8,2.0,2.2,2.4];
const PARA_SPACING_STEPS= [0,0.3,0.6,1.0,1.5,2.0];
```

`applyReadingStyle` writes CSS variables on `#content-area`; `saveReadingStyle` persists via `window.settings.set('readingStyle', …)`. The stepper UI in `reader-main.jsx` dispatches via `data-step` and `data-dir` attributes handled at the module level.

## Why so much book CSS is stripped

See `epub-parsing.md` — `font-family`, sizes, line heights, colors, and positioning are removed from book CSS so the reader's own typography wins. Drop-cap selectors (`.dropcap`, `.drop-cap`) are the only carve-out; they keep their `font-size` and `line-height`. If you need to respect more book styles, adjust `STRIP_CSS_PROPS` in `main.js` — not CSS in this directory.
