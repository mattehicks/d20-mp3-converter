const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('./engine');

// Clean run: throwaway profile wiped on exit, in-memory session, no settings, cache or log files.
// Nothing is remembered between launches (see clean/cleanrun.js). The only files this app creates are
// the MP3s (and folder.jpg, when that option is on) in the output folder chosen in the window.
const clean = require('./clean/cleanrun').setup({ prefix: 'd20mp3clean' });
const log = clean.log;
// With GPU acceleration on, Direct3D writes a per-exe shader cache to %LOCALAPPDATA%\D3DSCache\<hash>
// (outside the throwaway profile, and Chromium has no switch for it). This UI does not need the GPU.
app.disableHardwareAcceleration();

let win = null;
let control = null;   // { cancelAll, cancelOne } while a run is active
let closing = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 1060,
    minHeight: 660,
    frame: false,
    backgroundColor: '#0a0a0c',
    title: 'D20 MP3 Converter',
    webPreferences: clean.prefs({ preload: path.join(__dirname, 'preload.js'), spellcheck: false }),
  });
  clean.attach(win);
  win.loadFile('index.html');
  // Closing during a run: stop ffmpeg and remove the half-written file first, then close.
  win.on('close', (e) => {
    if (!control) return;
    e.preventDefault();
    if (closing) return;
    closing = true;
    log('warn', 'Window closed during a run: cancelling before exit');
    control.cancelAll();
  });
}

app.setAppUserModelId('com.thetruett.d20mp3converter');
app.whenReady().then(async () => {
  clean.prepare();
  clean.banner('D20 MP3 Converter');
  log('info', `  ffmpeg:  ${E.FFMPEG.bin} (${E.FFMPEG.src})`);
  log('info', `  ffprobe: ${E.FFPROBE.bin} (${E.FFPROBE.src})`);
  try { log('info', `  ${await E.ffmpegVersion()}`); } catch (e) { log('error', `  ffmpeg could not be started: ${e.message}`); }
  log('info', 'Add files or folders, then Start. MP3s go next to the source files unless an output folder is chosen. Originals are never changed.');
  createWindow();
});
app.on('window-all-closed', () => app.quit());

const send = (type, data) => { if (win && !win.isDestroyed()) win.webContents.send('ev', { type, data }); };

ipcMain.handle('defaults', () => ({ ...E.DEFAULTS, cores: os.cpus().length }));

ipcMain.handle('stat-paths', (_e, paths) => (paths || []).map((p) => {
  try { const st = fs.statSync(p); return { path: p, isDir: st.isDirectory(), ok: true }; } catch (e) { return { path: p, ok: false, error: e.message }; }
}));

// Creates the output folder the user typed, after they confirmed it in the window.
ipcMain.handle('make-dir', (_e, dir) => {
  try { fs.mkdirSync(dir, { recursive: true }); log('ok', `Created output folder ${dir}`); return { ok: true }; } catch (e) { log('error', `Could not create ${dir}: ${e.message}`); return { ok: false, error: e.message }; }
});

ipcMain.handle('run', async (_e, inputs, opts) => {
  if (control) { log('warn', 'A run is already in progress'); return { error: 'A run is already in progress' }; }
  control = {};
  try {
    return await E.runAll(inputs, opts, {
      log,
      control,
      onItems: (items) => send('items', items),
      onStage: (s) => send('stage', s),
      onPlan: (p) => send('plan', p),
      onProgress: (p) => send('progress', p),
      onResult: (r) => send('result', r),
    });
  } catch (e) {
    log('error', `Run stopped: ${e.message}`);
    return { error: e.message };
  } finally {
    control = null;
    if (closing && win && !win.isDestroyed()) win.destroy();
  }
});

ipcMain.on('cancel', () => { if (control && control.cancelAll) control.cancelAll(); else log('info', 'Nothing to cancel'); });
ipcMain.on('cancel-one', (_e, id) => { if (control && control.cancelOne) control.cancelOne(id); });
