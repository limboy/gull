---
summary: "How `parseEpub` in main.js turns an EPUB file into the `{title, chapters, toc}` payload the renderer consumes — including CSS/image normalization rules."
read_when:
  - A book renders with broken layout, missing images, or wrong colors
  - Adjusting which book styles are respected vs. overridden
  - Adding support for a new EPUB quirk (e.g. NCX-only books, SVG images)
title: "EPUB Parsing & Content Normalization"
---

All EPUB parsing happens synchronously in the main process (`main.js` → `parseEpub`). The renderer never touches the zip; it receives a self-contained payload with inlined images and filtered CSS.

## Pipeline

1. `AdmZip` opens the file; `META-INF/container.xml` yields the OPF path.
2. OPF is parsed with cheerio (`xmlMode: true`) to build:
   - `manifest` — id → `{href, mediaType, properties}`
   - `spine` — ordered list of idrefs
   - `title` from `dc:title`
3. **TOC** (`parseToc`): prefer EPUB 3 nav document (manifest item with `properties` containing `nav`), fall back to EPUB 2 NCX (`application/x-dtbncx+xml`). Shape: `[{ title, href, children }]`.
4. For each spine item: read XHTML, collect CSS, filter styles, inline images, normalize self-closing tags, emit `{ id, href, html, css }`.

## CSS handling — the opinionated part

This reader reflows with its own typography controls, so it intentionally strips properties that would override user settings. The list lives in `STRIP_CSS_PROPS` in `main.js`:

- Typography: `font-family`, `font-size`, `line-height`
- Colors/background: `color`, `background*`, `border-color`
- Positioned layout: `position`, `top/right/bottom/left`, `inset*`, `transform`

Applied in two places:
- `filterEpubCss` — strips from declaration blocks in collected stylesheets and inline `<style>` blocks.
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
  chapters: [{ id, href, html, css }],  // spine order
  toc:      [{ title, href, children }] // nested
}
```

Renderer-side consumers: `renderContent` (inject HTML), `initOutlineScrollTracking`, `indexBookForSearch`, `initChapterScrollbar`.
