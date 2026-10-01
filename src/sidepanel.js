// Side panel UI for the DingTalk Docs folder downloader.
const S = globalThis.DDShared;

// The panel root. Kept as a single indirection so element lookups all go through
// one place.
const root = document;
const $ = (id) => root.getElementById(id);

const els = {
  sessionDot: $('sessionDot'),
  sessionInfo: $('sessionInfo'),
  rootUrl: $('rootUrl'),
  btnUseTab: $('btnUseTab'),
  btnScan: $('btnScan'),
  btnCancel: $('btnCancel'),
  btnPing: $('btnPing'),
  btnDiag: $('btnDiag'),
  diagBox: $('diagBox'),
  diagText: $('diagText'),
  btnCloseDiag: $('btnCloseDiag'),
  statsBar: $('statsBar'),
  statFolders: $('statFolders'),
  statFiles: $('statFiles'),
  statSize: $('statSize'),
  statSel: $('statSel'),
  toolbar: $('toolbar'),
  filter: $('filter'),
  btnAll: $('btnAll'),
  btnNone: $('btnNone'),
  btnInvert: $('btnInvert'),
  btnExpandAll: $('btnExpandAll'),
  optFlatten: $('optFlatten'),
  optZip: $('optZip'),
  zipWarn: $('zipWarn'),
  downloadDir: $('downloadDir'),
  btnPickDir: $('btnPickDir'),
  tree: $('tree'),
  btnDownload: $('btnDownload'),
  btnOpenDl: $('btnOpenDl'),
  progress: $('progress'),
  barFill: $('barFill'),
  progressText: $('progressText'),
  report: $('report'),
  reportList: $('reportList'),
  btnCloseReport: $('btnCloseReport'),
};

let tree = null;
let scanning = false;
let downloading = false;
// The subfolder of the browser's download directory that files land in.
let downloadDir = '';
// The page the user is working in. Cookie reads are path sensitive, so the
// background needs this on every call to find path-scoped session cookies.
let currentPageUrl = null;

function send(type, payload) {
  return chrome.runtime.sendMessage({ type, pageUrl: currentPageUrl, ...(payload || {}) });
}

function say(msg, kind) {
  els.sessionInfo.textContent = msg;
  els.sessionInfo.className = `hint${kind ? ' ' + kind : ''}`;
}

// ---------------------------------------------------------------- session

async function checkSession({ quiet = false } = {}) {
  try {
    const r = await send('ping');
    if (r.ok && r.loggedIn) {
      els.sessionDot.className = 'dot ok';
      if (!quiet) {
        const via = r.via === 'page'
          ? '经页面代发请求'
          : (r.sessionCookies && r.sessionCookies.length
            ? `会话 cookie: ${r.sessionCookies.join(' + ')}`
            : '接口已接受当前会话');
        say(`会话可用（${via}）`, 'ok');
      }
    } else {
      els.sessionDot.className = 'dot bad';
      if (r.relayError) {
        say(`扩展自己的请求被拒（HTTP ${r.probeStatus}），且页面代发也失败：${r.relayError}。请确认钉钉文档页面还开着。`, 'bad');
      } else {
        say(`钉钉接口返回 HTTP ${r.probeStatus || '?'}：${r.probeError || '无法访问该节点'}。请点「诊断」查看详情。`, 'bad');
      }
    }
    return r;
  } catch (e) {
    els.sessionDot.className = 'dot bad';
    say('无法连接扩展后台：' + e.message, 'bad');
    return null;
  }
}

