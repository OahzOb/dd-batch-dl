// DingTalk Docs folder batch downloader — service worker.
// Talks to alidocs.dingtalk.com with the user's own browser session, then
// streams files to disk through chrome.downloads.

importScripts('shared.js', 'zip.js');
const S = globalThis.DDShared;
const Z = globalThis.DDZip;

const API = 'https://alidocs.dingtalk.com';
const TREE_CACHE_KEY = 'ddTreeCache';
// A deliberately nonexistent dentry: used only to probe whether the session is
// accepted. The API answers 400 for the bad id when the session is fine, and
// 401/403 or a NOT_LOGIN body when it is not.
const DUMMY_DENTRY_ID = 'dd-session-probe';
let currentJob = null;
// Last scanned tree, kept in memory so a download works even when persisting it
// to storage failed (quota) or the service worker has not been restarted.
let lastTreeInMemory = null;

// The page the user is working in. Cookie reads are path sensitive, so this has
// to travel with every auth lookup. Set by scan()/download() and reused by the
// API helpers in between.
let currentPageUrl = null;

function setPageUrl(url) {
  if (url && url !== currentPageUrl) {
    currentPageUrl = url;
    authCache = { at: 0, value: null };
  }
}

// ---------------------------------------------------------------- auth

let authCache = { at: 0, value: null };

// chrome.cookies.getAll({url}) only returns cookies that would actually be sent
// to that exact URL — and it is PATH sensitive too. Session tokens are often
// scoped to a sub-path (e.g. /i/ or /note/), so querying only the origin root
// silently misses them. Always include the real page URL as well.
const ROOT_COOKIE_URLS = [
  'https://alidocs.dingtalk.com/',
  'https://docs.dingtalk.com/',
  'https://login.dingtalk.com/',
  'https://dingtalk.com/',
];

function cookieUrlsFor(pageUrl) {
  const urls = [];
  if (pageUrl && /^https:\/\/[^/]*dingtalk\.com\//i.test(pageUrl)) {
    urls.push(pageUrl.split('#')[0]);
  }
  for (const u of ROOT_COOKIE_URLS) if (!urls.includes(u)) urls.push(u);
  return urls;
}

// Diagnose every way of reading the jar, so a failure can be attributed instead
// of guessed at.
async function collectCookieJar(pageUrl) {
  const byName = new Map();
  const sources = [];
  const add = (cookies, label) => {
    let fresh = 0;
    for (const c of cookies) {
      const key = `${c.name}@${c.domain}${c.path}`;
      if (!byName.has(key)) { byName.set(key, c); fresh += 1; }
    }
    sources.push({ label, count: cookies.length, fresh, names: cookies.map((c) => c.name) });
  };

  for (const url of cookieUrlsFor(pageUrl)) {
    try {
      add(await chrome.cookies.getAll({ url }), `url:${url}`);
    } catch (e) {
      sources.push({ label: `url:${url}`, error: String(e && e.message || e) });
    }
  }
  for (const domain of ['alidocs.dingtalk.com', 'dingtalk.com']) {
    try {
      add(await chrome.cookies.getAll({ domain }), `domain:${domain}`);
    } catch (e) {
      sources.push({ label: `domain:${domain}`, error: String(e && e.message || e) });
    }
  }

  // Prefer alidocs-scoped duplicates over same-named cookies from other hosts.
  const all = [...byName.values()];
  const byNameOnly = new Map();
  for (const c of all) {
    const prev = byNameOnly.get(c.name);
    if (!prev || (!prev.domain.includes('alidocs') && c.domain.includes('alidocs'))) {
      byNameOnly.set(c.name, c);
    }
  }
  return { all, byNameOnly, sources };
}

// Which cookie actually carries the DingTalk docs session varies by build/region:
// older clients use doc_atoken, newer ones ship a dk/dk.sig pair. Never gate on
// one specific name — try the request and let the server decide.
const SESSION_HINT_COOKIES = ['doc_atoken', 'dk', 'dk.sig', 'account', 'DINGTALK_SESSION_ID', 't_user_id'];

async function getAuth(pageUrl) {
  if (authCache.value && Date.now() - authCache.at < 60_000) return authCache.value;
  const jar = await collectCookieJar(pageUrl);
  const pick = (name) => {
    const hit = jar.byNameOnly.get(name);
    return hit ? hit.value : '';
  };
  const value = {
    // The Cookie header must not repeat a name; one entry per name is enough.
    cookieHeader: [...jar.byNameOnly.values()].map((c) => `${c.name}=${c.value}`).join('; '),
    atoken: pick('doc_atoken') || pick('a-token') || '',
    xsrf: pick('XSRF-TOKEN') || pick('_csrf_token') || '',
    // Informational only, never used to gate anything: which cookie carries the
    // docs session differs between DingTalk builds, and some are not readable
    // through the cookie API at all. The page relay covers those cases.
    sessionCookies: SESSION_HINT_COOKIES.filter((n) => jar.byNameOnly.has(n)),
    names: [...jar.byNameOnly.keys()].sort(),
    totalCookies: jar.all.length,
  };
  authCache = { at: Date.now(), value };
  return value;
}

// ---------------------------------------------------------------- diagnostics
//
// Never includes cookie values. The three probes below are what distinguish
// "the extension's own jar is insufficient" from "this account cannot read the
// node", which are very different problems.

