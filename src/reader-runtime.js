const state = {
  openBooks: [],       // [{ filePath, title, position: { scrollTop, progress } }]
  activeBookPath: null,
  bookContent: {},     // filePath -> { chapters, toc }
  bookSearchIndex: {}, // filePath -> [{ id, href, title, text, textLower }]
  sidebarMode: 'toc',
  searchQuery: '',
};

const STORAGE_KEY = 'yara-sidebar-widths';
const STORAGE_KEY_BOOKS = 'yara-open-books';

// DOM refs
const appLayout = document.getElementById('app-layout');
const tabBar = document.getElementById('tab-bar-tabs');
const contentArea = document.getElementById('content-area');
const emptyState = document.getElementById('empty-state');
const sidebarTabToc = document.getElementById('sidebar-tab-toc');
const sidebarTabSearch = document.getElementById('sidebar-tab-search');
const sidebarSearchWrap = document.getElementById('sidebar-search-wrap');
const sidebarSearchInput = document.getElementById('sidebar-search-input');
const outlinePanel = document.getElementById('outline-panel');
const searchPanel = document.getElementById('search-panel');

const SEARCH_DEBOUNCE_MS = 100;
const SEARCH_MIN_QUERY_LENGTH = 2;
const SEARCH_MAX_RESULTS = 120;
let sidebarSearchTimer = null;

// --- Book Tab Management ---
function openBook(filePath, title) {
  const existing = state.openBooks.find(b => b.filePath === filePath);
  if (!existing) {
    state.openBooks.push({ filePath, title });
  }
  setActiveBook(filePath);
  renderTabs();
  saveReaderState();
}

function closeBook(filePath) {
  const idx = state.openBooks.findIndex(b => b.filePath === filePath);
  if (idx === -1) return;

  state.openBooks.splice(idx, 1);
  delete state.bookContent[filePath];
  delete state.bookSearchIndex[filePath];

  if (state.activeBookPath === filePath) {
    if (state.openBooks.length > 0) {
      const newIdx = Math.min(idx, state.openBooks.length - 1);
      setActiveBook(state.openBooks[newIdx].filePath);
    } else {
      state.activeBookPath = null;
    }
  }
  renderTabs();
  renderContent();
  saveReaderState();
}

function setActiveBook(filePath) {
  state.activeBookPath = filePath;
  renderTabs();
  renderContent();
  saveReaderState();
}

function renderTabs() {
  tabBar.innerHTML = '';
  state.openBooks.forEach(book => {
    const tab = document.createElement('div');
    tab.className = 'tab-item' + (book.filePath === state.activeBookPath ? ' active' : '');
    tab.dataset.bookPath = book.filePath;
    const safeTitle = escapeHtml(book.title);
    tab.innerHTML = `
      <span class="tab-label">${safeTitle}</span>
      <span class="tab-close" data-close-book="${book.filePath}">
        <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </span>
    `;
    tabBar.appendChild(tab);
  });
}

