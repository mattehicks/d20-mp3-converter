// Read-only library survey. Opens files with 'r' only; writes nothing.
// usage: node survey.js <libraryDir> [ffprobePath]
const fs = require('fs'), path = require('path'), { execFile } = require('child_process');
const root = process.argv[2], FFPROBE = process.argv[3] || 'ffprobe';
const AUDIO = new Set(['mp3','m4a','wav','opus','flac','ogg','wma','aac','aiff','aif','ape','wv','mp4','mkv','webm']);
function walk(d, out = { files: [], dirs: [] }) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { out.dirs.push(p); walk(p, out); } else if (e.isFile()) out.files.push(p);
  }
  return out;
}
function probe(f) {
  return new Promise(res => execFile(FFPROBE, ['-v','error','-show_format','-show_streams','-of','json', f],
    { maxBuffer: 1 << 26, windowsHide: true }, (err, so) => { try { res(JSON.parse(so)); } catch { res({ error: String(err) }); } }));
}
function mp3Head(f) { // ID3 version + Xing/Info/VBRI flag, read-only
  const fd = fs.openSync(f, 'r'), size = fs.fstatSync(fd).size, h = Buffer.alloc(10), r = {};
  fs.readSync(fd, h, 0, 10, 0);
  let off = 0;
  if (h.toString('latin1', 0, 3) === 'ID3') {
    r.id3v2 = '2.' + h[3];
    off = 10 + ((h[6] & 127) << 21 | (h[7] & 127) << 14 | (h[8] & 127) << 7 | (h[9] & 127));
  }
  const b = Buffer.alloc(4096); fs.readSync(fd, b, 0, 4096, off);
  const s = b.toString('latin1');
  r.vbrHeader = s.includes('Xing') ? 'Xing(VBR)' : s.includes('VBRI') ? 'VBRI(VBR)' : s.includes('Info') ? 'Info(CBR)' : 'none';
  if (size > 128) { const t = Buffer.alloc(3); fs.readSync(fd, t, 0, 3, size - 128); r.id3v1 = t.toString('latin1') === 'TAG'; }
  fs.closeSync(fd); return r;
}
const inc = (o, k) => { o[k] = (o[k] || 0) + 1; };
(async () => {
  const { files, dirs } = walk(root);
  const S = { root, files: files.length, dirs: dirs.length, bytes: 0, byExt: {}, bytesByExt: {}, perDir: {}, fmt: {}, problems: [] };
  const queue = [];
  for (const f of files) {
    const st = fs.statSync(f), ext = path.extname(f).slice(1).toLowerCase();
    S.bytes += st.size; inc(S.byExt, ext); S.bytesByExt[ext] = (S.bytesByExt[ext] || 0) + st.size;
    inc(S.perDir, path.relative(root, path.dirname(f)) || '.');
    if (st.size >= 4 * 2 ** 30) S.problems.push('>=4GB: ' + f);
    if (AUDIO.has(ext)) queue.push({ f, ext, size: st.size });
  }
  const TAGS = ['title','artist','album','album_artist','track','disc','date','genre'];
  let i = 0;
  async function worker() {
    while (i < queue.length) {
      const q = queue[i++], j = await probe(q.f);
      const F = S.fmt[q.ext] = S.fmt[q.ext] || { n: 0, codec: {}, bitrateK: {}, sampleRate: {}, channels: {}, bits: {}, art: 0, artCodec: {}, artSize: {}, tag: {}, anyTag: 0, id3v2: {}, id3v1: 0, vbr: {}, durH: 0, maxDurMin: 0, nonAscii: 0, illegalFat: 0, longName: 0 };
      F.n++;
      const base = path.basename(q.f);
      if (/[^\x20-\x7e]/.test(base)) F.nonAscii++;
      if (base.length > 120) F.longName++;
      if (j.error || !j.streams) { S.problems.push('probe failed: ' + q.f); continue; }
      const a = j.streams.find(s => s.codec_type === 'audio'), v = j.streams.find(s => s.codec_type === 'video');
      if (!a) { S.problems.push('no audio stream: ' + q.f); continue; }
      inc(F.codec, a.codec_name); inc(F.sampleRate, a.sample_rate); inc(F.channels, a.channels);
      if (a.bits_per_raw_sample || a.bits_per_sample) inc(F.bits, a.bits_per_raw_sample || a.bits_per_sample);
      const br = Math.round((+a.bit_rate || +j.format.bit_rate || 0) / 1000);
      inc(F.bitrateK, q.ext === 'mp3' ? br : Math.round(br / 32) * 32);
      const dur = +j.format.duration || 0; F.durH += dur / 3600; F.maxDurMin = Math.max(F.maxDurMin, Math.round(dur / 60));
      if (v) { F.art++; inc(F.artCodec, v.codec_name + (v.pix_fmt ? '/' + v.pix_fmt : '')); inc(F.artSize, v.width + 'x' + v.height); }
      const tg = {}; for (const [k, val] of Object.entries({ ...(j.format.tags || {}), ...(a.tags || {}) })) tg[k.toLowerCase()] = val;
      let any = false; for (const t of TAGS) if (tg[t]) { inc(F.tag, t); any = true; }
      if (any) F.anyTag++;
      if (q.ext === 'mp3') { const h = mp3Head(q.f); inc(F.id3v2, h.id3v2 || 'none'); if (h.id3v1) F.id3v1++; inc(F.vbr, h.vbrHeader); }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  for (const F of Object.values(S.fmt)) F.durH = +F.durH.toFixed(1);
  console.log(JSON.stringify(S, null, 1));
})();
