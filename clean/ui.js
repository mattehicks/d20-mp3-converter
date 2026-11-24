// Title bar (minimize, maximize, close) plus an in-memory activity log drawer for frameless windows.
//   CleanUI.init({ name: 'SD Inspector', logo: '<svg ...>', logOpen: false })
//   CleanUI.log('info', 'text')   // also window.clean.log
(function () {
  const clean = window.clean;
  const LOGO = '<svg viewBox="0 0 32 32"><g fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12V8.5Q6 6 8.5 6H12"/><path d="M20 6h3.5Q26 6 26 8.5V12"/><path d="M26 20v3.5Q26 26 23.5 26H20"/><path d="M12 26H8.5Q6 26 6 23.5V20"/></g><polygon points="13.5,12 13.5,20 20,16" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const ICON = {
    term: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="1.5"/><path d="M7.5 10l3 2-3 2M12.5 15h4"/></svg>',
    min: '<svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg>',
    max: '<svg viewBox="0 0 24 24"><rect x="6.5" y="6.5" width="11" height="11"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
  };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const pad = (n, w) => String(n).padStart(w || 2, '0');
  const lines = [];
  let lastId = 0;
  let problems = 0;
  let X = {};

  function log(level, msg) { if (clean) clean.log(level, msg); }

  function addEntry(e) {
    if (e.id <= lastId) return;
    lastId = e.id;
    const d = new Date(e.t);
    const ts = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    const stick = X.list.scrollHeight - X.list.scrollTop - X.list.clientHeight < 40;
    const row = el('div', 'cu-ln ' + e.level);
    row.append(el('span', 'cu-tm', ts), document.createTextNode(e.msg));
    X.list.append(row);
    lines.push(`${ts} ${e.level.toUpperCase().padEnd(5)} ${e.msg}`);
    while (X.list.childElementCount > 3000) { X.list.removeChild(X.list.firstChild); lines.shift(); }
    if (stick) X.list.scrollTop = X.list.scrollHeight;
    if ((e.level === 'warn' || e.level === 'error') && !document.body.classList.contains('cu-logopen')) {
      problems++;
      X.badge.textContent = problems > 99 ? '99+' : String(problems);
      X.badge.classList.add('show');
    }
    if (e.level !== 'dim' && !e.msg.startsWith('  ')) {
      X.status.textContent = e.msg;
      X.status.className = 'cu-status ' + (e.level === 'info' ? '' : e.level);
    }
  }

  function setLogOpen(open) {
    document.body.classList.toggle('cu-logopen', open);
    X.logBtn.classList.toggle('on', open);
    if (open) { problems = 0; X.badge.classList.remove('show'); X.list.scrollTop = X.list.scrollHeight; }
  }

  function init(opts) {
    opts = opts || {};
    document.body.classList.add('cu-on');
    const tb = el('header', 'cu-titlebar');
    const brand = el('div', 'cu-brand');
    brand.innerHTML = opts.logo || LOGO;
    brand.append(el('span', 'cu-name', String(opts.name || document.title).toUpperCase()));
    X.status = el('div', 'cu-status');
    X.logBtn = el('button', 'cu-ib'); X.logBtn.innerHTML = ICON.term; X.logBtn.title = 'Activity log (`)';
    X.badge = el('span', 'cu-badge'); X.logBtn.append(X.badge);
    const wc = el('div', 'cu-wc');
    for (const [what, icon, title] of [['min', ICON.min, 'Minimize'], ['max', ICON.max, 'Maximize / restore'], ['close', ICON.close, 'Close']]) {
      const b = el('button', 'cu-wb' + (what === 'close' ? ' cu-x' : '')); b.innerHTML = icon; b.title = title;
      b.onclick = () => clean.win(what);
      wc.append(b);
    }
    tb.append(brand, X.status, X.logBtn, wc);
    document.body.prepend(tb);

    const drawer = el('aside', 'cu-log');
    const head = el('div', 'cu-lhead');
    head.append(el('span', 'cu-lcap', 'Activity log'), el('span', 'cu-grow'));
    const sel = el('select', 'cu-sel');
    for (const [v, t] of [['all', 'All'], ['warn', 'Problems only']]) { const o = el('option', '', t); o.value = v; sel.append(o); }
    sel.onchange = () => { X.list.classList.toggle('only-problems', sel.value === 'warn'); sel.blur(); };
    const copy = el('button', 'cu-mini', 'Copy');
    copy.onclick = async () => { try { await navigator.clipboard.writeText(lines.join('\n')); log('ok', `Copied ${lines.length} log lines to the clipboard`); } catch (e) { log('error', 'Copy failed: ' + e.message); } };
    const clear = el('button', 'cu-mini', 'Clear');
    clear.onclick = () => { X.list.textContent = ''; lines.length = 0; problems = 0; X.badge.classList.remove('show'); };
    head.append(sel, copy, clear);
    X.list = el('div', 'cu-list');
    drawer.append(head, X.list);
    document.body.append(drawer);

    X.logBtn.onclick = () => setLogOpen(!document.body.classList.contains('cu-logopen'));
    document.addEventListener('keydown', (e) => {
      const t = e.target;
      if (e.code === 'Backquote' && !(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'))) { e.preventDefault(); setLogOpen(!document.body.classList.contains('cu-logopen')); }
    });
    window.addEventListener('error', (e) => log('error', `Script error: ${e.message} (${String(e.filename || 'page').split('/').pop()}:${e.lineno})`));
    window.addEventListener('unhandledrejection', (e) => log('error', `Unhandled error: ${e.reason && e.reason.message ? e.reason.message : e.reason}`));

    clean.onLog(addEntry);
    clean.backlog().then((list) => list.forEach(addEntry));
    setLogOpen(!!opts.logOpen);
  }

  window.CleanUI = { init, log, setLogOpen };
})();
