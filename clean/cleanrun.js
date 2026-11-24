'use strict';
// Clean-run support for Electron main processes: the app keeps nothing on disk.
//  - Chromium's profile (cache, GPU shaders, storage) goes to a throwaway folder in %TEMP%.
//  - On exit that folder is overwritten with zeros and deleted by a short-lived helper process.
//  - Windows use an in-memory session (no cache, cookies or storage), with no permissions granted.
//  - The activity log is a memory ring buffer; nothing is written to a log file.
const { app, ipcMain, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const fsbrowse = require('./fsbrowse');

const PARTITION = 'clean-memory-only'; // no "persist:" prefix = in-memory

// Runs in the app (for stale folders) and, via toString(), in the exit helper.
async function scrubDir(dir, delayMs, extractDir) {
  const fs = require('fs');
  const path = require('path');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const walk = (d, o) => {
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, o); else o.push(p);
      }
    } catch (err) { /* ignore */ }
    return o;
  };
  await wait(delayMs);
  for (let i = 0; i < 10; i++) {
    for (const f of walk(dir, [])) {
      try {
        const sz = fs.statSync(f).size;
        const fd = fs.openSync(f, 'r+');
        const zeros = Buffer.alloc(65536);
        let off = 0;
        while (off < sz) { const n = Math.min(65536, sz - off); fs.writeSync(fd, zeros, 0, n, off); off += n; }
        fs.fsyncSync(fd);
        fs.closeSync(fd);
      } catch (err) { /* locked or gone */ }
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* locked */ }
    if (!fs.existsSync(dir)) break;
    await wait(1500);
  }
  // A portable build unpacks itself into %TEMP% on every launch. Remove that copy too, from a separate shell
  // (this helper runs from that very copy, so it cannot delete it itself).
  if (extractDir) {
    try {
      const Q = String.fromCharCode(34);
      require('child_process').spawn('cmd.exe', ['/d', '/s', '/c', Q + 'waitfor /t 4 cleanwait >nul 2>&1 & rmdir /s /q ' + Q + extractDir + Q + Q],
        { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true, cwd: require('os').tmpdir() }).unref();
    } catch (err) { /* ignore */ }
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// opts: { prefix: 'myapp', onLog: optional (level, msg) sink used instead of the built-in log panel feed }
function setup(opts = {}) {
  const prefix = `${opts.prefix || 'clean'}-`;

  // fewer things for Chromium to write or phone home about
  for (const sw of ['disable-gpu-shader-disk-cache', 'disable-breakpad', 'disable-component-update', 'no-pings', 'disable-background-networking']) {
    app.commandLine.appendSwitch(sw);
  }
  app.commandLine.appendSwitch('disk-cache-size', '1');
  app.commandLine.appendSwitch('media-cache-size', '1');

  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}${process.pid}-`));
  for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) app.setPath(key, runDir);

  // folders left by a run that was killed instead of closed (never one that is still running)
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      const m = name.startsWith(prefix) && new RegExp('^' + prefix + '(\\d+)-').exec(name);
      if (m && Number(m[1]) !== process.pid && !isAlive(Number(m[1]))) scrubDir(path.join(os.tmpdir(), name), 0);
    }
  } catch (e) { /* ignore */ }

  // electron-builder's portable launcher sets PORTABLE_EXECUTABLE_* and runs the app from a copy unpacked in %TEMP%
  const execDir = path.dirname(process.execPath);
  const extractDir = (process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR)
    && execDir.toLowerCase().startsWith(os.tmpdir().toLowerCase())
    && fs.existsSync(path.join(execDir, 'resources')) ? execDir : '';

  let wiped = false;
  app.on('will-quit', () => {
    if (wiped) return;
    wiped = true;
    try {
      spawn(process.execPath, ['-e', `(${scrubDir.toString()})(process.env.CLEAN_DIR, 2500, process.env.CLEAN_EXTRACT)`], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLEAN_DIR: runDir, CLEAN_EXTRACT: extractDir },
        detached: true, stdio: 'ignore', windowsHide: true, cwd: os.tmpdir(),
      }).unref();
    } catch (e) { /* ignore */ }
  });

  // ---- in-memory activity log ----
  let win = null;
  let seq = 0;
  const backlog = [];
  const LEVELS = ['info', 'step', 'ok', 'warn', 'error', 'dim'];
  function log(level, msg) {
    if (!LEVELS.includes(level)) level = 'info';
    if (opts.onLog) { opts.onLog(level, String(msg)); return; }
    const entry = { id: ++seq, t: Date.now(), level, msg: String(msg) };
    backlog.push(entry);
    if (backlog.length > 1000) backlog.shift();
    if (win && !win.isDestroyed()) win.webContents.send('clean:logline', entry);
  }
  process.on('uncaughtException', (e) => log('error', `Uncaught exception: ${e && e.stack ? e.stack : e}`));
  process.on('unhandledRejection', (e) => log('error', `Unhandled rejection: ${e && e.stack ? e.stack : e}`));

  ipcMain.on('clean:log', (_e, level, msg) => log(level, msg));
  ipcMain.handle('clean:backlog', () => backlog.slice());
  ipcMain.on('clean:win', (_e, what) => {
    if (!win || win.isDestroyed()) return;
    if (what === 'min') win.minimize();
    else if (what === 'max') (win.isMaximized() ? win.unmaximize() : win.maximize());
    else if (what === 'close') win.close();
  });
  fsbrowse.register(ipcMain);

  return {
    runDir,
    partition: PARTITION,
    log,
    // call inside app.whenReady(), before creating the window
    // pass { preload: false } for windows that run with nodeIntegration and use clean/shim-node.js instead
    prepare(popts) {
      const ses = session.fromPartition(PARTITION);
      if (!popts || popts.preload !== false) ses.setPreloads([path.join(__dirname, 'preload.js')]);
      ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
      try { ses.setSpellCheckerEnabled(false); } catch (e) { /* ignore */ }
    },
    // merge into BrowserWindow webPreferences
    prefs(extra) {
      return { contextIsolation: true, nodeIntegration: false, partition: PARTITION, ...extra };
    },
    // call right after creating the window
    attach(w) {
      win = w;
      w.webContents.on('console-message', (_e, level, message, line, sourceId) => {
        // (dev runs print an "Electron Security Warning" for pages without a CSP; packaged builds never do)
        if (level >= 2 && !/Electron Security Warning/.test(message)) log(level >= 3 ? 'error' : 'warn', `[page] ${message} (${path.basename(String(sourceId))}:${line})`);
      });
      w.webContents.on('render-process-gone', (_e, d) => log('error', `Renderer process gone: ${d.reason} (exit ${d.exitCode})`));
      w.webContents.on('unresponsive', () => log('warn', 'Window is not responding'));
      w.webContents.on('responsive', () => log('info', 'Window is responding again'));
      w.webContents.on('did-fail-load', (_e, code, desc) => log('error', `Page failed to load: ${desc} (${code})`));
    },
    banner(name) {
      log('step', `${name} ${app.getVersion()} started (Electron ${process.versions.electron})`);
      log('ok', 'Clean mode: nothing is written to disk. This log lives in memory and is discarded when the window closes.');
    },
  };
}

module.exports = { setup };
