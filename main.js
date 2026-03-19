const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function getBooksDir() {
  const dir = path.join(app.getPath('userData'), 'books');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getMetadataPath() {
  return path.join(app.getPath('userData'), 'books.json');
}

function readMetadata() {
  const p = getMetadataPath();
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return [];
  }
}

function writeMetadata(data) {
  fs.writeFileSync(getMetadataPath(), JSON.stringify(data, null, 2));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadFile('index.html');
}

app.whenReady().then(() => {
  // IPC handlers
  ipcMain.handle('get-books', () => {
    return readMetadata();
  });

  ipcMain.handle('import-books', (_event, filePaths) => {
    const metadata = readMetadata();
    const booksDir = getBooksDir();

    for (const filePath of filePaths) {
      if (!filePath.toLowerCase().endsWith('.epub')) continue;

      const id = crypto.randomUUID();
      const filename = id + '.epub';
      const dest = path.join(booksDir, filename);
      const title = path.basename(filePath, path.extname(filePath));

      fs.copyFileSync(filePath, dest);
      metadata.push({ id, title, filename, addedAt: new Date().toISOString() });
    }

    writeMetadata(metadata);
    return metadata;
  });

  ipcMain.handle('delete-book', (_event, id) => {
    let metadata = readMetadata();
    const entry = metadata.find(b => b.id === id);
    if (entry) {
      const filePath = path.join(getBooksDir(), entry.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      metadata = metadata.filter(b => b.id !== id);
      writeMetadata(metadata);
    }
    return metadata;
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
