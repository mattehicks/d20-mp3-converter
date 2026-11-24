// Builds test inputs with the bundled ffmpeg into test/tmp/in. Usage: node test/make-fixtures.js [--long]
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const E = require('../engine');

const TMP = path.join(__dirname, 'tmp');
const IN = path.join(TMP, 'in');
const ASSETS = path.join(TMP, 'assets');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(IN, 'Album Ünïcode'), { recursive: true });
fs.mkdirSync(path.join(IN, 'video'), { recursive: true });
fs.mkdirSync(ASSETS, { recursive: true });

const ff = (...args) => execFileSync(E.FFMPEG.bin, ['-hide_banner', '-v', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
const sine = (f = 440, d = 6, r = 44100) => ['-f', 'lavfi', '-i', `sine=frequency=${f}:duration=${d}:sample_rate=${r}`];
const meta = (o) => Object.entries(o).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
const bare = ['-map_metadata', '-1', '-fflags', '+bitexact'];
const p = (...s) => path.join(IN, ...s);

const coverPng = path.join(ASSETS, 'cover-1400.png');
const coverWide = path.join(ASSETS, 'cover-1280x720.png');
ff('-f', 'lavfi', '-i', 'testsrc2=size=1400x1400:rate=1', '-frames:v', '1', coverPng);
ff('-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=1', '-frames:v', '1', coverWide);
ff('-f', 'lavfi', '-i', 'mandelbrot=size=1400x1400:rate=1', '-frames:v', '1', '-q:v', '1', p('Album Ünïcode', 'folder.jpg'));
ff('-f', 'lavfi', '-i', 'testsrc2=size=300x300:rate=1', '-frames:v', '1', '-q:v', '4', '-pix_fmt', 'yuvj420p', path.join(ASSETS, 'small.jpg'));

const UNI = { title: 'Ünïcödé — 日本語 ✓', artist: 'Björk & Sigur Rós', album: 'Ágætis byrjun', album_artist: 'Värious', track: '3/12', disc: '1/2', date: '1999-06-12', genre: 'Post-rock' };

// 1. Unicode tags + large PNG cover
ff(...sine(), '-i', coverPng, '-map', '0:a', '-map', '1:v', '-c:a', 'flac', '-c:v', 'png', '-disposition:v', 'attached_pic', ...meta(UNI), p('unicode cover.flac'));
// 2. 5.1 surround
ff('-f', 'lavfi', '-i', 'aevalsrc=0.2*sin(2*PI*440*t)|0.2*sin(2*PI*550*t)|0.2*sin(2*PI*330*t)|0.2*sin(2*PI*60*t)|0.2*sin(2*PI*660*t)|0.2*sin(2*PI*770*t):c=5.1:s=48000:d=6', '-c:a', 'flac', ...meta({ title: 'Surround', artist: 'Six Channels' }), p('surround 5.1.flac'));
// 3. 96 kHz / 24-bit
ff(...sine(1000, 6, 96000), '-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', ...meta({ title: 'Hi-res', artist: 'Ninety Six', album: 'Bits', track: '1' }), p('hires 96k 24bit.flac'));
// 4. no tags at all
ff(...sine(300, 6, 48000), '-c:a', 'pcm_s16le', ...bare, p('no tags.wav'));
// 5. awkward file name (Windows cannot create \ / : * ? " < > | in a name, so those come in through the title tag below)
ff(...sine(500), '-c:a', 'libvorbis', '-q:a', '4', ...meta({ title: 'AC/DC: "Who?" <Live> *Best* |1|\\', artist: "Rock 'n' Roll", track: '7', disc: '2' }), p("Rock 'n' Roll ~ 100% #1 & (it's) [odd]; name... .ogg"));
// one of each remaining input format
ff(...sine(520), '-c:a', 'pcm_s16be', '-write_id3v2', '1', ...meta({ title: 'Aiff track', artist: 'Fixture', album: 'Album Ünïcode', track: '2' }), p('Album Ünïcode', '02 aiff track.aiff'));
ff(...sine(540), '-c:a', 'aac', '-b:a', '128k', ...meta({ title: 'AAC track', artist: 'Fixture', date: '2020', genre: 'Test' }), p('aac 128.m4a'));
ff(...sine(560), '-c:a', 'alac', ...meta({ title: 'ALAC track', artist: 'Fixture', album: 'Album Ünïcode', track: '1' }), p('Album Ünïcode', '01 alac track.m4a'));
ff(...sine(580, 6, 48000), '-c:a', 'libopus', '-b:a', '128k', ...meta({ title: 'Opus track', artist: 'Fixture' }), p('opus track.opus'));
ff(...sine(600), '-c:a', 'wmav2', '-b:a', '128k', ...meta({ title: 'WMA track', artist: 'Fixture', album: 'Windows', track: '4', date: '2005', genre: 'Rock' }), p('wma track.wma'));
ff(...sine(620), '-c:a', 'wavpack', ...meta({ title: 'WavPack track', artist: 'Fixture' }), p('wavpack track.wv'));
const vid = ['-f', 'lavfi', '-i', 'testsrc2=size=128x72:rate=10:duration=6'];
ff(...vid, ...sine(640), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', ...meta({ title: 'MP4 video' }), p('video', 'clip.mp4'));
ff(...vid, ...sine(660), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'flac', '-shortest', ...meta({ title: 'MKV video' }), p('video', 'clip.mkv'));
ff(...vid, ...sine(680, 6, 48000), '-c:v', 'libvpx', '-b:v', '100k', '-c:a', 'libvorbis', '-shortest', ...meta({ title: 'WebM video' }), p('video', 'clip.webm'));
// MP3 inputs
ff(...sine(700), '-i', path.join(ASSETS, 'small.jpg'), '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-b:a', '192k', '-c:v', 'copy', '-disposition:v', 'attached_pic', '-id3v2_version', '3', ...meta({ title: 'Compliant', artist: 'Fixture' }), p('compliant.mp3'));
ff(...sine(720, 6, 48000), '-i', coverWide, '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-q:a', '4', '-c:v', 'png', '-disposition:v', 'attached_pic', '-id3v2_version', '4', ...meta({ title: 'Needs retag ☃', artist: 'Fixture', date: '2011' }), p('id3v24 vbr 48k png cover.mp3'));
ff(...sine(740), '-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '0', '-write_xing', '0', ...bare, p('bare no id3.mp3'));
ff(...sine(760), '-c:a', 'aac', '-b:a', '128k', '-f', 'adts', ...bare, path.join(ASSETS, 'x.aac'));
fs.copyFileSync(path.join(ASSETS, 'x.aac'), p('aac inside.mp3'));
// broken inputs
fs.writeFileSync(p('broken.flac'), Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7919) % 251)));
fs.writeFileSync(p('empty.wav'), Buffer.alloc(0));
fs.writeFileSync(p('notes.txt'), 'not audio');
// long file for cancel tests
const mins = process.argv.includes('--long') ? 90 : 20;
ff(...sine(220, mins * 60), '-c:a', 'flac', ...meta({ title: 'Long mix', artist: 'Fixture' }), path.join(TMP, 'long mix.flac'));
console.log('fixtures written to', IN);
