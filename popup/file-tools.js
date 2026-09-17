// JPG & PDF Tools — fully local file conversion, no network, no page
// injection. Two libraries do the real work:
//   pdf-lib  (window.PDFLib, classic UMD script) — builds/edits PDFs:
//            create, merge, split, embed images.
//   pdf.js   (imported here as an ES module — v4+ dropped its UMD build) —
//            renders EXISTING pdf pages to a canvas, which pdf-lib cannot do
//            on its own. That's why this file is loaded as
//            <script type="module">, unlike every other popup script.
//
// Everything else (image compress/resize/convert/rotate) is plain Canvas —
// no library needed.
import * as pdfjsLib from "../utils/pdfjs/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("utils/pdfjs/pdf.worker.min.mjs");

// ── Small shared helpers ───────────────────────────────────────────────────

function formatBytes(n) {
  if (!n && n !== 0) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(2) + " MB";
}

function baseName(filename) {
  return String(filename || "file").replace(/\.[^./]+$/, "");
}

function readAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("Could not read " + file.name));
    r.readAsArrayBuffer(file);
  });
}
function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("Could not read " + file.name));
    r.readAsDataURL(file);
  });
}
function sendRuntimeMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : (resp || { ok: false, error: "No response" }));
    });
  });
}

// ── OCR & Background Removal — both "bring your own API key", same pattern
// as everywhere else in this extension (Settings > OCR / Background Removal).
// OCR reuses the EXACT pipeline the Passport tab's own OCR already uses
// (utils/license.js's scan(), background.js -> the Nuskomate license server
// -> ocr.space) — that endpoint already returns the plain text (`raw`)
// alongside the passport-specific parsed fields, so no server change was
// needed for a general "read the text out of this image" tool. It shares
// the Passport tab's "ocr" entitlement on purpose: this is the same paid
// capability, just pointed at any image instead of only a passport photo.
async function ocrImage(file) {
  if (!window.NkLicense || !window.NkLicense.scan) throw new Error("Licensing isn't available");
  const r = await window.NkLicense.scan(file, "ocr");
  if (!r || !r.ok) throw new Error((r && r.error) || "OCR failed");
  const text = (r.raw || "").trim();
  if (!text) throw new Error("No text found in this image");
  return text;
}

// Background Removal calls remove.bg directly from background.js (see its
// own comment for why) — this file just base64s the picked image over and
// decodes the PNG that comes back.
async function removeBackgroundFromFile(file) {
  const fileB64 = await readAsBase64(file);
  const resp = await sendRuntimeMessage({ type: "nkRemoveBg", fileB64, fileType: file.type || "image/jpeg" });
  if (!resp || !resp.ok) throw new Error((resp && resp.error) || "Background removal failed");
  const bytes = Uint8Array.from(atob(resp.data.fileB64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: resp.data.fileType || "image/png" });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode image"))), type, quality);
  });
}

// One <a download> click, same technique already used elsewhere in this
// popup (see popup/auto-clicker.js's export buttons).
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// "invoice.pdf" picked twice (or a tool that would otherwise emit the same
// name for two different sources) would silently collide inside a zip —
// number the repeats before they ever reach downloadAll/renderResults.
function dedupeNames(results) {
  const seen = new Map();
  return results.map((r) => {
    const count = (seen.get(r.name) || 0) + 1;
    seen.set(r.name, count);
    if (count === 1) return r;
    const dot = r.name.lastIndexOf(".");
    const name = dot < 0 ? `${r.name} (${count})` : `${r.name.slice(0, dot)} (${count})${r.name.slice(dot)}`;
    return { ...r, name };
  });
}

// ── Minimal ZIP writer (STORE — no compression) ─────────────────────────────
// Every result here is already compressed (JPEG/WebP/PDF), so re-compressing
// the archive itself would barely shrink it further — not worth vendoring a
// whole deflate implementation for. STORE-method zips are still 100% standard
// and open in anything (Explorer, macOS Finder, 7-Zip, …).
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

// Two ways to get a batch of results out, offered as separate buttons —
// one .zip file (via makeZip below), or every file downloaded on its own.
// Staggered: firing N downloads in the same instant is exactly the pattern
// Chrome's own "site is trying to download multiple files" guard watches for.
function downloadEach(results) {
  results.forEach((r, i) => setTimeout(() => downloadBlob(r.blob, r.name), i * 350));
}
async function downloadAsZip(results, zipName) {
  downloadBlob(await makeZip(results), zipName);
}

// Any image type the browser can decode → a JPEG Blob at the page's natural
// pixel size. Normalizing to JPEG here (rather than branching on the
// original format) means every downstream PDF step only ever has to call
// pdf-lib's embedJpg — PNG transparency flattens to white, which is the
// right call for a printable PDF page anyway.
async function imageToJpegBlob(file, quality = 0.92) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); // flatten any transparency
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close && bitmap.close();
  return { blob: await canvasToBlob(canvas, "image/jpeg", quality), width: canvas.width, height: canvas.height };
}

// Shared by Crop Image's two ways of landing on a rectangle (the dragged
// region, or Trim Whitespace's auto-detected one) — keeps the file's own
// format (PNG stays PNG, so transparency survives a crop) rather than always
// normalizing to JPEG the way imageToJpegBlob above deliberately does.
async function cropImageToRect(file, rect) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = rect.width; canvas.height = rect.height;
  canvas.getContext("2d").drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  bitmap.close && bitmap.close();
  const isPng = file.type === "image/png";
  const blob = await canvasToBlob(canvas, isPng ? "image/png" : "image/jpeg", isPng ? undefined : 0.92);
  return { blob, ext: isPng ? "png" : "jpg" };
}

// Crop Image accepts a batch, but only shows ONE region selector — calibrated
// against files[0]. Reusing that selection on a differently-sized image only
// makes sense as a PROPORTION of the image (e.g. "the middle 70% width, top
// 15%-85% height"), not as the same pixel rectangle — so the selector hands
// back a 0..1 fraction (see buildRegionSelector's getFraction), and this
// re-derives the actual pixel rect per file from its own natural size.
async function cropImageToFraction(file, frac) {
  const bitmap = await createImageBitmap(file);
  const rect = {
    x: Math.round(frac.fx * bitmap.width), y: Math.round(frac.fy * bitmap.height),
    width: Math.round(frac.fw * bitmap.width), height: Math.round(frac.fh * bitmap.height),
  };
  bitmap.close && bitmap.close();
  return cropImageToRect(file, rect);
}

// "1-3,5,8-10" (1-based, as shown to the user) → 0-based page indices, in
// the order given — repeating or reordering ranges is allowed on purpose,
// it's a harmless way to duplicate or reorder pages into the output.
function parsePageRange(str, pageCount) {
  const out = [];
  const parts = String(str || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error("Enter a page range, e.g. 1-3,5");
  for (const part of parts) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`"${part}" isn't a valid page or range`);
    const a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    if (lo < 1 || hi > pageCount) throw new Error(`Page ${hi > pageCount ? hi : lo} is outside 1–${pageCount}`);
    for (let p = a; a <= b ? p <= b : p >= b; a <= b ? p++ : p--) out.push(p - 1);
  }
  return out;
}

async function renderPdfPageToCanvas(pdfPage, scale) {
  const viewport = pdfPage.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  await pdfPage.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

async function loadPdfJs(file) {
  const buf = await readAsArrayBuffer(file);
  return pdfjsLib.getDocument({ data: buf }).promise;
}
async function loadPdfLib(file) {
  const buf = await readAsArrayBuffer(file);
  return window.PDFLib.PDFDocument.load(buf);
}

// A new pdf-lib document with the given JPEG pages, one page per image,
// each page exactly the image's pixel size (1px = 1pt) — simple, and prints
// close enough to natural size for a quick conversion tool.
async function pdfFromJpegPages(jpegPages) {
  const { PDFDocument } = window.PDFLib;
  const out = await PDFDocument.create();
  for (const { bytes, width, height } of jpegPages) {
    const img = await out.embedJpg(bytes);
    const page = out.addPage([width, height]);
    page.drawImage(img, { x: 0, y: 0, width, height });
  }
  return out.save();
}

// ── Auto-straighten: detect a crooked scan/photo's tilt angle ──────────────
// A "projection profile" skew detector — the same basic technique real
// document scanners use, no ML model or vendored library needed. The idea:
// for the CORRECT rotation, a page's text sits in neat horizontal bands (row
// after row of "mostly ink" alternating with "mostly white gap"), which
// makes the row-by-row darkness profile spike sharply. Any wrong angle
// smears text across rows instead, flattening that profile out. So: try a
// range of candidate angles, score each by how spiky its profile is, and the
// biggest spike wins.
//
// This can only ever find a rotation whose two directions look genuinely
// different from each other — which a small tilt always does, but an exact
// 180°/pointing-the-other-way flip does NOT (upside-down text still makes
// the same horizontal bands, just in reverse row order — same variance
// either way, so nothing here can tell "upside down" from "right side up").
// That's why this only searches a modest range around the image's OWN
// current orientation (assumes it's already roughly upright, just tilted)
// rather than also trying to guess between all four 90° rotations — being
// confidently wrong about "sideways vs. upside-down" would make a document
// worse, not better, so it isn't attempted.
//
// Returns null when nothing in the image looks line-like enough to trust
// (a photo of a face, a plain graphic, anything without real text/ruled
// lines) — callers should fall back to asking for a manual angle instead of
// silently applying a guess.
function detectSkewAngle(sourceCanvas, maxAngle = 20) {
  const maxDim = 480; // plenty of resolution for this; more just costs time
  const scale = Math.min(1, maxDim / Math.max(sourceCanvas.width, sourceCanvas.height));
  const w = Math.max(1, Math.round(sourceCanvas.width * scale));
  const h = Math.max(1, Math.round(sourceCanvas.height * scale));
  const small = document.createElement("canvas");
  small.width = w; small.height = h;
  const sctx = small.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(sourceCanvas, 0, 0, w, h);
  const { data } = sctx.getImageData(0, 0, w, h);

  // Precompute "darkness" (0 = white, 255 = black) once — every candidate
  // angle re-buckets these same values, never touches the canvas again.
  const dark = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    dark[p] = 255 - (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  }

  const cx = w / 2, cy = h / 2;
  const numBuckets = Math.ceil(Math.sqrt(w * w + h * h)) + 2;
  const mid = numBuckets / 2;
  const buckets = new Float64Array(numBuckets); // reused every call, cleared each time

  // Projects every dark pixel onto the axis perpendicular to candidate
  // angle `deg`, filling `buckets` with that angle's row-darkness profile —
  // the shared step both scoreAngle() and the final trust-check need.
  function computeBuckets(deg) {
    buckets.fill(0);
    const rad = (deg * Math.PI) / 180, sin = Math.sin(rad), cos = Math.cos(rad);
    for (let y = 0; y < h; y++) {
      const yy = y - cy;
      const rowOffset = y * w;
      for (let x = 0; x < w; x++) {
        const d = dark[rowOffset + x];
        if (d < 12) continue; // background pixels never help — skip for speed
        const bucket = ((x - cx) * sin + yy * cos + mid) | 0;
        if (bucket >= 0 && bucket < numBuckets) buckets[bucket] += d;
      }
    }
    return buckets;
  }
  function scoreAngle(deg) {
    const b = computeBuckets(deg);
    let mean = 0;
    for (let i = 0; i < numBuckets; i++) mean += b[i];
    mean /= numBuckets;
    let variance = 0;
    for (let i = 0; i < numBuckets; i++) { const dd = b[i] - mean; variance += dd * dd; }
    return variance / numBuckets;
  }

  // Coarse sweep (1° steps) to find the neighborhood, then refine (0.15°
  // steps) around it — cheap enough to just always do both passes.
  let sum = 0, count = 0, best = { angle: 0, score: -Infinity };
  for (let a = -maxAngle; a <= maxAngle; a += 1) {
    const s = scoreAngle(a);
    sum += s; count++;
    if (s > best.score) best = { angle: a, score: s };
  }
  const coarseAngle = best.angle;
  for (let a = coarseAngle - 0.9; a <= coarseAngle + 0.9; a += 0.15) {
    const s = scoreAngle(a);
    if (s > best.score) best = { angle: a, score: s };
  }

  // Trust check, two parts — both matter, confirmed empirically (a smooth
  // photo/gradient can score deceptively well on variance alone):
  //   1. confidence — the winning angle must clearly beat the average of
  //      every angle tried; a flat/textureless image scores similarly no
  //      matter what angle is tried.
  //   2. band count — the winning angle's OWN profile must actually look
  //      like multiple alternating text-line bands, not just one smooth
  //      hump. Counted as contiguous above-threshold runs (not per-point
  //      local maxima) so it isn't fooled by pixel-level noise inside a
  //      single true band.
  const avg = sum / count;
  const confidence = avg > 0 ? Math.max(0, Math.min(1, (best.score - avg) / avg)) : 0;
  const winProfile = computeBuckets(best.angle);
  const bandThresh = Math.max(...winProfile) * 0.3;
  let bands = 0, wasAbove = false;
  for (let i = 0; i < numBuckets; i++) {
    const above = winProfile[i] > bandThresh;
    if (above && !wasAbove) bands++;
    wasAbove = above;
  }
  if (confidence < 0.12 || bands < 4) return null;
  return { angle: Math.round(best.angle * 10) / 10, confidence };
}

// Rotates by an ARBITRARY angle (unlike the 90°-multiple case elsewhere,
// which swaps width/height exactly) — the canvas has to grow to fit the
// rotated rectangle without clipping its corners, and whatever background
// shows in the newly-exposed corners is filled white, same as real scanner
// apps do after straightening a page.
function rotateCanvasByAngle(source, w, h, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
  const newW = Math.ceil(w * cos + h * sin), newH = Math.ceil(w * sin + h * cos);
  const canvas = document.createElement("canvas");
  canvas.width = newW; canvas.height = newH;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, newW, newH);
  ctx.translate(newW / 2, newH / 2);
  ctx.rotate(rad);
  ctx.drawImage(source, -w / 2, -h / 2, w, h);
  return canvas;
}

