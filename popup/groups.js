// Groups Export tab — fetch Masar's Groups List (via modules/groups-export.js
// on the page), show it as an editable grid, and export a grouped/formatted
// Excel report from whatever's currently in that grid (fetched or hand-edited).
document.addEventListener("DOMContentLoaded", () => {
  const fetchBtn   = document.getElementById("groups-fetch");
  const addRowBtn  = document.getElementById("groups-add-row");
  const addColBtn  = document.getElementById("groups-add-col");
  const exportBtn  = document.getElementById("groups-export-btn");
  const clearBtn   = document.getElementById("groups-clear");
  const progressEl = document.getElementById("groups-progress");
  const barFillEl  = document.getElementById("groups-bar-fill");
  const progressTextEl = document.getElementById("groups-progress-text");
  const errorEl    = document.getElementById("groups-error");
  const gridWrapEl = document.getElementById("groups-grid-wrap");
  const gridHeadEl = document.getElementById("groups-grid-head");
  const gridBodyEl = document.getElementById("groups-grid-body");
  const emptyEl    = document.getElementById("groups-empty");
  const actionsEl  = document.getElementById("groups-actions");
  const infoBtn    = document.getElementById("groups-info-btn");
  const infoPanel  = document.getElementById("groups-info-panel");
  if (!fetchBtn) return;

  if (infoBtn && infoPanel) {
    infoBtn.addEventListener("click", () => {
      const open = infoPanel.style.display !== "none";
      infoPanel.style.display = open ? "none" : "";
      infoBtn.classList.toggle("info-btn-open", !open);
    });
  }

  const TABLE_KEY = "groupsTableData";     // { columns: [{key,label}], rows: [{...}] }
  const STATUS_KEY = "groupsFetchStatus";  // written by modules/groups-export.js

  const DEFAULT_COLUMNS = [
    { key: "groupNumber", label: "Group Number" },
    { key: "package",     label: "Package" },
    { key: "groupName",   label: "Group Name" },
    { key: "pax",         label: "Pax" },
    { key: "arrival",     label: "Arrival" },
    { key: "departure",   label: "Departure" },
    { key: "stay",        label: "Stay" },
    { key: "mainExternalAgentName", label: "Main External Agent Name" },
    { key: "subEaName",   label: "Sub EA Name" },
    { key: "createdBy",   label: "Created By" },
    { key: "state",       label: "State" },
  ];

  let table = { columns: DEFAULT_COLUMNS.map((c) => ({ ...c })), rows: [] };

  // ── Date parsing — Group Name carries the two flight dates, e.g.
  // "NEBRAS 20JUL 9AUG ISB JED UB" → arrival 20-Jul, departure 9-Aug. Year is
  // inferred from Creation Date; departure rolls to next year if it would
  // otherwise land before arrival (a Dec→Jan trip).
  const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const pad2 = (n) => String(n).padStart(2, "0");
  const isoDate = (y, m, d) => `${y}-${pad2(m + 1)}-${pad2(d)}`;

  function creationYear(creationDateStr) {
    const m = /(\d{4})/.exec(creationDateStr || "");
    return m ? +m[1] : new Date().getFullYear();
  }

  // Real Masar group names vary a lot: "20JUL" (abbreviated, no separator),
  // "21JULY" (full month name), "24 JUL" (space between day and month), and
  // "31JULG9175" (month abbreviation glued to trailing flight-code letters).
  // Matching 3-9 letters (no trailing \b) and only ever looking at the FIRST
  // 3 of them covers all four — the day/month regex below stays permissive
  // and relies on the MONTHS lookup to reject accidental non-date matches
  // (e.g. "01PAX", "182DAY80").
  function parseDatesFromGroupName(name, baseYear) {
    const re = /(\d{1,2})\s*([A-Z]{3,9})/g;
    const found = [];
    let m;
    const upper = String(name || "").toUpperCase();
    while ((m = re.exec(upper)) && found.length < 2) {
      const month = MONTHS[m[2].slice(0, 3)];
      if (month === undefined) continue;
      found.push({ day: +m[1], month });
    }
    if (found.length === 0) return null;
    const a = found[0];
    // Only one date in the name (no second flight date to anchor a departure
    // on) — treat it as the arrival and leave departure/stay blank rather
    // than guessing.
    if (found.length === 1) return { arrival: isoDate(baseYear, a.month, a.day), departure: "", stay: "" };
    const d = found[1];
    const arrival = new Date(Date.UTC(baseYear, a.month, a.day));
    let departureYear = baseYear;
    let departure = new Date(Date.UTC(departureYear, d.month, d.day));
    if (departure < arrival) { departureYear++; departure = new Date(Date.UTC(departureYear, d.month, d.day)); }
    const stay = Math.round((departure - arrival) / 86400000);
    return { arrival: isoDate(baseYear, a.month, a.day), departure: isoDate(departureYear, d.month, d.day), stay };
  }

  function deriveRows(rawRows) {
    return rawRows.map((r) => {
      const parsed = parseDatesFromGroupName(r.groupName, creationYear(r.creationDate));
      return {
        groupNumber: r.groupNumber || "",
        package: (r.packageCode || "").trim(),
        groupName: r.groupName || "",
        pax: r.mutamerNumber || "",
        arrival: parsed ? parsed.arrival : "",
        departure: parsed ? parsed.departure : "",
        stay: parsed ? String(parsed.stay) : "",
        mainExternalAgentName: r.mainExternalAgentName || "",
        subEaName: r.subEaName || "",
        createdBy: r.createdBy || "",
        state: r.state || "",
      };
    });
  }

  // ── Persistence ─────────────────────────────────────────────
  function save() { chrome.storage.local.set({ [TABLE_KEY]: table }); }
  function load(cb) {
    chrome.storage.local.get([TABLE_KEY], (res) => {
      if (res[TABLE_KEY] && Array.isArray(res[TABLE_KEY].columns) && Array.isArray(res[TABLE_KEY].rows)) {
        table = res[TABLE_KEY];
      }
      cb();
    });
  }

  // ── Grid rendering ──────────────────────────────────────────
  const NARROW = new Set(["package", "pax", "stay"]);

  function render() {
    const has = table.rows.length > 0;
    gridWrapEl.style.display = has ? "" : "none";
    emptyEl.style.display = has ? "none" : "";
    actionsEl.style.display = has ? "flex" : "none";
    if (!has) return;

    gridHeadEl.textContent = "";
    table.columns.forEach((col, ci) => {
      const th = document.createElement("th");
      const wrap = document.createElement("div"); wrap.className = "groups-grid-colhead";
      const lbl = document.createElement("span"); lbl.textContent = col.label;
      const del = document.createElement("button");
      del.type = "button"; del.className = "groups-grid-del-btn"; del.textContent = "×";
      del.title = "Remove this column";
      del.addEventListener("click", () => {
        if (!confirm(`Remove the "${col.label}" column?`)) return;
        table.columns.splice(ci, 1);
        save(); render();
      });
      wrap.append(lbl, del);
      th.appendChild(wrap);
      gridHeadEl.appendChild(th);
    });
    const thDel = document.createElement("th"); gridHeadEl.appendChild(thDel);

    gridBodyEl.textContent = "";
    table.rows.forEach((row, ri) => {
      const tr = document.createElement("tr");
      table.columns.forEach((col) => {
        const td = document.createElement("td");
        if (NARROW.has(col.key)) td.classList.add("groups-col-narrow");
        const input = document.createElement("input");
        input.type = "text";
        input.value = row[col.key] ?? "";
        input.addEventListener("input", (e) => { row[col.key] = e.target.value; save(); });
        td.appendChild(input);
        tr.appendChild(td);
      });
      const tdDel = document.createElement("td");
      const del = document.createElement("button");
      del.type = "button"; del.className = "groups-grid-del-btn"; del.textContent = "×";
      del.title = "Delete this row";
      del.addEventListener("click", () => { table.rows.splice(ri, 1); save(); render(); });
      tdDel.appendChild(del);
      tr.appendChild(tdDel);
      gridBodyEl.appendChild(tr);
    });
  }

  // ── Fetch from Masar ────────────────────────────────────────
  function setProgress(status) {
    if (!status || !status.running) { progressEl.style.display = "none"; return; }
    progressEl.style.display = "flex";
    barFillEl.style.width = "60%"; // page count is open-ended, so this is just an activity indicator
    progressTextEl.textContent = `Fetching page ${status.page || 1}… ${status.rows || 0} group(s) so far`;
  }

  fetchBtn.addEventListener("click", () => {
    errorEl.style.display = "none";
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0] || !tabs[0].id) return;
      chrome.tabs.sendMessage(tabs[0].id, { action: "FETCH_GROUPS" }, () => {
        if (chrome.runtime.lastError) {
          errorEl.textContent = "Open the Groups List page in Masar and refresh it, then try again.";
          errorEl.style.display = "";
          return;
        }
        progressEl.style.display = "flex";
        progressTextEl.textContent = "Starting…";
      });
    });
  });

  chrome.storage.local.get([STATUS_KEY], (res) => setProgress(res[STATUS_KEY]));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[STATUS_KEY]) {
      const status = changes[STATUS_KEY].newValue;
      setProgress(status);
      if (status && status.done) {
        if (status.error) {
          errorEl.textContent = status.error;
          errorEl.style.display = "";
        } else {
          chrome.storage.local.get(["groupsRawRows"], (res) => {
            const raw = res.groupsRawRows || [];
            table = { columns: DEFAULT_COLUMNS.map((c) => ({ ...c })), rows: deriveRows(raw) };
            save(); render();
          });
        }
      }
    }
  });

  // ── Toolbar actions ─────────────────────────────────────────
  addRowBtn.addEventListener("click", () => {
    const blank = {}; table.columns.forEach((c) => { blank[c.key] = ""; });
    table.rows.push(blank);
    save(); render();
  });

  addColBtn.addEventListener("click", () => {
    const label = window.prompt("New column name:");
    if (!label || !label.trim()) return;
    const key = "col_" + Date.now();
    table.columns.push({ key, label: label.trim() });
    table.rows.forEach((r) => { r[key] = ""; });
    save(); render();
  });

  clearBtn.addEventListener("click", () => {
    if (!confirm("Clear all fetched/edited groups data? This can't be undone.")) return;
    table = { columns: DEFAULT_COLUMNS.map((c) => ({ ...c })), rows: [] };
    save(); render();
  });

  // ── Export ──────────────────────────────────────────────────
  // "NuskoGroups-DDMMYY-hh.mm.ss" — local time, so it matches the clock the
  // export was actually made on rather than UTC.
  function exportFileName() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const DD = p(d.getDate()), MM = p(d.getMonth() + 1), YY = p(d.getFullYear() % 100);
    const hh = p(d.getHours()), mm = p(d.getMinutes()), ss = p(d.getSeconds());
    return `NuskoGroups-${DD}${MM}${YY}-${hh}.${mm}.${ss}`;
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function colLetter(n) {
    let s = ""; n++;
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  // Groups rows by Arrival date (ascending) — rows sharing the same arrival
  // date cluster together with their own subtotal, then a blank spacer, then
  // the next date. Ends with a blank + a grand total. Subtotals and the grand
  // total are real =SUM(...) formulas (recalculate if you edit a Pax value
  // afterward in Excel) — the grand total sums the subtotal CELLS specifically
  // (not the whole column), so it isn't double-counted against them. Whatever
  // is currently in each cell (fetched or hand-edited) is used as-is.
  exportBtn.addEventListener("click", () => {
    if (!table.rows.length) return;
    const cols = table.columns;
    const arrivalIdx = cols.findIndex((c) => c.key === "arrival");
    const departureIdx = cols.findIndex((c) => c.key === "departure");
    const stayIdx = cols.findIndex((c) => c.key === "stay");
    const paxIdx = cols.findIndex((c) => c.key === "pax");
    const groupNameIdx = cols.findIndex((c) => c.key === "groupName");
    const labelIdx = groupNameIdx >= 0 ? groupNameIdx : 0;
    const paxCol = paxIdx >= 0 ? colLetter(paxIdx) : null;
    const arrivalCol = arrivalIdx >= 0 ? colLetter(arrivalIdx) : null;
    const departureCol = departureIdx >= 0 ? colLetter(departureIdx) : null;

    const withDate = table.rows.map((r, i) => ({
      r, i, d: arrivalIdx >= 0 ? Date.parse(r[cols[arrivalIdx].key]) : NaN,
    }));
    withDate.sort((a, b) => {
      if (isNaN(a.d) && isNaN(b.d)) return a.i - b.i;
      if (isNaN(a.d)) return 1;
      if (isNaN(b.d)) return -1;
      return a.d - b.d || a.i - b.i;
    });
    const sorted = withDate.map((x) => x.r);

    const outRows = [];
    const kinds = [];
    const totalRefs = []; // sheet cell refs of each cluster's TOTAL pax cell
    let grandTotal = 0;
    let i = 0;
    while (i < sorted.length) {
      const key = arrivalIdx >= 0 ? sorted[i][cols[arrivalIdx].key] : `__row${i}`;
      const clusterStartRow = outRows.length + 2; // +1 for the header row, +1 for 1-indexing
      let clusterTotal = 0;
      while (i < sorted.length && (arrivalIdx >= 0 ? sorted[i][cols[arrivalIdx].key] : `__row${i}`) === key) {
        const row = sorted[i];
        const rowNum = outRows.length + 2; // this row's 1-indexed sheet row (header is row 1)
        const arr = arrivalIdx >= 0 ? row[cols[arrivalIdx].key] : "";
        const dep = departureIdx >= 0 ? row[cols[departureIdx].key] : "";
        outRows.push(cols.map((c, ci) => {
          // Stay = Departure - Arrival, as a live formula (not a static
          // number) — only when both dates are actually present, otherwise
          // it stays blank rather than subtracting against an empty cell.
          if (ci === stayIdx && arrivalCol && departureCol && arr && dep) {
            const cached = row[c.key];
            const v = cached === "" || cached == null || isNaN(Number(cached)) ? 0 : Number(cached);
            return { f: `${departureCol}${rowNum}-${arrivalCol}${rowNum}`, v };
          }
          return row[c.key] ?? "";
        }));
        kinds.push("data");
        const n = paxIdx >= 0 ? Number(row[cols[paxIdx].key]) : NaN;
        if (isFinite(n)) clusterTotal += n;
        i++;
      }
      const clusterEndRow = outRows.length + 1;
      const totalRow = cols.map((c, ci) => {
        if (ci === labelIdx) return "TOTAL";
        if (ci === paxIdx) return { f: `SUM(${paxCol}${clusterStartRow}:${paxCol}${clusterEndRow})`, v: clusterTotal };
        return "";
      });
      outRows.push(totalRow); kinds.push("total");
      if (paxCol) totalRefs.push(`${paxCol}${outRows.length + 1}`);
      grandTotal += clusterTotal;
      if (i < sorted.length) { outRows.push(cols.map(() => "")); kinds.push("blank"); }
    }
    outRows.push(cols.map(() => "")); kinds.push("blank");
    const grandFormula = totalRefs.length ? `SUM(${totalRefs.join(",")})` : null;
    outRows.push(cols.map((c, ci) => {
      if (ci === labelIdx) return "GRAND TOTAL";
      if (ci === paxIdx) return grandFormula ? { f: grandFormula, v: grandTotal } : grandTotal;
      return "";
    }));
    kinds.push("grandtotal");

    const headers = cols.map((c) => c.label);
    const dateCols = cols.map((c, i2) => (c.key === "arrival" || c.key === "departure") ? i2 : -1).filter((x) => x >= 0);
    const numCols = cols.map((c, i2) => (c.key === "pax" || c.key === "stay") ? i2 : -1).filter((x) => x >= 0);
    const leftAlignCols = labelIdx >= 0 ? [labelIdx] : []; // Group Name stays left-aligned; everything else is centered
    const bigFontCols = paxIdx >= 0 ? [paxIdx] : []; // column D (Pax) at size 16

    const blob = window.NkXlsx.blob(headers, outRows, dateCols, numCols, kinds, leftAlignCols, bigFontCols);
    download(blob, `${exportFileName()}.xlsx`);
  });

  load(render);
});
