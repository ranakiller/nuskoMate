(function () {
  "use strict";

  let isEnabled = false;
  let observer = null;

  function removeSpinners() {
    document.querySelectorAll('app-spinner, .loading-overlay, [class*="ajaxloadingbar"]').forEach(el => el.remove());
  }

  function start() {
    if (observer) return;
    removeSpinners();
    observer = new MutationObserver(removeSpinners);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stop() {
    isEnabled = false;
    if (observer) { observer.disconnect(); observer = null; }
  }

  chrome.storage.local.get(["extensionEnabled", "moduleDisableOverlay"], (res) => {
    if (res.extensionEnabled === false) return;
    isEnabled = !!res.moduleDisableOverlay;
    if (isEnabled) start();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.extensionEnabled) {
      if (!changes.extensionEnabled.newValue) { stop(); return; }
      else { chrome.storage.local.get(["moduleDisableOverlay"], (r) => { isEnabled = !!r.moduleDisableOverlay; if (isEnabled) start(); }); return; }
    }
    if (changes.moduleDisableOverlay) {
      isEnabled = !!changes.moduleDisableOverlay.newValue;
      isEnabled ? start() : stop();
    }
  });
})();
