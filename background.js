/*
 * Nuskomate background service worker.
 *
 * Sole job: proxy license-server network calls for the content scripts and
 * popup. Fetches made here are governed only by the extension's
 * host_permissions, so they are NEVER blocked by a page's Content-Security-
 * Policy (which DOES block fetch() initiated from content scripts on strict
 * sites like masar.nusuk.sa). The target URL is passed in each message, so
 * there is a single source of truth (utils/license.js → LICENSE_SERVER).
 */

// Classic (non-module) service worker — importScripts, not ES import.
// modules/whatsapp-automation.js is the WhatsApp/passport-detection side of
// the automation plan; kept in its own file rather than growing this one
// further, given how much more is planned to land there (CRM lookup, Masar
// feeding, group creation) as that pipeline gets built out.
importScripts("modules/whatsapp-pipeline.js", "modules/whatsapp-automation.js");

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "nkUi") {                       // UI mode switch (popup ↔ side panel)
    applyUiMode().finally(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "nkSyncPollNow") {              // popup just opened — check for remote changes right away
    pollPull(false).finally(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "nkSyncNow") {                  // "Sync now" button — push whatever's pending, then pull
    clearTimeout(pushDebounce);                    // don't also fire the debounced auto-push a moment later
    autoPushIfEnabled().then(() => pollPull(false)).finally(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "nkTranslate") {                // Translation Rules — see doTranslate()/queueTranslate() below
    queueTranslate(msg.text, msg.sl, msg.tl)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err && err.message }));
    return true;
  }
  if (msg.type === "nkRemoveBg") {                 // JPG & PDF Tools > Remove Background — see removeBackground() below
    removeBackground(msg.fileB64, msg.fileType)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err && err.message }));
    return true;
  }
  if (msg.type === "nkWebshotSelected") {          // Element Screenshot — see runWebshotCapture() below
    const tabId = _sender.tab && _sender.tab.id;
    runWebshotCapture(tabId, msg.rect, msg.dpr || 1, msg.pageTitle || "screenshot")
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        if (tabId != null) chrome.tabs.sendMessage(tabId, { type: "nkWebshotFailed", error: err && err.message }).catch(() => {});
        sendResponse({ ok: false, error: err && err.message });
      });
    return true;
  }
  if (msg.type === "nkWaCallAction") {              // raw WA-Campaigns action relay for the popup's test harness — modules/whatsapp-pipeline.js's callWaAction, exposed to popup.js
    // Passes WA-Campaigns' own response straight through (not nested under a
    // `resp` key) — every caller (the wa-test-* buttons' resp.ok/resp.error,
    // the Feeding Chats search's resp.chats) already reads WA-Campaigns'
    // fields directly off the top level. Wrapping it as { ok: true, resp }
    // made resp.chats undefined (the real array sat at resp.resp.chats
    // instead), which is why the Feeding Chats search always reported zero
    // chats even though WA-Campaigns' getChats was actually returning data.
    WA_PIPELINE.callWaAction(msg.action, msg.payload || {})
      .then((resp) => sendResponse(resp))
      .catch((err) => sendResponse({ ok: false, error: err && err.message }));
    return true;
  }
  if (msg.type === "nkPipelineCrmLookup") {          // popup's CRM Lookup test — the pipeline's own lookupReservationInCrm (via the CRM Bridge)
    WA_PIPELINE.lookupReservationInCrm(String(msg.reservationNo || "").trim())
      .then((resp) => sendResponse(resp))
      .catch((err) => sendResponse({ ok: false, error: err && err.message }));
    return true;
  }
  if (msg.type === "nkCrmBridgeCall") {              // popup's "Test bridge" button — modules/whatsapp-pipeline.js's callCrmBridge
    WA_PIPELINE.callCrmBridge(msg.payload || { type: "ping" })
      .then((resp) => sendResponse(resp))
      .catch((err) => sendResponse({ ok: false, error: err && err.message }));
    return true;
  }
  if (msg.type === "nkWebshotCaptureForAutomation") { // same capture pipeline, dataUrl handed back instead of downloaded/copied/opened — Phase 5 of the WhatsApp automation plan
    const tabId = _sender.tab && _sender.tab.id;
    runWebshotCapture(tabId, msg.rect, msg.dpr || 1, msg.pageTitle || "screenshot", "return")
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((err) => sendResponse({ ok: false, error: err && err.message }));
    return true;
  }
  if (msg.type === "nkMasarPassportScanned") {      // OCR-scan relay from modules/masar-add-mutamer.js — resumes whichever reservation queued this passport
    WA_PIPELINE.handleMasarScanResult(msg)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err && err.message }));
    return true;
  }
  if (msg.type === "nkMasarRegisterTestFeed") {     // popup's "Masar Passport Feed" test — registers with the OCR-relay tracker the same way a real WhatsApp event would, so testing shows real Pipeline Log results
    WA_PIPELINE.registerTestFeed(msg.labels || [])
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err && err.message }));
    return true;
  }
  if (msg.type === "nkPipelineClearQueue") {        // popup's "Clear Stuck Queue" button — see modules/whatsapp-pipeline.js's clearStuckQueue
    WA_PIPELINE.clearStuckQueue()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err && err.message }));
    return true;
  }
  if (msg.type === "nkPipelineClearAll") {          // popup's "Clear All" button — see modules/whatsapp-pipeline.js's clearAllQueue
    WA_PIPELINE.clearAllQueue()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err && err.message }));
    return true;
  }
  if (msg.type === "nkMasarMutamerConfirmed") {     // Mutamer List confirmation relay from modules/masar-add-mutamer.js — the real "this passport is actually saved" signal
    WA_PIPELINE.handleMutamerConfirmed(msg)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err && err.message }));
    return true;
  }
  if (msg.type === "nkPipelineRetry") {             // popup's per-item "Retry" button on a flagged/stuck reservation
    WA_PIPELINE.retryReservation(msg.reservationNo)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err && err.message }));
    return true;
  }
  if (msg.type !== "nkLicense") return;            // not for us
  handle(msg)
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false, error: "Cannot reach the license server" }));
  return true; // keep the channel open for the async reply
});

