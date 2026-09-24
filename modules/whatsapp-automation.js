// modules/whatsapp-automation.js — background-context (loaded into
// background.js via importScripts(); background.js is a classic, non-module
// service worker, so this can't be an ES import). Bridges to the user's
// SEPARATE WA-Campaigns extension for all actual WhatsApp I/O — this file
// owns none of that itself, it only consumes WA-Campaigns' external API:
// one-shot chrome.runtime.sendMessage calls in both directions — WA-Campaigns
// pushes a message for each new-message event, and this file (via
// whatsapp-pipeline.js's callWaAction) calls request/response actions
// (openChat/sendText/sendMedia/getMessageMedia/mentionInChat) the same way.
// See the project_whatsapp_automation_plan notes for the full pipeline this
// is the first slice of.
//
// Was originally built on a long-lived chrome.runtime.connect() port for the
// push direction, but MV3 service workers get suspended after ~30s idle and
// a Port doesn't reliably survive that on either side — this produced a
// connect/disconnect cycle roughly every 30 seconds in practice (confirmed
// live), with a real risk of a message arriving in the brief gap being
// silently dropped (WA-Campaigns only relayed `if (nuskomatePort)`).
// A one-shot sendMessage doesn't have that problem: Chrome reliably wakes a
// suspended service worker to deliver it, same as any other extension
// message, so there's no persistent connection to keep alive at all.
//
// FIRST BUILD INCREMENT: connect, classify incoming messages for a
// passport+reservation-number pattern, correlate across nearby messages in
// the same chat (the number and the image aren't always in the same
// message), de-duplicate already-seen reservation numbers, and log a clear
// detection. Everything past that (CRM lookup, Masar feeding, group
// creation, the actual WhatsApp reply) is still to come — this stage is
// deliberately safe/non-destructive (it never calls sendText/sendMedia/
// openChat) so it can be verified against a real WhatsApp account before
// anything further is layered on.

const WA_CAMPAIGNS_EXTENSION_ID = "gjacnhihfadbodlcjanankehcfaomlhc";

// ── Background-context logging ──────────────────────────────────────────
// utils/logger.js's window.nkLog can't be used here — it needs `window`,
// which doesn't exist in a service worker (only `self`). Writing straight to
// its own storage key/shape instead, so these entries still show up
// alongside everything else in the popup's Logs tab.
const NKLOGS_KEY = "nkLogs";
const NKLOGS_MAX = 10000;
async function bgLog(level, message) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"]("[Nuskomate/WhatsApp]", message);
  try {
    const { [NKLOGS_KEY]: existing } = await chrome.storage.local.get([NKLOGS_KEY]);
    const list = Array.isArray(existing) ? existing : [];
    list.push({ t: Date.now(), lvl: level, m: message });
    if (list.length > NKLOGS_MAX) list.splice(0, list.length - NKLOGS_MAX);
    await chrome.storage.local.set({ [NKLOGS_KEY]: list });
  } catch (_) {
    // logging must never throw into the message-handling path
  }
}

// ── Reservation-number pattern ──────────────────────────────────────────
// Exactly 6 digits, always — never more or fewer. Optionally prefixed with
// "ur"/"UR" (case-insensitive), optionally separated from the digits by a
// dash or a space, or with no prefix/separator at all:
//   UR123456   ur-123456   UR 123456   123456
// Word-boundaried on both ends so this can never match 6 digits out of a
// longer run (a 7+ digit number, a phone number, etc).
const RESERVATION_RE = /\b(?:ur[\s-]?)?(\d{6})\b/i;
function extractReservationNumber(text) {
  if (!text) return null;
  const m = RESERVATION_RE.exec(text);
  return m ? m[1] : null;
}

// Message types (as WA-Campaigns' relay passes them through from wa-js,
// unmodified) that could carry a passport — voice notes/stickers/vcards/
// location never do.
const PASSPORT_MEDIA_TYPES = new Set(["image", "document"]);

