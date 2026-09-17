(function () {
  "use strict";

  // Masar Create-Group automation — Phase 4 of the WhatsApp automation
  // pipeline. Content script for masar.nusuk.sa.
  //
  // Confirmed live 2026-09-17 (real screenshots, not just narration this
  // time): Step 1 (Group Information) -> Next -> "Add From Mutamer List"
  // (checkbox per row, columns include Passport Number, an "Add" button
  // confirms the selection and itself advances to the next step) ->
  // "assign Group guide" (ONE radio per row, no checkbox; Masar itself only
  // lists pilgrims 18+ here — no gender column at all, so guide preference
  // is decided from OUR OWN OCR-derived `sex` per mutamer, passed in by the
  // caller, not read off this page) -> an optional Select Package section ->
  // final review page ("Create Group" heading, Group Data/Mutamer List/
  // Programs panels, Previous/Save buttons) -> Save. Every step still throws
  // a specific, readable error rather than guessing if the real page doesn't
  // match this.

  const wlog = (m) => { try { (window.nkLog || console.log)("[Nuskomate MasarGroup] " + m); } catch (_) { console.log(m); } };

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
  // still equals just the label) — only a plain div/span still requires
  // zero children, to avoid matching some big ancestor container that
  // merely CONTAINS the target text alongside a lot of other content.
  function findByExactText(text, root = document) {
    return Array.from(root.querySelectorAll("button, a, div, span"))
      .find((e) => {
        if ((e.textContent || "").trim() !== text || !isVisible(e)) return false;
        return e.tagName === "BUTTON" || e.tagName === "A" || e.children.length === 0;
      }) || null;
  }

  const CREATE_GROUP_PATH = "/umrah/mutamer-group/add-group/create-group";

  async function goToCreateGroupPage() {
    if (location.pathname === CREATE_GROUP_PATH) return;
    location.href = "https://masar.nusuk.sa" + CREATE_GROUP_PATH;
    const ok = await waitFor(() => location.pathname === CREATE_GROUP_PATH, { timeout: 20000 });
    if (!ok) throw new Error("Could not reach the Create Group page.");
    await sleep(1000);
  }

  // ── Step 1: Group Information ────────────────────────────────────────────
  // Confirmed live 2026-09-17 (real HTML, not guessed): the Group Name field
  // is `input[formcontrolname="groupName"]` — matching by that instead of
  // the old "find a label, then look nearby" approach, which never found it
  // on this page (that approach is also why the Next-click never ran: this
  // function threw before ever reaching it).
  async function fillGroupInfo(groupName, notes) {
    const nameInput = await waitFor(() => document.querySelector('input[formcontrolname="groupName"]'), { timeout: 15000 });
    if (!nameInput) throw new Error('Group Name field (input[formcontrolname="groupName"]) not found on the Create Group page.');
    if (typeof window.simulateAngularInput === "function") window.simulateAngularInput(nameInput, groupName);
    else {
      nameInput.value = groupName;
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      nameInput.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await sleep(300);

    // Notes isn't currently passed by the real pipeline (whatsapp-pipeline.js
    // never sets it) — best-effort only, harmless either way if this guess
    // at the control name is wrong since it's silently skipped.
    if (notes) {
      const notesInput = document.querySelector('textarea[formcontrolname="notes"], input[formcontrolname="notes"]');
      if (notesInput) {
        if (typeof window.simulateAngularInput === "function") window.simulateAngularInput(notesInput, notes);
        else { notesInput.value = notes; notesInput.dispatchEvent(new Event("input", { bubbles: true })); }
      }
    }

    // Consulate is confirmed (via a prior live walkthrough) to auto-select
    // itself — nothing to do here, just give it a moment to settle before
    // advancing.
    await sleep(1500);
  }

  // ── Generic "primary action button" finder — same anchor-on-"Save for
  // later"-or-known-labels approach as modules/masar-add-mutamer.js, since
  // this wizard's action bar wasn't confirmed to use real <button> tags
  // either, and its exact labels per step aren't confirmed. ──
  function findPrimaryActionButton() {
    const saveForLater = findByExactText("Save for later");
    if (saveForLater) {
      const bar = saveForLater.closest("div")?.parentElement || saveForLater.parentElement;
      if (bar) {
        const candidates = Array.from(bar.querySelectorAll("button, a, div, span"))
          .filter((el) => el !== saveForLater && el.children.length === 0 &&
                           (el.textContent || "").trim().length > 0 && isVisible(el));
        if (candidates.length) return candidates[candidates.length - 1];
      }
    }
    for (const label of ["Next", "Create", "Confirm", "Finish", "Submit"]) {
      const el = findByExactText(label);
      if (el) return el;
    }
    return null;
  }

  async function clickNextAndWaitForChange() {
    const btn = await waitFor(findPrimaryActionButton, { timeout: 10000 });
    if (!btn) throw new Error("Could not find the group wizard's Next/Confirm button.");
    if (btn.disabled) throw new Error("The group wizard's Next button is disabled — a required field is likely still empty.");
    const before = document.body.innerText;
    btn.click();
    const changed = await waitFor(() => document.body.innerText !== before, { timeout: 10000 });
    if (!changed) throw new Error("Clicked Next but the page didn't change — it may be silently failing validation.");
  }

  // Finds the <tr> whose Passport Number cell exactly matches `pno` — used
  // by both the "Add From Mutamer List" checkbox step and the guide radio
  // step, since both are real PrimeNG-style tables with one <td> per column.
  function findRowByPassportNo(pno) {
    return Array.from(document.querySelectorAll("tr"))
      .find((row) => Array.from(row.querySelectorAll("td")).some((td) => (td.textContent || "").trim() === pno)) || null;
  }

  function selectedMutamerCount() {
    const m = document.body.innerText.match(/Selected mutamers\s*:\s*(\d+)\s*\/\s*\d+/i);
    return m ? parseInt(m[1], 10) : null;
  }

  // ── Step 2: "Add From Mutamer List" — a checkbox per row; a separate
  // "Add" button confirms the selection IN PLACE — it does NOT itself
  // advance the wizard (corrected after live testing; the caller still
  // clicks a normal Next afterward).
  //
  // Clicks the real input[type="checkbox"] directly — confirmed working
  // this way by the user's own proven bookmarklet doing the exact same
  // thing on this exact page (`if (!cb.checked) cb.click()`). An earlier
  // attempt here guessed that PrimeNG's `.p-checkbox-box` needed to be the
  // click target instead (a real pattern in PrimeNG generally, just not the
  // right call for THIS page) — worth remembering if a future PrimeNG grid
  // elsewhere in Masar doesn't respond to a direct input click: check
  // empirically (a bookmarklet is a fast way to do that) rather than
  // assuming either way. ──
  // Clicks a row's checkbox and RETRIES with growing delays if the page's
  // own counter doesn't move — a bare single click risks firing before
  // Angular has actually finished wiring up that row's binding, even though
  // the DOM node already visually exists (this table's data loads via an
  // API call once this step renders, and PrimeNG/Angular's own click
  // handling can lag a moment behind the initial markup appearing).
  async function clickCheckboxWithRetry(input, expectedCountAfter) {
    for (const delayMs of [0, 600, 1500, 3000]) {
      if (delayMs) await sleep(delayMs);
      if (!input.checked) input.click();
      const moved = await waitFor(() => selectedMutamerCount() === expectedCountAfter, { timeout: 800 });
      if (moved) return true;
    }
    return selectedMutamerCount() === expectedCountAfter;
  }

  async function selectMutamers(passportNumbers) {
    await waitFor(() => document.querySelectorAll('input[type="checkbox"]').length > 0, { timeout: 15000 });
    await sleep(1500); // let the SPA finish loading + rendering this step's row data before touching anything
    const missing = [];
    const failed = [];
    let expected = 0;
    for (const pno of passportNumbers) {
      const row = findRowByPassportNo(pno);
      const input = row && row.querySelector('input[type="checkbox"]');
      if (!input) { missing.push(pno); continue; }
      if (input.checked) { expected++; continue; }
      expected++;
      const ok = await clickCheckboxWithRetry(input, expected);
      if (!ok) failed.push(pno);
    }
    if (missing.length) {
      throw new Error(`Could not find these mutamers in the "Add From Mutamer List" table (by passport number): ${missing.join(", ")}`);
    }
    if (failed.length) {
      throw new Error(`Selected the others, but these never registered on the page's own "Selected mutamers" counter after several retries: ${failed.join(", ")}.`);
    }

    // Final cross-check against the page's own "Selected mutamers : N /50
    // mutamer" counter, in case something above raced.
    const counterMatched = await waitFor(() => selectedMutamerCount() === expected, { timeout: 3000 });
    if (!counterMatched) {
      throw new Error(`Selected ${expected} passport(s), but the page's own "Selected mutamers" counter shows ${selectedMutamerCount()} — something didn't register.`);
    }

    const addBtn = await waitFor(() => findByExactText("Add"), { timeout: 5000 });
    if (!addBtn) throw new Error('Selected the mutamers, but could not find the "Add" button to confirm the selection.');
    if (addBtn.disabled) throw new Error('The "Add" button is disabled — the selection may not have registered.');
    const before = document.body.innerText;
    addBtn.click();
    const changed = await waitFor(() => document.body.innerText !== before, { timeout: 10000 });
    if (!changed) throw new Error('Clicked "Add" but the page didn\'t change — it may be silently failing.');
  }

  // Confirmed real HTML: <button class="mutamer-group__btn mutamer-group__btn--next"> Next </button>.
  // Same timing class of bug as the checkboxes — clicking it once right
  // after "Add" isn't reliable, most likely because Angular hasn't finished
  // settling the just-confirmed selection yet (the button may still be
  // effectively unready even though it already exists in the DOM). Retries
  // with growing delays, verified against the one thing we know for certain
  // marks real success: the guide step's radio inputs actually appearing —
  // NOT a generic "did the text change" check, which can pass on a trivial
  // re-render without genuinely having advanced.
  async function clickNextIntoGuideStep() {
    for (const delayMs of [0, 600, 1500, 3000]) {
      if (delayMs) await sleep(delayMs);
      const btn = findByExactText("Next");
      if (!btn || btn.disabled) continue;
      btn.click();
      const reached = await waitFor(() => document.querySelectorAll('input[type="radio"]').length > 0, { timeout: 1500 });
      if (reached) return;
    }
    throw new Error('Clicked "Next" after adding mutamers (or it stayed missing/disabled) several times, but never reached the guide-selection step (no radio inputs ever appeared).');
  }

  // ── Step 3: pick a group leader ──────────────────────────────────────────
  // Rule (confirmed by the user): prefer any adult male; otherwise any other
  // known mutamer; never guess at a child. Masar's OWN guide list only ever
  // shows pilgrims 18+ ("Only pilgrims over 18 years old will be shown" —
  // confirmed live), so every row here is already an adult — this never
  // needs to filter by age itself. It also shows NO gender column at all, so
  // `mutamers[].sex` (captured back when each was fed via OCR/MRZ — see
  // whatsapp-pipeline.js) is the only source of that information; a row is
  // matched to a mutamer by passport number, same as step 2.
  async function pickGroupLeader(mutamers) {
    await waitFor(() => document.querySelectorAll('input[type="radio"]').length > 0, { timeout: 15000 });
    await sleep(1500); // same reasoning as selectMutamers — give Angular a real moment to finish wiring this step up

    const withRow = mutamers
      .filter((m) => m.passportNo)
      .map((m) => ({ ...m, row: findRowByPassportNo(m.passportNo) }))
      .filter((m) => m.row);
    if (!withRow.length) {
      throw new Error("None of this group's passport numbers appear as selectable group-leader candidates — either the row match is wrong, or every one of them was filtered out (e.g. all under 18).");
    }

    const chosen = withRow.find((m) => m.sex === "Male") || withRow[0];
    // Same as selectMutamers — click the real radio input directly, retrying
    // with growing delays if it doesn't take right away.
    const input = chosen.row.querySelector('input[type="radio"]');
    if (!input) throw new Error(`Found ${chosen.passportNo}'s row but no radio input in it.`);
    let picked = input.checked;
    for (const delayMs of [0, 600, 1500, 3000]) {
      if (picked) break;
      if (delayMs) await sleep(delayMs);
      if (!input.checked) input.click();
      picked = await waitFor(() => !!input.checked, { timeout: 800 });
    }
    if (!picked) throw new Error(`Clicked ${chosen.passportNo}'s radio as group leader several times, but it never reported checked.`);
  }

  // ── After the guide is picked, whatever remains (an optional Select
  // Package section, etc.) until the final review page — identified by its
  // own "Save" button, confirmed live — is reached. Bounded, since this
  // wasn't confirmed to be exactly one click or several. ──
  async function advanceUntilReviewPage({ maxClicks = 4 } = {}) {
    for (let i = 0; i < maxClicks; i++) {
      const saveBtn = findByExactText("Save");
      if (saveBtn && isVisible(saveBtn)) return true;
      await clickNextAndWaitForChange();
    }
    const saveBtn = findByExactText("Save");
    return !!(saveBtn && isVisible(saveBtn));
  }

  // ── Final review page — click Save. ──────────────────────────────────────
  async function saveGroup() {
    const saveBtn = await waitFor(() => findByExactText("Save"), { timeout: 10000 });
    if (!saveBtn) throw new Error('Could not find the final "Save" button on the group review page.');
    if (saveBtn.disabled) throw new Error('The "Save" button is disabled — the page\'s own "Some data is incomplete" banner likely means a required field is still missing.');
    saveBtn.click();
    const left = await waitFor(() => location.pathname !== CREATE_GROUP_PATH, { timeout: 15000 });
    return !!left;
  }

  async function createGroup({ groupName, notes, mutamers }) {
    if (!groupName) throw new Error("groupName is required.");
    if (!Array.isArray(mutamers) || !mutamers.length) throw new Error("mutamers (non-empty array of {passportNo, sex?}) is required.");
    const passportNumbers = mutamers.map((m) => m.passportNo).filter(Boolean);
    if (!passportNumbers.length) throw new Error("None of the given mutamers have a passport number.");

    await goToCreateGroupPage();
    await fillGroupInfo(groupName, notes);
    await clickNextAndWaitForChange(); // Group Information -> Add From Mutamer List

    await selectMutamers(passportNumbers); // checks boxes + clicks "Add" to confirm the selection
    await clickNextIntoGuideStep(); // Add From Mutamer List -> assign Group guide

    await pickGroupLeader(mutamers);

    const reachedReview = await advanceUntilReviewPage();
    if (!reachedReview) throw new Error("Never reached the final review page (no \"Save\" button found) after picking a group leader.");

    const submitted = await saveGroup();
    return { ok: true, submitted, groupName };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "nkMasarCreateGroup") return;
    createGroup(msg)
      .then((result) => { wlog(`create group "${msg.groupName}" → ${JSON.stringify(result)}`); sendResponse(result); })
      .catch((err) => {
        const message = (err && (err.message || err.name)) || String(err) || "Unknown error";
        console.error("[Nuskomate MasarGroup] failed:", err);
        wlog(`create group "${msg.groupName}" FAILED: ${message}`);
        sendResponse({ ok: false, error: message });
      });
    return true;
  });
})();