// ── WhatsApp pipeline stuck-reservation watchdog ─────────────────────────
// Always on (unlike the cloud-sync alarm above, which only runs when the
// user has turned that feature on) — this is core pipeline reliability, not
// an opt-in feature. Every 5 minutes, ask whatsapp-pipeline.js to flag any
// active reservation that's stopped moving; see checkStuckReservations's own
// comment for what "stuck" means and why this only ever flags, never
// auto-fixes.
const PIPELINE_WATCHDOG_ALARM = "nkPipelineWatchdog";
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === PIPELINE_WATCHDOG_ALARM) WA_PIPELINE.checkStuckReservations(); });
function armPipelineWatchdog() { chrome.alarms.create(PIPELINE_WATCHDOG_ALARM, { periodInMinutes: 5 }); }
chrome.runtime.onInstalled.addListener(armPipelineWatchdog);
chrome.runtime.onStartup.addListener(armPipelineWatchdog);

// ── UI mode: floating popup (default) or docked side panel ──────────────────
// Toggled from the popup/side-panel header. When "sidepanel", we clear the
// action popup so clicking the icon opens the side panel instead.
async function applyUiMode() {
  let mode = "popup";
  try { mode = (await chrome.storage.local.get("uiMode")).uiMode || "popup"; } catch (_) {}
  try {
    if (mode === "sidepanel") {
      await chrome.action.setPopup({ popup: "" });
      if (chrome.sidePanel) await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    } else {
      if (chrome.sidePanel) await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
      await chrome.action.setPopup({ popup: "popup/popup.html" });
    }
  } catch (_) {}
}
chrome.runtime.onInstalled.addListener(applyUiMode);
chrome.runtime.onStartup.addListener(applyUiMode);
chrome.storage.onChanged.addListener((c, a) => { if (a === "local" && c.uiMode) applyUiMode(); });
applyUiMode();

// ── Translation Rules defaults ───────────────────────────────────────────
// modules/translation.js ("Auto Translate Names") used to hardcode 4
// name-field EN→AR pairs (first/second/third/family name) plus 3 other
// fields (service name, details, a generic placeholder pair) — all removed
// now that Translation Rules can do the same thing, configurably. Only the
// 4 name pairs get carried forward, as pre-built (not forced-on) rules, so
// existing Translation Rules users get them for free and new installs start
// with a sane default instead of an empty list. Idempotent — checks each
// one's sourceSelector before adding, so this is safe to run on every
// startup without ever duplicating a rule the user already has (including
// one they've since edited or deleted on purpose).
const DEFAULT_TRANSLATE_PATH = "/umrah/mutamer/add-mutamer";
const DEFAULT_TRANSLATE_RULES = [
  { name: "First Name (EN → AR)", source: 'div[formgroupname="firstName"] input[formcontrolname="en"]', target: 'div[formgroupname="firstName"] input[formcontrolname="ar"]' },
  { name: "Second Name (EN → AR)", source: 'div[formgroupname="secondName"] input[formcontrolname="en"]', target: 'div[formgroupname="secondName"] input[formcontrolname="ar"]' },
  { name: "Third Name (EN → AR)", source: 'div[formgroupname="thirdName"] input[formcontrolname="en"]', target: 'div[formgroupname="thirdName"] input[formcontrolname="ar"]' },
  { name: "Family Name (EN → AR)", source: 'div[formgroupname="familyName"] input[formcontrolname="en"]', target: 'div[formgroupname="familyName"] input[formcontrolname="ar"]' },
];

// Stored shape of a rule's URL list — see utils/url-match.js, which this
// service worker doesn't load. NO_MASAR_PATH is that file's constant of the
// same name: the pathname older Nuskomate versions see for a rule that has
// no Masar URL, so they never run it.
const NO_MASAR_PATH = "/__nuskomate_other_sites__";
const WA_HOST = "web.whatsapp.com";

// A ready-made starting point for WhatsApp Web. Seeded once (see the flag
// below), and it only does anything after WhatsApp Web is allowed in
// Settings → Sites.
//
// Ships DISABLED — it would otherwise start translating every message in
// every chat the moment someone allows the site, which is a surprising thing
// to do on a messaging app. Flip it on in Translation Rules.
//
// Two deliberate choices in this rule's shape:
//   • ".selectable-text" is WhatsApp's own long-standing class on message
//     text. It isn't a documented API and could change on any WhatsApp
//     build; if it does, this rule quietly stops matching (no breakage
//     elsewhere) and the selector can be re-picked with the element picker.
//   • displayMode "tooltip", NOT "replace" — WhatsApp Web is a React app
//     that owns its DOM and re-renders over anything we write into a message
//     bubble. Tooltip mode never touches the page's own text: the
//     translation shows on hover, with a "Replace text" button if you do
//     want it committed for that one message.
const DEFAULT_WA_TRANSLATE_RULE = {
  name: "Translate incoming messages (hover)",
  selector: ".selectable-text",
};

