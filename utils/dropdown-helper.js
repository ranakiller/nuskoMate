(function () {
  "use strict";

  // PrimeNG only keeps ONE dropdown overlay open at a time — opening a second
  // dropdown instantly closes the first. The autofill module asks for several
  // dropdowns at once (passport type, birth country, marital status, mobile
  // code), so if we open them concurrently the earlier ones get their overlay
  // closed before we can click the option (Passport Type was the usual victim).
  //
  // So we SERIALIZE: only one dropdown is opened/selected at a time; the rest
  // queue and run after it finishes. Each dropdown therefore behaves exactly
  // the same, reliably.

  const queuedKeys = new Set(); // selector::text currently waiting or in-flight
  const queue = [];             // [{ selector, wantedText, key }]
  let active = false;

  function labelOf(selector) {
    const el = document.querySelector(selector);
    return el ? el.querySelector(".p-dropdown-label") : null;
  }

  function isSelected(selector, wantedText) {
    const label = labelOf(selector);
    return !!(label && label.textContent.trim().toLowerCase().includes(wantedText));
  }

  function pickOption(wantedText) {
    const items = document.querySelectorAll('ul[role="listbox"] li');
    for (const li of items) {
      if (li.textContent.trim().toLowerCase().includes(wantedText)) {
        li.click();
        li.dispatchEvent(new Event("click", { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  function processNext() {
    if (active) return;
    const job = queue.shift();
    if (!job) return;
    active = true;

    const finish = () => {
      queuedKeys.delete(job.key);
      active = false;
      // Small gap so the just-closed overlay doesn't collide with the next open.
      setTimeout(processNext, 150);
    };

    const label = labelOf(job.selector);
    if (!label) { finish(); return; }                                   // dropdown not in DOM
    if (label.textContent.trim().toLowerCase().includes(job.wantedText)) { finish(); return; } // already set

    label.click(); // open this dropdown's overlay

    // Options may already be rendered — try immediately, then watch for them.
    if (pickOption(job.wantedText)) { finish(); return; }

    let done = false;
    const obs = new MutationObserver(() => {
      if (done) return;
      if (pickOption(job.wantedText)) { done = true; obs.disconnect(); finish(); }
    });
    obs.observe(document.body, { childList: true, subtree: true });

    // Give up on this one after a moment and move on (don't block the queue).
    setTimeout(() => {
      if (done) return;
      done = true;
      obs.disconnect();
      finish();
    }, 2500);
  }

  window.sharedDropdownHandler = function (dropdownSelector, matchText) {
    if (!dropdownSelector || !matchText) return;
    const wantedText = matchText.toLowerCase();
    if (isSelected(dropdownSelector, wantedText)) return;     // nothing to do
    const key = `${dropdownSelector}::${wantedText}`;
    if (queuedKeys.has(key)) return;                          // already queued / in-flight
    queuedKeys.add(key);
    queue.push({ selector: dropdownSelector, wantedText, key });
    processNext();
  };
})();
