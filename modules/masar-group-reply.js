(function () {
  "use strict";

  // Masar Group Reply Assets — Phase 5 of the WhatsApp automation pipeline.
  // Content script for masar.nusuk.sa. Opens a group (newest, or matched by
  // name), switches to its "Mutamers List" tab, and produces the two things
  // the WhatsApp reply needs: a formatted caption (reusing modules/talab-
  // copy.js's Scenario B — see window.nkBuildMutamerListText, exposed there
  // for exactly this) and a screenshot of just the first 5 columns (mutamer
  // picture through nationality), reusing the Element Screenshot capture
  // pipeline in background.js via a "return the data instead of downloading/
  // copying/opening it" mode added there for this.
  //
  // Honesty note: opening a specific group row and the exact "Mutamers List"
  // tab click were described in a walkthrough, not inspected in full DOM
  // detail (the row's own icon-button markup wasn't shared) — built
  // generically (first clickable control in the row) with a clear error if
  // that assumption doesn't hold, same philosophy as modules/masar-group.js.

  const wlog = (m) => { try { (window.nkLog || console.log)("[Nuskomate MasarGroupReply] " + m); } catch (_) { console.log(m); } };

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function waitFor(check, { timeout = 15000, interval = 250 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const v = check();
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

  function isVisible(el) {
    return !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  // A real <button>/<a> is still an exact-text match even if it also
  // contains an icon (an SVG child has no text content, so .textContent
  // still equals just the label) — learned the hard way in modules/
  // masar-group.js, applied here pre-emptively since this site's buttons
  // consistently pair an icon with a label. Only a plain div/span still
  // requires zero children, to avoid matching a big ancestor container.
  function findByExactText(text, root = document) {
    return Array.from(root.querySelectorAll("button, a, div, span"))
      .find((e) => {
        if ((e.textContent || "").trim() !== text || !isVisible(e)) return false;
        return e.tagName === "BUTTON" || e.tagName === "A" || e.children.length === 0;
      }) || null;
  }

  // This site (Angular + PrimeNG) does not reliably respond to a single
  // immediate click — same lesson learned in modules/masar-group.js,
  // applied here from the start instead of waiting to hit it again. Re-finds
  // the element fresh on each attempt and only counts it done once
  // `verify()` confirms it, retrying with growing delays.
  //
  // IMPORTANT — only safe for clicks where a repeat is harmless: an element
  // that disappears once it worked (navigating to a new page/tab, this
  // file's two uses), or a genuinely idempotent toggle (switching to a tab
  // that's already active). NOT safe for a checkbox/radio (a second click
  // un-checks what the first one already did) or a non-idempotent submit
  // (Save/Add could double-submit) — a `verify()` that reports false
  // slightly after the real state change already landed would otherwise
  // cause a real, silent regression there, not just a wasted retry.
  async function clickUntilVerified(findEl, verify, { delays = [0, 400, 800, 1500, 3000], verifyTimeout = 1200 } = {}) {
    for (const delayMs of delays) {
      if (delayMs) await sleep(delayMs);
      const el = findEl();
      if (!el || el.disabled) continue;
      el.click();
      const ok = await waitFor(verify, { timeout: verifyTimeout });
      if (ok) return true;
    }
    return false;
  }

  const GROUP_LIST_PATH = "/umrah/mutamer-group/group-list";

  async function goToGroupListPage() {
    if (location.pathname === GROUP_LIST_PATH) return;
    location.href = "https://masar.nusuk.sa" + GROUP_LIST_PATH;
    const ok = await waitFor(() => location.pathname === GROUP_LIST_PATH, { timeout: 20000 });
    if (!ok) throw new Error("Could not reach the Group List page.");
    await sleep(1200);
  }

  function findGroupRow(expectedGroupName) {
    const rows = Array.from(document.querySelectorAll("tr")).filter((r) => r.querySelectorAll("td").length > 1);
    if (expectedGroupName) return rows.find((r) => r.textContent.includes(expectedGroupName)) || null;
    return rows[0] || null; // newest assumed first, per the create-group walkthrough this was built from
  }

  async function openGroup(expectedGroupName) {
    await goToGroupListPage();
    const row = await waitFor(() => findGroupRow(expectedGroupName), { timeout: 15000 });
    if (!row) {
      throw new Error(expectedGroupName
        ? `Group "${expectedGroupName}" not found in the Group List.`
        : "No groups found in the Group List.");
    }
    // Confirmed real HTML: the "view" action is a <div class="p-element
    // flat-row-action"><i class="pi pi-eye"></i></div> — NOT a <button>. The
    // Actions cell also has a "..." menu button (Edit/Delete/Send Group/
    // etc.), which a generic `button, a, [role="button"]` selector matches
    // FIRST since it comes before ever falling back to an icon search — that
    // was the actual bug, opening the wrong control's dropdown instead of
    // the group. The eye icon must be checked first, always.
    const openControl = row.querySelector(".pi-eye")?.closest("div, span, button, a")
      || row.querySelector('button, a, [role="button"]');
    if (!openControl) throw new Error("Could not find a way to open this group row (no eye icon or button found in it).");
    const before = document.body.innerText;
    const opened = await clickUntilVerified(() => openControl, () => document.body.innerText !== before);
    if (!opened) throw new Error("Clicked the group row's icon several times, but the page never changed.");
  }

  async function openMutamersListTab() {
    const findTab = () => findByExactText("Mutamers List") || findByExactText("Mutamer List");
    const ready = await clickUntilVerified(
      findTab,
      () => typeof window.nkIsMutamerListPage === "function" && window.nkIsMutamerListPage(),
      { delays: [0, 400, 800, 1500, 3000], verifyTimeout: 3000 }
    );
    if (!ready) throw new Error("Could not find/click the 'Mutamers List' tab, or the mutamer table never rendered after several tries.");
    await sleep(500);
  }

  function getCaptionText() {
    if (typeof window.nkBuildMutamerListText !== "function") {
      throw new Error("Talab Copy module's text builder isn't available — is modules/talab-copy.js loaded?");
    }
    const built = window.nkBuildMutamerListText();
    if (!built) throw new Error("No mutamers found on the Mutamers List tab — nothing to caption.");
    return built;
  }

  // ── Screenshot: first 5 columns only (picture → nationality) ────────────
  function findMutamerTable() {
    for (const table of document.querySelectorAll("table")) {
      const headerCells = table.querySelectorAll("thead th, thead td");
      if (!headerCells.length) continue;
      if ([...headerCells].some((th) => /passport/i.test(th.textContent))) return table;
    }
    return null;
  }

  // Page-absolute coordinates (viewport rect + current scroll offset) — same
  // convention utils/webshot-picker.js's own selection tool uses, which lets
  // background.js's existing multi-tile capture pipeline scroll to wherever
  // it needs on its own (so a table taller than one screen still works).
  function computeFirst5ColumnsRect(table) {
    const headerRow = table.querySelector("thead tr");
    const bodyRows = Array.from(table.querySelectorAll("tbody tr"));
    if (!headerRow || !bodyRows.length) return null;
    const headerCells = Array.from(headerRow.querySelectorAll("th, td"));
    if (headerCells.length < 5) return null;
    const firstRect = headerCells[0].getBoundingClientRect();
    const fifthRect = headerCells[4].getBoundingClientRect();
    const lastRowRect = bodyRows[bodyRows.length - 1].getBoundingClientRect();
    return {
      x: Math.round(firstRect.left + window.scrollX),
      y: Math.round(firstRect.top + window.scrollY),
      width: Math.round(fifthRect.right - firstRect.left),
      height: Math.round(lastRowRect.bottom - firstRect.top),
    };
  }

  // Minimal stand-in for utils/webshot-picker.js's own prepare/scroll/
  // restore handlers (which only register while its interactive picker is
  // in use) — background.js's capture pipeline sends these exact message
  // types to whichever tab it's capturing regardless of caller, so an
  // automated capture needs something answering them too. Registered only
  // for the duration of one capture call, mirroring that file's own
  // register-then-unregister lifecycle so it never lingers.
  function withCaptureSupport(fn) {
    const origScrollX = window.scrollX, origScrollY = window.scrollY;
    let hidden = null;
    function listener(msg, _sender, sendResponse) {
      if (msg.type === "nkWebshotPrepare") {
        const fixedEls = Array.from(document.querySelectorAll("*")).filter((el) => {
          const cs = getComputedStyle(el);
          return (cs.position === "fixed" || cs.position === "sticky") && el.offsetParent !== null;
        });
        hidden = fixedEls.map((el) => ({ el, prev: el.style.visibility }));
        fixedEls.forEach((el) => { el.style.visibility = "hidden"; });
        sendResponse({ vw: window.innerWidth, vh: window.innerHeight });
        return true;
      }
      if (msg.type === "nkWebshotScrollTo") {
        window.scrollTo(msg.x, msg.y);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          setTimeout(() => sendResponse({ actualX: window.scrollX, actualY: window.scrollY }), 60);
        }));
        return true;
      }
      if (msg.type === "nkWebshotRestore") {
        (hidden || []).forEach(({ el, prev }) => { el.style.visibility = prev; });
        hidden = null;
        window.scrollTo(origScrollX, origScrollY);
        sendResponse({ ok: true });
        return true;
      }
      return false;
    }
    chrome.runtime.onMessage.addListener(listener);
    return fn().finally(() => chrome.runtime.onMessage.removeListener(listener));
  }

  async function captureFirst5ColumnsScreenshot() {
    const table = await waitFor(findMutamerTable, { timeout: 10000 });
    if (!table) throw new Error("Mutamers table not found on the page for screenshotting.");
    const rect = computeFirst5ColumnsRect(table);
    if (!rect) throw new Error("Could not compute a screenshot rect (fewer than 5 columns, or no data rows in the table).");

    return withCaptureSupport(async () => {
      const resp = await chrome.runtime.sendMessage({
        type: "nkWebshotCaptureForAutomation",
        rect,
        dpr: window.devicePixelRatio || 1,
        pageTitle: "Mutamers List",
      });
      if (!resp || !resp.ok) throw new Error((resp && resp.error) || "Screenshot capture failed.");
      return resp.dataUrl;
    });
  }

  async function getGroupReplyAssets({ expectedGroupName } = {}) {
    await openGroup(expectedGroupName);
    await openMutamersListTab();
    const caption = getCaptionText();
    const screenshotDataUrl = await captureFirst5ColumnsScreenshot();
    return {
      ok: true,
      caption: caption.text,
      mutamerCount: caption.count,
      groupName: caption.groupName,
      groupNumber: caption.groupNumber,
      screenshotDataUrl,
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "nkMasarGetGroupReplyAssets") return;
    getGroupReplyAssets(msg)
      .then((result) => { wlog(`assets for "${msg.expectedGroupName || "(newest group)"}" → caption ${result.caption?.length || 0} chars, ${result.mutamerCount} mutamer(s)`); sendResponse(result); })
      .catch((err) => {
        const message = (err && (err.message || err.name)) || String(err) || "Unknown error";
        console.error("[Nuskomate MasarGroupReply] failed:", err);
        wlog(`assets for "${msg.expectedGroupName || "(newest group)"}" FAILED: ${message}`);
        sendResponse({ ok: false, error: message });
      });
    return true;
  });
})();