function setSidebarMode(mode) {
  state.sidebarMode = mode === 'search' ? 'search' : 'toc';

  const isSearch = state.sidebarMode === 'search';
  sidebarTabToc.classList.toggle('active', !isSearch);
  sidebarTabSearch.classList.toggle('active', isSearch);
  sidebarTabToc.setAttribute('aria-selected', String(!isSearch));
  sidebarTabSearch.setAttribute('aria-selected', String(isSearch));

  sidebarSearchWrap.hidden = !isSearch;
  outlinePanel.hidden = isSearch;
  searchPanel.hidden = !isSearch;

  if (isSearch) {
    sidebarSearchInput.focus({ preventScroll: true });
    renderSearchResults();
  }
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildTocTitleMap(items, titleMap = {}) {
  if (!items) return titleMap;
  for (const item of items) {
    const baseHref = (item.href || '').split('#')[0];
    const file = baseHref.split('/').pop();
    if (file && item.title && !titleMap[file]) {
      titleMap[file] = item.title;
    }
    if (item.children) {
      buildTocTitleMap(item.children, titleMap);
    }
  }
  return titleMap;
}

function normalizeText(str) {
  return str.replace(/\s+/g, ' ').trim();
}

function indexBookForSearch(filePath, chapters, toc) {
  const titleMap = buildTocTitleMap(toc);
  const index = [];
  for (const chapter of chapters || []) {
    const section = contentArea.querySelector('#chapter-' + CSS.escape(chapter.id));
    if (!section) continue;
    const text = normalizeText(section.textContent || '');
    if (!text) continue;
    const file = (chapter.href || '').split('/').pop();
    index.push({
      id: chapter.id,
      href: chapter.href || '',
      title: titleMap[file] || chapter.title || file || 'Untitled Chapter',
      text,
      textLower: text.toLowerCase(),
    });
  }
  state.bookSearchIndex[filePath] = index;
}

function buildMatchSnippet(text, start, length = 46) {
  const left = Math.max(0, start - length);
  const right = Math.min(text.length, start + length);
  const prefix = left > 0 ? '…' : '';
  const suffix = right < text.length ? '…' : '';
  return prefix + text.slice(left, right) + suffix;
}

function buildHighlightedSnippet(snippet, terms) {
  let html = escapeHtml(snippet);
  for (const term of terms) {
    if (!term) continue;
    const regex = new RegExp(`(${escapeRegExp(term)})`, 'ig');
    html = html.replace(regex, '<mark>$1</mark>');
  }
  return html;
}

function findSearchMatches(filePath, query) {
  const index = state.bookSearchIndex[filePath] || [];
  const normalized = normalizeText(query).toLowerCase();
  if (normalized.length < SEARCH_MIN_QUERY_LENGTH) return [];

  const terms = normalized.split(' ').filter(Boolean);
  if (terms.length === 0) return [];

  const results = [];
  for (const entry of index) {
    if (!terms.every(term => entry.textLower.includes(term))) continue;

    let from = 0;
    let hits = 0;
    while (results.length < SEARCH_MAX_RESULTS && hits < 3) {
      const hitAt = entry.textLower.indexOf(terms[0], from);
      if (hitAt === -1) break;
      results.push({
        chapterId: entry.id,
        href: entry.href,
        title: entry.title,
        snippet: buildMatchSnippet(entry.text, hitAt),
      });
      from = hitAt + terms[0].length;
      hits += 1;
    }

    if (results.length >= SEARCH_MAX_RESULTS) break;
  }

  return results;
}

function renderSearchResults() {
  searchPanel.innerHTML = '';

  if (!state.activeBookPath) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = 'Open a book to search.';
    searchPanel.appendChild(empty);
    return;
  }

  const query = state.searchQuery || '';
  const normalized = normalizeText(query);
  if (!normalized) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = 'Type to search in the current book.';
    searchPanel.appendChild(empty);
    return;
  }

  if (normalized.length < SEARCH_MIN_QUERY_LENGTH) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = `Enter at least ${SEARCH_MIN_QUERY_LENGTH} characters.`;
    searchPanel.appendChild(empty);
    return;
  }

  const results = findSearchMatches(state.activeBookPath, normalized);
  if (results.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = `No matches for "${normalized}".`;
    searchPanel.appendChild(empty);
    return;
  }

  const terms = normalized.toLowerCase().split(' ').filter(Boolean);
  for (const result of results) {
    const row = document.createElement('div');
    row.className = 'search-result-item';
    row.dataset.chapterId = result.chapterId;
    row.dataset.href = result.href || '';
    row.innerHTML = `
      <div class="search-result-title">${escapeHtml(result.title)}</div>
      <div class="search-result-snippet">${buildHighlightedSnippet(result.snippet, terms)}</div>
    `;
    searchPanel.appendChild(row);
  }
}