// ── Per-chat recent-message buffer ──────────────────────────────────────
// The reservation number and the passport image aren't always in the same
// WhatsApp message, and either can come first. Keep a short rolling window
// per chat so a number arriving some time after (or before) its passport
// image can still be matched up, without keeping unbounded history.
const RECENT_WINDOW_MS = 10 * 60 * 1000; // generous enough for a follow-up message typed a few minutes later; small enough not to misattribute an old, unrelated number/image
const recentByChat = new Map(); // waId -> [{ messageId, messageType, text, reservationNumber, timestamp }]

function pruneOld(list, now) {
  while (list.length && now - list[0].timestamp > RECENT_WINDOW_MS) list.shift();
}
function rememberMessage(entry) {
  let list = recentByChat.get(entry.waId);
  if (!list) { list = []; recentByChat.set(entry.waId, list); }
  pruneOld(list, entry.timestamp);
  list.push(entry);
}

// Finds EVERY passport-shaped message in the buffer that belongs to
// whichever reservation number is "in play" for this chat right now —
// triggered by the just-arrived message, but not limited to pairing with
// just that one message. Confirmed live this matters: a customer sending
// several photos together as one WhatsApp multi-select "album" doesn't
// necessarily get the typed caption copied onto every photo — often only
// ONE of them ends up carrying the reservation number, WhatsApp-side, not
// Nuskomate's. An earlier version of this function paired the number with
// only the SINGLE closest photo, so every other photo in that same burst —
// arriving captionless, before the number was known — sat in the buffer
// forever unpaired (this is what "only feeds one passport then creates the
// group" turned out to be: only the captioned photo was ever detected).
//
// Superseded design note (kept for context): before that, an even earlier
// version searched the WHOLE buffer for the single best pairing anywhere,
// which had a different bug — once one self-contained pairing (gap 0) had
// already been detected and deduped, a LATER, unrelated self-contained
// pairing in the same chat could tie it on gap and never be found. This
// version avoids that by still anchoring "which number is in play" to the
// message that just arrived (itself, if it carries one; otherwise whichever
// buffered number is closest to it) — but then attaches EVERY not-yet-
// conflicting photo to that number, not just one.
function collectPairings(waId, newEntry) {
  const list = recentByChat.get(waId);
  if (!list) return [];

  // The number in play: the just-arrived message's own (a number-only text,
  // or an image with its own caption), or else whichever buffered number is
  // closest in time to it.
  let numberEntry = newEntry.reservationNumber ? newEntry : null;
  if (!numberEntry) {
    let best = null;
    for (const n of list) {
      if (!n.reservationNumber) continue;
      const gap = Math.abs(newEntry.timestamp - n.timestamp);
      if (!best || gap < best.gap) best = { entry: n, gap };
    }
    numberEntry = best && best.entry;
  }
  if (!numberEntry) return []; // no number known yet anywhere in this chat's recent window

  // Every passport-shaped message that doesn't carry a DIFFERENT number of
  // its own belongs to this one — a plain captionless photo has
  // `reservationNumber: null`, which never conflicts with anything.
  const pairings = [];
  for (const m of list) {
    if (!PASSPORT_MEDIA_TYPES.has(m.messageType)) continue;
    if (m.reservationNumber && m.reservationNumber !== numberEntry.reservationNumber) continue;
    pairings.push({ mediaEntry: m, numberEntry, reservationNumber: numberEntry.reservationNumber });
  }
  return pairings;
}

// ── Intent gating ─────────────────────────────────────────────────────────
// A reservation number sitting near an image doesn't necessarily mean
// "please feed this passport" — it could be a cancellation request, a
// question, an unrelated document sent around the same time, etc. Since
// findPairing above only cares about PROXIMITY, not intent, this is a second,
// independent check: does either half of the pairing's text mention one of a
// configurable list of words that mean "this probably isn't a feed request"?
// User-editable (Settings → Pipeline Settings → Skip words) rather than a
// fixed list baked into code, since which phrasings actually show up is
// something only the team using this day to day would know reliably.
const DEFAULT_SKIP_KEYWORDS = ["cancel", "cancellation", "refund", "reschedule", "postpone"];
async function getSkipKeywords() {
  const { waSkipKeywords } = await chrome.storage.local.get(["waSkipKeywords"]);
  return Array.isArray(waSkipKeywords) ? waSkipKeywords : DEFAULT_SKIP_KEYWORDS;
}
function findSkipKeyword(text, keywords) {
  if (!text) return null;
  const lower = text.toLowerCase();
  return keywords.find((kw) => kw && lower.includes(kw)) || null;
}

