// Offscreen helper for the WhatsApp pipeline (see modules/pipeline-ocr.js).
// Offscreen documents can use ONLY the chrome.runtime API — no storage, no
// tabs — so this does pure image work and returns data URLs; the background
// service worker owns everything else (licence, OCR calls, storage).
//
// Messages (all carry target: "nk-offscreen"):
//   { type: "prep", dataUrl, mimetype }  → { ok, kind, pages: [{ pageId, clean, gentle, info, text }] }
//       Turns one WhatsApp attachment into one or more upright, cleaned images
//       (a PDF becomes one image per page). `clean` = straightened + trimmed
//       colour JPEG (what gets fed to Masar); `gentle` = the text-enhanced
//       grayscale JPEG to OCR first.
//   { type: "strong", pageId }           → { ok, strong } bold black-on-white PNG
//       of a page prepared earlier — only requested when the gentle copy
//       didn't read well.

import * as pdfjsLib from "../utils/pdfjs/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("utils/pdfjs/pdf.worker.min.mjs");

const P = window.NkImagePrep;
const MAX_PDF_PAGES = 8;
const PAGE_TTL_MS = 10 * 60 * 1000;
const pages = new Map(); // pageId -> { canvas, ts }

function gc() {
  const now = Date.now();
  for (const [id, v] of pages) if (now - v.ts > PAGE_TTL_MS) pages.delete(id);
}

// The real file type comes from the bytes, not the label: WhatsApp attachments
// sent "as a document" can carry a wrong or blank mimetype (an image sent as a
// document, a PDF with no type at all), and the label decides whether this is
// rendered as a PDF or decoded as an image.
function sniffType(bytes) {
  if (bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "application/pdf"; // %PDF
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57) return "image/webp";
  return null;
}

function dataUrlToBlob(dataUrl, fallbackType) {
  const comma = dataUrl.indexOf(",");
  const head = dataUrl.slice(0, comma);
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const type = sniffType(bytes) || (/^data:([^;,]+)/.exec(head) || [])[1] || fallbackType || "application/octet-stream";
  return new Blob([bytes], { type });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("Couldn't read the encoded image."));
    r.readAsDataURL(blob);
  });
}

// Encode a canvas as JPEG no bigger than maxBytes / maxLong pixels (OCR.space's
// free tier rejects uploads over ~1MB; Masar uploads stay modest too).
async function jpegDataUrl(canvas, { maxLong, maxBytes }) {
  let c = canvas;
  const long = Math.max(c.width, c.height);
  if (long > maxLong) {
    const s = maxLong / long;
    const r = document.createElement("canvas");
    r.width = Math.round(c.width * s); r.height = Math.round(c.height * s);
    const ctx = r.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, r.width, r.height);
    ctx.drawImage(c, 0, 0, r.width, r.height);
    c = r;
  }
  let blob = null;
  for (const q of [0.9, 0.8, 0.7, 0.6, 0.5]) {
    blob = await P.canvasToBlob(c, "image/jpeg", q);
    if (blob.size <= maxBytes) break;
  }
  return blobToDataUrl(blob);
}

async function canvasesFromMedia({ dataUrl, mimetype }) {
  const blob = dataUrlToBlob(dataUrl, mimetype);
  const isPdf = blob.type === "application/pdf";
  if (!isPdf) return { kind: "image", items: [{ canvas: await P.toCanvas(blob), text: "" }] };

  const doc = await pdfjsLib.getDocument({ data: await blob.arrayBuffer() }).promise;
  const items = [];
  const count = Math.min(doc.numPages, MAX_PDF_PAGES);
  for (let n = 1; n <= count; n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(4, Math.max(1, 2200 / Math.max(base.width, base.height)));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await Promise.race([
      page.render({ canvasContext: ctx, viewport }).promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("Rendering PDF page " + n + " timed out.")), 30000)),
    ]);
    let text = "";
    try { text = (await page.getTextContent()).items.map((i) => i.str).join(" "); } catch (_) { /* image-only page */ }
    items.push({ canvas, text });
  }
  return { kind: "pdf", items, totalPages: doc.numPages };
}

async function prep(msg) {
  gc();
  const { kind, items, totalPages } = await canvasesFromMedia(msg);
  const out = [];
  for (const { canvas, text } of items) {
    const { canvas: clean, info } = await P.prepareForOcr(canvas, { trim: true });
    const pageId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    pages.set(pageId, { canvas: clean, ts: Date.now() });
    out.push({
      pageId, info, text,
      clean: await jpegDataUrl(clean, { maxLong: 2400, maxBytes: 1500000 }),
      gentle: await jpegDataUrl(P.enhanceForOcr(clean, { mode: "gentle", minLongEdge: 1800, maxLongEdge: 2000 }), { maxLong: 2000, maxBytes: 900000 }),
    });
  }
  return { ok: true, kind, totalPages: totalPages || 1, pages: out };
}

async function strong(msg) {
  const entry = pages.get(msg.pageId);
  if (!entry) return { ok: false, error: "That page is no longer cached." };
  const enhanced = P.enhanceForOcr(entry.canvas, { mode: "strong", minLongEdge: 1800, maxLongEdge: 2000 });
  const blob = await P.canvasToBlob(enhanced, "image/png");
  return { ok: true, strong: await blobToDataUrl(blob) };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "nk-offscreen") return;
  const job = msg.type === "prep" ? prep(msg) : msg.type === "strong" ? strong(msg) : Promise.resolve({ ok: false, error: "Unknown offscreen request" });
  job.then(sendResponse).catch((e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
  return true;
});
