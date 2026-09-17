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
  async function lookupReservationInCrm(reservationNo) {
    const tab = await getOrOpenTab(CRM_URL_PATTERN, CRM_LOGIN_URL);
    return sendToTab(tab, { type: "nkCrmLookupReservation", reservationNo });
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
    let crm;
    try {
      crm = await lookupReservationInCrm(reservationNo);
    } catch (err) {
      await pLog("error", `Pipeline: CRM lookup failed for ${reservationNo}: ${err.message}`);
      return;
    }
    if (!crm || !crm.ok) {
      await pLog("error", `Pipeline: CRM lookup returned an error for ${reservationNo}: ${crm && crm.error}`);
      return;
    }

    if (!crm.found) {
      await sendReply(waId, { text: `We couldn't find reservation ${reservationNo} in our system — could you double-check the number?` });
      await saveRecord(reservationNo, { status: "not_found", waId, chatName, checkedAt: Date.now() });
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
      const existing = await getRecord(reservationNo);
      if (existing && existing.groupName) {
        // Removing an already-fed mutamer from a Masar group is explicitly
        // NOT built (no walkthrough exists for that flow) — flag for a human
        // instead of attempting undefined DOM automation.
        await pLog("warn", `Pipeline: reservation ${reservationNo} was cancelled AFTER being fed to Masar group "${existing.groupName}" — needs MANUAL removal, this isn't automated yet.`);
      }
      await saveRecord(reservationNo, { status: "cancelled", waId, chatName, checkedAt: Date.now() });
      return;
    }

    if (crm.status !== "Confirmed") {
      await pLog("warn", `Pipeline: reservation ${reservationNo} has an unrecognized CRM status "${crm.status}" — stopping here rather than guessing how to handle it.`);
      await saveRecord(reservationNo, { status: crm.status || "unknown", waId, chatName, checkedAt: Date.now() });
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

    let queued;
    try {
      queued = await queuePassportToMasar(media.dataUrl, media.filename || `passport-${reservationNo}.jpg`);
    } catch (err) {
      await pLog("error", `Pipeline: could not hand reservation ${reservationNo}'s passport to Masar's bulk parser: ${err.message}`);
      return;
    }
    if (!queued || !queued.ok) {
      await pLog("error", `Pipeline: Masar didn't accept reservation ${reservationNo}'s passport into the queue: ${(queued && queued.error) || "no confirmation"}`);
      return;
    }
    await pushFeedOrder({ reservationNo, messageId });
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

    // 4) Track this mutamer against the reservation; only create the group
    // once every expected PAX has been fed (avoids a group per single
    // passport when a reservation has several travelers).
    const mutamers = [...(record.mutamers || []), { passportNo: scan.passportNo, name: scan.name, sex: scan.sex || null, age: scan.age ?? null, messageId }];
    const expectedPax = record.expectedPax || (crm && crm.pax) || null;
    await saveRecord(reservationNo, { mutamers });
    await pLog("info", `Pipeline: OCR read mutamer "${scan.name || "(name unknown)"}" (passport ${scan.passportNo}) for reservation ${reservationNo}`);

    if (!expectedPax) {
      // CRM's PAX: field didn't parse (see crm-lookup.js's grab("PAX:")) — no
      // signal at all for how many travelers this reservation has. Proceeding
      // straight to group creation here would silently treat "unknown" the
      // same as "just this one," which is wrong for any multi-pax booking.
      // Flag it instead of guessing.
      await pLog("warn", `Pipeline: reservation ${reservationNo} has no PAX count from CRM — can't tell if more passports are expected. Creating the group with just the ${mutamers.length} fed so far; check manually if this booking has more travelers.`);
    } else if (mutamers.length < expectedPax) {
      await pLog("info", `Pipeline: reservation ${reservationNo} has ${mutamers.length}/${expectedPax} passports fed — waiting for the rest before creating a group.`);
      return;
    }

    // 5) Create the Masar group.
    const groupName = buildGroupName(crm && crm.parsedPackage);
    if (!groupName) {
      await pLog("error", `Pipeline: could not build a group name for reservation ${reservationNo} (CRM Package string didn't parse: "${crm && crm.package}") — stopping before group creation.`);
      return;
    }

    let group;
    try {
      group = await createMasarGroup(groupName, mutamers.filter((m) => m.passportNo));
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

    // 6) Screenshot + caption, then reply in the originating chat.
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

  return { processReservationEvent, handleMasarScanResult, registerTestFeed, callWaAction, sendReply, getRecord };
})();
