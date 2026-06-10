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
    try {
      const device = await getDevice();
      const res = await fetch(base + "/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, device }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        await store({ licenseKey: key, licenseValid: true, licenseName: data.name || "", licenseCheckedAt: Date.now() });
        return { ok: true, name: data.name };
      }
      await store({ licenseValid: false });
      return { ok: false, error: data.error || "Invalid or revoked key" };
    } catch (_) {
      return { ok: false, error: "Cannot reach the license server" };
    }
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
    try {
      const device = await getDevice();
      const fd = new FormData();
      fd.append("file", file, file.name || "scan.jpg");
      const res = await fetch(base + "/scan", { method: "POST", headers: { "X-License": key, "X-Device": device }, body: fd });
      const data = await res.json().catch(() => ({}));
      if (res.status === 403) { await store({ licenseValid: false }); } // key pulled
      return data && typeof data === "object" ? data : { ok: false, error: "Bad server response" };
    } catch (_) {
      return { ok: false, error: "Cannot reach the license server" };
    }
  }

  window.NkLicense = { enforced, getStatus, getKey, activate, deactivate, scan };
})();
