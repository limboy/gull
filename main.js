const { app, BrowserWindow, ipcMain, Menu, dialog, nativeTheme, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const cheerio = require('cheerio');

const APP_LOGO_PATH = path.join(__dirname, 'logo.png');
const APP_DOCK_ICON_PATH = path.join(__dirname, 'logo-dock.png');
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

function setMacDockIcon() {
  if (process.platform !== 'darwin' || !app.dock) return;
  const dockIconPath = fs.existsSync(APP_DOCK_ICON_PATH) ? APP_DOCK_ICON_PATH : APP_LOGO_PATH;
  if (!fs.existsSync(dockIconPath)) return;
  const dockIcon = nativeImage.createFromPath(dockIconPath);
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

function broadcastToAllWindows(channel, ...args) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.getURL().includes('settings.html')) continue;
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

// Properties to strip from EPUB CSS (conflict with reader theme)
const STRIP_CSS_PROPS = new Set([
  'font-family', 'color', 'background', 'background-color',
  'background-image', 'border-color',
]);

function filterInlineStyle(style) {
  return style
    .split(';')
    .map(s => s.trim())
    .filter(s => {
      const prop = s.split(':')[0]?.trim().toLowerCase();
      return prop && !STRIP_CSS_PROPS.has(prop);
    })
    .join('; ');
}

function filterEpubCss(css) {
  // Simple CSS property filter: process declaration blocks and strip conflicting properties.
  // Handles nested @-rules like @media by working on individual declarations.
  return css.replace(/\{([^}]*)\}/g, (match, block) => {
    const filtered = block
      .split(';')
      .map(s => s.trim())
      .filter(s => {
        const prop = s.split(':')[0]?.trim().toLowerCase();
        return prop && !STRIP_CSS_PROPS.has(prop);
      })
      .join(';\n  ');
    return filtered ? `{ ${filtered}; }` : '{ }';
  });
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
      const cleaned = filterInlineStyle(style);
      if (cleaned) {
        $el.attr('style', cleaned);
      } else {
        $el.removeAttr('style');
      }
    });

    // Convert images to base64 data URIs
    $('img, image').each((_, el) => {
      const $el = $(el);
      const src = $el.attr('src') || $el.attr('xlink:href');
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
          $el.attr('src', `data:${mime};base64,${b64}`);
        }
      } catch {
        // skip missing images
      }
    });

    const body = $('body');
    const html = body.length ? body.html() : $.html();
    chapters.push({ id: idref, href: item.href, html, css: chapterCss });
  }

  return { title, chapters, toc };
}

// --- Window Management ---

let settingsWindow = null;
// Queue of file paths to open once the main window is ready
let pendingFiles = [];

function getMainWindow() {
  return BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w !== settingsWindow);
}

function getRendererPath(page) {
  return path.join(__dirname, 'dist', page);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 800,
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
    // Open any files that were queued before the window was ready
    for (const filePath of pendingFiles) {
      win.webContents.send('open-file', filePath);
    }
    pendingFiles = [];
  });

  return win;
}

function openFileInApp(filePath) {
  if (!filePath || !filePath.toLowerCase().endsWith('.epub')) return;
  if (!fs.existsSync(filePath)) return;

  const win = getMainWindow();
  if (win) {
    win.webContents.send('open-file', filePath);
    win.focus();
  } else {
    pendingFiles.push(filePath);
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

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  const currentTheme = readSettings().theme || 'dark';
  settingsWindow = new BrowserWindow({
    width: 660,
    height: 480,
    show: false,
    resizable: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: currentTheme === 'light' ? '#ffffff' : '#1e1e1e',
    icon: fs.existsSync(APP_LOGO_PATH) ? APP_LOGO_PATH : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (DEV_SERVER_URL) {
    settingsWindow.loadURL(new URL('settings.html', `${DEV_SERVER_URL}/`).toString());
  } else {
    settingsWindow.loadFile(getRendererPath('settings.html'));
  }
  settingsWindow.once('ready-to-show', () => {
    settingsWindow.show();
  });
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

function createAppMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => openSettings(),
        },
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

  // IPC: settings
  ipcMain.on('open-settings', () => {
    openSettings();
  });

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

  createWindow();

  // Handle CLI args (e.g., `yara mybook.epub`)
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  for (const arg of args) {
    if (arg.toLowerCase().endsWith('.epub')) {
      const resolved = path.resolve(arg);
      if (fs.existsSync(resolved)) {
        pendingFiles.push(resolved);
      }
    }
  }

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