// ── Feeding Chats allowlist ───────────────────────────────────────────────
// Which WhatsApp chats the pipeline is even allowed to act on — the user's
// own spec: staff searches WhatsApp's real chat/group list by name (via
// WA-Campaigns' `getChats` action, popup.js's own picker) and adds the ones
// that should be watched, rather than typing in a raw chat ID.
// FAILS CLOSED (2026-09-18, explicit correction — an earlier version of this
// treated an empty list as "no restriction", meaning the pipeline still
// processed every chat until someone opted in): the entire point of this
// allowlist was "only ever process passports/messages from certain groups or
// people" — an empty list means nothing has been vetted yet, so nothing
// should be processed, not everything. Staff must add each real intake chat
// via the Feeding Chats search picker in Settings before it starts working.
async function isFeedingChat(waId) {
  const { waFeedingChats } = await chrome.storage.local.get(["waFeedingChats"]);
  const list = Array.isArray(waFeedingChats) ? waFeedingChats : [];
  if (!list.length) return false;
  return list.some((c) => c.waId === waId);
}

// ── De-dup: passport MESSAGES already handed to the pipeline ─────────────
// Keyed by the passport media message's own ID — NOT the reservation number.
// A reservation number is reused across every photo of a multi-pax booking
// (2-5+ travelers is the normal case for group Umrah reservations), so
// keying dedup on the number alone meant only the FIRST photo of any such
// booking ever reached the pipeline: the 2nd/3rd pairing would resolve to
// the same already-marked reservation number and get silently dropped,
// making whatsapp-pipeline.js's "accumulate mutamers until expectedPax"
// logic unreachable for anything but single-pax bookings. Keying on the
// media message's ID instead means every distinct photo still gets through
// exactly once, AND — as a side benefit — a genuine retry (customer resends
// a corrected number, or a reservation that was `not_found`/failed earlier
// shows up again) is a brand-new message with a new ID, so it isn't
// permanently blocked the way the old reservation-keyed gate blocked it.
const DETECTED_KEY = "waProcessedMediaIds";
const DETECTED_MAX = 5000;
async function alreadyDetected(mediaMessageId) {
  const { [DETECTED_KEY]: list } = await chrome.storage.local.get([DETECTED_KEY]);
  return Array.isArray(list) && list.includes(mediaMessageId);
}
async function markDetected(mediaMessageId) {
  const { [DETECTED_KEY]: list } = await chrome.storage.local.get([DETECTED_KEY]);
  const next = Array.isArray(list) ? list.slice() : [];
  if (!next.includes(mediaMessageId)) {
    next.push(mediaMessageId);
    if (next.length > DETECTED_MAX) next.splice(0, next.length - DETECTED_MAX);
    await chrome.storage.local.set({ [DETECTED_KEY]: next });
  }
}

