(function () {
  "use strict";

  const pendingSelections = new Set();

  window.sharedDropdownHandler = function (dropdownSelector, matchText) {
    const el = document.querySelector(dropdownSelector);
    if (!el || !matchText) return;

    const label = el.querySelector(".p-dropdown-label");
    if (!label) return;

    const wantedText = matchText.toLowerCase();
    if (label.textContent.trim().toLowerCase().includes(wantedText)) return;

    const pendingKey = `${dropdownSelector}::${wantedText}`;
    if (pendingSelections.has(pendingKey)) return;
    pendingSelections.add(pendingKey);

    label.click();

    const observer = new MutationObserver((mutations, obs) => {
      const listItems = document.querySelectorAll('ul[role="listbox"] li');
      for (const li of listItems) {
        if (li.textContent.trim().toLowerCase().includes(wantedText)) {
          li.click();
          li.dispatchEvent(new Event("click", { bubbles: true }));
          pendingSelections.delete(pendingKey);
          obs.disconnect();
          return;
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      pendingSelections.delete(pendingKey);
      observer.disconnect();
    }, 3000);
  };
})();
