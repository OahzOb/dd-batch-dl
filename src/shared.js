// Shared helpers. Classic script: defines globalThis.DDShared.
// Loaded via importScripts() in the service worker and <script src> in the side panel.
(() => {
  const ONLINE_DOC_EXTS = [
    '.adoc', '.axls', '.amind', '.aboard', '.amxd', '.asheet', '.able',
  ];

  function extOf(name) {
    const m = /\.[^.\\/]+$/.exec(name || '');
    return m ? m[0].toLowerCase() : '';
  }

  // A node is a DingTalk-native online doc if either the API says so via
  // contentType, or its name carries one of the online-only extensions.
  // Accepts a node object or a bare filename.
  function isOnlineDoc(nodeOrName) {
    const name = typeof nodeOrName === 'string'
      ? nodeOrName
      : (nodeOrName && nodeOrName.name) || '';
    const contentType = typeof nodeOrName === 'object' && nodeOrName
      ? (nodeOrName.contentType || '') : '';
    if (contentType === 'ALIDOC') return true;
    return ONLINE_DOC_EXTS.includes(extOf(name));
  }

  // Windows-safe file/folder name. Also neutralises traversal.
  function safeName(name) {
    let out = String(name == null ? '' : name)
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '');
    if (out === '' || out === '.' || out === '..') out = 'untitled';
    if (out.length > 120) out = out.slice(0, 120);
    return out;
  }

  // Unique-ify `name` against a Set of already-used lowercase names.
  function dedupe(name, usedSet) {
    const stem = name.replace(/(\.[^.]*)?$/, '');
    const ext = name.slice(stem.length);
    let candidate = name;
    let n = 1;
    while (usedSet.has(candidate.toLowerCase())) {
      candidate = `${stem} (${n})${ext}`;
      n += 1;
    }
    usedSet.add(candidate.toLowerCase());
    return candidate;
  }

  function humanSize(bytes) {
    if (bytes == null || Number.isNaN(bytes)) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = Number(bytes);
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  }

  function nodeIdFromUrl(url) {
    if (!url) return null;
    const m = /\/i\/nodes\/([A-Za-z0-9_-]+)/.exec(url);
    return m ? m[1] : null;
  }

  function shortId(id) {
    if (!id) return '';
    return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
  }

  function tsName() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  globalThis.DDShared = {
    ONLINE_DOC_EXTS, extOf, isOnlineDoc, safeName, dedupe,
    humanSize, nodeIdFromUrl, shortId, tsName,
  };
})();