// ── Dispatch debounce ─────────────────────────────────────────────────────
// Confirmed live: dispatching to the pipeline the INSTANT a photo is
// detected loses a real race when a customer sends several photos as one
// WhatsApp multi-select album with the SAME caption copied onto each photo
// (self-contained pairing — each gets detected and dispatched individually,
// a moment apart). The FIRST photo's own CRM lookup can easily take 5-10+
// seconds; the second photo can't even start its own run until the first
// one's lock releases — but Masar's own automation (the user's Auto-Clicker
// rules) can finish processing the first passport and move itself to the
// Mutamer List well within that window, since nothing was in MASAR'S OWN
// queue yet for the second photo. The group then gets created with just the
// first passport. collectPairings() above already handles the OTHER
// ordering (several captionless photos, revealed all at once when a
// separate number-only text arrives) — this debounce handles the
// self-contained-caption case by giving a short window for a burst to fully
// arrive before ever starting the CRM/Masar work, regardless of which
// pattern the photos came in as.
const BATCH_DEBOUNCE_MS = 2000;
const pendingBatches = new Map(); // reservationNumber -> { messageIds: Set, ctx, timer }
function scheduleBatch(reservationNumber, messageId, ctx) {
  let batch = pendingBatches.get(reservationNumber);
  if (!batch) {
    batch = { messageIds: new Set(), ctx, timer: null };
    pendingBatches.set(reservationNumber, batch);
  }
  batch.messageIds.add(messageId);
  batch.ctx = ctx; // keep the most recent chat context (waId/isGroup/chatName don't change per reservation in practice, but no reason not to use the latest)
  clearTimeout(batch.timer);
  batch.timer = setTimeout(() => {
    pendingBatches.delete(reservationNumber);
    const messageIds = Array.from(batch.messageIds);
    WA_PIPELINE.processReservationEvent(batch.ctx, reservationNumber, messageIds)
      .catch((err) => bgLog("error", `Pipeline: failed for reservation ${reservationNumber}: ${(err && err.message) || err}`));
  }, BATCH_DEBOUNCE_MS);
}

// Rate-limits the "not on the allowlist" log so a chatty non-trusted group
// doesn't flood Pipeline Logs with one line per message — still visible
// (this exact kind of SILENT drop is what the allowlist's own predecessor
// concern was about — "no way of knowing" a message was ignored), just
// throttled to once per chat per interval.
const FEEDING_CHAT_WARN_INTERVAL_MS = 30 * 60 * 1000;
const feedingChatWarnedAt = new Map(); // waId -> last time this was logged

// ── The actual per-message handler ──────────────────────────────────────
async function handleIncomingMessage(payload) {
  const { waId, isGroup, chatName, fromMe, messageId, messageType, text, timestamp } = payload || {};
  if (!waId || fromMe) return; // never react to the agency's own messages
  if (!(await isFeedingChat(waId))) {
    const nowTs = Date.now();
    const lastWarned = feedingChatWarnedAt.get(waId) || 0;
    if (nowTs - lastWarned > FEEDING_CHAT_WARN_INTERVAL_MS) {
      feedingChatWarnedAt.set(waId, nowTs);
      await bgLog("warn", `Ignoring a message from "${chatName || waId}" — not on the Feeding Chats allowlist (Settings → Pipeline → Feeding Chats). Add it there if this chat should be watched.`);
    }
    return; // not trusted — ignore entirely, don't even buffer it for pairing
  }
  const now = timestamp || Date.now();

  const entry = { waId, messageId, messageType, text, reservationNumber: extractReservationNumber(text), timestamp: now };
  rememberMessage(entry);

  const pairings = collectPairings(waId, entry);
  if (!pairings.length) return; // nothing to act on yet — the matching half may not have arrived

  const skipKeywords = await getSkipKeywords();

  // Every pairing that survives dedup/skip-word checks gets debounced into
  // its reservation's pending batch (scheduleBatch) rather than dispatched
  // immediately — see that function's own comment for why.
  for (const pairing of pairings) {
    if (await alreadyDetected(pairing.mediaEntry.messageId)) continue; // this specific photo was already handled by an earlier message in the same burst

    // Check BOTH halves of the pairing — the wording could be on either the
    // number-bearing message or the media's own caption (e.g. an image sent
    // with "please cancel UR-106538" as its caption is self-contained).
    const hit = findSkipKeyword(pairing.numberEntry.text, skipKeywords) || findSkipKeyword(pairing.mediaEntry.text, skipKeywords);
    if (hit) {
      await markDetected(pairing.mediaEntry.messageId); // still dedup — a repeat of the same message shouldn't re-flag every time
      await bgLog(
        "warn",
        `Pipeline: reservation ${pairing.reservationNumber} in ${isGroup ? "group" : "chat"} "${chatName}" mentions "${hit}" — doesn't look like a passport submission, so it was NOT auto-processed. Handle it manually.`
      );
      const { waMentionId } = await chrome.storage.local.get(["waMentionId"]);
      if (waMentionId) {
        WA_PIPELINE.sendReply(waId, {
          text: `Reservation ${pairing.reservationNumber} was mentioned along with an image, but the message contains "${hit}" — skipped auto-processing since this doesn't look like a passport submission. Please check manually.`,
          mentionWaId: waMentionId,
        }).catch(() => {});
      }
      continue;
    }

    await markDetected(pairing.mediaEntry.messageId);
    await bgLog(
      "info",
      `Pipeline: passport detected — reservation ${pairing.reservationNumber} in ${isGroup ? "group" : "chat"} "${chatName}" (message ${pairing.mediaEntry.messageId}, type ${pairing.mediaEntry.messageType})`
    );

    // Hands off to modules/whatsapp-pipeline.js (Phase 6): CRM lookup ->
    // outcome handling -> Masar feed -> conflict check -> group creation ->
    // reply. Debounced (see scheduleBatch's own comment) rather than fired
    // immediately, so a burst of several photos for the same reservation —
    // however they're paired up — gets collected into ONE pipeline run
    // instead of racing Masar's own automation one photo at a time.
    scheduleBatch(pairing.reservationNumber, pairing.mediaEntry.messageId, { waId, isGroup, chatName });
  }
}

