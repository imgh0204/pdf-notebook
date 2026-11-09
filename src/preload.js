const { contextBridge, ipcRenderer } = require('electron');

// Library calls resolve with the value, or reject with an Error whose `code` says what went wrong.
const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args).then((r) => {
  if (r.ok) return r.value;
  throw Object.assign(new Error(r.message), { code: r.code });
});

contextBridge.exposeInMainWorld('desktop', {
  getInitialFile: () => ipcRenderer.invoke('get-initial-file'),
  savePdf: (filename, data) => ipcRenderer.invoke('save-pdf', filename, data),
  onOpenFile: (callback) => ipcRenderer.on('open-file', (_event, file) => callback(file)),
  clip: {
    readText: () => ipcRenderer.invoke('clip:read-text'),
    writeText: (text) => ipcRenderer.invoke('clip:write-text', text),
  },
  lib: {
    info: () => call('lib:info'),
    chooseRoot: (current) => call('lib:choose-root', current),
    setRoot: (dir) => call('lib:set-root', dir),
    scan: () => call('lib:scan'),
    mkdir: (parentRel, name) => call('lib:mkdir', parentRel, name),
    rename: (rel, isDoc, name) => call('lib:rename', rel, isDoc, name),
    move: (rel, isDoc, destRel) => call('lib:move', rel, isDoc, destRel),
    trash: (rel, isDoc) => call('lib:trash', rel, isDoc),
    importDialog: (destRel) => call('lib:import-dialog', destRel),
    importData: (destRel, filename, data, notes) => call('lib:import-data', destRel, filename, data, notes),
    read: (rel) => call('lib:read', rel),
    writeNotes: (rel, notes) => call('lib:write-notes', rel, notes),
    writeNotesSync: (rel, notes) => ipcRenderer.sendSync('lib:write-notes-sync', rel, notes),
    reveal: (rel, isDoc) => call('lib:reveal', rel, isDoc),
  },
});
