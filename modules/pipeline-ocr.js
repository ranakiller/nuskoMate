// modules/pipeline-ocr.js — background-context (importScripts'd from background.js).
// The WhatsApp pipeline's ONE passport read: every attachment is cleaned and
// read here, in the background, the moment it is fetched from WhatsApp — before
// anything touches Masar. The result (passport number, name, sex, age, plus the
// full parsed record) is then handed to Masar's page together with the cleaned
// image, so the page never has to OCR the same photo a second time (see the
// `scan` attached to files in whatsapp-pipeline.js → masar-add-mutamer.js →
// ocr.js's prefill).
//
// Split of work (a service worker has no canvas, and offscreen documents may
// only use chrome.runtime):
//   • offscreen/prep.js  — pure image work: PDF → page images, upright/level/
//                          trim, and the text-enhanced copies (gentle/strong)
//   • this file          — licence-server OCR calls + retry order + results
//
// Errors are split into two kinds so the caller can react correctly:
//   { ok: false, infra: true }  — couldn't run the read at all (no licence/key,
//        server unreachable, offscreen unavailable): caller falls back to the
//        old feed-and-let-the-page-read-it path
//   { ok: true, pages: [{ good: false }] } — the read ran but the photo isn't a
//        readable passport: caller decides what that means (image vs PDF page)

const WA_OCR = (() => {
  // Same server the page-side licence client talks to (utils/license.js) — keep in sync.
  const LICENSE_BASE = "https://nuskomate-license.ranakiller-59.workers.dev";
  const OFFSCREEN_URL = "offscreen/prep.html";
  let creating = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const infra = (error) => ({ ok: false, infra: true, error });

  async function ensureOffscreen() {
    if (!chrome.offscreen) throw new Error("This browser has no offscreen-document support.");
    const existing = chrome.runtime.getContexts ? await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }) : [];
    if (existing.length) return;
    if (!creating) {
      creating = chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ["DOM_PARSER"],
        justification: "Straighten, clean and convert passport photos/PDFs (canvas + PDF rendering) for OCR.",
      }).finally(() => { creating = null; });
    }
    await creating;
  }

  // A freshly created offscreen document may not have registered its message
  // listener yet — retry briefly instead of failing the first call.
  async function callOffscreen(msg) {
    let lastErr;
    for (let i = 0; i < 12; i++) {
      try {
        // A reply that never comes (helper page wedged) must not wedge the
        // pipeline with it — give up after 90s and let the caller fall back.
        const resp = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("the image helper didn't answer within 90s")), 90000);
          chrome.runtime.sendMessage({ target: "nk-offscreen", ...msg }, (r) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message)); else resolve(r);
          });
        });
        if (resp === undefined) throw new Error("no response from the image helper");
        return resp;
      } catch (err) { lastErr = err; if (/didn't answer/.test(err.message)) break; await sleep(350); }
    }
    throw lastErr;
  }

  // One licence-server OCR call (the server OCRs with the user's own ocr.space
  // key AND parses — same endpoint the page-side scan uses).
  let scanner = async function serverScan(dataUrl, fileName) {
    const { licenseKey, licenseDevice, ocrApiKey } = await chrome.storage.local.get(["licenseKey", "licenseDevice", "ocrApiKey"]);
    if (!licenseKey) return infra("Nuskomate isn't activated on this browser — the pipeline can't run its own OCR.");
    if (!(ocrApiKey || "").trim()) return infra("No ocr.space API key is set (Settings) — the pipeline can't run its own OCR.");
    const comma = dataUrl.indexOf(",");
    const fileType = (/^data:([^;,]+)/.exec(dataUrl.slice(0, comma)) || [])[1] || "image/jpeg";
    let r;
    try {
      r = await handle({
        type: "nkLicense", action: "scan", base: LICENSE_BASE, key: licenseKey, device: licenseDevice || "",
        feature: "ocr", ocrApiKey: ocrApiKey.trim(), fileB64: dataUrl.slice(comma + 1), fileName: fileName || "scan.jpg", fileType,
      });
    } catch (err) { return infra(`OCR server unreachable: ${(err && err.message) || err}`); }
    const d = r && r.data;
    if (!d || typeof d !== "object") return infra("Bad response from the OCR server.");
    if (!d.ok) return infra(d.error || `OCR server refused the scan (HTTP ${r.status}).`);
    return { ok: true, result: d.result || {}, raw: d.raw || "" };
  };

  const isGood = (d) => !!(d && d.mrzValid && Array.isArray(d.nameBoxes) && d.nameBoxes.some(Boolean));
  function better(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (!!a.mrzValid !== !!b.mrzValid) return a.mrzValid ? a : b;
    const count = (x) => (x.nameBoxes || []).filter(Boolean).length + (x.issueDate ? 1 : 0);
    return count(b) > count(a) ? b : a;
  }

  // The identity fields the pipeline tracks per mutamer, from the parsed record.
  function summarize(scan) {
    const details = (scan && scan.details) || {};
    const ageRaw = details.age;
    const age = ageRaw !== undefined && ageRaw !== "" && !Number.isNaN(parseInt(ageRaw, 10)) ? parseInt(ageRaw, 10) : null;
    return {
      passportNo: details.passportNo || null,
      name: ((scan && scan.nameBoxes) || []).filter(Boolean).join(" ") || null,
      sex: details.sex || null,
      age,
      mrzValid: !!(scan && scan.mrzValid),
      blurry: !!(scan && scan.blurry),
    };
  }

  // Reads one prepared page: text-enhanced (gentle) copy first; only if that
  // doesn't read well, the bold black-on-white (strong) copy; keeps the better.
  async function readPage(page, baseName) {
    let best = null, calls = 0;
    const r1 = await scanner(page.gentle, `${baseName}-g.jpg`);
    calls++;
    if (!r1.ok) return r1;
    best = r1.result;
    if (!isGood(best)) {
      try {
        const s = await callOffscreen({ type: "strong", pageId: page.pageId });
        if (s && s.ok) {
          const r2 = await scanner(s.strong, `${baseName}-s.png`);
          calls++;
          if (r2.ok) best = better(best, r2.result);
        }
      } catch (_) { /* the gentle read stands */ }
    }
    return { ok: true, scan: best, calls };
  }

  // One WhatsApp attachment → { ok: true, kind, pages: [{ index, clean, scan, good, passportNo, name, sex, age, ... }] }
  async function scanMedia({ dataUrl, mimetype, filename }) {
    let prep;
    try {
      await ensureOffscreen();
      prep = await callOffscreen({ type: "prep", dataUrl, mimetype });
    } catch (err) { return infra(`Image helper failed: ${(err && err.message) || err}`); }
    if (!prep || !prep.ok) return infra((prep && prep.error) || "The image helper couldn't process that file.");

    const base = (filename || "photo").replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_");
    const pages = [];
    for (let i = 0; i < prep.pages.length; i++) {
      const p = prep.pages[i];
      const read = await readPage(p, `${base}-p${i + 1}`);
      if (!read.ok) return read; // infra failure — the whole attachment falls back
      const s = summarize(read.scan);
      pages.push({
        index: i, clean: p.clean, info: p.info, text: p.text || "", scan: read.scan, ocrCalls: read.calls,
        good: isGood(read.scan) && !!s.passportNo, ...s,
      });
    }
    return { ok: true, kind: prep.kind, totalPages: prep.totalPages, pages };
  }

  return { scanMedia, summarize, isGood, __setScanner: (fn) => { scanner = fn; } };
})();
