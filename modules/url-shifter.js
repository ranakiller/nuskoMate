(function () {
  "use strict";

  // URL Shifter — reactive rules that navigate to a target URL when either
  // the current page's URL matches a condition, OR a chosen element appears
  // on the page (e.g. an error banner, a "session expired" dialog). Angular-
  // friendly: masar.nusuk.sa is a single-page app, so a plain window.location
  // watcher would miss in-app route changes entirely (Angular's Router uses
  // history.pushState, never a real page load). utils/route-watcher.js
  // already patches pushState/replaceState and dispatches "nusuk-route-change"
  // whenever the URL actually changes — that's what drives the URL-trigger
  // checks; element-trigger checks additionally use a MutationObserver so a
  // dynamically-inserted element is caught right away, same pattern as the
  // reactive click/fill/select rules in modules/auto-clicker.js.

  const RULES_KEY = "autoUrlShiftRules";
  let moduleEnabled = false;
  let rules = [];
  const executedRules = new Set(); // rule ids already redirected THIS route — cleared on route change

  function normalizeRule(rule) {
    return {
      id: rule.id || Date.now() + Math.random(),
      name: rule.name || "Redirect",
      enabled: rule.enabled !== false,
      triggerBy: rule.triggerBy === "element" ? "element" : "url",
      matchMode: rule.matchMode || "contains", // exact | partial | contains | not contains
      matchValue: rule.matchValue || "",
      elementSelector: rule.elementSelector || "",
      targetUrl: rule.targetUrl || "",
    };
  }

  // exact/partial match the PATH (consistent with click/fill/select rules'
  // own pathMatch); contains/"not contains" match the FULL url so a redirect
  // can key off query strings, hashes, or a domain fragment too.
  function urlMatches(rule) {
    const v = (rule.matchValue || "").trim();
    if (!v) return false;
    const path = window.location.pathname;
    const href = window.location.href;
    switch (rule.matchMode) {
      case "exact":        return path === v;
      case "partial":      return path.startsWith(v);
      case "contains":     return href.includes(v);
      case "not contains": return !href.includes(v);
      default:             return false;
    }
  }

  // ── Element selector resolution ──────────────────────────────────────────
  // Self-contained (not shared with modules/auto-clicker.js) so this module
  // has no load-order dependency on it. Same "Advanced selectors" syntax as
  // the rest of the app: xpath=, text=/text*=, and "a || b" fallback chains.
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
    for (const el of document.querySelectorAll(TEXT_SCAN)) {
      const t = (el.innerText || el.textContent || "").trim().toLowerCase();
      if (!t || t.length > want.length + 120) continue;
      if (exact ? t === want : t.includes(want)) return el;
    }
    return null;
  }
  function resolveOne(sel) {
    sel = String(sel || "").trim();
    if (!sel) return null;
    if (/^xpath=/i.test(sel)) return findByXPath(sel.slice(6));
    if (sel[0] === "/" || sel[0] === "(") return findByXPath(sel);
    if (/^text\*=/i.test(sel)) return findByText(sel.slice(6), false);
    if (/^text=/i.test(sel))   return findByText(sel.slice(5), true);
    try { return document.querySelector(sel); } catch (_) { return null; }
  }
  function getElement(selector) {
    if (!selector) return null;
    for (const p of String(selector).split("||")) {
      const el = resolveOne(p);
      if (el) return el;
    }
    return null;
  }

  function elementMatches(rule) {
    const sel = (rule.elementSelector || "").trim();
    return !!sel && !!getElement(sel);
  }

  function resolveTarget(targetUrl) {
    try { return new URL(targetUrl, window.location.origin).href; }
    catch (_) { return targetUrl || ""; }
  }

  const ulog = (m) => { try { (window.nkLog || console.log)("[Nuskomate URL Shifter] " + m); } catch (_) { console.log(m); } };

  function scanUrlShiftRules() {
    if (!moduleEnabled || !rules.length) return;
    for (const rule of rules) {
      const id = String(rule.id);
      if (!rule.enabled || executedRules.has(id)) continue;
      const matched = rule.triggerBy === "element" ? elementMatches(rule) : urlMatches(rule);
      if (!matched) continue;
      const target = resolveTarget(rule.targetUrl);
      if (!target || target === window.location.href) continue; // no target, or already there
      executedRules.add(id); // one redirect per rule per route — avoids bounce loops
      ulog(`"${rule.name}" matched — going to ${target}`);
      window.location.href = target;
      return; // a navigation is starting; nothing else to do this pass
    }
  }

  function setRules(next) {
    rules = (next || []).map(normalizeRule);
    scanUrlShiftRules();
  }

  window.addEventListener("nusuk-route-change", () => {
    executedRules.clear();
    scanUrlShiftRules();
  });
  setInterval(scanUrlShiftRules, 1000);
  new MutationObserver(scanUrlShiftRules).observe(document.documentElement, { childList: true, subtree: true });

  // Premium — its own tool id, same pattern as the other automation modules.
  const premiumOK = () => !window.NkLicense || window.NkLicense.featureOK("urlshift");

  function refreshEnabled(after) {
    chrome.storage.local.get(["moduleUrlShift", "extensionEnabled"], (res) => {
      moduleEnabled = res.extensionEnabled !== false && !!res.moduleUrlShift && premiumOK();
      if (after) after();
    });
  }

  chrome.storage.local.get([RULES_KEY], (res) => {
    refreshEnabled(() => setRules(res[RULES_KEY] || []));
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.moduleUrlShift || changes.extensionEnabled) refreshEnabled(scanUrlShiftRules);
    if (changes[RULES_KEY]) setRules(changes[RULES_KEY].newValue || []);
  });

  // React to license activation/deactivation while the page is open.
  window.NkLicense && window.NkLicense.onPremiumChange(() => refreshEnabled(scanUrlShiftRules));
})();
