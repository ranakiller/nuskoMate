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

// Finds the closest-in-time pairing INVOLVING THE JUST-ARRIVED MESSAGE — not
// a search for the single best pairing anywhere in the whole buffer. That
// broader search was tried first and had a real bug: once one self-
// contained pairing (an image sent with the number as its own caption, gap
// 0) had already been detected and deduped, a LATER, unrelated self-
// contained pairing arriving in the same chat could tie it on gap (also 0)
// and lose the tie-break, so the new one was never found at all — the
// handler kept "discovering" the same already-handled reservation instead
// of the new one. Anchoring to the message that just arrived sidesteps this
// entirely: it can only ever pair with something else (or with itself), and
// old, already-resolved pairings elsewhere in the buffer are irrelevant to
// it, whichever role it plays in either direction.
function findPairing(waId, newEntry) {
  const list = recentByChat.get(waId);
  if (!list) return null;
  if (PASSPORT_MEDIA_TYPES.has(newEntry.messageType)) {
    // The new message IS the passport — find the closest reservation number
    // (its own caption counts, since it's in this same list, at gap 0).
    let best = null;
    for (const n of list) {
      if (!n.reservationNumber) continue;
      const gap = Math.abs(newEntry.timestamp - n.timestamp);
      if (!best || gap < best.gap) best = { mediaEntry: newEntry, reservationNumber: n.reservationNumber, gap };
    }
    return best;
  }
  if (newEntry.reservationNumber) {
    // The new message IS the reservation number — find the closest passport-shaped message.
    let best = null;
    for (const m of list) {
      if (!PASSPORT_MEDIA_TYPES.has(m.messageType)) continue;
      const gap = Math.abs(newEntry.timestamp - m.timestamp);
      if (!best || gap < best.gap) best = { mediaEntry: m, reservationNumber: newEntry.reservationNumber, gap };
    }
    return best;
  }
  return null; // plain text with no number, or a media type we don't treat as a passport (audio/video/sticker/...)
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

// ── The actual per-message handler ──────────────────────────────────────
async function handleIncomingMessage(payload) {
  const { waId, isGroup, chatName, fromMe, messageId, messageType, text, timestamp } = payload || {};
  // TEMPORARY debug trace (remove once live receiving is confirmed working) —
  // logs every raw event this handler is ever called with, BEFORE any of the
  // filtering below, so a message that gets dropped by the fromMe check, the
  // pairing check, or dedup still leaves visible proof it arrived at all.
  await bgLog("info", `Pipeline: [debug] raw event — waId=${waId} fromMe=${fromMe} type=${messageType} textLen=${(text || "").length} chatName="${chatName}"`);
  if (!waId || fromMe) return; // never react to the agency's own messages
  const now = timestamp || Date.now();

  const entry = { waId, messageId, messageType, text, reservationNumber: extractReservationNumber(text), timestamp: now };
  rememberMessage(entry);

  const pairing = findPairing(waId, entry);
  if (!pairing) return; // nothing to act on yet — the matching half may not have arrived

  if (await alreadyDetected(pairing.mediaEntry.messageId)) return;
  await markDetected(pairing.mediaEntry.messageId);

  await bgLog(
    "info",
    `Pipeline: passport detected — reservation ${pairing.reservationNumber} in ${isGroup ? "group" : "chat"} "${chatName}" (message ${pairing.mediaEntry.messageId}, type ${pairing.mediaEntry.messageType})`
  );

  // Hands off to modules/whatsapp-pipeline.js (Phase 6): CRM lookup ->
  // outcome handling -> Masar feed -> conflict check -> group creation ->
  // reply. That module's own `waPipelineLive` gate (Settings) decides
  // whether the final WhatsApp reply is actually sent or just logged as a
  // dry run — nothing here needs to know which.
  WA_PIPELINE.processReservationEvent(
    { waId, isGroup, chatName, messageId: pairing.mediaEntry.messageId },
    pairing.reservationNumber
  ).catch((err) => bgLog("error", `Pipeline: failed for reservation ${pairing.reservationNumber}: ${(err && err.message) || err}`));
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

  chrome.storage.local.get(["modulePipeline", "extensionEnabled"], (res) => {
    const enabled = res.extensionEnabled !== false && res.modulePipeline !== false; // default on
    if (!enabled) return; // no sendResponse — port closes unanswered

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
