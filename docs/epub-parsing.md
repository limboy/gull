---
summary: "How the EPUB worker turns a file into the `{title, chapters, toc}` payload the renderer consumes — including sanitizing and CSS/image normalization."
read_when:
  - A book renders with broken layout, missing images, or wrong colors
  - Adjusting which book styles are respected vs. overridden
  - Adding support for a new EPUB quirk (e.g. NCX-only books, SVG images)
title: "EPUB Parsing & Content Normalization"
---

EPUB parsing lives in `lib/epub-parser.js` and runs through `lib/epub-parser-worker.js`, keeping ZIP/XHTML work off the Electron main thread. The renderer never touches the zip; it receives a self-contained payload with inlined images, sanitized markup, and filtered CSS. Main separately creates the small cover thumbnail.

## Pipeline

1. Main validates the absolute path, extension, file type, and 512 MB input limit. The worker checks individual ZIP entries and total expanded size before reading content.
2. `AdmZip` opens the file; `META-INF/container.xml` yields the OPF path.
3. OPF is parsed with cheerio (`xmlMode: true`) to build:
   - `manifest` — id → `{href, mediaType, properties}`
   - `spine` — ordered list of idrefs
   - `title` from `dc:title`
4. **TOC** (`parseToc`): prefer EPUB 3 nav document (manifest item with `properties` containing `nav`), fall back to EPUB 2 NCX (`application/x-dtbncx+xml`). Shape: `[{ title, href, children }]`.
5. For each spine item: sanitize XHTML, collect CSS, filter styles, inline images, normalize self-closing tags, emit `{ id, href, html, css }`.

## Content safety

`lib/book-content.js` removes executable or embedded elements, inline event handlers, `srcdoc`, popup targets, unsafe URL schemes, remote media loads, CSS imports, URL-bearing declarations, and Electron-specific drag regions. This happens before chapter markup is returned to the renderer. The production CSP independently blocks inline scripts, frames, objects, forms, and unexpected network connections.

## CSS handling — the opinionated part

This reader reflows with its own typography controls, so it intentionally strips properties that would override user settings. The list lives in `STRIP_CSS_PROPS` in `lib/book-content.js`:

- Typography: `font-family`, `font-size`, `line-height`
- Colors/background: `color`, `background*`, `border-color`
- Positioned layout: `position`, `top/right/bottom/left`, `inset*`, `transform`

Applied in two places:
- `filterEpubCss` — strips from declaration blocks in collected stylesheets and inline `<style>` blocks, and rejects active URL-bearing CSS.
- `filterInlineStyle` — strips from element `style` attributes.

**Drop caps are a deliberate exception.** When a selector or element class contains `dropcap`/`drop-cap`, `font-size` and `line-height` are preserved so the decorative first-letter style survives.

## Images

`<img>` and SVG `<image>` elements have their `src` / `href` / `xlink:href` resolved against the chapter path, loaded from the zip, base64-encoded, and rewritten as a `data:` URI. MIME is inferred from the extension (`jpg/jpeg/png/gif/webp/svg`). Missing images are silently skipped — the renderer attaches a broken-image fallback (`initBrokenImageHandling` in `reader-runtime.js`).

## XHTML → HTML gotcha

Cheerio's `xmlMode` preserves self-closing tags like `<div/>`. When such markup is later injected via `innerHTML`, non-void elements don't actually self-close and swallow the rest of the chapter. `normalizeXhtmlFragment` rewrites `<tag/>` → `<tag></tag>` for any non-`HTML_VOID_TAGS` element before the payload leaves main. Keep this in mind if you ever bypass `parseEpub`.

## What is returned

```js
{
  title: string,
  identifier: string, // publication identifier when present
  chapters: [{ id, href, html, css }],  // spine order
  toc:      [{ title, href, children }], // nested
  cover:    string // optional base64 JPEG data URI thumbnail
}
```

Renderer-side consumers: `renderContent` (inject HTML), `initOutlineScrollTracking`, `indexBookForSearch`, `initChapterScrollbar`.

## Footnote popovers (duokan / EPUB 3 noteref)

Some EPUBs (e.g. Duokan-produced Chinese books) embed footnotes as `<aside epub:type="footnote">` blocks placed inline before the referencing paragraph, with `<a epub:type="noteref">` links pointing at them. The `<img class="epub-footnote">` inside each noteref link carries the footnote text in its `zy-footnote` and `alt` attributes.

Renderer handling (all in `reader-runtime.js`):
- `hideFootnoteAsides(section)` — called after each chapter is injected; sets `display:none` on any `aside` whose `epub:type` attribute is `footnote`, `rearnote`, or `endnote`, so they don't appear as block content.
- The content-area click handler detects `epub:type="noteref"` links and, instead of scrolling to the aside, calls `showFootnotePopover(text, anchorEl)`.
- `showFootnotePopover` reads the text from `zy-footnote` (or `alt` as fallback, or the aside element as last resort), then positions and shows `#footnote-popover` near the anchor element. Clicking outside dismisses it.
