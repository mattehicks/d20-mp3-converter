// In-app file browser. Replaces the Windows Open/Save dialogs so the shell never sees what you browse
// (no Recent-files entries, no dialog history, no shell thumbnails). It lists folders through
// window.clean.fsList (plain directory reads) and draws everything itself.
//
//   Picker.open({ mode: 'files' | 'file' | 'folder' | 'save', title, filter: 'video'|'image'|'media'|'any',
//                 start: '<path>', defaultName: 'x.mp4', ext: '.mp4' })  ->  Promise<string[] | string | null>
(function () {
  const BS = String.fromCharCode(92);
  const VIDEO = /\.(mp4|mov|mkv|avi|webm|m4v|wmv|flv|mpg|mpeg|ogv)$/i;
  const IMAGE = /\.(png|jpe?g|gif|webp|bmp|tiff?|avif)$/i;
  const FILTERS = { video: VIDEO, image: IMAGE, media: { test: (n) => VIDEO.test(n) || IMAGE.test(n) }, any: { test: () => true } };
  const ICON = {
    folder: '<svg viewBox="0 0 24 24"><path d="M3 7h6l2 2h10v10H3z"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v4h4"/></svg>',
    drive: '<svg viewBox="0 0 24 24"><rect x="3" y="8" width="18" height="9" rx="2"/><path d="M7 12.5h.01M11 12.5h6"/></svg>',
    up: '<svg viewBox="0 0 24 24"><path d="M6 14l6-6 6 6M12 8v11"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
  };
  let root = null;
  let S = null;
  const ui = {};

  const log = (level, msg) => { if (window.clean) window.clean.log(level, msg); };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const fmtSize = (b) => {
    if (b < 1024) return b + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let v = b / 1024; let i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i];
  };
  const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const dirOf = (p) => p.slice(0, Math.max(p.lastIndexOf(BS), p.lastIndexOf('/')));
  const joinPath = (d, n) => (d.endsWith(BS) ? d + n : d + BS + n);

  function build() {
    root = el('div', 'pk-back');
    root.hidden = true;
    const box = el('div', 'pk-box');
    const head = el('div', 'pk-head');
    ui.title = el('span', 'pk-title');
    ui.close = el('button', 'pk-ib'); ui.close.innerHTML = ICON.close; ui.close.title = 'Cancel (Esc)';
    head.append(ui.title, ui.close);

    const bar = el('div', 'pk-bar');
    ui.up = el('button', 'pk-ib'); ui.up.innerHTML = ICON.up; ui.up.title = 'Up one level';
    ui.path = el('input', 'pk-path'); ui.path.type = 'text'; ui.path.spellcheck = false; ui.path.placeholder = 'Type a path and press Enter';
    bar.append(ui.up, ui.path);

    const body = el('div', 'pk-body');
    ui.side = el('div', 'pk-side');
    const main = el('div', 'pk-main');
    const cols = el('div', 'pk-cols');
    cols.append(el('span', 'c-name', 'Name'), el('span', 'c-size', 'Size'), el('span', 'c-date', 'Modified'));
    ui.list = el('div', 'pk-list');
    main.append(cols, ui.list);
    body.append(ui.side, main);

    const foot = el('div', 'pk-foot');
    ui.name = el('input', 'pk-name'); ui.name.type = 'text'; ui.name.spellcheck = false; ui.name.placeholder = 'File name';
    ui.info = el('span', 'pk-info');
    ui.chkWrap = el('label', 'pk-chk');
    ui.chkInput = document.createElement('input');
    ui.chkInput.type = 'checkbox';
    ui.chkText = el('span');
    ui.chkWrap.append(ui.chkInput, ui.chkText);
    ui.chkWrap.style.display = 'none';
    ui.cancel = el('button', 'pk-btn', 'Cancel');
    ui.ok = el('button', 'pk-btn pk-primary', 'OK');
    foot.append(ui.name, ui.info, ui.chkWrap, ui.cancel, ui.ok);

    box.append(head, bar, body, foot);
    root.append(box);
    document.body.append(root);

    ui.close.onclick = ui.cancel.onclick = () => finish(null);
    ui.up.onclick = () => { if (S && S.cwd) go(S.parent); };
    ui.ok.onclick = confirm;
    ui.path.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(ui.path.value.trim().replace(/^"|"$/g, '')); });
    ui.name.addEventListener('input', () => { if (S) { S.confirmed = false; refreshFooter(); } });
    ui.name.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirm(); });
    root.addEventListener('mousedown', (e) => { if (e.target === root) finish(null); });
    // keys typed in the browser must never reach the app's own shortcuts (e.g. D = delete, 1/2/3 = move)
    root.addEventListener('keydown', (e) => { e.stopPropagation(); });
    root.addEventListener('keyup', (e) => { e.stopPropagation(); });
    document.addEventListener('keydown', (e) => {
      if (root.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
    }, true);
  }

  async function sideList() {
    ui.side.textContent = '';
    const r = await window.clean.fsRoots();
    const add = (label, items, icon) => {
      ui.side.append(el('div', 'pk-sh', label));
      for (const it of items) {
        const b = el('button', 'pk-place');
        b.innerHTML = icon;
        b.append(document.createTextNode(it.name));
        b.title = it.path;
        b.onclick = () => go(it.path);
        ui.side.append(b);
      }
    };
    const pc = el('button', 'pk-place');
    pc.innerHTML = ICON.drive; pc.append(document.createTextNode('This PC')); pc.onclick = () => go('');
    ui.side.append(pc);
    add('Places', r.places, ICON.folder);
    add('Drives', r.drives, ICON.drive);
  }

  async function go(dir) {
    if (!S) return;
    const r = await window.clean.fsList(dir);
    if (!S) return; // closed while the listing was loading
    if (r.error) {
      ui.info.textContent = r.error;
      ui.info.classList.add('bad');
      log('error', `Cannot open ${dir}: ${r.error}`);
      return;
    }
    ui.info.classList.remove('bad');
    S.cwd = r.dir;
    S.parent = r.parent;
    S.confirmed = false;
    const rx = FILTERS[S.filter] || FILTERS.any;
    const showFiles = S.mode !== 'folder' || S.filter !== 'any'; // folder mode lists matching files, dimmed, so you can see what is inside
    S.entries = r.entries
      .filter((e) => e.isDir || (showFiles && rx.test(e.name)))
      .sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    ui.path.value = r.dir || 'This PC';
    log('info', `Browsing ${r.dir || 'This PC'} (${S.entries.length} shown)`);
    renderList();
    refreshFooter();
  }

  function renderList() {
    ui.list.textContent = '';
    ui.up.disabled = !S.cwd;
    if (!S.entries.length) ui.list.append(el('div', 'pk-empty', 'Nothing to show here'));
    for (const e of S.entries) {
      const row = el('div', 'pk-row' + (S.sel.has(e.path) ? ' sel' : '') + (!e.isDir && S.mode === 'folder' ? ' dim' : ''));
      const name = el('span', 'c-name');
      name.innerHTML = e.isDir ? (S.cwd ? ICON.folder : ICON.drive) : ICON.file;
      name.append(document.createTextNode(e.name));
      row.title = e.path;
      row.append(name, el('span', 'c-size', e.isDir ? '' : fmtSize(e.size)), el('span', 'c-date', fmtDate(e.mtimeMs)));
      row.onclick = () => {
        if (e.isDir) { go(e.path); return; }
        if (S.mode === 'folder') return;
        if (S.mode === 'files') { if (S.sel.has(e.path)) S.sel.delete(e.path); else S.sel.add(e.path); }
        else if (S.mode === 'file') { S.sel = new Set([e.path]); }
        else if (S.mode === 'save') { ui.name.value = e.name; S.confirmed = false; }
        renderList(); refreshFooter();
      };
      row.ondblclick = () => {
        if (e.isDir) return;
        if (S.mode === 'files') finish([e.path]);
        else if (S.mode === 'file') finish(e.path);
      };
      ui.list.append(row);
    }
  }

  function refreshFooter() {
    const m = S.mode;
    ui.name.style.display = m === 'save' ? '' : 'none';
    if (m === 'files') { ui.ok.textContent = S.sel.size ? `Add ${S.sel.size} file${S.sel.size > 1 ? 's' : ''}` : 'Add'; ui.ok.disabled = !S.sel.size; }
    else if (m === 'file') { ui.ok.textContent = 'Open'; ui.ok.disabled = !S.sel.size; }
    else if (m === 'folder') { ui.ok.textContent = 'Use this folder'; ui.ok.disabled = !S.cwd; }
    else { ui.ok.textContent = S.confirmed ? 'Replace' : 'Save here'; ui.ok.disabled = !S.cwd || !ui.name.value.trim(); }
    if (!ui.info.classList.contains('bad')) {
      ui.info.textContent = m === 'files' ? 'Click files to select several, or double-click one'
        : m === 'folder' ? (S.cwd ? 'Open the folder you want, then choose it' : 'Pick a drive')
        : m === 'save' ? (S.confirmed ? 'That file exists. Click Replace to overwrite it' : 'Choose a folder and a file name') : '';
    }
  }

  async function confirm() {
    if (!S || ui.ok.disabled) return;
    if ((S.mode === 'save' || S.mode === 'folder') && !S.cwd) return; // no folder chosen yet
    if (S.mode === 'files') finish([...S.sel]);
    else if (S.mode === 'file') finish([...S.sel][0]);
    else if (S.mode === 'folder') finish(S.cwd);
    else {
      let name = ui.name.value.trim();
      if (S.ext && !name.toLowerCase().endsWith(S.ext)) name += S.ext;
      const full = joinPath(S.cwd, name);
      if (!S.confirmed && await window.clean.fsExists(full)) { S.confirmed = true; refreshFooter(); return; }
      finish(full);
    }
  }

  function finish(result) {
    if (!S) return;
    const done = S.resolve;
    window.Picker.checked = ui.chkInput.checked;
    log('info', result ? `File browser: chose ${Array.isArray(result) ? result.length + ' file(s)' : result}` : 'File browser: cancelled');
    S = null;
    root.hidden = true;
    done(result);
  }

  async function open(opts = {}) {
    if (!root) build();
    if (S) finish(null);
    return new Promise(async (resolve) => {
      S = { mode: opts.mode || 'file', filter: opts.filter || 'any', ext: opts.ext || '', sel: new Set(), cwd: '', parent: '', entries: [], confirmed: false, resolve };
      ui.title.textContent = opts.title || 'Choose';
      ui.name.value = opts.defaultName || '';
      ui.chkWrap.style.display = opts.checkbox ? '' : 'none';
      ui.chkText.textContent = opts.checkbox || '';
      ui.chkInput.checked = false;
      // reset everything left from the previous use so nothing stale can be clicked while the folder loads
      ui.list.textContent = '';
      ui.ok.disabled = true;
      ui.info.classList.remove('bad');
      ui.info.textContent = 'Loading...';
      root.hidden = false;
      log('step', `File browser opened: ${opts.title || S.mode}`);
      await sideList();
      let start = opts.start || '';
      if (start && /\.[A-Za-z0-9]{1,5}$/.test(start)) start = dirOf(start);
      await go(start);
      if (!S) return;
      if (!S.cwd && start) { const r = await window.clean.fsRoots(); await go(r.places[0] ? r.places[0].path : ''); }
      if (S && S.mode === 'save') ui.name.focus();
    });
  }

  // In-app replacement for a native message box: Picker.ask({ title, message, detail, buttons: ['Delete', 'Cancel'], primary: 0, danger: true }) -> Promise<index, or -1 if dismissed>
  function ask(opts) {
    return new Promise((resolve) => {
      const buttons = opts.buttons || ['OK'];
      const primary = opts.primary === undefined ? 0 : opts.primary;
      const back = el('div', 'pk-back');
      const box = el('div', 'pk-box pk-ask');
      const head = el('div', 'pk-head');
      head.append(el('span', 'pk-title', opts.title || 'Confirm'));
      const body = el('div', 'pk-askbody');
      body.append(el('div', 'pk-askmsg', opts.message || ''));
      if (opts.detail) body.append(el('div', 'pk-askdet', opts.detail));
      const foot = el('div', 'pk-foot');
      foot.append(el('span', 'pk-info'));
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(primary); }
        else e.stopPropagation();
      };
      const done = (i) => {
        document.removeEventListener('keydown', onKey, true);
        back.remove();
        log('info', `Dialog "${opts.title || 'Confirm'}": ${i >= 0 ? buttons[i] : 'dismissed'}`);
        resolve(i);
      };
      let focusBtn = null;
      buttons.forEach((label, i) => {
        const b = el('button', 'pk-btn' + (i === primary ? (opts.danger ? ' pk-danger' : ' pk-primary') : ''), label);
        b.onclick = () => done(i);
        if (i === primary) focusBtn = b;
        foot.append(b);
      });
      document.addEventListener('keydown', onKey, true);
      box.append(head, body, foot);
      back.append(box);
      document.body.append(back);
      log('step', `Dialog: ${opts.title || 'Confirm'} - ${opts.message || ''}`);
      if (focusBtn) focusBtn.focus();
    });
  }

  window.Picker = { open, ask, checked: false };
})();
