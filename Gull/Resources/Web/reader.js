// Gull's in-page reader runtime. It renders one reflowable book into the page
// and reports layout, scroll, selection, and link events to the native app,
// which owns every piece of UI around the text. Ported from the Electron
// renderer's src/reader-runtime.js.
'use strict';

(() => {
  const content = document.getElementById('content');
  const bookStyle = document.getElementById('book-style');
  const root = document.documentElement;

  const HIGHLIGHT_CONTEXT_LENGTH = 32;
  const RESTORE_SETTLE_MS = 2500;

  let chapters = [];       // [{ id, href }]
  let tocHrefs = [];       // TOC hrefs, in the native app's flattened TOC order
  let highlights = [];     // this book's highlights
  let searchTerms = [];
  let generation = 0;
  let ready = false;
  let restoreAnchor = null; // { section, ratio } held while late images settle
  let restoreUntil = 0;

  const post = (message) => {
    try { window.webkit.messageHandlers.gull.postMessage(message); } catch (_) { /* not hosted */ }
  };

  window.addEventListener('error', (event) => post({ type: 'error', message: `${event.message} @${event.lineno}` }));
  window.addEventListener('unhandledrejection', (event) => post({ type: 'error', message: String(event.reason && event.reason.stack || event.reason) }));

  // --- Small helpers -------------------------------------------------------

  const docTop = (el) => el.getBoundingClientRect().top + window.scrollY;
  const maxScroll = () => Math.max(0, root.scrollHeight - window.innerHeight);
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
    bookStyle.textContent = '';
    root.classList.add('instant');
    window.scrollTo(0, 0);

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
    tocHrefs = data.tocHrefs || [];
    bookStyle.textContent = data.css || '';
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
          section.id = 'chapter-' + chapter.id;
          section.innerHTML = chapter.html;
          prepareChapter(section);
          applyHighlightsToChapter(chapter.id, section);
          content.appendChild(section);
          if (index < data.chapters.length - 1) content.appendChild(document.createElement('hr'));
          index++;
        }
        if (index < data.chapters.length) requestAnimationFrame(batch);
        else resolve();
      };
      requestAnimationFrame(batch);
    });
    if (current !== generation) return;

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

  /** The chapter at the top of the viewport and how far into it we are. */
  function currentAnchor() {
    const sections = content.children;
    // Section offsets are relative to the (positioned) content column.
    const top = window.scrollY - content.offsetTop;
    let lo = 0;
    let hi = sections.length - 1;
    let found = null;
    // Binary search over chapter sections (hr separators are skipped).
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      let el = sections[mid];
      if (el.tagName !== 'SECTION') el = sections[mid - 1] || sections[mid + 1];
      if (!el) break;
      const elTop = el.offsetTop;
      if (elTop <= top) { found = el; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (!found || found.tagName !== 'SECTION') found = content.querySelector('section.gull-chapter');
    if (!found) return null;
    const height = found.offsetHeight || 1;
    return { section: found, ratio: Math.max(0, Math.min(1, (top - found.offsetTop) / height)) };
  }

  function applyAnchor(anchor) {
    if (!anchor || !anchor.section.isConnected) return;
    window.scrollTo(0, content.offsetTop + anchor.section.offsetTop + anchor.section.offsetHeight * anchor.ratio);
  }

  function restorePosition(position) {
    restoreAnchor = null;
    if (!position) return;
    if (position.chapterId) {
      const section = sectionFor(position.chapterId);
      if (section) {
        restoreAnchor = { section, ratio: position.ratio || 0 };
        restoreUntil = performance.now() + RESTORE_SETTLE_MS;
        applyAnchor(restoreAnchor);
        return;
      }
    }
    if (typeof position.progress === 'number') window.scrollTo(0, maxScroll() * position.progress);
  }

  // Images above the restored position load after the first scroll; keep the
  // reader pinned to the same text until the user scrolls on their own.
  const stopRestoring = () => { restoreAnchor = null; };
  window.addEventListener('wheel', stopRestoring, { passive: true });
  window.addEventListener('keydown', stopRestoring);
  window.addEventListener('mousedown', stopRestoring);

  // --- Layout and scroll reports ------------------------------------------

  let layoutTimer = null;
  function layoutChanged() {
    if (restoreAnchor && performance.now() < restoreUntil) applyAnchor(restoreAnchor);
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
      if (resolved) targets.push({ index, top: docTop(resolved.element) });
    });
    const chapterTops = [];
    for (const section of content.querySelectorAll('section.gull-chapter')) {
      chapterTops.push({ id: chapterIdOf(section), top: section.offsetTop + content.offsetTop });
    }
    post({
      type: 'layout',
      height: root.scrollHeight,
      viewport: window.innerHeight,
      targets,
      chapters: chapterTops,
    });
  }

  let scrollFrame = null;
  function reportScroll() {
    if (!ready) return;
    const anchor = currentAnchor();
    const max = maxScroll();
    post({
      type: 'scroll',
      top: window.scrollY,
      height: root.scrollHeight,
      viewport: window.innerHeight,
      progress: max > 0 ? window.scrollY / max : 0,
      chapterId: anchor ? chapterIdOf(anchor.section) : null,
      ratio: anchor ? anchor.ratio : 0,
    });
  }

  window.addEventListener('scroll', () => {
    if (scrollFrame !== null) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = null;
      reportScroll();
    });
  }, { passive: true });

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
  }

  /** Restyles without losing the reader's place. */
  async function setStyle(style) {
    const anchor = ready ? currentAnchor() : null;
    applyStyle(style);
    if (!ready) return;
    await waitForFonts();
    applyAnchor(anchor);
    layoutChanged();
  }

  function setScrollbarHidden(hidden) {
    root.classList.toggle('hide-scrollbar', !!hidden);
  }

  // --- Navigation ------------------------------------------------------------

  function scrollToHref(href, fallbackChapterId) {
    restoreAnchor = null;
    const resolved = resolveHref(href, fallbackChapterId);
    if (!resolved) return false;
    resolved.element.scrollIntoView({ behavior: 'instant', block: 'start' });
    return true;
  }

  function scrollToOffset(top) {
    restoreAnchor = null;
    window.scrollTo(0, Math.max(0, Math.min(maxScroll(), top)));
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

  window.addEventListener('scroll', () => post({ type: 'dismissFootnote' }), { passive: true });

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
    if (target) target.scrollIntoView({ behavior: 'instant', block: 'center' });
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
    mark.scrollIntoView({ behavior: 'instant', block: 'center' });
    const marks = content.querySelectorAll(`mark.reader-highlight[data-highlight-id="${CSS.escape(id)}"]`);
    marks.forEach(m => m.classList.add('flash'));
    setTimeout(() => marks.forEach(m => m.classList.remove('flash')), 500);
  }

  // --- Highlight context menu ------------------------------------------------
  // Tells the native side which highlight (if any) a right-click landed on, so the
  // context menu can offer "Remove Highlight". Sent before the menu opens.

  document.addEventListener('contextmenu', (event) => {
    const mark = event.target.closest ? event.target.closest('mark.reader-highlight') : null;
    post({ type: 'contextHighlight', id: mark ? mark.dataset.highlightId : null });
  });

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
    clearSelection: () => window.getSelection().removeAllRanges(),
  };

  post({ type: 'ready' });
})();
