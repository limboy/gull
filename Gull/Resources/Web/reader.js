// Gull's in-page reader runtime. It renders one reflowable book into the page
// and reports layout, scroll, selection, and link events to the native app,
// which owns every piece of UI around the text. Ported from the Electron
// renderer's src/reader-runtime.js.
'use strict';

(() => {
  const content = document.getElementById('content');
  const bookStyle = document.getElementById('book-style');
  const root = document.documentElement;
  const pages = document.getElementById('pages');
  const folios = document.getElementById('folios');

  const HIGHLIGHT_CONTEXT_LENGTH = 32;
  const RESTORE_SETTLE_MS = 2500;
  const COLUMN_GAP = 72;          // the gutter between the two pages of a spread
  const MIN_SPREAD_WIDTH = 720;   // narrower than this, a spread shows one page
  const FOLIO_HEIGHT = 56;        // room under the pages for their numbers

  let chapters = [];       // [{ id, href }]
  let tocHrefs = [];       // TOC hrefs, in the native app's flattened TOC order
  let highlights = [];     // this book's highlights
  let searchTerms = [];
  let generation = 0;
  let ready = false;
  let restoreAnchor = null; // { section, ratio } held while late images settle
  let restoreUntil = 0;

  // Paginated mode lays the book out in fixed-height columns, two to a spread,
  // and shows one spread at a time by translating the column strip. Positions
  // are then horizontal offsets into that strip instead of scroll offsets.
  let paginated = false;
  let spread = 0;           // index of the spread showing
  let columnsPerSpread = 2;
  let spreadAnchor = null;  // the text at the start of the spread, kept across relayouts
  let hasGrids = false;      // whether the book's styles use grid or flex layout

  const post = (message) => {
    try { window.webkit.messageHandlers.gull.postMessage(message); } catch (_) { /* not hosted */ }
  };

  window.addEventListener('error', (event) => post({ type: 'error', message: `${event.message} @${event.lineno}` }));
  window.addEventListener('unhandledrejection', (event) => post({ type: 'error', message: String(event.reason && event.reason.stack || event.reason) }));

  // --- Small helpers -------------------------------------------------------

  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sectionFor = (id) => document.getElementById('chapter-' + id);
  const chapterIdOf = (section) => section.id.slice('chapter-'.length);

  function rectOf(r) {
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  /**
   * Finds the chapter whose href best matches a TOC / link href. Multi-book
   * collections reuse file names (cover.xhtml) across directories, so an exact
   * match wins, then an unambiguous suffix or file-name match, then the
   * longest common suffix.
   */
  function findChapterByHref(baseHref) {
    if (!baseHref) return null;
    const exact = chapters.find(c => c.href === baseHref);
    if (exact) return exact;

    const suffix = chapters.filter(c => c.href.endsWith('/' + baseHref) || baseHref.endsWith('/' + c.href));
    if (suffix.length === 1) return suffix[0];

    const file = baseHref.split('/').pop();
    const byName = chapters.filter(c => c.href.split('/').pop() === file);
    if (byName.length === 1) return byName[0];

    const candidates = suffix.length > 0 ? suffix : byName;
    if (candidates.length > 1) {
      let best = candidates[0];
      let bestLength = 0;
      for (const c of candidates) {
        let length = 0;
        for (let i = 1; i <= Math.min(c.href.length, baseHref.length); i++) {
          if (c.href[c.href.length - i] === baseHref[baseHref.length - i]) length++;
          else break;
        }
        if (length > bestLength) { bestLength = length; best = c; }
      }
      return best;
    }
    return candidates[0] || null;
  }

  function findAnchor(scope, fragment) {
    if (!fragment) return null;
    let decoded = fragment;
    try { decoded = decodeURIComponent(fragment); } catch (_) {}
    const value = CSS.escape(decoded);
    return scope.querySelector(`[id="${value}"]`)
      || scope.querySelector(`[name="${value}"]`)
      || scope.querySelector(`[aid="${value}"]`);
  }

  /** Resolves an href to the element it points at. */
  function resolveHref(href, fallbackChapterId) {
    const target = href || '';
    const hash = target.indexOf('#');
    const base = hash === -1 ? target : target.slice(0, hash);
    const fragment = hash === -1 ? null : target.slice(hash + 1);

    let chapter = base ? findChapterByHref(base) : null;
    if (!chapter && fallbackChapterId) chapter = chapters.find(c => c.id === fallbackChapterId) || null;

    if (chapter) {
      const section = sectionFor(chapter.id);
      if (section) return { chapterId: chapter.id, element: findAnchor(section, fragment) || section };
    }
    if (fragment) {
      const element = findAnchor(content, fragment);
      if (element) {
        const section = element.closest('section.gull-chapter');
        return { chapterId: section ? chapterIdOf(section) : null, element };
      }
    }
    return null;
  }

  // --- Loading -------------------------------------------------------------

  async function load(config) {
    const current = ++generation;
    ready = false;
    content.classList.remove('ready');
    content.textContent = '';
    sections = [];
    bookStyle.textContent = '';
    root.classList.add('instant');
    window.scrollTo(0, 0);
    spread = 0;
    spreadAnchor = null;
    content.style.transform = '';

    highlights = config.highlights || [];
    searchTerms = config.searchTerms || [];
    applyStyle(config.style);
    setScrollbarHidden(config.hideScrollbar);

    let data;
    try {
      const response = await fetch(config.contentURL);
      data = await response.json();
    } catch (error) {
      post({ type: 'error', message: String(error) });
      return;
    }
    if (current !== generation) return;

    chapters = data.chapters.map(c => ({ id: c.id, href: c.href }));
    sections = [];
    tocHrefs = data.tocHrefs || [];
    bookStyle.textContent = data.css || '';
    // Scanning every element's style is only worth it when the book uses grids or flex boxes.
    hasGrids = /display\s*:\s*(?:inline-)?(?:grid|flex)/i.test(data.css || '');
    if (data.language) content.setAttribute('lang', data.language);
    else content.removeAttribute('lang');

    await waitForFonts();
    if (current !== generation) return;

    // Insert chapters in frame-sized batches so a 2,000-chapter collection
    // never blocks the page for long.
    let index = 0;
    await new Promise((resolve) => {
      const batch = () => {
        if (current !== generation) return resolve();
        const start = performance.now();
        while (index < data.chapters.length && performance.now() - start < 12) {
          const chapter = data.chapters[index];
          const section = document.createElement('section');
          section.className = 'gull-chapter';
          if (chapter.styleScope) section.classList.add(chapter.styleScope);
          if (chapter.bodyClasses) section.classList.add(...chapter.bodyClasses.split(' '));
          section.id = 'chapter-' + chapter.id;
          section.innerHTML = chapter.html;
          prepareChapter(section);
          applyHighlightsToChapter(chapter.id, section);
          content.appendChild(section);
          sections.push(section);
          if (hasGrids) markGrids(section);
          if (index < data.chapters.length - 1) content.appendChild(document.createElement('hr'));
          index++;
        }
        if (index < data.chapters.length) requestAnimationFrame(batch);
        else resolve();
      };
      requestAnimationFrame(batch);
    });
    if (current !== generation) return;

    layoutPages();
    restorePosition(config.position);
    content.classList.add('ready');
    ready = true;
    requestAnimationFrame(() => root.classList.remove('instant'));
    refreshSearchHighlights();
    reportLayout();
    reportScroll();
    post({ type: 'rendered' });
  }

  async function waitForFonts() {
    if (!document.fonts || !document.fonts.load) return;
    const family = getComputedStyle(root).getPropertyValue('--book-font-family').trim();
    const size = getComputedStyle(root).getPropertyValue('--book-font-size').trim() || '16px';
    const variants = ['', 'italic ', '600 ', '700 ', 'italic 700 '].map(v => `${v}${size} ${family}`);
    try {
      await Promise.race([
        Promise.all(variants.map(f => document.fonts.load(f))),
        new Promise(resolve => setTimeout(resolve, 800)),
      ]);
    } catch (_) {}
  }

  /**
   * Marks grid and flex boxes, which pages lay out as plain blocks: WebKit
   * slices them through a line at a page break instead of breaking between
   * lines. Bilingual editions set every paragraph pair in a grid this way.
   */
  function markGrids(section) {
    for (const el of section.querySelectorAll('*')) {
      const display = getComputedStyle(el).display;
      if (display === 'grid' || display === 'flex') el.classList.add('gull-grid');
    }
  }

  function prepareChapter(section) {
    for (const aside of section.querySelectorAll('aside')) {
      const type = aside.getAttribute('epub:type');
      if (type === 'footnote' || type === 'rearnote' || type === 'endnote') aside.style.display = 'none';
    }
    for (const el of section.querySelectorAll('[style]')) {
      const cls = (el.getAttribute('class') || '').toLowerCase();
      if (cls.includes('dropcap') || cls.includes('drop-cap')) continue;
      if (el.style.fontFamily) el.style.fontFamily = '';
      if (el.style.fontSize) el.style.fontSize = '';
    }
    for (const svgImage of section.querySelectorAll('svg image')) {
      const svg = svgImage.closest('svg');
      if (svg) { svg.style.display = 'block'; svg.style.maxWidth = '100%'; svg.style.height = 'auto'; }
    }
    for (const img of section.querySelectorAll('img')) {
      if (!img.getAttribute('src')) { img.classList.add('image-missing'); continue; }
      img.decoding = 'async';
      if (img.complete && img.naturalWidth > 0) img.classList.add('image-loaded');
    }
  }

  content.addEventListener('load', (event) => {
    if (event.target instanceof HTMLImageElement) {
      event.target.classList.add('image-loaded');
      layoutChanged();
    }
  }, true);

  content.addEventListener('error', (event) => {
    if (event.target instanceof HTMLImageElement) {
      event.target.classList.add('image-missing');
      layoutChanged();
    }
  }, true);

  // --- Position ------------------------------------------------------------
  // Scrolling, a position is a vertical document offset. Paginated, it is a
  // horizontal offset into the strip of columns, where spread k starts at
  // k * spreadWidth().

  let sections = [];       // the chapter sections, in order

  const spreadWidth = () => content.clientWidth + COLUMN_GAP;
  const columnWidth = () => (content.clientWidth - COLUMN_GAP * (columnsPerSpread - 1)) / columnsPerSpread;

  /** How many pages (columns) the book fills. */
  function columnCount() {
    const last = sections[sections.length - 1];
    if (!last) return 1;
    const right = last.getBoundingClientRect().right - content.getBoundingClientRect().left;
    return Math.max(1, Math.ceil((right + COLUMN_GAP / 2) / (columnWidth() + COLUMN_GAP)));
  }

  const spreadCount = () => Math.max(1, Math.ceil(columnCount() / columnsPerSpread));
  const viewPosition = () => paginated ? spread * spreadWidth() : window.scrollY;
  const viewLength = () => paginated ? spreadWidth() : window.innerHeight;
  const documentLength = () => paginated ? spreadCount() * spreadWidth() : root.scrollHeight;
  const maxPosition = () => paginated
    ? (spreadCount() - 1) * spreadWidth()
    : Math.max(0, root.scrollHeight - window.innerHeight);

  /** Where an element starts. */
  function positionOf(el) {
    const rect = el.getBoundingClientRect();
    return paginated ? rect.left - content.getBoundingClientRect().left : rect.top + window.scrollY;
  }

  // A section's start and length. Scrolling uses offsets, which are cheap; a
  // section broken across columns reports the box around all its pieces.
  const sectionStart = (section) => paginated ? positionOf(section) : content.offsetTop + section.offsetTop;
  const sectionLength = (section) => (paginated ? section.getBoundingClientRect().width : section.offsetHeight) || 1;

  /** The chapter at a position and how far into it that is. */
  function anchorAt(position) {
    let lo = 0;
    let hi = sections.length - 1;
    let found = sections[0];
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sectionStart(sections[mid]) <= position) { found = sections[mid]; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (!found) return null;
    return { section: found, ratio: Math.max(0, Math.min(1, (position - sectionStart(found)) / sectionLength(found))) };
  }

  /** The chapter at the top of the viewport (or start of the spread) and how far into it we are. */
  const currentAnchor = () => anchorAt(viewPosition());

  /** The box of a range's first character, or of the element it sits in. */
  function rangeRect(range) {
    const r = range.cloneRange();
    const node = r.startContainer;
    if (r.collapsed && node.nodeType === Node.TEXT_NODE && r.startOffset < node.length) r.setEnd(node, r.startOffset + 1);
    const rect = Array.from(r.getClientRects()).find(b => b.width > 0 || b.height > 0);
    if (rect) return rect;
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return el.getBoundingClientRect();
  }

  /**
   * The first text on the spread showing, so the same words stay on screen as
   * images load, fonts change, or the window resizes. Falls back to the chapter.
   */
  function spreadTextAnchor() {
    const anchor = currentAnchor();
    const box = pages.getBoundingClientRect();
    const bottom = box.top + content.clientHeight;
    for (let y = box.top + 4; y < bottom; y += 12) {
      const caret = document.caretRangeFromPoint(box.left + 2, y);
      if (!caret || caret.startContainer.nodeType !== Node.TEXT_NODE || !content.contains(caret.startContainer)) continue;
      const rect = rangeRect(caret);
      if (rect.left >= box.left - 1 && rect.left < box.right) return { ...anchor, range: caret };
    }
    return anchor;
  }

  /** Shows a position: scrolls to it, or shows the spread it falls on. */
  function show(position) {
    if (paginated) showSpread(Math.floor((position + 1) / spreadWidth()));
    else window.scrollTo(0, position);
  }

  /** Moves the reader to a position at the user's request. */
  function goTo(position) {
    restoreAnchor = null;
    show(position);
    if (paginated) spreadAnchor = spreadTextAnchor();
  }

  /** Brings an element into view, as a link, search result, or highlight jump does. */
  function reveal(element, block) {
    if (!paginated) {
      restoreAnchor = null;
      element.scrollIntoView({ behavior: 'instant', block });
      return;
    }
    goTo(positionOf(element));
  }

  function applyAnchor(anchor) {
    if (!anchor) return;
    if (anchor.range && anchor.range.startContainer.isConnected) {
      const rect = rangeRect(anchor.range);
      show(paginated ? rect.left - content.getBoundingClientRect().left : rect.top + window.scrollY);
      return;
    }
    if (!anchor.section || !anchor.section.isConnected) return;
    show(sectionStart(anchor.section) + sectionLength(anchor.section) * anchor.ratio);
  }

  function restorePosition(position) {
    restoreAnchor = null;
    if (!position) return;
    const section = position.chapterId ? sectionFor(position.chapterId) : null;
    if (section) {
      restoreAnchor = { section, ratio: position.ratio || 0 };
      restoreUntil = performance.now() + RESTORE_SETTLE_MS;
      applyAnchor(restoreAnchor);
    } else if (typeof position.progress === 'number') {
      show(maxPosition() * position.progress);
    }
    // Paginated, the spread's first words hold the place instead.
    if (paginated) {
      restoreAnchor = null;
      spreadAnchor = spreadTextAnchor();
    }
  }

  // Images above the restored position load after the first scroll; keep the
  // reader pinned to the same text until the user scrolls on their own.
  const stopRestoring = () => { restoreAnchor = null; };
  window.addEventListener('wheel', stopRestoring, { passive: true });
  window.addEventListener('keydown', stopRestoring);
  window.addEventListener('mousedown', stopRestoring);

  // --- Pages -------------------------------------------------------------------

  /** Sizes the columns to the window. Paginated mode only. */
  function layoutPages() {
    root.classList.toggle('paginated', paginated);
    if (!paginated) {
      content.style.transform = '';
      return;
    }
    const box = pages.getBoundingClientRect();
    const width = Math.floor(box.width);
    columnsPerSpread = width >= MIN_SPREAD_WIDTH ? 2 : 1;
    root.style.setProperty('--page-width', width + 'px');
    root.style.setProperty('--page-height', Math.max(160, Math.floor(window.innerHeight - box.top - FOLIO_HEIGHT)) + 'px');
    root.style.setProperty('--column-count', String(columnsPerSpread));
    root.style.setProperty('--column-gap', COLUMN_GAP + 'px');
  }

  function showSpread(index) {
    spread = Math.max(0, Math.min(spreadCount() - 1, index));
    content.style.transform = spread > 0 ? `translateX(${-spread * spreadWidth()}px)` : '';
    updateFolios();
    viewMoved();
  }

  function turnPage(delta) {
    goTo((spread + delta) * spreadWidth());
  }

  /** Page numbers under each page of the spread. */
  function updateFolios() {
    if (!paginated) return;
    const [left, right] = folios.children;
    const total = columnCount();
    const first = spread * columnsPerSpread + 1;
    left.textContent = first <= total ? String(first) : '';
    right.textContent = columnsPerSpread > 1 && first + 1 <= total ? String(first + 1) : '';
    folios.classList.toggle('single', columnsPerSpread === 1);
  }

  // Arrow keys, space, Page Up/Down, Home and End turn pages. Shift-arrows are
  // left alone (they extend a selection), as is anything with a modifier.
  document.addEventListener('keydown', (event) => {
    if (!paginated || !ready || event.metaKey || event.ctrlKey || event.altKey) return;
    let target = null;
    switch (event.key) {
      case 'ArrowRight': case 'ArrowDown': case 'PageDown':
        if (!event.shiftKey) target = spread + 1;
        break;
      case 'ArrowLeft': case 'ArrowUp': case 'PageUp':
        if (!event.shiftKey) target = spread - 1;
        break;
      case ' ':
        target = spread + (event.shiftKey ? -1 : 1);
        break;
      case 'Home':
        target = 0;
        break;
      case 'End':
        target = spreadCount() - 1;
        break;
    }
    if (target === null) return;
    event.preventDefault();
    turnPage(target - spread);
  });

  // A swipe or a turn of the wheel turns one page; the rest of the gesture
  // (and its momentum) is ignored until it comes to rest.
  let wheelTotal = 0;
  let wheelSpent = false;
  let wheelTimer = null;
  window.addEventListener('wheel', (event) => {
    if (!paginated) return;
    event.preventDefault();
    if (!ready || event.ctrlKey) return;
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => { wheelTotal = 0; wheelSpent = false; }, 200);
    if (wheelSpent) return;
    wheelTotal += Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (Math.abs(wheelTotal) < 24) return;
    wheelSpent = true;
    turnPage(Math.sign(wheelTotal));
  }, { passive: false });

  // --- Layout and scroll reports ------------------------------------------

  let layoutTimer = null;
  let relayoutFrame = null;
  function layoutChanged() {
    if (paginated) {
      // Coalesced: a book's images can finish loading by the hundred.
      if (relayoutFrame === null) {
        relayoutFrame = requestAnimationFrame(() => {
          relayoutFrame = null;
          if (!paginated) return;
          layoutPages();
          if (spreadAnchor) applyAnchor(spreadAnchor); else showSpread(spread);
        });
      }
    } else if (restoreAnchor && performance.now() < restoreUntil) {
      applyAnchor(restoreAnchor);
    }
    if (layoutTimer) return;
    layoutTimer = setTimeout(() => {
      layoutTimer = null;
      reportLayout();
      reportScroll();
    }, 120);
  }

  function reportLayout() {
    if (!ready) return;
    const targets = [];
    tocHrefs.forEach((href, index) => {
      if (!href) return;
      const resolved = resolveHref(href);
      if (resolved) targets.push({ index, top: positionOf(resolved.element) });
    });
    post({
      type: 'layout',
      height: documentLength(),
      viewport: viewLength(),
      targets,
      chapters: sections.map(section => ({ id: chapterIdOf(section), top: sectionStart(section) })),
    });
  }

  let scrollFrame = null;
  function reportScroll() {
    if (!ready) return;
    const anchor = currentAnchor();
    const top = viewPosition();
    const max = maxPosition();
    post({
      type: 'scroll',
      top,
      height: documentLength(),
      viewport: viewLength(),
      progress: max > 0 ? Math.min(1, top / max) : 0,
      chapterId: anchor ? chapterIdOf(anchor.section) : null,
      ratio: anchor ? anchor.ratio : 0,
    });
  }

  /** The view scrolled or turned a page: report it (once a frame) and close any footnote. */
  function viewMoved() {
    post({ type: 'dismissFootnote' });
    if (scrollFrame !== null) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = null;
      reportScroll();
    });
  }

  window.addEventListener('scroll', viewMoved, { passive: true });

  new ResizeObserver(() => layoutChanged()).observe(content);
  window.addEventListener('resize', () => layoutChanged());

  // --- Style -----------------------------------------------------------------

  function applyStyle(style) {
    if (!style) return;
    root.style.setProperty('--book-font-family', style.fontFamily);
    root.style.setProperty('--book-font-size', style.fontSize + 'px');
    root.style.setProperty('--book-line-height', String(style.lineHeight));
    root.style.setProperty('--book-para-spacing', style.paraSpacing + 'em');
    root.classList.toggle('full-width', !!style.fullWidth);
    paginated = !!style.paginated;
    layoutPages();
    const theme = style.theme;
    if (theme) {
      root.classList.toggle('theme-dark', !!theme.dark);
      root.style.setProperty('--page-bg', theme.background);
      root.style.setProperty('--text-primary', theme.text);
      root.style.setProperty('--text-secondary', theme.secondary);
      root.style.setProperty('--accent', theme.accent);
      root.style.setProperty('--border', theme.border);
    }
  }

  /** Restyles (or switches between scrolling and pages) without losing the reader's place. */
  async function setStyle(style) {
    const anchor = ready ? (paginated && spreadAnchor) || currentAnchor() : null;
    const wasPaginated = paginated;
    applyStyle(style);
    if (!ready) return;
    if (paginated !== wasPaginated) {
      spread = 0;
      spreadAnchor = null;
      window.scrollTo(0, 0);
    }
    await waitForFonts();
    layoutPages();
    applyAnchor(anchor);
    if (paginated) spreadAnchor = spreadTextAnchor();
    updateFolios();
    reportLayout();
    reportScroll();
  }

  function setScrollbarHidden(hidden) {
    root.classList.toggle('hide-scrollbar', !!hidden);
  }

  // --- Navigation ------------------------------------------------------------

  function scrollToHref(href, fallbackChapterId) {
    restoreAnchor = null;
    const resolved = resolveHref(href, fallbackChapterId);
    if (!resolved) return false;
    reveal(resolved.element, 'start');
    return true;
  }

  function scrollToOffset(top) {
    goTo(Math.max(0, Math.min(maxPosition(), top)));
  }

  // --- Links and footnotes ---------------------------------------------------

  content.addEventListener('click', (event) => {
    const link = event.target.closest('a');
    if (!link) return;
    const href = link.getAttribute('href');
    event.preventDefault();
    if (!href) return;

    if (/^(?:https?:|mailto:|tel:)/i.test(href)) {
      post({ type: 'openExternal', url: href });
      return;
    }

    const epubType = link.getAttribute('epub:type') || link.getAttributeNS('http://www.idpf.org/2007/ops', 'type');
    if (epubType === 'noteref') {
      const img = link.querySelector('img.epub-footnote');
      const imageText = img ? (img.getAttribute('zy-footnote') || img.getAttribute('alt') || '').trim() : '';
      const hash = href.indexOf('#');
      const aside = hash !== -1 ? findAnchor(content, href.slice(hash + 1)) : null;
      const text = imageText || (aside ? aside.textContent.trim() : '');
      if (text) {
        const anchor = link.closest('sup') || link;
        post({ type: 'footnote', text, rect: rectOf(anchor.getBoundingClientRect()) });
        return;
      }
    }

    const section = link.closest('section.gull-chapter');
    scrollToHref(href, section ? chapterIdOf(section) : null);
  });

  // --- Search ------------------------------------------------------------------

  function clearSearchHighlights() {
    for (const mark of content.querySelectorAll('mark.search-match')) {
      const parent = mark.parentNode;
      if (!parent) continue;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    }
  }

  function highlightTerms(terms) {
    if (!terms || terms.length === 0) return;
    const pattern = new RegExp(terms.map(escapeRegExp).join('|'), 'ig');
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentNode;
        if (parent && parent.closest && parent.closest('mark.search-match, style')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);

    for (const textNode of nodes) {
      const text = textNode.nodeValue;
      pattern.lastIndex = 0;
      if (!pattern.test(text)) continue;
      pattern.lastIndex = 0;
      const fragment = document.createDocumentFragment();
      let last = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        if (match[0].length === 0) { pattern.lastIndex++; continue; }
        if (match.index > last) fragment.appendChild(document.createTextNode(text.slice(last, match.index)));
        const mark = document.createElement('mark');
        mark.className = 'search-match';
        mark.textContent = match[0];
        fragment.appendChild(mark);
        last = match.index + match[0].length;
      }
      if (last < text.length) fragment.appendChild(document.createTextNode(text.slice(last)));
      textNode.parentNode.replaceChild(fragment, textNode);
    }
  }

  function refreshSearchHighlights() {
    clearSearchHighlights();
    highlightTerms(searchTerms);
  }

  function setSearchTerms(terms) {
    searchTerms = terms || [];
    if (ready) refreshSearchHighlights();
  }

  function jumpToSearchResult(chapterId, href, term, matchIndex) {
    if (!scrollToHref(href, chapterId)) return;
    const section = sectionFor(chapterId);
    if (!section || !term) return;
    const lower = term.toLowerCase();
    const marks = [...section.querySelectorAll('mark.search-match')].filter(m => m.textContent.toLowerCase() === lower);
    const target = marks[matchIndex] || marks[0];
    if (target) reveal(target, 'center');
  }

  // --- Highlights --------------------------------------------------------------

  function resolveHighlightOffsets(text, highlight) {
    const start = Number(highlight.start);
    const end = Number(highlight.end);
    if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start
      && text.slice(start, end) === highlight.text) {
      return { start, end };
    }
    if (!highlight.text) return null;
    let bestStart = -1;
    let bestScore = -Infinity;
    let from = 0;
    while (from <= text.length) {
      const candidate = text.indexOf(highlight.text, from);
      if (candidate === -1) break;
      const candidateEnd = candidate + highlight.text.length;
      let score = 0;
      if (highlight.prefix && text.slice(Math.max(0, candidate - highlight.prefix.length), candidate) === highlight.prefix) score += 2;
      if (highlight.suffix && text.slice(candidateEnd, candidateEnd + highlight.suffix.length) === highlight.suffix) score += 2;
      if (Number.isInteger(start)) score -= Math.abs(candidate - start) / Math.max(text.length, 1);
      if (score > bestScore) { bestScore = score; bestStart = candidate; }
      from = candidate + Math.max(highlight.text.length, 1);
    }
    return bestStart === -1 ? null : { start: bestStart, end: bestStart + highlight.text.length };
  }

  const overlaps = (a, b) => a.chapterId === b.chapterId && a.start <= b.end && a.end >= b.start;

  function applyHighlightsToChapter(chapterId, section) {
    const own = highlights.filter(h => h.chapterId === chapterId);
    if (own.length === 0) return;
    const text = section.textContent;
    const repaired = [];
    for (const h of own) {
      const resolved = resolveHighlightOffsets(text, h);
      if (!resolved) continue;
      if (resolved.start !== h.start || resolved.end !== h.end) {
        h.start = resolved.start;
        h.end = resolved.end;
        h.text = text.slice(h.start, h.end);
        repaired.push(h);
      }
      wrapHighlight(section, h.start, h.end, h.id);
    }
    if (repaired.length > 0) post({ type: 'highlightsRepaired', highlights: repaired });
  }

  function wrapHighlight(container, startOffset, endOffset, id) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let offset = 0;
    const pieces = [];
    let node;
    while ((node = walker.nextNode())) {
      const length = node.textContent.length;
      const nodeEnd = offset + length;
      if (nodeEnd > startOffset && offset < endOffset) {
        pieces.push({ node, start: Math.max(0, startOffset - offset), end: Math.min(length, endOffset - offset) });
      }
      offset = nodeEnd;
      if (offset >= endOffset) break;
    }
    for (let i = pieces.length - 1; i >= 0; i--) {
      const { node: textNode, start, end } = pieces[i];
      try {
        const range = document.createRange();
        range.setStart(textNode, start);
        range.setEnd(textNode, end);
        const mark = document.createElement('mark');
        mark.className = 'reader-highlight';
        mark.dataset.highlightId = id;
        range.surroundContents(mark);
      } catch (_) { /* text node boundaries changed under us */ }
    }
  }

  function unwrapHighlight(id) {
    for (const mark of content.querySelectorAll(`mark.reader-highlight[data-highlight-id="${CSS.escape(id)}"]`)) {
      const parent = mark.parentNode;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    }
  }

  function selectionOffsets(section, range) {
    if (!section.contains(range.startContainer) || !section.contains(range.endContainer)) return null;
    const before = range.cloneRange();
    before.selectNodeContents(section);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length;
    return { start, end: start + range.toString().length };
  }

  function selectedChapterRange() {
    const selection = window.getSelection();
    if (!selection.rangeCount || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    const startEl = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
    const section = startEl && startEl.closest('section.gull-chapter');
    if (!section) return null;
    const offsets = selectionOffsets(section, range);
    if (!offsets || offsets.start === offsets.end) return null;
    return { section, range, offsets };
  }

  /** Highlights the current selection, merging anything it overlaps or touches. */
  function highlightSelection() {
    const selected = selectedChapterRange();
    if (!selected) return;
    const { section, offsets } = selected;
    const chapterId = chapterIdOf(section);
    const candidate = { chapterId, start: offsets.start, end: offsets.end };
    const overlapping = highlights.filter(h => overlaps(h, candidate));

    let start = offsets.start;
    let end = offsets.end;
    let createdAt = Date.now();
    for (const h of overlapping) {
      start = Math.min(start, h.start);
      end = Math.max(end, h.end);
    }
    const removedIds = overlapping.map(h => h.id);
    removedIds.forEach(unwrapHighlight);
    highlights = highlights.filter(h => !removedIds.includes(h.id));

    const text = section.textContent;
    const highlight = {
      id: crypto.randomUUID(),
      chapterId,
      start,
      end,
      text: text.slice(start, end),
      prefix: text.slice(Math.max(0, start - HIGHLIGHT_CONTEXT_LENGTH), start),
      suffix: text.slice(end, end + HIGHLIGHT_CONTEXT_LENGTH),
      createdAt,
    };
    highlights.push(highlight);
    wrapHighlight(section, start, end, highlight.id);
    window.getSelection().removeAllRanges();
    post({ type: 'highlightCreated', highlight, removedIds });
  }

  function removeHighlight(id) {
    highlights = highlights.filter(h => h.id !== id);
    unwrapHighlight(id);
  }

  function jumpToHighlight(id, chapterId) {
    scrollToHref('', chapterId);
    const mark = content.querySelector(`mark.reader-highlight[data-highlight-id="${CSS.escape(id)}"]`);
    if (!mark) return;
    reveal(mark, 'center');
    const marks = content.querySelectorAll(`mark.reader-highlight[data-highlight-id="${CSS.escape(id)}"]`);
    marks.forEach(m => m.classList.add('flash'));
    setTimeout(() => marks.forEach(m => m.classList.remove('flash')), 500);
  }

  // --- Context menu & Look Up -----------------------------------------------
  // Tells the native side which highlight (if any) a right-click landed on and what
  // text is selected, so the context menu can offer "Remove Highlight" and
  // "Search in Book". Sent before the menu opens.

  document.addEventListener('contextmenu', (event) => {
    const mark = event.target.closest ? event.target.closest('mark.reader-highlight') : null;
    const selection = window.getSelection();
    post({
      type: 'contextMenu',
      highlightId: mark ? mark.dataset.highlightId : null,
      text: selection.isCollapsed ? '' : selection.toString(),
    });
  });

  /** The range's text, where its first line sits, and its font, for the native dictionary popover. */
  function describeForLookUp(range) {
    const rect = Array.from(range.getClientRects()).find(r => r.width > 0 && r.height > 0);
    const text = range.toString().trim();
    if (!rect || !text) return null;
    const node = range.startContainer;
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const style = getComputedStyle(el);
    return {
      text,
      x: rect.left,
      bottom: rect.bottom,
      fontFamily: style.fontFamily.split(',')[0].replace(/["']/g, '').trim(),
      fontSize: parseFloat(style.fontSize) || 16,
    };
  }

  function selectionForLookUp() {
    const selection = window.getSelection();
    if (!selection.rangeCount || selection.isCollapsed) return null;
    return describeForLookUp(selection.getRangeAt(0));
  }

  /** What to look up at a viewport point: the selection if the point is on it, else the word there. */
  function lookUpAt(x, y) {
    const selection = window.getSelection();
    if (selection.rangeCount && !selection.isCollapsed) {
      const hit = Array.from(selection.getRangeAt(0).getClientRects())
        .some(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
      if (hit) return selectionForLookUp();
    }
    const caret = document.caretRangeFromPoint(x, y);
    if (!caret || caret.startContainer.nodeType !== Node.TEXT_NODE) return null;
    const node = caret.startContainer;
    const offset = caret.startOffset;
    const segmenter = new Intl.Segmenter(document.documentElement.lang || undefined, { granularity: 'word' });
    for (const segment of segmenter.segment(node.data)) {
      const end = segment.index + segment.segment.length;
      if (offset < segment.index || offset > end || !segment.isWordLike) continue;
      const range = document.createRange();
      range.setStart(node, segment.index);
      range.setEnd(node, end);
      // caretRangeFromPoint snaps to the nearest gap; make sure the point is really on this word.
      const onWord = Array.from(range.getClientRects())
        .some(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
      if (onWord) return describeForLookUp(range);
    }
    return null;
  }

  function hasSelection() {
    return selectedChapterRange() !== null;
  }

  window.Gull = {
    load,
    setStyle,
    setScrollbarHidden,
    scrollToHref,
    scrollToOffset,
    setSearchTerms,
    jumpToSearchResult,
    highlightSelection,
    removeHighlight,
    jumpToHighlight,
    hasSelection,
    selectionForLookUp,
    lookUpAt,
    clearSelection: () => window.getSelection().removeAllRanges(),
  };

  post({ type: 'ready' });
})();
