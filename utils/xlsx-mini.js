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

  // A formula cell is written as { f: "SUM(D2:D4)", v: 8 } instead of a plain
  // value — `f` is the live formula Excel recalculates on open/edit, `v` is
  // just a cached display value so it doesn't show blank in stricter readers.
  function isFormula(val) { return val != null && typeof val === "object" && typeof val.f === "string"; }
  function cellDisplayLen(val) { return isFormula(val) ? String(val.v == null ? "" : val.v).length : String(val == null ? "" : val).length; }

  // Approximate "autofit" column widths from cell content (in character units,
  // matching how Excel measures width). Date cells render as "dd-mmm-yy" (9
  // chars) regardless of the stored serial. Padded a little and clamped.
  function colWidths(rows, dateCols) {
    const dc = new Set(dateCols || []);
    const widths = [];
    rows.forEach((row, r) => {
      row.forEach((val, c) => {
        const len = (r > 0 && dc.has(c)) ? 9 : cellDisplayLen(val);
        if (len > (widths[c] || 0)) widths[c] = len;
      });
    });
    return widths.map((w) => Math.min(Math.max((w || 0) + 2, 6), 60));
  }

  // ── Worksheet / workbook XML ────────────────────────────────
  // dateCols = column indices whose DATA cells are dates.
  // numCols  = column indices whose DATA cells are plain numbers.
  // rowKinds = OPTIONAL, one entry per data row (row 0/header excluded):
  //   "data" (default) | "header" | "total" | "grandtotal" | "blank"
  // leftAlignCols = OPTIONAL, column indices that stay left-aligned instead
  //   of centered (e.g. a "Group Name" column) — only meaningful alongside
  //   rowKinds, since the legacy (no-rowKinds) path doesn't set alignment at
  //   all, matching its original output exactly.
  // bigFontCols = OPTIONAL, column indices rendered at size 16 instead of 10
  //   (e.g. a "Pax" column meant to stand out) — same rowKinds-only caveat.
  // When rowKinds is given: header row is bold, total/grandtotal rows are
  // bold red, every cell is center-and-middle aligned except leftAlignCols
  // (horizontal only — those stay left/middle), and date cells use "dd-mmm"
  // (no year). No borders. Omitting rowKinds keeps the original plain/
  // unaligned/dd-mmm-yy output exactly as before (Bulk Parser).
  // A cell value of { f, v } is written as a live formula (see isFormula above).
  //
  // Style ids (must match xl/styles.xml's cellXfs order):
  //   0 = plain                 1 = plain + date dd-mmm-yy   (legacy, unstyled)
  //   2 = bold + center         3 = bold + left               (header)
  //   4 = plain + center        5 = plain + center + dd-mmm   (data)
  //   6 = plain + left                                        (data, left col)
  //   7 = bold+red + center     8 = bold+red + left            (total/grand-total)
  //   9 = bold + center, sz16    (header, big-font col)
  //  10 = plain + center, sz16   (data, big-font col)
  //  11 = bold+red + center, sz16 (total/grand-total, big-font col)
  function sheetXml(rows, dateCols, numCols, rowKinds, leftAlignCols, bigFontCols) {
    const dc = new Set(dateCols || []);
    const nc = new Set(numCols || []);
    const lac = new Set(leftAlignCols || []);
    const bfc = new Set(bigFontCols || []);
    const useKinds = Array.isArray(rowKinds);

    // <cols> must come before <sheetData>. Mark each column customWidth+bestFit
    // so it opens already fitted to its content.
    const widths = colWidths(rows, dateCols);
    const colsXml = widths.length
      ? `<cols>${widths.map((w, i) =>
          `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1" bestFit="1"/>`).join("")}</cols>`
      : "";

    let body = "";
    rows.forEach((row, r) => {
      const kind = r === 0 ? "header" : (useKinds ? (rowKinds[r - 1] || "data") : "data");
      let cells = "";
      row.forEach((val, c) => {
        const ref = colName(c) + (r + 1);
        if (useKinds && kind === "blank") { cells += `<c r="${ref}"/>`; return; }

        const isDateCol = r > 0 && dc.has(c);
        let s = null;
        if (useKinds) {
          const left = lac.has(c);
          const big = bfc.has(c);
          if (big) {
            s = kind === "header" ? 9 : (kind === "total" || kind === "grandtotal") ? 11 : 10;
          } else {
            s = kind === "header" ? (left ? 3 : 2)
              : (kind === "total" || kind === "grandtotal") ? (left ? 8 : 7)
              : left ? 6 : (isDateCol ? 5 : 4);
          }
        } else if (r > 0 && dc.has(c)) {
          s = 1; // legacy: only dates ever got an explicit style
        }
        const sAttr = s != null ? ` s="${s}"` : "";

        if (isFormula(val)) {
          cells += `<c r="${ref}"${sAttr}><f>${xmlEscape(val.f)}</f><v>${val.v == null ? "" : Number(val.v)}</v></c>`;
          return;
        }

        const serial = isDateCol ? excelDate(val) : null;
        const num = (r > 0 && nc.has(c) && val !== "" && val != null && isFinite(Number(val)))
          ? Number(val) : null;

        const str = val == null ? "" : String(val);

        if (serial != null) {
          cells += `<c r="${ref}"${sAttr}><v>${serial}</v></c>`;
        } else if (num != null) {
          cells += `<c r="${ref}"${sAttr}><v>${num}</v></c>`; // no t attr = numeric cell
        } else if (str === "") {
          // A truly empty <c/> (no t="inlineStr" with empty text) — Excel
          // treats an inline-string cell with empty content as a cell that
          // HAS a value (COUNTA/ISBLANK disagree with what it looks like),
          // which shows up especially once the file carries the Mark-of-the-
          // Web from being downloaded. Omitting the cell body entirely keeps
          // it genuinely blank while still carrying the style (alignment/
          // font) via sAttr.
          cells += `<c r="${ref}"${sAttr}/>`;
        } else {
          cells += `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(val)}</t></is></c>`;
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
      `<numFmts count="2">` +
      `<numFmt numFmtId="164" formatCode="dd-mmm-yy"/>` +
      `<numFmt numFmtId="165" formatCode="dd-mmm"/>` +
      `</numFmts>` +
      `<fonts count="6">` +
      `<font><sz val="10"/><name val="Consolas"/></font>` +                                    // 0: plain
      `<font><b/><sz val="10"/><name val="Consolas"/></font>` +                                // 1: bold
      `<font><b/><sz val="10"/><color rgb="FFFF0000"/><name val="Consolas"/></font>` +          // 2: bold + red
      `<font><sz val="16"/><name val="Consolas"/></font>` +                                    // 3: plain, sz16
      `<font><b/><sz val="16"/><name val="Consolas"/></font>` +                                // 4: bold, sz16
      `<font><b/><sz val="16"/><color rgb="FFFF0000"/><name val="Consolas"/></font>` +          // 5: bold + red, sz16
      `</fonts>` +
      `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>` +
      `<borders count="1"><border/></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="12">` +
      `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +                                                                                                    // 0: plain (legacy)
      `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +                                                                           // 1: plain + date dd-mmm-yy (legacy)
      `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>` +           // 2: bold + center (header)
      `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>` +             // 3: bold + left (header, left col)
      `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>` +                         // 4: plain + center (data)
      `<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>` + // 5: plain + center + date dd-mmm (data)
      `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>` +                           // 6: plain + left (data, left col)
      `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>` +           // 7: bold+red + center (total/grand-total)
      `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>` +             // 8: bold+red + left (total/grand-total, left col)
      `<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>` +           // 9: bold + center, sz16 (header, big col)
      `<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>` +           // 10: plain + center, sz16 (data, big col)
      `<xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>` +           // 11: bold+red + center, sz16 (total/grand-total, big col)
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
  // blob(headers, rows, dateCols, numCols, rowKinds, leftAlignCols, bigFontCols)
  //   dateCols: column indices formatted as dates (dd-mmm, or dd-mmm-yy when
  //             rowKinds is omitted)
  //   numCols:  column indices written as plain numbers
  //   rowKinds: OPTIONAL, one entry per row in `rows` — "data" | "header" |
  //             "total" | "grandtotal" | "blank" — turns on bold/red styling
  //             and column-wise center+middle alignment for a grouped report.
  //             Omit for the original plain, unaligned output.
  //   leftAlignCols: OPTIONAL, column indices that stay left-aligned instead
  //             of centered (only meaningful alongside rowKinds).
  //   bigFontCols: OPTIONAL, column indices rendered at size 16 instead of 10
  //             (only meaningful alongside rowKinds).
  function blob(headers, rows, dateCols, numCols, rowKinds, leftAlignCols, bigFontCols) {
    const aoa = [headers, ...rows];
    const files = Object.entries(FILES_BASE).map(([name, xml]) => ({ name, data: enc(xml) }));
    files.push({ name: "xl/worksheets/sheet1.xml", data: enc(sheetXml(aoa, dateCols, numCols, rowKinds, leftAlignCols, bigFontCols)) });
    const bytes = zip(files);
    return new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  }

  window.NkXlsx = { blob };
})();
