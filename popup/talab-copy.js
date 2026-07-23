// Talab Copy — settings panel: per-element include/exclude toggles for each
// of the 4 copy formats (modules/talab-copy.js reads the same storage key).
// Unticking one just means "leave this out of that page's copied text from
// now on" — the rest of that format is unaffected. Each group also gets a
// "select all in this group" header checkbox, same behavior as the Keys
// admin tool checklist (.k-tools/.k-group/.k-check) this reuses styling from.
document.addEventListener("DOMContentLoaded", () => {
  const moduleExtra = document.getElementById("talabcopy-module-extra");
  if (!moduleExtra) return;

  const KEY = "talabCopyFields";
  const HOTKEY_KEY = "talabCopyHotkey";
  const DEFAULT_HOTKEY = "Alt+Shift+C";
  const infoBtn = document.getElementById("talabcopy-info-btn");
  const infoPanel = document.getElementById("talabcopy-info-panel");
  const settingsBtn = document.getElementById("talabcopy-settings-btn");
  const hotkeyRow = document.getElementById("talabcopy-hotkey-row");

  if (infoBtn && infoPanel) {
    infoBtn.addEventListener("click", () => {
      const open = infoPanel.style.display !== "none";
      infoPanel.style.display = open ? "none" : "";
      infoBtn.classList.toggle("info-btn-open", !open);
    });
  }
  if (settingsBtn && moduleExtra) {
    settingsBtn.addEventListener("click", () => {
      const open = moduleExtra.style.display !== "none";
      moduleExtra.style.display = open ? "none" : "";
      settingsBtn.classList.toggle("module-gear-open", !open);
    });
  }

  // Same recorder pattern as BRN Request's hotkey field — click, press a
  // combo (must include Ctrl/Alt/Cmd), Backspace/Delete resets to default.
  function buildHotkeyRecorder(currentValue, onSet) {
    const hk = document.createElement("input");
    hk.type = "text";
    hk.readOnly = true;
    hk.className = "field-input";
    hk.value = currentValue || "";
    hk.placeholder = "Click, then press keys… (e.g. Alt+Shift+C)";
    hk.title = "Press the combo you want (must include Ctrl, Alt or Cmd). Backspace resets to default.";
    hk.addEventListener("focus", () => { if (!hk.value) hk.placeholder = "Press keys now… (Ctrl/Alt + key)"; });
    hk.addEventListener("blur", () => { hk.placeholder = "Click, then press keys… (e.g. Alt+Shift+C)"; });
    hk.addEventListener("keydown", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { hk.blur(); return; }
      if (e.key === "Backspace" || e.key === "Delete") { hk.value = DEFAULT_HOTKEY; onSet(DEFAULT_HOTKEY); return; }
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

  const groups = [...moduleExtra.querySelectorAll(".k-group")];
  const fieldBoxes = [...moduleExtra.querySelectorAll(".talabcopy-field")];

  function saveField(field, checked) {
    chrome.storage.local.get([KEY], (res) => {
      const fields = { ...(res[KEY] || {}) };
      fields[field] = checked;
      chrome.storage.local.set({ [KEY]: fields });
    });
  }

  // Header ⇄ children sync — header click sets every field in that group;
  // any child change updates the header (checked = all on, unchecked = none,
  // indeterminate = some).
  function refreshGroupHead(group) {
    const head = group.querySelector(".talabcopy-group-all");
    const kids = [...group.querySelectorAll(".talabcopy-field")];
    const on = kids.filter((k) => k.checked).length;
    head.checked = on === kids.length && kids.length > 0;
    head.indeterminate = on > 0 && on < kids.length;
  }

  groups.forEach((group) => {
    const head = group.querySelector(".talabcopy-group-all");
    head.addEventListener("change", () => {
      group.querySelectorAll(".talabcopy-field").forEach((k) => {
        k.checked = head.checked;
        saveField(k.dataset.field, k.checked);
      });
      refreshGroupHead(group);
    });
  });

  fieldBoxes.forEach((cb) => {
    cb.addEventListener("change", () => {
      saveField(cb.dataset.field, cb.checked);
      const group = cb.closest(".k-group");
      if (group) refreshGroupHead(group);
    });
  });

  chrome.storage.local.get([KEY], (res) => {
    const fields = res[KEY] || {};
    fieldBoxes.forEach((cb) => { cb.checked = fields[cb.dataset.field] !== false; });
    groups.forEach(refreshGroupHead);
  });
});