function scrollToHref(href, chapters, fallbackChapterId = null) {
  const targetHref = href || '';
  const baseHref = targetHref.split('#')[0];
  const fragment = targetHref.includes('#') ? targetHref.split('#')[1] : null;

  const matchChapter = (chapters || []).find(ch => {
    if (fallbackChapterId && ch.id === fallbackChapterId) return true;
    if (!baseHref) return false;
    if (ch.href === baseHref) return true;
    const chFile = ch.href.split('/').pop();
    const tocFile = baseHref.split('/').pop();
    return chFile === tocFile;
  });

  let scrolled = false;
  if (matchChapter) {
    const section = contentArea.querySelector('#chapter-' + CSS.escape(matchChapter.id));
    if (section) {
      if (fragment) {
        const target = section.querySelector('#' + CSS.escape(fragment));
        if (target) {
          target.scrollIntoView({ behavior: 'instant' });
          scrolled = true;
        }
      }
      if (!scrolled) {
        section.scrollIntoView({ behavior: 'instant' });
        scrolled = true;
      }
    }
  }

  if (!scrolled && fragment) {
    const target = contentArea.querySelector('#' + CSS.escape(fragment));
    if (target) {
      target.scrollIntoView({ behavior: 'instant' });
      scrolled = true;
    }
  }

  return scrolled;
}

