const state = {
  openBooks: [],       // [{ filePath, title, position: { scrollTop, progress } }]
  activeBookPath: null,
  bookContent: {},     // filePath -> { chapters, toc }
  bookSearchIndex: {}, // filePath -> [{ id, href, title, text, textLower }]
  sidebarMode: 'toc',
  searchQuery: '',
  highlights: {},      // filePath -> [{ id, chapterId, start, end, text, createdAt }]
};

const STORAGE_KEY = 'gull-sidebar-widths';
const STORAGE_KEY_BOOKS = 'gull-open-books';

// DOM refs
const appLayout = document.getElementById('app-layout');
const tabBar = document.getElementById('tab-bar-tabs');
const contentArea = document.getElementById('content-area');
const emptyState = document.getElementById('empty-state');
const sidebarTabToc = document.getElementById('sidebar-tab-toc');
const sidebarTabSearch = document.getElementById('sidebar-tab-search');
const sidebarTabHighlights = document.getElementById('sidebar-tab-highlights');
const sidebarSearchWrap = document.getElementById('sidebar-search-wrap');
const sidebarSearchInput = document.getElementById('sidebar-search-input');
const sidebarSearchClear = document.getElementById('sidebar-search-clear');
const outlinePanel = document.getElementById('outline-panel');
const searchPanel = document.getElementById('search-panel');
const highlightsPanel = document.getElementById('highlights-panel');
const selectionPopup = document.getElementById('selection-popup');

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
  state.sidebarMode = mode || 'toc';

  const isSearch = state.sidebarMode === 'search';
  const isHighlights = state.sidebarMode === 'highlights';
  const isToc = state.sidebarMode === 'toc';

  sidebarTabToc.classList.toggle('active', isToc);
  sidebarTabSearch.classList.toggle('active', isSearch);
  sidebarTabHighlights.classList.toggle('active', isHighlights);

  sidebarTabToc.setAttribute('aria-selected', String(isToc));
  sidebarTabSearch.setAttribute('aria-selected', String(isSearch));
  sidebarTabHighlights.setAttribute('aria-selected', String(isHighlights));

  sidebarSearchWrap.hidden = !isSearch;
  outlinePanel.hidden = !isToc;
  searchPanel.hidden = !isSearch;
  highlightsPanel.hidden = !isHighlights;

  if (isSearch) {
    sidebarSearchInput.focus({ preventScroll: true });
    renderSearchResults();
  } else if (isHighlights) {
    renderHighlights();
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

function flattenToc(items, out = []) {
  if (!items) return out;
  for (const item of items) {
    if (item.href && item.title) out.push(item);
    if (item.children) flattenToc(item.children, out);
  }
  return out;
}

function normalizeText(str) {
  return str.replace(/\s+/g, ' ').trim();
}

function indexBookForSearch(filePath, chapters, toc) {
  const titleMap = buildTocTitleMap(toc);
  const tocFiles = new Set(
    flattenToc(toc).map(t => (t.href || '').split('#')[0].split('/').pop()).filter(Boolean)
  );
  const index = [];
  const tempDiv = document.createElement('div');
  let i = 0;
  let inheritedTitle = '';

  function processChunk() {
    const start = performance.now();
    while (i < (chapters || []).length && performance.now() - start < 15) {
      const chapter = chapters[i];
      tempDiv.innerHTML = chapter.html || '';
      const text = normalizeText(tempDiv.textContent || '');
      if (text) {
        const file = (chapter.href || '').split('/').pop();
        if (tocFiles.has(file) && titleMap[file]) {
          inheritedTitle = titleMap[file];
        }
        const heading = tempDiv.querySelector('h1, h2, h3, h4, h5, h6, title');
        const headingTitle = heading ? normalizeText(heading.textContent || '') : '';
        index.push({
          id: chapter.id,
          href: chapter.href || '',
          title: titleMap[file] || chapter.title || inheritedTitle || headingTitle || '',
          text,
          textLower: text.toLowerCase(),
        });
      }
      i++;
    }

    if (i < (chapters || []).length) {
      setTimeout(processChunk, 10);
    } else {
      state.bookSearchIndex[filePath] = index;
      if (state.activeBookPath === filePath) {
        renderSearchResults();
      }
    }
  }

  setTimeout(processChunk, 200);
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
        matchIndex: hits,
        term: terms[0],
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
    row.dataset.matchIndex = String(result.matchIndex ?? 0);
    row.dataset.term = result.term || '';
    const titleHtml = result.title
      ? `<div class="search-result-title">${escapeHtml(result.title)}</div>`
      : '';
    row.innerHTML = `
      ${titleHtml}
      <div class="search-result-snippet">${buildHighlightedSnippet(result.snippet, terms)}</div>
    `;
    searchPanel.appendChild(row);
  }
}

