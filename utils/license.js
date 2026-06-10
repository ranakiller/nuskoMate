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

  // File/Blob → base64 string (messages must be JSON-serializable).
  function fileToB64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] || "");
      r.onerror = () => reject(new Error("read failed"));
      r.readAsDataURL(file);
    });
  }

  // A stable per-install id so a key can be bound to a limited number of
  // devices. Generated once and kept in local storage.
  async function getDevice() {
    const x = await read(["licenseDevice"]);
    if (x.licenseDevice) return x.licenseDevice;
    const id = (self.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
    await store({ licenseDevice: id });
    return id;
  }

  // Current activation status (used to gate the popup + modules)
  async function getStatus() {
    const x = await read(["licenseKey", "licenseValid", "licenseName"]);
    return {
      enforced: enforced(),
      activated: enforced() ? !!x.licenseValid : true, // dev mode = always "activated"
      key: x.licenseKey || "",
      name: x.licenseName || "",
    };
  }

  // Validate a key with the server and remember it on success.
  async function activate(key) {
    if (!enforced()) return { ok: true };
    key = (key || "").trim();
    if (!key) return { ok: false, error: "Enter a key" };
    const device = await getDevice();
    const data = await send({ type: "nkLicense", action: "activate", base, key, device });
    if (data && data.ok) {
      await store({ licenseKey: key, licenseValid: true, licenseName: data.name || "", licenseCheckedAt: Date.now() });
      return { ok: true, name: data.name };
    }
    await store({ licenseValid: false });
    return { ok: false, error: (data && data.error) || "Invalid or revoked key" };
  }

  async function deactivate() {
    await store({ licenseKey: "", licenseValid: false, licenseName: "" });
  }

  // Send an image to the server, which validates the key, runs OCR + parsing,
  // and returns { ok, result, raw }. result is the full parsed passport object.
  async function scan(file) {
    if (!enforced()) return { ok: false, error: "Licensing not configured" };
    const key = await getKey();
    if (!key) return { ok: false, error: "Not activated" };
    const device = await getDevice();

    let fileB64;
    try { fileB64 = await fileToB64(file); }
    catch (_) { return { ok: false, error: "Could not read image" }; }

    const r = await send({
      type: "nkLicense", action: "scan", base, key, device,
      fileB64, fileName: file.name || "scan.jpg", fileType: file.type || "image/jpeg",
    });

    // Background returns { status, data } for an HTTP response, or
    // { ok:false, error } if it couldn't reach the server at all.
    if (r && r.data) {
      if (r.status === 403) await store({ licenseValid: false }); // key revoked / device limit
      return (r.data && typeof r.data === "object") ? r.data : { ok: false, error: "Bad server response" };
    }
    return (r && r.error) ? r : { ok: false, error: "Cannot reach the license server" };
  }

  window.NkLicense = { enforced, getStatus, getKey, activate, deactivate, scan };
})();
