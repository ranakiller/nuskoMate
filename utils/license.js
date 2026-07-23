/*
 * Nuskomate licensing client.
 *
 * ┌─ SET THIS ───────────────────────────────────────────────────────────────┐
 * │ Paste your deployed Cloudflare Worker URL below to TURN ON licensing.     │
 * │ Leave it empty ("") for development — the extension then works locally    │
 * │ with no activation required.                                              │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
(function () {
  "use strict";

  const LICENSE_SERVER = "https://nuskomate-license.ranakiller-59.workers.dev";

  const base = LICENSE_SERVER.replace(/\/+$/, "");
  const enforced = () => !!base;

  function store(obj) { return new Promise((r) => chrome.storage.local.set(obj, r)); }
  function read(keys)  { return new Promise((r) => chrome.storage.local.get(keys, r)); }
  // storage.sync mirrors of store/read — best-effort only (not signed into
  // Chrome sync, or sync disabled, both just no-op instead of throwing).
  function storeSync(obj) { return new Promise((r) => { try { chrome.storage.sync.set(obj, () => r()); } catch (_) { r(); } }); }
  function readSync(keys) { return new Promise((r) => { try { chrome.storage.sync.get(keys, (x) => r(chrome.runtime.lastError ? {} : (x || {}))); } catch (_) { r({}); } }); }

  // Canonical list of per-key tool ids (kept in sync with the popup + modules).
  // autoclick/fillrules/autoselect are the pre-merge ids for what's now the
  // single "autorules" tool — kept in the list (not removed) since already-
  // issued keys may still carry them; featOK("autorules") accepts all 4.
  const FEATURES = ["ocr", "father", "bulk", "batch", "translate", "vaccine", "issuedate", "reload", "overlay", "autorules", "autoclick", "autofill", "fillrules", "autoselect", "workflows", "urlshift", "groups", "brnrequest", "translaterules", "mvtotals", "talabcopy"];

  // ── Entitlement cache (for gating premium content-script modules) ─────────
  // Fail-closed: in enforced mode we assume NOT activated until storage confirms
  // a valid license, so premium modules stay off by default.
  //   _features === null  → all tools enabled (master / legacy keys)
  //   _features === [...]  → only those tools enabled
  let _activated = !enforced();
  let _features  = null;
  const _subs = [];
  function _notify() { _subs.forEach((f) => { try { f(); } catch (_) {} }); }
  async function refreshEntitlements() {
    const x = await read(["licenseValid", "licenseFeatures"]);
    const act = enforced() ? !!x.licenseValid : true;
    let feats = null;
    try { feats = x.licenseFeatures ? JSON.parse(x.licenseFeatures) : null; } catch (_) { feats = null; }
    feats = Array.isArray(feats) ? feats : null;
    const changed = act !== _activated || JSON.stringify(feats) !== JSON.stringify(_features);
    _activated = act;
    _features = feats;
    if (changed) _notify();
  }
  const isActivated = () => _activated;
  const premiumOK   = () => !enforced() || _activated;       // is the license active at all?
  function featureOK(name) {                                  // is THIS tool included?
    if (!enforced()) return true;                            // dev mode = all on
    if (!_activated) return false;
    return _features === null || _features.includes(name);   // null = all tools
  }
  const onPremiumChange = (cb) => { if (typeof cb === "function") _subs.push(cb); };
  refreshEntitlements();
  chrome.storage.onChanged.addListener((c, a) => {
    if (a === "local" && (c.licenseValid !== undefined || c.licenseFeatures !== undefined)) refreshEntitlements();
  });

  function getKey() { return read(["licenseKey"]).then((x) => x.licenseKey || ""); }

  // All network calls go through the background service worker. Its fetches are
  // governed only by host_permissions, so they are NOT blocked by the page's
  // Content-Security-Policy (which blocks fetch() from content scripts).
  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: "Cannot reach the license server" });
          } else {
            resolve(r || { ok: false, error: "No response from background" });
          }
        });
      } catch (_) {
        resolve({ ok: false, error: "Cannot reach the license server" });
      }
    });
  }

  // OCR.space (free) chokes on images that are too big in BYTES *or* too large
  // in PIXELS — a 730 KB high-res photo failed even though it's under 1 MB.
  // So decode every image and downscale when either dimension or size is too
  // big. The long side is capped (MRZ stays legible) and JPEG quality steps
  // down until it fits comfortably under the limit.
  async function shrinkImage(file, maxBytes = 700000, maxDim = 1600) {
    try {
      if (!file) return file;
      const bmp = await createImageBitmap(file);
      let w = bmp.width, h = bmp.height;
      const big = Math.max(w, h);
      // Already small in both bytes and pixels → send as-is.
      if ((file.size || 0) <= maxBytes && big <= maxDim) {
        if (bmp.close) bmp.close();
        return file;
      }
      const scale = Math.min(1, maxDim / big);
      w = Math.max(1, Math.round(w * scale));
      h = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
      if (bmp.close) bmp.close();
      let blob = null;
      for (let q = 0.82; q >= 0.4; q -= 0.12) {
        blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", q));
        if (blob && blob.size <= maxBytes) break;
      }
      return blob || file;
    } catch (_) { return file; } // any failure → send the original
  }

  // File/Blob → base64 string (messages must be JSON-serializable).
  function fileToB64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] || "");
      r.onerror = () => reject(new Error("read failed"));
      r.readAsDataURL(file);
    });
  }

  // Optional native-messaging helper (see native-host/) — a small local
  // program that reads this PC's actual Windows machine id, something no
  // browser extension can access on its own. Chrome and Edge each have
  // completely separate storage, so without this every browser mints its
  // own random device id even on the same computer; the helper is the only
  // way to give them a SHARED one. Most customers won't have it installed —
  // this must never throw or hang activation, just resolve to null so the
  // caller falls back to the per-browser id.
  const NATIVE_HOST_NAME = "com.nuskomate.devicehost";
  // Defensive — window.nkLog only exists on the Masar content-script page
  // (utils/logger.js), NOT in the popup (popup.html never loads it).
  const nlog = (...a) => (window.nkLog ? window.nkLog(...a) : console.log(...a));
  function getNativeMachineId() {
    return new Promise((resolve) => {
      if (!chrome.runtime || !chrome.runtime.sendNativeMessage) return resolve(null);
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      // A cold powershell.exe launch (first run, possibly AV-scanned) can take
      // a couple of seconds — too short a timeout here silently falls back to
      // a per-browser id even when the helper IS installed correctly, with no
      // sign anything went wrong. 4s is generous but this only ever runs once,
      // on a fresh activation.
      const timer = setTimeout(() => {
        nlog("[Nuskomate License] native device helper: timed out (not installed, or slow to respond) — using per-browser id");
        finish(null);
      }, 4000);
      try {
        chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {}, (resp) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            nlog("[Nuskomate License] native device helper: not found —", chrome.runtime.lastError.message || "unknown error");
            return finish(null);
          }
          if (!resp || !resp.ok || !resp.machineId) {
            nlog("[Nuskomate License] native device helper: responded but no machine id —", JSON.stringify(resp));
            return finish(null);
          }
          nlog("[Nuskomate License] native device helper: connected, using shared machine id");
          finish("native:" + resp.machineId);
        });
      } catch (err) {
        clearTimeout(timer);
        nlog("[Nuskomate License] native device helper: call failed —", err && err.message);
        finish(null);
      }
    });
  }

  // A stable per-install id so a key can be bound to a limited number of
  // devices. Cached in LOCAL storage (fast, always available), but the
  // canonical copy also lives in SYNC storage — which is tied to the
  // signed-in Chrome/Edge profile, not the install, and survives an
  // uninstall/reinstall. So reinstalling in the same signed-in profile
  // recovers the SAME device id instead of minting a new random one and
  // quietly burning another seat. If sync isn't available (not signed in,
  // sync disabled), this degrades to the old local-only behavior.
  // An EXISTING cached id (local or sync) always wins over the native helper
  // — installing the helper later must never silently change an already-
  // activated device's id and burn a fresh seat. The native machine id is
  // only used to MINT a brand-new id, on a fresh activation, when nothing is
  // cached yet — that's the one case where using it is strictly better than
  // a random per-browser UUID, since it's the same value in every browser.
  async function getDevice() {
    const local = await read(["licenseDevice"]);
    if (local.licenseDevice) return local.licenseDevice;
    const synced = await readSync(["licenseDevice"]);
    if (synced.licenseDevice) {
      await store({ licenseDevice: synced.licenseDevice }); // re-cache locally
      return synced.licenseDevice;
    }
    const native = await getNativeMachineId();
    const id = native || ((self.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2));
    await store({ licenseDevice: id });
    storeSync({ licenseDevice: id }); // best-effort, don't block activation on it
    return id;
  }

  // Current activation status (used to gate the popup + modules)
  async function getStatus() {
    const x = await read(["licenseKey", "licenseValid", "licenseName", "licenseFeatures", "licenseExpiry", "licenseMaster"]);
    let feats = null;
    try { feats = x.licenseFeatures ? JSON.parse(x.licenseFeatures) : null; } catch (_) { feats = null; }
    return {
      enforced: enforced(),
      activated: enforced() ? !!x.licenseValid : true, // dev mode = always "activated"
      key: x.licenseKey || "",
      name: x.licenseName || "",
      features: Array.isArray(feats) ? feats : null,   // null = all tools
      expires: x.licenseExpiry || "",
      master: !!x.licenseMaster,                       // unlocks the Keys admin tab
    };
  }

  // Validate a key with the server and remember it (incl. features + expiry).
  async function activate(key) {
    if (!enforced()) return { ok: true };
    key = (key || "").trim();
    if (!key) return { ok: false, error: "Enter a key" };
    const device = await getDevice();
    const data = await send({ type: "nkLicense", action: "activate", base, key, device });
    if (data && data.ok) {
      await store({
        licenseKey: key, licenseValid: true, licenseName: data.name || "",
        licenseFeatures: JSON.stringify(data.features ?? null), // null = all
        licenseExpiry: data.expires || "",
        licenseMaster: !!data.master,
        licenseCheckedAt: Date.now(),
      });
      await refreshEntitlements();
      return { ok: true, name: data.name, features: data.features ?? null, expires: data.expires || "", master: !!data.master };
    }
    await store({ licenseValid: false });
    return { ok: false, error: (data && data.error) || "Invalid or revoked key" };
  }

  async function deactivate() {
    await store({ licenseKey: "", licenseValid: false, licenseName: "", licenseFeatures: "", licenseExpiry: "", licenseMaster: false });
    await refreshEntitlements();
  }

  // ── Periodic re-validation ("heartbeat") ───────────────────────────────────
  // This file is loaded as a CONTENT SCRIPT on the Masar page itself, not
  // just in the popup — so this runs while the user is actively working, not
  // only when they happen to reopen the popup. Same idea as the popup's
  // GitHub-release update check, applied to license state: if you revoke a
  // key, edit its features, delete it outright, or reset its devices, this
  // catches it within a few minutes and every premium module unlocks/locks
  // immediately via the existing onPremiumChange subscribers — no action
  // needed from the user, and it works mid-session.
  async function checkStatus() {
    if (!enforced()) return;
    const x = await read(["licenseKey", "licenseValid"]);
    if (!x.licenseKey || !x.licenseValid) return; // nothing activated to re-check
    const device = await getDevice();
    const data = await send({ type: "nkLicense", action: "status", base, key: x.licenseKey, device });
    if (data && data.ok) {
      // Refresh cached features/expiry/name too — this is also how a
      // features EDIT (not just revoke) propagates: a tool an admin just
      // removed disappears from licenseFeatures, and every module re-checks
      // featureOK() the moment refreshEntitlements() notices the change.
      await store({
        licenseName: data.name || "",
        licenseFeatures: JSON.stringify(data.features ?? null),
        licenseExpiry: data.expires || "",
        licenseMaster: !!data.master,
        licenseCheckedAt: Date.now(),
      });
      await refreshEntitlements();
      return;
    }
    // Same rule as scan()/shareRules(): only lock out when the key/device is
    // genuinely dead (revoked, expired, invalid — including a device an
    // admin reset). An unreachable server falls back to a generic "cannot
    // reach"/"bad response" message, which never matches this, so a
    // connectivity blip can't lock out an otherwise-valid customer.
    const err = (data && data.error) || "";
    if (/invalid|revoked|expired/i.test(err)) await store({ licenseValid: false });
  }
  // Shortly after load (catches a stale cache fast) and then periodically for
  // as long as this page/popup stays open.
  setTimeout(checkStatus, 4000);
  setInterval(checkStatus, 5 * 60 * 1000);

  // ── Admin (master key only) — manage the whole key list ───────────────────
  // The active key (stored licenseKey) is sent as the master credential; the
  // server only allows these when that key has master:true.
  async function admin(path, body) {
    if (!enforced()) return { ok: false, error: "Licensing not configured" };
    const adminKey = await getKey();
    if (!adminKey) return { ok: false, error: "Not activated" };
    const r = await send({ type: "nkLicense", action: "admin", base, adminKey, path, body: body || {} });
    if (r && r.data) return (r.data && typeof r.data === "object") ? r.data : { ok: false, error: "Bad server response" };
    return (r && r.error) ? r : { ok: false, error: "Cannot reach the license server" };
  }
  const adminList   = ()            => admin("/admin/list", {});
  const adminPut    = (key, record) => admin("/admin/put", { key, record });
  const adminRevoke = (key)         => admin("/admin/revoke", { key });
  const adminDelete = (key)         => admin("/admin/delete", { key });

  // ── Rule sharing (short links) ─────────────────────────────────────────────
  // Upload a rule set → { ok, code, url }. Requires an active license.
  async function shareRules(rules) {
    if (!enforced()) return { ok: false, error: "Licensing not configured" };
    const key = await getKey();
    if (!key) return { ok: false, error: "Not activated" };
    const device = await getDevice();
    const r = await send({ type: "nkLicense", action: "sharePut", base, key, device, rules });
    if (r && r.data) {
      // Same rule as scan(): only clear the cached key when the KEY/DEVICE
      // itself is dead (revoked/expired/invalid — including a device an
      // admin's "Reset devices" just dropped), never for something recoverable.
      if (r.status === 403) {
        const err = (r.data && r.data.error) || "";
        if (/invalid|revoked|expired/i.test(err)) await store({ licenseValid: false });
      }
      const d = r.data;
      if (d.ok && d.code) d.url = base + "/share/" + d.code;
      return d;
    }
    return (r && r.error) ? r : { ok: false, error: "Cannot reach the license server" };
  }
  // Fetch a shared rule set by code → { ok, rules }.
  async function fetchSharedRules(code) {
    if (!enforced()) return { ok: false, error: "Licensing not configured" };
    const r = await send({ type: "nkLicense", action: "shareGet", base, code });
    if (r && r.data) return r.data;
    return (r && r.error) ? r : { ok: false, error: "Cannot reach the license server" };
  }

  // Send an image to the server, which validates the key, runs OCR + parsing,
  // and returns { ok, result, raw }. result is the full parsed passport object.
  // Requires the customer's OWN ocr.space key (Settings → OCR) — there is no
  // shared/fallback key, so every install's OCR usage counts against its own
  // free-tier quota instead of one key shared (and exhausted) by everyone.
  async function scan(file, feature) {
    if (!enforced()) return { ok: false, error: "Licensing not configured" };
    const key = await getKey();
    if (!key) return { ok: false, error: "Not activated" };
    const device = await getDevice();
    const ocrApiKey = (await read(["ocrApiKey"])).ocrApiKey || "";
    if (!ocrApiKey.trim()) return { ok: false, error: "Please add your ocr.space API key in Settings to use OCR" };

    const sized = await shrinkImage(file); // fit OCR.space's 1 MB free-tier limit
    let fileB64;
    try { fileB64 = await fileToB64(sized); }
    catch (_) { return { ok: false, error: "Could not read image" }; }

    const r = await send({
      type: "nkLicense", action: "scan", base, key, device,
      feature: feature || "ocr", ocrApiKey: ocrApiKey.trim(),
      fileB64, fileName: file.name || "scan.jpg", fileType: sized.type || file.type || "image/jpeg",
    });

    // Background returns { status, data } for an HTTP response, or
    // { ok:false, error } if it couldn't reach the server at all.
    if (r && r.data) {
      // Only deactivate when the KEY itself is dead (revoked/expired/invalid).
      // A "feature not included" or "device limit" 403 must NOT wipe a valid key.
      if (r.status === 403) {
        const err = (r.data && r.data.error) || "";
        if (/invalid|revoked|expired/i.test(err)) await store({ licenseValid: false });
      }
      return (r.data && typeof r.data === "object") ? r.data : { ok: false, error: "Bad server response" };
    }
    return (r && r.error) ? r : { ok: false, error: "Cannot reach the license server" };
  }

  window.NkLicense = {
    enforced, getStatus, getKey, activate, deactivate, scan,
    isActivated, premiumOK, featureOK, onPremiumChange, FEATURES,
    adminList, adminPut, adminRevoke, adminDelete,
    shareRules, fetchSharedRules, checkStatus,
  };
})();
