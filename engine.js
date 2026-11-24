'use strict';
// Conversion engine: scan -> plan -> convert -> verify. Plain Node (no Electron), used by main.js and the tests.
// Sources are only ever opened for reading. The only files created are the output MP3s
// (and folder.jpg when saveCovers is on). Cover art and tags travel through pipes and arguments, never temp files.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const unpack = (p) => p.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked');
function resolveBin(pkg, name) {
  try {
    const p = unpack(require(pkg).path);
    if (fs.existsSync(p)) return { bin: p, src: 'bundled' };
  } catch (e) { /* fall through */ }
  return { bin: name, src: 'MISSING (bundled binary not found)' };
}
const FFMPEG = resolveBin('@ffmpeg-installer/ffmpeg', 'ffmpeg');
const FFPROBE = resolveBin('@ffprobe-installer/ffprobe', 'ffprobe');

const AUDIO_EXT = new Set(['mp3', 'flac', 'wav', 'aif', 'aiff', 'aifc', 'm4a', 'm4b', 'aac', 'ogg', 'oga', 'opus', 'wma', 'ape', 'wv', 'mka', 'mp4', 'm4v', 'mkv', 'webm', 'mov']);
const FAT_MAX = 4 * 2 ** 30 - 1;       // largest file FAT32 can hold
const COVER_MAX = 200 * 1024;
const COVER_PX = 500;

const DEFAULTS = {
  outDir: '',              // empty = write each MP3 next to its source file
  bitrate: 256,            // 192 | 256 | 320, CBR
  sampleRate: 44100,       // 44100 | 48000
  lossyCap: false,         // lossy sources at <=160 kbps are encoded at 192 instead of the chosen bitrate
  compatibleMp3: 'copy',   // 'copy' | 'skip'  - MP3s that already match the profile
  mp3Audio: 'keep',        // 'keep' = fix tags/art, audio stream copied | 'strict' = re-encode unless target rate, stereo, CBR
  keepStructure: true,
  numbered: false,         // "NN - Title.mp3" when track and title tags exist
  asciiNames: true,
  maxName: 100,
  titleFromName: true,
  loudnorm: false,
  folderArt: true,
  saveCovers: false,       // also write folder.jpg into each output folder
  skipExisting: true,
  dryRun: false,
  jobs: Math.max(1, Math.min(6, Math.floor(require('os').cpus().length / 2))), // ffmpeg processes at once
  maxBytes: Math.floor(3.9 * 2 ** 30), // split above this
};

