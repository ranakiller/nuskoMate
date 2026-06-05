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
    { id: "toggle-ocr",       key: "moduleOcr"            },
  ];

  const embassyMirror = document.getElementById("toggle-autofill-embassy");

  // All modules default ON for new installs (key never set = treat as true)
  // — except Issue Date Calc, which defaults OFF.
  const defaultOnKeys = new Set([
    "moduleReload", "moduleDisableOverlay", "moduleAutofill",
    "moduleTranslate", "moduleVaccineUpload", "moduleOcr",
  ]);

  toggles.forEach(({ id, key }) => {
    const el = document.getElementById(id);
    if (!el) return;
    chrome.storage.local.get([key], (res) => {
      const val = key in res ? res[key] : (defaultOnKeys.has(key) ? true : false);
      el.checked = !!val;
      // Persist the default so the content script reads it correctly on next load
      if (!(key in res) && defaultOnKeys.has(key)) chrome.storage.local.set({ [key]: true });
      if (id === "toggle-autofill" && embassyMirror) embassyMirror.checked = !!val;
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
    { id: "field-mobile", key: "mobile"        },
    { id: "field-city",   key: "issueCityName" },
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
  // ── LOGS ──────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════

  const LOGS_KEY    = "nkLogs";
  const logsBox     = document.getElementById("logs-box");
  const logsEmpty   = document.getElementById("logs-empty");
  const logsCount   = document.getElementById("logs-count");
  const logsRefresh = document.getElementById("logs-refresh");
  const logsClear   = document.getElementById("logs-clear");

  function fmtLogTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function renderLogs(logs) {
    logs = Array.isArray(logs) ? logs : [];
    logsCount.textContent = logs.length;

    if (!logs.length) {
      logsBox.innerHTML = '<div class="logs-empty" id="logs-empty">No logs yet</div>';
      return;
    }

    // Newest first
    const frag = document.createDocumentFragment();
    for (let i = logs.length - 1; i >= 0; i--) {
      const entry = logs[i];
      const row = document.createElement("div");
      row.className = "log-row" + (entry.lvl === "warn" ? " log-warn" : entry.lvl === "error" ? " log-error" : "");
      const time = document.createElement("span");
      time.className = "log-time";
      time.textContent = fmtLogTime(entry.t);
      const msg = document.createElement("span");
      msg.className = "log-msg";
      msg.textContent = entry.m;
      row.append(time, msg);
      frag.appendChild(row);
    }
    logsBox.innerHTML = "";
    logsBox.appendChild(frag);
  }

  function loadLogs() {
    chrome.storage.local.get([LOGS_KEY], (res) => renderLogs(res[LOGS_KEY]));
  }

  logsRefresh.addEventListener("click", loadLogs);

  logsClear.addEventListener("click", () => {
    chrome.storage.local.set({ [LOGS_KEY]: [] }, () => {
      renderLogs([]);
      showToast("✓ Logs cleared");
    });
  });

  // Live-update while the popup is open
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[LOGS_KEY]) renderLogs(changes[LOGS_KEY].newValue);
  });

  loadLogs();

  // ══════════════════════════════════════════════════════════
  // ── EMAIL MANAGER ─────────────────────────────────────────
  // ══════════════════════════════════════════════════════════

  const emailInput = document.getElementById("email-input");
  const emailSave  = document.getElementById("email-save");
  const emailListEl = document.getElementById("email-list");

  let emailList     = [];
  let activeEmailId = null;

  function saveEmails() {
    chrome.storage.local.set({ emailList, activeEmailId });
    const active = emailList.find(e => e.id === activeEmailId);
    // `email` is the key the autofill module reads
    chrome.storage.local.set({ email: active ? active.email : "" });
  }

  function isValidEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  }

  function renderList() {
    emailListEl.innerHTML = "";

    if (!emailList.length) {
      const empty = document.createElement("div");
      empty.className = "email-empty";
      empty.textContent = "No saved emails yet";
      emailListEl.appendChild(empty);
      return;
    }

    emailList.forEach(entry => {
      const isActive = entry.id === activeEmailId;
      const row = document.createElement("div");
      row.className = "email-item" + (isActive ? " active" : "");

      const check = document.createElement("span");
      check.className = "email-check";
      check.innerHTML = isActive
        ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>'
        : "";

      const addr = document.createElement("span");
      addr.className = "email-addr";
      addr.textContent = entry.email;
      addr.title = isActive ? "Active email" : "Click to set active";

      const del = document.createElement("button");
      del.className = "email-del";
      del.title = "Delete";
      del.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';

      // Click row → set active
      row.addEventListener("click", (e) => {
        if (e.target.closest(".email-del")) return;
        activeEmailId = entry.id;
        saveEmails();
        renderList();
      });

      // Delete
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        emailList = emailList.filter(en => en.id !== entry.id);
        if (activeEmailId === entry.id) activeEmailId = emailList[0]?.id ?? null;
        saveEmails();
        renderList();
      });

      row.append(check, addr, del);
      emailListEl.appendChild(row);
    });
  }

  function addEmail() {
    const val = emailInput.value.trim();
    if (!val) return;

    if (!isValidEmail(val)) {
      emailInput.classList.add("email-input-error");
      showToast("✗ Enter a valid email");
      return;
    }
    emailInput.classList.remove("email-input-error");

    // Already saved → just make it active
    const existing = emailList.find(e => e.email.toLowerCase() === val.toLowerCase());
    if (existing) {
      activeEmailId = existing.id;
      saveEmails();
      renderList();
      emailInput.value = "";
      showToast("✓ Already saved — set as active");
      return;
    }

    const id = "em_" + Date.now();
    emailList.push({ id, email: val });
    activeEmailId = id; // newest becomes active
    saveEmails();
    renderList();
    emailInput.value = "";
    showToast("✓ Email saved & set as active");
  }

  emailSave.addEventListener("click", addEmail);
  emailInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addEmail(); }
  });
  emailInput.addEventListener("input", () => emailInput.classList.remove("email-input-error"));

  // ── Export CSV ──────────────────────────────────────────────
  document.getElementById("export-emails").addEventListener("click", () => {
    if (!emailList.length) { showToast("No emails to export"); return; }
    const rows = [["Email"], ...emailList.map(e => [e.email])];
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
        if (i === 0 && line.toLowerCase().includes("email") && !line.includes("@")) return; // header
        // Take the last column that contains an @ (handles old Label,Email CSVs)
        const cols  = line.split(",").map(v => v.replace(/^"|"$/g, "").trim());
        const email = cols.find(c => c.includes("@"));
        if (!email || !isValidEmail(email)) { skipped++; return; }
        if (emailList.some(en => en.email.toLowerCase() === email.toLowerCase())) { skipped++; return; }
        emailList.push({ id: "em_" + Date.now() + "_" + i, email });
        added++;
      });
      if (!activeEmailId && emailList.length) activeEmailId = emailList[0].id;
      saveEmails(); renderList();
      showToast(`✓ ${added} imported${skipped ? `, ${skipped} skipped` : ""}`);
      e.target.value = "";
    };
    reader.readAsText(file);
  });
  // ══════════════════════════════════════════════════════════
  // ── PASSPORT OCR ──────────────────────────────────────────
  // ══════════════════════════════════════════════════════════

  const ocrFileInput  = document.getElementById("ocr-file-input");
  const ocrFileNameEl = document.getElementById("ocr-file-name");
  const ocrScanBtn    = document.getElementById("ocr-scan-btn");
  const ocrStatusEl   = document.getElementById("ocr-status");
  const ocrResultsEl  = document.getElementById("ocr-results");
  const ocrFillBtn    = document.getElementById("ocr-fill-btn");
  const ocrApiKeyEl   = document.getElementById("ocr-api-key");

  let ocrSelectedFile = null;

  chrome.storage.local.get(["ocrApiKey"], (res) => {
    if (res.ocrApiKey) ocrApiKeyEl.value = res.ocrApiKey;
  });

  ocrApiKeyEl.addEventListener("input", () => {
    chrome.storage.local.set({ ocrApiKey: ocrApiKeyEl.value.trim() });
  });

  ocrFileInput.addEventListener("change", (e) => {
    ocrSelectedFile = e.target.files[0] || null;
    ocrFileNameEl.textContent = ocrSelectedFile ? ocrSelectedFile.name : "Choose passport image";
    ocrScanBtn.disabled = !ocrSelectedFile;
    ocrResultsEl.style.display = "none";
    ocrStatusEl.style.display  = "none";
  });

  ocrScanBtn.addEventListener("click", async () => {
    if (!ocrSelectedFile) return;
    const apiKey = ocrApiKeyEl.value.trim() || "helloworld";

    ocrScanBtn.disabled          = true;
    ocrStatusEl.style.display    = "block";
    ocrStatusEl.textContent      = "Scanning…";
    ocrStatusEl.className        = "ocr-status ocr-status-loading";
    ocrResultsEl.style.display   = "none";

    try {
      const data = await ocrRunScan(ocrSelectedFile, apiKey);
      const boxes = data.nameBoxes || ["", "", "", ""];

      document.getElementById("ocr-first").value  = boxes[0] || "";
      document.getElementById("ocr-second").value = boxes[1] || "";
      document.getElementById("ocr-third").value  = boxes[2] || "";
      document.getElementById("ocr-family").value = boxes[3] || "";
      document.getElementById("ocr-dob").value    = data.dob       || "";
      document.getElementById("ocr-issue").value  = data.issueDate || "";
      document.getElementById("ocr-gender").value = data.gender    || "";

      if (boxes.some(b => b)) {
        ocrStatusEl.textContent = "✓ Passport scanned — edit boxes if needed";
        ocrStatusEl.className   = "ocr-status ocr-status-success";
        ocrResultsEl.style.display = "block";
      } else {
        ocrStatusEl.textContent = "⚠ No passport data found — try a clearer image";
        ocrStatusEl.className   = "ocr-status ocr-status-warn";
      }
    } catch (err) {
      ocrStatusEl.textContent = "✗ " + (err.message || "Scan failed");
      ocrStatusEl.className   = "ocr-status ocr-status-error";
    } finally {
      ocrScanBtn.disabled = false;
    }
  });

  ocrFillBtn.addEventListener("click", () => {
    const data = {
      nameBoxes: [
        document.getElementById("ocr-first").value.trim(),
        document.getElementById("ocr-second").value.trim(),
        document.getElementById("ocr-third").value.trim(),
        document.getElementById("ocr-family").value.trim(),
      ],
      dob:       document.getElementById("ocr-dob").value.trim(),
      issueDate: document.getElementById("ocr-issue").value.trim(),
      gender:    document.getElementById("ocr-gender").value.trim(),
    };

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) { showToast("✗ No active tab"); return; }
      chrome.tabs.sendMessage(tabs[0].id, { action: "ocr-fill", data }, (response) => {
        if (chrome.runtime.lastError) { showToast("✗ Not on form page"); return; }
        showToast("✓ Form filled from passport");
      });
    });
  });

  // ── OCR helpers ─────────────────────────────────────────────

  async function ocrRunScan(file, apiKey) {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("apikey", apiKey);
    formData.append("language", "eng");
    formData.append("scale", "true");
    formData.append("OCREngine", "2");
    formData.append("detectOrientation", "true");

    const res = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      body: formData,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    if (json.IsErroredOnProcessing) {
      throw new Error(json.ErrorMessage?.[0] || "OCR processing failed");
    }

    const text = json.ParsedResults?.[0]?.ParsedText || "";
    return ocrParsePassport(text);
  }

  // ── Parse passport text (same logic as content script) ──────

  const OCR_MONTHS = {JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12};

  function ocrParseTextDate(str) {
    const m = str.match(/(\d{1,2})\s*([A-Z]{3})\s*(\d{4})/i);
    if (!m) return "";
    const mon = OCR_MONTHS[m[2].toUpperCase()];
    return mon ? `${m[3]}-${String(mon).padStart(2,"0")}-${String(+m[1]).padStart(2,"0")}` : "";
  }

  function ocrExtractDates(lines) {
    const out = { dob:"", issueDate:"", expiryDate:"" };
    for (let i = 0; i < lines.length; i++) {
      const lo = lines[i].toLowerCase(), nxt = lines[i+1]||"";
      if (/birth|dob/.test(lo) && !/issue|expir/.test(lo))
        out.dob       = ocrParseTextDate(nxt) || ocrParseTextDate(lines[i]);
      if (lo.includes("issue") && !lo.includes("expir"))
        out.issueDate = ocrParseTextDate(nxt) || ocrParseTextDate(lines[i]);
      if (lo.includes("expir"))
        out.expiryDate= ocrParseTextDate(nxt) || ocrParseTextDate(lines[i]);
    }
    return out;
  }

  function ocrParsePassport(text) {
    const lines  = text.split("\n").map(l => l.trim()).filter(Boolean);
    const result = { nameBoxes: ["", "", "", ""] };

    const fatherRaw    = ocrExtractParentName(lines);
    const fatherTokens = ocrNormaliseParent(fatherRaw);

    result.issueDate = ocrExtractDates(lines).issueDate;

    let mrzGiven = [], mrzFamily = "";
    const mrz = ocrFindMRZ(lines);
    if (mrz) {
      const m  = ocrParseMRZ(mrz[0], mrz[1]);
      mrzGiven  = m.givenParts || [];
      mrzFamily = m.familyName || "";
      result.dob    = m.dob;
      result.gender = m.gender;
    }

    // Boxes 1–2: MRZ full name (given names + surname), left→right
    const mrzTokens = [...mrzGiven, ...(mrzFamily ? [mrzFamily] : [])];
    const [b1, b2] = ocrDistribute(mrzTokens, 2, 15);
    result.nameBoxes[0] = b1;
    result.nameBoxes[1] = b2;

    // Boxes 3–4: father name
    //   fits in one box → box 4 only (box 3 empty)
    //   doesn't fit    → left→right across boxes 3 and 4
    const [b3, b4] = ocrFatherBoxes(fatherTokens);
    result.nameBoxes[2] = b3;
    result.nameBoxes[3] = b4;

    return result;
  }

  function ocrFatherBoxes(tokens) {
    if (!tokens.length) return ["", ""];
    const joined = tokens.join(" ");
    if (joined.length <= 15) return ["", joined];
    return ocrDistribute(tokens, 2, 15);
  }

  function ocrExtractParentName(lines) {
    // Pass 1: explicit "Father" / "Husband" label
    for (let i = 0; i < lines.length; i++) {
      const lo = lines[i].toLowerCase();
      if (!/father|husband/.test(lo)) continue;
      const ci = lines[i].indexOf(":");
      if (ci !== -1) {
        const v = lines[i].slice(ci + 1).trim();
        if (v && !ocrIsPlaceName(v)) return v;
      }
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const c = lines[j].trim();
        if (!c) continue;
        if (/^(date|nation|passport|birth|sex|place|type|issue|expiry|tracking|booklet|citizen)/i.test(c)) break;
        if (ocrIsPlaceName(c)) continue;
        if (/^[A-Z][A-Z\s'.,\-]+$/i.test(c) && c.length >= 3) return c;
      }
      break;
    }
    // Pass 2: label-free — find "SURNAME, GIVEN1 GIVEN2" in all-uppercase lines
    for (const line of lines) {
      if (!line.includes(",")) continue;
      if (line !== line.toUpperCase()) continue;
      if (!/^[A-Z][A-Z\s'.,\-]+$/.test(line)) continue;
      if (ocrIsPlaceName(line)) continue;
      const afterComma = line.split(",").slice(1).join(",").trim();
      if (afterComma.split(/\s+/).filter(Boolean).length < 2) continue;
      return line;
    }
    return "";
  }

  // "SHAH, RIZWAN ABBAS" → ["Rizwan","Abbas","Shah"]
  function ocrNormaliseParent(raw) {
    if (!raw) return [];
    let ordered = raw;
    if (raw.includes(",")) {
      const parts = raw.split(",").map(p => p.trim()).filter(Boolean);
      ordered = [...parts.slice(1), parts[0]].join(" ");
    }
    return ordered.trim().split(/\s+/).filter(Boolean).map(ocrCap);
  }

  // "KHUSHAB, PAK" → true  |  "SHAH, RIZWAN ABBAS" → false
  function ocrIsPlaceName(str) {
    if (!str) return false;
    if (str.includes(",")) {
      const last = str.split(",").pop().trim();
      if (/^[A-Z]{2,3}$/.test(last)) return true;
    }
    if (/^[A-Z]{2,3}$/.test(str.trim())) return true;
    return false;
  }

  function ocrDistribute(tokens, boxes, maxLen) {
    const result = Array(boxes).fill("");
    let b = 0;
    for (const word of tokens) {
      if (b >= boxes) break;
      const candidate = result[b] ? result[b] + " " + word : word;
      if (candidate.length <= maxLen) { result[b] = candidate; }
      else { b++; if (b < boxes) result[b] = word; }
    }
    return result;
  }

  function ocrFindMRZ(lines) {
    const re = /^[A-Z0-9<]{30,}$/;
    for (let i = 0; i < lines.length - 1; i++) {
      const l1 = lines[i].replace(/\s/g, "").toUpperCase();
      const l2 = lines[i + 1].replace(/\s/g, "").toUpperCase();
      if (l1.length >= 30 && l2.length >= 30 && re.test(l1) && re.test(l2) && l1[0] === "P")
        return [l1.padEnd(44, "<").slice(0, 44), l2.padEnd(44, "<").slice(0, 44)];
    }
    return null;
  }

  function ocrParseMRZ(l1, l2) {
    const r = { givenParts: [] };
    const nameStr = l1.slice(5);
    const sep     = nameStr.indexOf("<<");
    if (sep >= 0) {
      r.familyName = ocrCap(nameStr.slice(0, sep).replace(/</g, " ").trim());
      r.givenParts = nameStr.slice(sep + 2).replace(/<+$/, "").split("<").filter(Boolean).map(ocrCap);
    }
    r.dob = ocrMrzDate(l2.slice(13, 19), true);
    const sx = l2[20];
    r.gender = sx === "M" ? "Male" : sx === "F" ? "Female" : "";
    return r;
  }

  function ocrMrzDate(yymmdd, isPast) {
    if (!/^\d{6}$/.test(yymmdd)) return "";
    const yy    = parseInt(yymmdd.slice(0, 2), 10);
    const nowYY = new Date().getFullYear() % 100;
    const year  = isPast && yy > nowYY ? 1900 + yy : 2000 + yy;
    return `${year}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
  }

  function ocrCap(str) {
    return str ? str[0].toUpperCase() + str.slice(1).toLowerCase() : "";
  }

  // ══════════════════════════════════════════════════════════

  chrome.storage.local.get(["emailList", "activeEmailId"], (res) => {
    emailList     = res.emailList || [];
    activeEmailId = res.activeEmailId || (emailList[0]?.id ?? null);

    if (!emailList.length) {
      // Migrate a legacy single saved email if present
      chrome.storage.local.get(["email"], (r) => {
        if (r.email) {
          const id = "em_legacy";
          emailList = [{ id, email: r.email }];
          activeEmailId = id;
          saveEmails();
        }
        renderList();
      });
    } else {
      renderList();
    }
  });

});
