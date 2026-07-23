(function () {
  "use strict";

  // Mutamer/Voucher Totals — running total (+ visible row count) injected
  // next to the paginator on whichever pages you configure. Ported from the
  // user's Tampermonkey "Sum mutamer Numbers & Voucher amount" block, which
  // ran unconditionally on every page; this version only runs on the URL(s)
  // configured in the popup tab, and adds a 3rd number (total visible rows)
  // the original didn't have.

  const URLS_KEY = "mvTotalsUrls"; // string[] — substrings matched against location.href

  let moduleEnabled = false;
  let urls = [];

  function urlMatches() {
    if (!urls.length) return false;
    const href = window.location.href;
    return urls.some((u) => u && href.includes(u));
  }

  const INJECTED_SELECTOR = ".mutamer-total-span, .voucher-total-span, .mv-rows-total-span, .custom-paginator-totals";

  // Last written values — Masar's own Angular change detection re-renders
  // the money cells (currency-format pipe) far more often than the actual
  // total changes, which kept firing the observer and rewriting the
  // Voucher line over and over even though the number was identical. Only
  // touch the DOM when a value has genuinely changed.
  let lastRowCount = null;
  let lastMutamerTotal = null;
  let lastFormattedVoucher = null;

  function removeInjected() {
    document.querySelectorAll(INJECTED_SELECTOR).forEach((el) => el.remove());
    lastRowCount = lastMutamerTotal = lastFormattedVoucher = null;
  }

  function calculateAndUpdate() {
    if (!moduleEnabled || !urlMatches()) return;

    let mutamerTotal = 0;
    let voucherTotal = 0;
    const rows = new Set(); // dedup — a row usually has both a mutamer AND a voucher cell

    document.querySelectorAll(
      'td#mutamerNumber span.number_font, td#mutamersCount span.number_font',
    ).forEach((span) => {
      const row = span.closest("tr");
      if (!row) return;
      rows.add(row);
      const statusCell = row.querySelector('td#voucherStatus\\:name, td[id*="voucherStatus"]');
      if (statusCell && statusCell.textContent.toLowerCase().includes("expired")) return;
      const num = parseInt(span.textContent.trim(), 10);
      if (!isNaN(num)) mutamerTotal += num;
    });

    document.querySelectorAll(
      'td[id="total"] span.number_font, td[id="totalPriceWithVat"] span.number_font',
    ).forEach((span) => {
      const row = span.closest("tr");
      if (!row) return;
      rows.add(row);
      const statusCell = row.querySelector('td#voucherStatus\\:name, td[id*="voucherStatus"]');
      if (statusCell && statusCell.textContent.toLowerCase().includes("expired")) return;
      const num = parseFloat(span.textContent.replace(/,/g, ""));
      if (!isNaN(num)) voucherTotal += num;
    });

    // Total visible ROWS — every row counted above, regardless of expired
    // status (expired rows are still visible on the page, just excluded
    // from the money sums above).
    const rowCount = rows.size;

    const formattedVoucher = voucherTotal.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

    const rowsChanged = lastRowCount !== rowCount;
    const mutamerChanged = lastMutamerTotal !== mutamerTotal;
    const voucherChanged = lastFormattedVoucher !== formattedVoucher;
    lastRowCount = rowCount;
    lastMutamerTotal = mutamerTotal;
    lastFormattedVoucher = formattedVoucher;

    /* ---------------- OLD PAGINATOR ---------------- */
    // Order: Rows, then Mutamer Total, then Voucher Total — placed right
    // before the rows-per-page selector (the first control in this
    // paginator's template), matching where the totals sit relative to the
    // paginator on the new layout.
    const oldPaginator = document.querySelector("span.p-paginator-current");
    if (oldPaginator) {
      const container = oldPaginator.closest(".p-paginator") || oldPaginator.parentElement;
      const anchor = container.querySelector(".p-paginator-rpp-options, .p-dropdown") || container.firstElementChild;

      let rowsSpan = container.querySelector(".mv-rows-total-span");
      const rowsIsNew = !rowsSpan;
      if (rowsIsNew) {
        rowsSpan = document.createElement("span");
        rowsSpan.className = "mv-rows-total-span";
        rowsSpan.style.marginRight = "10px";
        rowsSpan.style.fontWeight = "bold";
        anchor.insertAdjacentElement("beforebegin", rowsSpan);
      }
      if (rowsChanged || rowsIsNew) rowsSpan.textContent = `Rows: ${rowCount}`;

      let mutamerSpan = document.querySelector(".mutamer-total-span");
      const mutamerIsNew = !mutamerSpan;
      if (mutamerIsNew) {
        mutamerSpan = document.createElement("span");
        mutamerSpan.className = "mutamer-total-span";
        mutamerSpan.style.marginRight = "10px";
        mutamerSpan.style.fontWeight = "bold";
        anchor.insertAdjacentElement("beforebegin", mutamerSpan);
      }
      if (mutamerChanged || mutamerIsNew) mutamerSpan.textContent = `Mutamer Total: ${mutamerTotal}`;

      let voucherSpan = document.querySelector(".voucher-total-span");
      const voucherIsNew = !voucherSpan;
      if (voucherIsNew) {
        voucherSpan = document.createElement("span");
        voucherSpan.className = "voucher-total-span";
        voucherSpan.style.marginRight = "10px";
        voucherSpan.style.fontWeight = "bold";
        anchor.insertAdjacentElement("beforebegin", voucherSpan);
      }
      if (voucherChanged || voucherIsNew) voucherSpan.textContent = `Voucher Total: ${formattedVoucher}`;
      return;
    }

    /* ---------------- NEW PAGINATOR (fallback) ---------------- */
    // Rows / Mutamer Total / Voucher Total each get their own block-level
    // line. Masar's own footer CSS reaches into this container with rules
    // targeting plain divs/spans (forcing them inline + normal weight) that
    // beat a plain inherited style — so display/font-weight are forced with
    // !important here, which wins the tie regardless of the page's own
    // selector specificity.
    const footer = document.querySelector(".p-datatable-footer .justify-content-between");
    if (!footer) return;

    const forceLine = (el) => {
      el.style.setProperty("display", "block", "important");
      el.style.setProperty("font-weight", "bold", "important");
      el.style.setProperty("white-space", "normal", "important");
    };

    let container = footer.querySelector(".custom-paginator-totals");
    let rowsLine, mutamerLine, voucherLine;
    const isNew = !container;
    if (isNew) {
      container = document.createElement("div");
      container.className = "custom-paginator-totals";
      container.style.setProperty("margin-left", "20px", "important");
      container.style.setProperty("line-height", "1.35", "important");
      forceLine(container);

      rowsLine = document.createElement("div");
      rowsLine.className = "mv-rows-total-span";
      mutamerLine = document.createElement("div");
      mutamerLine.className = "mutamer-total-span";
      voucherLine = document.createElement("div");
      voucherLine.className = "voucher-total-span";
      [rowsLine, mutamerLine, voucherLine].forEach(forceLine);
      container.append(rowsLine, mutamerLine, voucherLine);

      footer.insertBefore(container, footer.children[1] || footer.lastChild);
    } else {
      rowsLine = container.querySelector(".mv-rows-total-span");
      mutamerLine = container.querySelector(".mutamer-total-span");
      voucherLine = container.querySelector(".voucher-total-span");
    }
    if (rowsChanged || isNew) rowsLine.textContent = `Rows: ${rowCount}`;
    if (mutamerChanged || isNew) mutamerLine.textContent = `Mutamer Total: ${mutamerTotal}`;
    if (voucherChanged || isNew) voucherLine.textContent = `Voucher Total: ${formattedVoucher}`;
  }

  // Short debounce, not a "let it settle" delay — just enough to coalesce a
  // single render pass's burst of mutations into one recompute. Safe to run
  // this often now that calculateAndUpdate() only touches the DOM when a
  // value actually changed, so it can't feed back into its own loop.
  let debounceTimer = null;
  function scheduleUpdate() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(calculateAndUpdate, 100);
  }

  // Updating our own injected spans' textContent is itself a DOM mutation —
  // without this check the observer would see its own writes, schedule
  // another recompute, write again, and loop forever even when the page
  // itself never changes. A mutation only counts as "real" if it happened
  // outside the elements we injected.
  function isOwnMutation(target) {
    const el = target && target.nodeType === Node.TEXT_NODE ? target.parentElement : target;
    return !!(el && el.closest && el.closest(INJECTED_SELECTOR));
  }

  let observer = null;
  function startObserving() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      if (mutations.some((m) => !isOwnMutation(m.target))) scheduleUpdate();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    calculateAndUpdate();
  }
  function stopObserving() {
    if (observer) { observer.disconnect(); observer = null; }
    removeInjected();
  }

  window.addEventListener("nusuk-route-change", () => {
    if (!moduleEnabled) return;
    if (urlMatches()) calculateAndUpdate();
    else removeInjected(); // left the configured page(s) — don't leave stale numbers behind
  });

  const premiumOK = () => !window.NkLicense || window.NkLicense.featureOK("mvtotals");

  function refreshEnabled() {
    chrome.storage.local.get(["moduleMvTotals", "extensionEnabled", URLS_KEY], (res) => {
      urls = Array.isArray(res[URLS_KEY]) ? res[URLS_KEY].filter(Boolean) : [];
      const was = moduleEnabled;
      moduleEnabled = res.extensionEnabled !== false && !!res.moduleMvTotals && premiumOK();
      if (moduleEnabled && !was) startObserving();
      else if (!moduleEnabled && was) stopObserving();
      else if (moduleEnabled) calculateAndUpdate(); // url list may have just changed
    });
  }

  refreshEnabled();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.moduleMvTotals || changes.extensionEnabled || changes[URLS_KEY]) refreshEnabled();
  });

  window.NkLicense && window.NkLicense.onPremiumChange(() => refreshEnabled());
})();
