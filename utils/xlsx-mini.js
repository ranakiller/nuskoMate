/*
 * Nuskomate — tiny .xlsx writer (no dependencies).
 * Builds a valid single-sheet workbook with inline strings and packs it into a
 * store-only ZIP. Exposes window.NkXlsx.blob(headers, rows) → Blob.
 */
(function () {
  "use strict";

  // ── CRC32 ───────────────────────────────────────────────────
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

  function xmlEscape(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
  }

  function colName(n) { // 0 → A, 25 → Z, 26 → AA …
    let s = "";
    n++;
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  // "YYYY-MM-DD" → Excel serial day number (1900 date system), or null.
  function excelDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
    if (!m) return null;
    const days = Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000);
    return days > 0 ? days : null;
  }

  // Approximate "autofit" column widths from cell content (in character units,
  // matching how Excel measures width). Date cells render as "dd-mmm-yy" (9
  // chars) regardless of the stored serial. Padded a little and clamped.
  function colWidths(rows, dateCols) {
    const dc = new Set(dateCols || []);
    const widths = [];
    rows.forEach((row, r) => {
      row.forEach((val, c) => {
        const len = (r > 0 && dc.has(c)) ? 9 : String(val == null ? "" : val).length;
        if (len > (widths[c] || 0)) widths[c] = len;
      });
    });
    return widths.map((w) => Math.min(Math.max((w || 0) + 2, 6), 60));
  }

  // ── Worksheet / workbook XML ────────────────────────────────
  // dateCols = column indices whose DATA cells are dates (style s="1", dd-mmm-yy).
  function sheetXml(rows, dateCols) {
    const dc = new Set(dateCols || []);

    // <cols> must come before <sheetData>. Mark each column customWidth+bestFit
    // so it opens already fitted to its content.
    const widths = colWidths(rows, dateCols);
    const colsXml = widths.length
      ? `<cols>${widths.map((w, i) =>
          `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1" bestFit="1"/>`).join("")}</cols>`
      : "";

    let body = "";
    rows.forEach((row, r) => {
      let cells = "";
      row.forEach((val, c) => {
        const ref = colName(c) + (r + 1);
        const serial = (r > 0 && dc.has(c)) ? excelDate(val) : null; // row 0 = header
        if (serial != null) {
          cells += `<c r="${ref}" s="1"><v>${serial}</v></c>`;
        } else {
          cells += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(val)}</t></is></c>`;
        }
      });
      body += `<row r="${r + 1}">${cells}</row>`;
    });
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `${colsXml}<sheetData>${body}</sheetData></worksheet>`;
  }

  const FILES_BASE = {
    "[Content_Types].xml":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      `</Types>`,
    "_rels/.rels":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`,
    "xl/workbook.xml":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets><sheet name="Passports" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>`,
    "xl/styles.xml":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<numFmts count="1"><numFmt numFmtId="164" formatCode="dd-mmm-yy"/></numFmts>` +
      `<fonts count="1"><font><sz val="10"/><name val="Consolas"/></font></fonts>` +
      `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>` +
      `<borders count="1"><border/></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="2">` +
      `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
      `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
      `</cellXfs></styleSheet>`,
  };

  // ── store-only ZIP ──────────────────────────────────────────
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

  // ── Public API ──────────────────────────────────────────────
  // blob(headers, rows, dateCols) — dateCols: column indices to format as dates.
  function blob(headers, rows, dateCols) {
    const aoa = [headers, ...rows];
    const files = Object.entries(FILES_BASE).map(([name, xml]) => ({ name, data: enc(xml) }));
    files.push({ name: "xl/worksheets/sheet1.xml", data: enc(sheetXml(aoa, dateCols)) });
    const bytes = zip(files);
    return new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  }

  window.NkXlsx = { blob };
})();
