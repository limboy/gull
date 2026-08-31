const { app, BrowserWindow, ipcMain, Menu, dialog, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { fileURLToPath } = require('url');
const { Worker } = require('worker_threads');
const AdmZip = require('adm-zip');
const cheerio = require('cheerio');
const { autoUpdater } = require('electron-updater');
const {
  filterInlineStyle,
  normalizeXhtmlFragment,
  sanitizePublicationDocument,
} = require('./lib/book-content');

app.setName('Gull');

const SUPPORTED_EXTENSIONS = ['.epub', '.mobi', '.azw3', '.azw', '.prc'];
const MAX_BOOK_FILE_SIZE = 512 * 1024 * 1024;
const MAX_PATH_CHECKS = 500;
const MAX_FOLDER_BOOKS = 500;
const MAX_FOLDER_SCAN_DEPTH = 4;
const MAX_WATCHED_FOLDERS = 50;
const FOLDER_CHANGE_DEBOUNCE_MS = 400;
const RENDERER_SETTING_VALIDATORS = {
  theme: value => ['system', 'light', 'dark'].includes(value),
  chapterScrollbar: value => typeof value === 'boolean',
  fullWidth: value => typeof value === 'boolean',
  sidebarStates: value => value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.leftHidden === 'boolean'
    && typeof value.rightHidden === 'boolean',
};

function isSupportedFile(filePath) {
  if (typeof filePath !== 'string' || !filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS.includes(ext);
}

function validateBookPath(filePath) {
  if (!isSupportedFile(filePath) || !path.isAbsolute(filePath)) {
    throw new Error('Invalid book path');
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('Book path is not a file');
  if (stat.size > MAX_BOOK_FILE_SIZE) {
    throw new Error(`Book exceeds the ${MAX_BOOK_FILE_SIZE / 1024 / 1024} MB size limit`);
  }
  return filePath;
}

function validateFolderPath(folderPath) {
  if (typeof folderPath !== 'string' || !folderPath || !path.isAbsolute(folderPath)) {
    throw new Error('Invalid folder path');
  }
  if (!fs.statSync(folderPath).isDirectory()) {
    throw new Error('Folder path is not a directory');
  }
  return folderPath;
}

/**
 * Read the folder tree a sidebar folder should show.
 *
 * Book folders are organized in wildly different ways — a flat drop of EPUBs,
 * or a Calibre-style `Author/Title/book.epub` tree — so subfolders are returned
 * as nested nodes and the renderer decides how to display them. Branches with
 * no books anywhere below them are pruned, dotfiles are skipped, and symlinks
 * are ignored (readdir reports them as neither file nor directory), which also
 * rules out symlink cycles.
 */
function readFolderTree(folderPath, depth, budget) {
  const node = {
    path: folderPath,
    name: path.basename(folderPath) || folderPath,
    createdAt: statCreatedAt(folderPath),
    books: [],
    folders: [],
  };

  let entries;
  try {
    entries = fs.readdirSync(folderPath, { withFileTypes: true });
  } catch (e) {
    return node;
  }

  const subdirectories = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const entryPath = path.join(folderPath, entry.name);
    if (entry.isDirectory()) {
      subdirectories.push(entryPath);
    } else if (entry.isFile() && isSupportedFile(entry.name) && budget.remaining > 0) {
      budget.remaining--;
      node.books.push({
        filePath: entryPath,
        title: entry.name.replace(/\.[^.]+$/, ''),
        createdAt: statCreatedAt(entryPath),
      });
    }
  }

  if (depth < MAX_FOLDER_SCAN_DEPTH) {
    for (const subdirectory of subdirectories) {
      if (budget.remaining <= 0) break;
      const child = readFolderTree(subdirectory, depth + 1, budget);
      // Prune branches that hold no books at any depth.
      if (child.books.length > 0 || child.folders.length > 0) node.folders.push(child);
    }
  }

  return node;
}

function statCreatedAt(targetPath) {
  try {
    const stat = fs.statSync(targetPath);
    const created = stat.birthtimeMs || stat.mtimeMs;
    return Number.isFinite(created) ? created : 0;
  } catch (e) {
    return 0;
  }
}

function readBookFolder(folderPath) {
  return readFolderTree(folderPath, 0, { remaining: MAX_FOLDER_BOOKS });
}

// --- Book folder watching ---

// webContents id -> Map(folder path -> { watcher, timer })
const folderWatchersByWindow = new Map();

function stopFolderWatch(entry) {
  if (entry.timer) clearTimeout(entry.timer);
  try {
    entry.watcher.close();
  } catch (e) {
    // Already closed with its folder; nothing left to release.
  }
}

function stopFolderWatchers(rendererId) {
  const watchers = folderWatchersByWindow.get(rendererId);
  if (!watchers) return;
  for (const entry of watchers.values()) stopFolderWatch(entry);
  folderWatchersByWindow.delete(rendererId);
}

/**
 * Does a changed path under a library folder alter what the sidebar lists?
 *
 * Book folders collect plenty of noise — Calibre metadata, cover art, sync
 * lock files — and rescanning for those would walk the whole tree for nothing.
 * Extension-less names are treated as folders, which do change the listing.
 */
function affectsBookListing(filename) {
  if (!filename) return true; // the platform did not say what changed
  const base = path.basename(filename);
  if (base.startsWith('.')) return false; // dotfiles are never listed
  return isSupportedFile(base) || path.extname(base) === '';
}

/**
 * Watch one library folder and tell its window when what is under it changes.
 *
 * Finder copies and sync clients write in bursts, so events are debounced into
 * one notification per folder. Recursive watching is unavailable on Linux;
 * there we fall back to the folder itself, which still catches books added or
 * removed at its root.
 */
function watchBookFolder(webContents, folderPath) {
  let watcher;
  try {
    watcher = fs.watch(folderPath, { recursive: true });
  } catch (e) {
    try {
      watcher = fs.watch(folderPath);
    } catch (err) {
      return null; // unwatchable: gone, or a filesystem without notifications
    }
  }

  const entry = { watcher, timer: null };
  watcher.on('change', (eventType, filename) => {
    if (!affectsBookListing(filename)) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (!webContents.isDestroyed()) webContents.send('book-folder-changed', folderPath);
    }, FOLDER_CHANGE_DEBOUNCE_MS);
  });
  // A watcher dies with its folder. Drop it and leave the sidebar listing
  // alone; the renderer rescans on focus and can pick the folder back up.
  watcher.on('error', () => {
    const watchers = folderWatchersByWindow.get(webContents.id);
    if (watchers && watchers.get(folderPath) === entry) watchers.delete(folderPath);
    stopFolderWatch(entry);
  });
  return entry;
}

