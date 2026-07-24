// Auto Date Picker — ported from the user's Tampermonkey "Auto Date Picker"
// block, almost 1:1. Site-wide (no URL restriction, like Disable Overlay):
// focus ANY PrimeNG calendar text input (.p-calendar input.p-inputtext) and
// type a shorthand — DD, DDMM, DDMMYY, or DDMMYYYY — Enter/Tab/1.5s-idle
// commits it. Two dates can be typed at once (space-separated, or
// "+Nd"/"+Nm"/"+Ny" math off the first) to fill a date-range pair in one go.
//
// Two functions handle actually landing the date, picked per-field by
// runCalendarEngine() based on one signal: whether the <input> has the
// readonly attribute. That split isn't a guess — three real Masar fields
// were checked directly: fields WITHOUT readonly accept a typed value and
// Angular's bound form control updates correctly (fillByTyping, the fast
// path); fields WITH readonly (Masar's own convention for "pick from the
// calendar only", e.g. Arrival/Departure Date) visually accept typed text
// but Angular's real form value silently never updates — confirmed by
// testing — so those need an actual click-selected date instead
// (fillByClicking, the original year→month→day engine).
//
// Two real bugs in the original were fixed here (user-confirmed, both
// intentional deviations from the original — everything else, including the
// keystroke-interception model, is ported as-is):
//  1. The DDMM (4-digit) branch never rolled forward to next year when the
//     result landed in the past — only the day-only (1-2 digit) branch did.
//     A typed shorthand should always mean "the next occurrence of this
//     date," so DDMM now rolls forward too.
//  2. Filling a second date always searched the WHOLE document for "the next
//     .p-calendar input" — inside a modal/sidebar (e.g. a Hotel popup with
//     its own date-range pair), that could jump OUT of the popup and land on
//     a same-shaped calendar pair on the page behind it (like the page's own
//     Arrival/Departure Date) instead of the popup's own second field. Now
//     scoped to the nearest dialog/sidebar/overlay ancestor when there is
//     one; unchanged (whole document) for plain page-level fields.
//
// Status box follows the extension's own theme setting ("uiTheme" in
// chrome.storage.local — same key popup.js's theme switcher writes), not a
// fixed color — dark when the extension is set to dark (or "system" and the
// OS is dark), light otherwise. Colors match popup.css's own light/dark
// tokens so it looks like part of the same product.
(function () {
  "use strict";

  let moduleEnabled = false;
  const premiumOK = () => !window.NkLicense || window.NkLicense.featureOK("autodatepicker");

  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  let statusBox = null;
  let currentInput = null;
  let typedBuffer = "";
  let typedTimeout = null;

  function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
  function getPicker() { return document.querySelector(".p-datepicker:not(.p-datepicker-inline)"); }

  // ── Theme (mirrors popup.js's own THEME_KEY/applyTheme logic) ──
  let isDarkTheme = false;
  function refreshTheme() {
    chrome.storage.local.get(["uiTheme"], (res) => {
      const pref = res.uiTheme || "system";
      isDarkTheme = pref === "dark" ||
        (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    });
  }
  refreshTheme();
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", refreshTheme);

  function showStatusBox(parentContainer, text) {
    if (statusBox) statusBox.remove();
    statusBox = document.createElement("div");
    statusBox.id = "nk-date-status";
    Object.assign(statusBox.style, {
      position: "absolute", zIndex: "2147483647", left: "0", top: "-34px",
      padding: "5px 10px", fontSize: "12px", fontWeight: "700",
      borderRadius: "6px", pointerEvents: "none",
      fontFamily: "system-ui, sans-serif", whiteSpace: "nowrap",
      border: "1px solid " + (isDarkTheme ? "#2c3050" : "#e2e7f0"),
      background: isDarkTheme ? "#1a1d27" : "#ffffff",
      color: isDarkTheme ? "#e8ecf8" : "#1a2035",
      boxShadow: isDarkTheme ? "0 2px 14px rgba(0,0,0,.4)" : "0 2px 12px rgba(79,110,247,.10)",
    });
    statusBox.textContent = text;
    parentContainer.style.position = "relative";
    parentContainer.appendChild(statusBox);
  }

  function removeStatusBox() {
    if (statusBox) { statusBox.remove(); statusBox = null; }
    typedBuffer = "";
    if (typedTimeout) clearTimeout(typedTimeout);
  }

  document.addEventListener("click", (e) => {
    if (!moduleEnabled) return;
    if (currentInput && !e.target.closest(".p-calendar")) {
      removeStatusBox();
      currentInput = null;
    }
  });

  document.addEventListener("focusin", (e) => {
    if (!moduleEnabled) return;
    const input = e.target.closest(".p-calendar input.p-inputtext");
    if (!input) {
      // Focus landed on something else entirely (e.g. Tab moving out of a
      // calendar into a plain field like Number of Pilgrims) — clear
      // tracking here too, not just on click. Without this, currentInput
      // stayed pointed at the old calendar and every keystroke meant for
      // the newly-focused field kept getting hijacked into it instead.
      if (currentInput) { removeStatusBox(); currentInput = null; }
      return;
    }
    removeStatusBox();
    currentInput = input;
    showStatusBox(input.parentNode, "Allowed Formats: (DD, DDMM, DDMMYY or DDMMYYYY)");
  });

  document.addEventListener("keydown", (ev) => {
    // fillByTyping() below dispatches its own synthetic Enter keydown/keyup
    // at the target input to make PrimeNG commit the typed value — without
    // this guard, that synthetic event bubbles right back into this same
    // listener and gets misread as a second real keystroke.
    if (!ev.isTrusted) return;
    if (!moduleEnabled || !currentInput) return;
    // Defense in depth: only act on keystrokes actually aimed at the
    // tracked calendar input, never on whatever currently has real focus
    // elsewhere on the page.
    if (ev.target !== currentInput) return;

    if (ev.key === "Escape") {
      ev.preventDefault(); ev.stopPropagation();
      removeStatusBox();
      currentInput.blur();
      return;
    }

    if (ev.key === "Enter" || ev.key === "Tab") {
      if (typedBuffer.length > 0) {
        ev.preventDefault(); ev.stopPropagation();
        const val = typedBuffer;
        const targetInput = currentInput;
        removeStatusBox();
        handleQuickInput(val, targetInput).then((lastFilledInput) => {
          if (ev.key === "Tab") {
            // When two dates got typed into one field, handleQuickInput
            // finishes on the SECOND calendar it just filled, not the field
            // Tab was originally pressed in — advance from that actual last
            // field, or Tab lands back on the (already-filled) second
            // calendar instead of the real next field.
            const anchor = lastFilledInput || targetInput;
            const focusable = Array.from(document.querySelectorAll('input:not([disabled]), button:not([disabled]), select, [tabindex="0"]'));
            const idx = focusable.indexOf(anchor);
            if (idx > -1 && focusable[idx + 1]) focusable[idx + 1].focus();
          }
        });
      }
      return;
    }

    if (ev.key === "Backspace" && typedBuffer.length > 0) {
      ev.preventDefault(); ev.stopPropagation();
      typedBuffer = typedBuffer.slice(0, -1);
      showStatusBox(currentInput.parentNode, typedBuffer.length > 0 ? `Input: ${typedBuffer}` : "Type: (DD / DDMM / DDMMYY / DDMMYYYY) any format");
      return;
    }

    if (/^[0-9+ ]$/.test(ev.key)) {
      ev.preventDefault(); ev.stopPropagation();
      typedBuffer += ev.key;
      showStatusBox(currentInput.parentNode, `Input: ${typedBuffer}`);
      if (typedTimeout) clearTimeout(typedTimeout);
      typedTimeout = setTimeout(async () => {
        if (typedBuffer.length > 0) {
          const val = typedBuffer;
          const targetInput = currentInput;
          removeStatusBox();
          await handleQuickInput(val, targetInput);
        }
      }, 1500);
    }
  }, true);

  async function handleQuickInput(code, targetInput) {
    if (!targetInput) return targetInput;
    let parts;
    let isPlusMath = false;
    if (code.includes("+")) { parts = code.split("+"); isPlusMath = true; }
    else if (code.includes(" ")) parts = code.split(" ").filter((p) => p.length > 0);
    else parts = [code];

    const date1 = parseComplexDate(parts[0]);
    if (!date1) return;

    let date2 = null;
    if (isPlusMath && parts[1]) {
      const mathPart = parts[1].toLowerCase().trim();
      const start = new Date(date1.year, date1.month - 1, date1.day);
      if (mathPart.endsWith("m")) start.setMonth(start.getMonth() + parseInt(mathPart, 10));
      else if (mathPart.endsWith("y")) start.setFullYear(start.getFullYear() + parseInt(mathPart, 10));
      else start.setDate(start.getDate() + parseInt(mathPart, 10));
      date2 = { day: start.getDate(), month: start.getMonth() + 1, year: start.getFullYear() };
    } else if (parts[1]) {
      date2 = parseComplexDate(parts[1], date1);
    }

    await runCalendarEngine(date1.day, date1.month, date1.year, targetInput);

    if (date2) {
      const nextInput = findNextCalendarInput(targetInput);
      if (nextInput) {
        await wait(600);
        await runCalendarEngine(date2.day, date2.month, date2.year, nextInput);
        return nextInput;
      }
    }
    return targetInput;
  }

  function parseComplexDate(str, context) {
    const today = new Date();
    let day, month, year = today.getFullYear();
    const code = str.replace(/\D/g, "");

    if (code.length <= 2) {
      day = +code;
      month = context ? context.month : today.getMonth() + 1;
      year = context ? context.year : today.getFullYear();
      if (!context && day < today.getDate()) {
        month++;
        if (month > 12) { month = 1; year++; }
      }
    } else if (code.length === 4) {
      day = +code.slice(0, 2);
      month = +code.slice(2, 4);
      // Bug fix #1 — roll forward to next year if this DDMM already passed
      // this year (only when there's no context, i.e. this is the first/
      // only date typed — a second date's rollover is handled below same as
      // the original).
      if (!context) {
        const candidate = new Date(year, month - 1, day);
        const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        if (candidate < todayMidnight) year++;
      }
    } else if (code.length === 6 || code.length === 8) {
      day = +code.slice(0, 2);
      month = +code.slice(2, 4);
      const y = code.length === 6 ? +code.slice(4, 6) : +code.slice(4, 8);
      year = y < 100 ? (y < 50 ? 2000 + y : 1900 + y) : y;
    } else {
      return null;
    }

    if (context && year === context.year && month === context.month && day < context.day) {
      month++;
      if (month > 12) { month = 1; year++; }
    }

    return { day, month, year };
  }

  // Bug fix #2 — scope "the next calendar input" to the nearest dialog/
  // sidebar/overlay ancestor when the current one is inside one, instead of
  // always searching the whole document.
  function findNextCalendarInput(current) {
    const scope = current.closest(".p-dialog, .p-sidebar, .p-overlaypanel") || document;
    const inputs = Array.from(scope.querySelectorAll(".p-calendar input.p-inputtext"));
    const idx = inputs.indexOf(current);
    return idx > -1 ? (inputs[idx + 1] || null) : null;
  }

  async function navigateDecade(targetYear) {
    let attempts = 0;
    while (attempts < 10) {
      const yearOptions = Array.from(document.querySelectorAll(".p-yearpicker-year"));
      if (!yearOptions.length) return;
      const years = yearOptions.map((el) => parseInt(el.textContent.trim(), 10)).sort((a, b) => a - b);
      const minYear = years[0], maxYear = years[years.length - 1];
      if (targetYear >= minYear && targetYear <= maxYear) {
        const targetEl = yearOptions.find((el) => parseInt(el.textContent.trim(), 10) === targetYear);
        if (targetEl) targetEl.click();
        return;
      }
      const datepicker = getPicker();
      if (!datepicker) return;
      const prevBtn = datepicker.querySelector(".p-datepicker-prev");
      const nextBtn = datepicker.querySelector(".p-datepicker-next");
      if (targetYear < minYear) prevBtn?.click(); else nextBtn?.click();
      await wait(400);
      attempts++;
    }
  }

  // Fast path — for fields whose <input> is NOT readonly. execCommand fires
  // a real InputEvent (like an actual paste) that Angular/PrimeNG honor,
  // unlike a synthetic Event object some stricter configs ignore — same
  // technique modules/ocr.js already proved out for the passport issue-date
  // field.
  async function fillByTyping(targetInput, day, month, year) {
    const cal = targetInput.closest("p-calendar");
    const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

    if (document.activeElement !== targetInput) targetInput.focus({ preventScroll: true });

    // Close any picker popup already open on THIS field first — while it's
    // open, PrimeNG can silently ignore a typed value, which is exactly why
    // the very first attempt used to need a second try to actually stick.
    // Dispatched with bubbles:false so it only reaches the input/component
    // itself (closing just its own popup, via PrimeNG's own direct keydown
    // binding on the input — target-phase listeners fire regardless of
    // bubbles) and can't climb up into an ancestor dialog/sidebar's own
    // Escape-to-close handler, which is what closed the whole Makkah hotel
    // popup last time this was tried with a bubbling Escape.
    targetInput.dispatchEvent(new KeyboardEvent("keydown", { bubbles: false, cancelable: true, key: "Escape", keyCode: 27 }));

    targetInput.select();

    const ok = document.execCommand("insertText", false, iso);
    if (!ok) {
      targetInput.value = "";
      if (typeof window.simulateAngularInput === "function") window.simulateAngularInput(targetInput, iso);
    }

    // Angular/Zone.js runs change detection off the 'input' event above as
    // its own scheduled task, not synchronously inline — dispatching Enter
    // and calling blur() immediately after in the same call stack can race
    // that, so blur's own value-commit logic reads a stale pre-update
    // value. A real task-queue turn (setTimeout, not just a microtask) here
    // lets it flush first.
    await wait(50);

    targetInput.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", keyCode: 13 }));
    targetInput.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", keyCode: 13 }));
    await wait(50);
    targetInput.blur();
    if (cal) {
      cal.dispatchEvent(new Event("input", { bubbles: true }));
      cal.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  // Click-driven path — for fields whose <input> IS readonly. Unchanged
  // from the original: open the popup and click through year → month → day
  // like a human selecting it.
  async function fillByClicking(targetDay, targetMonth, targetYear, targetInput) {
    targetInput.click();
    await wait(300);
    let datepicker = getPicker();
    if (!datepicker) { targetInput.click(); await wait(400); datepicker = getPicker(); }
    if (!datepicker) return;

    const yearBtn = datepicker.querySelector(".p-datepicker-year");
    const currentVisibleYear = parseInt(yearBtn?.textContent.trim(), 10);
    if (currentVisibleYear !== targetYear) {
      yearBtn?.click();
      await wait(400);
      await navigateDecade(targetYear);
      await wait(600);
    }

    datepicker = getPicker();
    if (!datepicker) return;
    const targetMonthName = MONTH_NAMES[targetMonth - 1];
    const monthBtn = datepicker.querySelector(".p-datepicker-month");
    const currentVisibleMonth = monthBtn?.textContent.trim();
    let monthPicker = datepicker.querySelector(".p-monthpicker");

    if (monthPicker || (currentVisibleMonth && !currentVisibleMonth.includes(targetMonthName))) {
      if (!monthPicker) {
        monthBtn?.click();
        await wait(400);
        monthPicker = document.querySelector(".p-monthpicker");
      }
      if (monthPicker) {
        const monthOptions = Array.from(monthPicker.querySelectorAll(".p-monthpicker-month"));
        const targetMEl = monthOptions.find((el) => el.textContent.trim().includes(targetMonthName));
        if (targetMEl) { targetMEl.click(); await wait(500); }
      }
    }

    datepicker = getPicker();
    if (!datepicker) return;
    const days = Array.from(datepicker.querySelectorAll("td:not(.p-datepicker-other-month) span, td:not(.p-datepicker-other-month) a"));
    const targetDayEl = days.find((d) => d.textContent.trim() == targetDay);
    if (targetDayEl) {
      targetDayEl.click();
    } else {
      const allSpans = Array.from(datepicker.querySelectorAll(".p-datepicker-calendar span:not(.p-disabled)"));
      const finalTry = allSpans.find((s) => s.textContent.trim() == targetDay && !s.closest(".p-datepicker-other-month"));
      if (finalTry) finalTry.click();
    }
  }

  // Dispatcher — the one place that decides which of the two functions
  // above actually lands the date on a given field.
  async function runCalendarEngine(targetDay, targetMonth, targetYear, targetInput) {
    const readOnly = targetInput.hasAttribute("readonly") || targetInput.readOnly;
    if (readOnly) await fillByClicking(targetDay, targetMonth, targetYear, targetInput);
    else await fillByTyping(targetInput, targetDay, targetMonth, targetYear);
  }

  function refreshEnabled() {
    chrome.storage.local.get(["moduleAutoDatePicker", "extensionEnabled"], (res) => {
      moduleEnabled = res.extensionEnabled !== false && !!res.moduleAutoDatePicker && premiumOK();
      if (!moduleEnabled) { removeStatusBox(); currentInput = null; }
    });
  }
  refreshEnabled();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.moduleAutoDatePicker || changes.extensionEnabled) refreshEnabled();
    if (changes.uiTheme) refreshTheme();
  });
  window.NkLicense && window.NkLicense.onPremiumChange(() => refreshEnabled());
})();