const lastLine = (s) => String(s || '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' | ');
const cmdline = (name, args) => name + ' ' + args.map((a) => (/[\s"'&|<>()=,;]/.test(a) || a === '' ? '"' + a.replace(/"/g, '\\"') + '"' : a)).join(' ');
const fmtDur = (s) => { s = Math.round(s); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s % 60).padStart(2, '0'); };

function run(bin, args, { input, onLine, onSpawn } = {}) {
  return new Promise((resolve) => {
    let child;
    const out = [];
    let err = '';
    let buf = '';
    try { child = spawn(bin, args, { windowsHide: true }); } catch (e) { resolve({ code: -1, err: e.message, out: Buffer.alloc(0) }); return; }
    if (onSpawn) onSpawn(child);
    child.stdin.on('error', () => {});
    if (input) child.stdin.end(input); else child.stdin.end();
    child.stdout.on('data', (d) => {
      if (!onLine) { out.push(d); return; }
      buf += d.toString('utf8');
      const parts = buf.split(/\r?\n|\r/);
      buf = parts.pop();
      for (const l of parts) if (l) onLine(l);
    });
    child.stderr.on('data', (d) => { err = (err + d.toString('utf8')).slice(-4000); });
    child.on('error', (e) => resolve({ code: -1, err: e.message, out: Buffer.concat(out) }));
    child.on('close', (code) => resolve({ code, err, out: Buffer.concat(out) }));
  });
}

async function probe(file) {
  const r = await run(FFPROBE.bin, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]);
  let j = null;
  try { j = JSON.parse(r.out.toString('utf8')); } catch (e) { /* not json */ }
  if (r.code !== 0 || !j || !j.streams || !j.format) throw new Error(lastLine(r.err) || 'ffprobe could not read the file');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  const pic = j.streams.find((s) => s.codec_type === 'video' && s.disposition && s.disposition.attached_pic);
  const tags = {};
  for (const src of [j.format.tags, a && a.tags]) {
    for (const [k, v] of Object.entries(src || {})) { const key = k.toLowerCase(); if (!(key in tags)) tags[key] = String(v); }
  }
  return {
    dur: +j.format.duration || (a && +a.duration) || 0,
    format: j.format.format_name || '',
    size: +j.format.size || 0,
    audio: a ? { codec: a.codec_name, sampleRate: +a.sample_rate || 0, channels: +a.channels || 0, bitRate: +a.bit_rate || +j.format.bit_rate || 0 } : null,
    art: pic ? { index: pic.index, codec: pic.codec_name, w: pic.width, h: pic.height } : null,
    tags,
  };
}

// ---- tags ----
const TAG_ALIASES = {
  title: ['title'],
  artist: ['artist', 'author'],
  album: ['album'],
  album_artist: ['album_artist', 'albumartist', 'album artist', 'wm/albumartist'],
  track: ['track', 'tracknumber', 'wm/tracknumber'],
  disc: ['disc', 'discnumber', 'wm/partofset'],
  date: ['date', 'year', 'originaldate', 'wm/year'],
  genre: ['genre', 'wm/genre'],
};
function normTags(raw) {
  const t = {};
  for (const [key, names] of Object.entries(TAG_ALIASES)) {
    for (const n of names) {
      const v = raw[n] === undefined ? '' : String(raw[n]).replace(/[\x00-\x1f]/g, ' ').trim();
      if (v) { t[key] = v; break; }
    }
  }
  if (t.date) { const m = /\d{4}/.exec(t.date); if (m) t.date = m[0]; else delete t.date; }
  for (const k of ['track', 'disc']) {
    if (!t[k]) continue;
    const m = /^(\d+)(?:\s*\/\s*(\d+))?/.exec(t[k]);
    if (m && +m[1] > 0) t[k] = m[2] ? `${+m[1]}/${+m[2]}` : String(+m[1]); else delete t[k];
  }
  return t;
}

// ---- file names safe for FAT32 / exFAT ----
const FOLD = { '‘': "'", '’': "'", '“': '', '”': '', '–': '-', '—': '-', '⁄': '-', '∕': '-', '¦': '-', '…': '...', 'ß': 'ss', 'æ': 'ae', 'Æ': 'AE', 'ø': 'o', 'Ø': 'O', 'đ': 'd', 'ł': 'l', 'Ł': 'L' };
function asciiFold(s) {
  s = s.normalize('NFKD').replace(/[̀-ͯ⃐-⃿︀-️]/g, '');
  s = s.replace(/[‘’“”–—⁄∕¦…ßæÆøØđłŁ]/g, (c) => FOLD[c]);
  return s.replace(/[^\x20-\x7e]/g, '');
}
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const tidy = (s) => s.replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
function safeName(name, o, suffix = '') {
  let s = name.replace(/\s/g, ' ');
  s = o.asciiNames ? asciiFold(s) : s.normalize('NFC');
  s = tidy(s.replace(/[\\/:*?"<>|\t\r\n]/g, ' ').replace(/[\x00-\x1f\x7f]/g, ''));
  if (o.asciiNames) s = tidy(s.replace(/(\s[-_])+$/, '').replace(/^([-_]\s)+/, '')); // separators left dangling after folding
  const room = Math.max(8, (o.maxName || 100) - suffix.length);
  if ([...s].length > room) s = tidy([...s].slice(0, room).join(''));
  if (!s) s = 'untitled';
  if (RESERVED.test(s)) s = '_' + s;
  return s + suffix;
}

// ---- small binary readers (read-only) ----
function mp3Head(file) {
  const r = { ver: null, vbr: false, info: false };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const h = Buffer.alloc(10);
    fs.readSync(fd, h, 0, 10, 0);
    let off = 0;
    if (h.toString('latin1', 0, 3) === 'ID3') {
      r.ver = h[3];
      off = 10 + (((h[6] & 127) << 21) | ((h[7] & 127) << 14) | ((h[8] & 127) << 7) | (h[9] & 127));
    }
    const b = Buffer.alloc(4096);
    fs.readSync(fd, b, 0, 4096, off);
    const s = b.toString('latin1');
    r.vbr = s.includes('Xing') || s.includes('VBRI');
    r.info = s.includes('Info');
  } catch (e) { /* unreadable: caller decides */ } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (e) { /* ignore */ } }
  return r;
}
function jpegInfo(b) {
  if (!b || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return { sof: 0 };
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { sof: m, h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return { sof: 0 };
}

// ---- scan ----
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
function scan(inputs, outDir, log = () => {}) {
  const out = [];
  const seen = new Set();
  const outKey = outDir ? path.resolve(outDir).toLowerCase() + path.sep : null;
  const roots = new Set(inputs.map((p) => path.resolve(p).toLowerCase() + path.sep));
  const stats = inputs.map((p) => { try { return { p: path.resolve(p), st: fs.statSync(p) }; } catch (e) { log('error', `Cannot read ${p}: ${e.message}`); return null; } }).filter(Boolean);
  const multiDir = stats.filter((x) => x.st.isDirectory()).length > 1;
  let ignored = 0;
  const add = (file, rel) => {
    const key = file.toLowerCase();
    if (seen.has(key)) return;
    // an output folder that sits inside an input folder is not scanned (an output folder equal to an input folder is)
    if (outKey && !roots.has(outKey) && (key + path.sep).startsWith(outKey)) return;
    seen.add(key);
    out.push({ src: file, rel });
  };
  const walk = (dir, root, prefix) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { log('warn', `Cannot list ${dir}: ${e.message}`); return; }
    entries.sort((a, b) => natural(a.name, b.name));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!e.name.startsWith('$') && e.name !== 'System Volume Information') walk(full, root, prefix); }
      else if (e.isFile()) {
        if (AUDIO_EXT.has(path.extname(e.name).slice(1).toLowerCase())) add(full, path.join(prefix, path.relative(root, full)));
        else ignored++;
      }
    }
  };
  for (const { p, st } of stats) {
    if (st.isDirectory()) walk(p, p, multiDir ? path.basename(p) : '');
    else add(p, path.basename(p));
  }
  out.forEach((it, i) => { it.id = i + 1; });
  log('info', `Scan: ${out.length} audio file(s), ${ignored} other file(s) ignored`);
  return out;
}

const stemOf = (f) => path.basename(f, path.extname(f));
const dropParen = (s) => s.replace(/\s*\([^()]*\)\s*$/, '').toLowerCase();
function findSidecar(src, ctx) {
  const dir = path.dirname(src);
  let list = ctx.dirs.get(dir);
  if (!list) {
    try { list = fs.readdirSync(dir).filter((n) => /\.(jpe?g|png)$/i.test(n)); } catch (e) { list = []; }
    ctx.dirs.set(dir, list);
  }
  if (!list.length) return null;
  const stem = stemOf(src).toLowerCase();
  const hit = list.find((n) => stemOf(n).toLowerCase() === stem)
    || list.find((n) => dropParen(stemOf(n)) === dropParen(stem))
    || list.find((n) => ['folder', 'cover', 'front', 'albumart', 'album'].includes(stemOf(n).toLowerCase()));
  return hit ? path.join(dir, hit) : null;
}

// ---- plan ----
class Cancelled extends Error { constructor() { super('cancelled'); } }

async function pool(list, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, list.length)) }, async () => {
    while (i < list.length) { const idx = i++; await fn(list[idx], idx); }
  }));
}