/** Watch exactly the folders a window's sidebar lists, and nothing else. */
function syncFolderWatchers(webContents, folderPaths) {
  let watchers = folderWatchersByWindow.get(webContents.id);
  if (!watchers) {
    watchers = new Map();
    folderWatchersByWindow.set(webContents.id, watchers);
  }

  for (const [folderPath, entry] of watchers) {
    if (folderPaths.includes(folderPath)) continue;
    stopFolderWatch(entry);
    watchers.delete(folderPath);
  }
  for (const folderPath of folderPaths) {
    if (watchers.has(folderPath)) continue;
    const entry = watchBookFolder(webContents, folderPath);
    if (entry) watchers.set(folderPath, entry);
  }
}

function isSafeExternalUrl(value) {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:'
      || protocol === 'mailto:' || protocol === 'tel:';
  } catch {
    return false;
  }
}


// --- Single Instance Lock ---
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine) => {
    // Process command line arguments for the second instance (Windows/Linux)
    const args = commandLine.slice(app.isPackaged ? 1 : 2);
    let openedBook = false;
    for (const arg of args) {
      if (isSupportedFile(arg)) {
        const resolved = path.resolve(arg);
        if (fs.existsSync(resolved)) {
          openFileInApp(resolved);
          openedBook = true;
        }
      }
    }

    if (!openedBook) {
      const win = getMainWindow() || createWindow();
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    }
  });
}

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const DEFAULT_MAIN_WINDOW_BOUNDS = { width: 1000, height: 800 };
let epubParserWorker = null;
let nextEpubParserRequestId = 1;
const epubParserRequests = new Map();

