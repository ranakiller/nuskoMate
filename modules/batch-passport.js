(function () {
  "use strict";

  // Logging shim — prefers the persistent extension logger, falls back to console
  const log = {
    info:  (...a) => (window.nkLog       ? window.nkLog(...a)       : console.log(...a)),
    warn:  (...a) => (window.nkLog?.warn  ? window.nkLog.warn(...a)  : console.warn(...a)),
    error: (...a) => (window.nkLog?.error ? window.nkLog.error(...a) : console.error(...a)),
  };

  let isEnabled   = false;
  let paused      = false;
  let observer    = null;
  let pollTimer   = null;
  let feeding     = false;
  let prevState   = "absent"; // "absent" | "empty" | "filled" — the upload field's state last tick
  let emptySince  = 0;        // when the field most recently became empty
  let armed       = false;    // allowed to feed once for the current empty appearance
  let settleMs    = 2000;     // delay before placing the next passport (user-configurable)
  const MIN_SETTLE = 500;     // never feed faster than this (covers the page refresh)
  const SEL_KEY   = "batchFieldSelector";

  // ── IndexedDB queue (handles hundreds/thousands of image blobs) ──────────
  const DB_NAME = "nuskomate-batch";
  const STORE   = "queue";
  let dbPromise = null;

  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(mode) {
    return db().then((d) => d.transaction(STORE, mode).objectStore(STORE));
  }

  async function queueAdd(files) {
    const store = await tx("readwrite");
    return new Promise((resolve, reject) => {
      let i = 0;
      for (const f of files) {
        store.add({ blob: f, name: f.name, type: f.type, addedAt: Date.now() });
        i++;
      }
      store.transaction.oncomplete = () => resolve(i);
      store.transaction.onerror    = () => reject(store.transaction.error);
    });
  }

  async function queueCount() {
    const store = await tx("readonly");
    return new Promise((resolve) => {
      const r = store.count();
      r.onsuccess = () => resolve(r.result);
      r.onerror   = () => resolve(0);
    });
  }

  // Pop the oldest queued image (returns a File, or null)
  async function queueTakeNext() {
    const store = await tx("readwrite");
    return new Promise((resolve) => {
      const cur = store.openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return resolve(null);
        const rec = c.value;
        store.delete(c.key);
        store.transaction.oncomplete = () =>
          resolve(new File([rec.blob], rec.name || "passport.jpg", { type: rec.type || "image/jpeg" }));
      };
      cur.onerror = () => resolve(null);
    });
  }

  async function queueClear() {
    const store = await tx("readwrite");
    return new Promise((resolve) => {
      store.clear();
      store.transaction.oncomplete = () => resolve();
      store.transaction.onerror    = () => resolve();
    });
  }

  // ── Locate the passport image field ─────────────────────────────────────
  // We learn the field from wherever the user multi-selects, then persist a
  // selector so we can re-find a fresh empty one after each form reset/reload.
  // A file input that accepts images, whether by MIME ("image/png") or by
  // extension (".png, .jpeg, .jpg" — what the passport field actually uses).
  function isImageFileInput(inp) {
    if (!inp || inp.tagName !== "INPUT" || inp.type !== "file") return false;
    const acc = (inp.getAttribute("accept") || "").toLowerCase();
    return /image|png|jpe?g|gif|webp|bmp/.test(acc);
  }

  function buildSelector(input) {
    const fc = input.getAttribute("formcontrolname");
    if (fc) return `input[formcontrolname="${fc}"]`;
    let el = input.parentElement;
    for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
      const a = el.getAttribute?.("formcontrolname") || el.getAttribute?.("formgroupname");
      if (a) return `[formcontrolname="${a}"] input[type="file"], [formgroupname="${a}"] input[type="file"]`;
      // Distinctive upload/passport container class (e.g. container__notes__upload)
      const cls = [...(el.classList || [])].find((c) => /upload|passport|attach/i.test(c));
      if (cls) return `.${CSS.escape(cls)} input[type="file"]`;
      const lbl = el.querySelector?.("label[for]");
      if (lbl) return `label[for="${lbl.getAttribute("for")}"] ~ * input[type="file"]`;
    }
    const acc = input.getAttribute("accept");
    return acc ? `input[type="file"][accept="${acc}"]` : 'input[type="file"]';
  }

  function rememberField(input) {
    const sel = buildSelector(input);
    chrome.storage.local.set({ [SEL_KEY]: sel });
    return sel;
  }

  function matchedInputs(selector) {
    if (!selector) return [];
    let nodes;
    try { nodes = document.querySelectorAll(selector); } catch (_) { return []; }
    const out = [];
    for (const n of nodes) {
      const inp = n.tagName === "INPUT" ? n : n.querySelector?.('input[type="file"]');
      if (inp && inp.type === "file") out.push(inp);
    }
    return out;
  }

  function fieldExists(selector) {
    return matchedInputs(selector).length > 0;
  }

  function findEmptyField(selector) {
    return matchedInputs(selector).find((inp) => inp.files.length === 0) || null;
  }

  function getSelector() {
    return new Promise((r) => chrome.storage.local.get([SEL_KEY], (x) => r(x[SEL_KEY])));
  }

  // Let the native picker select many files at once (image inputs only)
  function enableMultiple() {
    document.querySelectorAll('input[type="file"]').forEach((inp) => {
      if (isImageFileInput(inp) && !inp.hasAttribute("multiple")) inp.setAttribute("multiple", "");
    });
  }

  // ── Multi-select trigger ────────────────────────────────────────────────
  function onChangeCapture(e) {
    if (!isEnabled) return;
    const inp = e.target;
    if (inp?.tagName !== "INPUT" || inp.type !== "file") return;
    if (!inp.files || inp.files.length < 2) return; // only a multi-selection starts a batch

    // Sort by filename A→Z (natural order: img2 before img10) so passports are
    // processed in a predictable sequence, not the browser's arbitrary order.
    const all = [...inp.files]
      .filter((f) => f.type.startsWith("image/"))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    if (all.length < 2) return;

    log.info("[Nuskomate Batch] selection order:", all.map((f) => f.name).join(", "));

    // First image (alphabetically first) fills the field for the site + OCR;
    // the rest are queued in the same sorted order.
    const [first, ...rest] = all;
    rememberField(inp);

    const dt = new DataTransfer();
    dt.items.add(first);
    inp.files = dt.files; // trim so the site processes exactly one

    // The user's first image fills this page's slot — don't auto-feed onto it.
    prevState = "filled";
    armed = false;

    queueAdd(rest).then((n) => {
      log.info(`[Nuskomate Batch] queued ${n} passports (processing 1st now)`);
      updatePanel();
      toast(`Batch: ${rest.length} queued`);
    });
  }

  // ── Feed one image only when the upload screen genuinely RE-APPEARS ──────
  // This widget clears its own hidden input right after each upload, so "field
  // is empty" does NOT mean "ready for the next passenger" — it also happens
  // in-place while you're still reviewing the current one. Feeding on that
  // would overwrite the passport you haven't submitted yet (data loss).
  //
  // The only safe signal for "next passenger" is the upload field going
  // ABSENT → present again (a real refresh/navigation between passengers).
  // So we arm a feed only on that transition, then wait settleMs for the page
  // to finish loading. An in-place clear (filled → empty) never arms.
  async function tick() {
    if (!isEnabled || paused || feeding) return;

    const count = await queueCount();
    updatePanel(count);
    if (count === 0) { prevState = "absent"; armed = false; return; }

    const sel    = await getSelector();
    const exists = fieldExists(sel);
    const empty  = exists ? !!findEmptyField(sel) : false;
    const state  = !exists ? "absent" : empty ? "empty" : "filled";

    if (state === "empty") {
      if (prevState === "absent") {
        // Upload screen just (re)appeared → new passenger → arm + start settle
        emptySince = Date.now();
        armed = true;
      } else if (armed && Date.now() - emptySince >= settleMs) {
        armed = false; // one feed per appearance
        await feedNext(sel);
      }
    }
    // "filled" or "absent": nothing to do; the rising edge above re-arms next time
    prevState = state;
  }

  async function feedNext(sel) {
    const field = findEmptyField(sel);
    if (!field) return;
    feeding = true;
    try {
      const file = await queueTakeNext();
      if (!file) return;

      const dt = new DataTransfer();
      dt.items.add(file);
      field.files = dt.files;
      field.dispatchEvent(new Event("change", { bubbles: true })); // site attaches it
      log.info("[Nuskomate Batch] fed next passport:", file.name);

      // Trigger OCR + autofill (synthetic events are ignored by OCR's listener).
      if (typeof window.nkOcrScan === "function") window.nkOcrScan(file);

      prevState = "filled"; // we just filled it; wait for the next refresh
      updatePanel();
    } catch (err) {
      log.error("[Nuskomate Batch] feed failed:", err);
    } finally {
      feeding = false;
    }
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  async function waitFor(check, { timeout = 8000, interval = 200 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (check()) return true;
      await sleep(interval);
    }
    return false;
  }
  function findButtonByText(text) {
    return Array.from(document.querySelectorAll("button, a"))
      .find((e) => (e.textContent || "").trim() === text) || null;
  }

  // ── Click through the "Mutamer has been added successfully" screen ──────
  // Confirmed by the user live: neither this function nor anything else in
  // this codebase ever auto-clicked either of this screen's two buttons
  // ("Add Another Mutamer" / "Go To Mutamer List") — a human always had to
  // click through manually, which is exactly why the WhatsApp pipeline
  // (unattended by design) stalled here after the first passport of any
  // multi-pax batch. Fixed generically, for manual AND automated use alike:
  // if the queue still has more passports, click "Add Another Mutamer" to
  // loop back to a fresh empty Add Mutamer form for the next one (feeding
  // itself is still entirely handled by tick()'s own absent→empty
  // detection above — this only gets the wizard OUT of the success
  // interstitial and back to that empty form in the first place); once the
  // queue is empty, click "Go To Mutamer List" instead — the real signal
  // modules/masar-add-mutamer.js's reactive WhatsApp-pipeline confirmation
  // check (a separate file) is waiting for.
  let handlingSuccessScreen = false;
  async function checkSuccessScreen() {
    if (!isEnabled || handlingSuccessScreen) return;
    const addAnotherBtn = findButtonByText("Add Another Mutamer");
    const goToListBtn = findButtonByText("Go To Mutamer List");
    if (!addAnotherBtn && !goToListBtn) return;
    handlingSuccessScreen = true;
    try {
      const remaining = await queueCount();
      const target = (remaining > 0 && addAnotherBtn) ? addAnotherBtn : (goToListBtn || addAnotherBtn);
      if (!target) return;
      const label = (target.textContent || "").trim();
      target.click();
      log.info(`[Nuskomate Batch] mutamer saved — clicked "${label}" (${remaining} left queued)`);
      // Wait for the screen to actually go away before allowing another
      // click attempt — Angular's own navigation can take a moment, and
      // clicking again before it lands would be a real double-click (this
      // screen's buttons are not idempotent — clicking "Add Another
      // Mutamer" twice could skip a queued item's turn), not a harmless
      // retry, so this waits for confirmed success rather than a fixed delay.
      await waitFor(() => !findButtonByText("Add Another Mutamer") && !findButtonByText("Go To Mutamer List"));
    } catch (err) {
      log.error("[Nuskomate Batch] success-screen click failed:", err);
    } finally {
      handlingSuccessScreen = false;
    }
  }

  // ── External entry point for the WhatsApp pipeline (modules/masar-add-
  // mutamer.js's nkMasarQueuePassport) — feeds a batch of 1+ files exactly
  // the way a manual multi-select already does (onChangeCapture, above):
  // ONE atomic decision for the whole batch — the first file goes straight
  // into the field if it's free right now, the rest are queued in the SAME
  // call. Deliberately NOT split into one call per file: a caller awaiting
  // each file's own separate call before starting the next (as an early
  // version of the WhatsApp pipeline's test harness did) re-checks "is the
  // field free" per file, and that check can race ahead of the page settling
  // from the previous feed, misreading a field that's actually now occupied
  // as still free. Doing it all here in one un-interruptible pass avoids
  // that entirely, same as the manual path always has. Does NOT wait for
  // Masar to actually finish with any of them — the caller finds out later
  // via ocr.js's own ocrDisplay write, relayed separately (see
  // masar-add-mutamer.js).
  async function feedOrQueue(files) {
    if (!isEnabled) throw new Error("Bulk Passport Parser module is off (or not licensed) — turn it on so Nuskomate can feed passports through it.");
    if (!files || !files.length) return { ok: true, mode: "none", queued: 0 };
    const sel = await getSelector();
    const field = fieldExists(sel) ? findEmptyField(sel) : null;
    if (field && !feeding && (await queueCount()) === 0) {
      const [first, ...rest] = files;
      rememberField(field);
      feeding = true;
      try {
        const dt = new DataTransfer();
        dt.items.add(first);
        field.files = dt.files;
        field.dispatchEvent(new Event("change", { bubbles: true }));
        if (typeof window.nkOcrScan === "function") window.nkOcrScan(first);
        prevState = "filled"; // we just filled it; wait for the next refresh
        armed = false;
      } finally {
        feeding = false;
      }
      if (rest.length) await queueAdd(rest);
      updatePanel();
      if (rest.length) toast(`Batch: ${rest.length} queued (WhatsApp)`);
      return { ok: true, mode: "fed-directly", queued: rest.length };
    }
    await queueAdd(files);
    updatePanel();
    toast(`Batch: ${files.length} queued (WhatsApp)`);
    return { ok: true, mode: "queued", queued: files.length };
  }
  window.nkBatchFeedOrQueue = feedOrQueue;
  window.nkBatchQueueCount = queueCount; // used by modules/masar-add-mutamer.js to decide whether to redirect back to Add Mutamer after a Mutamer List confirmation check

  // ── On-page control panel ───────────────────────────────────────────────
  function ensurePanel() {
    let p = document.getElementById("nk-batch-panel");
    if (p) return p;
    p = document.createElement("div");
    p.id = "nk-batch-panel";
    Object.assign(p.style, {
      position: "fixed", bottom: "20px", left: "20px", zIndex: "999999",
      background: "#1a2035", color: "#fff", borderRadius: "10px",
      padding: "10px 12px", fontFamily: "system-ui, sans-serif", fontSize: "12.5px",
      boxShadow: "0 6px 20px rgba(0,0,0,.35)", display: "none", alignItems: "center", gap: "10px",
    });
    p.innerHTML =
      '<span id="nk-batch-count" style="font-weight:700;"></span>' +
      '<button id="nk-batch-pause" style="cursor:pointer;border:none;border-radius:6px;padding:4px 9px;font-weight:600;background:#4f6ef7;color:#fff;">Pause</button>' +
      '<button id="nk-batch-clear" style="cursor:pointer;border:none;border-radius:6px;padding:4px 9px;font-weight:600;background:#ef4444;color:#fff;">Clear</button>';
    document.body.appendChild(p);
    p.querySelector("#nk-batch-pause").addEventListener("click", () => {
      paused = !paused;
      p.querySelector("#nk-batch-pause").textContent = paused ? "Resume" : "Pause";
      p.querySelector("#nk-batch-pause").style.background = paused ? "#22c55e" : "#4f6ef7";
    });
    p.querySelector("#nk-batch-clear").addEventListener("click", async () => {
      await queueClear();
      updatePanel(0);
      toast("Batch cleared");
    });
    return p;
  }

  async function updatePanel(known) {
    const p = ensurePanel();
    const count = typeof known === "number" ? known : await queueCount();
    if (!isEnabled || count <= 0) { p.style.display = "none"; return; }
    p.style.display = "flex";
    p.querySelector("#nk-batch-count").textContent = `Passports left: ${count}`;
  }

  function toast(msg) {
    let el = document.getElementById("nk-batch-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "nk-batch-toast";
      Object.assign(el.style, {
        position: "fixed", bottom: "70px", left: "20px", zIndex: "999999",
        background: "#22c55e", color: "#fff", fontWeight: "600", fontSize: "12.5px",
        padding: "8px 14px", borderRadius: "8px", fontFamily: "system-ui, sans-serif",
        boxShadow: "0 4px 14px rgba(0,0,0,.3)", transition: "opacity .3s", opacity: "0",
      });
      document.body.appendChild(el);
    }
    el.textContent = msg; el.style.opacity = "1";
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = "0"; }, 2500);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────
  function start() {
    if (observer || pollTimer) return;
    document.addEventListener("change", onChangeCapture, true);
    observer = new MutationObserver(() => { enableMultiple(); });
    observer.observe(document.body, { childList: true, subtree: true });
    pollTimer = setInterval(() => { enableMultiple(); tick(); checkSuccessScreen(); }, 1000);
    enableMultiple();
    updatePanel();
  }

  function stop() {
    document.removeEventListener("change", onChangeCapture, true);
    if (observer) { observer.disconnect(); observer = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    const p = document.getElementById("nk-batch-panel");
    if (p) p.style.display = "none";
  }

  function applyDelay(seconds) {
    const s = parseFloat(seconds);
    settleMs = Math.max(MIN_SETTLE, (Number.isFinite(s) ? s : 2) * 1000);
  }

  // Premium feature — requires a license that includes this tool.
  const premiumOK = () => !window.NkLicense || window.NkLicense.featureOK("batch");

  chrome.storage.local.get(["extensionEnabled", "moduleBatchUpload", "batchDelay"], (res) => {
    applyDelay(res.batchDelay ?? 2);
    if (res.extensionEnabled === false) return;
    isEnabled = !!res.moduleBatchUpload && premiumOK();
    if (isEnabled) start();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.batchDelay) applyDelay(changes.batchDelay.newValue);
    if (changes.extensionEnabled) {
      if (!changes.extensionEnabled.newValue) { isEnabled = false; stop(); return; }
      chrome.storage.local.get(["moduleBatchUpload"], (r) => {
        isEnabled = !!r.moduleBatchUpload && premiumOK();
        isEnabled ? start() : stop();
      });
      return;
    }
    if (changes.moduleBatchUpload) {
      isEnabled = !!changes.moduleBatchUpload.newValue && premiumOK();
      isEnabled ? start() : stop();
    }
  });

  // React to license activation/deactivation while the page is open.
  window.NkLicense && window.NkLicense.onPremiumChange(() => {
    chrome.storage.local.get(["extensionEnabled", "moduleBatchUpload"], (r) => {
      isEnabled = r.extensionEnabled !== false && !!r.moduleBatchUpload && premiumOK();
      isEnabled ? start() : stop();
    });
  });
})();