// Probe A: the service worker's own request, no relay. Shows whether the jar
// the cookie API gives us is enough on its own.
async function probeDirectRequest(pageUrl) {
  const auth = await getAuth(pageUrl);
  try {
    const res = await fetch(`${API}/box/api/v2/dentry/info?dentryUuid=${DUMMY_DENTRY_ID}`, {
      method: 'GET',
      headers: apiHeaders(auth),
      credentials: 'include',
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }
    const errorMsg = json ? (json.errorMsg || json.message || '') : '';
    return {
      status: res.status,
      isSuccess: json ? json.isSuccess : null,
      errorMsg: errorMsg || null,
      authRejected: res.status === 401 || res.status === 403
        || /NOT_LOGIN|NOTLOGIN|UNAUTHORIZED|no\s*permission|登录/i.test(errorMsg),
      bodyHead: json ? null : text.slice(0, 160),
    };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

// Probe B: what the extension actually does now — SW first, page relay on an
// auth rejection. This is the one that predicts whether scanning will work.
async function probeAutoRequest(pageUrl) {
  const nodeId = S.nodeIdFromUrl(pageUrl);
  if (!nodeId) return { skipped: '页面 URL 里没有节点 id' };
  const url = new URL('/box/api/v2/dentry/info', API);
  url.searchParams.set('dentryUuid', nodeId);
  try {
    const r = await fetchJsonWithFallback(url.toString());
    let json = null;
    try { json = JSON.parse(r.text); } catch { /* ignore */ }
    return {
      status: r.status,
      via: r.via,
      relayError: r.relayError || null,
      name: json && json.data ? json.data.name : null,
      dentryType: json && json.data ? json.data.dentryType : null,
      spaceId: json && json.data ? json.data.spaceId : null,
      errorMsg: json ? (json.errorMsg || json.message || null) : (r.text || '').slice(0, 120),
    };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

async function diagnose(pageUrl) {
  authCache = { at: 0, value: null };
  const jar = await collectCookieJar(pageUrl);
  const auth = await getAuth(pageUrl);

  const out = {
    pageUrl: pageUrl || null,
    sessionCookies: auth.sessionCookies,
    hasAtoken: Boolean(auth.atoken),
    hasXsrf: Boolean(auth.xsrf),
    totalCookies: auth.totalCookies,
    cookieNames: auth.names,
    sources: jar.sources,
    hasTab: Boolean(await findDocTab()),
    directProbe: null,
    autoProbe: null,
  };
  out.directProbe = await probeDirectRequest(pageUrl);
  out.autoProbe = await probeAutoRequest(pageUrl);
  return out;
}

function apiHeaders(auth, extra = {}) {
  const h = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    cookie: auth.cookieHeader,
    referer: API + '/',
    origin: API,
    'user-agent': navigator.userAgent,
    ...extra,
  };
  if (auth.atoken) h['a-token'] = auth.atoken;
  if (auth.xsrf) {
    h['x-xsrf-token'] = auth.xsrf;
    h['x-csrf-token'] = auth.xsrf;
  }
  return h;
}

class ApiError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'ApiError';
    this.detail = detail;
  }
}

// ---------------------------------------------------------------- page relay
//
// Reading the session out of chrome.cookies is not reliable: some DingTalk
// builds keep the docs session in cookies that the cookie API will not hand
// over (partitioned storage, or set on a host we cannot enumerate). The page
// itself always has its own session, so when the service worker gets rejected
// we replay the same request from inside the page and inherit its credentials.
//
// The injected function is stringified into the page, so it must be completely
// self-contained: no closure references, no outer-scope imports.

let pageRelayWorks = null; // null = untried, true/false = learned

function pageFetchFunc(url, init) {
  return (async () => {
    try {
      const res = await fetch(url, {
        method: (init && init.method) || 'GET',
        credentials: 'include',
        headers: (init && init.headers) || { accept: 'application/json, text/plain, */*' },
        body: init && init.body ? init.body : undefined,
      });
      const text = await res.text();
      return { ok: res.ok, status: res.status, text };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  })();
}

async function findDocTab() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://alidocs.dingtalk.com/*' });
    if (!tabs.length) return null;
    const wanted = S.nodeIdFromUrl(currentPageUrl);
    return (wanted && tabs.find((t) => t.url && t.url.includes(wanted)))
      || tabs.find((t) => t.active)
      || tabs[0];
  } catch {
    return null;
  }
}

// Returns { ok, status, text } or { unavailable: reason }.
async function fetchViaPage(url, init) {
  const tab = await findDocTab();
  if (!tab) return { unavailable: '没有打开钉钉文档页面' };
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pageFetchFunc,
      args: [url, init || {}],
    });
    if (!result) return { unavailable: '页面脚本未返回结果' };
    if (result.error) return { unavailable: result.error };
    return result;
  } catch (e) {
    return { unavailable: String((e && e.message) || e) };
  }
}

// One JSON GET, trying the service worker first and falling back to the page.
async function fetchJsonWithFallback(url, init) {
  const auth = await getAuth(currentPageUrl);
  let direct = null;
  try {
    const res = await fetch(url, {
      method: (init && init.method) || 'GET',
      headers: apiHeaders(auth, (init && init.headers) || {}),
      credentials: 'include',
      body: init && init.body,
    });
    const text = await res.text();
    if (res.ok) {
      pageRelayWorks = false;
      return { text, status: res.status, via: 'sw' };
    }
    direct = { status: res.status, text };
    // Only an auth rejection justifies the relay; other statuses are real answers.
    if (res.status !== 401 && res.status !== 403) {
      return { ...direct, via: 'sw' };
    }
  } catch (e) {
    direct = { status: 0, text: '', error: String((e && e.message) || e) };
  }

  const relayed = await fetchViaPage(url, init);
  if (relayed.unavailable) {
    pageRelayWorks = false;
    return { ...direct, via: 'sw', relayError: relayed.unavailable };
  }
  pageRelayWorks = true;
  return { text: relayed.text, status: relayed.status, via: 'page' };
}

async function apiGet(path, params) {
  const url = new URL(path, API);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const r = await fetchJsonWithFallback(url.toString());
  let json = null;
  try { json = JSON.parse(r.text); } catch { /* not json */ }
  if (r.status < 200 || r.status >= 300) {
    throw new ApiError(
      `HTTP ${r.status} ${url.pathname}${r.via === 'page' ? '（页面代发）' : ''}`,
      (r.text || r.error || '').slice(0, 400),
    );
  }
  if (json && json.isSuccess === false) {
    throw new ApiError(`接口返回失败 ${url.pathname}: ${json.errorMsg || json.message || '未知原因'}`,
      JSON.stringify(json).slice(0, 400));
  }
  return json;
}