function rejectEpubParserRequests(error) {
  for (const { reject } of epubParserRequests.values()) reject(error);
  epubParserRequests.clear();
}

function getEpubParserWorker() {
  if (epubParserWorker) return epubParserWorker;
  const worker = new Worker(path.join(__dirname, 'lib', 'epub-parser-worker.js'));
  epubParserWorker = worker;
  worker.on('message', ({ id, result, error }) => {
    const request = epubParserRequests.get(id);
    if (!request) return;
    epubParserRequests.delete(id);
    if (error) {
      const parseError = new Error(error.message || 'Failed to parse EPUB');
      if (error.stack) parseError.stack = error.stack;
      request.reject(parseError);
    } else {
      request.resolve(result);
    }
  });
  worker.on('error', (error) => {
    if (epubParserWorker !== worker) return;
    epubParserWorker = null;
    rejectEpubParserRequests(error);
  });
  worker.on('exit', (code) => {
    if (epubParserWorker !== worker) return;
    epubParserWorker = null;
    if (epubParserRequests.size > 0) {
      rejectEpubParserRequests(new Error(`EPUB parser worker exited with code ${code}`));
    }
  });
  return worker;
}

function parseEpubOffMainThread(filePath) {
  return new Promise((resolve, reject) => {
    const id = nextEpubParserRequestId++;
    epubParserRequests.set(id, { resolve, reject });
    try {
      getEpubParserWorker().postMessage({ id, filePath });
    } catch (error) {
      epubParserRequests.delete(id);
      reject(error);
    }
  });
}

// --- Settings persistence ---
function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  const p = getSettingsPath();
  if (!fs.existsSync(p)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeSettings(data) {
  const settingsPath = getSettingsPath();
  const tempPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tempPath, settingsPath);
  } finally {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
  }
}

// iCloud Drive evicts files by replacing `/dir/Name.epub` with a placeholder
// at `/dir/.Name.epub.icloud`. Treat that as "still exists" so a transient
// offload doesn't drop the book from the user's tabs.
function pathExistsOrIcloudPlaceholder(p) {
  if (fs.existsSync(p)) return true;
  const dir = path.dirname(p);
  const base = path.basename(p);
  return fs.existsSync(path.join(dir, `.${base}.icloud`));
}

function isValidWindowBounds(bounds) {
  return bounds
    && Number.isInteger(bounds.x)
    && Number.isInteger(bounds.y)
    && Number.isInteger(bounds.width)
    && Number.isInteger(bounds.height)
    && bounds.width > 200
    && bounds.height > 200;
}

function saveMainWindowState(win) {
  if (!win || win.isDestroyed()) return;
  const settings = readSettings();
  settings.mainWindowBounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
  settings.mainWindowMaximized = win.isMaximized();
  writeSettings(settings);
}

let mainWindowStateSaveTimer = null;

function scheduleMainWindowStateSave(win) {
  if (mainWindowStateSaveTimer) {
    clearTimeout(mainWindowStateSaveTimer);
  }
  mainWindowStateSaveTimer = setTimeout(() => {
    saveMainWindowState(win);
    mainWindowStateSaveTimer = null;
  }, 200);
}

function broadcastToAllWindows(channel, ...args) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args);
  }
}

