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
  if (msg.type !== "nkLicense") return;            // not for us
  handle(msg)
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false, error: "Cannot reach the license server" }));
  return true; // keep the channel open for the async reply
});

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
      headers: { "X-License": msg.key || "", "X-Device": msg.device || "", "X-Feature": msg.feature || "ocr" },
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
// never touch THIS device's own activation), ephemeral run/log state
// (acRunStatus, nkLogs, bulkResults, ocrScanned), per-device UI cosmetics
// (uiTab, uiSidebarCollapsed, uiTheme, the popup's own ac*Collapsed*/
// acSearch_* view-state keys, and cloudSyncEnabled itself), and ocrApiKey —
// a credential that one device silently overwriting another's was surprising
// in practice, so it stays local-only like the license key does.
const SYNC_KEYS = [
  "autoClickRules", "autoWorkflows", "autoUrlShiftRules",
  "moduleReload", "moduleDisableOverlay", "moduleAutofill", "moduleTranslate",
  "moduleIssueDateCalc", "moduleVaccineUpload", "moduleOcr", "moduleFatherName",
  "moduleBatchUpload", "moduleAutoClicker", "moduleAutoFillRules", "moduleAutoSelect",
  "moduleWorkflows", "moduleUrlShift", "extensionEnabled",
  "reloadInterval", "batchDelay", "batchFieldSelector", "ocrDisplay",
  "emailList", "activeEmailId", "email", "mobile",
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