async function apiPost(path, body) {
  const r = await fetchJsonWithFallback(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let json = null;
  try { json = JSON.parse(r.text); } catch { /* ignore */ }
  if (r.status < 200 || r.status >= 300) {
    throw new ApiError(`HTTP ${r.status} ${path}`, (r.text || '').slice(0, 400));
  }
  if (json && json.isSuccess === false) {
    throw new ApiError(`接口返回失败 ${path}: ${json.errorMsg || json.message || '未知原因'}`,
      r.text.slice(0, 400));
  }
  return json;
}

// ---------------------------------------------------------------- tree

// Deliberately does NOT keep the raw API payload: each node's response carries a
// full ancestorList plus spaceProfile, which is kilobytes per node. Caching 791
// of those blew past chrome.storage.local's quota.
function normalizeNode(raw) {
  if (!raw) return null;
  const uuid = raw.dentryUuid || raw.uuid || raw.nodeId || raw.id;
  if (!uuid) return null;
  const type = (raw.dentryType || raw.nodeType || raw.type || 'file').toLowerCase();
  return {
    uuid,
    name: raw.name || raw.dentryName || uuid,
    type: type === 'folder' ? 'folder' : 'file',
    // The list endpoint reports fileSize; `size` is used by some other shapes.
    size: raw.fileSize != null ? Number(raw.fileSize)
      : (raw.size != null ? Number(raw.size) : null),
    hasChildren: Boolean(raw.hasChildren),
    // extension comes back without a leading dot ("pptx", not ".pptx")
    extension: raw.extension || raw.suffix || '',
    contentType: raw.contentType || '',
    modified: raw.updatedTime || raw.modifiedTime || raw.gmtModified || null,
  };
}

// The list endpoint ignores `size`/`page`/`offset` entirely. The real contract,
// verified against the live API:
//   request  -> pageSize (server caps at 50) + loadMoreId (cursor from prev page)
//   response -> data.children / data.hasMore / data.loadMoreId
// Response entries also carry contentType: ALIDOC for DingTalk-native online
// docs, `document` for uploaded files.
async function listChildren(dentryUuid, spaceId, log) {
  const out = [];
  const seen = new Set();
  let cursor;
  let page = 0;

  for (;;) {
    const params = { dentryUuid, spaceId, pageSize: 50 };
    if (cursor) params.loadMoreId = cursor;
    const json = await apiGet('/box/api/v2/dentry/list', params);
    const data = (json && (json.data || json.content)) || {};
    const children = data.children || data.list || data.items || [];

    let fresh = 0;
    for (const c of children) {
      const n = normalizeNode(c);
      if (!n || seen.has(n.uuid)) continue;
      seen.add(n.uuid);
      out.push(n);
      fresh += 1;
    }

    page += 1;
    if (log && page % 4 === 0) log(`列出 ${out.length} 项…`);

    const next = data.loadMoreId;
    if (!data.hasMore) break;
    // Guard against a cursor that stops advancing — without this a folder with
    // many children would loop until the page cap.
    if (!next || next === cursor) break;
    if (fresh === 0) break;
    cursor = next;
    if (page > 400) break;
  }
  return out;
}

// Returns just the normalized node: the raw payload is never needed downstream
// and is far too heavy to hold or cache.
async function getDentryInfo(dentryUuid, spaceId) {
  const json = await apiGet('/box/api/v2/dentry/info', { dentryUuid, spaceId });
  const data = (json && (json.data || json.content)) || {};
  return normalizeNode(data);
}

async function discoverSpaceId(dentryUuid, pageUrl) {
  // 1. explicit query param on the tab URL
  if (pageUrl) {
    try {
      const u = new URL(pageUrl);
      for (const k of ['spaceId', 'workspaceId', 'space_id']) {
        const v = u.searchParams.get(k);
        if (v) return v;
      }
    } catch { /* ignore */ }
  }
  // 2. ask the API without spaceId — some endpoints tolerate it
  try {
    const json = await apiGet('/box/api/v2/dentry/info', { dentryUuid });
    const data = (json && (json.data || json.content)) || {};
    if (data.spaceId) return data.spaceId;
  } catch { /* fall through */ }
  // 3. the API is not tolerant: spaceId is inside the user's own workspace.
  //    Read it off the page the user is looking at.
  if (pageUrl && /^https:\/\/alidocs\.dingtalk\.com\//.test(pageUrl)) {
    try {
      const tab = await findDocTab();
      if (tab) {
        const [{ result } = {}] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const html = document.documentElement.innerHTML;
            const m = /"spaceId"\s*:\s*"([^"]+)"/.exec(html)
              || /spaceId=([A-Za-z0-9_-]+)/.exec(location.href);
            return m ? m[1] : '';
          },
        });
        if (result) return result;
      }
    } catch { /* ignore */ }
  }
  return null;
}

// Loads ONE folder's direct children. Children are returned bare (no `children`
// array) so the UI can tell "not fetched yet" from "fetched and empty" — that
// distinction is what makes lazy loading possible.
async function fetchChildren(node, spaceId) {
  const children = await listChildren(node.uuid, spaceId);
  const used = new Set();
  for (const c of children) c.name = S.dedupe(S.safeName(c.name), used);
  node.children = children;
  node.loaded = true;
  return children;
}

// Only the root's own level is fetched up front. The rest of the tree is pulled
// in on demand, which turns a 100+ second full walk into a single request.
async function buildTree({ rootId, pageUrl }, notify) {
  const log = (msg) => notify({ type: 'progress', phase: 'scan', message: msg });
  setPageUrl(pageUrl);
  log('读取登录态…');
  const auth = await getAuth(pageUrl);
  log(auth.sessionCookies.length
    ? `cookie 里有 ${auth.sessionCookies.join(' + ')}（共 ${auth.names.length} 项）`
    : `cookie 里没有已知的会话项（共 ${auth.names.length} 项），将直接尝试请求`);

  const spaceId = await discoverSpaceId(rootId, pageUrl);
  if (!spaceId) {
    const err = new ApiError('未能识别 spaceId。请把钉钉文档页面地址栏里的完整链接（含 ?spaceId=… 部分）发我，或确认该页面已完全加载。');
    err.code = 'NO_SPACE_ID';
    throw err;
  }
  log(`spaceId = ${S.shortId(spaceId)}`);

  const rootNode = await getDentryInfo(rootId, spaceId);
  const root = rootNode || {
    uuid: rootId, name: '钉钉文档', type: 'folder', hasChildren: true, size: null,
  };
  if (root.type !== 'folder') {
    // single file link — wrap it so the tree still works
    root.wrappedSingle = true;
    root.loaded = true;
    root.children = null;
  } else {
    log('读取根目录…');
    await fetchChildren(root, spaceId);
    log(`已读取根目录 ${root.children.length} 项`);
  }

  const tree = {
    root,
    spaceId,
    scannedAt: Date.now(),
    pageUrl,
    // Nothing below the root has been read yet, so totals are unknown.
    stats: countLoaded(root),
  };
  annotateSizes(root);
  lastTreeInMemory = tree;

  let cacheWarning = null;
  try {
    await chrome.storage.local.set({ [TREE_CACHE_KEY]: tree });
  } catch (e) {
    cacheWarning = String((e && e.message) || e);
  }
  return { tree, cacheWarning };
}