async function renderContent() {
  contentArea.querySelectorAll('.book-content').forEach(el => el.remove());

  if (state.activeBookPath) {
    emptyState.style.display = 'none';
    const book = state.openBooks.find(b => b.filePath === state.activeBookPath);
    if (book) {
      // Load content if not cached
      if (!state.bookContent[book.filePath]) {
        const div = document.createElement('div');
        div.className = 'book-content active';
        div.textContent = 'Loading…';
        contentArea.appendChild(div);
        try {
          state.bookContent[book.filePath] = await window.epub.parse(book.filePath);
        } catch (err) {
          div.textContent = 'Failed to load book: ' + err.message;
          return;
        }
        div.remove();
      }

      const data = state.bookContent[book.filePath];
      // Update title from metadata if available
      if (data.title && book.title !== data.title) {
        book.title = data.title;
        renderTabs();
      }

      const div = document.createElement('div');
      div.className = 'book-content active';

      // Collect and deduplicate chapter CSS, scoped to .book-content
      const seenCss = new Set();
      const scopedStyles = [];
      data.chapters.forEach((ch) => {
        if (ch.css && ch.css.trim() && !seenCss.has(ch.css)) {
          seenCss.add(ch.css);
          scopedStyles.push(ch.css);
        }
      });
      if (scopedStyles.length > 0) {
        const styleEl = document.createElement('style');
        // Scope all selectors under .book-content so they don't leak
        const scoped = scopedStyles.join('\n').replace(
          /([^\s@{}][^{}]*?)\{/g,
          (match, selector) => {
            // Don't scope @-rules
            if (selector.trim().startsWith('@')) return match;
            const parts = selector.split(',').map(s =>
              `.book-content ${s.trim()}`
            ).join(', ');
            return `${parts} {`;
          }
        );
        styleEl.textContent = scoped;
        div.appendChild(styleEl);
      }

      data.chapters.forEach((ch, i) => {
        const section = document.createElement('section');
        section.className = 'chapter';
        section.id = 'chapter-' + ch.id;
        section.innerHTML = ch.html;
        stripEpubFonts(section);
        bindImageFallback(section);
        div.appendChild(section);
        if (i < data.chapters.length - 1) {
          div.appendChild(document.createElement('hr'));
        }
      });

      contentArea.appendChild(div);
      renderOutline(data.toc, data.chapters);
      if (!state.bookSearchIndex[book.filePath]) {
        indexBookForSearch(book.filePath, data.chapters, data.toc);
      }
      renderSearchResults();
      initOutlineScrollTracking(data.chapters);
      initChapterScrollbar(data.chapters, data.toc);

      // Restore position
      if (book.position) {
        requestAnimationFrame(() => {
          if (book.position.progress !== undefined) {
            const maxScroll = contentArea.scrollHeight - contentArea.clientHeight;
            contentArea.scrollTop = maxScroll * book.position.progress;
          } else if (book.position.scrollTop !== undefined) {
            contentArea.scrollTop = book.position.scrollTop;
          }
        });
      }
    }
  } else {
    emptyState.style.display = '';
    renderOutline([], []);
    searchPanel.innerHTML = '';
    renderSearchResults();
    initChapterScrollbar([]);
  }
}

function stripEpubFonts(container) {
  // CSS is already filtered in main process; just ensure no font-family leaks through
  container.querySelectorAll('[style]').forEach(el => {
    if (el.style.fontFamily) el.style.fontFamily = '';
  });
}

function bindImageFallback(container) {
  const svgImages = container.querySelectorAll('svg image');
  for (const svgImg of svgImages) {
    const svg = svgImg.closest('svg');
    if (svg) svg.style.display = 'none';
  }

  const imgs = container.querySelectorAll('img');
  for (const img of imgs) {
    const markMissing = () => {
      img.classList.remove('image-loaded');
      img.classList.add('image-missing');
    };
    const markLoaded = () => {
      img.classList.remove('image-missing');
      img.classList.add('image-loaded');
    };

    img.classList.remove('image-loaded');
    img.classList.remove('image-missing');

    img.addEventListener('error', markMissing);
    img.addEventListener('load', markLoaded);

    const src = img.getAttribute('src');
    if (!src) {
      markMissing();
      continue;
    }

    if (img.complete) {
      if (img.naturalWidth > 0) markLoaded();
      else markMissing();
    }
  }
}

// --- Chapter Progress Scrollbar ---
let chapterScrollCleanup = null;

function initChapterScrollbar(chapters, toc) {
  if (chapterScrollCleanup) {
    chapterScrollCleanup();
    chapterScrollCleanup = null;
  }

  const bar = document.getElementById('chapter-scrollbar');
  bar.innerHTML = '';

  if (!chapters || chapters.length === 0) return;

  // Build a chapter-href -> title map from ToC (top-level only)
  const titleMap = {};
  function flattenToc(items) {
    for (const item of items) {
      const baseHref = (item.href || '').split('#')[0];
      const file = baseHref.split('/').pop();
      if (file && !titleMap[file]) titleMap[file] = item.title;
      if (item.children) flattenToc(item.children);
    }
  }
  if (toc) flattenToc(toc);

  function resolveHrefTarget(href) {
    const targetHref = href || '';
    const baseHref = targetHref.split('#')[0];
    const fragment = targetHref.includes('#') ? targetHref.split('#')[1] : null;

    const ch = chapters.find(c => {
      if (!baseHref) return false;
      if (c.href === baseHref) return true;
      return c.href.split('/').pop() === baseHref.split('/').pop();
    });
    if (!ch) return null;

    const section = contentArea.querySelector('#chapter-' + CSS.escape(ch.id));
    if (!section) return null;

    if (fragment) {
      const fragEl = section.querySelector('#' + CSS.escape(fragment));
      if (fragEl) {
        return { chapterId: ch.id, target: fragEl };
      }
    }

    return { chapterId: ch.id, target: section };
  }

  // Build entries from rendered ToC items so indicator count matches visible ToC count.
  const tocEntries = [];
  const outlineItems = document.querySelectorAll('.outline-item');
  for (const item of outlineItems) {
    const href = item.dataset.href || '';
    const resolved = resolveHrefTarget(href);
    if (!resolved) continue;
    tocEntries.push({
      chapterId: resolved.chapterId,
      target: resolved.target,
      title: item.textContent || '',
    });
  }

  // Fallback to chapter-level indicators if no ToC target could be resolved.
  const sourceEntries = tocEntries.length > 0
    ? tocEntries
    : chapters.map(ch => {
      const section = contentArea.querySelector('#chapter-' + CSS.escape(ch.id));
      const chFile = ch.href.split('/').pop();
      return {
        chapterId: ch.id,
        target: section,
        title: titleMap[chFile] || '',
      };
    }).filter(entry => !!entry.target);

  if (sourceEntries.length === 0) return;

  // Build segment elements
  const segments = [];
  for (const entry of sourceEntries) {
    const seg = document.createElement('div');
    seg.className = 'ch-scroll-segment';
    const fill = document.createElement('div');
    fill.className = 'ch-scroll-fill';
    seg.appendChild(fill);
    bar.appendChild(seg);

    segments.push({
      chapterId: entry.chapterId,
      target: entry.target,
      seg,
      fill,
      title: entry.title,
    });
  }

  // Tooltip element
  const tooltip = document.createElement('div');
  tooltip.className = 'ch-scroll-tooltip';
  tooltip.style.display = 'none';
  document.body.appendChild(tooltip);

  function getTargetTopInContent(el) {
    const contentRect = contentArea.getBoundingClientRect();
    const targetRect = el.getBoundingClientRect();
    return targetRect.top - contentRect.top + contentArea.scrollTop;
  }

  function computeMeasures() {
    const measures = [];
    for (const s of segments) {
      if (!s.target) continue;
      measures.push({ ...s, top: getTargetTopInContent(s.target) });
    }
    if (measures.length === 0) return [];

    for (let i = 0; i < measures.length; i++) {
      const start = measures[i].top;
      const end = i < measures.length - 1
        ? measures[i + 1].top
        : contentArea.scrollHeight;
      const height = Math.max(1, end - start);
      measures[i].height = height;
    }
    return measures;
  }

  function update() {
    const scrollTop = contentArea.scrollTop;
    const viewportH = contentArea.clientHeight;
    const barH = bar.clientHeight - (segments.length - 1) * 3 - 16;

    const measures = computeMeasures();
    if (measures.length === 0) return;

    const totalH = measures.reduce((sum, m) => sum + m.height, 0);

    const viewportEnd = scrollTop + viewportH;
    for (const m of measures) {
      const ratio = m.height / totalH;
      const segH = Math.max(8, ratio * barH);
      m.seg.style.height = segH + 'px';

      let fillRatio = 0;
      if (viewportEnd >= m.top + m.height) {
        fillRatio = 1;
      } else if (viewportEnd > m.top) {
        fillRatio = (viewportEnd - m.top) / m.height;
      }

      fillRatio = Math.max(0, Math.min(1, fillRatio));
      m.fill.style.height = (fillRatio * 100) + '%';
    }
  }

  // Hover tooltip
  bar.addEventListener('mousemove', (e) => {
    const target = e.target.closest('.ch-scroll-segment');
    if (!target) { tooltip.style.display = 'none'; return; }

    const seg = segments.find(s => s.seg === target);
    if (!seg || !seg.title) { tooltip.style.display = 'none'; return; }

    tooltip.textContent = seg.title;
    tooltip.style.display = '';
    const barRect = bar.getBoundingClientRect();
    tooltip.style.right = (window.innerWidth - barRect.left + 8) + 'px';
    tooltip.style.top = e.clientY + 'px';
  });

  bar.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none';
  });

  // Click to jump
  bar.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const target = e.target.closest('.ch-scroll-segment');
    if (!target) return;

    const measures = computeMeasures();
    const measure = measures.find(m => m.seg === target);
    if (!measure) return;

    const segRect = target.getBoundingClientRect();
    const within = Math.max(0, Math.min(1, (e.clientY - segRect.top) / segRect.height));
    const desiredTop = measure.top + measure.height * within;
    const maxTop = Math.max(0, contentArea.scrollHeight - contentArea.clientHeight);
    contentArea.scrollTop = Math.max(0, Math.min(maxTop, desiredTop));
  });

  contentArea.addEventListener('scroll', update);
  chapterScrollCleanup = () => {
    contentArea.removeEventListener('scroll', update);
    tooltip.remove();
  };

  requestAnimationFrame(() => requestAnimationFrame(update));
}