async function seedDefaultTranslateRules() {
  try {
    const res = await chrome.storage.local.get(["autoClickRules", "moduleTranslate", "moduleTranslateRules", "waTranslateRuleSeeded"]);
    const rules = Array.isArray(res.autoClickRules) ? res.autoClickRules : [];
    const existingSources = new Set(rules.filter((r) => r && r.type === "translate").map((r) => r.sourceSelector));
    const missing = DEFAULT_TRANSLATE_RULES.filter((d) => !existingSources.has(d.source));

    // One-time correction: an earlier version of this seed shipped these 4
    // rules site-wide (pathname ""). Any rule still sitting at that original
    // blank pathname is presumed unmodified (a real edit would have set
    // something) and gets pinned to the intended page instead.
    let patched = false;
    // Only rules from before multi-URL support — a rule with a `urls` list
    // was saved by a version that already had this fix.
    const patchedRules = rules.map((r) => {
      if (r && r.type === "translate" && !r.pathname && !Array.isArray(r.urls) && DEFAULT_TRANSLATE_RULES.some((d) => d.source === r.sourceSelector)) {
        patched = true;
        return { ...r, pathname: DEFAULT_TRANSLATE_PATH, pathMatch: "exact" };
      }
      return r;
    });

    const updates = {};
    const added = missing.map((d) => ({
      id: Date.now() + Math.random(),
      type: "translate",
      mode: "fieldToField",
      enabled: true,
      name: d.name,
      urls: [{ match: "page", host: "masar.nusuk.sa", path: DEFAULT_TRANSLATE_PATH }],
      pathname: DEFAULT_TRANSLATE_PATH,
      pathMatch: "exact",
      requiredElements: [d.target],
      sourceSelector: d.source,
      sourceLang: "en",
      targetLang: "ar",
    }));

    // Seeded once, ever — tracked by its own flag rather than by "is a rule
    // with this selector present?" like the Masar block above, so deleting it
    // actually sticks instead of it reappearing on the next browser start.
    //
    // The hasWaRule check is the Cloud Sync case: a second device pulls the
    // rule down in the synced autoClickRules snapshot while its own flag is
    // still unset, and would otherwise seed a duplicate and push that back.
    const hasWaRule = rules.some((r) => r && r.type === "translate" &&
      (r.site === "whatsapp" || (Array.isArray(r.urls) && r.urls.some((u) => u && u.host === WA_HOST))));
    if (!res.waTranslateRuleSeeded) {
      if (!hasWaRule) added.push({
        id: Date.now() + Math.random(),
        type: "translate",
        mode: "autoDetect",
        enabled: false,            // opt-in — see DEFAULT_WA_TRANSLATE_RULE
        name: DEFAULT_WA_TRANSLATE_RULE.name,
        urls: [{ match: "site", host: WA_HOST, path: "" }],   // whole site — WhatsApp Web is a single-route SPA
        pathname: NO_MASAR_PATH,
        pathMatch: "exact",
        requiredElements: [DEFAULT_WA_TRANSLATE_RULE.selector],
        sourceLang: "auto",
        targetLangs: [],           // empty = translate into the Settings language
        displayMode: "tooltip",
      });
      updates.waTranslateRuleSeeded = true;
    }

    if (added.length || patched) updates.autoClickRules = [...patchedRules, ...added];

    // One-time carry-over: if the old always-on module was enabled, turn on
    // Translation Rules too so the equivalent behavior keeps working.
    if (res.moduleTranslate && !res.moduleTranslateRules) updates.moduleTranslateRules = true;

    if (Object.keys(updates).length) await chrome.storage.local.set(updates);
    if (res.moduleTranslate !== undefined) await chrome.storage.local.remove("moduleTranslate");
  } catch (_) {}
}
chrome.runtime.onInstalled.addListener(seedDefaultTranslateRules);
chrome.runtime.onStartup.addListener(seedDefaultTranslateRules);
seedDefaultTranslateRules();

// ── Sites: runs everywhere by default, "Never run on" is the only control ──
// (2026-09-16 — was opt-in per site via a runtime Chrome permission prompt;
// now `<all_urls>` is a REQUIRED manifest host permission, so Nuskomate has
// full site access outright and there's nothing left to ask Chrome for at
// runtime.) The only site-level lever the user has now is a plain
// storage-backed blocklist (blockedSites, "Never run on") — everything else
// runs everywhere, always. That's applied as excludeMatches on ONE dynamic
// content-script registration covering every site except Masar (already
// covered by the manifest's own static content_scripts, so it isn't
// injected twice there) and anything on the blocklist.
const SITE_SCRIPT_ID = "nk-sites";
// The portable part of the Masar stack — the rules/workflows engine and
// what it needs. Everything Masar-specific (autofill, OCR, BRN, …) stays out.
const SITE_SCRIPT_FILES = [
  "utils/logger.js", "utils/notify.js", "utils/license.js", "utils/route-watcher.js",
  "utils/element-type-detector.js", "utils/inspector.js", "utils/url-match.js",
  "modules/auto-clicker.js",
];
const MASAR_PATTERN = "*://masar.nusuk.sa/*";
const ALL_SITES_PATTERN = "*://*/*";
const VALID_HOST = /^([a-z0-9-]+\.)*[a-z0-9-]+$/i;
const sitePattern = (host) => `*://*.${host}/*`;