// Counts only what has actually been fetched, and reports whether anything is
// still unknown so the UI can label the numbers as incomplete.
function countLoaded(node) {
  const out = { folders: 0, files: 0, bytes: 0, partial: false };
  const walk = (n) => {
    if (n.type !== 'folder') {
      out.files += 1;
      out.bytes += n.size || 0;
      return;
    }
    out.folders += 1;
    if (!n.loaded) { out.partial = true; return; }
    for (const c of n.children || []) walk(c);
  };
  if (node.type === 'folder' && node.loaded) {
    out.folders = 0;
    for (const c of node.children || []) walk(c);
  } else if (node.type !== 'folder') {
    walk(node);
    out.folders = 0;
  }
  return out;
}

function persistTree() {
  if (!lastTreeInMemory) return;
  // Fire and forget: the cache is a convenience, and a quota failure must never
  // surface as an error in the middle of browsing.
  chrome.storage.local.set({ [TREE_CACHE_KEY]: lastTreeInMemory }).catch(() => {});
}

// Per-folder byte totals. DingTalk exposes no aggregate size — not in dentry/info,
// not in the list response, and its own web UI does not show folder sizes at all
// (verified: no size-bearing endpoint exists). So a size can only be derived from
// the files underneath, and is only knowable once that subtree has been read.
//
// Attaches `sizeBytes` to every fully-loaded folder and deletes it from folders
// whose subtree is incomplete, so a stale number is never shown as current.
function annotateSizes(node) {
  if (node.type !== 'folder') return node.size || 0;
  if (!node.loaded) return null;
  let total = 0;
  for (const c of node.children || []) {
    const sub = annotateSizes(c);
    if (sub === null) { delete node.sizeBytes; return null; }
    total += sub;
  }
  node.sizeBytes = total;
  return total;
}

function countUnloadedFolders(node) {
  let n = 0;
  const walk = (x) => {
    if (x.type !== 'folder') return;
    if (!x.loaded) { n += 1; return; }
    for (const c of x.children || []) walk(c);
  };
  walk(node);
  return n;
}

// Expands one subtree, fetching sibling folders concurrently. Used for surgical
// expansion (only the folders the user selected) rather than the whole tree.
async function loadSubtree(node, spaceId, budget, failures) {
  if (node.type !== 'folder') return;
  if (!node.loaded) {
    if (budget.requests <= 0) return;
    budget.requests -= 1;
    try {
      await fetchChildren(node, spaceId);
    } catch (e) {
      failures.push({ name: node.name, reason: String((e && e.message) || e) });
      return;
    }
  }
  const kids = (node.children || []).filter((c) => c.type === 'folder' && !c.loaded);
  for (let i = 0; i < kids.length; i += WALK_CONCURRENCY) {
    const batch = kids.slice(i, i + WALK_CONCURRENCY);
    await Promise.all(batch.map((c) => loadSubtree(c, spaceId, budget, failures)));
  }
}

// Walks the whole tree, fetching each unloaded folder once. Breadth-first with a
// deterministic queue: each folder is counted exactly once, and the counters
// describe exactly what happened (an earlier recursive version silently lost
// track of folders when the tree was already partly loaded).
//
// Requests run in parallel — the server round trip dominates (measured ~280ms
// each), so a serial walk of 288 folders took ~80s while the same work at
// concurrency 6 takes a fraction of that. Concurrency is deliberately modest:
// these are the user's own private endpoints.
const WALK_CONCURRENCY = 6;

async function expandEverything(tree, cap, notify) {
  const queue = [];
  for (const c of tree.root.children || []) {
    if (c.type === 'folder') queue.push(c);
  }
  let loaded = 0;
  let requests = 0;
  const failures = [];
  const seen = new Set();
  let sinceProgress = 0;

  const report = (force) => {
    if (!notify) return;
    if (!force && sinceProgress < 15) return;
    sinceProgress = 0;
    notify({
      type: 'progress',
      phase: 'scan',
      message: `已读取 ${loaded} 个文件夹…`,
      done: loaded,
      total: null,
    });
  };

  const worker = async () => {
    for (;;) {
      const node = queue.shift();
      if (!node) return;
      if (seen.has(node.uuid)) continue;
      seen.add(node.uuid);
      if (!node.loaded) {
        if (requests >= cap) {
          queue.unshift(node); // leave it for a later run
          return;
        }
        requests += 1;
        try {
          await fetchChildren(node, tree.spaceId);
          loaded += 1;
          sinceProgress += 1;
          report(false);
        } catch (e) {
          failures.push({ name: node.name, reason: String((e && e.message) || e) });
          continue; // do not descend into a folder we could not read
        }
      }
      for (const c of node.children || []) {
        if (c.type === 'folder' && !c.loaded && !seen.has(c.uuid)) queue.push(c);
      }
    }
  };

  await Promise.all(Array.from({ length: WALK_CONCURRENCY }, worker));
  report(true);

  return {
    loaded,
    requests,
    failures,
    remaining: countUnloadedFolders(tree.root),
  };
}

// ---------------------------------------------------------------- download

// The live API answers /box/api/v2/file/download with
//   data.downloadType = "CDN_URL_PRE_SIGNATURE"
//   data.cdnUrlPreSignatureInfo.cdnPreSignUrls[0]
// Older/other shapes use ossUrlPreSignatureInfo.preSignUrls, so accept both.
const URL_CONTAINER_KEYS = [
  'cdnUrlPreSignatureInfo',
  'ossUrlPreSignatureInfo',
  'preSignatureInfo',
  'presignInfo',
];