function setActiveOutlineItem(el) {
  document.querySelectorAll('.outline-item.active').forEach(item => item.classList.remove('active'));
  if (el) el.classList.add('active');
}

// Track scroll position to highlight current ToC item
let scrollTrackingCleanup = null;

function initOutlineScrollTracking(chapters) {
  // Clean up previous listener
  if (scrollTrackingCleanup) {
    scrollTrackingCleanup();
    scrollTrackingCleanup = null;
  }

  if (!chapters || chapters.length === 0) return;

  // Build a list of { outlineEl, scrollTarget } for each ToC item
  function buildTocTargets() {
    const targets = [];
    const items = document.querySelectorAll('.outline-item');
    for (const item of items) {
      const href = item.dataset.href || '';
      const baseHref = href.split('#')[0];
      const fragment = href.includes('#') ? href.split('#')[1] : null;

      // Find matching chapter
      const ch = chapters.find(c => {
        if (!baseHref) return false;
        if (c.href === baseHref) return true;
        return c.href.split('/').pop() === baseHref.split('/').pop();
      });

      if (ch) {
        const section = contentArea.querySelector('#chapter-' + CSS.escape(ch.id));
        if (section) {
          let target = section;
          if (fragment) {
            const fragEl = section.querySelector('#' + CSS.escape(fragment));
            if (fragEl) target = fragEl;
          }
          targets.push({ el: item, target });
        }
      }
    }
    return targets;
  }

  const onScroll = () => {
    const targets = buildTocTargets();
    if (targets.length === 0) return;

    const scrollTop = contentArea.scrollTop;
    const offset = 60;

    let active = targets[0].el;
    for (const { el, target } of targets) {
      if (target.offsetTop <= scrollTop + offset) {
        active = el;
      }
    }
    setActiveOutlineItem(active);
  };

  contentArea.addEventListener('scroll', onScroll);
  scrollTrackingCleanup = () => contentArea.removeEventListener('scroll', onScroll);

  // Set initial highlight
  onScroll();
}

