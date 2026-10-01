// Capture the exact request the DingTalk page itself sends for the folder
// listing, so the auth mechanism is observed rather than guessed.
// Also inventory every cookie the browser holds for dingtalk.com.
const PORT = Number(process.env.DD_CDP_PORT || 9333);
const BASE = `http://127.0.0.1:${PORT}`;
const log = (...a) => console.log(...a);
const hr = (t) => log(`\n${'='.repeat(6)} ${t} ${'='.repeat(6)}`);

async function json(p) { return (await fetch(BASE + p)).json(); }

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method) {
      events.push(m);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws failed')), { once: true });
  });
  return {
    ready, events,
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
  const target = targets.find((t) => t.type === 'page' && t.url.includes('alidocs.dingtalk.com'))
    || targets.find((t) => t.type === 'page');
  if (!target) throw new Error('没有页面 target');
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId: target.id, flatten: true });
  const send = (m, p = {}) => browser.send(m, p, sessionId);
  await send('Runtime.enable');
  await send('Network.enable');

  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.value;
  };

  hr('0. 页面状态');
  log('url  :', await evalJs('location.href'));
  log('title:', JSON.stringify(await evalJs('document.title')).slice(0, 80));

  hr('1. 浏览器里 dingtalk 相关 cookie 全量清单');
  const { cookies } = await send('Network.getCookies', { urls: ['https://alidocs.dingtalk.com/', 'https://dingtalk.com/'] });
  log(`共 ${cookies.length} 项`);
  for (const c of cookies) {
    const v = String(c.value || '');
    log(`  ${c.name.padEnd(26)} domain=${String(c.domain).padEnd(22)} path=${String(c.path).padEnd(22)} len=${String(v.length).padStart(4)}  httpOnly=${c.httpOnly}  ${v.slice(0, 18)}${v.length > 18 ? '…' : ''}`);
  }

  hr('2. 让页面重新请求一次目录，抓真实请求头');
  browser.events.length = 0;
  const nodeId = (/\/i\/nodes\/([A-Za-z0-9_-]+)/.exec(await evalJs('location.href')) || [])[1];
  const spaceId = await evalJs(`(() => { const m = /"spaceId"\\s*:\\s*"([^"]+)"/.exec(document.documentElement.innerHTML); return m ? m[1] : ''; })()`);
  log('触发一次 dentry/list 请求（用页面自己的 fetch，带上页面自己的头）…');

  // Ask the page to perform the very call it already makes internally.
  const raw = await evalJs(`(async () => {
    const url = new URL('/box/api/v2/dentry/list', 'https://alidocs.dingtalk.com');
    url.searchParams.set('dentryUuid', ${JSON.stringify(nodeId)});
    url.searchParams.set('spaceId', ${JSON.stringify(spaceId)});
    url.searchParams.set('pageSize', '5');
    const res = await fetch(url.toString(), { credentials: 'include' });
    const text = await res.text();
    return JSON.stringify({ status: res.status, head: text.slice(0, 300) });
  })()`);
  log('页面内 fetch 结果:', raw);

  // Now capture headers the page's own JS attached on its real request by
  // re-issuing through XMLHttpRequest with no explicit headers and inspecting
  // what the network layer recorded.
  const captured = [];
  const off = (msg) => {
    if (msg.method === 'Network.requestWillBeSent') {
      const r = msg.params.request;
      if (/alidocs\.dingtalk\.com\/(box|api|r)\//.test(r.url)) {
        captured.push({ url: r.url, method: r.method, headers: r.headers });
      }
    }
  };
  const origPush = browser.events.push.bind(browser.events);
  browser.events.push = (...a) => { a.forEach(off); return origPush(...a); };

  await evalJs(`(async () => {
    const url = new URL('/box/api/v2/dentry/list', 'https://alidocs.dingtalk.com');
    url.searchParams.set('dentryUuid', ${JSON.stringify(nodeId)});
    url.searchParams.set('spaceId', ${JSON.stringify(spaceId)});
    url.searchParams.set('pageSize', '5');
    const res = await fetch(url.toString(), { credentials: 'include' });
    await res.text();
    return 'done';
  })()`);
  await new Promise((r) => setTimeout(r, 1500));

  hr('3. 抓到的真实请求头');
  if (!captured.length) {
    log('（没抓到；看看页面有没有用 XHR/fetch 之外的方式）');
  }
  for (const c of captured.slice(-3)) {
    log('\nURL:', c.url.slice(0, 140));
    log('method:', c.method);
    log('headers:');
    for (const [k, v] of Object.entries(c.headers || {})) {
      const sv = String(v);
      log(`  ${k}: ${sv.length > 90 ? sv.slice(0, 90) + '…' : sv}`);
    }
  }

  hr('4. 页面自身请求用的鉴权来源探测');
  const probes = await evalJs(`(() => {
    const out = {};
    out.localStorageKeys = Object.keys(localStorage).slice(0, 40);
    out.sessionStorageKeys = Object.keys(sessionStorage).slice(0, 40);
    out.cookie = document.cookie;
    // common global holders
    for (const k of ['__INITIAL_STATE__','__INIT_DATA__','__NEXT_DATA__','g_config','_config','__DINGTALK__']) {
      if (window[k]) out[k] = JSON.stringify(window[k]).slice(0, 400);
    }
    return JSON.stringify(out);
  })()`);
  log(probes);

  hr('done');
  browser.close();
  setTimeout(() => process.exit(0), 200);
};

main().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exitCode = 1; });