// ── Trim whitespace: auto-crop blank margins ────────────────────────────────
// Unlike skew detection, this has no ambiguity to worry about — either a row
// of pixels is basically all one color or it isn't. Works out from each edge
// toward the center until it hits real content, on a downscaled copy for
// speed (the crop rectangle then scales back up to the original resolution,
// so the OUTPUT is never touched by the downscale — only where it detects
// the cut lines).
function estimateBorderColor(data, w, h) {
  // Median of a ring of sample points around all four edges — robust to one
  // stray dark pixel/dust speck near a corner throwing off the estimate,
  // which a single-pixel corner sample wouldn't be.
  const step = Math.max(1, Math.floor(Math.min(w, h) / 100));
  const rs = [], gs = [], bs = [];
  const sample = (x, y) => { const i = (y * w + x) * 4; rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]); };
  for (let x = 0; x < w; x += step) { sample(x, 0); sample(x, h - 1); }
  for (let y = 0; y < h; y += step) { sample(0, y); sample(w - 1, y); }
  const mid = (arr) => arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)];
  return { r: mid(rs), g: mid(gs), b: mid(bs) };
}

// Returns the detected content rectangle in the SOURCE canvas's own pixel
// coordinates, or null if nothing looked croppable (an entirely blank image,
// or content running edge-to-edge with no margin to trim at all).
function detectContentBounds(sourceCanvas, { tolerance = 20 } = {}) {
  const maxDim = 500;
  const scale = Math.min(1, maxDim / Math.max(sourceCanvas.width, sourceCanvas.height));
  const w = Math.max(1, Math.round(sourceCanvas.width * scale));
  const h = Math.max(1, Math.round(sourceCanvas.height * scale));
  const small = document.createElement("canvas");
  small.width = w; small.height = h;
  const ctx = small.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(sourceCanvas, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const bg = estimateBorderColor(data, w, h);
  const tol2 = tolerance * tolerance;

  const isBg = (x, y) => {
    const i = (y * w + x) * 4;
    const dr = data[i] - bg.r, dg = data[i + 1] - bg.g, db = data[i + 2] - bg.b;
    return dr * dr + dg * dg + db * db <= tol2;
  };
  // A row/column counts as "blank" up to a small amount of noise (JPEG
  // ringing, a fleck of dust) — otherwise a single stray pixel could pin the
  // crop right up against the actual content.
  const noiseAllowance = 0.006;
  const rowBlank = (y) => { let bad = 0; const max = w * noiseAllowance; for (let x = 0; x < w; x++) { if (!isBg(x, y) && ++bad > max) return false; } return true; };
  const colBlank = (x) => { let bad = 0; const max = h * noiseAllowance; for (let y = 0; y < h; y++) { if (!isBg(x, y) && ++bad > max) return false; } return true; };

  let top = 0, bottom = h - 1, left = 0, right = w - 1;
  while (top < bottom && rowBlank(top)) top++;
  while (bottom > top && rowBlank(bottom)) bottom--;
  while (left < right && colBlank(left)) left++;
  while (right > left && colBlank(right)) right--;

  if (right - left < w * 0.02 || bottom - top < h * 0.02) return null; // degenerate — e.g. a fully blank image
  if (top === 0 && bottom === h - 1 && left === 0 && right === w - 1) return null; // nothing to trim

  const inv = 1 / scale;
  return {
    x: Math.max(0, Math.floor(left * inv)), y: Math.max(0, Math.floor(top * inv)),
    width: Math.ceil((right - left + 1) * inv), height: Math.ceil((bottom - top + 1) * inv),
  };
}

// ── Icons (feather-style, matches the rest of the extension) ──────────────
const ICONS = {
  pdf2jpg: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  img2pdf: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>',
  merge:   '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  split:   '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/>',
  compress:'<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>',
  resize:  '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  convert: '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  rotate:  '<path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/>',
  trash:   '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  up:      '<polyline points="18 15 12 9 6 15"/>',
  down:    '<polyline points="6 9 12 15 18 9"/>',
  download:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  upload:  '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  crop:    '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  blur:    '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-4 5.19"/><line x1="1" y1="1" x2="23" y2="23"/>',
  filters: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  shield:  '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  ocr:     '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/>',
  wand:    '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M16 16l2 2M18 6l-2 2M8 16l-2 2"/><circle cx="12" cy="12" r="2"/>',
  list:    '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  text2pdf:'<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>',
  droplet: '<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>',
  copy:    '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check:   '<polyline points="20 6 9 17 4 12"/>',
  back:    '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  camera:  '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
};
const svg = (name, size) => `<svg width="${size || 14}" height="${size || 14}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${ICONS[name] || ""}</svg>`;

// ── Tool definitions ────────────────────────────────────────────────────────
// Each tool declares its accepted files, its option fields, and a run()
// that turns (files, values) into [{name, blob}]. One generic card builder
// (buildToolCard, below) renders and wires every tool identically.
const QUALITY_OPTIONS = [
  { value: "0.5", label: "Low — smallest file" },
  { value: "0.75", label: "Medium" },
  { value: "0.92", label: "High — best quality" },
];

const TOOLS = [
  // ── Web Page Screenshot ──────────────────────────────────────────────────
  {
    id: "webshot", group: "web", icon: "camera", iconClass: "ocr-icon",
    name: "Element Screenshot", desc: "Drag from one element to another on any web page to capture just that area",
    noFile: true, runLabel: "Capture Elements", commandId: "nk-webshot-start",
    fields: [{ key: "delivery", label: "When done", type: "select", options: [
      { value: "tool", label: "Show here, in File Tools" },
      { value: "download", label: "Download automatically" },
      { value: "clipboard", label: "Copy to clipboard" },
      { value: "tab", label: "Open in a new tab" },
    ], default: "tool" }],
    note: "Opens the picker on your CURRENT tab and closes this popup. Hover highlights an element; click it and drag to another (even past the edge of the screen — the page auto-scrolls) and release to capture everything from one to the other, stitched into a single image regardless of how much scrolling it took. Esc cancels.",
    resultsAsGrid: true,
    async run(files, v) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id || !/^https?:/.test(tab.url || "")) throw new Error("Open a regular web page first — this can't run on a browser-internal page");
      await chrome.storage.local.set({ ftScreenshotDelivery: v.delivery });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["utils/notify.js", "utils/webshot-picker.js"] });
      window.close();
      return [];
    },
  },
  // ── PDF Tools ──────────────────────────────────────────────────────────
  {
    id: "pdf2jpg", group: "pdf", icon: "pdf2jpg", iconClass: "ocr-icon",
    name: "PDF → JPG", desc: "Turn every page of one or more PDFs into downloadable images",
    accept: "application/pdf", multiple: true, runLabel: "Convert to JPG",
    fields: [{ key: "quality", label: "Image quality", type: "select", options: QUALITY_OPTIONS, default: "0.92" }],
    resultsAsGrid: true,
    async run(files, v, { onProgress }) {
      const out = [];
      for (let f = 0; f < files.length; f++) {
        const file = files[f];
        const prefix = files.length > 1 ? `${file.name} — ` : "";
        const doc = await loadPdfJs(file);
        for (let i = 1; i <= doc.numPages; i++) {
          onProgress(`${prefix}Rendering page ${i} of ${doc.numPages}…`);
          const page = await doc.getPage(i);
          const canvas = await renderPdfPageToCanvas(page, 2);
          const blob = await canvasToBlob(canvas, "image/jpeg", parseFloat(v.quality));
          out.push({ name: `${baseName(file.name)}-page-${i}.jpg`, blob });
        }
      }
      return out;
    },
  },
  {
    id: "img2pdf", group: "pdf", icon: "img2pdf", iconClass: "fill-icon",
    name: "Images → PDF", desc: "Combine JPGs or PNGs into one PDF, in order",
    accept: "image/jpeg,image/png,image/webp", multiple: true, reorder: true, runLabel: "Create PDF",
    fields: [{ key: "pageSize", label: "Page size", type: "select", options: [
      { value: "fit", label: "Fit to each image" },
      { value: "a4", label: "A4 (image centered)" },
    ], default: "fit" }],
    async run(files, v, { onProgress }) {
      const { PDFDocument } = window.PDFLib;
      const out = await PDFDocument.create();
      for (let i = 0; i < files.length; i++) {
        onProgress(`Adding image ${i + 1} of ${files.length}…`);
        const { blob, width, height } = await imageToJpegBlob(files[i]);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const img = await out.embedJpg(bytes);
        if (v.pageSize === "a4") {
          const [pw, ph] = [595.28, 841.89];
          const scale = Math.min(pw / width, ph / height);
          const w = width * scale, h = height * scale;
          const page = out.addPage([pw, ph]);
          page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
        } else {
          out.addPage([width, height]).drawImage(img, { x: 0, y: 0, width, height });
        }
      }
      const bytes = await out.save();
      return [{ name: "images.pdf", blob: new Blob([bytes], { type: "application/pdf" }) }];
    },
  },
  {
    id: "pdfmerge", group: "pdf", icon: "merge", iconClass: "batch-icon",
    name: "Merge PDFs", desc: "Combine several PDFs into one, in the order listed",
    accept: "application/pdf", multiple: true, reorder: true, runLabel: "Merge",
    fields: [],
    async run(files, v, { onProgress }) {
      const { PDFDocument } = window.PDFLib;
      const out = await PDFDocument.create();
      for (let i = 0; i < files.length; i++) {
        onProgress(`Adding ${files[i].name}…`);
        const src = await loadPdfLib(files[i]);
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach((p) => out.addPage(p));
      }
      const bytes = await out.save();
      return [{ name: "merged.pdf", blob: new Blob([bytes], { type: "application/pdf" }) }];
    },
  },
  {
    id: "pdfsplit", group: "pdf", icon: "split", iconClass: "issuedate-icon",
    name: "Split PDF", desc: "Pull out a page range, or split every page into its own file",
    accept: "application/pdf", multiple: false,
    runLabel: (v) => (v.mode === "each" ? "Split" : "Extract Pages"),
    fields: [
      { key: "mode", label: "Split mode", type: "select", options: [
        { value: "range", label: "Extract a page range" },
        { value: "each", label: "Every page as its own PDF" },
      ], default: "range" },
      { key: "range", label: "Pages (e.g. 1-3,5)", type: "text", placeholder: "1-3,5", showIf: (v) => v.mode === "range" },
    ],
    async run(files, v, { onProgress }) {
      const { PDFDocument } = window.PDFLib;
      const file = files[0];
      const src = await loadPdfLib(file);
      const total = src.getPageCount();
      const name = baseName(file.name);
      if (v.mode === "each") {
        const out = [];
        for (let i = 0; i < total; i++) {
          onProgress(`Splitting page ${i + 1} of ${total}…`);
          const doc = await PDFDocument.create();
          const [p] = await doc.copyPages(src, [i]);
          doc.addPage(p);
          const bytes = await doc.save();
          out.push({ name: `${name}-page-${i + 1}.pdf`, blob: new Blob([bytes], { type: "application/pdf" }) });
        }
        return out;
      }
      const indices = parsePageRange(v.range, total);
      onProgress(`Extracting ${indices.length} page(s)…`);
      const doc = await PDFDocument.create();
      const pages = await doc.copyPages(src, indices);
      pages.forEach((p) => doc.addPage(p));
      const bytes = await doc.save();
      return [{ name: `${name}-pages.pdf`, blob: new Blob([bytes], { type: "application/pdf" }) }];
    },
  },
  {
    id: "pdfcompress", group: "pdf", icon: "compress", iconClass: "reload-icon",
    name: "Compress PDF", desc: "Shrink file size by re-encoding each page as an image",
    accept: "application/pdf", multiple: false, runLabel: "Compress",
    fields: [{ key: "quality", label: "Quality vs. size", type: "select", options: [
      { value: "0.4|1.1", label: "Smallest file" },
      { value: "0.6|1.4", label: "Balanced" },
      { value: "0.8|1.8", label: "Best quality" },
    ], default: "0.6|1.4" }],
    note: "This rasterizes every page — text is no longer selectable afterward. Best for scanned/image-heavy PDFs; a mostly-text PDF may not shrink much this way.",
    async run(files, v, { onProgress }) {
      const [quality, scale] = v.quality.split("|").map(Number);
      const file = files[0];
      const doc = await loadPdfJs(file);
      const pages = [];
      for (let i = 1; i <= doc.numPages; i++) {
        onProgress(`Compressing page ${i} of ${doc.numPages}…`);
        const page = await doc.getPage(i);
        const canvas = await renderPdfPageToCanvas(page, scale);
        const blob = await canvasToBlob(canvas, "image/jpeg", quality);
        pages.push({ bytes: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height });
      }
      const bytes = await pdfFromJpegPages(pages);
      return [{ name: `${baseName(file.name)}-compressed.pdf`, blob: new Blob([bytes], { type: "application/pdf" }) }];
    },
  },
  {
    id: "pdfrotate", group: "pdf", icon: "rotate", iconClass: "clicker-icon",
    name: "Rotate Pages", desc: "Rotate by 90°/180°/270°, or auto-straighten crooked scans",
    accept: "application/pdf", multiple: false,
    runLabel: (v) => (v.degrees === "auto" ? "Straighten" : "Rotate"),
    fields: [{ key: "degrees", label: "Rotate by", type: "select", options: [
      { value: "90", label: "90° clockwise" }, { value: "180", label: "180°" }, { value: "270", label: "90° counter-clockwise" },
      { value: "auto", label: "Auto-straighten (detect the angle, per page)" },
    ], default: "90" }],
    note: "Auto-straighten only rasterizes a page that actually needs correcting (text stops being selectable on THAT page) — a page that's already aligned is left exactly as it was, vector text and all. It can't tell upside-down from right-side-up, so it only fixes a crooked scan, not a sideways/upside-down one.",
    async run(files, v, { onProgress }) {
      const file = files[0];
      if (v.degrees !== "auto") {
        const doc = await loadPdfLib(file);
        const deg = parseInt(v.degrees, 10) || 90;
        doc.getPages().forEach((p) => p.setRotation(window.PDFLib.degrees((p.getRotation().angle + deg) % 360)));
        const bytes = await doc.save();
        return [{ name: `${baseName(file.name)}-rotated.pdf`, blob: new Blob([bytes], { type: "application/pdf" }) }];
      }
      const jsDoc = await loadPdfJs(file);
      const libSrc = await loadPdfLib(file);
      const { PDFDocument } = window.PDFLib;
      const out = await PDFDocument.create();
      let straightened = 0;
      for (let i = 1; i <= jsDoc.numPages; i++) {
        onProgress(`Checking page ${i} of ${jsDoc.numPages}…`);
        const page = await jsDoc.getPage(i);
        const canvas = await renderPdfPageToCanvas(page, 1.5);
        const skew = detectSkewAngle(canvas);
        if (skew && Math.abs(skew.angle) >= 0.3) {
          onProgress(`Straightening page ${i} by ${skew.angle}°…`);
          const corrected = rotateCanvasByAngle(canvas, canvas.width, canvas.height, skew.angle);
          const blob = await canvasToBlob(corrected, "image/jpeg", 0.92);
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const img = await out.embedJpg(bytes);
          out.addPage([corrected.width, corrected.height]).drawImage(img, { x: 0, y: 0, width: corrected.width, height: corrected.height });
          straightened++;
        } else {
          const [copied] = await out.copyPages(libSrc, [i - 1]);
          out.addPage(copied);
        }
      }
      const bytes = await out.save();
      const suffix = straightened ? `-straightened.pdf` : `-checked.pdf`;
      // The generic "Done" progress text is about to overwrite whatever
      // onProgress last said, so the per-page summary goes out as a toast
      // instead — it's the one thing about this run worth keeping visible.
      window.nkToast && window.nkToast(
        straightened ? `Straightened ${straightened} of ${jsDoc.numPages} page(s).` : "No pages needed straightening — they already looked aligned.",
        "info",
      );
      return [{ name: `${baseName(file.name)}${suffix}`, blob: new Blob([bytes], { type: "application/pdf" }) }];
    },
  },
  {
    id: "pdforganize", group: "pdf", icon: "list", iconClass: "batch-icon",
    name: "Reorder / Delete Pages", desc: "Move pages up/down, or remove ones you don't need",
    accept: "application/pdf", multiple: false, interactive: "pages", runLabel: "Save Changes",
    fields: [],
    async run(files, v, { getPageIndices }) {
      const indices = getPageIndices();
      if (!indices || !indices.length) throw new Error("At least one page must remain");
      const file = files[0];
      const src = await loadPdfLib(file);
      const { PDFDocument } = window.PDFLib;
      const doc = await PDFDocument.create();
      const pages = await doc.copyPages(src, indices);
      pages.forEach((p) => doc.addPage(p));
      const bytes = await doc.save();
      return [{ name: `${baseName(file.name)}-organized.pdf`, blob: new Blob([bytes], { type: "application/pdf" }) }];
    },
  },
  {
    id: "pdftext", group: "pdf", icon: "ocr", iconClass: "fill-icon",
    name: "Extract Text", desc: "Pull the text layer out of one or more PDFs",
    accept: "application/pdf", multiple: true, runLabel: "Extract",
    fields: [], resultsAsText: true,
    note: "Only works on PDFs that already have real text in them (not a scan) — for a scanned/image PDF, use PDF → JPG followed by the OCR Image tool instead.",
    async run(files, v, { onProgress }) {
      const out = [];
      for (const file of files) {
        const doc = await loadPdfJs(file);
        const lines = [];
        for (let i = 1; i <= doc.numPages; i++) {
          onProgress(`${files.length > 1 ? file.name + " — " : ""}Reading page ${i} of ${doc.numPages}…`);
          const page = await doc.getPage(i);
          const content = await page.getTextContent();
          lines.push(content.items.map((it) => it.str).join(" "));
        }
        const text = lines.join("\n\n");
        if (!text.trim()) throw new Error(`${file.name} has no extractable text — it's likely a scanned image`);
        out.push({ name: `${baseName(file.name)}.txt`, blob: new Blob([text], { type: "text/plain" }) });
      }
      return out;
    },
  },
  {
    id: "pdfflatten", group: "pdf", icon: "merge", iconClass: "issuedate-icon",
    name: "Flatten Form Fields", desc: "Merge any fillable form fields into the page so they can't be edited further",
    accept: "application/pdf", multiple: false, runLabel: "Flatten",
    fields: [],
    async run(files) {
      const file = files[0];
      const doc = await loadPdfLib(file);
      const form = doc.getForm();
      if (!form.getFields().length) throw new Error("This PDF has no fillable form fields to flatten");
      form.flatten();
      const bytes = await doc.save();
      return [{ name: `${baseName(file.name)}-flattened.pdf`, blob: new Blob([bytes], { type: "application/pdf" }) }];
    },
  },
  {
    id: "text2pdf", group: "pdf", icon: "text2pdf", iconClass: "ocr-icon",
    name: "Text → PDF", desc: "Turn typed or pasted text into a simple PDF",
    noFile: true, canRun: (v) => !!(v.text || "").trim(), runLabel: "Create PDF",
    fields: [
      { key: "text", label: "Text content", type: "textarea", placeholder: "Type or paste your text here…" },
      { key: "size", label: "Font size", type: "select", options: [
        { value: "10", label: "Small" }, { value: "12", label: "Medium" }, { value: "16", label: "Large" },
      ], default: "12" },
    ],
    async run(files, v) {
      const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const size = parseInt(v.size, 10) || 12;
      const [pw, ph] = [595.28, 841.89]; // A4
      const margin = 50, lineHeight = size * 1.35, maxWidth = pw - margin * 2;

      // Manual word-wrap — pdf-lib measures text but never wraps it for you.
      const wrapped = [];
      (v.text || "").split(/\r?\n/).forEach((paragraph) => {
        if (!paragraph) { wrapped.push(""); return; }
        let line = "";
        paragraph.split(" ").forEach((word) => {
          const trial = line ? line + " " + word : word;
          if (font.widthOfTextAtSize(trial, size) > maxWidth && line) { wrapped.push(line); line = word; }
          else line = trial;
        });
        wrapped.push(line);
      });

      let page = doc.addPage([pw, ph]);
      let y = ph - margin;
      wrapped.forEach((line) => {
        if (y < margin) { page = doc.addPage([pw, ph]); y = ph - margin; }
        if (line) page.drawText(line, { x: margin, y, size, font, color: rgb(0, 0, 0) });
        y -= lineHeight;
      });
      const bytes = await doc.save();
      return [{ name: "text.pdf", blob: new Blob([bytes], { type: "application/pdf" }) }];
    },
  },
  {
    id: "pdfwatermark", group: "pdf", icon: "droplet", iconClass: "vaccine-icon",
    name: "Watermark / Page Numbers", desc: "Stamp text and/or page numbers onto every page",
    accept: "application/pdf", multiple: false, runLabel: "Apply",
    fields: [
      { key: "watermark", label: "Watermark text (optional)", type: "text", placeholder: "e.g. DRAFT", full: true },
      { key: "pageNumbers", label: "Page numbers", type: "select", options: [
        { value: "none", label: "Off" }, { value: "on", label: "On (bottom center)" },
      ], default: "none" },
    ],
    async run(files, v) {
      if (!v.watermark?.trim() && v.pageNumbers !== "on") throw new Error("Add watermark text or turn on page numbers");
      const { StandardFonts, rgb, degrees: deg } = window.PDFLib;
      const file = files[0];
      const doc = await loadPdfLib(file);
      const font = await doc.embedFont(StandardFonts.HelveticaBold);
      const pages = doc.getPages();
      pages.forEach((page, i) => {
        const { width, height } = page.getSize();
        if (v.watermark?.trim()) {
          const size = Math.min(width, height) / 8;
          const textWidth = font.widthOfTextAtSize(v.watermark, size);
          page.drawText(v.watermark, {
            x: (width - textWidth) / 2, y: height / 2, size, font,
            color: rgb(0.6, 0.6, 0.6), opacity: 0.35, rotate: deg(35),
          });
        }
        if (v.pageNumbers === "on") {
          const label = String(i + 1);
          page.drawText(label, { x: width / 2 - font.widthOfTextAtSize(label, 10) / 2, y: 22, size: 10, font, color: rgb(0.3, 0.3, 0.3) });
        }
      });
      const bytes = await doc.save();
      return [{ name: `${baseName(file.name)}-marked.pdf`, blob: new Blob([bytes], { type: "application/pdf" }) }];
    },
  },

  // ── JPG / Image Tools ──────────────────────────────────────────────────
  {
    id: "imgcompress", group: "jpg", icon: "compress", iconClass: "reload-icon",
    name: "Compress Image", desc: "Reduce file size by re-encoding as JPEG",
    accept: "image/jpeg,image/png,image/webp", multiple: true, runLabel: "Compress",
    fields: [{ key: "quality", label: "Quality", type: "select", options: QUALITY_OPTIONS, default: "0.75" }],
    resultsAsGrid: true,
    async run(files, v, { onProgress }) {
      const out = [];
      for (let i = 0; i < files.length; i++) {
        onProgress(`Compressing ${files[i].name}…`);
        const { blob } = await imageToJpegBlob(files[i], parseFloat(v.quality));
        out.push({ name: `${baseName(files[i].name)}-compressed.jpg`, blob });
      }
      return out;
    },
  },
  {
    id: "imgresize", group: "jpg", icon: "resize", iconClass: "vaccine-icon",
    name: "Resize Image", desc: "Scale down to a maximum width/height",
    accept: "image/jpeg,image/png,image/webp", multiple: true, runLabel: "Resize",
    fields: [
      { key: "width", label: "Max width (px)", type: "number", placeholder: "e.g. 1920" },
      { key: "height", label: "Max height (px)", type: "number", placeholder: "leave blank = auto" },
    ],
    note: "Leave one blank to scale it automatically and keep the image's proportions.",
    resultsAsGrid: true,
    async run(files, v, { onProgress }) {
      const maxW = parseInt(v.width, 10) || 0, maxH = parseInt(v.height, 10) || 0;
      if (!maxW && !maxH) throw new Error("Set at least a max width or max height");
      const out = [];
      for (let i = 0; i < files.length; i++) {
        onProgress(`Resizing ${files[i].name}…`);
        const bitmap = await createImageBitmap(files[i]);
        let w = bitmap.width, h = bitmap.height;
        const scale = Math.min(maxW ? maxW / w : Infinity, maxH ? maxH / h : Infinity, 1);
        w = Math.max(1, Math.round(w * scale)); h = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
        bitmap.close && bitmap.close();
        const isPng = files[i].type === "image/png";
        const blob = await canvasToBlob(canvas, isPng ? "image/png" : "image/jpeg", isPng ? undefined : 0.9);
        out.push({ name: `${baseName(files[i].name)}-resized.${isPng ? "png" : "jpg"}`, blob });
      }
      return out;
    },
  },
  {
    id: "imgconvert", group: "jpg", icon: "convert", iconClass: "fill-icon",
    name: "Convert Format", desc: "Switch between JPG, PNG and WebP",
    accept: "image/jpeg,image/png,image/webp", multiple: true, runLabel: "Convert",
    fields: [{ key: "format", label: "Convert to", type: "select", options: [
      { value: "image/jpeg", label: "JPG" }, { value: "image/png", label: "PNG" }, { value: "image/webp", label: "WebP" },
    ], default: "image/jpeg" }],
    resultsAsGrid: true,
    async run(files, v, { onProgress }) {
      const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[v.format];
      const out = [];
      for (let i = 0; i < files.length; i++) {
        onProgress(`Converting ${files[i].name}…`);
        const bitmap = await createImageBitmap(files[i]);
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d");
        if (v.format === "image/jpeg") { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); }
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close && bitmap.close();
        const blob = await canvasToBlob(canvas, v.format, v.format === "image/png" ? undefined : 0.92);
        out.push({ name: `${baseName(files[i].name)}.${ext}`, blob });
      }
      return out;
    },
  },
  {
    id: "imgrotate", group: "jpg", icon: "rotate", iconClass: "clicker-icon",
    name: "Rotate / Flip", desc: "Rotate by 90°, flip, or auto-straighten a crooked scan",
    accept: "image/jpeg,image/png,image/webp", multiple: true,
    runLabel: (v) => (v.rotate === "auto" ? "Straighten" : "Rotate"),
    fields: [
      { key: "rotate", label: "Rotate", type: "select", options: [
        { value: "0", label: "None" }, { value: "90", label: "90° clockwise" },
        { value: "180", label: "180°" }, { value: "270", label: "90° counter-clockwise" },
        { value: "auto", label: "Auto-straighten (detect the angle)" },
      ], default: "0" },
      { key: "flip", label: "Flip", type: "select", options: [
        { value: "none", label: "None" }, { value: "h", label: "Horizontal" }, { value: "v", label: "Vertical" },
      ], default: "none" },
    ],
    note: "Auto-straighten looks for straight rows of text and corrects small tilts — it can't tell upside-down from right-side-up (those look identical to it), so it only fixes a crooked scan, not a sideways/upside-down one. Works best on documents; a plain photo may not have enough for it to lock onto.",
    resultsAsGrid: true,
    async run(files, v, { onProgress }) {
      const out = [];
      for (let i = 0; i < files.length; i++) {
        onProgress(`Processing ${files[i].name}…`);
        const bitmap = await createImageBitmap(files[i]);
        let canvas;
        if (v.rotate === "auto") {
          const flat = document.createElement("canvas");
          flat.width = bitmap.width; flat.height = bitmap.height;
          flat.getContext("2d").drawImage(bitmap, 0, 0);
          const skew = detectSkewAngle(flat);
          if (!skew) throw new Error(`Couldn't find a clear angle for ${files[i].name} — try a manual rotation instead`);
          onProgress(`Straightening ${files[i].name} by ${skew.angle}°…`);
          canvas = rotateCanvasByAngle(flat, bitmap.width, bitmap.height, skew.angle);
          if (v.flip !== "none") {
            const flipped = document.createElement("canvas");
            flipped.width = canvas.width; flipped.height = canvas.height;
            const fctx = flipped.getContext("2d");
            fctx.translate(canvas.width / 2, canvas.height / 2);
            fctx.scale(v.flip === "h" ? -1 : 1, v.flip === "v" ? -1 : 1);
            fctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
            canvas = flipped;
          }
        } else {
          const deg = parseInt(v.rotate, 10) || 0;
          const swapped = deg === 90 || deg === 270;
          canvas = document.createElement("canvas");
          canvas.width = swapped ? bitmap.height : bitmap.width;
          canvas.height = swapped ? bitmap.width : bitmap.height;
          const ctx = canvas.getContext("2d");
          ctx.translate(canvas.width / 2, canvas.height / 2);
          ctx.rotate((deg * Math.PI) / 180);
          ctx.scale(v.flip === "h" ? -1 : 1, v.flip === "v" ? -1 : 1);
          ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
        }
        bitmap.close && bitmap.close();
        const isPng = files[i].type === "image/png";
        const blob = await canvasToBlob(canvas, isPng ? "image/png" : "image/jpeg", isPng ? undefined : 0.92);
        out.push({ name: `${baseName(files[i].name)}-edited.${isPng ? "png" : "jpg"}`, blob });
      }
      return out;
    },
  },
  {
    id: "imgcrop", group: "jpg", icon: "crop", iconClass: "issuedate-icon",
    name: "Crop Image", desc: "Drag from corner to corner to select the area to keep — works on a batch too",
    accept: "image/jpeg,image/png,image/webp", multiple: true, interactive: "region", runLabel: "Crop",
    fields: [],
    note: "Drag anywhere on the image to draw the box (drag again elsewhere to redraw it) — against the first image only; with more than one image picked, that same box (as a proportion of each picture) is applied to all of them.",
    resultsAsGrid: true,
    async run(files, v, { getFraction, onProgress }) {
      const frac = getFraction();
      if (!frac) throw new Error("Drag a box over the image to select the area to crop first");
      const out = [];
      for (const file of files) {
        if (files.length > 1) onProgress(`Cropping ${file.name}…`);
        const { blob, ext } = await cropImageToFraction(file, frac);
        out.push({ name: `${baseName(file.name)}-cropped.${ext}`, blob });
      }
      return out;
    },
    // A second, secondary-styled button next to Run — same picked file(s), a
    // different way to land on the crop rectangle: this one ignores the drag
    // box entirely and auto-detects each image's OWN blank margin instead
    // (no shared box needed — that's an independent per-image measurement),
    // for when the trim is the actual goal rather than an arbitrary selection.
    extraActions: [{
      id: "trim", label: "Trim Whitespace",
      async run(files, v, { onProgress }) {
        const out = [];
        for (const file of files) {
          if (files.length > 1) onProgress(`Trimming ${file.name}…`);
          const bitmap = await createImageBitmap(file);
          const flat = document.createElement("canvas");
          flat.width = bitmap.width; flat.height = bitmap.height;
          flat.getContext("2d").drawImage(bitmap, 0, 0);
          bitmap.close && bitmap.close();
          const rect = detectContentBounds(flat, { tolerance: 20 });
          if (!rect) throw new Error(`${file.name} has no blank margin to trim (or is blank all over)`);
          const { blob, ext } = await cropImageToRect(file, rect);
          out.push({ name: `${baseName(file.name)}-trimmed.${ext}`, blob });
        }
        return out;
      },
    }],
  },
  {
    id: "imgblur", group: "jpg", icon: "blur", iconClass: "overlay-icon",
    name: "Blur / Censor Area", desc: "Drag a box over a face, ID number or barcode to hide it",
    accept: "image/jpeg,image/png,image/webp", multiple: false, interactive: "region", runLabel: "Censor",
    fields: [{ key: "strength", label: "Effect strength", type: "select", options: [
      { value: "8", label: "Light" }, { value: "16", label: "Medium" }, { value: "28", label: "Heavy" },
    ], default: "16" }],
    note: "Drag anywhere on the image to draw the box over what needs hiding. Pixelates the selected area rather than a soft blur — a soft blur can sometimes be partly reversed; this genuinely discards the detail underneath.",
    async run(files, v, { getRegion }) {
      const file = files[0];
      const rect = getRegion();
      if (!rect) throw new Error("Drag a box over the area to censor first");
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      const strength = parseInt(v.strength, 10) || 16;
      const sw = Math.max(1, Math.round(rect.width / strength)), sh = Math.max(1, Math.round(rect.height / strength));
      const small = document.createElement("canvas");
      small.width = sw; small.height = sh;
      small.getContext("2d").drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, sw, sh);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(small, 0, 0, sw, sh, rect.x, rect.y, rect.width, rect.height);
      bitmap.close && bitmap.close();
      const isPng = file.type === "image/png";
      const blob = await canvasToBlob(canvas, isPng ? "image/png" : "image/jpeg", isPng ? undefined : 0.92);
      return [{ name: `${baseName(file.name)}-censored.${isPng ? "png" : "jpg"}`, blob }];
    },
  },
  {
    id: "imgfilters", group: "jpg", icon: "filters", iconClass: "batch-icon",
    name: "Brightness / Contrast", desc: "Fix a poorly-lit photo, or convert to grayscale/sepia",
    accept: "image/jpeg,image/png,image/webp", multiple: true, runLabel: "Apply",
    fields: [
      { key: "brightness", label: "Brightness", type: "select", options: [
        { value: "70", label: "Darker" }, { value: "100", label: "Normal" }, { value: "130", label: "Brighter" }, { value: "160", label: "Much brighter" },
      ], default: "100" },
      { key: "contrast", label: "Contrast", type: "select", options: [
        { value: "70", label: "Lower" }, { value: "100", label: "Normal" }, { value: "130", label: "Higher" }, { value: "160", label: "Much higher" },
      ], default: "100" },
      { key: "tone", label: "Tone", type: "select", options: [
        { value: "none", label: "None" }, { value: "grayscale", label: "Grayscale" }, { value: "sepia", label: "Sepia" },
      ], default: "none" },
    ],
    resultsAsGrid: true,
    async run(files, v, { onProgress }) {
      const filter = `brightness(${v.brightness}%) contrast(${v.contrast}%)` + (v.tone === "grayscale" ? " grayscale(100%)" : v.tone === "sepia" ? " sepia(100%)" : "");
      const out = [];
      for (const file of files) {
        onProgress(`Adjusting ${file.name}…`);
        const bitmap = await createImageBitmap(file);
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d");
        ctx.filter = filter;
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close && bitmap.close();
        const isPng = file.type === "image/png";
        const blob = await canvasToBlob(canvas, isPng ? "image/png" : "image/jpeg", isPng ? undefined : 0.92);
        out.push({ name: `${baseName(file.name)}-adjusted.${isPng ? "png" : "jpg"}`, blob });
      }
      return out;
    },
  },
  {
    id: "imgmetadata", group: "jpg", icon: "shield", iconClass: "vaccine-icon",
    name: "Remove Metadata", desc: "Strip camera model, GPS location and other hidden EXIF data",
    accept: "image/jpeg,image/png,image/webp", multiple: true, runLabel: "Clean",
    fields: [],
    note: "Every other image tool here already strips this as a side effect of re-encoding — this one exists for when you don't want to change anything else about the image.",
    resultsAsGrid: true,
    async run(files, v, { onProgress }) {
      const out = [];
      for (const file of files) {
        onProgress(`Cleaning ${file.name}…`);
        const isPng = file.type === "image/png";
        const bitmap = await createImageBitmap(file);
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        canvas.getContext("2d").drawImage(bitmap, 0, 0);
        bitmap.close && bitmap.close();
        const blob = await canvasToBlob(canvas, isPng ? "image/png" : "image/jpeg", isPng ? undefined : 0.95);
        out.push({ name: `${baseName(file.name)}-clean.${isPng ? "png" : "jpg"}`, blob });
      }
      return out;
    },
  },
  {
    id: "imgocr", group: "jpg", icon: "ocr", iconClass: "ocr-icon",
    name: "OCR Image", desc: "Read the text out of a photo, screenshot or scan",
    accept: "image/jpeg,image/png,image/webp", multiple: true, runLabel: "OCR Now",
    fields: [], resultsAsText: true,
    note: "Uses the same OCR you already have set up for Passport scanning — needs your ocr.space key in Settings, and counts against that key's usage.",
    async run(files, v, { onProgress }) {
      const out = [];
      for (const file of files) {
        onProgress(`Reading ${file.name}…`);
        const text = await ocrImage(file);
        out.push({ name: `${baseName(file.name)}-ocr.txt`, blob: new Blob([text], { type: "text/plain" }) });
      }
      return out;
    },
  },
  {
    id: "imgremovebg", group: "jpg", icon: "wand", iconClass: "clicker-icon",
    name: "Remove Background", desc: "Cut a subject out onto a transparent background",
    accept: "image/jpeg,image/png,image/webp", multiple: true, runLabel: "Remove Background",
    fields: [],
    note: "Uses your own remove.bg API key (Settings) — each image counts against remove.bg's own free-tier quota for that key.",
    resultsAsGrid: true,
    async run(files, v, { onProgress }) {
      const out = [];
      for (const file of files) {
        onProgress(`Removing background from ${file.name}…`);
        const blob = await removeBackgroundFromFile(file);
        out.push({ name: `${baseName(file.name)}-nobg.png`, blob });
      }
      return out;
    },
  },
];