function getMobiCover(book, tempDir) {
  try {
    const coverPath = book.getCoverImage();
    if (coverPath && fs.existsSync(coverPath)) {
      return coverPath;
    }
  } catch (e) {
    console.error('Standard getCoverImage failed:', e);
  }
  try {
    const innerMobi = book.mobiFile;
    if (innerMobi && innerMobi.exth) {
      const exth = innerMobi.exth;
      const coverOffset = exth.coverOffset !== undefined && exth.coverOffset !== null ? Number(exth.coverOffset) : 4294967295;
      const thumbnailOffset = exth.thumbnailOffset !== undefined && exth.thumbnailOffset !== null ? Number(exth.thumbnailOffset) : 4294967295;
      
      const offset = coverOffset < 4294967295 ? coverOffset : thumbnailOffset < 4294967295 ? thumbnailOffset : undefined;
      
      if (offset !== undefined && offset !== null) {
        const res = innerMobi.loadResource(offset);
        if (res && res.raw) {
          const ext = res.type ? res.type.split('/').pop() : 'jpg';
          const coverFilename = `cover_fallback.${ext}`;
          const coverPath = path.join(tempDir, coverFilename);
          fs.writeFileSync(coverPath, res.raw);
          return coverPath;
        }
      }
    }
  } catch (e) {
    console.error('Fallback cover extraction failed:', e);
  }
  return null;
}

function getMimeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  return ext === 'svg' ? 'image/svg+xml'
    : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
    : ext === 'png' ? 'image/png'
    : ext === 'gif' ? 'image/gif'
    : ext === 'webp' ? 'image/webp'
    : 'image/png';
}

