// Package Creator — six package-creation automations from the user's
// Tampermonkey userscript, ported together as one module because they all
// cooperate during a single create-package run (the Runner drives the
// wizard; the rest fire reactively as their moment arrives):
//
//   groundService — on create-package/basic-info, ticks the checkbox on any
//                   row whose text matches one of the configured words
//                   (was hardcoded ["Nebras Al Fawz","PAKISTAN","Ground
//                   services"]; now a user-editable list).
//   autoFill      — expands collapsed accordions, zeroes tripNumber inputs,
//                   ticks every acknowledge checkbox as it appears, and
//                   fills Buying Price / Profit Margin per page type
//                   (ground / hotel static-or-nights×rate / transport /
//                   enrichment dialog / additional dialog). Settings that
//                   lived behind the original's on-page Ctrl+B popup now
//                   live in the extension popup (user-confirmed choice).
//                   Skips create-package/transportation, same as the
//                   original (its transport IIFE was never in the saved
//                   script — pending the user sharing that block).
//   singleFlight  — auto-clicks the radio when filtering leaves exactly ONE
//                   visible flight row. Deviation (user-confirmed): scoped
//                   to actual flight rows (row must contain td#time) — the
//                   original clicked ANY lone visible .p-radiobutton-box
//                   anywhere on the site. The original's spinner-removal
//                   half is NOT here — it's byte-identical to the existing
//                   Disable Overlay module.
//   beds10000     — fills an empty #integeronly input with the configured
//                   value (default 10000). Site-wide like the original;
//                   only ever touches EMPTY fields.
//   agents        — ticks the agent checkboxes matching the configured
//                   company names and clicks Add once enabled (was a
//                   hardcoded 10-name list; now user-editable).
//   runner        — the big state machine: paste Talab/BRN block(s) into an
//                   on-page panel, START, and it drives the ENTIRE
//                   create-package wizard (arrival/departure dates via
//                   click-driven calendars, highest-departure-time flight,
//                   add trip, destination city, per-hotel check-in/out +
//                   hotel dropdown + BRN dropdown + room count, continuous-
//                   stay grouping, saves) and loops to the next queued
//                   block automatically after each package completes.
//
// Runner deviations from the original (everything else ported 1:1):
//  1. parseInput always used the CURRENT year — a package created in Dec
//     for a Jan stay landed a year in the past. Dates now roll forward a
//     year when they'd land in the past.
//  2. A cross-year range ("28Dec | 03Jan") got both dates the same year,
//     putting checkout BEFORE check-in. The end date now rolls forward a
//     year when it lands before the start.
//  3. Panel restyled to Nuskomate's visual language, theme-aware (uiTheme).
//  4. State/queue keys renamed (nkPkg*) so this can never fight the user's
//     original Tampermonkey copy if both happen to be enabled at once.
// Run state (queue/index/step) stays in localStorage like the original —
// it must survive the full page reloads between packages but must NEVER
// cloud-sync to another device (same rule as acRunStatus).
(function () {
  "use strict";

  let moduleEnabled = false;
  const premiumOK = () => !window.NkLicense || window.NkLicense.featureOK("packagecreator");

  const SETTINGS_KEY = "pkgCreatorSettings";
  const DEFAULTS = {
    groundServiceEnabled: true,
    autoFillEnabled: true,
    singleFlightEnabled: true,
    bedsEnabled: true,
    agentsEnabled: true,
    transportEnabled: true,
    servicesEnabled: true,
    runnerEnabled: true,

    groundServiceWords: [
      { text: "Nebras Al Fawz", enabled: true },
      { text: "PAKISTAN", enabled: true },
      { text: "Ground services", enabled: true },
    ],

    ground_bp: "1", ground_pm: "1",
    hotel_bp_mode: "static", hotel_bp_static: "1", hotel_bp_rate: "100", hotel_pm: "1",
    enrichment_bp: "1", enrichment_pm: "1",
    additional_bp: "1", additional_pm: "1",
    // No separate transport_bp/transport_pm — the Trip Information Summary
    // page's transport prices now come from the same transportPage* values
    // the transport step itself uses, so transport is configured in exactly
    // one place.

    bedsValue: "10000",

    transportPageCost: "10",
    transportPageProfit: "1",
    flightHotkey: "Alt+Shift+F",
    additionalServiceText: "ZIARAT",
    enrichmentAutoDate: true,
    // Only these are ever picked. Empty = the destination dropdown is
    // left alone entirely (deliberately NOT "pick anything").
    enrichmentDestinations: [],

    agentNames: [
      "DATA TRAVEL AND TOURS",
      "FLYING ZONE INTERNATIONAL",
      "Sang e Aswad Travel And Tours Pvt Ltd",
      "AZAM TRAVEL AND TOURS PVT LTD",
      "NEW CHOUDHARY TRAVELS",
      "GULF AVIATION TRAVEL AND TOURS SERVICES",
      "ARYAN AIR TRAVELS",
      "SHAH WAZIR HAJJ AND UMRAH",
      "SHAH WAZIR HAJJ UMRAH SERVICES PVT LTD",
      "HANI TRAVEL & TOURISM",
    ].map((text) => ({ text, enabled: true })),
  };
  let settings = { ...DEFAULTS };

  // The word/company lists are {text, enabled} rows so each entry has its
  // own switch in the popup. Plain string arrays (the original shape) still
  // read fine — every entry counts as enabled.
  function enabledTexts(list) {
    return (Array.isArray(list) ? list : [])
      .map((x) => (typeof x === "string"
        ? { text: x, enabled: true }
        : { text: String(x && x.text || ""), enabled: !(x && x.enabled === false) }))
      .filter((x) => x.enabled && x.text.trim())
      .map((x) => x.text.trim());
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function setAngularValue(input, value) {
    if (typeof window.simulateAngularInput === "function") {
      window.simulateAngularInput(input, value);
      return;
    }
    input.focus();
    input.value = value;
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();
    input.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function realClick(el) {
    if (!el) return;
    el.scrollIntoView({ behavior: "auto", block: "center" });
    el.focus();
    ["mousedown", "mouseup", "click"].forEach((name) => {
      el.dispatchEvent(new MouseEvent(name, { bubbles: true, cancelable: true }));
    });
  }

  async function waitFor(fn, timeout = 25000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const res = fn();
      if (res) return res;
      await sleep(500);
    }
    throw new Error("Timeout waiting for element");
  }

  // ── Theme (mirrors popup.js's own THEME_KEY/applyTheme logic) ──
  let isDarkTheme = false;
  function refreshTheme() {
    chrome.storage.local.get(["uiTheme"], (res) => {
      const pref = res.uiTheme || "system";
      isDarkTheme = pref === "dark" ||
        (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      applyPanelTheme();
    });
  }
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", refreshTheme);

  /* ════════════════════════ #6 Ground-service checkbox ════════════════════ */

  let groundObserver = null;

  function groundTryCheck(row) {
    const words = enabledTexts(settings.groundServiceWords).map((w) => w.toLowerCase());
    if (!words.length) return;
    const text = row.innerText?.toLowerCase() || "";
    if (!words.some((w) => text.includes(w))) return;
    const checkbox = row.querySelector('input[type="checkbox"]');
    if (!checkbox || checkbox.checked) return;
    checkbox.click();
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function groundStart() {
    if (groundObserver) return;
    document.querySelectorAll("tr, .row, .table-row").forEach(groundTryCheck);
    groundObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.matches("tr, .row, .table-row")) groundTryCheck(node);
          node.querySelectorAll?.("tr, .row, .table-row").forEach(groundTryCheck);
        }
      }
    });
    groundObserver.observe(document.body, { childList: true, subtree: true });
  }

  function groundStop() {
    if (groundObserver) { groundObserver.disconnect(); groundObserver = null; }
  }

  function groundRefresh() {
    const on = moduleEnabled && settings.groundServiceEnabled &&
      location.href.includes("/umrah/packages/create-package/basic-info");
    on ? groundStart() : groundStop();
  }

  /* ════════════════════════ #7 Auto Fill When Creating Package ═══════════ */

  let afObserver = null;
  let afRunTimeout = null;
  let ackObserver = null;
  const ackSeen = new WeakSet();
  const ackIntervals = new Set();

  function expandAccordions() {
    // The transportation page's own handler (trOpenAllAccordions) owns
    // accordions there. Both only click ones reading aria-expanded="false",
    // but if both read that at the same instant they'd both click — one
    // opening it, the other closing it right back. Only one of them touches
    // that page now; the original scripts, being separate userscripts, had
    // no way to coordinate this.
    if (location.href.includes("transportation")) return;
    document.querySelectorAll('a.p-accordion-header-link[aria-expanded="false"]').forEach((banner) => {
      const opts = { bubbles: true, cancelable: true, view: window };
      banner.dispatchEvent(new PointerEvent("pointerdown", opts));
      banner.dispatchEvent(new MouseEvent("mousedown", opts));
      banner.dispatchEvent(new MouseEvent("mouseup", opts));
      banner.dispatchEvent(new PointerEvent("pointerup", opts));
      banner.dispatchEvent(new MouseEvent("click", opts));
    });
  }

  function fillTripNumbers() {
    document.querySelectorAll('input[formcontrolname="tripNumber"]').forEach((input) => {
      if (input.value !== "0") setAngularValue(input, "0");
    });
  }

  function detectPageType() {
    const dialogTitle = document.querySelector(".p-dialog .title, .p-dialog-header .title")?.textContent || "";
    if (dialogTitle.includes("Enrichment Services")) return "enrichment";
    if (dialogTitle.includes("Additional Services")) return "additional";
    if (document.querySelector("h3.title.ng-star-inserted")?.textContent.includes("Basic Information")) return "basicInfo";
    if (document.querySelector("h2.trip-info__title")?.textContent.includes("Trip Information")) return "tripInfo";
    if (document.querySelector("div.trip-information-summary")?.textContent.includes("Trip Information Summary")) return "tripSummary";
    if (document.querySelector("app-transportation")) return "tripSummary";
    return "fallback";
  }

  // The original had a second "Enable Price Auto-Fill" switch inside its
  // Ctrl+B popup, separate from the script being active. Folded into the
  // single autoFillEnabled toggle here — the card is named "Auto Fill
  // Prices & Fields", and these only ever run via afRunTasks(), which
  // afRefresh() already gates on it.
  function fillBuyingPrice() {
    const pageType = detectPageType();

    if (pageType === "basicInfo") {
      const val = settings.ground_bp || "1";
      document.querySelectorAll('input.p-inputtext[placeholder="Buying Price Per Pilgrim (Inc VAT)"]').forEach((input) => {
        if (input.value !== val) setAngularValue(input, val);
      });
    } else if (pageType === "tripInfo") {
      document.querySelectorAll(".priceForm").forEach((form) => {
        const bpInput = form.querySelector('input.p-inputtext[placeholder="Buying Price Per Pilgrim (Inc VAT)"]');
        if (!bpInput) return;
        let val = settings.hotel_bp_static || "1";
        if (settings.hotel_bp_mode === "calc") {
          // durationOfStay is a sibling of the <fieldset> wrapping the price
          // form, so walk UP until the containing component has it.
          let container = form.parentElement;
          let durInput = null;
          while (container && container !== document.body) {
            durInput = container.querySelector('input[formcontrolname="durationOfStay"]');
            if (durInput) break;
            container = container.parentElement;
          }
          if (durInput) {
            const nights = parseFloat(durInput.value) || 0;
            const rate = parseFloat(settings.hotel_bp_rate) || 0;
            val = (nights * rate).toString();
          }
        }
        if (bpInput.value !== val) setAngularValue(bpInput, val);
      });
    } else if (pageType === "tripSummary") {
      // Transport is configured once, under Transport Selection — the
      // summary page's transport price reads the same value the transport
      // step itself writes.
      const val = settings.transportPageCost || "10";
      document.querySelectorAll('input.p-inputtext[placeholder="Buying Price Per Pilgrim (Inc VAT)"]').forEach((input) => {
        if (input.value !== val) setAngularValue(input, val);
      });
    }
    // The Enrichment / Additional dialogs are handled by the Services
    // Selection helper instead (svcFillPrices) — their prices are
    // configured on that card, so that card's switch controls them.
  }

  function fillProfitMargin() {
    const pageType = detectPageType();
    // Enrichment / Additional belong to the Services Selection helper.
    if (pageType === "enrichment" || pageType === "additional") return;

    let margin;
    if (pageType === "basicInfo") margin = settings.ground_pm || "1";
    else if (pageType === "tripInfo") margin = settings.hotel_pm || "1";
    else if (pageType === "tripSummary") margin = settings.transportPageProfit || "1";
    else margin = settings.ground_pm || "1";

    document.querySelectorAll('input.p-inputtext[placeholder="Profit Margin (Inc VAT)"]').forEach((input) => {
      if (input.value !== margin) setAngularValue(input, margin);
    });
  }

  function ackClickWhenReady(el) {
    const interval = setInterval(() => {
      if (!moduleEnabled || !settings.autoFillEnabled || !document.body.contains(el)) {
        clearInterval(interval);
        ackIntervals.delete(interval);
        return;
      }
      if (!el.checked) el.click();
      else { clearInterval(interval); ackIntervals.delete(interval); }
    }, 500);
    ackIntervals.add(interval);
  }

  function ackTryCheckAll() {
    document.querySelectorAll('input[type="checkbox"][formcontrolname="acknowledge"]').forEach((box) => {
      if (!ackSeen.has(box)) {
        ackSeen.add(box);
        ackClickWhenReady(box);
      }
    });
  }

  function afRunTasks() {
    // Transportation page deliberately untouched — same as the original
    // (its transport-page block is pending from the user; prices for
    // transport fill on the Trip Information Summary page instead).
    if (location.href.includes("transportation")) return;
    fillTripNumbers();
    fillBuyingPrice();
    fillProfitMargin();
  }

  function afStart() {
    if (afObserver) return;
    ackTryCheckAll();
    ackObserver = new MutationObserver(ackTryCheckAll);
    ackObserver.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => { if (moduleEnabled && settings.autoFillEnabled) { expandAccordions(); afRunTasks(); } }, 1000);

    afObserver = new MutationObserver(() => {
      clearTimeout(afRunTimeout);
      afRunTimeout = setTimeout(afRunTasks, 300);
    });
    afObserver.observe(document.body, { childList: true, subtree: true });
  }

  function afStop() {
    if (afObserver) { afObserver.disconnect(); afObserver = null; }
    if (ackObserver) { ackObserver.disconnect(); ackObserver = null; }
    clearTimeout(afRunTimeout);
    ackIntervals.forEach((i) => clearInterval(i));
    ackIntervals.clear();
  }

  function afRefresh() {
    const on = moduleEnabled && settings.autoFillEnabled;
    on ? afStart() : afStop();
  }

  /* ════════════════════════ #9 Auto-select single filtered flight ═════════ */

  let sfObserver = null;
  let sfPaused = false;

  function sfCheck() {
    if (sfPaused) return;
    // Deviation (user-confirmed): only radios inside actual flight rows
    // (td#time present) count — the original clicked ANY lone visible
    // radio anywhere on the site.
    const markButtons = Array.from(document.querySelectorAll(".p-radiobutton-box"))
      .filter((el) => el.offsetParent !== null && el.closest("tr")?.querySelector("td#time"));
    if (markButtons.length === 1) {
      const target = markButtons[0];
      if (target && document.contains(target)) {
        target.click();
        // Pause briefly after clicking so Angular's re-render of the same
        // single row doesn't get clicked again in a loop.
        sfPaused = true;
        setTimeout(() => { sfPaused = false; }, 2000);
      }
    }
  }

  function sfStart() {
    if (sfObserver) return;
    sfObserver = new MutationObserver(sfCheck);
    sfObserver.observe(document.body, { childList: true, subtree: true });
  }

  function sfStop() {
    if (sfObserver) { sfObserver.disconnect(); sfObserver = null; }
  }

  function sfRefresh() {
    const on = moduleEnabled && settings.singleFlightEnabled;
    on ? sfStart() : sfStop();
  }

  // ── Hotkey: pick the latest flight ──
  // Backlog #8 ("Alt+Shift+F — select flight with highest departure time"),
  // folded in here rather than as its own module: it's the same flight
  // table and the same selection this card already automates, just
  // manually triggered. Combo matching is self-contained (same reasoning
  // as modules/brn-request.js: no load-order dependency on another file).
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

  document.addEventListener("keydown", (e) => {
    if (!moduleEnabled || !settings.singleFlightEnabled) return;
    const want = normHotkey(settings.flightHotkey || "Alt+Shift+F");
    if (!want || comboFromEvent(e) !== want) return;
    e.preventDefault();
    selectFlightWithHighestTime(1500).catch(() => pkgLog("⚠️ No flight rows on this page."));
  }, true);

  /* ════════════════════════ #16 Dummy beds number ═════════════════════════ */

  let bedsObserver = null;

  function bedsFillIfEmpty() {
    const el = document.getElementById("integeronly");
    if (el && (el.value === "" || el.value == null)) {
      el.value = settings.bedsValue || "10000";
      el.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
    }
  }

  function bedsStart() {
    if (bedsObserver) return;
    bedsFillIfEmpty();
    bedsObserver = new MutationObserver(bedsFillIfEmpty);
    bedsObserver.observe(document.body, { childList: true, subtree: true });
  }

  function bedsStop() {
    if (bedsObserver) { bedsObserver.disconnect(); bedsObserver = null; }
  }

  function bedsRefresh() {
    const on = moduleEnabled && settings.bedsEnabled;
    on ? bedsStart() : bedsStop();
  }

  /* ════════════════════════ #17 Select agents & click Add ═════════════════ */

  let agObserver = null;
  let agDebounce = null;
  let agAddPending = false; // set once we've ticked agents; cleared when Add is clicked
  const AG_PROCESSED = "data-nk-auto-checked";

  const agNormalize = (t) => (t || "").replace(/\s+/g, " ").trim().toUpperCase();

  function agSelectMatches() {
    const targets = enabledTexts(settings.agentNames).map(agNormalize);
    if (!targets.length) return;

    document.querySelectorAll(".field-checkbox").forEach((agent) => {
      try {
        if (agent.getAttribute(AG_PROCESSED) === "1") return;
        const nameEl = agent.querySelector(".agent-name");
        if (!nameEl) return;
        if (!targets.includes(agNormalize(nameEl.textContent))) return;

        const box = agent.querySelector(".p-checkbox-box");
        const hiddenInput = agent.querySelector('input[type="checkbox"]');
        if (box) {
          const alreadyChecked = box.classList.contains("p-highlight") || (hiddenInput && hiddenInput.checked);
          if (!alreadyChecked) box.click();
        } else if (hiddenInput && !hiddenInput.checked) {
          hiddenInput.click();
        }
        agent.setAttribute(AG_PROCESSED, "1");
        agAddPending = true;
      } catch (_) {}
    });

    // Angular may enable Add a beat AFTER the ticks land, so the click
    // can't be gated on "selected something THIS pass" — the pending flag
    // persists across passes until Add actually gets pressed (the original
    // clicked any visible enabled Add on every pass; the flag keeps that
    // robustness without ever pressing an Add we didn't cause).
    if (agAddPending) {
      const addBtn = Array.from(document.querySelectorAll("button.p-button")).find((b) => {
        const text = (b.textContent || "").trim().toUpperCase();
        return text === "ADD" && !b.disabled && b.offsetParent !== null;
      });
      if (addBtn) { agAddPending = false; addBtn.click(); }
    }
  }

  function agSchedule() {
    clearTimeout(agDebounce);
    agDebounce = setTimeout(agSelectMatches, 300);
  }

  function agStart() {
    if (agObserver) return;
    agSchedule();
    agObserver = new MutationObserver(agSchedule);
    agObserver.observe(document.body, { childList: true, subtree: true, attributes: true });
  }

  function agStop() {
    if (agObserver) { agObserver.disconnect(); agObserver = null; }
    clearTimeout(agDebounce);
  }

  function agRefresh() {
    const on = moduleEnabled && settings.agentsEnabled;
    on ? agStart() : agStop();
  }

  /* ════════════════════════ Services popups ═══════════════════════════════ */
  // Ported from the userscript's "AUTOMATE SERVICES POPUPS WITH MANUAL DATE
  // GUARD & RANDOM SELECTION" block (which was missing from the backlog
  // inventory). Two dialogs:
  //   Additional Services — fills name + details with the configured text
  //                         (was hardcoded "ZIARAT").
  //   Enrichment Services — selects the enrichment radio card, then STOPS
  //                         until you pick the date yourself (deliberate:
  //                         the date is a judgement call, so it's never
  //                         auto-filled), and only once a date is there
  //                         picks a random Enrichment Destination and
  //                         copies that choice into the details field.

  let svcObserver = null;
  let svcRunning = false;
  // dialog → the destination text we last mirrored into its details box.
  const svcLastDest = new WeakMap();
  // dialogs whose dropdown had none of the listed destinations — so the
  // warning isn't repeated on every DOM change.
  const svcNoMatch = new WeakSet();

  function svcWriteField(field, textValue) {
    field.focus();
    field.value = textValue;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    field.blur();
  }

  // Fills only when the field is empty — never clobbers your typing.
  function svcFillInput(container, selector, textValue) {
    const field = container.querySelector(selector);
    if (!field || field.value) return false;
    svcWriteField(field, textValue);
    return true;
  }

  // Overwrites whatever's there. Used only for the details box tracking a
  // destination change, where the old text is a stale copy of the old
  // destination and keeping it would be wrong.
  function svcSetInput(container, selector, textValue) {
    const field = container.querySelector(selector);
    if (!field || field.value === textValue) return false;
    svcWriteField(field, textValue);
    return true;
  }

  // The destination currently showing in the dialog's dropdown, or "" when
  // it's still on its placeholder.
  function svcCurrentDest(dialog) {
    const label = dialog.querySelector("p-dropdown .p-dropdown-label");
    if (!label) return "";
    const text = label.textContent.trim();
    if (!text || text.includes("Enrichment Destination")) return "";
    return text;
  }

  // Prices inside an open Enrichment / Additional dialog. Run on every
  // pass (not once per dialog like the fills below) because these fields
  // can render late — the same continuous approach the other pages' price
  // filling uses.
  function svcFillPrices() {
    for (const header of document.querySelectorAll(".p-dialog-header .title")) {
      const titleText = header.textContent.trim();
      const isEnrichment = titleText.includes("Enrichment Services");
      const isAdditional = titleText.includes("Additional Services");
      if (!isEnrichment && !isAdditional) continue;

      const dialog = header.closest(".p-dialog");
      const scope = dialog && dialog.querySelector(".p-dialog-content");
      if (!scope) continue;

      const price = (isEnrichment ? settings.enrichment_bp : settings.additional_bp) || "1";
      const margin = (isEnrichment ? settings.enrichment_pm : settings.additional_pm) || "1";
      scope.querySelectorAll('input.p-inputtext[placeholder="Buying Price Per Pilgrim (Inc VAT)"]').forEach((input) => {
        if (input.value !== price) setAngularValue(input, price);
      });
      scope.querySelectorAll('input.p-inputtext[placeholder="Profit Margin (Inc VAT)"]').forEach((input) => {
        if (input.value !== margin) setAngularValue(input, margin);
      });
    }
  }

  // Opens this dialog's date calendar and clicks the earliest day that
  // isn't disabled, walking forward month by month if the visible month
  // has none. Never touches a date that's already set.
  async function svcPickFirstAvailableDate(dialog) {
    const cal = dialog.querySelector('p-calendar[formcontrolname="date"]');
    if (!cal) return false;
    const input = cal.querySelector("input");
    if (input && input.value) return true; // already chosen — leave it alone

    realClick(cal.querySelector("button") || input);
    const picker = await waitFor(() => {
      const dp = document.querySelector(".p-datepicker:not(.p-datepicker-inline)");
      return dp && dp.offsetParent !== null ? dp : null;
    }, 5000).catch(() => null);
    if (!picker) return false;

    for (let month = 0; month < 12; month++) {
      // DOM order is calendar order, so the first enabled cell IS the
      // earliest selectable day in the visible month.
      const day = picker.querySelector("td:not(.p-datepicker-other-month) span:not(.p-disabled)");
      if (day) {
        day.click();
        await sleep(600);
        pkgLog(`📅 Enrichment date: first available (${day.textContent.trim()})`);
        return true;
      }
      const next = picker.querySelector(".p-datepicker-next");
      if (!next) break;
      realClick(next);
      await sleep(500);
    }
    pkgLog("⚠️ No selectable date found in the next 12 months.");
    return false;
  }

  // Returns whatever's already chosen, otherwise opens the dropdown and
  // picks a RANDOM one of YOUR listed destinations (random is the
  // original's deliberate behaviour — it spreads bookings around instead
  // of always taking the first; the allow-list is the addition). Callers
  // must only reach here with a non-empty list.
  async function svcPickDropdown(container, placeholderText, allowed) {
    const dropdown = container.querySelector("p-dropdown");
    if (!dropdown) return null;

    const labelSpan = dropdown.querySelector(".p-dropdown-label");
    if (labelSpan && !labelSpan.textContent.includes(placeholderText) && labelSpan.textContent.trim() !== "") {
      return labelSpan.textContent.trim();
    }

    const trigger = dropdown.querySelector(".p-dropdown-trigger");
    if (!trigger) return null;
    trigger.click();
    await sleep(500);

    const items = Array.from(document.querySelectorAll(".p-dropdown-panel p-dropdownitem li:not(.p-disabled)"));
    if (!items.length) return null;

    const wanted = allowed.map((t) => t.toLowerCase());
    const pool = items.filter((li) => {
      const t = li.textContent.trim().toLowerCase();
      return wanted.some((a) => t.includes(a));
    });
    if (!pool.length) {
      pkgLog("⚠️ None of your listed destinations are in this dropdown — nothing picked.");
      document.body.click(); // close the panel so it isn't left hanging open
      return null;
    }

    const chosen = pool[Math.floor(Math.random() * pool.length)];
    const text = chosen.textContent.trim();
    chosen.click();
    await sleep(400);
    return text;
  }

  async function svcCheckPopups() {
    if (svcRunning) return;
    if (!moduleEnabled || !settings.servicesEnabled) return;
    svcRunning = true;
    try {
      svcFillPrices();
      // No per-dialog "already processed" marker any more. Angular reuses
      // the same .p-dialog element for the next service you open, so a
      // permanent marker meant only the FIRST enrichment/additional card
      // ever got filled. Every step below is instead guarded on the
      // field's own state, which is naturally correct however many cards
      // come through the same dialog element.
      for (const header of document.querySelectorAll(".p-dialog-header .title")) {
        const titleText = header.textContent.trim();
        const dialog = header.closest(".p-dialog");
        if (!dialog) continue;

        if (titleText.includes("Additional Services")) {
          const text = settings.additionalServiceText || "ZIARAT";
          // svcFillInput only writes into an empty field, so this is a
          // no-op once the card is filled — and fills again for the next
          // card that reuses this dialog.
          const filled = svcFillInput(dialog, 'div[formgroupname="name"] input[formcontrolname="en"]', text);
          if (filled) {
            pkgLog(`🎯 Additional Services — filling "${text}"`);
            await sleep(200);
          }
          svcFillInput(dialog, 'div[formgroupname="details"] textarea[formcontrolname="en"]', text);
        } else if (titleText.includes("Enrichment Services")) {
          const radio = dialog.querySelector('app-radio-card input[type="radio"][value="4"]');
          if (radio) {
            const figure = radio.closest("figure.radio-card");
            if (figure && !figure.classList.contains("selected")) {
              figure.click();
              await sleep(500);
            }
          }

          const dateInput = dialog.querySelector('p-calendar[formcontrolname="date"] input');
          if (!dateInput) continue;

          // The original always waited for the date to be set by hand.
          // With auto-date on, the earliest selectable day gets picked
          // instead; a date already in the box is never overwritten.
          if (!dateInput.value && settings.enrichmentAutoDate) {
            await svcPickFirstAvailableDate(dialog);
          }

          // Still nothing (auto-date off, or no selectable day). Skip just
          // THIS dialog rather than the whole pass — with several service
          // dialogs open, one waiting on a date shouldn't stall the rest.
          if (!dateInput.value) continue;

          let dest = svcCurrentDest(dialog);

          // Pick one only when nothing is chosen yet. An empty list means
          // the dropdown is left alone entirely; svcNoMatch remembers the
          // dialogs where none of the listed destinations were on offer,
          // so we don't reopen and re-warn on every DOM change.
          if (!dest && !svcNoMatch.has(dialog)) {
            const allowedDests = enabledTexts(settings.enrichmentDestinations);
            if (allowedDests.length) {
              dest = await svcPickDropdown(dialog, "Enrichment Destination", allowedDests);
              if (!dest) svcNoMatch.add(dialog);
            }
          }

          // Details mirror whichever destination is selected right now —
          // ours, or one you changed by hand afterwards. Keyed on the last
          // value we wrote, so changing the destination updates details,
          // while details you've since edited yourself are left alone.
          if (dest && svcLastDest.get(dialog) !== dest) {
            svcSetInput(dialog, 'div[formgroupname="details"] textarea[formcontrolname="en"]', dest);
            svcLastDest.set(dialog, dest);
            svcNoMatch.delete(dialog);
            pkgLog(`✨ Enrichment Services — ${dest}`);
          }
        }
      }
    } catch (e) {
      pkgLog(`❌ Services error: ${e.message}`);
    } finally {
      svcRunning = false;
    }
  }

  function svcStart() {
    if (svcObserver) return;
    svcCheckPopups();
    svcObserver = new MutationObserver(svcCheckPopups);
    svcObserver.observe(document.body, { childList: true, subtree: true });
  }

  function svcStop() {
    if (svcObserver) { svcObserver.disconnect(); svcObserver = null; }
  }

  function svcRefresh() {
    const on = moduleEnabled && settings.servicesEnabled;
    on ? svcStart() : svcStop();
  }

  /* ════════════════════════ Transport page ════════════════════════════════ */
  // Ported from the user's separate "Auto Selecting Transport in Package"
  // userscript (v8.6) — the block the main Auto Fill deliberately skips.
  // Only ever acts on create-package/transportation: expands every
  // collapsed accordion, then per trip leg picks Train Travel when it's
  // offered and Land Travel otherwise, and fills trip number + cost/profit.
  //
  // It deliberately does NOT touch Company Name / Vehicle Model / Vehicle
  // Type, even though the original did. Three ordinary dropdown rules
  // (selector span[aria-label="Select …"], repeat on) handle those far
  // better: the aria-label stops saying "Select" once a value is chosen so
  // they self-stop, they apply to every row on the page instead of only the
  // last one, and the values live where the user already edits rules.

  let trObserver = null;
  let trBusy = false;

  function trTriggerClick(el) {
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new PointerEvent("click", opts));
  }

  async function trOpenAllAccordions() {
    const headers = document.querySelectorAll(".p-accordion-header");
    for (const header of headers) {
      const anchor = header.querySelector('a[role="button"]');
      const isExpanded = anchor?.getAttribute("aria-expanded") === "true" || header.classList.contains("p-highlight");
      if (anchor && !isExpanded) {
        trTriggerClick(anchor);
        await sleep(400);
      }
    }
  }

  function trFillTripNumbers(container) {
    container.querySelectorAll('input[formcontrolname="tripNumber"]').forEach((input) => {
      input.focus();
      input.value = "0";
      ["input", "change", "blur"].forEach((ev) => input.dispatchEvent(new Event(ev, { bubbles: true })));
    });
  }

  // This page's price fields are p-inputnumber cost/profit controls — NOT
  // the placeholder-matched "Buying Price Per Pilgrim" inputs the other
  // pages use, so they carry their own two settings.
  function trFillFinancialFields(container) {
    [
      { el: container.querySelector('p-inputnumber[formcontrolname="cost"] input'), val: settings.transportPageCost || "10" },
      { el: container.querySelector('p-inputnumber[formcontrolname="profit"] input'), val: settings.transportPageProfit || "1" },
    ].forEach(({ el, val }) => {
      if (!el) return;
      el.focus();
      el.value = val;
      ["input", "change", "blur"].forEach((ev) => el.dispatchEvent(new Event(ev, { bubbles: true })));
    });
  }

  async function trRun() {
    if (trBusy) return;
    if (!moduleEnabled || !settings.transportEnabled) return;
    if (!location.href.includes("transportation")) return;

    trBusy = true;
    try {
      await trOpenAllAccordions();
      const accordionPanels = document.querySelectorAll("p-accordiontab");
      const containers = accordionPanels.length ? accordionPanels : [document.body];

      for (const container of containers) {
        // dataset key renamed from the original's `done` to `nkDone` so a
        // still-installed Tampermonkey copy can't mark cards we'd skip
        // (and vice versa).
        const targetCards = [...container.querySelectorAll("figure.radio-card")].filter((c) => !c.dataset.nkDone);
        if (!targetCards.length) continue;

        const trainCard = targetCards.find((c) => c.innerText.includes("Train Travel"));
        const landCard = targetCards.find((c) => c.innerText.includes("Land Travel"));

        if (trainCard) {
          pkgLog("🚆 Train Travel offered — selecting it.");
          trTriggerClick(trainCard);
          // Both cards in the leg get marked so the choice never flips back.
          targetCards.forEach((c) => { c.dataset.nkDone = "true"; });
          await sleep(1500);
          trFillTripNumbers(container);
          trFillFinancialFields(container);
          break; // let the UI settle; the observer picks up the next leg
        } else if (landCard) {
          pkgLog("🚌 No Train Travel — using Land Travel.");
          trTriggerClick(landCard);
          targetCards.forEach((c) => { c.dataset.nkDone = "true"; });
          await sleep(1500);
          trFillTripNumbers(container);
          trFillFinancialFields(container);
          // Company Name / Vehicle Model / Vehicle Type are deliberately
          // NOT filled here — three plain dropdown rules
          // (span[aria-label="Select …"], repeat on) do it better: they
          // self-stop once the aria-label stops saying "Select", they
          // cover every row on the page rather than just the last one,
          // and the values stay editable as ordinary rules.
          break;
        }
      }
    } catch (e) {
      pkgLog(`❌ Transport error: ${e.message}`);
    }
    trBusy = false;
  }

  function trStart() {
    if (trObserver) return;
    trRun();
    trObserver = new MutationObserver(() => { if (!trBusy) trRun(); });
    trObserver.observe(document.body, { childList: true, subtree: true });
  }

  function trStop() {
    if (trObserver) { trObserver.disconnect(); trObserver = null; }
  }

  function trRefresh() {
    const on = moduleEnabled && settings.transportEnabled;
    on ? trStart() : trStop();
  }

  /* ════════════════════════ #22 Auto Package Creation runner ══════════════ */

  const REQUIRED_URL_PART = "https://masar.nusuk.sa/umrah/packages/create-package/";
  const STATE_KEY = "nkPkgState";
  const BRN_QUEUE_KEY = "nkPkgQueue";
  const BRN_INDEX_KEY = "nkPkgIndex";

  const STEPS = {
    IDLE: "idle",
    NAME_FILLED: "name_filled",
    FIRST_DATE_SELECTED: "first_date_selected",
    FIRST_FLIGHTS_LOADED: "first_flights_loaded",
    SECOND_DATE_SELECTED: "second_date_selected",
    SECOND_FLIGHTS_LOADED: "second_flights_loaded",
    TRIP_ADDED: "trip_added",
    HOTEL_SELECTED: "hotel_selected",
    COMPLETED: "completed",
  };

  function getState() {
    try {
      const state = localStorage.getItem(STATE_KEY);
      return state ? JSON.parse(state) : { step: STEPS.IDLE, data: null };
    } catch (_) { return { step: STEPS.IDLE, data: null }; }
  }
  function setState(step, data = null) {
    localStorage.setItem(STATE_KEY, JSON.stringify({ step, data }));
  }
  function resetState() { localStorage.removeItem(STATE_KEY); }

  function watchAndClickNext() {
    const nextButton = Array.from(document.querySelectorAll("button.btn.btn-primary"))
      .find((btn) => btn.textContent.trim() === "Next" && !btn.disabled);
    if (nextButton) {
      pkgLog("🟢 Found 'Next' button — clicking…");
      realClick(nextButton);
    }
  }

  // ── Data extraction ──

  function parseInput(txt) {
    const lines = txt.split("\n").map((l) => l.trim()).filter(Boolean);
    const dateLine = lines.find((l) => l.includes("|") && l.includes("-"));
    let result = null;
    if (dateLine) {
      const parts = dateLine.split("|");
      const startPart = parts[0].trim();
      const endPart = parts[1].split("-")[0].trim();
      const parseDate = (str) => {
        const dayMatch = str.match(/\d+/);
        const monthMatch = str.match(/[a-zA-Z]+/);
        if (!dayMatch || !monthMatch) throw new Error("Invalid date format: " + str);
        const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
        return { day: parseInt(dayMatch[0], 10), month: months[monthMatch[0].toLowerCase().slice(0, 3)], year: new Date().getFullYear() };
      };
      result = { startDate: parseDate(startPart), endDate: parseDate(endPart) };

      // Bug fix #1 — the pipe format carries no year, and the original
      // always stamped the CURRENT one, so a package built in Dec for a
      // Jan stay landed a year in the past. Roll the start forward when
      // it's already behind today.
      const today = new Date();
      const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const startAsDate = new Date(result.startDate.year, result.startDate.month, result.startDate.day);
      if (startAsDate < todayMidnight) result.startDate.year++;

      // Bug fix #2 — a cross-year range ("28Dec | 03Jan") got both dates
      // the same year, putting checkout BEFORE check-in. Roll the end
      // forward until it's after the start.
      result.endDate.year = result.startDate.year;
      const endAsDate = () => new Date(result.endDate.year, result.endDate.month, result.endDate.day);
      const startFinal = new Date(result.startDate.year, result.startDate.month, result.startDate.day);
      if (endAsDate() <= startFinal) result.endDate.year++;

      return result;
    }
    const drMatch = txt.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (drMatch) {
      return {
        startDate: { day: parseInt(drMatch[1], 10), month: parseInt(drMatch[2], 10) - 1, year: parseInt(drMatch[3], 10) },
        endDate: { day: parseInt(drMatch[4], 10), month: parseInt(drMatch[5], 10) - 1, year: parseInt(drMatch[6], 10) },
      };
    }
    throw new Error("Could not parse date format from text");
  }

  const extractHotelName = (txt) => {
    if (!txt || typeof txt !== "string") return "Hotel";
    const lines = txt.split("\n").map((l) => l.trim()).filter(Boolean);
    return (lines[1] || "Hotel").replace(/\s*\((MAD|MAK)\)\s*/gi, "").trim();
  };

  const extractCity = (txt) => {
    if (!txt || typeof txt !== "string") return "Makkah";
    const match = txt.match(/\((MAD|MAK)\)/i);
    if (!match) return "Makkah";
    return match[1].toUpperCase() === "MAD" ? "Madina" : "Makkah";
  };

  const extractBRN = (txt) => {
    if (!txt || typeof txt !== "string") return null;
    return txt.match(/\b\d{10,20}\b/)?.[0] || null;
  };

  const extractBeds = (txt) => {
    const pxMatch = txt.match(/(\d+)\s*Px/i);
    return pxMatch ? pxMatch[1] : (txt.match(/beds?:?\s*(\d+)/i)?.[1] || "1");
  };

  function splitMultipleBRNs(txt) {
    let blocks = [];
    if (txt.includes('"')) {
      blocks = txt
        .split(/"\s*[\r\n]+\s*"|"\s*[\r\n]+|[\r\n]+\s*"/)
        .map((b) => b.replace(/^"+|"+$/g, "").trim())
        .filter(Boolean);
    } else {
      blocks = txt.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
    }
    if (!blocks.length) return [];

    const grouped = [];
    let currentGroup = [blocks[0]];
    for (let i = 1; i < blocks.length; i++) {
      try {
        const prev = parseInput(currentGroup[currentGroup.length - 1]);
        const curr = parseInput(blocks[i]);
        const isContinuous =
          prev.endDate.day === curr.startDate.day &&
          prev.endDate.month === curr.startDate.month;
        if (isContinuous) currentGroup.push(blocks[i]);
        else { grouped.push({ hotels: [...currentGroup] }); currentGroup = [blocks[i]]; }
      } catch (_) {
        grouped.push({ hotels: [...currentGroup] });
        currentGroup = [blocks[i]];
      }
    }
    grouped.push({ hotels: [...currentGroup] });
    return grouped;
  }

  // ── Click-driven calendar (readonly PrimeNG fields — same reality the
  // Auto Date Picker module found: these only accept a real selection) ──

  async function stabilizeBeforeCalendarOpen(pCalendar) {
    if (!pCalendar) return;
    pCalendar.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(500);
    window.scrollBy(0, -100);
    await sleep(200);
  }

  async function pickDate(pCalendar, target) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const targetMonthName = months[target.month];
    const btn = pCalendar.querySelector("button") || pCalendar.querySelector("input");

    await stabilizeBeforeCalendarOpen(pCalendar);
    pkgLog(`📅 Opening calendar for: ${target.day} ${targetMonthName} ${target.year}`);
    realClick(btn);

    let datepicker = await waitFor(() => {
      const dp = document.querySelector(".p-datepicker:not(.p-datepicker-inline)");
      return dp && dp.offsetParent !== null ? dp : null;
    }, 5000).catch(() => null);

    if (!datepicker) {
      pkgLog("⚠️ Calendar didn't stay open, retrying click…");
      realClick(btn);
      await sleep(1000);
      datepicker = document.querySelector(".p-datepicker:not(.p-datepicker-inline)");
      if (!datepicker) throw new Error("Calendar would not open");
    }

    const curYear = datepicker.querySelector(".p-datepicker-year")?.textContent.trim();
    if (curYear != target.year) {
      realClick(datepicker.querySelector(".p-datepicker-year"));
      await sleep(600);
      const opt = Array.from(document.querySelectorAll(".p-yearpicker-year")).find((el) => el.textContent.trim() == target.year);
      if (opt) realClick(opt);
      await sleep(600);
    }

    const curMonth = datepicker.querySelector(".p-datepicker-month")?.textContent.trim();
    if (curMonth && !curMonth.includes(targetMonthName)) {
      realClick(datepicker.querySelector(".p-datepicker-month"));
      await sleep(600);
      const monthOpts = Array.from(document.querySelectorAll(".p-monthpicker-month"));
      const specificOpt = monthOpts.find((el) => el.textContent.trim().includes(targetMonthName));
      if (specificOpt) realClick(specificOpt);
      else if (monthOpts[target.month]) realClick(monthOpts[target.month]);
      await sleep(800);
    }

    const dayMatch = await waitFor(() => {
      const cells = Array.from(datepicker.querySelectorAll("td:not(.p-datepicker-other-month) span, td:not(.p-datepicker-other-month) a"));
      return cells.find((el) => el.textContent.trim() === String(target.day));
    });
    dayMatch.click();
    pkgLog(`✅ Date ${target.day} selected.`);
    await sleep(1000);
  }

  function timeToSeconds(timeStr) {
    const [h, m, s] = timeStr.split(":").map(Number);
    return (h * 3600) + (m * 60) + (s || 0);
  }

  // timeout is short for the hotkey path (the table is either already on
  // screen or it isn't) and long for the runner, which presses Search and
  // then waits for results to come back.
  async function selectFlightWithHighestTime(timeout = 25000) {
    const rows = await waitFor(() => {
      const r = Array.from(document.querySelectorAll("tr")).filter((tr) => tr.querySelector("td#time span"));
      return r.length ? r : null;
    }, timeout);
    let bestRow = null;
    let bestTime = -1;
    rows.forEach((row) => {
      const timeText = row.querySelector("td#time span")?.textContent.trim();
      if (!timeText) return;
      const seconds = timeToSeconds(timeText);
      if (seconds > bestTime) { bestTime = seconds; bestRow = row; }
    });
    if (!bestRow) throw new Error("No flight rows found");
    const radioBox = bestRow.querySelector(".p-radiobutton-box") || bestRow.querySelector('input[type="radio"]');
    realClick(radioBox);
    pkgLog(`☑️ Selected latest flight at ${bestRow.querySelector("td#time span").textContent.trim()}`);
  }

  // ── Main execute flow (ported 1:1 from the original state machine) ──

  let executing = false;

  async function execute() {
    if (executing) return;
    executing = true;
    try {
      const inputBox = document.getElementById("nkPkgInput");
      const txt = (inputBox?.value || "").trim();
      let queue = JSON.parse(localStorage.getItem(BRN_QUEUE_KEY) || "null");
      let index = Number(localStorage.getItem(BRN_INDEX_KEY) || 0);

      if (!queue) {
        queue = splitMultipleBRNs(txt);
        localStorage.setItem(BRN_QUEUE_KEY, JSON.stringify(queue));
        localStorage.setItem(BRN_INDEX_KEY, "0");
        index = 0;
      }

      const packageData = queue[index];
      if (inputBox && packageData?.hotels?.length) {
        inputBox.value = packageData.hotels.join('\n"\n');
      }
      if (!packageData || !packageData.hotels || !packageData.hotels.length) {
        pkgLog("❌ No valid hotel data found.");
        return;
      }
      const hotelsArray = packageData.hotels;

      const data1 = parseInput(hotelsArray[0]);
      const lastData = parseInput(hotelsArray[hotelsArray.length - 1]);
      const departureDate = lastData.endDate;

      const currentTxt = hotelsArray[0];
      let state = getState();
      if (state.data !== currentTxt) {
        resetState();
        state = { step: STEPS.IDLE, data: currentTxt };
      }

      while (state.step !== STEPS.COMPLETED) {
        if (!moduleEnabled || !settings.runnerEnabled) { pkgLog("⏹ Stopped (module off)."); return; }
        const stateEl = document.getElementById("nkPkgState");
        if (stateEl) stateEl.textContent = `${state.step} (${index + 1}/${queue.length})`;

        if (state.step === STEPS.IDLE) {
          watchAndClickNext();
          state.step = STEPS.NAME_FILLED;
        }
        else if (state.step === STEPS.NAME_FILLED) {
          pkgLog("🔍 Searching for Arrival Calendar…");
          const arrivalCard = await waitFor(() => document.querySelector('app-journey-card[formgroupname="arrival"]'));
          const cal = arrivalCard.querySelector('p-calendar[formcontrolname="date"]');
          if (!cal) throw new Error("Arrival calendar not found");
          await pickDate(cal, data1.startDate);
          state.step = STEPS.FIRST_DATE_SELECTED;
        }
        else if (state.step === STEPS.FIRST_DATE_SELECTED) {
          await waitFor(() => document.querySelectorAll("tr td#time").length > 0);
          await selectFlightWithHighestTime();
          state.step = STEPS.FIRST_FLIGHTS_LOADED;
        }
        else if (state.step === STEPS.FIRST_FLIGHTS_LOADED) {
          pkgLog("🔍 Searching for Departure Calendar…");
          const departureCard = await waitFor(() =>
            document.querySelector('app-journey-card[formgroupname="departure"]') ||
            [...document.querySelectorAll("app-journey-card")].find((el) => el.innerText.includes("Departure")));
          const cal = departureCard.querySelector('p-calendar[formcontrolname="date"]');
          if (!cal) throw new Error("Departure calendar not found");
          await stabilizeBeforeCalendarOpen(cal);
          await pickDate(cal, departureDate);
          state.step = STEPS.SECOND_DATE_SELECTED;
        }
        else if (state.step === STEPS.SECOND_DATE_SELECTED) {
          await waitFor(() => document.querySelectorAll("tr td#time").length > 0);
          await selectFlightWithHighestTime();
          state.step = STEPS.SECOND_FLIGHTS_LOADED;
        }
        else if (state.step === STEPS.SECOND_FLIGHTS_LOADED) {
          realClick(await waitFor(() => document.querySelector(".add-trip-button__btn:not([disabled])")));
          state.step = STEPS.TRIP_ADDED;
        }
        else if (state.step === STEPS.TRIP_ADDED) {
          const targetCity = extractCity(hotelsArray[0]);
          pkgLog(`🏙️ Selecting City: ${targetCity}`);
          const drop = await waitFor(() => document.querySelector('p-dropdown[formcontrolname="destination"]'));
          realClick(drop.querySelector(".p-dropdown-label"));
          realClick(await waitFor(() => [...document.querySelectorAll("li")].find((li) => li.innerText.trim() === targetCity)));
          state.step = STEPS.HOTEL_SELECTED;
        }
        else if (state.step === STEPS.HOTEL_SELECTED) {
          const hotelsToProcess = packageData.hotels || [];
          let previousCity = null;
          let previousEndDate = null;

          for (let i = 0; i < hotelsToProcess.length; i++) {
            const hotelTxt = hotelsToProcess[i];
            const city = extractCity(hotelTxt);
            const brn = extractBRN(hotelTxt);
            const hName = extractHotelName(hotelTxt);
            const bedCount = extractBeds(hotelTxt);
            const hDates = parseInput(hotelTxt);

            const isContinuous =
              previousEndDate &&
              previousEndDate.day === hDates.startDate.day &&
              previousEndDate.month === hDates.startDate.month;
            const sameCity = previousCity && previousCity === city;

            pkgLog(`🏨 Processing ${hName} (${i + 1}/${hotelsToProcess.length})`);

            // City change / non-continuous — save the current station first.
            if (i > 0 && (!sameCity || !isContinuous)) {
              const hotelSave = await waitFor(() =>
                [...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "Save" && !b.disabled));
              realClick(hotelSave);
              await sleep(3000);
            }

            // New trip station, or "add another hotel" on a continuous stay.
            if (i === 0 || !sameCity) {
              const addTripBtn = await waitFor(() => document.querySelector(".add-trip-button__btn:not([disabled])"));
              realClick(addTripBtn);
              await sleep(2000);
              const drop = await waitFor(() => document.querySelector('p-dropdown[formcontrolname="destination"]'));
              realClick(drop.querySelector(".p-dropdown-label"));
              realClick(await waitFor(() => [...document.querySelectorAll("li")].find((li) => li.innerText.trim() === city)));
              await sleep(1000);
            } else if (sameCity && isContinuous) {
              const addAnotherBtn = await waitFor(() => document.querySelector(".btn.hover-button"));
              realClick(addAnotherBtn);
              await sleep(2000);
            }

            // Fill the hotel card — always the LAST calendar pair / dropdowns
            // on the page (the card just added).
            const allCals = document.querySelectorAll('p-calendar[formcontrolname*="Date"]');
            const checkInCal = allCals[allCals.length - 2];
            const checkOutCal = allCals[allCals.length - 1];
            await pickDate(checkInCal, hDates.startDate);
            await pickDate(checkOutCal, hDates.endDate);

            const hDrops = document.querySelectorAll('p-dropdown[formcontrolname="hotelId"]');
            const lastHotelDrop = hDrops[hDrops.length - 1];
            if (!lastHotelDrop) throw new Error("Hotel dropdown not found");
            realClick(lastHotelDrop.querySelector(".p-dropdown-label"));
            realClick(await waitFor(() =>
              [...document.querySelectorAll("li")].find((li) => li.innerText.toLowerCase().includes(hName.toLowerCase()))));
            await sleep(1000);

            const brnDrops = document.querySelectorAll('p-dropdown[formcontrolname="agreementId"]');
            realClick(brnDrops[brnDrops.length - 1].querySelector(".p-dropdown-label"));
            const brnOpt = await waitFor(() =>
              document.querySelector(`li[aria-label="${brn}"]`) ||
              [...document.querySelectorAll(".p-dropdown-item")].find((li) => li.innerText.trim().includes(brn)), 10000);
            realClick(brnOpt);
            await sleep(1500);

            const bedInputs = document.querySelectorAll('p-inputnumber[formcontrolname="roomCount"] input');
            const lastBedInput = bedInputs[bedInputs.length - 1];
            if (lastBedInput) {
              lastBedInput.focus();
              lastBedInput.value = bedCount;
              ["input", "change", "blur"].forEach((ev) => lastBedInput.dispatchEvent(new Event(ev, { bubbles: true })));
            }

            previousCity = city;
            previousEndDate = hDates.endDate;
          }

          // Final save.
          const hotelSave = await waitFor(() =>
            [...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "Save" && !b.disabled));
          realClick(hotelSave);
          await sleep(3000);

          state.step = STEPS.COMPLETED;
          setState(STEPS.COMPLETED, currentTxt);
        }
        setState(state.step, currentTxt);
        await sleep(800);
        watchAndClickNext();
      }
    } catch (e) {
      pkgLog(`❌ Error: ${e.message}`);
    } finally {
      executing = false;
    }
  }

  // ── On-page panel ──

  let panel = null;
  let monitorInterval = null;

  function pkgLog(m) {
    const logBox = document.getElementById("nkPkgLog");
    if (logBox) {
      const line = document.createElement("div");
      line.style.cssText = "border-left:2px solid #4f6ef7; padding-left:6px; margin-bottom:3px;";
      line.textContent = m;
      logBox.prepend(line);
    }
    if (typeof window.nkLog === "function") window.nkLog("PackageCreator: " + m.replace(/^[^\w]*\s*/, ""), "info");
  }

  function applyPanelTheme() {
    if (!panel) return;
    const bg = isDarkTheme ? "#1a1d27" : "#ffffff";
    const fg = isDarkTheme ? "#e8ecf8" : "#1a2035";
    const border = isDarkTheme ? "#2c3050" : "#e2e7f0";
    panel.style.background = bg;
    panel.style.color = fg;
    panel.style.border = `1px solid ${border}`;
    const ta = panel.querySelector("#nkPkgInput");
    if (ta) {
      ta.style.background = isDarkTheme ? "#22263a" : "#fff";
      ta.style.color = fg;
      ta.style.border = `1px solid ${border}`;
    }
    const logBox = panel.querySelector("#nkPkgLog");
    if (logBox) logBox.style.borderTop = `1px solid ${border}`;
  }

  function buildPanel() {
    if (panel) return;
    panel = document.createElement("div");
    panel.id = "nkPkgPanel";
    panel.style.cssText = `
      position: fixed; bottom: 8px; left: 8px; z-index: 999999;
      padding: 14px; width: 340px; border-radius: 12px;
      font-family: system-ui, sans-serif;
      box-shadow: 0 8px 24px rgba(0,0,0,0.25); display: none;
    `;
    panel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
        <div style="font-weight:800; font-size:14px; color:#4f6ef7;">Package Creator</div>
        <span id="nkPkgState" style="background:#4f6ef7; color:#fff; padding:1px 8px; border-radius:4px; font-size:11px;">${getState().step}</span>
      </div>
      <textarea id="nkPkgInput" placeholder="Paste BRN data here…"
        style="width:100%; height:80px; border-radius:6px; font-size:13px; padding:8px; box-sizing:border-box; margin-bottom:10px; outline:none; resize:vertical;"></textarea>
      <div style="display:flex; gap:8px; margin-bottom:10px;">
        <button id="nkPkgRun" style="flex:2; padding:9px; background:#4f6ef7; color:#fff; border:none; cursor:pointer; font-weight:700; font-size:13px; border-radius:6px;">START</button>
        <button id="nkPkgReset" style="flex:1; padding:9px; background:transparent; color:#4f6ef7; border:1px solid #4f6ef7; cursor:pointer; font-weight:600; font-size:12px; border-radius:6px;">RESET</button>
      </div>
      <div id="nkPkgLog" style="font-size:12px; opacity:.85; max-height:80px; overflow-y:auto; padding-top:8px; line-height:1.4;"></div>
    `;
    document.body.appendChild(panel);
    applyPanelTheme();

    panel.querySelector("#nkPkgRun").addEventListener("click", execute);
    panel.querySelector("#nkPkgReset").addEventListener("click", () => {
      localStorage.removeItem(BRN_QUEUE_KEY);
      localStorage.removeItem(BRN_INDEX_KEY);
      resetState();
      location.reload();
    });
  }

  function refreshPanelVisibility() {
    const on = moduleEnabled && settings.runnerEnabled && location.href.includes(REQUIRED_URL_PART);
    if (on) { buildPanel(); panel.style.display = "block"; }
    else if (panel) panel.style.display = "none";
  }

  // Advances the queue after each finished package: packages-list page +
  // COMPLETED state → bump index, jump back to basic-info for the next
  // block (full page load — that's what re-arms everything, same as the
  // original). Auto-resumes execute() when landing on create-package with
  // a queue still pending.
  function monitorTick() {
    if (!moduleEnabled || !settings.runnerEnabled) return;
    const url = window.location.href;
    let queue = null;
    try { queue = JSON.parse(localStorage.getItem(BRN_QUEUE_KEY)); } catch (_) {}
    let index = Number(localStorage.getItem(BRN_INDEX_KEY) || 0);
    const state = getState();

    if (url.includes("packages-list") && queue && state.step === STEPS.COMPLETED) {
      index++;
      if (index < queue.length) {
        pkgLog("⏳ Finished one! Moving to the next…");
        localStorage.setItem(BRN_INDEX_KEY, String(index));
        resetState();
        window.location.href = "https://masar.nusuk.sa/umrah/packages/create-package/basic-info";
      } else {
        localStorage.removeItem(BRN_QUEUE_KEY);
        localStorage.removeItem(BRN_INDEX_KEY);
        pkgLog("🎉 ALL BRNS FINISHED");
        window.nkToast("All BRN packages created successfully", "success");
      }
    }
    if (url.includes("create-package") && queue && state.step === STEPS.IDLE && !executing) execute();
  }

  function runnerRefresh() {
    refreshPanelVisibility();
    const on = moduleEnabled && settings.runnerEnabled;
    if (on && !monitorInterval) monitorInterval = setInterval(monitorTick, 2000);
    else if (!on && monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
  }

  /* ════════════════════════ Wiring ════════════════════════════════════════ */

  function refreshAll() {
    groundRefresh();
    afRefresh();
    sfRefresh();
    bedsRefresh();
    agRefresh();
    svcRefresh();
    trRefresh();
    runnerRefresh();
  }

  function loadAndRefresh() {
    chrome.storage.local.get(["modulePackageCreator", "extensionEnabled", SETTINGS_KEY], (res) => {
      settings = { ...DEFAULTS, ...(res[SETTINGS_KEY] || {}) };
      moduleEnabled = res.extensionEnabled !== false && !!res.modulePackageCreator && premiumOK();
      refreshAll();
    });
  }
  loadAndRefresh();
  refreshTheme();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.modulePackageCreator || changes.extensionEnabled || changes[SETTINGS_KEY]) loadAndRefresh();
    if (changes.uiTheme) refreshTheme();
  });
  window.NkLicense && window.NkLicense.onPremiumChange(loadAndRefresh);

  // SPA route changes (shared route-watcher event) — re-evaluate the
  // URL-scoped pieces, and re-expand accordions after the new page settles
  // (the original only did this on full page loads; the runner's full
  // reloads between packages behave the same either way).
  window.addEventListener("nusuk-route-change", () => {
    groundRefresh();
    refreshPanelVisibility();
    if (moduleEnabled && settings.autoFillEnabled) setTimeout(expandAccordions, 1000);
  });
})();
