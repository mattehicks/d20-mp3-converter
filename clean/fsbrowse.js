'use strict';
// Directory browsing for the in-app file picker. It only reads directory listings with fs,
// so no Windows file dialog is involved: no Recent-files entries, dialog history or shell thumbnails.
const fs = require('fs');
const os = require('os');
const path = require('path');

const BS = String.fromCharCode(92);

function places() {
  const home = os.homedir();
  const out = [{ name: 'Home', path: home }];
  for (const n of ['Desktop', 'Documents', 'Downloads', 'Videos', 'Pictures', 'Music']) {
    const p = path.join(home, n);
    try { if (fs.statSync(p).isDirectory()) out.push({ name: n, path: p }); } catch (e) { /* missing */ }
  }
  return out;
}

function drives() {
  const out = [];
  for (let c = 67; c <= 90; c++) { // C..Z
    const d = String.fromCharCode(c) + ':' + BS;
    try { if (fs.existsSync(d)) out.push({ name: d.slice(0, 2), path: d }); } catch (e) { /* ignore */ }
  }
  return out;
}

async function list(dir) {
  if (!dir) return { dir: '', parent: null, entries: drives().map((d) => ({ name: d.name, path: d.path, isDir: true, size: 0, mtimeMs: 0 })) };
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const out = await Promise.all(entries.map(async (e) => {
      if (e.name.startsWith('$') || e.name === 'System Volume Information') return null;
      const full = path.join(dir, e.name);
      try {
        let isDir = e.isDirectory();
        let size = 0;
        let mtimeMs = 0;
        if (e.isSymbolicLink() || !isDir) {
          const st = await fs.promises.stat(full);
          isDir = st.isDirectory();
          size = st.size;
          mtimeMs = st.mtimeMs;
        }
        return { name: e.name, path: full, isDir, size: isDir ? 0 : size, mtimeMs };
      } catch (err) { return null; }
    }));
    const up = path.dirname(dir);
    return { dir, parent: up === dir ? '' : up, entries: out.filter(Boolean) };
  } catch (err) {
    return { dir, error: err.message };
  }
}

function register(ipcMain) {
  ipcMain.handle('fs-roots', () => ({ places: places(), drives: drives() }));
  ipcMain.handle('fs-list', (_e, dir) => list(dir));
  ipcMain.handle('fs-exists', (_e, p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
}

module.exports = { register };
