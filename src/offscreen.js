// Offscreen document: exists only because an MV3 service worker has no DOM and
// therefore no URL.createObjectURL. This document rebuilds the archive from the
// base64 the worker sends, turns it into a blob: URL, and hands that URL back —
// the worker then passes it to chrome.downloads.
//
// Verified in a real service worker that URL.createObjectURL is undefined there
// (typeof === 'undefined', calling it throws "not a function"), while
// chrome.downloads.download does accept blob: URLs.
//
// The payload must arrive in CHUNKS: runtime.sendMessage has a hard 64 MiB
// ceiling (measured: 32 MB of data passes, 64 MB throws "Message exceeded
// maximum allowed size of 64MiB"). base64 adds a third on top, so a single
// message could never carry a real archive.

const transfers = new Map(); // id -> { mime, parts: [] }

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;

  if (msg.type === 'blob-chunk') {
    let t = transfers.get(msg.id);
    if (!t) { t = { mime: msg.mime || 'application/octet-stream', parts: [] }; transfers.set(msg.id, t); }
    try {
      t.parts.push(b64ToBytes(msg.base64));
    } catch (e) {
      transfers.delete(msg.id);
      sendResponse({ ok: false, error: `解码分片失败：${String((e && e.message) || e)}` });
      return true;
    }
    sendResponse({ ok: true, received: t.parts.length });
    return true;
  }

  if (msg.type === 'blob-finish') {
    const t = transfers.get(msg.id);
    transfers.delete(msg.id);
    if (!t) {
      sendResponse({ ok: false, error: '分片已丢失（离屏文档可能被回收）' });
      return true;
    }
    try {
      const blob = new Blob(t.parts, { type: t.mime });
      t.parts.length = 0;
      const url = URL.createObjectURL(blob);
      sendResponse({ ok: true, url, size: blob.size });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
    return true;
  }

  if (msg.type === 'blob-abort') {
    transfers.delete(msg.id);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'revoke-blob-url') {
    try { URL.revokeObjectURL(msg.url); } catch { /* already gone */ }
    return false;
  }

  return false;
});
