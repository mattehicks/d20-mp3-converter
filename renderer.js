/* global CleanUI, Picker */
(async function () {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const LOGO = '<svg viewBox="0 0 32 32"><g fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 22V8l12-2.5V19"/><path d="M4 13h4M3 17.5h5"/></g><ellipse cx="10" cy="22" rx="3.4" ry="2.7" fill="currentColor"/><ellipse cx="22" cy="19.5" rx="3.4" ry="2.7" fill="currentColor"/></svg>';
  CleanUI.init({ name: 'D20 MP3 Converter', logo: LOGO });
  const log = CleanUI.log;
  const api = window.api;
  const D = await api.defaults();
  const state = { inputs: [], running: false, rows: new Map(), lastDir: '', total: 0, done: 0, dry: false };
  const opts = {};

  // ---- options (every launch starts from the defaults; nothing is saved) ----
  const SELECTS = [
    ['bitrate', 'Bitrate (CBR)', [[192, '192 kbps'], [256, '256 kbps'], [320, '320 kbps']]],
    ['sampleRate', 'Sample rate', [[44100, '44.1 kHz'], [48000, '48 kHz']]],
    ['compatibleMp3', 'MP3s already compatible', [['copy', 'Copy'], ['skip', 'Skip']]],
    ['mp3Audio', 'Other MP3s', [['keep', 'Fix tags/cover, keep audio'], ['strict', 'Re-encode to profile']]],
    ['jobs', `Files at once (${D.cores} cores)`, [1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, String(n)])],
  ];
  const CHECKS = [
    ['keepStructure', 'Keep source folder structure'],
    ['skipExisting', 'Skip existing outputs'],
    ['asciiNames', 'ASCII-only file names'],
    ['numbered', '"NN - Title" file names from tags'],
    ['titleFromName', 'Use the file name when the title tag is missing'],
    ['folderArt', 'Use folder.jpg or a same-named image when tags have no cover'],
    ['saveCovers', 'Also write folder.jpg into output folders'],
    ['lossyCap', '192 kbps for lossy sources at 160 kbps or less'],
    ['loudnorm', 'Loudness normalisation (EBU R128, -16 LUFS)'],
  ];
  for (const [key, label, values] of SELECTS) {
    opts[key] = D[key];
    const row = el('div', 'opt');
    const sel = el('select');
    sel.id = 'opt-' + key;
    for (const [v, t] of values) { const o = el('option', '', t); o.value = String(v); sel.append(o); }
    sel.value = String(D[key]);
    sel.onchange = () => { opts[key] = typeof D[key] === 'number' ? Number(sel.value) : sel.value; log('info', `Option ${key} = ${opts[key]}`); };
    row.append(el('label', '', label), sel);
    $('opts').append(row);
  }
  $('opts').append(el('div', 'optsep'));
  for (const [key, label] of CHECKS) {
    opts[key] = D[key];
    const row = el('div', 'opt chk');
    const lab = el('label');
    const box = el('input');
    box.type = 'checkbox';
    box.id = 'opt-' + key;
    box.checked = !!D[key];
    box.onchange = () => { opts[key] = box.checked; log('info', `Option ${key} = ${opts[key]}`); };
    lab.append(box, el('span', '', label));
    row.append(lab);
    $('opts').append(row);
  }

  // ---- inputs ----
  function renderInputs() {
    const box = $('inputs');
    box.textContent = '';
    if (!state.inputs.length) { box.append(el('div', 'hint', 'Drop music files or folders anywhere in this window.')); return; }
    for (const it of state.inputs) {
      const row = el('div', 'in');
      const p = el('span', 'p', it.path);
      p.title = it.path;
      const x = el('button', '', '×');
      x.title = 'Remove from the list';
      x.onclick = () => { if (state.running) return; state.inputs = state.inputs.filter((i) => i !== it); renderInputs(); };
      row.append(el('span', 'kind', it.isDir ? 'FOLDER' : 'FILE'), p, x);
      box.append(row);
    }
  }
  async function addPaths(paths) {
    if (state.running || !paths || !paths.length) return;
    for (const s of await api.statPaths(paths)) {
      if (!s.ok) { log('error', `Cannot add ${s.path}: ${s.error}`); continue; }
      if (state.inputs.some((i) => i.path.toLowerCase() === s.path.toLowerCase())) continue;
      state.inputs.push({ path: s.path, isDir: s.isDir });
      state.lastDir = s.path;
      log('ok', `Added ${s.isDir ? 'folder' : 'file'} ${s.path}`);
    }
    renderInputs();
  }
  $('btn-add-files').onclick = async () => addPaths(await Picker.open({ mode: 'files', title: 'Add music files', filter: 'any', start: state.lastDir }));
  $('btn-add-folder').onclick = async () => { const d = await Picker.open({ mode: 'folder', title: 'Add a music folder (subfolders included)', filter: 'any', start: state.lastDir }); if (d) addPaths([d]); };
  $('btn-clear').onclick = () => { if (state.running) return; state.inputs = []; renderInputs(); log('info', 'Input list cleared'); };
  $('btn-out').onclick = async () => { const d = await Picker.open({ mode: 'folder', title: 'Choose the output folder', filter: 'any', start: $('out-path').value.trim() }); if (d) { $('out-path').value = d; log('ok', `Output folder: ${d}`); } };

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    addPaths([...e.dataTransfer.files].map((f) => window.clean.pathForFile(f)).filter(Boolean));
  });

  // ---- file table ----
  const DONE = ['converted', 'retagged', 'copied', 'skipped', 'failed', 'cancelled'];
  const WOULD = { converted: 'Would convert', retagged: 'Would retag (audio untouched)', copied: 'Would copy', skipped: 'Would skip', failed: 'Would fail', cancelled: 'Cancelled' };
  const SAID = { converted: 'Converted, verified', retagged: 'Retagged, verified (audio untouched)', copied: 'Copied, verified', skipped: 'Skipped', failed: 'Failed', cancelled: 'Cancelled' };
  function setOverall(frac, text) { $('overall-bar').style.width = Math.round(frac * 1000) / 10 + '%'; $('overall-text').textContent = text; }
  function setRowState(r, cls) { r.root.className = 'row ' + cls; }
  function makeRow(it) {
    const root = el('div', 'row queued');
    root.dataset.id = it.id;
    const name = el('span', 'c-name', it.rel);
    name.title = it.src;
    const dest = el('small', '', '');
    name.append(dest);
    const st = el('span', 'c-st');
    const text = el('span', '', 'Queued');
    const bar = el('div', 'bar');
    const fill = el('i');
    bar.append(fill);
    st.append(text, bar);
    const xc = el('span', 'c-x');
    const x = el('button', '', '×');
    x.title = 'Cancel this file';
    x.onclick = () => api.cancelOne(it.id);
    xc.append(x);
    const src = el('span', 'c-src', '');
    const act = el('span', 'c-act', '');
    root.append(el('span', 'c-n', String(it.id)), name, src, act, st, xc);
    return { root, dest, src, act, text, fill, st };
  }
  const onEvent = {
    items(items) {
      $('rows').textContent = '';
      $('rows').className = '';
      state.rows.clear();
      state.total = items.length;
      state.done = 0;
      if (!items.length) $('rows').append(el('div', 'empty', 'No audio files found in the inputs.'));
      const frag = document.createDocumentFragment();
      for (const it of items) { const r = makeRow(it); state.rows.set(it.id, r); frag.append(r.root); }
      $('rows').append(frag);
    },
    stage(s) { setOverall(0, `Reading files with ffprobe: ${s.done} of ${s.total}`); },
    plan(p) {
      const r = state.rows.get(p.id);
      if (!r) return;
      r.src.textContent = p.desc;
      r.src.title = [p.desc, p.art ? 'cover: ' + p.art : 'no cover', ...Object.entries(p.tags).map(([k, v]) => `${k}: ${v}`)].join('\n');
      r.act.textContent = p.action;
      r.text.textContent = p.reason + (p.note ? ' (' + p.note + ')' : '');
      if (p.dests.length && p.action !== 'skip' && p.action !== 'fail') { r.dest.textContent = '→ ' + p.dests.map((d) => d.split('\\').pop()).join(' + '); r.dest.title = p.dests.join('\n'); }
    },
    progress(p) {
      const r = state.rows.get(p.id);
      if (r) { if (!r.root.classList.contains('active')) setRowState(r, 'active'); r.fill.style.width = Math.round(p.frac * 100) + '%'; r.text.textContent = Math.round(p.frac * 100) + '%'; }
      setOverall(p.overall, `${Math.round(p.overall * 100)}%   ${state.done} of ${state.total} files finished`);
    },
    result(res) {
      state.done++;
      const r = state.rows.get(res.id);
      if (!r) return;
      setRowState(r, res.status + (res.mismatches.length ? ' mismatch' : ''));
      let t = (state.dry ? WOULD : SAID)[res.status] || res.status;
      if (res.status === 'failed' || res.status === 'skipped' || state.dry) t += ': ' + res.reason;
      if (res.mismatches.length) t = `${SAID[res.status].split(',')[0]}, verification mismatch: ${res.mismatches.join('; ')}`;
      r.text.textContent = t;
      r.st.title = t;
    },
  };
  api.onEvent((ev) => { if (onEvent[ev.type]) onEvent[ev.type](ev.data); });

  function showSummary(s) {
    const box = $('summary');
    box.textContent = '';
    const w = s.dryRun ? 'would be ' : '';
    const chips = [['', 'all', s.total], ['converted', w + 'converted', s.converted], ['retagged', w + 'retagged', s.retagged], ['copied', w + 'copied', s.copied], ['skipped', 'skipped', s.skipped], ['failed', 'failed', s.failed], ['cancelled', 'cancelled', s.cancelled]];
    if (!s.dryRun) chips.push(['mismatch', 'verification mismatches', s.mismatched]);
    for (const [cls, label, n] of chips) {
      const c = el('button', 'chip ' + cls);
      c.dataset.filter = cls;
      const b = el('b', '', String(n));
      c.append(b, document.createTextNode(label));
      c.onclick = () => {
        for (const o of box.children) o.classList.toggle('on', o === c && !!cls);
        $('rows').classList.toggle('filtered', !!cls);
        for (const r of state.rows.values()) r.root.classList.toggle('show', !!cls && r.root.classList.contains(cls));
      };
      box.append(c);
    }
  }

  function setRunning(on) {
    state.running = on;
    for (const id of ['btn-start', 'btn-dry', 'btn-add-files', 'btn-add-folder', 'btn-clear', 'btn-out', 'out-path']) $(id).disabled = on;
    for (const n of document.querySelectorAll('#opts select, #opts input')) n.disabled = on;
    $('btn-cancel').disabled = !on;
  }

  async function start(dryRun) {
    if (state.running) return;
    if (!state.inputs.length) { log('warn', 'Add at least one file or folder first'); return; }
    const outDir = $('out-path').value.trim().replace(/^"|"$/g, '');
    if (outDir && !dryRun && !(await window.clean.fsExists(outDir))) {
      const i = await Picker.ask({ title: 'Create folder', message: 'The output folder does not exist yet. Create it?', detail: outDir, buttons: ['Create folder', 'Cancel'], primary: 0 });
      if (i !== 0) return;
      const made = await api.makeDir(outDir);
      if (!made.ok) return;
    }
    state.dry = dryRun;
    setRunning(true);
    $('summary').textContent = '';
    setOverall(0, 'Scanning inputs');
    const s = await api.run(state.inputs.map((i) => i.path), { ...opts, outDir, dryRun });
    setRunning(false);
    if (s.error) { setOverall(0, 'Stopped: ' + s.error); return; }
    showSummary(s);
    const w = s.dryRun ? 'would be ' : '';
    setOverall(1, `${s.dryRun ? 'Dry run' : 'Finished'} in ${s.seconds.toFixed(1)} s: ${s.converted} ${w}converted, ${s.retagged} ${w}retagged, ${s.copied} ${w}copied, ${s.skipped} skipped, ${s.failed} failed, ${s.cancelled} cancelled`);
    document.body.dataset.runs = String((Number(document.body.dataset.runs) || 0) + 1);
  }
  $('btn-start').onclick = () => start(false);
  $('btn-dry').onclick = () => start(true);
  $('btn-cancel').onclick = () => { log('warn', 'Cancel clicked'); api.cancel(); };
  document.body.dataset.ready = '1';
})();
