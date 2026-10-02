// End-to-end harness: runs the extension's REAL background.js against the live
// DingTalk API by shimming only the host boundary (global fetch + chrome.*).
// The scan/download logic under test is exactly what ships.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根目录：脚本位于 <root>/tools/，所以相对自身推导，换位置也不会坏。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import vm from 'node:vm';

const PORT = Number(process.env.DD_CDP_PORT || 9333);
const CDP_BASE = `http://127.0.0.1:${PORT}`;
const API = 'https://alidocs.dingtalk.com';
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'tmp', 'e2e-out');

const log = (...a) => console.log(...a);
const hr = (t) => log(`\n${'='.repeat(6)} ${t} ${'='.repeat(6)}`);

async function cdpJson(p) { return (await fetch(CDP_BASE + p)).json(); }

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
        setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('timeout ' + method)); } }, 180000);
      });
    },
    close: () => ws.close(),
  };
}

const main = async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // ---- CDP bridge so every HTTP call originates from the logged-in page ----
  const version = await cdpJson('/json/version');
  const browser = connect(version.webSocketDebuggerUrl);
  await browser.ready;
  const targets = await cdpJson('/json/list');
  const target = targets.find((t) => t.type === 'page' && t.url.includes('alidocs.dingtalk.com'));
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId: target.id, flatten: true });
  const send = (m, p = {}) => browser.send(m, p, sessionId);
  await send('Runtime.enable');

  const pageEval = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.value;
  };

  let httpCount = 0;
  let swRejected = 0;
  // DD_SW_401=1 models the real failure mode: the service worker's own request
  // is rejected (its cookie jar is insufficient) while the page is fine. Any
  // request that reaches here already carries the SW's explicitly-set headers,
  // so rejecting it and letting the page relay succeed is exactly the user's
  // situation.
  const rejectServiceWorker = process.env.DD_SW_401 === '1';

  const pageFetch = async (url, init = {}) => {
    httpCount += 1;
    const target = String(url);

    // The signed CDN URL lives on another origin. A page-context fetch would be
    // blocked by CORS, but an extension service worker with host_permissions is
    // exempt from CORS, so issue those from Node to model the real behaviour.
    const sameOrigin = target.startsWith(API);
    if (!sameOrigin) {
      return await fetch(target, {
        method: init.method || 'GET',
        headers: { 'user-agent': 'Mozilla/5.0' },
      });
    }

    const headers = init.headers || {};
    const hasCookieHeader = Object.keys(headers).some((k) => k.toLowerCase() === 'cookie')
      && /(?:^|;\s*)(doc_atoken|dk)=/.test(String(headers.cookie || headers.Cookie || ''));
    if (rejectServiceWorker && hasCookieHeader && target.includes('/box/api/')) {
      swRejected += 1;
      return new Response('{"status":401,"code":"NOT_LOGIN"}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }

    const override = { cookie: '', origin: '', referer: '', 'user-agent': '' };
    for (const [k, v] of Object.entries(headers)) {
      const lk = k.toLowerCase();
      if (lk in override) override[lk] = v;
    }
    const expr = `(async () => {
      const h = ${JSON.stringify(override)};
      const init = {
        method: ${JSON.stringify(init.method || 'GET')},
        credentials: 'include',
        headers: { accept: 'application/json, text/plain, */*' },
      };
      if (h['user-agent']) init.headers['user-agent'] = h['user-agent'];
      ${init.body ? `init.headers['content-type'] = 'application/json'; init.body = ${JSON.stringify(String(init.body))};` : ''}
      try {
        const res = await fetch(${JSON.stringify(target)}, init);
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = '';
        const CH = 0x8000;
        for (let i = 0; i < bytes.length; i += CH) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
        }
        const hdrs = {};
        res.headers.forEach((v, k) => { hdrs[k] = v; });
        return { ok: res.ok, status: res.status, headers: hdrs, b64: btoa(bin) };
      } catch (e) {
        return { error: String(e && e.message || e) };
      }
    })()`;
    const out = await pageEval(expr);
    if (!out) throw new TypeError('fetch failed: no result from page');
    if (out.error) throw new TypeError(`fetch failed: ${out.error}`);
    const body = Buffer.from(out.b64, 'base64');
    return new Response(body, { status: out.status, headers: out.headers });
  };

  // ---- chrome.* shims ----
  const notifies = [];
  const pendingDownloads = [];
  const capturedBlobs = [];
  const store = {};
  let storageBytes = 0;

  // Stands in for the offscreen document's message handler. It speaks the SAME
  // chunked protocol as src/offscreen.js, and enforces the real 64 MiB
  // per-message ceiling — an earlier version of this shim accepted a single
  // oversized message and therefore could not reproduce the truncated-zip bug.
  const MESSAGE_LIMIT = 64 * 1024 * 1024;
  const transfers = new Map();
  const handleOffscreenMessage = (msg) => {
    if (!msg || msg.target !== 'offscreen') return null;

    if (msg.type === 'blob-chunk' || msg.type === 'blob-finish' || msg.type === 'blob-abort') {
      const approx = msg.base64 ? msg.base64.length : 0;
      if (approx > MESSAGE_LIMIT) {
        throw new Error('Error in invocation of runtime.sendMessage: Message exceeded maximum allowed size of 64MiB.');
      }
    }
    if (msg.type === 'blob-chunk') {
      let t = transfers.get(msg.id);
      if (!t) { t = { parts: [], bytes: 0 }; transfers.set(msg.id, t); }
      const buf = Buffer.from(msg.base64, 'base64');
      t.parts.push(buf);
      t.bytes += buf.length;
      return { ok: true, received: t.parts.length };
    }
    if (msg.type === 'blob-finish') {
      const t = transfers.get(msg.id);
      transfers.delete(msg.id);
      if (!t) return { ok: false, error: '分片已丢失' };
      const joined = Buffer.concat(t.parts);
      capturedBlobs.push(joined);
      return { ok: true, url: `blob:chrome-extension://test/${capturedBlobs.length - 1}`, size: joined.length };
    }
    if (msg.type === 'blob-abort') { transfers.delete(msg.id); return { ok: true }; }
    if (msg.type === 'revoke-blob-url') return undefined;
    return null;
  };

  let liveSpaceId = '';
  const pageUrlEarly = await pageEval('location.href');
  liveSpaceId = await pageEval(`(() => { const m = /"spaceId"\\s*:\\s*"([^"]+)"/.exec(document.documentElement.innerHTML); return m ? m[1] : ''; })()`);

  // Feed the real session cookies into the chrome.cookies shim, exactly as the
  // extension would receive them from its own cookie jar.
  await send('Network.enable');
  const { cookies: liveCookies } = await send('Network.getCookies', { urls: ['https://alidocs.dingtalk.com/'] });
  log('灌入真实 cookie:', liveCookies.map((c) => c.name).join(', '));

  // Chrome only returns a cookie from getAll({url}) when that URL would really
  // send it: same scheme, host/domain match, and path prefix match. Modelling
  // this strictly is what catches "queried the bare registrable domain and got
  // an empty jar" bugs — a loose shim hides them.
  const cookieMatchesUrl = (cookie, urlString) => {
    const url = new URL(urlString);
    if (cookie.secure && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    const domain = String(cookie.domain || '').toLowerCase().replace(/^\./, '');
    if (cookie.hostOnly) {
      if (host !== domain) return false;
    } else {
      if (host !== domain && !host.endsWith('.' + domain)) return false;
      // a public suffix like "com" would match far too much; reject
      if (!domain.includes('.')) return false;
    }
    const path = cookie.path || '/';
    if (path !== '/') {
      const p = url.pathname || '/';
      if (!(p === path || p.startsWith(path.endsWith('/') ? path : path + '/'))) return false;
    }
    return true;
  };

  const cookieShimStats = [];
  const chromeShim = {
    runtime: {
      onMessage: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
      sendMessage: async (msg) => {
        // Messages aimed at the offscreen document are handled here rather than
        // recorded as progress notifications.
        const off = handleOffscreenMessage(msg);
        if (off !== null) return off;
        notifies.push(msg);
        return undefined;
      },
      getURL: (p) => `chrome-extension://test/${p}`,
    },
    // Models the offscreen document: an MV3 service worker has no DOM, so
    // URL.createObjectURL does not exist there. The worker posts base64 to an
    // offscreen page and gets a blob: URL back. Stubbing createObjectURL as
    // available is exactly the over-permissive shim that hid this bug.
    offscreen: {
      hasDocument: async () => true,
      createDocument: async () => {},
    },
    storage: {
      local: {
        get: async (key) => {
          const keys = Array.isArray(key) ? key : [key];
          const out = {};
          for (const k of keys) if (k in store) out[k] = store[k];
          return out;
        },
        set: async (obj) => {
          // Enforce chrome.storage.local's real 10 MB ceiling so an oversized
          // tree fails here instead of only in the browser.
          let total = 0;
          for (const v of Object.values({ ...store, ...obj })) {
            total += Buffer.byteLength(JSON.stringify(v) || '', 'utf8');
          }
          storageBytes = total;
          if (total > 10 * 1024 * 1024) {
            const err = new Error('QUOTA_BYTES quota exceeded');
            err.name = 'QuotaExceededError';
            throw err;
          }
          Object.assign(store, obj);
        },
      },
    },
    cookies: {
      getAll: async (filter = {}) => {
        let out;
        if (filter.url) {
          out = liveCookies.filter((c) => cookieMatchesUrl(c, filter.url));
          if (process.env.DD_COOKIE_TRACE === '1') {
            cookieShimStats.push({ url: filter.url, returned: out.length });
          }
        } else if (filter.domain) {
          const d = String(filter.domain).toLowerCase().replace(/^\./, '');
          out = liveCookies.filter((c) => {
            const cd = String(c.domain || '').toLowerCase().replace(/^\./, '');
            return cd === d || cd.endsWith('.' + d);
          });
        } else {
          out = liveCookies.slice();
        }
        return out;
      },
    },
    tabs: {
      query: async () => [{ id: 1, active: true, url: pageUrlEarly }],
      create: async () => ({}),
    },
    // Runs the function the extension actually injects, in a page-like scope,
    // so the relay path is exercised for real rather than stubbed.
    scripting: {
      executeScript: async ({ func, args }) => {
        // No args => this is the spaceId reader injected by discoverSpaceId.
        if (!args || args.length === 0) return [{ result: liveSpaceId }];
        const pageLikeFetch = async (url, init) => {
          // Reuse the CDP bridge (page-context request, page's own session) but
          // bypass the SW-rejection simulation: a relayed request must be
          // allowed to succeed.
          return await pageFetch(url, { ...(init || {}), headers: {} });
        };
        const fn = vm.runInNewContext(`(${func.toString()})`, { fetch: pageLikeFetch, URL, console });
        const result = await fn(...args);
        return [{ result }];
      },
    },
    downloads: {
      download: async (opts) => {
        const id = pendingDownloads.length + 1;
        pendingDownloads.push(opts);
        return id;
      },
    },
    sidePanel: { setPanelBehavior: async () => {} },
  };

  // ---- load the real extension sources ----
  const sandbox = {
    console,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Response,
    Request,
    Headers,
    Blob,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON,
    Promise,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Error,
    TypeError,
    Map,
    Set,
    WeakMap,
    Uint8Array,
    Uint32Array,
    DataView,
    ArrayBuffer,
    RegExp,
    isNaN,
    parseInt,
    parseFloat,
    fetch: pageFetch,
    chrome: chromeShim,
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/153.0.0.0' },
    CompressionStream: globalThis.CompressionStream,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    // Faithful to a real MV3 service worker: URL exists, but the object-URL
    // factory does not. The extension must route through the offscreen document.
    URL: Object.assign(function (...args) { return new URL(...args); }, {
      createObjectURL: undefined,
      revokeObjectURL: undefined,
    }),
    importScripts: (...files) => {
      for (const f of files) {
        const code = fs.readFileSync(path.join(SRC, f), 'utf8');
        vm.runInContext(code, context, { filename: f });
      }
    },
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);

  const backgroundSrc = fs.readFileSync(path.join(SRC, 'background.js'), 'utf8');
  vm.runInContext(backgroundSrc, context, { filename: 'background.js' });
  log('已加载真实的 background.js');

  // expose the internal handlers for direct invocation
  const handlersExpr = `({
    ping: typeof handlers !== 'undefined' ? handlers.ping : null,
    scan: typeof handlers !== 'undefined' ? handlers.scan : null,
    download: typeof handlers !== 'undefined' ? handlers.download : null,
  })`;
  const haveHandlers = vm.runInContext(`typeof handlers !== 'undefined'`, context);
  log('handlers 可见:', haveHandlers);
  if (!haveHandlers) throw new Error('background.js 里的 handlers 不可见，无法驱动测试');

  const call = (name, payload) => vm.runInContext(
    `handlers[${JSON.stringify(name)}](${JSON.stringify(payload || {})})`, context,
  );

  hr('1. ping（登录态读取）');
  // The page is only needed for a live scan. With a cached tree the API calls
  // still work (the harness relays them through the page context), but reading
  // spaceId out of the DOM can fail if the debug session has expired — so make
  // it non-fatal and fall back to the cached tree's own spaceId.
  let pageUrl = 'https://alidocs.dingtalk.com/';
  let spaceId = '';
  try {
    pageUrl = (await pageEval('location.href')) || pageUrl;
    spaceId = await pageEval(`(() => { const m = /"spaceId"\\s*:\\s*"([^"]+)"/.exec(document.documentElement.innerHTML); return m ? m[1] : ''; })()`);
  } catch (e) {
    log(`(读取页面信息失败：${e.message} —— 继续，稍后从缓存目录树取 spaceId)`);
  }
  const ping = await call('ping', { pageUrl });
  log(JSON.stringify(ping, null, 1));
  if (!ping.loggedIn) {
    throw new Error('登录态读取失败 —— 这正是线上报的 bug，先修它');
  }

  hr('1b. diagnose（cookie 来源 + 两种发起方式对比）');
  const diag = await call('diagnose', { pageUrl });
  log('会话 cookie:', diag.sessionCookies.join(', ') || '(none)',
    '| doc_atoken:', diag.hasAtoken, '| XSRF:', diag.hasXsrf, '| cookie 总数:', diag.totalCookies);
  log('各查询来源:');
  for (const s of diag.sources) {
    log(`  ${s.label}  → ${s.error ? 'ERROR ' + s.error : `${s.count} 项（新增 ${s.fresh}）`}`);
  }
  log('扩展 SW 发起:', JSON.stringify(diag.directProbe));
  log('扩展实际方式:', JSON.stringify(diag.autoProbe));
  log(`模拟拒绝对 SW 请求的次数: ${swRejected}`);
  if (cookieShimStats.length) {
    log('cookie 垫片各 URL 返回数:', JSON.stringify(cookieShimStats));
  }

  const rootId = (/\/i\/nodes\/([A-Za-z0-9_-]+)/.exec(pageUrl) || [])[1];

  hr('2. scan（懒加载：只应读取根目录一层）');
  const TREE_CACHE = path.join(OUT, 'tree-cache.json');
  let tree;
  if (process.env.DD_SKIP_SCAN === '1' && fs.existsSync(TREE_CACHE)) {
    tree = JSON.parse(fs.readFileSync(TREE_CACHE, 'utf8'));
    if (!spaceId) spaceId = tree.spaceId || '';
    log(`复用磁盘缓存目录树（${new Date(tree.scannedAt).toLocaleString()}），跳过扫描`);
    log(`spaceId（来自缓存）: ${spaceId}`);
    // Seed the worker's own store so the download/zip paths find it.
    await vm.runInContext(`chrome.storage.local.set({ ddTreeCache: ${JSON.stringify(tree)} })`, context);
    await vm.runInContext(`lastTreeInMemory = ${JSON.stringify(tree)}`, context);
  } else {
    const before = httpCount;
    const t0 = Date.now();
    const scan = await call('scan', { rootId, pageUrl, spaceIdOverride: spaceId });
    tree = scan.tree;
    const scanRequests = httpCount - before;
    log(`扫描耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，HTTP 请求 ${scanRequests} 次`);
    log(`根目录子项: ${(tree.root.children || []).length}`);
    log(`是否有未加载的子文件夹: ${(tree.root.children || []).some((c) => c.type === 'folder' && !c.loaded) ? '是（懒加载生效）' : '否'}`);
    log('stats (应为 partial):', JSON.stringify(tree.stats));
    fs.writeFileSync(TREE_CACHE, JSON.stringify(tree));
  }
  log('root:', JSON.stringify(tree.root.name), '| spaceId:', tree.spaceId);

  hr('2b. listChildren（展开单个文件夹，只取一层）');
  const firstFolder = (tree.root.children || []).find((c) => c.type === 'folder');
  if (!firstFolder) {
    log('根目录下没有文件夹，跳过');
  } else {
    const before2 = httpCount;
    const t1 = Date.now();
    const lc = await call('listChildren', { uuid: firstFolder.uuid });
    const n = lc.children ? lc.children.length : -1;
    log(`展开「${firstFolder.name}」: ${n} 项，耗时 ${((Date.now() - t1) / 1000).toFixed(2)}s，HTTP 请求 ${httpCount - before2} 次`);
    log(`cached=${lc.cached}`);
    const subFolders = (lc.children || []).filter((c) => c.type === 'folder');
    log(`其中文件夹 ${subFolders.length} 个，是否都未加载: ${subFolders.every((c) => !c.loaded) ? '是 ✅（只取了一层）' : '否 ❌（发生了递归）'}`);
    // second call must be served from the loaded node
    const before3 = httpCount;
    const again = await call('listChildren', { uuid: firstFolder.uuid });
    log(`再次展开同一文件夹: HTTP 请求 ${httpCount - before3} 次，cached=${again.cached}`);
  }

  hr('2c. loadAll（显式展开全部，应恢复完整目录树）');
  const before4 = httpCount;
  const t2 = Date.now();
  const pre = await vm.runInContext(`(() => {
    const tree = lastTreeInMemory;
    const countAll = (n, acc) => {
      if (n.type !== 'folder') { acc.files += 1; return acc; }
      acc.folders += 1;
      if (n.loaded) acc.loaded += 1;
      for (const c of n.children || []) countAll(c, acc);
      return acc;
    };
    const acc = { folders: 0, files: 0, loaded: 0 };
    for (const c of tree.root.children || []) countAll(c, acc);
    return JSON.stringify({
      rootLoaded: tree.root.loaded,
      counts: acc,
      unloadedViaHelper: countUnloadedFolders(tree.root),
      firstChild: (tree.root.children || []).map((c) => ({
        name: c.name, type: c.type, loaded: c.loaded,
        childrenIsUndefined: c.children === undefined,
        nChildren: (c.children || []).length,
      })).slice(0, 5),
    });
  })()`, context);
  log('展开前状态:', pre);
  const la = await call('loadAll', { maxRequests: 4000 });
  log(`耗时 ${((Date.now() - t2) / 1000).toFixed(1)}s，HTTP 请求 ${httpCount - before4} 次，展开 ${la.expanded}，剩余 ${la.remaining}`);
  log('stats:', JSON.stringify(la.stats), '| truncated:', la.truncated, '| requestsUsed:', la.requestsUsed);
  const post = await vm.runInContext(`(() => {
    const tree = lastTreeInMemory;
    const acc = { folders: 0, files: 0, loaded: 0 };
    const countAll = (n) => {
      if (n.type !== 'folder') { acc.files += 1; return; }
      acc.folders += 1;
      if (n.loaded) acc.loaded += 1;
      for (const c of n.children || []) countAll(c);
    };
    for (const c of tree.root.children || []) countAll(c);
    // size annotations
    let withSize = 0;
    let sumRootChildren = 0;
    const sizes = [];
    for (const c of tree.root.children || []) {
      if (c.type !== 'folder') { sumRootChildren += c.size || 0; continue; }
      if (c.sizeBytes != null) { withSize += 1; sumRootChildren += c.sizeBytes; sizes.push([c.name, c.sizeBytes]); }
    }
    return JSON.stringify({
      counts: acc,
      unloadedViaHelper: countUnloadedFolders(tree.root),
      foldersWithSize: withSize,
      rootChildrenTotal: sumRootChildren,
      sampleSizes: sizes.slice(0, 4),
    });
  })()`, context);
  log('展开后状态:', post);
  const postObj = JSON.parse(post);
  const EXPECTED_TOTAL = 3575784779;
  log(`\n大小计算校验: 根目录子项合计 ${postObj.rootChildrenTotal} 字节`
    + `，期望 ${EXPECTED_TOTAL} → ${postObj.rootChildrenTotal === EXPECTED_TOTAL ? '✅ 一致' : '❌ 不一致'}`);
  log(`带 sizeBytes 的文件夹: ${postObj.foldersWithSize}`);
  log(`根目录子文件夹大小: ${JSON.stringify(postObj.sampleSizes)}`);

  hr('2d. 大小标注是否传到侧边栏（getTree 的返回）');
  const viaGetTree = await vm.runInContext(`(() => {
    const t = lastTreeInMemory;
    const out = [];
    for (const c of t.root.children || []) {
      if (c.type !== 'folder') continue;
      out.push({ name: c.name, sizeBytes: c.sizeBytes != null ? c.sizeBytes : null });
      // also check one nested level
      const kid = (c.children || []).find((x) => x.type === 'folder');
      if (kid) out.push({ name: c.name + '/' + kid.name, sizeBytes: kid.sizeBytes != null ? kid.sizeBytes : null });
    }
    return JSON.stringify(out);
  })()`, context);
  log('getTree 可见的大小:', viaGetTree);
  const anyKnown = JSON.parse(viaGetTree).some((x) => x.sizeBytes != null);
  log(anyKnown ? '✅ 大小字段存在于树中' : '❌ 树里没有任何 sizeBytes —— 已复现「显示未知大小」');

  tree = await call('getTree').then((r) => r.tree);
  const json = JSON.stringify(tree);
  log(`序列化后是否仍含 sizeBytes: ${json.includes('sizeBytes') ? '是' : '否 ❌'}（storage 往返会丢掉 undefined，但不应丢掉数字）`);
  fs.writeFileSync(TREE_CACHE, json);


  // flatten and sanity check
  const all = [];
  const walk = (n, p) => {
    const cur = `${p}/${n.name}`;
    all.push({ path: cur, type: n.type, size: n.size, ct: n.contentType, ext: n.extension });
    for (const c of n.children || []) walk(c, cur);
  };
  for (const c of tree.root.children || []) walk(c, tree.root.name);
  const files = all.filter((x) => x.type === 'file');
  log(`\n条目总数 ${all.length}（文件 ${files.length}，文件夹 ${all.length - files.length}）`);

  const extCount = {};
  for (const f of files) {
    const e = (f.ext || '(无)').toLowerCase();
    extCount[e] = (extCount[e] || 0) + 1;
  }
  log('文件类型分布:', JSON.stringify(extCount));
  const online = files.filter((f) => f.ct === 'ALIDOC');
  log('在线文档(ALIDOC):', online.length);
  const withSize = files.filter((f) => f.size != null);
  log('带 fileSize 的文件:', withSize.length, '/', files.length);
  const totalBytes = files.reduce((a, f) => a + (f.size || 0), 0);
  log('总体积:', (totalBytes / 1024 / 1024).toFixed(1), 'MB');

  hr('3. >50 项文件夹是否被完整列出（分页验证）');
  // 不写死账号里的目录名：可用 DD_BIG_FOLDER 指定，默认自动找子项 >50 的文件夹。
  const bigs = [];
  (function findBig(n, cur) {
    if ((n.children || []).length > 50) bigs.push({ path: cur, count: n.children.length });
    for (const c of n.children || []) findBig(c, `${cur}/${c.name}`);
  })(tree.root, tree.root.name);
  const bigFolder = process.env.DD_BIG_FOLDER
    ? bigs.find((x) => x.path.includes(process.env.DD_BIG_FOLDER))
    : bigs[0];
  if (bigFolder) {
    log(`目标: ${bigFolder.path}`);
    log(`子项数: ${bigFolder.count}（未分页时服务端只给 50）→ ✅ 分页生效`);
  } else {
    log('⚠ 树里没有子项 >50 的文件夹，未能验证分页');
    log('  目录里确实有这种文件夹的话，先「展开全部」再跑，或用 DD_BIG_FOLDER=<名字> 指定');
  }

  hr('4. download 前 3 个真实文件');
  const sample = files.filter((f) => f.ct !== 'ALIDOC').slice(0, 3);
  log('样本:', sample.map((s) => s.path.split('/').pop()).join(' | '));
  const dl = await call('download', {
    selection: buildSelection(tree.root, sample.map((s) => s.path)),
    options: { mode: 'files', flatten: false },
  });
  log('结果: ok =', dl.ok, '| failures =', dl.failures.length);
  for (const f of dl.failures) log('  ✗', f.name, '-', f.reason);
  log('\nchrome.downloads 收到的请求:');
  for (const d of pendingDownloads) log(`  ${d.filename}  <- ${String(d.url).slice(0, 70)}…`);

  hr('4b. 只勾选一个「文件夹」能否下载（子节点已在树里）');
  // This mirrors what the sidepanel sends: selectedNodes() returns the checked
  // FOLDER node carrying its already-loaded children.
  const folderNode = (() => {
    const found = bigFolder
      ? all.find((x) => x.type === 'folder' && x.path === bigFolder.path)
      : all.find((x) => x.type === 'folder');
    if (!found) return null;
    const findNode = (n, cur) => {
      if (cur === found.path) return n;
      for (const c of n.children || []) {
        const r = findNode(c, `${cur}/${c.name}`);
        if (r) return r;
      }
      return null;
    };
    return { entry: found, node: findNode(tree.root, tree.root.name) };
  })();
  if (!folderNode || !folderNode.node) {
    log('未找到测试文件夹');
  } else {
    const before = pendingDownloads.length;
    const dlf = await call('download', {
      selection: [strip(folderNode.node)],
      options: { mode: 'files', flatten: false },
    });
    log(`文件夹「${folderNode.entry.path.split('/').pop()}」含 ${(folderNode.node.children || []).length} 个子项`);
    log('结果: ok =', dlf.ok, '| failures =', dlf.failures.length);
    for (const f of dlf.failures.slice(0, 5)) log('  ✗', f.name, '-', f.reason);
    log(`新增下载请求: ${pendingDownloads.length - before}`);
    log(dlf.ok > 0 ? '✅ 只勾选文件夹可以下载' : '❌ 只勾选文件夹无法下载 —— 已复现');
  }

  hr('4c. 只勾选一个「未展开」的文件夹能否下载');
  // The interesting case: the node has no `children` array at all.
  const unloaded = (() => {
    const found = all.find((x) => x.type === 'folder' && x.path.includes('Hi7技术资料'));
    if (!found) return null;
    const findNode = (n, cur) => {
      if (cur === found.path) return n;
      for (const c of n.children || []) {
        const r = findNode(c, `${cur}/${c.name}`);
        if (r) return r;
      }
      return null;
    };
    return { entry: found, node: findNode(tree.root, tree.root.name) };
  })();
  if (!unloaded || !unloaded.node) {
    log('未找到测试文件夹（或它已完全展开，本用例不适用）');
  } else {
    const stripped = strip(unloaded.node);
    delete stripped.children;
    const before = pendingDownloads.length;
    const dlu = await call('download', {
      selection: [stripped],
      options: { mode: 'files', flatten: false },
    });
    log(`未展开文件夹「${unloaded.entry.path.split('/').pop()}」的选中节点: ${JSON.stringify({ uuid: stripped.uuid, name: stripped.name, hasChildren: stripped.children !== undefined })}`);
    log('结果: ok =', dlu.ok, '| failures =', dlu.failures.length);
    log(`新增下载请求: ${pendingDownloads.length - before}`);
    log(dlu.ok > 0 ? '✅ 未展开文件夹也能下载（后台解析）' : '❌ 未展开文件夹无法下载 —— 已复现');
  }

  hr('5. zip 模式（真打包 + 校验 zip 结构）');
  const zipSample = files.filter((f) => f.ct !== 'ALIDOC').slice(0, 2);
  const zipSelection = buildSelection(tree.root, zipSample.map((s) => s.path));
  log('zip 选择到的节点数:', zipSelection.length, JSON.stringify(zipSelection.map((n) => n.name)));
  log('待打包路径:', zipSample.map((s) => s.path).join(' | '));
  const dl2 = await call('download', {
    selection: zipSelection,
    options: { mode: 'zip', flatten: false, zipName: 'e2e-test.zip' },
  });

  // Drive runZip directly with verbose notify capture: this isolates the zip
  // path from the message wrapper.
  log('\n直接驱动 runZip:');
  const zipDirect = await vm.runInContext(`(async () => {
    const selection = ${JSON.stringify(zipSelection)};
    const t = lastTreeInMemory;
    const resolved = await collectFilesResolving(selection, t, null);
    const entries = resolved.entries;
    const messages = [];
    let result = null;
    let error = null;
    try {
      result = await runZip({
        entries,
        spaceId: ${JSON.stringify(tree.spaceId)},
        flatten: false,
        zipName: 'e2e-test.zip',
      }, (m) => messages.push(m));
    } catch (e) {
      error = String(e && e.stack || e);
    }
    return { entriesCount: entries.length, result: result ? {
      done: result.done, ok: result.ok, failures: result.failures, zip: result.zip || null,
    } : null, error, messages: messages.map((m) => m.message || m.phase) };
  })()`, context);
  log(JSON.stringify(zipDirect, null, 1));
  log('结果: ok =', dl2.ok, '| zip =', JSON.stringify(dl2.zip));
  const zipReq = pendingDownloads[pendingDownloads.length - 1];
  log('下载请求总数:', pendingDownloads.length);
  log('最后一个下载请求:', JSON.stringify({ filename: zipReq.filename, url: String(zipReq.url).slice(0, 60) }));
  log(`下载方式: ${(dl2.zip && dl2.zip.via) || '(未知)'} —— 真实 SW 里 createObjectURL 不存在，应走 offscreen`);
  const blobIdx = Number(/blob:chrome-extension:\/\/test\/(\d+)/.exec(zipReq.url || '')?.[1]);
  const zipBuf = Number.isInteger(blobIdx) ? capturedBlobs[blobIdx] : null;
  if (!zipBuf) {
    log('❌ 没捕获到 zip 内容（说明 zip 模式没有产出文件）');
  } else {
    const zbuf = zipBuf;
    fs.writeFileSync(path.join(OUT, 'e2e-test.zip'), zbuf);
    log('zip 字节数:', zbuf.length);
    const sig = zbuf.subarray(0, 4).toString('hex');
    const eocd = zbuf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    log('本地文件头签名:', sig, sig === '504b0304' ? '✅' : '❌');
    log('EOCD 位置:', eocd, eocd > 0 ? '✅' : '❌');
    if (eocd > 0) {
      const entriesCount = zbuf.readUInt16LE(eocd + 10);
      const cdSize = zbuf.readUInt32LE(eocd + 12);
      log('zip 内条目数:', entriesCount, '| 中央目录大小:', cdSize);
      // walk the central directory and list the stored paths
      let off = zbuf.readUInt32LE(eocd + 16);
      for (let i = 0; i < entriesCount && off + 46 <= zbuf.length; i += 1) {
        if (zbuf.readUInt32LE(off) !== 0x02014b50) break;
        const method = zbuf.readUInt16LE(off + 10);
        const compSize = zbuf.readUInt32LE(off + 20);
        const rawSize = zbuf.readUInt32LE(off + 24);
        const nameLen = zbuf.readUInt16LE(off + 28);
        const name = zbuf.toString('utf8', off + 46, off + 46 + nameLen);
        log(`   [${i + 1}] ${name}  method=${method === 8 ? 'deflate' : 'store'} ${rawSize} -> ${compSize}`);
        off += 46 + nameLen + zbuf.readUInt16LE(off + 30) + zbuf.readUInt16LE(off + 32);
      }
    }
    // verify the archive actually round-trips
    log('\n解压校验:');
    try {
      const { execFileSync } = await import('node:child_process');
      const outDir = path.join(OUT, 'unzipped');
      fs.mkdirSync(outDir, { recursive: true });
      const res = execFileSync('powershell.exe', ['-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${path.join(OUT, 'e2e-test.zip')}' -DestinationPath '${outDir}' -Force; Get-ChildItem -Recurse -File '${outDir}' | Select-Object -ExpandProperty FullName`],
      { encoding: 'utf8' });
      log(res.trim().split('\n').map((l) => '   ' + l.trim()).join('\n'));
      log('✅ Expand-Archive 成功解压，zip 结构有效');
    } catch (e) {
      log('❌ 解压失败:', String(e.message).slice(0, 300));
    }
  }

  hr('done');
  log('通知消息条数:', notifies.length);
  log('最后 3 条:', JSON.stringify(notifies.slice(-3), null, 1));
  browser.close();
  setTimeout(() => process.exit(0), 300);
};

function buildSelection(root, paths) {
  const wanted = new Set(paths);
  const out = [];
  const walk = (node, cur) => {
    if (wanted.has(cur)) {
      out.push(strip(node));
      return;
    }
    for (const c of node.children || []) walk(c, `${cur}/${c.name}`);
  };
  const rootPath = root.name;
  for (const c of root.children || []) walk(c, `${rootPath}/${c.name}`);
  return out;
}
function strip(n) {
  return {
    uuid: n.uuid, name: n.name, type: n.type, size: n.size,
    contentType: n.contentType, extension: n.extension,
    children: n.children ? n.children.map(strip) : undefined,
  };
}

main().catch((e) => { console.error('E2E FAILED:', e.stack || e.message); process.exitCode = 1; });