// Serialized — unregister+register from two overlapping calls would race
// into a "duplicate script id" error.
let siteSyncChain = Promise.resolve();
function syncSiteAccess() {
  siteSyncChain = siteSyncChain.then(syncSiteAccessNow, syncSiteAccessNow);
  return siteSyncChain;
}
async function syncSiteAccessNow() {
  try {
    const cfg = await chrome.storage.local.get(["blockedSites"]);
    const blocked = (Array.isArray(cfg.blockedSites) ? cfg.blockedSites : []).filter((h) => VALID_HOST.test(h || ""));
    const excludeMatches = [MASAR_PATTERN, ...blocked.map(sitePattern)];
    const [existing] = await chrome.scripting.getRegisteredContentScripts({ ids: [SITE_SCRIPT_ID] });
    // The worker wakes up constantly (messages, the sync alarm) and runs this
    // each time — leave an already-correct registration alone.
    const same = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);
    if (existing && same(existing.excludeMatches, excludeMatches) && same(existing.js, SITE_SCRIPT_FILES)) return;
    if (existing) await chrome.scripting.unregisterContentScripts({ ids: [SITE_SCRIPT_ID] });
    await chrome.scripting.registerContentScripts([{
      id: SITE_SCRIPT_ID,
      matches: [ALL_SITES_PATTERN],
      excludeMatches,
      js: SITE_SCRIPT_FILES,
      runAt: "document_idle",
      persistAcrossSessions: true,
    }]);
  } catch (err) {
    console.warn("[Nuskomate] site access sync failed:", err && err.message);
  }
}

// A site just removed from "Never run on" should start working in tabs
// already open on it, not only after the next reload — check every open
// tab (probing first so a tab that already has the stack isn't re-injected).
async function injectIntoOpenTabs() {
  try {
    const { blockedSites } = await chrome.storage.local.get(["blockedSites"]);
    const blocked = Array.isArray(blockedSites) ? blockedSites : [];
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      let host = "";
      try { const u = new URL(tab.url || ""); if (/^https?:$/.test(u.protocol)) host = u.hostname.toLowerCase(); } catch (_) {}
      if (!host || host === "masar.nusuk.sa") continue;
      if (blocked.some((b) => host === b || host.endsWith("." + b))) continue;
      const target = { tabId: tab.id };
      // Content scripts share one isolated world, so a NkLicense global
      // there means this tab already has the stack — don't run it twice.
      const [probe] = await chrome.scripting.executeScript({ target, func: () => !!window.NkLicense }).catch(() => []);
      if (!probe || probe.result) continue;
      await chrome.scripting.executeScript({ target, files: SITE_SCRIPT_FILES }).catch(() => {});
    }
  } catch (_) {}
}

chrome.runtime.onInstalled.addListener(() => {
  // One-time cleanup — allowedSites/allowAllSites mirrored the old
  // per-site Chrome permission grants, which no longer exist now that
  // <all_urls> is unconditional; nothing reads these keys anymore.
  chrome.storage.local.remove(["allowedSites", "allowAllSites"]);
  syncSiteAccess().then(() => injectIntoOpenTabs());
});
chrome.runtime.onStartup.addListener(() => syncSiteAccess());
chrome.storage.onChanged.addListener((c, a) => { if (a === "local" && c.blockedSites) syncSiteAccess().then(() => injectIntoOpenTabs()); });
syncSiteAccess();

// Google's unofficial (but widely used) translate endpoint, called from here
// instead of modules/auto-clicker.js directly. It used to fetch() straight
// from the content script, which happened to work on Masar but silently (or
// not so silently — see quickTranslateElement's error toast) fails on any
// site with a stricter Content-Security-Policy: web.whatsapp.com's connect-src
// allow-lists only WhatsApp/Facebook domains, so a content-script fetch to
// translate.googleapis.com is blocked by the PAGE itself before it ever
// leaves the browser. A background fetch is governed only by this
// extension's host_permissions (already declared), never by any page's CSP —
// same reasoning as every other network call in this file.
async function doTranslate(text, sl, tl) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  try {
    return await res.json();
  } catch (_) {
    // This unofficial endpoint returns an HTML "unusual traffic" page instead
    // of JSON when Google's abuse detection trips (a shared/VPN IP, or too
    // many requests too fast) — surface that plainly instead of a raw JSON
    // parse error, since translateText()'s caller shows this to the user.
    throw new Error(res.ok ? "Google's translate service is temporarily blocking this connection" : `Translate request failed (${res.status})`);
  }
}

// ── Throttling ───────────────────────────────────────────────────────────
// A single Masar field-to-field rule translates one field at a time as the
// user types — never enough requests at once to matter. An "auto-detect"
// rule on a busy WhatsApp chat is a different story: it scans every visible
// message in one pass, so opening a chat with 30 messages fired 30
// simultaneous requests at Google's free, unofficial, quota-less endpoint —
// which is exactly the "unusual traffic" burst it exists to block. Every
// nkTranslate message funnels through this ONE queue (shared across every
// tab and every rule) so a burst is spread out instead of fired all at once.
//
// A small cache sits in front of it: forwarded messages (the same paragraph
// appearing 3 times in a row, as WhatsApp shows them) are a real, common
// case, and translating identical text 3 times is pure waste that only adds
// to the burst.
const TRANSLATE_MAX_CONCURRENT = 2;
const TRANSLATE_STAGGER_MS = 200;
const TRANSLATE_CACHE_MAX = 300;
const TRANSLATE_CACHE_TTL_MS = 10 * 60 * 1000; // long chats keep reusing the same forwarded text

let translateActive = 0;
const translateQueue = [];
const translateCache = new Map(); // "sl|tl|text" -> { at, data }

