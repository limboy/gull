const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('versions', {
  node: () => process.versions.node,
  chrome: () => process.versions.chrome,
  electron: () => process.versions.electron,
});

contextBridge.exposeInMainWorld('books', {
  getAll: () => ipcRenderer.invoke('get-books'),
  import: (paths) => ipcRenderer.invoke('import-books', paths),
  delete: (id) => ipcRenderer.invoke('delete-book', id),
  getFilePath: (file) => webUtils.getPathForFile(file),
});
