const { app, BrowserWindow, ipcMain, Menu, dialog, nativeTheme, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const cheerio = require('cheerio');

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
      if (arg.toLowerCase().endsWith('.epub')) {
        const resolved = path.resolve(arg);
        if (fs.existsSync(resolved)) {
          openFileInApp(resolved);
        }
      }
    }
  });
}

const APP_LOGO_PATH = path.join(__dirname, 'logo.png');
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const DEFAULT_MAIN_WINDOW_BOUNDS = { width: 1000, height: 800 };

function setMacDockIcon() {
  if (process.platform !== 'darwin' || !app.dock) return;
  if (!fs.existsSync(APP_LOGO_PATH)) return;
  const dockIcon = nativeImage.createFromPath(APP_LOGO_PATH);
  if (!dockIcon.isEmpty()) {
    app.dock.setIcon(dockIcon);
  }
}

// --- Settings persistence ---
function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  const p = getSettingsPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

function writeSettings(data) {
  fs.writeFileSync(getSettingsPath(), JSON.stringify(data, null, 2));
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

function broadcastSettings(settings) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('settings-changed', settings);
  }
}

// --- EPUB Parsing ---

function parseToc(zip, opfDir, manifest, $opf) {
  const navItem = Object.values(manifest).find(m => m.properties.includes('nav'));
  if (navItem) {
    try {
      const navXhtml = zip.readAsText(opfDir + navItem.href);
      const $ = cheerio.load(navXhtml, { xmlMode: true });
      const navEl = $('nav[*|type="toc"], nav[epub\\:type="toc"], nav').first();
      if (navEl.length) {
        return parseNavOl(navEl.children('ol').first(), $);
      }
    } catch {
      // fall through to NCX
    }
  }

  const tocId = $opf('spine').attr('toc');
  const ncxItem = tocId ? manifest[tocId] : Object.values(manifest).find(m => m.mediaType === 'application/x-dtbncx+xml');
  if (ncxItem) {
    try {
      const ncxXml = zip.readAsText(opfDir + ncxItem.href);
      const $ = cheerio.load(ncxXml, { xmlMode: true });
      return parseNcxNavMap($('navMap').first(), $);
    } catch {
      // no TOC
    }
  }

  return [];
}

function parseNavOl(ol, $) {
  const items = [];
  ol.children('li').each((_, li) => {
    const $li = $(li);
    const a = $li.children('a').first();
    const title = a.text().trim();
    const href = a.attr('href') || '';
    const childOl = $li.children('ol').first();
    const children = childOl.length ? parseNavOl(childOl, $) : [];
    if (title) items.push({ title, href, children });
  });
  return items;
}

function parseNcxNavMap(navMap, $) {
  const items = [];
  navMap.children('navPoint').each((_, np) => {
    const $np = $(np);
    const title = $np.children('navLabel').first().find('text').first().text().trim();
    const href = $np.children('content').first().attr('src') || '';
    const children = parseNcxNavMap($np, $);
    if (title) items.push({ title, href, children });
  });
  return items;
}

// Properties to strip from EPUB CSS.
// We intentionally ignore book-defined line metrics and positioned text layout
// because this reader reflows content using its own typography controls.
const STRIP_CSS_PROPS = new Set([
  'font-family', 'color', 'background', 'background-color',
  'background-image', 'border-color',
  'font-size', 'line-height',
  'position', 'top', 'right', 'bottom', 'left',
  'inset', 'inset-block', 'inset-block-start', 'inset-block-end',
  'inset-inline', 'inset-inline-start', 'inset-inline-end',
  'transform',
]);

const HTML_VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img',
  'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

function filterInlineStyle(style, preserveMetrics = false) {
  return style
    .split(';')
    .map(s => s.trim())
    .filter(s => {
      const prop = s.split(':')[0]?.trim().toLowerCase();
      if (!prop) return false;
      if (preserveMetrics && (prop === 'font-size' || prop === 'line-height')) {
        return true;
      }
      return !STRIP_CSS_PROPS.has(prop);
    })
    .join('; ');
}

