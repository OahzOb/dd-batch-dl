// Ask Chrome directly to load the unpacked extension and report the outcome.
// Extensions.loadUnpacked returns the extension id, or a protocol error
// carrying Chrome's own load failure message.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根目录：脚本位于 <root>/tools/，相对自身推导，换位置也不会坏。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PORT = Number(process.env.DD_LOAD_PORT || 9444);
const BASE = `http://127.0.0.1:${PORT}`;
const EXT_PATH = ROOT;

const version = await (await fetch(BASE + '/json/version')).json();
console.log('browser:', version.Browser);

const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', () => rej(new Error('ws failed')), { once: true });
});

let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(Object.assign(new Error(m.error.message), { code: m.error.code, data: m.error.data })) : resolve(m.result);
  }
});
const send = (method, params = {}) => {
  const mid = ++id;
  return new Promise((resolve, reject) => {
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('timeout ' + method)); } }, 30000);
  });
};

try {
  const r = await send('Extensions.loadUnpacked', { path: EXT_PATH });
  console.log('\n✅ Chrome 成功加载扩展');
  console.log('   extension id:', r.id);
} catch (e) {
  console.log('\n加载返回错误:', e.message, e.code ? `(code ${e.code})` : '');
} 

// also surface any load-time diagnostics Chrome is willing to share
try {
  const targets = await (await fetch(BASE + '/json/list')).json();
  const mine = targets.filter((t) => /chrome-extension:\/\//.test(t.url));
  console.log('\n当前扩展 target:');
  for (const t of mine) console.log(`  [${t.type}] ${t.url}`);
} catch { /* ignore */ }

ws.close();
setTimeout(() => process.exit(0), 200);
