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

  // ── Service-worker keepalive ──────────────────────────────────────────
  // MV3 can suspend this background service worker mid-flight, discarding
  // ALL in-memory state (reservationLocks, whatsapp-automation.js's per-chat
  // buffers, and whatever this exact function was in the middle of) with no
  // error and nothing to catch — confirmed live as the real cause behind
  // multi-photo batches that silently died partway through once a single
  // run (back then including a slow CRM-tab lookup) got long enough to reach
  // whatever idle/lifetime cap Chrome enforces here.
  // Wrapping every entry point below in this keeps a trivial chrome.storage
  // call ticking every 20s for as long as that entry point's own work is
  // still running, which is the standard "keep touching an extension API so
  // the worker looks active" approach — not a documented guarantee from
  // Chrome, so this reduces the risk rather than eliminating it; the stage
  // watchdog (checkStuckReservations, alarm-driven so it reliably wakes
  // regardless) is the real safety net if a run dies anyway.
  function withKeepAlive(fn) {
    return async (...args) => {
      const timer = setInterval(() => { chrome.storage.local.get(["__nkKeepAlive"]).catch(() => {}); }, 20000);
      try {
        return await fn(...args);
      } finally {
        clearInterval(timer);
      }
    };
  }

  // Waits for the tab to genuinely finish loading rather than guessing with a
  // fixed sleep — confirmed live: a fixed 3s wait wasn't enough when the CRM
  // site (setup.nebraspk.com, a slow enterprise DevExpress app) had to be
  // opened completely fresh, so the message never reached a content script
  // that hadn't attached yet. Polls chrome.tabs' own `status` field, which
  // reflects the real browser-level load state regardless of how long that
  // actually takes on a given day — and requires it to STAY "complete" for a
  // short stretch, not just touch it once, since a login page auto-
  // redirecting to a landing page flips back to "loading" again for a moment.
  // The outer `timeoutMs` is only a last-resort ceiling for a page that's
  // genuinely stuck/unreachable, not the normal wait — it should rarely, if
  // ever, actually get hit.
  // Safety net on top of the pure wait: a tab that's sat non-"complete" for
  // more than `reloadAfterMs` (a genuinely non-responsive site, as opposed to
  // one that's just slow-but-progressing) gets reloaded, up to `maxReloads`
  // times — confirmed by the user this recovers most cases of a page that's
  // simply hung. Still bounded overall by `timeoutMs`, so a truly dead site
  // eventually surfaces as a clear error instead of hanging forever.
  async function waitForTabLoaded(tabId, { timeoutMs = 90000, pollMs = 400, stableMs = 600, reloadAfterMs = 12000, maxReloads = 2 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let stableSince = null;
    let notCompleteSince = Date.now();
    let reloads = 0;
    while (Date.now() < deadline) {
      let tab;
      try { tab = await chrome.tabs.get(tabId); } catch (_) { return false; } // tab was closed while waiting
      if (tab.status === "complete") {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= stableMs) return true;
      } else {
        stableSince = null;
        if (reloads < maxReloads && Date.now() - notCompleteSince >= reloadAfterMs) {
          reloads++;
          notCompleteSince = Date.now(); // restart the non-responsive clock for the NEXT reload's own grace period
          await chrome.tabs.reload(tabId).catch(() => {});
        }
      }
      await sleep(pollMs);
    }
    return false;
  }

  // ── Tab management — find a matching tab, or open one; always bring it to
  // the front first, since Chrome throttles setTimeout-based waits (which
  // every content-script automation here leans on) in tabs that aren't the
  // active tab of a focused window. Same reasoning as popup.js's
  // withFocusedTab() helper, just the background-context equivalent. ──
  async function getOrOpenTab(urlPattern, createUrl) {
    const tabs = await chrome.tabs.query({ url: urlPattern });
    let tab = tabs[0];
    if (!tab) tab = await chrome.tabs.create({ url: createUrl, active: false });
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    // Whether just created or already open, it might be mid-navigation right
    // now (a fresh tab loading for the first time, or an existing one the
    // user happened to have navigating somewhere else) — wait for it to
    // genuinely settle before anything tries to message it.
    const ready = await waitForTabLoaded(tab.id);
    if (!ready) throw new Error(`The tab for ${urlPattern} still hadn't finished loading after 90s — giving up (check whether the site is reachable/slow right now).`);
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

  // ── CRM lookup — via the separate "Nebras Reservation Bridge" extension ──
  // The Bridge keeps every reservation row cached from the CRM and answers
  // from that cache, so a lookup is a millisecond extension message instead
  // of driving a CRM tab from here (the old tab-scraping approach — slow page
  // loads, stale grids, and long enough runs that Chrome's MV3 worker
  // suspension killed them mid-flight — is gone entirely). Its extension ID is
  // the crmBridgeId Setting. The Bridge does its own live CRM search for a
  // reservation that isn't cached yet (a brand-new booking).
  const CRM_BRIDGE_TIMEOUT_MS = 150000; // a live search inside the Bridge (login/route/search) can legitimately take a while — only a last-resort ceiling
  const CRM_BRIDGE_MAX_AGE_MS = 15 * 60 * 1000; // its full rescan runs every ~10 min, so an older row means scans are failing
  async function callCrmBridge(payload) {
    const { crmBridgeId } = await chrome.storage.local.get(["crmBridgeId"]);
    const id = (crmBridgeId || "").trim();
    if (!id) return { ok: false, error: "No CRM Bridge extension ID set (Settings → Pipeline → CRM Bridge)." };
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, error: `CRM Bridge didn't answer within ${CRM_BRIDGE_TIMEOUT_MS / 1000}s` }), CRM_BRIDGE_TIMEOUT_MS);
      try {
        chrome.runtime.sendMessage(id, payload, (resp) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
          resolve(resp || { ok: false, error: "empty response from CRM Bridge" });
        });
      } catch (err) {
        clearTimeout(timer);
        resolve({ ok: false, error: (err && err.message) || String(err) });
      }
    });
  }

  // Returns the Bridge's lookup result ({ok, found, status, pax, ...}, plus
  // `via: "bridge"`), or { ok: false, error } when it can't answer — callers
  // treat that as a lookup failure (logged; the reservation stays "checking"
  // and the watchdog/Retry cover it).
  async function lookupReservationInCrm(reservationNo) {
    let r = await callCrmBridge({ type: "getReservation", reservationNo, maxAgeMs: CRM_BRIDGE_MAX_AGE_MS });
    if (!r || !r.ok) {
      // One quick second try — a Bridge whose service worker was just waking up
      // or mid-scan can miss the first message.
      await sleep(3000);
      r = await callCrmBridge({ type: "getReservation", reservationNo, maxAgeMs: CRM_BRIDGE_MAX_AGE_MS });
    }
    if (!r || !r.ok) return { ok: false, error: `CRM Bridge lookup failed: ${(r && r.error) || "no response"} — is the Bridge extension installed, its ID set in Settings, and its CRM tab logged in?` };

    // Anything that isn't plainly Confirmed is what the pipeline stops or
    // @mentions on, and a status can change inside the cache window — confirm
    // it against the live CRM before acting on a cached value.
    if (r.found && r.status !== "Confirmed" && r.source === "cache") {
      const live = await callCrmBridge({ type: "getReservation", reservationNo, refresh: true });
      if (live && live.ok) r = live;
    }
    const ageSec = Math.round((r.ageMs || 0) / 1000);
    await pLog("info", `Pipeline: CRM Bridge answered for ${reservationNo} (${r.found ? "found" : "not found"}, ${r.source === "live" ? "live search" : `cache, ${ageSec}s old`}${r.stale ? ", STALE — live refresh failed" : ""}).`);
    return { ...r, via: "bridge" };
  }

  // ── Masar feed ────────────────────────────────────────────────────────
  // Fire-and-forget: hands the file(s) to modules/batch-passport.js's own
  // queue (the exact same mechanism a manual multi-select already uses) and
  // returns as soon as it's queued — NOT once Masar has actually finished
  // with it. Whatever already drives that page the rest of the way (OCR
  // autofill, the user's own Auto-Clicker rules) does the actual work; this
  // pipeline finds out the result later via the OCR-scan relay below
  // (nkMasarPassportScanned), matched back to this reservation by feed ORDER
  // — see FEED_ORDER_KEY.
  //
  // Takes an ARRAY, always — even a single photo is `[{dataUrl, filename}]`.
  // Originally took one file per call, meaning a burst of several photos
  // arriving together (e.g. one WhatsApp multi-select "album") needed one
  // separate call PER photo, each its own background-service-worker round
  // trip. Confirmed live this was a real reliability gap, not just
  // theoretical: manually multi-selecting the same photos straight into
  // Masar's own Bulk Passport Parser worked every time, while the pipeline's
  // one-at-a-time feeding occasionally lost a later photo in the batch when
  // the service worker got suspended between calls (see the MV3 keepalive
  // notes above — reduced, not eliminated). Batching every photo that
  // arrived together into ONE call removes the per-photo survival
  // requirement for the fetch+feed step entirely, matching the manual path.
  async function queuePassportToMasar(files) {
    const tab = await getOrOpenTab(MASAR_URL_PATTERN, MASAR_ADD_MUTAMER_URL);
    return sendToTab(tab, { type: "nkMasarQueuePassport", files });
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
    // the CRM Bridge's parsePackage(). Country code isn't in the
    // Package string at all — every real example seen so far was Pakistani
    // ("PK"), and there's no other signal available yet to derive it
    // per-reservation, so it's hardcoded with this note attached rather than
    // silently guessed differently per reservation.
    return `NEBRAS ${arrival} ${departure} ${route} PK`;
  }

  // ── Main orchestration — called once per confirmed reservation EVENT,
  // which may carry one OR SEVERAL passport photos that arrived together
  // (e.g. one WhatsApp multi-select "album" — see collectPairings in
  // whatsapp-automation.js). Wrapped in withReservationLock so a second,
  // separately-timed batch for the same reservation number still waits its
  // turn rather than racing this one. ──
  function processReservationEvent(ctx, reservationNo, messageIds) {
    return withReservationLock(reservationNo, () => runReservationEvent(ctx, reservationNo, messageIds));
  }

  async function runReservationEvent({ waId, isGroup, chatName }, reservationNo, messageIds) {
    await pLog("info", `Pipeline: processing reservation ${reservationNo} (chat "${chatName}") — ${messageIds.length} photo(s) in this batch`);

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

    // Visibility stub — written BEFORE the CRM lookup even starts, so a
    // reservation shows up in the Queue/Live Monitor the instant it's
    // detected, not only once CRM comes back. Without this, the entire CRM
    // lookup (the one step confirmed live to sometimes stall — see the
    // MV3 keepalive notes above) was completely invisible: nothing in
    // storage yet to show it was even being worked on. Purely informational
    // (no crm/expectedPax yet) — the real "confirmed" save further down
    // still happens once CRM actually answers.
    if (!existing) {
      await saveRecord(reservationNo, { status: "pending", waId, chatName, stage: "checking", stageAt: Date.now() });
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
        await pLog("error", `Pipeline: CRM lookup returned an error for ${reservationNo}: ${(crm && crm.error) || `no usable response (got ${JSON.stringify(crm)})`}`);
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
    // `stage`/`stageAt` from here on are purely for the stuck-reservation
    // watchdog below — they track how far through the flow this reservation
    // got and when it last actually moved, so a silent stall shows up as a
    // dated stage instead of nothing at all.
    // `messageIds` is saved on the record itself (not just held in this
    // function's closure) specifically so a manual Retry, run later in a
    // completely separate invocation, can re-fetch and re-feed these exact
    // photos from WhatsApp if the feed step itself never got through OCR —
    // see feedMessagesToMasar/retryReservation below. Unioned with anything
    // already on file rather than overwritten, since more photos can arrive
    // in a later batch for the same reservation.
    const allMessageIds = Array.from(new Set([...((existing && existing.messageIds) || []), ...messageIds]));
    await saveRecord(reservationNo, { status: "confirmed", waId, chatName, crm, expectedPax: crm.pax || null, checkedAt: Date.now(), stage: "feeding", stageAt: Date.now(), messageIds: allMessageIds });

    await feedMessagesToMasar(reservationNo, waId, messageIds);
  }

  // ── Fetches each message's attachment from WhatsApp, reads it ONCE here in
  // the background, and hands Masar the cleaned image together with that
  // result — factored out of runReservationEvent so retryReservation (below)
  // can re-run exactly this step for whichever of a reservation's photos never
  // made it through, without redoing the CRM lookup or re-detecting anything.
  //
  // SINGLE OCR (modules/pipeline-ocr.js): each attachment is straightened,
  // cleaned and read (a PDF becomes one image per page) BEFORE anything is fed
  // to Masar. That gives the passport number up front — so each person is
  // tracked and queued for the Mutamer-List confirmation immediately, no
  // waiting on the Masar page's own scan and no feed-order matching — and the
  // page is handed the finished result (nkOcrPrefill → modules/ocr.js) so it
  // fills the form without reading the photo again.
  //   • An IMAGE that can't be read as a passport is NOT fed: the sender is
  //     asked for a clearer photo (and the team @mentioned), and it's recorded
  //     as unread. A PDF page with no passport on it (a booking confirmation,
  //     a cover page) is simply skipped.
  //   • If the background read itself can't run (not activated, no OCR key,
  //     server/offscreen failure) that attachment falls back to the old path:
  //     feed the original and let the Masar page read it (FIFO-matched).
  async function feedMessagesToMasar(reservationNo, waId, messageIds) {
    const scanned = [];  // { messageId, dataUrl, filename, scan, summary } — read here, tracked before feeding
    const legacy = [];   // { messageId, dataUrl, filename } — background read unavailable
    let unreadImages = 0;
    let fetched = 0;

    for (const messageId of messageIds) {
      let media;
      try {
        media = await callWaAction("getMessageMedia", { waId, messageId });
      } catch (err) {
        await pLog("error", `Pipeline: getMessageMedia failed for reservation ${reservationNo}'s message ${messageId}: ${err.message}`);
        continue;
      }
      if (!media || !media.dataUrl) {
        await pLog("error", `Pipeline: WA-Campaigns returned no media for reservation ${reservationNo}'s message ${messageId}.`);
        continue;
      }
      fetched++;
      const baseName = media.filename || `passport-${reservationNo}-${messageId}.jpg`;

      const read = await WA_OCR.scanMedia({ dataUrl: media.dataUrl, mimetype: media.mimetype, filename: baseName });
      if (!read.ok) {
        await pLog("warn", `Pipeline: couldn't read message ${messageId} in the background (${read.error}) — feeding the original and letting the Masar page read it.`);
        legacy.push({ messageId, dataUrl: media.dataUrl, filename: baseName });
        continue;
      }

      const isPdf = read.kind === "pdf";
      for (const page of read.pages) {
        if (!page.passportNo) {
          if (isPdf) {
            await pLog("info", `Pipeline: page ${page.index + 1} of the PDF in message ${messageId} has no readable passport — skipped.`);
            continue;
          }
          unreadImages++;
          await handleUnreadPhoto(reservationNo, waId, messageId, page.blurry);
          continue;
        }
        const suffix = isPdf ? `-p${page.index + 1}` : "";
        scanned.push({
          messageId, dataUrl: page.clean, scan: page.scan,
          filename: `passport-${reservationNo}-${messageId}${suffix}.jpg`,
          summary: { passportNo: page.passportNo, name: page.name, sex: page.sex, age: page.age, blurry: page.blurry },
        });
      }
    }

    if (!fetched) {
      await pLog("error", `Pipeline: none of reservation ${reservationNo}'s ${messageIds.length} photo(s) could be fetched from WhatsApp — nothing fed to Masar.`);
      return { ok: false, error: "Could not fetch any of the photo(s) from WhatsApp." };
    }

    // Track every read passport (conflict/duplicate checks, confirm queue)
    // BEFORE feeding, so the Mutamer List check knows what to look for.
    const toFeed = [];
    for (const item of scanned) {
      if (await continueAfterMasarScan(reservationNo, item.messageId, item.summary)) toFeed.push(item);
    }

    if (!toFeed.length && !legacy.length) {
      const why = unreadImages ? `${unreadImages} photo(s) couldn't be read as a passport` : "nothing usable was found in the attachment(s)";
      await pLog("warn", `Pipeline: reservation ${reservationNo} — nothing fed to Masar (${why}).`);
      return { ok: false, error: `Nothing to feed — ${why}.` };
    }

    // Legacy items keep the old FIFO correlation (their result still comes back
    // via the page's own scan); pre-read items never enter it.
    for (const f of legacy) await pushFeedOrder({ reservationNo, messageId: f.messageId });

    const files = [
      ...toFeed.map(({ dataUrl, filename, scan }) => ({ dataUrl, filename, scan })),
      ...legacy.map(({ dataUrl, filename }) => ({ dataUrl, filename })),
    ];
    let queued;
    try {
      queued = await queuePassportToMasar(files);
    } catch (err) {
      await rollbackFeed(reservationNo, toFeed, legacy);
      await pLog("error", `Pipeline: could not hand reservation ${reservationNo}'s ${files.length} passport(s) to Masar's bulk parser: ${err.message}`);
      return { ok: false, error: err.message };
    }
    if (!queued || !queued.ok) {
      await rollbackFeed(reservationNo, toFeed, legacy);
      const error = (queued && queued.error) || "no confirmation";
      await pLog("error", `Pipeline: Masar didn't accept reservation ${reservationNo}'s passport(s) into the queue: ${error}`);
      return { ok: false, error };
    }
    await pLog("info", `Pipeline: reservation ${reservationNo}'s ${files.length} passport(s) handed to Masar's bulk parser in one batch (${toFeed.length} pre-read, ${legacy.length} to be read by the page).`);
    return { ok: true, fed: files.length, unread: unreadImages };
  }

  // The feed never reached Masar — nothing will complete these, so undo the
  // tracking done for them (mutamer entries, confirm-queue entries, FIFO).
  async function rollbackFeed(reservationNo, toFeed, legacy) {
    for (const f of legacy) await removeFeedOrder(reservationNo, f.messageId);
    if (!toFeed.length) return;
    const gone = new Set(toFeed.map((i) => i.summary.passportNo));
    const record = await getRecord(reservationNo);
    if (record) await saveRecord(reservationNo, { mutamers: (record.mutamers || []).filter((m) => !gone.has(m.passportNo)) });
    const { [CONFIRM_QUEUE_KEY]: queue } = await chrome.storage.local.get([CONFIRM_QUEUE_KEY]);
    if (Array.isArray(queue)) {
      await chrome.storage.local.set({ [CONFIRM_QUEUE_KEY]: queue.filter((e) => !(e.reservationNo === reservationNo && gone.has(e.passportNo))) });
    }
  }

  // An image was fetched but isn't a readable passport, even after cleaning
  // and both enhancement passes. Not fed — ask the sender for a clearer photo,
  // @mention the team, and remember it (once per message, so a Retry doesn't
  // re-send the same request).
  async function handleUnreadPhoto(reservationNo, waId, messageId, blurry) {
    const record = await getRecord(reservationNo);
    const already = (record && record.unreadMessageIds) || [];
    if (already.includes(messageId)) return;
    await saveRecord(reservationNo, { unreadMessageIds: [...already, messageId] });
    await pLog("warn", `Pipeline: a photo for reservation ${reservationNo} (message ${messageId}) couldn't be read as a passport even after cleaning it${blurry ? " — looks blurry" : ""} — NOT fed to Masar; asking for a clearer one.`);
    const { waMentionId } = await chrome.storage.local.get(["waMentionId"]);
    await sendReply(waId, {
      text: `A photo sent for reservation ${reservationNo} couldn't be read as a passport${blurry ? " (it looks blurry)" : ""} — could you send a clearer photo of that passport? It has not been processed.`,
      mentionWaId: waMentionId || undefined,
    }).catch(() => {});
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
      return false;
    }
    const { waId, chatName, crm } = record;

    if (!scan.passportNo) {
      // Matches the original plan's "processing failure" outcome (step 13):
      // logged for manual review. Not counted toward expectedPax — a blurry/
      // unreadable scan shouldn't silently masquerade as a successful feed.
      // The "auto-reply asking for a clearer photo" half of that plan isn't
      // built yet — flagged, not silently skipped.
      // Remembered on the record so group creation can say plainly how many
      // photos were fed to Masar without ever being identified — those
      // people can't be selected into the group (no passport number to match
      // a row by), and that must never pass silently.
      const unread = Array.from(new Set([...(record.unreadMessageIds || []), messageId].filter(Boolean)));
      await saveRecord(reservationNo, { unreadMessageIds: unread });
      await pLog("warn", `Pipeline: OCR couldn't read a passport number for reservation ${reservationNo}'s photo (message ${messageId}${scan.blurry ? ", flagged blurry" : ""}) — needs manual review; not counted toward this booking's pax.`);
      // Previously this only showed up if someone happened to be reading
      // Pipeline Logs — a real gap, since a bad/blurry photo otherwise just
      // silently occupies a Masar batch slot and goes nowhere. Team gets the
      // same @mention treatment as the other manual-review cases (On hold,
      // pax mismatch) so it's a visible action item instead.
      const { waMentionId } = await chrome.storage.local.get(["waMentionId"]);
      if (waMentionId) {
        await sendReply(waId, {
          text: `A photo sent for reservation ${reservationNo} couldn't be read as a passport${scan.blurry ? " (looked blurry)" : ""} — please check it manually.`,
          mentionWaId: waMentionId,
        }).catch(() => {});
      }
      return false;
    }

    // Same passport already tracked for this reservation (a duplicate photo, a
    // PDF page repeating it, a retry) — never track or feed a person twice.
    if ((record.mutamers || []).some((m) => m.passportNo === scan.passportNo)) {
      await pLog("info", `Pipeline: passport ${scan.passportNo} is already tracked for reservation ${reservationNo} — not adding it again.`);
      return false;
    }

    // 3) Passport-reuse / conflict check — keyed by passport number, now
    // known from the OCR relay instead of a synchronous feed result.
    const priorReservation = await getPassportOwner(scan.passportNo);
    if (priorReservation && priorReservation !== reservationNo) {
      const priorRecord = await getRecord(priorReservation);
      if (priorRecord && priorRecord.status === "confirmed") {
        await pLog("error", `Pipeline: CONFLICT — passport ${scan.passportNo} is already attached to a DIFFERENT confirmed reservation (${priorReservation}) — flagging for manual review, not auto-processing reservation ${reservationNo}.`);
        await saveRecord(reservationNo, { status: "conflict", conflictWith: priorReservation });
        return false;
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
    await saveRecord(reservationNo, { mutamers, stage: "confirming", stageAt: Date.now() });
    await pLog("info", `Pipeline: OCR read mutamer "${scan.name || "(name unknown)"}" (passport ${scan.passportNo}) for reservation ${reservationNo} — waiting for Masar to confirm it's actually saved.`);

    // 5) Queue this passport for confirmation instead of deciding readiness
    // here — see pushConfirmQueue's comment for the full reasoning.
    await pushConfirmQueue({ reservationNo, messageId, passportNo: scan.passportNo });
    return true;
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

    const unreadCount = (record.unreadMessageIds || []).length;
    if (unreadCount) {
      const inGroup = (mutamers || []).filter((m) => m.passportNo).length;
      const notice = `Reservation ${reservationNo}: group created with ${inGroup} mutamer(s), but ${unreadCount} photo(s) were fed to Masar without their passport being read — please add them to the group manually.`;
      await pLog("warn", `Pipeline: ${notice}`);
      const { waMentionId } = await chrome.storage.local.get(["waMentionId"]);
      if (waMentionId) await sendReply(waId, { text: notice, mentionWaId: waMentionId }).catch(() => {});
    }

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
    await saveRecord(reservationNo, { repliedAt: Date.now(), stage: "replied", stageAt: Date.now() });
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
  async function handleMutamerConfirmed({ reservationNo, confirmations, stillQueued }) {
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

      // `stillQueued` — Masar's OWN internal batch-passport.js queue count,
      // relayed by masar-add-mutamer.js — tells us whether anything else is
      // still waiting to be fed. This page now gets visited after EVERY
      // single mutamer submission (2026-09-18: the interstitial's own
      // auto-click was removed, replaced by the user's Auto-Clicker always
      // clicking "Go To Mutamer List"), so a single visit's confirmations
      // are no longer necessarily the WHOLE batch the way they used to be —
      // still no timeout, still purely driven by Masar's real queue state,
      // just checked on every visit instead of only the last one.
      if (stillQueued) {
        await pLog("info", `Pipeline: reservation ${reservationNo} — ${confirmed.length} confirmed so far, more still queued in Masar — waiting for the rest before creating the group.`);
        return;
      }

      if (!expectedPax) {
        await pLog("warn", `Pipeline: reservation ${reservationNo} has no PAX count from CRM — can't compare against how many passports arrived. Creating the group with the ${confirmed.length} confirmed.`);
      } else if (confirmed.length < expectedPax) {
        await pLog("info", `Pipeline: reservation ${reservationNo} — CRM expects ${expectedPax}, only ${confirmed.length} confirmed so far. Creating the group with what's arrived; more can be added manually later if the rest come in.`);
      } else {
        await pLog("info", `Pipeline: reservation ${reservationNo} — all ${expectedPax} expected passports confirmed.`);
      }

      await saveRecord(reservationNo, { stage: "grouping", stageAt: Date.now() });
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

  // ── Stuck-reservation watchdog ───────────────────────────────────────────
  // The gap the user flagged directly: nothing ever told anyone a reservation
  // had silently stopped moving — it just sat there until someone happened to
  // notice, then had to nuke the whole queue to get unstuck. Run periodically
  // (see background.js's chrome.alarms wiring) against every ACTIVE
  // reservation (status "confirmed", not yet replied) and flag any that
  // haven't advanced their `stage` in a while. Only ever flags — never
  // auto-clears or auto-retries — a human decides what actually happened,
  // using the per-item Retry button (retryReservation, below) once they've
  // looked.
  const STUCK_THRESHOLD_MS = 20 * 60 * 1000; // 20 minutes with no stage progress
  // "pending" (still checking CRM — see the visibility stub in
  // runReservationEvent above) gets its own, much shorter threshold: a CRM
  // lookup normally finishes in seconds, so it stalling for minutes is a much
  // stronger stuck signal than the multi-step confirmed flow ever needing 20.
  const PENDING_STUCK_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
  async function checkStuckReservations() {
    const { [DB_KEY]: db } = await chrome.storage.local.get([DB_KEY]);
    const records = db || {};
    const now = Date.now();
    for (const reservationNo of Object.keys(records)) {
      const r = records[reservationNo];
      if (r.repliedAt) continue; // already resolved
      const isPending = r.status === "pending";
      if (r.status !== "confirmed" && !isPending) continue; // only active, unfinished reservations
      const lastProgress = r.stageAt || r.checkedAt || 0;
      const threshold = isPending ? PENDING_STUCK_THRESHOLD_MS : STUCK_THRESHOLD_MS;
      if (now - lastProgress < threshold) continue;
      if (r.stuckNotifiedAt && r.stuckNotifiedAt >= lastProgress) continue; // already flagged since the last real progress — don't re-notify every watchdog tick
      const minutes = Math.round((now - lastProgress) / 60000);
      const stageLabel = r.stage || "processing";
      await saveRecord(reservationNo, { stuckAt: now, stuckNotifiedAt: now });
      await pLog("warn", `Pipeline: reservation ${reservationNo} looks STUCK — no progress in ${minutes} min (stage: ${stageLabel}). Use the Queue's Retry button, or check Masar/CRM manually.`);
      const { waMentionId } = await chrome.storage.local.get(["waMentionId"]);
      if (waMentionId) {
        await sendReply(r.waId, { text: `Reservation ${reservationNo} seems stuck in our system (${stageLabel}, ${minutes} min with no progress) — could someone check it?`, mentionWaId: waMentionId }).catch(() => {});
      }
    }
  }

  // Asks modules/masar-add-mutamer.js to immediately re-check the Mutamer
  // List against whatever's still pending in waMasarConfirmQueue, instead of
  // waiting for its normal trigger (a route-change landing there on its own).
  // Covers the case where the passport genuinely WAS saved by Masar but the
  // route-change relay was missed for some reason (a dropped event, the page
  // already being on the Mutamer List when it happened, etc.).
  async function recheckMasarConfirmations() {
    const tab = await getOrOpenTab(MASAR_URL_PATTERN, MASAR_ADD_MUTAMER_URL);
    return sendToTab(tab, { type: "nkMasarRecheckConfirmations" });
  }

  // ── Manual per-item retry (popup's Retry button on a flagged reservation) ──
  // Deliberately narrow — this can only re-drive steps that are safe to
  // repeat from data ALREADY saved. It never re-feeds a passport image (that
  // data is gone once queuePassportToMasar hands it off; recovering from a
  // lost feed means the customer's photo has to be re-sent, nothing
  // automatable here). What it picks, based on the record's current stage:
  //  - "grouping" (or confirmedPassports already has something): the group
  //    was never successfully created — safe to just try createGroupAndReply
  //    again with the data already on file.
  //  - anything earlier ("feeding"/"confirming"): re-check the Mutamer List
  //    right now in case Masar's own confirmation relay was simply missed.
  async function retryReservation(reservationNo) {
    return withReservationLock(reservationNo, async () => {
      const record = await getRecord(reservationNo);
      if (!record) return { ok: false, error: "No tracking record for this reservation." };
      if (record.groupCreatedAt || record.groupName) {
        return { ok: false, error: `Reservation ${reservationNo} already has a group ("${record.groupName}") — nothing to retry.` };
      }
      await saveRecord(reservationNo, { stuckAt: null, stuckNotifiedAt: null });

      // "pending" (still stuck on the CRM-lookup step — see the visibility
      // stub in runReservationEvent) — there's no photo to re-feed here even
      // in principle (queuePassportToMasar was never reached), so the only
      // safe recovery is re-running the CRM lookup itself and saving whatever
      // it finds, same as a fresh event would. If it comes back Confirmed,
      // this still won't have a photo queued — that needs the customer to
      // resend, flagged clearly rather than silently left half-done.
      if (record.status === "pending") {
        await pLog("info", `Pipeline: manually re-running the CRM lookup for reservation ${reservationNo} (was stuck before CRM ever answered).`);
        let crm;
        try {
          crm = await lookupReservationInCrm(reservationNo);
        } catch (err) {
          return { ok: false, error: `CRM lookup failed: ${err.message}` };
        }
        if (!crm || !crm.ok) return { ok: false, error: (crm && crm.error) || "CRM lookup returned no usable response." };
        if (crm.found && crm.status === "Confirmed") {
          await saveRecord(reservationNo, { status: "confirmed", crm, expectedPax: crm.pax || null, checkedAt: Date.now(), stage: "feeding", stageAt: Date.now() });
          await pLog("warn", `Pipeline: reservation ${reservationNo} is Confirmed in CRM, but its original photo(s) were never fed to Masar (the CRM step got stuck before that) — ask the customer to resend the passport photo(s).`);
        } else {
          await saveRecord(reservationNo, { status: crm.found ? (crm.status || "unknown") : "not_found", crm, checkedAt: Date.now() });
        }
        return { ok: true, action: "recheck_crm" };
      }

      if (record.stage === "grouping" || (record.confirmedPassports || []).length > 0) {
        await pLog("info", `Pipeline: manually retrying group creation for reservation ${reservationNo}.`);
        await createGroupAndReply(reservationNo, record);
        return { ok: true, action: "grouping" };
      }

      // "feeding"/"confirming" with photo(s) that never produced an OCR
      // result at all — the previous version of this branch only ever
      // re-checked the Mutamer List, which does nothing if OCR never ran in
      // the first place (nothing there yet to find). Re-fetch and re-feed
      // specifically whichever of this reservation's ORIGINAL messageIds
      // haven't already produced a mutamer — never the ones that already
      // did, so a partial success (2 of 3 read) doesn't get double-fed.
      const alreadyFed = new Set((record.mutamers || []).map((m) => m.messageId).filter(Boolean));
      const unfed = (record.messageIds || []).filter((id) => !alreadyFed.has(id));
      if (unfed.length) {
        await pLog("info", `Pipeline: manually re-feeding ${unfed.length} of reservation ${reservationNo}'s photo(s) to Masar (never produced an OCR result the first time).`);
        const result = await feedMessagesToMasar(reservationNo, record.waId, unfed);
        if (!result.ok) return { ok: false, error: result.error };
        return { ok: true, action: "refeed" };
      }

      await pLog("info", `Pipeline: manually re-checking Masar's Mutamer List for reservation ${reservationNo}'s pending passport(s).`);
      try {
        const result = await recheckMasarConfirmations();
        if (!result || !result.ok) return { ok: false, error: (result && result.error) || "Masar tab didn't confirm the recheck." };
        return { ok: true, action: "recheck" };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });
  }

  return {
    processReservationEvent: withKeepAlive(processReservationEvent),
    handleMasarScanResult: withKeepAlive(handleMasarScanResult),
    handleMutamerConfirmed: withKeepAlive(handleMutamerConfirmed),
    retryReservation: withKeepAlive(retryReservation),
    registerTestFeed, callWaAction, callCrmBridge, lookupReservationInCrm, sendReply, getRecord, clearStuckQueue, clearAllQueue,
    checkStuckReservations,
  };
})();
