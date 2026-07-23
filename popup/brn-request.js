// BRN Request tab — hotkey config + hotel list (view/rename/delete + bulk
// JSON edit). The floating search bar, date parsing, agreement autofill and
// auto-capture itself all run in modules/brn-request.js on the page; this
// tab only manages the shared storage (hotel list + hotkey) they read from.
document.addEventListener("DOMContentLoaded", () => {
  const listEl = document.getElementById("brn-list");
  if (!listEl) return;

  const LIST_KEY = "brnHotelList";
  const HOTKEY_KEY = "brnHotkey";
  const SEARCH_KEY = "brnSearch";
  const PRICE_KEY = "brnDefaultPrice";
  const NIGHTS_KEY = "brnDefaultNights";
  const DEFAULT_HOTKEY = "Alt+H";
  const DEFAULT_PRICE = "1";
  const DEFAULT_NIGHTS = 3;

  const countEl = document.getElementById("brn-count");
  const searchEl = document.getElementById("brn-search");
  const bulkToggleBtn = document.getElementById("brn-bulk-toggle");
  const bulkSection = document.getElementById("brn-bulk-section");
  const bulkTextarea = document.getElementById("brn-bulk-textarea");
  const bulkCountEl = document.getElementById("brn-bulk-count");
  const bulkErrorEl = document.getElementById("brn-bulk-error");
  const bulkSaveBtn = document.getElementById("brn-bulk-save");
  const bulkCancelBtn = document.getElementById("brn-bulk-cancel");
  const hotkeyRow = document.getElementById("brn-hotkey-row");
  const priceInput = document.getElementById("brn-default-price");
  const nightsInput = document.getElementById("brn-default-nights");
  const infoBtn = document.getElementById("brn-info-btn");
  const infoPanel = document.getElementById("brn-info-panel");

  if (infoBtn && infoPanel) {
    infoBtn.addEventListener("click", () => {
      const open = infoPanel.style.display !== "none";
      infoPanel.style.display = open ? "none" : "";
      infoBtn.classList.toggle("info-btn-open", !open);
    });
  }

  // ── Icon-only row buttons — same visual language as Keys admin's list ──
  const ICON = {
    copy:  '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    edit:  '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  };
  const iconSvg = (name) => `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">${ICON[name] || ""}</svg>`;
  function iconBtn(name, title, fn, danger) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "k-mini k-icon-btn" + (danger ? " k-mini-danger" : "");
    b.innerHTML = iconSvg(name);
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("click", fn);
    return b;
  }
  function copyBtn(name, id) {
    const b = iconBtn("copy", "Copy hotel name + ID", () => {
      const text = `Hotel: ${name}\nNusuk URL ID: ${id}`;
      navigator.clipboard.writeText(text).then(() => {
        b.innerHTML = iconSvg("check");
        b.classList.add("k-copy-done");
        setTimeout(() => { b.innerHTML = iconSvg("copy"); b.classList.remove("k-copy-done"); }, 1200);
      }).catch(() => {});
    });
    return b;
  }

  // ── Hotkey recorder — click the box, press the combo (must include
  // Ctrl/Alt/Meta). Same widget/behavior as the Auto Clicker rule/workflow
  // hotkeys, duplicated here since this tab is a separate script file. ──
  function buildHotkeyRecorder(currentValue, onSet) {
    const hk = document.createElement("input");
    hk.type = "text";
    hk.readOnly = true;
    hk.className = "field-input";
    hk.value = currentValue || "";
    hk.placeholder = "Click, then press keys… (e.g. Alt+H)";
    hk.title = "Press the combo you want (must include Ctrl, Alt or Cmd). Backspace clears.";
    hk.addEventListener("focus", () => { if (!hk.value) hk.placeholder = "Press keys now… (Ctrl/Alt + key)"; });
    hk.addEventListener("blur", () => { hk.placeholder = "Click, then press keys… (e.g. Alt+H)"; });
    hk.addEventListener("keydown", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { hk.blur(); return; }
      if (e.key === "Backspace" || e.key === "Delete") { hk.value = ""; onSet(DEFAULT_HOTKEY); return; }
      if (["Alt", "Control", "Shift", "Meta"].includes(e.key)) return;
      if (!e.ctrlKey && !e.altKey && !e.metaKey) { hk.value = "add Ctrl or Alt…"; return; }
      const parts = [];
      if (e.ctrlKey) parts.push("Ctrl"); if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift"); if (e.metaKey) parts.push("Meta");
      parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
      const combo = parts.join("+");
      hk.value = combo;
      onSet(combo);
    });
    return hk;
  }

  if (hotkeyRow) {
    chrome.storage.local.get([HOTKEY_KEY], (res) => {
      const hk = buildHotkeyRecorder(res[HOTKEY_KEY] || DEFAULT_HOTKEY, (v) => {
        chrome.storage.local.set({ [HOTKEY_KEY]: v || DEFAULT_HOTKEY });
      });
      hotkeyRow.appendChild(hk);
    });
  }

  if (priceInput || nightsInput) {
    chrome.storage.local.get([PRICE_KEY, NIGHTS_KEY], (res) => {
      if (priceInput) priceInput.value = res[PRICE_KEY] || DEFAULT_PRICE;
      if (nightsInput) nightsInput.value = res[NIGHTS_KEY] || DEFAULT_NIGHTS;
    });
    if (priceInput) priceInput.addEventListener("change", (e) => {
      chrome.storage.local.set({ [PRICE_KEY]: e.target.value.trim() || DEFAULT_PRICE });
    });
    if (nightsInput) nightsInput.addEventListener("change", (e) => {
      const n = Math.max(1, Number(e.target.value) || DEFAULT_NIGHTS);
      nightsInput.value = n;
      chrome.storage.local.set({ [NIGHTS_KEY]: n });
    });
  }

  // ── Hotel list ───────────────────────────────────────────────────────
  let hotels = {};   // { name: id }
  let search = "";
  let editingName = null; // hotel name currently shown as an inline edit form (null = none)

  function saveHotels(next, cb) {
    hotels = next;
    chrome.storage.local.set({ [LIST_KEY]: next }, cb);
  }

  // Renames AND/OR re-IDs a hotel in place. Bails out (via onError) instead
  // of silently reverting so the inline form can show what's wrong.
  function updateHotel(oldName, newName, newId, onError) {
    newName = newName.trim();
    if (!newName) { onError("Hotel name can't be empty."); return false; }
    const idNum = parseInt(newId, 10);
    if (isNaN(idNum)) { onError("Hotel ID must be a number."); return false; }
    if (newName !== oldName && hotels[newName] != null) { onError(`"${newName}" already exists in the list.`); return false; }
    const next = { ...hotels };
    if (newName !== oldName) delete next[oldName];
    next[newName] = idNum;
    saveHotels(next, () => { editingName = null; render(); });
    return true;
  }

  function deleteHotel(name) {
    if (!confirm(`Remove "${name}" from the hotel list?`)) return;
    const next = { ...hotels };
    delete next[name];
    saveHotels(next, render);
  }

  function matches(name, id) {
    if (!search) return true;
    return name.toLowerCase().includes(search) || String(id).includes(search);
  }

  function render() {
    const names = Object.keys(hotels).sort((a, b) => a.localeCompare(b));
    const shown = names.filter((n) => matches(n, hotels[n]));
    if (countEl) countEl.textContent = `(${names.length})`;

    listEl.textContent = "";
    if (!names.length) {
      const e = document.createElement("div"); e.className = "logs-empty";
      e.textContent = "No hotels captured yet — visit any hotel's page on Masar once to capture it automatically.";
      listEl.appendChild(e); return;
    }
    if (!shown.length) {
      const e = document.createElement("div"); e.className = "logs-empty";
      e.textContent = "No hotels match your search.";
      listEl.appendChild(e); return;
    }

    shown.forEach((name) => {
      const id = hotels[name];
      const item = document.createElement("div"); item.className = "k-item";

      // ── Inline edit mode: the row's own name/ID text becomes small
      // editable fields right where they already sit — no separate box, no
      // Save/Cancel buttons. Enter saves, Esc cancels, click-away cancels —
      // same compact pattern as the email list / Totals URL list / rule names. ──
      if (name === editingName) {
        item.classList.add("k-item-editing");
        const main = document.createElement("div"); main.className = "k-item-main";

        const nameInp = document.createElement("input");
        nameInp.type = "text"; nameInp.className = "inline-text-input";
        nameInp.value = name; nameInp.placeholder = "Hotel name";
        nameInp.title = "Enter to save · Esc to cancel";

        const idInp = document.createElement("input");
        idInp.type = "text"; idInp.className = "inline-text-input";
        idInp.value = id; idInp.placeholder = "Hotel ID";
        idInp.title = "Enter to save · Esc to cancel";

        const errEl = document.createElement("div"); errEl.className = "inline-edit-error";

        const doSave = () => {
          updateHotel(name, nameInp.value, idInp.value, (msg) => {
            nameInp.classList.add("email-input-error");
            errEl.textContent = msg;
            errEl.style.display = "";
          });
        };
        const doCancel = () => { editingName = null; render(); };

        [nameInp, idInp].forEach((inp) => {
          inp.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); doSave(); }
            if (e.key === "Escape") { e.preventDefault(); doCancel(); }
          });
          inp.addEventListener("input", () => {
            nameInp.classList.remove("email-input-error");
            errEl.style.display = "none";
          });
        });

        item.addEventListener("focusout", () => {
          setTimeout(() => { if (editingName === name && !item.contains(document.activeElement)) doCancel(); }, 0);
        });

        main.append(nameInp, idInp, errEl);
        item.append(main);
        listEl.appendChild(item);
        nameInp.focus();
        nameInp.select();
        return;
      }

      const main = document.createElement("div"); main.className = "k-item-main";
      const nameEl = document.createElement("div"); nameEl.className = "k-item-name"; nameEl.textContent = name;
      const meta = document.createElement("div"); meta.className = "k-item-meta"; meta.textContent = `ID: ${id}`;
      main.append(nameEl, meta);

      const btns = document.createElement("div"); btns.className = "k-item-btns";
      btns.append(
        copyBtn(name, id),
        iconBtn("edit", "Edit", () => { editingName = name; render(); }),
        iconBtn("trash", "Delete", () => deleteHotel(name), true),
      );

      item.append(main, btns);
      listEl.appendChild(item);
    });
  }

  if (searchEl) {
    chrome.storage.local.get([SEARCH_KEY], (res) => {
      search = (res[SEARCH_KEY] || "").trim().toLowerCase();
      searchEl.value = res[SEARCH_KEY] || "";
      render();
    });
    searchEl.addEventListener("input", (e) => {
      search = e.target.value.trim().toLowerCase();
      chrome.storage.local.set({ [SEARCH_KEY]: e.target.value });
      render();
    });
  }

  chrome.storage.local.get([LIST_KEY], (res) => {
    hotels = res[LIST_KEY] || {};
    render();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[LIST_KEY]) { hotels = changes[LIST_KEY].newValue || {}; render(); }
  });

  // ── Bulk edit (JSON) — same power-editing capability as the original
  // Tampermonkey script's on-page modal, just relocated into this tab. ──
  function updateBulkCount() {
    try {
      const parsed = JSON.parse(bulkTextarea.value);
      const n = Object.keys(parsed).length;
      bulkCountEl.textContent = `${n} hotel${n !== 1 ? "s" : ""}`;
      bulkErrorEl.style.display = "none";
    } catch (_) {
      bulkCountEl.textContent = "";
      bulkErrorEl.textContent = "⚠ Invalid JSON";
      bulkErrorEl.style.display = "";
    }
  }

  if (bulkToggleBtn) {
    bulkToggleBtn.addEventListener("click", () => {
      const opening = bulkSection.style.display === "none";
      if (opening) {
        bulkTextarea.value = JSON.stringify(hotels, null, 2);
        updateBulkCount();
        bulkSection.style.display = "";
        bulkToggleBtn.classList.add("ac-icon-btn-primary");
      } else {
        bulkSection.style.display = "none";
        bulkToggleBtn.classList.remove("ac-icon-btn-primary");
      }
    });
  }
  if (bulkTextarea) bulkTextarea.addEventListener("input", updateBulkCount);
  if (bulkCancelBtn) bulkCancelBtn.addEventListener("click", () => {
    bulkSection.style.display = "none";
    bulkToggleBtn.classList.remove("ac-icon-btn-primary");
  });
  if (bulkSaveBtn) bulkSaveBtn.addEventListener("click", () => {
    try {
      const parsed = JSON.parse(bulkTextarea.value);
      saveHotels(parsed, () => {
        render();
        bulkSection.style.display = "none";
        bulkToggleBtn.classList.remove("ac-icon-btn-primary");
      });
    } catch (_) {
      bulkErrorEl.textContent = "❌ Invalid JSON — fix errors before saving.";
      bulkErrorEl.style.display = "";
    }
  });
});
