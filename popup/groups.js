// Groups Export — one click in Modules > Utilities: fetch Masar's Groups
// List (via modules/groups-export.js, which pages through every row on its
// own) and immediately download a formatted, grouped-by-arrival-date Excel
// report. No editable grid anymore — the button next to the toggle IS the
// whole action, same one-shot idea as Totals' "Add Current URL" button.
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("groups-download-btn");
  if (!btn) return;

  const STATUS_KEY = "groupsFetchStatus";
  const RAW_KEY = "groupsRawRows";
  const statusRow  = document.getElementById("groups-status-row");
  const statusText = document.getElementById("groups-status-text");

  // Flipping the toggle back on shouldn't leave a stale "turned off" error
  // sitting there from a previous attempt — clear it the moment the toggle
  // changes, in either direction.
  const toggleEl = document.getElementById("toggle-groups");
  if (toggleEl) toggleEl.addEventListener("change", () => showStatus(""));

  const COLUMNS = [
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

  // ── Status line — errors only; a successful run just triggers the
  // download, no separate confirmation needed. ──
  let hideTimer = null;
  function showStatus(msg, isError) {
    clearTimeout(hideTimer);
    statusText.textContent = msg || "";
    statusRow.style.display = msg ? "" : "none";
    statusRow.classList.toggle("groups-status-error", !!isError);
  }
  function flashError(msg) {
    showStatus(msg, true);
    hideTimer = setTimeout(() => showStatus(""), 5000);
  }

  function setBusy(busy) {
    btn.disabled = busy;
    btn.classList.toggle("busy", busy);
  }

  // "Groups-DDMMYY-hh.mm.ss" — local time, so it matches the clock the
  // export was actually made on rather than UTC. The "Nuskomate" part of
  // the final filename comes from download() below, not here.
  function exportFileName() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const DD = p(d.getDate()), MM = p(d.getMonth() + 1), YY = p(d.getFullYear() % 100);
    const hh = p(d.getHours()), mm = p(d.getMinutes()), ss = p(d.getSeconds());
    return `Groups-${DD}${MM}${YY}-${hh}.${mm}.${ss}`;
  }

  // chrome.downloads.download() instead of an <a download> + synthetic
  // click — the click fires from a storage.onChanged callback, well after
  // the original button click's user-gesture context, which some browsers
  // (Edge in particular) can silently refuse to honor. The extension API
  // isn't gesture-gated the same way, so it downloads reliably either way.
  // The blob URL is only revoked once the download actually finishes, since
  // chrome.downloads needs it to stay alive while it reads the data.
  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    filename = window.nkBrandFilename ? window.nkBrandFilename(filename) : filename;
    chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError || !downloadId) {
        URL.revokeObjectURL(url);
        flashError("Download didn't start — check your browser's download permission for this extension.");
        return;
      }
      const onChanged = (delta) => {
        if (delta.id !== downloadId || !delta.state) return;
        if (delta.state.current === "complete" || delta.state.current === "interrupted") {
          URL.revokeObjectURL(url);
          chrome.downloads.onChanged.removeListener(onChanged);
        }
      };
      chrome.downloads.onChanged.addListener(onChanged);
    });
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
  // (not the whole column), so it isn't double-counted against them.
  function buildAndDownload(rawRows) {
    const rows = deriveRows(rawRows);
    if (!rows.length) { flashError("No groups found on that page."); return; }

    const cols = COLUMNS;
    const arrivalIdx = cols.findIndex((c) => c.key === "arrival");
    const departureIdx = cols.findIndex((c) => c.key === "departure");
    const stayIdx = cols.findIndex((c) => c.key === "stay");
    const paxIdx = cols.findIndex((c) => c.key === "pax");
    const groupNameIdx = cols.findIndex((c) => c.key === "groupName");
    const labelIdx = groupNameIdx >= 0 ? groupNameIdx : 0;
    const paxCol = paxIdx >= 0 ? colLetter(paxIdx) : null;
    const arrivalCol = arrivalIdx >= 0 ? colLetter(arrivalIdx) : null;
    const departureCol = departureIdx >= 0 ? colLetter(departureIdx) : null;

    const withDate = rows.map((r, i) => ({
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

    const blob = window.NkXlsx.blob(headers, outRows, dateCols, numCols, kinds, leftAlignCols, bigFontCols, "Groups");
    download(blob, `${exportFileName()}.xlsx`);
  }

  // ── Fetch from Masar, then export the moment it's done ──────
  // Each fetch on the page side gets a unique runId (see groups-export.js).
  // expectedRunId locks onto whichever run's status we see first after a
  // click, so a leftover/duplicate status write from a DIFFERENT run can
  // never be mistaken for this one. downloadedRunId is a second guard so
  // even a duplicate "done" event for the SAME run can't trigger a second
  // download.
  let expectedRunId = null;
  let downloadedRunId = null;

  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    setBusy(true);
    showStatus("Fetching…");
    expectedRunId = null;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0] || !tabs[0].id) { setBusy(false); flashError("No active tab."); return; }
      chrome.tabs.sendMessage(tabs[0].id, { action: "FETCH_GROUPS" }, () => {
        if (chrome.runtime.lastError) {
          setBusy(false);
          flashError("Open the Groups List page in Masar and refresh it, then try again.");
        }
      });
    });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!changes[STATUS_KEY]) return;
    const status = changes[STATUS_KEY].newValue;
    if (!status) return;

    if (expectedRunId === null) expectedRunId = status.runId;
    if (status.runId !== expectedRunId) return; // stale write from a different run

    if (status.running) { showStatus(`Fetching page ${status.page || 1}… ${status.rows || 0} group(s) so far`); return; }
    if (status.done) {
      setBusy(false);
      if (status.error) { flashError(status.error); return; }
      if (downloadedRunId === status.runId) return; // already handled this run
      downloadedRunId = status.runId;
      showStatus("");
      chrome.storage.local.get([RAW_KEY], (res) => buildAndDownload(res[RAW_KEY] || []));
    }
  });
});
