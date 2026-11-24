// Real-window end-to-end test over the Chrome DevTools protocol.
//   node test/e2e-cdp.js            runs the dev build (electron .)
//   node test/e2e-cdp.js <app.exe>  runs a packaged build
// Opens a folder through the in-app browser, converts it, cancels one file and one whole run mid-way,
// then closes the window with its own close button and checks the throwaway profile is gone.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch, sleep } = require('./cdp');
const { checkOutput, walk, counts: checkCounts } = require('./headless');

const TMP = path.join(__dirname, 'tmp');
const IN = path.join(TMP, 'in');

async function runScenario({ exe, env, outRoot = path.join(TMP, 'e2e'), label = 'dev build' } = {}) {
  const R = { label, pass: 0, fail: 0, notes: [] };
  const ok = (cond, msg) => { if (cond) R.pass++; else { R.fail++; console.log('  FAIL: ' + msg); } };
  fs.rmSync(outRoot, { recursive: true, force: true });
  const out1 = path.join(outRoot, 'out');
  const out2 = path.join(outRoot, 'made by the app');
  fs.mkdirSync(out1, { recursive: true });
  const rel = (d) => (fs.existsSync(d) ? walk(d).map((f) => path.relative(d, f).replace(/\\/g, '/')).sort() : []);
  const chip = (app, cls) => app.js(`Number(document.querySelector('#summary .chip.${cls} b').textContent)`);

  const app = await launch({ exe, env });
  try {
    await app.waitFor(`!!document.body && document.body.dataset.ready === '1' && !!document.querySelector('.cu-titlebar')`, 'window ready', 40000);
    const controls = await app.js(`[...document.querySelectorAll('.cu-wc .cu-wb')].map((b) => b.title)`);
    ok(JSON.stringify(controls) === JSON.stringify(['Minimize', 'Maximize / restore', 'Close']), 'window controls order: ' + controls);
    const accent = await app.js(`getComputedStyle(document.querySelector('#btn-start')).backgroundColor`);
    ok(accent === 'rgb(232, 255, 71)', 'accent colour ' + accent);
    ok(await app.js(`document.querySelector('#opt-bitrate').value === '256' && document.querySelector('#opt-sampleRate').value === '44100' && !document.querySelector('#opt-loudnorm').checked && document.querySelector('#out-path').value === '' && !document.querySelector('#inputs .in')`), 'launch did not start from defaults');

    // 1. open the input folder through the in-app browser: type the parent path, then click into the folder
    await app.click(app.q('#btn-add-folder'));
    await app.pickerOpen();
    await app.pickerGo(TMP);
    await app.pickerRow('in');
    await app.waitFor(`${app.q('.pk-path')}.value.toLowerCase() === ${JSON.stringify(IN.toLowerCase())}`, 'browser inside the input folder');
    await app.pickerOk();
    await app.waitFor(`document.querySelectorAll('#inputs .in').length === 1`, 'input listed');
    await app.click(app.q('#btn-out'));
    await app.pickerOpen();
    await app.pickerGo(out1);
    await app.pickerOk();
    ok((await app.js(`${app.q('#out-path')}.value`)).toLowerCase() === out1.toLowerCase(), 'output folder set');

    // 2. dry run writes nothing, then the real conversion
    await app.click(app.q('#btn-dry'));
    await app.waitFor(`document.body.dataset.runs === '1'`, 'dry run to finish', 60000);
    ok(rel(out1).length === 0 && await chip(app, 'converted') === 15, 'dry run wrote files or miscounted');
    await app.click(app.q('#btn-start'));
    await app.waitFor(`document.body.dataset.runs === '2'`, 'conversion to finish', 120000);
    const counts = {};
    for (const c of ['converted', 'retagged', 'copied', 'skipped', 'failed', 'cancelled', 'mismatch']) counts[c] = await chip(app, c);
    R.notes.push(`run 1: ${JSON.stringify(counts)}`);
    ok(counts.converted === 15 && counts.retagged === 2 && counts.copied === 1 && counts.failed === 2 && counts.mismatch === 0, 'run counts ' + JSON.stringify(counts));
    ok(rel(out1).length === 18, 'output count ' + rel(out1).length);
    const before = checkCounts().fail;
    checkOutput(path.join(out1, 'unicode cover.mp3'), { dur: 6, encoded: 1, art: '500x500', tags: { album: 'Ágætis byrjun', track: '3/12', date: '1999' } });
    checkOutput(path.join(out1, 'surround 5.1.mp3'), { dur: 6, encoded: 1, art: false });
    ok(checkCounts().fail === before, 'ffprobe / ID3 checks on the outputs');
    const failText = await app.js(`[...document.querySelectorAll('#rows .row.failed .c-st')].map((e) => e.textContent).join(' | ')`);
    ok(/Failed: .{8,}/.test(failText), 'failure reasons shown: ' + failText);
    R.notes.push('failure reasons in window: ' + failText);

    // 3. cancel one file mid-way while another finishes; output folder typed by hand and created by the app
    await app.click(app.q('#btn-clear'));
    await app.click(app.q('#btn-add-files'));
    await app.pickerOpen();
    await app.pickerGo(TMP);
    await app.pickerRow('long mix.flac');
    await app.pickerOk();
    await app.click(app.q('#btn-add-files'));
    await app.pickerOpen();
    await app.pickerGo(IN);
    await app.pickerRow('no tags.wav');
    await app.pickerOk();
    await app.waitFor(`document.querySelectorAll('#inputs .in').length === 2`, 'two files listed');
    await app.type('#out-path', out2);
    await app.click(app.q('#btn-start'));
    await app.click(`document.querySelector('.pk-ask .pk-primary')`, 'create-folder dialog');
    await app.waitFor(`(() => { const r = document.querySelector('#rows .row[data-id="1"]'); return r && r.classList.contains('active') && parseInt(r.querySelector('.c-st span').textContent, 10) >= 3; })()`, 'long file to be mid-way', 60000);
    const midway = await app.js(`document.querySelector('#rows .row[data-id="1"] .c-st span').textContent`);
    await app.click(`document.querySelector('#rows .row[data-id="1"] .c-x button')`, 'cancel button of the long file');
    await app.waitFor(`document.body.dataset.runs === '3'`, 'run with one cancelled file to finish', 60000);
    ok(await chip(app, 'cancelled') === 1 && await chip(app, 'converted') === 1, 'cancel-one counts');
    ok(JSON.stringify(rel(out2)) === JSON.stringify(['no tags.mp3']), 'after cancelling one file the folder holds: ' + rel(out2).join(', '));
    R.notes.push(`cancelled one file at ${midway}; left in folder: ${rel(out2).join(', ')}`);

    // 4. cancel the whole run mid-way with the Cancel button
    await app.click(app.q('#btn-start'));
    await app.waitFor(`(() => { const r = document.querySelector('#rows .row.active'); return r && parseInt(r.querySelector('.c-st span').textContent, 10) >= 3; })()`, 'second run to be mid-way', 60000);
    await app.click(app.q('#btn-cancel'));
    await app.waitFor(`document.body.dataset.runs === '4'`, 'cancelled run to finish', 60000);
    ok(await chip(app, 'cancelled') === 1 && await chip(app, 'skipped') === 1, 'cancel-all counts');
    ok(JSON.stringify(rel(out2)) === JSON.stringify(['no tags.mp3']), 'partial file left after Cancel: ' + rel(out2).join(', '));

    // 5. activity log
    await app.click(`document.querySelector('.cu-titlebar .cu-ib')`, 'log button');
    const logText = await app.js(`document.querySelector('.cu-list').textContent`);
    const logLines = await app.js(`document.querySelectorAll('.cu-ln').length`);
    ok(logLines > 100 && /ffmpeg -hide_banner/.test(logText) && /libmp3lame/.test(logText) && /FAILED/.test(logText) && /Cancel requested/.test(logText) && /verified/.test(logText), 'activity log content');
    R.notes.push(`activity log: ${logLines} lines`);

    // 6. close the window the normal way
    const runDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('d20mp3clean-'));
    ok(runDirs().length >= 1, 'throwaway profile folder exists while running');
    await app.click(`document.querySelector('.cu-wb.cu-x')`, 'close button');
    const code = await app.waitExit(20000);
    ok(code === 0, 'exit code after closing: ' + code);
    // the exit helper overwrites and removes the profile from 2.5 s after exit, retrying while Windows still holds files
    const tExit = Date.now();
    while (runDirs().length && Date.now() - tExit < 30000) await sleep(500);
    ok(runDirs().length === 0, 'profile folder still in %TEMP% after 30 s: ' + runDirs().join(', '));
    R.notes.push(`closed with the title-bar button, exit code ${code}; profile folder gone ${((Date.now() - tExit) / 1000).toFixed(1)} s after exit; d20mp3clean-* folders left in %TEMP%: ${runDirs().length}`);
  } catch (e) {
    R.fail++;
    console.log('  FAIL: ' + e.message);
    try { app.child.kill(); } catch (err) { /* gone */ }
  } finally { app.close(); }
  R.outRoot = outRoot;
  return R;
}

module.exports = { runScenario };
if (require.main === module) {
  runScenario({ exe: process.argv[2], label: process.argv[2] ? path.basename(process.argv[2]) : 'dev build' }).then((R) => {
    R.notes.forEach((n) => console.log('  ' + n));
    console.log(`\n${R.label}: ${R.pass} checks passed, ${R.fail} failed`);
    process.exit(R.fail ? 1 : 0);
  });
}
