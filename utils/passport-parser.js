/*
 * Nuskomate — shared passport MRZ + text parser.
 * Loaded in BOTH the content script (form filling) and the popup (bulk parse),
 * so there is a single source of truth. Exposes window.NkPassport.
 */
(function () {
  "use strict";

  const _win = (typeof window !== "undefined") ? window : null; // null in the Worker
  const log = {
    info:  (...a) => (_win && _win.nkLog        ? _win.nkLog(...a)        : console.log(...a)),
    warn:  (...a) => (_win && _win.nkLog?.warn  ? _win.nkLog.warn(...a)   : console.warn(...a)),
    error: (...a) => (_win && _win.nkLog?.error ? _win.nkLog.error(...a)  : console.error(...a)),
  };

  // ── Date extraction from visible text ──────────────────────
  const MONTHS = { JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12 };

  // OCR sometimes returns Cyrillic/Greek letters that look identical to Latin
  // (e.g. "ОСТ" instead of "OCT"). Map the confusable ones back to Latin.
  const HOMOGLYPHS = {
    // Cyrillic uppercase
    "А":"A","В":"B","Е":"E","З":"3","И":"N","К":"K","М":"M","Н":"H","О":"O","Р":"P","С":"C","Т":"T","У":"Y","Х":"X","І":"I","Ј":"J","Ѕ":"S","Ё":"E",
    // Cyrillic lowercase
    "а":"a","в":"b","е":"e","к":"k","м":"m","н":"h","о":"o","р":"p","с":"c","т":"t","у":"y","х":"x","і":"i","ј":"j","ѕ":"s",
    // Greek uppercase
    "Α":"A","Β":"B","Ε":"E","Ζ":"Z","Η":"H","Ι":"I","Κ":"K","Μ":"M","Ν":"N","Ο":"O","Ρ":"P","Τ":"T","Υ":"Y","Χ":"X",
  };

  function normalizeText(text) {
    // Strip diacritics (JUL) then fold homoglyphs (Cyrillic OCT to Latin OCT)
    return text
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\u0000-\u007F]/g, (c) => HOMOGLYPHS[c] || c);
  }

  function parseTextDate(str) {
    // Handles "22 APR 2024", "22APR2024", "01 NOV 1978"
    const m = str.match(/(\d{1,2})\s*([A-Z]{3})\s*(\d{4})/i);
    if (!m) return "";
    const mon = MONTHS[m[2].toUpperCase()];
    if (!mon) return "";
    return `${m[3]}-${String(mon).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}`;
  }

  // Extract the issue date from the visible text.
  // The OCR'd label ("Date of Issue") is often garbled beyond recognition
  // (e.g. "Dota of"), so we DON'T rely on it. Instead: a Pakistani passport
  // shows exactly three dates — DOB, Issue, Expiry. We already know DOB and
  // Expiry from the MRZ, so the issue date is simply the remaining visible
  // date that matches neither. Falls back to label-matching if MRZ is absent.
  function extractDates(lines, mrzDob, mrzExpiry) {
    // All distinct "DD MON YYYY" dates in the visible text, in order
    const visible = [];
    for (const line of lines) {
      const d = parseTextDate(line);
      if (d && !visible.includes(d)) visible.push(d);
    }

    // Primary: odd-one-out using MRZ dates (label-independent, OCR-proof)
    if (mrzDob && mrzExpiry) {
      const ym = (d) => d.slice(0, 7); // compare on YYYY-MM (tolerates day OCR slips)
      const dobYM = ym(mrzDob), expYM = ym(mrzExpiry);
      const candidates = visible.filter((d) => ym(d) !== dobYM && ym(d) !== expYM);

      if (candidates.length === 1) return { issueDate: candidates[0] };

      if (candidates.length > 1) {
        // Disambiguate: issue date is ~5 or ~10 years before expiry (validity)
        const exp = new Date(mrzExpiry);
        const near = candidates.find((d) => {
          const yrs = (exp - new Date(d)) / (365.25 * 86400000);
          return Math.abs(yrs - 5) < 0.2 || Math.abs(yrs - 10) < 0.2;
        });
        if (near) return { issueDate: near };
        return { issueDate: candidates[0] };
      }
    }

    // Fallback: label-based (used only when the MRZ is missing/unreadable)
    for (let i = 0; i < lines.length; i++) {
      const lo = lines[i].toLowerCase();
      if (lo.includes("issue") && !lo.includes("expir")) {
        const date = parseTextDate(lines[i + 1] || "") || parseTextDate(lines[i]);
        if (date) return { issueDate: date };
      }
    }

    return { issueDate: "" };
  }

  // Verify (and if needed correct) the OCR'd issue date against the MRZ expiry.
  // Pakistani passports are valid 5 or 10 years, with expiry = issue + Ny − 1 day.
  // Since the expiry is MRZ-protected (check digits), we can derive the expected
  // issue date and trust it over a typo'd OCR reading.
  //   • OCR date within ~2 days of derived → OCR is fine, keep its exact value
  //   • OCR date far off (a real typo)      → replace with the derived date + flag
  function refineIssueDate(ocrIssue, mrzExpiry) {
    if (!mrzExpiry || !ocrIssue) return { issueDate: ocrIssue || "", corrected: false };

    const exp = new Date(mrzExpiry);
    const iss = new Date(ocrIssue);
    if (isNaN(exp) || isNaN(iss)) return { issueDate: ocrIssue, corrected: false };

    const derive = (yrs) => {
      const d = new Date(exp);
      d.setFullYear(d.getFullYear() - yrs);
      d.setDate(d.getDate() + 1); // expiry = issue + Ny − 1 day
      return d;
    };
    const days = (a, b) => Math.abs(a - b) / 86400000;

    // Choose the validity (5 or 10 yr) whose derived issue date is nearest the OCR one
    const cand5 = derive(5), cand10 = derive(10);
    const derived = days(iss, cand5) <= days(iss, cand10) ? cand5 : cand10;
    const offBy = days(iss, derived);

    if (offBy <= 2) return { issueDate: ocrIssue, corrected: false }; // agree → trust OCR

    const fmt = (d) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    log.warn(`[Nuskomate OCR] issue date "${ocrIssue}" disagrees with expiry by ${Math.round(offBy)}d → corrected to ${fmt(derived)}`);
    return { issueDate: fmt(derived), corrected: true };
  }

  // ── Passport parser ─────────────────────────────────────────
  function parsePassport(text) {
    // Normalize OCR noise: diacritics (JÛL→JUL) + homoglyphs (Cyrillic ОСТ→OCT)
    text = normalizeText(text);

    const lines  = text.split("\n").map(l => l.trim()).filter(Boolean);
    const result = { nameBoxes: ["", "", "", ""] };

    // Father / husband name — from visible text, skipping city names
    const fatherRaw    = extractParentName(lines);
    const fatherTokens = normaliseParentName(fatherRaw);

    // MRZ — all fields (used + display-only)
    let mrzGiven = [], mrzFamily = "", mrzExpiry = "", m = null;
    const mrz = findMRZ(lines);
    if (mrz) {
      // Visible-zone lines (no "<") — used to tell a compound surname from a
      // surname+given split that OCR mangled.
      const vizLines = lines.filter((l) => !l.includes("<"))
                            .map((l) => l.replace(/\s+/g, " ").trim().toUpperCase());
      m         = parseMRZLines(mrz[0], mrz[1], vizLines);
      mrzGiven  = m.givenParts || [];
      mrzFamily = m.familyName || "";
      mrzExpiry = m.expiry || "";
      result.dob    = m.dob;
      result.gender = m.gender;

      // Repair MRZ name tokens corrupted by "<" filler misread as letters,
      // using the clean name printed in the visual zone (e.g. RAHMANK→RAHMAN).
      const viz = vizWords(lines, mrz);
      mrzGiven  = mrzGiven.map((t) => correctNameToken(t, viz));
      mrzFamily = mrzFamily.split(/\s+/).filter(Boolean)
                           .map((t) => correctNameToken(t, viz)).join(" ");
      m.givenParts = mrzGiven;
      m.familyName = mrzFamily;
    }

    // Issue date — the visible date that is neither DOB nor expiry (from MRZ),
    // then cross-checked against the expiry to catch/correct OCR typos.
    const rawIssue = extractDates(lines, result.dob, mrzExpiry).issueDate;
    const refined  = refineIssueDate(rawIssue, mrzExpiry);
    result.issueDate = refined.issueDate;

    // Place-of-birth city (e.g. "HANGU, PAK" → "Hangu") for the city fields
    result.birthCity = extractBirthCity(lines);

    // Per-field MRZ check-digit results (drives the on-page warnings)
    result.checks = mrz
      ? checkMRZ(mrz[1])
      : { passportNo: true, dob: true, expiry: true, composite: true };

    // ── Full detail set for the popup viewer (display only — form filling
    //    keeps using nameBoxes/dob/gender/issueDate above) ──────────────────
    result.details = {
      docType:        m ? m.docType : "",
      issuingCountry: m ? m.issuingCountry : "",
      surname:        m ? (m.familyName || "") : "",
      givenNames:     mrzGiven.join(" "),
      fullName:       [mrzGiven.join(" "), m ? m.familyName : ""].filter(Boolean).join(" "),
      passportNo:     m ? m.passportNo : "",
      nationality:    m ? m.nationality : "",
      dob:            result.dob || "",
      sex:            m ? (m.gender || m.sexCode) : "",
      expiry:         mrzExpiry,
      personalNo:     m ? m.personalNo : "",
      fatherName:     normaliseParentName(fatherRaw).join(" "),
      birthCity:      result.birthCity || "",
      placeOfBirth:   extractPlaceOfBirth(lines),
      issuingAuthority: extractIssuingAuthority(lines),
      cnic:           extractCNIC(text),
      trackingNumber: extractTracking(lines),
      bookletNumber:  extractBooklet(lines),
      age:            computeAge(result.dob),
      issueDate:      result.issueDate || "",
      mrzLine1:       mrz ? mrz[0] : "",
      mrzLine2:       mrz ? mrz[1] : "",
      checks:         result.checks,
    };

    // ── Blurry detection ───────────────────────────────────────
    let blurry = false;

    // 0. Issue date corrected against expiry → flag for verification
    if (refined.corrected) blurry = true;

    // 1. MRZ check-digit validation (also an objective scan-quality signal)
    result.mrzValid = !!(mrz && validateMRZ(mrz[1]));
    if (mrz && !result.mrzValid) {
      blurry = true;
      log.warn("[Nuskomate OCR] MRZ check digits failed — image may be blurry");
    }

    // 2. Clean digits that crept into name tokens (e.g. T→1, O→0). Split the
    //    family name into individual words so multi-word surnames distribute
    //    across the name boxes instead of overflowing one.
    const familyWords = mrzFamily ? mrzFamily.split(/\s+/).filter(Boolean) : [];
    const mrzClean    = cleanNameTokens([...mrzGiven, ...familyWords]);
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

  // A line that looks like a person's name: all-caps letters (with spaces,
  // commas, hyphens, apostrophes), not a place, keyword, or date.
  function isLikelyNameLine(s) {
    if (!s || s.length < 3) return false;
    if (s !== s.toUpperCase()) return false;
    if (!/^[A-Z][A-Z\s'.,\-]+$/.test(s)) return false;
    if (isPlaceName(s)) return false;
    if (/^(PAKISTANI|PAKISTAN|PASSPORT|NATIONALITY|TYPE|SEX|MALE|FEMALE|REPUBLIC|ISLAMIC)$/.test(s)) return false;
    if (parseTextDate(s)) return false;
    // Must contain a plausible name token (≥3 letters with a vowel) so OCR junk
    // sitting between fields — e.g. "WW N", "S/W", "CARRYCO" — isn't mistaken
    // for a name and grabbed instead of the real father/husband line below it.
    const tokens = s.split(/[\s,]+/).filter(Boolean);
    if (!tokens.some((t) => t.length >= 3 && /[AEIOU]/.test(t))) return false;
    return true;
  }

  // Extract the father / husband name from OCR lines.
  // Pass 1 — explicit "Father" / "Husband" label line.
  // Pass 2 — positional: the name printed right after the "Place of Birth"
  //           line ("CITY, PAK"); catches comma-less names like "NOOR ULLAH".
  // Pass 3 — scan for a "SURNAME, GIVEN" all-caps comma line.
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

      // Scan next few lines; skip place-name artefacts from two-column layouts.
      // Require an ALL-CAPS person name (isLikelyNameLine) so OCR-garbled labels
      // like "Datn of lesus" (mixed case) are never mistaken for the father.
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const c = lines[j].trim();
        if (!c) continue;
        if (parseTextDate(c)) break;          // hit the dates → stop
        if (isPlaceName(c)) continue;
        if (isLikelyNameLine(c)) return c;
      }
      break;
    }

    // ── Pass 2: positional (after Place of Birth) ──────────────
    // In label-less OCR dumps the father/husband name is the line directly
    // after the place-of-birth line. This works with or without a comma
    // ("NOOR ULLAH", "ZAMAN, GOHAR", "AWAN, MUHAMMAD MIRZA").
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes(",") || !isPlaceName(lines[i])) continue; // place-of-birth line
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const c = lines[j].trim();
        if (!c) continue;
        if (parseTextDate(c)) break;          // reached the dates → no father line here
        if (isLikelyNameLine(c)) return c;
      }
      break;
    }

    // ── Pass 3: label-free comma scan ──────────────────────────
    // The father name is the only all-caps line with a comma whose second
    // part is NOT a short country/city code (e.g. "AWAN, MUHAMMAD MIRZA").
    for (const line of lines) {
      if (!line.includes(",")) continue;
      // All uppercase only (passport data, not the introductory paragraphs)
      if (line !== line.toUpperCase()) continue;
      // Letters, spaces, commas, hyphens, apostrophes — no digits
      if (!/^[A-Z][A-Z\s'.,\-]+$/.test(line)) continue;
      // Skip place names: "MULTAN, PAK" / "CITY, PAKISTAN"
      if (isPlaceName(line)) continue;
      // Require at least one given name after the comma ("ZAMAN, GOHAR")
      const afterComma = line.split(",").slice(1).join(",").trim();
      if (afterComma.split(/\s+/).filter(Boolean).length < 1) continue;

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

  // Country / place words used to reject place-of-birth lines like
  // "RAWALPINDI, PAK" or "LAHORE, PAKISTAN" so they're not read as a father name.
  const COUNTRY_WORDS = /^(PAKISTAN|SAUDI|ARABIA|INDIA|AFGHANISTAN|IRAN|CHINA|BANGLADESH|UNITED|KINGDOM|STATES|EMIRATES)$/;

  // KNOWN country codes only — must NOT match short given names like LAL, ALI,
  // GUL, DIN, which would otherwise be mistaken for a "CITY, CODE" place.
  const COUNTRY_CODES = new Set([
    "PAK","AFG","IND","IRN","CHN","BGD","NPL","LKA","BTN","MMR",
    "SAU","KSA","ARE","UAE","QAT","KWT","OMN","BHR","IRQ","SYR","JOR","YEM",
    "EGY","TUR","USA","GBR","UK","US","CAN","AUS","DEU","FRA","ITA","ESP",
    "PK","SA","AE",
  ]);

  // Returns true when a string looks like a place: "CITY, PAK" / "CITY, PAKISTAN"
  // / bare "PAK" — i.e. the part after the comma is a known country code/word.
  function isPlaceName(str) {
    if (!str) return false;
    if (str.includes(",")) {
      const last = str.split(",").pop().trim().toUpperCase();
      if (COUNTRY_CODES.has(last) || COUNTRY_WORDS.test(last)) return true;
    }
    const t = str.trim().toUpperCase();
    if (COUNTRY_CODES.has(t) || COUNTRY_WORDS.test(t)) return true; // bare code/name
    return false;
  }

  // Place of birth city — the part before the comma in a "CITY, PAK" line.
  function extractBirthCity(lines) {
    for (const line of lines) {
      if (!line.includes(",") || !isPlaceName(line)) continue; // "CITY, PAK" line
      const city = line.split(",")[0].trim();
      if (/^[A-Za-z][A-Za-z .'\-]{1,}$/.test(city)) {
        return city.split(/\s+/).map(toTitleCase).join(" ");
      }
    }
    return "";
  }

  // Full place of birth as printed ("Hangu, PAK").
  function extractPlaceOfBirth(lines) {
    for (const line of lines) {
      if (!line.includes(",") || !isPlaceName(line)) continue;
      const parts = line.split(",").map(p => p.trim());
      const city = parts[0].split(/\s+/).map(toTitleCase).join(" ");
      const code = parts[parts.length - 1].toUpperCase();
      if (/^[A-Za-z]/.test(city)) return code ? `${city}, ${code}` : city;
    }
    return "";
  }

  // Pakistani CNIC, e.g. 14101-2491702-3
  function extractCNIC(text) {
    const m = text.match(/\b\d{5}-\d{7}-\d\b/);
    return m ? m[0] : "";
  }

  // Value printed under a (possibly OCR-garbled) label, matched loosely.
  // Uses the text after a ":" on the label line, else the next line that fits.
  function labeledValue(lines, labelRe, valueRe) {
    for (let i = 0; i < lines.length; i++) {
      if (!labelRe.test(lines[i])) continue;
      const ci = lines[i].indexOf(":");
      if (ci !== -1) {
        const inline = lines[i].slice(ci + 1).trim();
        if (inline && (!valueRe || valueRe.test(inline))) return inline;
      }
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
        const c = lines[j].trim();
        if (!c) continue;
        return (!valueRe || valueRe.test(c)) ? c : "";
      }
    }
    return "";
  }

  function extractIssuingAuthority(lines) {
    const v = labeledValue(lines, /iss?u\w*\s*auth|aut(h|o)r/i, /^[A-Za-z]{3,}/);
    return v ? v.split(/\s+/).map(toTitleCase).join(" ") : "";
  }

  function extractTracking(lines) {
    const v = labeledValue(lines, /track|tra[icl]?n|tracr/i, /^\d{8,14}$/);
    if (v) return v;
    const num = lines.find(l => /^\d{10,13}$/.test(l.trim()));
    return num ? num.trim() : "";
  }

  function extractBooklet(lines) {
    return labeledValue(lines, /book|bo[oc]k?l|budk|bocie|booldet/i, /^[A-Z]{1,2}\d{5,9}$/);
  }

  function computeAge(dob) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob || "")) return "";
    const d = new Date(dob), now = new Date();
    let age = now.getFullYear() - d.getFullYear();
    const md = now.getMonth() - d.getMonth();
    if (md < 0 || (md === 0 && now.getDate() < d.getDate())) age--;
    return age >= 0 && age < 130 ? String(age) : "";
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

  // Per-field MRZ check-digit validation (ICAO 9303 TD3, line 2).
  //   passportNo: chars 1-9  → check digit at 10
  //   dob:        chars 14-19 → check digit at 20
  //   expiry:     chars 22-27 → check digit at 28
  //   composite:  chars 1-10 + 14-20 + 22-43 → final check digit at 44
  // Returns { passportNo, dob, expiry, composite } booleans.
  function checkMRZ(l2) {
    const got = (i) => (/[0-9]/.test(l2[i]) ? +l2[i] : -1); // non-digit ⇒ never matches
    const composite = l2.slice(0, 10) + l2.slice(13, 20) + l2.slice(21, 43);
    const exp = {
      passportNo: mrzDigit(l2.slice(0, 9)),
      dob:        mrzDigit(l2.slice(13, 19)),
      expiry:     mrzDigit(l2.slice(21, 27)),
      composite:  mrzDigit(composite),
    };
    return {
      passportNo: exp.passportNo === got(9),
      dob:        exp.dob        === got(19),
      expiry:     exp.expiry     === got(27),
      composite:  exp.composite  === got(43),
      expected:   exp,                                      // correct check digits
      actual:     { passportNo: l2[9], dob: l2[19], expiry: l2[27], composite: l2[43] },
    };
  }

  // True when the three key field check digits are valid (overall scan quality).
  function validateMRZ(l2) {
    const c = checkMRZ(l2);
    return c.passportNo && c.dob && c.expiry;
  }

  // ── MRZ helpers ─────────────────────────────────────────────
  function findMRZ(lines) {
    // A TD3 passport MRZ is two lines of exactly 44 chars:
    //   line 1: P<CCC SURNAME<<GIVEN<…<   (type, country, names, "<" padding)
    //   line 2: passportNo(9) chk natl(3) dob(6) chk sex expiry(6) chk … (44)
    // OCR often mangles the long "<" runs — splitting a line's padding onto its
    // own line(s), or dropping padding entirely. So we identify the two lines by
    // STRUCTURE, not length, then pad each back out to the canonical 44 chars.
    const merged = [];
    for (const raw of lines) {
      // OCR routinely misreads the MRZ "<" filler as "&" (and the type/country
      // "P<" as "P&"). Those stray chars otherwise fail the MRZ char test and
      // make us reject an entire valid MRZ — normalise them back to "<".
      let l = raw.replace(/\s/g, "").toUpperCase().replace(/&/g, "<");
      if (!l) continue;
      // If a line is MOSTLY MRZ characters, coerce the few stray ones (".", "/",
      // non-ASCII OCR noise, etc.) to "<" filler instead of rejecting the whole
      // line. A scattered dot in the "<" padding must not lose the entire MRZ.
      const clean = l.replace(/[^A-Z0-9<]/g, "");
      if (clean.length >= l.length * 0.7) l = l.replace(/[^A-Z0-9<]/g, "<");
      // A pure-"<" fragment is dropped padding → reattach to the previous line
      if (/^<+$/.test(l) && merged.length) merged[merged.length - 1] += l;
      else merged.push(l);
    }

    // Line 2 signature: passportNo(9) + checkdigit + nationality(3) + dob(6)…
    const line2Re = /^[A-Z0-9<]{9}[0-9<][A-Z<]{3}[0-9<]{6}/;
    // Line 1: type "P" + a 5-char letters/"<" head (P<CCC… — OCR sometimes
    // misreads the "P<" filler as a letter, e.g. "PSPAK"), carrying the
    // surname/given "<<" separator. The "<<" requirement keeps place-of-birth
    // lines ("PAKPATTAN<PAK", single "<") and line-2 data rows (digits in the
    // head) from matching.
    const isL1 = (s) => s.length >= 10 && s[0] === "P" && /^[A-Z<]{5}/.test(s) && s.includes("<<");
    const isL2 = (s) => s.length >= 28 && line2Re.test(s);

    // Pick the first line-1 and first line-2 found ANYWHERE in the block — this
    // tolerates rotated/landscape scans where the data line is printed before
    // the name line, and ignores stray text lines sitting between them.
    let l1 = null, l2 = null;
    for (const s of merged) {
      if (!l1 && isL1(s)) l1 = s;
      else if (!l2 && isL2(s)) l2 = s;
    }
    if (l1 && l2) {
      return [l1.padEnd(44, "<").slice(0, 44), l2.padEnd(44, "<").slice(0, 44)];
    }
    return null;
  }

  // OCR sometimes misreads the MRZ's trailing "<" padding as a long run of
  // letters (e.g. "SSSSSSSSSSSSSSSSSaSYY"), producing a fake name token. Reject
  // tokens that are implausibly long or dominated by one repeated character.
  function isGarbageToken(t) {
    if (!t) return true;
    if (t.length >= 16) return true;
    // Real names always carry a vowel. OCR debris from the MRZ "<" padding
    // (e.g. "SCK", "CK", "&", "K") never does — drop it.
    if (!/[AEIOU]/i.test(t)) return true;
    if (t.length >= 6) {
      const u = t.toUpperCase();
      const counts = {};
      let max = 0;
      for (const ch of u) { counts[ch] = (counts[ch] || 0) + 1; if (counts[ch] > max) max = counts[ch]; }
      if (max / u.length >= 0.6) return true;
    }
    return false;
  }

  // Build the set of clean words printed in the visual (non-MRZ) zone. Used to
  // repair MRZ name tokens whose trailing char is actually misread "<" filler.
  function vizWords(lines, mrz) {
    const skip = new Set((mrz || []).map((l) => l.replace(/\s/g, "").toUpperCase()));
    const set = new Set();
    for (const ln of lines) {
      if (skip.has(ln.replace(/\s/g, "").toUpperCase())) continue;
      for (const w of ln.toUpperCase().split(/[^A-Z]+/)) {
        if (w.length >= 2) set.add(w);
      }
    }
    return set;
  }

  // If an MRZ name token is absent from the visual zone but trimming its last
  // letter matches a visual-zone word, that last letter is OCR debris from the
  // "<" padding (e.g. RAHMAN<< misread as RAHMANK<) — drop it. Conservative:
  // only acts on tokens ≥4 chars and only when the page itself shows the
  // shorter form, so correctly-read names (which appear verbatim) are untouched.
  function correctNameToken(tokTitle, viz) {
    const u = tokTitle.toUpperCase();
    if (!u || viz.has(u)) return tokTitle;
    if (u.length >= 4 && viz.has(u.slice(0, -1))) return toTitleCase(u.slice(0, -1));
    return tokTitle;
  }

  function parseMRZLines(l1, l2, vizLines) {
    const r = { givenParts: [] };
    // Line 1: P<CCC SURNAME<<GIVEN NAMES
    r.docType         = l1.slice(0, 1).replace(/</g, "");
    r.issuingCountry  = l1.slice(2, 5).replace(/</g, "");
    const nameStr = l1.slice(5);
    const sep     = nameStr.indexOf("<<");
    let famRaw = sep >= 0 ? nameStr.slice(0, sep) : nameStr;
    let givRaw = sep >= 0 ? nameStr.slice(sep + 2) : "";

    let givenParts = givRaw.replace(/<+$/, "").split("<")
                           .filter((t) => t && !isGarbageToken(t)).map(toTitleCase);
    // OCR frequently misreads the "<<" surname/given separator as a single "<"
    // (or a stray letter), so the real split is lost and the "<<" we found is
    // just trailing padding — dumping both names into famRaw. Detect that (no
    // VALID given name survived, but an internal "<" remains in famRaw) and
    // re-split: first token = surname, the rest = given names. This also covers
    // the case where the given side is present but pure OCR garbage (e.g. the
    // "<" padding misread as "SKKKKKK…").
    //
    // BUT some passports legitimately have a multi-word SURNAME with NO given
    // name (e.g. "HAMMAD<UL<HASSAN<<" → surname "HAMMAD UL HASSAN"). That looks
    // identical in the MRZ, so we check the visible zone: if the full surname
    // appears there as one line, it's a real compound surname — don't re-split.
    const famClean = famRaw.replace(/<+$/, "");
    const famSpaced = famClean.replace(/</g, " ").trim();
    const isCompoundSurname = !!(vizLines && famSpaced.includes(" ") &&
      vizLines.some((l) => l.includes(famSpaced)));
    if (!givenParts.length && famClean.includes("<") && !isCompoundSurname) {
      const toks = famClean.split("<").filter(Boolean);
      famRaw = toks[0] || "";
      givenParts = toks.slice(1).filter((t) => !isGarbageToken(t)).map(toTitleCase);
    }
    r.familyName = famRaw.replace(/</g, " ").trim()
                         .split(/\s+/).filter((w) => w && !isGarbageToken(w))
                         .map(toTitleCase).join(" ");
    r.givenParts = givenParts;
    // Line 2: passportNo(9) chk natl(3) dob(6) chk sex expiry(6) chk personal(14) …
    r.passportNo  = l2.slice(0, 9).replace(/</g, "");
    r.nationality = l2.slice(10, 13).replace(/</g, "");
    r.dob    = mrzDate(l2.slice(13, 19), true);
    r.expiry = mrzDate(l2.slice(21, 27), false);
    const sx = l2[20];
    r.sexCode = sx === "<" ? "" : sx;
    r.gender  = sx === "M" ? "Male" : sx === "F" ? "Female" : "";
    r.personalNo = l2.slice(28, 42).replace(/</g, "");
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

  const NkPassport = {
    parse: parsePassport,
    distributeWords,
    checkMRZ,
    mrzDate,
    computeAge,
  };
  if (_win) _win.NkPassport = NkPassport;                       // browser
  if (typeof module !== "undefined" && module.exports) module.exports = NkPassport; // server build
})();
