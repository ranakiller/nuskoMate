// Talab Details Copy — ported from the user's Tampermonkey "Copy Talab
// Details" (Alt+Shift+C) block, plus new scenarios the original script never
// had. Instead of a hotkey, each scenario gets its own small copy control
// injected right next to that page's own controls.
//
// Scenario A — Hotel Agreement Details page: copies agreement number / hotel
// name+city / dates+days+beds / shirka name (switches to the Hotel Details
// tab to read the city, switches back, then cleans zero-required-rooms rows
// — same side effect the original script had).
// Scenario B — Group Details > Mutamers List page: copies group number/name
// (+ computed trip length), a numbered passport+name list, and the shirka
// name — the full version the original script actually had built, just
// commented down to "passport numbers only" (see masar-userscript-backlog.md
// item 14).
// Scenario C — Groups List page (NEW, not in the original script): copies a
// numbered "group number x mutamer-count (state)" summary + a totals line +
// the shirka name, for whatever rows are currently visible on screen.
// Scenario D — Agreements list page (NEW, not in the original script):
// copies a numbered block per agreement — number / hotel name+city / dates+
// days+rooms — plus the shirka name.
(function () {
  "use strict";

  const wlog = (m) => { try { (window.nkLog || console.log)("[Nuskomate Talab Copy] " + m); } catch (_) { console.log(m); } };

  let moduleEnabled = false;
  // Per-element include/exclude toggles, keyed "scenario.field" (see the
  // matching checkboxes in popup/talab-copy.js) — absent = included, same
  // "missing key means on" convention as every module toggle in this
  // extension. Lets you drop e.g. the shirka name from just the Groups List
  // format without touching the other 3.
  let fieldFlags = {};
  function fieldOn(key) { return fieldFlags[key] !== false; }

  const premiumOK = () => !window.NkLicense || window.NkLicense.featureOK("talabcopy");

  // ── Configurable hotkey (Settings > Talab Copy) — same "record it, store
  // it as a string, normalize before comparing" pattern as BRN Request's
  // hotkey (modules/brn-request.js). Defaults to Alt+Shift+C, the combo the
  // original Tampermonkey script used, but isn't hardcoded to it.
  const HOTKEY_KEY = "talabCopyHotkey";
  const DEFAULT_HOTKEY = "Alt+Shift+C";
  let hotkeyCombo = DEFAULT_HOTKEY;

  function comboFromEvent(e) {
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

  // ── On-page confirmation toast — same idea as the original script's
  // showConfirmation(), self-contained styling so it works regardless of
  // Masar's own CSS. ──
  let toastEl = null;
  let toastHideTimer = null;
  function showToast(message, isError) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.id = "nk-talab-copy-toast";
      Object.assign(toastEl.style, {
        position: "fixed", top: "16px", right: "16px", padding: "9px 16px",
        color: "#fff", borderRadius: "6px", zIndex: "2147483647",
        fontFamily: "system-ui, sans-serif", fontSize: "13px", fontWeight: "600",
        opacity: "0", transition: "opacity .35s ease", pointerEvents: "none",
        boxShadow: "0 4px 14px rgba(0,0,0,.25)",
      });
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.style.backgroundColor = isError ? "#e0245e" : "#22c55e";
    toastEl.style.opacity = "1";
    clearTimeout(toastHideTimer);
    toastHideTimer = setTimeout(() => { toastEl.style.opacity = "0"; }, 2400);
  }

  function copyToClipboard(text, successMsg) {
    navigator.clipboard.writeText(text)
      .then(() => { wlog(successMsg); showToast(successMsg); })
      .catch(() => showToast("Copy failed", true));
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  function getLines() { return document.body.innerText.split("\n").map((l) => l.trim()); }

  // Same shirka-name extraction the original script used in both its
  // scenarios: prefer the "Contract ID ... - Shirka Name" line; otherwise the
  // first non-empty line after a line starting with "Hello".
  function extractShirkaName(lines) {
    const contractLine = lines.find((l) => l.startsWith("Contract ID"));
    if (contractLine && contractLine.includes("-")) {
      return contractLine.split("-").slice(1).join("-").trim();
    }
    const helloIdx = lines.findIndex((l) => l.startsWith("Hello"));
    if (helloIdx >= 0) {
      for (let j = helloIdx + 1; j < lines.length; j++) {
        if (lines[j]) return lines[j];
      }
    }
    return "";
  }

  /* ============================================================
     Scenario A — Hotel Agreement Details
     ============================================================ */
  function isAgreementDetailsPage() {
    return location.href.includes("/housing-agreement/agreement-details");
  }

  function getValueByLabel(label) {
    const elements = Array.from(document.querySelectorAll("span, div, td, label, p"));
    const target = elements.find((el) => el.children.length === 0 && el.innerText && el.innerText.trim() === label);
    if (!target) return null;
    const value = target.nextElementSibling?.innerText?.trim()
      || target.parentElement?.nextElementSibling?.innerText?.trim();
    return value || null;
  }

  function formatDateDDMon(dateStr) {
    if (!dateStr || !dateStr.includes("/")) return dateStr;
    const [day, month] = dateStr.split("/").map((x) => x.trim());
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${day}${monthNames[parseInt(month, 10) - 1] || ""}`;
  }

  // Removes room-type rows whose "Required Rooms" column is empty/NA/0 —
  // ported as-is from the original script's cleanRequiredRoomsRows(), run
  // right after the copy the same way it was there.
  function cleanRequiredRoomsRows() {
    document.querySelectorAll("tr").forEach((row) => {
      const cells = row.querySelectorAll("td");
      if (cells.length >= 4) {
        const val = cells[3].innerText.trim();
        if (!val || val === "NA" || isNaN(val) || Number(val) === 0) row.remove();
      }
    });
  }

  async function copyAgreementDetails() {
    const bodyText = document.body.innerText;
    const agreementNumber = getValueByLabel("Agreement Number")
      || bodyText.match(/Agreement[\s\S]*?(\d{4,})/)?.[1] || "N/A";
    const hotelNameRaw = getValueByLabel("Hotel Name") || "N/A";

    const durationText = getValueByLabel("Agreement Duration") || "";
    let startDate = "N/A", endDate = "N/A";
    if (durationText.includes("-")) {
      const [a, b] = durationText.split("-");
      startDate = formatDateDDMon(a.trim());
      endDate = formatDateDDMon(b.trim());
    }

    const pilgrimsMatch = bodyText.match(/(\d+)\s+pilgrims\)/);
    const totalBeds = pilgrimsMatch ? pilgrimsMatch[1] + " Px" : "N/A";
    const daysMatch = bodyText.match(/^\s*(\d+)\s+Days\s*$/im);
    const numberOfDays = daysMatch ? daysMatch[1] + "D" : "N/A";

    const shirkaName = extractShirkaName(getLines());

    // Switch to the Hotel Details tab just long enough to read the city,
    // then switch back — same trick the original script used.
    let cityAbbrev = "";
    const hotelTab = Array.from(document.querySelectorAll(".p-tabview-nav-link"))
      .find((el) => el.innerText.includes("Hotel Details"));
    if (hotelTab) {
      hotelTab.click();
      await sleep(400);
      const cityEl = document.querySelector(".pi-map-marker")?.closest(".hotel-info__feature");
      if (cityEl) {
        const cityClean = cityEl.innerText.trim().split("\n")[0];
        cityAbbrev = cityClean.substring(0, 3).toUpperCase();
      }
      const mainTab = Array.from(document.querySelectorAll(".p-tabview-nav-link"))
        .find((el) => el.innerText.includes("Agreement") || el.innerText.includes("General"));
      if (mainTab) mainTab.click();
    }

    // Hotel name + city share a line when both are on ("Rua Almasi Hotel
    // (MAD)"), but each has its own toggle — either can be dropped on its own.
    const hotelBits = [];
    if (fieldOn("agreementDetails.hotelName")) hotelBits.push(hotelNameRaw);
    if (fieldOn("agreementDetails.city") && cityAbbrev) hotelBits.push(`(${cityAbbrev})`);
    const hotelLine = hotelBits.join(" ");

    // Same idea for the dates/days/beds line — "23Jul | 26Jul - 3D / 9 Px".
    const dateBits = [];
    if (fieldOn("agreementDetails.startDate")) dateBits.push(startDate);
    if (fieldOn("agreementDetails.endDate")) dateBits.push(endDate);
    let dateLine = dateBits.join(" | ");
    const tailBits = [];
    if (fieldOn("agreementDetails.days")) tailBits.push(numberOfDays);
    if (fieldOn("agreementDetails.beds")) tailBits.push(totalBeds);
    if (tailBits.length) dateLine += (dateLine ? " - " : "") + tailBits.join(" / ");

    const mainLines = [];
    if (fieldOn("agreementDetails.agreementNumber")) mainLines.push(agreementNumber);
    if (hotelLine) mainLines.push(hotelLine);
    if (dateLine) mainLines.push(dateLine);

    const blocks = [];
    if (mainLines.length) blocks.push(mainLines.join("\n"));
    if (fieldOn("agreementDetails.shirkaName")) blocks.push(shirkaName);
    const output = blocks.join("\n\n");

    copyToClipboard(output, `Copied: ${hotelNameRaw}`);
    cleanRequiredRoomsRows();
  }

  /* ============================================================
     Scenario B — Group Details > Mutamers List
     Full format (group number/name/days + numbered passport+name list +
     shirka name) — the ORIGINAL script actually had this whole thing built,
     just commented out down to "passport numbers only". This is that full
     version, uncommented.
     ============================================================ */
  const PASSPORT_RE = /^[A-Z]{2}\d{7}$/;

  function findPassportLines() {
    return getLines().filter((l) => PASSPORT_RE.test(l));
  }

  // The "Mutamers List" tab text alone isn't enough (it's present even when
  // a DIFFERENT tab on the same Group Details page is active) — requiring at
  // least one passport-shaped line confirms the table itself is actually
  // rendered right now.
  function isMutamerListPage() {
    const t = document.body.innerText;
    return (t.includes("Mutamers List") || t.includes("Mutamer List")) && findPassportLines().length > 0;
  }
  window.nkIsMutamerListPage = isMutamerListPage; // shared with modules/masar-group-reply.js — see buildMutamerListText above

  function extractGroupNameNumber(pageText) {
    const m = pageText.match(/Group Details\s+(.+?)\s+(\d{9,})/);
    if (!m) return { groupName: "N/A", groupNumber: "N/A" };
    return { groupName: m[1].trim(), groupNumber: m[2].trim() };
  }

  // Group names carry the two flight dates, but the format varies a lot:
  // "20JUL" (no separator), "21JULY" (full month name), "24 JUL" (space
  // between day and month), "31JULG9175" (month abbreviation glued to
  // trailing flight-code letters) — same permissive matching Groups
  // Export's own date parser uses (popup/groups.js's
  // parseDatesFromGroupName): 1-2 digit day, 3-9 letter month, only the
  // month's first 3 letters looked up, so any of those variants resolve.
  // Current year used for both dates (matches the original — it never
  // anchored on Creation Date here the way Groups Export's parser does).
  const MONTH_IDX = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  function computeDaysText(groupName) {
    const re = /(\d{1,2})\s*([A-Z]{3,9})/g;
    const upper = String(groupName || "").toUpperCase();
    const found = [];
    let m;
    while ((m = re.exec(upper)) && found.length < 2) {
      const month = MONTH_IDX[m[2].slice(0, 3)];
      if (month === undefined) continue;
      found.push({ day: parseInt(m[1], 10), month });
    }
    if (found.length < 2) return "";
    const y = new Date().getFullYear();
    const d1 = new Date(y, found[0].month, found[0].day);
    const d2 = new Date(y, found[1].month, found[1].day);
    const diff = Math.round((d2 - d1) / 86400000);
    return diff > 0 ? `${diff} Days` : "";
  }

  // Name sits 2 lines above its passport number in the rendered table.
  function extractMutamers(filteredLines) {
    const mutamers = [];
    let sr = 1;
    for (let i = 0; i < filteredLines.length; i++) {
      if (PASSPORT_RE.test(filteredLines[i])) {
        mutamers.push({ sr: sr++, passport: filteredLines[i], name: filteredLines[i - 2] || "Unknown" });
      }
    }
    return mutamers;
  }

  // Pure text-building half of Scenario B, split out so it can be reused by
  // automation (the WhatsApp pipeline's reply-caption step) without the
  // clipboard/toast side effects the hotkey/button version wants. Returns
  // null when there's nothing to build (caller decides how to report that).
  function buildMutamerListText() {
    const pageText = document.body.innerText;
    const filteredLines = pageText.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    const mutamers = extractMutamers(filteredLines);
    if (!mutamers.length) return null;

    const { groupName, groupNumber } = extractGroupNameNumber(pageText);
    const daysText = computeDaysText(groupName);
    const shirkaName = extractShirkaName(getLines());

    const headerBits = [];
    if (fieldOn("mutamerList.groupNumber")) headerBits.push(groupNumber);
    if (fieldOn("mutamerList.groupName")) {
      // Days appends right onto the END of the group name itself — "GroupName
      // (N Days)" — its own toggle, so it can be dropped independently, but
      // only shows at all when the group name line itself is shown.
      const withDays = fieldOn("mutamerList.days") && daysText ? `${groupName} (${daysText})` : groupName;
      headerBits.push(withDays);
    }

    const showSr = fieldOn("mutamerList.sr");
    const showPassport = fieldOn("mutamerList.passport");
    const showName = fieldOn("mutamerList.name");

    const blocks = [];
    if (headerBits.length) blocks.push(headerBits.join("\n"));
    if (showPassport || showName) {
      const listLines = mutamers.map((m) => {
        const bits = [];
        if (showPassport) bits.push(m.passport);
        if (showName) bits.push(m.name);
        const line = bits.join(" — ");
        return showSr ? `${m.sr}. ${line}` : line;
      });
      blocks.push(listLines.join("\n"));
    }
    if (fieldOn("mutamerList.shirkaName")) blocks.push(shirkaName);
    return { text: blocks.join("\n\n"), count: mutamers.length, groupName, groupNumber };
  }
  // Exposed for modules/masar-group-reply.js (Phase 5 of the WhatsApp
  // automation plan) — content scripts on the same page share one isolated
  // world, so this is directly callable from another module file without
  // duplicating the extraction logic. Available regardless of this module's
  // own enabled toggle (the hotkey/button UI is what's gated, not the pure
  // text-building this wraps).
  window.nkBuildMutamerListText = buildMutamerListText;

  function copyMutamerListDetails() {
    const built = buildMutamerListText();
    if (!built) { showToast("No mutamers found on this page", true); return; }
    copyToClipboard(built.text, `Copied ${built.count} mutamer(s)`);
  }

  /* ============================================================
     Scenario C — Groups List (new format)
     ============================================================ */
  // Same header-matching approach as modules/groups-export.js, trimmed down
  // to just the 3 columns this needs.
  function normalize(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim(); }
  function headerText(th) {
    const titleEl = th.querySelector(".p-column-title");
    return normalize(titleEl ? titleEl.textContent : th.textContent);
  }
  function findGroupsTable() {
    for (const table of document.querySelectorAll("table")) {
      const headerCells = table.querySelectorAll("thead th, thead td");
      if (!headerCells.length) continue;
      const texts = [...headerCells].map(headerText);
      if (texts.some((t) => t.includes("group number")) && texts.some((t) => t.includes("group name"))) return table;
    }
    return null;
  }
  function mapGroupsColumns(table) {
    const headerCells = [...table.querySelectorAll("thead th, thead td")];
    const map = {};
    headerCells.forEach((th, i) => {
      const text = headerText(th);
      if (!("groupNumber" in map) && text.includes("group number")) map.groupNumber = i;
      if (!("mutamerNumber" in map) && text.includes("mutamer")) map.mutamerNumber = i;
      if (!("state" in map) && text === "state") map.state = i;
    });
    return map;
  }

  function isGroupsListPage() {
    const t = document.body.innerText;
    return t.includes("EA Groups") && t.includes("Groups List");
  }

  function copyGroupsListSummary() {
    const table = findGroupsTable();
    if (!table) { showToast("Groups table not found", true); return; }
    const colMap = mapGroupsColumns(table);
    if (!("groupNumber" in colMap)) { showToast("Couldn't read the Groups List columns", true); return; }

    const rows = [...table.querySelectorAll("tbody tr")];
    if (!rows.length) { showToast("No groups on this page", true); return; }

    const showGroupNumber = fieldOn("groupsList.groupNumber");
    const showMutamerCount = fieldOn("groupsList.mutamerCount");
    const showState = fieldOn("groupsList.state");

    let total = 0;
    const lines = rows.map((tr, i) => {
      const cells = tr.querySelectorAll("td");
      const groupNumber = cells[colMap.groupNumber]?.innerText.trim() || "";
      const mutamerCount = parseInt((cells[colMap.mutamerNumber]?.innerText || "0").trim(), 10) || 0;
      const state = "state" in colMap ? (cells[colMap.state]?.innerText.trim() || "") : "";
      total += mutamerCount; // tracked regardless of display, for the totals line

      const bits = [];
      if (showGroupNumber) bits.push(groupNumber);
      if (showMutamerCount) bits.push(`x${mutamerCount}`);
      if (showState && state) bits.push(`(${state})`);
      return `${i + 1}. ${bits.join(" ")}`;
    });

    const shirkaName = extractShirkaName(getLines());
    const blocks = [];
    if ((showGroupNumber || showMutamerCount || showState) && lines.length) blocks.push(lines.join("\n"));
    if (fieldOn("groupsList.totals")) blocks.push(`---Totals: ${total}---`);
    if (fieldOn("groupsList.shirkaName")) blocks.push(shirkaName);
    const output = blocks.join("\n\n");
    copyToClipboard(output, `Copied ${rows.length} group(s)`);
  }

  /* ============================================================
     Scenario D — Agreements list (new format)
     ============================================================ */
  function findAgreementsTable() {
    for (const table of document.querySelectorAll("table")) {
      const headerCells = table.querySelectorAll("thead th, thead td");
      if (!headerCells.length) continue;
      const texts = [...headerCells].map(headerText);
      if (texts.some((t) => t.includes("agreement number")) && texts.some((t) => t.includes("hotel name"))) return table;
    }
    return null;
  }
  function mapAgreementsColumns(table) {
    const headerCells = [...table.querySelectorAll("thead th, thead td")];
    const map = {};
    headerCells.forEach((th, i) => {
      const text = headerText(th);
      if (!("agreementNumber" in map) && text.includes("agreement number")) map.agreementNumber = i;
      if (!("hotelName" in map) && text.includes("hotel name")) map.hotelName = i;
      if (!("city" in map) && text === "city") map.city = i;
      if (!("rooms" in map) && text === "rooms") map.rooms = i;
      if (!("days" in map) && text === "days") map.days = i;
      if (!("startDate" in map) && text.includes("start date")) map.startDate = i;
      if (!("endDate" in map) && text.includes("end date")) map.endDate = i;
    });
    return map;
  }

  function isAgreementsListPage() {
    const t = document.body.innerText;
    return t.includes("Agreements") && t.includes("Agreement Number") && t.includes("Hotel Name");
  }

  // This table's dates come as "23-07-2026" (dash-separated), unlike the
  // Agreement Details page's "23/07/2026" (slash-separated) — same DDMon
  // output, different input format, so it's its own helper.
  function formatDashDate(dateStr) {
    const parts = String(dateStr || "").trim().split("-");
    if (parts.length < 2) return dateStr || "";
    const [day, month] = parts;
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${day}${monthNames[parseInt(month, 10) - 1] || ""}`;
  }

  function copyAgreementsListSummary() {
    const table = findAgreementsTable();
    if (!table) { showToast("Agreements table not found", true); return; }
    const colMap = mapAgreementsColumns(table);
    if (!("agreementNumber" in colMap)) { showToast("Couldn't read the Agreements columns", true); return; }

    const rows = [...table.querySelectorAll("tbody tr")];
    if (!rows.length) { showToast("No agreements on this page", true); return; }

    const rowBlocks = rows.map((tr) => {
      const cells = tr.querySelectorAll("td");
      const agreementNumber = cells[colMap.agreementNumber]?.innerText.trim() || "";
      const hotelName = cells[colMap.hotelName]?.innerText.trim() || "";
      const city = "city" in colMap ? (cells[colMap.city]?.innerText.trim() || "") : "";
      const cityAbbrev = city ? city.substring(0, 3).toUpperCase() : "";
      const rooms = "rooms" in colMap ? (cells[colMap.rooms]?.innerText.trim() || "") : "";
      const days = "days" in colMap ? (cells[colMap.days]?.innerText.trim() || "") : "";
      const startDate = "startDate" in colMap ? formatDashDate(cells[colMap.startDate]?.innerText.trim()) : "";
      const endDate = "endDate" in colMap ? formatDashDate(cells[colMap.endDate]?.innerText.trim()) : "";

      const hotelBits = [];
      if (fieldOn("agreementsList.hotelName")) hotelBits.push(hotelName);
      if (fieldOn("agreementsList.city") && cityAbbrev) hotelBits.push(`(${cityAbbrev})`);
      const hotelLine = hotelBits.join(" ");

      const dateBits = [];
      if (fieldOn("agreementsList.startDate")) dateBits.push(startDate);
      if (fieldOn("agreementsList.endDate")) dateBits.push(endDate);
      let dateLine = dateBits.join(" | ");
      const tailBits = [];
      if (fieldOn("agreementsList.days") && days) tailBits.push(`${days}D`);
      if (fieldOn("agreementsList.rooms") && rooms) tailBits.push(`${rooms} Room`);
      if (tailBits.length) dateLine += (dateLine ? " - " : "") + tailBits.join(" / ");

      const blockLines = [];
      if (fieldOn("agreementsList.agreementNumber")) blockLines.push(agreementNumber);
      if (hotelLine) blockLines.push(hotelLine);
      if (dateLine) blockLines.push(dateLine);
      return blockLines.join("\n");
    }).filter(Boolean);

    const shirkaName = extractShirkaName(getLines());
    const blocks = [...rowBlocks];
    if (fieldOn("agreementsList.shirkaName")) blocks.push(shirkaName);
    const output = blocks.join("\n\n");
    copyToClipboard(output, `Copied ${rows.length} agreement(s)`);
  }

  /* ============================================================
     Button injection — same exact markup/classes as Masar's own PrimeNG
     buttons (e.g. the "Create Package" button: a `div.my-2.ng-star-inserted`
     wrapping a `button.p-element...p-button.p-component` with an icon span +
     label span), so it renders identically to a native page control instead
     of looking like an injected overlay. The Angular-only bits (`pbutton`
     directive attribute, `routerlink`, `_ngcontent-*` scoping attrs) are
     skipped — those only matter inside Angular's own component tree; the
     PrimeNG classes alone (global, unscoped CSS) already give the same look.
     Falls back to a fixed top-right floating button if the expected anchor
     isn't found, so the feature still works even if Masar's markup drifts
     from what's assumed here.
     ============================================================ */
  const BTN_ID = "nk-talab-copy-btn";

  function makeMasarButton(labelText, onClick) {
    const wrapper = document.createElement("div");
    wrapper.id = BTN_ID;
    wrapper.className = "my-2 ng-star-inserted";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "p-element flex self-end items-end justify-end p-button p-component";
    btn.tabIndex = 0;

    const iconSpan = document.createElement("span");
    iconSpan.className = "p-button-icon p-button-icon-left pi pi-copy";
    iconSpan.setAttribute("aria-hidden", "true");

    const labelSpan = document.createElement("span");
    labelSpan.className = "p-button-label";
    labelSpan.textContent = labelText;

    btn.append(iconSpan, labelSpan);
    btn.addEventListener("click", onClick);
    wrapper.appendChild(btn);
    return wrapper;
  }

  // Icon-only control — same markup shape as the OTHER icon buttons already
  // sitting in the Group Details / Groups List toolbar (a plain
  // `div.p-element.last-first-item` wrapping an `<i class="pi ...">`, no
  // <button>, no label) — same format as those, just different functionality.
  function makeIconOnlyButton(iconClass, title, onClick) {
    const wrapper = document.createElement("div");
    wrapper.id = BTN_ID;
    wrapper.className = "p-element last-first-item ng-star-inserted";
    wrapper.title = title;
    wrapper.style.cursor = "pointer";
    const icon = document.createElement("i");
    icon.className = `pi ${iconClass}`;
    wrapper.appendChild(icon);
    wrapper.addEventListener("click", onClick);
    return wrapper;
  }

  function placeFallbackFixed(btn) {
    Object.assign(btn.style, { position: "fixed", top: "70px", right: "16px", zIndex: "2147483000", margin: "0" });
    document.body.appendChild(btn);
  }

  // A leaf <div> (no element children) whose own text trims to an exact
  // match — the heading pattern Masar uses for "Mutamer List" / "Groups
  // List" / "Agreements" (`<div class="ng-star-inserted"> Mutamer List
  // </div>`). These pages also show the SAME text as a bigger page title
  // higher up — the in-context heading right above the table is always the
  // LAST match in document order, so that's the one used.
  function findLeafTextDiv(text) {
    const matches = [...document.querySelectorAll("div")].filter((d) => d.children.length === 0 && d.textContent.trim() === text);
    return matches[matches.length - 1];
  }
  function findHeading2(text) {
    return [...document.querySelectorAll("h2")].find((h) => h.textContent.trim() === text);
  }
  // The row of icon-only controls (filter-slash / refresh / export dropdown)
  // above the table on both the Group Details and Groups List pages — our
  // button goes in as the FIRST item there.
  function findListToolbar() {
    return document.querySelector(".last-item > .flex-d");
  }

  function placeOnAgreementPage(btn) {
    const anchor = findHeading2("Basic data");
    if (anchor) { anchor.insertAdjacentElement("afterend", btn); return true; }
    return false;
  }
  function placeInToolbarOrAfterHeading(btn, headingText) {
    const toolbar = findListToolbar();
    if (toolbar) { toolbar.insertBefore(btn, toolbar.firstElementChild); return true; }
    const anchor = findLeafTextDiv(headingText);
    if (anchor) { anchor.insertAdjacentElement("afterend", btn); return true; }
    return false;
  }
  function placeOnMutamerListPage(btn) { return placeInToolbarOrAfterHeading(btn, "Mutamer List"); }
  function placeOnGroupsListPage(btn) { return placeInToolbarOrAfterHeading(btn, "Groups List"); }
  function placeOnAgreementsListPage(btn) { return placeInToolbarOrAfterHeading(btn, "Agreements"); }

  function removeInjectedButton() {
    const el = document.getElementById(BTN_ID);
    if (el) el.remove();
  }

  // Shared scenario detection — used by both the injected button (per page)
  // and the Alt+Shift+C keyboard shortcut (same shortcut the original
  // Tampermonkey script used), so the hotkey always runs whichever format
  // actually matches the page you're currently on.
  function getCurrentScenarioCopyFn() {
    if (isAgreementDetailsPage()) return copyAgreementDetails;
    if (isMutamerListPage()) return copyMutamerListDetails;
    if (isGroupsListPage()) return copyGroupsListSummary;
    if (isAgreementsListPage()) return copyAgreementsListSummary;
    return null;
  }

  function injectForCurrentPage() {
    if (document.getElementById(BTN_ID)) return; // already injected for this page state
    let btn, placed;
    if (isAgreementDetailsPage()) {
      btn = makeMasarButton("Copy", () => copyAgreementDetails());
      placed = placeOnAgreementPage(btn);
    } else if (isMutamerListPage()) {
      btn = makeIconOnlyButton("pi-copy", "Copy mutamer list details", () => copyMutamerListDetails());
      placed = placeOnMutamerListPage(btn);
    } else if (isGroupsListPage()) {
      btn = makeIconOnlyButton("pi-copy", "Copy groups summary", () => copyGroupsListSummary());
      placed = placeOnGroupsListPage(btn);
    } else if (isAgreementsListPage()) {
      btn = makeIconOnlyButton("pi-copy", "Copy agreements summary", () => copyAgreementsListSummary());
      placed = placeOnAgreementsListPage(btn);
    } else {
      return; // not a page we handle
    }
    if (!placed) placeFallbackFixed(btn);
  }

  document.addEventListener("keydown", (e) => {
    if (!moduleEnabled) return;
    if (comboFromEvent(e) !== hotkeyCombo) return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;
    const copyFn = getCurrentScenarioCopyFn();
    if (!copyFn) return;
    e.preventDefault();
    copyFn();
  });

  let debounceTimer = null;
  function scheduleInject() {
    if (!moduleEnabled) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(injectForCurrentPage, 500);
  }

  let observer = null;
  function startObserving() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      // Ignore our own button's insertion/removal to avoid a self-triggered loop.
      const relevant = mutations.some((m) => {
        const t = m.target.nodeType === Node.TEXT_NODE ? m.target.parentElement : m.target;
        return !(t && t.id === BTN_ID);
      });
      if (relevant) scheduleInject();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    scheduleInject();
  }
  function stopObserving() {
    if (observer) { observer.disconnect(); observer = null; }
    removeInjectedButton();
  }

  window.addEventListener("nusuk-route-change", () => {
    if (!moduleEnabled) return;
    removeInjectedButton(); // page changed — old button (if any) no longer applies
    scheduleInject();
  });

  function refreshEnabled() {
    chrome.storage.local.get(["moduleTalabCopy", "extensionEnabled", "talabCopyFields", HOTKEY_KEY], (res) => {
      fieldFlags = res.talabCopyFields || {};
      hotkeyCombo = normHotkey(res[HOTKEY_KEY]) || DEFAULT_HOTKEY;
      const was = moduleEnabled;
      moduleEnabled = res.extensionEnabled !== false && !!res.moduleTalabCopy && premiumOK();
      if (moduleEnabled && !was) startObserving();
      else if (!moduleEnabled && was) stopObserving();
    });
  }

  refreshEnabled();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[HOTKEY_KEY]) hotkeyCombo = normHotkey(changes[HOTKEY_KEY].newValue) || DEFAULT_HOTKEY;
    if (changes.moduleTalabCopy || changes.extensionEnabled || changes.talabCopyFields) refreshEnabled();
  });

  window.NkLicense && window.NkLicense.onPremiumChange(() => refreshEnabled());
})();
