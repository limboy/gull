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
    // Someone tried to run a second instance, we should focus our window.
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    
    // Process command line arguments for the second instance (Windows/Linux)
    const args = commandLine.slice(app.isPackaged ? 1 : 2);
    for (const arg of args) {
      if (isSupportedFile(arg)) {
        const resolved = path.resolve(arg);
        if (fs.existsSync(resolved)) {
          openFileInApp(resolved);
        }
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

function getCoverThumbnail(zip, $opf, opfDir) {
  // 1. Look for item with property "cover-image"
  let coverItem = null;
  $opf('manifest item').each((_, el) => {
    const $el = $opf(el);
    const props = $el.attr('properties') || '';
    if (props.split(/\s+/).includes('cover-image')) {
      coverItem = {
        href: $el.attr('href'),
        mediaType: $el.attr('media-type')
      };
    }
  });

  // 2. Fallback to <meta name="cover" content="..." />
  if (!coverItem) {
    const coverMeta = $opf('metadata meta[name="cover"]').attr('content');
    if (coverMeta) {
      const item = $opf(`manifest item[id="${coverMeta}"]`);
      if (item.length) {
        coverItem = {
          href: item.attr('href'),
          mediaType: item.attr('media-type')
        };
      }
    }
  }

  // 3. Fallback: search manifest for items containing "cover" in their id or href
  if (!coverItem) {
    $opf('manifest item').each((_, el) => {
      const $el = $opf(el);
      const id = $el.attr('id') || '';
      const href = $el.attr('href') || '';
      const mediaType = $el.attr('media-type') || '';
      if (mediaType.startsWith('image/')) {
        if (id.toLowerCase().includes('cover') || href.toLowerCase().includes('cover')) {
          coverItem = { href, mediaType };
        }
      }
    });
  }

  if (coverItem) {
    const imgPath = path.posix.normalize(opfDir + coverItem.href);
    try {
      const imgData = zip.readFile(imgPath);
      if (imgData) {
        const ext = path.extname(coverItem.href).toLowerCase().replace('.', '');
        const mime = coverItem.mediaType || (ext === 'svg' ? 'image/svg+xml'
          : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
          : ext === 'png' ? 'image/png'
          : ext === 'gif' ? 'image/gif'
          : ext === 'webp' ? 'image/webp'
          : 'image/png');

        if (mime === 'image/svg+xml') {
          const b64 = imgData.toString('base64');
          return `data:${mime};base64,${b64}`;
        }

        try {
          const img = nativeImage.createFromBuffer(imgData);
          if (!img.isEmpty()) {
            // Resize to height 60px to keep it extremely small for localStorage.
            const resized = img.resize({ height: 60, quality: 'better' });
            const jpegBuf = resized.toJPEG(80);
            return `data:image/jpeg;base64,${jpegBuf.toString('base64')}`;
          }
        } catch (resizeErr) {
          console.error('Failed to resize cover image', resizeErr);
        }

        const b64 = imgData.toString('base64');
        return `data:${mime};base64,${b64}`;
      }
    } catch (e) {
      console.error('Failed to read cover image', e);
    }
  }
  return null;
}

async function getBookCover(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.epub') {
    try {
      const zip = new AdmZip(filePath);
      const containerXml = zip.readAsText('META-INF/container.xml');
      const $container = cheerio.load(containerXml, { xmlMode: true });
      const opfPath = $container('rootfile').attr('full-path');
      const opfDir = path.dirname(opfPath) === '.' ? '' : path.dirname(opfPath) + '/';

      const opfXml = zip.readAsText(opfPath);
      const $opf = cheerio.load(opfXml, { xmlMode: true });

      return getCoverThumbnail(zip, $opf, opfDir);
    } catch (e) {
      console.error('Failed to get book cover', e);
      return null;
    }
  } else if (['.mobi', '.azw3', '.azw', '.prc'].includes(ext)) {
    const tempDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'gull-cover-'));
    let book = null;
    try {
      const { initMobiFile, initKf8File } = await getMobiParser();
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
        isKf = ext === '.azw3' || ext === '.azw';
      }

      if (isKf) {
        try { book = await initKf8File(filePath, tempDir); }
        catch { book = await initMobiFile(filePath, tempDir); }
      } else {
        try { book = await initMobiFile(filePath, tempDir); }
        catch { book = await initKf8File(filePath, tempDir); }
      }

      const coverPath = getMobiCover(book, tempDir);
      let coverDataUri = null;
      if (coverPath && fs.existsSync(coverPath)) {
        const coverData = fs.readFileSync(coverPath);
        const mime = getMimeFromPath(coverPath);
        
        try {
          const img = nativeImage.createFromBuffer(coverData);
          if (!img.isEmpty()) {
            const resized = img.resize({ height: 60, quality: 'better' });
            const jpegBuf = resized.toJPEG(80);
            coverDataUri = `data:image/jpeg;base64,${jpegBuf.toString('base64')}`;
          }
        } catch (resizeErr) {
          console.error('Failed to resize MOBI cover image', resizeErr);
        }
        
        if (!coverDataUri) {
          coverDataUri = `data:${mime};base64,${coverData.toString('base64')}`;
        }
      }
      return coverDataUri;
    } catch (e) {
      console.error('Failed to get MOBI book cover', e);
      return null;
    } finally {
      if (book) {
        try { book.destroy(); } catch {}
      }
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  }
  return null;
}