// Is the embedded picture already what the profile asks for? Returns the raw JPEG when it is.
async function artCompliant(src, art) {
  if (art.codec !== 'mjpeg') return { ok: false, why: `${art.codec} ${art.w}x${art.h}` };
  if (art.w > COVER_PX || art.h > COVER_PX) return { ok: false, why: `${art.w}x${art.h}` };
  const r = await run(FFMPEG.bin, ['-v', 'error', '-nostdin', '-i', src, '-map', `0:${art.index}`, '-c', 'copy', '-f', 'image2pipe', 'pipe:1']);
  if (r.code !== 0 || !r.out.length) return { ok: false, why: 'unreadable' };
  if (r.out.length > COVER_MAX) return { ok: false, why: `${Math.round(r.out.length / 1024)} KB` };
  if (jpegInfo(r.out).sof !== 0xc0) return { ok: false, why: 'progressive JPEG' };
  return { ok: true, buf: r.out };
}

async function analyse(item, o, ctx) {
  const p = { id: item.id, src: item.src, rel: item.rel, action: 'fail', reason: '', dests: [], parts: 1, partDur: 0 };
  let info;
  try { info = await probe(item.src); } catch (e) { p.reason = 'unreadable: ' + e.message.split(item.src + ': ').join(''); return p; }
  if (!info.audio) { p.reason = 'no audio stream'; return p; }
  if (!(info.dur > 0)) { p.reason = 'no duration (empty or damaged file)'; return p; }
  p.info = info;
  const a = info.audio;
  const tags = normTags(info.tags);
  let titleFilled = false;
  if (!tags.title && o.titleFromName) { tags.title = stemOf(item.src); titleFilled = true; }
  p.tags = tags;
  p.art = info.art ? { from: 'embedded', file: item.src, map: `0:${info.art.index}`, desc: `embedded ${info.art.codec} ${info.art.w}x${info.art.h}` } : null;
  if (!p.art && o.folderArt) {
    const side = findSidecar(item.src, ctx);
    if (side) p.art = { from: 'file', file: side, map: '0:v:0', desc: path.basename(side) };
  }
  const lossless = /^(flac|alac|ape|wavpack|pcm_|wmalossless|tta|truehd|mlp)/.test(a.codec);
  p.bitrate = o.bitrate;
  if (o.lossyCap && !lossless && a.bitRate && a.bitRate <= 165000) p.bitrate = Math.min(192, o.bitrate);

  const why = [];
  let head = null;
  if (a.codec === 'mp3') {
    head = mp3Head(item.src);
    p.durEstimated = !head.vbr && !head.info;
    if (o.loudnorm) why.push('loudness normalisation');
    if (![32000, 44100, 48000].includes(a.sampleRate)) why.push(`${a.sampleRate} Hz`);
    if (a.channels > 2) why.push(`${a.channels} channels`);
    if (o.mp3Audio === 'strict') {
      if (a.sampleRate !== o.sampleRate) why.push(`${a.sampleRate} Hz`);
      if (a.channels !== 2) why.push('not stereo');
      if (head.vbr) why.push('VBR');
    }
  } else {
    p.durEstimated = info.format === 'aac';
    why.push(a.codec + (path.extname(item.src).toLowerCase() === '.mp3' ? ' audio inside a .mp3 file' : ''));
  }
  if (why.length) {
    p.action = 'encode';
    p.reason = [...new Set(why)].join(', ');
  } else {
    const fix = [];
    if (head.ver !== null && head.ver !== 3) fix.push(`ID3v2.${head.ver} tags`);
    else if (head.ver === null && Object.keys(tags).length) fix.push('no ID3v2 tag');
    else if (titleFilled) fix.push('title missing');
    if (p.art && p.art.from === 'file') fix.push('cover from ' + p.art.desc);
    else if (p.art) {
      const chk = await artCompliant(item.src, info.art);
      if (chk.ok) p.art.raw = chk.buf; else fix.push('cover ' + chk.why);
    }
    if (fix.length) { p.action = 'retag'; p.reason = fix.join(', ') + '; audio copied bit-exact'; }
    else { p.action = o.compatibleMp3 === 'skip' ? 'skip' : 'copy'; p.reason = 'already compatible'; }
  }
  const outBps = p.action === 'encode' ? p.bitrate * 1000 : (a.bitRate || (info.size * 8) / info.dur);
  const est = (info.dur * outBps) / 8 + 300000;
  if (est > o.maxBytes) {
    p.parts = Math.ceil(est / o.maxBytes);
    if (p.action === 'copy') { p.action = 'retag'; p.reason = 'over the size limit; split, audio copied bit-exact'; }
  }
  p.partDur = info.dur / p.parts;
  p.estBytes = est;
  return p;
}

