// Drives the real app window over the Chrome DevTools protocol with real mouse and keyboard input events.
const { spawn } = require('child_process');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch({ exe, port = 9339, env = process.env } = {}) {
  const root = path.join(__dirname, '..');
  const args = [`--remote-debugging-port=${port}`];
  env = { ...env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = exe ? spawn(exe, args, { env, stdio: 'ignore' }) : spawn(require('electron'), ['.', ...args], { cwd: root, env, stdio: 'ignore' });
  let exited = null;
  child.on('exit', (code) => { exited = code === null ? -1 : code; });
  let target = null;
  for (let i = 0; i < 150 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && /index\.html/.test(t.url)); } catch (e) { /* not up yet */ }
  }
  if (!target) { try { child.kill(); } catch (e) { /* gone */ } throw new Error('window did not appear on the DevTools port'); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('DevTools socket failed')); });
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { const w = waiting.get(d.id); waiting.delete(d.id); if (d.error) w.rej(new Error(d.error.message)); else w.res(d.result); } };
  const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });

  const js = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  };
  const waitFor = async (expression, what, timeout = 20000) => {
    const t0 = Date.now();
    for (;;) {
      const v = await js(expression);
      if (v) return v;
      if (Date.now() - t0 > timeout) throw new Error('timed out waiting for ' + (what || expression));
      await sleep(100);
    }
  };
  // find: JS expression that evaluates to an element
  const click = async (find, what) => {
    const pt = await waitFor(`(() => { const e = ${find}; if (!e || e.disabled) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`, what || find);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
  };
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
  const byText = (sel, text) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)}))`;
  const type = async (sel, text, enter) => {
    await click(q(sel));
    await js(`${q(sel)}.select()`);
    await send('Input.insertText', { text });
    if (enter) for (const t of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type: t, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  };
  // In-app file browser helpers
  const pickerOpen = () => waitFor(`(() => { const b = document.querySelector('.pk-back:not(.pk-ask)'); return b && !b.hidden && document.querySelector('.pk-info').textContent !== 'Loading...'; })()`, 'file browser to open');
  const pickerGo = async (dir) => { await type('.pk-path', dir, true); await waitFor(`${q('.pk-path')}.value.toLowerCase() === ${JSON.stringify(dir.toLowerCase())} && !document.querySelector('.pk-info.bad')`, 'file browser to list ' + dir); };
  const pickerRow = (name) => click(byText('.pk-row .c-name', name), 'row ' + name);
  const pickerOk = async () => { await click(`document.querySelector('.pk-back:not(.pk-ask) .pk-primary')`); await waitFor(`document.querySelector('.pk-back:not(.pk-ask)').hidden`, 'file browser to close'); };
  const waitExit = async (timeout = 20000) => { const t0 = Date.now(); while (exited === null && Date.now() - t0 < timeout) await sleep(100); return exited; };
  return { child, send, js, waitFor, click, type, q, byText, pickerOpen, pickerGo, pickerRow, pickerOk, waitExit, sleep, close: () => { try { ws.close(); } catch (e) { /* closed */ } } };
}

module.exports = { launch, sleep };
