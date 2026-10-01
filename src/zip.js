// Streaming-ish ZIP writer. Builds the archive as a Blob made of segment
// references, so the payload chunks are never concatenated in memory.
// Real DEFLATE comes from the platform's CompressionStream.
(() => {
  const enc = new TextEncoder();

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  // Incremental CRC-32, so we never need the whole file in memory.
  function makeCrc() {
    let c = 0xFFFFFFFF;
    return {
      update(bytes) {
        for (let i = 0; i < bytes.length; i += 1) {
          c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
        }
        return this;
      },
      digest() {
        return (c ^ 0xFFFFFFFF) >>> 0;
      },
    };
  }

  function dosDateTime(date) {
    const d = date || new Date();
    const year = Math.max(1980, d.getFullYear());
    const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() / 2) & 0x1F);
    const day = (((year - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
    return { time, date: day };
  }

  async function deflateRaw(blob) {
    // store only — caller decides
    if (typeof CompressionStream !== 'function') return null;
    try {
      const stream = blob.stream().pipeThrough(new CompressionStream('deflate-raw'));
      const out = await new Response(stream).blob();
      return out;
    } catch {
      return null;
    }
  }

  // entries: [{ path, blob, date }]
  // options: { compress: boolean, onProgress(done, total) }
  async function buildZip(entries, options = {}) {
    const compress = Boolean(options.compress);
    const onProgress = options.onProgress || (() => {});
    const segments = [];
    const central = [];
    let offset = 0;

    const push = (blob) => {
      segments.push(blob);
      offset += blob.size;
    };

    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const nameBytes = enc.encode(entry.path);
      const { time, date } = dosDateTime(entry.date);

      const crc = makeCrc();
      let uncompressedSize = 0;
      const reader = entry.blob.stream().getReader();
      const parts = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        crc.update(value);
        uncompressedSize += value.length;
        parts.push(value);
      }
      const rawBlob = new Blob(parts, { type: 'application/octet-stream' });
      parts.length = 0;

      let payload = rawBlob;
      let method = 0;
      if (compress && uncompressedSize > 256) {
        const deflated = await deflateRaw(rawBlob);
        if (deflated && deflated.size < rawBlob.size) {
          payload = deflated;
          method = 8;
        }
      }

      const localHeader = new DataView(new ArrayBuffer(30));
      localHeader.setUint32(0, 0x04034b50, true);
      localHeader.setUint16(4, 20, true);
      localHeader.setUint16(6, 0x0800, true); // UTF-8 names
      localHeader.setUint16(8, method, true);
      localHeader.setUint16(10, time, true);
      localHeader.setUint16(12, date, true);
      localHeader.setUint32(14, crc.digest(), true);
      localHeader.setUint32(18, payload.size, true);
      localHeader.setUint32(22, uncompressedSize, true);
      localHeader.setUint16(26, nameBytes.length, true);
      localHeader.setUint16(28, 0, true);

      const headerOffset = offset;
      push(new Blob([localHeader.buffer, nameBytes]));
      push(payload);

      central.push({ nameBytes, method, time, date, crc: crc.digest(), compressed: payload.size, uncompressed: uncompressedSize, headerOffset });
      onProgress(i + 1, entries.length, entry.path);
    }

    const cdStart = offset;
    let cdSize = 0;
    for (const e of central) {
      const h = new DataView(new ArrayBuffer(46));
      h.setUint32(0, 0x02014b50, true);
      h.setUint16(4, 20, true);
      h.setUint16(6, 20, true);
      h.setUint16(8, 0x0800, true);
      h.setUint16(10, e.method, true);
      h.setUint16(12, e.time, true);
      h.setUint16(14, e.date, true);
      h.setUint32(16, e.crc, true);
      h.setUint32(20, e.compressed, true);
      h.setUint32(24, e.uncompressed, true);
      h.setUint16(28, e.nameBytes.length, true);
      h.setUint32(42, e.headerOffset, true);
      const blob = new Blob([h.buffer, e.nameBytes]);
      push(blob);
      cdSize += blob.size;
    }

    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, central.length, true);
    eocd.setUint16(10, central.length, true);
    eocd.setUint32(12, cdSize, true);
    eocd.setUint32(16, cdStart, true);
    push(new Blob([eocd.buffer]));

    return new Blob(segments, { type: 'application/zip' });
  }

  globalThis.DDZip = { buildZip, makeCrc };
})();