function clearContentSearchHighlights() {
  contentArea.querySelectorAll('mark.search-match').forEach(mark => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  });
}

function highlightTermsInContent(terms) {
  if (!terms || terms.length === 0) return;
  const pattern = new RegExp(terms.map(escapeRegExp).join('|'), 'ig');
  const walker = document.createTreeWalker(contentArea, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      let p = node.parentNode;
      while (p && p !== contentArea) {
        const tag = p.nodeName;
        if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
        if (p.classList && p.classList.contains('search-match')) return NodeFilter.FILTER_REJECT;
        p = p.parentNode;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);

  for (const node of nodes) {
    const text = node.nodeValue;
    pattern.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let match;
    let found = false;
    while ((match = pattern.exec(text)) !== null) {
      if (match[0].length === 0) { pattern.lastIndex++; continue; }
      found = true;
      if (match.index > last) frag.appendChild(document.createTextNode(text.slice(last, match.index)));
      const mark = document.createElement('mark');
      mark.className = 'search-match';
      mark.textContent = match[0];
      frag.appendChild(mark);
      last = match.index + match[0].length;
    }
    if (found) {
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  }
}

function refreshContentSearchHighlights() {
  clearContentSearchHighlights();
  const q = normalizeText(state.searchQuery || '').toLowerCase();
  if (q.length < SEARCH_MIN_QUERY_LENGTH) return;
  const terms = q.split(' ').filter(Boolean);
  if (terms.length === 0) return;
  highlightTermsInContent(terms);
}

function scrollToHref(href, chapters, fallbackChapterId = null) {
  const targetHref = href || '';
  const baseHref = targetHref.split('#')[0];
  const fragment = targetHref.includes('#') ? targetHref.split('#')[1] : null;

  const matchChapter = (chapters || []).find(ch => {
    if (baseHref) {
      if (ch.href === baseHref) return true;
      const chFile = ch.href.split('/').pop();
      const tocFile = baseHref.split('/').pop();
      return chFile === tocFile;
    }
    return fallbackChapterId && ch.id === fallbackChapterId;
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
      div.style.opacity = '0';
      div.style.transition = 'opacity 0.15s ease-in-out';
      isRestoringBook = true;

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

      // Batched chapter DOM insertion
      contentArea.appendChild(div);
      const searchToRun = !state.bookSearchIndex[book.filePath];
      renderOutline(data.toc, data.chapters);
      if (searchToRun) {
        indexBookForSearch(book.filePath, data.chapters, data.toc);
      } else {
        renderSearchResults();
      }

      let chapterIdx = 0;
      function processChapterBatch() {
        if (state.activeBookPath !== book.filePath) {
          isRestoringBook = false;
          return;
        }

        const start = performance.now();
        while (chapterIdx < data.chapters.length && performance.now() - start < 15) {
          const ch = data.chapters[chapterIdx];
          const section = document.createElement('section');
          section.className = 'chapter';
          section.id = 'chapter-' + ch.id;
          section.innerHTML = ch.html;
          stripEpubFonts(section);
          bindImageFallback(section);
          applyHighlightsToChapter(ch.id, section);
          div.appendChild(section);
          if (chapterIdx < data.chapters.length - 1) {
            div.appendChild(document.createElement('hr'));
          }
          chapterIdx++;
        }

        if (chapterIdx < data.chapters.length) {
          requestAnimationFrame(processChapterBatch);
        } else {
          initOutlineScrollTracking(data.chapters);
          initChapterScrollbar(data.chapters, data.toc);

          // Restore position instantly before showing
          if (book.position) {
            if (book.position.progress !== undefined) {
              const maxScroll = contentArea.scrollHeight - contentArea.clientHeight;
              contentArea.scrollTop = maxScroll * book.position.progress;
            } else if (book.position.scrollTop !== undefined) {
              contentArea.scrollTop = book.position.scrollTop;
            }
          }
          
          div.style.opacity = '1';
          refreshContentSearchHighlights();
          setTimeout(() => { isRestoringBook = false; }, 100);
        }
      }

      requestAnimationFrame(processChapterBatch);
    }
  } else {
    emptyState.style.display = '';
    renderOutline([], []);
    searchPanel.innerHTML = '';
    renderSearchResults();
    initChapterScrollbar([]);
    renderHighlights();
  }
}

// --- Highlights ---
function getSelectionOffsets(root) {
  const selection = window.getSelection();
  if (!selection.rangeCount) return null;
  const range = selection.getRangeAt(0);

  // Ensure selection is within the root
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;

  const preSelectionRange = range.cloneRange();
  preSelectionRange.selectNodeContents(root);
  preSelectionRange.setEnd(range.startContainer, range.startOffset);
  const start = preSelectionRange.toString().length;

  return {
    start,
    end: start + range.toString().length,
    text: range.toString()
  };
}

function applyHighlightsToChapter(chapterId, container) {
  if (!state.activeBookPath) return;
  const bookHighlights = state.highlights[state.activeBookPath] || [];
  const chapterHighlights = bookHighlights.filter(h => h.chapterId === chapterId);

  chapterHighlights.forEach(h => {
    wrapHighlight(container, h.start, h.end, h.id);
  });
}

function wrapHighlight(root, startOffset, endOffset, id) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
  let currentOffset = 0;
  const nodesToWrap = [];

  let node;
  while ((node = walker.nextNode())) {
    const nodeLength = node.textContent.length;
    const nodeEndOffset = currentOffset + nodeLength;

    if (nodeEndOffset > startOffset && currentOffset < endOffset) {
      nodesToWrap.push({
        node,
        start: Math.max(0, startOffset - currentOffset),
        end: Math.min(nodeLength, endOffset - currentOffset)
      });
    }

    currentOffset = nodeEndOffset;
    if (currentOffset >= endOffset) break;
  }

  for (let i = nodesToWrap.length - 1; i >= 0; i--) {
    const { node, start, end } = nodesToWrap[i];
    try {
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      const mark = document.createElement('mark');
      mark.className = 'reader-highlight';
      mark.dataset.highlightId = id;
      range.surroundContents(mark);
    } catch (e) {
      console.warn('Failed to wrap highlight', e);
    }
  }
}

function renderHighlights() {
  highlightsPanel.innerHTML = '';
  if (!state.activeBookPath) {
    highlightsPanel.innerHTML = '<div class="search-empty">Open a book to see highlights.</div>';
    return;
  }

  const bookHighlights = state.highlights[state.activeBookPath] || [];
  if (bookHighlights.length === 0) {
    highlightsPanel.innerHTML = '<div class="search-empty">No highlights yet. Select text to highlight.</div>';
    return;
  }

  // Sort by createdAt desc
  [...bookHighlights].sort((a, b) => b.createdAt - a.createdAt).forEach(h => {
    const item = document.createElement('div');
    item.className = 'highlight-item';
    item.dataset.id = h.id;
    item.innerHTML = `
      <div class="highlight-content">
        <div class="highlight-text">"${escapeHtml(h.text)}"</div>
        <div class="highlight-footer">
          <div class="highlight-meta">${new Date(h.createdAt).toLocaleString()}</div>
          <button class="highlight-delete" title="Delete Highlight" data-delete-id="${h.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 6h18" />
              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            </svg>
          </button>
        </div>
      </div>
    `;

    item.querySelector('.highlight-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      removeHighlight(h.id);
    });

    item.addEventListener('click', () => {
      const data = state.bookContent[state.activeBookPath];
      if (data) {
        const scrolled = scrollToHref('', data.chapters, h.chapterId);
        if (scrolled) {
          // Precisely scroll to the mark if possible
          const mark = document.querySelector(`.reader-highlight[data-highlight-id="${h.id}"]`);
          if (mark) {
            mark.scrollIntoView({ behavior: 'instant', block: 'center' });
            // Flash effect
            mark.style.transition = 'none';
            mark.style.backgroundColor = 'rgba(255, 230, 0, 0.8)';
            setTimeout(() => {
              mark.style.transition = 'background-color 0.5s';
              mark.style.backgroundColor = '';
            }, 500);
          }
        }
      }
    });
    highlightsPanel.appendChild(item);
  });
}

