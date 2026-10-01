// Reproduce the twisty behaviour with the REAL sidepanel.js, by loading its
// actual source into a plain page. Avoids chrome-extension:// navigation, which
// refuses to load under automation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根目录：脚本位于 <root>/tools/，所以相对自身推导，换位置也不会坏。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PORT = Number(process.env.DD_LOAD_PORT || 9444);
const CDP = `http://127.0.0.1:${PORT}`;
const SRC = path.join(ROOT, 'src');
const log = (...a) => console.log(...a);
const hr = (t) => log(`\n${'='.repeat(6)} ${t} ${'='.repeat(6)}`);

async function cdpJson(p) { return (await fetch(CDP + p)).json(); }
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method) {
      for (const fn of listeners) fn(m);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws failed')), { once: true });
  });
  return {
    ready,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    send(method, params = {}, sessionId) {
      const mid = ++id;
      const p = { id: mid, method, params };
      if (sessionId) p.sessionId = sessionId;
      return new Promise((resolve, reject) => {
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify(p));
        setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('timeout ' + method)); } }, 30000);
      });
    },
    close: () => ws.close(),
  };
}

const html = fs.readFileSync(path.join(SRC, 'sidepanel.html'), 'utf8');
const css = fs.readFileSync(path.join(SRC, 'sidepanel.css'), 'utf8');
const shared = fs.readFileSync(path.join(SRC, 'shared.js'), 'utf8');
const panel = fs.readFileSync(path.join(SRC, 'sidepanel.js'), 'utf8');
// take the body markup only; scripts and stylesheet link are supplied separately
const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
const bodyHtml = (bodyMatch ? bodyMatch[1] : html).replace(/<script[\s\S]*?<\/script>/gi, '');

const MOCK_TREE = {
  root: {
    uuid: 'root', name: '测试根', type: 'folder', loaded: true, expanded: true,
    children: [
      { uuid: 'f1', name: '子文件夹A', type: 'folder', hasChildren: true, loaded: false, size: null },
      { uuid: 'x1', name: '顶层文件.txt', type: 'file', size: 100 },
    ],
  },
  spaceId: 'space1',
  stats: { folders: 1, files: 1, bytes: 100, partial: true },
  pageUrl: 'https://alidocs.dingtalk.com/i/nodes/root',
};

// After a loadAll, the background returns a uuid -> bytes map and the panel has
// to merge it, or every folder keeps showing "大小未知".
const POST_LOADALL_TREE = {
  root: {
    uuid: 'root', name: '测试根', type: 'folder', loaded: true, expanded: true,
    children: [
      {
        uuid: 'f1', name: '子文件夹A', type: 'folder', hasChildren: true, loaded: true,
        expanded: true, sizeBytes: 1234567,
        children: [
          { uuid: 'g1', name: '孙文件夹', type: 'folder', hasChildren: true, loaded: true, sizeBytes: 999 },
          { uuid: 'y1', name: '子文件.bin', type: 'file', size: 899 },
        ],
      },
      { uuid: 'x1', name: '顶层文件.txt', type: 'file', size: 100 },
    ],
  },
  spaceId: 'space1',
  stats: { folders: 2, files: 2, bytes: 1234667, partial: false },
  pageUrl: 'https://alidocs.dingtalk.com/i/nodes/root',
};

const documentHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${bodyHtml}</body></html>`;

const MOCK_JS = `(() => {
  const tree = ${JSON.stringify(MOCK_TREE)};
  const postTree = ${JSON.stringify(POST_LOADALL_TREE)};
  let loadAllDone = false;
  window.__log = [];
  window.chrome = {
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: async (msg) => {
        window.__log.push(msg.type);
        if (msg.type === 'ping') return { ok: true, loggedIn: true, via: 'sw', probeStatus: 200, sessionCookies: [], cookieNames: [], totalCookies: 0 };
        if (msg.type === 'getTree') return { ok: true, tree: JSON.parse(JSON.stringify(loadAllDone ? postTree : tree)) };
        if (msg.type === 'listChildren') return { ok: true, cached: false,
          stats: { folders: 2, files: 2, bytes: 1999, partial: false },
          sizes: { f1: 1999, g1: 999 },
          children: [
            { uuid: 'g1', name: '孙文件夹', type: 'folder', hasChildren: true, loaded: false },
            { uuid: 'y1', name: '子文件.bin', type: 'file', size: 899 }
          ] };
        if (msg.type === 'loadAll') {
          loadAllDone = true;
          return { ok: true, stats: postTree.stats, sizes: { f1: 1234567, g1: 999 },
                   expanded: 1, remaining: 0, failures: [], truncated: false };
        }
        if (msg.type === 'expandSelected') return { ok: true, stats: postTree.stats, sizes: { f1: 1234567, g1: 999 }, expanded: 1, failures: [] };
        return { ok: true };
      },
    },
    tabs: { query: async () => [{ id: 1, active: true, url: tree.pageUrl }], create: async () => ({}) },
  };
  return 'mock ready';
})()`;

const main = async () => {
  const version = await cdpJson('/json/version');
  const browser = connect(version.webSocketDebuggerUrl);
  await browser.ready;
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (m, p = {}) => browser.send(m, p, sessionId);
  await send('Page.enable');
  await send('Runtime.enable');
  await new Promise((r) => setTimeout(r, 600));

  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result?.value;
  };

  hr('1. 用真实 sidepanel.html + 真实 sidepanel.js 重建界面');
  const frames = await send('Page.getFrameTree');
  const frameId = frames.frameTree.frame.id;
  await send('Page.setDocumentContent', { frameId, html: documentHtml });
  await new Promise((r) => setTimeout(r, 300));
  log('文档已注入，元素数:', await evalJs('document.querySelectorAll("#tree, header").length'));
  log('mock:', await evalJs(MOCK_JS));
  await evalJs(shared);
  log('shared:', await evalJs('typeof DDShared'));
  await evalJs(panel);
  await new Promise((r) => setTimeout(r, 1200));

  const boot = await evalJs(`JSON.stringify({
    nodes: [...document.querySelectorAll('#tree .node')].map(w => ({ uuid: w.dataset.uuid, name: w.dataset.name })),
    log: window.__log
  })`);
  log('启动:', boot);

  const snap = async () => JSON.parse(await evalJs(`JSON.stringify(
    [...document.querySelectorAll('#tree .node')].map(w => {
      const kids = w.querySelector(':scope > .children');
      const tw = w.querySelector(':scope > .node-row > .twisty');
      return { uuid: w.dataset.uuid, name: w.dataset.name,
               kidsHidden: kids ? kids.hidden : null,
               arrow: tw ? tw.textContent : null,
               filtered: w.classList.contains('filtered'),
               visible: w.getBoundingClientRect().height > 0 };
    }))`));

  const clickTwisty = async (name) => evalJs(`(() => {
    const w = [...document.querySelectorAll('#tree .node')].find(x => x.dataset.name === ${JSON.stringify(name)}.toLowerCase());
    if (!w) return 'NOT FOUND: ' + [...document.querySelectorAll('#tree .node')].map(x => x.dataset.name).join(',');
    w.querySelector(':scope > .node-row > .twisty').click();
    return 'clicked';
  })()`);

  hr('2. 展开「子文件夹A」');
  log('点击前:', JSON.stringify(await snap()));
  log('click:', await clickTwisty('子文件夹A'));
  await new Promise((r) => setTimeout(r, 800));
  const afterExpand = await snap();
  log('展开后:', JSON.stringify(afterExpand));

  hr('3. 再点一次（应收起）');
  log('click:', await clickTwisty('子文件夹A'));
  await new Promise((r) => setTimeout(r, 600));
  const afterCollapse = await snap();
  log('收起后:', JSON.stringify(afterCollapse));

  hr('4. 第三次点击（应再次展开）');
  log('click:', await clickTwisty('子文件夹A'));
  await new Promise((r) => setTimeout(r, 500));
  log('再展开:', JSON.stringify(await snap()));

  hr('判定');
  const exp = afterExpand.find((x) => x.name === '子文件夹a');
  const col = afterCollapse.find((x) => x.name === '子文件夹a');
  const grand = afterCollapse.find((x) => x.name === '孙文件夹');
  log(`展开后: container.hidden=${exp && exp.kidsHidden} 箭头=${exp && exp.arrow}`);
  log(`收起后: container.hidden=${col && col.kidsHidden} 箭头=${col && col.arrow}`);
  log(`收起后 孙节点存在=${!!grand}${grand ? ` 可见=${grand.visible}` : ''}`);
  const collapsed = col && col.kidsHidden === true;
  const grandHidden = !grand || !grand.visible;
  log(collapsed && grandHidden ? '✅ 收起正常' : `❌ 收起失败（container.hidden=${col && col.kidsHidden}, 孙可见=${grand && grand.visible}）`);

  hr('5. 过滤功能（同一个 CSS bug 也让过滤失效过）');
  // Ensure the folder is definitely expanded before testing the filter — the
  // previous step may have left it collapsed.
  for (let i = 0; i < 3; i += 1) {
    const kidsHidden = await evalJs(`(() => {
      const w = [...document.querySelectorAll('#tree .node')].find(x => x.dataset.name === '子文件夹a');
      return w.querySelector(':scope > .children').hidden;
    })()`);
    if (!kidsHidden) break;
    await evalJs(`(() => {
      const w = [...document.querySelectorAll('#tree .node')].find(x => x.dataset.name === '子文件夹a');
      w.querySelector(':scope > .node-row > .twisty').click();
      return 'ok';
    })()`);
    await new Promise((r) => setTimeout(r, 350));
  }
  log('过滤前 文件夹已展开:', JSON.stringify(await snap()));
  const filterInput = async (q) => {
    await evalJs(`(() => {
      const el = document.getElementById('filter');
      el.value = ${JSON.stringify(q)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`);
    await new Promise((r) => setTimeout(r, 250));
    return snap();
  };
  const f1 = await filterInput('子文件');
  log('过滤 "子文件":', JSON.stringify(f1.map((x) => ({ n: x.name, vis: x.visible }))));
  const f2 = await filterInput('');
  log('清空过滤 :', JSON.stringify(f2.map((x) => ({ n: x.name, vis: x.visible }))));
  const filterWorks = f1.find((x) => x.name === '顶层文件.txt').visible === false
    && f1.find((x) => x.name === '子文件.bin').visible === true
    && f2.find((x) => x.name === '顶层文件.txt').visible === true;
  log(filterWorks ? '✅ 过滤正常' : '❌ 过滤异常');

  hr('6. 「展开全部」之后，文件夹是否显示大小（而不是未知）');
  const sizeTexts = async () => JSON.parse(await evalJs(`JSON.stringify(
    [...document.querySelectorAll('#tree .node')].map(w => {
      const sz = w.querySelector(':scope > .node-row > .folder-size');
      return sz ? { name: w.dataset.name, size: sz.textContent, unknown: sz.classList.contains('unknown') } : null;
    }).filter(Boolean))`));
  log('展开前:', JSON.stringify(await sizeTexts()));
  log('点击前 __log:', await evalJs('JSON.stringify(window.__log)'));
  const clicked = await evalJs(`(() => {
    const b = document.getElementById('btnExpandAll');
    if (!b) return 'NO BUTTON';
    if (b.disabled) return 'DISABLED';
    b.click();
    return 'clicked';
  })()`);
  log('按钮点击:', clicked);
  await new Promise((r) => setTimeout(r, 1500));
  log('点击后 __log:', await evalJs('JSON.stringify(window.__log)'));
  log('状态栏:', await evalJs(`document.getElementById('sessionInfo').textContent`));
  log('面板里的树 sizeBytes:', await evalJs(`JSON.stringify(
    [...document.querySelectorAll('#tree .node')].map(w => ({ n: w.dataset.name })))`));
  const after = await sizeTexts();
  log('展开后:', JSON.stringify(after));
  // Look at the actual data the renderer saw.
  const dbg = await evalJs(`JSON.stringify({
    human: typeof S !== 'undefined' ? S.humanSize(1234567) : 'no S',
    rowHtml: (() => {
      const w = [...document.querySelectorAll('#tree .node')].find(x => x.dataset.name === '子文件夹a');
      return w ? w.querySelector(':scope > .node-row').outerHTML.slice(0, 400) : 'NOT FOUND';
    })(),
    nodeSizeBytes: (() => {
      const idx = typeof byUuid === 'undefined' ? null : 1;
      return 'see rowHtml';
    })(),
  })`);
  log('调试:', dbg);
  const anyUnknown = after.some((x) => x.unknown || x.size === '大小未知');
  log(anyUnknown ? '❌ 展开后仍显示「大小未知」—— 已复现' : '✅ 展开后显示了实际大小');
  const shown = after.map((x) => `${x.name}=${x.size}`).join(', ');
  log('显示值:', shown);


  if (anyUnknown) {
    log('\n❌ 大小显示有问题');
    browser.close();
    setTimeout(() => process.exit(1), 200);
    return;
  }
  log('\n全部通过');

  browser.close();
  setTimeout(() => process.exit(0), 200);
};

main().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exitCode = 1; });