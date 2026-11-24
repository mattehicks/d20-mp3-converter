// For windows that run with nodeIntegration and no preload (they cannot use clean/preload.js, which needs
// contextIsolation). Provides the same window.clean API on top of ipcRenderer. Load it before picker.js / ui.js.
// Wrapped in a function so it declares no globals (the host page often declares ipcRenderer itself).
(function () {
  const { ipcRenderer, webUtils } = require('electron');

  window.clean = {
    log: (level, msg) => ipcRenderer.send('clean:log', level, msg),
    onLog: (cb) => ipcRenderer.on('clean:logline', (_e, entry) => cb(entry)),
    backlog: () => ipcRenderer.invoke('clean:backlog'),
    win: (what) => ipcRenderer.send('clean:win', what),
    fsRoots: () => ipcRenderer.invoke('fs-roots'),
    fsList: (dir) => ipcRenderer.invoke('fs-list', dir),
    fsExists: (p) => ipcRenderer.invoke('fs-exists', p),
    pathForFile: (file) => webUtils.getPathForFile(file),
  };
})();