function addHighlight() {
  const selection = window.getSelection();
  if (!selection.rangeCount || selection.isCollapsed) return;

  const range = selection.getRangeAt(0);
  const chapterSection = range.startContainer.parentElement.closest('section.chapter');
  if (!chapterSection) return;

  const chapterId = chapterSection.id.replace('chapter-', '');
  const offsets = getSelectionOffsets(chapterSection);
  if (!offsets || offsets.start === offsets.end) return;

  const id = crypto.randomUUID();
  const highlight = {
    id,
    chapterId,
    start: offsets.start,
    end: offsets.end,
    text: offsets.text,
    createdAt: Date.now()
  };

  if (!state.highlights[state.activeBookPath]) {
    state.highlights[state.activeBookPath] = [];
  }
  state.highlights[state.activeBookPath].push(highlight);

  wrapHighlight(chapterSection, highlight.start, highlight.end, highlight.id);
  selection.removeAllRanges();
  selectionPopup.hidden = true;
  saveHighlights();
  if (state.sidebarMode === 'highlights') renderHighlights();
}

function removeHighlight(id) {
  if (!state.activeBookPath) return;
  const bookHighlights = state.highlights[state.activeBookPath] || [];
  const idx = bookHighlights.findIndex(h => h.id === id);
  if (idx === -1) return;

  const h = bookHighlights[idx];
  bookHighlights.splice(idx, 1);
  saveHighlights();

  // Remove the <mark> tags
  document.querySelectorAll(`.reader-highlight[data-highlight-id="${id}"]`).forEach(mark => {
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  });

  if (state.sidebarMode === 'highlights') renderHighlights();
  selectionPopup.hidden = true;
}

