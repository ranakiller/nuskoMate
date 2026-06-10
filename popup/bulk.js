// Bulk passport parser — OCR many images in the popup, build a table, export.
document.addEventListener("DOMContentLoaded", () => {
  const fileInput   = document.getElementById("bulk-file-input");
  const pickLabel   = document.getElementById("bulk-pick-label");
  const progress    = document.getElementById("bulk-progress");
  const barFill     = document.getElementById("bulk-bar-fill");
  const progressText= document.getElementById("bulk-progress-text");
  const tableWrap   = document.getElementById("bulk-table-wrap");
  const tbody       = document.getElementById("bulk-tbody");
  const actions     = document.getElementById("bulk-actions");
  if (!fileInput) return;

  let results = [];            // { file, details, raw, ok }
  const HISTORY_KEY = "bulkResults";
  const CAP = 500;             // persisted rolling history (≥ the 50 you asked for)

  function saveHistory() {
    chrome.storage.local.set({ [HISTORY_KEY]: results.slice(-CAP) });
  }

  function getApiKey() {
    return new Promise((r) => chrome.storage.local.get(["ocrApiKey"], (x) => r(x.ocrApiKey || "helloworld")));
  }

  // Restore previous conversions when the popup reopens
  function loadHistory() {
    chrome.storage.local.get([HISTORY_KEY], (x) => {
      results = Array.isArray(x[HISTORY_KEY]) ? x[HISTORY_KEY] : [];
      if (!results.length) return;
      tbody.innerHTML = "";
      results.forEach((r, i) => addRow(i, r.file, r.details, r.ok));
      tableWrap.style.display = "block";
      actions.style.display = "flex";
      pickLabel.textContent = `${results.length} in history — upload more`;
    });
  }

  async function ocrImage(file, apiKey) {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("apikey", apiKey);
    fd.append("language", "eng");
    fd.append("scale", "true");
    fd.append("OCREngine", "2");
    fd.append("detectOrientation", "true");
    const res = await fetch("https://api.ocr.space/parse/image", { method: "POST", body: fd });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    if (json.IsErroredOnProcessing) throw new Error(json.ErrorMessage?.[0] || "OCR error");
    return json.ParsedResults?.[0]?.ParsedText || "";
  }

  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : s; return d.innerHTML; }

  function addRow(i, fname, d, ok) {
    d = d || {};
    const tr = document.createElement("tr");
    if (!ok) tr.className = "bulk-row-bad";
    tr.title = fname;
    tr.innerHTML =
      `<td>${i + 1}</td>` +
      `<td>${esc(d.fullName)}</td>` +
      `<td>${esc(d.passportNo)}</td>` +
      `<td>${esc(d.nationality)}</td>` +
      `<td>${esc(d.age)}</td>` +
      `<td class="bulk-status">${ok ? "✓" : "⚠"}</td>`;
    tbody.appendChild(tr);
  }

  fileInput.addEventListener("change", async (e) => {
    const files = [...e.target.files]
      .filter((f) => f.type.startsWith("image/"))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    if (!files.length) return;

    // Append to the existing history rather than wiping it
    progress.style.display = "block";
    tableWrap.style.display = "block";
    actions.style.display = "none";
    fileInput.disabled = true;

    const apiKey = await getApiKey();
    const startCount = results.length;

    for (let i = 0; i < files.length; i++) {
      barFill.style.width = `${Math.round((i / files.length) * 100)}%`;
      progressText.textContent = `Scanning ${i + 1} / ${files.length}…`;
      let raw = "", details = null, ok = false;
      try {
        let parsed;
        if (window.NkLicense && window.NkLicense.enforced()) {
          // Licensed mode: server validates the key, OCRs + parses
          const r = await window.NkLicense.scan(files[i]);
          if (!r.ok) throw new Error(r.error || "scan refused");
          raw = r.raw || "";
          parsed = r.result;
        } else {
          // Dev mode: OCR + parse locally
          raw = await ocrImage(files[i], apiKey);
          parsed = window.NkPassport.parse(raw);
        }
        details = parsed.details;
        ok = !!(details.passportNo || details.fullName);
        // Mirror into the "Last Scanned Passport" viewer (shared with page scans)
        if (ok) {
          chrome.storage.local.set({
            ocrDisplay: JSON.stringify({
              details: parsed.details,
              nameBoxes: parsed.nameBoxes,
              mrzValid: parsed.mrzValid,
              blurry: parsed.blurry,
              scannedAt: Date.now(),
            }),
          });
        }
      } catch (err) {
        raw = "ERROR: " + err.message;
      }
      results.push({ file: files[i].name, details: details || {}, raw, ok });
      addRow(startCount + i, files[i].name, details, ok);
      if (i % 10 === 9) saveHistory(); // periodic save so a mid-run close keeps progress
    }

    saveHistory();
    barFill.style.width = "100%";
    progressText.textContent = `Done — ${files.length} added · ${results.length} in history`;
    pickLabel.textContent = `${results.length} in history — upload more`;
    actions.style.display = "flex";
    fileInput.disabled = false;
    fileInput.value = "";
  });

  // ── Exports ─────────────────────────────────────────────────
  const HEADERS = [
    "SR", "Title", "Given Name", "Surname", "Full Name", "Passport No", "Father Name",
    "Nationality", "Date of Birth", "Age", "Category", "Issue Date", "Expiry Date",
  ];
  const DATE_COLS = [8, 11, 12]; // Date of Birth, Issue Date, Expiry Date

  function ageOf(d) {
    const n = parseInt(d.age, 10);
    return Number.isFinite(n) ? n : null;
  }

  // Travel-standard age bands: <2 Infant, 2–12 Child, older Adult.
  function categoryOf(age) {
    if (age == null) return "";
    if (age < 2) return "Infant";
    if (age <= 12) return "Child";
    return "Adult";
  }

  // Male → Mr.  |  Female ≥12 → Mrs.  |  Female <12 → Miss
  function titleOf(d, age) {
    const sex = (d.sex || "").toLowerCase();
    if (sex.startsWith("f")) return (age != null && age < 12) ? "Miss" : "Mrs.";
    if (sex.startsWith("m")) return "Mr.";
    return "";
  }

  function excelRows() {
    return results.map((r, i) => {
      const d = r.details || {};
      const age = ageOf(d);
      return [
        String(i + 1),                  // SR
        titleOf(d, age),                // Title
        d.givenNames || "",             // Given Name
        d.surname || "",                // Surname
        d.fullName || "",               // Full Name
        d.passportNo || "",             // Passport No
        d.fatherName || "",             // Father Name
        d.nationality || "",            // Nationality
        d.dob || "",                    // Date of Birth
        d.age || "",                    // Age
        categoryOf(age),                // Category
        d.issueDate || "",              // Issue Date
        d.expiry || "",                 // Expiry Date
      ];
    });
  }

  function rawText() {
    return results.map((r, i) => `===== ${i + 1}. ${r.file} =====\n${r.raw}`).join("\n\n");
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  document.getElementById("bulk-dl-excel").addEventListener("click", () => {
    if (results.length) download(window.NkXlsx.blob(HEADERS, excelRows(), DATE_COLS), "passports.xlsx");
  });
  document.getElementById("bulk-dl-raw").addEventListener("click", () => {
    if (results.length) download(new Blob([rawText()], { type: "text/plain" }), "passports-raw.txt");
  });
  document.getElementById("bulk-clear").addEventListener("click", () => {
    if (results.length && !confirm(`Clear all ${results.length} saved conversions?`)) return;
    results = [];
    chrome.storage.local.remove(HISTORY_KEY);
    tbody.innerHTML = "";
    tableWrap.style.display = "none";
    progress.style.display = "none";
    actions.style.display = "none";
    pickLabel.textContent = "Upload passports (select many)";
    fileInput.value = "";
  });

  loadHistory(); // restore previous conversions on popup open
});
