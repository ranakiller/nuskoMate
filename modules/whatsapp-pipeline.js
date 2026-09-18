// modules/whatsapp-pipeline.js — Phase 6 of the WhatsApp automation plan:
// wires the already-built pieces (CRM lookup, Masar add-mutamer, Masar
// create-group, group reply assets) together, triggered from
// modules/whatsapp-automation.js once it detects a passport+reservation
// pairing. Background-context, loaded via importScripts() same as that file.
//
// SAFETY GATE: everything here runs regardless (CRM lookups, Masar mutamer/
// group creation — all safely reversible, on the user's own systems, with a
// Delete button) EXCEPT the actual WhatsApp reply (sendText/sendMedia/
// mentionInChat), which only fires when `waPipelineLive` is true in storage
// (default: false/unset). Until that's turned on in Settings, every place
// that would send a real WhatsApp message instead just logs what it WOULD
// have sent — lets the whole CRM→Masar→group pipeline be exercised safely
// before the one genuinely irreversible step is ever live. Flip it on only
// after testing sendText/sendMedia directly against a throwaway chat (see
// the "WA-Campaigns Raw Action Test" harness in Settings).

const WA_PIPELINE = (() => {
  const CRM_URL_PATTERN = "https://setup.nebraspk.com/*";
  const CRM_LOGIN_URL = "https://setup.nebraspk.com/Login.aspx";
  const MASAR_URL_PATTERN = "https://masar.nusuk.sa/*";
  const MASAR_ADD_MUTAMER_URL = "https://masar.nusuk.sa/umrah/mutamer/add-mutamer";

  const DB_KEY = "waReservations";           // reservationNo -> record (see shape below)
  const PASSPORT_INDEX_KEY = "waPassportIndex"; // passportNo -> reservationNo, for the reuse/conflict check

  // ── Tiny logging shim (background has no window) — mirrors whatsapp-automation.js's own bgLog ──
  async function pLog(level, message) {
    console[level === "error" ? "error" : level === "warn" ? "warn" : "log"]("[Nuskomate/Pipeline]", message);
    try {
      const { nkLogs: existing } = await chrome.storage.local.get(["nkLogs"]);
      const list = Array.isArray(existing) ? existing : [];
      list.push({ t: Date.now(), lvl: level, m: message });
      if (list.length > 10000) list.splice(0, list.length - 10000);
      await chrome.storage.local.set({ nkLogs: list });
    } catch (_) { /* logging must never throw into the pipeline */ }
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // ── Tab management — find a matching tab, or open one; always bring it to
  // the front first, since Chrome throttles setTimeout-based waits (which
  // every content-script automation here leans on) in tabs that aren't the
  // active tab of a focused window. Same reasoning as popup.js's
  // withFocusedTab() helper, just the background-context equivalent. ──
  async function getOrOpenTab(urlPattern, createUrl) {
    const tabs = await chrome.tabs.query({ url: urlPattern });
    let tab = tabs[0];
    if (!tab) {
      tab = await chrome.tabs.create({ url: createUrl, active: false });
      await sleep(3000); // let it start loading before anything tries to message it
    }
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    return tab;
  }

  // Content scripts aren't necessarily ready the instant a tab exists (fresh
  // navigation, or the extension was just reloaded) — retry a few times
  // rather than failing on the first "receiving end does not exist".
  async function sendToTab(tab, message, { retries = 4, retryDelayMs = 1500 } = {}) {
    let lastErr;
    for (let i = 0; i < retries; i++) {
      try {
        return await chrome.tabs.sendMessage(tab.id, message);
      } catch (err) {
        lastErr = err;
        await sleep(retryDelayMs);
      }
    }
    throw new Error(`Could not reach the tab for ${message.type} after ${retries} attempts: ${lastErr && lastErr.message}`);
  }

  // ── Reservation tracking DB (chrome.storage.local — the extension already
  // has the "unlimitedStorage" permission, and every other piece of state in
  // this codebase already lives here, so this reuses that convention rather
  // than introducing IndexedDB as a second persistence mechanism). ──
  async function getRecord(reservationNo) {
    const { [DB_KEY]: db } = await chrome.storage.local.get([DB_KEY]);
    return (db && db[reservationNo]) || null;
  }
  async function saveRecord(reservationNo, patch) {
    const { [DB_KEY]: db } = await chrome.storage.local.get([DB_KEY]);
    const next = db || {};
    next[reservationNo] = { ...(next[reservationNo] || {}), ...patch, reservationNo };
    await chrome.storage.local.set({ [DB_KEY]: next });
    return next[reservationNo];
  }
  async function getPassportOwner(passportNo) {
    const { [PASSPORT_INDEX_KEY]: idx } = await chrome.storage.local.get([PASSPORT_INDEX_KEY]);
    return (idx && idx[passportNo]) || null;
  }
  async function setPassportOwner(passportNo, reservationNo) {
    const { [PASSPORT_INDEX_KEY]: idx } = await chrome.storage.local.get([PASSPORT_INDEX_KEY]);
    const next = idx || {};
    next[passportNo] = reservationNo;
    await chrome.storage.local.set({ [PASSPORT_INDEX_KEY]: next });
  }

  // ── Per-reservation serialization ────────────────────────────────────
  // Now that whatsapp-automation.js's dedup gate lets every distinct photo
  // of a multi-pax booking through (previously only the first ever arrived
  // here — see that file's history), two photos for the SAME reservation
  // can genuinely run through processReservationEvent concurrently (they
  // often land seconds apart). Both would read-modify-write the same
  // record's `mutamers` array via chrome.storage.local with no locking —
  // a classic lost-update race that could silently drop a mutamer. Chaining
  // each reservation's runs through a tiny per-key promise queue fixes that
  // without needing any real locking primitive.
  const reservationLocks = new Map();
  function withReservationLock(key, fn) {
    const prev = reservationLocks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn); // run regardless of the previous run's outcome
    const tail = next.catch(() => {}); // never let a rejection poison the chain for the next caller
    reservationLocks.set(key, tail);
    tail.finally(() => { if (reservationLocks.get(key) === tail) reservationLocks.delete(key); });
    return next;
  }

  async function isPipelineLive() {
    const { waPipelineLive } = await chrome.storage.local.get(["waPipelineLive"]);
    return !!waPipelineLive;
  }

  // ── WA-Campaigns action calls (external one-shot messaging) ─────────────
  const WA_CAMPAIGNS_EXTENSION_ID = "gjacnhihfadbodlcjanankehcfaomlhc";
  function callWaAction(action, payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(WA_CAMPAIGNS_EXTENSION_ID, { action, ...payload }, (resp) => {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        resolve(resp);
      });
    });
  }

  // Every place that would send a real WhatsApp message goes through this —
  // the single point where the live/dry-run gate is enforced, so it can
  // never be accidentally bypassed by a new call site forgetting to check.
  async function sendReply(waId, { text, mediaDataUrl, filename, caption, mentionWaId } = {}) {
    const live = await isPipelineLive();
    const kind = mediaDataUrl ? "sendMedia" : mentionWaId ? "mentionInChat" : "sendText";
    if (!live) {
      await pLog("info", `Pipeline: [dry-run] would ${kind} to ${waId}: ${text || caption || "(media)"}`);
      return { ok: true, dryRun: true };
    }
    if (kind === "sendMedia") return callWaAction("sendMedia", { waId, dataUrl: mediaDataUrl, filename, caption });
    if (kind === "mentionInChat") return callWaAction("mentionInChat", { waId, text, mentionWaId });
    return callWaAction("sendText", { waId, text });
  }

  // ── CRM lookup ────────────────────────────────────────────────────────
  // Seen live, repeatably, for the SAME reservation across separate attempts:
  // the CRM tab's content script responds with nothing at all (no error, no
  // result — `sendToTab` just resolves `undefined`), which reads as "CRM
  // lookup returned an error ... undefined" in the Pipeline Log. Since it
  // repeats across independent attempts on the same tab, whatever went wrong
  // (a stuck DevExpress callback panel, a JS error on the page, etc.) is
  // stuck IN the tab, not something a plain retry without changing anything
  // would fix — so this reloads the CRM tab once and tries again before
  // giving up for real.
  async function lookupReservationInCrm(reservationNo, { allowReload = true } = {}) {
    const tab = await getOrOpenTab(CRM_URL_PATTERN, CRM_LOGIN_URL);
    const result = await sendToTab(tab, { type: "nkCrmLookupReservation", reservationNo });
    if ((!result || !result.ok) && allowReload) {
      await pLog("warn", `Pipeline: CRM tab gave no usable response for ${reservationNo} (got ${JSON.stringify(result)}) — reloading the CRM tab and retrying once.`);
      await chrome.tabs.reload(tab.id).catch(() => {});
      await sleep(5000); // let the CRM app finish reloading (+ auto-login, if needed) before messaging it again
      return lookupReservationInCrm(reservationNo, { allowReload: false });
    }
    return result;
  }

  // ── Masar feed ────────────────────────────────────────────────────────
  // Fire-and-forget: hands the file to modules/batch-passport.js's own queue
  // (the exact same mechanism a manual multi-select already uses) and
  // returns as soon as it's queued — NOT once Masar has actually finished
  // with it. Whatever already drives that page the rest of the way (OCR
  // autofill, the user's own Auto-Clicker rules) does the actual work; this
  // pipeline finds out the result later via the OCR-scan relay below
  // (nkMasarPassportScanned), matched back to this reservation by feed ORDER
  // — see FEED_ORDER_KEY.
  async function queuePassportToMasar(dataUrl, filename) {
    const tab = await getOrOpenTab(MASAR_URL_PATTERN, MASAR_ADD_MUTAMER_URL);
    return sendToTab(tab, { type: "nkMasarQueuePassport", dataUrl, filename });
  }

  // ── Feed-order tracking — correlates an OCR-scan-completed event back to
  // WHICH reservation/message it belongs to, since queuePassportToMasar
  // above no longer gets that answer synchronously. Relies on Masar's Add
  // Mutamer wizard only ever processing one passport at a time (confirmed by
  // batch-passport.js's own design) — as long as feeds arrive in order and
  // nothing else feeds the SAME page concurrently (a human manually using
  // that page's bulk parser at the same moment would desync this), each scan
  // completion corresponds to the oldest still-unresolved entry here. ──
  const FEED_ORDER_KEY = "waMasarFeedOrder";
  const CONFIRM_QUEUE_KEY = "waMasarConfirmQueue"; // see pushConfirmQueue's own comment further down for what this is
  async function pushFeedOrder(entry) {
    const { [FEED_ORDER_KEY]: list } = await chrome.storage.local.get([FEED_ORDER_KEY]);
    const next = Array.isArray(list) ? list : [];
    next.push({ ...entry, queuedAt: Date.now() });
    await chrome.storage.local.set({ [FEED_ORDER_KEY]: next });
  }
  // Registers a raw test feed (popup's "Masar Passport Feed" test button) the
  // same way a real WhatsApp event does, just tagged `isTest` instead of a
  // real reservationNo — so testing the OCR relay produces real Pipeline Log
  // visibility instead of silently going nowhere (that tool messages the
  // content script directly, same convention as every other test harness, so
  // it never otherwise touches this tracker).
  async function registerTestFeed(labels) {
    for (const label of labels) await pushFeedOrder({ isTest: true, label });
  }
  async function popFeedOrder() {
    const { [FEED_ORDER_KEY]: list } = await chrome.storage.local.get([FEED_ORDER_KEY]);
    if (!Array.isArray(list) || !list.length) return null;
    const [head, ...rest] = list;
    await chrome.storage.local.set({ [FEED_ORDER_KEY]: rest });
    return head;
  }
  // Removes ONE specific entry rather than assuming it's at the head — used
  // when a feed fails after already being pushed (see runReservationEvent).
  // Different reservations' events run concurrently (only same-reservation
  // calls share a lock), so another entry can land in between this one's
  // push and its own failure being detected; blindly popping the head in
  // that case would silently discard a DIFFERENT, perfectly good
  // reservation's tracking entry instead of this failed one's.
  async function removeFeedOrder(reservationNo, messageId) {
    const { [FEED_ORDER_KEY]: list } = await chrome.storage.local.get([FEED_ORDER_KEY]);
    if (!Array.isArray(list) || !list.length) return;
    const next = list.filter((e) => !(e.reservationNo === reservationNo && e.messageId === messageId));
    if (next.length !== list.length) await chrome.storage.local.set({ [FEED_ORDER_KEY]: next });
  }

  // ── Manual "Clear Stuck Queue" (popup button) ────────────────────────────
  // For when processing stops mid-flight — an error, a page reload, the
  // extension itself reloading — and leaves a reservation permanently
  // "confirmed, awaiting more passports/mutamer save" with nothing left that
  // will ever move it forward, plus a stale waMasarFeedOrder entry that
  // could wrongly latch onto some LATER, unrelated scan. Toggling the
  // Pipeline module off/on does NOT clear any of this by itself — off just
  // stops new events from being accepted, it doesn't touch already-recorded
  // state, which is exactly why old work could still resurface once it's
  // switched back on. Only ever removes reservations that are mid-flight
  // (status "confirmed" with no repliedAt yet) — anything already resolved
  // (not_found/draft/cancelled/conflict/replied) is left alone, since those
  // are done, not stuck, and are worth keeping for the passport-reuse
  // conflict check and for a record of what happened.
  async function clearStuckQueue() {
    const { [DB_KEY]: db } = await chrome.storage.local.get([DB_KEY]);
    const records = db || {};
    const stuckNos = Object.keys(records).filter((no) => records[no].status === "confirmed" && !records[no].repliedAt);
    for (const no of stuckNos) delete records[no];
    await chrome.storage.local.set({ [DB_KEY]: records });

    // Drop any passport→reservation index entries that pointed at a
    // reservation we just cleared — otherwise a stale entry could wrongly
    // flag a real future booking as a passport-reuse conflict against a
    // reservation that no longer has any tracking record at all.
    const { [PASSPORT_INDEX_KEY]: idx } = await chrome.storage.local.get([PASSPORT_INDEX_KEY]);
    const nextIdx = idx || {};
    let idxChanged = false;
    for (const passportNo of Object.keys(nextIdx)) {
      if (stuckNos.includes(nextIdx[passportNo])) { delete nextIdx[passportNo]; idxChanged = true; }
    }
    if (idxChanged) await chrome.storage.local.set({ [PASSPORT_INDEX_KEY]: nextIdx });

    const { [FEED_ORDER_KEY]: feedOrder } = await chrome.storage.local.get([FEED_ORDER_KEY]);
    const feedOrderCount = Array.isArray(feedOrder) ? feedOrder.length : 0;
    await chrome.storage.local.set({ [FEED_ORDER_KEY]: [] });

    const { [CONFIRM_QUEUE_KEY]: confirmQueue } = await chrome.storage.local.get([CONFIRM_QUEUE_KEY]);
    const confirmQueueCount = Array.isArray(confirmQueue) ? confirmQueue.length : 0;
    await chrome.storage.local.set({ [CONFIRM_QUEUE_KEY]: [] });

    await pLog("info", `Pipeline: manually cleared ${stuckNos.length} stuck reservation(s)${stuckNos.length ? ` (${stuckNos.join(", ")})` : ""}, ${feedOrderCount} pending feed-order entr${feedOrderCount === 1 ? "y" : "ies"}, and ${confirmQueueCount} pending confirm-queue entr${confirmQueueCount === 1 ? "y" : "ies"}.`);
    return { ok: true, clearedReservations: stuckNos, clearedFeedOrderCount: feedOrderCount, clearedConfirmQueueCount: confirmQueueCount };
  }

  // ── Manual "Clear All" (popup button) — a full reset, unlike the targeted
  // clearStuckQueue above ─────────────────────────────────────────────────
  // Wipes EVERY reservation record regardless of status — including already
  // -replied ones — plus the passport-reuse index and both internal order
  // queues. For deliberately starting completely fresh (e.g. clearing out
  // accumulated test reservations), not for routine "something got stuck"
  // recovery, which is what the other button is for.
  async function clearAllQueue() {
    const { [DB_KEY]: db } = await chrome.storage.local.get([DB_KEY]);
    const allNos = Object.keys(db || {});
    await chrome.storage.local.set({ [DB_KEY]: {} });
    await chrome.storage.local.set({ [PASSPORT_INDEX_KEY]: {} });

    const { [FEED_ORDER_KEY]: feedOrder } = await chrome.storage.local.get([FEED_ORDER_KEY]);
    const feedOrderCount = Array.isArray(feedOrder) ? feedOrder.length : 0;
    await chrome.storage.local.set({ [FEED_ORDER_KEY]: [] });

    const { [CONFIRM_QUEUE_KEY]: confirmQueue } = await chrome.storage.local.get([CONFIRM_QUEUE_KEY]);
    const confirmQueueCount = Array.isArray(confirmQueue) ? confirmQueue.length : 0;
    await chrome.storage.local.set({ [CONFIRM_QUEUE_KEY]: [] });

    await pLog("info", `Pipeline: manually cleared ALL ${allNos.length} tracked reservation(s), the passport-reuse index, ${feedOrderCount} pending feed-order entr${feedOrderCount === 1 ? "y" : "ies"}, and ${confirmQueueCount} pending confirm-queue entr${confirmQueueCount === 1 ? "y" : "ies"} — starting fresh.`);
    return { ok: true, clearedReservations: allNos, clearedFeedOrderCount: feedOrderCount, clearedConfirmQueueCount: confirmQueueCount };
  }
  // `mutamers` here is the full {passportNo, sex, age} array, not just
  // passport numbers — modules/masar-group.js needs `sex` to pick a group
  // leader, since the guide-selection step on that page shows no gender
  // column at all (only Masar's own age filter — 18+ only — is visible
  // there); this is the only source of that information.
  async function createMasarGroup(groupName, mutamers) {
    const tab = await getOrOpenTab(MASAR_URL_PATTERN, MASAR_ADD_MUTAMER_URL);
    return sendToTab(tab, { type: "nkMasarCreateGroup", groupName, mutamers });
  }
  async function getGroupReplyAssets(expectedGroupName) {
    const tab = await getOrOpenTab(MASAR_URL_PATTERN, MASAR_ADD_MUTAMER_URL);
    return sendToTab(tab, { type: "nkMasarGetGroupReplyAssets", expectedGroupName });
  }

  // ── Group name format (confirmed via a real worked example — see the
  // WhatsApp automation plan memory): "NEBRAS {arrival} {departure} {route} {country}" ──
  function buildGroupName(parsedPackage) {
    if (!parsedPackage) return null;
    const { arrival, departure, route } = parsedPackage;
    if (!arrival || !departure || !route) return null;
    // Route already comes as space-separated (e.g. "LHE JED LHE") from
    // modules/crm-lookup.js's parsePackage(). Country code isn't in the
    // Package string at all — every real example seen so far was Pakistani
    // ("PK"), and there's no other signal available yet to derive it
    // per-reservation, so it's hardcoded with this note attached rather than
    // silently guessed differently per reservation.
    return `NEBRAS ${arrival} ${departure} ${route} PK`;
  }

  // ── Main orchestration — called once per confirmed passport+reservation
  // pairing. Wrapped in withReservationLock so concurrent photos for the
  // same reservation number are processed one at a time, in arrival order. ──
  function processReservationEvent(ctx, reservationNo) {
    return withReservationLock(reservationNo, () => runReservationEvent(ctx, reservationNo));
  }

  async function runReservationEvent({ waId, isGroup, chatName, messageId }, reservationNo) {
    await pLog("info", `Pipeline: processing reservation ${reservationNo} (chat "${chatName}")`);

    // 1) CRM lookup — the four-outcome branch from the pipeline plan.
    // Reuse a prior lookup for this reservation instead of re-searching the
    // CRM for every single photo — confirmed live: sending 5 passports for
    // one multi-pax reservation (5 separate WhatsApp messages, same
    // reservation number) searched the CRM 5 times, once per photo, since
    // nothing previously checked whether this reservation had already been
    // resolved. A terminal, non-confirmed outcome (not found/on hold/
    // cancelled/unrecognized/conflict) is also only ever HANDLED — and
    // replied to — once; a second photo arriving for an already-on-hold
    // reservation shouldn't re-send the same @mention notice again.
    const existing = await getRecord(reservationNo);
    if (existing && existing.crm && existing.status && existing.status !== "confirmed") {
      await pLog("info", `Pipeline: reservation ${reservationNo} was already handled as "${existing.status}" — not repeating the CRM search or the reply for this additional photo.`);
      return;
    }

    let crm = existing && existing.crm;
    if (crm) {
      await pLog("info", `Pipeline: reusing the cached CRM result for reservation ${reservationNo} instead of searching again.`);
    } else {
      try {
        crm = await lookupReservationInCrm(reservationNo);
      } catch (err) {
        await pLog("error", `Pipeline: CRM lookup failed for ${reservationNo}: ${err.message}`);
        return;
      }
      if (!crm || !crm.ok) {
        await pLog("error", `Pipeline: CRM lookup returned an error for ${reservationNo}: ${(crm && crm.error) || `no response even after a reload (got ${JSON.stringify(crm)})`}`);
        return;
      }
    }

    if (!crm.found) {
      await sendReply(waId, { text: `We couldn't find reservation ${reservationNo} in our system — could you double-check the number?` });
      await saveRecord(reservationNo, { status: "not_found", waId, chatName, crm, checkedAt: Date.now() });
      return;
    }

    if (crm.status === "On hold") {
      const { waMentionId } = await chrome.storage.local.get(["waMentionId"]);
      if (waMentionId) {
        await sendReply(waId, { text: `Reservation ${reservationNo} is still on hold — could you confirm it?`, mentionWaId: waMentionId });
      } else {
        await pLog("warn", `Pipeline: reservation ${reservationNo} is On hold, but no team WA ID is configured (Settings) to @mention — skipping the reply.`);
      }
      await saveRecord(reservationNo, { status: "draft", waId, chatName, crm, checkedAt: Date.now() });
      return;
    }

    if (crm.status === "Cancelled") {
      await sendReply(waId, { text: `Reservation ${reservationNo} shows as cancelled in our system.` });
      if (existing && existing.groupName) {
        // Removing an already-fed mutamer from a Masar group is explicitly
        // NOT built (no walkthrough exists for that flow) — flag for a human
        // instead of attempting undefined DOM automation.
        await pLog("warn", `Pipeline: reservation ${reservationNo} was cancelled AFTER being fed to Masar group "${existing.groupName}" — needs MANUAL removal, this isn't automated yet.`);
      }
      await saveRecord(reservationNo, { status: "cancelled", waId, chatName, crm, checkedAt: Date.now() });
      return;
    }

    if (crm.status !== "Confirmed") {
      await pLog("warn", `Pipeline: reservation ${reservationNo} has an unrecognized CRM status "${crm.status}" — stopping here rather than guessing how to handle it.`);
      await saveRecord(reservationNo, { status: crm.status || "unknown", waId, chatName, crm, checkedAt: Date.now() });
      return;
    }

    // 2) Confirmed — fetch the actual passport image from WhatsApp and queue
    // it into Masar's own bulk-parser queue (fire-and-forget — see
    // queuePassportToMasar above). This function's job ends here; the rest
    // (conflict check, group creation, reply) happens later in
    // continueAfterMasarScan, once the OCR-scan relay reports back which
    // passport number this particular photo turned out to be.
    await saveRecord(reservationNo, { status: "confirmed", waId, chatName, crm, expectedPax: crm.pax || null, checkedAt: Date.now() });

    let media;
    try {
      media = await callWaAction("getMessageMedia", { waId, messageId });
    } catch (err) {
      await pLog("error", `Pipeline: getMessageMedia failed for reservation ${reservationNo}: ${err.message}`);
      return;
    }
    if (!media || !media.dataUrl) {
      await pLog("error", `Pipeline: WA-Campaigns returned no media for reservation ${reservationNo}'s passport message.`);
      return;
    }

    // Register the FIFO entry BEFORE sending the feed request, not after —
    // confirmed live this ordering actually matters: when a passport is fed
    // DIRECTLY (the upload field was free), nkBatchFeedOrQueue's own call
    // triggers the OCR scan as part of that same round trip, so the scan can
    // finish and get relayed to the background BEFORE the tab-messaging
    // response even makes it back here. With pushFeedOrder called only
    // AFTER that await, handleMasarScanResult would find nothing queued yet
    // for this reservation (treating a real result as an untracked manual
    // upload and dropping it), while this reservation's own entry — pushed
    // moments too late — sat in the FIFO to be wrongly matched against
    // whatever unrelated scan happened to complete next. That's what
    // "instantly went to creating group" was: an old/wrong FIFO entry
    // getting resolved by a scan that wasn't actually its own.
    await pushFeedOrder({ reservationNo, messageId });

    let queued;
    try {
      queued = await queuePassportToMasar(media.dataUrl, media.filename || `passport-${reservationNo}.jpg`);
    } catch (err) {
      await removeFeedOrder(reservationNo, messageId); // the feed never reached Masar — nothing will ever complete this entry, so don't leave it stuck in the queue
      await pLog("error", `Pipeline: could not hand reservation ${reservationNo}'s passport to Masar's bulk parser: ${err.message}`);
      return;
    }
    if (!queued || !queued.ok) {
      await removeFeedOrder(reservationNo, messageId);
      await pLog("error", `Pipeline: Masar didn't accept reservation ${reservationNo}'s passport into the queue: ${(queued && queued.error) || "no confirmation"}`);
      return;
    }
    await pLog("info", `Pipeline: reservation ${reservationNo}'s passport (message ${messageId}) handed to Masar's bulk parser (${queued.mode === "fed-directly" ? "fed immediately" : "queued behind others"}) — awaiting OCR result.`);
  }

  // ── Continuation — resumes a reservation once Masar's OCR scan for one of
  // its photos comes back (see the nkMasarPassportScanned relay from
  // modules/masar-add-mutamer.js, wired to this via background.js's message
  // switch calling WA_PIPELINE.handleMasarScanResult). Everything the OLD
  // synchronous flow did after feeding (conflict check → track mutamer →
  // wait for expectedPax → create group → reply) now lives here instead,
  // reading waId/chatName/crm back off the saved record since this runs in
  // a separate invocation from the one that queued the feed. ──
  async function continueAfterMasarScan(reservationNo, messageId, scan) {
    const record = await getRecord(reservationNo);
    if (!record) {
      await pLog("warn", `Pipeline: OCR result came back for reservation ${reservationNo}, but no tracking record exists for it anymore — ignoring.`);
      return;
    }
    const { waId, chatName, crm } = record;

    if (!scan.passportNo) {
      // Matches the original plan's "processing failure" outcome (step 13):
      // logged for manual review. Not counted toward expectedPax — a blurry/
      // unreadable scan shouldn't silently masquerade as a successful feed.
      // The "auto-reply asking for a clearer photo" half of that plan isn't
      // built yet — flagged, not silently skipped.
      await pLog("warn", `Pipeline: OCR couldn't read a passport number for reservation ${reservationNo}'s photo (message ${messageId}${scan.blurry ? ", flagged blurry" : ""}) — needs manual review; not counted toward this booking's pax.`);
      return;
    }

    // 3) Passport-reuse / conflict check — keyed by passport number, now
    // known from the OCR relay instead of a synchronous feed result.
    const priorReservation = await getPassportOwner(scan.passportNo);
    if (priorReservation && priorReservation !== reservationNo) {
      const priorRecord = await getRecord(priorReservation);
      if (priorRecord && priorRecord.status === "confirmed") {
        await pLog("error", `Pipeline: CONFLICT — passport ${scan.passportNo} is already attached to a DIFFERENT confirmed reservation (${priorReservation}) — flagging for manual review, not auto-processing reservation ${reservationNo}.`);
        await saveRecord(reservationNo, { status: "conflict", conflictWith: priorReservation });
        return;
      }
      // Prior reservation wasn't confirmed (e.g. cancelled) — legitimate
      // rebooking. Renaming the existing Masar group for this case isn't
      // built (needs a walkthrough, same as remove-mutamer) — logged
      // instead of guessed at.
      await pLog("warn", `Pipeline: passport ${scan.passportNo} was previously under reservation ${priorReservation} (not confirmed) — treating as a rebooking, but renaming any existing Masar group for it isn't automated yet.`);
    }
    await setPassportOwner(scan.passportNo, reservationNo);

    // 4) Track this mutamer against the reservation (identity only — sex/
    // age/name for group-leader picking) — but DON'T treat "OCR read it" as
    // "ready for group creation" (see CONFIRM_QUEUE_KEY below for why).
    const mutamers = [...(record.mutamers || []), { passportNo: scan.passportNo, name: scan.name, sex: scan.sex || null, age: scan.age ?? null, messageId }];
    await saveRecord(reservationNo, { mutamers });
    await pLog("info", `Pipeline: OCR read mutamer "${scan.name || "(name unknown)"}" (passport ${scan.passportNo}) for reservation ${reservationNo} — waiting for Masar to confirm it's actually saved.`);

    // 5) Queue this passport for confirmation instead of deciding readiness
    // here — see pushConfirmQueue's comment for the full reasoning.
    await pushConfirmQueue({ reservationNo, messageId, passportNo: scan.passportNo });
  }

  // ── Group creation + reply, split out of the old continueAfterMasarScan
  // so it can be triggered from the confirmation step below instead of
  // right after an OCR read. ──
  async function createGroupAndReply(reservationNo, record) {
    const { waId, chatName, crm, mutamers } = record;
    const groupName = buildGroupName(crm && crm.parsedPackage);
    if (!groupName) {
      await pLog("error", `Pipeline: could not build a group name for reservation ${reservationNo} (CRM Package string didn't parse: "${crm && crm.package}") — stopping before group creation.`);
      return;
    }

    let group;
    try {
      group = await createMasarGroup(groupName, (mutamers || []).filter((m) => m.passportNo));
    } catch (err) {
      await pLog("error", `Pipeline: Masar create-group failed for reservation ${reservationNo}: ${err.message}`);
      return;
    }
    if (!group || !group.ok || !group.submitted) {
      await pLog("error", `Pipeline: Masar create-group didn't complete for reservation ${reservationNo}: ${(group && group.error) || "no confirmation"}`);
      return;
    }
    await saveRecord(reservationNo, { groupName, groupCreatedAt: Date.now() });
    await pLog("info", `Pipeline: created Masar group "${groupName}" for reservation ${reservationNo}`);

    // Screenshot + caption, then reply in the originating chat.
    let assets;
    try {
      assets = await getGroupReplyAssets(groupName);
    } catch (err) {
      await pLog("error", `Pipeline: could not get reply assets for reservation ${reservationNo}: ${err.message}`);
      return;
    }
    if (!assets || !assets.ok) {
      await pLog("error", `Pipeline: reply-assets step failed for reservation ${reservationNo}: ${assets && assets.error}`);
      return;
    }

    await sendReply(waId, { mediaDataUrl: assets.screenshotDataUrl, filename: `${groupName}.png`, caption: assets.caption });
    await saveRecord(reservationNo, { repliedAt: Date.now() });
    await pLog("info", `Pipeline: replied in chat "${chatName}" for reservation ${reservationNo} — done.`);
  }

  // ── Confirmation queue — the REAL "is this passport actually done" signal
  // (2026-09-18, v3.11.21, replacing the disruptive polling attempt) ──────
  // Per the user's own description of how their existing Masar workflow
  // actually behaves: after a passport is fed and their own Auto-Clicker
  // rules finish autofilling/clicking through/Saving it, MASAR ITSELF (that
  // existing workflow) navigates to the Mutamer List page as its own final
  // step — Nuskomate never has to drive that navigation, and must NOT poll
  // for it (a repeated navigate-away-and-back loop was confirmed live to
  // interrupt the user's own in-progress Auto-Clicker work on the CURRENT
  // passport). Instead: modules/masar-add-mutamer.js reacts PASSIVELY to
  // route-watcher.js's "nusuk-route-change" event — whenever the SPA's own
  // navigation happens to land on the Mutamer List (for this automated flow,
  // or a human checking manually), it checks whichever entries are pending
  // here against the visible rows, relays back whichever ones it finds via
  // nkMasarMutamerConfirmed, and then — ONLY if something here was actually
  // pending, so a human's own manual visit is never hijacked — redirects
  // back to Add Mutamer so batch-passport.js's own queue can feed the next
  // one. Exactly the cycle described: feed → (their workflow saves it) →
  // Mutamer List appears → Nuskomate confirms + redirects back → feed the
  // next → repeat.
  async function pushConfirmQueue(entry) {
    const { [CONFIRM_QUEUE_KEY]: list } = await chrome.storage.local.get([CONFIRM_QUEUE_KEY]);
    const next = Array.isArray(list) ? list : [];
    next.push({ ...entry, queuedAt: Date.now() });
    await chrome.storage.local.set({ [CONFIRM_QUEUE_KEY]: next });
  }

  // Called once a BATCH of this reservation's passports has been confirmed
  // visible on the Mutamer List in the same visit (see masar-add-mutamer.js's
  // reactive check, which groups everything it finds per-reservation before
  // relaying — never one message per passport, so a multi-pax batch that all
  // lands together doesn't get evaluated one at a time).
  //
  // NO WAITING for expectedPax to be reached — explicit decision (2026-09-18):
  // the user rejected both a fixed timeout AND blocking indefinitely for
  // more passports ("we cannot specify time limit... what is received gets
  // processed, what is not, when they get sent by customer we will process
  // them"). Masar's own "Go To Mutamer List" trigger (batch-passport.js's
  // checkSuccessScreen, only fires once ITS queue is empty) is already the
  // real "nothing more immediately incoming" signal — by the time this
  // fires, everything currently known about has already been fed and saved,
  // so it's correct to create the group with whatever that turns out to be,
  // rather than waiting for a specific count. If MORE passports for the same
  // reservation arrive later (a following day, say), that's a real, accepted
  // case here, not a bug — see the "already has a group" branch below, which
  // is what handles it (flagged for manual addition, not automated).
  async function handleMutamerConfirmed({ reservationNo, confirmations }) {
    return withReservationLock(reservationNo, async () => {
      const record = await getRecord(reservationNo);
      if (!record) {
        await pLog("warn", `Pipeline: Mutamer List confirmed passport(s) for reservation ${reservationNo}, but no tracking record exists for it anymore — ignoring.`);
        return;
      }
      const newPassports = (confirmations || []).map((c) => c.passportNo).filter(Boolean);

      // A group was already created for this reservation — the passport(s)
      // just confirmed arrived AFTER that (e.g. the customer sent the rest
      // of the group a day later). Adding a mutamer to an EXISTING Masar
      // group isn't automated (no walkthrough exists for that flow, same
      // gap as the cancelled-after-feed/rebooking cases) — flag it clearly
      // for manual handling instead of silently dropping it.
      if (record.groupCreatedAt || record.groupName) {
        await pLog("warn", `Pipeline: reservation ${reservationNo} already has a group ("${record.groupName}") — ${newPassports.length} more passport(s) confirmed AFTER the fact (${newPassports.join(", ") || "unreadable"}) — these need MANUAL addition to the group, that isn't automated yet.`);
        return;
      }

      const confirmed = [...(record.confirmedPassports || [])];
      for (const p of newPassports) { if (!confirmed.includes(p)) confirmed.push(p); }
      await saveRecord(reservationNo, { confirmedPassports: confirmed });

      if (!confirmed.length) return; // shouldn't happen (confirmations always carry a real passportNo), but never create an empty group

      const expectedPax = record.expectedPax || (record.crm && record.crm.pax) || null;
      if (expectedPax && confirmed.length > expectedPax) {
        // Real anomaly — MORE passports than the CRM says this booking has.
        // Unlike "fewer than expected" (safe to proceed with — see below),
        // this is NOT safe to auto-resolve: one of these passports may
        // belong to a different booking entirely, and forcing all of them
        // into one Masar group risks attaching the wrong traveler to it.
        // Stop and surface it to the team via the same @mention channel
        // used for On-hold reservations — a human needs to decide which
        // one(s) don't belong, not something to guess at. Only notifies
        // once per reservation (paxMismatchNotifiedAt), since every
        // following passport for this reservation would otherwise re-hit
        // this same branch and re-send the same notice.
        if (!record.paxMismatchNotifiedAt) {
          const { waMentionId } = await chrome.storage.local.get(["waMentionId"]);
          const notice = `Reservation ${reservationNo}: CRM expects ${expectedPax} passport(s), but ${confirmed.length} have been received — please check which one(s) don't belong before the group is created.`;
          if (waMentionId) await sendReply(record.waId, { text: notice, mentionWaId: waMentionId });
          await pLog("warn", `Pipeline: ${notice}${waMentionId ? "" : " (no team WA ID configured in Settings to @mention — logged only.)"}`);
          await saveRecord(reservationNo, { paxMismatchNotifiedAt: Date.now() });
        }
        return;
      }

      if (!expectedPax) {
        await pLog("warn", `Pipeline: reservation ${reservationNo} has no PAX count from CRM — can't compare against how many passports arrived. Creating the group with the ${confirmed.length} confirmed.`);
      } else if (confirmed.length < expectedPax) {
        await pLog("info", `Pipeline: reservation ${reservationNo} — CRM expects ${expectedPax}, only ${confirmed.length} confirmed so far. Creating the group with what's arrived; more can be added manually later if the rest come in.`);
      } else {
        await pLog("info", `Pipeline: reservation ${reservationNo} — all ${expectedPax} expected passports confirmed.`);
      }

      const fresh = await getRecord(reservationNo); // re-read: saveRecord above already merged confirmedPassports in
      await createGroupAndReply(reservationNo, fresh);
    });
  }

  // ── Entry point for the OCR-scan relay (see masar-add-mutamer.js) — pops
  // the oldest still-unresolved feed and resumes ITS reservation, locked the
  // same way processReservationEvent is, so this can never race a second
  // photo landing for the same reservation. ──
  async function handleMasarScanResult(scan) {
    const entry = await popFeedOrder();
    if (!entry) {
      // A genuinely manual, human-driven upload with nothing queued by
      // Nuskomate — expected and correct, not a Pipeline Log event. Only
      // console-logged so it's still visible while debugging, without
      // cluttering Pipeline Logs with routine, non-actionable noise for
      // every passport a human feeds by hand.
      console.log("[Nuskomate/Pipeline] OCR scan completed with nothing pending in the feed-order queue — a manual upload, most likely; ignoring.");
      return;
    }
    if (entry.isTest) {
      const passportBit = scan.passportNo ? `passport ${scan.passportNo}${scan.name ? ` (${scan.name})` : ""}` : "unreadable";
      await pLog("info", `Pipeline: [test] OCR result for "${entry.label}" — ${passportBit}${scan.blurry ? " [blurry]" : ""}`);
      return;
    }
    return withReservationLock(entry.reservationNo, () => continueAfterMasarScan(entry.reservationNo, entry.messageId, scan || {}));
  }

  return { processReservationEvent, handleMasarScanResult, handleMutamerConfirmed, registerTestFeed, callWaAction, sendReply, getRecord, clearStuckQueue, clearAllQueue };
})();
