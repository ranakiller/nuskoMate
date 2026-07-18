(function () {
  "use strict";

  const RULES_KEY = "autoClickRules";
  const LEGACY_KEY = "autoButtons";

  let moduleEnabled = false;    // reactive rules (moduleAutoClicker)
  let fillEnabled = false;      // input-fill rules (moduleAutoFillRules)
  let selectEnabled = false;    // dropdown-select rules (moduleAutoSelect)
  let workflowsEnabled = false; // workflows run/hotkeys (moduleWorkflows)
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
  function findByText(txt, exact) {
    const want = String(txt || "").trim().toLowerCase();
    if (!want) return null;
    let best = null, bestLen = Infinity;
    for (const el of document.querySelectorAll(TEXT_SCAN)) {
      const t = (el.innerText || el.textContent || "").trim().toLowerCase();
      if (!t || t.length > want.length + 120) continue;   // skip big containers early
      if (exact ? t !== want : !t.includes(want)) continue;
      if (!isVisible(el)) continue;
      // Tightest (shortest-text) match wins → the actual button, not its wrapper.
      if (t.length < bestLen) { best = el; bestLen = t.length; }
    }
    return best;
  }

  function resolveOne(sel) {
    sel = String(sel || "").trim();
    if (!sel) return null;
    if (/^xpath=/i.test(sel)) return findByXPath(sel.slice(6));
    if (sel[0] === "/" || sel[0] === "(") return findByXPath(sel);
    if (/^text\*=/i.test(sel)) return findByText(sel.slice(6), false);
    if (/^text=/i.test(sel))   return findByText(sel.slice(5), true);
    try {
      return document.querySelector(sel);
    } catch (err) {
      console.warn("Invalid selector skipped:", sel, err);
      return null;
    }
  }

  function getElement(selector) {
    if (!selector) return null;
    // Fallback chain: try each "||"-separated alternative in order.
    const parts = String(selector).split("||");
    for (const p of parts) {
      const el = resolveOne(p);
      if (el) return el;
    }
    return null;
  }

  // ── Path / condition matching ─────────────────────────────────────────────

  function pathMatches(rule) {
    const pathname = window.location.pathname;
    const rulePath = rule.pathname || rule.path || "";
    if (!rulePath) return true;
    const mode = rule.pathMatch || rule.urlMatch || "exact";
    return mode === "includes" ? pathname.includes(rulePath) : pathname === rulePath;
  }

  function conditionsPass(rule) {
    if (!rule.enabled || !pathMatches(rule)) return false;

    const requiredSelectors = Array.isArray(rule.requiredElements)
      ? rule.requiredElements
      : rule.requiredElement ? [rule.requiredElement]
      : rule.selector ? [rule.selector]
      : [];

    if (!requiredSelectors.length) return false;

    const requiredElements = requiredSelectors.map(getElement);
    if (requiredElements.some((el) => !isVisible(el))) return false;

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

  function clickElement(element) {
    const isDisabled =
      element.disabled ||
      element.getAttribute("disabled") === "true" ||
      element.getAttribute("aria-disabled") === "true" ||
      element.classList.contains("disabled");
    if (isDisabled) return;
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
    };
  }

  // ── Scan loop ─────────────────────────────────────────────────────────────

  // A rule's element type decides which module gates it:
  //   input → Autofill (fill),  dropdown → Auto Select,  everything else → Auto Clicker (click).
  function ruleCategory(rule) {
    const t = rule.type || "button";
    return t === "input" ? "fill" : t === "dropdown" ? "select" : "click";
  }
  function categoryEnabled(cat) {
    return cat === "fill" ? fillEnabled : cat === "select" ? selectEnabled : moduleEnabled;
  }

  function scanRules() {
    if (!rules.length || (!moduleEnabled && !fillEnabled && !selectEnabled)) return;
    rules.forEach((rule) => {
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
    scanRules();
  }

  // ── Rule saving ───────────────────────────────────────────────────────────

  function buildDefaultRule(selection) {
    const { selector, text, elementType = "button", meta = {} } = selection;

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

  function saveCapturedRule(selection) {
    const newRule = normalizeRule(buildDefaultRule(selection));
    chrome.storage.local.get([RULES_KEY], (res) => {
      const nextRules = [...(res[RULES_KEY] || []), newRule];
      chrome.storage.local.set({ [RULES_KEY]: nextRules }, () => {
        inspectorDefaults = {};
        alert(`Rule saved: ${newRule.name}\nType: ${newRule.type}\nPath: ${newRule.pathname}`);
      });
    });
  }

  function updateSelectorInRule(ruleId, selection, key) {
    chrome.storage.local.get([RULES_KEY, LEGACY_KEY], (res) => {
      const current = res[RULES_KEY] || res[LEGACY_KEY] || [];
      const nextRules = current.map((rule) => {
        if (String(rule.id) !== String(ruleId)) return normalizeRule(rule);
        const normalized = normalizeRule(rule);
        const existing = normalizeSelectorArray(normalized[key] || []);
        return { ...normalized, [key]: [...existing, selection.selector].filter(Boolean) };
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
      if (options.forUsElement) { saveUsElementSelector(selection, options.ruleId); return; }
      if (options.forWorkflowStep) { updateWorkflowStepSelector(selection, options.workflowId, options.stepId); return; }
      if (options.forWorkflow) { saveCapturedStep(selection, options.workflowId, options.afterStepId); return; }
      if (options.ruleId) {
        const key = options.mode === "forbidden" ? "forbiddenElements" : "requiredElements";
        updateSelectorInRule(options.ruleId, selection, key);
        return;
      }
      saveCapturedRule(selection);
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

  const observer = new MutationObserver(() => { scanRules(); scanWorkflows(); });
  observer.observe(document.body, { childList: true, subtree: true });
  setInterval(() => { scanRules(); scanWorkflows(); }, 1000);

  window.addEventListener("nusuk-route-change", () => {
    executedRules.clear();
    pendingRules.clear();
    wfArmed.clear();          // re-arm auto-run workflows on a fresh page
    scanRules();
    scanWorkflows();
  });

  // Premium — each automation tool has its OWN key entitlement now:
  //   autoclick = click rules, fillrules = input-fill rules,
  //   autoselect = dropdown rules, workflows = sequences.
  const featOK = (f) => !window.NkLicense || window.NkLicense.featureOK(f);

  function refreshEnabled(after) {
    chrome.storage.local.get(["moduleAutoClicker", "moduleAutoFillRules", "moduleAutoSelect", "moduleWorkflows", "extensionEnabled"], (res) => {
      const on = res.extensionEnabled !== false;
      moduleEnabled    = on && !!res.moduleAutoClicker   && featOK("autoclick");  // click rules
      fillEnabled      = on && !!res.moduleAutoFillRules && featOK("fillrules");  // input-fill rules
      selectEnabled    = on && !!res.moduleAutoSelect    && featOK("autoselect"); // dropdown rules
      workflowsEnabled = on && !!res.moduleWorkflows     && featOK("workflows");
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
    if (changes.moduleAutoClicker || changes.moduleAutoFillRules || changes.moduleAutoSelect || changes.moduleWorkflows || changes.extensionEnabled) refreshEnabled(scanRules);
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
    const text = readValue(el, "text").toLowerCase();
    const want = interp(step.value || "", ctx).toLowerCase();
    if (cond === "textEquals")   return !!el && text === want;
    return !!el && text.includes(want); // textIncludes (default for text conds)
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

  async function runStep(step, ctx) {
    const type = step.type || "button";
    const sel = interp(stepSelector(step), ctx);

    if (type === "wait" || type === "delay") { await sleep(Number(step.waitMs) || 0); return; }
    if (type === "waitFor")  { if (!(await waitUntil(sel, true,  step.timeoutMs))) throw new Error(`waitFor timed out: ${sel}`); return; }
    if (type === "waitGone") { if (!(await waitUntil(sel, false, step.timeoutMs))) throw new Error(`waitGone timed out: ${sel}`); return; }
    if (type === "capture") {
      const ok = await waitUntil(sel, true, Number(step.timeoutMs) || 8000);
      const el = getElement(sel);
      if (!ok || !el) throw new Error(`capture: element not found: ${sel}`);
      const val = readValue(el, step.captureSource || "text");
      ctx.vars[step.varName || "var"] = val;
      wlog(`captured ${step.varName || "var"} = "${val}"`);
      return;
    }

    // Action step — ensure the element is present/visible first.
    const present = await waitUntil(sel, true, Number(step.timeoutMs) || 8000);
    const el = getElement(sel);
    if (!present || !el) throw new Error(`element not found: ${sel}`);
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
        await runStep(step, ctx);
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

  async function runWorkflow(wf) {
    if (wfState.running) { wlog("a workflow is already running"); return; }
    if (!wf || !Array.isArray(wf.steps) || !wf.steps.length) return;
    wfState.running = true; wfState.paused = false; wfState.stop = false; wfState.id = wf.id;
    const total = wf.steps.length;
    const base = { id: wf.id, name: wf.name, running: true, paused: false, total };
    const repeat = wf.repeat || { mode: "off" };
    const cols = (wf.data && Array.isArray(wf.data.columns)) ? wf.data.columns : [];
    const rows = (repeat.mode === "perRow" && wf.data && Array.isArray(wf.data.rows)) ? wf.data.rows : null;
    const newCtx = () => ({ vars: {}, humanize: !!wf.humanize });
    wlog(`▶ ${wf.name} — ${total} step(s)${wf.humanize ? " (humanized)" : ""}`);

    try {
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
      } else {
        await runProgram(wf.steps, newCtx(), base);
      }
    } catch (e) {
      const m = (e && e.message) || String(e);
      wfState.running = false; wfState.id = null;
      writeStatus({ ...base, running: false, done: true, lastError: m });
      wlog(`✖ ${wf.name} failed: ${m}`);
      return;
    }

    const stopped = wfState.stop;
    wfState.running = false; wfState.id = null;
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
  // A workflow with a `hotkey` (e.g. "Alt+1", "Ctrl+Shift+K") runs on that combo.
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
  // Cache combo → workflow so we don't hit storage on every keystroke.
  let hotkeyMap = {};
  function refreshHotkeys() {
    chrome.storage.local.get([WF_KEY], (res) => {
      hotkeyMap = {};
      (res[WF_KEY] || []).forEach((w) => { if (w.enabled !== false && w.hotkey) { const k = normHotkey(w.hotkey); if (k) hotkeyMap[k] = w; } });
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
    if (!workflowsEnabled) return;
    const combo = comboFromEvent(e);
    if (!combo) return;
    const wf = hotkeyMap[combo];
    if (wf) { e.preventDefault(); e.stopPropagation(); runWorkflow(wf); }
  }, true);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.action) {
      case "START_PICKER":
        inspectorDefaults = msg.defaults || {};
        startInspector(sendResponse, { mode: msg.mode || "required", ruleId: msg.ruleId, forWorkflow: msg.forWorkflow, forWorkflowTrigger: msg.forWorkflowTrigger, forWorkflowRepeatWhile: msg.forWorkflowRepeatWhile, forUsElement: msg.forUsElement, forWorkflowStep: msg.forWorkflowStep, workflowId: msg.workflowId, afterStepId: msg.afterStepId, stepId: msg.stepId });
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
