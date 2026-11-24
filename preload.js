const { contextBridge, ipcRenderer } = require('electron');

// window.clean (file browser, dropped-file paths, window controls, log) comes from clean/preload.js
contextBridge.exposeInMainWorld('api', {
  defaults: () => ipcRenderer.invoke('defaults'),
  statPaths: (paths) => ipcRenderer.invoke('stat-paths', paths),
  makeDir: (dir) => ipcRenderer.invoke('make-dir', dir),
  run: (inputs, opts) => ipcRenderer.invoke('run', inputs, opts),
  cancel: () => ipcRenderer.send('cancel'),
  cancelOne: (id) => ipcRenderer.send('cancel-one', id),
  onEvent: (cb) => ipcRenderer.on('ev', (_e, ev) => cb(ev)),
});
