const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('versions', {
  node: () => process.versions.node,
  chrome: () => process.versions.chrome,
  electron: () => process.versions.electron,
});

contextBridge.exposeInMainWorld('settings', {
  open: () => ipcRenderer.send('open-settings'),
});

contextBridge.exposeInMainWorld('books', {
  getAll: () => ipcRenderer.invoke('get-books'),
  import: (paths) => ipcRenderer.invoke('import-books', paths),
  delete: (id) => ipcRenderer.invoke('delete-book', id),
  open: (id) => ipcRenderer.invoke('open-book', id),
  getFilePath: (file) => webUtils.getPathForFile(file),
  showContextMenu: (id) => ipcRenderer.send('show-book-context-menu', id),
  onStatusUpdated: (cb) => {
    ipcRenderer.on('book-status-updated', (_e, id, status) => cb(id, status));
  },
  onDeleteRequested: (cb) => {
    ipcRenderer.on('book-delete-requested', (_e, id) => cb(id));
  },
});
