// Groups Export — scrapes Masar's "Groups List" table (whatever filter/tab is
// currently active there, e.g. Sub-Agents Groups) across every page, and
// hands the raw rows to the popup for editing + a formatted Excel export.
//
// Deliberately does NOT hardcode CSS classes for the table/paginator beyond
// PrimeNG's well-known ".p-paginator-next" — everything else is matched by
// HEADER TEXT (see COLUMN_MAP) so small markup differences don't break it.
// Every step logs to the Logs tab, so if Masar's layout doesn't match, what
// went wrong (table not found / columns not recognized / pagination stuck)
// is visible without needing devtools.
(function () {
  "use strict";

  const log = {
    info:  (...a) => (window.nkLog       ? window.nkLog(...a)       : console.log(...a)),
    warn:  (...a) => (window.nkLog?.warn  ? window.nkLog.warn(...a)  : console.warn(...a)),
    error: (...a) => (window.nkLog?.error ? window.nkLog.error(...a) : console.error(...a)),
  };
  const TAG = "[Nuskomate Groups]";
  const premiumOK = () => !window.NkLicense || window.NkLicense.featureOK("groups");

  // Header text (normalized: lowercase, punctuation stripped) → field name.
  // Matched by SUBSTRING, so "Mutamer's Number" vs "Mutamer Number" (or any
  // other small wording difference) still maps correctly.
  const COLUMN_MAP = [
    ["group number", "groupNumber"],
    ["group name", "groupName"],
    ["creation date", "creationDate"],
    ["consulate", "consulate"],
    ["package type", "packageType"],
    // Masar has THREE separate "package"-ish columns — "Package Type" (e.g.
    // "Air"), "Package" (a numeric code, e.g. 4145182 — this is what the
    // export's Package column actually wants), and "Suggested Package".
    // "=" prefix means EXACT match (after normalize), not substring — plain
    // "package" would also match inside "package type" and "suggested
    // package" otherwise. Listed after "package type" so that one still
    // claims its own column first regardless of match order.
    ["=package", "packageCode"],
    ["mutamer", "mutamerNumber"],
    ["arrival date", "arrivalDate"],
    ["created by", "createdBy"],
    ["services value", "servicesValue"],
    // Masar has BOTH a "Main External Agent Code" and a "Main External Agent
    // Name" column (same for Sub EA) — the Code column always comes first in
    // the table, so a needle of just "main external agent" would match it
    // first and steal the field slot before the real Name column is even
    // seen. The needle must include "name" so it can only match the Name
    // column, never the Code one.
    ["main external agent name", "mainExternalAgentName"],
    ["sub ea name", "subEaName"],
    ["external agent", "externalAgentCode"],
    // "State" sits right next to the Voucher Status column — exact match so
    // it doesn't accidentally grab some other "...state..." header.
    ["=state", "state"],
  ];

  function normalize(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  }

  // PrimeNG (which the rest of this app already targets — see dropdown-
  // helper.js) wraps a column's actual label in ".p-column-title", with the
  // sort arrow / filter-menu button as separate SIBLING elements — but a
  // filter button often carries a hidden dropdown/menu with its OWN text
  // nodes still inside the <th>. Reading th.textContent directly picks all
  // of that up too, which silently breaks EXACT-match needles (see
  // COLUMN_MAP's "=package") even though it looks harmless for substring
  // ones. Prefer the title element; fall back to the whole cell only if it's
  // not there.
  function headerText(th) {
    const titleEl = th.querySelector(".p-column-title");
    return normalize(titleEl ? titleEl.textContent : th.textContent);
  }

  // Any <table> whose header row mentions BOTH "group number" and "group
  // name" — specific enough that a false match elsewhere on the page is
  // very unlikely.
  function findGroupsTable() {
    for (const table of document.querySelectorAll("table")) {
      const headerCells = table.querySelectorAll("thead th, thead td");
      if (!headerCells.length) continue;
      const texts = [...headerCells].map(headerText);
      if (texts.some((t) => t.includes("group number")) && texts.some((t) => t.includes("group name"))) return table;
    }
    return null;
  }

  function mapColumns(table) {
    const headerCells = [...table.querySelectorAll("thead th, thead td")];
    const map = {};
    headerCells.forEach((th) => {
      const text = headerText(th);
      for (const [needle, field] of COLUMN_MAP) {
        if (field in map) continue;
        const exact = needle.startsWith("=");
        const pattern = exact ? needle.slice(1) : needle;
        const match = exact ? text === pattern : text.includes(pattern);
        if (match) { map[field] = headerCells.indexOf(th); break; }
      }
    });
    return map;
  }

  function scrapeVisibleRows(table, colMap) {
    return [...table.querySelectorAll("tbody tr")].map((tr) => {
      const cells = tr.querySelectorAll("td");
      const rec = {};
      Object.keys(colMap).forEach((field) => {
        const cell = cells[colMap[field]];
        rec[field] = cell ? cell.textContent.trim().replace(/\s+/g, " ") : "";
      });
      return rec;
    }).filter((r) => r.groupNumber);
  }

  // ── Pagination ────────────────────────────────────────────────────────
  function findNextButton(table) {
    const scopes = [table.closest(".p-datatable") || table.parentElement, document];
    for (const scope of scopes) {
      if (!scope) continue;
      let btn = scope.querySelector(".p-paginator-next");
      if (btn) return btn;
      btn = [...scope.querySelectorAll("button, a")].find((b) =>
        /next/i.test(b.getAttribute("aria-label") || "") || /next/i.test(b.title || ""));
      if (btn) return btn;
    }
    return null;
  }

  function isDisabled(btn) {
    if (!btn) return true;
    return btn.disabled === true || btn.hasAttribute("disabled")
      || btn.classList.contains("p-disabled") || btn.getAttribute("aria-disabled") === "true";
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // Waits for the table's first row to actually change after a pagination
  // click (Angular re-renders async) instead of a blind fixed delay.
  async function waitForTableChange(table, prevFirstRowText, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(120);
      const firstRow = table.querySelector("tbody tr");
      const text = firstRow ? firstRow.textContent.trim() : "";
      if (text && text !== prevFirstRowText) return true;
    }
    return false;
  }

  function setStatus(patch) {
    chrome.storage.local.get(["groupsFetchStatus"], (res) => {
      chrome.storage.local.set({ groupsFetchStatus: { ...(res.groupsFetchStatus || {}), ...patch } });
    });
  }

  const MAX_PAGES = 400; // safety cap so a stuck paginator can't loop forever

  async function fetchAllGroups() {
    if (!premiumOK()) {
      setStatus({ running: false, done: true, error: "Groups Export isn't included in your current license." });
      return;
    }
    const table = findGroupsTable();
    if (!table) {
      log.warn(TAG, "no Groups List table found on this page");
      setStatus({ running: false, done: true, error: "Open the Groups List page in Masar first, then try again." });
      return;
    }
    const colMap = mapColumns(table);
    log.info(TAG, "column map:", JSON.stringify(colMap));
    if (!("groupNumber" in colMap) || !("groupName" in colMap)) {
      setStatus({ running: false, done: true, error: "Couldn't recognize the Groups List columns — the page layout may have changed." });
      return;
    }

    const all = [];
    const seen = new Set();
    let page = 1;
    setStatus({ running: true, done: false, page, rows: 0, error: "" });

    while (page <= MAX_PAGES) {
      const rows = scrapeVisibleRows(table, colMap);
      let added = 0;
      for (const r of rows) {
        if (seen.has(r.groupNumber)) continue;
        seen.add(r.groupNumber);
        all.push(r);
        added++;
      }
      log.info(TAG, `page ${page}: scraped ${rows.length} row(s), ${added} new (total ${all.length})`);
      setStatus({ page, rows: all.length });

      const nextBtn = findNextButton(table);
      if (isDisabled(nextBtn)) { log.info(TAG, "reached the last page"); break; }
      const firstRowText = (table.querySelector("tbody tr") || {}).textContent || "";
      nextBtn.click();
      const changed = await waitForTableChange(table, firstRowText.trim(), 6000);
      if (!changed) { log.warn(TAG, "table didn't change after clicking Next — stopping"); break; }
      page++;
    }

    chrome.storage.local.set({ groupsRawRows: all }, () => {
      setStatus({ running: false, done: true, page, rows: all.length });
      log.info(TAG, `done — ${all.length} group(s) fetched`);
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "FETCH_GROUPS") {
      fetchAllGroups();
      sendResponse({ ok: true });
      return true;
    }
  });
})();
