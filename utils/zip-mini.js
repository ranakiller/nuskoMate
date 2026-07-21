/*
 * Nuskomate — tiny store-only ZIP writer (no dependencies, no compression).
 * Extracted from utils/xlsx-mini.js's proven CRC32/ZIP logic so the license
 * server can bundle the native-host installer scripts into one downloadable
 * zip without duplicating that logic or needing a separate build step —
 * server/worker.js imports this directly (same dual browser/CJS export
 * pattern already used by utils/passport-parser.js for the same reason).
 * Exposes zip(files) → Uint8Array, where files = [{ name, data: Uint8Array }].
 */
(function () {
  "use strict";

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const enc = (s) => new TextEncoder().encode(s);

  function zip(files) {
    // files: [{ name, data: Uint8Array }]
    const chunks = [];
    const central = [];
    let offset = 0;

    const u16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
    const u32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

    for (const f of files) {
      const nameBytes = enc(f.name);
      const crc = crc32(f.data);
      const size = f.data.length;

      const local = [].concat(
        u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0)
      );
      chunks.push(new Uint8Array(local), nameBytes, f.data);

      central.push([].concat(
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(size), u32(size), u16(nameBytes.length),
        u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset)
      ), nameBytes);

      offset += local.length + nameBytes.length + size;
    }

    const centralStart = offset;
    let centralLen = 0;
    const centralChunks = [];
    for (let i = 0; i < central.length; i += 2) {
      const head = new Uint8Array(central[i]);
      centralChunks.push(head, central[i + 1]);
      centralLen += head.length + central[i + 1].length;
    }

    const end = new Uint8Array([].concat(
      u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(centralLen), u32(centralStart), u16(0)
    ));

    const all = [...chunks, ...centralChunks, end];
    const total = all.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(total);
    let p = 0;
    for (const a of all) { out.set(a, p); p += a.length; }
    return out;
  }

  const NkZip = { zip };
  if (typeof window !== "undefined") window.NkZip = NkZip;         // browser
  if (typeof module !== "undefined" && module.exports) module.exports = NkZip; // server build
})();
