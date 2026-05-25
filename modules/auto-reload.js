(function () {
  "use strict";

  let reloadTimer = null;
  let isEnabled = false;
  let reloadIntervalMinutes = 1.5;

  function reloadIfInactive() {
    if (!isEnabled) return;
    if (document.hidden) {
      window.location.reload();
    } else {
      scheduleReload();
    }
  }

  function scheduleReload() {
    clearTimeout(reloadTimer);
    if (isEnabled) {
      const safeMinutes = Math.max(Number(reloadIntervalMinutes) || 1.5, 0.5);
      reloadTimer = setTimeout(reloadIfInactive, safeMinutes * 60 * 1000);
    }
  }

  function stop() {
    isEnabled = false;
    clearTimeout(reloadTimer);
  }

  chrome.storage.local.get(["extensionEnabled", "moduleReload", "reloadInterval"], (result) => {
    if (result.extensionEnabled === false) return;
    isEnabled = !!result.moduleReload;
    reloadIntervalMinutes = result.reloadInterval || 1.5;
    if (isEnabled) scheduleReload();
  });

  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== "local") return;
    if (changes.extensionEnabled) {
      if (!changes.extensionEnabled.newValue) { stop(); return; }
      else { chrome.storage.local.get(["moduleReload","reloadInterval"], (r) => { isEnabled = !!r.moduleReload; reloadIntervalMinutes = r.reloadInterval || 1.5; if (isEnabled) scheduleReload(); }); return; }
    }
    if (changes.moduleReload) isEnabled = !!changes.moduleReload.newValue;
    if (changes.reloadInterval) reloadIntervalMinutes = changes.reloadInterval.newValue;
    isEnabled ? scheduleReload() : stop();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && isEnabled) scheduleReload();
  });
})();