function saveHighlights() {
  localStorage.setItem('gull-highlights', JSON.stringify(state.highlights));
}

function loadHighlights() {
  try {
    const saved = JSON.parse(localStorage.getItem('gull-highlights'));
    if (saved) state.highlights = saved;
  } catch (e) {
    console.warn('Failed to load highlights', e);
  }
}

document.addEventListener('mouseup', (e) => {
  // Use a small timeout to ensure the selection is finalized
  setTimeout(() => handleSelectionChange(e.target), 20);
});

document.addEventListener('selectionchange', () => {
  // Hide popup while selecting or if selection is cleared
  selectionPopup.hidden = true;
});

function handleSelectionChange(targetEl) {
  const selection = window.getSelection();
  const isCollapsed = !selection.rangeCount || selection.isCollapsed;
  const markEl = targetEl?.closest?.('mark.reader-highlight');

  if (isCollapsed && !markEl) {
    selectionPopup.hidden = true;
    return;
  }

  const range = selection.getRangeAt(0);
  const chapterSection = range.startContainer.parentElement?.closest('section.chapter');
  if (!chapterSection) {
    selectionPopup.hidden = true;
    return;
  }

  let existing = null;
  let targetRect = null;

  if (markEl) {
    const id = markEl.dataset.highlightId;
    existing = (state.highlights[state.activeBookPath] || []).find(h => h.id === id);
    targetRect = markEl.getBoundingClientRect();
  } else {
    // Check if selection is already a highlight
    const offsets = getSelectionOffsets(chapterSection);
    existing = (state.highlights[state.activeBookPath] || []).find(h => 
      h.chapterId === chapterSection.id.replace('chapter-', '') &&
      Math.abs(h.start - offsets.start) < 2 &&
      Math.abs(h.end - offsets.end) < 2
    );
    targetRect = selection.getRangeAt(0).getBoundingClientRect();
  }

  if (existing) {
    selectionPopup.textContent = 'Remove Highlight';
    selectionPopup.onclick = () => removeHighlight(existing.id);
  } else {
    selectionPopup.textContent = 'Highlight';
    selectionPopup.onclick = () => addHighlight();
  }

  selectionPopup.style.top = (targetRect.top + window.scrollY - 40) + 'px';
  selectionPopup.style.left = (targetRect.left + targetRect.width / 2 + window.scrollX) + 'px';
  selectionPopup.hidden = false;
}