// ── "Apply another tool" — chaining a result into a next tool ──────────────
// Which tools can sensibly take THESE results as input: every result's MIME
// type has to be in the candidate tool's own `accept` list (a tool that only
// takes PDFs never shows up for a batch of JPEGs), and a tool that can't take
// more than one file (multiple: false) only shows up when there's exactly one
// result to hand it — never for a batch. noFile tools (Text -> PDF) never take
// an input file at all, so they're never offered here.
function compatibleChainTools(results) {
  if (!results || !results.length) return [];
  const types = [...new Set(results.map((r) => r.blob.type))];
  return TOOLS.filter((t) => {
    if (t.noFile) return false;
    if (results.length > 1 && !t.multiple) return false;
    const accepted = t.accept ? t.accept.split(",").map((s) => s.trim()) : [];
    return types.every((ty) => accepted.includes(ty));
  });
}
// Blob results -> real File objects, so they can be handed straight to a
// panel's own setFiles the same way a picked/dropped file would be.
function resultsToFiles(results) {
  return results.map((r) => new File([r.blob], r.name, { type: r.blob.type }));
}

// ── Interactive region selector (Crop, Blur/Pixelate) ───────────────────────
// One draggable/resizable rectangle over a rendered preview of the picked
// image. Tracked in DISPLAYED pixels while dragging; converted to the
// image's NATURAL (full-resolution) pixels only when read, so the actual
// crop/blur math always happens against the real image regardless of how
// small the card renders the preview.
function buildRegionSelector() {
  const wrap = document.createElement("div");
  wrap.className = "ft-region-wrap";
  const img = document.createElement("img");
  img.className = "ft-region-img";
  const box = document.createElement("div");
  box.className = "ft-region-box";
  box.hidden = true; // nothing drawn until the user drags one out
  const handle = document.createElement("div");
  handle.className = "ft-region-handle";
  box.appendChild(handle);
  wrap.append(img, box);

  let rect = null;
  function clamp() {
    const iw = img.clientWidth, ih = img.clientHeight;
    rect.w = Math.max(20, Math.min(rect.w, iw - 4));
    rect.h = Math.max(20, Math.min(rect.h, ih - 4));
    rect.x = Math.max(0, Math.min(rect.x, iw - rect.w));
    rect.y = Math.max(0, Math.min(rect.y, ih - rect.h));
  }
  function paint() {
    box.style.left = rect.x + "px"; box.style.top = rect.y + "px";
    box.style.width = rect.w + "px"; box.style.height = rect.h + "px";
  }
  function dragFrom(e0, onMove) {
    e0.preventDefault();
    const startX = e0.clientX, startY = e0.clientY, start = { ...rect };
    const move = (e) => { onMove(e.clientX - startX, e.clientY - startY, start); clamp(); paint(); };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  const clampPt = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  // Draw a brand-new box from scratch, point to point — no default box shown
  // on load; dragging anywhere on the image (that isn't the current box)
  // starts a fresh selection and replaces whatever was there before. This is
  // the same click-drag-release gesture as Photoshop/GIMP's marquee or the
  // OS's own screenshot-region picker, which is why the cursor over the
  // image is a crosshair (see .ft-region-img in popup.css) rather than the
  // default arrow — it signals "click and drag to select" before the user
  // even touches it, instead of them having to discover a pre-made box first.
  function startCreate(e0) {
    e0.preventDefault();
    const imgRect = img.getBoundingClientRect();
    const startX = clampPt(e0.clientX - imgRect.left, 0, img.clientWidth);
    const startY = clampPt(e0.clientY - imgRect.top, 0, img.clientHeight);
    rect = { x: startX, y: startY, w: 0, h: 0 };
    box.hidden = false;
    paint();
    const move = (e) => {
      const curX = clampPt(e.clientX - imgRect.left, 0, img.clientWidth);
      const curY = clampPt(e.clientY - imgRect.top, 0, img.clientHeight);
      rect.x = Math.min(startX, curX); rect.y = Math.min(startY, curY);
      rect.w = Math.abs(curX - startX); rect.h = Math.abs(curY - startY);
      paint();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      // A drag too small to be an intentional selection (a stray click) —
      // rather than leaving a near-invisible sliver box behind, treat it as
      // no selection at all, same as before anything was drawn.
      if (rect.w < 10 || rect.h < 10) { rect = null; box.hidden = true; return; }
      clamp(); paint();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  wrap.addEventListener("pointerdown", (e) => startCreate(e));
  box.addEventListener("pointerdown", (e) => {
    if (e.target === handle) return;
    e.stopPropagation(); // don't also let this reach wrap's startCreate — dragging the box MOVES it, doesn't start a new one
    dragFrom(e, (dx, dy, start) => { rect.x = start.x + dx; rect.y = start.y + dy; });
  });
  handle.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    dragFrom(e, (dx, dy, start) => { rect.w = start.w + dx; rect.h = start.h + dy; });
  });

  function load(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      img.onload = () => {
        // No default box — the user draws their own (see startCreate above).
        rect = null;
        box.hidden = true;
        URL.revokeObjectURL(url);
        resolve();
      };
      img.src = url;
    });
  }
  function getRect() {
    if (!rect) return null;
    const sx = img.naturalWidth / img.clientWidth, sy = img.naturalHeight / img.clientHeight;
    return { x: Math.round(rect.x * sx), y: Math.round(rect.y * sy), width: Math.round(rect.w * sx), height: Math.round(rect.h * sy) };
  }
  // Same box, expressed as a 0..1 fraction of the loaded image instead of its
  // pixels — how a shared selection carries over to OTHER images in a batch
  // (see cropImageToFraction above). Display and natural pixels give the same
  // ratio, so this doesn't need img.naturalWidth/Height at all.
  function getFraction() {
    if (!rect) return null;
    const iw = img.clientWidth, ih = img.clientHeight;
    return { fx: rect.x / iw, fy: rect.y / ih, fw: rect.w / iw, fh: rect.h / ih };
  }
  return { el: wrap, load, getRect, getFraction };
}

