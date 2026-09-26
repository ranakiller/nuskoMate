// modules/whatsapp-commands.js — background-context, importScripts()-ed after
// whatsapp-pipeline.js (needs WA_PIPELINE.sendReply) and before whatsapp-automation.js
// (whose onMessageExternal listener calls maybeHandleNuskoCommand below).
//
// A small WhatsApp "command channel": a message from an allow-listed chat (waCommandChats —
// its own list, entirely separate from Feeding Chats, which gates the passport pipeline, not
// this) starting with /Nusko... gets acted on and replied to. Deliberately independent of the
// Pipeline module/license gate that guards handleIncomingMessage in whatsapp-automation.js — a
// status check is most useful exactly when the pipeline looks broken or is switched off, so
// gating it the same way would be self-defeating (see whatsapp-automation.js's listener, which
// calls this unconditionally, before that gate). v1 scope is read-only status reporting only —
// no command triggers pipeline work yet.

const CMD_CHATS_KEY = "waCommandChats";

// Matched case/spacing/underscore-insensitively after the leading /Nusko, same convention CRM
// Bridge uses for its own /CRM... commands — chosen over bare keywords so an ordinary sentence
// in a chat you also use for other things can't accidentally trigger one.
function parseNuskoCommand(text) {
  const m = /^\/([A-Za-z_ ]+)/.exec(String(text || "").trim());
  if (!m) return null;
  const norm = m[1].toLowerCase().replace(/[\s_]+/g, "");
  return norm.startsWith("nusko") ? (norm.slice(5) || null) : null;
}

// Fails closed on an empty list, same as Feeding Chats' own isFeedingChat (whatsapp-automation.js)
// — an empty list means nothing has been vetted for commands yet, not "allow everything".
async function isCommandChat(waId) {
  const { [CMD_CHATS_KEY]: list } = await chrome.storage.local.get([CMD_CHATS_KEY]);
  const chats = Array.isArray(list) ? list : [];
  if (!chats.length) return false;
  return chats.some((c) => c.waId === waId);
}

// Same bucket logic as popup.js's renderPipelineMonitor, replicated here (background context has
// no DOM to call that function from) reading the pipeline's own storage directly — waReservations
// keyed by reservation number (whatsapp-pipeline.js's DB_KEY), not imported since that file's
// closure doesn't expose it.
const PM_BLOCKED_STATUSES = new Set(["not_found", "cancelled", "draft", "conflict", "unknown"]);
async function nuskoStatusReplyText() {
  const [{ waReservations }, { waPipelineLive }, lic] = await Promise.all([
    chrome.storage.local.get(["waReservations"]),
    chrome.storage.local.get(["waPipelineLive"]),
    chrome.storage.local.get(["licenseValid", "licenseName", "licenseFeatures"]),
  ]);
  const records = Object.values(waReservations || {});
  const active = records.filter((r) => (r.status === "pending" || r.status === "confirmed") && !r.repliedAt);
  const blocked = records.filter((r) => PM_BLOCKED_STATUSES.has(r.status));
  const stuck = records.filter((r) => r.stuckAt).length;

  const counts = { checking: 0, feeding: 0, confirming: 0, grouping: 0 };
  for (const r of active) {
    const stage = r.status === "pending" ? "checking" : (r.stage || "feeding");
    if (counts[stage] !== undefined) counts[stage]++;
  }

  let feats = null;
  try { feats = lic.licenseFeatures ? JSON.parse(lic.licenseFeatures) : null; } catch (_) { feats = null; }
  const pipelineLicensed = !!lic.licenseValid && (feats === null || (Array.isArray(feats) && feats.includes("pipeline")));

  return [
    "Nuskomate status:",
    `Pipeline: ${counts.checking} checking, ${counts.feeding} feeding, ${counts.confirming} confirming, ${counts.grouping} grouping`,
    `Needs attention: ${blocked.length}${stuck ? ` (${stuck} stuck)` : ""}`,
    `License: ${lic.licenseValid ? `active${lic.licenseName ? " (" + lic.licenseName + ")" : ""}${pipelineLicensed ? "" : " - no Pipeline feature"}` : "not activated"}`,
    `Live sending: ${waPipelineLive ? "on" : "off (dry run)"}`,
  ].join("\n");
}

async function runNuskoCommand(cmd) {
  switch (cmd) {
    case "status": return nuskoStatusReplyText();
    default: return null; // unrecognized /Nusko... word - stay silent, same tone as an unrecognized /CRM... one
  }
}

// ── AI command understanding (optional, off by default) ───────────────────
// Talks to the AI Bridge extension (a peer, like WA-Campaigns). The AI tab this extension used to
// have (chat, model picker, WebLLM, batch decision tester - root background.js's callGemini,
// popup/ai.js, popup/webllm-runner.js) moved there entirely and no longer exists here at all. AI
// Bridge holds one Gemini key, shared with CRM Bridge and WA-Campaigns too, so switching provider
// later is a one-place change instead of editing every extension that uses it.
const AI_BRIDGE_ID = "jcchaofblhinmenpgkfmdghbkhfkjogf";
const AI_TIMEOUT_MS = 70000;

function callAiBridge(msg) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: `AI Bridge didn't answer within ${AI_TIMEOUT_MS / 1000}s` }), AI_TIMEOUT_MS);
    try {
      chrome.runtime.sendMessage(AI_BRIDGE_ID, msg, (resp) => {
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, error: `AI Bridge not reachable: ${err.message} (is it installed, and is this extension's id on its Allowed list?)` });
        else resolve(resp || { ok: false, error: "Empty response from AI Bridge" });
      });
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, error: (e && e.message) || String(e) });
    }
  });
}

