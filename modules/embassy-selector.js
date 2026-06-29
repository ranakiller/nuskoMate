(function () {
  "use strict";

  let isEnabled = false;
  let focusTimer = null;
  let pollTimer = null;
  let observer = null;

  function isTargetPage() {
    return window.location.pathname === "/umrah/mutamer-group/add-group/create-group";
  }

  function focusGroupName() {
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      const groupInput = document.querySelector('input[formcontrolname="groupName"]');
      if (!groupInput) return;
      groupInput.focus();
      groupInput.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      groupInput.click();
    }, 500);
  }

  function runEmbassySelection() {
    if (!isEnabled || !isTargetPage() || typeof window.sharedDropdownHandler !== "function") return;
    const embassySelector = 'p-dropdown[formcontrolname="consulate"]';
    const dropdown = document.querySelector(embassySelector);
    if (!dropdown) return;
    const label = dropdown.querySelector(".p-dropdown-label");
    if (label && !label.textContent.includes("Islamabad")) {
      window.sharedDropdownHandler(embassySelector, "Islamabad");
      focusGroupName();
    }
  }

  function start() {
    if (observer) return;
    observer = new MutationObserver(runEmbassySelection);
    observer.observe(document.body, { childList: true, subtree: true });
    pollTimer = setInterval(runEmbassySelection, 1000);
    window.addEventListener("nusuk-route-change", runEmbassySelection);
  }

  function stop() {
    isEnabled = false;
    clearTimeout(focusTimer);
    clearInterval(pollTimer);
    if (observer) { observer.disconnect(); observer = null; }
  }

  // Premium feature — its own per-key tool, independent of Autofill.
  const premiumOK = () => !window.NkLicense || window.NkLicense.featureOK("embassy");

  chrome.storage.local.get(["extensionEnabled", "moduleEmbassy"], (res) => {
    if (res.extensionEnabled === false) return;
    isEnabled = res.moduleEmbassy !== false && premiumOK();
    if (isEnabled) start();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.extensionEnabled) {
      if (!changes.extensionEnabled.newValue) { stop(); return; }
      chrome.storage.local.get(["moduleEmbassy"], (r) => { isEnabled = r.moduleEmbassy !== false && premiumOK(); if (isEnabled) start(); });
      return;
    }
    if (changes.moduleEmbassy !== undefined) {
      isEnabled = changes.moduleEmbassy.newValue !== false && premiumOK();
      isEnabled ? start() : stop();
    }
  });

  // React to license activation/deactivation while the page is open.
  window.NkLicense && window.NkLicense.onPremiumChange(() => {
    chrome.storage.local.get(["extensionEnabled", "moduleEmbassy"], (r) => {
      isEnabled = r.extensionEnabled !== false && r.moduleEmbassy !== false && premiumOK();
      isEnabled ? start() : stop();
    });
  });
})();
