(function () {
  "use strict";

  // URL Shifter — reactive rules that navigate to a target URL when the
  // current page's URL matches a condition. Angular-friendly: masar.nusuk.sa
  // is a single-page app, so a plain window.location watcher would miss
  // in-app route changes entirely (Angular's Router uses history.pushState,
  // never a real page load). utils/route-watcher.js already patches
  // pushState/replaceState and dispatches "nusuk-route-change" whenever the
  // URL actually changes — that's what drives every check here, on top of
  // the same 1s safety-net poll the other reactive rules use.

  const RULES_KEY = "autoUrlShiftRules";
  let moduleEnabled = false;
  let rules = [];
  const executedRules = new Set(); // rule ids already redirected THIS route — cleared on route change

  function normalizeRule(rule) {
    return {
      id: rule.id || Date.now() + Math.random(),
      name: rule.name || "Redirect",
      enabled: rule.enabled !== false,
      matchMode: rule.matchMode || "contains", // exact | partial | contains | not contains
      matchValue: rule.matchValue || "",
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
      if (!urlMatches(rule)) continue;
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
