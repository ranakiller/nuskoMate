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

  // Premium feature — requires a license that includes this tool.
  const premiumOK = () => !window.NkLicense || window.NkLicense.featureOK("overlay");

  chrome.storage.local.get(["extensionEnabled", "moduleDisableOverlay"], (res) => {
    if (res.extensionEnabled === false) return;
    isEnabled = !!res.moduleDisableOverlay && premiumOK();
    if (isEnabled) start();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.extensionEnabled) {
      if (!changes.extensionEnabled.newValue) { stop(); return; }
      else { chrome.storage.local.get(["moduleDisableOverlay"], (r) => { isEnabled = !!r.moduleDisableOverlay && premiumOK(); if (isEnabled) start(); }); return; }
    }
    if (changes.moduleDisableOverlay) {
      isEnabled = !!changes.moduleDisableOverlay.newValue && premiumOK();
      isEnabled ? start() : stop();
    }
  });

  // React to license activation/deactivation while the page is open.
  window.NkLicense && window.NkLicense.onPremiumChange(() => {
    chrome.storage.local.get(["extensionEnabled", "moduleDisableOverlay"], (r) => {
      isEnabled = r.extensionEnabled !== false && !!r.moduleDisableOverlay && premiumOK();
      isEnabled ? start() : stop();
    });
  });
})();
