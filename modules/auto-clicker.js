(function () {
  "use strict";

  const RULES_KEY = "autoClickRules";
  const LEGACY_KEY = "autoButtons";

  let moduleEnabled = false;
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

  function getElement(selector) {
    if (!selector) return null;
    try {
      return document.querySelector(selector);
    } catch (err) {
      console.warn("Invalid selector skipped:", selector, err);
      return null;
    }
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

  function fillInput(element, rule) {
    const value = rule.fillValue || "";
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

    // Custom dropdown (PrimeNG p-dropdown, etc.) via sharedDropdownHandler
    if (typeof window.sharedDropdownHandler === "function") {
      const selector = (rule.requiredElements && rule.requiredElements[0]) || "";
      window.sharedDropdownHandler(selector, rule.selectValue || "");
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
    const delayMs = action.type === "delay" ? Math.max(Number(action.delayMs) || 0, 0) : 0;

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
      fillValue: rule.fillValue || "",
      clearFirst: rule.clearFirst !== false,
      triggerAngularEvents: rule.triggerAngularEvents !== false,
      selectValue: rule.selectValue || "",
      selectMatchBy: rule.selectMatchBy || "value",
      targetState: rule.targetState || "checked",
    };
  }

  // ── Scan loop ─────────────────────────────────────────────────────────────

  function scanRules() {
    if (!moduleEnabled || !rules.length) return;
    rules.forEach((rule) => {
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

  // ── Inspector ─────────────────────────────────────────────────────────────

  function startInspector(sendResponse, options = {}) {
    if (typeof window.ElementInspector !== "function") {
      sendResponse({ status: "Inspector unavailable" });
      return;
    }

    const inspector = new window.ElementInspector();
    inspector.start((selection) => {
      if (options.ruleId) {
        const key = options.mode === "forbidden" ? "forbiddenElements" : "requiredElements";
        updateSelectorInRule(options.ruleId, selection, key);
        return;
      }
      saveCapturedRule(selection);
    });
    sendResponse({ status: "Inspector Active" });
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  const observer = new MutationObserver(() => scanRules());
  observer.observe(document.body, { childList: true, subtree: true });
  setInterval(scanRules, 1000);

  window.addEventListener("nusuk-route-change", () => {
    executedRules.clear();
    pendingRules.clear();
    scanRules();
  });

  // Premium — its own per-key tool. Enabled only when the master extension
  // toggle is on, the module toggle is on, AND the license includes "autoclick".
  const premiumOK = () => !window.NkLicense || window.NkLicense.featureOK("autoclick");

  function refreshEnabled(after) {
    chrome.storage.local.get(["moduleAutoClicker", "extensionEnabled"], (res) => {
      moduleEnabled = res.extensionEnabled !== false && !!res.moduleAutoClicker && premiumOK();
      if (after) after();
    });
  }

  chrome.storage.local.get([RULES_KEY, LEGACY_KEY], (res) => {
    const initial = res[RULES_KEY] || res[LEGACY_KEY] || [];
    refreshEnabled(() => setRules(initial));
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.moduleAutoClicker || changes.extensionEnabled) refreshEnabled(scanRules);
    if (changes[RULES_KEY]) setRules(changes[RULES_KEY].newValue || []);
    else if (changes[LEGACY_KEY]) setRules(changes[LEGACY_KEY].newValue || []);
    else scanRules();
  });

  // React to license activation/deactivation while the page is open.
  window.NkLicense && window.NkLicense.onPremiumChange(() => refreshEnabled(scanRules));

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "START_PICKER") {
      inspectorDefaults = msg.defaults || {};
      startInspector(sendResponse, { mode: msg.mode || "required", ruleId: msg.ruleId });
    }
  });
})();
