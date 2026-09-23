/*
 * Nuskomate — tiny ZIP writer (no dependencies), STORE method (no
 * compression). Every file this bundles is already compressed at the
 * source (JPEG/WebP/PDF/PNG icons, media pulled from a page), so deflating
 * the archive itself would barely shrink it further — not worth vendoring
 * a whole deflate implementation for. STORE-method zips are still 100%
 * standard and open in anything (Explorer, macOS Finder, 7-Zip, …).
 *
 * Exposes window.NkZip.blob(entries) → Promise<Blob>, entries being
 * [{ name, blob }, …]. Shared by File Tools (batch results -> one .zip)
 * and Media Grabber (Download All as .zip) — same pattern as
 * utils/xlsx-mini.js's window.NkXlsx: one small always-loaded module, one
 * global API, used wherever it's needed instead of duplicated per file.
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
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  function dosDateTime(d) {
    return {
      time: ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f),
      date: (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f),
    };
  }

  async function makeZip(entries) {
    const enc = new TextEncoder();
    const { time, date } = dosDateTime(new Date());
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const { name, blob } of entries) {
      const data = new Uint8Array(await blob.arrayBuffer());
      const nameBytes = enc.encode(name);
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length);
      const dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0, true);
      dv.setUint16(8, 0, true); dv.setUint16(10, time, true); dv.setUint16(12, date, true);
      dv.setUint32(14, crc, true); dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true);
      dv.setUint16(26, nameBytes.length, true); dv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      chunks.push(local, data);
      central.push({ nameBytes, crc, size: data.length, offset });
      offset += local.length + data.length;
    }
    let centralSize = 0;
    const centralChunks = central.map((c) => {
      const buf = new Uint8Array(46 + c.nameBytes.length);
      const dv = new DataView(buf.buffer);
      dv.setUint32(0, 0x02014b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 20, true);
      dv.setUint16(8, 0, true); dv.setUint16(10, 0, true); dv.setUint16(12, time, true); dv.setUint16(14, date, true);
      dv.setUint32(16, c.crc, true); dv.setUint32(20, c.size, true); dv.setUint32(24, c.size, true);
      dv.setUint16(28, c.nameBytes.length, true); dv.setUint16(30, 0, true); dv.setUint16(32, 0, true);
      dv.setUint16(34, 0, true); dv.setUint16(36, 0, true); dv.setUint32(38, 0, true); dv.setUint32(42, c.offset, true);
      buf.set(c.nameBytes, 46);
      centralSize += buf.length;
      return buf;
    });
    const eocd = new Uint8Array(22);
    const dv = new DataView(eocd.buffer);
    dv.setUint32(0, 0x06054b50, true);
    dv.setUint16(8, central.length, true); dv.setUint16(10, central.length, true);
    dv.setUint32(12, centralSize, true); dv.setUint32(16, offset, true);
    return new Blob([...chunks, ...centralChunks, eocd], { type: "application/zip" });
  }

  window.NkZip = { blob: makeZip };
})();