function filterEpubCss(css) {
  // Simple CSS property filter: process declaration blocks and strip conflicting properties.
  // Handles nested @-rules like @media by working on individual declarations.
  return css.replace(/([^{]*)\{([^}]*)\}/g, (match, selector, block) => {
    const isDropCap = selector.toLowerCase().includes('dropcap') || selector.toLowerCase().includes('drop-cap');
    const filtered = block
      .split(';')
      .map(s => s.trim())
      .filter(s => {
        const prop = s.split(':')[0]?.trim().toLowerCase();
        if (!prop) return false;
        if (isDropCap && (prop === 'font-size' || prop === 'line-height')) {
          return true;
        }
        return !STRIP_CSS_PROPS.has(prop);
      })
      .join(';\n  ');
    return filtered ? `${selector}{ ${filtered}; }` : '';
  });
}

function normalizeXhtmlFragment(html) {
  // Cheerio preserves XHTML self-closing syntax like <div />.
  // When injected via innerHTML into the HTML renderer, non-void tags do not self-close
  // and can swallow the rest of the chapter, collapsing section layout.
  return html.replace(
    /<([a-zA-Z][\w:-]*)(\s[^<>]*?)?\s*\/>/g,
    (match, tagName, attrs = '') => {
      if (HTML_VOID_TAGS.has(tagName.toLowerCase())) {
        return `<${tagName}${attrs}>`;
      }
      return `<${tagName}${attrs}></${tagName}>`;
    }
  );
}

function parseEpub(epubPath) {
  const zip = new AdmZip(epubPath);

  const containerXml = zip.readAsText('META-INF/container.xml');
  const $container = cheerio.load(containerXml, { xmlMode: true });
  const opfPath = $container('rootfile').attr('full-path');
  const opfDir = path.dirname(opfPath) === '.' ? '' : path.dirname(opfPath) + '/';

  const opfXml = zip.readAsText(opfPath);
  const $opf = cheerio.load(opfXml, { xmlMode: true });

  // Build manifest map
  const manifest = {};
  $opf('manifest item').each((_, el) => {
    const $el = $opf(el);
    manifest[$el.attr('id')] = {
      href: $el.attr('href'),
      mediaType: $el.attr('media-type'),
      properties: $el.attr('properties') || '',
    };
  });

  // Spine order
  const spine = [];
  $opf('spine itemref').each((_, el) => {
    spine.push($opf(el).attr('idref'));
  });

  // Parse TOC
  const toc = parseToc(zip, opfDir, manifest, $opf);

  // Extract book title
  const title = $opf('metadata dc\\:title, metadata title').first().text().trim()
    || path.basename(epubPath, '.epub');

  // Process chapters
  const chapters = [];
  for (const idref of spine) {
    const item = manifest[idref];
    if (!item) continue;
    const chapterPath = opfDir + item.href;
    let xhtml;
    try {
      xhtml = zip.readAsText(chapterPath);
    } catch {
      continue;
    }
    const chapterDir = path.dirname(chapterPath);
    const $ = cheerio.load(xhtml, { xmlMode: true });

    // Collect CSS from linked stylesheets and inline <style> blocks,
    // filter out properties that conflict with our reader theme
    let collectedCss = '';

    $('link[rel="stylesheet"]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const cssPath = path.posix.normalize(chapterDir + '/' + href);
      try {
        collectedCss += zip.readAsText(cssPath) + '\n';
      } catch {}
    });
    $('style').each((_, el) => {
      collectedCss += $(el).html() + '\n';
    });

    // Remove original stylesheet refs
    $('link[rel="stylesheet"], style').remove();

    // Filter and scope CSS to this chapter's container
    let chapterCss = '';
    if (collectedCss.trim()) {
      chapterCss = filterEpubCss(collectedCss);
    }

    // Strip conflicting inline styles, keep layout/formatting ones
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

    // Convert images to base64 data URIs
    $('img, image').each((_, el) => {
      const $el = $(el);
      const src = $el.attr('src') || $el.attr('xlink:href') || $el.attr('href');
      if (!src || src.startsWith('data:')) return;
      const imgPath = path.posix.normalize(chapterDir + '/' + src);
      try {
        const imgData = zip.readFile(imgPath);
        if (imgData) {
          const ext = path.extname(src).toLowerCase().replace('.', '');
          const mime = ext === 'svg' ? 'image/svg+xml'
            : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
            : ext === 'png' ? 'image/png'
            : ext === 'gif' ? 'image/gif'
            : ext === 'webp' ? 'image/webp'
            : 'image/png';
          const b64 = imgData.toString('base64');
          const dataUri = `data:${mime};base64,${b64}`;
          if (el.name === 'img') {
            $el.attr('src', dataUri);
          } else {
            // SVG image uses href or xlink:href
            $el.attr('href', dataUri);
            $el.attr('xlink:href', dataUri);
            // Also remove any src attribute that might have been mistakenly added
            $el.removeAttr('src');
          }
        }
      } catch {
        // skip missing images
      }
    });

    const body = $('body');
    const rawHtml = body.length ? body.html() : $.html();
    const html = normalizeXhtmlFragment(rawHtml);
    chapters.push({ id: idref, href: item.href, html, css: chapterCss });
  }

  return { title, chapters, toc };
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