// ── Interactive page manager (Reorder / Delete Pages) ───────────────────────
// Renders every page of the picked PDF as a small thumbnail (reusing the
// same renderPdfPageToCanvas as PDF -> JPG). Move up/down + delete, same
// chip-list idiom as the reorderable file lists above, just applied to
// pages instead of files.
function buildPageManager() {
  const wrap = document.createElement("div");
  wrap.className = "ft-pages";
  let pages = [];

  function render() {
    wrap.textContent = "";
    pages.forEach((p, i) => {
      const item = document.createElement("div"); item.className = "ft-page-item";
      const img = document.createElement("img"); img.className = "ft-page-thumb"; img.src = p.canvas.toDataURL("image/jpeg", 0.6);
      const num = document.createElement("div"); num.className = "ft-page-num"; num.textContent = "Page " + (p.index + 1);
      const controls = document.createElement("div"); controls.className = "ft-page-controls";
      const up = document.createElement("button"); up.type = "button"; up.className = "ft-file-move"; up.innerHTML = svg("up", 11);
      up.title = "Move up"; up.disabled = i === 0;
      up.addEventListener("click", () => { const n = [...pages]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; pages = n; render(); });
      const down = document.createElement("button"); down.type = "button"; down.className = "ft-file-move"; down.innerHTML = svg("down", 11);
      down.title = "Move down"; down.disabled = i === pages.length - 1;
      down.addEventListener("click", () => { const n = [...pages]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; pages = n; render(); });
      const del = document.createElement("button"); del.type = "button"; del.className = "ft-file-del"; del.innerHTML = svg("trash", 11);
      del.title = "Delete this page"; del.addEventListener("click", () => { pages = pages.filter((_, j) => j !== i); render(); });
      controls.append(up, down, del);
      item.append(img, num, controls);
      wrap.appendChild(item);
    });
  }
  async function load(file) {
    wrap.textContent = "Loading pages…";
    const doc = await loadPdfJs(file);
    pages = [];
    for (let i = 0; i < doc.numPages; i++) {
      const page = await doc.getPage(i + 1);
      pages.push({ index: i, canvas: await renderPdfPageToCanvas(page, 0.35) });
    }
    render();
  }
  const getIndices = () => pages.map((p) => p.index);
  return { el: wrap, load, getIndices };
}

