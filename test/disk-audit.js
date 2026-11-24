// Disk audit of a packaged build: snapshot %TEMP%, %APPDATA% and %LOCALAPPDATA% (every file: path, size, mtime),
// drive a full run of the exe (dry run, conversion, two cancels, normal close), snapshot again and report the difference.
//   node test/disk-audit.js portable
//   node test/disk-audit.js installed     (installs silently, audits the installed exe, then uninstalls)
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runScenario } = require('./e2e-cdp');
const { sleep } = require('./cdp');

const ROOT = path.join(__dirname, '..');
const ver = require('../package.json').version;
const mode = process.argv[2] || 'portable';
const DIRS = { TEMP: os.tmpdir(), APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
const APPISH = /D3DSCache|d20mp3clean|d20.?mp3|thetruett|electron|ffmpeg|ffprobe|nsis|\\ns[a-z0-9]{3,6}\.tmp/i;
const WINDOWS_CACHES = /\\Microsoft\\Spelling\\|\\Microsoft\\Windows\\(Recent|Explorer)\\|\\IconCache|thumbcache|\\CrashDumps\\/i;

function snap(dir) {
  const m = new Map();
  const tempLow = DIRS.TEMP.toLowerCase();
  const walk = (d) => {
    let list;
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (dir !== DIRS.TEMP && p.toLowerCase() === tempLow) continue; // %TEMP% sits inside %LOCALAPPDATA%; counted once
        m.set(p + '\\', 'dir');
        walk(p);
      } else { try { const st = fs.statSync(p); m.set(p, st.size + '|' + Math.round(st.mtimeMs)); } catch (err) { /* vanished */ } }
    }
  };
  walk(dir);
  return m;
}
const snapAll = () => Object.fromEntries(Object.entries(DIRS).map(([k, d]) => [k, snap(d)]));

(async () => {
  let exe = path.join(ROOT, 'dist', `D20Mp3Converter-Portable-${ver}.exe`);
  let uninstall = null;
  if (mode === 'installed') {
    const setup = path.join(ROOT, 'dist', `D20Mp3Converter-Setup-${ver}.exe`);
    console.log('Installing silently: ' + setup);
    execFileSync(setup, ['/S'], { stdio: 'ignore' });
    await sleep(10000);
    const dir = path.join(DIRS.LOCALAPPDATA, 'Programs', 'd20-mp3-converter');
    exe = path.join(dir, 'D20 MP3 Converter.exe');
    uninstall = path.join(dir, 'Uninstall D20 MP3 Converter.exe');
    if (!fs.existsSync(exe)) throw new Error('installed exe not found at ' + exe);
    console.log('Installed to ' + dir);
  }
  console.log(`Audit of ${mode} build: ${exe}`);
  const before = snapAll();
  for (const [k, m] of Object.entries(before)) console.log(`  before: ${k} = ${DIRS[k]} (${m.size} entries)`);
  const R = await runScenario({ exe, outRoot: path.join(__dirname, 'tmp', 'audit-' + mode), label: mode });
  R.notes.forEach((n) => console.log('  ' + n));
  console.log(`  scenario: ${R.pass} checks passed, ${R.fail} failed`);
  await sleep(8000);
  const after = snapAll();
  let appLeft = 0;
  let winTouched = 0;
  for (const k of Object.keys(DIRS)) {
    const a = before[k];
    const b = after[k];
    const added = [...b.keys()].filter((p) => !a.has(p));
    const changed = [...b.keys()].filter((p) => a.has(p) && a.get(p) !== b.get(p));
    const removed = [...a.keys()].filter((p) => !b.has(p));
    const mine = [...added, ...changed].filter((p) => APPISH.test(p));
    const caches = [...added, ...changed].filter((p) => WINDOWS_CACHES.test(p));
    appLeft += mine.length;
    winTouched += caches.length;
    console.log(`\n${k}: ${b.size} entries after; ${added.length} added, ${changed.length} changed, ${removed.length} removed`);
    console.log(`  matching this app (d20mp3clean, d20 mp3, D3DSCache, electron, ffmpeg, nsis): ${mine.length}`);
    mine.slice(0, 40).forEach((p) => console.log('    ' + p));
    console.log(`  Windows-owned files touched (Spelling, Recent / jump lists, Explorer thumbnail and icon caches, crash dumps): ${caches.length}`);
    caches.slice(0, 20).forEach((p) => console.log('    ' + p));
    const groups = {};
    for (const p of [...added, ...changed]) {
      if (APPISH.test(p)) continue;
      const g = path.relative(DIRS[k], p).split(path.sep).slice(0, 2).join('\\');
      groups[g] = (groups[g] || 0) + 1;
    }
    const top = Object.entries(groups).sort((x, y) => y[1] - x[1]);
    console.log(`  other entries added or changed during the run, by owner folder (${top.length} folders):`);
    top.slice(0, 25).forEach(([g, n]) => console.log(`    ${String(n).padStart(5)}  ${g}`));
    if (k === 'TEMP') {
      const newTop = fs.readdirSync(DIRS.TEMP).filter((n) => !a.has(path.join(DIRS.TEMP, n)) && !a.has(path.join(DIRS.TEMP, n) + '\\'));
      console.log(`  new top-level entries in %TEMP%: ${newTop.length ? newTop.join(', ') : 'none'}`);
    }
  }
  const outs = fs.existsSync(R.outRoot) ? fs.readdirSync(R.outRoot, { recursive: true }).filter((f) => /\.(mp3|jpg)$/i.test(f)) : [];
  console.log(`\nOutput files written by the run (in ${R.outRoot}): ${outs.length}`);
  console.log(`RESULT ${mode}: ${appLeft === 0 && R.fail === 0 ? 'PASS' : 'CHECK'} - ${appLeft} app-related entries left in the three folders, ${winTouched} Windows-owned files touched, scenario ${R.pass}/${R.pass + R.fail}`);
  if (uninstall && !process.argv.includes('--keep')) {
    console.log('Uninstalling silently');
    try { execFileSync(uninstall, ['/S'], { stdio: 'ignore' }); } catch (e) { console.log('  uninstall returned: ' + e.message); }
    await sleep(6000);
    console.log('  install folder still present: ' + fs.existsSync(path.dirname(exe)));
  }
})().catch((e) => { console.error(e); process.exit(1); });
