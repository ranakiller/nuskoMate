(function () {
  "use strict";

  // Logging shim — prefers the persistent extension logger, falls back to console
  const log = {
    info:  (...a) => (window.nkLog       ? window.nkLog(...a)       : console.log(...a)),
    warn:  (...a) => (window.nkLog?.warn  ? window.nkLog.warn(...a)  : console.warn(...a)),
    error: (...a) => (window.nkLog?.error ? window.nkLog.error(...a) : console.error(...a)),
  };

  let isEnabled = false;
  let uploadSuccessful = false;
  let isWaiting = false;
  let observer = null;

  function isTargetPage() {
    return window.location.pathname === "/umrah/mutamer/add-mutamer";
  }

  async function uploadLocalImage() {
    if (!isEnabled || !isTargetPage() || uploadSuccessful || isWaiting) return;
    const allFileInputs = document.querySelectorAll('input[type="file"][accept*="image"]');
    const fileInput = allFileInputs[4];
    if (!fileInput || fileInput.files.length !== 0) return;
    isWaiting = true;
    setTimeout(async () => {
      try {
        const imageUrl = chrome.runtime.getURL("images/vaccine.jpg");
        const response = await fetch(imageUrl);
        const blob = await response.blob();
        const file = new File([blob], "vaccine.jpg", { type: "image/jpeg" });
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        fileInput.files = dataTransfer.files;
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
        uploadSuccessful = true;
      } catch (err) {
        log.error("[Nuskomate Vaccine] Failed to load local asset:", err);
      } finally {
        isWaiting = false;
      }
    }, 2000);
  }

  function start() {
    if (observer) return;
    observer = new MutationObserver(() => {
      if (!isTargetPage()) { uploadSuccessful = false; isWaiting = false; return; }
      if (!document.querySelector('input[type="file"]')) { uploadSuccessful = false; isWaiting = false; }
      uploadLocalImage();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("nusuk-route-change", () => { uploadSuccessful = false; isWaiting = false; uploadLocalImage(); });
  }

  function stop() {
    isEnabled = false;
    if (observer) { observer.disconnect(); observer = null; }
  }

  chrome.storage.local.get(["extensionEnabled", "moduleVaccineUpload"], (res) => {
    if (res.extensionEnabled === false) return;
    isEnabled = !!res.moduleVaccineUpload;
    start();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.extensionEnabled) {
      if (!changes.extensionEnabled.newValue) { stop(); return; }
      else { chrome.storage.local.get(["moduleVaccineUpload"], (r) => { isEnabled = !!r.moduleVaccineUpload; start(); }); return; }
    }
    if (changes.moduleVaccineUpload) { isEnabled = !!changes.moduleVaccineUpload.newValue; if (isEnabled) uploadLocalImage(); }
  });
})();