function drainTranslateQueue() {
  if (translateActive >= TRANSLATE_MAX_CONCURRENT || !translateQueue.length) return;
  const job = translateQueue.shift();
  translateActive++;
  doTranslate(job.text, job.sl, job.tl)
    .then((data) => {
      translateCache.set(job.key, { at: Date.now(), data });
      // Map preserves insertion order — evicting the first key is evicting
      // the oldest, a cheap approximation of LRU that's good enough here.
      if (translateCache.size > TRANSLATE_CACHE_MAX) translateCache.delete(translateCache.keys().next().value);
      job.resolve(data);
    }, job.reject)
    .finally(() => { translateActive--; setTimeout(drainTranslateQueue, TRANSLATE_STAGGER_MS); });
  // Also try to fill the next concurrent slot, staggered rather than instant.
  setTimeout(drainTranslateQueue, TRANSLATE_STAGGER_MS);
}

function queueTranslate(text, sl, tl) {
  const key = `${sl}|${tl}|${text}`;
  const hit = translateCache.get(key);
  if (hit && Date.now() - hit.at < TRANSLATE_CACHE_TTL_MS) return Promise.resolve(hit.data);
  return new Promise((resolve, reject) => {
    translateQueue.push({ key, text, sl, tl, resolve, reject });
    drainTranslateQueue();
  });
}

// Uint8Array -> base64, without FileReader (service workers don't have one —
// that's a Window/dedicated-Worker API only). Chunked so a large image
// doesn't blow the call stack going through String.fromCharCode(...bytes).
function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

// remove.bg — the customer's OWN API key (Settings > JPG & PDF Tools), same
// "bring your own key" pattern as ocr.space: no shared/fallback key, so one
// install's usage never eats into another's free-tier quota. Called straight
// from here (not proxied through the Nuskomate license server, unlike OCR) —
// there's no server-side secret to protect for a plain image-in/image-out
// call, so keeping it a direct background fetch is simpler. A background
// fetch with this host in host_permissions also sidesteps whatever CORS
// policy remove.bg does or doesn't set, the same reasoning as every other
// network call in this file.
async function removeBackground(fileB64, fileType) {
  const key = (await chrome.storage.local.get(["removeBgApiKey"])).removeBgApiKey || "";
  if (!key.trim()) throw new Error("Add your remove.bg API key in Settings to use this tool");
  const bytes = Uint8Array.from(atob(fileB64 || ""), (c) => c.charCodeAt(0));
  const fd = new FormData();
  fd.append("image_file", new Blob([bytes], { type: fileType || "image/jpeg" }), "image");
  fd.append("size", "auto");
  const res = await fetch("https://api.remove.bg/v1.0/removebg", { method: "POST", headers: { "X-Api-Key": key.trim() }, body: fd });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const detail = body && body.errors && body.errors[0] && body.errors[0].title;
    throw new Error(detail || `remove.bg request failed (${res.status})`);
  }
  const out = new Uint8Array(await res.arrayBuffer());
  return { fileB64: bytesToBase64(out), fileType: "image/png" };
}

