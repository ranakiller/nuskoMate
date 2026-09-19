(function () {
  "use strict";

  // Logging shim — prefers the persistent extension logger, falls back to console
  const log = {
    info:  (...a) => (window.nkLog       ? window.nkLog(...a)       : console.log(...a)),
    warn:  (...a) => (window.nkLog?.warn  ? window.nkLog.warn(...a)  : console.warn(...a)),
    error: (...a) => (window.nkLog?.error ? window.nkLog.error(...a) : console.error(...a)),
  };

  let isEnabled       = true;
  let fatherEnabled   = true; // Father Name module: ON = fill name boxes from OCR; OFF = leave Masar's own MRZ names
  let scanned         = {};
  let fillTimer       = null;
  let calcTimer       = null;
  let issueDateTimer  = null;
  let extrasTimer     = null; // city fill (Identity Details renders late)
  let issueDateReleased = false; // user took manual control via the calc's Insert button
  let lastFileId      = null;
  let started         = false;
  // "Don't fight the user" tracking. We only overwrite a name box / city while
  // it's blank, still holds OUR value, or we're inside a short window after the
  // boxes first appear (to beat Masar's own MRZ auto-fill). After that, a value
  // the user typed is left untouched.
  let boxesSeenAt     = 0;    // when the name boxes first rendered
  let ourBox          = {};   // per-index value we wrote
  let ourCity         = "";   // city value we wrote
  const NAME_GRACE_MS = 8000; // overwrite window after boxes appear

  // ── Lifecycle ───────────────────────────────────────────────
  // Premium feature — requires a license that includes passport OCR.
  // (The scan itself is also server-gated, so this is defence-in-depth.)
  const premiumOK = () => !window.NkLicense || window.NkLicense.featureOK("ocr");
  // Father-name fill is its own licensable tool (a key can have OCR but not it).
  const fatherOK  = () => !window.NkLicense || window.NkLicense.featureOK("father");

  chrome.storage.local.get(["extensionEnabled", "moduleOcr", "moduleFatherName"], (res) => {
    fatherEnabled = res.moduleFatherName !== false && fatherOK();
    if (res.extensionEnabled === false) { isEnabled = false; return; }
    isEnabled = res.moduleOcr !== false && premiumOK();
    if (isEnabled) start();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.moduleFatherName !== undefined) {
      fatherEnabled = changes.moduleFatherName.newValue !== false && fatherOK();
      scheduleFill(); // re-fill with the right box set (with / without father)
    }
    if (changes.extensionEnabled && !changes.extensionEnabled.newValue) { isEnabled = false; stop(); return; }
    if (changes.moduleOcr !== undefined) {
      isEnabled = changes.moduleOcr.newValue !== false && premiumOK();
      isEnabled ? start() : stop();
    }
  });

  // React to license activation/deactivation while the page is open.
  window.NkLicense && window.NkLicense.onPremiumChange(() => {
    chrome.storage.local.get(["extensionEnabled", "moduleOcr", "moduleFatherName"], (r) => {
      fatherEnabled = r.moduleFatherName !== false && fatherOK();
      isEnabled = r.extensionEnabled !== false && r.moduleOcr !== false && premiumOK();
      isEnabled ? start() : stop();
    });
  });

  function start() {
    if (started) return;
    started = true;
    document.addEventListener("change", onFileChange, true);
    window.addEventListener("nusuk-route-change", onRouteChange);
    loadFromStorage(); // restore after reload
    // Expose a scan entry point for the batch module (fed images)
    window.nkOcrScan = scanFile;
    // Let the Issue Date Calculator's Insert button take over the issue-date
    // field — stop OCR from reverting it back to the extracted value.
    window.nkReleaseIssueDate = () => {
      issueDateReleased = true;
      clearInterval(issueDateTimer);
      clearInterval(calcTimer);
      log.info("[Nuskomate OCR] issue date released to manual control");
    };
  }

  function stop() {
    started = false;
    document.removeEventListener("change", onFileChange, true);
    window.removeEventListener("nusuk-route-change", onRouteChange);
    clearInterval(fillTimer);
    clearInterval(calcTimer);
    clearInterval(issueDateTimer);
    clearInterval(extrasTimer);
  }

  function onRouteChange() {
    lastFileId = null;
    if (window.location.pathname.includes("add-mutamer")) {
      // Returned to form — restore if we have saved data
      loadFromStorage();
    } else {
      // Left the form — wipe saved data
      scanned = {};
      chrome.storage.local.remove("ocrScanned");
    }
  }

  // ── Persist / restore ───────────────────────────────────────
  function saveToStorage() {
    chrome.storage.local.set({ ocrScanned: JSON.stringify(scanned) });
  }

  function loadFromStorage() {
    chrome.storage.local.get(["ocrScanned"], (res) => {
      if (!res.ocrScanned) return;
      try {
        const saved = JSON.parse(res.ocrScanned);
        if (saved?.nameBoxes?.some(b => b) || saved?.issueDate) {
          scanned = saved;
          scheduleFill();
          log.info("[Nuskomate OCR] restored from storage — names:", scanned.nameBoxes,
                   "| issueDate:", scanned.issueDate || "(none)");
        }
      } catch (_) {}
    });
  }

  // ── Intercept file upload ───────────────────────────────────
  async function onFileChange(e) {
    if (!isEnabled) return;
    if (!e.isTrusted) return;

    const input = e.target;
    if (input.tagName !== "INPUT" || input.type !== "file") return;
    const file = input.files?.[0];
    if (!file || !file.type.startsWith("image/")) return;
    scanFile(file);
  }

  // Run the full OCR + fill pipeline on a File. Exposed as window.nkOcrScan so
  // the batch module can trigger a scan on images it feeds programmatically
  // (those arrive via synthetic events that onFileChange intentionally ignores).
  async function scanFile(file) {
    if (!isEnabled || !file || !file.type?.startsWith("image/")) return;

    const fileId = `${file.name}_${file.size}_${file.lastModified}`;
    if (fileId === lastFileId) return;
    lastFileId = fileId;

    // New passport → wipe the PREVIOUS scan completely before we start.
    // Stops the old fill loops re-asserting stale names and clears persisted
    // data, so a failed/rate-limited scan can never keep showing old values.
    clearInterval(fillTimer);
    clearInterval(calcTimer);
    clearInterval(issueDateTimer);
    clearInterval(extrasTimer);
    scanned = {};
    chrome.storage.local.remove("ocrScanned");

    log.info("[Nuskomate OCR] detected upload:", file.name);
    toast("Scanning passport…", "neutral");

    // A scan that ERRORS (server refused, no API key, network/OCR failure)
    // used to write nothing at all — so the WhatsApp pipeline, which learns
    // each fed passport's result from this ocrDisplay write (relayed by
    // masar-add-mutamer.js), never heard back for that photo: it stayed
    // "in flight" forever and shifted its feed-order matching for every
    // later photo. Publishing an empty result (no passport number) makes the
    // failure visible to it exactly like a blurry/unreadable scan.
    const publishFailedScan = () => {
      chrome.storage.local.set({
        ocrDisplay: JSON.stringify({ details: {}, nameBoxes: ["", "", "", ""], mrzValid: false, blurry: false, failed: true, scannedAt: Date.now() }),
      });
    };

    // The WhatsApp pipeline reads each passport ONCE itself (background) and
    // hands the finished result over with the cleaned image — use it instead of
    // OCR-ing the same photo again (see modules/masar-add-mutamer.js's
    // queuePassport for where it's stored; keyed by name+size).
    const prefillKey = `${file.name}_${file.size}`;
    const prefillEntry = await new Promise((resolve) => {
      chrome.storage.local.get(["nkOcrPrefill"], (x) => {
        const all = (x && x.nkOcrPrefill) || {};
        const entry = all[prefillKey] || null;
        if (entry) { delete all[prefillKey]; chrome.storage.local.set({ nkOcrPrefill: all }); }
        resolve(entry);
      });
    });

    try {
      let data, raw = "";

      if (prefillEntry && prefillEntry.scan) {
        data = prefillEntry.scan;
        log.info("[Nuskomate OCR] using the pipeline's pre-read result — no second OCR for", file.name);
      } else if (window.NkLicense && window.NkLicense.enforced()) {
        // ── Licensed mode: the server validates the key, OCRs, AND parses ──
        const r = await window.NkLicense.scan(file, "ocr");
        if (!r.ok) {
          toast("✗ " + (r.error || "Scan refused"), "err");
          log.warn("[Nuskomate OCR] server scan refused:", r.error);
          publishFailedScan();
          return;
        }
        data = r.result;
        raw  = r.raw || "";
        log.info("[Nuskomate OCR] server raw text:\n", r.raw);
        log.info("[Nuskomate OCR] server parsed:", data);
      } else {
        // ── Dev mode: OCR + parse locally ──
        const apiKey = await getApiKey();
        if (!apiKey) {
          toast("✗ Please add your ocr.space API key in Settings to use OCR", "err");
          log.warn("[Nuskomate OCR] no local API key set — scan refused");
          publishFailedScan();
          return;
        }
        const text = await callOCR(file, apiKey);
        raw = text;
        log.info("[Nuskomate OCR] raw text:\n", text);
        data = parsePassport(text);
        log.info("[Nuskomate OCR] parsed:", data);

        // Rescue pass: only if the original scan failed the quality gate, retry
        // on a straightened + text-enhanced copy (utils/image-prep.js — the same
        // code as the JPG tools' Straightener/Enhancer): Gentle first, then
        // Strong (bold black-on-white) if still weak. Keeps whichever result is
        // better. Each retry is one more OCR call, so this only runs on a weak scan.
        if (!scanIsGood(data)) {
          for (const mode of ["gentle", "strong"]) {
            log.info(`[Nuskomate OCR] scan weak → retrying on ${mode} enhanced image`);
            const enhanced = await enhancedFile(file, mode);
            if (!enhanced) continue; // couldn't build/size this version — try the next mode
            try {
              const text2 = await callOCR(enhanced, apiKey);
              const data2 = parsePassport(text2);
              const better = pickBetterScan(data, data2);
              if (better === data2) raw = text2;
              data = better;
              log.info(`[Nuskomate OCR] using ${data === data2 ? mode.toUpperCase() + " ENHANCED" : "ORIGINAL"} result`);
            } catch (e2) {
              log.warn(`[Nuskomate OCR] ${mode} enhanced pass failed:`, e2.message);
            }
            if (scanIsGood(data)) break;
          }
        }
      }

      // Publish the full parsed detail set for the popup viewer (display only)
      chrome.storage.local.set({
        ocrDisplay: JSON.stringify({
          details:   data.details || {},
          nameBoxes: data.nameBoxes || ["", "", "", ""],
          mrzValid:  !!data.mrzValid,
          blurry:    !!data.blurry,
          prefilled: !!(prefillEntry && prefillEntry.scan),
          scannedAt: Date.now(),
        }),
      });

      if (data.nameBoxes?.some(b => b)) {
        scanned = data;
        saveToStorage();
        appendToBulkHistory(data, raw); // mirror page scans into the bulk list
        scheduleFill();

        if (data.issueDate) {
          navigator.clipboard?.writeText(data.issueDate).catch(() => {});
        }

        if (data.blurry) {
          toast("⚠ Filled — please verify names & dates", "warn");
        } else {
          const clip = data.issueDate ? ` · Issue ${data.issueDate} copied` : "";
          toast(`✓ Passport scanned${clip}`, "ok");
        }
      } else {
        // Slightly blurry photo: the MRZ (so nationality) often reads fine while
        // the name boxes come back empty. The nationality is still published
        // (ocrDisplay above) and Autofill already uses it for Birth Country —
        // the city box must follow the same nationality instead of staying
        // blank just because no names were extracted. fillCity() only needs
        // scanned.details, so run it on its own for this case.
        const code = data.details && (data.details.issuingCountry || data.details.nationality);
        if (code) {
          scanned = { details: data.details, birthCity: data.birthCity || "" };
          clearInterval(extrasTimer);
          extrasTimer = setInterval(() => { fillCity(); }, 1000);
          setTimeout(() => clearInterval(extrasTimer), 180000);
          toast("⚠ Names unreadable — city filled from nationality; verify the rest", "warn");
        } else {
          toast("⚠ No passport data found — try a clearer image", "warn");
        }
      }
    } catch (err) {
      log.error("[Nuskomate OCR] error:", err);
      toast("✗ OCR failed: " + err.message, "err");
      publishFailedScan();
    }
  }

  // Mirror a page scan into the same persistent list the Bulk Parser uses, so
  // passports scanned one-by-one on masar also build a saveable/exportable list.
  // One row per passport number: a re-scan updates the existing row in place.
  function appendToBulkHistory(data, raw) {
    const HISTORY_KEY = "bulkResults";
    const CAP = 10000;
    const details = (data && data.details) || {};
    const pno = details.passportNo || "";
    const entry = {
      file: details.fullName || pno || "masar scan",
      details,
      raw: raw || "",
      ok: !!(pno || details.fullName),
    };
    chrome.storage.local.get([HISTORY_KEY], (x) => {
      let list = Array.isArray(x[HISTORY_KEY]) ? x[HISTORY_KEY] : [];
      const idx = pno ? list.findIndex((e) => e && e.details && e.details.passportNo === pno) : -1;
      if (idx >= 0) list[idx] = entry;
      else list.push(entry);
      if (list.length > CAP) list = list.slice(-CAP);
      chrome.storage.local.set({ [HISTORY_KEY]: list });
    });
  }

  // ── Fill form ───────────────────────────────────────────────
  function scheduleFill() {
    issueDateReleased = false; // a fresh scan re-takes control of the issue date
    boxesSeenAt = 0; ourBox = {}; ourCity = ""; // fresh scan → fresh overwrite window
    clearInterval(fillTimer);
    clearInterval(calcTimer);

    // Keep re-asserting the names until they stay correct for several
    // consecutive ticks. Two things make this tricky:
    //  • The name boxes live on the NEXT page (after the upload screen) and
    //    appear LATE — Angular keeps the same URL, so no route-change fires to
    //    restart us. Until the boxes render, applyFields() returns false and
    //    nameStable stays 0, so the loop just keeps waiting.
    //  • The nusuk page fills its own MRZ names the instant the boxes appear,
    //    so we must still be running then to overwrite them.
    // Hence a long window (covers review + slow page load) and a stability
    // gate that only stops once OUR values have held for ~5s.
    let nameStable = 0;
    applyFields();
    fillTimer = setInterval(() => {
      const correct = applyFields();
      nameStable = correct ? nameStable + 1 : 0;
      if (nameStable >= 6) clearInterval(fillTimer); // correct & stable ~5s
    }, 800);
    setTimeout(() => clearInterval(fillTimer), 180000); // up to 3 min for a late form

    // Calculator sync — independent timer
    calcTimer = setInterval(() => { if (syncCalculator()) clearInterval(calcTimer); }, 600);
    setTimeout(() => clearInterval(calcTimer), 180000);

    // Issue date — completely independent timer.
    // Runs until the field has the correct value and stays that way.
    clearInterval(issueDateTimer);
    if (scanned.issueDate) {
      let stable = 0;
      issueDateTimer = setInterval(() => {
        const filled = fillIssueDate();
        // Require the value to hold for ~5s (8 ticks) before stopping — long
        // enough that the Issue Date Calculator's sync has settled and won't
        // overwrite our value afterwards. Any overwrite resets the counter.
        stable = filled ? stable + 1 : 0;
        if (stable >= 8) clearInterval(issueDateTimer);
      }, 600);
      setTimeout(() => clearInterval(issueDateTimer), 180000);
    }

    // City fill — independent of the name-fill loop, which stops once names
    // stabilise (~5s). The Identity Details section (City of Issued) renders
    // later, so keep applying it for the full window.
    clearInterval(extrasTimer);
    extrasTimer = setInterval(() => { fillCity(); }, 1000);
    setTimeout(() => clearInterval(extrasTimer), 180000);
  }

  const BOX_SEL = [
    'div[formgroupname="firstName"]  input[formcontrolname="en"]',
    'div[formgroupname="secondName"] input[formcontrolname="en"]',
    'div[formgroupname="thirdName"]  input[formcontrolname="en"]',
    'div[formgroupname="familyName"] input[formcontrolname="en"]',
  ];

  function applyFields() {
    // Wait until at least the first box is in the DOM
    if (!document.querySelector(BOX_SEL[0])) return false;
    if (!boxesSeenAt) boxesSeenAt = Date.now(); // boxes just appeared → start grace window

    // Re-assert names until they hold. The form can render box-by-box, and the
    // nusuk page fills its own MRZ names the instant the boxes appear — so for a
    // short grace window after the boxes show we overwrite anything that differs
    // (to beat that). After the window we only (re)write a box that is blank or
    // still holds OUR value, so a name the USER edits is left alone.
    const aggressive = (Date.now() - boxesSeenAt) < NAME_GRACE_MS;
    let allBoxesCorrect = true;
    const snapshot = []; // diagnostic: state of each box this tick
    // Names ALWAYS fill. The Father Name toggle only chooses WHICH precomputed
    // box set to use: with the father name (ON) or the MRZ name only (OFF). The
    // distribution rule is identical either way (see parser nameToBoxes).
    const useBoxes = (fatherEnabled ? scanned.nameBoxes
                                    : (scanned.nameBoxesNoFather || scanned.nameBoxes)) || [];
    useBoxes.forEach((val, i) => {
      const sel = BOX_SEL[i];
      if (!sel) return;
      const want = val ?? "";
      // Only write boxes we actually have a value for. NEVER clear a box to ""
      // — if our parse missed a name (e.g. garbled MRZ) we must not wipe what
      // the site or user already put there.
      if (!want) { snapshot.push(`box${i}:skip(no value)`); return; }
      const el = document.querySelector(sel);
      if (!el) {
        snapshot.push(`box${i}:MISSING(want="${want}")`);
        allBoxesCorrect = false;
        return;
      }
      const before = el.value;
      if (before === want) {
        snapshot.push(`box${i}:ok="${want}"`);
      } else if (before === "" || before === ourBox[i] || aggressive) {
        fill(sel, want);
        ourBox[i] = want;
        snapshot.push(`box${i}:was="${before}"→set="${want}"`);
        allBoxesCorrect = false;
      } else {
        // User edited this box after the grace window → leave it (treated as
        // settled so the retry loop can stop).
        snapshot.push(`box${i}:user="${before}"`);
      }
    });

    // Log whenever a box was (re)set or is missing — including later overwrites
    // by the site. Stays quiet once everything is steady-state "ok".
    const changed = snapshot.some(s => s.includes("→set") || s.includes("MISSING"));
    if (changed) log.info("[Nuskomate OCR] boxes:", snapshot.join(" | "));

    // Only fill the issue date (unless the user took manual control via Insert).
    // Birth date and gender are left to nusuk's own MRZ auto-fill.
    if (!issueDateReleased) {
      fillCalendar('p-calendar[formcontrolname="passportIssueDate"]', scanned.issueDate);
    }

    // (City fill runs on its own persistent timer — the Identity Details
    //  section renders after the names stabilise.)

    // Only stop the retry interval once all boxes are present AND correct
    return allBoxesCorrect;
  }

  // ── City fill ───────────────────────────────────────────────
  // Fill every city field (any formcontrolname containing "city") with the
  // place-of-birth city extracted from the passport.
  function fillCity() {
    // Only act once a passport has actually been scanned — never touch city
    // fields on a blank page.
    const hasScan = !!(scanned && (scanned.birthCity || scanned.details ||
                       scanned.nameBoxes?.some((b) => b)));
    if (!hasScan) return;
    // Use the read place-of-birth city; otherwise fall back to the passport's
    // own country (GBR → "United Kingdom", PAK → "Pakistan", …). Unknown country
    // code → leave the field for the user rather than guessing.
    const code = scanned.details && (scanned.details.issuingCountry || scanned.details.nationality);
    const country = window.NkCountries ? window.NkCountries.name(code) : "";
    const city = scanned.birthCity || country || "";
    if (!city) return;
    let any = false;
    document.querySelectorAll("input[formcontrolname]").forEach((inp) => {
      if (!/city/i.test(inp.getAttribute("formcontrolname") || "")) return;
      const cur = inp.value.trim();
      if (cur !== "" && cur !== ourCity) return;        // user owns it → leave
      if (cur !== city && typeof window.simulateAngularInput === "function") {
        window.simulateAngularInput(inp, city);
        any = true;
      }
    });
    if (any) { ourCity = city; log.info("[Nuskomate OCR] city →", city); }
  }

  // Reverse-populate the Issue Date Calculator widget.
  // Once years/days are set correctly the calculator fires its own handler
  // which writes the computed date straight into passportIssueDate.
  // Returns true when sync succeeded so the caller can stop retrying.
  function syncCalculator() {
    if (issueDateReleased) return true; // user controls the calc/issue date now
    if (!scanned.issueDate) return true;

    const yearsEl  = document.getElementById("nuskomate-years-input");
    const daysEl   = document.getElementById("nuskomate-days-input");
    const resultEl = document.getElementById("nuskomate-result-input");
    if (!yearsEl || !daysEl || !resultEl) return false; // widget not injected yet

    // Wait until the calculator has already run once (has a result value).
    // That means its internal `initializedForValue` is set, so firing our
    // input event below will NOT trigger the reset-to-default branch.
    if (!resultEl.value) return false;

    const expiryInput = document.querySelector(
      'p-calendar[formcontrolname="passportExpiryDate"] input[type="text"]'
    );
    if (!expiryInput || !expiryInput.value) return false;

    const issue  = new Date(scanned.issueDate);
    const expiry = new Date(expiryInput.value);
    if (isNaN(issue) || isNaN(expiry)) return true;

    const years = expiry.getFullYear() - issue.getFullYear();
    const base  = new Date(expiry);
    base.setFullYear(base.getFullYear() - years);
    const days = Math.round((issue - base) / 86400000);

    yearsEl.value = years;
    daysEl.value  = days;

    // Fire the calculator's own input listener.
    // Because initializedForValue === expiryValue it will NOT reset our values —
    // it reads yearsEl/daysEl, computes the correct date, and writes it directly
    // into the passportIssueDate field (that's what the calculator already does).
    yearsEl.dispatchEvent(new Event("input", { bubbles: true }));

    log.info("[Nuskomate OCR] calculator synced →", years, "yrs,", days, "days →", scanned.issueDate);
    return true;
  }

  // Fill passportIssueDate.
  // Uses execCommand('insertText') which fires a real native InputEvent —
  // identical to what the browser generates for an actual paste, so PrimeNG
  // and Angular see it as a genuine user action.
  // Returns true when the field value is committed and the form is valid.
  function fillIssueDate() {
    if (issueDateReleased) return true; // user took manual control via Insert
    if (!scanned.issueDate) return true;

    const cal = document.querySelector('p-calendar[formcontrolname="passportIssueDate"]');
    if (!cal) return false;
    const inp = cal.querySelector("input");
    if (!inp) return false;

    // Done when value is correct AND Angular form considers it valid
    if (inp.value === scanned.issueDate && !cal.classList.contains("ng-invalid")) return true;

    // 1. Close the datepicker panel if it is open (open picker intercepts events)
    inp.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape", keyCode: 27 }));
    inp.dispatchEvent(new KeyboardEvent("keyup",   { bubbles: true, cancelable: true, key: "Escape", keyCode: 27 }));

    // 2. Focus + select-all so insertText replaces existing content
    inp.focus({ preventScroll: true });
    inp.select();

    // 3. execCommand insertText — fires a real InputEvent that PrimeNG processes
    //    exactly like a user paste (unlike synthetic Event objects which may be ignored)
    const ok = document.execCommand("insertText", false, scanned.issueDate);

    if (!ok) {
      // execCommand not supported — fall back to manual approach
      inp.value = "";
      if (typeof window.simulateAngularInput === "function") {
        window.simulateAngularInput(inp, scanned.issueDate);
      } else {
        inp.value = scanned.issueDate;
        inp.dispatchEvent(new Event("input",  { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    // 4. Enter to commit whatever PrimeNG is waiting for
    inp.dispatchEvent(new KeyboardEvent("keydown",  { bubbles: true, key: "Enter", keyCode: 13 }));
    inp.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true, key: "Enter", keyCode: 13 }));
    inp.dispatchEvent(new KeyboardEvent("keyup",    { bubbles: true, key: "Enter", keyCode: 13 }));

    // 5. Blur to trigger PrimeNG's onInputBlur which finalises the model
    inp.blur();
    cal.dispatchEvent(new Event("input",  { bubbles: true }));
    cal.dispatchEvent(new Event("change", { bubbles: true }));

    log.info("[Nuskomate OCR] issue date attempt →", scanned.issueDate, "| current:", inp.value);
    return false;
  }

  function fillCalendar(calSelector, value) {
    if (!value) return;
    const cal = document.querySelector(calSelector);
    if (!cal) return;
    const inp = cal.querySelector("input[type='text']");
    if (!inp || typeof window.simulateAngularInput !== "function") return;
    window.simulateAngularInput(inp, value);
    // PrimeNG needs keyboard + blur to commit the value into the model
    inp.dispatchEvent(new KeyboardEvent("keydown",  { bubbles: true, key: "Enter" }));
    inp.dispatchEvent(new KeyboardEvent("keyup",    { bubbles: true, key: "Enter" }));
    inp.dispatchEvent(new Event("input",  { bubbles: true }));
    inp.dispatchEvent(new Event("change", { bubbles: true }));
    inp.blur();
    cal.dispatchEvent(new Event("change", { bubbles: true }));
    log.info("[Nuskomate OCR] calendar →", calSelector.match(/"(\w+)"/)?.[1], value);
  }

  function fill(selector, value) {
    if (value === undefined || value === null) return false;
    const el = document.querySelector(selector);
    if (!el) return false;
    if (typeof window.simulateAngularInput !== "function") return false;
    // Always overwrite — OCR data is authoritative
    if (el.value === value) return false; // already correct, skip dispatch
    window.simulateAngularInput(el, value);
    log.info("[Nuskomate OCR] filled →", JSON.stringify(value));
    return true;
  }

  // ── OCR API ─────────────────────────────────────────────────
  // No fallback demo key — every install must supply its own free key
  // (Settings → OCR), so usage counts against that install's own quota
  // instead of one shared key everyone would exhaust together.
  function getApiKey() {
    return new Promise(r => chrome.storage.local.get(["ocrApiKey"], res => r((res.ocrApiKey || "").trim())));
  }

  async function callOCR(file, apiKey) {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("apikey", apiKey);
    fd.append("language", "eng");
    fd.append("scale", "true");
    fd.append("OCREngine", "2");
    fd.append("detectOrientation", "true");
    const res  = await fetch("https://api.ocr.space/parse/image", { method: "POST", body: fd });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.IsErroredOnProcessing) throw new Error(json.ErrorMessage?.[0] || "OCR error");
    return json.ParsedResults?.[0]?.ParsedText || "";
  }

  // ── Image enhancement (rescue pass) ─────────────────────────
  // Straightens (sideways/upside-down/tilted) and text-enhances a copy of the
  // photo via utils/image-prep.js. Sized to stay under ocr.space's 1MB upload
  // limit (JPEG for Gentle, PNG for the compact black-on-white Strong).
  // Returns a File, or null on any error so the caller can just move on.
  async function enhancedFile(file, mode) {
    const P = window.NkImagePrep;
    if (!P) return null;
    try {
      const { canvas } = await P.prepareForOcr(file, { trim: false });
      const enhanced = P.enhanceForOcr(canvas, { mode, minLongEdge: 1800, maxLongEdge: 2400 });
      if (mode === "strong") {
        return new File([await P.canvasToBlob(enhanced, "image/png")], "scan.png", { type: "image/png" });
      }
      for (const q of [0.9, 0.8, 0.7, 0.6]) {
        const blob = await P.canvasToBlob(enhanced, "image/jpeg", q);
        if (blob.size <= 950000) return new File([blob], "scan.jpg", { type: "image/jpeg" });
      }
      return null;
    } catch (_) { return null; }
  }

  function scanIsGood(data) {
    return !!(data && data.mrzValid && data.nameBoxes?.some((b) => b));
  }

  // Pick the better of two parses: prefer a valid MRZ, then more filled boxes
  function pickBetterScan(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (a.mrzValid !== b.mrzValid) return a.mrzValid ? a : b;
    const count = (x) => (x.nameBoxes || []).filter(Boolean).length + (x.issueDate ? 1 : 0);
    return count(b) > count(a) ? b : a;
  }

  // ── Passport parsing lives in the shared module utils/passport-parser.js
  function parsePassport(text) { return window.NkPassport.parse(text); }


  // ── Toast ───────────────────────────────────────────────────
  function toast(msg, type) {
    let el = document.getElementById("nk-ocr-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "nk-ocr-toast";
      Object.assign(el.style, {
        position: "fixed", top: "24px", right: "24px",
        padding: "10px 18px", borderRadius: "10px",
        fontSize: "13px", fontWeight: "600", fontFamily: "system-ui, sans-serif",
        zIndex: "999999", boxShadow: "0 6px 20px rgba(0,0,0,.3)",
        transition: "opacity .3s, transform .3s",
        opacity: "0", transform: "translateY(-6px)", pointerEvents: "none",
      });
      document.body.appendChild(el);
    }
    const bg = { ok: "#22c55e", warn: "#f59e0b", err: "#ef4444", neutral: "#1a2035" };
    el.textContent      = msg;
    el.style.background = bg[type] || bg.neutral;
    el.style.color      = "#fff";
    el.style.opacity    = "1";
    el.style.transform  = "translateY(0)";
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = "0"; el.style.transform = "translateY(-6px)"; },
      type === "neutral" ? 8000 : 3500);
  }


})();
