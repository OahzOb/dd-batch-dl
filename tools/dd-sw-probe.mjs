// Verify the offscreen blob-download mechanism INSIDE the real extension service
// worker: build a zip, hand it to downloadBlob(), then confirm Chrome actually
// wrote the bytes to disk. This is the path that URL.createObjectURL broke.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根目录：脚本位于 <root>/tools/，所以相对自身推导，换位置也不会坏。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PORT = Number(process.env.DD_LOAD_PORT || 9444);
const CDP = `http://127.0.0.1:${PORT}`;
const EXT = ROOT;
const DOWNLOADS = path.join(ROOT, 'tmp', 'sw-out');
const log = (...a) => console.log(...a);
const hr = (t) => log(`\n${'='.repeat(6)} ${t} ${'='.repeat(6)}`);

async function cdpJson(p) { return (await fetch(CDP + p)).json(); }

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
        setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('timeout ' + method)); } }, 120000);
      });
    },
    close: () => ws.close(),
  };
}

async function findWorker(browser, extId) {
  for (let i = 0; i < 15; i += 1) {
    const list = await cdpJson('/json/list');
    const sw = list.find((t) => t.type === 'service_worker' && t.url.includes(extId));
    if (sw) return sw;
    await new Promise((r) => setTimeout(r, 700));
  }
  return null;
}

