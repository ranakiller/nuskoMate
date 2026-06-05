(function () {
  "use strict";

  let isEnabled = false;
  let settingsCache = {};
  let syncTimer = null;
  let pollTimer = null;
  let observer = null;

  function isTargetPage() {
    return window.location.pathname === "/umrah/mutamer/add-mutamer";
  }

  function syncField(selector, value, force = false) {
    if (value === undefined || value === null || value === "") return;
    const input = document.querySelector(selector);
    if (input && (force || input.value.trim() === "")) {
      window.simulateAngularInput(input, value);
    }
  }

  function syncDropdown(selector, value) {
    if (typeof window.sharedDropdownHandler !== "function") return;
    window.sharedDropdownHandler(selector, value);
  }

  function syncAllData(force = false) {
    if (!isEnabled || !isTargetPage()) return;
    syncField('input[formcontrolname="email"]', settingsCache.email, force);
    syncField('input[formcontrolname="profession"]', "Nil", force);
    syncField('input[formcontrolname="issueCityName"]', settingsCache.issueCityName, force);
    syncField('input[formcontrolname="birthCityName"]', settingsCache.issueCityName, force);
    syncField('input[numbersonly][maxlength="12"]', settingsCache.mobile, force);
    const firstInput = document.querySelector('div[formgroupname="firstName"] input[formcontrolname="en"]');
    const famInput = document.querySelector('div[formgroupname="familyName"] input[formcontrolname="en"]');
    if (firstInput && famInput && firstInput.value.trim() && !famInput.value.trim()) {
      window.simulateAngularInput(famInput, firstInput.value.trim());
    }
    syncDropdown('p-dropdown[formcontrolname="passportTypeId"]', "Normal");
    syncDropdown('p-dropdown[formcontrolname="birthCountryId"]', "Pakistan");
    const dobInput = document.querySelector('p-calendar[formcontrolname="birthDate"] input[type="text"]');
    if (dobInput && dobInput.value) {
      const dob = new Date(dobInput.value);
      const age = new Date().getFullYear() - dob.getFullYear();
      syncDropdown('p-dropdown[formcontrolname="martialStatusId"]', age >= 18 ? "Married" : "Single");
    }
    const mobCodeDropdown = [...document.querySelectorAll("p-dropdown")].find(
      (d) => d.textContent.includes("Country code") || d.innerText.includes("92")
    );
    if (mobCodeDropdown) {
      const label = mobCodeDropdown.querySelector(".p-dropdown-label");
      if (label && !label.textContent.includes("+92")) {
        syncDropdown("p-dropdown:not([formcontrolname])", "+92");
      }
    }
  }

  function scheduleSync(force = false) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncAllData(force), 250);
  }

  function start() {
    if (observer) return;
    observer = new MutationObserver(() => scheduleSync(false));
    observer.observe(document.body, { childList: true, subtree: true });
    pollTimer = setInterval(() => syncAllData(false), 1000);
    window.addEventListener("nusuk-route-change", () => scheduleSync(true));
    scheduleSync(true);
  }

  function stop() {
    isEnabled = false;
    clearTimeout(syncTimer);
    clearInterval(pollTimer);
    if (observer) { observer.disconnect(); observer = null; }
  }

  chrome.storage.local.get(null, (settings) => {
    if (settings.extensionEnabled === false) return;
    settingsCache = settings || {};
    isEnabled = !!settingsCache.moduleAutofill;
    start();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.extensionEnabled) {
      if (!changes.extensionEnabled.newValue) { stop(); return; }
      else { chrome.storage.local.get(null, (s) => { settingsCache = s; isEnabled = !!s.moduleAutofill; start(); }); return; }
    }
    Object.entries(changes).forEach(([key, change]) => { settingsCache[key] = change.newValue; });
    if (changes.moduleAutofill) isEnabled = !!changes.moduleAutofill.newValue;
    scheduleSync(true);
  });
})();
