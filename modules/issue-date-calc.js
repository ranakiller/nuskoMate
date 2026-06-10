(function () {
  "use strict";

  // Logging shim — prefers the persistent extension logger, falls back to console
  const log = {
    info:  (...a) => (window.nkLog       ? window.nkLog(...a)       : console.log(...a)),
    warn:  (...a) => (window.nkLog?.warn  ? window.nkLog.warn(...a)  : console.warn(...a)),
    error: (...a) => (window.nkLog?.error ? window.nkLog.error(...a) : console.error(...a)),
  };

  let isEnabled = false;
  let pollTimer = null;
  let lastExpiryValue = "";
  let initializedForValue = "";

  const STYLE_ID = "nuskomate-date-calc-styles";

  function isTargetPage() {
    return window.location.pathname === "/umrah/mutamer/add-mutamer";
  }

  function formatDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function copyToClipboard(value) {
    if (!navigator.clipboard?.writeText) { log.info("[Nuskomate IssueDate] Calculated issue date:", value); return; }
    navigator.clipboard.writeText(value).catch(() => log.info("[Nuskomate IssueDate] Calculated issue date:", value));
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const styleEl = document.createElement("style");
    styleEl.id = STYLE_ID;
    styleEl.textContent = `
      #nuskomate-date-calc-container {
        display: block;
      }
      .nuskomate-calc-badge {
        font-size: 9px;
        font-weight: 700;
        background-color: var(--primary-color, #2563eb);
        color: var(--primary-color-text, #ffffff);
        padding: 2px 6px;
        border-radius: 4px;
        text-transform: uppercase;
        margin-left: 10px;
      }
      .nuskomate-calc-col {
        display: flex;
        flex-direction: column;
      }
      .nuskomate-calc-label {
        font-weight: 500;
        margin-bottom: 6px;
      }
      .nuskomate-result-container {
        display: flex;
        flex-direction: column;
      }
      .nuskomate-result-row {
        display: flex;
        gap: 8px;
        width: 100%;
      }
      .nuskomate-result-input {
        flex: 1;
        text-align: center;
        cursor: not-allowed;
      }
      .nuskomate-copy-btn {
        padding: 10px 20px;
        font-size: 13px;
        font-weight: 600;
        color: var(--primary-color-text, #ffffff);
        background: var(--primary-color, #2563eb);
        border: none;
        border-radius: 6px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 6px;
        transition: all 0.2s ease-in-out;
      }
      .nuskomate-copy-btn:hover {
        opacity: 0.9;
        transform: translateY(-1px);
      }
      .nuskomate-copy-btn:active {
        transform: translateY(1px);
      }
      .nuskomate-copy-btn.success {
        background: #10b981;
        color: #ffffff;
      }
    `;
    document.head.appendChild(styleEl);
  }

  function removeWidget() {
    const widget = document.getElementById("nuskomate-date-calc-container");
    if (widget) widget.remove();
    lastExpiryValue = "";
    initializedForValue = "";
  }

  function findCardContainer(element) {
    let current = element;
    while (current && current.parentElement) {
      const parent = current.parentElement;
      if (
        current.tagName === "APP-HAJ-MAIN-CARD" ||
        current.classList.contains("card") ||
        current.classList.contains("p-card") ||
        current.tagName === "P-PANEL" ||
        current.classList.contains("panel")
      ) {
        return current;
      }
      current = parent;
    }
    return null;
  }

  function applyAngularScoping(root, sampleEl) {
    if (!sampleEl || !root) return;
    const attrs = [];
    for (const attr of sampleEl.attributes) {
      if (attr.name.startsWith("_ngcontent-") || attr.name.startsWith("_nghost-")) {
        attrs.push({ name: attr.name, value: attr.value });
      }
    }
    
    // Check inner card element attributes to get template specific IDs
    const cardEl = sampleEl.querySelector(".card");
    if (cardEl) {
      for (const attr of cardEl.attributes) {
        if (attr.name.startsWith("_ngcontent-") && !attrs.some(a => a.name === attr.name)) {
          attrs.push({ name: attr.name, value: attr.value });
        }
      }
    }

    const traverse = (el) => {
      for (const attr of attrs) {
        el.setAttribute(attr.name, attr.value);
      }
      for (const child of el.children) {
        traverse(child);
      }
    };
    traverse(root);
  }

  function calculateAndSync(forceInit = false) {
    const expiryInput = document.querySelector('p-calendar[formcontrolname="passportExpiryDate"] input');
    const widget = document.getElementById("nuskomate-date-calc-container");
    if (!expiryInput || !widget) return;

    const val = expiryInput.value.trim();
    const resultInput = widget.querySelector("#nuskomate-result-input");
    const yearsInput = widget.querySelector("#nuskomate-years-input");
    const daysInput = widget.querySelector("#nuskomate-days-input");

    if (!val) {
      if (resultInput) resultInput.value = "";
      initializedForValue = "";
      return;
    }

    const expiryDate = new Date(val);
    if (Number.isNaN(expiryDate.getTime())) {
      if (resultInput) resultInput.value = "Invalid date format";
      initializedForValue = "";
      return;
    }

    const expiryYear = expiryDate.getFullYear();
    const defaultSub = expiryYear - 5 > new Date().getFullYear() ? 10 : 5;

    if (forceInit || val !== initializedForValue) {
      yearsInput.value = defaultSub;
      daysInput.value = 1;
      initializedForValue = val;
    }

    let years = parseInt(yearsInput.value, 10);
    if (Number.isNaN(years)) {
      years = defaultSub;
    }

    let days = parseInt(daysInput.value, 10);
    if (Number.isNaN(days)) {
      days = 1;
    }

    const computedDate = new Date(expiryDate.getTime());
    computedDate.setFullYear(computedDate.getFullYear() - years);
    computedDate.setDate(computedDate.getDate() + days);

    const formatted = formatDate(computedDate);
    if (resultInput) {
      resultInput.value = formatted;
    }

    // Autofill Angular form input for issue date (Release Date)
    const parentCalendar = document.querySelector('p-calendar[formcontrolname="passportIssueDate"]');
    if (parentCalendar) {
      const issueInput = parentCalendar.querySelector('input');
      if (issueInput) {
        // Clear to bypass any early exit check in simulateAngularInput
        issueInput.value = "";
        
        if (window.simulateAngularInput) {
          window.simulateAngularInput(issueInput, formatted);
        } else {
          issueInput.value = formatted;
          issueInput.dispatchEvent(new Event("input", { bubbles: true }));
          issueInput.dispatchEvent(new Event("change", { bubbles: true }));
          issueInput.dispatchEvent(new Event("blur", { bubbles: true }));
        }

        // Dispatch key inputs, input, change and call native blur to force model state binding update
        issueInput.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
        issueInput.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true, key: "Enter" }));
        issueInput.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
        issueInput.dispatchEvent(new Event("input", { bubbles: true }));
        issueInput.dispatchEvent(new Event("change", { bubbles: true }));
        issueInput.blur();
      }

      // Notify parent calendar component
      parentCalendar.dispatchEvent(new Event("input", { bubbles: true }));
      parentCalendar.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function injectWidget(expiryCalendar) {
    removeWidget();
    injectStyles();

    const identityCard = findCardContainer(expiryCalendar);

    const widget = document.createElement("app-haj-main-card");
    widget.id = "nuskomate-date-calc-container";

    widget.innerHTML = `
      <div class="card">
        <div class="card-header mb-0 cursor-pointer">
          <div class="d-flex justify-content-between align-items-center w-100">
            <h3 class="title">Issue Date Calculator</h3>
            <span class="nuskomate-calc-badge">Auto Calc</span>
          </div>
        </div>
        <div class="body collapse show">
          <div class="row">
            <div class="col-md-4 col-lg-4 col-xl-3 form-mb">
              <label for="nuskomate-years-input">Years Difference</label>
              <input type="number" id="nuskomate-years-input" class="p-inputtext p-component p-element w-full nuskomate-calc-input" placeholder="Years" min="0" step="1">
            </div>
            <div class="col-md-4 col-lg-4 col-xl-3 form-mb">
              <label for="nuskomate-days-input">Days Difference</label>
              <input type="number" id="nuskomate-days-input" class="p-inputtext p-component p-element w-full nuskomate-calc-input" placeholder="Days" step="1">
            </div>
          </div>
          <div class="row">
            <div class="col-md-4 col-lg-4 col-xl-3 form-mb">
              <label>Calculated Issue Date</label>
              <div class="nuskomate-result-row">
                <input type="text" id="nuskomate-result-input" class="p-inputtext p-component p-element w-full nuskomate-result-input" placeholder="Enter valid expiry date" readonly>
                <button type="button" id="nuskomate-insert-btn" class="nuskomate-copy-btn">Insert</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    // Position the widget right before the Identity Details card and apply Angular scoping
    if (identityCard && identityCard.parentNode) {
      applyAngularScoping(widget, identityCard);
      identityCard.parentNode.insertBefore(widget, identityCard);
    } else {
      expiryCalendar.parentNode.insertBefore(widget, expiryCalendar.nextSibling);
    }

    const yearsInput = widget.querySelector("#nuskomate-years-input");
    const daysInput = widget.querySelector("#nuskomate-days-input");
    const insertBtn = widget.querySelector("#nuskomate-insert-btn");

    yearsInput.addEventListener("input", () => calculateAndSync(false));
    daysInput.addEventListener("input", () => calculateAndSync(false));

    insertBtn.addEventListener("click", () => {
      const resultInput = widget.querySelector("#nuskomate-result-input");
      const val = resultInput && resultInput.value;
      if (!val || val.includes("valid") || val.includes("Invalid")) return;

      // Tell the OCR module to stop re-asserting its extracted issue date —
      // otherwise it reverts our inserted value within a tick.
      if (typeof window.nkReleaseIssueDate === "function") window.nkReleaseIssueDate();

      // Put the calculated date straight into the Release/Issue date field.
      // Uses execCommand("insertText") after selecting all — fires a REAL
      // InputEvent that PrimeNG/Angular always accepts, and replaces whatever
      // is already in the box (so it works even when the field is pre-filled).
      const cal = document.querySelector('p-calendar[formcontrolname="passportIssueDate"]');
      const inp = cal && cal.querySelector("input");
      if (inp) {
        const wasDisabled = inp.disabled;
        if (wasDisabled) inp.disabled = false;

        // Close any open datepicker panel so events go to the input, not the calendar
        inp.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape", keyCode: 27 }));
        inp.focus({ preventScroll: true });
        inp.select();

        const ok = document.execCommand("insertText", false, val);
        if (!ok) {
          // Fallback for environments where execCommand is unavailable
          inp.value = "";
          if (window.simulateAngularInput) window.simulateAngularInput(inp, val);
          else { inp.value = val; inp.dispatchEvent(new Event("input", { bubbles: true })); }
        }

        inp.dispatchEvent(new KeyboardEvent("keydown",  { bubbles: true, key: "Enter", keyCode: 13 }));
        inp.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true, key: "Enter", keyCode: 13 }));
        inp.dispatchEvent(new KeyboardEvent("keyup",    { bubbles: true, key: "Enter", keyCode: 13 }));
        inp.dispatchEvent(new Event("input",  { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
        inp.blur();
        cal.dispatchEvent(new Event("input",  { bubbles: true }));
        cal.dispatchEvent(new Event("change", { bubbles: true }));

        if (wasDisabled) inp.disabled = true;
        log.info("[Nuskomate IssueDate] inserted issue date:", val, "| field now:", inp.value);
      }

      insertBtn.textContent = "Inserted!";
      insertBtn.classList.add("success");
      setTimeout(() => {
        insertBtn.textContent = "Insert";
        insertBtn.classList.remove("success");
      }, 1500);
    });

    return widget;
  }

  function handleDateLogic() {
    if (!isEnabled || !isTargetPage()) {
      removeWidget();
      return;
    }

    const expiryCalendar = document.querySelector('p-calendar[formcontrolname="passportExpiryDate"]');
    if (!expiryCalendar) {
      removeWidget();
      return;
    }

    let widget = document.getElementById("nuskomate-date-calc-container");
    if (!widget) {
      widget = injectWidget(expiryCalendar);
    }

    const expiryInput = expiryCalendar.querySelector("input");
    if (expiryInput) {
      const val = expiryInput.value.trim();
      if (val !== lastExpiryValue) {
        lastExpiryValue = val;
        if (val.length < 8) {
          initializedForValue = "";
          const resultInput = widget.querySelector("#nuskomate-result-input");
          if (resultInput) resultInput.value = "";
        } else {
          calculateAndSync(true);
        }
      }
    }
  }

  function start() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      handleDateLogic();
    }, 500);
    window.addEventListener("nusuk-route-change", () => {
      removeWidget();
      handleDateLogic();
    });
  }

  function stop() {
    isEnabled = false;
    clearInterval(pollTimer);
    pollTimer = null;
    removeWidget();
  }

  chrome.storage.local.get(["extensionEnabled", "moduleIssueDateCalc"], (res) => {
    if (res.extensionEnabled === false) return;
    isEnabled = !!res.moduleIssueDateCalc;
    start();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.extensionEnabled) {
      if (!changes.extensionEnabled.newValue) { stop(); return; }
      else { chrome.storage.local.get(["moduleIssueDateCalc"], (r) => { isEnabled = !!r.moduleIssueDateCalc; start(); }); return; }
    }
    if (changes.moduleIssueDateCalc) { isEnabled = !!changes.moduleIssueDateCalc.newValue; if (isEnabled) handleDateLogic(); else removeWidget(); }
  });
})();
