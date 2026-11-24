// Registered on the in-memory session with session.setPreloads(), so every app gets window.clean
// without touching its own preload.js. (Sandboxed preloads may only require electron.)
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('clean', {
  log: (level, msg) => ipcRenderer.send('clean:log', level, msg),
  onLog: (cb) => ipcRenderer.on('clean:logline', (_e, entry) => cb(entry)),
  backlog: () => ipcRenderer.invoke('clean:backlog'),
  win: (what) => ipcRenderer.send('clean:win', what),
  fsRoots: () => ipcRenderer.invoke('fs-roots'),
  fsList: (dir) => ipcRenderer.invoke('fs-list', dir),
  fsExists: (p) => ipcRenderer.invoke('fs-exists', p),
  pathForFile: (file) => webUtils.getPathForFile(file),
});