function extractDownloadUrl(payload) {
  if (!payload) return null;
  const d = payload.data || payload.content || payload;
  if (typeof d === 'string' && /^https?:\/\//.test(d)) return d;
  const direct = d.downloadUrl || d.url || d.signedUrl || d.ossUrl;
  if (typeof direct === 'string' && /^https?:\/\//.test(direct)) return direct;
  for (const key of URL_CONTAINER_KEYS) {
    const info = d[key];
    if (!info) continue;
    const urls = info.cdnPreSignUrls || info.preSignUrls || info.urls
      || info.signedUrls || info.cdnUrls;
    if (Array.isArray(urls) && urls.length && typeof urls[0] === 'string') return urls[0];
  }
  if (Array.isArray(d.urls) && d.urls.length) return d.urls[0];
  return null;
}

// The API always answers this endpoint with JSON carrying a signed CDN URL
// (verified: downloadType = CDN_URL_PRE_SIGNATURE). Anything else is an error.
async function resolveDownloadUrl(node, spaceId) {
  const url = new URL('/box/api/v2/file/download', API);
  url.searchParams.set('dentryUuid', node.uuid);
  if (spaceId) url.searchParams.set('spaceId', String(spaceId));
  const r = await fetchJsonWithFallback(url.toString());

  if (r.status < 200 || r.status >= 300) {
    throw new ApiError(`下载接口 HTTP ${r.status}（${node.name}）`,
      (r.text || r.error || '').slice(0, 300));
  }
  let json = null;
  try { json = JSON.parse(r.text); } catch { /* fall through to the error below */ }
  if (!json) {
    throw new ApiError(`下载接口返回了非 JSON 内容（${node.name}）`, (r.text || '').slice(0, 200));
  }
  if (json.isSuccess === false) {
    throw new ApiError(`无法下载「${node.name}」：${json.errorMsg || json.message || '接口拒绝'}`);
  }
  const signed = extractDownloadUrl(json);
  if (!signed) throw new ApiError(`「${node.name}」没有返回下载地址：${r.text.slice(0, 200)}`);
  return { kind: 'url', url: signed };
}

// Flattens the selected subtree into {node, pathParts} entries.
//
// `parts` is the destination path RELATIVE TO THE SELECTION — the scanned root
// never appears in it. Ticking a folder named "报告" containing "财务/x.xlsx"
// therefore yields "报告/财务/x.xlsx", and ticking the root's own children yields
// "财务/x.xlsx":
//
// The selection comes from the UI, which may never have expanded a folder the
// user ticked — such a node has no `children`. So for every folder we look the
// node up in the background's own tree (by uuid) and fetch its children when
// they are missing. This is what makes "just tick the folder" work.
async function collectFilesResolving(selection, tree, onProgress) {
  const out = [];
  const failures = [];
  const countFolders = (list) => list.reduce(
    (a, n) => a + (n.type === 'folder' ? 1 + countFolders(n.children || []) : 0), 0,
  );
  let resolved = 0;
  const totalFolders = countFolders(selection);

  const ensureLoaded = async (node) => {
    if (node.type !== 'folder') return true;
    if (node.loaded && node.children) return true;
    // Prefer the background's copy: the UI's may lack children entirely.
    const authoritative = findNodeByUuid(tree.root, node.uuid);
    const target = authoritative && authoritative.type === 'folder' ? authoritative : node;
    if (target.loaded && target.children) {
      node.children = target.children;
      node.loaded = true;
      return true;
    }
    try {
      resolved += 1;
      if (onProgress) onProgress(resolved, totalFolders, node.name);
      await fetchChildren(target, tree.spaceId);
      node.children = target.children;
      node.loaded = true;
      return true;
    } catch (e) {
      failures.push({ name: node.name, reason: String((e && e.message) || e) });
      return false;
    }
  };

  // Paths are relative to the SELECTION, with exactly one exception: the scanned
  // root itself. That node is only the entry point the user opened the panel
  // from, so letting it through would add a spurious top level to every download
  // ("根目录名/…"). Everything the user actually ticked keeps its own name, so
  // ticking "产品A" yields "产品A/手册/说明书.pdf".
  const walk = async (nodeList, prefix) => {
    for (const n of nodeList) {
      const skipSelf = n.uuid === tree.root.uuid;
      const parts = skipSelf ? [...prefix] : [...prefix, S.safeName(n.name)];
      if (n.type === 'folder') {
        if (await ensureLoaded(n)) await walk(n.children || [], parts);
      } else {
        out.push({ node: n, parts });
      }
    }
  };

  await walk(selection, []);
  if (resolved) annotateSizes(tree.root);
  return { entries: out, failures, resolvedFolders: resolved };
}

// Where downloads land. chrome.downloads only accepts a path RELATIVE to the
// browser's download directory, so the user picks a subfolder of it; `saveAs`
// is the escape hatch when they want somewhere else entirely.
const DOWNLOAD_DIR_KEY = 'ddDownloadDir';

function normalizeSubdir(raw) {
  if (!raw) return '';
  const cleaned = String(raw)
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => S.safeName(p.replace(/\.\./g, '_')))
    .filter((p) => p && p !== '.')
    .join('/');
  return cleaned.slice(0, 180);
}

async function getDownloadDir() {
  try {
    const got = await chrome.storage.local.get(DOWNLOAD_DIR_KEY);
    return normalizeSubdir(got[DOWNLOAD_DIR_KEY]);
  } catch {
    return '';
  }
}

async function setDownloadDir(value) {
  const dir = normalizeSubdir(value);
  try {
    await chrome.storage.local.set({ [DOWNLOAD_DIR_KEY]: dir });
  } catch { /* not fatal: the download still works with the default folder */ }
  return dir;
}

// chrome.downloads refuses absolute paths and any ".." segment; build the
// relative path defensively so a hostile folder name cannot escape the
// download directory.
function buildFilename(parts) {
  const segments = parts
    .map((p) => S.safeName(String(p).replace(/\.\./g, '_')))
    .filter((p) => p && p !== '.');
  return segments.join('/');
}

async function downloadOne(job, entry, usedByDir) {
  const { node, parts } = entry;

  // Directory the file lands in, relative to the Downloads folder.
  const dirParts = parts.slice(0, -1);
  const dirKey = dirParts.join('/');
  if (!usedByDir.has(dirKey)) usedByDir.set(dirKey, new Set());
  const used = usedByDir.get(dirKey);

  const relDir = job.flatten ? [] : dirParts;

  if (S.isOnlineDoc(node)) {
    return {
      node,
      skipped: true,
      reason: 'online-doc',
      url: `${API}/i/nodes/${node.uuid}`,
    };
  }

  const resolved = await resolveDownloadUrl(node, job.spaceId);
  const downloadUrl = resolved.url;

  // Dedupe within the destination directory, after the extension is known,
  // so "报告" and "报告.pdf" stay distinct names.
  const finalName = S.dedupe(S.safeName(node.name), used);
  const filename = buildFilename([...(job.dirParts || []), ...relDir, finalName]);

  const id = await chrome.downloads.download({
    url: downloadUrl,
    filename,
    conflictAction: 'uniquify',
    saveAs: false,
  });
  return { node, downloadId: id, filename };
}

async function runDownload({ entries, spaceId, flatten, mode, zipName, dirParts }, notify) {
  if (mode === 'zip') return runZip({ entries, spaceId, flatten, zipName }, notify);

  const usedByDir = new Map();
  const failures = [];
  let done = 0;
  let ok = 0;

  for (const entry of entries) {
    if (currentJob && currentJob.cancelled) {
      notify({ type: 'progress', phase: 'download', message: '已取消', done, total: entries.length });
      break;
    }
    notify({
      type: 'progress',
      phase: 'download',
      message: `(${done + 1}/${entries.length}) ${entry.node.name}`,
      done,
      total: entries.length,
    });
    try {
      const r = await downloadOne({ spaceId, flatten, dirParts }, entry, usedByDir);
      if (r && r.skipped) {
        failures.push({ name: entry.node.name, reason: '在线文档，需在钉钉里手动导出', url: r.url });
      } else {
        ok += 1;
      }
    } catch (e) {
      failures.push({ name: entry.node.name, reason: e.message });
    }
    done += 1;
    // Be a good citizen: these are private endpoints behind a rate limiter.
    await new Promise((r) => setTimeout(r, 250));
  }

  notify({
    type: 'progress',
    phase: 'done',
    message: `完成：${ok} 个文件已下载，${failures.length} 个跳过或失败`,
    done,
    total: entries.length,
  });
  return { done, ok, failures };
}

// ---------------------------------------------------------------- blob URLs
//
// An MV3 service worker has no DOM, and URL.createObjectURL is therefore NOT
// available in it (verified in a live service worker: typeof is 'undefined' and
// calling it throws "URL.createObjectURL is not a function"). The zip path needs
// a blob: URL that chrome.downloads will accept, so the blob is handed to an
// offscreen document — which does have a DOM — and only the URL comes back.
//
// The payload is sent in chunks because runtime.sendMessage has a hard 64 MiB
// ceiling (measured in a live worker: 32 MB of data passes, 64 MB throws
// "Message exceeded maximum allowed size of 64MiB"). base64 inflates by a third,
// so a single message could never carry a real archive — sending one produced a
// truncated, unusable zip.

let offscreenReady = null;
const OFFSCREEN_PATH = 'src/offscreen.html';
// base64 of 4 MiB of payload is ~5.6 MB of text: comfortably under the ceiling.
const CHUNK_BYTES = 4 * 1024 * 1024;

async function ensureOffscreen() {
  // hasDocument() is the only reliable way; getContexts() is newer.
  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    if (await chrome.offscreen.hasDocument()) return;
  } else if (offscreenReady) {
    return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['BLOBS'],
      justification: '把打包好的 zip 变成 blob: 地址交给下载器（Service Worker 里没有 URL.createObjectURL）',
    });
  } catch (e) {
    // Race: another call created it first.
    if (!/single offscreen|already/i.test(String((e && e.message) || e))) throw e;
  }
  offscreenReady = true;
}

