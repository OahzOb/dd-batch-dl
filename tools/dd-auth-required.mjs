// Reproduce the extension service worker's EXACT request shape from the page
// context, using credentials:'omit' so the browser cannot silently attach the
// real jar. Then bisect the cookie set to find what auth actually needs, and
// test whether the SW's extra headers are what cause the 401.
const PORT = Number(process.env.DD_CDP_PORT || 9333);
const BASE = `http://127.0.0.1:${PORT}`;
const API = 'https://alidocs.dingtalk.com';
const log = (...a) => console.log(...a);
const hr = (t) => log(`\n${'='.repeat(6)} ${t} ${'='.repeat(6)}`);

async function json(p) { return (await fetch(BASE + p)).json(); }
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws failed')), { once: true });
  });
  return {
    ready,
    send(method, params = {}, sessionId) {
      const mid = ++id;
      const p = { id: mid, method, params };
      if (sessionId) p.sessionId = sessionId;
      return new Promise((resolve, reject) => {
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify(p));
        setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('timeout ' + method)); } }, 60000);
      });
    },
    close: () => ws.close(),
  };
}

const main = async () => {
  const version = await json('/json/version');
  const browser = connect(version.webSocketDebuggerUrl);
  await browser.ready;
  const targets = await json('/json/list');
  const target = targets.find((t) => t.type === 'page' && t.url.includes('alidocs.dingtalk.com'));
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId: target.id, flatten: true });
  const send = (m, p = {}) => browser.send(m, p, sessionId);
  await send('Runtime.enable');

  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.value;
  };

  const { cookies } = await send('Network.getCookies', { urls: ['https://alidocs.dingtalk.com/'] });
  const nodeId = (/\/i\/nodes\/([A-Za-z0-9_-]+)/.exec(await evalJs('location.href')) || [])[1];
  const spaceId = await evalJs(`(() => { const m = /"spaceId"\\s*:\\s*"([^"]+)"/.exec(document.documentElement.innerHTML); return m ? m[1] : ''; })()`);
  log('页面:', nodeId, '| spaceId:', spaceId);
  log('jar:', cookies.map((c) => c.name).join(', '));

  const xsrf = (cookies.find((c) => c.name === 'XSRF-TOKEN') || {}).value || '';
  const atoken = (cookies.find((c) => c.name === 'doc_atoken') || {}).value || '';

  // `endpoint` lets us compare the probe id against the real node id — the 401
  // might simply be the server's answer to an unknown dentryUuid.
  const call = async (label, { jar, headers, endpoint = 'list' }) => {
    const cookieHeader = (jar || cookies).map((c) => `${c.name}=${c.value}`).join('; ');
    const hdrs = { accept: 'application/json, text/plain, */*', ...(headers || {}) };
    const params = endpoint === 'list'
      ? { dentryUuid: nodeId, spaceId, pageSize: '3' }
      : { dentryUuid: nodeId, spaceId };
    const raw = await evalJs(`(async () => {
      const u = new URL(${JSON.stringify(endpoint === 'list' ? '/box/api/v2/dentry/list' : '/box/api/v2/dentry/info')}, ${JSON.stringify(API)});
      const q = ${JSON.stringify(params)};
      for (const k of Object.keys(q)) u.searchParams.set(k, q[k]);
      try {
        const res = await fetch(u.toString(), {
          credentials: 'omit',
          headers: { ...${JSON.stringify(hdrs)}, cookie: ${JSON.stringify(cookieHeader)} },
        });
        const t = await res.text();
        let j = null; try { j = JSON.parse(t); } catch {}
        const kids = j && j.data && j.data.children ? j.data.children.length : null;
        return JSON.stringify({ status: res.status, name: j && j.data ? j.data.name : null, kids, err: j ? (j.errorMsg || j.message || null) : t.slice(0, 100) });
      } catch (e) { return JSON.stringify({ error: String(e && e.message || e) }); }
    })()`);
    const r = JSON.parse(raw);
    const ok = r.status === 200;
    log(`  ${ok ? '✅' : '❌'} ${label.padEnd(52)} status=${r.status}${r.kids != null ? ` children=${r.kids}` : ''}${r.name ? ` name=${r.name}` : ''}${r.err ? ' err=' + r.err : ''}${r.error ? ' ' + r.error : ''}`);
    return r;
  };

  hr('1. 复刻 SW 的请求（credentials:omit + 显式 jar + SW 的头）');
  const swHeaders = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    referer: API + '/',
    origin: API,
  };
  await call('SW 头 + 完整 jar → dentry/list', { headers: swHeaders });
  await call('SW 头 + 完整 jar → dentry/info', { headers: swHeaders, endpoint: 'info' });

  hr('2. 加/去 a-token 与 csrf 头的影响');
  await call('再加 a-token 头', { headers: { ...swHeaders, 'a-token': atoken } });
  await call('再加 x-csrf-token 头', { headers: { ...swHeaders, 'x-csrf-token': xsrf } });
  await call('只带 cookie，不带 referer/origin', { headers: { accept: 'application/json' } });

  hr('3. 换成 info 端点探测不存在的 id（复现诊断里的 401？）');
  const probeRaw = await evalJs(`(async () => {
    const u = new URL('/box/api/v2/dentry/info', ${JSON.stringify(API)});
    u.searchParams.set('dentryUuid', 'dd-session-probe');
    const jar = ${JSON.stringify(cookies.map((c) => `${c.name}=${c.value}`).join('; '))};
    const res = await fetch(u.toString(), { credentials: 'omit', headers: { accept: 'application/json', referer: ${JSON.stringify(API + '/')}, origin: ${JSON.stringify(API)}, cookie: jar } });
    return JSON.stringify({ status: res.status, body: (await res.text()).slice(0, 250) });
  })()`);
  log('  不存在的 id:', probeRaw);

  hr('4. 逐项剔除（credentials:omit，真实生效）');
  const required = [];
  for (const drop of cookies) {
    const rest = cookies.filter((c) => c.name !== drop.name);
    const r = await call(`去掉 ${drop.name}`, { jar: rest, headers: swHeaders });
    if (r.status !== 200) required.push(drop.name);
  }
  log('\n必需 cookie:', required.length ? required.join(', ') : '（无单项必需）');

  hr('5. 只带必需项组合');
  if (required.length) {
    await call(`只带 ${required.join('+')}`, { jar: cookies.filter((c) => required.includes(c.name)), headers: swHeaders });
  }
  // also test the promising pair explicitly
  for (const set of [['account'], ['doc_atoken'], ['account', 'doc_atoken'], ['account', 'tfstk'], ['account', 'doc_atoken', 'XSRF-TOKEN']]) {
    const jar = cookies.filter((c) => set.includes(c.name));
    if (jar.length === set.length) await call(`只带 ${set.join('+')}`, { jar, headers: swHeaders });
  }

  hr('done');
  browser.close();
  setTimeout(() => process.exit(0), 200);
};

main().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exitCode = 1; });
