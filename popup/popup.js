document.addEventListener("DOMContentLoaded", () => {

  // ── Theme ───────────────────────────────────────────────────
  const THEME_KEY = "uiTheme";
  const themeButtons = {
    system: document.getElementById("theme-system"),
    light:  document.getElementById("theme-light"),
    dark:   document.getElementById("theme-dark"),
  };

  function applyTheme(preference) {
    const isDark = preference === "dark" ||
      (preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
    Object.entries(themeButtons).forEach(([key, btn]) =>
      btn.classList.toggle("active", key === preference));
  }

  chrome.storage.local.get([THEME_KEY], (res) => applyTheme(res[THEME_KEY] || "system"));
  Object.entries(themeButtons).forEach(([key, btn]) => {
    btn.addEventListener("click", () => {
      chrome.storage.local.set({ [THEME_KEY]: key });
      applyTheme(key);
    });
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    chrome.storage.local.get([THEME_KEY], (res) => {
      if ((res[THEME_KEY] || "system") === "system") applyTheme("system");
    });
  });


  // ── Master Toggle ───────────────────────────────────────────
  const masterEl     = document.getElementById("toggle-master");
  const masterStatus = document.getElementById("master-status");

  function applyMasterState(enabled) {
    masterStatus.textContent = enabled ? "On" : "Off";
    masterStatus.classList.toggle("off", !enabled);
    document.body.classList.toggle("ext-disabled", !enabled);
  }

  chrome.storage.local.get(["extensionEnabled"], (res) => {
    const enabled = res.extensionEnabled !== false;
    masterEl.checked = enabled;
    applyMasterState(enabled);
  });

  masterEl.addEventListener("change", () => {
    chrome.storage.local.set({ extensionEnabled: masterEl.checked });
    applyMasterState(masterEl.checked);
  });


  // ── Module Toggles ──────────────────────────────────────────
  const toggles = [
    { id: "toggle-reload",     key: "moduleReload"         },
    { id: "toggle-overlay",    key: "moduleDisableOverlay" },
    { id: "toggle-autofill",   key: "moduleAutofill"       },
    { id: "toggle-translate",  key: "moduleTranslate"      },
    { id: "toggle-issue-date", key: "moduleIssueDateCalc"  },
    { id: "toggle-vaccine",    key: "moduleVaccineUpload"  },
  ];

  const embassyMirror = document.getElementById("toggle-autofill-embassy");

  toggles.forEach(({ id, key }) => {
    const el = document.getElementById(id);
    if (!el) return;
    chrome.storage.local.get([key], (res) => {
      el.checked = !!res[key];
      if (id === "toggle-autofill" && embassyMirror) embassyMirror.checked = !!res[key];
    });
    el.addEventListener("change", () => {
      chrome.storage.local.set({ [key]: el.checked });
      if (id === "toggle-autofill" && embassyMirror) embassyMirror.checked = el.checked;
    });
  });


  // ── Reload Interval ─────────────────────────────────────────
  const reloadInput = document.getElementById("reload-time");
  if (reloadInput) {
    chrome.storage.local.get(["reloadInterval"], (res) => {
      reloadInput.value = res.reloadInterval || 1.5;
    });
    reloadInput.addEventListener("change", (e) => {
      let val = parseFloat(e.target.value);
      if (!Number.isFinite(val) || val < 0.5) val = 0.5;
      e.target.value = val;
      chrome.storage.local.set({ reloadInterval: val });
    });
  }


  // ── Other Autofill Fields ───────────────────────────────────
  [
    { id: "field-mobile",     key: "mobile"        },
    { id: "field-city",       key: "issueCityName" },
    { id: "field-profession", key: "profession"    },
  ].forEach(({ id, key }) => {
    const el = document.getElementById(id);
    if (!el) return;
    chrome.storage.local.get([key], (res) => { el.value = res[key] || ""; });
    el.addEventListener("input", () => chrome.storage.local.set({ [key]: el.value }));
  });


  // ── Toast helper ────────────────────────────────────────────
  function showToast(msg) {
    document.querySelectorAll(".nk-toast").forEach(t => t.remove());
    const t = document.createElement("div");
    t.className = "nk-toast";
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add("nk-toast-in"));
    setTimeout(() => { t.classList.remove("nk-toast-in"); setTimeout(() => t.remove(), 300); }, 2200);
  }

  // ══════════════════════════════════════════════════════════
  // ── EMAIL MANAGER ─────────────────────────────────────────
  // ══════════════════════════════════════════════════════════

  const emailSearch   = document.getElementById("email-search");
  const emailDropdown = document.getElementById("email-dropdown");
  const activeBadge   = document.getElementById("active-email-badge");
  const activeLabel   = document.getElementById("active-email-label");
  const activeVal     = document.getElementById("active-email-val");
  const addTrigger    = document.getElementById("add-email-trigger");
  const addRow        = document.getElementById("add-email-row");
  const newLabel      = document.getElementById("new-email-label");
  const newVal        = document.getElementById("new-email-val");
  const aeSave        = document.getElementById("ae-save");
  const aeCancel      = document.getElementById("ae-cancel");

  let emailList     = [];
  let activeEmailId = null;
  let editingId     = null;

  function saveEmails() {
    chrome.storage.local.set({ emailList, activeEmailId });
    const active = emailList.find(e => e.id === activeEmailId);
    if (active) chrome.storage.local.set({ email: active.email });
  }

  function renderBadge() {
    const active = emailList.find(e => e.id === activeEmailId);
    if (active) {
      activeLabel.textContent = active.label || "—";
      activeVal.textContent   = active.email;
      activeBadge.style.display = "flex";
    } else {
      activeBadge.style.display = "none";
    }
  }

  function renderDropdown(filter = "") {
    emailDropdown.innerHTML = "";
    highlightedIdx = -1;
    const q = filter.toLowerCase();
    const matches = q
      ? emailList.filter(e => e.label.toLowerCase().includes(q) || e.email.toLowerCase().includes(q))
      : emailList;

    if (!matches.length) {
      const empty = document.createElement("div");
      empty.style.cssText = "padding:10px;text-align:center;font-size:12px;color:var(--text-sub);";
      empty.textContent = emailList.length ? "No match" : "No saved emails yet";
      emailDropdown.appendChild(empty);
      emailDropdown.classList.add("open");
      return;
    }

    matches.forEach(entry => {
      const row = document.createElement("div");
      row.className = "dd-item" + (entry.id === activeEmailId ? " active-dd" : "");

      if (editingId === entry.id) {
        // Inline edit mode
        row.innerHTML = `
          <input class="dd-edit-input" id="edit-lbl" value="${entry.label}" placeholder="Label" style="width:70px;flex-shrink:0;" />
          <input class="dd-edit-input" id="edit-eml" value="${entry.email}" placeholder="email" type="email" style="flex:1;" />
          <div class="dd-actions">
            <button class="dd-btn" id="edit-ok" title="Save">✓</button>
            <button class="dd-btn dd-del" id="edit-x" title="Cancel">✕</button>
          </div>`;

        row.querySelector("#edit-ok").addEventListener("click", (e) => {
          e.stopPropagation();
          const lv = row.querySelector("#edit-lbl").value.trim();
          const ev = row.querySelector("#edit-eml").value.trim();
          if (!ev) return;
          const idx = emailList.findIndex(en => en.id === entry.id);
          if (idx > -1) { emailList[idx].label = lv; emailList[idx].email = ev; }
          editingId = null;
          saveEmails(); renderBadge(); renderDropdown(emailSearch.value);
        });

        row.querySelector("#edit-x").addEventListener("click", (e) => {
          e.stopPropagation();
          editingId = null;
          renderDropdown(emailSearch.value);
        });

        // stop clicks inside edit row from selecting
        row.addEventListener("click", e => e.stopPropagation());
      } else {
        row.innerHTML = `
          <span class="dd-label">${entry.label || "—"}</span>
          <span class="dd-email">${entry.email}</span>
          ${entry.id === activeEmailId ? '<span class="dd-check">✓</span>' : ""}
          <div class="dd-actions">
            <button class="dd-btn dd-edit-btn" title="Edit">✎</button>
            <button class="dd-btn dd-del" title="Delete">✕</button>
          </div>`;

        // Select on row click (not action buttons)
        row.addEventListener("click", (e) => {
          if (e.target.closest(".dd-actions")) return;
          activeEmailId = entry.id;
          emailSearch.value = "";
          emailDropdown.classList.remove("open");
          saveEmails(); renderBadge();
        });

        row.querySelector(".dd-edit-btn").addEventListener("click", (e) => {
          e.stopPropagation();
          editingId = entry.id;
          renderDropdown(emailSearch.value);
        });

        row.querySelector(".dd-del").addEventListener("click", (e) => {
          e.stopPropagation();
          emailList = emailList.filter(en => en.id !== entry.id);
          if (activeEmailId === entry.id) activeEmailId = emailList[0]?.id ?? null;
          saveEmails(); renderBadge(); renderDropdown(emailSearch.value);
        });
      }

      emailDropdown.appendChild(row);
    });

    emailDropdown.classList.add("open");
  }

  // Open dropdown on focus/click
  emailSearch.addEventListener("focus", () => renderDropdown(emailSearch.value));
  emailSearch.addEventListener("input", () => renderDropdown(emailSearch.value));

  // Keyboard navigation
  let highlightedIdx = -1;

  function getItems() {
    return [...emailDropdown.querySelectorAll(".dd-item:not([data-editing])")];
  }

  function setHighlight(idx) {
    const items = getItems();
    items.forEach(i => i.classList.remove("dd-highlighted"));
    if (idx >= 0 && idx < items.length) {
      highlightedIdx = idx;
      items[idx].classList.add("dd-highlighted");
      items[idx].scrollIntoView({ block: "nearest" });
    }
  }

  emailSearch.addEventListener("keydown", (e) => {
    const items = getItems();
    if (!emailDropdown.classList.contains("open")) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        renderDropdown(emailSearch.value);
        highlightedIdx = -1;
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight(Math.min(highlightedIdx + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight(Math.max(highlightedIdx - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlightedIdx >= 0 && items[highlightedIdx]) {
        items[highlightedIdx].click();
      }
    } else if (e.key === "Escape") {
      emailDropdown.classList.remove("open");
      highlightedIdx = -1;
    }
  });

  // Reset highlight when dropdown re-renders

  // Close on outside click
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".email-active-row")) {
      emailDropdown.classList.remove("open");
      editingId = null;
    }
  });

  // Add new email
  addTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    emailDropdown.classList.remove("open");
    addRow.style.display = addRow.style.display === "none" ? "block" : "none";
    if (addRow.style.display === "block") {
      newLabel.value = ""; newVal.value = ""; newLabel.focus();
    }
  });

  aeCancel.addEventListener("click", () => { addRow.style.display = "none"; });

  aeSave.addEventListener("click", () => {
    const lv = newLabel.value.trim();
    const ev = newVal.value.trim();
    if (!ev) { newVal.style.borderColor = "var(--overlay-fg)"; return; }
    newVal.style.borderColor = "";
    const id = "em_" + Date.now();
    emailList.push({ id, label: lv || "Email " + (emailList.length + 1), email: ev });
    activeEmailId = id; // always make new email the active one
    saveEmails(); renderBadge();
    addRow.style.display = "none";
    newLabel.value = ""; newVal.value = "";
    showToast("✓ Email saved & set as active");
  });

  // ── Export CSV ──────────────────────────────────────────────
  document.getElementById("export-emails").addEventListener("click", () => {
    if (!emailList.length) { showToast("No emails to export"); return; }
    const rows = [["Label", "Email"], ...emailList.map(e => [e.label, e.email])];
    const csv  = rows.map(r => r.map(v => `"${v.replace(/"/g,'""')}"`).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement("a"), {
      href: url, download: "nuskomate-emails.csv"
    });
    a.click();
    URL.revokeObjectURL(url);
    showToast("✓ Emails exported");
  });

  // ── Import CSV ──────────────────────────────────────────────
  document.getElementById("import-emails").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const lines = ev.target.result.split(/\r?\n/).filter(l => l.trim());
      let added = 0, skipped = 0;
      lines.forEach((line, i) => {
        if (i === 0 && line.toLowerCase().includes("label")) return; // skip header
        const [rawLabel, rawEmail] = line.split(",").map(v => v.replace(/^"|"$/g,"").trim());
        const email = rawEmail || rawLabel; // handle single-column CSVs
        if (!email || !email.includes("@")) { skipped++; return; }
        const label = rawEmail ? rawLabel : "Imported";
        const already = emailList.some(en => en.email === email);
        if (already) { skipped++; return; }
        emailList.push({ id: "em_" + Date.now() + "_" + i, label, email });
        added++;
      });
      if (!activeEmailId && emailList.length) activeEmailId = emailList[0].id;
      saveEmails(); renderBadge(); renderDropdown();
      showToast(`✓ ${added} imported${skipped ? `, ${skipped} skipped` : ""}`);
      e.target.value = ""; // reset so same file can be re-imported
    };
    reader.readAsText(file);
  });
  chrome.storage.local.get(["emailList", "activeEmailId"], (res) => {
    emailList     = res.emailList || [];
    activeEmailId = res.activeEmailId || (emailList[0]?.id ?? null);

    if (!emailList.length) {
      chrome.storage.local.get(["email"], (r) => {
        if (r.email) {
          const id = "em_legacy";
          emailList = [{ id, label: "Default", email: r.email }];
          activeEmailId = id;
          saveEmails();
        }
        renderBadge();
      });
    } else {
      renderBadge();
    }
  });

});