let mobiParserModule = null;
async function getMobiParser() {
  if (!mobiParserModule) {
    mobiParserModule = await import('@lingo-reader/mobi-parser');
  }
  return mobiParserModule;
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

// State to track if the renderer is ready to receive files
let rendererReady = false;
let pendingFiles = [];

function getMainWindow() {
  return BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
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

function createWindow() {
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

  if (DEV_SERVER_URL) {
    win.loadURL(new URL('index.html', `${DEV_SERVER_URL}/`).toString());
  } else {
    win.loadFile(getRendererPath('index.html'));
  }

  win.webContents.on('did-finish-load', () => {
    // We no longer send pending files here, as we wait for 'renderer-ready'
  });

  // The renderer is a single-page reader. Links are opened only through the
  // validated open-external IPC handler after an explicit content click.
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.on('resize', () => scheduleMainWindowStateSave(win));
  win.on('move', () => scheduleMainWindowStateSave(win));
  win.on('close', () => {
    if (mainWindowStateSaveTimer) {
      clearTimeout(mainWindowStateSaveTimer);
      mainWindowStateSaveTimer = null;
    }
    saveMainWindowState(win);
    rendererReady = false;
  });

  if (settings.mainWindowMaximized) {
    win.maximize();
  }

  return win;
}

function openFileInApp(filePath) {
  if (!filePath || !isSupportedFile(filePath)) return;
  if (!fs.existsSync(filePath)) return;

  const win = getMainWindow();
  if (win) {
    if (rendererReady) {
      win.webContents.send('open-file', filePath);
    } else {
      if (!pendingFiles.includes(filePath)) {
        pendingFiles.push(filePath);
      }
    }
    if (win.isMinimized()) win.restore();
    win.focus();
  } else {
    if (!pendingFiles.includes(filePath)) {
      pendingFiles.push(filePath);
    }
    createWindow();
  }
}

async function showOpenDialog() {
  const win = getMainWindow();
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
    pendingFiles.push(filePath);
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
      const parsed = await parseEpubOffMainThread(filePath);
      parsed.cover = await getBookCover(filePath);
      return parsed;
    } else if (['.mobi', '.azw3', '.azw', '.prc'].includes(ext)) {
      return parseMobiOrAzw3(filePath);
    } else {
      throw new Error('Unsupported book format: ' + ext);
    }
  });

  // IPC: get a book's cover image by its path
  ipcMain.handle('get-book-cover', (event, filePath) => {
    assertTrustedIpc(event);
    validateBookPath(filePath);
    return getBookCover(filePath);
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
      if (fs.existsSync(resolved)) {
        pendingFiles.push(resolved);
      }
    }
  }

  ipcMain.on('renderer-ready', (event) => {
    assertTrustedIpc(event);
    rendererReady = true;
    const win = getMainWindow();
    if (win) {
      for (const filePath of pendingFiles) {
        win.webContents.send('open-file', filePath);
      }
    }
    pendingFiles = [];
  });

  createWindow();

  initAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
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
