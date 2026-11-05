const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getInitialFile: () => ipcRenderer.invoke('get-initial-file'),
  savePdf: (filename, data) => ipcRenderer.invoke('save-pdf', filename, data),
  confirmDiscard: () => ipcRenderer.invoke('confirm-discard'),
  onOpenFile: (callback) => ipcRenderer.on('open-file', (_event, file) => callback(file)),
});