// Chunked so a large archive cannot blow the argument limit of
// String.fromCharCode.apply.
function bytesToBase64(bytes) {
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

let transferSeq = 0;

async function makeBlobUrl(blob) {
  await ensureOffscreen();
  const id = `t${Date.now()}-${++transferSeq}`;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mime = blob.type || 'application/octet-stream';

  try {
    for (let off = 0; off < bytes.length; off += CHUNK_BYTES) {
      const slice = bytes.subarray(off, Math.min(off + CHUNK_BYTES, bytes.length));
      const res = await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'blob-chunk',
        id,
        mime,
        base64: bytesToBase64(slice),
      });
      if (!res || !res.ok) {
        throw new ApiError(`传输分片被拒绝：${(res && res.error) || '离屏文档没有响应'}`);
      }
    }
    const done = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'blob-finish', id, mime });
    if (!done || !done.ok) {
      throw new ApiError(`离屏文档创建地址失败：${(done && done.error) || '没有响应'}`);
    }
    // A short archive is the classic symptom of a truncated transfer, so verify
    // rather than hand the user a silently broken file.
    if (done.size !== bytes.length) {
      throw new ApiError(`传输不完整：发送 ${bytes.length} 字节，离屏文档只组装出 ${done.size} 字节`);
    }
    return done.url;
  } catch (e) {
    try { await chrome.runtime.sendMessage({ target: 'offscreen', type: 'blob-abort', id }); } catch { /* ignore */ }
    throw e;
  }
}

async function releaseBlobUrl(url) {
  try {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'revoke-blob-url', url });
  } catch { /* document may already be gone */ }
}

// Hands a blob to chrome.downloads, falling back between two mechanisms:
//   1. an offscreen document, which can create a blob: URL;
//   2. a base64 data: URL, which needs no DOM but cannot hold large payloads.
async function downloadBlob(blob, filename) {
  let blobUrl = null;
  let firstError = null;
  try {
    blobUrl = await makeBlobUrl(blob);
    const id = await chrome.downloads.download({ url: blobUrl, filename, conflictAction: 'uniquify', saveAs: false });
    setTimeout(() => releaseBlobUrl(blobUrl), 600_000);
    return { id, via: 'offscreen', size: blob.size };
  } catch (e) {
    firstError = e;
    if (blobUrl) { releaseBlobUrl(blobUrl); blobUrl = null; }
  }

  // Fallback: data: URLs work in a service worker, but Chrome refuses anything
  // in the multi-megabyte range, so this only rescues small archives.
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const dataUrl = `data:${blob.type || 'application/octet-stream'};base64,${bytesToBase64(bytes)}`;
    const id = await chrome.downloads.download({ url: dataUrl, filename, conflictAction: 'uniquify', saveAs: false });
    return { id, via: 'data-url', size: blob.size };
  } catch (e) {
    throw new ApiError(
      `打包完成但无法保存（离屏方式失败：${(firstError && firstError.message) || firstError}；data: 方式失败：${(e && e.message) || e}）`,
    );
  }
}