function extractIdFromSelector(selector) {
  if (!selector) return null;
  const match = selector.match(/\[id=["']?(.*?)["']?\]/);
  if (match) return match[1];
  if (selector.startsWith('#')) return selector.substring(1);
  return null;
}

function mapToc(tocItems, book) {
  if (!tocItems) return [];
  return tocItems.map(item => {
    let href = '';
    if (item.href) {
      const resolved = book.resolveHref(item.href);
      if (resolved) {
        const anchorId = extractIdFromSelector(resolved.selector);
        href = anchorId ? `${resolved.id}#${anchorId}` : resolved.id;
      } else {
        href = item.href;
      }
    }
    return {
      title: item.label || '',
      href: href,
      children: mapToc(item.children, book)
    };
  });
}

async function parseMobiOrAzw3(filePath) {
  const { initMobiFile, initKf8File } = await getMobiParser();
  const tempDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'gull-mobi-'));
  
  let book = null;
  let isKf = false;
  
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(120);
    fs.readSync(fd, buf, 0, 120, 0);
    const off = buf.readUInt32BE(78);
    const vBuf = Buffer.alloc(4);
    fs.readSync(fd, vBuf, 0, 4, off + 20);
    const version = vBuf.readUInt32BE(0);
    fs.closeSync(fd);
    
    isKf = version === 8 || version === 264 || version >= 8;
  } catch (e) {
    const ext = path.extname(filePath).toLowerCase();
    isKf = ext === '.azw3' || ext === '.azw';
  }
  
  try {
    if (isKf) {
      try {
        book = await initKf8File(filePath, tempDir);
      } catch (err) {
        console.warn('initKf8File failed, trying initMobiFile fallback:', err);
        book = await initMobiFile(filePath, tempDir);
        isKf = false;
      }
    } else {
      try {
        book = await initMobiFile(filePath, tempDir);
      } catch (err) {
        console.warn('initMobiFile failed, trying initKf8File fallback:', err);
        book = await initKf8File(filePath, tempDir);
        isKf = true;
      }
    }
  } catch (err) {
    console.error('Failed to initialize MOBI/KF8 reader:', err);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    throw err;
  }
  
  try {
    const metadata = book.getMetadata() || {};
    const title = metadata.title || path.basename(filePath, path.extname(filePath));
    const language = metadata.language || '';
    const identifier = String(metadata.asin || metadata.identifier || metadata.uniqueId || '');
    
    const spine = book.getSpine() || [];
    const chapters = [];
    
    for (const item of spine) {
      if (!item || !item.id) continue;
      const chapterData = await book.loadChapter(item.id);
      if (!chapterData) continue;
      
      let html = chapterData.html || '';
      const $ = cheerio.load(html, { xmlMode: true });
      sanitizePublicationDocument($);
      
      $('[style]').each((_, el) => {
        const $el = $(el);
        const style = $el.attr('style') || '';
        const cls = ($el.attr('class') || '').toLowerCase();
        const isDropCap = cls.includes('dropcap') || cls.includes('drop-cap');
        const cleaned = filterInlineStyle(style, isDropCap);
        if (cleaned) {
          $el.attr('style', cleaned);
        } else {
          $el.removeAttr('style');
        }
      });
      
      $('img, image').each((_, el) => {
        const $el = $(el);
        const src = $el.attr('src') || $el.attr('xlink:href') || $el.attr('href');
        if (!src || src.startsWith('data:')) return;
        
        const baseName = path.basename(src);
        const imgPath = path.join(tempDir, baseName);
        
        try {
          if (fs.existsSync(imgPath)) {
            const imgData = fs.readFileSync(imgPath);
            const mime = getMimeFromPath(baseName);
            const b64 = imgData.toString('base64');
            const dataUri = `data:${mime};base64,${b64}`;
            if (el.name === 'img') {
              $el.attr('src', dataUri);
            } else {
              $el.attr('href', dataUri);
              $el.attr('xlink:href', dataUri);
              $el.removeAttr('src');
            }
          }
        } catch (e) {
          console.error('Failed to inline MOBI image:', src, e);
        }
      });
      
      const body = $('body');
      const rawHtml = body.length ? body.html() : $.html();
      const cleanHtml = normalizeXhtmlFragment(rawHtml);
      
      chapters.push({
        id: item.id,
        href: item.id,
        html: cleanHtml,
        css: ''
      });
    }
    
    let cover = null;
    const coverPath = getMobiCover(book, tempDir);
    if (coverPath && fs.existsSync(coverPath)) {
      try {
        const coverData = fs.readFileSync(coverPath);
        const mime = getMimeFromPath(coverPath);
        
        try {
          const img = nativeImage.createFromBuffer(coverData);
          if (!img.isEmpty()) {
            const resized = img.resize({ height: 60, quality: 'better' });
            const jpegBuf = resized.toJPEG(80);
            cover = `data:image/jpeg;base64,${jpegBuf.toString('base64')}`;
          }
        } catch (resizeErr) {
          console.error('Failed to resize MOBI cover image', resizeErr);
        }
        
        if (!cover) {
          cover = `data:${mime};base64,${coverData.toString('base64')}`;
        }
      } catch (e) {
        console.error('Failed to read cover image', e);
      }
    }
    
    const rawToc = book.getToc() || [];
    const toc = mapToc(rawToc, book);
    
    return { title, language, identifier, chapters, toc, cover };
  } finally {
    if (book) {
      try { book.destroy(); } catch {}
    }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

// --- Window Management ---

let mainWindow = null;
let startupFiles = [];
const pendingFilesByWindow = new Map();
const bookWindows = new Map();

function getMainWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function getRendererPath(page) {
  return path.join(__dirname, 'dist', page);
}

function isTrustedRendererUrl(rawUrl) {
  try {
    if (DEV_SERVER_URL) {
      return new URL(rawUrl).origin === new URL(DEV_SERVER_URL).origin;
    }
    if (!rawUrl.startsWith('file:')) return false;
    return path.resolve(fileURLToPath(rawUrl)) === path.resolve(getRendererPath('index.html'));
  } catch {
    return false;
  }
}

function assertTrustedIpc(event) {
  const senderFrame = event.senderFrame;
  if (!senderFrame || senderFrame !== event.sender.mainFrame || !isTrustedRendererUrl(senderFrame.url)) {
    throw new Error('Rejected IPC from an untrusted frame');
  }
}

function validateRendererSetting(key, value) {
  const validator = RENDERER_SETTING_VALIDATORS[key];
  if (!validator || !validator(value)) {
    throw new Error(`Invalid renderer setting: ${String(key)}`);
  }
}

function createWindow({ bookFilePath = null } = {}) {
  const isBookWindow = Boolean(bookFilePath);
  const settings = readSettings();
  const savedBounds = settings.mainWindowBounds;
  const hasSavedBounds = isValidWindowBounds(savedBounds);
  const win = new BrowserWindow({
    width: hasSavedBounds ? savedBounds.width : DEFAULT_MAIN_WINDOW_BOUNDS.width,
    height: hasSavedBounds ? savedBounds.height : DEFAULT_MAIN_WINDOW_BOUNDS.height,
    minWidth: 500,
    minHeight: 530,
    x: hasSavedBounds ? savedBounds.x : undefined,
    y: hasSavedBounds ? savedBounds.y : undefined,
    title: isBookWindow
      ? path.basename(bookFilePath, path.extname(bookFilePath))
      : app.name,
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    trafficLightPosition: { x: 16, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  const rendererId = win.webContents.id;

  if (isBookWindow) {
    bookWindows.set(bookFilePath, win);
    pendingFilesByWindow.set(rendererId, [bookFilePath]);
  } else {
    mainWindow = win;
  }

  if (DEV_SERVER_URL) {
    const rendererUrl = new URL('index.html', `${DEV_SERVER_URL}/`);
    if (isBookWindow) rendererUrl.searchParams.set('standalone', '1');
    win.loadURL(rendererUrl.toString());
  } else {
    win.loadFile(
      getRendererPath('index.html'),
      isBookWindow ? { query: { standalone: '1' } } : undefined
    );
  }

  // The renderer is a single-page reader. Links are opened only through the
  // validated open-external IPC handler after an explicit content click.
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (!isBookWindow) {
    win.on('resize', () => scheduleMainWindowStateSave(win));
    win.on('move', () => scheduleMainWindowStateSave(win));
    win.on('close', () => {
      if (mainWindowStateSaveTimer) {
        clearTimeout(mainWindowStateSaveTimer);
        mainWindowStateSaveTimer = null;
      }
      saveMainWindowState(win);
    });
  }

  win.on('closed', () => {
    pendingFilesByWindow.delete(rendererId);
    stopFolderWatchers(rendererId);
    if (isBookWindow) {
      if (bookWindows.get(bookFilePath) === win) bookWindows.delete(bookFilePath);
    } else if (mainWindow === win) {
      mainWindow = null;
    }
  });

  if (!isBookWindow && settings.mainWindowMaximized) {
    win.maximize();
  }

  return win;
}

function openFileInApp(filePath) {
  if (!filePath || !isSupportedFile(filePath)) return;
  if (!fs.existsSync(filePath)) return;

  const resolved = path.resolve(filePath);
  const existingWindow = bookWindows.get(resolved);
  if (existingWindow && !existingWindow.isDestroyed()) {
    if (existingWindow.isMinimized()) existingWindow.restore();
    existingWindow.focus();
    return;
  }

  createWindow({ bookFilePath: resolved });
}

async function showOpenDialog() {
  const win = BrowserWindow.getFocusedWindow() || getMainWindow();
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'E-Books', extensions: ['epub', 'mobi', 'azw3', 'azw', 'prc'] },
      { name: 'EPUB Files', extensions: ['epub'] },
      { name: 'Kindle Files', extensions: ['mobi', 'azw3', 'azw', 'prc'] }
    ],
  });
  if (!result.canceled) {
    for (const filePath of result.filePaths) {
      openFileInApp(filePath);
    }
  }
}



function createAppMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: `About ${app.name}` },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'Open…',
          accelerator: 'CmdOrCtrl+O',
          click: () => showOpenDialog(),
        },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- Auto-update ---
