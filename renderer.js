// State
const state = {
  activeActivity: 'books',
  leftTab: 'all',
  rightTab: 'outline',
  openBooks: [],       // [{ id, title }]
  activeBookId: null,
  books: [],           // [{ id, title, filename, addedAt }]
  bookContent: {},     // id -> { chapters, toc }
};

const STORAGE_KEY = 'yara-sidebar-widths';

// DOM refs
const appLayout = document.getElementById('app-layout');
const tabBar = document.getElementById('tab-bar');
const contentArea = document.getElementById('content-area');
const emptyState = document.getElementById('empty-state');

// --- Activity Bar ---
function setActiveActivity(name) {
  state.activeActivity = name;
  document.querySelectorAll('.activity-icon').forEach(el => {
    el.classList.toggle('active', el.dataset.activity === name);
  });
}

// --- Left Sidebar Tabs ---
function setLeftTab(tab) {
  state.leftTab = tab;
  document.querySelectorAll('#left-sidebar .tab-row .tab').forEach(el => {
    el.classList.toggle('active', el.dataset.leftTab === tab);
  });
  document.querySelectorAll('#left-sidebar .tab-panel').forEach(el => {
    el.classList.toggle('active', el.dataset.leftPanel === tab);
  });
}

// --- Right Sidebar Tabs ---
function setRightTab(tab) {
  state.rightTab = tab;
  document.querySelectorAll('#right-sidebar .tab-row .tab').forEach(el => {
    el.classList.toggle('active', el.dataset.rightTab === tab);
  });
  document.querySelectorAll('#right-sidebar .tab-panel').forEach(el => {
    el.classList.toggle('active', el.dataset.rightPanel === tab);
  });
}

// --- Book Management ---
function openBook(id, title) {
  const existing = state.openBooks.find(b => b.id === id);
  if (!existing) {
    state.openBooks.push({ id, title });
  }
  setActiveBook(id);
  renderTabs();
}

function closeBook(id) {
  const idx = state.openBooks.findIndex(b => b.id === id);
  if (idx === -1) return;

  state.openBooks.splice(idx, 1);

  if (state.activeBookId === id) {
    if (state.openBooks.length > 0) {
      const newIdx = Math.min(idx, state.openBooks.length - 1);
      setActiveBook(state.openBooks[newIdx].id);
    } else {
      state.activeBookId = null;
    }
  }
  renderTabs();
  renderContent();
}

function setActiveBook(id) {
  state.activeBookId = id;
  renderTabs();
  renderContent();
}

function renderTabs() {
  tabBar.innerHTML = '';
  state.openBooks.forEach(book => {
    const tab = document.createElement('div');
    tab.className = 'tab-item' + (book.id === state.activeBookId ? ' active' : '');
    tab.dataset.bookId = book.id;
    tab.innerHTML = `
      <span class="tab-label">${book.title}</span>
      <span class="tab-close" data-close-book="${book.id}">
        <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </span>
    `;
    tabBar.appendChild(tab);
  });
}

async function renderContent() {
  // Remove existing book content elements
  contentArea.querySelectorAll('.book-content').forEach(el => el.remove());

  if (state.activeBookId) {
    emptyState.style.display = 'none';
    const book = state.openBooks.find(b => b.id === state.activeBookId);
    if (book) {
      // Load content if not cached
      if (!state.bookContent[book.id]) {
        const div = document.createElement('div');
        div.className = 'book-content active';
        div.textContent = 'Loading…';
        contentArea.appendChild(div);
        try {
          state.bookContent[book.id] = await window.books.open(book.id);
        } catch (err) {
          div.textContent = 'Failed to load book: ' + err.message;
          return;
        }
        div.remove();
      }

      const data = state.bookContent[book.id];
      const div = document.createElement('div');
      div.className = 'book-content active';

      // Render chapters
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
    }
  } else {
    emptyState.style.display = '';
    renderOutline([], []);
  }
}

function stripEpubFonts(container) {
  // Remove <style> tags from EPUB content
  container.querySelectorAll('style').forEach(el => el.remove());
  // Strip inline font-family from all elements
  container.querySelectorAll('[style]').forEach(el => {
    el.style.fontFamily = '';
    el.style.fontSize = '';
    el.style.lineHeight = '';
  });
}