// ---------------------------------------------------------------- zip mode

async function fetchNodeBlob(node, spaceId) {
  const resolved = await resolveDownloadUrl(node, spaceId);
  // The signed URL is self-authenticating and CORS-exempt for the extension
  // (host_permissions), so fetch it directly rather than through the page.
  const res = await fetch(resolved.url);
  if (!res.ok) throw new ApiError(`取文件失败 HTTP ${res.status}（${node.name}）`);
  return await res.blob();
}

async function runZip({ entries, spaceId, flatten, zipName, dirParts: outDir }, notify) {
  const failures = [];
  const zipEntries = [];
  const usedByDir = new Map();
  let done = 0;

  for (const entry of entries) {
    if (currentJob && currentJob.cancelled) break;
    const { node, parts } = entry;
    notify({
      type: 'progress',
      phase: 'download',
      message: `(${done + 1}/${entries.length}) 读取 ${node.name}`,
      done,
      total: entries.length,
    });
    if (S.isOnlineDoc(node)) {
      failures.push({ name: node.name, reason: '在线文档，需在钉钉里手动导出', url: `${API}/i/nodes/${node.uuid}` });
      done += 1;
      continue;
    }
    try {
      const blob = await fetchNodeBlob(node, spaceId);
      const dirParts = flatten ? [] : parts.slice(0, -1);
      const dirKey = dirParts.join('/');
      if (!usedByDir.has(dirKey)) usedByDir.set(dirKey, new Set());
      const name = S.dedupe(S.safeName(node.name), usedByDir.get(dirKey));
      const zipPath = [...dirParts, name].join('/');
      zipEntries.push({ path: zipPath, blob });
    } catch (e) {
      failures.push({ name: node.name, reason: e.message });
    }
    done += 1;
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!zipEntries.length) {
    notify({ type: 'progress', phase: 'done', message: '没有可打包的文件。', done, total: entries.length });
    return { done, ok: 0, failures };
  }

  notify({ type: 'progress', phase: 'download', message: '正在压缩打包…', done, total: entries.length });
  const zipBlob = await Z.buildZip(zipEntries, {
    // These are user documents; DEFLATE is worth it for text-heavy files and
    // the builder falls back to store per file when it would not help.
    compress: true,
    onProgress: (i, total, path) => {
      notify({
        type: 'progress',
        phase: 'download',
        message: `打包中 (${i}/${total}) ${path}`,
        done,
        total: entries.length,
      });
    },
  });

  const baseName = (zipName || `钉钉文档-${S.tsName()}.zip`).replace(/[\\/:*?"<>|]/g, '_');
  const filename = buildFilename([...(outDir || []), baseName]);
  const saved = await downloadBlob(zipBlob, filename);

  notify({
    type: 'progress',
    phase: 'done',
    message: `打包完成：${zipEntries.length} 个文件 → ${filename}（${S.humanSize(zipBlob.size)}）`,
    done,
    total: entries.length,
  });
  return {
    done,
    ok: zipEntries.length,
    failures,
    zip: { id: saved.id, filename, size: zipBlob.size, via: saved.via },
  };
}

// Resolve the current tree: in-memory copy first (survives a failed storage
// write), storage second.
async function resolveTree() {
  if (lastTreeInMemory) return lastTreeInMemory;
  try {
    const stored = await chrome.storage.local.get(TREE_CACHE_KEY);
    lastTreeInMemory = stored[TREE_CACHE_KEY] || null;
  } catch {
    lastTreeInMemory = null;
  }
  return lastTreeInMemory;
}

function findNodeByUuid(node, uuid) {
  if (!node) return null;
  if (node.uuid === uuid) return node;
  for (const c of node.children || []) {
    const hit = findNodeByUuid(c, uuid);
    if (hit) return hit;
  }
  return null;
}

// The UI keeps its own copy of the tree, so any size the background annotates
// has to be handed back explicitly. Without this the side panel kept showing
// "大小未知" even after a full expansion had computed every size.
function sizeMap(node, out = {}) {
  if (node.type === 'folder' && node.sizeBytes != null) out[node.uuid] = node.sizeBytes;
  for (const c of node.children || []) sizeMap(c, out);
  return out;
}

// ---------------------------------------------------------------- messaging

const handlers = {
  async ping({ pageUrl } = {}) {
    setPageUrl(pageUrl);
    const auth = await getAuth(pageUrl);
    // Ask the API rather than inspecting cookie names — the relay means the
    // session can work even when the cookie jar looks empty to us.
    const probe = await probeAutoRequest(pageUrl);
    const ok = probe.status === 200 || probe.skipped;
    return {
      ok: true,
      loggedIn: ok,
      via: probe.via || null,
      probeStatus: probe.status || null,
      probeError: probe.errorMsg || probe.error || null,
      relayError: probe.relayError || null,
      hasTab: Boolean(await findDocTab()),
      sessionCookies: auth.sessionCookies,
      cookieNames: auth.names,
      totalCookies: auth.totalCookies,
      hasAtoken: Boolean(auth.atoken),
      hasXsrf: Boolean(auth.xsrf),
    };
  },

  async diagnose({ pageUrl } = {}) {
    return await diagnose(pageUrl);
  },

  async getTree() {
    return { tree: await resolveTree() };
  },

  async scan({ rootId, pageUrl }) {
    const notify = (m) => chrome.runtime.sendMessage(m).catch(() => {});
    const { tree, cacheWarning } = await buildTree({ rootId, pageUrl }, notify);
    return { tree, cacheWarning };
  },

  // Expand one folder: the UI sends the node's uuid and gets its direct
  // children back, without any recursion.
  async listChildren({ uuid }) {
    const tree = await resolveTree();
    if (!tree) throw new ApiError('还没有扫描结果，请先扫描。');
    const node = findNodeByUuid(tree.root, uuid);
    if (!node) throw new ApiError('找不到该文件夹节点，请重新扫描。');
    if (node.loaded) {
      return { children: node.children || [], stats: countLoaded(tree.root), cached: true };
    }
    const children = await fetchChildren(node, tree.spaceId);
    annotateSizes(tree.root);
    persistTree();
    return {
      children,
      stats: countLoaded(tree.root),
      sizes: sizeMap(tree.root),
      cached: false,
    };
  },

  // "展开全部" — walks the whole tree on purpose, with a request budget.
  async loadAll({ maxRequests } = {}) {
    const tree = await resolveTree();
    if (!tree) throw new ApiError('还没有扫描结果，请先扫描。');
    const notify = (m) => chrome.runtime.sendMessage(m).catch(() => {});
    const cap = Math.max(1, Math.min(Number(maxRequests) || 2000, 5000));
    const before = countUnloadedFolders(tree.root);
    notify({ type: 'progress', phase: 'scan', message: `展开全部：还有 ${before} 个文件夹待读取…` });
    const res = await expandEverything(tree, cap, notify);
    annotateSizes(tree.root);
    persistTree();
    return {
      stats: countLoaded(tree.root),
      sizes: sizeMap(tree.root),
      expanded: res.loaded,
      remaining: res.remaining,
      failures: res.failures,
      requestsUsed: res.requests,
      truncated: res.remaining > 0,
    };
  },

  // Expand only the subtrees the user actually selected. Used when a folder is
  // ticked without opening it: the UI needs its file count and size, but has no
  // reason to fetch the rest of the tree.
  async expandSelected({ uuids, maxRequests } = {}) {
    const tree = await resolveTree();
    if (!tree) throw new ApiError('还没有扫描结果，请先扫描。');
    const cap = Math.max(1, Math.min(Number(maxRequests) || 3000, 8000));
    const budget = { requests: cap };
    let expanded = 0;
    const failures = [];
    const notify = (m) => chrome.runtime.sendMessage(m).catch(() => {});
    for (const uuid of uuids || []) {
      const node = findNodeByUuid(tree.root, uuid);
      if (!node || node.type !== 'folder') continue;
      const before = countUnloadedFolders(node);
      notify({ type: 'progress', phase: 'scan', message: `解析文件夹：${node.name}（${before} 个子文件夹）` });
      await loadSubtree(node, tree.spaceId, budget, failures);
      expanded += before - countUnloadedFolders(node);
    }
    annotateSizes(tree.root);
    persistTree();
    return {
      stats: countLoaded(tree.root),
      sizes: sizeMap(tree.root),
      expanded,
      failures,
      remaining: countUnloadedFolders(tree.root),
    };
  },

  async download({ selection, options }) {
    const tree = await resolveTree();
    if (!tree) throw new ApiError('还没有扫描结果，请先扫描。');
    const notify = (m) => chrome.runtime.sendMessage(m).catch(() => {});
    currentJob = { cancelled: false };

    // A checked folder may never have been expanded, in which case the UI has no
    // children for it. Resolve those here so "just tick the folder" works, which
    // is the whole point of being able to select a folder without opening it.
    const { entries, failures: resolveFailures } = await collectFilesResolving(
      selection, tree, (done, total, name) => {
        notify({
          type: 'progress',
          phase: 'download',
          message: `解析文件夹 (${done}/${total}) ${name}`,
          done: 0,
          total: 0,
        });
      },
    );
    if (!entries.length) {
      const detail = resolveFailures.length
        ? resolveFailures.slice(0, 3).map((f) => `${f.name}: ${f.reason}`).join('；')
        : null;
      throw new ApiError('没有可下载的文件。', detail);
    }

    // The panel may pass a directory explicitly; otherwise use the saved one.
    const dir = options && options.dir !== undefined
      ? await setDownloadDir(options.dir)
      : await getDownloadDir();
    const dirParts = dir ? dir.split('/') : [];

    const res = await runDownload(
      {
        entries,
        spaceId: tree.spaceId,
        flatten: Boolean(options && options.flatten),
        mode: (options && options.mode) || 'files',
        zipName: options && options.zipName,
        dirParts,
      },
      notify,
    );
    currentJob = null;
    if (resolveFailures.length) {
      res.failures = [...(res.failures || []), ...resolveFailures];
    }
    res.dir = dir;
    return res;
  },

  async getDownloadDir() {
    return { dir: await getDownloadDir() };
  },

  async setDownloadDir({ dir } = {}) {
    return { dir: await setDownloadDir(dir) };
  },

  // Chrome's own download-location UI, for when the user wants somewhere other
  // than a subfolder of the default download directory.
  async openDownloadSettings() {
    return await openDownloadFolderSettings();
  },

  async cancel() {
    if (currentJob) currentJob.cancelled = true;
    return { cancelled: true };
  },

  async revealDownload() {
    // open the downloads page so the user can find everything at once
    await chrome.tabs.create({ url: 'chrome://downloads/' });
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fn = handlers[msg && msg.type];
  if (!fn) return false;
  fn(msg, sender)
    .then((r) => sendResponse({ ok: true, ...r }))
    .catch((e) => sendResponse({
      ok: false,
      error: e.message,
      code: e.code || null,
      detail: e.detail || null,
    }));
  return true; // async response
});

// ---------------------------------------------------------------- panel
//
// Chrome's side panel is the UI host. It stays open across tabs — that is its
// behaviour, not a bug, and an in-page overlay was tried as a replacement and
// rejected: it could not be made reliable on the live DingTalk page.
//
// Note for anyone tempted to "fix" the persistence: there is no API to close a
// side panel programmatically, and setOptions({enabled:false}) on other tabs does
// not dismiss the panel the user already opened. The only controls are the user's
// own close button and `openPanelOnActionClick`.

const PANEL_PATH = 'src/sidepanel.html';

function configurePanelBehavior() {
  if (!chrome.sidePanel || !chrome.sidePanel.setPanelBehavior) return;
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(configurePanelBehavior);
configurePanelBehavior();

// Chrome's own download settings, for choosing a location other than a subfolder
// of the default download directory.
async function openDownloadFolderSettings() {
  try {
    // 1. showDefaultFolder() reveals the folder in the file manager and, on some
    //    platforms, opens Chrome's download UI with the "Change" affordance.
    if (chrome.downloads && chrome.downloads.showDefaultFolder) {
      chrome.downloads.showDefaultFolder();
      return { ok: true, via: 'showDefaultFolder' };
    }
  } catch { /* fall through */ }
  try {
    await chrome.tabs.create({ url: 'chrome://settings/downloads' });
    return { ok: true, via: 'settings-tab' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