// ── Grid button — the home screen for each sub-tab ─────────────────────────
// Just an icon + label; clicking it is handled by the bootstrap's morph-open
// logic below, not by this function (it doesn't know about the detail panel).
function buildToolButton(tool) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ft-grid-btn";
  btn.dataset.toolId = tool.id;
  btn.title = tool.desc;
  btn.innerHTML = `
    <div class="module-icon ${tool.iconClass} ft-grid-icon">${svg(tool.icon, 17)}</div>
    <div class="ft-grid-label">${tool.name}</div>`;
  return btn;
}

// ── Chain grid — "Apply another tool"'s own screen ──────────────────────────
// A second, filtered copy of the same grid-of-buttons home screen, not a
// dropdown list — clicking a tile here morphs further in exactly like the
// main grid does, just starting from the results just produced instead of a
// freshly picked file. onPick(tool, buttonEl) / onBack() are wired by the
// bootstrap, which is the part that actually knows how to navigate.
function buildChainGridPanel(results, onPick, onBack) {
  const wrap = document.createElement("div");
  wrap.className = "ft-panel ft-chain-panel";

  const head = document.createElement("div");
  head.className = "ft-panel-head";
  const backBtn = document.createElement("button");
  backBtn.type = "button"; backBtn.className = "ft-back-btn"; backBtn.innerHTML = svg("back", 15);
  backBtn.title = "Back (Backspace or Alt+←)";
  backBtn.addEventListener("click", () => onBack());
  head.innerHTML = `
    <div class="module-icon batch-icon">${svg("wand", 14)}</div>
    <div class="module-info">
      <div class="module-name">Apply another tool</div>
      <div class="module-desc">Pick a tool to run on ${results.length > 1 ? `these ${results.length} files` : "this file"}</div>
    </div>`;
  head.prepend(backBtn);

  const body = document.createElement("div");
  body.className = "ft-tool-body";
  const compat = compatibleChainTools(results);
  if (!compat.length) {
    const hint = document.createElement("div");
    hint.className = "ft-hint";
    hint.textContent = "No other tool here currently accepts this result as input.";
    body.appendChild(hint);
  } else {
    const grid = document.createElement("div");
    grid.className = "ft-grid";
    compat.forEach((tool) => {
      const btn = buildToolButton(tool);
      btn.addEventListener("click", () => onPick(tool, btn));
      grid.appendChild(btn);
    });
    body.appendChild(grid);
  }
  wrap.append(head, body);
  return wrap;
}