// Sequential and in input order, so the same inputs always get the same output names.
async function assignNames(p, o, ctx) {
  if (p.action === 'fail' || p.action === 'cancelled') return;
  let base = stemOf(p.src);
  if (o.numbered && p.tags.track && p.tags.title) {
    const n = parseInt(p.tags.track, 10);
    const d = parseInt(p.tags.disc, 10);
    if (n > 0) base = `${d > 1 ? d + '-' : ''}${String(n).padStart(2, '0')} - ${p.tags.title}`;
  }
  const relDir = o.keepStructure ? path.dirname(p.rel).split(/[\\/]/).filter((s) => s && s !== '.').map((s) => safeName(s, o)) : [];
  // No output folder chosen = each MP3 goes next to its source file.
  const dir = o.outDir ? path.join(o.outDir, ...relDir) : path.dirname(p.src);
  const busy = (c) => ctx.taken.has(c.toLowerCase()) || c.toLowerCase() === p.src.toLowerCase();
  const take = (nm, alsoDisk) => {
    let n = 1;
    let cand;
    do { cand = path.join(dir, (n === 1 ? nm : `${nm} (${n})`) + '.mp3'); n++; } while (busy(cand) || (alsoDisk && fs.existsSync(cand)));
    ctx.taken.add(cand.toLowerCase());
    return cand;
  };
  const names = [];
  for (let i = 0; i < p.parts; i++) names.push(safeName(base, o, p.parts > 1 ? ` (part ${i + 1} of ${p.parts})` : ''));
  if (p.action === 'copy' && path.join(dir, names[0] + '.mp3').toLowerCase() === p.src.toLowerCase()) {
    p.action = 'skip';
    p.reason = 'already compatible and already in place';
    return;
  }
  p.dests = names.map((nm) => take(nm, false));
  if (p.action === 'skip') return;
  const existing = p.dests.filter((d) => fs.existsSync(d));
  if (!existing.length) return;
  if (o.skipExisting && existing.length === p.dests.length) {
    let good = true;
    for (const d of p.dests) {
      try { const e = await probe(d); if (Math.abs(e.dur - p.partDur) > 1.5) good = false; } catch (e) { good = false; }
    }
    if (good) { p.action = 'skip'; p.reason = 'output already exists'; return; }
  }
  // Existing files are never overwritten: write under a free name instead.
  p.dests = names.map((nm) => take(nm, true));
  p.note = o.skipExisting ? 'existing output is incomplete or different; writing under a new name' : 'name already in use; writing under a new name';
}

