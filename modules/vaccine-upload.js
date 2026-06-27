(function () {
  "use strict";

  // Logging shim — prefers the persistent extension logger, falls back to console
  const log = {
    info:  (...a) => (window.nkLog       ? window.nkLog(...a)       : console.log(...a)),
    warn:  (...a) => (window.nkLog?.warn  ? window.nkLog.warn(...a)  : console.warn(...a)),
    error: (...a) => (window.nkLog?.error ? window.nkLog.error(...a) : console.error(...a)),
  };

  let isEnabled       = false;
  let observer        = null;
  let pollTimer       = null;
  let debounceTimer   = null;
  let lastAttempt     = 0;
  let postUploadUntil = 0;     // back off until this time after a dispatch
  let busy            = false;
  const RETRY_MS              = 4000;  // min gap between upload attempts
  const POST_UPLOAD_GRACE_MS = 12000; // let nusuk finish uploading + render the attachment

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
    // After a dispatch, leave nusuk alone while it uploads the file to its
    // server and renders the attachment — firing again during this window is
    // what caused the constant errors.
    if (Date.now() < postUploadUntil) return;
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
        postUploadUntil = Date.now() + POST_UPLOAD_GRACE_MS; // stand down while it processes
        log.info("[Nuskomate Vaccine] uploaded vaccine.jpg");
      }
    } catch (err) {
      log.error("[Nuskomate Vaccine] upload failed:", err);
    } finally {
      busy = false;
    }
  }

  // Coalesce bursts of DOM mutations into a single delayed attempt.
  function scheduleUpload() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(uploadVaccine, 400);
  }

  function start() {
    if (observer || pollTimer) return;
    // React to DOM changes (e.g. a deletion re-rendering the slot), but debounced
    // so a burst of Angular re-renders triggers only one attempt.
    observer = new MutationObserver(scheduleUpload);
    observer.observe(document.body, { childList: true, subtree: true });
    // …and a slow poll as a safety net for deletions/failed uploads.
    pollTimer = setInterval(uploadVaccine, 2000);
    window.addEventListener("nusuk-route-change", onRoute);
    uploadVaccine();
  }

  function stop() {
    if (observer) { observer.disconnect(); observer = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    clearTimeout(debounceTimer);
    window.removeEventListener("nusuk-route-change", onRoute);
  }

  function onRoute() {
    lastAttempt = 0;       // allow an immediate attempt on the new page
    postUploadUntil = 0;   // clear any leftover back-off from the previous page
    uploadVaccine();
  }

  // Premium feature — requires a license that includes this tool.
  const premiumOK = () => !window.NkLicense || window.NkLicense.featureOK("vaccine");

  chrome.storage.local.get(["extensionEnabled", "moduleVaccineUpload"], (res) => {
    if (res.extensionEnabled === false) return;
    isEnabled = !!res.moduleVaccineUpload && premiumOK();
    if (isEnabled) start();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.extensionEnabled) {
      if (!changes.extensionEnabled.newValue) { isEnabled = false; stop(); return; }
      chrome.storage.local.get(["moduleVaccineUpload"], (r) => {
        isEnabled = !!r.moduleVaccineUpload && premiumOK();
        isEnabled ? start() : stop();
      });
      return;
    }
    if (changes.moduleVaccineUpload) {
      isEnabled = !!changes.moduleVaccineUpload.newValue && premiumOK();
      isEnabled ? start() : stop();
    }
  });

  // React to license activation/deactivation while the page is open.
  window.NkLicense && window.NkLicense.onPremiumChange(() => {
    chrome.storage.local.get(["extensionEnabled", "moduleVaccineUpload"], (r) => {
      isEnabled = r.extensionEnabled !== false && !!r.moduleVaccineUpload && premiumOK();
      isEnabled ? start() : stop();
    });
  });
})();
