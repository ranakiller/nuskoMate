(function () {
  "use strict";

  const RULES_KEY = "autoClickRules";
  const LEGACY_KEY = "autoButtons";

  // Click/fill/select rules used to be 3 separately-licensed categories —
  // merged into one "Rules" tab/toggle/tool-id (autorules). featOK("autorules")
  // also accepts the 3 old tool ids so already-issued keys keep working
  // without needing to be reissued immediately (see refreshEnabled below).
  let autoRulesEnabled = false; // click/input/dropdown rules (moduleAutoRules)
  let workflowsEnabled = false; // workflows run/hotkeys (moduleWorkflows)
  let translateRulesEnabled = false; // translation rules (moduleTranslateRules)
  let rules = [];
  let inspectorDefaults = {};
  const executedRules = new Set();
  const pendingRules = new Set();
  const lastRunAt = new Map();

  // ── Visibility ────────────────────────────────────────────────────────────

  function isVisible(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  // ── Advanced selectors (Tier 3) ───────────────────────────────────────────
  // Every selector everywhere (rules, workflow steps, triggers, highlight)
  // understands, besides plain CSS:
  //   xpath=//button[@id='x']   or a raw XPath starting with "/" or "("
  //   text=Submit               element whose visible text EQUALS (case-insens.)
  //   text*=Subm                element whose visible text CONTAINS
  //   a || b || c               fallback chain — first one that matches wins
  function findByXPath(xp) {
    try {
      const r = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const n = r.singleNodeValue;
      return n && n.nodeType === 1 ? n : null;
    } catch (_) { return null; }
  }

  const TEXT_SCAN = "button, a, [role='button'], input[type='button'], input[type='submit'], label, li, span, td, th, p-dropdown, div";
  // includeHidden: skip the visibility filter — for hotkey-fired rules only
  // (see fireRuleHotkey). Menu items in a closed PrimeNG/Angular dropdown are
  // usually still IN the DOM, just hidden via CSS, and calling .click() on
  // them still works (a real click handler doesn't care about visibility) —
  // matching how a hand-written querySelectorAll+.click() script behaves.
  // Every OTHER caller (auto-scan rules, workflow steps, waitUntil, …) keeps
  // the strict default (includeHidden left undefined/false) since firing on
  // a hidden match unattended is exactly the kind of mistake that gate exists
  // to prevent.
  function findByText(txt, exact, includeHidden) {
    const want = String(txt || "").trim().toLowerCase();
    if (!want) return null;
    let best = null, bestLen = Infinity;
    for (const el of document.querySelectorAll(TEXT_SCAN)) {
      const t = (el.innerText || el.textContent || "").trim().toLowerCase();
      if (!t || t.length > want.length + 120) continue;   // skip big containers early
      if (exact ? t !== want : !t.includes(want)) continue;
      if (!includeHidden && !isVisible(el)) continue;
      // Tightest (shortest-text) match wins → the actual button, not its wrapper.
      if (t.length < bestLen) { best = el; bestLen = t.length; }
    }
    return best;
  }

  function resolveOne(sel, includeHidden) {
    sel = String(sel || "").trim();
    if (!sel) return null;
    if (/^xpath=/i.test(sel)) return findByXPath(sel.slice(6));
    if (sel[0] === "/" || sel[0] === "(") return findByXPath(sel);
    if (/^text\*=/i.test(sel)) return findByText(sel.slice(6), false, includeHidden);
    if (/^text=/i.test(sel))   return findByText(sel.slice(5), true, includeHidden);
    try {
      return document.querySelector(sel);
    } catch (err) {
      console.warn("Invalid selector skipped:", sel, err);
      return null;
    }
  }

  function getElement(selector, includeHidden) {
    if (!selector) return null;
    // Fallback chain: try each "||"-separated alternative in order.
    const parts = String(selector).split("||");
    for (const p of parts) {
      const el = resolveOne(p, includeHidden);
      if (el) return el;
    }
    return null;
  }

  // Plural counterpart to getElement() — same selector syntax (CSS, xpath=,
  // text=, text*=, "a || b" fallback chains), returns every VISIBLE match
  // instead of just the first. Powers the "For each match" workflow repeat
  // mode (iterate every row/button matching a selector, one at a time).
  function findAllByXPath(xp) {
    try {
      const r = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const out = [];
      for (let i = 0; i < r.snapshotLength; i++) out.push(r.snapshotItem(i));
      return out;
    } catch (_) { return []; }
  }
  // includeHidden: same idea as findByText's — a "For each match" workflow
  // is an explicit, deliberate bulk action the user configured, and (like a
  // hotkey rule) is exactly the case where a still-in-the-DOM-but-hidden
  // batch of matches (e.g. every row's own hidden dropdown-menu item) is
  // the whole point, not a mistake to guard against.
  function findAllByText(txt, exact, includeHidden) {
    const want = String(txt || "").trim().toLowerCase();
    if (!want) return [];
    const found = [];
    for (const el of document.querySelectorAll(TEXT_SCAN)) {
      const t = (el.innerText || el.textContent || "").trim().toLowerCase();
      if (!t || t.length > want.length + 120) continue;
      if (exact ? t !== want : !t.includes(want)) continue;
      if (!includeHidden && !isVisible(el)) continue;
      found.push(el);
    }
    // Leaf-most wins: drop any match that CONTAINS another match (e.g. a
    // wrapping <div> around the actual <button>) — same tightest-match
    // principle as findByText's shortest-text tiebreak, generalized to a list.
    return found.filter((el) => !found.some((other) => other !== el && el.contains(other)));
  }
  function resolveAll(sel, includeHidden) {
    sel = String(sel || "").trim();
    if (!sel) return [];
    if (/^xpath=/i.test(sel)) return findAllByXPath(sel.slice(6));
    if (sel[0] === "/" || sel[0] === "(") return findAllByXPath(sel);
    if (/^text\*=/i.test(sel)) return findAllByText(sel.slice(6), false, includeHidden);
    if (/^text=/i.test(sel))   return findAllByText(sel.slice(5), true, includeHidden);
    try {
      const all = [...document.querySelectorAll(sel)];
      return includeHidden ? all : all.filter(isVisible);
    } catch (err) {
      console.warn("Invalid selector skipped:", sel, err);
      return [];
    }
  }
  // "For each match" always passes includeHidden=true (see runWorkflow) —
  // every other caller of getAllElements (none yet, but keep this default
  // strict for anything added later) gets the safe, visibility-filtered
  // behavior unless it explicitly asks otherwise.
  function getAllElements(selector, includeHidden) {
    const parts = String(selector || "").split("||");
    for (const p of parts) {
      const found = resolveAll(p, includeHidden);
      if (found.length) return found;
    }
    return [];
  }

  // ── Path / condition matching ─────────────────────────────────────────────

  function pathMatches(rule) {
    const pathname = window.location.pathname;
    const rulePath = rule.pathname || rule.path || "";
    if (!rulePath) return true;
    const mode = rule.pathMatch || rule.urlMatch || "exact";
    return mode === "includes" ? pathname.includes(rulePath) : pathname === rulePath;
  }

  // includeHidden: passed as true only from fireRuleHotkey — lets a hotkey
  // rule match/click a menu item that's still in the DOM but visually hidden
  // inside a closed dropdown (see findByText's comment above). Auto-scanned
  // rules never pass this, so their behavior is unchanged.
  function conditionsPass(rule, includeHidden) {
    if (!rule.enabled || !pathMatches(rule)) return false;

    const requiredSelectors = Array.isArray(rule.requiredElements)
      ? rule.requiredElements
      : rule.requiredElement ? [rule.requiredElement]
      : rule.selector ? [rule.selector]
      : [];

    if (!requiredSelectors.length) return false;

    const requiredElements = requiredSelectors.map((s) => getElement(s, includeHidden));
    if (requiredElements.some((el) => !el || (!includeHidden && !isVisible(el)))) return false;

    const forbiddenSelectors = Array.isArray(rule.forbiddenElements)
      ? rule.forbiddenElements
      : rule.forbiddenElement ? [rule.forbiddenElement]
      : [];

    if (forbiddenSelectors.length) {
      const allForbiddenPresent = forbiddenSelectors.every((sel) => {
        const el = getElement(sel);
        return el && isVisible(el);
      });
      if (allForbiddenPresent) return false;
    }

    const primary = requiredElements[0];
    const targetText = (primary.innerText || primary.textContent || "").trim().toLowerCase();
    const expectedText = (rule.text || "").toLowerCase();
    if (expectedText && !targetText.includes(expectedText)) return false;

    return primary;
  }

  // ── Native value setter (React / Angular compat) ──────────────────────────

  function setNativeValue(element, value) {
    const proto = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  // ── Action executors ──────────────────────────────────────────────────────

  function isElementDisabled(element) {
    return !!(
      element.disabled ||
      element.getAttribute("disabled") === "true" ||
      element.getAttribute("aria-disabled") === "true" ||
      element.classList.contains("disabled")
    );
  }

  function clickElement(element) {
    if (isElementDisabled(element)) return;
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    element.click();
  }

  // ── Date/time formatting (for fill rules whose value is "today's date") ───
  // Tokens: YYYY YY MMM MM DD HH mm ss. Longer tokens are listed first in the
  // alternation so e.g. "YYYY" isn't partially consumed by the "YY" branch.
  function formatDate(d, fmt) {
    const p2 = (n) => String(n).padStart(2, "0");
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const map = {
      YYYY: d.getFullYear(), YY: String(d.getFullYear()).slice(-2),
      MMM: MONTHS[d.getMonth()], MM: p2(d.getMonth() + 1),
      DD: p2(d.getDate()), HH: p2(d.getHours()), mm: p2(d.getMinutes()), ss: p2(d.getSeconds()),
    };
    return String(fmt || "YYYY-MM-DD").replace(/YYYY|YY|MMM|MM|DD|HH|mm|ss/g, (t) => (t in map ? String(map[t]) : t));
  }

  // Fill rules can produce either static text or today's date/time in a
  // chosen format, optionally wrapped in a prefix/suffix — e.g.
  // prefix "Ref-" + date "YYYYMMDD" + suffix "-A" → "Ref-20260710-A".
  function resolveFillValue(rule) {
    const base = rule.valueMode === "date"
      ? formatDate(new Date(), (rule.dateFormat === "custom" ? rule.dateFormatCustom : rule.dateFormat) || "YYYY-MM-DD")
      : (rule.fillValue || "");
    return (rule.prefix || "") + base + (rule.suffix || "");
  }

  function fillInput(element, rule) {
    const value = resolveFillValue(rule);
    element.focus();

    if (rule.clearFirst !== false) {
      setNativeValue(element, "");
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }

    if (rule.triggerAngularEvents !== false) {
      element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true }));
    }

    setNativeValue(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));

    if (rule.triggerAngularEvents !== false) {
      element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true }));
    }
  }

  function selectOption(element, rule) {
    // Native <select>
    if (element.tagName.toLowerCase() === "select") {
      const matchBy = rule.selectMatchBy || "value";
      const target = (rule.selectValue || "").toLowerCase();
      let matched = null;

      for (const option of element.options) {
        const candidate = matchBy === "text"
          ? option.text.trim().toLowerCase()
          : option.value.toLowerCase();
        if (candidate === target) { matched = option; break; }
      }

      if (!matched) return;

      element.value = matched.value;
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new Event("input", { bubbles: true }));

      if (rule.triggerAngularEvents !== false) {
        element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
        element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
      }
      return;
    }

    // Custom dropdown (PrimeNG p-dropdown, etc.). The matched element may be the
    // container, the .p-dropdown wrapper, or the label span itself — the
    // element-based handler resolves the label from any of them (and the
    // captured selector's .p-placeholder class disappears once a value is set,
    // so we work off the live element rather than re-querying the selector).
    const value = rule.selectValue || "";
    if (typeof window.sharedDropdownHandlerEl === "function") {
      window.sharedDropdownHandlerEl(element, value);
    } else if (typeof window.sharedDropdownHandler === "function") {
      window.sharedDropdownHandler((rule.requiredElements && rule.requiredElements[0]) || "", value);
    } else {
      clickElement(element);
    }
  }

  function setCheckbox(element, targetState) {
    const shouldCheck = targetState === "toggle" ? !element.checked : targetState === "checked";
    if (element.checked !== shouldCheck) element.click();
  }

  function executeAction(rule, element) {
    switch (rule.type || "button") {
      case "input":    fillInput(element, rule); break;
      case "dropdown": selectOption(element, rule); break;
      case "checkbox": setCheckbox(element, rule.targetState || "checked"); break;
      case "radio":
      case "button":
      default:         clickElement(element);
    }
    console.log(`Auto-rule [${rule.type || "button"}]:`, rule.name || rule.id);
  }

  // ── Rule execution ────────────────────────────────────────────────────────

  function executeRule(rule, element) {
    const action = rule.action || { type: "run", delayMs: 0 };
    const id = String(rule.id);
    const isRepeat = !!rule.repeat;

    if (!isRepeat && executedRules.has(id)) return;
    if (pendingRules.has(id)) return;

    if (isRepeat) {
      const cooldown = Math.max(Number(rule.repeatIntervalMs) || 0, 0);
      const prev = lastRunAt.get(id) || 0;
      if (cooldown > 0 && Date.now() - prev < cooldown) return;
    }

    pendingRules.add(id);
    // Human-like jitter: up to jitterMs of random extra wait before acting.
    const jitter = Math.max(Number(rule.jitterMs) || 0, 0);
    const delayMs = (action.type === "delay" ? Math.max(Number(action.delayMs) || 0, 0) : 0)
                  + (jitter ? Math.floor(Math.random() * jitter) : 0);

    setTimeout(() => {
      pendingRules.delete(id);

      if (action.type === "stop") {
        if (!isRepeat) executedRules.add(id);
        lastRunAt.set(id, Date.now());
        return;
      }

      const freshElement = conditionsPass(rule);
      if (!freshElement) return;

      executeAction(rule, freshElement);
      if (!isRepeat) executedRules.add(id);
      lastRunAt.set(id, Date.now());
    }, delayMs);
  }

  // Fires a rule immediately on its hotkey — separate from executeRule()
  // because none of its dedup/cooldown state applies here: a hotkey press is
  // an explicit ask, so it should always attempt to fire, not just once per
  // page (executedRules) or throttled to repeatIntervalMs. Still re-validates
  // conditions (path/required/forbidden/text) right before acting, and still
  // applies jitter for human-like timing.
  function fireRuleHotkey(rule) {
    // includeHidden=true: a hotkey press is explicit and deliberate, so
    // match even a menu item sitting hidden inside a closed dropdown — same
    // as a hand-written querySelectorAll+.click() script would.
    const element = conditionsPass(rule, true);
    if (!element) { wlog(`hotkey rule "${rule.name}" — conditions not met, nothing to do`); return; }
    const jitter = Math.max(Number(rule.jitterMs) || 0, 0);
    const delayMs = jitter ? Math.floor(Math.random() * jitter) : 0;
    setTimeout(() => {
      const freshElement = conditionsPass(rule, true);
      if (!freshElement) return;
      executeAction(rule, freshElement);
    }, delayMs);
  }

  // ── Normalization ─────────────────────────────────────────────────────────

  function normalizeSelectorArray(value) {
    if (Array.isArray(value)) return value.map((s) => String(s || "").trim()).filter(Boolean);
    if (typeof value === "string") return value.split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);
    return [];
  }

  function normalizeAction(rule) {
    const raw = rule.action;

    if (raw && ["run", "stop", "delay"].includes(raw.type)) {
      return { type: raw.type, delayMs: Math.max(Number(raw.delayMs) || 0, 0) };
    }

    const oldType = typeof raw === "string" ? raw : (raw?.type || "click");
    const oldDelay = Math.max(Number(typeof raw === "object" ? raw?.delay : 0) || 0, 0);

    if (oldType === "dontClick" || oldType === "stop" || oldType === "delay") {
      return { type: "stop", delayMs: 0 };
    }
    return { type: "run", delayMs: oldDelay };
  }

  function normalizeRepeat(rule) {
    if (typeof rule.repeat === "boolean") return rule.repeat;
    if (rule.alwaysClick) return true;
    const raw = rule.action;
    if (raw && (raw === "alwaysClick" || raw?.type === "alwaysClick")) return true;
    return false;
  }

  function normalizeRule(rule) {
    const requiredElements = normalizeSelectorArray(
      rule.requiredElements || rule.requiredElement || rule.selector || [],
    );
    const forbiddenElements = normalizeSelectorArray(
      rule.forbiddenElements || rule.forbiddenElement || [],
    );

    return {
      id: rule.id || Date.now() + Math.random(),
      type: rule.type || "button",
      enabled: rule.enabled !== false,
      name: rule.name || rule.text || requiredElements[0] || "Unnamed",
      text: rule.text || "",
      pathname: rule.pathname !== undefined
        ? rule.pathname
        : (rule.path !== undefined ? rule.path : window.location.pathname),
      pathMatch: rule.pathMatch || rule.urlMatch || "exact",
      requiredElements,
      forbiddenElements,
      action: normalizeAction(rule),
      repeat: normalizeRepeat(rule),
      repeatIntervalMs: Math.max(Number(rule.repeatIntervalMs) || Number(rule.alwaysClickDelay) || 0, 0),
      jitterMs: Math.max(Number(rule.jitterMs) || 0, 0),
      // "auto" (default) = today's behavior, fires as soon as conditions
      // pass. "hotkey" = never auto-fires from the scan loop — only runs
      // when its keyboard combo is pressed (see the Hotkey triggers section).
      triggerMode: rule.triggerMode === "hotkey" ? "hotkey" : "auto",
      hotkey: rule.hotkey || "",
      fillValue: rule.fillValue || "",
      valueMode: rule.valueMode === "date" ? "date" : "text",
      dateFormat: rule.dateFormat || "YYYY-MM-DD",
      dateFormatCustom: rule.dateFormatCustom || "",
      prefix: rule.prefix || "",
      suffix: rule.suffix || "",
      clearFirst: rule.clearFirst !== false,
      triggerAngularEvents: rule.triggerAngularEvents !== false,
      selectValue: rule.selectValue || "",
      selectMatchBy: rule.selectMatchBy || "value",
      targetState: rule.targetState || "checked",
      // Translation rules: "fieldToField" reads a separate source element and
      // writes its translation into requiredElements[0]; "autoDetect" scans
      // requiredElements[0] (which may match many elements) for foreign text
      // and translates it in place, duplicating a row per extra target language.
      mode: rule.mode === "autoDetect" ? "autoDetect" : "fieldToField",
      sourceSelector: rule.sourceSelector || "",
      sourceLang: rule.sourceLang || "en",
      targetLang: rule.targetLang || "ar",
      targetLangs: Array.isArray(rule.targetLangs) ? rule.targetLangs.filter(Boolean) : [],
      // autoDetect only — "replace" overwrites the page text in place
      // (original behavior); "tooltip" leaves the text untouched and shows
      // the translation in an instant hover tooltip instead.
      displayMode: rule.displayMode === "tooltip" ? "tooltip" : "replace",
    };
  }

  // ── Scan loop ─────────────────────────────────────────────────────────────

  // Click/input/dropdown rules all share one "Rules" gate now; translate
  // rules are their own separate category (fundamentally a different kind
  // of action, not click/fill/select — kept apart on purpose).
  function ruleCategory(rule) {
    return rule.type === "translate" ? "translate" : "auto";
  }
  function categoryEnabled(cat) {
    return cat === "translate" ? translateRulesEnabled : autoRulesEnabled;
  }

  function scanRules() {
    if (!rules.length || !autoRulesEnabled) return;
    rules.forEach((rule) => {
      if (rule.type === "translate") return; // handled by scanTranslateRules(), not click/fill/select's engine
      if (rule.triggerMode === "hotkey") return; // fires only via its hotkey, never auto-scanned
      if (!categoryEnabled(ruleCategory(rule))) return;
      const element = conditionsPass(rule);
      if (element) executeRule(rule, element);
    });
  }

  function setRules(nextRules) {
    rules = (nextRules || []).map(normalizeRule);
    executedRules.clear();
    pendingRules.clear();
    lastRunAt.clear();
    refreshHotkeys(); // rule hotkeys live in this same list — keep the combo map current
    scanRules();
    scanTranslateRules();
  }

  // ── Translation rules ──────────────────────────────────────────────────────
  // Two independent modes sharing one rule shape (see normalizeRule above):
  //   fieldToField — reactive, one source element → one target element, fixed
  //                  language pair, fully user-configurable (no hardcoded
  //                  field selectors — the old modules/translation.js that
  //                  hardcoded 7 of these was removed once this could cover
  //                  it; background.js seeds 4 of them — the name fields —
  //                  as default rules so nobody lost anything).
  //   autoDetect   — scans requiredElements[0] (may match MANY elements, e.g.
  //                  a whole column of rows), auto-detects the language of
  //                  whatever text shows up, and translates it in place for
  //                  the FIRST configured target language; any ADDITIONAL
  //                  target languages get a cloned duplicate element inserted
  //                  right after, holding that language's translation.
  // Both bypass scanRules()/executeAction() entirely — they need async API
  // calls and per-element "did this actually change" caching that doesn't fit
  // the click/fill/select engine's fire-once dedup model.

  const RTL_LANGS = new Set(["ar", "ur", "fa", "he", "ps", "syr", "dv", "ku", "yi"]);
  function applyDir(el, lang) {
    try { el.setAttribute("dir", RTL_LANGS.has(lang) ? "rtl" : "ltr"); } catch (_) {}
  }

  function isFieldElement(el) {
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
  }
  function readElementText(el) {
    return (isFieldElement(el) ? el.value : (el.innerText || el.textContent || "")).trim();
  }
  function writeElementText(el, text) {
    if (isFieldElement(el)) {
      if (typeof window.simulateAngularInput === "function") window.simulateAngularInput(el, text);
      else {
        el.value = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    } else {
      el.textContent = text;
    }
  }

  // Arabic-transliteration fallback — used only when the target language is
  // Arabic AND the API either failed outright or clearly didn't translate
  // (empty, unchanged, or still has Latin letters in it).
  const EN_TO_AR_MAP = {
    a: "ا", b: "ب", c: "ك", d: "د", e: "ي", f: "ف", g: "ج",
    h: "ه", i: "ي", j: "ج", k: "ك", l: "ل", m: "م", n: "ن",
    o: "و", p: "ب", q: "ق", r: "ر", s: "س", t: "ت", u: "و",
    v: "ف", w: "و", x: "كس", y: "ي", z: "ذ",
    0: "٠", 1: "١", 2: "٢", 3: "٣", 4: "٤", 5: "٥",
    6: "٦", 7: "٧", 8: "٨", 9: "٩",
    " ": " ", "-": "-", "'": "", '"': "",
  };
  function transliterateToArabic(text) {
    return text.split("").map((ch) => EN_TO_AR_MAP[ch.toLowerCase()] || ch).join("");
  }

  // data[0] = translated segments, data[2] = detected source language (only
  // meaningful when sl="auto" was passed). Unofficial endpoint, already
  // whitelisted in manifest.json's host_permissions.
  function translateText(text, sl, tl) {
    const toArabic = String(tl || "").toLowerCase().startsWith("ar");
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;
    return fetch(url).then((res) => res.json()).then((data) => {
      let translated = ((data && data[0]) || []).map((seg) => seg[0]).join("");
      const detected = (data && data[2]) || (sl === "auto" ? "" : sl);
      const invalid = !translated || translated.toLowerCase() === text.toLowerCase() || /[a-z]/i.test(translated);
      if (invalid && toArabic) translated = transliterateToArabic(text);
      else if (!translated) translated = text;
      return { translated, detected };
    }).catch((err) => {
      if (toArabic) return { translated: transliterateToArabic(text), detected: "" };
      throw err;
    });
  }

  function resolveSystemLanguage(pref) {
    if (pref && pref !== "system") return pref;
    try { return (chrome.i18n.getUILanguage() || "en").split("-")[0].toLowerCase(); } catch (_) { return "en"; }
  }

  // ── Mode: fieldToField ──────────────────────────────────────────────────
  // Keyed by rule id (not element) — the rule shape only ever has ONE source
  // + ONE target, so there's nothing to disambiguate beyond the rule itself.
  const translateSourceCache = new Map();

  function scanTranslateFieldToField() {
    rules.forEach((rule) => {
      if (rule.type !== "translate" || rule.mode === "autoDetect" || !rule.enabled) return;
      if (!pathMatches(rule)) return;
      const targetEl = getElement(rule.requiredElements[0]);
      const sourceEl = getElement(rule.sourceSelector);
      if (!targetEl || !sourceEl) return;
      const raw = readElementText(sourceEl);
      if (!raw) return;
      const key = String(rule.id);
      if (translateSourceCache.get(key) === raw) return;
      translateSourceCache.set(key, raw); // set before the await — prevents firing again mid-flight
      translateText(raw, rule.sourceLang || "en", rule.targetLang || "ar")
        .then(({ translated }) => {
          writeElementText(targetEl, translated);
          applyDir(targetEl, rule.targetLang || "ar");
        })
        .catch(() => {});
    });
  }

  // ── Mode: autoDetect (broadcast to N languages) ──────────────────────────
  // element → { lastWritten, dupes: [elements] }. lastWritten lets a scan
  // tick tell "did the page change this since we last translated it" apart
  // from "this is just the translation WE wrote sitting there unchanged" —
  // both look identical to a naive text comparison otherwise, which would
  // either loop forever or never re-translate an edit.
  const translateBroadcastCache = new WeakMap();
  // Elements WE inserted as extra-language duplicates — excluded from being
  // scanned as if they were fresh foreign-text matches (a clone can share the
  // same class/selector as its original).
  const translateDupElements = new WeakSet();
  // Guards against the MutationObserver re-entering this same element while
  // its translateText() calls are still in flight (our own writes are
  // mutations too, and several can land before the first call resolves).
  const translateInFlight = new WeakSet();

  // ── Display mode: tooltip ─────────────────────────────────────────────────
  // Leaves the page's own text untouched — the translation only ever shows in
  // a small hover tooltip. Translated ahead of time by the scan loop (same as
  // replace mode) so the tooltip has zero lookup delay; hovering just shows
  // whatever's already cached instead of triggering a fetch, so it appears
  // the instant the cursor lands, no matter how slow the translate API is.
  // The tooltip also carries a "Replace text" button — an explicit, on-demand
  // way to commit that translation into the page for just THAT element,
  // without switching the whole rule over to always-replace mode.
  const tooltipCache = new WeakMap(); // el -> { lastSource, lines: [{lang, text}] }
  const tooltipTargets = new WeakSet(); // elements a tooltip should show for
  const tooltipCommitted = new WeakMap(); // el -> original raw text, once its translation has been committed in place
  let tooltipEl = null;
  let tooltipLinesEl = null;
  let tooltipBtnEl = null;
  let currentTooltipTarget = null;

  function ensureTooltipEl() {
    if (tooltipEl) return tooltipEl;
    tooltipEl = document.createElement("div");
    tooltipEl.id = "nk-translate-tooltip";
    Object.assign(tooltipEl.style, {
      position: "fixed", zIndex: "2147483647", background: "#1f2430", color: "#fff",
      padding: "9px 13px", borderRadius: "8px", fontSize: "15px", fontWeight: "600",
      lineHeight: "1.5", maxWidth: "360px", boxShadow: "0 6px 18px rgba(0,0,0,.32)",
      display: "none", fontFamily: "system-ui, sans-serif",
    });

    tooltipLinesEl = document.createElement("div");
    tooltipEl.appendChild(tooltipLinesEl);

    tooltipBtnEl = document.createElement("button");
    tooltipBtnEl.type = "button";
    Object.assign(tooltipBtnEl.style, {
      display: "block", marginTop: "7px", padding: "5px 10px", width: "100%",
      border: "none", borderRadius: "5px", background: "rgba(255,255,255,.16)",
      color: "#fff", fontSize: "12.5px", fontWeight: "700", cursor: "pointer",
      fontFamily: "inherit",
    });
    tooltipBtnEl.addEventListener("mouseenter", () => { tooltipBtnEl.style.background = "rgba(255,255,255,.28)"; });
    tooltipBtnEl.addEventListener("mouseleave", () => { tooltipBtnEl.style.background = "rgba(255,255,255,.16)"; });
    tooltipBtnEl.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!currentTooltipTarget) return;
      const target = currentTooltipTarget;
      toggleCommit(target);
      showTooltipFor(target); // refresh the button label in place — stays open under the cursor
    });
    tooltipEl.appendChild(tooltipBtnEl);

    // Leaving the tooltip itself (not back onto the target text) hides it —
    // needed now that it has a clickable button, so the cursor has somewhere
    // to actually go without immediately losing the tooltip.
    tooltipEl.addEventListener("mouseleave", () => { hideTooltip(); });

    document.body.appendChild(tooltipEl);
    return tooltipEl;
  }

  function findTooltipTarget(node) {
    let n = node;
    while (n && n !== document.body && n !== document.documentElement) {
      if (tooltipTargets.has(n)) return n;
      n = n.parentElement;
    }
    return null;
  }

  function showTooltipFor(el) {
    const cache = tooltipCache.get(el);
    if (!cache || !cache.lines.length) return;
    currentTooltipTarget = el;
    const tip = ensureTooltipEl();
    tooltipLinesEl.textContent = ""; // each line gets its own dir="auto" div, so mixed-script tooltips (e.g. Arabic + Urdu) still render each line in its own natural direction
    cache.lines.forEach((l) => {
      const line = document.createElement("div");
      line.dir = "auto";
      line.textContent = l.text;
      tooltipLinesEl.appendChild(line);
    });
    tooltipBtnEl.textContent = tooltipCommitted.has(el) ? "↺ Revert to original  (T)" : "✓ Replace text on page  (T)";
    tip.style.display = "block";
    const rect = el.getBoundingClientRect();
    // A tight 2px gap (not the more typical 6-8px) — with the button now
    // clickable, a wider gap gave the cursor a dead zone to lose the tooltip
    // in on the way from the text to the button.
    const above = rect.top - tip.offsetHeight - 2;
    tip.style.top = (above < 4 ? rect.bottom + 2 : above) + "px";
    tip.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - tip.offsetWidth - 4)) + "px";
  }

  function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = "none";
    currentTooltipTarget = null;
  }

  // One language sits on a single line; a second (and any further) language
  // gets a full blank line before it, all inside the SAME element — a <br><br>
  // between each language's <span>, rather than replace mode's separate
  // cloned element per extra language. Each span keeps its own dir="auto" so
  // mixed scripts (e.g. English + Urdu) each still render in their natural
  // direction.
  function writeTranslationLines(el, lines) {
    if (isFieldElement(el)) {
      writeElementText(el, lines.map((l) => l.text).join("\n\n"));
      return;
    }
    el.textContent = "";
    lines.forEach((line, i) => {
      if (i > 0) { el.appendChild(document.createElement("br")); el.appendChild(document.createElement("br")); }
      const span = document.createElement("span");
      span.dir = "auto";
      span.textContent = line.text;
      el.appendChild(span);
    });
    if (lines.length) applyDir(el, lines[0].lang);
  }

  // Commits (or reverts) ALL configured target languages directly into the
  // page for just this one element. The rule itself stays in tooltip mode;
  // this only affects the element you triggered it on. Doesn't touch the
  // tooltip's own visibility — callers (button click, keyboard shortcut)
  // re-show it afterward so the state flip is visible without it blinking
  // shut and reopening.
  function toggleCommit(el) {
    const cache = tooltipCache.get(el);
    if (!cache || !cache.lines.length) return;
    const committed = tooltipCommitted.get(el);
    if (committed) {
      writeElementText(el, committed.originalRaw);
      tooltipCommitted.delete(el);
      return;
    }
    const originalRaw = readElementText(el);
    writeTranslationLines(el, cache.lines);
    tooltipCommitted.set(el, { originalRaw });
  }

  document.addEventListener("mouseover", (e) => {
    const target = findTooltipTarget(e.target);
    if (target) showTooltipFor(target);
  }, true);
  document.addEventListener("mouseout", (e) => {
    const target = findTooltipTarget(e.target);
    if (!target) return;
    const to = e.relatedTarget;
    if (to && (target.contains(to) || (tooltipEl && tooltipEl.contains(to)))) return;
    hideTooltip();
  }, true);

  // Keyboard shortcut for the exact same toggle the button does — the cursor
  // never has to leave the original text (and risk losing the tooltip to a
  // dead zone on the way to the button) to commit or revert a translation.
  // Press T while a tooltip is showing; press it again to flip back.
  document.addEventListener("keydown", (e) => {
    if (!currentTooltipTarget) return;
    if (e.key.toLowerCase() !== "t" || e.ctrlKey || e.altKey || e.metaKey) return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return; // don't steal a keystroke while actually typing somewhere
    e.preventDefault();
    toggleCommit(currentTooltipTarget);
    showTooltipFor(currentTooltipTarget); // refresh the button label + keep the tooltip open so the result is visible immediately
  }, true);

  async function processTooltipElement(rule, el, raw) {
    if (tooltipCommitted.has(el)) return; // text on the page IS the committed translation right now — don't re-translate it as if it were new foreign text
    const cache = tooltipCache.get(el);
    if (cache && cache.lastSource === raw) return; // already translated, text hasn't changed
    if (translateInFlight.has(el)) return;
    translateInFlight.add(el);
    try {
      const langs = rule.targetLangs.length ? rule.targetLangs : [resolveSystemLanguage()];
      const lines = [];
      for (const lang of langs) {
        let translated, detected;
        try {
          const r = await translateText(raw, "auto", lang);
          translated = r.translated; detected = r.detected;
        } catch (_) { continue; }
        if (detected && detected === lang) continue; // already in this language
        lines.push({ lang, text: translated });
      }
      if (lines.length) {
        tooltipCache.set(el, { lastSource: raw, lines });
        tooltipTargets.add(el);
      }
    } finally {
      translateInFlight.delete(el);
    }
  }

  async function processBroadcastElement(rule, el) {
    const raw = readElementText(el);
    if (!raw) return;
    if (rule.displayMode === "tooltip") return processTooltipElement(rule, el, raw);
    const cache = translateBroadcastCache.get(el);
    if (cache && cache.lastWritten === raw) return; // nothing's changed since we last wrote it
    if (translateInFlight.has(el)) return;
    translateInFlight.add(el);

    try {
      const langs = rule.targetLangs.length ? rule.targetLangs : [resolveSystemLanguage()];
      if (cache && cache.dupes) cache.dupes.forEach((d) => { try { d.remove(); } catch (_) {} });

      let primaryText = raw;
      let primaryLang = langs[0];
      const dupes = [];
      let anchor = el;

      for (let i = 0; i < langs.length; i++) {
        const lang = langs[i];
        let translated, detected;
        try {
          const r = await translateText(raw, "auto", lang);
          translated = r.translated; detected = r.detected;
        } catch (_) { continue; }

        if (detected && detected === lang) {
          // Already in this language — nothing to translate into it.
          if (i === 0) { primaryText = raw; primaryLang = lang; }
          continue;
        }
        if (i === 0) {
          primaryText = translated;
          primaryLang = lang;
        } else {
          const dup = el.cloneNode(true);
          writeElementText(dup, translated);
          applyDir(dup, lang);
          translateDupElements.add(dup);
          anchor.insertAdjacentElement("afterend", dup);
          anchor = dup;
          dupes.push(dup);
        }
      }

      writeElementText(el, primaryText);
      applyDir(el, primaryLang);
      translateBroadcastCache.set(el, { lastWritten: primaryText, dupes });
    } finally {
      translateInFlight.delete(el);
    }
  }

  // No selector set = "the whole page" — walk actual TEXT NODES (not a fixed
  // tag list) and translate each one's PARENT element. A TreeWalker over
  // SHOW_TEXT naturally lands on the deepest/leaf-most text-bearing element
  // only (a wrapping <div> around a <span>Hello</span> has no text node of
  // its own there — that text belongs to the span), which avoids double-
  // translating the same text at multiple nesting levels the way a generic
  // tag-list selector scan would.
  const SKIP_TEXT_PARENT_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT"]);
  function getGlobalTextElements() {
    const out = [];
    const seen = new Set();
    let walker;
    try {
      walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          const p = node.parentElement;
          if (!p || SKIP_TEXT_PARENT_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
          // Skip our own injected UI (bar, toasts, etc.) — never translate ourselves.
          if (p.closest("#nkBrnBar, #tm-hotel-auto-toast, #multiHotelBox")) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
    } catch (_) { return out; }
    let n;
    while ((n = walker.nextNode())) {
      const p = n.parentElement;
      if (!p || seen.has(p) || translateDupElements.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
    return out;
  }

  function scanTranslateBroadcast() {
    rules.forEach((rule) => {
      if (rule.type !== "translate" || rule.mode !== "autoDetect" || !rule.enabled) return;
      if (!pathMatches(rule)) return;
      const sel = (rule.requiredElements[0] || "").trim();
      const elements = sel ? getAllElements(sel, true) : getGlobalTextElements();
      elements.forEach((el) => {
        if (translateDupElements.has(el)) return;
        processBroadcastElement(rule, el);
      });
    });
  }

  function scanTranslateRules() {
    if (!rules.length || !translateRulesEnabled) return;
    scanTranslateFieldToField();
    scanTranslateBroadcast();
  }

  // One-shot "pick text to translate" — no rule saved, just an immediate
  // in-place fix using whatever language Settings has configured.
  async function quickTranslateElement(element) {
    if (!element) return;
    const text = readElementText(element);
    if (!text) { alert("No text found on that element."); return; }
    chrome.storage.local.get(["nkLanguage"], async (res) => {
      const targetLang = resolveSystemLanguage(res.nkLanguage);
      try {
        const { translated, detected } = await translateText(text, "auto", targetLang);
        if (detected && detected === targetLang) { alert("That text already looks like it's in your target language."); return; }
        writeElementText(element, translated);
        applyDir(element, targetLang);
      } catch (_) {
        alert("Translation failed — check your connection and try again.");
      }
    });
  }

  // ── Rule saving ───────────────────────────────────────────────────────────

  function buildDefaultRule(selection, forceType) {
    const { selector, text, meta = {} } = selection;
    const elementType = forceType || selection.elementType || "button";

    const base = {
      id: Date.now(),
      type: elementType,
      enabled: true,
      name: text || selector,
      text: elementType === "button" ? text : "",
      pathname: window.location.pathname,
      pathMatch: "exact",
      requiredElements: [selector],
      forbiddenElements: [],
      action: { type: "run", delayMs: 0 },
      repeat: false,
      repeatIntervalMs: 0,
      clearFirst: true,
      triggerAngularEvents: true,
    };

    if (elementType === "input") {
      base.fillValue = meta.currentValue || "";
      if (meta.label) base.name = meta.label;
    } else if (elementType === "dropdown") {
      base.selectValue = meta.currentValue || "";
      base.selectMatchBy = "value";
    } else if (elementType === "checkbox") {
      base.targetState = meta.currentState ? "unchecked" : "checked";
    } else if (elementType === "radio") {
      base.targetState = "checked";
    }

    return base;
  }

  function saveCapturedRule(selection, forceType) {
    const newRule = normalizeRule(buildDefaultRule(selection, forceType));
    chrome.storage.local.get([RULES_KEY], (res) => {
      const nextRules = [...(res[RULES_KEY] || []), newRule];
      chrome.storage.local.set({ [RULES_KEY]: nextRules }, () => {
        inspectorDefaults = {};
        alert(`Rule saved: ${newRule.name}\nType: ${newRule.type}\nPath: ${newRule.pathname}`);
      });
    });
  }

  // `index` targets a SPECIFIC existing selector to replace (the row's own
  // Pick button, popup/auto-clicker.js's per-row payload) — omitted (or past
  // the end of the current array, e.g. a row that hasn't been saved yet)
  // falls back to appending, which is what the list-level "+ Add selector"
  // button asks for.
  function updateSelectorInRule(ruleId, selection, key, index) {
    chrome.storage.local.get([RULES_KEY, LEGACY_KEY], (res) => {
      const current = res[RULES_KEY] || res[LEGACY_KEY] || [];
      const nextRules = current.map((rule) => {
        if (String(rule.id) !== String(ruleId)) return normalizeRule(rule);
        const normalized = normalizeRule(rule);
        const existing = normalizeSelectorArray(normalized[key] || []);
        const next = (index != null && index >= 0 && index < existing.length)
          ? existing.map((s, i) => (i === index ? selection.selector : s))
          : [...existing, selection.selector];
        return { ...normalized, [key]: next.filter(Boolean) };
      });
      chrome.storage.local.set({ [RULES_KEY]: nextRules }, () => {
        alert(`Selector saved: ${selection.selector}`);
      });
    });
  }

  // ── Workflow step capture ─────────────────────────────────────────────────

  function buildStepFromSelection(selection) {
    const { selector, text, elementType = "button", meta = {} } = selection;
    const step = {
      id: Date.now() + Math.floor(Math.random() * 1000),
      type: elementType,
      name: text || selector,
      requiredElements: [selector],
      selector,
      timeoutMs: 8000,
      afterMs: 250,
      optional: false,
    };
    if (elementType === "input") step.fillValue = meta.currentValue || "";
    else if (elementType === "dropdown") { step.selectValue = meta.currentValue || ""; step.selectMatchBy = "value"; }
    else if (elementType === "checkbox") step.targetState = meta.currentState ? "unchecked" : "checked";
    else if (elementType === "radio") step.targetState = "checked";
    return step;
  }

  function saveCapturedStep(selection, workflowId, afterStepId) {
    const step = buildStepFromSelection(selection);
    chrome.storage.local.get(["autoWorkflows"], (res) => {
      const wfs = (res.autoWorkflows || []).map((w) => {
        if (String(w.id) !== String(workflowId)) return w;
        const steps = [...(w.steps || [])];
        const idx = afterStepId != null ? steps.findIndex((s) => String(s.id) === String(afterStepId)) : -1;
        if (idx >= 0) steps.splice(idx + 1, 0, step); else steps.push(step);
        return { ...w, steps };
      });
      chrome.storage.local.set({ autoWorkflows: wfs }, () => alert(`Step added: ${step.name}  (${step.type})`));
    });
  }

  function saveTriggerSelector(selection, workflowId) {
    chrome.storage.local.get(["autoWorkflows"], (res) => {
      const wfs = (res.autoWorkflows || []).map((w) =>
        String(w.id) === String(workflowId) ? { ...w, triggerSelector: selection.selector } : w);
      chrome.storage.local.set({ autoWorkflows: wfs }, () => alert(`Trigger element set: ${selection.selector}`));
    });
  }

  function saveRepeatWhileSelector(selection, workflowId) {
    chrome.storage.local.get(["autoWorkflows"], (res) => {
      const wfs = (res.autoWorkflows || []).map((w) =>
        String(w.id) === String(workflowId) ? { ...w, repeat: { ...(w.repeat || {}), whileSelector: selection.selector } } : w);
      chrome.storage.local.set({ autoWorkflows: wfs }, () => alert(`Selector set: ${selection.selector}`));
    });
  }

  // "For each match" repeat mode's match selector — same save shape as
  // saveRepeatWhileSelector, different repeat field.
  function saveMatchSelector(selection, workflowId) {
    chrome.storage.local.get(["autoWorkflows"], (res) => {
      const wfs = (res.autoWorkflows || []).map((w) =>
        String(w.id) === String(workflowId) ? { ...w, repeat: { ...(w.repeat || {}), matchSelector: selection.selector } } : w);
      chrome.storage.local.set({ autoWorkflows: wfs }, () => alert(`Match selector set: ${selection.selector}`));
    });
  }

  // URL Shifter's "element appears" trigger — Pick sets the element selector
  // on the given redirect rule (modules/url-shifter.js owns its own storage
  // key, "autoUrlShiftRules", separate from click/fill/select rules).
  function saveUsElementSelector(selection, ruleId) {
    chrome.storage.local.get(["autoUrlShiftRules"], (res) => {
      const rules = (res.autoUrlShiftRules || []).map((r) =>
        String(r.id) === String(ruleId) ? { ...r, elementSelector: selection.selector } : r);
      chrome.storage.local.set({ autoUrlShiftRules: rules }, () => alert(`Element selector set: ${selection.selector}`));
    });
  }

  // A translate rule (mode "fieldToField") has a SECOND selector beyond the
  // shared requiredElements — the source it reads FROM. Re-picking it works
  // the same as re-picking the target (updateSelectorInRule), just a
  // different field on the same rule.
  function saveTranslateSourceSelector(selection, ruleId) {
    chrome.storage.local.get([RULES_KEY], (res) => {
      const rules = (res[RULES_KEY] || []).map((r) =>
        String(r.id) === String(ruleId) ? { ...normalizeRule(r), sourceSelector: selection.selector } : normalizeRule(r));
      chrome.storage.local.set({ [RULES_KEY]: rules }, () => alert(`Source selector set: ${selection.selector}`));
    });
  }

  // Re-pick the selector for an EXISTING step (unlike saveCapturedStep, which
  // adds a whole new step). A step has exactly one target, so this REPLACES
  // requiredElements/selector rather than appending like rules' multi-selector
  // "Pick Required/Forbidden" does.
  function updateWorkflowStepSelector(selection, workflowId, stepId) {
    chrome.storage.local.get(["autoWorkflows"], (res) => {
      const wfs = (res.autoWorkflows || []).map((w) => {
        if (String(w.id) !== String(workflowId)) return w;
        return {
          ...w,
          steps: (w.steps || []).map((s) => String(s.id) === String(stepId)
            ? { ...s, requiredElements: [selection.selector], selector: selection.selector }
            : s),
        };
      });
      chrome.storage.local.set({ autoWorkflows: wfs }, () => alert(`Selector saved: ${selection.selector}`));
    });
  }

  // ── Inspector ─────────────────────────────────────────────────────────────

  function startInspector(sendResponse, options = {}) {
    if (typeof window.ElementInspector !== "function") {
      sendResponse({ status: "Inspector unavailable" });
      return;
    }

    const inspector = new window.ElementInspector();
    inspector.start((selection) => {
      if (options.forWorkflowTrigger) { saveTriggerSelector(selection, options.workflowId); return; }
      if (options.forWorkflowRepeatWhile) { saveRepeatWhileSelector(selection, options.workflowId); return; }
      if (options.forWorkflowMatchSelector) { saveMatchSelector(selection, options.workflowId); return; }
      if (options.forUsElement) { saveUsElementSelector(selection, options.ruleId); return; }
      if (options.forWorkflowStep) { updateWorkflowStepSelector(selection, options.workflowId, options.stepId); return; }
      if (options.forWorkflow) { saveCapturedStep(selection, options.workflowId, options.afterStepId); return; }
      if (options.forQuickTranslate) { quickTranslateElement(selection.element); return; }
      if (options.forTranslateSource) { saveTranslateSourceSelector(selection, options.ruleId); return; }
      if (options.ruleId) {
        const key = options.mode === "forbidden" ? "forbiddenElements" : "requiredElements";
        updateSelectorInRule(options.ruleId, selection, key, options.index);
        return;
      }
      saveCapturedRule(selection, options.forceType);
    });
    sendResponse({ status: "Inspector Active" });
  }

  // ── Record mode (Tier 3) ──────────────────────────────────────────────────
  // Records a whole interaction sequence into workflow steps: clicks become
  // click steps, typed fields become fill steps (captured on blur/change),
  // PrimeNG dropdown picks become select steps, checkboxes/radios their step.
  // Passive — the page behaves normally while recording. Stop saves the steps.

  let recState = null; // { workflowId, steps, bar, count, lastDropdown }

  function recSelector(el) {
    return (window.ElementInspector && window.ElementInspector.getUniqueSelector)
      ? window.ElementInspector.getUniqueSelector(el) : "";
  }

  function recBarUpdate() {
    if (recState && recState.count) recState.count.textContent = `● Recording — ${recState.steps.length} step(s)`;
  }

  function recPush(step) {
    if (!recState) return;
    // Re-editing the same field: replace the previous fill instead of stacking.
    const last = recState.steps[recState.steps.length - 1];
    if (step.type === "input" && last && last.type === "input" && last.selector === step.selector) {
      recState.steps[recState.steps.length - 1] = step;
    } else {
      recState.steps.push(step);
    }
    recBarUpdate();
  }

  function recStepFor(el, type, extra) {
    const selector = recSelector(el);
    const base = {
      id: Date.now() + Math.floor(Math.random() * 1000),
      type,
      name: (extra && extra.name) || (el.innerText || el.textContent || "").trim().slice(0, 40) || selector,
      requiredElements: [selector],
      selector,
      timeoutMs: 8000,
      afterMs: 250,
      optional: false,
      ...extra,
    };
    return base;
  }

  function recOnClick(e) {
    if (!recState) return;
    const t = e.target;
    if (!t || (recState.bar && recState.bar.contains(t))) return;

    // A PrimeNG dropdown option being picked → one "select" step on the dropdown.
    const li = t.closest && t.closest('ul[role="listbox"] li');
    if (li) {
      const root = recState.lastDropdown;
      if (root) {
        const val = (li.innerText || li.textContent || "").trim();
        recPush(recStepFor(root, "dropdown", { name: "Select " + val, selectValue: val, selectMatchBy: "text" }));
      }
      recState.lastDropdown = null;
      return;
    }
    // Opening a custom dropdown — remember it; the option click makes the step.
    const dd = t.closest && t.closest("p-dropdown, .p-dropdown");
    if (dd) { recState.lastDropdown = dd; return; }

    // Walk up to the real actionable element.
    const el = (t.closest && t.closest('button, a, [role="button"], input, label')) || t;
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    const itype = (el.type || "").toLowerCase();

    if (tag === "input" && (itype === "checkbox" || itype === "radio")) {
      // .checked already reflects the NEW state during the click event.
      recPush(recStepFor(el, itype === "radio" ? "radio" : "checkbox", { targetState: el.checked ? "checked" : "unchecked", name: itype }));
      return;
    }
    // Clicking into a text field is just focus — the change event records it.
    if (tag === "textarea" || (tag === "input" && !["button", "submit", "reset"].includes(itype))) return;
    if (tag === "select") return; // its change event records the pick

    recPush(recStepFor(el, "button", { name: "Click " + ((el.innerText || el.textContent || "").trim().slice(0, 30) || tag) }));
  }

  function recOnChange(e) {
    if (!recState) return;
    const el = e.target;
    if (!el || (recState.bar && recState.bar.contains(el))) return;
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    const itype = (el.type || "").toLowerCase();
    if (itype === "checkbox" || itype === "radio") return; // click handled these
    if (tag === "select") {
      recPush(recStepFor(el, "dropdown", { name: "Select " + el.value, selectValue: el.value, selectMatchBy: "value" }));
      return;
    }
    if (tag === "input" || tag === "textarea") {
      recPush(recStepFor(el, "input", { name: "Fill " + (el.placeholder || el.name || "field").slice(0, 30), fillValue: el.value, clearFirst: true, triggerAngularEvents: true }));
    }
  }

  function recBuildBar() {
    const bar = document.createElement("div");
    bar.setAttribute("style",
      "position:fixed;top:12px;right:12px;z-index:2147483647;display:flex;align-items:center;gap:10px;" +
      "background:#1c1e26;color:#fff;padding:9px 12px;border-radius:10px;font:600 12px system-ui;" +
      "box-shadow:0 4px 18px rgba(0,0,0,.35);border:1px solid #e5484d;");
    const count = document.createElement("span");
    count.textContent = "● Recording — 0 step(s)";
    count.style.color = "#ff6369";
    const mkBtn = (label, bg) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.setAttribute("style", `border:none;border-radius:7px;padding:5px 12px;cursor:pointer;font:600 12px system-ui;color:#fff;background:${bg};`);
      return b;
    };
    const stopBtn = mkBtn("Stop & save", "#2f9e44");
    const cancelBtn = mkBtn("Cancel", "#495057");
    stopBtn.addEventListener("click", () => stopRecording(true));
    cancelBtn.addEventListener("click", () => stopRecording(false));
    bar.append(count, stopBtn, cancelBtn);
    document.body.appendChild(bar);
    return { bar, count };
  }

  function startRecording(workflowId) {
    if (recState) stopRecording(false);
    const ui = recBuildBar();
    recState = { workflowId, steps: [], bar: ui.bar, count: ui.count, lastDropdown: null };
    document.addEventListener("click", recOnClick, true);
    document.addEventListener("change", recOnChange, true);
    wlog("recording started");
  }

  function stopRecording(save) {
    if (!recState) return;
    const { workflowId, steps, bar } = recState;
    document.removeEventListener("click", recOnClick, true);
    document.removeEventListener("change", recOnChange, true);
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
    recState = null;
    if (!save) { wlog("recording cancelled"); return; }
    if (!steps.length) { alert("Nothing recorded — no steps were captured."); return; }
    chrome.storage.local.get(["autoWorkflows"], (res) => {
      const wfs = (res.autoWorkflows || []).map((w) =>
        String(w.id) === String(workflowId) ? { ...w, steps: [...(w.steps || []), ...steps] } : w);
      chrome.storage.local.set({ autoWorkflows: wfs }, () =>
        alert(`Recording saved — ${steps.length} step(s) added to the workflow.`));
    });
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  const observer = new MutationObserver(() => { scanRules(); scanWorkflows(); scanTranslateRules(); });
  observer.observe(document.body, { childList: true, subtree: true });
  setInterval(() => { scanRules(); scanWorkflows(); scanTranslateRules(); }, 1000);

  window.addEventListener("nusuk-route-change", () => {
    executedRules.clear();
    pendingRules.clear();
    wfArmed.clear();          // re-arm auto-run workflows on a fresh page
    scanRules();
    scanWorkflows();
  });

  // Premium — click/input/dropdown rules share ONE entitlement now
  // ("autorules"). featOK also accepts the 3 OLD ids (autoclick/fillrules/
  // autoselect) so a key that predates the merge keeps working as-is —
  // no forced reissue, migrate customers to the clean id whenever convenient.
  const featOK = (f) => !window.NkLicense || window.NkLicense.featureOK(f);
  const autoRulesOK = () => featOK("autorules") || featOK("autoclick") || featOK("fillrules") || featOK("autoselect");

  function refreshEnabled(after) {
    chrome.storage.local.get(["moduleAutoRules", "moduleWorkflows", "moduleTranslateRules", "extensionEnabled"], (res) => {
      const on = res.extensionEnabled !== false;
      autoRulesEnabled      = on && !!res.moduleAutoRules      && autoRulesOK();
      workflowsEnabled      = on && !!res.moduleWorkflows      && featOK("workflows");
      translateRulesEnabled = on && !!res.moduleTranslateRules && featOK("translaterules");
      if (after) after();
      scanWorkflows();
    });
  }

  chrome.storage.local.get([RULES_KEY, LEGACY_KEY], (res) => {
    const initial = res[RULES_KEY] || res[LEGACY_KEY] || [];
    refreshEnabled(() => setRules(initial));
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.moduleAutoRules || changes.moduleWorkflows || changes.moduleTranslateRules || changes.extensionEnabled) refreshEnabled(scanRules);
    if (changes[RULES_KEY]) setRules(changes[RULES_KEY].newValue || []);
    else if (changes[LEGACY_KEY]) setRules(changes[LEGACY_KEY].newValue || []);
    else scanRules();
  });

  // React to license activation/deactivation while the page is open.
  window.NkLicense && window.NkLicense.onPremiumChange(() => refreshEnabled(scanRules));

  // ── Highlight (verify a selector from the popup) ──────────────────────────

  function flashElement(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (_) {}
    const prevOutline = el.style.outline;
    const prevShadow = el.style.boxShadow;
    const prevTrans = el.style.transition;
    el.style.transition = "box-shadow .15s ease";
    el.style.outline = "3px solid #4f6ef7";
    el.style.boxShadow = "0 0 0 6px rgba(79,110,247,.30)";
    setTimeout(() => {
      el.style.outline = prevOutline;
      el.style.boxShadow = prevShadow;
      el.style.transition = prevTrans;
    }, 1500);
    return true;
  }

  // ── Workflow engine (ordered sequences + waits + run controls) ────────────

  const WF_KEY = "autoWorkflows";
  const STATUS_KEY = "acRunStatus";
  const wfState = { running: false, paused: false, stop: false, id: null };
  // Workflow ids currently "on the call stack" — the top-level running
  // workflow, plus any it (or something it called) is calling right now via
  // a "callWorkflow" step. There's still only ONE workflow ever actually
  // executing (wfState is a single mutex, on purpose — see runWorkflow) — a
  // call step just jumps the same thread of execution into another step
  // list and back, like a subroutine call, not real concurrency. This stack
  // exists purely to reject cycles (A calls B calls A) before they recurse
  // forever.
  let wfCallStack = [];

  const wlog = (m) => { try { (window.nkLog || console.log)("[Nuskomate Clicker] " + m); } catch (_) { console.log(m); } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms | 0)));

  function writeStatus(patch) {
    chrome.storage.local.get([STATUS_KEY], (res) => {
      chrome.storage.local.set({ [STATUS_KEY]: { ...(res[STATUS_KEY] || {}), ...patch, at: Date.now() } });
    });
  }

  function stepSelector(step) {
    return (Array.isArray(step.requiredElements) ? step.requiredElements[0] : "") || step.selector || "";
  }

  // Poll until the selector is visible (or gone), up to timeoutMs.
  async function waitUntil(sel, wantVisible, timeoutMs) {
    const deadline = Date.now() + (Number(timeoutMs) || 15000);
    for (;;) {
      if (wfState.stop) return false;
      const el = getElement(sel);
      if ((wantVisible ? isVisible(el) : !isVisible(el))) return true;
      if (Date.now() > deadline) return false;
      await sleep(250);
    }
  }

  // ── Tier 2: variables, capture, conditions, blocks ───────────────────────

  // Substitute {{var}} placeholders from the run context.
  function interp(str, ctx) {
    if (typeof str !== "string" || str.indexOf("{{") < 0) return str || "";
    return str.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
      const v = ctx.vars[k];
      return v == null ? "" : String(v);
    });
  }

  function readValue(el, source) {
    if (!el) return "";
    if (source === "value") return (el.value != null ? el.value : el.getAttribute("value")) || "";
    return (el.innerText || el.textContent || "").trim();
  }

  function evalCondition(step, ctx) {
    const sel = interp(stepSelector(step), ctx);
    const el = getElement(sel);
    const cond = step.condition || "visible";
    if (cond === "visible") return isVisible(el);
    if (cond === "hidden")  return !isVisible(el);
    // "disabled" is true once there's nothing left to wait for — either the
    // element is gone entirely, or it's present but disabled — matching the
    // common "!nextBtn || nextBtn.disabled" pattern for a paginator arrow
    // that becomes disabled (not hidden) once there's nothing more to page
    // through. "enabled" is the strict opposite: must exist AND not be disabled.
    if (cond === "disabled") return !el || isElementDisabled(el);
    if (cond === "enabled")  return !!el && !isElementDisabled(el);
    const text = readValue(el, "text").toLowerCase();
    const want = interp(step.value || "", ctx).toLowerCase();
    if (cond === "textEquals")   return !!el && text === want;
    return !!el && text.includes(want); // textIncludes (default for text conds)
  }

  // Poll evalCondition() until true (or timeout) — a generalized waitFor/
  // waitGone that also covers "disabled"/"enabled"/text conditions, e.g.
  // waiting for a paginator's Next arrow to become disabled (not hidden —
  // disabled buttons usually stay fully visible) once nothing's left to page
  // through.
  async function waitUntilCondition(step, ctx, timeoutMs) {
    const deadline = Date.now() + (Number(timeoutMs) || 15000);
    for (;;) {
      if (wfState.stop) return false;
      if (evalCondition(step, ctx)) return true;
      if (Date.now() > deadline) return false;
      await sleep(250);
    }
  }

  // Pair up block markers: loopStart↔loopEnd, if↔endif, else→endif.
  function buildBlocks(steps) {
    const partner = {}, elseOf = {}, stack = [];
    steps.forEach((s, i) => {
      const t = s.type;
      if (t === "loopStart" || t === "if") stack.push(i);
      else if (t === "else") { const o = stack[stack.length - 1]; if (o != null && steps[o].type === "if") elseOf[o] = i; }
      else if (t === "loopEnd" || t === "endif") {
        const o = stack.pop();
        if (o != null) { partner[o] = i; partner[i] = o; if (t === "endif" && elseOf[o] != null) partner[elseOf[o]] = i; }
      }
    });
    return { partner, elseOf };
  }

  async function runStep(step, ctx, base) {
    const type = step.type || "button";
    const rawSel = stepSelector(step);
    const sel = interp(rawSel, ctx);

    if (type === "wait" || type === "delay") { await sleep(Number(step.waitMs) || 0); return; }
    if (type === "waitFor")  { if (!(await waitUntil(sel, true,  step.timeoutMs))) throw new Error(`waitFor timed out: ${sel}`); return; }
    if (type === "waitGone") { if (!(await waitUntil(sel, false, step.timeoutMs))) throw new Error(`waitGone timed out: ${sel}`); return; }
    if (type === "waitCondition") {
      if (!(await waitUntilCondition(step, ctx, step.timeoutMs))) throw new Error(`waitCondition timed out: ${step.condition || "visible"} ${sel}`);
      return;
    }
    if (type === "callWorkflow") { await callTarget(step, base); return; }
    if (type === "capture") {
      const ok = await waitUntil(sel, true, Number(step.timeoutMs) || 8000);
      const el = getElement(sel);
      if (!ok || !el) throw new Error(`capture: element not found: ${sel}`);
      const val = readValue(el, step.captureSource || "text");
      ctx.vars[step.varName || "var"] = val;
      wlog(`captured ${step.varName || "var"} = "${val}"`);
      return;
    }

    // Action step. A "For each match" loop (ctx.forEach) sets its current
    // iteration's specific element aside — if THIS step's own selector is
    // literally the same text as the loop's match selector, target that
    // exact element directly instead of re-resolving to the first match on
    // the page every time. That's what makes "click the row button"
    // actually advance through every row instead of clicking row 1 over and
    // over. Anything else (a different selector, e.g. a "wait for Next to
    // disable" step) resolves normally, unaffected.
    let el;
    if (ctx.forEach && rawSel === ctx.forEach.selector) {
      el = ctx.forEach.element || null;
      if (!el) throw new Error(`element not found: ${sel}`);
    } else {
      const present = await waitUntil(sel, true, Number(step.timeoutMs) || 8000);
      el = present ? getElement(sel) : null;
      if (!el) throw new Error(`element not found: ${sel}`);
    }
    // Human-like: a short random "reaction time" before each action.
    if (ctx.humanize) await sleep(150 + Math.random() * 450);
    switch (type) {
      case "input":    fillInput(el, { ...step, fillValue: interp(step.fillValue, ctx), prefix: interp(step.prefix, ctx), suffix: interp(step.suffix, ctx) }); break;
      case "dropdown": selectOption(el, { ...step, requiredElements: [sel], selectValue: interp(step.selectValue, ctx) }); break;
      case "checkbox": setCheckbox(el, step.targetState || "checked"); break;
      case "radio":    setCheckbox(el, step.targetState || "checked"); break;
      default:         clickElement(el);
    }
  }

  // Fires a single click/fill/select rule synchronously (awaited) from
  // inside a workflow's "Call" step — same conditions-check + jitter as
  // fireRuleHotkey(), but resolves/rejects instead of firing and forgetting,
  // so the calling workflow can wait for it (and skip it if `optional`).
  function callRule(rule) {
    return new Promise((resolve, reject) => {
      const element = conditionsPass(rule, true);
      if (!element) { reject(new Error(`rule "${rule.name}" — conditions not met`)); return; }
      const jitter = Math.max(Number(rule.jitterMs) || 0, 0);
      const delayMs = jitter ? Math.floor(Math.random() * jitter) : 0;
      setTimeout(() => {
        const freshElement = conditionsPass(rule, true);
        if (!freshElement) { reject(new Error(`rule "${rule.name}" — conditions not met`)); return; }
        executeAction(rule, freshElement);
        resolve();
      }, delayMs);
    });
  }

  // A "callWorkflow" step — calls another saved workflow OR a single rule
  // as a subroutine, like Call MySub in VBA: the SAME single-threaded run
  // (wfState never changes, no second "running" workflow) just jumps into
  // the target's steps and comes back when they finish. wfCallStack guards
  // against cycles (A calls B calls A) and caps total call depth.
  async function callTarget(step, base) {
    const kind = step.targetKind === "rule" ? "rule" : "workflow";
    const targetId = step.targetId;
    if (!targetId) throw new Error("call step: no target selected");

    if (kind === "rule") {
      const rule = rules.find((r) => String(r.id) === String(targetId));
      if (!rule) throw new Error(`called rule not found (it may have been deleted)`);
      if (!rule.enabled) throw new Error(`called rule "${rule.name}" is turned off`);
      wlog(`↳ calling rule "${rule.name}"`);
      await callRule(rule);
      return;
    }

    const wfs = await new Promise((resolve) => chrome.storage.local.get([WF_KEY], (res) => resolve(res[WF_KEY] || [])));
    const target = wfs.find((w) => String(w.id) === String(targetId));
    if (!target) throw new Error(`called workflow not found (it may have been deleted)`);
    if (target.enabled === false) throw new Error(`called workflow "${target.name}" is turned off`);
    if (!Array.isArray(target.steps) || !target.steps.length) throw new Error(`called workflow "${target.name}" has no steps`);
    const tid = String(target.id);
    if (wfCallStack.includes(tid)) throw new Error(`circular call: "${target.name}" is already running in this call chain`);
    if (wfCallStack.length >= 6) throw new Error(`call depth limit reached (6) — check for a call loop`);

    wfCallStack.push(tid);
    try {
      wlog(`↳ calling workflow "${target.name}"`);
      await runWorkflowSteps(target, { ...base, name: target.name, total: (target.steps || []).length });
    } finally {
      wfCallStack.pop();
    }
  }

  // Interpret one pass over the steps (a program counter with loop/if blocks).
  async function runProgram(steps, ctx, base) {
    const { partner, elseOf } = buildBlocks(steps);
    const loopCount = {};
    let pc = 0, guard = 0;
    while (pc < steps.length) {
      if (wfState.stop) return { stopped: true };
      while (wfState.paused && !wfState.stop) await sleep(200);
      if (wfState.stop) return { stopped: true };
      if (++guard > 500000) throw new Error("step budget exceeded (infinite loop?)");
      const step = steps[pc];
      const type = step.type;
      writeStatus({ ...base, stepIndex: pc, lastError: "" });

      if (type === "loopStart") {
        const done = loopCount[pc] || 0;
        const enter = step.loopMode === "while"
          ? isVisible(getElement(interp(stepSelector(step), ctx)))
          : done < (Number(step.count) || 1);
        if (!enter) { loopCount[pc] = 0; pc = (partner[pc] != null ? partner[pc] : pc) + 1; continue; }
        pc++; continue;
      }
      if (type === "loopEnd") {
        const start = partner[pc];
        if (start != null) loopCount[start] = (loopCount[start] || 0) + 1;
        pc = start != null ? start : pc + 1; continue;
      }
      if (type === "if") {
        if (evalCondition(step, ctx)) { pc++; continue; }
        const e = elseOf[pc];
        pc = (e != null ? e + 1 : (partner[pc] != null ? partner[pc] : pc) + 1); continue;
      }
      if (type === "else")  { pc = (partner[pc] != null ? partner[pc] : pc) + 1; continue; }
      if (type === "endif") { pc++; continue; }

      try {
        await runStep(step, ctx, base);
        // Human-like: vary the between-step gap ±40% instead of a fixed beat.
        const gap = Number(step.afterMs) || 250;
        await sleep(ctx.humanize ? gap * (0.6 + Math.random() * 0.8) : gap);
      } catch (e) {
        const m = (e && e.message) || String(e);
        if (step.optional) { wlog(`⚠ step ${pc + 1} skipped: ${m}`); pc++; continue; }
        throw new Error(`step ${pc + 1}: ${m}`);
      }
      pc++;
    }
    return { ok: true };
  }

  // Runs wf's own step list per its repeat mode. Used both as the top-level
  // execution (called by runWorkflow, wrapped with wfState/writeStatus) and,
  // unwrapped, when a "callWorkflow" step invokes another workflow as a
  // subroutine — callers share the SAME wfState (stop/pause both still work
  // across a call), they just don't touch it directly here.
  async function runWorkflowSteps(wf, base) {
    const repeat = wf.repeat || { mode: "off" };
    const cols = (wf.data && Array.isArray(wf.data.columns)) ? wf.data.columns : [];
    const rows = (repeat.mode === "perRow" && wf.data && Array.isArray(wf.data.rows)) ? wf.data.rows : null;
    const newCtx = () => ({ vars: {}, humanize: !!wf.humanize });

    if (rows) {
      for (let r = 0; r < rows.length && !wfState.stop; r++) {
        const ctx = newCtx();
        cols.forEach((c, ci) => { ctx.vars[c] = rows[r][ci] != null ? rows[r][ci] : ""; });
        ctx.vars._row = r + 1; ctx.vars._rows = rows.length;
        wlog(`— row ${r + 1}/${rows.length}`);
        if ((await runProgram(wf.steps, ctx, { ...base, iter: r + 1, iterTotal: rows.length })).stopped) break;
      }
    } else if (repeat.mode === "count") {
      const n = Math.max(1, Number(repeat.count) || 1);
      for (let r = 0; r < n && !wfState.stop; r++) {
        if ((await runProgram(wf.steps, newCtx(), { ...base, iter: r + 1, iterTotal: n })).stopped) break;
      }
    } else if (repeat.mode === "whileVisible") {
      let r = 0;
      while (!wfState.stop && isVisible(getElement(repeat.whileSelector || "")) && ++r <= 10000) {
        if ((await runProgram(wf.steps, newCtx(), { ...base, iter: r })).stopped) break;
      }
    } else if (repeat.mode === "forEachMatch") {
      // Runs the steps once per element CURRENTLY matching matchSelector —
      // e.g. every row's "Review Passports" button — instead of re-running
      // against the same (always-first) match. Tracks WHICH elements have
      // already been handled (by identity, not position) and re-queries
      // the match list fresh each iteration, picking the first not-yet-
      // handled one — robust whether matches stay put (their state just
      // changes) or get removed from the DOM after being processed; a
      // plain index would silently skip an element in the latter case.
      // Whichever step's own selector equals matchSelector gets pointed at
      // THIS specific match (see runStep's ctx.forEach handling) —
      // everything else in the steps resolves normally. includeHidden=true
      // — matches even elements still hidden inside a closed dropdown menu
      // (every row's menu content is typically all rendered up front, just
      // CSS-hidden until its own toggle is clicked), so this can target
      // "every row's Review Passports button" directly without an extra
      // "open the menu first" step, same as a hand-written script that
      // just calls .click() on whatever querySelectorAll found.
      const matchSel = (repeat.matchSelector || "").trim();
      if (!matchSel) { wlog(`⚠ "For each match" has no match selector set — nothing to do`); }
      const handled = new Set();
      let n = 0;
      while (!wfState.stop) {
        const matches = matchSel ? getAllElements(matchSel, true) : [];
        const next = matches.find((el) => !handled.has(el));
        if (!next) break; // every currently-matching element has already been handled
        handled.add(next);
        n++;
        const ctx = { vars: { _matchIndex: n, _matchCount: matches.length }, humanize: !!wf.humanize, forEach: { selector: matchSel, element: next } };
        wlog(`— match ${n}`);
        if ((await runProgram(wf.steps, ctx, { ...base, iter: n, iterTotal: matches.length })).stopped) break;
      }
    } else {
      await runProgram(wf.steps, newCtx(), base);
    }
  }

  async function runWorkflow(wf) {
    if (wfState.running) { wlog("a workflow is already running"); return; }
    if (!wf || !Array.isArray(wf.steps) || !wf.steps.length) return;
    wfState.running = true; wfState.paused = false; wfState.stop = false; wfState.id = wf.id;
    wfCallStack = [String(wf.id)];
    const total = wf.steps.length;
    const base = { id: wf.id, name: wf.name, running: true, paused: false, total };
    wlog(`▶ ${wf.name} — ${total} step(s)${wf.humanize ? " (humanized)" : ""}`);

    try {
      await runWorkflowSteps(wf, base);
    } catch (e) {
      const m = (e && e.message) || String(e);
      wfState.running = false; wfState.id = null; wfCallStack = [];
      writeStatus({ ...base, running: false, done: true, lastError: m });
      wlog(`✖ ${wf.name} failed: ${m}`);
      return;
    }

    const stopped = wfState.stop;
    wfState.running = false; wfState.id = null; wfCallStack = [];
    writeStatus({ ...base, running: false, done: true, stopped, lastError: "" });
    wlog(stopped ? `■ ${wf.name} stopped` : `✔ ${wf.name} finished`);
  }

  function startWorkflowById(id) {
    if (!workflowsEnabled) { wlog("Workflows module is off or not licensed"); return; }
    chrome.storage.local.get([WF_KEY], (res) => {
      const wf = (res[WF_KEY] || []).find((w) => String(w.id) === String(id));
      if (!wf) { wlog("workflow not found"); return; }
      if (wf.enabled === false) { wlog(`"${wf.name}" is turned off`); return; }
      runWorkflow(wf);
    });
  }

  // ── Auto-run triggers (run a workflow when an element appears) ─────────────
  // A workflow with `trigger === "auto"` fires like a reactive rule: when its
  // trigger element becomes visible it runs automatically (no Run button).
  // Edge-triggered — it re-arms only after the trigger element disappears, so a
  // steadily-visible element runs it once, not on every scan. Default trigger
  // selector is the workflow's first actionable step. `trigger === "manual"`
  // (or unset) means Run-button / hotkey only.
  let autoWfs = [];            // workflows with trigger === "auto"
  const wfArmed = new Map();   // workflow id → armed to fire (re-armed when trigger gone)

  // The selector whose appearance fires the workflow.
  function wfTriggerSelector(wf) {
    if (wf.triggerSelector && wf.triggerSelector.trim()) return wf.triggerSelector.trim();
    const first = (wf.steps || []).find((s) => stepSelector(s));
    return first ? stepSelector(first) : "";
  }

  function refreshAutoWorkflows() {
    chrome.storage.local.get([WF_KEY], (res) => {
      autoWfs = (res[WF_KEY] || []).filter((w) => w.enabled !== false && w.trigger === "auto" && wfTriggerSelector(w));
    });
  }
  refreshAutoWorkflows();

  function scanWorkflows() {
    if (!workflowsEnabled || !autoWfs.length || wfState.running) return;
    for (const wf of autoWfs) {
      const sel = wfTriggerSelector(wf);
      const visible = isVisible(getElement(sel));
      const armed = wfArmed.get(wf.id) !== false;   // default armed
      if (visible && armed) {
        wfArmed.set(wf.id, false);                   // disarm until the trigger disappears
        wlog(`▶ auto-run "${wf.name}" (trigger appeared: ${sel})`);
        runWorkflow(wf);
        return;                                      // one workflow at a time
      }
      if (!visible && !armed) wfArmed.set(wf.id, true); // re-arm once the trigger is gone
    }
  }

  // ── Hotkey triggers ───────────────────────────────────────────────────────
  // A workflow OR a click/fill/select rule (rule.triggerMode === "hotkey")
  // with a `hotkey` (e.g. "Alt+1", "Ctrl+Shift+K") runs on that combo.
  // Requires Ctrl/Alt/Meta (Shift-only is ignored so normal typing isn't caught).
  function comboFromEvent(e) {
    if (["Alt", "Control", "Shift", "Meta"].includes(e.key)) return "";
    if (!e.ctrlKey && !e.altKey && !e.metaKey) return "";
    const parts = [];
    if (e.ctrlKey)  parts.push("Ctrl");
    if (e.altKey)   parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (e.metaKey)  parts.push("Meta");
    parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
    return parts.join("+");
  }
  function normHotkey(s) {
    const parts = String(s || "").split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
    const mods = [];
    if (parts.includes("ctrl") || parts.includes("control")) mods.push("Ctrl");
    if (parts.includes("alt")  || parts.includes("option"))  mods.push("Alt");
    if (parts.includes("shift")) mods.push("Shift");
    if (parts.includes("meta") || parts.includes("cmd")) mods.push("Meta");
    const key = parts.filter((p) => !["ctrl", "control", "alt", "option", "shift", "meta", "cmd"].includes(p)).pop() || "";
    if (!key || !mods.length) return "";
    return [...mods, key.length === 1 ? key.toUpperCase() : key].join("+");
  }
  // Cache combo → { kind: "workflow"|"rule", item } so we don't hit storage
  // on every keystroke. Rules come from the already-in-memory `rules` array
  // (kept current by setRules(), which calls this on every RULES_KEY
  // change) rather than a separate storage read. If a rule and a workflow
  // (or two rules) both claim the same combo, whichever is processed last
  // here wins — no collision warning UI, just documented behavior.
  let hotkeyMap = {};
  function refreshHotkeys() {
    chrome.storage.local.get([WF_KEY], (res) => {
      hotkeyMap = {};
      (res[WF_KEY] || []).forEach((w) => { if (w.enabled !== false && w.hotkey) { const k = normHotkey(w.hotkey); if (k) hotkeyMap[k] = { kind: "workflow", item: w }; } });
      rules.forEach((r) => { if (r.enabled && r.triggerMode === "hotkey" && r.hotkey) { const k = normHotkey(r.hotkey); if (k) hotkeyMap[k] = { kind: "rule", item: r }; } });
    });
  }
  refreshHotkeys();
  chrome.storage.onChanged.addListener((c, a) => {
    if (a !== "local" || !c[WF_KEY]) return;
    refreshHotkeys();
    refreshAutoWorkflows();
    wfArmed.clear();          // workflows edited → re-evaluate triggers cleanly
  });
  document.addEventListener("keydown", (e) => {
    const combo = comboFromEvent(e);
    if (!combo) return;
    const entry = hotkeyMap[combo];
    if (!entry) return;
    if (entry.kind === "workflow") {
      if (!workflowsEnabled) return;
      e.preventDefault(); e.stopPropagation();
      runWorkflow(entry.item);
    } else if (entry.kind === "rule") {
      if (!categoryEnabled(ruleCategory(entry.item))) return;
      e.preventDefault(); e.stopPropagation();
      fireRuleHotkey(entry.item);
    }
  }, true);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.action) {
      case "START_PICKER":
        inspectorDefaults = msg.defaults || {};
        startInspector(sendResponse, { mode: msg.mode || "required", ruleId: msg.ruleId, index: msg.index, forWorkflow: msg.forWorkflow, forWorkflowTrigger: msg.forWorkflowTrigger, forWorkflowRepeatWhile: msg.forWorkflowRepeatWhile, forWorkflowMatchSelector: msg.forWorkflowMatchSelector, forUsElement: msg.forUsElement, forWorkflowStep: msg.forWorkflowStep, workflowId: msg.workflowId, afterStepId: msg.afterStepId, stepId: msg.stepId, forceType: msg.forceType, forTranslateSource: msg.forTranslateSource, forQuickTranslate: msg.forQuickTranslate });
        break;
      case "START_RECORD":   startRecording(msg.workflowId); sendResponse({ ok: true }); break;
      case "STOP_RECORD":    stopRecording(true); sendResponse({ ok: true }); break;
      case "RUN_WORKFLOW":   startWorkflowById(msg.workflowId); sendResponse({ ok: true }); break;
      case "STOP_WORKFLOW":  wfState.stop = true; wfState.paused = false; sendResponse({ ok: true }); break;
      case "PAUSE_WORKFLOW": wfState.paused = true;  writeStatus({ paused: true });  sendResponse({ ok: true }); break;
      case "RESUME_WORKFLOW":wfState.paused = false; writeStatus({ paused: false }); sendResponse({ ok: true }); break;
      case "HIGHLIGHT_ELEMENT": sendResponse({ ok: flashElement(getElement(msg.selector)) }); break;
      default: sendResponse({ ok: false });
    }
    return true; // keep the channel open for async sendResponse
  });
})();
