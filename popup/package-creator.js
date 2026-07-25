// Package Creator tab — each helper's sub-toggle plus, behind that
// helper's own gear, the settings only it uses (prices + beds, ground
// match words, transport vehicle details, agent companies). All of it
// lives in ONE storage object (pkgCreatorSettings) that
// modules/package-creator.js reads on the page. The module master toggle
// (modulePackageCreator) is wired in popup.js's shared toggles array like
// every other tab's, not here.
document.addEventListener("DOMContentLoaded", () => {
  const content = document.getElementById("pc-content");
  if (!content) return;

  const KEY = "pkgCreatorSettings";
  const GEAR_OPEN_KEY = "moduleGearOpen"; // shared with every other module gear
  const DEFAULT_FLIGHT_HOTKEY = "Alt+Shift+F";

  const infoBtn = document.getElementById("pc-info-btn");
  const infoPanel = document.getElementById("pc-info-panel");
  if (infoBtn && infoPanel) {
    infoBtn.addEventListener("click", () => {
      const open = infoPanel.style.display !== "none";
      infoPanel.style.display = open ? "none" : "";
      infoBtn.classList.toggle("info-btn-open", !open);
    });
  }

  // Gear → its settings panel. Open/closed is remembered per gear in the
  // same shared map the Totals and Copy cards use.
  [
    ["pc-ground-gear", "pc-ground-extra"],
    ["pc-flight-gear", "pc-flight-extra"],
    ["pc-prices-gear", "pc-prices-extra"],
    ["pc-services-gear", "pc-services-extra"],
    ["pc-transport-gear", "pc-transport-extra"],
    ["pc-agents-gear", "pc-agents-extra"],
  ].forEach(([btnId, extraId]) => {
    const btn = document.getElementById(btnId);
    const extra = document.getElementById(extraId);
    if (!btn || !extra) return;
    const setOpen = (open) => {
      extra.style.display = open ? "" : "none";
      btn.classList.toggle("module-gear-open", open);
    };
    chrome.storage.local.get([GEAR_OPEN_KEY], (res) => setOpen(!!(res[GEAR_OPEN_KEY] || {})[btnId]));
    btn.addEventListener("click", () => {
      const open = extra.style.display === "none";
      setOpen(open);
      chrome.storage.local.get([GEAR_OPEN_KEY], (res) => {
        const all = { ...(res[GEAR_OPEN_KEY] || {}) };
        all[btnId] = open;
        chrome.storage.local.set({ [GEAR_OPEN_KEY]: all });
      });
    });
  });

  const TOGGLES = {
    "pc-runner": "runnerEnabled",
    "pc-autofill": "autoFillEnabled",
    "pc-ground": "groundServiceEnabled",
    "pc-singleflight": "singleFlightEnabled",
    "pc-beds": "bedsEnabled",
    "pc-agents": "agentsEnabled",
    "pc-transport": "transportEnabled",
    "pc-services": "servicesEnabled",
    "pc-enrichment-autodate": "enrichmentAutoDate",
  };
  const FIELDS = {
    "pc-ground-bp": "ground_bp",
    "pc-ground-pm": "ground_pm",
    "pc-hotel-mode": "hotel_bp_mode",
    "pc-hotel-bp-static": "hotel_bp_static",
    "pc-hotel-bp-rate": "hotel_bp_rate",
    "pc-hotel-pm": "hotel_pm",
    "pc-enrichment-bp": "enrichment_bp",
    "pc-enrichment-pm": "enrichment_pm",
    "pc-additional-bp": "additional_bp",
    "pc-additional-pm": "additional_pm",
    "pc-beds-value": "bedsValue",
    "pc-transport-cost": "transportPageCost",
    "pc-transport-profit": "transportPageProfit",
    "pc-service-text": "additionalServiceText",
  };

  const DEFAULTS = {
    runnerEnabled: true, autoFillEnabled: true, groundServiceEnabled: true,
    singleFlightEnabled: true, bedsEnabled: true, agentsEnabled: true,
    transportEnabled: true, servicesEnabled: true,
    ground_bp: "1", ground_pm: "1",
    hotel_bp_mode: "static", hotel_bp_static: "1", hotel_bp_rate: "100", hotel_pm: "1",
    enrichment_bp: "1", enrichment_pm: "1",
    additional_bp: "1", additional_pm: "1",
    bedsValue: "10000",
    transportPageCost: "10",
    transportPageProfit: "1",
    flightHotkey: DEFAULT_FLIGHT_HOTKEY,
    additionalServiceText: "ZIARAT",
    enrichmentAutoDate: true,
    enrichmentDestinations: [],
    groundServiceWords: [
      { text: "Nebras Al Fawz", enabled: true },
      { text: "PAKISTAN", enabled: true },
      { text: "Ground services", enabled: true },
    ],
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

  // These two lists used to be plain string arrays (a textarea, one per
  // line). They're {text, enabled} rows now so each entry has its own
  // switch — old saved arrays still read fine and get upgraded on the
  // next write.
  function normList(arr) {
    return (Array.isArray(arr) ? arr : [])
      .map((x) => (typeof x === "string"
        ? { text: x.trim(), enabled: true }
        : { text: String(x && x.text || "").trim(), enabled: !(x && x.enabled === false) }))
      .filter((x) => x.text);
  }

  // Single get-then-set per save (never per-field parallel writes — the
  // Copy tool's settings had exactly that race and fields silently
  // reverted; see popup/talab-copy.js's saveFields).
  function save(patch) {
    chrome.storage.local.get([KEY], (res) => {
      const next = { ...DEFAULTS, ...(res[KEY] || {}), ...patch };
      chrome.storage.local.set({ [KEY]: next });
    });
  }

  const ICON_TRASH = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

  // One checklist (match words / agent companies). Rendered from the
  // stored rows; every change writes the whole list back at once.
  function makeList({ listId, countId, inputId, addBtnId, settingsKey, emptyText, placeholderDupMsg }) {
    const listEl = document.getElementById(listId);
    const countEl = document.getElementById(countId);
    const inputEl = document.getElementById(inputId);
    const addBtn = document.getElementById(addBtnId);
    if (!listEl) return { render: () => {} };

    let rows = [];

    function persist() {
      save({ [settingsKey]: rows });
      render();
    }

    function render() {
      listEl.textContent = "";
      if (countEl) countEl.textContent = `(${rows.filter((r) => r.enabled).length}/${rows.length})`;

      if (!rows.length) {
        const empty = document.createElement("div");
        empty.className = "pc-list-empty";
        empty.textContent = emptyText;
        listEl.appendChild(empty);
        return;
      }

      rows.forEach((row, i) => {
        const label = document.createElement("label");
        label.className = "pc-chk";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = row.enabled;
        cb.addEventListener("change", () => { rows[i].enabled = cb.checked; persist(); });

        const text = document.createElement("span");
        text.className = "pc-chk-text";
        text.textContent = row.text;
        text.title = row.text;

        const del = document.createElement("button");
        del.type = "button";
        del.className = "pc-chk-del";
        del.title = "Remove";
        del.setAttribute("aria-label", "Remove " + row.text);
        del.innerHTML = ICON_TRASH;
        del.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation(); // the row is a <label> — don't toggle the box
          rows.splice(i, 1);
          persist();
        });

        label.append(cb, text, del);
        listEl.appendChild(label);
      });
    }

    function add() {
      const value = (inputEl.value || "").trim();
      if (!value) return;
      if (rows.some((r) => r.text.toLowerCase() === value.toLowerCase())) {
        inputEl.value = "";
        inputEl.placeholder = placeholderDupMsg;
        setTimeout(() => { inputEl.placeholder = inputEl.dataset.ph; }, 1600);
        return;
      }
      rows.push({ text: value, enabled: true });
      inputEl.value = "";
      persist();
    }

    if (inputEl) {
      inputEl.dataset.ph = inputEl.placeholder;
      inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); add(); }
      });
    }
    if (addBtn) addBtn.addEventListener("click", add);

    return {
      render(nextRows) { rows = nextRows; render(); },
    };
  }

  const wordsList = makeList({
    listId: "pc-words-list", countId: "pc-words-count",
    inputId: "pc-word-input", addBtnId: "pc-word-add",
    settingsKey: "groundServiceWords",
    emptyText: "No match words — nothing will be ticked.",
    placeholderDupMsg: "Already in the list",
  });

  const destsList = makeList({
    listId: "pc-dests-list", countId: "pc-dests-count",
    inputId: "pc-dest-input", addBtnId: "pc-dest-add",
    settingsKey: "enrichmentDestinations",
    emptyText: "Empty — no destination will be picked.",
    placeholderDupMsg: "Already in the list",
  });

  const agentsList = makeList({
    listId: "pc-agents-list", countId: "pc-agents-count",
    inputId: "pc-agent-input", addBtnId: "pc-agent-add",
    settingsKey: "agentNames",
    emptyText: "No companies — nothing will be ticked.",
    placeholderDupMsg: "Already in the list",
  });

  // ── Hotkey recorder — click the box, press the combo (must include
  // Ctrl/Alt/Meta). Same widget/behavior as BRN Request's and the Auto
  // Clicker rule hotkeys, duplicated here since this tab is its own
  // script file. ──
  function buildHotkeyRecorder(currentValue, onSet) {
    const hk = document.createElement("input");
    hk.type = "text";
    hk.readOnly = true;
    hk.className = "field-input";
    hk.value = currentValue || "";
    hk.placeholder = "Click, then press keys… (e.g. Alt+Shift+F)";
    hk.title = "Press the combo you want (must include Ctrl, Alt or Cmd). Backspace resets to the default.";
    hk.addEventListener("focus", () => { if (!hk.value) hk.placeholder = "Press keys now… (Ctrl/Alt + key)"; });
    hk.addEventListener("blur", () => { hk.placeholder = "Click, then press keys… (e.g. Alt+Shift+F)"; });
    hk.addEventListener("keydown", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { hk.blur(); return; }
      if (e.key === "Backspace" || e.key === "Delete") {
        hk.value = DEFAULT_FLIGHT_HOTKEY;
        onSet(DEFAULT_FLIGHT_HOTKEY);
        return;
      }
      if (["Alt", "Control", "Shift", "Meta"].includes(e.key)) return;
      if (!e.ctrlKey && !e.altKey && !e.metaKey) { hk.value = "add Ctrl or Alt…"; return; }
      const parts = [];
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      if (e.metaKey) parts.push("Meta");
      parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
      const combo = parts.join("+");
      hk.value = combo;
      onSet(combo);
    });
    return hk;
  }

  const flightHotkeyRow = document.getElementById("pc-flight-hotkey-row");
  let flightHotkeyInput = null;
  if (flightHotkeyRow) {
    flightHotkeyInput = buildHotkeyRecorder("", (v) => save({ flightHotkey: v || DEFAULT_FLIGHT_HOTKEY }));
    flightHotkeyRow.appendChild(flightHotkeyInput);
  }

  function refreshHotelModeRows(mode) {
    const staticWrap = document.getElementById("pc-hotel-static-wrap");
    const rateWrap = document.getElementById("pc-hotel-rate-wrap");
    if (staticWrap) staticWrap.style.display = mode === "calc" ? "none" : "";
    if (rateWrap) rateWrap.style.display = mode === "calc" ? "" : "none";
  }

  function populate(s) {
    Object.entries(TOGGLES).forEach(([id, key]) => {
      const el = document.getElementById(id);
      if (el) el.checked = s[key] !== false;
    });
    Object.entries(FIELDS).forEach(([id, key]) => {
      const el = document.getElementById(id);
      if (el) el.value = s[key] ?? DEFAULTS[key];
    });
    refreshHotelModeRows(s.hotel_bp_mode || "static");
    if (flightHotkeyInput) flightHotkeyInput.value = s.flightHotkey || DEFAULT_FLIGHT_HOTKEY;
    wordsList.render(normList(s.groundServiceWords));
    destsList.render(normList(s.enrichmentDestinations));
    agentsList.render(normList(s.agentNames));
  }

  chrome.storage.local.get([KEY], (res) => populate({ ...DEFAULTS, ...(res[KEY] || {}) }));

  Object.entries(TOGGLES).forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", () => save({ [key]: el.checked }));
  });

  Object.entries(FIELDS).forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", () => {
      save({ [key]: el.value.trim() || DEFAULTS[key] });
      if (id === "pc-hotel-mode") refreshHotelModeRows(el.value);
    });
  });
});
