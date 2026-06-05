(function () {
  "use strict";

  // Logging shim — prefers the persistent extension logger, falls back to console
  const log = {
    info:  (...a) => (window.nkLog       ? window.nkLog(...a)       : console.log(...a)),
    warn:  (...a) => (window.nkLog?.warn  ? window.nkLog.warn(...a)  : console.warn(...a)),
    error: (...a) => (window.nkLog?.error ? window.nkLog.error(...a) : console.error(...a)),
  };

  let isEnabled       = true;
  let scanned         = {};
  let fillTimer       = null;
  let calcTimer       = null;
  let issueDateTimer  = null;
  let lastFileId      = null;
  let started         = false;

  // ── Lifecycle ───────────────────────────────────────────────
  chrome.storage.local.get(["extensionEnabled", "moduleOcr"], (res) => {
    if (res.extensionEnabled === false) { isEnabled = false; return; }
    isEnabled = res.moduleOcr !== false;
    if (isEnabled) start();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.extensionEnabled && !changes.extensionEnabled.newValue) { isEnabled = false; stop(); return; }
    if (changes.moduleOcr !== undefined) {
      isEnabled = changes.moduleOcr.newValue !== false;
      isEnabled ? start() : stop();
    }
  });

  function start() {
    if (started) return;
    started = true;
    document.addEventListener("change", onFileChange, true);
    window.addEventListener("nusuk-route-change", onRouteChange);
    loadFromStorage(); // restore after reload
    log.info("[Nuskomate OCR] started");
  }

  function stop() {
    started = false;
    document.removeEventListener("change", onFileChange, true);
    window.removeEventListener("nusuk-route-change", onRouteChange);
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
        if (saved?.nameBoxes?.some(b => b)) {
          scanned = saved;
          scheduleFill();
          log.info("[Nuskomate OCR] restored from storage:", scanned.nameBoxes);
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

    const fileId = `${file.name}_${file.size}_${file.lastModified}`;
    if (fileId === lastFileId) return;
    lastFileId = fileId;

    // New passport → wipe the PREVIOUS scan completely before we start.
    // Stops the old fill loops re-asserting stale names and clears persisted
    // data, so a failed/rate-limited scan can never keep showing old values.
    clearInterval(fillTimer);
    clearInterval(calcTimer);
    clearInterval(issueDateTimer);
    scanned = {};
    chrome.storage.local.remove("ocrScanned");

    log.info("[Nuskomate OCR] detected upload:", file.name);
    toast("Scanning passport…", "neutral");

    try {
      const apiKey = await getApiKey();
      const text   = await callOCR(file, apiKey);
      log.info("[Nuskomate OCR] raw text:\n", text);

      const data = parsePassport(text);
      log.info("[Nuskomate OCR] parsed:", data);

      if (data.nameBoxes?.some(b => b)) {
        scanned = data;
        saveToStorage();
        scheduleFill();

        if (data.issueDate) {
          navigator.clipboard?.writeText(data.issueDate).catch(() => {});
        }

        if (data.blurry) {
          toast("⚠ Filled — verify names (image may be blurry)", "warn");
        } else {
          const clip = data.issueDate ? ` · Issue ${data.issueDate} copied` : "";
          toast(`✓ Passport scanned${clip}`, "ok");
        }
      } else {
        toast("⚠ No passport data found — try a clearer image", "warn");
      }
    } catch (err) {
      log.error("[Nuskomate OCR] error:", err);
      toast("✗ OCR failed: " + err.message, "err");
    }
  }

  // ── Fill form ───────────────────────────────────────────────
  function scheduleFill() {
    clearInterval(fillTimer);
    clearInterval(calcTimer);

    // Keep re-asserting the names until they stay correct for several
    // consecutive ticks. The nusuk page runs its OWN MRZ extraction after a
    // passport upload and overwrites our values (box0=given, box3=surname) —
    // often AFTER our first successful fill. Requiring sustained stability
    // means we win that race instead of stopping too early.
    let nameStable = 0;
    applyFields();
    fillTimer = setInterval(() => {
      const correct = applyFields();
      nameStable = correct ? nameStable + 1 : 0;
      if (nameStable >= 6) clearInterval(fillTimer); // correct & stable ~5s
    }, 800);
    setTimeout(() => clearInterval(fillTimer), 25000);

    // Calculator sync — independent timer
    calcTimer = setInterval(() => { if (syncCalculator()) clearInterval(calcTimer); }, 600);
    setTimeout(() => clearInterval(calcTimer), 60000);

    // Issue date — completely independent timer.
    // Runs until the field has the correct value and stays that way.
    clearInterval(issueDateTimer);
    if (scanned.issueDate) {
      let stable = 0;
      issueDateTimer = setInterval(() => {
        const filled = fillIssueDate();
        stable = filled ? stable + 1 : 0;
        if (stable >= 3) clearInterval(issueDateTimer); // value held for 3 ticks
      }, 600);
      setTimeout(() => clearInterval(issueDateTimer), 60000);
    }
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

    // Keep retrying until EVERY name box actually holds its intended value.
    // The form can render box-by-box, and other modules (e.g. autofill copying
    // firstName→familyName) may overwrite a box right after we set it — so we
    // re-assert every tick until all boxes are correct and stable.
    let allBoxesCorrect = true;
    const snapshot = []; // diagnostic: state of each box this tick
    (scanned.nameBoxes || []).forEach((val, i) => {
      const sel = BOX_SEL[i];
      if (!sel) return;
      const el = document.querySelector(sel);
      const want = val ?? "";
      if (!el) {
        snapshot.push(`box${i}:MISSING(want="${want}")`);
        allBoxesCorrect = false;
        return;
      }
      const before = el.value;
      if (el.value !== want) {
        fill(sel, want);
        snapshot.push(`box${i}:was="${before}"→set="${want}"`);
        if (want) allBoxesCorrect = false;
      } else {
        snapshot.push(`box${i}:ok="${want}"`);
      }
    });

    // Log whenever a box was (re)set or is missing — including later overwrites
    // by the site. Stays quiet once everything is steady-state "ok".
    const changed = snapshot.some(s => s.includes("→set") || s.includes("MISSING"));
    if (changed) log.info("[Nuskomate OCR] boxes:", snapshot.join(" | "));

    fillCalendar('p-calendar[formcontrolname="birthDate"]',         scanned.dob);
    fillCalendar('p-calendar[formcontrolname="passportIssueDate"]', scanned.issueDate);

    if (scanned.gender && typeof window.sharedDropdownHandler === "function") {
      window.sharedDropdownHandler('p-dropdown[formcontrolname="gender"]', scanned.gender);
    }

    // Only stop the retry interval once all boxes are present AND correct
    return allBoxesCorrect;
  }

  // Reverse-populate the Issue Date Calculator widget.
  // Once years/days are set correctly the calculator fires its own handler
  // which writes the computed date straight into passportIssueDate.
  // Returns true when sync succeeded so the caller can stop retrying.
  function syncCalculator() {
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
  function getApiKey() {
    return new Promise(r => chrome.storage.local.get(["ocrApiKey"], res => r(res.ocrApiKey || "helloworld")));
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

  // ── Date extraction from visible text ──────────────────────
  const MONTHS = { JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12 };

  function parseTextDate(str) {
    // Handles "22 APR 2024", "22APR2024", "01 NOV 1978"
    const m = str.match(/(\d{1,2})\s*([A-Z]{3})\s*(\d{4})/i);
    if (!m) return "";
    const mon = MONTHS[m[2].toUpperCase()];
    if (!mon) return "";
    return `${m[3]}-${String(mon).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}`;
  }

  // Only extract the issue date — that's all OCR fills for dates.
  // DOB comes from MRZ; expiry is left to the existing calculator.
  function extractDates(lines) {
    for (let i = 0; i < lines.length; i++) {
      const lo = lines[i].toLowerCase();
      // "Date of Issue", "ate er issue", "date issue" — any garbled variant
      if (lo.includes("issue") && !lo.includes("expir")) {
        const date = parseTextDate(lines[i + 1] || "") || parseTextDate(lines[i]);
        if (date) return { issueDate: date };
      }
    }
    return { issueDate: "" };
  }

  // ── Passport parser ─────────────────────────────────────────
  function parsePassport(text) {
    const lines  = text.split("\n").map(l => l.trim()).filter(Boolean);
    const result = { nameBoxes: ["", "", "", ""] };

    // Father / husband name — from visible text, skipping city names
    const fatherRaw    = extractParentName(lines);
    const fatherTokens = normaliseParentName(fatherRaw);

    // Issue date — only exists in the visible text section, not in MRZ
    result.issueDate = extractDates(lines).issueDate;

    // MRZ — given names + family name + DOB + gender
    let mrzGiven = [], mrzFamily = "";
    const mrz = findMRZ(lines);
    if (mrz) {
      const m   = parseMRZLines(mrz[0], mrz[1]);
      mrzGiven  = m.givenParts || [];
      mrzFamily = m.familyName || "";
      result.dob    = m.dob;
      result.gender = m.gender;
    }

    // ── Blurry detection ───────────────────────────────────────
    let blurry = false;

    // 1. MRZ check-digit validation
    if (mrz && !validateMRZ(mrz[1])) {
      blurry = true;
      log.warn("[Nuskomate OCR] MRZ check digits failed — image may be blurry");
    }

    // 2. Clean digits that crept into name tokens (e.g. T→1, O→0)
    const mrzClean    = cleanNameTokens([...mrzGiven, ...(mrzFamily ? [mrzFamily] : [])]);
    const fatherClean = cleanNameTokens(fatherTokens);
    if (mrzClean.corrected || fatherClean.corrected) {
      blurry = true;
      log.warn("[Nuskomate OCR] digit-in-name corrections applied:", {
        mrz:    mrzClean.tokens,
        father: fatherClean.tokens,
      });
    }

    result.blurry = blurry;

    // ── Box distribution (using cleaned tokens) ─────────────────
    const [b1, b2]  = distributeWords(mrzClean.tokens, 2, 15);
    result.nameBoxes[0] = b1;
    result.nameBoxes[1] = b2;

    const [b3, b4]  = fatherToBoxes(fatherClean.tokens);
    result.nameBoxes[2] = b3;
    result.nameBoxes[3] = b4;

    return result;
  }

  // Extract the father / husband name from OCR lines.
  // Pass 1 — look for an explicit "Father" / "Husband" label line.
  // Pass 2 — fallback for passports where OCR produces no labels: scan every
  //           all-uppercase line for the pattern "SURNAME, GIVEN1 GIVEN2"
  //           and reject anything that looks like a place name.
  function extractParentName(lines) {
    // ── Pass 1: label-based ────────────────────────────────────
    for (let i = 0; i < lines.length; i++) {
      const lo = lines[i].toLowerCase();
      if (!/father|husband/.test(lo)) continue;

      const ci = lines[i].indexOf(":");
      if (ci !== -1) {
        const v = lines[i].slice(ci + 1).trim();
        if (v && !isPlaceName(v)) return v;
      }

      // Scan next few lines; skip place-name artefacts from two-column layouts
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const c = lines[j].trim();
        if (!c) continue;
        if (/^(date|nation|passport|birth|sex|place|type|issue|expiry|tracking|booklet|citizen)/i.test(c)) break;
        if (isPlaceName(c)) continue;
        if (/^[A-Z][A-Z\s'.,\-]+$/i.test(c) && c.length >= 3) return c;
      }
      break;
    }

    // ── Pass 2: label-free fallback ────────────────────────────
    // Some passports print only values in the OCR output (no headings).
    // The father name is the only all-caps line with a comma whose second
    // part is NOT a short country/city code (e.g. "AWAN, MUHAMMAD MIRZA").
    for (const line of lines) {
      if (!line.includes(",")) continue;
      // All uppercase only (passport data, not the introductory paragraphs)
      if (line !== line.toUpperCase()) continue;
      // Letters, spaces, commas, hyphens, apostrophes — no digits
      if (!/^[A-Z][A-Z\s'.,\-]+$/.test(line)) continue;
      // Skip place names: "MULTAN, PAK" → last comma-segment is a 2-3 letter code
      if (isPlaceName(line)) continue;
      // Require at least two words after the comma (given name + more)
      const afterComma = line.split(",").slice(1).join(",").trim();
      if (afterComma.split(/\s+/).filter(Boolean).length < 2) continue;

      return line;
    }

    return "";
  }

  // "SHAH, RIZWAN ABBAS" → ["Rizwan", "Abbas", "Shah"]  (surname moved to end)
  // "RIZWAN ABBAS SHAH"  → ["Rizwan", "Abbas", "Shah"]
  function normaliseParentName(raw) {
    if (!raw) return [];
    let ordered = raw;
    if (raw.includes(",")) {
      const parts = raw.split(",").map(p => p.trim()).filter(Boolean);
      // parts[0] = "SHAH" (surname-first), rest = given names
      ordered = [...parts.slice(1), parts[0]].join(" ");
    }
    return ordered.trim().split(/\s+/).filter(Boolean).map(toTitleCase);
  }

  // Returns true when a string looks like "CITY, PAK" or bare "PAK" —
  // i.e. the last comma-segment is a 2-3 uppercase letter country/place code.
  function isPlaceName(str) {
    if (!str) return false;
    if (str.includes(",")) {
      const last = str.split(",").pop().trim();
      if (/^[A-Z]{2,3}$/.test(last)) return true;   // e.g. PAK, USA, UAE
    }
    // Bare country code
    if (/^[A-Z]{2,3}$/.test(str.trim())) return true;
    return false;
  }

  // Father name → [box3, box4]
  // If all tokens fit in one string (≤15 chars): box3="", box4=full string
  // Otherwise: distribute left→right across boxes 3 and 4
  function fatherToBoxes(tokens) {
    if (!tokens.length) return ["", ""];
    const joined = tokens.join(" ");
    if (joined.length <= 15) return ["", joined];
    return distributeWords(tokens, 2, 15);
  }

  // Pack word tokens into `boxes` slots; each slot ≤ maxLen chars; never split a word.
  function distributeWords(tokens, boxes, maxLen) {
    const result = Array(boxes).fill("");
    let b = 0;
    for (const word of tokens) {
      if (b >= boxes) break;
      const candidate = result[b] ? result[b] + " " + word : word;
      if (candidate.length <= maxLen) {
        result[b] = candidate;
      } else {
        b++;
        if (b < boxes) result[b] = word;
      }
    }
    return result;
  }

  // ── Blurry-image helpers ─────────────────────────────────────

  // Digits that look like letters in OCR — replace them inside name tokens.
  // Returns { tokens: string[], corrected: boolean }
  const DIGIT_LETTER = { '0':'O', '1':'I', '2':'Z', '5':'S', '6':'G', '8':'B', '7':'T' };

  function cleanNameTokens(tokens) {
    let corrected = false;
    const clean = tokens.map(t =>
      t.replace(/[0-9]/g, d => { corrected = true; return DIGIT_LETTER[d] || d; })
    );
    return { tokens: clean, corrected };
  }

  // MRZ check-digit algorithm (ICAO Doc 9303)
  function mrzDigit(str) {
    const W = [7, 3, 1];
    let sum = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      const v = c === '<' ? 0 : c >= '0' && c <= '9' ? +c : c.charCodeAt(0) - 55;
      sum += (v < 0 ? 0 : v) * W[i % 3];
    }
    return sum % 10;
  }

  // Returns true when all three MRZ line-2 check digits are valid.
  function validateMRZ(l2) {
    return (
      mrzDigit(l2.slice(0, 9))  === +l2[9]  &&   // passport number
      mrzDigit(l2.slice(13, 19)) === +l2[19] &&   // date of birth
      mrzDigit(l2.slice(21, 27)) === +l2[27]       // date of expiry
    );
  }

  // ── MRZ helpers ─────────────────────────────────────────────
  function findMRZ(lines) {
    const re = /^[A-Z0-9<]{30,}$/;
    for (let i = 0; i < lines.length - 1; i++) {
      const l1 = lines[i].replace(/\s/g, "").toUpperCase();
      const l2 = lines[i + 1].replace(/\s/g, "").toUpperCase();
      if (l1.length >= 30 && l2.length >= 30 && re.test(l1) && re.test(l2) && l1[0] === "P")
        return [l1.padEnd(44, "<").slice(0, 44), l2.padEnd(44, "<").slice(0, 44)];
    }
    return null;
  }

  function parseMRZLines(l1, l2) {
    const r = { givenParts: [] };
    const nameStr = l1.slice(5);
    const sep     = nameStr.indexOf("<<");
    if (sep >= 0) {
      r.familyName = toTitleCase(nameStr.slice(0, sep).replace(/</g, " ").trim());
      r.givenParts = nameStr.slice(sep + 2).replace(/<+$/, "").split("<")
                            .filter(Boolean).map(toTitleCase);
    }
    r.dob    = mrzDate(l2.slice(13, 19), true);
    r.expiry = mrzDate(l2.slice(21, 27), false);
    const sx = l2[20];
    r.gender = sx === "M" ? "Male" : sx === "F" ? "Female" : "";
    return r;
  }

  function mrzDate(yymmdd, isPast) {
    if (!/^\d{6}$/.test(yymmdd)) return "";
    const yy    = parseInt(yymmdd.slice(0, 2), 10);
    const nowYY = new Date().getFullYear() % 100;
    const year  = isPast && yy > nowYY ? 1900 + yy : 2000 + yy;
    return `${year}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
  }

  function toTitleCase(s) {
    return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : "";
  }

  // ── Toast ───────────────────────────────────────────────────
  function toast(msg, type) {
    let el = document.getElementById("nk-ocr-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "nk-ocr-toast";
      Object.assign(el.style, {
        position: "fixed", bottom: "24px", right: "24px",
        padding: "10px 18px", borderRadius: "10px",
        fontSize: "13px", fontWeight: "600", fontFamily: "system-ui, sans-serif",
        zIndex: "999999", boxShadow: "0 6px 20px rgba(0,0,0,.3)",
        transition: "opacity .3s, transform .3s",
        opacity: "0", transform: "translateY(6px)", pointerEvents: "none",
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
    el._t = setTimeout(() => { el.style.opacity = "0"; el.style.transform = "translateY(6px)"; },
      type === "neutral" ? 8000 : 3500);
  }

  // ── Popup manual fill ───────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action !== "ocr-fill") return;
    const d = message.data || {};
    scanned = {
      nameBoxes: d.nameBoxes || distributeWords(
        [d.firstName, d.secondName, d.thirdName, d.familyName]
          .join(" ").split(/\s+/).filter(Boolean), 4, 15
      ),
      dob:       d.dob,
      issueDate: d.issueDate,
      gender:    d.gender,
    };
    saveToStorage();
    scheduleFill();
    sendResponse({ ok: true });
    return true;
  });

})();
