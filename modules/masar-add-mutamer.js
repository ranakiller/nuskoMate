(function () {
  "use strict";

  // Masar passport feed — Phase 2 of the WhatsApp automation pipeline.
  // Content script for masar.nusuk.sa.
  //
  // Given a passport image (as a data URL — the same shape WA-Campaigns'
  // getMessageMedia returns), hands it to modules/batch-passport.js's own
  // queue — the EXACT mechanism a human already uses today by clicking
  // Browse and multi-selecting many passport photos at once. Deliberately
  // does NOT drive the Add Mutamer wizard itself (no clicking through
  // steps, no filling fields): that's already fully handled by the user's
  // own existing setup (OCR autofill, Issue Date Calculator, their own
  // Auto-Clicker rules) the same way it already works for their manual
  // bulk-upload workflow. This file's only job is getting the file into
  // that same pipe, plus relaying back the OCR result for each photo so
  // modules/whatsapp-pipeline.js finds out what passport number it turned
  // out to be (see the ocrDisplay relay below) — it has no way to know that
  // synchronously anymore now that feeding is fire-and-forget.

  const wlog = (m) => { try { (window.nkLog || console.log)("[Nuskomate MasarAddMutamer] " + m); } catch (_) { console.log(m); } };

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function waitFor(check, { timeout = 15000, interval = 250 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const v = check();
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

  function isVisible(el) {
    return !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  // Exact-text match, restricted to visible elements — the technique that
  // proved reliable for clicking ambiguous-tag UI controls
  // (this site doesn't consistently use real <button> tags for its
  // actions). A real <button>/<a> still counts even with an icon child (an
  // SVG has no text content, so .textContent still equals just the label) —
  // only a plain div/span requires zero children, to avoid matching some
  // big ancestor container that merely CONTAINS the target text. Only
  // Phase 3 (below) still needs this.
  function findByExactText(text, root = document) {
    return Array.from(root.querySelectorAll("button, a, div, span"))
      .find((e) => {
        if ((e.textContent || "").trim() !== text || !isVisible(e)) return false;
        return e.tagName === "BUTTON" || e.tagName === "A" || e.children.length === 0;
      }) || null;
  }

  const ADD_MUTAMER_PATH = "/umrah/mutamer/add-mutamer";
  const MUTAMER_LIST_PATH = "/umrah/mutamer/mutamer-list";

  function isOnAddMutamerPage() {
    return location.pathname === ADD_MUTAMER_PATH;
  }
  function isOnMutamerListPage() {
    return location.pathname === MUTAMER_LIST_PATH;
  }

  function findAddMutamerButton() {
    return document.querySelector('button[routerlink="/mutamer/add-mutamer"]') || findByExactText("Add new mutamer");
  }

  // A hard `location.href` straight to the Add Mutamer URL from an
  // already-running session errored out live (confirmed by the user) — this
  // wizard step apparently expects context the Angular app only sets up when
  // you arrive at it through its own router, not via a cold deep link. The
  // Mutamer List is a safe page to hard-navigate to, so go there instead and
  // click its real "Add new mutamer" button to get a normal in-app
  // (client-side router) transition, exactly like a human would.
  async function goToAddMutamerPage() {
    if (isOnAddMutamerPage()) return;
    if (!isOnMutamerListPage()) {
      location.href = "https://masar.nusuk.sa" + MUTAMER_LIST_PATH;
      const onList = await waitFor(() => isOnMutamerListPage(), { timeout: 20000 });
      if (!onList) throw new Error("Could not reach the Mutamer List page.");
      await sleep(1000);
    }
    const btn = await waitFor(() => findAddMutamerButton(), { timeout: 15000 });
    if (!btn) throw new Error('Could not find the "Add new mutamer" button on the Mutamer List page.');
    btn.click();
    const ok = await waitFor(() => isOnAddMutamerPage(), { timeout: 20000 });
    if (!ok) throw new Error("Could not reach the Add Mutamer page after clicking Add new mutamer.");
    await sleep(1000);
  }

  async function dataUrlToFile(dataUrl, filename) {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    return new File([blob], filename || `passport-${Date.now()}.jpg`, { type: blob.type || "image/jpeg" });
  }

  // ── Feed one or more passports into the bulk parser's queue, in ONE call —
  // see batch-passport.js's feedOrQueue for why this must stay a single
  // atomic batch rather than one round-trip per file. `msg.files` is the
  // normal shape (real WhatsApp events send one, the popup test harness can
  // send several); a bare `{dataUrl, filename}` is still accepted for a
  // single passport as a convenience.
  async function queuePassport(msg) {
    await goToAddMutamerPage();
    const items = Array.isArray(msg.files) ? msg.files : [{ dataUrl: msg.dataUrl, filename: msg.filename }];
    const files = await Promise.all(items.map((it) => dataUrlToFile(it.dataUrl, it.filename)));
    // A file that arrives with `scan` was already read by the pipeline — stash
    // that result where modules/ocr.js will find it (by name+size; storage, not
    // memory, since queued files survive a page reload) so the page fills the
    // form from it instead of OCR-ing the same photo a second time.
    const prefill = {};
    items.forEach((it, i) => { if (it.scan) prefill[`${files[i].name}_${files[i].size}`] = { scan: it.scan, at: Date.now() }; });
    if (Object.keys(prefill).length) {
      const { nkOcrPrefill } = await chrome.storage.local.get(["nkOcrPrefill"]);
      const fresh = {};
      for (const [k, v] of Object.entries(nkOcrPrefill || {})) if (v && Date.now() - v.at < 3600000) fresh[k] = v; // drop anything unclaimed for an hour
      await chrome.storage.local.set({ nkOcrPrefill: { ...fresh, ...prefill } });
    }
    if (typeof window.nkBatchFeedOrQueue !== "function") {
      throw new Error("Bulk Passport Parser isn't available on this page (module off, or batch-passport.js didn't load) — can't queue this passport.");
    }
    return window.nkBatchFeedOrQueue(files);
  }

  // ── OCR-scan relay ────────────────────────────────────────────────────
  // modules/ocr.js writes a fresh `ocrDisplay` entry to storage every time a
  // scan completes (success OR a weak/blurry result) — for ANY passport fed
  // into this page, whether by a manual selection, batch-passport.js's own
  // auto-feed of a queued item, or queuePassport() above. Relaying each one
  // as it happens is how whatsapp-pipeline.js finds out the result of a feed
  // it can no longer wait on synchronously; it matches each relay back to a
  // reservation by ORDER (see waMasarFeedOrder in whatsapp-pipeline.js), not
  // by anything in this message — so this stays a dumb, order-preserving
  // relay and never tries to guess which reservation a scan belongs to.
  // Guards against relaying the exact same scan twice — e.g. if ocrDisplay
  // ever gets rewritten with an identical value for some unrelated reason.
  // Matters more here than a normal double-log would elsewhere: a duplicate
  // relay would pop TWO entries off whatsapp-pipeline.js's FIFO tracker for
  // what was really only one scan, silently shifting every LATER passport's
  // correlation by one and misattributing it to the wrong reservation.
  let lastRelayedScannedAt = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.ocrDisplay || !changes.ocrDisplay.newValue) return;
    if (!isOnAddMutamerPage()) return;
    let parsed;
    try { parsed = JSON.parse(changes.ocrDisplay.newValue); } catch (_) { parsed = null; }
    if (!parsed) return;
    if (parsed.prefilled) return; // the pipeline already read this one itself and tracked it — nothing to relay
    const scannedAt = parsed.scannedAt || Date.now();
    if (scannedAt === lastRelayedScannedAt) return;
    lastRelayedScannedAt = scannedAt;
    const name = (parsed.nameBoxes || []).filter(Boolean).join(" ") || null;
    const passportNo = (parsed.details && parsed.details.passportNo) || null;
    // Already extracted from the MRZ by utils/passport-parser.js (result.
    // details.sex / .age) — nothing new to read here, just relaying what
    // OCR already knows so the group-creation step can pick a leader
    // without needing to scrape gender off a page that doesn't show it.
    const sex = (parsed.details && parsed.details.sex) || null; // "Male" | "Female" | null
    // computeAge() (utils/passport-parser.js) returns a numeric STRING (or
    // "" when DOB is unreadable) — not a number — so parse it here.
    const ageRaw = parsed.details && parsed.details.age;
    const age = ageRaw !== undefined && ageRaw !== "" && !Number.isNaN(parseInt(ageRaw, 10)) ? parseInt(ageRaw, 10) : null;
    chrome.runtime.sendMessage({
      type: "nkMasarPassportScanned",
      passportNo, name, sex, age,
      mrzValid: !!parsed.mrzValid,
      blurry: !!parsed.blurry,
      scannedAt,
    }).catch(() => {});
  });

  // ── Phase 3: Mutamer List verification ───────────────────────────────────
  // Confirms a batch's passports actually landed, by checking whether each
  // expected passport number's text appears anywhere on an expanded Mutamer
  // List page — deliberately a plain text-presence check rather than reading
  // exact table columns, since that's robust regardless of the grid's precise
  // DOM structure (which wasn't inspected in detail).
  async function goToMutamerListPage() {
    if (location.pathname === MUTAMER_LIST_PATH) return;
    location.href = "https://masar.nusuk.sa" + MUTAMER_LIST_PATH;
    const ok = await waitFor(() => location.pathname === MUTAMER_LIST_PATH, { timeout: 20000 });
    if (!ok) throw new Error("Could not reach the Mutamer List page.");
    await sleep(1200);
  }

  // Best-effort: switch the grid's page size from the default 10 to 100 so
  // more rows are visible at once. Failing to do this isn't fatal — the
  // verification below just checks page text either way, so a missed row
  // only means it might need a second page, not a wrong result.
  async function setPageSizeTo100() {
    const combo = Array.from(document.querySelectorAll('.p-dropdown [role="combobox"]'))
      .find((el) => (el.textContent || "").trim() === "10");
    if (!combo) return false;
    combo.click();
    await sleep(300);
    const option = await waitFor(() => findByExactText("100"), { timeout: 3000 });
    if (!option) { document.body.click(); return false; }
    option.click();
    await sleep(800);
    return true;
  }

  // Manual-only (Test Tools' "Verify Mutamers" button) — actively navigates
  // to the Mutamer List to check, unlike the reactive confirmation below
  // which never drives navigation itself.
  async function verifyMutamers(expectedPassportNumbers) {
    await goToMutamerListPage();
    await setPageSizeTo100().catch(() => {});
    await sleep(500);
    const bodyText = document.body.innerText;
    const found = [];
    const missing = [];
    for (const pno of expectedPassportNumbers) {
      if (pno && bodyText.includes(pno)) found.push(pno);
      else missing.push(pno);
    }
    return { ok: true, found, missing, allFound: missing.length === 0 };
  }

  // ── Reactive Mutamer List confirmation (2026-09-18, v3.11.21) ────────────
  // The real "is this passport actually saved" signal for the WhatsApp
  // pipeline, replacing an earlier polling attempt that actively navigated
  // to this page every 15s and was confirmed live to interrupt the user's
  // own in-progress Auto-Clicker work on whatever passport was currently
  // being processed on Add Mutamer.
  //
  // Per the user's own description of their existing workflow: after a
  // passport is fed and their Auto-Clicker rules finish autofilling/
  // clicking through/Saving it, MASAR ITSELF (that existing workflow, not
  // anything built here) navigates to this Mutamer List page as its own
  // final step. Nuskomate never drives that navigation — it just reacts,
  // via route-watcher.js's "nusuk-route-change" event, whenever the SPA
  // happens to land here. If whatsapp-pipeline.js has anything pending
  // confirmation (waMasarConfirmQueue — pushed once OCR has identified a
  // fed passport's number), check the visible rows for it, relay back
  // whichever ones are found, then hand control back to Add Mutamer so
  // batch-passport.js's own queue can feed the next one — exactly the cycle
  // described: feed → (their workflow saves it) → Mutamer List appears →
  // Nuskomate confirms + redirects back → feed the next → repeat.
  //
  // Deliberately does nothing at all when nothing is pending — a human
  // manually checking this page on their own is never redirected away from
  // it; only genuinely automated, Nuskomate-initiated feeds get this
  // treatment.
  const CONFIRM_QUEUE_KEY = "waMasarConfirmQueue";
  let checkingConfirmations = false;
  async function checkMutamerListConfirmations() {
    if (checkingConfirmations) return; // a route-change can fire more than once per navigation; avoid overlapping checks
    checkingConfirmations = true;
    try {
      const { [CONFIRM_QUEUE_KEY]: pending } = await chrome.storage.local.get([CONFIRM_QUEUE_KEY]);
      let list = Array.isArray(pending) ? pending : [];
      const confirmedByReservation = {};

      // Retry a few times over a few seconds instead of one snapshot check —
      // confirmed live that a single check right after landing here could
      // miss some already-saved passports (the grid hadn't finished
      // rendering every row yet), leaving them stuck pending until a human
      // happened to revisit this page manually to finish the job. Skipped
      // entirely when nothing's pending (a purely manual upload, or simply
      // nothing to do) — no point waiting on text that was never going to
      // appear.
      if (list.length) {
        for (let attempt = 0; attempt < 4 && list.length; attempt++) {
          await sleep(attempt === 0 ? 800 : 1200);
          const bodyText = document.body.innerText;
          const stillPending = [];
          for (const entry of list) {
            if (entry.passportNo && bodyText.includes(entry.passportNo)) {
              wlog(`Mutamer List confirms passport ${entry.passportNo} (reservation ${entry.reservationNo}) is saved`);
              (confirmedByReservation[entry.reservationNo] ||= []).push(entry);
            } else {
              stillPending.push(entry);
            }
          }
          list = stillPending;
          await chrome.storage.local.set({ [CONFIRM_QUEUE_KEY]: list });
        }
      }

      // Masar's OWN internal queue count decides whether to auto-continue to
      // the next mutamer — checked UNCONDITIONALLY (not just when something
      // was pending in waMasarConfirmQueue above), so a purely MANUAL
      // multi-select batch — nothing ever goes through that queue for one —
      // still gets the same auto-continue convenience a WhatsApp-pipeline
      // feed does (this is what used to live in batch-passport.js's
      // checkSuccessScreen, removed 2026-09-18 — same decision, just made
      // here instead, on the Mutamer List page every submission now lands
      // on). Also relayed as `stillQueued` alongside any pipeline
      // confirmations below, so handleMutamerConfirmed knows whether this is
      // genuinely the last one or more are still coming (still no timeout —
      // purely driven by this real queue state).
      const stillQueued = typeof window.nkBatchQueueCount === "function" ? await window.nkBatchQueueCount() : 0;

      for (const [reservationNo, entries] of Object.entries(confirmedByReservation)) {
        chrome.runtime.sendMessage({
          type: "nkMasarMutamerConfirmed",
          reservationNo,
          confirmations: entries.map((e) => ({ messageId: e.messageId, passportNo: e.passportNo })),
          stillQueued: stillQueued > 0,
        }).catch(() => {});
      }

      if (stillQueued > 0) {
        await goToAddMutamerPage().catch(() => {});
      } else if (list.length) {
        wlog(`${list.length} passport(s) still not visible on the Mutamer List after retrying — leaving them pending; check manually if this persists.`);
      }
    } finally {
      checkingConfirmations = false;
    }
  }
  window.addEventListener("nusuk-route-change", () => {
    if (location.pathname === MUTAMER_LIST_PATH) checkMutamerListConfirmations();
  });
  if (location.pathname === MUTAMER_LIST_PATH) checkMutamerListConfirmations(); // in case this content script attached while already on the page (e.g. an extension reload)

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;

    if (msg.type === "nkMasarQueuePassport") {
      queuePassport(msg)
        .then((result) => { wlog(`queued ${msg.filename || "(passport)"} → ${JSON.stringify(result)}`); sendResponse(result); })
        .catch((err) => {
          const message = (err && (err.message || err.name)) || String(err) || "Unknown error";
          console.error("[Nuskomate MasarAddMutamer] failed:", err);
          wlog(`queuing ${msg.filename || "(passport)"} FAILED: ${message}`);
          sendResponse({ ok: false, error: message });
        });
      return true;
    }

    if (msg.type === "nkMasarRecheckConfirmations") {
      // Manual "Retry" button (popup Pipeline Queue) for a reservation that's
      // been sitting at "feeding"/"confirming" too long — forces the same
      // check checkMutamerListConfirmations() normally only runs reactively
      // off a route-change, in case Masar genuinely did save the passport but
      // that route-change relay was missed.
      goToMutamerListPage()
        .then(() => checkMutamerListConfirmations())
        .then(() => sendResponse({ ok: true }))
        .catch((err) => {
          const message = (err && (err.message || err.name)) || String(err) || "Unknown error";
          sendResponse({ ok: false, error: message });
        });
      return true;
    }

    if (msg.type === "nkMasarVerifyMutamers") {
      verifyMutamers(Array.isArray(msg.passportNumbers) ? msg.passportNumbers : [])
        .then((result) => { wlog(`verify → ${JSON.stringify(result)}`); sendResponse(result); })
        .catch((err) => {
          const message = (err && (err.message || err.name)) || String(err) || "Unknown error";
          console.error("[Nuskomate MasarAddMutamer] verify failed:", err);
          sendResponse({ ok: false, error: message });
        });
      return true;
    }
  });
})();