const NUSKO_COMMAND_DESCRIPTIONS = {
  status: "asking for the Nuskomate WhatsApp pipeline's current status - how many reservations are being checked/fed/confirmed/grouped, how many need attention, license state, whether live sending is on",
};

async function classifyNuskoCommandWithAI(text) {
  const { waAiCommands } = await chrome.storage.local.get(["waAiCommands"]);
  if (!waAiCommands) return null; // opt-in - the key itself lives in the AI Bridge extension
  const s = String(text || "").trim();
  if (!s) return null;
  const options = Object.entries(NUSKO_COMMAND_DESCRIPTIONS).map(([k, d]) => `${k}: ${d}`).join("\n");
  const prompt = [
    "You are a strict command classifier for the Nuskomate Chrome extension's WhatsApp control channel.",
    "Reply with EXACTLY one word: one of the command names below, or NONE if the message doesn't clearly ask for one of them. No punctuation, no explanation, nothing else.",
    "", "Commands:", options, "", `Message: "${s}"`,
  ].join("\n");
  const r = await callAiBridge({ type: "generateText", prompt });
  if (!r.ok) { bgLog("warn", "Command channel: AI classification failed: " + r.error); return null; }
  const word = String(r.text || "").trim().toLowerCase().replace(/[^a-z]/g, "");
  return Object.prototype.hasOwnProperty.call(NUSKO_COMMAND_DESCRIPTIONS, word) ? word : null;
}

// WA-Campaigns pushes EVERY WhatsApp event it sees for an allow-listed chat, including this
// extension's own outgoing replies (fromMe:true) - a moment after maybeHandleNuskoCommand sends
// one, it echoes straight back as its own "new-message" push. fromMe can't just be filtered here
// (a self-chat command you type yourself also has fromMe:true - the whole point of allowing a
// self-chat as the command chat), so instead every reply's message id is recorded, and an
// incoming message whose id matches one this extension itself sent is never reprocessed. CRM
// Bridge hit exactly this failure mode live (2026-09-26) once it had a command whose own reply
// text could be re-classified as a fresh command (a status reply contains numbers/words an AI
// classifier can match again) - same architecture here, so fixed proactively before it's hit.
const CMD_REPLY_IDS_KEY = "nkCmdReplyIds";
const CMD_REPLY_IDS_MAX = 200;
async function isOwnCmdReply(messageId) {
  if (!messageId) return false;
  const { [CMD_REPLY_IDS_KEY]: list } = await chrome.storage.local.get([CMD_REPLY_IDS_KEY]);
  return Array.isArray(list) && list.includes(messageId);
}
async function markOwnCmdReply(messageId) {
  if (!messageId) return;
  const { [CMD_REPLY_IDS_KEY]: list } = await chrome.storage.local.get([CMD_REPLY_IDS_KEY]);
  const next = Array.isArray(list) ? list.slice() : [];
  if (!next.includes(messageId)) next.push(messageId);
  if (next.length > CMD_REPLY_IDS_MAX) next.splice(0, next.length - CMD_REPLY_IDS_MAX);
  await chrome.storage.local.set({ [CMD_REPLY_IDS_KEY]: next });
}
// Second, independent line of defense (in-memory - the persisted id match above is the real fix,
// this is a circuit breaker in case an id ever fails to match for some reason not seen yet): never
// send more than one command-channel reply to the same chat within this window, full stop.
const CMD_REPLY_COOLDOWN_MS = 4000;
const cmdReplyCooldown = new Map(); // waId -> last reply timestamp

// Called from whatsapp-automation.js's onMessageExternal listener for every new-message push,
// unconditionally — independent of the modulePipeline/"pipeline"-license gate that guards
// handleIncomingMessage (see file header comment). fromMe is deliberately NOT filtered out here:
// a self-chat message (the natural place to run your own commands from) always has fromMe true.
// The allow-list check runs BEFORE the AI fallback - message text is never sent to Gemini for a
// chat that isn't already on waCommandChats.
async function maybeHandleNuskoCommand(payload) {
  const { waId, messageId, chatName, text } = payload || {};
  if (!waId) return;
  if (await isOwnCmdReply(messageId)) return; // our own reply, echoed back - never reprocess it
  if (!(await isCommandChat(waId))) return; // fail closed - never treated as a command, or AI-classified, from an unlisted chat
  let cmd = parseNuskoCommand(text);
  let viaAi = false;
  // AI fallback only runs when the message isn't a /Nusko... attempt at all - an explicit but
  // misspelled /Nusko command is reported as unrecognized below, never silently reinterpreted.
  if (!cmd) { cmd = await classifyNuskoCommandWithAI(text); viaAi = !!cmd; }
  if (!cmd) return; // not a /Nusko... message, and (if AI is off, or didn't match) not understood either - silent
  const lastReplyAt = cmdReplyCooldown.get(waId) || 0;
  if (Date.now() - lastReplyAt < CMD_REPLY_COOLDOWN_MS) {
    bgLog("warn", `Command channel: "${chatName || waId}": reply suppressed - too soon after the last one (possible echo loop)`);
    return;
  }
  const reply = await runNuskoCommand(cmd);
  if (reply == null) {
    bgLog("info", `Command channel: "${chatName || waId}": /Nusko${cmd} not recognized - ignored`);
    return;
  }
  bgLog("info", `Command channel: "${chatName || waId}": ${viaAi ? `AI understood this as "${cmd}"` : `/Nusko${cmd}`} - replying`);
  cmdReplyCooldown.set(waId, Date.now());
  const r = await WA_PIPELINE.sendReply(waId, { text: reply }).catch((err) => { bgLog("warn", "Command channel: reply failed: " + ((err && err.message) || err)); return null; });
  if (r && r.msgId) markOwnCmdReply(r.msgId);
}