const describe = (p) => (p.info ? `${p.info.audio.codec} ${p.info.audio.sampleRate} Hz ${p.info.audio.channels}ch ${Math.round(p.info.audio.bitRate / 1000)}k ${fmtDur(p.info.dur)}` : '');
const publicPlan = (p) => ({ id: p.id, src: p.src, rel: p.rel, action: p.action, reason: p.reason, note: p.note || '', dests: p.dests, parts: p.parts, dur: p.info ? p.info.dur : 0, desc: describe(p), art: p.art ? p.art.desc : '', tags: p.tags || {} });

// ---- convert ----
function tagsFor(p, i) {
  const t = { ...p.tags };
  if (p.parts > 1) t.title = `${t.title || stemOf(p.src)} (part ${i + 1} of ${p.parts})`;
  return t;
}

async function getCover(p, h, job) {
  if (p.art.raw) return p.art.raw;
  for (const [px, q] of [[500, 3], [500, 6], [500, 10], [400, 8], [320, 8], [240, 10]]) {
    const vf = `scale=w='min(${px},iw)':h='min(${px},ih)':force_original_aspect_ratio=decrease,format=yuvj420p`;
    const args = ['-v', 'error', '-nostdin', '-i', p.art.file, '-map', p.art.map, '-frames:v', '1', '-vf', vf, '-c:v', 'mjpeg', '-q:v', String(q), '-f', 'image2pipe', 'pipe:1'];
    h.log('dim', `  [${p.id}] cover: ${cmdline('ffmpeg', args)}`);
    const r = await run(FFMPEG.bin, args, { onSpawn: (c) => { job.child = c; } });
    job.child = null;
    if (job.cancelled) return null;
    const ji = jpegInfo(r.out);
    if (r.code !== 0 || !ji.sof) { h.log('warn', `  [${p.id}] cover could not be read (${p.art.desc}): ${lastLine(r.err) || 'no image data'}`); return null; }
    if (r.out.length <= COVER_MAX && ji.sof === 0xc0) {
      h.log('dim', `  [${p.id}] cover: ${ji.w}x${ji.h} baseline JPEG, ${Math.round(r.out.length / 1024)} KB (from ${p.art.desc})`);
      return r.out;
    }
  }
  h.log('warn', `  [${p.id}] cover could not be brought under 200 KB; leaving it out`);
  return null;
}

function buildArgs(p, o, i, cover) {
  const A = ['-hide_banner', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-n'];
  if (!cover) A.push('-nostdin');
  if (p.parts > 1) A.push('-ss', (i * p.partDur).toFixed(3), '-t', p.partDur.toFixed(3));
  A.push('-i', p.src);
  if (cover) A.push('-f', 'mjpeg', '-i', 'pipe:0'); // the cover arrives on stdin
  A.push('-map', '0:a:0');
  if (cover) A.push('-map', '1:v:0');
  if (p.action === 'encode') {
    A.push('-c:a', 'libmp3lame', '-b:a', p.bitrate + 'k', '-ar', String(o.sampleRate), '-ac', '2');
    if (o.loudnorm) A.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11');
  } else A.push('-c:a', 'copy');
  if (cover) A.push('-c:v', 'copy', '-disposition:v:0', 'attached_pic', '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)');
  A.push('-map_metadata', '-1', '-map_chapters', '-1');
  for (const [k, v] of Object.entries(tagsFor(p, i))) A.push('-metadata', `${k}=${v}`);
  A.push('-id3v2_version', '3', '-write_id3v1', '0', '-f', 'mp3', p.dests[i]);
  return A;
}

function copyFile(src, dest, job, onFrac) {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(src).size;
    let done = 0;
    const rs = fs.createReadStream(src);
    const ws = fs.createWriteStream(dest, { flags: 'wx' });
    job.abort = () => rs.destroy(new Cancelled());
    rs.on('data', (d) => { done += d.length; onFrac(size ? done / size : 1); });
    require('stream').pipeline(rs, ws, (err) => {
      job.abort = null;
      if (!err) { resolve(); return; }
      if (err.code !== 'EEXIST') try { fs.unlinkSync(dest); } catch (e) { /* nothing written */ }
      reject(job.cancelled ? new Cancelled() : err);
    });
  });
}