const main = async () => {
  fs.rmSync(DOWNLOADS, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOADS, { recursive: true });

  const version = await cdpJson('/json/version');
  const browser = connect(version.webSocketDebuggerUrl);
  await browser.ready;

  const loaded = await browser.send('Extensions.loadUnpacked', { path: EXT });
  log('extension id:', loaded.id);

  let sw = await findWorker(browser, loaded.id);
  if (!sw) throw new Error('找不到 service worker target');
  log('service worker:', sw.url);

  const { sessionId } = await browser.send('Target.attachToTarget', { targetId: sw.id, flatten: true });
  const send = (m, p = {}) => browser.send(m, p, sessionId);
  await send('Runtime.enable');

  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      return { __error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    }
    return r.result?.value;
  };

  hr('1. 在真实 Service Worker 里确认 createObjectURL 缺失');
  log(await evalJs(`JSON.stringify({ createObjectURL: typeof URL.createObjectURL, offscreen: typeof chrome.offscreen })`));

  hr('2. 直接验离屏文档能不能造 blob: URL');
  const offscreen = await evalJs(`(async () => {
    try {
      await ensureOffscreen();
      const has = chrome.offscreen.hasDocument ? await chrome.offscreen.hasDocument() : 'n/a';
      const res = await chrome.runtime.sendMessage({
        target: 'offscreen', type: 'make-blob-url',
        base64: btoa('hello-offscreen'), mime: 'text/plain',
      });
      return JSON.stringify({ hasDocument: has, res });
    } catch (e) { return 'THROWS: ' + (e && e.message); }
  })()`);
  log('离屏文档:', offscreen);

  hr('2b. 大载荷：旧实现（单条消息）vs 新实现（分块）');
  // Previously the whole base64 went in one runtime.sendMessage, which Chrome
  // caps at 64 MiB — so any real archive arrived truncated. Now it is chunked.
  for (const mb of [8, 64, 100]) {
    const r = await evalJs(`(async () => {
      try {
        const size = ${mb} * 1024 * 1024;
        const bytes = new Uint8Array(size);
        for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + 7) & 0xff;
        const blob = new Blob([bytes], { type: 'application/octet-stream' });
        const url = await makeBlobUrl(blob);
        // Confirm the offscreen blob really holds every byte.
        const back = await fetch(url);
        const buf = new Uint8Array(await back.arrayBuffer());
        let firstDiff = -1;
        for (let i = 0; i < size; i += 1) { if (buf[i] !== bytes[i]) { firstDiff = i; break; } }
        return JSON.stringify({ mb: ${mb}, sent: size, got: buf.length,
          identical: firstDiff === -1, firstDiff, url: String(url).slice(0, 46) });
      } catch (e) { return JSON.stringify({ mb: ${mb}, THROWS: String(e && e.message) }); }
    })()`);
    log(r);
  }

  hr('2c. 直接确认单条消息的上限（对照）');
  const single = await evalJs(`(async () => {
    try {
      const bytes = new Uint8Array(64 * 1024 * 1024);
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'blob-chunk', id: 'x', base64: bytesToBase64(bytes) });
      return 'unexpectedly succeeded';
    } catch (e) { return 'THROWS: ' + String(e && e.message); }
  })()`);
  log(single);

  hr('3. 造一个 zip Blob 并交给真实的 downloadBlob()');
  // No closures across evaluates: build, download and report in one go.
  const dl = await evalJs(`(async () => {
    try {
      const enc = new TextEncoder();
      const entries = [
        { path: 'a/报告.txt', blob: new Blob([enc.encode('这是第一个文件的内容 hello zip')]) },
        { path: 'b/二进制.bin', blob: new Blob([new Uint8Array([1,2,3,4,5,0,255,254])]) },
      ];
      const zipBlob = await DDZip.buildZip(entries, { compress: true });
      const r = await downloadBlob(zipBlob, 'dd-sw-probe.zip');
      return JSON.stringify({ zipSize: zipBlob.size, result: r });
    } catch (e) { return 'THROWS: ' + (e && e.stack || e && e.message); }
  })()`);
  log('downloadBlob:', dl);

  hr('4. 等待落盘并检查字节');
  // Poll rather than guess: a real write can take longer than a fixed sleep.
  const osDownloads = path.join(process.env.USERPROFILE || '', 'Downloads');
  const findZip = () => {
    const candidates = [];
    for (const dir of [DOWNLOADS, osDownloads]) {
      try {
        for (const f of fs.readdirSync(dir)) {
          if (/^dd-sw-probe.*\.zip$/i.test(f) && !f.endsWith('.crdownload')) {
            candidates.push(path.join(dir, f));
          }
        }
      } catch { /* dir missing */ }
    }
    return candidates;
  };
  let found = [];
  for (let i = 0; i < 20 && !found.length; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    found = findZip();
  }
  log('找到的探测文件:', found.length ? found.join(', ') : '(无)');
  if (!found.length) {
    log('❌ 没有 zip 落盘');
    const errs = await evalJs(`(async () => {
      const list = await chrome.downloads.search({ limit: 5, orderBy: ['-startTime'] });
      return JSON.stringify(list.map(d => ({ f: d.filename, state: d.state, err: d.error, bytes: d.bytesReceived, total: d.totalBytes })));
    })()`);
    log('chrome.downloads 最近记录:', errs);
  } else {
    const src = found[0];
    const p = path.join(DOWNLOADS, path.basename(src));
    fs.copyFileSync(src, p);
    const buf = fs.readFileSync(p);
    log(`文件: ${path.basename(src)}  字节: ${buf.length}`);
    const sig = buf.subarray(0, 4).toString('hex');
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    log('签名:', sig, sig === '504b0304' ? '✅' : '❌', '| EOCD:', eocd, eocd > 0 ? '✅' : '❌');
    if (eocd > 0) log('zip 条目数:', buf.readUInt16LE(eocd + 10));
    try {
      const { execFileSync } = await import('node:child_process');
      const outDir = path.join(DOWNLOADS, 'unzipped');
      fs.mkdirSync(outDir, { recursive: true });
      const res = execFileSync('powershell.exe', ['-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${p}' -DestinationPath '${outDir}' -Force; Get-ChildItem -Recurse -File '${outDir}' | ForEach-Object { $_.FullName + '  ' + $_.Length }`],
      { encoding: 'utf8' });
      log('解压结果:\n' + res.trim().split('\n').map((l) => '   ' + l.trim()).join('\n'));
      log('✅ 离屏文档路径完全可用');
    } catch (e) {
      log('❌ 解压失败:', String(e.message).slice(0, 300));
    }
  }

  hr('done');
  browser.close();
  setTimeout(() => process.exit(0), 200);
};

main().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exitCode = 1; });