async function runDiagnose() {
  els.diagBox.hidden = false;
  els.diagText.textContent = '诊断中…';
  let r;
  try {
    r = await send('diagnose');
  } catch (e) {
    els.diagText.textContent = '诊断调用失败：' + e.message;
    return;
  }
  if (!r.ok) {
    els.diagText.textContent = '诊断失败：' + r.error;
    return;
  }
  const lines = [];
  if (!r.pageUrl) {
    lines.push('⚠️ 还没有定位到钉钉文档页面。请先打开该文件夹页面，点「用当前标签页」。');
    lines.push('');
  } else {
    lines.push(`页面            : ${r.pageUrl}`);
  }
  lines.push(`会话 cookie     : ${r.sessionCookies.length ? r.sessionCookies.join(', ') : '（未识别到已知会话 cookie）'}`);
  lines.push(`doc_atoken      : ${r.hasAtoken ? '有' : '没有'}`);
  lines.push(`XSRF-TOKEN      : ${r.hasXsrf ? '有' : '没有'}`);
  lines.push(`读到的 cookie 总数: ${r.totalCookies}`);
  lines.push(`去重后名称(${r.cookieNames.length}): ${r.cookieNames.join(', ') || '（空）'}`);
  lines.push('');
  lines.push('各查询来源返回情况:');
  for (const s of r.sources) {
    if (s.error) lines.push(`  ${s.label}  → 报错: ${s.error}`);
    else lines.push(`  ${s.label}  → ${s.count} 项（新增 ${s.fresh}）`);
  }
  lines.push('');

  const fmtProbe = (p, label) => {
    if (!p) { lines.push(`${label}: （未执行）`); return; }
    if (p.skipped) { lines.push(`${label}: 跳过（${p.skipped}）`); return; }
    if (p.error) { lines.push(`${label}: 请求失败（${p.error}）`); return; }
    const extra = [];
    if (p.via) extra.push(`经${p.via === 'page' ? '页面代发' : '扩展自身'}`);
    if (p.name) extra.push(`节点=${p.name}(${p.dentryType || '?'})`);
    if (p.errorMsg) extra.push(`信息=${p.errorMsg}`);
    if (p.relayError) extra.push(`页面代发失败=${p.relayError}`);
    if (p.bodyHead) extra.push(`响应=${p.bodyHead}`);
    lines.push(`${label}: HTTP ${p.status}  ${extra.join('  ')}`);
  };
  lines.push('关键对比:');
  lines.push(`  钉钉文档标签页: ${r.hasTab ? '已找到' : '未找到 ❗（页面代发需要它）'}`);
  fmtProbe(r.directProbe, '  ① 扩展自身发起（不带代发）');
  fmtProbe(r.autoProbe, '  ② 扩展实际使用的方式  ');
  lines.push('');

  const auto = r.autoProbe || {};
  const direct = r.directProbe || {};
  if (auto.status === 200) {
    if (auto.via === 'page') {
      lines.push('→ ✅ 扩展自身的 cookie 不够（① 被拒），但页面代发成功（② 正常）。这已经自动处理，直接扫描即可。');
    } else {
      lines.push('→ ✅ 扩展自身的 cookie 就够用，会话正常。直接扫描即可。');
    }
  } else if (direct.status !== 200 && !r.hasTab) {
    lines.push('→ ❗ 扩展自身请求被拒，且没找到钉钉文档标签页，无法代发。请先在浏览器里打开该文件夹页面。');
  } else {
    lines.push(`→ ❗ 两种方式都没成功（HTTP ${auto.status || '?'}）。这说明当前登录的账号对该节点没有访问权，或该链接不属于当前登录的文档空间。请确认页面里能正常看到文件列表。`);
  }
  els.diagText.textContent = lines.join('\n');
}

// ---------------------------------------------------------------- tree model

function eachNode(node, fn, parent) {
  fn(node, parent);
  for (const c of node.children || []) eachNode(c, fn, node);
}

// Selection works on whole subtrees: a checked folder means "everything under
// it", so downloading a folder that was never expanded still gets all of it —
// the background resolves each file's uuid on demand.
function selectedNodes(root) {
  const out = [];
  const walk = (node) => {
    for (const c of node.children || []) {
      if (c.checked === true) {
        out.push(c); // whole subtree goes
      } else if (c.checked === 'partial') {
        walk(c);
      }
    }
  };
  walk(root);
  return out;
}

// Returns null when the count is unknown because part of the subtree has not
// been fetched — the UI must not present a guessed number as fact.
function countFiles(node) {
  if (node.type !== 'folder') return 1;
  if (!node.loaded) return null;
  let total = 0;
  for (const c of node.children || []) {
    const n = countFiles(c);
    if (n === null) return null;
    total += n;
  }
  return total;
}

function countSelected(node) {
  if (node.type !== 'folder') return node.checked === true ? 1 : 0;
  if (node.checked === true) return countFiles(node);
  if (!node.loaded) return 0;
  let total = 0;
  for (const c of node.children || []) {
    const n = countSelected(c);
    if (n === null) return null;
    total += n;
  }
  return total;
}

// Sum of the sizes of everything currently selected; null if any selected
// subtree still has unloaded folders.
function selectedBytes(node) {
  const walk = (n) => {
    if (n.type !== 'folder') return n.checked === true || n.checked === 'partial' ? (n.size || 0) : 0;
    if (!n.checked) return 0;
    if (!n.loaded) return null;
    let total = 0;
    for (const c of n.children || []) {
      const v = walk(c);
      if (v === null) return null;
      total += v;
    }
    return total;
  };
  if (!tree) return 0;
  const root = tree.root;
  if (root.type !== 'folder') return root.checked === true ? (root.size || 0) : 0;
  let total = 0;
  for (const c of root.children || []) {
    const v = walk(c);
    if (v === null) return null;
    total += v;
  }
  return total;
}

function hasUnloadedChecked(node) {
  for (const c of node.children || []) {
    if (c.checked && c.type === 'folder' && !c.loaded) return true;
    if (c.checked && hasUnloadedChecked(c)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- rendering

let parentMap = new WeakMap();

function refreshParent(node, map) {
  const p = map.get(node);
  if (!p || p.type !== 'folder') return;
  const kids = p.children || [];
  if (!kids.length) { p.checked = false; return; }
  const all = kids.every((c) => c.checked === true);
  const none = kids.every((c) => !c.checked);
  p.checked = all ? true : (none ? false : 'partial');
  refreshParent(p, map);
}

function render() {
  if (!tree) return;
  const root = tree.root;
  reindex();
  parentMap = new WeakMap();
  eachNode(root, (n, p) => { if (p) parentMap.set(n, p); });

  els.tree.textContent = '';
  if (root.type !== 'folder') {
    // single-file link
    const wrap = document.createElement('div');
    wrap.className = 'node';
    wrap.dataset.uuid = root.uuid;
    wrap.dataset.name = root.name.toLowerCase();
    wrap.appendChild(rowEl(root, 0));
    els.tree.appendChild(wrap);
  } else if (!(root.children || []).length) {
    els.tree.innerHTML = '<div class="empty">这个文件夹是空的。</div>';
  } else {
    for (const child of root.children || []) {
      els.tree.appendChild(nodeEl(child, 0));
    }
  }
  updateStats();
  els.toolbar.hidden = false;
  els.statsBar.hidden = false;
  applyFilter();
}

// The twisty is the only thing that triggers a fetch: a folder's children are
// requested the first time it is expanded, never before.
function nodeEl(node, depth) {
  const wrap = document.createElement('div');
  wrap.className = 'node';
  wrap.dataset.uuid = node.uuid;
  wrap.dataset.name = node.name.toLowerCase();

  const row = rowEl(node, depth);
  wrap.appendChild(row);

  if (node.type !== 'folder') return wrap;

  const kids = document.createElement('div');
  kids.className = 'children';
  wrap.appendChild(kids);

  // Render whatever is already loaded — this is pure DOM work with no fetching,
  // so a full re-render stays cheap.
  const buildChildren = () => {
    kids.textContent = '';
    for (const c of node.children || []) {
      kids.appendChild(nodeEl(c, depth + 1));
    }
    if (node.loaded && !(node.children || []).length) {
      const empty = document.createElement('div');
      empty.className = 'children-empty';
      empty.textContent = '（空文件夹）';
      kids.appendChild(empty);
    }
  };
  buildChildren();

  // A folder the user has already expanded stays open across re-renders.
  kids.hidden = !node.expanded;

  const tw = row.querySelector('.twisty');
  const paint = () => {
    if (node.loading) { tw.textContent = '…'; tw.classList.remove('leaf'); return; }
    tw.textContent = kids.hidden ? '▶' : '▼';
    if (node.loaded) tw.classList.toggle('leaf', !(node.children || []).length);
    else tw.classList.toggle('leaf', node.hasChildren === false);
  };
  paint();

  tw.addEventListener('click', async () => {
    if (node.loading) return;
    if (!node.loaded) {
      node.loading = true;
      paint();
      try {
        const r = await send('listChildren', { uuid: node.uuid });
        if (!r.ok) throw new Error(r.error);
        node.children = r.children || [];
        node.loaded = true;
        if (tree && r.stats) tree.stats = r.stats;
        buildChildren();
        updateBadge(wrap, node);
        reindex();
        parentMap = new WeakMap();
        eachNode(tree.root, (n, p) => { if (p) parentMap.set(n, p); });
        // Expanding one folder can complete the size of every ancestor.
        refreshRenderedMeta();
      } catch (e) {
        say(`展开「${node.name}」失败：${e.message}`, 'bad');
        node.loading = false;
        paint();
        return;
      }
      node.loading = false;
      node.expanded = true;
    } else {
      node.expanded = !node.expanded;
    }
    kids.hidden = !node.expanded;
    paint();
    updateStats();
    applyFilter();
  });

  return wrap;
}

function updateBadge(wrap, node) {
  const b = wrap.querySelector(':scope > .node-row > .badge-count');
  if (b) {
    if (node.loaded) {
      b.textContent = `${(node.children || []).length}`;
      b.title = `${(node.children || []).length} 项`;
    } else {
      b.textContent = '·';
      b.title = '尚未展开';
    }
  }
  const sz = wrap.querySelector(':scope > .node-row > .folder-size');
  if (sz) {
    if (node.sizeBytes != null) {
      sz.textContent = S.humanSize(node.sizeBytes);
      sz.title = '整棵子树的总大小';
      sz.classList.remove('unknown');
    } else {
      sz.textContent = '大小未知';
      sz.title = '该文件夹尚未完全展开，大小无法得知。点「展开全部」可算出精确大小。';
      sz.classList.add('unknown');
    }
  }
}

function rowEl(node, depth) {
  const row = document.createElement('div');
  row.className = 'node-row';
  row.style.paddingLeft = `${8 + depth * 14}px`;

  const twisty = document.createElement('span');
  twisty.className = 'twisty';
  twisty.textContent = node.type === 'folder' ? '▶' : '•';
  if (node.type !== 'folder') twisty.classList.add('leaf');
  row.appendChild(twisty);

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = node.checked === true;
  cb.indeterminate = node.checked === 'partial';
  cb.addEventListener('change', () => {
    setSubtree(node, cb.checked);
    refreshParent(node, parentMap);
    rerenderCheckboxes();
    updateStats();
  });
  row.appendChild(cb);

  const name = document.createElement('span');
  name.className = 'node-name' + (node.type === 'folder' ? ' folder' : '')
    + (S.isOnlineDoc(node) ? ' online' : '');
  name.textContent = node.name;
  name.title = node.name;
  row.appendChild(name);

  if (node.type === 'folder') {
    const b = document.createElement('span');
    b.className = 'badge badge-count';
    // An unexpanded folder shows "·" rather than a misleading 0 — its contents
    // have not been read yet.
    b.textContent = node.loaded ? `${(node.children || []).length}` : '·';
    b.title = node.loaded ? `${(node.children || []).length} 项` : '尚未展开';
    row.appendChild(b);

    const sz = document.createElement('span');
    sz.className = 'meta folder-size';
    // A folder size is only knowable once everything under it has been read.
    sz.textContent = node.sizeBytes != null ? S.humanSize(node.sizeBytes) : '大小未知';
    sz.title = node.sizeBytes != null
      ? '整棵子树的总大小'
      : '该文件夹尚未完全展开，大小无法得知。点「展开全部」可算出精确大小。';
    if (node.sizeBytes == null) sz.classList.add('unknown');
    row.appendChild(sz);
  } else {
    if (S.isOnlineDoc(node)) {
      const b = document.createElement('span');
      b.className = 'badge online';
      b.textContent = '在线';
      b.title = '钉钉在线文档，没有公开导出接口，需要在钉钉里手动导出';
      row.appendChild(b);
    }
    if (node.size != null) {
      const m = document.createElement('span');
      m.className = 'meta';
      m.textContent = S.humanSize(node.size);
      row.appendChild(m);
    }
  }
  return row;
}

// A DOM element is bound to its tree node directly, by uuid. An earlier version
// looked nodes up by a rendered path string, which silently broke: the path was
// only appended for folders (files return before that point), so files and
// folders produced mismatched keys and the lookups quietly returned null —
// disabling checkbox refresh and size sync without any visible error.
function nodeOf(wrap) {
  const uuid = wrap.dataset.uuid;
  return uuid ? (nodesByUuid.get(uuid) || null) : null;
}

function rerenderCheckboxes() {
  els.tree.querySelectorAll('.node').forEach((wrap) => {
    const node = nodeOf(wrap);
    if (!node) return;
    const cb = wrap.querySelector(':scope > .node-row > input[type=checkbox]');
    if (!cb) return;
    cb.checked = node.checked === true;
    cb.indeterminate = node.checked === 'partial';
  });
}

// After a bulk operation the sizes of many folders change at once. Walk the
// rendered nodes and resync their badges/sizes, so the whole tree reflects the
// new state without rebuilding the DOM (which would collapse everything).
function refreshRenderedMeta() {
  els.tree.querySelectorAll('.node').forEach((wrap) => {
    const node = nodeOf(wrap);
    if (node) updateBadge(wrap, node);
  });
}

let nodesByUuid = new Map();
function reindex() {
  nodesByUuid = new Map();
  if (!tree) return;
  eachNode(tree.root, (n) => { nodesByUuid.set(n.uuid, n); });
}

function setSubtree(node, value) {
  node.checked = value;
  for (const c of node.children || []) setSubtree(c, value);
}

// ---------------------------------------------------------------- filtering

// The filter marks non-matching nodes with a class rather than the hidden
// attribute, so it cannot interfere with the collapse state — and a node inside
// a collapsed folder stays hidden regardless of whether it matches.
function applyFilter() {
  const q = els.filter.value.trim().toLowerCase();
  const wraps = [...els.tree.querySelectorAll('.node')];

  const inCollapsedBranch = (el) => {
    let p = el.parentElement;
    while (p && p !== els.tree) {
      if (p.classList.contains('children') && p.hidden) return true;
      p = p.parentElement;
    }
    return false;
  };

  if (!q) {
    for (const w of wraps) w.classList.remove('filtered');
    return;
  }
  for (const w of wraps) {
    const self = (w.dataset.name || '').includes(q);
    const desc = [...w.querySelectorAll('.node')].some((c) => (c.dataset.name || '').includes(q));
    w.classList.toggle('filtered', !(self || desc) || inCollapsedBranch(w));
  }
}

// The side panel holds its own copy of the tree, so sizes the background
// computed have to be merged back in — otherwise every folder keeps showing
// "大小未知" even after a full expansion.
function applySizes(map) {
  if (!map || !tree) return;
  let changed = 0;
  eachNode(tree.root, (n) => {
    if (n.type !== 'folder') return;
    const v = map[n.uuid];
    if (v != null && n.sizeBytes !== v) { n.sizeBytes = v; changed += 1; }
  });
  return changed;
}

// A checked folder that was never expanded has no children in this copy, so its
// file count and size are unknown and the download button stays disabled. Load
// those folders once the user stops clicking.
let settleTimer = null;
function scheduleSettleUnloaded() {
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(settleUnloaded, 250);
}

async function settleUnloaded() {
  settleTimer = null;
  if (!tree || scanning) return;
  const targets = [];
  const walk = (n) => {
    for (const c of n.children || []) {
      if (c.type !== 'folder') continue;
      if (c.checked && !c.loaded) targets.push(c);
      else walk(c);
    }
  };
  walk(tree.root);
  if (!targets.length) return;

  els.tree.classList.add('busy');
  try {
    // Expand only what was selected — no reason to fetch the rest of the tree.
    const r = await send('expandSelected', {
      uuids: targets.map((n) => n.uuid),
      maxRequests: 4000,
    });
    if (r.ok) {
      applyBackgroundResult(r);
      // Our node objects still lack children; re-read the authoritative tree.
      const fresh = await send('getTree');
      if (fresh.ok && fresh.tree) {
        tree = fresh.tree;
        render();
      }
      if (r.failures && r.failures.length) {
        say(`${r.failures.length} 个子文件夹读取失败，下载时会跳过它们。`, 'bad');
      }
    }
  } catch { /* leave the state as-is; download resolves folders anyway */ }
  finally {
    els.tree.classList.remove('busy');
    updateStats();
  }
}

// ---------------------------------------------------------------- stats

function updateStats() {
  if (!tree) return;
  const root = tree.root;
  const stats = tree.stats || { folders: 0, files: 0, bytes: 0, partial: true };

  let selFiles;
  if (root.type !== 'folder') {
    selFiles = root.checked === true ? 1 : 0;
  } else {
    selFiles = 0;
    for (const c of root.children || []) {
      const n = countSelected(c);
      if (n === null) { selFiles = null; break; }
      selFiles += n;
    }
  }

  // Numbers cover only what has been fetched; label them so they are not read
  // as totals for the whole folder.
  const suffix = stats.partial ? '（已展开部分）' : '';
  els.statFolders.textContent = `${stats.folders} 文件夹${suffix}`;
  els.statFiles.textContent = `${stats.files} 文件${suffix}`;
  els.statSize.textContent = stats.partial ? `${S.humanSize(stats.bytes) || '—'}${suffix}` : (S.humanSize(stats.bytes) || '—');
  els.statSel.textContent = selFiles === null
    ? '已选：含未展开文件夹'
    : `已选 ${selFiles} 个文件`;
  els.btnDownload.disabled = selFiles === 0 || downloading || scanning;

  // zip mode has to hold the whole archive in memory before saving
  if (els.optZip.checked) {
    const bytes = selectedBytes(root);
    if (bytes === null) {
      els.zipWarn.hidden = false;
      els.zipWarn.textContent = '选中的文件夹里还有未展开的部分，无法预估打包体积。请先「展开全部」或改用逐个下载。';
      els.btnDownload.disabled = true;
    } else {
      const warn = bytes > 1.8e9;
      els.zipWarn.hidden = !warn;
      if (warn) {
        els.zipWarn.textContent = `选中约 ${S.humanSize(bytes)}，超过 zip 打包的安全上限（约 1.8 GB）。请改用逐个下载。`;
        els.btnDownload.disabled = true;
      }
    }
  } else {
    els.zipWarn.hidden = true;
  }

  // Downloading a folder that was never expanded is fine — the background
  // resolves it — but the count and size are unknown until those folders are
  // loaded, so kick that off once the user stops clicking.
  if (root.type === 'folder' && hasUnloadedChecked(root)) {
    scheduleSettleUnloaded();
  }
}

// ---------------------------------------------------------------- actions

async function useCurrentTab() {
  // The side panel is its own document, so it has to ask Chrome which tab the
  // user is looking at.
  let url = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    url = tab ? tab.url : null;
  } catch (e) {
    say(`读取当前标签页地址失败：${(e && e.message) || e}`, 'bad');
    return null;
  }

  if (!url) {
    say('没能读到当前页面地址。可以直接把链接粘贴到上面的输入框。', 'bad');
    return null;
  }
  if (!/alidocs\.dingtalk\.com/.test(url)) {
    say(`当前页面不是钉钉文档页面（${url.slice(0, 60)}）。请在该页面打开本面板。`, 'bad');
    return null;
  }
  currentPageUrl = url;
  els.rootUrl.value = url;
  say('已填入当前页面地址。', 'ok');
  await checkSession({ quiet: true });
  return { url };
}

async function scan() {
  if (scanning) return;
  // Fill the link in automatically rather than making the user press a button
  // first; the panel already knows which tab is active.
  if (!els.rootUrl.value.trim()) {
    await useCurrentTab();
  }
  let url = els.rootUrl.value.trim();
  if (!url) {
    say('请先填入钉钉文档链接，或点「重新读取当前页面」。', 'bad');
    return;
  }
  const rootId = S.nodeIdFromUrl(url);
  if (!rootId) {
    say('链接里没找到 /i/nodes/<id>，请确认是钉钉文档的节点链接。', 'bad');
    return;
  }
  currentPageUrl = url;

  scanning = true;
  els.btnScan.disabled = true;
  els.btnScan.textContent = '扫描中…';
  els.progress.hidden = false;
  els.report.hidden = true;
  setProgress(0, '开始…');

  try {
    const r = await send('scan', { rootId, pageUrl: url });
    if (!r.ok) {
      // most common failure: the user pasted a link to a node that is not a
      // folder, or the session/spaceId could not be resolved
      say(`${r.error}${r.detail ? ' — ' + r.detail : ''}`, 'bad');
      return;
    }
    tree = r.tree;
    reindex();
    render();
    const note = r.cacheWarning ? '（结果未能缓存，重开侧边栏需重新扫描；本次下载不受影响）' : '';
    say(`已读取根目录 ${(tree.root.children || []).length} 项。点文件夹左边的小三角展开，才会去读取它的内容。${note}`, 'ok');
  } catch (e) {
    say('扫描失败：' + e.message, 'bad');
  } finally {
    scanning = false;
    els.btnScan.disabled = false;
    els.btnScan.textContent = '扫描目录树';
    els.progress.hidden = true;
    updateStats();
  }
}

function setProgress(ratio, text) {
  els.barFill.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
  els.progressText.textContent = text;
}

async function download() {
  if (!tree || downloading) return;
  const selection = selectedNodes(tree.root);
  if (!selection.length) {
    say('没有勾选任何文件。', 'bad');
    return;
  }
  const total = selection.reduce((a, n) => a + (n.type === 'folder' ? countFiles(n) : 1), 0);
  const zipMode = els.optZip.checked;
  downloading = true;
  els.btnDownload.disabled = true;
  els.btnDownload.textContent = zipMode ? '打包中…' : '下载中…';
  els.btnCancel.hidden = false;
  els.progress.hidden = false;
  els.report.hidden = true;
  setProgress(0, zipMode ? `准备打包 ${total} 个文件…` : `准备下载 ${total} 个文件…`);

  try {
    const r = await send('download', {
      selection: stripInternal(selection),
      options: {
        flatten: els.optFlatten.checked,
        mode: zipMode ? 'zip' : 'files',
        zipName: zipMode ? buildZipName() : undefined,
        dir: downloadDir,
      },
    });
    if (!r.ok) {
      say(r.error + (r.detail ? ' — ' + r.detail : ''), 'bad');
      return;
    }
    if (r.failures && r.failures.length) {
      showReport(r.failures);
    }
    setProgress(1, r.failures.length
      ? `完成：${r.ok} 个成功，${r.failures.length} 个需要手动处理。`
      : `全部完成：${r.ok} 个文件已下载到${r.dir ? `「${r.dir}」` : '默认下载目录'}。`);
  } catch (e) {
    say('下载失败：' + e.message, 'bad');
  } finally {
    downloading = false;
    els.btnCancel.hidden = true;
    els.btnDownload.textContent = '下载选中的文件';
    updateStats();
  }
}

function buildZipName() {
  const rootName = tree && tree.root ? S.safeName(tree.root.name) : '钉钉文档';
  return `${rootName}-${S.tsName()}.zip`;
}

// strip parent links / cached raw payloads before messaging
function stripInternal(nodes) {
  return nodes.map((n) => ({
    uuid: n.uuid,
    name: n.name,
    type: n.type,
    size: n.size,
    contentType: n.contentType,
    extension: n.extension,
    children: n.children ? stripInternal(n.children) : undefined,
  }));
}

function showReport(failures) {
  els.reportList.textContent = '';
  for (const f of failures) {
    const li = document.createElement('li');
    li.textContent = `${f.name} — ${f.reason}`;
    if (f.url) {
      const a = document.createElement('a');
      a.href = f.url;
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.textContent = ' 打开';
      li.appendChild(a);
    }
    els.reportList.appendChild(li);
  }
  els.report.hidden = false;
}

// ---------------------------------------------------------------- wiring

els.btnPing.addEventListener('click', () => checkSession());
els.btnDiag.addEventListener('click', runDiagnose);
els.btnCloseDiag.addEventListener('click', () => { els.diagBox.hidden = true; });
els.btnUseTab.addEventListener('click', useCurrentTab);
els.btnScan.addEventListener('click', scan);
els.btnDownload.addEventListener('click', download);
els.btnOpenDl.addEventListener('click', () => send('revealDownload'));
els.btnCloseReport.addEventListener('click', () => { els.report.hidden = true; });
els.filter.addEventListener('input', applyFilter);
els.optFlatten.addEventListener('change', () => {
  say(els.optFlatten.checked
    ? '已开启扁平化：所有文件会下载到同一个文件夹，重名自动加序号。'
    : '将保留子文件夹结构。');
  updateStats();
});
els.optZip.addEventListener('change', () => {
  say(els.optZip.checked
    ? '将把选中的文件打包成一个 zip。文件会先读进内存再压缩，所以大文件夹请改用逐个下载。'
    : '将逐个下载文件，并保留子文件夹结构。');
  updateStats();
});

// Selecting a folder means "everything under it", so 全选 does not need the
// whole tree loaded — but the counts and the zip size estimate do, so offer to
// fetch it on demand rather than doing it behind the user's back.
els.btnAll.addEventListener('click', async () => {
  if (!tree) return;
  for (const c of tree.root.children || []) setSubtree(c, true);
  rerenderCheckboxes();
  updateStats();
  if (tree.root.type === 'folder' && hasUnloadedChecked(tree.root)) {
    await expandAll();
  }
});
els.btnNone.addEventListener('click', () => {
  if (!tree) return;
  for (const c of tree.root.children || []) setSubtree(c, false);
  rerenderCheckboxes(); updateStats();
});
els.btnInvert.addEventListener('click', () => {
  if (!tree) return;
  const invert = (n) => {
    if (n.type !== 'folder') { n.checked = n.checked !== true; return; }
    for (const c of n.children || []) invert(c);
    const kids = n.children || [];
    const all = kids.length > 0 && kids.every((c) => c.checked === true);
    const none = kids.every((c) => !c.checked);
    n.checked = all ? true : (none ? false : 'partial');
  };
  for (const c of tree.root.children || []) invert(c);
  rerenderCheckboxes(); updateStats();
});

els.btnExpandAll.addEventListener('click', expandAll);

// ---------------------------------------------------------------- download dir

function paintDownloadDir() {
  els.downloadDir.value = downloadDir;
}

let dirSaveTimer = null;
els.downloadDir.addEventListener('input', () => {
  downloadDir = els.downloadDir.value.trim();
  if (dirSaveTimer) clearTimeout(dirSaveTimer);
  dirSaveTimer = setTimeout(async () => {
    const r = await send('setDownloadDir', { dir: downloadDir });
    if (r.ok) {
      downloadDir = r.dir;
      paintDownloadDir();
      say(downloadDir
        ? `文件会下到「下载目录/${downloadDir}」。`
        : '文件会直接下到浏览器的默认下载目录。');
    }
  }, 400);
});

els.btnPickDir.addEventListener('click', async () => {
  const r = await send('openDownloadSettings');
  if (r.ok) {
    say('已打开 Chrome 的下载设置。改完「位置」后，上面填的子文件夹会建在那个目录下。');
  } else {
    say('无法自动打开设置，请手动访问 chrome://settings/downloads 修改下载位置。', 'bad');
  }
});

// Merge a background response that carries stats + sizes back into the UI's
// tree. Both "展开全部" and the implicit settle-after-ticking must go through
// this: expandAll originally refreshed only `stats`, so every folder kept
// showing "大小未知" even though the background had computed the sizes.
function applyBackgroundResult(r) {
  if (!r || !r.ok || !tree) return 0;
  if (r.stats) tree.stats = r.stats;
  const changed = applySizes(r.sizes) || 0;
  if (changed) {
    // Cheap path: the nodes already have their children, only the size labels
    // changed, so resync the labels without rebuilding (which would collapse
    // everything the user had opened).
    refreshRenderedMeta();
  }
  return changed;
}

async function expandAll() {
  if (!tree || scanning) return;
  if (tree.root.type !== 'folder') return;
  scanning = true;
  els.btnExpandAll.disabled = true;
  els.btnScan.disabled = true;
  els.progress.hidden = false;
  setProgress(0.05, '展开全部文件夹…');
  try {
    const r = await send('loadAll', { maxRequests: 4000 });
    if (!r.ok) {
      say('展开失败：' + r.error, 'bad');
      return;
    }
    const sized = applyBackgroundResult(r);
    // Newly fetched children only exist in the background's copy, so pull it.
    if (r.expanded > 0) {
      const fresh = await send('getTree');
      if (fresh.ok && fresh.tree) tree = fresh.tree;
    }
    render();
    const parts = [`已展开 ${r.expanded} 个文件夹`];
    if (r.truncated) parts.push(`还剩 ${r.remaining} 个未展开，可再次点击继续`);
    if (r.failures && r.failures.length) parts.push(`${r.failures.length} 个读取失败`);
    parts.push(`共 ${r.stats.folders} 个文件夹 / ${r.stats.files} 个文件`);
    if (sized) parts.push(`已算出 ${sized} 个文件夹的大小`);
    say(parts.join('，'), r.failures && r.failures.length ? 'bad' : 'ok');
    if (r.failures && r.failures.length) showReport(r.failures);
    setProgress(1, '展开完成');
  } catch (e) {
    say('展开失败：' + e.message, 'bad');
  } finally {
    scanning = false;
    els.btnExpandAll.disabled = false;
    els.btnScan.disabled = false;
    els.progress.hidden = true;
    updateStats();
  }
}

els.btnCancel.addEventListener('click', () => send('cancel'));

// Progress notifications arrive over chrome.runtime.
function onProgress(msg) {
  if (!msg || msg.type !== 'progress') return;
  if (msg.phase === 'scan') {
    // Bulk expand reports a running count with no known total; the initial scan
    // reports a short status line.
    if (msg.total) setProgress((msg.done || 0) / msg.total, msg.message);
    else setProgress(0.4, msg.message);
  } else if (msg.phase === 'download') {
    const ratio = msg.total ? (msg.done || 0) / msg.total : 0;
    setProgress(ratio, msg.message);
  }
}
chrome.runtime.onMessage.addListener(onProgress);

// ---------------------------------------------------------------- boot

(async function boot() {
  // Load the saved download directory.
  try {
    const d = await send('getDownloadDir');
    if (d.ok) { downloadDir = d.dir || ''; paintDownloadDir(); }
  } catch { /* ignore */ }

  // Resolve the page URL first: the background needs it to find path-scoped
  // session cookies, and filling it in here means 「扫描目录树」 works immediately
  // without the user having to press anything first.
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab ? tab.url : null;
    if (url && /alidocs\.dingtalk\.com\//.test(url)) {
      currentPageUrl = url;
      els.rootUrl.value = url;
    }
  } catch (e) {
    // Not fatal — the user can paste the link instead.
    say(`自动读取当前页面地址失败：${(e && e.message) || e}。可手动粘贴链接。`, 'bad');
  }

  await checkSession({ quiet: true });

  const stored = await send('getTree');
  if (stored && stored.ok && stored.tree) {
    tree = stored.tree;
    if (!els.rootUrl.value) els.rootUrl.value = tree.pageUrl || '';
    if (!currentPageUrl) currentPageUrl = tree.pageUrl || null;
    reindex();
    render();
    say(`载入了上次的扫描结果（${new Date(tree.scannedAt).toLocaleString()}）。`, 'ok');
  }
})();