function stripEpubFonts(container) {
  // CSS is already filtered in main process; just ensure no font-family leaks through
  container.querySelectorAll('[style]').forEach(el => {
    const cls = (el.getAttribute('class') || '').toLowerCase();
    const isDropCap = cls.includes('dropcap') || cls.includes('drop-cap');
    if (!isDropCap) {
      if (el.style.fontFamily) el.style.fontFamily = '';
      if (el.style.fontSize) el.style.fontSize = '';
    }
  });
}

function bindImageFallback(container) {
  const svgImages = container.querySelectorAll('svg image');
  for (const svgImg of svgImages) {
    const svg = svgImg.closest('svg');
    // Previously we were hiding these, which prevented covers from showing.
    // Now we ensure they are visible and have reasonable defaults.
    if (svg) {
      svg.style.display = 'block';
      svg.style.maxWidth = '100%';
      svg.style.height = 'auto';
    }
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

  let cachedMeasures = null;
  const invalidateScrollbar = () => {
    cachedMeasures = null;
    requestAnimationFrame(update);
  };
  const ro = new ResizeObserver(invalidateScrollbar);
  ro.observe(contentArea);
  contentArea.addEventListener('force-update-scrollbar', invalidateScrollbar);

  let updating = false;
  function update() {
    if (updating) return;
    updating = true;
    requestAnimationFrame(() => {
      updating = false;
      const scrollTop = contentArea.scrollTop;
      const viewportH = contentArea.clientHeight;
      
      let gap = 3;
      if (segments.length * 6 + segments.length * gap > bar.clientHeight) gap = 1;
      if (segments.length * 3 + segments.length * gap > bar.clientHeight) gap = 0;
      bar.style.gap = gap + 'px';
      
      const barH = bar.clientHeight - (segments.length - 1) * gap;
  
      if (!cachedMeasures) cachedMeasures = computeMeasures();
      const measures = cachedMeasures;
      if (measures.length === 0) return;
  
      const totalH = measures.reduce((sum, m) => sum + m.height, 0);
  
      const viewportEnd = scrollTop + viewportH;
      for (const m of measures) {
        // Pure mathematical proportionality (no minH pixel stealing)
        const rawRatio = m.height / totalH;
        m.seg.style.height = (rawRatio * barH) + 'px';
  
        let fillRatio = 0;
        if (viewportEnd >= m.top + m.height) {
          fillRatio = 1;
        } else if (viewportEnd > m.top) {
          fillRatio = (viewportEnd - m.top) / m.height;
        }
  
        fillRatio = Math.max(0, Math.min(1, fillRatio));
        m.fill.style.height = (fillRatio * 100) + '%';
      }
    });
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

    if (!cachedMeasures) cachedMeasures = computeMeasures();
    const measures = cachedMeasures;
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
    ro.disconnect();
    contentArea.removeEventListener('force-update-scrollbar', invalidateScrollbar);
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

  let cachedTargets = null;
  const invalidateOutline = () => {
    cachedTargets = null;
    requestAnimationFrame(onScroll);
  };
  const ro = new ResizeObserver(invalidateOutline);
  ro.observe(contentArea);
  contentArea.addEventListener('force-update-scrollbar', invalidateOutline);

  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      if (!cachedTargets) cachedTargets = buildTocTargets();
      const targets = cachedTargets;
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
    });
  };

  contentArea.addEventListener('scroll', onScroll);
  scrollTrackingCleanup = () => {
    ro.disconnect();
    contentArea.removeEventListener('force-update-scrollbar', invalidateOutline);
    contentArea.removeEventListener('scroll', onScroll);
  };

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

    // Lock onto the visible chapter to prevent scroll jumping
    const scrollTop = contentArea.scrollTop;
    const chapters = Array.from(contentArea.querySelectorAll('section.chapter'));
    let targetCh = null;
    let targetRatio = 0;
    
    for (const ch of chapters) {
      if (ch.offsetTop + ch.offsetHeight > scrollTop) {
        targetCh = ch;
        targetRatio = Math.max(0, scrollTop - ch.offsetTop) / (ch.offsetHeight || 1);
        break;
      }
    }

    let isUpdating = false;
    let currentX = e.clientX;

    const updateWidth = () => {
      isUpdating = false;
      const delta = side === 'right' ? startX - currentX : currentX - startX;
      const maxWidth = 500;
      const newWidth = Math.max(250, Math.min(maxWidth, startWidth + delta));
      
      document.documentElement.style.setProperty(cssVar, newWidth + 'px');
      
      if (targetCh) {
        contentArea.scrollTop = targetCh.offsetTop + (targetCh.offsetHeight * targetRatio);
      }
      
      contentArea.dispatchEvent(new CustomEvent('force-update-scrollbar'));
    };

    const onMouseMove = (e) => {
      currentX = e.clientX;
      if (!isUpdating) {
        isUpdating = true;
        requestAnimationFrame(updateWidth);
      }
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

async function loadReaderState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY_BOOKS));
    if (!saved || !saved.openBooks || saved.openBooks.length === 0) {
      isStateLoaded = true;
      return;
    }

    // Verify file existence
    const pathsToCheck = saved.openBooks.map(b => b.filePath);
    const existenceResults = await window.epub.checkPathsExistence(pathsToCheck);
    const existingFilePaths = new Set(
      existenceResults.filter(r => r.exists).map(r => r.path)
    );

    const validSavedBooks = saved.openBooks.filter(b => existingFilePaths.has(b.filePath));

    // Merge saved books into current state to avoid overwriting books 
    // that might have been opened via IPC before loadReaderState ran.
    const currentPaths = new Set(state.openBooks.map(b => b.filePath));
    for (const b of validSavedBooks) {
      if (!currentPaths.has(b.filePath)) {
        state.openBooks.push(b);
      }
    }

    if (!state.activeBookPath) {
      if (validSavedBooks.some(b => b.filePath === saved.activeBookPath)) {
        state.activeBookPath = saved.activeBookPath;
      } else if (state.openBooks.length > 0) {
        state.activeBookPath = state.openBooks[0].filePath;
      }
    }

    isStateLoaded = true;
    renderTabs();

    if (state.activeBookPath) {
      setActiveBook(state.activeBookPath);
    }

    // Persist filtered state back to localStorage
    saveReaderState();
  } catch (e) {
    console.warn('Failed to load reader state', e);
    isStateLoaded = true;
  }
}

