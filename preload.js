const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('epub', {
  parse: (filePath) => ipcRenderer.invoke('parse-epub', filePath),
  getFilePath: (file) => webUtils.getPathForFile(file),
  onOpenFile: (cb) => {
    ipcRenderer.on('open-file', (_e, filePath) => cb(filePath));
  },
});

contextBridge.exposeInMainWorld('settings', {
  open: () => ipcRenderer.send('open-settings'),
  getAll: () => ipcRenderer.invoke('get-settings'),
  set: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  onThemeChanged: (cb) => {
    ipcRenderer.on('theme-changed', (_e, theme) => cb(theme));
  },
});
