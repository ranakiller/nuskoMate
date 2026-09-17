(function () {
  "use strict";

  // BRN Request — quick hotel search + date/Full-Talab navigator, ported from
  // the user's Tampermonkey "Quickly Send BRN Requests" script plus its
  // "AUTO HOTEL CAPTURE" companion block. GM_getValue/setValue and page
  // localStorage both become chrome.storage.local (synced across devices via
  // Cloud Sync, same as rules/workflows). Two things from the original were
  // deliberately dropped, not ported: the "show list" hotkey and the on-page
  // JSON editor modal — both are now just the extension's own BRN Request
  // popup tab, which already has the full list on screen, so a second on-page
  // UI for the same data would be redundant. Date math, the create-agreement
  // autofill, and the auto-capture mechanism are otherwise unchanged.

  const LIST_KEY = "brnHotelList";   // { hotelName: hotelId }
  const LAST_KEY = "brnLastUsed";    // { hotel, date, fullTalab }
  const HOTKEY_KEY = "brnHotkey";    // e.g. "Alt+H" — toggles the search bar
  const PRICE_KEY = "brnDefaultPrice";     // auto-filled into the create-agreement price field
  const NIGHTS_KEY = "brnDefaultNights";   // nights added when only a single date is entered
  const DEFAULT_HOTKEY = "Alt+H";
  const DEFAULT_PRICE = "1";
  const DEFAULT_NIGHTS = 3;

  const wlog = (m) => { try { (window.nkLog || console.log)("[Nuskomate BRN] " + m); } catch (_) { console.log(m); } };

  let moduleEnabled = false;
  let hotels = {};
  let lastUsed = { hotel: "", date: "", fullTalab: false };
  let hotkeyCombo = DEFAULT_HOTKEY;
  let defaultPrice = DEFAULT_PRICE;
  let defaultNights = DEFAULT_NIGHTS;

  // ── Hotkey combo matching — self-contained (same reasoning as
  // modules/url-shifter.js: no load-order dependency on auto-clicker.js) ──
  function comboFromEvent(e) {
    if (["Alt", "Control", "Shift", "Meta"].includes(e.key)) return "";
    if (!e.ctrlKey && !e.altKey && !e.metaKey) return "";
    const parts = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (e.metaKey) parts.push("Meta");
    parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
    return parts.join("+");
  }
  function normHotkey(s) {
    const parts = String(s || "").split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
    const mods = [];
    if (parts.includes("ctrl") || parts.includes("control")) mods.push("Ctrl");
    if (parts.includes("alt") || parts.includes("option")) mods.push("Alt");
    if (parts.includes("shift")) mods.push("Shift");
    if (parts.includes("meta") || parts.includes("cmd")) mods.push("Meta");
    const key = parts.filter((p) => !["ctrl", "control", "alt", "option", "shift", "meta", "cmd"].includes(p)).pop() || "";
    if (!key || !mods.length) return "";
    return [...mods, key.length === 1 ? key.toUpperCase() : key].join("+");
  }

  // ── Floating search bar ────────────────────────────────────────────────
  const bar = document.createElement("div");
  bar.id = "nkBrnBar";
  bar.innerHTML = `
    <input id="nkBrnHotel" list="nkBrnHotelList" placeholder="Hotel name…" autocomplete="off" />
    <datalist id="nkBrnHotelList"></datalist>
    <input id="nkBrnDate" placeholder="e.g. 28 05" autocomplete="off" />
    <label style="font-size:13px;margin-left:8px;display:inline-flex;align-items:center;gap:5px;">
      <input type="checkbox" id="nkBrnFullTalab" /> Full Talab
    </label>
  `;

  const style = document.createElement("style");
  style.textContent = `
    #nkBrnBar {
      position: fixed; top: 40%; left: 50%; transform: translate(-50%, -50%);
      background: #fff; padding: 12px 15px; border-radius: 12px;
      box-shadow: 0 0 25px rgba(0,0,0,0.3); display: none; z-index: 999999;
      font-family: 'Segoe UI', sans-serif; transition: all 0.25s ease-in-out;
    }
    #nkBrnBar.active { box-shadow: 0 0 25px rgba(0,200,100,0.6); }
    #nkBrnBar input[type="text"], #nkBrnBar input:not([type]) {
      margin: 5px; padding: 8px 10px; font-size: 14px;
      border: 1px solid #ccc; border-radius: 6px; outline: none; width: 200px;
    }
    #nkBrnBar input:focus { border-color: #00aa66; box-shadow: 0 0 5px #00aa66; }
    #tm-hotel-auto-toast {
      position: fixed; bottom: 24px; right: 24px; padding: 10px 18px; border-radius: 8px;
      color: #fff; font-family: 'Segoe UI', sans-serif; font-size: 14px; font-weight: 600;
      z-index: 9999999; box-shadow: 0 4px 14px rgba(0,0,0,0.25); background: #00aa66;
      opacity: 0; transition: opacity 0.35s ease; pointer-events: none;
    }
  `;

  let injected = false;
  function inject() {
    if (injected) return;
    document.head.appendChild(style);
    document.body.appendChild(bar);
    injected = true;
    wireBar();
  }

  const datalistEl = () => document.getElementById("nkBrnHotelList");
  function refreshDatalist() {
    const list = datalistEl();
    if (!list) return;
    list.innerHTML = "";
    Object.keys(hotels).sort((a, b) => a.localeCompare(b)).forEach((h) => {
      const opt = document.createElement("option");
      opt.value = h;
      list.appendChild(opt);
    });
  }

  function showBar() {
    // Always re-read so hotels captured elsewhere (or edited in the popup
    // tab) show up immediately, and the last-used values stay current.
    chrome.storage.local.get([LIST_KEY, LAST_KEY], (res) => {
      hotels = res[LIST_KEY] || {};
      lastUsed = res[LAST_KEY] || { hotel: "", date: "", fullTalab: false };
      refreshDatalist();
      const hotelBox = document.getElementById("nkBrnHotel");
      const dateBox = document.getElementById("nkBrnDate");
      const fullChk = document.getElementById("nkBrnFullTalab");
      if (hotelBox) hotelBox.value = lastUsed.hotel || "";
      if (dateBox) dateBox.value = lastUsed.date || "";
      if (fullChk) fullChk.checked = !!lastUsed.fullTalab;
      bar.style.display = "block";
      bar.classList.add("active");
      if (hotelBox) hotelBox.focus();
    });
  }
  function hideBar() {
    bar.style.display = "none";
    bar.classList.remove("active");
  }
  function toggleBar() {
    if (!moduleEnabled) return;
    if (bar.style.display === "none" || !bar.style.display) showBar();
    else hideBar();
  }

  // ── Date helpers (unchanged from the original script) ──────────────────
  function makeDates(startStr, endStr) {
    const today = new Date();
    let year = today.getFullYear();

    startStr = startStr.replace(/\s*\+\s*/g, "+");

    if (startStr.includes("+")) {
      const [left, daysToAddStr] = startStr.split("+");
      const addDays = parseInt(daysToAddStr, 10);
      if (isNaN(addDays)) { window.nkToast("Invalid +days format", "error"); return null; }

      // Bug fix: only length===2 was treated as "day-only" here — a single
      // digit (e.g. "5+3") fell through both branches, leaving day/month
      // undefined and producing an Invalid Date. Day-only now covers any
      // non-4-length input (1 or 2 digits), same convention the plain
      // (non-"+") parse() below already uses.
      let day, month;
      if (left.length === 4) {
        day = parseInt(left.slice(0, 2), 10);
        month = parseInt(left.slice(2, 4), 10) - 1;
      } else {
        day = parseInt(left, 10);
        month = today.getMonth();
        if (day < today.getDate()) { month++; if (month > 11) { month = 0; year++; } }
      }

      let start = new Date(year, month, day);
      const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      if (start < todayMid) { year++; start = new Date(year, month, day); }

      const end = new Date(start);
      end.setDate(end.getDate() + addDays);
      return { start: formatDate(start), end: formatDate(end) };
    }

    const parse = (str) => {
      if (str.length === 4) {
        const d = parseInt(str.slice(0, 2), 10);
        const m = parseInt(str.slice(2), 10) - 1;
        return { d, m, explicitMonth: true };
      }
      return { d: parseInt(str, 10), m: today.getMonth(), explicitMonth: false };
    };

    const s = parse(startStr);
    const e = parse(endStr);

    let startYear = year;
    if (s.explicitMonth) {
      const candidateStart = new Date(year, s.m, s.d);
      if (candidateStart < today) startYear++;
    } else {
      if (s.d < today.getDate()) { s.m++; if (s.m > 11) { s.m = 0; startYear++; } }
    }

    let endMonth, endYear;
    if (!e.explicitMonth) {
      endMonth = s.m; endYear = startYear;
      if (e.d < s.d) { endMonth++; if (endMonth > 11) { endMonth = 0; endYear++; } }
      const endTest = new Date(endYear, endMonth, e.d);
      const startTest = new Date(startYear, s.m, s.d);
      if (endTest < startTest) endYear++;
    } else {
      endMonth = e.m; endYear = startYear;
      if (endMonth < s.m) endYear++;
    }

    return {
      start: formatDate(new Date(startYear, s.m, s.d)),
      end: formatDate(new Date(endYear, endMonth, e.d)),
    };
  }

  function formatDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  // Shared by the on-page bar's Enter key AND the popup's own BRN tab
  // ("Quick Send", via the BRN_QUICK_SEARCH message below) — same hotel
  // lookup, date math, and URL-building either way, so the two can never
  // drift out of sync. Returns { ok, error } instead of toasting directly
  // (unlike makeDates' own internal +days-format toast, which still fires
  // on-page — harmless either way, just redundant with the popup's own
  // toast when this is reached via a message) so each caller can show the
  // failure wherever the user is actually looking.
  function performSearch(hotelName, dates, fullTalab) {
    const hotelId = hotels[hotelName];
    if (!hotelId) return { ok: false, error: "Hotel not found in list." };

    let d1, d2;
    if (/^\d{1,4}$/.test(dates)) { d1 = `${dates}+${defaultNights}`; d2 = null; }
    else if (dates.includes("+")) { d1 = dates; d2 = null; }
    else {
      [d1, d2] = dates.split(" ");
      if (!d1 || !d2) return { ok: false, error: "Enter dates as: 28 05 or 22+18 (to add days in 1st date)" };
    }

    const parsed = makeDates(d1, d2);
    if (!parsed) return { ok: false, error: "Invalid date." };
    const { start, end } = parsed;

    const url = fullTalab
      ? `https://masar.nusuk.sa/umrah/housing-agreement/create-agreement?hotelId=${hotelId}&start=${start}&end=${end}&startTime=12:00:00&endTime=10:00:00&hotelName=${encodeURIComponent(hotelName)}`
      : `https://masar.nusuk.sa/umrah/service-providers/housing/hotel/${hotelId}?from=${start}&to=${end}`;

    chrome.storage.local.set({ [LAST_KEY]: { hotel: hotelName, date: dates, fullTalab } });
    window.location.href = url;
    return { ok: true };
  }

  // ── Wire the bar's Enter-to-navigate behavior (once, at inject time) ───
  function wireBar() {
    const hotelBox = document.getElementById("nkBrnHotel");
    const dateBox = document.getElementById("nkBrnDate");
    const fullChk = document.getElementById("nkBrnFullTalab");
    if (!dateBox) return;

    dateBox.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const result = performSearch(hotelBox.value.trim(), dateBox.value.trim(), fullChk.checked);
      if (!result.ok) { window.nkToast(result.error, "error"); return; }
      hideBar();
      hotelBox.value = "";
      dateBox.value = "";
    });
  }

  // Lets the popup's BRN tab trigger the exact same search/navigate from its
  // own "Quick Send" box — the popup has no page of its own to navigate, so
  // it messages whichever Masar tab is active instead. Synchronous (no
  // `return true`): performSearch resolves immediately, no async work inside.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.action !== "BRN_QUICK_SEARCH") return;
    if (!moduleEnabled) { sendResponse({ ok: false, error: "BRN Request is off, or not included in your license." }); return; }
    sendResponse(performSearch(String(msg.hotelName || "").trim(), String(msg.dates || "").trim(), !!msg.fullTalab));
  });

  document.addEventListener("keydown", (e) => {
    if (!moduleEnabled) return;
    if (e.key === "Escape") { hideBar(); return; }
    if (comboFromEvent(e) === hotkeyCombo) { e.preventDefault(); toggleBar(); }
  });

  // ── Autofill agreement details (create-agreement page) — unchanged ─────
  let agreementObserver = null;
  function startAutoFillAgreementDetails() {
    if (agreementObserver) return;
    let priceFilled = false;
    let checkboxChecked = false;

    function tryFill() {
      if (!location.href.includes("/create-agreement")) return;
      const priceInput = document.querySelector('input[formcontrolname="totalAgreementPrice"]');
      if (priceInput && !priceFilled) {
        priceInput.value = defaultPrice;
        priceInput.dispatchEvent(new Event("input", { bubbles: true }));
        priceFilled = true;
      }
      const wrapper = document.querySelector('p-checkbox[formcontrolname="regulations"]');
      if (wrapper && !checkboxChecked) {
        const box = wrapper.querySelector(".p-checkbox-box");
        if (box && !box.classList.contains("p-highlight")) {
          box.click();
          checkboxChecked = true;
        }
      }
      if (priceFilled && checkboxChecked) stopAutoFillAgreementDetails();
    }
    agreementObserver = new MutationObserver(tryFill);
    agreementObserver.observe(document.body, { childList: true, subtree: true });
    tryFill();
  }
  function stopAutoFillAgreementDetails() {
    if (!agreementObserver) return;
    agreementObserver.disconnect();
    agreementObserver = null;
  }

  // ── Auto hotel capture (hotel detail page) — unchanged mechanism ───────
  // Triggers on /umrah/service-providers/housing/hotel/{id}; extracts the ID
  // from the path and the name from <app-back-header h4>, then saves it into
  // the SAME list the search bar and the popup tab both read from.
  function isHotelPage() {
    return /\/umrah\/service-providers\/housing\/hotel\/\d+/.test(location.pathname);
  }
  function getHotelIdFromPath() {
    const m = location.pathname.match(/\/hotel\/(\d+)/);
    return m ? m[1] : null;
  }
  function getHotelNameFromPage() {
    const h4 = document.querySelector("app-back-header h4");
    if (!h4) return null;
    const name = h4.textContent.trim();
    return name.length > 1 ? name : null;
  }
  function showAutoCaptureToast(msg) {
    let el = document.getElementById("tm-hotel-auto-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "tm-hotel-auto-toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = "1";
    setTimeout(() => { el.style.opacity = "0"; }, 4000);
  }

  let captureObserver = null;
  let captured = false;
  function tryCapture() {
    if (captured || !moduleEnabled || !isHotelPage()) return;
    const hotelId = getHotelIdFromPath();
    if (!hotelId) return;
    const hotelName = getHotelNameFromPage();
    if (!hotelName) return; // Angular hasn't rendered the h4 yet — observer retries

    chrome.storage.local.get([LIST_KEY], (res) => {
      const list = res[LIST_KEY] || {};
      const existingEntry = Object.entries(list).find(([, v]) => String(v) === hotelId);

      if (existingEntry) {
        const [existingKey] = existingEntry;
        if (existingKey === hotelName) { captured = true; return; }
        list[hotelName] = parseInt(hotelId, 10);
        delete list[existingKey];
        chrome.storage.local.set({ [LIST_KEY]: list }, () => {
          hotels = list;
          refreshDatalist();
          captured = true;
          wlog(`renamed: ${existingKey} → ${hotelName} (id ${hotelId})`);
          showAutoCaptureToast("✏️ Hotel renamed: " + hotelName);
        });
        return;
      }

      list[hotelName] = parseInt(hotelId, 10);
      chrome.storage.local.set({ [LIST_KEY]: list }, () => {
        hotels = list;
        refreshDatalist();
        captured = true;
        wlog(`captured: ${hotelName} (id ${hotelId})`);
        showAutoCaptureToast("🏨 Hotel captured: " + hotelName);
      });
    });
  }
  function startCaptureObserver() {
    if (captureObserver) return;
    captureObserver = new MutationObserver(tryCapture);
    captureObserver.observe(document.body, { childList: true, subtree: true });
    tryCapture();
  }
  function stopCaptureObserver() {
    if (!captureObserver) return;
    captureObserver.disconnect();
    captureObserver = null;
  }

  // Route changes (Angular SPA navigation) can move you onto/off a hotel
  // page without a full reload — reset the per-page dedup flag so a genuine
  // navigation to a DIFFERENT hotel page gets re-evaluated.
  let lastPath = location.pathname;
  window.addEventListener("nusuk-route-change", () => {
    if (location.pathname !== lastPath) { lastPath = location.pathname; captured = false; }
    if (moduleEnabled) tryCapture();
  });

  // ── Module enable/disable (extension master switch + this module's own
  // toggle + license entitlement) — same pattern as modules/url-shifter.js ──
  function premiumOK() { return !window.NkLicense || window.NkLicense.featureOK("brnrequest"); }

  function applyEnabledState() {
    if (moduleEnabled) {
      inject();
      startAutoFillAgreementDetails();
      startCaptureObserver();
    } else {
      hideBar();
      stopAutoFillAgreementDetails();
      stopCaptureObserver();
    }
  }

  function refreshEnabled(after) {
    chrome.storage.local.get(["moduleBrnRequest", "extensionEnabled"], (res) => {
      const was = moduleEnabled;
      moduleEnabled = res.extensionEnabled !== false && !!res.moduleBrnRequest && premiumOK();
      if (moduleEnabled !== was) applyEnabledState();
      if (after) after();
    });
  }

  chrome.storage.local.get([LIST_KEY, HOTKEY_KEY, PRICE_KEY, NIGHTS_KEY], (res) => {
    hotels = res[LIST_KEY] || {};
    hotkeyCombo = normHotkey(res[HOTKEY_KEY]) || DEFAULT_HOTKEY;
    defaultPrice = (res[PRICE_KEY] || "").trim() || DEFAULT_PRICE;
    defaultNights = Math.max(1, Number(res[NIGHTS_KEY]) || DEFAULT_NIGHTS);
    refreshEnabled();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.moduleBrnRequest || changes.extensionEnabled) refreshEnabled();
    if (changes[LIST_KEY]) { hotels = changes[LIST_KEY].newValue || {}; refreshDatalist(); }
    if (changes[HOTKEY_KEY]) hotkeyCombo = normHotkey(changes[HOTKEY_KEY].newValue) || DEFAULT_HOTKEY;
    if (changes[PRICE_KEY]) defaultPrice = (changes[PRICE_KEY].newValue || "").trim() || DEFAULT_PRICE;
    if (changes[NIGHTS_KEY]) defaultNights = Math.max(1, Number(changes[NIGHTS_KEY].newValue) || DEFAULT_NIGHTS);
  });

  window.NkLicense && window.NkLicense.onPremiumChange(() => refreshEnabled());
})();