function createWindow() {
  const settings = readSettings();
  const savedBounds = settings.mainWindowBounds;
  const hasSavedBounds = isValidWindowBounds(savedBounds);
  const win = new BrowserWindow({
    width: hasSavedBounds ? savedBounds.width : DEFAULT_MAIN_WINDOW_BOUNDS.width,
    height: hasSavedBounds ? savedBounds.height : DEFAULT_MAIN_WINDOW_BOUNDS.height,
    x: hasSavedBounds ? savedBounds.x : undefined,
    y: hasSavedBounds ? savedBounds.y : undefined,
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    trafficLightPosition: { x: 16, y: 12 },
    icon: fs.existsSync(APP_LOGO_PATH) ? APP_LOGO_PATH : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
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

  // Prevent internal navigation (e.g. from link clicks that aren't intercepted)
  // which can lead to a white screen in this SPA-style app.
  win.webContents.on('will-navigate', (event, url) => {
    const isDev = DEV_SERVER_URL && url.startsWith(DEV_SERVER_URL);
    if (!isDev && url !== win.webContents.getURL()) {
      event.preventDefault();
      // If it's an external link, we could open it in the system browser here,
      // but setWindowOpenHandler handles most cases.
      if (url.startsWith('http:') || url.startsWith('https:')) {
        require('electron').shell.openExternal(url);
      }
    }
  });

  // Open external links in the default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      require('electron').shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

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
  if (!filePath || !filePath.toLowerCase().endsWith('.epub')) return;
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
    filters: [{ name: 'EPUB Files', extensions: ['epub'] }],
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
        { role: 'about' },
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
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- macOS: handle file open before app is ready ---
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (app.isReady()) {
    openFileInApp(filePath);
  } else {
    pendingFiles.push(filePath);
  }
});

app.whenReady().then(() => {
  setMacDockIcon();

  createAppMenu();



  ipcMain.handle('get-settings', () => {
    return readSettings();
  });

  ipcMain.handle('set-setting', (_event, key, value) => {
    const settings = readSettings();
    settings[key] = value;
    writeSettings(settings);
    broadcastSettings(settings);
    if (key === 'theme') {
      broadcastToAllWindows('theme-changed', value);
    }
    return settings;
  });

  // IPC: parse an EPUB file by its path
  ipcMain.handle('parse-epub', (_event, filePath) => {
    return parseEpub(filePath);
  });

  ipcMain.handle('check-paths-existence', (_event, paths) => {
    if (!Array.isArray(paths)) return [];
    return paths.map(p => ({ path: p, exists: fs.existsSync(p) }));
  });

  // Handle CLI args (e.g., `gull mybook.epub`)
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  for (const arg of args) {
    if (arg.toLowerCase().endsWith('.epub')) {
      const resolved = path.resolve(arg);
      if (fs.existsSync(resolved)) {
        pendingFiles.push(resolved);
      }
    }
  }

  ipcMain.on('renderer-ready', () => {
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
