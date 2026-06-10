(function () {
  "use strict";

  // Logging shim — prefers the persistent extension logger, falls back to console
  const log = {
    info:  (...a) => (window.nkLog       ? window.nkLog(...a)       : console.log(...a)),
    warn:  (...a) => (window.nkLog?.warn  ? window.nkLog.warn(...a)  : console.warn(...a)),
    error: (...a) => (window.nkLog?.error ? window.nkLog.error(...a) : console.error(...a)),
  };

  let isEnabled   = false;
  let observer    = null;
  let pollTimer   = null;
  let lastAttempt = 0;
  let busy        = false;
  const RETRY_MS  = 2000; // min gap between upload attempts (covers Angular's processing window)

  function isTargetPage() {
    return window.location.pathname === "/umrah/mutamer/add-mutamer";
  }

  // ── Locate the vaccine slot robustly ────────────────────────
  // Prefer the slot owning the "Vaccination Certificate" label
  // (for="vaccinationPicture"); fall back to the legacy 5th image input so we
  // never lose the original behaviour if the markup changes.
  function vaccineSlot() {
    const label = document.querySelector('label[for="vaccinationPicture"]');
    return label ? (label.closest(".my-3") || label.parentElement) : null;
  }

  function vaccineInput() {
    const slot = vaccineSlot();
    if (slot) return slot.querySelector('input[type="file"]'); // null when already uploaded
    const inputs = document.querySelectorAll('input[type="file"][accept*="image"]');
    return inputs[4] || null;
  }

  // Our vaccine is considered present when the slot shows an attachment-handler.
  function vaccineAttached() {
    const slot = vaccineSlot();
    if (slot) return !!slot.querySelector("app-attachment-handler");
    return [...document.querySelectorAll("app-attachment-handler")]
      .some((h) => /vaccine/i.test(h.textContent || ""));
  }

  // (Re)upload needed when the slot's input exists, is empty, and nothing is attached.
  function needsUpload() {
    if (vaccineAttached()) return false;
    const inp = vaccineInput();
    return !!(inp && inp.files.length === 0);
  }

  async function uploadVaccine() {
    if (!isEnabled || !isTargetPage() || busy) return;
    if (!needsUpload()) return;
    if (Date.now() - lastAttempt < RETRY_MS) return; // throttle rapid retries
    lastAttempt = Date.now();
    busy = true;
    try {
      const url  = chrome.runtime.getURL("images/vaccine.jpg");
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], "vaccine.jpg", { type: "image/jpeg" });
      const dt   = new DataTransfer();
      dt.items.add(file);

      const inp = vaccineInput();
      if (inp && inp.files.length === 0) {
        inp.files = dt.files;
        inp.dispatchEvent(new Event("change", { bubbles: true }));
        log.info("[Nuskomate Vaccine] uploaded vaccine.jpg");
      }
    } catch (err) {
      log.error("[Nuskomate Vaccine] upload failed:", err);
    } finally {
      busy = false;
    }
  }

  function start() {
    if (observer || pollTimer) return;
    // React instantly to DOM changes (e.g. a deletion re-rendering the slot)…
    observer = new MutationObserver(() => uploadVaccine());
    observer.observe(document.body, { childList: true, subtree: true });
    // …and poll as a safety net so deletions/failed uploads are caught fast.
    pollTimer = setInterval(uploadVaccine, 1000);
    window.addEventListener("nusuk-route-change", onRoute);
    uploadVaccine();
  }

  function stop() {
    if (observer) { observer.disconnect(); observer = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    window.removeEventListener("nusuk-route-change", onRoute);
  }

  function onRoute() {
    lastAttempt = 0; // allow an immediate attempt on the new page
    uploadVaccine();
  }

  chrome.storage.local.get(["extensionEnabled", "moduleVaccineUpload"], (res) => {
    if (res.extensionEnabled === false) return;
    isEnabled = !!res.moduleVaccineUpload;
    if (isEnabled) start();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.extensionEnabled) {
      if (!changes.extensionEnabled.newValue) { isEnabled = false; stop(); return; }
      chrome.storage.local.get(["moduleVaccineUpload"], (r) => {
        isEnabled = !!r.moduleVaccineUpload;
        isEnabled ? start() : stop();
      });
      return;
    }
    if (changes.moduleVaccineUpload) {
      isEnabled = !!changes.moduleVaccineUpload.newValue;
      isEnabled ? start() : stop();
    }
  });
})();