function renderOutline(toc, chapters) {
  outlinePanel.innerHTML = '';
  if (!toc || toc.length === 0) return;

  function addItems(items, level) {
    for (const item of items) {
      const div = document.createElement('div');
      div.className = 'outline-item level-' + level;
      div.textContent = item.title;
      div.dataset.href = item.href || '';
      div.addEventListener('click', () => {
        const scrolled = scrollToHref(item.href || '', chapters);
        if (scrolled) setActiveOutlineItem(div);
      });
      outlinePanel.appendChild(div);
      if (item.children && item.children.length > 0) {
        addItems(item.children, Math.min(level + 1, 3));
      }
    }
  }

  addItems(toc, 1);
}

// --- Resize Handle ---
function initResize() {
  const saved = loadSidebarWidths();
  if (saved.left) document.documentElement.style.setProperty('--left-sidebar-width', saved.left + 'px');
  if (saved.right) document.documentElement.style.setProperty('--right-sidebar-width', saved.right + 'px');

  setupHandle('resize-left', '--left-sidebar-width', 'left');
  setupHandle('resize-right', '--right-sidebar-width', 'right');
}

function setupHandle(handleId, cssVar, side) {
  const handle = document.getElementById(handleId);
  let startX, startWidth;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    const computed = getComputedStyle(document.documentElement).getPropertyValue(cssVar);
    startWidth = parseInt(computed, 10);

    handle.classList.add('active');
    document.body.classList.add('no-select');

    const onMouseMove = (e) => {
      const delta = side === 'right'
        ? startX - e.clientX
        : e.clientX - startX;
      const maxWidth = window.innerWidth * 0.5;
      const newWidth = Math.max(150, Math.min(maxWidth, startWidth + delta));
      document.documentElement.style.setProperty(cssVar, newWidth + 'px');
    };

    const onMouseUp = () => {
      handle.classList.remove('active');
      document.body.classList.remove('no-select');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      saveSidebarWidths();
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

function saveSidebarWidths() {
  const left = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--left-sidebar-width'), 10);
  const right = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--right-sidebar-width'), 10);
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ left, right }));
}

function loadSidebarWidths() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

// --- Reader State Persistence ---
let isStateLoaded = false;

function saveReaderState() {
  if (!isStateLoaded) return;
  const data = {
    openBooks: state.openBooks.map(b => ({
      filePath: b.filePath,
      title: b.title,
      position: b.position
    })),
    activeBookPath: state.activeBookPath
  };
  localStorage.setItem(STORAGE_KEY_BOOKS, JSON.stringify(data));
}

function loadReaderState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY_BOOKS));
    if (!saved || !saved.openBooks || saved.openBooks.length === 0) {
      isStateLoaded = true;
      return;
    }

    // Merge saved books into current state to avoid overwriting books 
    // that might have been opened via IPC before loadReaderState ran.
    const currentPaths = new Set(state.openBooks.map(b => b.filePath));
    for (const b of saved.openBooks) {
      if (!currentPaths.has(b.filePath)) {
        state.openBooks.push(b);
      }
    }

    if (!state.activeBookPath) {
      state.activeBookPath = saved.activeBookPath;
    }

    isStateLoaded = true;
    renderTabs();

    if (state.activeBookPath) {
      setActiveBook(state.activeBookPath);
    }
  } catch (e) {
    console.warn('Failed to load reader state', e);
    isStateLoaded = true;
  }
}