// ---- verify ----
async function verify(p, o, i) {
  const dest = p.dests[i];
  const bad = [];
  let v;
  try { v = await probe(dest); } catch (e) { return ['output unreadable: ' + e.message]; }
  const size = fs.statSync(dest).size;
  if (!v.audio || v.audio.codec !== 'mp3') { bad.push(`codec ${v.audio ? v.audio.codec : 'none'}, expected mp3`); return bad; }
  if (size > FAT_MAX) bad.push(`size ${size} bytes is over the 4 GB FAT32 limit`);
  if (Math.abs(v.dur - p.partDur) > 1) bad.push(`duration ${v.dur.toFixed(2)} s, source ${p.partDur.toFixed(2)} s${p.durEstimated ? ' (source has no length header, its duration is an estimate)' : ''}`);
  if (p.action === 'copy') { if (size !== p.info.size) bad.push(`copy is ${size} bytes, source ${p.info.size}`); return bad; }
  const head = mp3Head(dest);
  if (p.action === 'encode') {
    if (v.audio.sampleRate !== o.sampleRate) bad.push(`sample rate ${v.audio.sampleRate}, expected ${o.sampleRate}`);
    if (v.audio.channels !== 2) bad.push(`${v.audio.channels} channel(s), expected 2`);
    if (Math.abs(v.audio.bitRate - p.bitrate * 1000) > p.bitrate * 20) bad.push(`bitrate ${Math.round(v.audio.bitRate / 1000)} kbps, expected ${p.bitrate}`);
    if (head.vbr) bad.push('VBR header found, expected CBR');
  }
  const want = tagsFor(p, i);
  if ((Object.keys(want).length || p.coverBytes) && head.ver !== 3) bad.push(`ID3v2.${head.ver} tag, expected ID3v2.3`);
  const got = normTags(v.tags);
  for (const [k, val] of Object.entries(want)) if (got[k] !== val) bad.push(`tag ${k} reads "${got[k] || ''}", expected "${val}"`);
  if (p.coverBytes) {
    if (!v.art) bad.push('cover art missing');
    else if (v.art.codec !== 'mjpeg' || v.art.w > COVER_PX || v.art.h > COVER_PX) bad.push(`cover is ${v.art.codec} ${v.art.w}x${v.art.h}`);
  } else if (v.art) bad.push('cover art present but none expected');
  return bad;
}

async function convertOne(p, o, h, job, ctx) {
  const created = [];
  const undo = () => { for (const f of created) try { fs.unlinkSync(f); } catch (e) { /* already gone */ } };
  try {
    if (p.action === 'copy') {
      fs.mkdirSync(path.dirname(p.dests[0]), { recursive: true });
      h.log('step', `[${p.id}] Copy ${p.src}`);
      h.log('info', `  [${p.id}] -> ${p.dests[0]} (${p.reason})`);
      await copyFile(p.src, p.dests[0], job, (f) => h.progress(p, f));
      created.push(p.dests[0]);
    } else {
      h.log('step', `[${p.id}] ${p.action === 'encode' ? 'Convert' : 'Retag'} ${p.src} (${describe(p)}; ${p.reason})`);
      const cover = p.art ? await getCover(p, h, job) : null;
      if (job.cancelled) throw new Cancelled();
      p.coverBytes = cover ? cover.length : 0;
      for (let i = 0; i < p.parts; i++) {
        const dest = p.dests[i];
        const dir = path.dirname(dest);
        fs.mkdirSync(dir, { recursive: true });
        if (fs.existsSync(dest)) throw new Error('output name is already taken: ' + dest);
        if (cover && o.saveCovers && !ctx.covers.has(dir.toLowerCase())) {
          ctx.covers.add(dir.toLowerCase());
          const fj = path.join(dir, 'folder.jpg');
          try { fs.writeFileSync(fj, cover, { flag: 'wx' }); h.log('info', `  [${p.id}] wrote ${fj}`); } catch (e) { if (e.code !== 'EEXIST') h.log('warn', `  [${p.id}] could not write ${fj}: ${e.message}`); }
        }
        const args = buildArgs(p, o, i, cover);
        h.log('info', `  [${p.id}] ${cmdline('ffmpeg', args)}`);
        let lastStep = -1;
        created.push(dest);
        const r = await run(FFMPEG.bin, args, {
          input: cover,
          onSpawn: (c) => { job.child = c; },
          onLine: (l) => {
            const m = /^out_time_us=(\d+)/.exec(l) || /^out_time_ms=(\d+)/.exec(l);
            if (!m) return;
            const f = Math.max(0, Math.min(1, m[1] / 1e6 / p.partDur));
            h.progress(p, (i + f) / p.parts);
            const step = Math.floor(f * 4);
            if (step > lastStep && step < 4) { lastStep = step; h.log('dim', `  [${p.id}] ${step * 25}%${p.parts > 1 ? ` of part ${i + 1}/${p.parts}` : ''}`); }
          },
        });
        job.child = null;
        if (job.cancelled) throw new Cancelled();
        if (r.code !== 0) throw new Error(lastLine(r.err) || `ffmpeg exited with code ${r.code}`);
      }
    }
    h.progress(p, 1);
    const bad = [];
    for (let i = 0; i < p.dests.length; i++) bad.push(...await verify(p, o, i));
    return bad;
  } catch (e) {
    undo();
    throw e;
  }
}