let positionSaveTimer = null;
let isRestoringBook = false;

contentArea.addEventListener('scroll', () => {
  if (!state.activeBookPath || isRestoringBook) return;
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

sidebarTabHighlights.addEventListener('click', () => {
  setSidebarMode('highlights');
});

function updateSearchClearVisibility() {
  sidebarSearchClear.hidden = !sidebarSearchInput.value;
}

sidebarSearchInput.addEventListener('input', (e) => {
  state.searchQuery = e.target.value || '';
  updateSearchClearVisibility();
  if (sidebarSearchTimer) {
    clearTimeout(sidebarSearchTimer);
  }
  sidebarSearchTimer = setTimeout(() => {
    renderSearchResults();
    refreshContentSearchHighlights();
  }, SEARCH_DEBOUNCE_MS);
});

sidebarSearchClear.addEventListener('click', () => {
  state.searchQuery = '';
  sidebarSearchInput.value = '';
  updateSearchClearVisibility();
  renderSearchResults();
  refreshContentSearchHighlights();
  sidebarSearchInput.focus({ preventScroll: true });
});

sidebarSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    state.searchQuery = '';
    sidebarSearchInput.value = '';
    updateSearchClearVisibility();
    renderSearchResults();
    refreshContentSearchHighlights();
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
  const matchIndex = parseInt(item.dataset.matchIndex || '0', 10);
  const term = (item.dataset.term || '').toLowerCase();
  const scrolled = scrollToHref(href, data.chapters, chapterId);
  if (!scrolled) return;

  if (chapterId && term) {
    const section = contentArea.querySelector('#chapter-' + CSS.escape(chapterId));
    if (section) {
      const marks = [...section.querySelectorAll('mark.search-match')]
        .filter(m => m.textContent.toLowerCase() === term);
      const target = marks[matchIndex] || marks[0];
      if (target) target.scrollIntoView({ behavior: 'instant', block: 'center' });
    }
  }

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

  // Intercept link clicks to prevent navigation and handle internal jumps (footnotes, etc.)
  contentArea.addEventListener('click', (e) => {
    const link = e.target.closest('a');
    if (!link || !state.activeBookPath) return;

    const href = link.getAttribute('href');
    if (!href || href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('tel:')) {
      // For external links, we might want to open them in system browser,
      // but for now let default happen (or block if needed)
      return;
    }

    e.preventDefault();
    const data = state.bookContent[state.activeBookPath];
    if (data) {
      const chapterSection = link.closest('section.chapter');
      const chapterId = chapterSection ? chapterSection.id.replace('chapter-', '') : null;
      scrollToHref(href, data.chapters, chapterId);
    }
  });
}

// --- Style Popover ---
const stylePopover = document.getElementById('style-popover');
const btnStyle = document.getElementById('btn-style');

const readingStyle = {
  fontFamily: "'Charter', serif",
  fontSize: 16,
  lineHeight: 1.8,
  paraSpacing: 0.6,
};

const FONT_SIZE_STEPS = [12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 24];
const LINE_HEIGHT_STEPS = [1.2, 1.4, 1.6, 1.8, 2.0, 2.2, 2.4];
const PARA_SPACING_STEPS = [0, 0.3, 0.6, 1.0, 1.5, 2.0];

function loadReadingStyle() {
  try {
    const saved = JSON.parse(localStorage.getItem('gull-reading-style'));
    if (saved) Object.assign(readingStyle, saved);
  } catch {}
}

function saveReadingStyle() {
  localStorage.setItem('gull-reading-style', JSON.stringify(readingStyle));
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

document.getElementById('btn-theme-light').addEventListener('click', () => {
  applyTheme('light');
  window.settings.set('theme', 'light');
});

document.getElementById('btn-theme-dark').addEventListener('click', () => {
  applyTheme('dark');
  window.settings.set('theme', 'dark');
});

// --- File open from main process (Finder double-click, File > Open) ---
window.epub.onOpenFile((filePath) => {
  const title = filePath.split('/').pop().replace(/\.epub$/i, '');
  openBook(filePath, title);
});

// --- Theme ---
function applyTheme(theme) {
  const t = theme || 'light';
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('gull-theme', t);
  
  // Update switcher UI
  const btnLight = document.getElementById('btn-theme-light');
  const btnDark = document.getElementById('btn-theme-dark');
  if (btnLight && btnDark) {
    btnLight.classList.toggle('active', t === 'light');
    btnDark.classList.toggle('active', t === 'dark');
  }
}

async function loadTheme() {
  const settings = await window.settings.getAll();
  applyTheme(settings.theme);
}

window.settings.onThemeChanged((theme) => {
  applyTheme(theme);
});

function initUpdatePill() {
  const btn = document.getElementById('btn-update');
  if (!btn || !window.updater) return;
  window.updater.onUpdateReady(() => {
    btn.hidden = false;
  });
  btn.addEventListener('click', () => {
    btn.disabled = true;
    window.updater.apply();
  });
}

// Init
async function initApp() {
  await loadReaderState();
  loadHighlights();
  setSidebarMode('toc');
  initResize();
  initDragAndDrop();
  initBrokenImageHandling();
  initUpdatePill();
  await loadTheme();
  window.epub.signalReady();
}

initApp();
