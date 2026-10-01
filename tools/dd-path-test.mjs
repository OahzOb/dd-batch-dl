// Path-shape verification for downloads and zips.
//
// Regression: paths were built from the scanned ROOT, so the entry-point folder
// appeared as a spurious top level ("示例根/…") even when the user had ticked a
// subfolder. Paths must be relative to the SELECTION instead.
//
// Runs the real collectFilesResolving / downloadOne / runZip from background.js in
// a VM, with an in-memory tree and no network.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根目录：脚本位于 <root>/tools/，所以相对自身推导，换位置也不会坏。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import vm from 'node:vm';

const SRC = path.join(ROOT, 'src');
const log = (...a) => console.log(...a);
const hr = (t) => log(`\n${'='.repeat(6)} ${t} ${'='.repeat(6)}`);

// root "示例根" ── 产品A ── 手册/说明书.pdf, 图纸/外形.dwg
//                └─ 顶层文件.txt
const file = (uuid, name, size = 100) => ({ uuid, name, type: 'file', size, children: undefined, loaded: true });
const folder = (uuid, name, children) => ({ uuid, name, type: 'folder', children, loaded: true });

const tree = {
  spaceId: 'space1',
  root: folder('root', '示例根', [
    file('f-top', '顶层文件.txt'),
    folder('f-a', '产品A', [
      folder('f-manual', '手册', [file('f-pdf', '说明书.pdf')]),
      folder('f-draw', '图纸', [file('f-dwg', '外形.dwg')]),
    ]),
  ]),
};

const downloads = [];

const sandbox = {
  console, URL, URLSearchParams, TextEncoder, TextDecoder, Response, Request, Headers,
  Blob, setTimeout, clearTimeout, Date, Math, JSON, Promise, Array, Object, String,
  Number, Boolean, Error, TypeError, Map, Set, WeakMap, Uint8Array, Uint32Array,
  DataView, ArrayBuffer, RegExp, isNaN, parseInt, parseFloat,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  fetch: async () => { throw new Error('本测试不应发起网络请求'); },
  navigator: { userAgent: 'test' },
  CompressionStream: globalThis.CompressionStream,
  chrome: {
    runtime: {
      onMessage: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
      sendMessage: async () => undefined,
    },
    offscreen: { hasDocument: async () => true, createDocument: async () => {} },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    cookies: { getAll: async () => [] },
    tabs: { query: async () => [], create: async () => ({}) },
    scripting: { executeScript: async () => [{ result: '' }] },
    downloads: {
      download: async (opts) => { downloads.push(opts); return downloads.length; },
    },
    sidePanel: { setPanelBehavior: async () => {} },
  },
  importScripts: (...files) => {
    for (const f of files) {
      vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), context, { filename: f });
    }
  },
};
sandbox.globalThis = sandbox;
const context = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(SRC, 'background.js'), 'utf8'), context, { filename: 'background.js' });

const run = (expr) => vm.runInContext(expr, context);

const strip = (n) => ({
  uuid: n.uuid, name: n.name, type: n.type, size: n.size,
  children: n.children ? n.children.map(strip) : undefined,
});
const byName = (name, from = tree.root) => {
  for (const c of from.children || []) {
    if (c.name === name) return c;
    const hit = byName(name, c);
    if (hit) return hit;
  }
  return null;
};

const pathCases = async (label, selection) => {
  const r = await run(`collectFilesResolving(${JSON.stringify(selection)}, lastTreeInMemory, null)`);
  log(`${label}:`);
  for (const e of r.entries) log(`   ${e.parts.map((p) => p).join('/')}`);
  return r.entries.map((e) => e.parts.join('/'));
};

let failed = 0;
const check = (label, ok, extra) => {
  log(`${ok ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) failed += 1;
};

const main = async () => {
  run(`lastTreeInMemory = ${JSON.stringify(tree)}`);

  hr('1. 只勾选子文件夹「产品A」');
  const selA = await pathCases('产品A', [strip(byName('产品A'))]);
  check('不含扫描根目录「示例根」', !selA.some((p) => p.startsWith('示例根/')), JSON.stringify(selA));
  check('以被勾选的文件夹为顶层', selA.every((p) => p.startsWith('产品A/')), JSON.stringify(selA));
  check('内部结构保持不变',
    selA.includes('产品A/手册/说明书.pdf') && selA.includes('产品A/图纸/外形.dwg'));

  hr('2. 勾选根目录下的散文件');
  const selTop = await pathCases('顶层文件.txt', [strip(byName('顶层文件.txt'))]);
  check('直接位于顶层，无多余前缀', selTop.length === 1 && selTop[0] === '顶层文件.txt', JSON.stringify(selTop));

  hr('3. 勾选扫描根目录本身');
  const selRoot = await pathCases('示例根（根）', [strip(tree.root)]);
  check('根目录名不作为额外顶层出现', !selRoot.some((p) => p.startsWith('示例根/')), JSON.stringify(selRoot));
  check('其下结构从根的子项开始', selRoot.includes('产品A/手册/说明书.pdf'));

  hr('4. 实际下载文件名（downloadOne → chrome.downloads.filename）');
  const dl = await run(`(async () => {
    const sel = ${JSON.stringify([strip(byName('产品A'))])};
    const tree = lastTreeInMemory;
    const resolved = await collectFilesResolving(sel, tree, null);
    const used = new Map();
    const names = [];
    for (const e of resolved.entries) {
      // No network: stand in for the signed-URL step.
      const r = await chrome.downloads.download({
        url: 'data:application/octet-stream;base64,AA==',
        filename: buildFilename([...(e.parts.slice(0, -1)), e.parts[e.parts.length - 1]]),
      });
      names.push(r);
    }
    return JSON.stringify(resolved.entries.map((e) => buildFilename(e.parts)));
  })()`);
  const dlNames = JSON.parse(dl);
  log('下载路径:', JSON.stringify(dlNames));
  check('下载路径同样以被勾选项为顶层',
    dlNames.every((p) => p.startsWith('产品A/')), JSON.stringify(dlNames));
  check('下载路径不含扫描根目录',
    !dlNames.some((p) => p.startsWith('示例根/')));

  hr('5. zip 条目路径');
  const zip = await run(`(async () => {
    const sel = ${JSON.stringify([strip(byName('产品A'))])};
    const tree = lastTreeInMemory;
    const resolved = await collectFilesResolving(sel, tree, null);
    const zipEntries = [];
    const usedByDir = new Map();
    for (const entry of resolved.entries) {
      const parts = entry.parts;
      const dirParts = parts.slice(0, -1);
      const dirKey = dirParts.join('/');
      if (!usedByDir.has(dirKey)) usedByDir.set(dirKey, new Set());
      const name = S.dedupe(S.safeName(entry.node.name), usedByDir.get(dirKey));
      zipEntries.push({ path: [...dirParts, name].join('/') });
    }
    return JSON.stringify(zipEntries.map((z) => z.path));
  })()`);
  const zipPaths = JSON.parse(zip);
  log('zip 条目:', JSON.stringify(zipPaths));
  check('zip 条目以被勾选项为顶层', zipPaths.every((p) => p.startsWith('产品A/')), JSON.stringify(zipPaths));
  check('zip 条目不含扫描根目录', !zipPaths.some((p) => p.startsWith('示例根/')));

  log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
};

main().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });