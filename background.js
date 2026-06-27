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
  if (!msg || msg.type !== "nkLicense") return; // not for us
  handle(msg)
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false, error: "Cannot reach the license server" }));
  return true; // keep the channel open for the async reply
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

  return { ok: false, error: "Unknown action" };
}
