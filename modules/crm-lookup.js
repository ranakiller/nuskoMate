(function () {
  "use strict";

  // CRM Lookup — content script for setup.nebraspk.com (the "Nebras" eTravel
  // CRM 14, a DevExpress XAF web app). Phase 1 of the WhatsApp automation
  // pipeline: given a reservation number, log in if needed, search for it,
  // and report back its status + key details. See the project's WhatsApp
  // automation plan memory for the full pipeline this feeds into — this file
  // deliberately does nothing beyond looking a reservation up (no Masar
  // feeding, no WhatsApp replies) so it can be tested completely on its own.

  const wlog = (m) => { try { (window.nkLog || console.log)("[Nuskomate CRM] " + m); } catch (_) { console.log(m); } };

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // Poll until `check()` returns a truthy value, or time out.
  async function waitFor(check, { timeout = 15000, interval = 250 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const v = check();
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

  function isOnLoginPage() {
    return /Login\.aspx/i.test(location.pathname);
  }

  function getCreds() {
    return new Promise((r) => chrome.storage.local.get(["crmUsername", "crmPassword"], (res) =>
      r({ username: (res.crmUsername || "").trim(), password: res.crmPassword || "" })
    ));
  }

  async function login() {
    const { username, password } = await getCreds();
    if (!username || !password) throw new Error("No CRM credentials saved (Settings → CRM Login).");

    const userInp = await waitFor(() => document.querySelector("input[name$='UserName_Edit']"));
    const passInp = document.querySelector("input[name$='Password_Edit']");
    if (!userInp || !passInp) throw new Error("Login form not found — the CRM page layout may have changed.");

    userInp.value = username;
    userInp.dispatchEvent(new Event("input", { bubbles: true }));
    passInp.value = password;
    passInp.dispatchEvent(new Event("input", { bubbles: true }));

    const loginBtn = document.getElementById("Logon_PopupActions_Menu_DXI0_T");
    if (!loginBtn) throw new Error("Login button not found.");
    loginBtn.click();

    const loggedIn = await waitFor(() => !isOnLoginPage(), { timeout: 20000 });
    if (!loggedIn) throw new Error("Login did not complete (wrong credentials, or the CRM is slow to respond).");
    await sleep(1000); // let the dashboard shell finish rendering
  }

  // Jump straight to the Reservations list via its hash route instead of
  // clicking through the left-nav tree — no toggle-state to get wrong (the
  // nav-click approach had a real bug: "Groups" is a collapse/expand toggle,
  // and clicking it unconditionally could COLLAPSE an already-expanded tree,
  // hiding "Reservations" instead of revealing it). Setting location.hash on
  // a page that's already loaded and running fires a real hashchange event
  // this SPA reacts to correctly — that's different from (and more reliable
  // than) loading this hash on a brand-new page load, which this app does
  // NOT reliably pick up.
  const RESERVATION_LIST_HASH = "ViewID=UmrReservation_ListView&ObjectClassName=eCRM.Module.BusinessObjects.UMR.UmrReservation";

  // DevExpress XAF names this control `Vertical$v2_46420132$LE_v2$DXSE` —
  // the "v2"/"v3" AND the numeric segment in the middle are NOT stable
  // across sessions/navigations (confirmed live: this exact selector worked
  // once, then broke on a later session with the same page reached the same
  // way — only the "vN" component had changed). Match on the one part that
  // is stable instead: the trailing "$DXSE"/"_DXSE_I" search-panel suffix,
  // present regardless of whatever XAF's per-session view counter is.
  function getSearchBox() {
    return document.querySelector('input[id$="_DXSE_I"]') || document.querySelector("input[name$='\\$DXSE']");
  }

  function isOnReservationList() {
    return !!getSearchBox();
  }

  async function goToReservationList() {
    if (isOnReservationList()) return;
    location.hash = RESERVATION_LIST_HASH;
    const ok = await waitFor(() => isOnReservationList(), { timeout: 15000 });
    if (!ok) throw new Error("Could not reach the Reservations list via hash navigation.");
    await sleep(500);
  }

  // The reservation list defaults to a "[Reservation Date] >= today" filter
  // that hides most reservations (confirmed: 19 of 3676 shown with it on).
  // Must clear it before every search, or older reservations wrongly read as
  // "not found".
  async function clearDateFilter() {
    const link = Array.from(document.querySelectorAll("a")).find(
      (a) => (a.innerText || "").trim() === "Clear" &&
             a.closest("div,td")?.parentElement?.innerText?.includes("LocalDateTimeToday")
    );
    if (link) {
      link.click();
      await sleep(1500);
    }
  }

  // "9P 28SEP-18OCT LHE-JED-LHE GROUP" → { arrival, departure, route }
  function parsePackage(pkg) {
    if (!pkg) return null;
    const m = /(\d{1,2}[A-Z]{3})-(\d{1,2}[A-Z]{3})\s+([A-Z]{3}(?:-[A-Z]{3})+)/.exec(pkg);
    if (!m) return null;
    return { arrival: m[1], departure: m[2], route: m[3].split("-").join(" ") };
  }

  // Fire a full, realistic keydown+keypress+keyup sequence for Enter. A lone
  // synthetic "keydown" is often ignored by older ASP.NET/DevExpress client
  // handlers (some check event.which/charCode, which only a keypress event
  // carries) — matches the lesson already learned with Masar's own OCR
  // listener needing more than a bare synthetic event.
  function fireEnter(el) {
    const opts = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 };
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keypress", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  async function lookupReservation(reservationNo) {
    if (isOnLoginPage()) await login();
    await goToReservationList();
    await clearDateFilter();

    const box = getSearchBox();
    if (!box) throw new Error("Search box not found after navigating to Reservations.");
    box.focus();
    box.value = reservationNo;
    box.dispatchEvent(new Event("input", { bubbles: true }));
    fireEnter(box);

    const bareNo = reservationNo.replace(/^UR-?/i, "");

    // Wait for an ACTUAL result row to exist, identified the reliable way —
    // see findDataRows()'s comment for why. Two earlier attempts both
    // guessed at distinguishing "real row" from "header/filter row" using
    // page TEXT (a before/after diff, then a strict-format regex, then a
    // header-label majority vote) and all three broke on real DOM structure
    // the user then shared directly: a deep `querySelectorAll("td")` over
    // the header row was quietly pulling in a NESTED table's cells too
    // (each header cell wraps its label + sort/filter icon in its own
    // mini-table), desyncing any index-based header↔data mapping — that
    // was the actual root cause the whole time, not a text-matching issue.
    const result = await waitFor(() => {
      if (document.body.innerText.includes("No data to display")) return "none";
      const row = findDataRows().find((r) => r.innerText.includes(bareNo));
      return row || null;
    }, { timeout: 15000, interval: 300 });

    if (!result || result === "none") return { ok: true, found: false, reservationNo };

    await sleep(300); // let the row's own cells finish settling right after it first appears
    const headerRow = findHeaderRow();
    const detail = extractRowFields(result, headerRow);

    return {
      ok: true,
      found: true,
      reservationNo,
      status: detail.status,
      familyHead: detail.familyHead,
      customer: detail.customer,
      groupCode: detail.groupCode,
      packageCode: detail.packageCode,
      package: detail.package,
      parsedPackage: parsePackage(detail.package),
      pax: detail.pax,
    };
  }

  // Everything the pipeline needs (Status/Family Head/Group Title/PAX/...)
  // is already visible directly in this grid row — a double-click into the
  // Detail View to scrape it there (the original approach) was fragile and
  // ended up returning nulls for everything except Status.
  //
  // Real markup (confirmed live by the user): both the header row and every
  // result row carry a STABLE id suffix regardless of the random numeric
  // prefix DevExpress assigns per session — "..._DXHeadersRow0" and
  // "..._DXDataRowN". Far more reliable than scanning every <tr> on the
  // page and guessing from text content, which is what every earlier
  // attempt here did (a before/after text diff, then a strict-format regex,
  // then a header-label majority vote) and which kept accidentally matching
  // the grid's own header row instead of real data.
  //
  // Also confirmed live: each header cell wraps its label in its OWN nested
  // <table> (for the sort/filter icon), while data cells don't — so a DEEP
  // `querySelectorAll("td")` over the header row was pulling in those
  // nested cells too, desyncing the header↔data index mapping. That
  // mismatch — not any text-matching issue — was the actual root cause the
  // whole time. Using only DIRECT <td> children of each row keeps both
  // rows' cell counts and order aligned 1:1 (confirmed: 30 direct cells in
  // both, same order); `.innerText` on each direct header cell still
  // correctly reads through to its nested label as one string.
  function findHeaderRow() {
    return document.querySelector('tr[id*="_DXHeadersRow"]');
  }
  function findDataRows() {
    return Array.from(document.querySelectorAll('tr[id*="_DXDataRow"]'));
  }
  function directCellTexts(row) {
    return Array.from(row.children)
      .filter((c) => c.tagName === "TD")
      .map((td) => (td.innerText || "").trim());
  }

  function extractRowFields(row, headerRow) {
    const cellTexts = directCellTexts(row);
    const headers = headerRow ? directCellTexts(headerRow) : [];
    const byHeader = {};
    headers.forEach((h, i) => { if (h && cellTexts[i] !== undefined && cellTexts[i] !== "") byHeader[h] = cellTexts[i]; });

    const paxNum = parseInt(byHeader["PAX"], 10);

    return {
      status: byHeader["Status"] || null,
      familyHead: byHeader["Family Head"] || null,
      customer: byHeader["Customer"] || null,
      groupCode: byHeader["Group Code"] || null,
      packageCode: byHeader["Package Code"] || null,
      package: byHeader["Group Title"] || null,
      pax: Number.isFinite(paxNum) ? paxNum : null,
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "nkCrmLookupReservation") return;
    lookupReservation(String(msg.reservationNo || "").trim())
      .then((result) => { wlog(`lookup ${msg.reservationNo} → ${JSON.stringify(result)}`); sendResponse(result); })
      .catch((err) => {
        // Guaranteed non-empty message, whatever got thrown (a real Error,
        // a DOMException, or something else entirely) — a response with no
        // error text at all is worse than a vague one, since it leaves no
        // clue to debug from.
        const message = (err && (err.message || err.name)) || String(err) || "Unknown error";
        console.error("[Nuskomate CRM] lookup failed:", err); // full object + stack, for the tab's own DevTools console
        wlog(`lookup ${msg.reservationNo} FAILED: ${message}`);
        sendResponse({ ok: false, error: message });
      });
    return true; // async response
  });
})();