// ── Receiving pushed events from WA-Campaigns ────────────────────────────
// No connection to manage anymore — WA-Campaigns fires a one-shot
// chrome.runtime.sendMessage(NUSKOMATE_ID, {type:'new-message', ...}) for
// every WhatsApp message, and Chrome wakes this service worker on delivery
// even if it was suspended. `type: "ping"` is a lightweight reachability
// check WA-Campaigns sends itself once per its own service worker start, so
// its own status UI can show "last confirmed reachable" without needing a
// live connection either.
// Master module switch (Pipeline tab's own on/off, separate from the
// Live Sending toggle which only gates the final reply). When off, this
// listener never calls sendResponse at all — Chrome closes the port
// unanswered, so WA-Campaigns sees Nuskomate as unreachable, same as if
// this module wasn't installed. No event is parsed, logged, or processed.
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (sender.id !== WA_CAMPAIGNS_EXTENSION_ID) return; // unhandled — Chrome treats this the same as no listener at all

  chrome.storage.local.get(["modulePipeline", "extensionEnabled", "licenseValid", "licenseFeatures"], (res) => {
    const enabled = res.extensionEnabled !== false && res.modulePipeline !== false; // default on
    if (!enabled) return; // no sendResponse — port closes unanswered

    // Mirrors utils/license.js's featureOK("pipeline") — duplicated here
    // (not imported) because that file does `window.NkLicense = ...`, which
    // throws in this service worker (no `window`). The popup locking the
    // Pipeline tab is cosmetic on its own; this is the actual enforcement,
    // since WA-Campaigns talks straight to this listener, never the popup.
    let feats = null;
    try { feats = res.licenseFeatures ? JSON.parse(res.licenseFeatures) : null; } catch (_) { feats = null; }
    const licensed = !!res.licenseValid && (feats === null || (Array.isArray(feats) && feats.includes("pipeline")));
    if (!licensed) return; // unlicensed — same "unanswered port" treatment as module-off

    if (msg && msg.type === "ping") {
      sendResponse({ ok: true });
      return;
    }

    if (msg && msg.type === "new-message") {
      handleIncomingMessage(msg).catch((err) => bgLog("warn", "Pipeline: message handling failed: " + ((err && err.message) || err)));
      sendResponse({ ok: true });
      return;
    }
  });
  return true; // keep the message channel open across the async storage read above
});
bgLog("info", "Pipeline: ready to receive WhatsApp events from WA-Campaigns (external messaging, no persistent connection needed).");