let positionSaveTimer = null;
contentArea.addEventListener('scroll', () => {
  if (!state.activeBookPath) return;
  if (positionSaveTimer) clearTimeout(positionSaveTimer);
  positionSaveTimer = setTimeout(() => {
    const book = state.openBooks.find(b => b.filePath === state.activeBookPath);
    if (!book) return;

    const scrollTop = contentArea.scrollTop;
    const scrollHeight = contentArea.scrollHeight;
    const clientHeight = contentArea.clientHeight;

    book.position = {
      scrollTop,
      progress: scrollHeight > clientHeight ? scrollTop / (scrollHeight - clientHeight) : 0
    };
    saveReaderState();
  }, 1000);
});

// --- Event Delegation ---
appLayout.addEventListener('click', (e) => {
  const closeBtn = e.target.closest('[data-close-book]');
  if (closeBtn) {
    closeBook(closeBtn.dataset.closeBook);
    return;
  }

  const tabItem = e.target.closest('.tab-item[data-book-path]');
  if (tabItem) {
    setActiveBook(tabItem.dataset.bookPath);
    return;
  }
});

document.getElementById('toggle-left-sidebar').addEventListener('click', () => {
  appLayout.classList.toggle('left-sidebar-hidden');
});

sidebarTabToc.addEventListener('click', () => {
  setSidebarMode('toc');
});

sidebarTabSearch.addEventListener('click', () => {
  setSidebarMode('search');
});

sidebarSearchInput.addEventListener('input', (e) => {
  state.searchQuery = e.target.value || '';
  if (sidebarSearchTimer) {
    clearTimeout(sidebarSearchTimer);
  }
  sidebarSearchTimer = setTimeout(() => {
    renderSearchResults();
  }, SEARCH_DEBOUNCE_MS);
});

sidebarSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    state.searchQuery = '';
    sidebarSearchInput.value = '';
    renderSearchResults();
    return;
  }

  if (e.key === 'Enter') {
    const first = searchPanel.querySelector('.search-result-item');
    if (first) first.click();
  }
});

searchPanel.addEventListener('click', (e) => {
  const item = e.target.closest('.search-result-item');
  if (!item || !state.activeBookPath) return;

  const data = state.bookContent[state.activeBookPath];
  if (!data) return;

  const chapterId = item.dataset.chapterId || null;
  const href = item.dataset.href || '';
  const scrolled = scrollToHref(href, data.chapters, chapterId);
  if (!scrolled) return;

  const targetOutline = [...outlinePanel.querySelectorAll('.outline-item')]
    .find(el => (el.dataset.href || '') === href);

  if (targetOutline) {
    setActiveOutlineItem(targetOutline);
  }
});

// --- Drag and Drop (on entire window) ---
function initDragAndDrop() {
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    for (const file of e.dataTransfer.files) {
      const filePath = window.epub.getFilePath(file);
      if (filePath && filePath.toLowerCase().endsWith('.epub')) {
        const title = filePath.split('/').pop().replace(/\.epub$/i, '');
        openBook(filePath, title);
      }
    }
  });
}

// --- Broken image handling ---
function initBrokenImageHandling() {
  contentArea.addEventListener('error', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLImageElement)) return;
    target.classList.add('image-missing');
  }, true);
}

// --- Style Popover ---
const stylePopover = document.getElementById('style-popover');
const btnStyle = document.getElementById('btn-style');

const readingStyle = {
  fontFamily: "Charter, 'Iowan Old Style', Georgia, 'Times New Roman', serif",
  fontSize: 16,
  lineHeight: 1.8,
  paraSpacing: 0.6,
};

const FONT_SIZE_STEPS = [12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 24];
const LINE_HEIGHT_STEPS = [1.2, 1.4, 1.6, 1.8, 2.0, 2.2, 2.4];
const PARA_SPACING_STEPS = [0, 0.3, 0.6, 1.0, 1.5, 2.0];