// ---- run ----
// hooks: log(level,msg), onItems(list), onStage({stage,done,total}), onPlan(plan), onProgress({id,frac,overall}), onResult(result), control {}
async function runAll(inputs, opts, hooks = {}) {
  const o = { ...DEFAULTS, ...opts };
  o.jobs = Math.max(1, Math.min(8, +o.jobs || 1));
  const log = hooks.log || (() => {});
  const t0 = Date.now();
  const S = { dryRun: !!o.dryRun, total: 0, converted: 0, retagged: 0, copied: 0, skipped: 0, failed: 0, cancelled: 0, mismatched: 0, outDir: o.outDir, results: [] };
  const jobs = new Map();
  const early = new Set();
  let stop = false;
  const kill = (j) => { j.cancelled = true; if (j.child) try { j.child.kill(); } catch (e) { /* gone */ } if (j.abort) j.abort(); };
  const ctl = hooks.control || {};
  ctl.cancelAll = () => { if (!stop) log('warn', 'Cancel requested: stopping all work'); stop = true; for (const j of jobs.values()) kill(j); };
  ctl.cancelOne = (id) => { const j = jobs.get(id); log('warn', `Cancel requested for file ${id}`); if (j) kill(j); else early.add(id); };

  if (!o.dryRun && o.outDir) {
    let ok = false;
    try { ok = fs.statSync(o.outDir).isDirectory(); } catch (e) { /* missing */ }
    if (!ok) throw new Error('Output folder does not exist: ' + o.outDir);
  }
  log('step', `${o.dryRun ? 'Dry run' : 'Run'} started: ${inputs.length} input(s) -> ${o.outDir || 'the same folder as each source file'}`);
  log('info', `  Profile: MP3 CBR ${o.bitrate} kbps, ${o.sampleRate} Hz, stereo, ID3v2.3, cover <= ${COVER_PX}px baseline JPEG <= 200 KB, files <= ${(o.maxBytes / 2 ** 30).toFixed(2)} GiB`);
  log('info', `  Options: ${['lossyCap', 'compatibleMp3', 'mp3Audio', 'keepStructure', 'numbered', 'asciiNames', 'titleFromName', 'loudnorm', 'folderArt', 'saveCovers', 'skipExisting', 'jobs'].map((k) => `${k}=${o[k]}`).join(' ')}`);
  inputs.forEach((p) => log('info', `  Input: ${p}`));

  const items = scan(inputs, o.outDir, log);
  S.total = items.length;
  if (hooks.onItems) hooks.onItems(items);
  const ctx = { dirs: new Map(), taken: new Set(), sources: new Set(items.map((i) => i.src.toLowerCase())), covers: new Set() };
  const plans = new Array(items.length);
  let probed = 0;
  log('step', `Reading ${items.length} file(s) with ffprobe`);
  await pool(items, 6, async (it, idx) => {
    plans[idx] = stop ? { id: it.id, src: it.src, rel: it.rel, action: 'cancelled', reason: 'cancelled', dests: [], parts: 1 } : await analyse(it, o, ctx);
    probed++;
    if (hooks.onStage) hooks.onStage({ stage: 'probe', done: probed, total: items.length });
  });
  for (const p of plans) {
    await assignNames(p, o, ctx);
    log('info', `  [${p.id}] ${p.action.toUpperCase().padEnd(6)} ${p.rel}${p.dests.length && p.action !== 'skip' ? ' -> ' + p.dests.map((d) => (o.outDir ? path.relative(o.outDir, d) : path.basename(d))).join(' + ') : ''} (${p.reason}${p.note ? '; ' + p.note : ''})`);
    if (hooks.onPlan) hooks.onPlan(publicPlan(p));
  }

  const finish = (p, status, reason, mismatches = []) => {
    const r = { id: p.id, src: p.src, rel: p.rel, status, action: p.action, reason: reason || '', dests: p.dests, mismatches };
    S.results.push(r);
    if (S[status] !== undefined) S[status]++;
    if (mismatches.length) S.mismatched++;
    if (status === 'failed') log('error', `[${p.id}] FAILED ${p.rel}: ${reason}`);
    else if (status === 'cancelled') log('warn', `[${p.id}] cancelled ${p.rel}`);
    else if (mismatches.length) log('warn', `[${p.id}] ${status} with verification mismatches: ${mismatches.join('; ')}`);
    else if (status !== 'skipped' && !o.dryRun) log('ok', `[${p.id}] ${status}, verified: ${p.dests.map((d) => path.basename(d)).join(' + ')}`);
    if (hooks.onResult) hooks.onResult(r);
  };
  const STATUS = { encode: 'converted', retag: 'retagged', copy: 'copied', skip: 'skipped', fail: 'failed', cancelled: 'cancelled' };

  if (o.dryRun) {
    for (const p of plans) finish(p, STATUS[p.action], p.reason);
  } else {
    const work = [];
    for (const p of plans) { if (['encode', 'retag', 'copy'].includes(p.action)) work.push(p); else finish(p, STATUS[p.action], p.reason); }
    const totalDur = work.reduce((s, p) => s + p.info.dur, 0) || 1;
    const fracs = new Map();
    const last = new Map();
    const h = {
      log,
      progress: (p, f) => {
        fracs.set(p.id, f * p.info.dur);
        const now = Date.now();
        if (f < 1 && now - (last.get(p.id) || 0) < 120) return;
        last.set(p.id, now);
        let done = 0;
        for (const v of fracs.values()) done += v;
        if (hooks.onProgress) hooks.onProgress({ id: p.id, frac: f, overall: Math.min(1, done / totalDur) });
      },
    };
    log('step', `Converting ${work.length} file(s), ${o.jobs} at a time`);
    await pool(work, o.jobs, async (p) => {
      if (stop || early.has(p.id)) { fracs.set(p.id, p.info.dur); finish(p, 'cancelled', 'cancelled'); return; }
      const job = { cancelled: false, child: null, abort: null };
      jobs.set(p.id, job);
      try {
        const bad = await convertOne(p, o, h, job, ctx);
        finish(p, STATUS[p.action], p.reason, bad);
      } catch (e) {
        fracs.set(p.id, p.info.dur);
        if (e instanceof Cancelled || job.cancelled) finish(p, 'cancelled', 'cancelled');
        else finish(p, 'failed', e.message);
      } finally { jobs.delete(p.id); }
    });
  }
  S.seconds = (Date.now() - t0) / 1000;
  const w = o.dryRun ? 'would be ' : '';
  log(S.failed ? 'warn' : 'ok', `${o.dryRun ? 'Dry run' : 'Run'} finished in ${S.seconds.toFixed(1)} s: ${S.converted} ${w}converted, ${S.retagged} ${w}retagged, ${S.copied} ${w}copied, ${S.skipped} skipped, ${S.failed} failed, ${S.cancelled} cancelled${o.dryRun ? '' : `, ${S.mismatched} with verification mismatches`}`);
  for (const r of S.results) if (r.status === 'failed') log('error', `  failed: ${r.rel}: ${r.reason}`);
  return S;
}

async function ffmpegVersion() {
  const r = await run(FFMPEG.bin, ['-hide_banner', '-version']);
  if (r.code !== 0) throw new Error(r.err || 'could not start');
  return r.out.toString('utf8').split(/\r?\n/)[0];
}

module.exports = { FFMPEG, FFPROBE, DEFAULTS, AUDIO_EXT, FAT_MAX, COVER_MAX, COVER_PX, runAll, scan, probe, safeName, asciiFold, normTags, mp3Head, jpegInfo, run, ffmpegVersion, fmtDur };
