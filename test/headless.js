// Headless test: converts every fixture and checks each output independently of the engine's own verifier
// (ffprobe for stream facts, a hand-written ID3v2 parser for tag version, text encodings and the cover JPEG).
// Usage: node test/make-fixtures.js && node test/headless.js
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const E = require('../engine');

const TMP = path.join(__dirname, 'tmp');
const IN = path.join(TMP, 'in');
let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  FAIL: ' + msg); } };
const section = (s) => console.log('\n== ' + s);
const walk = (d, o = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, o); else o.push(p); } return o; };
const sha = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const snapshot = (d) => walk(d).sort().map((f) => `${path.relative(d, f)}|${fs.statSync(f).size}|${fs.statSync(f).mtimeMs}|${sha(f)}`).join('\n');
const ffprobe = (f) => JSON.parse(execFileSync(E.FFPROBE.bin, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', f], { maxBuffer: 1 << 26 }).toString('utf8'));
const fresh = (name) => { const d = path.join(TMP, name); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d; };

function id3(file) {
  const b = fs.readFileSync(file);
  if (b.toString('latin1', 0, 3) !== 'ID3') return { ver: null, frames: {}, enc: [] };
  const size = ((b[6] & 127) << 21) | ((b[7] & 127) << 14) | ((b[8] & 127) << 7) | (b[9] & 127);
  const r = { ver: b[3], frames: {}, enc: [], apic: null, id3v1: b.toString('latin1', b.length - 128, b.length - 125) === 'TAG' };
  let i = 10;
  while (i + 10 <= 10 + size) {
    const id = b.toString('latin1', i, i + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const len = b.readUInt32BE(i + 4);
    const body = b.subarray(i + 10, i + 10 + len);
    if (id === 'APIC') {
      let j = 1;
      while (body[j] !== 0) j++;
      const mime = body.toString('latin1', 1, j);
      const type = body[j + 1];
      j += 2;
      if (body[0] === 1) { while (!(body[j] === 0 && body[j + 1] === 0)) j += 2; j += 2; } else { while (body[j] !== 0) j++; j++; }
      r.apic = { mime, type, data: body.subarray(j) };
    } else if (id[0] === 'T') {
      r.enc.push(body[0]);
      r.frames[id] = body[0] === 1 ? new TextDecoder('utf-16').decode(body.subarray(1)).replace(/\0+$/, '') : body.toString('latin1', 1).replace(/\0+$/, '');
    }
    i += 10 + len;
  }
  return r;
}

function checkOutput(file, exp) {
  const name = path.basename(file);
  const j = ffprobe(file);
  const a = j.streams.find((s) => s.codec_type === 'audio');
  const v = j.streams.find((s) => s.codec_type === 'video');
  const tag = id3(file);
  const stem = name.replace(/\.mp3$/, '');
  ok(a && a.codec_name === 'mp3', `${name}: codec ${a && a.codec_name}`);
  ok(Math.abs(+j.format.duration - exp.dur) <= 1, `${name}: duration ${j.format.duration} vs ${exp.dur}`);
  ok(fs.statSync(file).size <= E.FAT_MAX, `${name}: over 4 GB`);
  ok(!/[\\/:*?"<>|\x00-\x1f]/.test(stem) && !/[. ]$/.test(stem) && stem.length <= 100, `${name}: unsafe file name`);
  if (exp.ascii !== false) ok(/^[\x20-\x7e]+$/.test(name), `${name}: non-ASCII file name`);
  if (exp.encoded) {
    ok(+a.sample_rate === (exp.rate || 44100), `${name}: sample rate ${a.sample_rate}`);
    ok(a.channels === 2, `${name}: channels ${a.channels}`);
    ok(Math.abs(+a.bit_rate - (exp.kbps || 256) * 1000) <= 3000, `${name}: bitrate ${a.bit_rate}`);
    ok(!E.mp3Head(file).vbr, `${name}: has VBR header`);
  }
  if (!exp.copied) {
    ok(tag.ver === 3, `${name}: ID3v2.${tag.ver}`);
    ok(tag.enc.every((e) => e === 0 || e === 1), `${name}: text encodings ${tag.enc} (want 0=ISO-8859-1 or 1=UTF-16)`);
    ok(!tag.id3v1, `${name}: has ID3v1 trailer`);
  }
  const FR = { title: 'TIT2', artist: 'TPE1', album: 'TALB', album_artist: 'TPE2', track: 'TRCK', disc: 'TPOS', date: 'TYER', genre: 'TCON' };
  for (const [k, val] of Object.entries(exp.tags || {})) ok(tag.frames[FR[k]] === val, `${name}: ${FR[k]} is "${tag.frames[FR[k]]}", want "${val}"`);
  if (exp.art) {
    ok(!!tag.apic && v && v.codec_name === 'mjpeg', `${name}: cover missing`);
    if (tag.apic) {
      const ji = E.jpegInfo(tag.apic.data);
      ok(tag.apic.mime === 'image/jpeg' && (exp.copied || tag.apic.type === 3), `${name}: APIC ${tag.apic.mime} type ${tag.apic.type}`);
      ok(ji.sof === 0xc0, `${name}: cover is not baseline JPEG (SOF marker ${ji.sof.toString(16)})`);
      ok(ji.w <= 500 && ji.h <= 500, `${name}: cover ${ji.w}x${ji.h}`);
      ok(tag.apic.data.length <= 200 * 1024, `${name}: cover ${tag.apic.data.length} bytes`);
      if (exp.art !== true) ok(`${ji.w}x${ji.h}` === exp.art, `${name}: cover ${ji.w}x${ji.h}, want ${exp.art}`);
    }
  } else if (exp.art === false) ok(!tag.apic, `${name}: unexpected cover`);
}
module.exports = { id3, checkOutput, snapshot, walk, ffprobe, counts: () => ({ pass, fail }) };
if (require.main !== module) return;

const quiet = { log: () => {} };
const audioMd5 = (f) => execFileSync(E.FFMPEG.bin, ['-v', 'error', '-i', f, '-map', '0:a:0', '-c', 'copy', '-f', 'md5', '-']).toString().trim();
const rel = (d) => walk(d).map((f) => path.relative(d, f).replace(/\\/g, '/')).sort();
const UNI = { title: 'Ünïcödé — 日本語 ✓', artist: 'Björk & Sigur Rós', album: 'Ágætis byrjun', album_artist: 'Värious', track: '3/12', disc: '1/2', date: '1999', genre: 'Post-rock' };
const ODD = "Rock 'n' Roll ~ 100% #1 & (it's) [odd]; name";

(async () => {
  console.log(`ffmpeg:  ${E.FFMPEG.bin} (${E.FFMPEG.src})\nffprobe: ${E.FFPROBE.bin} (${E.FFPROBE.src})`);
  ok(E.FFMPEG.src === 'bundled' && E.FFPROBE.src === 'bundled', 'bundled binaries not in use');

  section('file names');
  const D = E.DEFAULTS;
  ok(E.safeName('AC/DC: "Who?" <Live> *Best* |1|\\', D) === 'AC DC Who Live Best 1', 'illegal characters: ' + E.safeName('AC/DC: "Who?" <Live> *Best* |1|\\', D));
  ok(E.safeName('trailing dots... ', D) === 'trailing dots', 'trailing dots');
  ok(E.safeName('N̲i̲ne Ｉnch — Панк', D) === 'Nine Inch', 'ascii fold: ' + E.safeName('N̲i̲ne Ｉnch — Панк', D));
  ok(E.safeName('Панк', D) === 'untitled', 'empty after fold');
  ok(E.safeName('Панк?', { ...D, asciiNames: false }) === 'Панк', 'unicode kept');
  ok(E.safeName('x'.repeat(300), D).length === 100, 'length limit');
  ok(E.safeName('NUL', D) === '_NUL' && E.safeName('com1.x', D) === '_com1.x', 'reserved names');
  ok(E.safeName('a\tb\u0001c', D) === 'a bc', 'control characters');

  const before = snapshot(IN);

  section('dry run');
  const dryDir = path.join(TMP, 'out-dry');
  fs.rmSync(dryDir, { recursive: true, force: true });
  let s = await E.runAll([IN], { outDir: dryDir, dryRun: true }, quiet);
  ok(!fs.existsSync(dryDir), 'dry run created the output folder');
  ok(s.total === 20 && s.converted === 15 && s.retagged === 2 && s.copied === 1 && s.failed === 2, 'dry-run counts ' + JSON.stringify({ ...s, results: 0 }));

  section('default profile');
  const out1 = fresh('out1');
  s = await E.runAll([IN], { outDir: out1 }, quiet);
  console.log(`  ${s.converted} converted, ${s.retagged} retagged, ${s.copied} copied, ${s.skipped} skipped, ${s.failed} failed, ${s.mismatched} mismatched in ${s.seconds.toFixed(1)} s`);
  ok(s.converted === 15 && s.retagged === 2 && s.copied === 1 && s.failed === 2 && s.mismatched === 0, 'run counts');
  const failed = s.results.filter((r) => r.status === 'failed');
  ok(failed.length === 2 && failed.every((r) => r.reason.length > 5), 'failure reasons present');
  failed.forEach((r) => console.log(`  failed as expected: ${r.rel}: ${r.reason}`));
  const want = {
    'aac 128.mp3': { encoded: 1, art: false, tags: { title: 'AAC track', artist: 'Fixture', date: '2020', genre: 'Test' } },
    'aac inside.mp3': { encoded: 1, art: false, tags: { title: 'aac inside' } },
    'Album Unicode/01 alac track.mp3': { encoded: 1, art: '500x500', tags: { title: 'ALAC track', album: 'Album Ünïcode', track: '1' } },
    'Album Unicode/02 aiff track.mp3': { encoded: 1, art: '500x500', tags: { title: 'Aiff track', artist: 'Fixture', track: '2' } },
    'bare no id3.mp3': { art: false, tags: { title: 'bare no id3' } },
    'compliant.mp3': { copied: 1, art: true, tags: { title: 'Compliant' } },
    'hires 96k 24bit.mp3': { encoded: 1, art: false, tags: { title: 'Hi-res', artist: 'Ninety Six', album: 'Bits', track: '1' } },
    'id3v24 vbr 48k png cover.mp3': { art: '500x281', tags: { title: 'Needs retag ☃', artist: 'Fixture', date: '2011' } },
    'no tags.mp3': { encoded: 1, art: false, tags: { title: 'no tags' } },
    'opus track.mp3': { encoded: 1, art: false, tags: { title: 'Opus track', artist: 'Fixture' } },
    [ODD + '.mp3']: { encoded: 1, art: false, tags: { title: 'AC/DC: "Who?" <Live> *Best* |1|\\', artist: "Rock 'n' Roll", track: '7', disc: '2' } },
    'surround 5.1.mp3': { encoded: 1, art: false, tags: { title: 'Surround', artist: 'Six Channels' } },
    'unicode cover.mp3': { encoded: 1, art: '500x500', tags: UNI },
    'video/clip.mp3': { encoded: 1, art: false, tags: { title: 'MKV video' } },
    'video/clip (2).mp3': { encoded: 1, art: false, tags: { title: 'MP4 video' } },
    'video/clip (3).mp3': { encoded: 1, art: false, tags: { title: 'WebM video' } },
    'wavpack track.mp3': { encoded: 1, art: false, tags: { title: 'WavPack track', artist: 'Fixture' } },
    'wma track.mp3': { encoded: 1, art: false, tags: { title: 'WMA track', artist: 'Fixture', album: 'Windows', track: '4', date: '2005', genre: 'Rock' } },
  };
  ok(JSON.stringify(rel(out1)) === JSON.stringify(Object.keys(want).sort()), 'output set: ' + rel(out1).join(', '));
  for (const [name, exp] of Object.entries(want)) { if (fs.existsSync(path.join(out1, name))) checkOutput(path.join(out1, name), { dur: 6, ...exp }); }
  ok(Buffer.compare(fs.readFileSync(path.join(out1, 'compliant.mp3')), fs.readFileSync(path.join(IN, 'compliant.mp3'))) === 0, 'compliant.mp3 not copied byte for byte');
  for (const n of ['id3v24 vbr 48k png cover.mp3', 'bare no id3.mp3']) ok(audioMd5(path.join(out1, n)) === audioMd5(path.join(IN, n)), `${n}: audio stream changed by retag`);
  ok(id3(path.join(out1, 'unicode cover.mp3')).enc.includes(1) && id3(path.join(out1, 'wma track.mp3')).enc.every((e) => e === 0), 'UTF-16 only where needed');

  section('second run skips existing outputs');
  const snap1 = snapshot(out1);
  s = await E.runAll([IN], { outDir: out1 }, quiet);
  ok(s.skipped === 18 && s.converted + s.retagged + s.copied === 0, 'skip counts ' + s.skipped);
  ok(snapshot(out1) === snap1, 'outputs were modified by the second run');

  section('320 kbps / 48 kHz / numbered / Unicode names / flat / strict MP3 / save covers');
  const out2 = fresh('out2');
  s = await E.runAll([IN], { outDir: out2, bitrate: 320, sampleRate: 48000, numbered: true, asciiNames: false, keepStructure: false, mp3Audio: 'strict', saveCovers: true }, quiet);
  ok(s.converted === 18 && s.failed === 2 && s.mismatched === 0, 'strict counts ' + JSON.stringify({ ...s, results: 0 }));
  const o2 = rel(out2);
  const uniName = '03 - Ünïcödé — 日本語 ✓.mp3';
  ok(o2.includes(uniName), 'numbered Unicode name: ' + o2.join(', '));
  ok(o2.includes('2-07 - AC DC Who Live Best 1.mp3'), 'title with illegal characters became a safe name');
  ok(o2.includes('folder.jpg') && E.jpegInfo(fs.readFileSync(path.join(out2, 'folder.jpg'))).sof === 0xc0, 'folder.jpg written');
  for (const n of o2.filter((x) => x.endsWith('.mp3'))) checkOutput(path.join(out2, n), { dur: 6, encoded: 1, kbps: 320, rate: 48000, ascii: false });

  section('compatible MP3 = skip, loudness normalisation, 192 kbps, single-file inputs, lossy cap');
  const out3 = fresh('out3');
  s = await E.runAll([path.join(IN, 'compliant.mp3'), path.join(IN, 'unicode cover.flac'), path.join(IN, 'aac 128.m4a')], { outDir: out3, compatibleMp3: 'skip', lossyCap: true }, quiet);
  ok(s.skipped === 1 && s.converted === 2 && !fs.existsSync(path.join(out3, 'compliant.mp3')), 'compatible MP3 skipped');
  checkOutput(path.join(out3, 'aac 128.mp3'), { dur: 6, encoded: 1, kbps: 192 });
  checkOutput(path.join(out3, 'unicode cover.mp3'), { dur: 6, encoded: 1, kbps: 256, art: true });
  const out4 = fresh('out4');
  s = await E.runAll([path.join(IN, 'unicode cover.flac'), path.join(IN, 'compliant.mp3')], { outDir: out4, loudnorm: true, bitrate: 192 }, quiet);
  ok(s.converted === 2 && s.mismatched === 0, 'loudnorm run');
  checkOutput(path.join(out4, 'unicode cover.mp3'), { dur: 6, encoded: 1, kbps: 192, art: '500x500', tags: UNI });

  section('existing files are never overwritten');
  const out5 = fresh('out5');
  fs.writeFileSync(path.join(out5, 'no tags.mp3'), 'not ours');
  s = await E.runAll([path.join(IN, 'no tags.wav')], { outDir: out5 }, quiet);
  ok(fs.readFileSync(path.join(out5, 'no tags.mp3'), 'utf8') === 'not ours' && fs.existsSync(path.join(out5, 'no tags (2).mp3')), 'existing file overwritten');

  section('default output: same folder as the source');
  const here = fresh('inplace');
  fs.mkdirSync(path.join(here, 'sub'));
  for (const [n, d] of [['unicode cover.flac', ''], ['compliant.mp3', ''], ['id3v24 vbr 48k png cover.mp3', 'sub'], ['no tags.wav', 'sub']]) fs.copyFileSync(path.join(IN, n), path.join(here, d, n));
  const hereBefore = snapshot(here);
  s = await E.runAll([here], {}, quiet);
  ok(s.converted === 2 && s.retagged === 1 && s.skipped === 1 && s.failed === 0 && s.mismatched === 0, 'same-folder counts ' + JSON.stringify({ ...s, results: 0 }));
  ok(JSON.stringify(rel(here)) === JSON.stringify(['compliant.mp3', 'sub/id3v24 vbr 48k png cover (2).mp3', 'sub/id3v24 vbr 48k png cover.mp3', 'sub/no tags.mp3', 'sub/no tags.wav', 'unicode cover.flac', 'unicode cover.mp3']), 'same-folder outputs: ' + rel(here).join(', '));
  ok(hereBefore.split(String.fromCharCode(10)).every((l) => snapshot(here).includes(l)), 'a source changed in same-folder mode');
  checkOutput(path.join(here, 'unicode cover.mp3'), { dur: 6, encoded: 1, art: '500x500', tags: UNI });
  checkOutput(path.join(here, 'sub', 'id3v24 vbr 48k png cover (2).mp3'), { dur: 6, art: '500x281' });
  const hereAfter = snapshot(here);
  s = await E.runAll([here], {}, quiet);
  ok(s.converted + s.retagged + s.copied === 0 && s.skipped === 7 && snapshot(here) === hereAfter, 'same-folder rerun wrote something: ' + JSON.stringify({ ...s, results: 0 }));
  s = await E.runAll([here], { outDir: here }, quiet);
  ok(s.converted + s.retagged + s.copied === 0 && snapshot(here) === hereAfter, 'output folder = input folder wrote something');

  section('size limit: split into parts');
  const long = path.join(TMP, 'long mix.flac');
  const longDur = +ffprobe(long).format.duration;
  const out6 = fresh('out6');
  const limit = Math.ceil((longDur * 24000) / 2.5);
  s = await E.runAll([long], { outDir: out6, bitrate: 192, maxBytes: limit }, quiet);
  const parts = rel(out6);
  console.log(`  ${Math.round(longDur / 60)} min source, limit ${(limit / 1e6).toFixed(1)} MB -> ${parts.join(', ')} in ${s.seconds.toFixed(1)} s`);
  ok(parts.length === 3 && parts[0] === 'long mix (part 1 of 3).mp3', 'split into 3 parts');
  let sum = 0;
  for (const n of parts) { const f = path.join(out6, n); sum += +ffprobe(f).format.duration; ok(fs.statSync(f).size <= limit, `${n} over the limit`); checkOutput(f, { dur: longDur / 3, encoded: 1, kbps: 192 }); }
  ok(Math.abs(sum - longDur) <= 1 && s.mismatched === 0, `parts add up: ${sum} vs ${longDur}`);
  ok(id3(path.join(out6, parts[1])).frames.TIT2 === 'Long mix (part 2 of 3)', 'part title');

  section('cancel mid-file');
  const out7 = fresh('out7');
  const control = {};
  let fired = false;
  s = await E.runAll([long, path.join(IN, 'no tags.wav')], { outDir: out7, jobs: 1 }, { log: () => {}, control, onProgress: (p) => { if (!fired && p.frac > 0.05) { fired = true; control.cancelAll(); } } });
  ok(fired && s.cancelled === 2 && s.converted === 0, 'cancel counts ' + JSON.stringify({ ...s, results: 0 }));
  ok(rel(out7).length === 0, 'partial output left behind: ' + rel(out7).join(', '));

  section('sources untouched');
  ok(snapshot(IN) === before, 'input folder changed (names, sizes, mtimes or SHA-1)');

  console.log(`\n${pass} checks passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
