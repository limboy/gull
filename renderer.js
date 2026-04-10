// State
const state = {
  openBooks: [],       // [{ filePath, title }]
  activeBookPath: null,
  bookContent: {},     // filePath -> { chapters, toc }
};

const STORAGE_KEY = 'yara-sidebar-widths';

// DOM refs
const appLayout = document.getElementById('app-layout');
const tabBar = document.getElementById('tab-bar-tabs');
const contentArea = document.getElementById('content-area');
const emptyState = document.getElementById('empty-state');

// --- Book Tab Management ---
function openBook(filePath, title) {
  const existing = state.openBooks.find(b => b.filePath === filePath);
  if (!existing) {
    state.openBooks.push({ filePath, title });
  }
  setActiveBook(filePath);
  renderTabs();
}

function closeBook(filePath) {
  const idx = state.openBooks.findIndex(b => b.filePath === filePath);
  if (idx === -1) return;

  state.openBooks.splice(idx, 1);
  delete state.bookContent[filePath];

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
}

function setActiveBook(filePath) {
  state.activeBookPath = filePath;
  renderTabs();
  renderContent();
}

function renderTabs() {
  tabBar.innerHTML = '';
  state.openBooks.forEach(book => {
    const tab = document.createElement('div');
    tab.className = 'tab-item' + (book.filePath === state.activeBookPath ? ' active' : '');
    tab.dataset.bookPath = book.filePath;
    tab.innerHTML = `
      <span class="tab-label">${book.title}</span>
      <span class="tab-close" data-close-book="${book.filePath}">
        <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </span>
    `;
    tabBar.appendChild(tab);
  });
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
      initOutlineScrollTracking(data.chapters);
      initChapterScrollbar(data.chapters, data.toc);
    }
  } else {
    emptyState.style.display = '';
    renderOutline([], []);
    initChapterScrollbar([]);
  }
}

function stripEpubFonts(container) {
  container.querySelectorAll('style').forEach(el => el.remove());
  container.querySelectorAll('[style]').forEach(el => {
    el.style.fontFamily = '';
    el.style.fontSize = '';
    el.style.lineHeight = '';
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

  // Build segment elements
  const segments = [];
  for (const ch of chapters) {
    const seg = document.createElement('div');
    seg.className = 'ch-scroll-segment';
    const fill = document.createElement('div');
    fill.className = 'ch-scroll-fill';
    seg.appendChild(fill);
    bar.appendChild(seg);

    const chFile = ch.href.split('/').pop();
    const title = titleMap[chFile] || '';
    segments.push({ id: ch.id, seg, fill, title });
  }

  // Tooltip element
  const tooltip = document.createElement('div');
  tooltip.className = 'ch-scroll-tooltip';
  tooltip.style.display = 'none';
  document.body.appendChild(tooltip);

  function update() {
    const scrollTop = contentArea.scrollTop;
    const viewportH = contentArea.clientHeight;
    const barH = bar.clientHeight - (chapters.length - 1) * 3 - 16;

    const chapterMeasures = [];
    let totalH = 0;
    for (const s of segments) {
      const section = contentArea.querySelector('#chapter-' + CSS.escape(s.id));
      if (section) {
        const h = section.offsetHeight;
        chapterMeasures.push({ ...s, top: section.offsetTop, height: h });
        totalH += h;
      }
    }

    if (totalH === 0) return;

    for (const m of chapterMeasures) {
      const ratio = m.height / totalH;
      const segH = Math.max(8, ratio * barH);
      m.seg.style.height = segH + 'px';

      const chStart = m.top;
      const viewEnd = scrollTop + viewportH;

      let fillRatio = 0;
      if (viewEnd >= chStart + m.height) {
        fillRatio = 1;
      } else if (viewEnd > chStart) {
        fillRatio = (viewEnd - chStart) / m.height;
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

    const seg = segments.find(s => s.seg === target);
    if (!seg) return;

    const segRect = target.getBoundingClientRect();
    const within = (e.clientY - segRect.top) / segRect.height;
    const section = contentArea.querySelector('#chapter-' + CSS.escape(seg.id));
    if (section) {
      contentArea.scrollTop = section.offsetTop + section.offsetHeight * within - contentArea.clientHeight / 2;
    }
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
  const panel = document.getElementById('outline-panel');
  panel.innerHTML = '';
  if (!toc || toc.length === 0) return;

  function addItems(items, level) {
    for (const item of items) {
      const div = document.createElement('div');
      div.className = 'outline-item level-' + level;
      div.textContent = item.title;
      div.dataset.href = item.href || '';
      div.addEventListener('click', () => {
        const href = item.href || '';
        const baseHref = href.split('#')[0];
        const fragment = href.includes('#') ? href.split('#')[1] : null;

        // Find the matching chapter by comparing href (filename)
        const matchChapter = (chapters || []).find(ch => {
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
              if (target) { target.scrollIntoView({ behavior: 'instant' }); scrolled = true; }
            }
            if (!scrolled) { section.scrollIntoView({ behavior: 'instant' }); scrolled = true; }
          }
        }

        if (!scrolled && fragment) {
          const target = contentArea.querySelector('#' + CSS.escape(fragment));
          if (target) { target.scrollIntoView({ behavior: 'instant' }); scrolled = true; }
        }

        if (scrolled) setActiveOutlineItem(div);
      });
      panel.appendChild(div);
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
  if (saved.right) document.documentElement.style.setProperty('--right-sidebar-width', saved.right + 'px');

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
      const delta = startX - e.clientX;
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
  const right = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--right-sidebar-width'), 10);
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ right }));
}

function loadSidebarWidths() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

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
  document.documentElement.setAttribute('data-theme', theme || 'dark');
}

async function loadTheme() {
  const settings = await window.settings.getAll();
  applyTheme(settings.theme);
}

window.settings.onThemeChanged((theme) => {
  applyTheme(theme);
});

// Init
initResize();
initDragAndDrop();
initBrokenImageHandling();
loadTheme();