// ── Detail panel: file picker + fields + run + results ──────────────────────
// Opened full-width for exactly one tool at a time (see the bootstrap's
// openTool/closeTool) — deliberately not a list of many independently
// expandable cards. That one-tool-at-a-time model is what makes "drop a file
// onto the popup" unambiguous: whichever tool's panel is open is the only
// thing listening for it, so there's never a question of which tool a drop
// was meant for. Both the small drop-zone AND the panel as a whole accept a
// drop; either way it calls stopPropagation() so it can never also reach
// popup/bulk.js's own document-level drop listener (Bulk Passport Parser),
// which used to swallow every drop in the whole popup before this existed.

function buildToolPanel(tool, panelOpts) {
  const card = document.createElement("div");
  card.className = "ft-panel";

  const head = document.createElement("div");
  head.className = "ft-panel-head";
  const backBtn = document.createElement("button");
  backBtn.type = "button"; backBtn.className = "ft-back-btn"; backBtn.innerHTML = svg("back", 15);
  backBtn.title = "Back (Backspace or Alt+←)"; backBtn.addEventListener("click", () => panelOpts.onBack());
  head.innerHTML = `
    <div class="module-icon ${tool.iconClass}">${svg(tool.icon, 14)}</div>
    <div class="module-info">
      <div class="module-name">${tool.name}</div>
      <div class="module-desc">${tool.desc}</div>
    </div>`;
  head.prepend(backBtn);

  const body = document.createElement("div");
  body.className = "ft-tool-body";

  let files = [];
  const values = {};
  tool.fields.forEach((f) => { values[f.key] = f.default !== undefined ? f.default : ""; });

  // A tool with no file input at all (Text -> PDF) can run once its fields
  // have what they need; every other tool needs at least one file.
  const canRun = () => (tool.noFile ? (tool.canRun ? !!tool.canRun(values) : true) : !!files.length);
  const refreshRunEnabled = () => { actionBtns.forEach((b) => { b.disabled = !canRun(); }); };

  // Region selector (Crop, Blur) / page manager (Reorder-Delete Pages) —
  // only built for tools that declare them; everyone else gets neither.
  const region = tool.interactive === "region" ? buildRegionSelector() : null;
  const pageMgr = tool.interactive === "pages" ? buildPageManager() : null;

  // File picker (skipped entirely for noFile tools)
  let input = null, drop = null, fileList = null, setFiles = () => {};
  if (!tool.noFile) {
    input = document.createElement("input");
    input.type = "file"; input.accept = tool.accept; input.multiple = !!tool.multiple; input.hidden = true;

    drop = document.createElement("div");
    drop.className = "ft-drop";
    drop.innerHTML = `${svg("upload", 22)}<span class="ft-drop-label">Click to choose ${tool.multiple ? "file(s)" : "a file"}</span><span class="ft-drop-hint">${tool.accept.includes("pdf") ? "PDF" : "JPG, PNG or WebP"}</span>`;
    drop.addEventListener("click", () => input.click());
    ["dragover", "dragenter"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.add("ft-drop-over"); }));
    ["dragleave", "dragend", "drop"].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove("ft-drop-over")));
    drop.addEventListener("drop", (e) => {
      e.preventDefault(); e.stopPropagation();
      const dropped = [...(e.dataTransfer.files || [])];
      if (dropped.length) setFiles(tool.multiple ? [...files, ...dropped] : [dropped[0]]);
    });

    fileList = document.createElement("div");
    fileList.className = "ft-files";

    const renderFileList = () => {
      fileList.textContent = "";
      files.forEach((f, i) => {
        const row = document.createElement("div");
        row.className = "ft-file";
        const name = document.createElement("span"); name.className = "ft-file-name"; name.textContent = f.name; name.title = f.name;
        const size = document.createElement("span"); size.className = "ft-file-size"; size.textContent = formatBytes(f.size);
        row.append(name, size);
        if (tool.reorder && files.length > 1) {
          const up = document.createElement("button"); up.type = "button"; up.className = "ft-file-move"; up.innerHTML = svg("up", 12);
          up.title = "Move up"; up.disabled = i === 0;
          up.addEventListener("click", () => { const n = [...files]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; setFiles(n); });
          const down = document.createElement("button"); down.type = "button"; down.className = "ft-file-move"; down.innerHTML = svg("down", 12);
          down.title = "Move down"; down.disabled = i === files.length - 1;
          down.addEventListener("click", () => { const n = [...files]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; setFiles(n); });
          row.append(up, down);
        }
        const del = document.createElement("button"); del.type = "button"; del.className = "ft-file-del"; del.innerHTML = svg("trash", 12);
        del.title = "Remove"; del.addEventListener("click", () => setFiles(files.filter((_, j) => j !== i)));
        row.append(del);
        fileList.appendChild(row);
      });
      refreshRunEnabled();
    };
    setFiles = (next) => {
      files = next;
      renderFileList();
      // Region/page UI always reflects whichever ONE file is currently picked.
      if (region) { if (files[0]) region.load(files[0]); else region.el.replaceChildren(); }
      if (pageMgr) { if (files[0]) pageMgr.load(files[0]).catch((err) => window.nkToast && window.nkToast("Could not read that PDF: " + err.message, "error")); else pageMgr.el.replaceChildren(); }
    };
    input.addEventListener("change", () => { if (input.files.length) setFiles(tool.multiple ? [...files, ...input.files] : [input.files[0]]); input.value = ""; });
  }

  // Option fields
  const fieldsWrap = document.createElement("div");
  fieldsWrap.className = "ft-fields";
  function renderFields() {
    fieldsWrap.textContent = "";
    tool.fields.forEach((f) => {
      if (f.showIf && !f.showIf(values)) return;
      const wrap = document.createElement("div");
      wrap.className = "rule-field" + (f.full || f.type === "textarea" ? " full" : "");
      const label = document.createElement("label"); label.textContent = f.label;
      let control;
      if (f.type === "select") {
        control = document.createElement("select");
        f.options.forEach((o) => { const opt = document.createElement("option"); opt.value = o.value; opt.textContent = o.label; control.appendChild(opt); });
      } else if (f.type === "textarea") {
        control = document.createElement("textarea");
        control.className = "ft-textarea"; control.rows = 6;
        if (f.placeholder) control.placeholder = f.placeholder;
      } else {
        control = document.createElement("input");
        control.type = f.type === "number" ? "number" : "text";
        if (f.placeholder) control.placeholder = f.placeholder;
      }
      control.value = values[f.key];
      control.addEventListener("change", (e) => {
        values[f.key] = e.target.value;
        if (tool.fields.some((x) => x.showIf)) renderFields();
        refreshRunEnabled();
        updateRunLabel();
      });
      // A no-file tool's fields are its ONLY signal for whether Run makes
      // sense — react as the user types, not just on blur/change.
      if (tool.noFile) control.addEventListener("input", (e) => { values[f.key] = e.target.value; refreshRunEnabled(); });
      wrap.append(label, control);
      fieldsWrap.appendChild(wrap);
    });
    if (tool.note) {
      const note = document.createElement("div"); note.className = "ft-note"; note.textContent = tool.note;
      fieldsWrap.appendChild(note);
    }
  }

  // Keyboard shortcut row — only for a tool that declares one (currently
  // just Element Screenshot, via chrome.commands so it can fire on ANY page
  // without a persistent content script). Chrome owns the actual key
  // binding for a global command — there's no API for an extension to SET
  // it — so unlike the Auto Clicker/BRN/Talab Copy hotkeys (plain in-page
  // keydown listeners this extension fully controls, freely re-recordable
  // in their own settings), this can only DISPLAY the live binding and hand
  // the user off to Chrome's own editor to change it.
  let hotkeyRow = null;
  if (tool.commandId) {
    hotkeyRow = document.createElement("div");
    hotkeyRow.className = "ft-hotkey-row";
    const label = document.createElement("span"); label.className = "ft-hotkey-label"; label.textContent = "Keyboard shortcut:";
    const kbd = document.createElement("kbd"); kbd.className = "ft-hotkey-kbd"; kbd.textContent = "…";
    const changeBtn = document.createElement("button");
    changeBtn.type = "button"; changeBtn.className = "wf-mini"; changeBtn.textContent = "Change";
    changeBtn.title = "Opens Chrome's own keyboard-shortcuts page — Chrome manages the actual key binding, not this extension";
    changeBtn.addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));
    hotkeyRow.append(label, kbd, changeBtn);
    const refreshHotkey = () => {
      chrome.commands.getAll((cmds) => {
        const cmd = (cmds || []).find((c) => c.name === tool.commandId);
        kbd.textContent = (cmd && cmd.shortcut) || "Not set";
      });
    };
    refreshHotkey();
    // Chrome fires no event for "the binding changed" — re-check whenever
    // the popup regains focus, since that's exactly when someone would be
    // coming back from chrome://extensions/shortcuts having just changed it.
    window.addEventListener("focus", refreshHotkey);
  }

  // Run + progress + results
  const runRow = document.createElement("div"); runRow.className = "ft-run-row";
  const runBtn = document.createElement("button");
  runBtn.type = "button"; runBtn.className = "act-btn ft-run-btn";
  // runLabel is either a fixed string ("Compress") or a function of the
  // current field values, for a tool whose action reads differently
  // depending on the mode picked (Rotate Pages says "Straighten" only once
  // Auto-straighten is actually selected, "Rotate" otherwise).
  const updateRunLabel = () => { runBtn.textContent = typeof tool.runLabel === "function" ? tool.runLabel(values) : (tool.runLabel || "Run"); };
  updateRunLabel();
  runBtn.disabled = true;
  // A tool can offer secondary, equally-one-click ways to produce its
  // output from the SAME picked file (Crop Image's "Trim Whitespace" button
  // ignores the dragged region and auto-detects one instead) — same file
  // requirement, same progress/results/download handling, just a different
  // run() to call.
  const actionBtns = [runBtn];
  const extraBtns = (tool.extraActions || []).map((action) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "wf-mini ft-extra-btn"; b.textContent = action.label;
    b.disabled = true;
    actionBtns.push(b);
    return { el: b, action };
  });
  const progress = document.createElement("div"); progress.className = "ft-progress";
  runRow.append(runBtn, ...extraBtns.map((e) => e.el), progress);

  const results = document.createElement("div");
  results.className = "ft-results" + (tool.resultsAsGrid ? " ft-results-grid" : "");
  // Nothing downloads on its own anymore — one result gets its own clear
  // Download button here (same weight as Run, since it's now THE way to get
  // the file); more than one gets the individually/.zip pair instead. Every
  // result item also keeps its own small download icon regardless (see
  // renderResults) for "just this one out of the batch".
  const resultsActions = document.createElement("div"); resultsActions.className = "ft-results-actions"; resultsActions.style.display = "none";
  const dlOneBtn = document.createElement("button"); dlOneBtn.type = "button"; dlOneBtn.className = "act-btn ft-dl-one-btn"; dlOneBtn.textContent = "Download";
  const dlEachBtn = document.createElement("button"); dlEachBtn.type = "button"; dlEachBtn.className = "wf-mini"; dlEachBtn.textContent = "Download individually";
  const dlZipBtn = document.createElement("button"); dlZipBtn.type = "button"; dlZipBtn.className = "wf-mini"; dlZipBtn.textContent = "Download as .zip";
  // One button, whether there's a single result or a whole batch — it hands
  // ALL of lastResults on to whichever next tool gets picked (see
  // buildChainGridPanel / the bootstrap's openChainGrid). Hidden whenever
  // nothing currently open here could take these results as input.
  const applyBtn = document.createElement("button"); applyBtn.type = "button"; applyBtn.className = "wf-mini ft-apply-btn"; applyBtn.textContent = "Apply another tool";
  applyBtn.addEventListener("click", () => panelOpts.onChain(applyBtn, lastResults));
  resultsActions.append(dlOneBtn, dlEachBtn, dlZipBtn, applyBtn);

  let lastResults = [];
  function renderResults() {
    results.textContent = "";
    lastResults.forEach((r) => {
      const item = document.createElement("div"); item.className = "ft-result";
      if (tool.resultsAsGrid && r.blob.type.startsWith("image/")) {
        const img = document.createElement("img");
        img.className = "ft-result-thumb"; img.src = URL.createObjectURL(r.blob); img.alt = r.name;
        item.appendChild(img);
      }
      const info = document.createElement("div"); info.className = "ft-result-info";
      const name = document.createElement("div"); name.className = "ft-result-name"; name.textContent = r.name; name.title = r.name;
      const size = document.createElement("div"); size.className = "ft-result-size"; size.textContent = formatBytes(r.blob.size);
      info.append(name, size);
      if (tool.resultsAsText) {
        const ta = document.createElement("textarea");
        ta.className = "ft-result-textbox"; ta.readOnly = true; ta.rows = 5;
        r.blob.text().then((t) => { ta.value = t; });
        info.appendChild(ta);
      }
      const actions = document.createElement("div"); actions.className = "ft-result-btns";
      if (tool.resultsAsText) {
        const copyBtn = document.createElement("button"); copyBtn.type = "button"; copyBtn.className = "wf-mini wf-icon-btn"; copyBtn.innerHTML = svg("copy", 12);
        copyBtn.title = "Copy text";
        copyBtn.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(await r.blob.text());
            copyBtn.innerHTML = svg("check", 12);
            setTimeout(() => { copyBtn.innerHTML = svg("copy", 12); }, 1200);
          } catch (_) { window.nkToast && window.nkToast("Couldn't copy — select the text and copy it manually.", "error"); }
        });
        actions.appendChild(copyBtn);
      }
      const dl = document.createElement("button"); dl.type = "button"; dl.className = "wf-mini wf-icon-btn ft-result-dl"; dl.innerHTML = svg("download", 12);
      dl.title = "Download"; dl.addEventListener("click", () => downloadBlob(r.blob, r.name));
      actions.appendChild(dl);
      item.append(info, actions);
      results.appendChild(item);
    });
    resultsActions.style.display = lastResults.length >= 1 ? "flex" : "none";
    dlOneBtn.style.display = lastResults.length === 1 ? "" : "none";
    dlEachBtn.style.display = lastResults.length > 1 ? "" : "none";
    dlZipBtn.style.display = lastResults.length > 1 ? "" : "none";
    applyBtn.style.display = compatibleChainTools(lastResults).length ? "" : "none";
  }
  const zipName = tool.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".zip";
  dlOneBtn.addEventListener("click", () => lastResults[0] && downloadBlob(lastResults[0].blob, lastResults[0].name));
  dlEachBtn.addEventListener("click", () => downloadEach(lastResults));
  dlZipBtn.addEventListener("click", async () => {
    dlZipBtn.disabled = true; dlZipBtn.textContent = "Zipping…";
    try { await downloadAsZip(lastResults, zipName); }
    finally { dlZipBtn.disabled = false; dlZipBtn.textContent = "Download as .zip"; }
  });

  // Shared by the main Run button and any extraActions button — same
  // progress/results/error handling regardless of which run() produced them.
  async function runAndShow(runFn) {
    actionBtns.forEach((b) => { b.disabled = true; });
    progress.className = "ft-progress"; progress.textContent = "Working…";
    results.textContent = ""; lastResults = []; resultsActions.style.display = "none";
    try {
      const opts = {
        onProgress: (msg) => { progress.textContent = msg; },
        getRegion: () => region && region.getRect(),
        getFraction: () => region && region.getFraction(),
        getPageIndices: () => pageMgr && pageMgr.getIndices(),
      };
      const out = dedupeNames(await runFn(files, values, opts));
      lastResults = out;
      renderResults();
      progress.className = "ft-progress ft-progress-ok";
      progress.textContent = out.length > 1 ? `Done — ${out.length} file(s) ready` : "Done";
    } catch (err) {
      progress.className = "ft-progress ft-progress-err";
      progress.textContent = err && err.message ? err.message : "Something went wrong";
      window.nkToast && window.nkToast(`${tool.name} failed: ${(err && err.message) || "unknown error"}`, "error");
    } finally {
      refreshRunEnabled();
    }
  }
  runBtn.addEventListener("click", () => runAndShow(tool.run));
  extraBtns.forEach(({ el, action }) => el.addEventListener("click", () => runAndShow(action.run)));

  renderFields();
  refreshRunEnabled();
  if (!tool.noFile) body.append(drop, input, fileList);
  if (region) body.append(region.el);
  if (pageMgr) body.append(pageMgr.el);
  body.append(fieldsWrap);
  if (hotkeyRow) body.append(hotkeyRow);
  body.append(runRow, results, resultsActions);
  card.append(head, body);

  // The panel as a WHOLE also accepts a drop, not just the small drop-zone
  // box — once a tool is open it's the only thing that could reasonably want
  // the file, so there's no reason to make the user aim for a small target.
  if (!tool.noFile) {
    ["dragover", "dragenter"].forEach((ev) => card.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); card.classList.add("ft-panel-drag-over"); }));
    ["dragleave", "dragend"].forEach((ev) => card.addEventListener(ev, (e) => { if (e.target === card) card.classList.remove("ft-panel-drag-over"); }));
    card.addEventListener("drop", (e) => {
      e.preventDefault(); e.stopPropagation();
      card.classList.remove("ft-panel-drag-over");
      const dropped = [...(e.dataTransfer.files || [])];
      if (dropped.length) setFiles(tool.multiple ? [...files, ...dropped] : [dropped[0]]);
    });
  }

  return {
    el: card,
    // The public entry point a chained-in result uses (vs. the internal
    // `setFiles` the picker/drop-zone call) — replaces whatever this panel
    // already had loaded, same as picking a fresh file would, and also
    // clears out any results/progress left over from this panel's last run
    // so nothing stale lingers under a document that's no longer there.
    setFiles: tool.noFile ? () => {} : (list) => {
      setFiles(list);
      lastResults = [];
      results.textContent = "";
      resultsActions.style.display = "none";
      progress.className = "ft-progress"; progress.textContent = "";
    },
    // Shows a result that was produced OUTSIDE this panel's own run() —
    // right now only Element Screenshot needs this: its "Run" (see its
    // tool.run above) just opens the on-page picker and closes the popup, so
    // its actual result only exists once the popup is reopened later (see
    // the bootstrap's pending-capture check). Reuses the exact same
    // rendering as a normal run, so download/zip/"Apply another tool" all
    // work identically either way.
    injectResult: (out) => {
      lastResults = out;
      renderResults();
      progress.className = "ft-progress ft-progress-ok";
      progress.textContent = out.length > 1 ? `Done — ${out.length} file(s) ready` : "Done";
    },
  };
}

