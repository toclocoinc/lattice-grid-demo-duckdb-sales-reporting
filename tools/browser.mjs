/**
 * A small driver for headless Chrome over the DevTools protocol (Node 22's
 * built-in WebSocket; no packages). Used by tools/verify.mjs and tools/shots.mjs.
 */

import { spawn } from 'node:child_process';
import { access, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean);

async function findChrome() {
  for (const path of CANDIDATES) {
    try { await access(path); return path; } catch { /* next */ }
  }
  throw new Error(`No browser found. Tried:\n  ${CANDIDATES.join('\n  ')}\nSet CHROME_PATH.`);
}

function freePort() {
  return import('node:net').then(({ createServer }) => new Promise((ok, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  }));
}

/**
 * Start a browser and attach to one page.
 *
 * @param {{width: number, height: number, mobile?: boolean, colorScheme?: 'light'|'dark'}} viewport
 */
export async function openBrowser(viewport) {
  if (typeof WebSocket === 'undefined') throw new Error(`Needs Node 22 or newer for its WebSocket; this is ${process.version}.`);
  const chromePath = await findChrome();
  const profile = await mkdtemp(join(tmpdir(), 'sales-verify-'));
  const port = await freePort();
  const browser = spawn(chromePath, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-gpu',
    '--disable-dev-shm-usage', '--hide-scrollbars',
    `--window-size=${viewport.width},${viewport.height}`, 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  browser.stderr.on('data', () => {});

  let wsUrl;
  for (let i = 0; i < 150 && !wsUrl; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) wsUrl = (await response.json()).webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) throw new Error('the browser never opened its debugging port');

  const socket = new WebSocket(wsUrl);
  await new Promise((ok, fail) => {
    socket.onopen = ok;
    socket.onerror = () => fail(new Error('could not attach to the browser'));
  });

  let nextId = 0;
  const pending = new Map();
  const errors = [];
  socket.onclose = () => {
    for (const { reject } of pending.values()) reject(new Error('the browser went away'));
    pending.clear();
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id != null && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      errors.push(`console.error: ${message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')}`);
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const d = message.params.exceptionDetails;
      errors.push(`exception: ${d.exception?.description || d.text}`);
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      errors.push(`log: ${message.params.entry.text} ${message.params.entry.url || ''}`);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((ok, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve: ok, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);
  await call('Page.enable');
  await call('Runtime.enable');
  await call('Log.enable');
  await call('Emulation.setDeviceMetricsOverride', {
    width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.scale ?? 1, mobile: Boolean(viewport.mobile),
  });
  if (viewport.colorScheme) {
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: viewport.colorScheme }] });
  }

  const evaluate = async (expression, ms = 30000) => {
    const result = await Promise.race([
      call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      sleep(ms).then(() => { throw new Error('the page did not answer in time'); }),
    ]);
    if (result.exceptionDetails) {
      throw new Error(`${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description || ''}`);
    }
    return result.result.value;
  };

  const waitFor = async (expression, timeout, what) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      try { if (await evaluate(expression, 15000)) return true; } catch { /* still busy */ }
      await sleep(400);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  const shoot = async (file, { full = true } = {}) => {
    await mkdir(dirname(file), { recursive: true });
    const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
    await writeFile(file, Buffer.from(data, 'base64'));
  };

  /** A real mouse click at the centre of the first element matching `selector`. */
  const click = async (selector) => {
    const box = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error(`nothing matches ${selector}`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await call('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
    }
  };

  /** Type into the focused element with real key events. */
  const type = async (text) => {
    for (const ch of text) {
      await call('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch });
      await call('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    }
  };

  const key = async (name, code = name) => {
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: { Enter: 13, ArrowDown: 40, Tab: 9, Escape: 27 }[name] ?? 0 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code });
  };

  const close = async () => {
    try { process.kill(-browser.pid, 'SIGKILL'); } catch { /* gone */ }
    try { browser.kill('SIGKILL'); } catch { /* gone */ }
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };

  return { call, evaluate, waitFor, shoot, click, type, key, errors, close, sleep };
}