// ── Element Screenshot ────────────────────────────────────────────────────
// utils/webshot-picker.js (injected on demand — see popup/file-tools.js's
// "webshot" tool) reports back a target rectangle in PAGE (document, not
// viewport) coordinates once the user drags from one element to another.
// Getting an image of a region bigger than one screenful means scrolling the
// page through a grid of stops, capturing chrome.tabs.captureVisibleTab() at
// each one (it can only ever see what's currently on screen — there's no
// "capture the whole document" API), then stitching the results back
// together. Each tile is cropped to just the slice that falls inside the
// target rectangle using where the page ACTUALLY ended up scrolled to, not
// where it was asked to go — a short page clamps scrollTo() before reaching
// the last row/column's requested position, and using the real value is what
// keeps the seams lined up correctly at those edges.
const WEBSHOT_MAX_TILES = 80;       // a runaway selection (say, a whole huge table) shouldn't hang the browser capturing hundreds of times
const WEBSHOT_CAPTURE_GAP_MS = 550; // chrome.tabs.captureVisibleTab is rate-limited to roughly 2/sec

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function makeScreenshotFilename(title) {
  const slug = String(title || "screenshot").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "screenshot";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${slug}-${stamp}.png`;
}

// One retry, on the specific rate-limit error only — everything else (the
// tab closed mid-capture, permission revoked) should fail immediately rather
// than silently eat another half-second first.
async function captureVisibleTabSafe(windowId) {
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch (err) {
    if (err && /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(err.message || "")) {
      await sleep(1000);
      return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    }
    throw err;
  }
}

async function runWebshotCapture(tabId, rect, dpr, pageTitle, deliverOverride) {
  if (!tabId) throw new Error("Lost track of the source tab");
  const tab = await chrome.tabs.get(tabId);
  const windowId = tab.windowId;

  const prep = await chrome.tabs.sendMessage(tabId, { type: "nkWebshotPrepare" });
  if (!prep) throw new Error("Couldn't prepare the page for capture");
  const vw = prep.vw, vh = prep.vh;

  const cols = Math.max(1, Math.ceil(rect.width / vw));
  const rows = Math.max(1, Math.ceil(rect.height / vh));
  if (cols * rows > WEBSHOT_MAX_TILES) {
    await chrome.tabs.sendMessage(tabId, { type: "nkWebshotRestore" }).catch(() => {});
    throw new Error("That selection is too large to capture in one go — try a smaller region");
  }

  const tiles = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const targetX = rect.x + col * vw, targetY = rect.y + row * vh;
      const scrolled = await chrome.tabs.sendMessage(tabId, { type: "nkWebshotScrollTo", x: targetX, y: targetY });
      await sleep(WEBSHOT_CAPTURE_GAP_MS);
      const dataUrl = await captureVisibleTabSafe(windowId);
      tiles.push({ dataUrl, actualX: scrolled.actualX, actualY: scrolled.actualY });
    }
  }

  await chrome.tabs.sendMessage(tabId, { type: "nkWebshotRestore" }).catch(() => {});

  // OffscreenCanvas works directly in a service worker — no need for the
  // extra chrome.offscreen document some other MV3 canvas work requires.
  const pxW = Math.max(1, Math.round(rect.width * dpr)), pxH = Math.max(1, Math.round(rect.height * dpr));
  const canvas = new OffscreenCanvas(pxW, pxH);
  const ctx = canvas.getContext("2d");
  for (const tile of tiles) {
    const overlapX0 = Math.max(rect.x, tile.actualX), overlapX1 = Math.min(rect.x + rect.width, tile.actualX + vw);
    const overlapY0 = Math.max(rect.y, tile.actualY), overlapY1 = Math.min(rect.y + rect.height, tile.actualY + vh);
    if (overlapX1 <= overlapX0 || overlapY1 <= overlapY0) continue; // this tile ended up clamped entirely outside the target — nothing of it belongs in the final image
    const blob = await (await fetch(tile.dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const srcX = (overlapX0 - tile.actualX) * dpr, srcY = (overlapY0 - tile.actualY) * dpr;
    const srcW = (overlapX1 - overlapX0) * dpr, srcH = (overlapY1 - overlapY0) * dpr;
    const destX = (overlapX0 - rect.x) * dpr, destY = (overlapY0 - rect.y) * dpr;
    ctx.drawImage(bitmap, srcX, srcY, srcW, srcH, destX, destY, srcW, srcH);
    bitmap.close && bitmap.close();
  }

  const finalBlob = await canvas.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await finalBlob.arrayBuffer());
  const dataUrl = "data:image/png;base64," + bytesToBase64(bytes);
  const filename = makeScreenshotFilename(pageTitle);

  const { ftScreenshotDelivery } = await chrome.storage.local.get(["ftScreenshotDelivery"]);
  const mode = deliverOverride || ftScreenshotDelivery || "tool";

  // Used by automation (e.g. modules/masar-group-reply.js, WhatsApp pipeline
  // Phase 5) that needs the actual image data back to attach elsewhere —
  // skips every user-facing delivery side effect (download/clipboard/tab/
  // badge) entirely, since none of those make sense for a caller that isn't
  // the person sitting at the keyboard.
  if (mode === "return") {
    return dataUrl; // silent — no user-facing toast, this call has no person watching for one
  }

  if (mode === "download") {
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
  } else if (mode === "clipboard") {
    await chrome.tabs.sendMessage(tabId, { type: "nkWebshotCopyClipboard", dataUrl }).catch(() => {});
  } else if (mode === "tab") {
    await chrome.storage.session.set({ nkPendingScreenshot: { dataUrl, filename, at: Date.now() } });
    await chrome.tabs.create({ url: chrome.runtime.getURL("popup/screenshot-viewer.html") });
  } else {
    await chrome.storage.session.set({ nkPendingScreenshot: { dataUrl, filename, at: Date.now() } });
    try { await chrome.action.setBadgeText({ text: "1" }); await chrome.action.setBadgeBackgroundColor({ color: "#4f6ef7" }); } catch (_) {}
  }

  // The clipboard path already shows its own toast from inside the content
  // script's write attempt (success OR failure) — a second one here would
  // just be noise, and worse, a false "delivered" if the write itself failed.
  if (mode !== "clipboard") {
    await chrome.tabs.sendMessage(tabId, { type: "nkWebshotDelivered", mode }).catch(() => {});
  }
}

// Global hotkey (Settings > default Alt+Shift+S, user-changeable at
// chrome://extensions/shortcuts — see popup/file-tools.js's hotkey row,
// which reads the live binding back with chrome.commands.getAll() since
// there's no event for "the user just changed it") — same injection
// popup/file-tools.js's own "Capture Elements" button does, just triggered
// by a keyboard command instead of a click. chrome.commands firing via its
// real keyboard shortcut counts as a user gesture in its own right, so
// activeTab is granted here exactly as it would be from a popup click —
// no extra permission needed, and this works with the popup closed (the
// whole point of a global shortcut).
async function startWebshotFromCommand() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !/^https?:/.test(tab.url || "")) return; // a chrome:// page, the new-tab page, etc. — nothing scriptable here, so just do nothing
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["utils/notify.js", "utils/webshot-picker.js"] });
  } catch (err) {
    console.warn("[Nuskomate] Element Screenshot hotkey failed:", err && err.message);
  }
}
chrome.commands.onCommand.addListener((command) => {
  if (command === "nk-webshot-start") startWebshotFromCommand();
});

async function handle(msg) {
  const base = String(msg.base || "").replace(/\/+$/, "");
  if (!base) return { ok: false, error: "Licensing not configured" };

  if (msg.action === "activate") {
    const res = await fetch(base + "/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: msg.key, device: msg.device }),
    });
    return await res.json().catch(() => ({ ok: false, error: "Bad server response" }));
  }

  if (msg.action === "status") {
    // Periodic re-validation heartbeat — same shape as activate, but never
    // admits a new device (see /status on the server for why).
    const res = await fetch(base + "/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: msg.key, device: msg.device }),
    });
    return await res.json().catch(() => ({ ok: false, error: "Bad server response" }));
  }

  if (msg.action === "scan") {
    const bytes = Uint8Array.from(atob(msg.fileB64 || ""), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: msg.fileType || "image/jpeg" });
    const fd = new FormData();
    fd.append("file", blob, msg.fileName || "scan.jpg");
    const res = await fetch(base + "/scan", {
      method: "POST",
      headers: { "X-License": msg.key || "", "X-Device": msg.device || "", "X-Feature": msg.feature || "ocr", "X-Ocr-Key": msg.ocrApiKey || "" },
      body: fd,
    });
    const data = await res.json().catch(() => ({ ok: false, error: "Bad server response" }));
    return { status: res.status, data };
  }

  if (msg.action === "admin") {
    // Master-key-gated key management. msg.path = "/admin/list" etc.
    const res = await fetch(base + msg.path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin": msg.adminKey || "" },
      body: JSON.stringify(msg.body || {}),
    });
    const data = await res.json().catch(() => ({ ok: false, error: "Bad server response" }));
    return { status: res.status, data };
  }

  if (msg.action === "sharePut") {
    // Upload a rule set → short share code (license required by the server).
    const res = await fetch(base + "/share", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-License": msg.key || "", "X-Device": msg.device || "" },
      body: JSON.stringify({ rules: msg.rules || [] }),
    });
    const data = await res.json().catch(() => ({ ok: false, error: "Bad server response" }));
    return { status: res.status, data };
  }

  if (msg.action === "syncPush") {
    // Upload the full rules+settings snapshot to this key's cloud sync slot.
    const res = await fetch(base + "/sync/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-License": msg.key || "", "X-Device": msg.device || "" },
      body: JSON.stringify({ data: msg.data || {} }),
    });
    const data = await res.json().catch(() => ({ ok: false, error: "Bad server response" }));
    return { status: res.status, data };
  }

  if (msg.action === "syncPull") {
    // Download this key's last-pushed rules+settings snapshot.
    const res = await fetch(base + "/sync/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-License": msg.key || "", "X-Device": msg.device || "" },
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => ({ ok: false, error: "Bad server response" }));
    return { status: res.status, data };
  }

  if (msg.action === "shareGet") {
    // Download a shared rule set by its code.
    const res = await fetch(base + "/share/" + encodeURIComponent(msg.code || ""), {
      headers: { "Accept": "application/json" },
    });
    const data = await res.json().catch(() => ({ ok: false, error: "Bad server response" }));
    return { status: res.status, data };
  }

  return { ok: false, error: "Unknown action" };
}

// ── Cloud Sync: push on any tracked change, poll for remote changes ────────
// Lives HERE (not in the popup) so it keeps working even while the popup is
// closed — e.g. a workflow step picked straight on the page writes to
// storage with the popup already gone (it closes itself when the picker
// starts).
//
// Bidirectional: a local change auto-pushes (debounced); changes made on
// OTHER devices are picked up by polling — once a minute via chrome.alarms
// (the only way to reliably survive this service worker being suspended;
// MV3 alarms can't fire faster than 1/minute), and immediately whenever a
// popup opens (nkSyncPollNow, near-instant for the common "did it update"
// check). Toggling sync on does one immediate pull too, so a new device
// joining an existing key doesn't start by overwriting the cloud copy with
// its own empty/different local state.
//
// Keep this URL in sync with utils/license.js's LICENSE_SERVER — background.js
// doesn't load that file, so it can't share the constant directly.
const SYNC_LICENSE_SERVER = "https://nuskomate-license.ranakiller-59.workers.dev";
const SYNC_ALARM = "nkCloudSyncPoll";

// Explicit allowlist — rules + the settings that define behavior. Deliberately
// EXCLUDES: license/device identity (pulling another device's snapshot must
// never touch THIS device's own activation), ephemeral run/log/scan state
// (acRunStatus, nkLogs, bulkResults, ocrScanned, ocrDisplay — the last
// scanned passport's data, which must NEVER travel to another device/
// customer over sync), per-device UI cosmetics (uiTab, uiSidebarCollapsed,
// uiTheme, the popup's own ac*Collapsed*/acSearch_* view-state keys, and
// cloudSyncEnabled itself), and ocrApiKey — a credential that one device
// silently overwriting another's was surprising in practice, so it stays
// local-only like the license key does.
const SYNC_KEYS = [
  "autoClickRules", "autoWorkflows", "autoUrlShiftRules",
  "moduleReload", "moduleDisableOverlay", "moduleAutofill",
  "moduleIssueDateCalc", "moduleVaccineUpload", "moduleOcr", "moduleFatherName",
  "moduleBatchUpload", "moduleAutoRules",
  // Old per-category toggles kept syncing too (read by the one-time
  // moduleAutoRules migration in popup.js) — harmless once migrated.
  "moduleAutoClicker", "moduleAutoFillRules", "moduleAutoSelect",
  "moduleWorkflows", "moduleUrlShift", "moduleBrnRequest", "moduleTranslateRules", "moduleMvTotals", "moduleGroupsExport", "moduleTalabCopy", "talabCopyFields", "talabCopyHotkey", "moduleAutoDatePicker", "modulePackageCreator", "pkgCreatorSettings", "modulePipeline", "extensionEnabled",
  "reloadInterval", "batchDelay", "batchFieldSelector",
  "emailList", "activeEmailId", "email", "mobile",
  "brnHotelList", "brnLastUsed", "brnHotkey", "brnDefaultPrice", "brnDefaultNights",
  "nkLanguage", "mvTotalsUrls",
  // "Never run on" is a plain preference, so it travels. Allowed sites do
  // NOT: each one is a Chrome permission that has to be granted on every
  // device separately — rules naming a site that isn't allowed here yet
  // show an Allow button right on the rule instead.
  "blockedSites",
];

// True only while WE are writing a just-pulled snapshot back to storage, so
// that write doesn't loop back into scheduling another push.
let applyingRemoteSync = false;
let pushDebounce = null;

function scheduleAutoPush() {
  clearTimeout(pushDebounce);
  pushDebounce = setTimeout(autoPushIfEnabled, 1500);
}

async function autoPushIfEnabled() {
  const cfg = await chrome.storage.local.get(["cloudSyncEnabled", "licenseKey", "licenseValid", "licenseDevice"]);
  if (!cfg.cloudSyncEnabled || !cfg.licenseKey || !cfg.licenseValid || !cfg.licenseDevice) return;
  const data = await chrome.storage.local.get(SYNC_KEYS);
  await chrome.storage.local.set({ cloudSyncInProgress: true });
  const r = await handle({ action: "syncPush", base: SYNC_LICENSE_SERVER, key: cfg.licenseKey, device: cfg.licenseDevice, data });
  if (r && r.data && r.data.ok) {
    await chrome.storage.local.set({ cloudSyncLastAt: r.data.at || Date.now(), cloudSyncLastError: "", cloudSyncInProgress: false });
  } else {
    await chrome.storage.local.set({ cloudSyncLastError: (r && r.data && r.data.error) || (r && r.error) || "Sync failed", cloudSyncInProgress: false });
  }
}

// Pulls the current server snapshot and applies it ONLY if it's newer than
// what this device already reflects (tracked via cloudSyncLastAt, which both
// push and pull keep up to date) — so polling every minute doesn't reapply
// (and re-flash the "syncing" banner for) data that hasn't actually changed.
// `force` skips that check — used when sync is first turned on, so it always
// seeds from the server even if cloudSyncLastAt is still 0.
async function pollPull(force) {
  const cfg = await chrome.storage.local.get(["cloudSyncEnabled", "licenseKey", "licenseValid", "licenseDevice", "cloudSyncLastAt"]);
  if (!cfg.cloudSyncEnabled) return;
  if (!cfg.licenseKey || !cfg.licenseValid || !cfg.licenseDevice) {
    if (force) await chrome.storage.local.set({ cloudSyncLastError: "Not activated" });
    return;
  }
  await chrome.storage.local.set({ cloudSyncInProgress: true });
  const r = await handle({ action: "syncPull", base: SYNC_LICENSE_SERVER, key: cfg.licenseKey, device: cfg.licenseDevice });
  const d = r && r.data;
  if (d && d.ok && d.data && typeof d.data === "object") {
    const serverAt = d.at || 0;
    if (!force && serverAt <= (cfg.cloudSyncLastAt || 0)) {
      await chrome.storage.local.set({ cloudSyncInProgress: false }); // nothing new — just clear the "syncing" flag
      return;
    }
    applyingRemoteSync = true;
    // cloudSyncPulledAt is a one-shot signal the popup watches for, distinct
    // from cloudSyncLastAt (which also updates on ordinary pushes) — only a
    // PULL can silently change things like module toggles that the popup
    // only ever reads once at open time, so only a pull needs to trigger a
    // refresh of an already-open popup.
    await chrome.storage.local.set({ ...d.data, cloudSyncLastAt: serverAt || Date.now(), cloudSyncLastError: "", cloudSyncPulledAt: Date.now(), cloudSyncInProgress: false });
    setTimeout(() => { applyingRemoteSync = false; }, 200);
  } else {
    // "No synced data found for this key yet" just means this is the first
    // device to ever turn sync on for this key — not an error to surface.
    const err = (d && d.error) || (r && r.error) || "";
    await chrome.storage.local.set(
      !/no synced data/i.test(err) ? { cloudSyncLastError: err || "Pull failed", cloudSyncInProgress: false } : { cloudSyncInProgress: false },
    );
  }
}

async function setSyncAlarm(on) {
  if (on) await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 1 });
  else await chrome.alarms.clear(SYNC_ALARM);
}
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === SYNC_ALARM) pollPull(false); });

// Re-arm the poll alarm on browser/extension restart if sync was left on —
// alarms usually survive a restart on their own, but this is a cheap safety net.
async function resumeSyncIfEnabled() {
  const cfg = await chrome.storage.local.get(["cloudSyncEnabled"]);
  if (cfg.cloudSyncEnabled) setSyncAlarm(true);
}
chrome.runtime.onInstalled.addListener(resumeSyncIfEnabled);
chrome.runtime.onStartup.addListener(resumeSyncIfEnabled);
resumeSyncIfEnabled();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || applyingRemoteSync) return;
  if (changes.cloudSyncEnabled) {
    clearTimeout(pushDebounce);
    const on = changes.cloudSyncEnabled.newValue;
    setSyncAlarm(on);
    if (on) pollPull(true);
    return;
  }
  if (SYNC_KEYS.some((k) => k in changes)) scheduleAutoPush();
});

// One-time cleanup: the CRM login used to be stored here for the old
// CRM-tab lookup. Lookups now go through the separate CRM Bridge extension
// (which holds its own login), so drop the leftover plaintext credentials.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(["crmUsername", "crmPassword"]).catch(() => {});
});
