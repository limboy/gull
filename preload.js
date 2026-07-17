const { contextBridge, ipcRenderer, webUtils } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('epub', {
  parse: (filePath) => ipcRenderer.invoke('parse-epub', filePath),
  getCover: (filePath) => ipcRenderer.invoke('get-book-cover', filePath),
  getFilePath: (file) => webUtils.getPathForFile(file),
  onOpenFile: (cb) => subscribe('open-file', cb),
  signalReady: () => ipcRenderer.send('renderer-ready'),
  checkPathsExistence: (paths) => ipcRenderer.invoke('check-paths-existence', paths),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});

contextBridge.exposeInMainWorld('updater', {
  onUpdateReady: (cb) => subscribe('update-ready', cb),
  apply: () => ipcRenderer.invoke('apply-update'),
});

contextBridge.exposeInMainWorld('settings', {
  getAll: () => ipcRenderer.invoke('get-settings'),
  set: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  onSettingsChanged: (cb) => subscribe('settings-changed', cb),
  onThemeChanged: (cb) => subscribe('theme-changed', cb),
  onChapterScrollbarChanged: (cb) => subscribe('chapter-scrollbar-changed', cb),
});

contextBridge.exposeInMainWorld('initialSettings', ipcRenderer.sendSync('get-settings-sync'));