function loadReadingStyle() {
  try {
    const saved = JSON.parse(localStorage.getItem('yara-reading-style'));
    if (saved) Object.assign(readingStyle, saved);
  } catch {}
}

function saveReadingStyle() {
  localStorage.setItem('yara-reading-style', JSON.stringify(readingStyle));
}

function applyReadingStyle() {
  const root = document.documentElement;
  root.style.setProperty('--book-font-family', readingStyle.fontFamily);
  root.style.setProperty('--book-font-size', readingStyle.fontSize + 'px');
  root.style.setProperty('--book-line-height', String(readingStyle.lineHeight));
  root.style.setProperty('--book-para-spacing', readingStyle.paraSpacing + 'em');
  updateStyleDisplay();
}

function updateStyleDisplay() {
  document.getElementById('style-font-size-val').textContent = readingStyle.fontSize + 'px';
  document.getElementById('style-line-height-val').textContent = readingStyle.lineHeight.toFixed(1);
  document.getElementById('style-para-spacing-val').textContent = readingStyle.paraSpacing + 'em';

  // Sync select
  const fontSelect = document.getElementById('style-font');
  for (const opt of fontSelect.options) {
    if (readingStyle.fontFamily === opt.value) { fontSelect.value = opt.value; break; }
  }
}

function stepValue(arr, current, dir) {
  let idx = 0;
  let minDiff = Infinity;
  for (let i = 0; i < arr.length; i++) {
    const diff = Math.abs(arr[i] - current);
    if (diff < minDiff) { minDiff = diff; idx = i; }
  }
  const next = idx + dir;
  return arr[Math.max(0, Math.min(arr.length - 1, next))];
}

btnStyle.addEventListener('click', (e) => {
  e.stopPropagation();
  if (stylePopover.classList.contains('visible')) {
    stylePopover.classList.remove('visible');
    return;
  }
  // Position below the button, right-aligned to it
  const rect = btnStyle.getBoundingClientRect();
  stylePopover.style.top = (rect.bottom + 6) + 'px';
  stylePopover.style.right = (window.innerWidth - rect.right) + 'px';
  stylePopover.classList.add('visible');
});

// Close popover on outside click
document.addEventListener('mousedown', (e) => {
  if (!stylePopover.contains(e.target) && e.target !== btnStyle && !btnStyle.contains(e.target)) {
    stylePopover.classList.remove('visible');
  }
});

// Font select
document.getElementById('style-font').addEventListener('change', (e) => {
  readingStyle.fontFamily = e.target.value;
  applyReadingStyle();
  saveReadingStyle();
});

// Stepper buttons
stylePopover.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-step]');
  if (!btn) return;

  const prop = btn.dataset.step;
  const dir = parseInt(btn.dataset.dir, 10);

  if (prop === 'font-size') {
    readingStyle.fontSize = stepValue(FONT_SIZE_STEPS, readingStyle.fontSize, dir);
  } else if (prop === 'line-height') {
    readingStyle.lineHeight = stepValue(LINE_HEIGHT_STEPS, readingStyle.lineHeight, dir);
  } else if (prop === 'para-spacing') {
    readingStyle.paraSpacing = stepValue(PARA_SPACING_STEPS, readingStyle.paraSpacing, dir);
  }

  applyReadingStyle();
  saveReadingStyle();
});

loadReadingStyle();
applyReadingStyle();

// --- Right Sidebar Toggle ---
document.getElementById('toggle-right-sidebar').addEventListener('click', () => {
  appLayout.classList.toggle('right-sidebar-hidden');
});

// --- File open from main process (Finder double-click, File > Open) ---
window.epub.onOpenFile((filePath) => {
  const title = filePath.split('/').pop().replace(/\.epub$/i, '');
  openBook(filePath, title);
});

// --- Theme ---
function applyTheme(theme) {
  const t = theme || 'dark';
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('yara-theme', t);
}

async function loadTheme() {
  const settings = await window.settings.getAll();
  applyTheme(settings.theme);
}

window.settings.onThemeChanged((theme) => {
  applyTheme(theme);
});

// Init
loadReaderState();
setSidebarMode('toc');
initResize();
initDragAndDrop();
initBrokenImageHandling();
loadTheme();
