// Minimal Chrome DevTools Protocol driver (no external deps, uses Node's global WebSocket)
// Usage: node dd-cdp.mjs <command> [args...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根目录：脚本位于 <root>/tools/，所以相对自身推导，换位置也不会坏。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PORT = Number(process.env.DD_CDP_PORT || 9333);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;

export async function httpJson(p) {
  const r = await fetch(BASE + p);
  return await r.json();
}

class Conn {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg);
      }
    });
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout: ${method}`)); }
      }, 120000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function connectWs(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', (e) => rej(new Error('ws error: ' + (e.message || 'failed'))), { once: true });
  });
  return new Conn(ws);
}

export async function connectBrowser() {
  const v = await httpJson('/json/version');
  return connectWs(v.webSocketDebuggerUrl);
}

// Find the first real page target
export async function firstPageTarget() {
  const list = await httpJson('/json/list');
  const pages = list.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  return pages[0] || list[0];
}

export async function attachToPage(targetId) {
  const browser = await connectBrowser();
  const info = await httpJson('/json/list');
  const target = targetId
    ? info.find((t) => t.id === targetId)
    : info.find((t) => t.type === 'page' && !t.url.startsWith('devtools://')) || info.find((t) => t.type === 'page');
  if (!target) throw new Error('no page target found');
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId: target.id, flatten: true });
  const page = {
    conn: browser,
    sessionId,
    targetId: target.id,
    send: (m, p = {}) => browser.send(m, p, sessionId),
    on: (fn) => browser.on((msg) => { if (msg.sessionId === sessionId) fn(msg); }),
    close: () => browser.close(),
  };
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  return page;
}

export async function evalJs(page, expression, { awaitPromise = true } = {}) {
  const r = await page.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
    allowUnsafeEvalBlockedByCSP: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('page eval error: ' + (d.exception?.description || d.text));
  }
  return r.result?.value;
}

// ---------- CLI ----------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\//, '').replace(/\//g, path.sep));
if (isMain || process.argv[1]?.endsWith('dd-cdp.mjs')) {
  const [cmd, ...args] = process.argv.slice(2);
  const out = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));
  try {
    if (cmd === 'targets') {
      out(await httpJson('/json/list'));
    } else if (cmd === 'navigate') {
      const page = await attachToPage();
      await page.send('Page.navigate', { url: args[0] });
      out({ navigated: args[0], targetId: page.targetId });
      page.close();
    } else if (cmd === 'eval') {
      const page = await attachToPage(args[0] && args[0].startsWith('TID:') ? args[0].slice(4) : undefined);
      const expr = args[0]?.startsWith('TID:') ? args[1] : args[0];
      out(await evalJs(page, expr));
      page.close();
    } else if (cmd === 'info') {
      const page = await attachToPage();
      const url = await evalJs(page, 'location.href');
      const title = await evalJs(page, 'document.title');
      out({ url, title, targetId: page.targetId });
      page.close();
    } else {
      out({ usage: ['targets', 'info', 'navigate <url>', 'eval <js>', 'eval TID:<targetId> <js>'] });
    }
  } catch (e) {
    console.error('ERROR: ' + e.message);
    process.exitCode = 1;
  }
}