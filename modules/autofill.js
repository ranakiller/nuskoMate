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

  // What WE last wrote to each field — lets us tell our own auto-fill from a
  // value the USER typed/changed. We only (re)write a field when it is blank or
  // still holds our previous value; once the user edits it, we leave it alone.
  // (Reset on route change — a new form starts fresh.) This keeps the form
  // editable while still filling on first render / after a page reload.
  let ours = {};

  function syncField(selector, value, key) {
    if (value === undefined || value === null || value === "") return;
    const input = document.querySelector(selector);
    if (!input) return;
    const cur = input.value.trim();
    if (cur !== "" && cur !== ours[key]) return;        // user owns it → leave
    if (cur !== value) window.simulateAngularInput(input, value);
    ours[key] = value;
  }

  function syncDropdown(selector, value, key) {
    if (!value || typeof window.sharedDropdownHandler !== "function") return;
    const el = document.querySelector(selector);
    if (!el) return;
    const label = el.querySelector(".p-dropdown-label");
    const cur = label ? label.textContent.trim() : "";
    const lc = cur.toLowerCase();
    const placeholder = !label || label.classList.contains("p-placeholder");
    const mine = key && ours[key] && lc.includes(ours[key].toLowerCase());
    if (!placeholder && !mine) return;                  // user picked something → leave
    if (!lc.includes(value.toLowerCase())) window.sharedDropdownHandler(selector, value);
    ours[key] = value;
  }

  // ICAO code from the last scanned passport (or "" if none). Country name and
  // dial code come from the shared, full ISO-3166 table (utils/countries.js).
  function scannedCode() {
    try {
      const d = settingsCache.ocrDisplay ? JSON.parse(settingsCache.ocrDisplay) : null;
      return (d && d.details && (d.details.issuingCountry || d.details.nationality)) || "";
    } catch (_) { return ""; }
  }
  // Birth-country name from the last scanned passport (or "" if none/unknown).
  function scannedBirthCountry() { return window.NkCountries ? window.NkCountries.name(scannedCode()) : ""; }
  // Phone dialling code from the last scanned passport (default +92).
  function scannedDialCode() { return (window.NkCountries && window.NkCountries.dial(scannedCode())) || "+92"; }

  // Mobile number — the input sits next to the country-code dropdown and its
  // maxlength CHANGES with the selected code (e.g. +44 → 13). Fill from settings,
  // truncating from the end if the configured number is longer than maxlength.
  function syncMobileNumber() {
    const digits = String(settingsCache.mobile || "").replace(/\D/g, "");
    if (!digits) return;
    const input = document.querySelector('input[numbersonly].flex-grow')
               || document.querySelector('input[numbersonly][maxlength]');
    if (!input) return;
    const max = parseInt(input.getAttribute("maxlength") || "0", 10);
    const val = (max > 0 && digits.length > max) ? digits.slice(0, max) : digits;
    const cur = input.value.trim();
    if (cur !== "" && cur !== ours.mobile) return;      // user owns it → leave
    if (cur !== val) window.simulateAngularInput(input, val);
    ours.mobile = val;
  }

  function syncAllData() {
    if (!isEnabled || !isTargetPage()) return;
    syncField('input[formcontrolname="email"]', settingsCache.email, "email");
    syncField('input[formcontrolname="profession"]', "Nil", "profession");
    syncMobileNumber();
    syncDropdown('p-dropdown[formcontrolname="passportTypeId"]', "Normal", "passportType");
    // Birth country follows the scanned passport's nationality (not hardcoded).
    const birthCountry = scannedBirthCountry();
    if (birthCountry) syncDropdown('p-dropdown[formcontrolname="birthCountryId"]', birthCountry, "birthCountry");
    const dobInput = document.querySelector('p-calendar[formcontrolname="birthDate"] input[type="text"]');
    if (dobInput && dobInput.value) {
      const dob = new Date(dobInput.value);
      const age = new Date().getFullYear() - dob.getFullYear();
      syncDropdown('p-dropdown[formcontrolname="martialStatusId"]', age >= 18 ? "Married" : "Single", "marital");
    }
    // Mobile country code follows the scanned passport (e.g. GBR → +44).
    const mobCodeDropdown = [...document.querySelectorAll("p-dropdown")].find(
      (d) => d.textContent.includes("Country code") || /\+\d/.test(d.textContent)
    );
    if (mobCodeDropdown) {
      const sel = "p-dropdown:not([formcontrolname])";
      // Reuse the tracked dropdown setter (keyed) so it won't fight a user change.
      const label = mobCodeDropdown.querySelector(".p-dropdown-label");
      const lc = (label ? label.textContent.trim() : "").toLowerCase();
      const placeholder = !label || label.classList.contains("p-placeholder") || lc.includes("country code");
      const dialCode = scannedDialCode();
      const mine = ours.mobileCode && lc.includes(ours.mobileCode.toLowerCase());
      if (placeholder || mine) {
        if (!lc.includes(dialCode)) window.sharedDropdownHandler(sel, dialCode);
        ours.mobileCode = dialCode;
      }
    }
  }

  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncAllData(), 250);
  }

  function start() {
    if (observer) return;
    observer = new MutationObserver(() => scheduleSync());
    observer.observe(document.body, { childList: true, subtree: true });
    pollTimer = setInterval(() => syncAllData(), 1000);
    // New form (route change) → forget what we filled so the fresh form fills.
    window.addEventListener("nusuk-route-change", () => { ours = {}; scheduleSync(); });
    scheduleSync();
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
    scheduleSync();
  });
})();