function initAutoUpdater() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', (info) => {
    broadcastToAllWindows('update-ready', { version: info.version });
  });

  autoUpdater.on('error', (err) => {
    console.error('[autoUpdater]', err);
  });

  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 6 * 60 * 60 * 1000);
}

// --- macOS: handle file open before app is ready ---
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (!isSupportedFile(filePath) || !fs.existsSync(filePath)) return;
  if (app.isReady()) {
    openFileInApp(filePath);
  } else {
    if (!startupFiles.includes(filePath)) startupFiles.push(filePath);
  }
});

app.whenReady().then(() => {
  createAppMenu();



  ipcMain.handle('get-settings', (event) => {
    assertTrustedIpc(event);
    return readSettings();
  });

  ipcMain.on('get-settings-sync', (event) => {
    try {
      assertTrustedIpc(event);
      event.returnValue = readSettings();
    } catch {
      event.returnValue = {};
    }
  });

  ipcMain.handle('set-setting', (event, key, value) => {
    assertTrustedIpc(event);
    validateRendererSetting(key, value);
    const settings = readSettings();
    settings[key] = value;
    writeSettings(settings);
    broadcastToAllWindows('settings-changed', settings);
    if (key === 'theme') {
      broadcastToAllWindows('theme-changed', value);
    }
    if (key === 'chapterScrollbar') {
      broadcastToAllWindows('chapter-scrollbar-changed', value);
    }
    return settings;
  });

  // IPC: parse a book file by its path (supports epub, mobi, azw3)
  ipcMain.handle('parse-epub', async (event, filePath) => {
    assertTrustedIpc(event);
    validateBookPath(filePath);
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.epub') {
      return parseEpubOffMainThread(filePath);
    } else if (['.mobi', '.azw3', '.azw', '.prc'].includes(ext)) {
      return parseMobiOrAzw3(filePath);
    } else {
      throw new Error('Unsupported book format: ' + ext);
    }
  });

  ipcMain.handle('open-external', async (event, url) => {
    assertTrustedIpc(event);
    if (!isSafeExternalUrl(url)) throw new Error('Unsupported external URL');
    await shell.openExternal(url);
  });

  ipcMain.handle('apply-update', (event) => {
    assertTrustedIpc(event);
    if (!app.isPackaged) return;
    autoUpdater.quitAndInstall();
  });

  // IPC: native right-click menu for a sidebar folder or book row
  ipcMain.handle('show-sidebar-menu', async (event, payload) => {
    assertTrustedIpc(event);
    const targetPath = payload?.path;
    const isFolder = payload?.type === 'folder';
    if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) {
      throw new Error('Invalid sidebar menu target');
    }
    if (isFolder ? !fs.existsSync(targetPath) : !isSupportedFile(targetPath)) {
      throw new Error('Invalid sidebar menu target');
    }

    const win = BrowserWindow.fromWebContents(event.sender);
    return new Promise((resolve) => {
      let action = null;
      const template = [
        {
          label: 'Show in Finder',
          click: () => {
            action = 'reveal';
            shell.showItemInFolder(targetPath);
          },
        },
      ];
      if (!isFolder) {
        template.push(
          { type: 'separator' },
          {
            label: 'Mark as Finished',
            type: 'checkbox',
            checked: payload?.finished === true,
            click: () => { action = 'toggle-finished'; },
          }
        );
      }
      if (isFolder) {
        template.push(
          { type: 'separator' },
          { label: 'Expand All', click: () => { action = 'expand'; } },
          { label: 'Collapse All', click: () => { action = 'collapse'; } },
          { type: 'separator' },
          { label: 'Remove', click: () => { action = 'remove'; } }
        );
      }

      Menu.buildFromTemplate(template).popup({
        window: win,
        // The item's click handler runs just after the menu reports closing.
        callback: () => setTimeout(() => resolve(action), 0),
      });
    });
  });

  // IPC: native menu for the sidebar's sort control
  ipcMain.handle('show-sort-menu', async (event, current) => {
    assertTrustedIpc(event);
    const key = current?.key === 'created' ? 'created' : 'name';
    const direction = current?.direction === 'desc' ? 'desc' : 'asc';
    const foldersFirst = current?.foldersFirst !== false;
    const chosen = { key, direction, foldersFirst };
    let changed = false;

    const template = [
      { label: 'Name', type: 'radio', checked: key === 'name',
        click: () => { chosen.key = 'name'; changed = true; } },
      { label: 'Date Created', type: 'radio', checked: key === 'created',
        click: () => { chosen.key = 'created'; changed = true; } },
      { type: 'separator' },
      { label: 'Ascending', type: 'radio', checked: direction === 'asc',
        click: () => { chosen.direction = 'asc'; changed = true; } },
      { label: 'Descending', type: 'radio', checked: direction === 'desc',
        click: () => { chosen.direction = 'desc'; changed = true; } },
      { type: 'separator' },
      { label: 'Folders First', type: 'checkbox', checked: foldersFirst,
        click: () => { chosen.foldersFirst = !foldersFirst; changed = true; } },
    ];

    const win = BrowserWindow.fromWebContents(event.sender);
    const anchor = current?.anchor;
    return new Promise((resolve) => {
      Menu.buildFromTemplate(template).popup({
        window: win,
        x: Number.isFinite(anchor?.x) ? Math.round(anchor.x) : undefined,
        y: Number.isFinite(anchor?.y) ? Math.round(anchor.y) : undefined,
        callback: () => setTimeout(() => resolve(changed ? chosen : null), 0),
      });
    });
  });

  // IPC: pick a folder of books to list in the sidebar
  ipcMain.handle('select-book-folder', async (event) => {
    assertTrustedIpc(event);
    const win = BrowserWindow.fromWebContents(event.sender) || getMainWindow();
    const result = await dialog.showOpenDialog(win, {
      title: 'Add Book Folder',
      buttonLabel: 'Add Folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return readBookFolder(validateFolderPath(result.filePaths[0]));
  });

  // IPC: re-read a folder the user already added, so the sidebar tracks the disk
  ipcMain.handle('scan-book-folder', (event, folderPath) => {
    assertTrustedIpc(event);
    try {
      validateFolderPath(folderPath);
    } catch (e) {
      return null; // unmounted drive or deleted folder: keep the saved listing
    }
    return readBookFolder(folderPath);
  });

  // IPC: keep watching the folders the sidebar lists, so books added or deleted
  // outside Gull show up without a restart
  ipcMain.on('watch-book-folders', (event, folderPaths) => {
    assertTrustedIpc(event);
    if (!Array.isArray(folderPaths)) return;
    const watchable = [];
    for (const folderPath of folderPaths.slice(0, MAX_WATCHED_FOLDERS)) {
      try {
        watchable.push(validateFolderPath(folderPath));
      } catch (e) {
        // Deleted or unmounted: nothing to watch, the listing stays as saved.
      }
    }
    syncFolderWatchers(event.sender, watchable);
  });

  ipcMain.handle('check-paths-existence', (event, paths) => {
    assertTrustedIpc(event);
    if (!Array.isArray(paths)) return [];
    return paths.slice(0, MAX_PATH_CHECKS).map(p => ({
      path: p,
      exists: typeof p === 'string'
        && path.isAbsolute(p)
        && isSupportedFile(p)
        && pathExistsOrIcloudPlaceholder(p),
    }));
  });

  // Handle CLI args (e.g., `gull mybook.epub`)
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  for (const arg of args) {
    if (isSupportedFile(arg)) {
      const resolved = path.resolve(arg);
      if (fs.existsSync(resolved) && !startupFiles.includes(resolved)) startupFiles.push(resolved);
    }
  }

  ipcMain.on('renderer-ready', (event) => {
    assertTrustedIpc(event);
    const senderId = event.sender.id;
    for (const filePath of pendingFilesByWindow.get(senderId) || []) {
      event.sender.send('open-file', filePath);
    }
    pendingFilesByWindow.delete(senderId);
  });

  if (startupFiles.length === 0) createWindow();
  for (const filePath of startupFiles) openFileInApp(filePath);
  startupFiles = [];

  initAutoUpdater();

  app.on('activate', () => {
    if (!getMainWindow()) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  const worker = epubParserWorker;
  epubParserWorker = null;
  rejectEpubParserRequests(new Error('Application is quitting'));
  worker?.terminate();
});
