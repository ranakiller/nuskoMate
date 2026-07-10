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

  const queuedKeys = new Set(); // key currently waiting or in-flight
  const queue = [];             // [{ root|selector, wantedText, key }]
  let active = false;

  // Resolve the clickable ".p-dropdown-label" from either a container element,
  // the label itself, or a CSS selector. Callers pass different things:
  //   • autofill passes  p-dropdown[formcontrolname="…"]  (a container)
  //   • the Auto Select rule captures the label <span> directly (it IS the label)
  //   • either may pass the wrapping .p-dropdown div
  // so we accept all three shapes here.
  function labelFromRoot(root) {
    if (!root || !root.classList) return null;
    if (root.classList.contains("p-dropdown-label")) return root;      // root IS the label
    return root.querySelector ? root.querySelector(".p-dropdown-label") : null;
  }
  function resolveRoot(job) {
    return job.root || (job.selector ? document.querySelector(job.selector) : null);
  }
  function labelOf(job) {
    return labelFromRoot(resolveRoot(job));
  }

  function isSelectedLabel(label, wantedText) {
    return !!(label && label.textContent.trim().toLowerCase().includes(wantedText));
  }

  function pickOption(wantedText) {
    const items = [...document.querySelectorAll('ul[role="listbox"] li')];
    // Prefer an EXACT match so a dial code like "+44" can't match "+441"
    // (Bermuda etc.); fall back to a substring match for partial labels
    // (e.g. "pakistan" inside "Pakistan (PK)").
    const norm = (li) => li.textContent.trim().toLowerCase();
    const target = items.find((li) => norm(li) === wantedText)
                || items.find((li) => norm(li).includes(wantedText));
    if (target) {
      target.click();
      target.dispatchEvent(new Event("click", { bubbles: true }));
      return true;
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

    const label = labelOf(job);
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

  function enqueue(job) {
    if (queuedKeys.has(job.key)) return;                      // already queued / in-flight
    queuedKeys.add(job.key);
    queue.push(job);
    processNext();
  }

  // Selector-based (used by autofill, which passes a p-dropdown container).
  window.sharedDropdownHandler = function (dropdownSelector, matchText) {
    if (!dropdownSelector || !matchText) return;
    const wantedText = matchText.toLowerCase();
    const label = labelFromRoot(document.querySelector(dropdownSelector));
    if (isSelectedLabel(label, wantedText)) return;           // nothing to do
    enqueue({ selector: dropdownSelector, wantedText, key: `${dropdownSelector}::${wantedText}` });
  };

  // Element-based (used by the Auto Select rule / workflow steps, where we
  // already have the matched element — which may be the label span itself).
  let elSeq = 0;
  window.sharedDropdownHandlerEl = function (rootEl, matchText) {
    if (!rootEl || !matchText) return;
    const wantedText = matchText.toLowerCase();
    const label = labelFromRoot(rootEl);
    if (isSelectedLabel(label, wantedText)) return;           // nothing to do
    // The element has no stable string key, so tag it once for dedupe.
    if (!rootEl.__nkDdId) rootEl.__nkDdId = "el" + (++elSeq);
    enqueue({ root: rootEl, wantedText, key: `${rootEl.__nkDdId}::${wantedText}` });
  };
})();