function bindImageFallback(container) {
  // Hide SVGs containing <image> elements (e.g. EPUB cover pages)
  // that fail to render properly
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

    // Fail-closed: keep hidden unless we can confirm it loaded.
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
        // Try to find the chapter by href
        const href = item.href || '';
        const baseHref = href.split('#')[0];
        const fragment = href.includes('#') ? href.split('#')[1] : null;

        // Try fragment first
        if (fragment) {
          const target = contentArea.querySelector('#' + CSS.escape(fragment));
          if (target) { target.scrollIntoView({ behavior: 'smooth' }); return; }
        }

        // Match chapter by href suffix
        if (baseHref && chapters) {
          const idx = chapters.findIndex(ch => baseHref.endsWith(ch.id + '.xhtml') || baseHref.endsWith(ch.id + '.html') || baseHref.includes(ch.id));
          if (idx !== -1) {
            const section = contentArea.querySelector('#chapter-' + CSS.escape(chapters[idx].id));
            if (section) { section.scrollIntoView({ behavior: 'smooth' }); return; }
          }
          // Also try matching by filename
          for (const ch of chapters) {
            const section = contentArea.querySelector('#chapter-' + CSS.escape(ch.id));
            if (section) {
              // Check if this section contains the fragment target
              if (fragment) {
                const target = section.querySelector('#' + CSS.escape(fragment));
                if (target) { target.scrollIntoView({ behavior: 'smooth' }); return; }
              }
            }
          }
        }
      });
      panel.appendChild(div);
      if (item.children && item.children.length > 0) {
        addItems(item.children, Math.min(level + 1, 3));
      }
    }
  }

  addItems(toc, 1);
}

// --- Resize Handles ---
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
      const delta = side === 'left' ? e.clientX - startX : startX - e.clientX;
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

// --- Event Delegation ---
appLayout.addEventListener('click', (e) => {
  const target = e.target.closest('[data-activity]');
  if (target) {
    setActiveActivity(target.dataset.activity);
    return;
  }

  const leftTab = e.target.closest('[data-left-tab]');
  if (leftTab) {
    setLeftTab(leftTab.dataset.leftTab);
    return;
  }

  const rightTab = e.target.closest('[data-right-tab]');
  if (rightTab) {
    setRightTab(rightTab.dataset.rightTab);
    return;
  }

  const closeBtn = e.target.closest('[data-close-book]');
  if (closeBtn) {
    closeBook(closeBtn.dataset.closeBook);
    return;
  }

  const tabItem = e.target.closest('.tab-item[data-book-id]');
  if (tabItem) {
    setActiveBook(tabItem.dataset.bookId);
    return;
  }

  const bookItem = e.target.closest('.book-item[data-book-id]');
  if (bookItem) {
    openBook(bookItem.dataset.bookId, bookItem.dataset.bookTitle);
    return;
  }
});

// Auto-resize textarea
const aiInput = document.getElementById('ai-input');
aiInput.addEventListener('input', () => {
  aiInput.style.height = 'auto';
  aiInput.style.height = Math.min(aiInput.scrollHeight, 120) + 'px';
});

// --- Book List Rendering ---
const BOOK_ICON_SVG = '<svg class="book-icon" viewBox="0 0 24 24"><path d="M6 2h10l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm9 1.5V7h3.5L15 3.5zM6 4v16h12V8h-4a1 1 0 0 1-1-1V4H6z"/></svg>';

function createBookItem(book) {
  const div = document.createElement('div');
  div.className = 'book-item';
  div.dataset.bookId = book.id;
  div.dataset.bookTitle = book.title;
  div.innerHTML = `${BOOK_ICON_SVG}<span class="book-title">${book.title}</span>`;
  div.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.books.showContextMenu(book.id);
  });
  return div;
}

function renderBookList() {
  const panels = {
    all: document.querySelector('[data-left-panel="all"] .book-list'),
    reading: document.querySelector('[data-left-panel="reading"] .book-list'),
    finished: document.querySelector('[data-left-panel="finished"] .book-list'),
  };
  Object.values(panels).forEach(el => el.innerHTML = '');

  state.books.forEach(book => {
    panels.all.appendChild(createBookItem(book));
    if (book.status === 'reading') {
      panels.reading.appendChild(createBookItem(book));
    } else if (book.status === 'finished') {
      panels.finished.appendChild(createBookItem(book));
    }
  });
}

async function loadBooks() {
  state.books = await window.books.getAll();
  renderBookList();
}

// --- Drag and Drop ---
function initDragAndDrop() {
  const sidebar = document.getElementById('left-sidebar');
  let dragCounter = 0;

  // Prevent default file loading on the whole document
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  sidebar.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1) sidebar.classList.add('drag-over');
  });

  sidebar.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter === 0) sidebar.classList.remove('drag-over');
  });

  sidebar.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  sidebar.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    sidebar.classList.remove('drag-over');

    const paths = [];
    for (const file of e.dataTransfer.files) {
      const filePath = window.books.getFilePath(file);
      if (filePath && filePath.toLowerCase().endsWith('.epub')) {
        paths.push(filePath);
      }
    }

    if (paths.length > 0) {
      state.books = await window.books.import(paths);
      renderBookList();
    }
  });
}

// --- Broken image handling ---
function initBrokenImageHandling() {
  // image `error` does not bubble, so listen in capture phase
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

// --- Book context menu responses ---
window.books.onStatusUpdated((id, status) => {
  const book = state.books.find(b => b.id === id);
  if (book) {
    book.status = status;
    renderBookList();
  }
});

window.books.onDeleteRequested(async (id) => {
  state.books = await window.books.delete(id);
  closeBook(id);
  renderBookList();
});

// Init
initResize();
initDragAndDrop();
initBrokenImageHandling();
loadBooks();