// ── Bootstrap: grid of tool buttons, morphing open into one detail panel ───
// Only ONE tool panel exists on screen at a time per sub-tab (see
// buildToolPanel's own comment for why that's what makes drag-and-drop
// routing unambiguous) — the grid is the "choose a tool" step, the panel is
// the "use it" step, and a button's click visually morphs from one into the
// other rather than just snapping, so it's clear which button you're now
// inside of. Panels are built once and cached, so going back and reopening
// the same tool keeps whatever you'd already picked/typed.
document.addEventListener("DOMContentLoaded", () => {
  const groups = ["web", "jpg", "pdf"];
  const grids = {}, details = {}, panes = {}, panelCache = {};
  // Per group: a stack of frames currently pushed into that group's detail
  // area — [] means "showing the main grid". Depth 1 is a tool opened
  // straight from the grid (the only case restorable across a popup
  // reopen — see persistStack); depth 2+ is "Apply another tool" territory:
  // a chain-grid frame, or a tool opened FROM one, arbitrarily deep.
  const stacks = {};
  let closing = {}; // group -> true while a close animation is in flight, so a stray click can't double-fire
  const dividers = [document.getElementById("ft-divider-web"), document.getElementById("ft-divider")].filter(Boolean);

  for (const g of groups) {
    grids[g] = document.getElementById("ft-grid-" + g);
    details[g] = document.getElementById("ft-detail-" + g);
    panes[g] = document.getElementById("ft-pane-" + g);
    panelCache[g] = new Map();
    stacks[g] = [];
  }
  if (!grids.jpg || !grids.pdf) return; // this popup build doesn't have the PDF-JPG Tools tab

  // Web Page Screenshot / JPG / PDF all sit in one continuous scroll (no
  // sub-tab switcher — see ft-section-divider in popup.css) — while a tool
  // is open in one group, every OTHER group's whole section (title + grid)
  // is hidden along with every divider, so it still reads as one focused
  // tool rather than a long page with an open panel and unrelated grids
  // sitting below it.
  function setOtherGroupVisible(g, visible) {
    groups.forEach((og) => { if (og !== g && panes[og]) panes[og].classList.toggle("ft-pane-collapsed", !visible); });
    dividers.forEach((d) => { d.hidden = !visible; });
  }

  TOOLS.forEach((tool) => {
    const g = tool.group;
    if (!grids[g]) return;
    const btn = buildToolButton(tool);
    btn.addEventListener("click", () => openTool(g, tool, btn));
    grids[g].appendChild(btn);
  });

  function panelFor(g, tool) {
    if (!panelCache[g].has(tool.id)) {
      panelCache[g].set(tool.id, buildToolPanel(tool, {
        onBack: () => popFrame(g),
        onChain: (originEl, results) => openChainGrid(g, results, originEl),
      }));
    }
    return panelCache[g].get(tool.id);
  }

  // Only a depth-1 "tool opened straight from the grid" frame can be
  // meaningfully restored after the popup reopens — its panel is rebuilt
  // fresh from panelCache with no picked files either way. A chain-grid
  // frame, or a tool opened via "Apply another tool", carries preset files
  // that plainly can't survive a popup close, so that deeper state is never
  // persisted — the popup just lands one level back at the plain tool, or
  // the grid, as if the chained step hadn't happened.
  function persistStack(g) {
    const stack = stacks[g];
    if (stack.length === 1 && stack[0].kind === "tool") {
      chrome.storage.local.set({ uiFtOpenTool: { group: g, id: stack[0].toolId } });
    } else {
      chrome.storage.local.remove("uiFtOpenTool");
    }
  }

  // Morph `node` in from `originEl`'s own position/size (so it visually reads
  // as "this button grew") to fill the pane. Used both for the main grid ->
  // first tool AND every further "goes further in" step ("Apply another
  // tool" -> its filtered grid, and that grid -> the next tool) — same
  // mechanic regardless of nesting depth. The node's natural height has to be
  // measured up front — animating TO "auto" doesn't work in CSS — and is
  // released back to "auto" once the animation ends, so anything that
  // changes it afterward (an error message, results appearing) still just
  // reflows normally instead of clipping.
  function pushFrame(g, node, originEl, meta) {
    const pane = grids[g].parentElement;
    const detail = details[g];
    const paneRect = pane.getBoundingClientRect();
    const originRect = originEl.getBoundingClientRect();

    stacks[g].push({ node, ...meta });

    detail.replaceChildren(node);
    detail.hidden = false;
    setOtherGroupVisible(g, false);

    // Measure the node's natural full-width height off to the side, in the
    // final layout it'll actually end up in, without it ever being visible.
    node.style.visibility = "hidden";
    detail.style.position = "static"; detail.style.width = "auto"; detail.style.height = "auto";
    const naturalHeight = detail.getBoundingClientRect().height;
    node.style.visibility = "";

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    Object.assign(detail.style, {
      position: "absolute",
      top: (originRect.top - paneRect.top) + "px", left: (originRect.left - paneRect.left) + "px",
      width: originRect.width + "px", height: originRect.height + "px",
      overflow: "hidden", opacity: reduceMotion ? "1" : "0", zIndex: "1", transition: "none",
    });
    pane.style.position = "relative";
    grids[g].classList.add("ft-grid-hidden");

    void detail.offsetWidth; // force layout before switching to the transitioned values
    requestAnimationFrame(() => {
      detail.style.transition = reduceMotion ? "none" : "top .26s cubic-bezier(.2,.7,.2,1), left .26s cubic-bezier(.2,.7,.2,1), width .26s cubic-bezier(.2,.7,.2,1), height .26s cubic-bezier(.2,.7,.2,1), opacity .2s ease";
      detail.style.top = "0px"; detail.style.left = "0px";
      detail.style.width = paneRect.width + "px"; detail.style.height = naturalHeight + "px";
      detail.style.opacity = "1";
    });
    const settle = () => {
      // Hand layout back to the document instead of staying pinned at a
      // fixed pixel size forever — a result appearing later needs to be able
      // to grow the panel normally.
      Object.assign(detail.style, { position: "static", top: "", left: "", width: "", height: "", overflow: "", opacity: "", zIndex: "", transition: "" });
      grids[g].hidden = true;
      grids[g].classList.remove("ft-grid-hidden");
    };
    if (reduceMotion) settle(); else detail.addEventListener("transitionend", settle, { once: true });

    persistStack(g);
  }

  function openTool(g, tool, originEl, presetFiles) {
    const panel = panelFor(g, tool);
    if (presetFiles && presetFiles.length) panel.setFiles(presetFiles);
    pushFrame(g, panel.el, originEl, { kind: "tool", toolId: tool.id });
  }

  // A result can chain into a tool that lives in the OTHER group (the one
  // real case today: PDF → JPG's output is images, so its "Apply another
  // tool" list is full of JPG-group tools). The two groups' detail areas are
  // separate DOM subtrees with their own coordinate space, so there's no
  // single button rect a morph could originate from across that boundary —
  // instead, this closes the source group's stack outright (instant, no
  // animation) and opens the target tool in its own home group exactly like
  // clicking it fresh from that group's grid, originating the morph from
  // that grid's own button. A clear two-step motion (this closes, that
  // opens) rather than an illusion of one continuous morph across panes.
  function openToolAcrossGroup(fromG, tool, files) {
    closeAllFramesInstant(fromG);
    const targetG = tool.group === "pdf" ? "pdf" : "jpg";
    const btn = grids[targetG].querySelector(`[data-tool-id="${tool.id}"]`);
    openTool(targetG, tool, btn, files);
  }

  function closeAllFramesInstant(g) {
    stacks[g] = [];
    details[g].hidden = true;
    details[g].replaceChildren();
    grids[g].hidden = false;
    grids[g].classList.remove("ft-grid-hidden", "ft-grid-entering");
    setOtherGroupVisible(g, true);
    chrome.storage.local.remove("uiFtOpenTool");
  }

  function openChainGrid(g, results, originEl) {
    const node = buildChainGridPanel(
      results,
      (tool, btnEl) => {
        const files = resultsToFiles(results);
        const targetG = tool.group === "pdf" ? "pdf" : "jpg";
        if (targetG !== g) openToolAcrossGroup(g, tool, files);
        else openTool(g, tool, btnEl, files);
      },
      () => popFrame(g),
    );
    pushFrame(g, node, originEl, { kind: "chain" });
  }

  // Pops exactly one level — back to the previous frame if there is one
  // (an earlier tool, or the chain-grid that led here), otherwise all the
  // way out to the main grid. No reverse-morph back into a tiny button; a
  // quick cross-fade reads just as clearly as "closing" without needing to
  // re-track exactly where a button used to be (which may have scrolled, or
  // not exist at all for a chain-grid tile that's about to be rebuilt).
  function popFrame(g) {
    if (closing[g]) return;
    const detail = details[g];
    const cur = stacks[g].pop();
    if (!cur) return; // already on the grid — nothing to pop
    const prev = stacks[g][stacks[g].length - 1];
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    closing[g] = true;

    if (!prev) {
      grids[g].hidden = false;
      setOtherGroupVisible(g, true);
      if (reduceMotion) { detail.hidden = true; closing[g] = false; persistStack(g); return; }
      grids[g].classList.add("ft-grid-entering");
      detail.classList.add("ft-detail-leaving");
      // ft-grid-entering / ft-detail-leaving are CSS @keyframes animations,
      // not transitions — "animationend" is the matching event here
      // ("transitionend", used in pushFrame which animates plain inline
      // styles, would never fire for these).
      detail.addEventListener("animationend", function done() {
        detail.removeEventListener("animationend", done);
        detail.hidden = true;
        detail.classList.remove("ft-detail-leaving");
        grids[g].classList.remove("ft-grid-entering");
        closing[g] = false;
      }, { once: true });
    } else if (reduceMotion) {
      detail.replaceChildren(prev.node);
      closing[g] = false;
    } else {
      detail.classList.add("ft-detail-leaving");
      detail.addEventListener("animationend", function done() {
        detail.removeEventListener("animationend", done);
        detail.classList.remove("ft-detail-leaving");
        detail.replaceChildren(prev.node);
        detail.classList.add("ft-grid-entering");
        detail.addEventListener("animationend", function done2() {
          detail.removeEventListener("animationend", done2);
          detail.classList.remove("ft-grid-entering");
          closing[g] = false;
        }, { once: true });
      }, { once: true });
    }
    persistStack(g);
  }

  // Backspace / Alt+← to go back one level — Escape closes the WHOLE popup
  // (that's Chrome's own behavior for an extension popup, not something a
  // page can reliably override, so fighting it is the wrong fix). Both are
  // standard "go back" gestures elsewhere (Backspace in a file browser,
  // Alt+← as browser back) and don't collide with anything else in this
  // popup (Ctrl/Cmd+Z/Y are the only other document-level shortcut, in
  // popup/auto-clicker.js). Skipped while actually typing somewhere, same
  // guard that one uses, so it never eats a real keystroke.
  document.addEventListener("keydown", (e) => {
    const isBack = e.key === "Backspace" || (e.key === "ArrowLeft" && e.altKey);
    if (!isBack) return;
    const t = e.target && e.target.tagName;
    if (t === "INPUT" || t === "TEXTAREA" || t === "SELECT" || (e.target && e.target.isContentEditable)) return;
    const openGroup = groups.find((g) => !details[g].hidden);
    if (!openGroup) return; // already on the grid — let Backspace/Alt+← do nothing rather than something surprising
    e.preventDefault();
    popFrame(openGroup);
  });

  // Reopening the popup lands back on whichever tool was open — but
  // straight to the finished panel, no replaying the morph animation. Only
  // ever a depth-1 plain tool (see persistStack).
  chrome.storage.local.get(["uiFtOpenTool"], (res) => {
    const open = res.uiFtOpenTool;
    if (open && TOOLS.some((t) => t.id === open.id)) {
      const tool = TOOLS.find((t) => t.id === open.id);
      const g = open.group;
      const panel = panelFor(g, tool);
      stacks[g].push({ node: panel.el, kind: "tool", toolId: tool.id });
      details[g].replaceChildren(panel.el);
      details[g].hidden = false;
      grids[g].hidden = true;
      setOtherGroupVisible(g, false);
    }
  });

  // Element Screenshot's "Show here, in File Tools" delivery mode: its
  // tool.run() only ever opens the on-page picker and closes this popup —
  // the actual result shows up here, asynchronously, on whichever LATER
  // popup open follows a finished capture (background.js's
  // runWebshotCapture left it in session storage and lit the toolbar badge).
  // Takes priority over the uiFtOpenTool restore above if both apply — a
  // just-finished screenshot is the more useful thing to land on.
  if (chrome.storage.session) {
    chrome.storage.session.get(["nkPendingScreenshot"], (res) => {
      const pending = res.nkPendingScreenshot;
      if (!pending || !pending.dataUrl) return;
      chrome.storage.session.remove("nkPendingScreenshot");
      try { chrome.action.setBadgeText({ text: "" }); } catch (_) {}
      const tool = TOOLS.find((t) => t.id === "webshot");
      if (!tool || !grids.web) return;
      fetch(pending.dataUrl).then((r) => r.blob()).then((blob) => {
        const panel = panelFor("web", tool);
        panel.injectResult([{ name: pending.filename || "screenshot.png", blob }]);
        stacks.web = [{ node: panel.el, kind: "tool", toolId: tool.id }];
        details.web.replaceChildren(panel.el);
        details.web.hidden = false;
        grids.web.hidden = true;
        setOtherGroupVisible("web", false);
      });
    });
  }
});
