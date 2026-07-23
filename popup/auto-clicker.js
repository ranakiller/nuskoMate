// Auto Clicker — rules manager for the "Rules" tab (click/fill/select rules
// merged into one) and the separate "Translate" tab.
// Rules are stored in chrome.storage.local under "autoClickRules" and executed
// by modules/auto-clicker.js on the Masar page. The enable toggle lives on
// each tab's own module card; this panel only creates/edits rules.
document.addEventListener("DOMContentLoaded", () => {
  const RULES_KEY = "autoClickRules";
  const TYPE_LABELS = { button: "BTN", input: "INP", dropdown: "SEL", checkbox: "CHK", radio: "RAD", translate: "TRN" };

  // Practical subset of Google Translate's supported languages, weighted
  // toward the languages actually in play around Umrah travel (South Asia,
  // Southeast Asia, the Gulf, Turkey/Iran/Africa) rather than the full list.
  const LANGUAGES = [
    { code: "en", label: "English" }, { code: "ar", label: "Arabic" },
    { code: "ur", label: "Urdu" }, { code: "hi", label: "Hindi" },
    { code: "bn", label: "Bengali" }, { code: "id", label: "Indonesian" },
    { code: "ms", label: "Malay" }, { code: "tl", label: "Filipino (Tagalog)" },
    { code: "tr", label: "Turkish" }, { code: "fa", label: "Persian (Farsi)" },
    { code: "ps", label: "Pashto" }, { code: "sw", label: "Swahili" },
    { code: "fr", label: "French" }, { code: "es", label: "Spanish" },
    { code: "pt", label: "Portuguese" }, { code: "de", label: "German" },
    { code: "ru", label: "Russian" }, { code: "zh-CN", label: "Chinese (Simplified)" },
    { code: "ta", label: "Tamil" }, { code: "ml", label: "Malayalam" },
  ];

  // Preset date/time formats offered for a fill rule's "date" value mode.
  // Tokens: YYYY YY MMM MM DD HH mm ss (see formatDate in modules/auto-clicker.js).
  const DATE_FORMAT_PRESETS = [
    "YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "DD-MM-YYYY",
    "DD MMM YYYY", "HH:mm", "YYYY-MM-DD HH:mm",
    { value: "custom", label: "Custom…" },
  ];

  // Click/input/dropdown rules used to be 3 separate tabs/categories — now
  // ONE "Rules" tab/category ("auto"); Translate stays its own separate
  // category on purpose (a text transform, not a click/fill/select action).
  const CATS = [
    { cat: "auto",      list: "ar-list", search: "ar-search", add: "ar-add", exp: "ar-export", imp: "ar-import", impFile: "ar-import-file", share: "ar-share", impLink: "ar-import-link", delAll: "ar-delete-all", expandToggle: "ar-expand-toggle", searchKey: "acSearch_auto",      module: "moduleAutoRules",      empty: "No rules yet",             file: "auto-rules",      infoBtn: "ar-info-btn", infoPanel: "ar-info-panel" },
    { cat: "translate", list: "tr-list", search: "tr-search", add: "tr-add", exp: "tr-export", imp: "tr-import", impFile: "tr-import-file", share: "tr-share", impLink: "tr-import-link", delAll: "tr-delete-all", expandToggle: "tr-expand-toggle", searchKey: "acSearch_translate", module: "moduleTranslateRules", empty: "No translation rules yet", file: "translate-rules", infoBtn: "tr-info-btn", infoPanel: "tr-info-panel", forceType: "translate" },
  ];
  if (!document.getElementById("ar-list")) return;

  // Default for a brand-new "auto-detect" translate rule's language list —
  // resolved once at popup load (Settings > Extension language, "system" =
  // the browser's own UI language). Not re-read live; good enough for a
  // one-time default, the rule's own saved list is what actually matters.
  let cachedDefaultLang = "en";
  chrome.storage.local.get(["nkLanguage"], (res) => {
    const pref = res.nkLanguage;
    if (pref && pref !== "system") { cachedDefaultLang = pref; return; }
    try { cachedDefaultLang = (chrome.i18n.getUILanguage() || "en").split("-")[0].toLowerCase(); } catch (_) {}
  });

  const collapsedRuleIds = new Set();
  const knownRuleIds = new Set();
  const collapsedGroups = new Set(); // "cat|path" groups collapsed in the rules lists

  // Flipping a rule/workflow/redirect-rule's on/off slider is the one card
  // interaction with a CSS transition to actually see — but every save here
  // triggers a storage.onChanged event, which the listeners below react to
  // by tearing down and rebuilding the whole list. If that rebuild lands
  // (and it reliably does, well inside the slider's transition duration)
  // it replaces the very DOM node mid-animation with a fresh one already in
  // its final state, so the slide never gets to play — it just snaps.
  // The toggle's native checked state is already visually correct the
  // instant you click it, so for THIS one save there's nothing else on
  // screen that actually needs a rebuild — skip the next onChanged-driven
  // render it causes. Self-clears on a short timer too, in case the write
  // is a no-op (same value) and onChanged never actually fires.
  let suppressNextToggleRender = false;
  function skipNextToggleRender() {
    suppressNextToggleRender = true;
    setTimeout(() => { suppressNextToggleRender = false; }, 400);
  }

  // A popup is fully torn down and rebuilt every time it's closed, so these
  // Sets would otherwise forget every Hide/Show the instant you close the
  // popup. knownRuleIds is persisted alongside collapsedRuleIds so a rule
  // that's genuinely brand-new (never in either) still defaults to
  // collapsed, while a previously-seen rule keeps whatever state you left it in.
  function persistRuleCollapse() {
    chrome.storage.local.set({
      acKnownRuleIds: [...knownRuleIds],
      acCollapsedRuleIds: [...collapsedRuleIds],
      acCollapsedGroups: [...collapsedGroups],
    });
  }

  function categoryOf(rule) {
    return rule.type === "translate" ? "translate" : "auto";
  }

  // ── Per-category search + info toggle ───────────────────────────────────
  CATS.forEach((c) => {
    wireInfoToggle(c.infoBtn, c.infoPanel);
    const s = document.getElementById(c.search);
    if (!s) return;
    chrome.storage.local.get([c.searchKey], (res) => { s.value = res[c.searchKey] || ""; });
    s.addEventListener("input", (e) => { chrome.storage.local.set({ [c.searchKey]: e.target.value }); renderRules(); });
  });

  // ── Normalization ───────────────────────────────────────────────────────
  function normalizeSelectorArray(value) {
    if (Array.isArray(value)) return value.map((s) => String(s || "").trim()).filter(Boolean);
    if (typeof value === "string") return value.split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);
    return [];
  }

  function normalizeAction(raw) {
    if (raw && ["run", "stop", "delay"].includes(raw.type)) {
      return { type: raw.type, delayMs: Math.max(Number(raw.delayMs) || 0, 0) };
    }
    const oldType = typeof raw === "string" ? raw : (raw && raw.type) || "click";
    const oldDelay = Math.max(Number(typeof raw === "object" ? raw && raw.delay : 0) || 0, 0);
    if (oldType === "dontClick" || oldType === "delay") return { type: "stop", delayMs: 0 };
    return { type: "run", delayMs: oldDelay };
  }

  function normalizeRule(rule) {
    const requiredElements = normalizeSelectorArray(
      rule.requiredElements || rule.requiredElement || rule.selector || [],
    );
    const forbiddenElements = normalizeSelectorArray(
      rule.forbiddenElements || rule.forbiddenElement || [],
    );
    const repeat = typeof rule.repeat === "boolean"
      ? rule.repeat
      : !!(rule.alwaysClick || (rule.action && rule.action.type === "alwaysClick"));

    return {
      id: rule.id || Date.now(),
      type: rule.type || "button",
      enabled: rule.enabled !== false,
      name: rule.name || rule.text || requiredElements[0] || "Unnamed",
      text: rule.text || "",
      pathname: rule.pathname !== undefined ? rule.pathname : (rule.path !== undefined ? rule.path : ""),
      pathMatch: rule.pathMatch || rule.urlMatch || "exact",
      requiredElements,
      forbiddenElements,
      action: normalizeAction(rule.action),
      repeat,
      repeatIntervalMs: Math.max(Number(rule.repeatIntervalMs) || Number(rule.alwaysClickDelay) || 0, 0),
      jitterMs: Math.max(Number(rule.jitterMs) || 0, 0),
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
      mode: rule.mode === "autoDetect" ? "autoDetect" : "fieldToField",
      sourceSelector: rule.sourceSelector || "",
      sourceLang: rule.sourceLang || "en",
      targetLang: rule.targetLang || "ar",
      targetLangs: Array.isArray(rule.targetLangs) ? rule.targetLangs.filter(Boolean) : [],
      // autoDetect only — "replace" overwrites the page text in place
      // (original behavior); "tooltip" leaves the text untouched and shows
      // the translation in a hover tooltip instead.
      displayMode: rule.displayMode === "tooltip" ? "tooltip" : "replace",
    };
  }

  // "How this works" — collapsed behind an ⓘ button next to a section title
  // so it doesn't eat space once you already know the ropes.
  function wireInfoToggle(btnId, panelId) {
    const btn = document.getElementById(btnId);
    const panel = document.getElementById(panelId);
    if (!btn || !panel) return;
    btn.addEventListener("click", () => {
      const open = panel.style.display !== "none";
      panel.style.display = open ? "none" : "";
      btn.classList.toggle("info-btn-open", !open);
    });
  }

  // ── Drag-to-reorder (pointer-based, NOT native HTML5 DnD) ─────────────────
  // Native HTML5 drag-and-drop (draggable="true" + dragstart/dragover/drop)
  // is unreliable inside a small extension popup — the drop kept being
  // rejected and the browser played its "snap back to origin" animation, no
  // matter how the drop targets were wired. So this doesn't use the browser's
  // DnD state machine AT ALL: it's plain pointer tracking with Pointer
  // Capture, which keeps receiving move/up events for the rest of the
  // gesture regardless of what's under the cursor (a card, a gap, a group
  // header, a step inserter — doesn't matter).
  //
  // Call from a drag-HANDLE's pointerdown: startPointerDrag(e, handleEl,
  // itemEl, itemId, container, itemSelector, onReorder). onReorder(srcId,
  // targetId) fires once, on release, with whichever item ended up closest
  // to the pointer.
  function startPointerDrag(e, handleEl, itemEl, itemId, container, itemSelector, onReorder) {
    if (e.button !== 0) return; // left button / primary touch only
    e.preventDefault();
    itemEl.classList.add("dragging");
    try { handleEl.setPointerCapture(e.pointerId); } catch (_) {}

    function closestItem(clientY) {
      let best = null, bestDist = Infinity;
      container.querySelectorAll(itemSelector).forEach((el) => {
        if (el === itemEl) return;
        const r = el.getBoundingClientRect();
        const dist = Math.abs(clientY - (r.top + r.height / 2));
        if (dist < bestDist) { bestDist = dist; best = el; }
      });
      return best;
    }

    function onMove(ev) {
      const near = closestItem(ev.clientY);
      container.querySelectorAll(itemSelector).forEach((el) => el.classList.toggle("drag-over", el === near));
    }
    function finish(ev) {
      handleEl.removeEventListener("pointermove", onMove);
      handleEl.removeEventListener("pointerup", finish);
      handleEl.removeEventListener("pointercancel", finish);
      try { handleEl.releasePointerCapture(ev.pointerId); } catch (_) {}
      const near = closestItem(ev.clientY);
      itemEl.classList.remove("dragging");
      container.querySelectorAll(itemSelector).forEach((el) => el.classList.remove("drag-over"));
      if (near && near.dataset.dragId && String(near.dataset.dragId) !== String(itemId)) {
        onReorder(itemId, near.dataset.dragId);
      }
    }
    handleEl.addEventListener("pointermove", onMove);
    handleEl.addEventListener("pointerup", finish);
    handleEl.addEventListener("pointercancel", finish);
  }

  function matchesSearch(rule, search) {
    return [
      rule.name, rule.type, rule.pathname, rule.pathMatch, rule.fillValue, rule.selectValue,
      rule.sourceSelector, ...(rule.targetLangs || []),
      ...rule.requiredElements, ...rule.forbiddenElements,
    ].filter(Boolean).join(" ").toLowerCase().includes(search);
  }

  // ── Share by link ──────────────────────────────────────────────────────────
  // Preferred: SHORT server-backed links — the rule set is stored on the
  // license server (KV, 180-day expiry) and the link is just an unguessable
  // code, e.g.  https://…workers.dev/share/aB3xk9QmT2
  // Fallback / legacy: self-contained links carrying the whole rule set as
  // URL-safe base64 after "r=" — still importable, and used for sharing when
  // the server can't be reached.
  const SHARE_BASE = "https://nuskomate.app/rules#r=";
  function encodeRulesLink(rules) {
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(rules))))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return SHARE_BASE + b64;
  }
  function decodeRulesLink(text) {
    let s = String(text || "").trim();
    if (!s) throw new Error("Nothing pasted.");
    const at = s.search(/[#?&]r=/);           // pull the code out of a full link
    if (at >= 0) s = s.slice(at + 3);
    s = s.split(/[#?&\s]/)[0];                 // drop anything trailing
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    let parsed;
    try { parsed = JSON.parse(decodeURIComponent(escape(atob(s)))); }
    catch (_) { throw new Error("This is not a valid Nuskomate rules link."); }
    if (!Array.isArray(parsed)) throw new Error("This link does not contain a rules list.");
    return parsed;
  }
  // Extract the short-share code from a pasted link (or bare code), else "".
  function shareCodeFrom(text) {
    const s = String(text || "").trim();
    const m = /\/share\/([A-Za-z0-9]{6,24})\b/.exec(s) || /^([A-Za-z0-9]{6,24})$/.exec(s);
    return m ? m[1] : "";
  }
  function copyText(text, okMsg) {
    const fallback = () => window.prompt("Copy this link:", text);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => alert(okMsg), fallback);
    } else fallback();
  }

  // Shared by bulk (whole category / whole URL group), single-rule and
  // per-group Share buttons across click/fill/select AND URL Shifter — same
  // short-link-first, long-link-fallback flow, just given a smaller array.
  async function shareRuleArray(rules, btnEl) {
    if (!rules.length) { alert("No rules to share."); return; }
    if (btnEl) btnEl.disabled = true;
    if (window.NkLicense && window.NkLicense.shareRules) {
      const r = await window.NkLicense.shareRules(rules);
      if (btnEl) btnEl.disabled = false;
      if (r && r.ok && r.url) {
        copyText(r.url, `Short link copied — ${rules.length} rule(s), valid 180 days.\nAnyone imports it with "Import link".`);
        return;
      }
      if (!confirm(`Could not create a short link (${(r && r.error) || "server unreachable"}).\nCopy a long offline link instead?`)) return;
    } else if (btnEl) btnEl.disabled = false;
    copyText(encodeRulesLink(rules), `Long link copied — ${rules.length} rule(s). Paste it to anyone; they import it with "Import link".`);
  }

  // Single toolbar icon shared by every automation tab (Click/Fill/Select/
  // Workflows/URL Shifter) that flips between "expand everything" and
  // "collapse everything" — one click opens every collapsible item in the
  // tab, the next click closes them all again. `ids` is whichever set of
  // collapse-keys applies to that tab (rule-group keys for Click/Fill/Select,
  // workflow ids for Workflows, rule ids for URL Shifter); `collapsedSet` is
  // that tab's own Set tracking which of those keys are currently collapsed.
  function wireExpandToggle(btnId, ids, collapsedSet, rerender, noun) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    const anyCollapsed = ids.some((id) => collapsedSet.has(id));
    btn.innerHTML = svgIcon(anyCollapsed ? "chevDown" : "chevUp");
    btn.title = ids.length ? (anyCollapsed ? `Expand all ${noun}` : `Collapse all ${noun}`) : `No ${noun} yet`;
    btn.setAttribute("aria-label", btn.title);
    btn.disabled = !ids.length;
    btn.onclick = () => {
      if (anyCollapsed) ids.forEach((id) => collapsedSet.delete(id));
      else ids.forEach((id) => collapsedSet.add(id));
      rerender();
    };
  }

  // ── Undo / redo (Tier 3) ───────────────────────────────────────────────────
  // Every rule/workflow/redirect-rule mutation snapshots ALL THREE stores
  // first, so Ctrl+Z walks back edits, deletes, imports, reorders and profile
  // loads across the Clicker/Fill/Select tabs, Workflows, AND URL Shifter.
  // Per popup session.
  const HISTORY_MAX = 60;
  const history = { undo: [], redo: [] };
  let restoringHistory = false;

  function historySnapshot(cb) {
    chrome.storage.local.get([RULES_KEY, "autoWorkflows", "autoUrlShiftRules"], (res) =>
      cb({ rules: res[RULES_KEY] || [], wfs: res.autoWorkflows || [], usRules: res.autoUrlShiftRules || [] }));
  }
  function pushUndo(then) {
    if (restoringHistory) { then(); return; }
    historySnapshot((snap) => {
      history.undo.push(snap);
      if (history.undo.length > HISTORY_MAX) history.undo.shift();
      history.redo.length = 0;
      updateHistoryButtons();
      then();
    });
  }
  function applyHistorySnapshot(snap) {
    restoringHistory = true;
    chrome.storage.local.set({ [RULES_KEY]: snap.rules, autoWorkflows: snap.wfs, autoUrlShiftRules: snap.usRules }, () => {
      restoringHistory = false;
      renderRules(); renderWorkflows(); renderUsRules(); updateHistoryButtons();
    });
  }
  function doUndo() {
    if (!history.undo.length) return;
    historySnapshot((cur) => { history.redo.push(cur); applyHistorySnapshot(history.undo.pop()); });
  }
  function doRedo() {
    if (!history.redo.length) return;
    historySnapshot((cur) => { history.undo.push(cur); applyHistorySnapshot(history.redo.pop()); });
  }
  function updateHistoryButtons() {
    const u = document.getElementById("hist-undo"), r = document.getElementById("hist-redo");
    if (u) { u.disabled = !history.undo.length; u.title = `Undo rule/workflow change (Ctrl+Z) — ${history.undo.length} available`; }
    if (r) { r.disabled = !history.redo.length; r.title = `Redo (Ctrl+Y) — ${history.redo.length} available`; }
  }
  const histUndoBtn = document.getElementById("hist-undo");
  const histRedoBtn = document.getElementById("hist-redo");
  if (histUndoBtn) histUndoBtn.addEventListener("click", doUndo);
  if (histRedoBtn) histRedoBtn.addEventListener("click", doRedo);
  updateHistoryButtons();
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    // Let text fields keep their native text undo while typing.
    const t = e.target && e.target.tagName;
    if (t === "INPUT" || t === "TEXTAREA" || t === "SELECT") return;
    const k = (e.key || "").toLowerCase();
    if (k === "z" && !e.shiftKey) { e.preventDefault(); doUndo(); }
    else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); doRedo(); }
  });

  // ── Persistence ─────────────────────────────────────────────────────────
  function saveRules(rules, callback) { pushUndo(() => chrome.storage.local.set({ [RULES_KEY]: rules }, callback)); }

  // Reads current storage itself (rather than trusting a `rules` array
  // handed in from whenever the card was rendered) so it's always correct
  // even if the drag took a while or another edit landed in between.
  function reorderRules(sourceId, targetId) {
    chrome.storage.local.get([RULES_KEY, "autoButtons"], (res) => {
      const rules = (res[RULES_KEY] || res.autoButtons || []).map(normalizeRule);
      const from = rules.findIndex((r) => String(r.id) === String(sourceId));
      const to = rules.findIndex((r) => String(r.id) === String(targetId));
      if (from < 0 || to < 0 || from === to) return;
      const next = [...rules];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      saveRules(next, renderRules);
    });
  }

  // ── Field helpers ─────────────────────────────────────────────────────────
  function getRuleValue(rule, key) {
    if (key === "actionType") return rule.action.type;
    if (key === "actionDelaySeconds") return rule.action.delayMs / 1000;
    if (key === "repeatIntervalSeconds") return rule.repeatIntervalMs / 1000;
    if (key === "jitterSeconds") return (rule.jitterMs || 0) / 1000;
    return rule[key] !== undefined ? rule[key] : "";
  }
  function isSecondsField(key) { return key === "actionDelaySeconds" || key === "repeatIntervalSeconds" || key === "jitterSeconds"; }
  function normalizeActionType(type) { return ["run", "stop", "delay"].includes(type) ? type : "run"; }

  function setRuleValue(rule, key, value) {
    if (key === "actionType") return { ...rule, action: { ...rule.action, type: normalizeActionType(value) } };
    if (key === "actionDelaySeconds") return { ...rule, action: { ...rule.action, delayMs: Math.max(Number(value) || 0, 0) * 1000 } };
    if (key === "repeatIntervalSeconds") return { ...rule, repeatIntervalMs: Math.max(Number(value) || 0, 0) * 1000 };
    if (key === "jitterSeconds") return { ...rule, jitterMs: Math.max(Number(value) || 0, 0) * 1000 };
    return { ...rule, [key]: value };
  }

  function createField(rule, key, labelText, controlType, rules, options, size) {
    const wrapper = document.createElement("div");
    wrapper.className = size ? `rule-field ${size}` : "rule-field";
    const label = document.createElement("label");
    label.textContent = labelText;
    const control = controlType === "select" ? document.createElement("select") : document.createElement("input");
    if (controlType === "select") {
      // Options are either plain strings (value === displayed label, most
      // fields) or { value, label } objects when the raw value would be
      // unclear on its own (e.g. "date" → "Today's date (formatted)").
      (options || []).forEach((o) => {
        const val = typeof o === "object" ? o.value : o;
        const lbl = typeof o === "object" ? o.label : o;
        const opt = document.createElement("option");
        opt.value = val; opt.textContent = lbl; control.appendChild(opt);
      });
    } else {
      control.type = isSecondsField(key) ? "number" : "text";
      if (isSecondsField(key)) { control.min = "0"; control.step = "0.5"; }
    }
    control.value = getRuleValue(rule, key);
    control.addEventListener("change", (e) => {
      const nextRules = rules.map((r) => String(r.id) === String(rule.id) ? setRuleValue(r, key, e.target.value) : r);
      // These fields change which OTHER fields should be visible (e.g.
      // switching Value to "date" reveals the date-format field), so they
      // need a full re-render, not just a silent save.
      const needsRerender = key === "actionType" || key === "valueMode" || key === "dateFormat" || key === "triggerMode" || key === "mode" || key === "displayMode";
      saveRules(nextRules, needsRerender ? renderRules : undefined);
    });
    wrapper.append(label, control);
    return wrapper;
  }

  function createCheckboxField(rule, key, labelText, rules, callback) {
    const wrapper = document.createElement("div");
    wrapper.className = "check-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!rule[key];
    input.addEventListener("change", (e) => {
      saveRules(rules.map((r) => String(r.id) === String(rule.id) ? { ...r, [key]: e.target.checked } : r), callback || undefined);
    });
    const label = document.createElement("label");
    label.textContent = labelText;
    wrapper.append(input, label);
    return wrapper;
  }

  // Path match + Page path share one row — the dropdown stays a fixed
  // narrow width, the path input takes the rest. Reuses createField for
  // each half so the actual save/change wiring stays identical everywhere
  // else it's used; this just repackages the two into one flex row.
  function createPathRow(rule, rules) {
    const wrapper = document.createElement("div");
    wrapper.className = "rule-field full path-row";
    const matchField = createField(rule, "pathMatch", "Path match", "select", rules, ["exact", "includes"]);
    matchField.classList.add("path-row-match");
    const pathField = createField(rule, "pathname", "Page path", "input", rules);
    pathField.classList.add("path-row-path");
    wrapper.append(matchField, pathField);
    return wrapper;
  }

  function createMultiSelectorField(rule, key, labelText, rules, placeholder, mode) {
    const wrapper = document.createElement("div");
    wrapper.className = "rule-field full";
    const label = document.createElement("label");
    label.textContent = labelText;
    const list = document.createElement("div");
    list.className = "multi-selector-list";
    const selectors = Array.isArray(rule[key]) ? rule[key] : [];

    const renderItems = () => {
      list.textContent = "";
      const values = selectors.length ? selectors : [""];
      values.forEach((value, index) => {
        const row = document.createElement("div");
        row.className = "multi-selector-row";
        const input = document.createElement("input");
        input.type = "text";
        input.value = value;
        input.placeholder = placeholder || "Enter selector";
        input.addEventListener("change", (e) => {
          const next = [...values];
          next[index] = e.target.value.trim();
          saveRules(rules.map((r) => String(r.id) === String(rule.id) ? { ...r, [key]: next.filter(Boolean) } : r), renderRules);
        });
        const removeBtn = iconMini("trash", "Remove this selector", () => {
          const next = [...values];
          next.splice(index, 1);
          saveRules(rules.map((r) => String(r.id) === String(rule.id) ? { ...r, [key]: next.filter(Boolean) } : r), renderRules);
        }, true);
        // Pick REPLACES this specific row (by index) — appending a brand new
        // row is the separate "+ Add selector" button below the list, not
        // something every row's own Pick button should also do.
        row.append(input, pickSelectorBtn({ mode, ruleId: rule.id, index }), highlightSelectorBtn(() => input.value), removeBtn);
        list.appendChild(row);
      });
    };

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "multi-selector-add";
    addBtn.textContent = "+ Add selector";
    addBtn.title = "Pick another element on the page to add as a new selector";
    addBtn.addEventListener("click", () => startPicker({ mode, ruleId: rule.id }));

    wrapper.append(label, list, addBtn);
    renderItems();
    return wrapper;
  }

  function getTypeSpecificFields(rule, rules) {
    switch (rule.type) {
      case "input": {
        const fields = [createField(rule, "valueMode", "Value", "select", rules, [
          { value: "text", label: "Static text (Fill value below)" },
          { value: "date", label: "Today's date/time (formatted)" },
        ])];
        if (rule.valueMode === "date") {
          fields.push(createField(rule, "dateFormat", "Date format", "select", rules, DATE_FORMAT_PRESETS));
          if (rule.dateFormat === "custom") {
            fields.push(createField(rule, "dateFormatCustom", "Custom format (YYYY MM DD HH mm ss)", "input", rules, null, "full"));
          }
        } else {
          fields.push(createField(rule, "fillValue", "Fill value", "input", rules, null, "full"));
        }
        fields.push(
          createField(rule, "prefix", "Prefix", "input", rules),
          createField(rule, "suffix", "Suffix", "input", rules),
          createCheckboxField(rule, "clearFirst", "Clear first", rules),
          createCheckboxField(rule, "triggerAngularEvents", "Angular events", rules),
        );
        return fields;
      }
      case "dropdown":
        return [
          createField(rule, "selectValue", "Select value", "input", rules, null, "full"),
          createField(rule, "selectMatchBy", "Match by", "select", rules, ["value", "text"]),
        ];
      case "checkbox":
      case "radio":
        return [createField(rule, "targetState", "Target state", "select", rules, ["checked", "unchecked", "toggle"])];
      case "translate": {
        const fields = [createField(rule, "mode", "Mode", "select", rules, [
          { value: "fieldToField", label: "Field to field — one source, one target, fixed languages" },
          { value: "autoDetect",   label: "Auto-detect — translate any foreign text found, to N languages" },
        ])];
        if (rule.mode === "autoDetect") {
          fields.push(
            createField(rule, "displayMode", "Display", "select", rules, [
              { value: "replace", label: "Replace the text on the page" },
              { value: "tooltip", label: "Show a tooltip on hover, with a button to replace on demand" },
            ]),
            createTargetLangsField(rule, rules),
          );
        } else {
          fields.push(
            createSourceSelectorField(rule, rules),
            createField(rule, "sourceLang", "From language", "select", rules, LANGUAGES.map((l) => ({ value: l.code, label: l.label }))),
            createField(rule, "targetLang", "To language", "select", rules, LANGUAGES.map((l) => ({ value: l.code, label: l.label }))),
          );
        }
        return fields;
      }
      default:
        return [];
    }
  }

  // ── Translation rule fields (mode-specific, see getTypeSpecificFields) ────

  function createSourceSelectorField(rule, rules) {
    const wrapper = document.createElement("div"); wrapper.className = "rule-field full";
    const label = document.createElement("label"); label.textContent = "Source element (translated FROM here)";
    const row = document.createElement("div"); row.className = "us-url-row";
    const input = document.createElement("input");
    input.type = "text"; input.value = rule.sourceSelector || "";
    input.placeholder = "CSS / xpath= / text=";
    input.addEventListener("change", (e) => {
      saveRules(rules.map((r) => String(r.id) === String(rule.id) ? { ...r, sourceSelector: e.target.value.trim() } : r), renderRules);
    });
    row.append(
      input,
      pickSelectorBtn({ forTranslateSource: true, ruleId: rule.id }),
      highlightSelectorBtn(() => input.value),
    );
    wrapper.append(label, row);
    return wrapper;
  }

  function createTargetLangsField(rule, rules) {
    const wrapper = document.createElement("div"); wrapper.className = "rule-field full";
    const label = document.createElement("label");
    label.textContent = rule.displayMode === "tooltip"
      ? "Target languages — each one adds a line to the hover tooltip"
      : "Target languages — first replaces the text in place; each extra one adds a translated duplicate right below it";
    const list = document.createElement("div"); list.className = "multi-selector-list";
    const langs = rule.targetLangs.length ? rule.targetLangs : [cachedDefaultLang];

    langs.forEach((code, index) => {
      const row = document.createElement("div"); row.className = "multi-selector-row";
      const sel = document.createElement("select");
      LANGUAGES.forEach((l) => { const opt = document.createElement("option"); opt.value = l.code; opt.textContent = l.label; sel.appendChild(opt); });
      sel.value = code;
      sel.addEventListener("change", (e) => {
        const next = [...langs]; next[index] = e.target.value;
        saveRules(rules.map((r) => String(r.id) === String(rule.id) ? { ...r, targetLangs: next } : r), renderRules);
      });
      const removeBtn = iconMini("trash", "Remove this language", () => {
        const next = [...langs]; next.splice(index, 1);
        saveRules(rules.map((r) => String(r.id) === String(rule.id) ? { ...r, targetLangs: next } : r), renderRules);
      }, true);
      row.append(sel, removeBtn);
      list.appendChild(row);
    });

    const addBtn = document.createElement("button");
    addBtn.type = "button"; addBtn.className = "multi-selector-add"; addBtn.textContent = "+ Add language";
    addBtn.title = "Add another target language — a translated duplicate is inserted for each one beyond the first";
    addBtn.addEventListener("click", () => {
      const next = [...langs, cachedDefaultLang];
      saveRules(rules.map((r) => String(r.id) === String(rule.id) ? { ...r, targetLangs: next } : r), renderRules);
    });

    wrapper.append(label, list, addBtn);
    return wrapper;
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function renderRules() {
    // Pull every category's search key dynamically (was a hardcoded list
    // that silently missed acSearch_translate when that tab was added —
    // its search box never actually filtered anything as a result).
    chrome.storage.local.get([RULES_KEY, "autoButtons", ...CATS.map((c) => c.searchKey)], (res) => {
      const rules = (res[RULES_KEY] || res.autoButtons || []).map(normalizeRule);

      const buildRuleCard = (rule) => {
        const id = String(rule.id);
        if (!knownRuleIds.has(id)) { knownRuleIds.add(id); collapsedRuleIds.add(id); }

        const card = document.createElement("div");
        card.className = "rule-card";

        const isCollapsed = collapsedRuleIds.has(id);

        const head = document.createElement("div");
        head.className = "rule-head";

        const { label: toggleWrap, input: toggle } = toggleSwitch(rule.enabled, "enable-toggle");
        toggle.dataset.id = id;
        toggle.title = "Enable this rule";

        const dragHandle = document.createElement("span");
        dragHandle.className = "drag-handle";
        dragHandle.textContent = "☰";

        // Collapsed: plain headline text. Expanded: the SAME spot becomes a
        // borderless inline input — renaming happens right in the header,
        // no separate "Rule name" field further down the card anymore.
        let title;
        if (isCollapsed) {
          title = document.createElement("div");
          title.className = "rule-title";
          title.textContent = rule.name || rule.requiredElements[0] || "Unnamed";
        } else {
          title = document.createElement("input");
          title.type = "text";
          title.className = "rule-title rule-title-input";
          title.value = rule.name || "";
          title.placeholder = rule.requiredElements[0] || "Unnamed";
          title.addEventListener("change", (e) => {
            saveRules(rules.map((r) => String(r.id) === String(rule.id) ? { ...r, name: e.target.value } : r));
          });
        }

        const badge = document.createElement("span");
        badge.className = `type-badge type-badge--${rule.type}`;
        badge.textContent = TYPE_LABELS[rule.type] || "BTN";

        // Headline row: toggle, drag handle, name — the type badge floats to
        // the far right for free since the title/input has flex:1.
        head.append(toggleWrap, dragHandle, title, badge);

        const collapseBtn = document.createElement("button");
        collapseBtn.className = "collapse-rule wf-icon-btn";
        collapseBtn.type = "button";
        collapseBtn.dataset.id = id;
        collapseBtn.innerHTML = svgIcon(isCollapsed ? "chevDown" : "chevUp");
        collapseBtn.title = isCollapsed ? "Show rule details" : "Hide rule details";

        const shareBtn = document.createElement("button");
        shareBtn.className = "secondary-btn wf-icon-btn rule-share-btn";
        shareBtn.dataset.id = id;
        shareBtn.type = "button";
        shareBtn.innerHTML = svgIcon("share");
        shareBtn.title = "Share this rule as a link";

        const dupBtn = document.createElement("button");
        dupBtn.className = "secondary-btn wf-icon-btn dup-btn";
        dupBtn.dataset.id = id;
        dupBtn.type = "button";
        dupBtn.innerHTML = svgIcon("duplicate");
        dupBtn.title = "Duplicate this rule";

        const delBtn = document.createElement("button");
        delBtn.className = "delete-rule wf-icon-btn del-btn";
        delBtn.dataset.id = id;
        delBtn.type = "button";
        delBtn.innerHTML = svgIcon("trash");
        delBtn.title = "Delete this rule";

        // Second row: summary text on the left, all the icon actions grouped
        // at the far right — the headline row above stays clean (just name +
        // type), everything actionable lives in one place below it.
        const summary = document.createElement("div");
        summary.className = "rule-summary";
        const delayText = rule.action.type === "delay" ? ` ${rule.action.delayMs / 1000}s` : "";
        const repeatText = rule.repeat ? ` | repeat ${rule.repeatIntervalMs / 1000}s` : "";
        const hotkeyText = rule.triggerMode === "hotkey" ? ` | ⌨ ${rule.hotkey || "not set"}` : "";
        summary.textContent = `${rule.action.type}${delayText}${repeatText}${hotkeyText} | ${rule.pathMatch}: ${rule.pathname || "any path"}`;

        const actions = document.createElement("div");
        actions.className = "rule-actions";
        actions.append(collapseBtn, shareBtn, dupBtn, delBtn);

        const metaRow = document.createElement("div");
        metaRow.className = "rule-meta-row";
        metaRow.append(summary, actions);

        // Translate rules don't have a "click" action, a hotkey trigger, or
        // jitter/repeat timing — they're continuously reactive by nature, and
        // everything type-specific for them lives in getTypeSpecificFields().
        const isTranslate = rule.type === "translate";
        const requiredLabel = !isTranslate ? "Required selectors"
          : rule.mode === "autoDetect" ? "Elements to scan (blank = the whole page; selector may also match many)"
          : "Target element (translation is written here)";

        const body = document.createElement("div");
        body.className = collapsedRuleIds.has(id) ? "rule-body collapsed" : "rule-body";
        body.append(
          createPathRow(rule, rules),
          createMultiSelectorField(rule, "requiredElements", requiredLabel, rules, ".btn, [data-action]", "required"),
        );
        if (!isTranslate) {
          body.append(
            createMultiSelectorField(rule, "forbiddenElements", "Forbidden selectors", rules, ".error, button[disabled]", "forbidden"),
            createField(rule, "actionType", "Action", "select", rules, ["run", "stop", "delay"]),
          );
          if (rule.action.type === "delay") body.append(createField(rule, "actionDelaySeconds", "Delay sec", "input", rules));

          body.append(createField(rule, "triggerMode", "Trigger", "select", rules, [
            { value: "auto", label: "Automatic — as soon as it appears" },
            { value: "hotkey", label: "Keyboard shortcut" },
          ]));
          if (rule.triggerMode === "hotkey") {
            const hkWrap = document.createElement("div"); hkWrap.className = "rule-field full";
            const hkLbl = document.createElement("label"); hkLbl.textContent = "Hotkey — click box, press combo";
            const hk = buildHotkeyRecorder(rule.hotkey, (v) => {
              saveRules(rules.map((r) => String(r.id) === String(rule.id) ? { ...r, hotkey: v } : r), renderRules);
            });
            hkWrap.append(hkLbl, hk);
            body.append(hkWrap);
          }

          const jitterField = createField(rule, "jitterSeconds", "Jitter (sec)", "input", rules);
          jitterField.querySelector("input").title = "Random extra delay added before running, up to this many seconds — makes timing look human, not robotic.";
          body.append(jitterField);
          // Repeat/cooldown only means something for auto-triggered rules — a
          // hotkey press already IS the explicit re-trigger, every press fires.
          if (rule.triggerMode !== "hotkey") {
            body.append(createCheckboxField(rule, "repeat", "Repeat", rules, renderRules));
            if (rule.repeat) body.append(createField(rule, "repeatIntervalSeconds", "Repeat interval sec", "input", rules));
          }
        }

        const typeFields = getTypeSpecificFields(rule, rules);
        if (typeFields.length) {
          const divider = document.createElement("hr");
          divider.className = "field-divider";
          body.append(divider, ...typeFields);
        }

        // Drag to reorder — pointer-based, handle-only (form inputs inside
        // the card stay untouched). See startPointerDrag for why.
        card.dataset.dragId = id;
        dragHandle.addEventListener("pointerdown", (e) => {
          const listEl = card.closest(".ac-list");
          if (listEl) startPointerDrag(e, dragHandle, card, id, listEl, ".rule-card", (srcId, targetId) => reorderRules(srcId, targetId));
        });

        card.append(head, metaRow, body);
        return card;
      };

      // Render each category into its own list, grouped by match URL.
      CATS.forEach((cfg) => {
        const listEl = document.getElementById(cfg.list);
        if (!listEl) return;
        listEl.textContent = "";
        const catRules = rules.filter((r) => categoryOf(r) === cfg.cat);
        const search = (res[cfg.searchKey] || "").trim().toLowerCase();
        const displayed = search ? catRules.filter((r) => matchesSearch(r, search)) : catRules;
        if (!displayed.length) {
          wireExpandToggle(cfg.expandToggle, [], collapsedGroups, renderRules, "groups");
          const e = document.createElement("div"); e.className = "logs-empty";
          e.textContent = catRules.length ? "No rules match your search." : cfg.empty;
          listEl.appendChild(e); return;
        }
        const groups = new Map();
        displayed.forEach((rule) => { const key = (rule.pathname || "").trim() || "__any__"; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(rule); });
        wireExpandToggle(cfg.expandToggle, [...groups.keys()].map((k) => cfg.cat + "|" + k), collapsedGroups, renderRules, "groups");

        groups.forEach((grpRules, key) => {
          const gkey = cfg.cat + "|" + key;
          const label = key === "__any__" ? "Any page" : key;
          const gh = document.createElement("div"); gh.className = "rule-group-head";
          const gcol = collapsedGroups.has(gkey);
          const caret = document.createElement("span"); caret.className = "rule-group-caret"; caret.textContent = gcol ? "▸" : "▾";
          const gt = document.createElement("span"); gt.className = "rule-group-title"; gt.textContent = label;
          const gc = document.createElement("span"); gc.className = "rule-group-count"; gc.textContent = grpRules.length;
          const gShare = iconMini("share", `Share all ${grpRules.length} rule(s) in "${label}" as a link`, (e) => {
            e.stopPropagation();
            shareRuleArray(grpRules, null);
          });
          const gDel = iconMini("trash", `Delete all ${grpRules.length} rule(s) in "${label}"`, (e) => {
            e.stopPropagation();
            if (!confirm(`Delete all ${grpRules.length} rule(s) under "${label}"? This can be undone with Ctrl+Z.`)) return;
            const ids = new Set(grpRules.map((r) => String(r.id)));
            saveRules(rules.filter((r) => !ids.has(String(r.id))), renderRules);
          }, true);
          gh.append(caret, gt, gc, gShare, gDel);
          gh.addEventListener("click", () => { collapsedGroups.has(gkey) ? collapsedGroups.delete(gkey) : collapsedGroups.add(gkey); renderRules(); });
          listEl.appendChild(gh);
          if (gcol) return;
          grpRules.forEach((rule) => listEl.appendChild(buildRuleCard(rule)));
        });
        listEl.querySelectorAll(".enable-toggle").forEach((cb) => {
          cb.onchange = (e) => {
            const rid = e.target.dataset.id;
            skipNextToggleRender();
            saveRules(rules.map((r) => String(r.id) === rid ? { ...r, enabled: e.target.checked } : r));
          };
        });
        listEl.querySelectorAll(".collapse-rule").forEach((btn) => {
          btn.onclick = (e) => { const rid = e.currentTarget.dataset.id; collapsedRuleIds.has(rid) ? collapsedRuleIds.delete(rid) : collapsedRuleIds.add(rid); renderRules(); };
        });
        listEl.querySelectorAll(".rule-share-btn").forEach((btn) => {
          btn.onclick = (e) => {
            const rid = e.currentTarget.dataset.id;
            const rule = rules.find((r) => String(r.id) === rid);
            if (rule) shareRuleArray([rule], btn);
          };
        });
        listEl.querySelectorAll(".dup-btn").forEach((btn) => {
          btn.onclick = (e) => {
            const rid = e.currentTarget.dataset.id;
            const idx = rules.findIndex((r) => String(r.id) === rid);
            if (idx < 0) return;
            const copy = { ...rules[idx], id: Date.now() + Math.random(), name: (rules[idx].name || "Unnamed") + " (copy)" };
            const next = [...rules]; next.splice(idx + 1, 0, copy);
            const newId = String(copy.id);
            knownRuleIds.add(newId); collapsedRuleIds.delete(newId); // land expanded so the copy is easy to spot
            saveRules(next, renderRules);
          };
        });
        listEl.querySelectorAll(".del-btn").forEach((btn) => {
          btn.onclick = (e) => { const rid = e.currentTarget.dataset.id; collapsedRuleIds.delete(rid); knownRuleIds.delete(rid); saveRules(rules.filter((r) => String(r.id) !== rid), renderRules); };
        });
      });
      persistRuleCollapse(); // covers explicit Hide/Show toggles AND newly-discovered rules defaulting to collapsed
    });
  }

  // One-shot "pick text on the page and translate it in place" — not a
  // saved rule, just an immediate fix using whatever Settings > Extension
  // language resolves to (see quickTranslateElement in modules/auto-clicker.js).
  const quickTranslateBtn = document.getElementById("tr-quick-translate");
  if (quickTranslateBtn) quickTranslateBtn.onclick = () => startPicker({ forQuickTranslate: true });

  // ── Picker ──────────────────────────────────────────────────────────────
  function startPicker(payload = {}) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0] || !tabs[0].id) return;
      chrome.tabs.sendMessage(tabs[0].id, { action: "START_PICKER", ...payload }, () => {
        if (chrome.runtime.lastError) alert("Open a Masar page and refresh it before using the picker.");
        else window.close();
      });
    });
  }

  // ── Shared Pick / Highlight buttons ───────────────────────────────────────
  // ONE visual language + behavior for every selector field in the extension
  // (Required/Forbidden selectors, workflow step Selector, workflow Trigger
  // element, "While selector visible", URL Shifter's Element selector) —
  // reuse these two instead of hand-rolling another slightly different pair.
  // `getSelector` is a function returning the CURRENT value to highlight
  // (usually `() => input.value`, so an unsaved edit still highlights right).
  function pickSelectorBtn(payload) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "us-use-btn";
    b.textContent = "Pick";
    b.title = "Click, then click the element on the page";
    b.addEventListener("click", () => startPicker(payload));
    return b;
  }
  function highlightSelectorBtn(getSelector) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "us-use-btn";
    b.textContent = "◎";
    b.title = "Highlight this element on the page";
    b.addEventListener("click", () => {
      const s = (getSelector() || "").trim();
      if (s) sendToPage({ action: "HIGHLIGHT_ELEMENT", selector: s });
      else alert("Set a selector first.");
    });
    return b;
  }

  // Shared hotkey-combo recorder — click the box, press the actual combo
  // (e.g. Alt+1). Must include Ctrl/Alt/Meta (Shift alone would clash with
  // normal typing). Backspace/Delete clears; Esc leaves the field. Used by
  // both workflow hotkeys and per-rule hotkeys — same widget, same behavior.
  function buildHotkeyRecorder(currentValue, onSet) {
    const hk = document.createElement("input");
    hk.type = "text";
    hk.readOnly = true;
    hk.value = currentValue || "";
    hk.placeholder = "Click, then press keys… (e.g. Alt+1)";
    hk.title = "Press the combo you want (must include Ctrl, Alt or Cmd). Backspace clears.";
    hk.addEventListener("focus", () => { if (!hk.value) hk.placeholder = "Press keys now… (Ctrl/Alt + key)"; });
    hk.addEventListener("blur", () => { hk.placeholder = "Click, then press keys… (e.g. Alt+1)"; });
    hk.addEventListener("keydown", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { hk.blur(); return; }
      if (e.key === "Backspace" || e.key === "Delete") { onSet(""); return; }
      if (["Alt", "Control", "Shift", "Meta"].includes(e.key)) return;   // wait for the real key
      if (!e.ctrlKey && !e.altKey && !e.metaKey) { hk.value = "add Ctrl or Alt…"; return; }
      const parts = [];
      if (e.ctrlKey)  parts.push("Ctrl");
      if (e.altKey)   parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      if (e.metaKey)  parts.push("Meta");
      parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
      onSet(parts.join("+"));
    });
    return hk;
  }

  // ── Per-category toolbars (Add picks only that type; export/import filter) ──
  CATS.forEach((cfg) => {
    const addBtn = document.getElementById(cfg.add);
    if (addBtn) addBtn.onclick = () => startPicker({ mode: "required", forceType: cfg.forceType });

    // Share this category's rules — short server link, long link as fallback.
    // NOTE: never touch .textContent/.innerHTML on this button for a "loading"
    // state — it's icon-only now, and overwriting its content would wipe the
    // SVG out permanently (same bug that turned the module-off info button
    // into a stray "i"). Use the disabled state (dimmed via CSS) instead.
    const shareBtn = document.getElementById(cfg.share);
    if (shareBtn) shareBtn.onclick = () => {
      chrome.storage.local.get([RULES_KEY], (res) => {
        const rules = (res[RULES_KEY] || []).filter((r) => categoryOf(normalizeRule(r)) === cfg.cat);
        shareRuleArray(rules, shareBtn);
      });
    };

    // Bulk "delete all" for just this category — other categories' rules
    // (they share the same RULES_KEY array) are left untouched.
    const delAllBtn = document.getElementById(cfg.delAll);
    if (delAllBtn) delAllBtn.onclick = () => {
      chrome.storage.local.get([RULES_KEY], (res) => {
        const all = res[RULES_KEY] || [];
        const count = all.filter((r) => categoryOf(normalizeRule(r)) === cfg.cat).length;
        if (!count) { alert("No rules to delete."); return; }
        if (!confirm(`Delete all ${count} rule(s) in this tab? This can be undone with Ctrl+Z.`)) return;
        saveRules(all.filter((r) => categoryOf(normalizeRule(r)) !== cfg.cat), renderRules);
      });
    };

    // Import rules from a pasted link — short server link, long link, or bare code.
    const impLinkBtn = document.getElementById(cfg.impLink);
    if (impLinkBtn) impLinkBtn.onclick = async () => {
      const text = window.prompt("Paste a Nuskomate rules link:");
      if (text == null || !text.trim()) return;
      let imported = null;
      const code = shareCodeFrom(text);
      if (code && window.NkLicense && window.NkLicense.fetchSharedRules) {
        const r = await window.NkLicense.fetchSharedRules(code);
        if (r && r.ok && Array.isArray(r.rules)) imported = r.rules;
        else if (!/[#?&]r=/.test(text)) { alert("Import failed: " + ((r && r.error) || "server unreachable")); return; }
      }
      if (!imported) {
        try { imported = decodeRulesLink(text); } catch (err) { alert("Import failed: " + err.message); return; }
      }
      if (!imported.length) { alert("That link has no rules."); return; }
      chrome.storage.local.get([RULES_KEY], (res) => {
        const merged = [...(res[RULES_KEY] || []), ...imported];
        saveRules(merged, () => { alert(`Imported ${imported.length} rule(s) from link.`); renderRules(); });
      });
    };

    const expBtn = document.getElementById(cfg.exp);
    if (expBtn) expBtn.onclick = () => {
      chrome.storage.local.get([RULES_KEY], (res) => {
        const rules = (res[RULES_KEY] || []).filter((r) => categoryOf(normalizeRule(r)) === cfg.cat);
        if (!rules.length) { alert("No rules to export."); return; }
        const blob = new Blob([JSON.stringify(rules, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a"); a.href = url; a.download = `${cfg.file}-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
      });
    };

    const impBtn = document.getElementById(cfg.imp);
    const impFile = document.getElementById(cfg.impFile);
    if (impBtn && impFile) impBtn.onclick = () => impFile.click();
    if (impFile) impFile.addEventListener("change", (e) => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const imported = JSON.parse(ev.target.result);
          if (!Array.isArray(imported)) throw new Error("Expected an array of rules.");
          chrome.storage.local.get([RULES_KEY], (res) => {
            const merged = [...(res[RULES_KEY] || []), ...imported];
            saveRules(merged, () => { alert(`Imported ${imported.length} rule(s).`); renderRules(); });
          });
        } catch (err) { alert(`Import failed: ${err.message}`); }
      };
      reader.readAsText(file); impFile.value = "";
    });
  });

  // ══ Workflows ═════════════════════════════════════════════════════════════
  const WF_KEY = "autoWorkflows";
  const STATUS_KEY = "acRunStatus";
  const WF_SEARCH_KEY = "acSearch_workflow";
  const wfListEl = document.getElementById("wf-list");
  const wfSearchEl = document.getElementById("wf-search");
  const wfKnown = new Set();
  const wfSettingsOpen = new Set(); // workflow ids whose settings panel is expanded
  const wfCollapsed = new Set();    // collapsed (hidden body) workflow ids
  let liveStatus = {};
  let openInserterKey = null; // "<wfId>|<afterId or START>" of the one open "+ insert" menu
  // Kept fresh by renderWorkflows() on every render — lets a "Call" step's
  // field editor populate its target dropdown synchronously instead of
  // firing its own storage read every keystroke/open.
  const wfPickerCache = { workflows: [], rules: [] };

  // Same reasoning as persistRuleCollapse: a popup is rebuilt from scratch
  // every time it's opened, so Hide/Show and the ⚙ settings panel would
  // otherwise forget themselves the moment you close the popup.
  function persistWfCollapse() {
    chrome.storage.local.set({ acWfCollapsed: [...wfCollapsed], acWfSettingsOpen: [...wfSettingsOpen] });
  }

  const STEP_LABEL = {
    button: "CLICK", click: "CLICK", input: "FILL", dropdown: "SELECT",
    checkbox: "CHECK", radio: "RADIO", waitFor: "WAIT+", waitGone: "WAIT-", wait: "DELAY", delay: "DELAY",
    capture: "GET", if: "IF", else: "ELSE", endif: "END IF", loopStart: "LOOP", loopEnd: "END LOOP",
    waitCondition: "WAIT?", callWorkflow: "CALL",
  };
  const MARKER_TYPES = new Set(["else", "endif", "loopEnd"]);       // no fields, minimal row
  const NO_HIGHLIGHT = new Set(["wait", "delay", "else", "endif", "loopEnd", "loopStart", "callWorkflow"]);
  // Block openers/closers aren't safe to duplicate on their own (they're
  // paired — duplicating just one half would misalign the loop/if structure).
  // Duplicate is offered only for self-contained action/wait/capture steps.
  const BLOCK_TYPES = new Set(["if", "else", "endif", "loopStart", "loopEnd"]);

  function saveWorkflows(wfs, cb) { pushUndo(() => chrome.storage.local.set({ [WF_KEY]: wfs }, cb)); }
  function withWorkflows(fn) { chrome.storage.local.get([WF_KEY], (res) => fn(res[WF_KEY] || [])); }

  function sendToPage(payload, cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0] || !tabs[0].id) { if (cb) cb(false); return; }
      chrome.tabs.sendMessage(tabs[0].id, payload, () => {
        if (chrome.runtime.lastError) { alert("Open a Masar page and refresh it before running / highlighting."); if (cb) cb(false); }
        else if (cb) cb(true);
      });
    });
  }

  // Stop is special: if a workflow step (or the page itself) navigated since
  // the run started, the content script that was tracking it is GONE — a new
  // one loaded on the new page with fresh, idle state. It has nothing to
  // stop, so a plain STOP_WORKFLOW message either reaches nobody or reaches
  // a script that was never running anything, and the stored "running" /
  // "paused" status is left frozen forever with a Stop button that visibly
  // does nothing. So Stop always ALSO clears the stored status directly from
  // here — best-effort message to the live page (silently, no alert; it's a
  // stop, not something the user needs to be told to open a page for) plus a
  // guaranteed local reset so the UI never gets stuck.
  function forceStopWorkflow(wf) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].id) {
        try { chrome.tabs.sendMessage(tabs[0].id, { action: "STOP_WORKFLOW" }, () => void chrome.runtime.lastError); } catch (_) {}
      }
    });
    chrome.storage.local.get([STATUS_KEY], (res) => {
      const cur = res[STATUS_KEY] || {};
      // Only force-clear if THIS workflow is the one the stale status points
      // at — never stomp on a status belonging to a different, still-live run.
      if (String(cur.id) !== String(wf.id)) return;
      chrome.storage.local.set({
        [STATUS_KEY]: { ...cur, running: false, paused: false, done: true, stopped: true, lastError: "", at: Date.now() },
      });
    });
  }

  const uid = () => Date.now() + Math.floor(Math.random() * 1000);

  function patchWorkflow(wfId, patch) {
    withWorkflows((wfs) => saveWorkflows(wfs.map((w) => String(w.id) === String(wfId) ? { ...w, ...patch } : w), renderWorkflows));
  }
  // Same write as patchWorkflow, but WITHOUT the immediate renderWorkflows()
  // callback — used only by the enable/disable slider, whose native checked
  // state is already visually correct the instant you click it. Rebuilding
  // the card right away (either via this callback or the onChanged listener
  // it also triggers) would replace that DOM node mid-transition, which is
  // why the slide looked instant instead of smooth. skipNextToggleRender()
  // suppresses the onChanged-driven rebuild too.
  function patchWorkflowEnabled(wfId, enabled) {
    skipNextToggleRender();
    withWorkflows((wfs) => saveWorkflows(wfs.map((w) => String(w.id) === String(wfId) ? { ...w, enabled } : w)));
  }
  function patchStep(wfId, stepId, patch) {
    withWorkflows((wfs) => saveWorkflows(wfs.map((w) => String(w.id) !== String(wfId) ? w
      : { ...w, steps: (w.steps || []).map((s) => String(s.id) === String(stepId) ? { ...s, ...patch } : s) }), renderWorkflows));
  }
  function removeStep(wfId, stepId) {
    withWorkflows((wfs) => saveWorkflows(wfs.map((w) => String(w.id) !== String(wfId) ? w
      : { ...w, steps: (w.steps || []).filter((s) => String(s.id) !== String(stepId)) }), renderWorkflows));
  }
  function duplicateStep(wfId, stepId) {
    withWorkflows((wfs) => saveWorkflows(wfs.map((w) => {
      if (String(w.id) !== String(wfId)) return w;
      const steps = [...(w.steps || [])];
      const idx = steps.findIndex((s) => String(s.id) === String(stepId));
      if (idx < 0) return w;
      const copy = { ...steps[idx], id: uid(), name: (steps[idx].name || steps[idx].type) + " (copy)" };
      steps.splice(idx + 1, 0, copy);
      return { ...w, steps };
    }), renderWorkflows));
  }
  function moveStep(wfId, stepId, dir) {
    withWorkflows((wfs) => saveWorkflows(wfs.map((w) => {
      if (String(w.id) !== String(wfId)) return w;
      const steps = [...(w.steps || [])];
      const i = steps.findIndex((s) => String(s.id) === String(stepId));
      const j = i + dir;
      if (i < 0 || j < 0 || j >= steps.length) return w;
      [steps[i], steps[j]] = [steps[j], steps[i]];
      return { ...w, steps };
    }), renderWorkflows));
  }
  function addWaitStep(wfId, type, afterId) {
    let step;
    if (type === "wait") step = { id: uid(), type: "wait", name: "Delay", waitMs: 1000 };
    else if (type === "waitCondition") step = { id: uid(), type, name: "Wait until…", requiredElements: [""], selector: "", condition: "disabled", value: "", timeoutMs: 15000 };
    else step = { id: uid(), type, name: type === "waitFor" ? "Wait for element" : "Wait until gone", requiredElements: [""], selector: "", timeoutMs: 15000 };
    addStepAt(wfId, step, afterId);
  }
  function deleteWorkflow(wfId) {
    if (!confirm("Delete this workflow?")) return;
    withWorkflows((wfs) => saveWorkflows(wfs.filter((w) => String(w.id) !== String(wfId)), renderWorkflows));
  }
  function duplicateWorkflow(wfId) {
    withWorkflows((wfs) => {
      const idx = wfs.findIndex((w) => String(w.id) === String(wfId));
      if (idx < 0) return;
      const src = wfs[idx];
      const copy = {
        ...src,
        id: uid(),
        name: (src.name || "Workflow") + " (copy)",
        steps: (src.steps || []).map((s) => ({ ...s, id: uid() })), // fresh step ids
        hotkey: "", // cleared — two workflows sharing one hotkey would silently collide
      };
      const next = [...wfs]; next.splice(idx + 1, 0, copy);
      saveWorkflows(next, renderWorkflows);
    });
  }
  function addWorkflow() {
    withWorkflows((wfs) => { const wf = { id: uid(), name: `Workflow ${wfs.length + 1}`, enabled: true, steps: [] }; saveWorkflows([...wfs, wf], renderWorkflows); });
  }
  function reorderWorkflows(srcId, targetId) {
    withWorkflows((wfs) => {
      const from = wfs.findIndex((w) => String(w.id) === String(srcId));
      const to = wfs.findIndex((w) => String(w.id) === String(targetId));
      if (from < 0 || to < 0 || from === to) return;
      const next = [...wfs];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      saveWorkflows(next, renderWorkflows);
    });
  }
  // Insert one/many steps right after the step whose id === afterId, or at
  // the end when afterId is null/undefined — every "+ add" control (bottom
  // toolbar AND the per-step inserters) goes through these two.
  function spliceIn(steps, afterId, items) {
    const idx = afterId != null ? steps.findIndex((s) => String(s.id) === String(afterId)) : -1;
    const next = [...steps];
    if (idx >= 0) next.splice(idx + 1, 0, ...items); else next.push(...items);
    return next;
  }
  function addStepAt(wfId, step, afterId) {
    withWorkflows((wfs) => saveWorkflows(wfs.map((w) => String(w.id) === String(wfId) ? { ...w, steps: spliceIn(w.steps || [], afterId, [step]) } : w), renderWorkflows));
  }
  function addStepsAt(wfId, arr, afterId) {
    withWorkflows((wfs) => saveWorkflows(wfs.map((w) => String(w.id) === String(wfId) ? { ...w, steps: spliceIn(w.steps || [], afterId, arr) } : w), renderWorkflows));
  }
  function addStep(wfId, step) { addStepAt(wfId, step, null); }
  function addSteps(wfId, arr) { addStepsAt(wfId, arr, null); }
  function addCapture(wfId, afterId) { addStepAt(wfId, { id: uid(), type: "capture", name: "Capture", requiredElements: [""], selector: "", varName: "myVar", captureSource: "text", timeoutMs: 8000 }, afterId); }
  function addIf(wfId, afterId)   { addStepsAt(wfId, [{ id: uid(), type: "if", name: "If", requiredElements: [""], selector: "", condition: "visible", value: "" }, { id: uid(), type: "endif", name: "End if" }], afterId); }
  function addElse(wfId, afterId) { addStepAt(wfId, { id: uid(), type: "else", name: "Else" }, afterId); }
  function addLoop(wfId, afterId) { addStepsAt(wfId, [{ id: uid(), type: "loopStart", name: "Loop", loopMode: "count", count: 2, requiredElements: [""], selector: "" }, { id: uid(), type: "loopEnd", name: "End loop" }], afterId); }
  function addCallStep(wfId, afterId) { addStepAt(wfId, { id: uid(), type: "callWorkflow", name: "Call…", targetKind: "workflow", targetId: "", targetName: "", optional: false }, afterId); }

  // Drag-and-drop reorder of steps WITHIN a workflow.
  function reorderSteps(wfId, sourceStepId, targetStepId) {
    withWorkflows((wfs) => saveWorkflows(wfs.map((w) => {
      if (String(w.id) !== String(wfId)) return w;
      const steps = [...(w.steps || [])];
      const from = steps.findIndex((s) => String(s.id) === String(sourceStepId));
      const to = steps.findIndex((s) => String(s.id) === String(targetStepId));
      if (from < 0 || to < 0 || from === to) return w;
      const [moved] = steps.splice(from, 1);
      steps.splice(to, 0, moved);
      return { ...w, steps };
    }), renderWorkflows));
  }

  function patchRepeat(wfId, patch) {
    withWorkflows((wfs) => saveWorkflows(wfs.map((w) => String(w.id) === String(wfId) ? { ...w, repeat: { ...(w.repeat || { mode: "off" }), ...patch } } : w), renderWorkflows));
  }

  // Minimal CSV parser (handles quoted fields). First row = column names.
  function parseCSV(text) {
    const lines = String(text).replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim() !== "");
    if (!lines.length) return { columns: [], rows: [] };
    const parseLine = (l) => {
      const out = []; let cur = "", q = false;
      for (let i = 0; i < l.length; i++) {
        const c = l[i];
        if (q) { if (c === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
        else if (c === '"') q = true;
        else if (c === ",") { out.push(cur); cur = ""; }
        else cur += c;
      }
      out.push(cur); return out.map((s) => s.trim());
    };
    return { columns: parseLine(lines[0]), rows: lines.slice(1).map(parseLine) };
  }

  // Indent depth per step (for loop / if block nesting).
  function computeDepths(steps) {
    const depths = []; let d = 0;
    for (const s of steps) {
      const t = s.type;
      if (t === "loopEnd" || t === "endif") d = Math.max(0, d - 1);
      if (t === "else") { depths.push(Math.max(0, d - 1)); continue; }
      depths.push(d);
      if (t === "loopStart" || t === "if") d++;
    }
    return depths;
  }

  function stepSummary(step) {
    const sel = (step.requiredElements && step.requiredElements[0]) || step.selector || "—";
    switch (step.type) {
      case "wait": case "delay": return `delay ${Number(step.waitMs) || 0} ms`;
      case "waitFor":  return `wait for ${sel}`;
      case "waitGone": return `wait until gone ${sel}`;
      case "waitCondition": return `wait until ${step.condition || "visible"} ${sel}${(step.condition === "textIncludes" || step.condition === "textEquals") && step.value ? ` "${step.value}"` : ""}`;
      case "callWorkflow": return `call ${step.targetKind === "rule" ? "rule" : "workflow"} "${step.targetName || step.targetId || "not set"}"`;
      case "input":    return `fill "${step.fillValue || ""}"`;
      case "dropdown": return `select "${step.selectValue || ""}"`;
      case "checkbox": case "radio": return `${step.targetState || "checked"}`;
      case "capture":  return `${step.varName || "var"} = ${step.captureSource || "text"} of ${sel}`;
      case "if":       return `if ${sel} ${step.condition || "visible"}${step.value ? ` "${step.value}"` : ""}`;
      case "else":     return "else";
      case "endif":    return "end if";
      case "loopStart":return step.loopMode === "while" ? `loop while ${sel} visible` : `loop ${step.count || 1}×`;
      case "loopEnd":  return "end loop";
      default:         return `click`;
    }
  }

  function fieldRow(labelText, control) {
    const w = document.createElement("div"); w.className = "rule-field full";
    const l = document.createElement("label"); l.textContent = labelText;
    w.append(l, control); return w;
  }
  function txt(value, ph, onchange) {
    const i = document.createElement("input"); i.type = "text"; i.value = value || ""; if (ph) i.placeholder = ph;
    i.addEventListener("change", (e) => onchange(e.target.value.trim())); return i;
  }
  function num(value, onchange) {
    const i = document.createElement("input"); i.type = "number"; i.min = "0"; i.step = "50"; i.value = value == null ? "" : value;
    i.addEventListener("change", (e) => onchange(Number(e.target.value) || 0)); return i;
  }
  function sel(value, opts, onchange) {
    const s = document.createElement("select");
    opts.forEach((o) => {
      const op = document.createElement("option");
      op.value = typeof o === "object" ? o.value : o;
      op.textContent = typeof o === "object" ? o.label : o;
      s.appendChild(op);
    });
    s.value = value; s.addEventListener("change", (e) => onchange(e.target.value)); return s;
  }

  // Selector field + a "Pick" button that re-opens the on-page inspector for
  // THIS step (updates its selector in place — unlike the inserter's own
  // "+ Pick element", which adds a brand new step).
  function selectorFieldRow(labelText, selVal, wf, step) {
    const w = document.createElement("div"); w.className = "rule-field full";
    const l = document.createElement("label"); l.textContent = labelText;
    const row = document.createElement("div"); row.className = "us-url-row";
    const input = txt(selVal, "CSS / xpath= / text=  (a || b = fallback)", (v) => patchStep(wf.id, step.id, { requiredElements: [v], selector: v }));
    row.append(
      input,
      pickSelectorBtn({ forWorkflowStep: true, workflowId: wf.id, stepId: step.id }),
      highlightSelectorBtn(() => input.value),
    );
    w.append(l, row);
    return w;
  }

  const CONDITION_OPTIONS = ["visible", "hidden", "disabled", "enabled", "textIncludes", "textEquals"];

  function stepFields(wf, step) {
    const P = (patch) => patchStep(wf.id, step.id, patch);
    const selVal = (step.requiredElements && step.requiredElements[0]) || step.selector || "";
    const isDelay = step.type === "wait" || step.type === "delay";
    const isWait = step.type === "waitFor" || step.type === "waitGone" || step.type === "waitCondition";
    const isText = (step.type === "if" || step.type === "waitCondition") && (step.condition === "textIncludes" || step.condition === "textEquals");
    const fields = [];

    // ── loop marker ──
    if (step.type === "loopStart") {
      fields.push(fieldRow("Repeat", sel(step.loopMode || "count", ["count", "while"], (v) => P({ loopMode: v }))));
      if ((step.loopMode || "count") === "while") fields.push(selectorFieldRow("While selector visible", selVal, wf, step));
      else fields.push(fieldRow("Times", num(step.count == null ? 2 : step.count, (v) => P({ count: v }))));
      return fields;
    }
    // ── conditional ──
    if (step.type === "if") {
      fields.push(selectorFieldRow("Selector", selVal, wf, step));
      fields.push(fieldRow("Condition", sel(step.condition || "visible", CONDITION_OPTIONS, (v) => P({ condition: v }))));
      if (isText) fields.push(fieldRow("Text", txt(step.value, "", (v) => P({ value: v }))));
      return fields;
    }
    // ── capture into a variable ──
    if (step.type === "capture") {
      fields.push(selectorFieldRow("Selector", selVal, wf, step));
      fields.push(fieldRow("Variable name", txt(step.varName, "e.g. name", (v) => P({ varName: v }))));
      fields.push(fieldRow("Read", sel(step.captureSource || "text", ["text", "value"], (v) => P({ captureSource: v }))));
      return fields;
    }
    // ── call another workflow or rule as a subroutine (VBA-style "Call") ──
    if (step.type === "callWorkflow") {
      const kind = step.targetKind === "rule" ? "rule" : "workflow";
      fields.push(fieldRow("Call", sel(kind, [
        { value: "workflow", label: "Workflow" },
        { value: "rule", label: "Rule (click / fill / select)" },
      ], (v) => P({ targetKind: v, targetId: "", targetName: "" }))));
      const options = kind === "rule"
        ? wfPickerCache.rules.map((r) => ({ value: String(r.id), label: r.name || r.text || String(r.id) }))
        : wfPickerCache.workflows.filter((w) => String(w.id) !== String(wf.id)).map((w) => ({ value: String(w.id), label: w.name || String(w.id) }));
      const targetSel = sel(step.targetId || "", [{ value: "", label: "— choose —" }, ...options], (v) => {
        const picked = options.find((o) => o.value === v);
        P({ targetId: v, targetName: picked ? picked.label : "" });
      });
      fields.push(fieldRow(kind === "rule" ? "Rule to run" : "Workflow to run", targetSel));
      const hint = document.createElement("div"); hint.className = "wf-data-hint";
      hint.textContent = kind === "rule"
        ? "Runs that rule's action once, right now, and waits for it before continuing."
        : "Runs that workflow's steps (and its own repeat mode) once, right here, and waits for it to finish before continuing — like calling a subroutine.";
      fields.push(hint);
      const optWrap = document.createElement("div"); optWrap.className = "check-row";
      const opt = document.createElement("input"); opt.type = "checkbox"; opt.checked = !!step.optional;
      opt.addEventListener("change", (e) => P({ optional: e.target.checked }));
      const optl = document.createElement("label"); optl.textContent = "Optional (skip if it fails)";
      optWrap.append(opt, optl); fields.push(optWrap);
      return fields;
    }

    // ── action / wait steps ──
    if (!isDelay) fields.push(selectorFieldRow("Selector", selVal, wf, step));
    if (step.type === "input") {
      fields.push(fieldRow("Fill value", txt(step.fillValue, "text or {{column}}", (v) => P({ fillValue: v }))));
      fields.push(fieldRow("Prefix", txt(step.prefix, "text or {{column}} (optional)", (v) => P({ prefix: v }))));
      fields.push(fieldRow("Suffix", txt(step.suffix, "text or {{column}} (optional)", (v) => P({ suffix: v }))));
    }
    if (step.type === "dropdown") {
      fields.push(fieldRow("Select value", txt(step.selectValue, "text or {{column}}", (v) => P({ selectValue: v }))));
      fields.push(fieldRow("Match by", sel(step.selectMatchBy || "value", ["value", "text"], (v) => P({ selectMatchBy: v }))));
    }
    if (step.type === "checkbox" || step.type === "radio") fields.push(fieldRow("Target state", sel(step.targetState || "checked", ["checked", "unchecked", "toggle"], (v) => P({ targetState: v }))));
    if (step.type === "waitCondition") {
      fields.push(fieldRow("Condition", sel(step.condition || "visible", CONDITION_OPTIONS, (v) => P({ condition: v }))));
      if (isText) fields.push(fieldRow("Text", txt(step.value, "", (v) => P({ value: v }))));
    }
    if (isDelay) fields.push(fieldRow("Delay (ms)", num(step.waitMs, (v) => P({ waitMs: v }))));
    if (isWait || !isDelay) fields.push(fieldRow(isWait ? "Timeout (ms)" : "Element timeout (ms)", num(step.timeoutMs == null ? (isWait ? 15000 : 8000) : step.timeoutMs, (v) => P({ timeoutMs: v }))));

    const optWrap = document.createElement("div"); optWrap.className = "check-row";
    const opt = document.createElement("input"); opt.type = "checkbox"; opt.checked = !!step.optional;
    opt.addEventListener("change", (e) => P({ optional: e.target.checked }));
    const optl = document.createElement("label"); optl.textContent = "Optional (skip if it fails)";
    optWrap.append(opt, optl); fields.push(optWrap);
    return fields;
  }

  // The "add a step" actions, reused by both the per-step inserter and the
  // trailing (append-at-end) inserter. afterId = null means append at end.
  function buildInserterMenu(wf, afterId, onAdded) {
    const menu = document.createElement("div"); menu.className = "wf-inserter-menu";
    const wrap = (fn) => () => { fn(); onAdded(); };
    menu.append(
      mini("+ Pick element", wrap(() => startPicker({ forWorkflow: true, workflowId: wf.id, afterStepId: afterId }))),
      mini("+ Wait for", wrap(() => addWaitStep(wf.id, "waitFor", afterId))),
      mini("+ Wait gone", wrap(() => addWaitStep(wf.id, "waitGone", afterId))),
      mini("+ Wait until…", wrap(() => addWaitStep(wf.id, "waitCondition", afterId))),
      mini("+ Delay", wrap(() => addWaitStep(wf.id, "wait", afterId))),
      mini("+ Capture", wrap(() => addCapture(wf.id, afterId))),
      mini("+ If", wrap(() => addIf(wf.id, afterId))),
      mini("+ Else", wrap(() => addElse(wf.id, afterId))),
      mini("+ Loop", wrap(() => addLoop(wf.id, afterId))),
      mini("+ Call workflow/rule", wrap(() => addCallStep(wf.id, afterId))),
    );
    return menu;
  }

  // Thin "+" divider between steps (and before the first / after the last)
  // that a user clicks to insert a new step at exactly that point.
  function buildInserter(wf, afterId) {
    const key = wf.id + "|" + (afterId == null ? "START" : afterId);
    const wrap = document.createElement("div"); wrap.className = "wf-inserter";
    const line = document.createElement("div"); line.className = "wf-inserter-line";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "wf-inserter-btn";
    const isOpen = openInserterKey === key;
    btn.textContent = isOpen ? "×" : "+";
    btn.title = isOpen ? "Close" : "Insert a step here";
    btn.addEventListener("click", () => { openInserterKey = isOpen ? null : key; renderWorkflows(); });
    wrap.append(line, btn);
    if (isOpen) {
      wrap.appendChild(buildInserterMenu(wf, afterId, () => { openInserterKey = null; }));
    }
    return wrap;
  }

  function renderStepCard(wf, step, index, total, activeIndex, depth) {
    const isMarker = MARKER_TYPES.has(step.type);
    const id = String(step.id);
    const card = document.createElement("div");
    card.className = "wf-step" + (isMarker ? " wf-step-marker" : "") + (activeIndex === index ? " wf-step-active" : "");
    if (depth > 0) { card.style.marginLeft = Math.min(depth, 4) * 14 + "px"; card.classList.add("wf-step-nested"); }

    const head = document.createElement("div"); head.className = "wf-step-head";
    const dragHandle = document.createElement("span"); dragHandle.className = "drag-handle wf-step-drag"; dragHandle.textContent = "☰"; dragHandle.title = "Drag to reorder";
    const numTag = document.createElement("span"); numTag.className = "wf-step-num"; numTag.textContent = index + 1;
    const badge = document.createElement("span"); badge.className = `type-badge type-badge--${step.type}`; badge.textContent = STEP_LABEL[step.type] || "STEP";
    const up = iconMini("chevUp", "Move step up", () => moveStep(wf.id, step.id, -1));
    const down = iconMini("chevDown", "Move step down", () => moveStep(wf.id, step.id, +1));
    // Loop/If openers & closers are paired — duplicating just one half would
    // misalign the block, so the button is only offered on self-contained steps.
    const canDuplicate = !BLOCK_TYPES.has(step.type);
    const dup = canDuplicate ? iconMini("duplicate", "Duplicate this step", () => duplicateStep(wf.id, step.id)) : null;
    const del = iconMini("trash", "Delete this step", () => removeStep(wf.id, step.id), true);

    // Drag to reorder — pointer-based, handle-only (inputs inside the body
    // stay usable). Container resolved lazily at drag-start via .closest()
    // since stepsWrap isn't in scope here.
    card.dataset.dragId = id;
    dragHandle.addEventListener("pointerdown", (e) => {
      const stepsWrap = card.closest(".wf-steps");
      if (stepsWrap) startPointerDrag(e, dragHandle, card, id, stepsWrap, ".wf-step", (srcId, targetId) => reorderSteps(wf.id, srcId, targetId));
    });

    // Block markers (else / endif / end loop) are a single compact row.
    if (isMarker) {
      const lbl = document.createElement("span"); lbl.className = "wf-marker-label"; lbl.textContent = stepSummary(step);
      head.append(dragHandle, numTag, badge, lbl, up, down, del);
      card.append(head);
      return card;
    }

    const name = document.createElement("input"); name.className = "wf-step-name"; name.value = step.name || step.type;
    name.addEventListener("change", (e) => patchStep(wf.id, step.id, { name: e.target.value }));
    const hi = iconMini("target", "Flash this element on the page", () => { const s = (step.requiredElements && step.requiredElements[0]) || step.selector; if (s) sendToPage({ action: "HIGHLIGHT_ELEMENT", selector: s }); });
    hi.disabled = NO_HIGHLIGHT.has(step.type);
    const nameRow = document.createElement("div"); nameRow.className = "wf-step-name-row";
    nameRow.append(numTag, badge, name);
    const controlsRow = document.createElement("div"); controlsRow.className = "wf-step-controls-row";
    controlsRow.append(dragHandle, up, down, hi, ...(dup ? [dup] : []), del);
    head.append(nameRow, controlsRow);

    const summary = document.createElement("div"); summary.className = "wf-step-sum"; summary.textContent = stepSummary(step);
    const body = document.createElement("div"); body.className = "wf-step-body";
    stepFields(wf, step).forEach((f) => body.append(f));

    card.append(head, summary, body);
    return card;
  }

  // Per-workflow settings: hotkey, repeat mode, CSV data source.
  function buildSettings(wf) {
    const panel = document.createElement("div"); panel.className = "wf-settings";
    const repeat = wf.repeat || { mode: "off" };
    const data = wf.data || { columns: [], rows: [] };

    // Run mode: manual (Run button / hotkey) or auto (fires when an element
    // appears, like a reactive rule).
    panel.append(fieldRow("Run", sel(wf.trigger === "auto" ? "auto" : "manual", ["manual", "auto"], (v) => patchWorkflow(wf.id, { trigger: v }))));
    if (wf.trigger === "auto") {
      const trigWrap = document.createElement("div"); trigWrap.className = "rule-field full";
      const trigLbl = document.createElement("label"); trigLbl.textContent = "Trigger element (runs when it appears)";
      const trigRow = document.createElement("div"); trigRow.className = "us-url-row";
      const trig = txt(wf.triggerSelector, "CSS selector (blank = first step)", (v) => patchWorkflow(wf.id, { triggerSelector: v }));
      trigRow.append(
        trig,
        pickSelectorBtn({ forWorkflowTrigger: true, workflowId: wf.id }),
        highlightSelectorBtn(() => trig.value),
      );
      trigWrap.append(trigLbl, trigRow);
      panel.append(trigWrap);
      const th = document.createElement("div"); th.className = "wf-data-hint";
      th.textContent = "Auto-run fires once when the element appears; it re-arms after the element disappears. Leave the selector blank to use the first step's element.";
      panel.append(th);
    }
    const hk = buildHotkeyRecorder(wf.hotkey, (v) => patchWorkflow(wf.id, { hotkey: v }));
    panel.append(fieldRow("Hotkey — click box, press combo", hk));

    // Human-like: random reaction pause before actions + varied step gaps.
    const humWrap = document.createElement("div"); humWrap.className = "check-row";
    const hum = document.createElement("input"); hum.type = "checkbox"; hum.checked = !!wf.humanize;
    hum.addEventListener("change", (e) => patchWorkflow(wf.id, { humanize: e.target.checked }));
    const humLbl = document.createElement("label"); humLbl.textContent = "Human-like delays (randomized timing)";
    humWrap.append(hum, humLbl); panel.append(humWrap);

    panel.append(fieldRow("Repeat", sel(repeat.mode || "off", [
      { value: "off", label: "off" },
      { value: "count", label: "count" },
      { value: "whileVisible", label: "whileVisible" },
      { value: "perRow", label: "perRow" },
      { value: "forEachMatch", label: "For each match" },
    ], (v) => patchRepeat(wf.id, { mode: v }))));
    if (repeat.mode === "count") panel.append(fieldRow("Times", num(repeat.count == null ? 1 : repeat.count, (v) => patchRepeat(wf.id, { count: v }))));
    if (repeat.mode === "whileVisible") {
      const wvWrap = document.createElement("div"); wvWrap.className = "rule-field full";
      const wvLbl = document.createElement("label"); wvLbl.textContent = "While selector visible";
      const wvRow = document.createElement("div"); wvRow.className = "us-url-row";
      const wvInput = txt(repeat.whileSelector, "CSS / xpath= / text=  (a || b = fallback)", (v) => patchRepeat(wf.id, { whileSelector: v }));
      wvRow.append(
        wvInput,
        pickSelectorBtn({ forWorkflowRepeatWhile: true, workflowId: wf.id }),
        highlightSelectorBtn(() => wvInput.value),
      );
      wvWrap.append(wvLbl, wvRow);
      panel.append(wvWrap);
    }
    if (repeat.mode === "forEachMatch") {
      const fmWrap = document.createElement("div"); fmWrap.className = "rule-field full";
      const fmLbl = document.createElement("label"); fmLbl.textContent = "Match selector (every element matching this gets one pass)";
      const fmRow = document.createElement("div"); fmRow.className = "us-url-row";
      const fmInput = txt(repeat.matchSelector, "CSS / xpath= / text=  (a || b = fallback)", (v) => patchRepeat(wf.id, { matchSelector: v }));
      fmRow.append(
        fmInput,
        pickSelectorBtn({ forWorkflowMatchSelector: true, workflowId: wf.id }),
        highlightSelectorBtn(() => fmInput.value),
      );
      fmWrap.append(fmLbl, fmRow);
      panel.append(fmWrap);
      const fmHint = document.createElement("div"); fmHint.className = "wf-data-hint";
      fmHint.textContent = "Runs the steps once per matching element (e.g. every row's “Review” button), most-recent match list re-checked each time. Whichever step's own selector is set to this SAME selector automatically targets that iteration's specific match instead of always the first one — set your click step's selector to match this field exactly.";
      panel.append(fmHint);
    }

    // Data source (CSV) — feeds {{column}} variables; run "Per data row" to loop rows.
    const dataInfo = document.createElement("div"); dataInfo.className = "wf-data-info";
    dataInfo.textContent = data.rows && data.rows.length
      ? `${data.rows.length} row(s) · columns: ${(data.columns || []).join(", ") || "—"}`
      : "No data loaded";
    const dataRow = document.createElement("div"); dataRow.className = "wf-data-row";
    const impBtn = mini("Import CSV", () => csvInput.click());
    const clrBtn = mini("Clear", () => patchWorkflow(wf.id, { data: { columns: [], rows: [] } }), true);
    const csvInput = document.createElement("input"); csvInput.type = "file"; csvInput.accept = ".csv,.txt"; csvInput.style.display = "none";
    csvInput.addEventListener("change", (e) => {
      const f = e.target.files[0]; if (!f) return;
      const rd = new FileReader();
      rd.onload = (ev) => { const parsed = parseCSV(ev.target.result); patchWorkflow(wf.id, { data: parsed }); if (!(wf.repeat && wf.repeat.mode === "perRow")) patchRepeat(wf.id, { mode: "perRow" }); };
      rd.readAsText(f); csvInput.value = "";
    });
    dataRow.append(impBtn, clrBtn, csvInput);
    const dataLbl = document.createElement("label"); dataLbl.textContent = "Data source (CSV)"; dataLbl.className = "wf-data-lbl";
    panel.append(dataLbl, dataInfo, dataRow);
    const hint = document.createElement("div"); hint.className = "wf-data-hint";
    hint.textContent = "Use {{column}} in Fill/Select values. Set Repeat = Per data row to run once per row.";
    panel.append(hint);
    return panel;
  }

  function mini(label, fn, danger) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "wf-mini" + (danger ? " wf-mini-danger" : "");
    b.textContent = label;
    b.addEventListener("click", fn);
    return b;
  }

  // ── Icon buttons ────────────────────────────────────────────────────────
  // Same look/feel as mini() but with an SVG glyph instead of a text label,
  // plus a native title tooltip so the icon is never a guessing game.
  const ICON = {
    play:      '<polygon points="6 3 20 12 6 21 6 3" fill="currentColor" stroke="none"/>',
    stop:      '<rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" stroke="none"/>',
    pause:     '<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/>',
    record:    '<circle cx="12" cy="12" r="7" fill="currentColor" stroke="none"/>',
    duplicate: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    share:     '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>',
    gear:      '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    chevDown:  '<polyline points="6 9 12 15 18 9"/>',
    chevUp:    '<polyline points="18 15 12 9 6 15"/>',
    trash:     '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    target:    '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/>',
  };
  function svgIcon(name, size) {
    return `<svg width="${size || 13}" height="${size || 13}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">${ICON[name] || ""}</svg>`;
  }
  function iconMini(iconName, title, fn, danger) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "wf-mini wf-icon-btn" + (danger ? " wf-mini-danger" : "");
    b.innerHTML = svgIcon(iconName);
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("click", fn);
    return b;
  }

  // Compact on/off slider (same look as the Settings/Modules toggles) used
  // inline in card headers instead of a plain checkbox. `extraClass` lets a
  // caller keep the ".enable-toggle" class for event-delegation wiring
  // (rule cards, which rewire everything after every render); `onChange` lets
  // a caller wire the listener directly instead (workflow / URL Shifter
  // cards, which build listeners once per card). Returns both the wrapper
  // <label> (append this) and the inner <input> (set dataset/title on this).
  function toggleSwitch(checked, extraClass, onChange) {
    const label = document.createElement("label");
    label.className = "toggle-switch toggle-switch-sm";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!checked;
    if (extraClass) input.className = extraClass;
    if (onChange) input.addEventListener("change", (e) => onChange(e.target.checked));
    const slider = document.createElement("span");
    slider.className = "slider";
    label.append(input, slider);
    return { label, input };
  }

  function renderWorkflowCard(wf) {
    const running = liveStatus.running && String(liveStatus.id) === String(wf.id);
    const paused = running && liveStatus.paused;
    const activeIndex = running ? liveStatus.stepIndex : -1;

    const id = String(wf.id);
    const collapsed = wfCollapsed.has(id);
    const card = document.createElement("div"); card.className = "wf-card" + (running ? " wf-card-running" : "");

    const head = document.createElement("div"); head.className = "wf-head";
    const { label: toggleWrap } = toggleSwitch(wf.enabled !== false, null, (checked) => patchWorkflowEnabled(wf.id, checked));
    toggleWrap.title = "Turn this workflow on/off (blocks its hotkey, auto-trigger and Run button)";
    const dragHandle = document.createElement("span"); dragHandle.className = "drag-handle wf-drag"; dragHandle.textContent = "☰"; dragHandle.title = "Drag to reorder";
    // Collapsed: plain static text. Expanded: the same spot becomes an
    // editable input — was always an input regardless of collapse state,
    // which invited accidental edits/cursor placement on a card you were
    // just skimming past collapsed.
    let name;
    if (collapsed) {
      name = document.createElement("div"); name.className = "wf-name-static"; name.textContent = wf.name || "Workflow";
    } else {
      name = document.createElement("input"); name.className = "wf-name"; name.value = wf.name || "Workflow";
      name.addEventListener("change", (e) => patchWorkflow(wf.id, { name: e.target.value }));
    }

    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.className = "wf-run" + (running ? " wf-run-stop" : "");
    runBtn.innerHTML = svgIcon(running ? "stop" : "play", 13);
    runBtn.title = running ? "Stop this workflow" : "Run this workflow";
    runBtn.setAttribute("aria-label", runBtn.title);
    runBtn.onclick = () => running ? forceStopWorkflow(wf) : sendToPage({ action: "RUN_WORKFLOW", workflowId: wf.id });

    const pauseBtn = iconMini(paused ? "play" : "pause", paused ? "Resume" : "Pause", () => sendToPage({ action: paused ? "RESUME_WORKFLOW" : "PAUSE_WORKFLOW" }));
    pauseBtn.style.display = running ? "" : "none";

    const recBtn = iconMini("record", "Record on the page — your clicks, typing and dropdown picks become steps", () => {
      sendToPage({ action: "START_RECORD", workflowId: wf.id }, (ok) => { if (ok) window.close(); });
    });
    recBtn.classList.add("wf-rec");

    const gear = iconMini("gear", "Workflow settings (hotkey, repeat, data)", () => { wfSettingsOpen.has(id) ? wfSettingsOpen.delete(id) : wfSettingsOpen.add(id); renderWorkflows(); });
    const shareBtn = iconMini("share", "Share this workflow as a link", (e) => shareRuleArray([wf], e.currentTarget));
    const dupBtn = iconMini("duplicate", "Duplicate this workflow (its hotkey is not copied)", () => duplicateWorkflow(wf.id));
    const collapseBtn = iconMini(collapsed ? "chevDown" : "chevUp", collapsed ? "Show steps" : "Hide steps", () => { wfCollapsed.has(id) ? wfCollapsed.delete(id) : wfCollapsed.add(id); renderWorkflows(); });
    const del = iconMini("trash", "Delete this workflow", () => deleteWorkflow(wf.id), true);

    const nameRow = document.createElement("div"); nameRow.className = "wf-head-name-row";
    nameRow.append(name);
    const controlsRow = document.createElement("div"); controlsRow.className = "wf-head-controls-row";
    controlsRow.append(toggleWrap, dragHandle, runBtn, pauseBtn, recBtn, gear, shareBtn, dupBtn, collapseBtn, del);
    head.append(nameRow, controlsRow);

    // status line
    const status = document.createElement("div"); status.className = "wf-status";
    const isThis = String(liveStatus.id) === String(wf.id);
    if (running) {
      const iterTxt = liveStatus.iterTotal ? ` · run ${liveStatus.iter}/${liveStatus.iterTotal}` : (liveStatus.iter ? ` · run ${liveStatus.iter}` : "");
      status.textContent = `${paused ? "Paused" : "Running"} — step ${Math.min((liveStatus.stepIndex || 0) + 1, liveStatus.total)}/${liveStatus.total || (wf.steps || []).length}${iterTxt}`;
    }
    else if (isThis && liveStatus.lastError) { status.textContent = "✖ " + liveStatus.lastError; status.classList.add("wf-status-err"); }
    else if (isThis && liveStatus.done && !liveStatus.stopped) { status.textContent = "✔ finished"; status.classList.add("wf-status-ok"); }
    else if (isThis && liveStatus.stopped) status.textContent = "■ stopped";
    else {
      const rp = wf.repeat && wf.repeat.mode && wf.repeat.mode !== "off" ? ` · repeat: ${wf.repeat.mode}` : "";
      const hk = wf.hotkey ? ` · ${wf.hotkey}` : "";
      const au = wf.trigger === "auto" ? " · ⚡ auto-run" : "";
      status.textContent = `${(wf.steps || []).length} step(s)${rp}${hk}${au}`;
    }

    // settings panel (collapsible)
    const settings = wfSettingsOpen.has(String(wf.id)) ? buildSettings(wf) : null;

    // steps (indented by loop/if nesting), with a thin "+" inserter BEFORE
    // the first step and AFTER every step — click one to add a step exactly
    // there instead of always at the end.
    const stepsWrap = document.createElement("div"); stepsWrap.className = "wf-steps";
    const steps = wf.steps || [];
    if (!steps.length) {
      stepsWrap.appendChild(buildInserter(wf, null));
      const e = document.createElement("div"); e.className = "wf-empty"; e.textContent = "No steps yet — click + above to add one.";
      stepsWrap.appendChild(e);
    } else {
      const depths = computeDepths(steps);
      stepsWrap.appendChild(buildInserter(wf, null)); // insert before the first step
      steps.forEach((s, i) => {
        stepsWrap.appendChild(renderStepCard(wf, s, i, steps.length, activeIndex, depths[i]));
        stepsWrap.appendChild(buildInserter(wf, s.id)); // insert right after this step
      });
    }

    card.append(head, status);
    if (!collapsed) {
      if (settings) card.append(settings);
      card.append(stepsWrap);
    }

    // Drag to reorder workflows — pointer-based, handle-only.
    card.dataset.dragId = id;
    dragHandle.addEventListener("pointerdown", (e) => {
      startPointerDrag(e, dragHandle, card, id, wfListEl, ".wf-card", (srcId, targetId) => reorderWorkflows(srcId, targetId));
    });
    return card;
  }

  // Matches on the workflow's own name/hotkey AND every step inside it (name,
  // type, selector, fill/select value) — so searching "consulate" finds a
  // workflow whose 3rd step just happens to target that dropdown.
  function matchesWfSearch(wf, search) {
    const stepText = (wf.steps || []).flatMap((s) => [
      s.name, s.type, s.selector, s.fillValue, s.selectValue, ...(s.requiredElements || []),
    ]);
    return [wf.name, wf.hotkey, ...stepText].filter(Boolean).join(" ").toLowerCase().includes(search);
  }

  if (wfSearchEl) {
    chrome.storage.local.get([WF_SEARCH_KEY], (res) => { wfSearchEl.value = res[WF_SEARCH_KEY] || ""; });
    wfSearchEl.addEventListener("input", (e) => { chrome.storage.local.set({ [WF_SEARCH_KEY]: e.target.value }); renderWorkflows(); });
  }

  function renderWorkflows() {
    if (!wfListEl) return;
    chrome.storage.local.get([WF_KEY, STATUS_KEY, WF_SEARCH_KEY, RULES_KEY], (res) => {
      const wfs = res[WF_KEY] || [];
      liveStatus = res[STATUS_KEY] || {};
      wfPickerCache.workflows = wfs;
      wfPickerCache.rules = (res[RULES_KEY] || []).map(normalizeRule);
      const search = (res[WF_SEARCH_KEY] || "").trim().toLowerCase();
      const shown = search ? wfs.filter((w) => matchesWfSearch(w, search)) : wfs;
      wireExpandToggle("wf-expand-toggle", shown.map((w) => String(w.id)), wfCollapsed, () => { persistWfCollapse(); renderWorkflows(); }, "workflows");
      wfListEl.textContent = "";
      if (!wfs.length) {
        const e = document.createElement("div"); e.className = "logs-empty";
        e.textContent = "No workflows yet — create one to build a step sequence.";
        wfListEl.appendChild(e); return;
      }
      if (!shown.length) {
        const e = document.createElement("div"); e.className = "logs-empty";
        e.textContent = "No workflows match your search.";
        wfListEl.appendChild(e); return;
      }
      shown.forEach((wf) => wfListEl.appendChild(renderWorkflowCard(wf)));
      persistWfCollapse();
    });
  }

  const wfAddBtn = document.getElementById("wf-add");
  if (wfAddBtn) wfAddBtn.onclick = addWorkflow;

  wireInfoToggle("wf-info-btn", "wf-info-panel");

  // ── Workflows toolbar: Share / Import link / Export / Import ─────────────
  // Same share-link infrastructure as rules (utils/license.js shareRules /
  // fetchSharedRules don't care what shape the array is), applied to the
  // whole autoWorkflows array instead of a filtered rule category.
  const wfShareBtn = document.getElementById("wf-share");
  if (wfShareBtn) wfShareBtn.onclick = () => {
    chrome.storage.local.get([WF_KEY], (res) => shareRuleArray(res[WF_KEY] || [], wfShareBtn));
  };

  const wfImpLinkBtn = document.getElementById("wf-import-link");
  if (wfImpLinkBtn) wfImpLinkBtn.onclick = async () => {
    const text = window.prompt("Paste a Nuskomate workflows link:");
    if (text == null || !text.trim()) return;
    let imported = null;
    const code = shareCodeFrom(text);
    if (code && window.NkLicense && window.NkLicense.fetchSharedRules) {
      const r = await window.NkLicense.fetchSharedRules(code);
      if (r && r.ok && Array.isArray(r.rules)) imported = r.rules;
      else if (!/[#?&]r=/.test(text)) { alert("Import failed: " + ((r && r.error) || "server unreachable")); return; }
    }
    if (!imported) {
      try { imported = decodeRulesLink(text); } catch (err) { alert("Import failed: " + err.message); return; }
    }
    if (!imported.length) { alert("That link has no workflows."); return; }
    withWorkflows((wfs) => saveWorkflows([...wfs, ...imported], () => { alert(`Imported ${imported.length} workflow(s) from link.`); renderWorkflows(); }));
  };

  const wfExportBtn = document.getElementById("wf-export");
  if (wfExportBtn) wfExportBtn.onclick = () => {
    chrome.storage.local.get([WF_KEY], (res) => {
      const wfs = res[WF_KEY] || [];
      if (!wfs.length) { alert("No workflows to export."); return; }
      const blob = new Blob([JSON.stringify(wfs, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `workflows-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    });
  };

  const wfImportBtn = document.getElementById("wf-import");
  const wfImportFile = document.getElementById("wf-import-file");
  if (wfImportBtn && wfImportFile) wfImportBtn.onclick = () => wfImportFile.click();
  if (wfImportFile) wfImportFile.addEventListener("change", (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const imported = JSON.parse(ev.target.result);
        if (!Array.isArray(imported)) throw new Error("Expected an array of workflows.");
        withWorkflows((wfs) => saveWorkflows([...wfs, ...imported], () => { alert(`Imported ${imported.length} workflow(s).`); renderWorkflows(); }));
      } catch (err) { alert(`Import failed: ${err.message}`); }
    };
    reader.readAsText(file); wfImportFile.value = "";
  });

  // Keep in sync if rules / workflows / status change elsewhere.
  chrome.storage.onChanged.addListener((c, a) => {
    if (a !== "local") return;
    if (c[RULES_KEY] || c.autoButtons) {
      if (suppressNextToggleRender) suppressNextToggleRender = false;
      else renderRules();
    }
    if (c[WF_KEY] || c[STATUS_KEY]) {
      if (suppressNextToggleRender) suppressNextToggleRender = false;
      else renderWorkflows();
    }
  });

  // ══ URL Shifter (redirect rules) ═══════════════════════════════════════════
  const US_KEY = "autoUrlShiftRules";
  const US_SEARCH_KEY = "acSearch_urlshift";
  const usListEl = document.getElementById("us-list");
  const usSearchEl = document.getElementById("us-search");
  const usCollapsed = new Set(); // collapsed (hidden body) redirect-rule ids — persisted like the other Hide/Show states
  function persistUsCollapse() { chrome.storage.local.set({ acUsCollapsed: [...usCollapsed] }); }

  // Fetches the ACTIVE TAB's URL (not this popup's own URL) so "Use current"
  // can drop it straight into a match/redirect field.
  function getActiveTabUrl(cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      cb(tab && tab.url ? tab.url : null);
    });
  }
  // A text field + a small "Use current" button that fills it from the
  // active tab's URL — kind "path" inserts just the pathname, "href" the
  // full URL. Bypasses the normal txt() so the button can update the input
  // AND save in one action instead of requiring a manual paste.
  function usUrlField(labelText, value, placeholder, kind, onSave) {
    const w = document.createElement("div"); w.className = "rule-field full";
    const l = document.createElement("label"); l.textContent = labelText;
    const row = document.createElement("div"); row.className = "us-url-row";
    const input = document.createElement("input");
    input.type = "text"; input.value = value || ""; if (placeholder) input.placeholder = placeholder;
    input.addEventListener("change", (e) => onSave(e.target.value.trim()));
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "us-use-btn";
    btn.textContent = "Use current";
    btn.title = kind === "path" ? "Insert the active tab's current page path" : "Insert the active tab's current full URL";
    btn.addEventListener("click", () => {
      getActiveTabUrl((url) => {
        if (!url) { alert("Could not read the active tab's URL — open a Masar page first."); return; }
        let val = url;
        try { val = kind === "path" ? new URL(url).pathname : url; } catch (_) {}
        input.value = val;
        onSave(val);
      });
    });
    row.append(input, btn);
    w.append(l, row);
    return w;
  }

  function usNormalizeRule(rule) {
    return {
      id: rule.id || uid(),
      name: rule.name || "Redirect",
      nameCustom: !!rule.nameCustom, // true once the user types their own name — stops auto-rename
      enabled: rule.enabled !== false,
      triggerBy: rule.triggerBy === "element" ? "element" : "url",
      matchMode: rule.matchMode || "contains",
      matchValue: rule.matchValue || "",
      elementSelector: rule.elementSelector || "",
      targetUrl: rule.targetUrl || "",
    };
  }
  function withUsRules(fn) { chrome.storage.local.get([US_KEY], (res) => fn((res[US_KEY] || []).map(usNormalizeRule))); }

  // "https://masar.nusuk.sa/umrah/mutamer-group/add-group" → "→ umrah/mutamer-group/add-group".
  // Falls back to the raw string for anything that doesn't parse as a URL
  // (e.g. mid-typing, or a bare path already — new URL() needs an origin for
  // those, which the popup doesn't have access to).
  function usDeriveName(targetUrl) {
    const v = (targetUrl || "").trim();
    if (!v) return "";
    let path = v;
    if (/^https?:\/\//i.test(v)) {
      try { path = new URL(v).pathname; } catch (_) { /* leave as raw string */ }
    }
    path = path.replace(/^\/+|\/+$/g, "");
    return "→ " + (path || v);
  }
  function saveUsRules(rules, cb) { pushUndo(() => chrome.storage.local.set({ [US_KEY]: rules }, cb)); }

  function addUsRule() {
    withUsRules((rules) => saveUsRules([...rules, usNormalizeRule({ id: uid(), name: `Redirect ${rules.length + 1}` })], renderUsRules));
  }
  function duplicateUsRule(id) {
    withUsRules((rules) => {
      const idx = rules.findIndex((r) => String(r.id) === String(id));
      if (idx < 0) return;
      // Mark the copy's name custom so editing its (likely different) target
      // URL doesn't silently drop the " (copy)" suffix right after duplicating.
      const copy = { ...rules[idx], id: uid(), name: (rules[idx].name || "Redirect") + " (copy)", nameCustom: true };
      const next = [...rules]; next.splice(idx + 1, 0, copy);
      saveUsRules(next, renderUsRules);
    });
  }
  function deleteUsRule(id) {
    if (!confirm("Delete this redirect rule?")) return;
    withUsRules((rules) => saveUsRules(rules.filter((r) => String(r.id) !== String(id)), renderUsRules));
  }
  function patchUsRule(id, patch) {
    withUsRules((rules) => saveUsRules(rules.map((r) => String(r.id) === String(id) ? { ...r, ...patch } : r), renderUsRules));
  }
  // Same write as patchUsRule, but WITHOUT the immediate renderUsRules()
  // callback — see patchWorkflowEnabled for why the enable/disable slider
  // specifically needs to skip both re-render paths.
  function patchUsRuleEnabled(id, enabled) {
    skipNextToggleRender();
    withUsRules((rules) => saveUsRules(rules.map((r) => String(r.id) === String(id) ? { ...r, enabled } : r)));
  }
  function reorderUsRules(srcId, targetId) {
    withUsRules((rules) => {
      const from = rules.findIndex((r) => String(r.id) === String(srcId));
      const to = rules.findIndex((r) => String(r.id) === String(targetId));
      if (from < 0 || to < 0 || from === to) return;
      const next = [...rules];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      saveUsRules(next, renderUsRules);
    });
  }
  function matchesUsSearch(rule, search) {
    return [rule.name, rule.triggerBy, rule.matchMode, rule.matchValue, rule.elementSelector, rule.targetUrl].filter(Boolean).join(" ").toLowerCase().includes(search);
  }
  function usMatchPlaceholder(mode) {
    if (mode === "exact" || mode === "partial") return "/umrah/mutamer/add-mutamer";
    return "text to search for anywhere in the URL";
  }

  function buildUsCard(rule) {
    const id = String(rule.id);
    const isCollapsed = usCollapsed.has(id);
    const card = document.createElement("div"); card.className = "rule-card us-card";
    card.dataset.dragId = id;

    const head = document.createElement("div"); head.className = "rule-head";
    const { label: toggleWrap } = toggleSwitch(rule.enabled, null, (checked) => patchUsRuleEnabled(id, checked));
    toggleWrap.title = "Enable this rule";

    const dragHandle = document.createElement("span"); dragHandle.className = "drag-handle"; dragHandle.textContent = "☰"; dragHandle.title = "Drag to reorder";
    dragHandle.addEventListener("pointerdown", (e) => startPointerDrag(e, dragHandle, card, id, usListEl, ".us-card", (srcId, targetId) => reorderUsRules(srcId, targetId)));

    const name = document.createElement("input"); name.className = "wf-step-name"; name.value = rule.name;
    name.title = rule.nameCustom ? "" : "Auto-named from the redirect URL — type your own name to take over";
    name.addEventListener("change", (e) => {
      const v = e.target.value.trim();
      // Clearing the name back to empty hands naming back to auto-mode;
      // typing anything else marks it custom so URL edits stop overwriting it.
      if (!v) patchUsRule(id, { name: usDeriveName(rule.targetUrl) || "Redirect", nameCustom: false });
      else patchUsRule(id, { name: v, nameCustom: true });
    });

    const collapseBtn = iconMini(isCollapsed ? "chevDown" : "chevUp", isCollapsed ? "Show rule details" : "Hide rule details", () => {
      usCollapsed.has(id) ? usCollapsed.delete(id) : usCollapsed.add(id);
      persistUsCollapse();
      renderUsRules();
    });
    const shareOne = iconMini("share", "Share this rule as a link", (e) => shareRuleArray([rule], e.currentTarget));
    const dup = iconMini("duplicate", "Duplicate this rule", () => duplicateUsRule(id));
    const del = iconMini("trash", "Delete this rule", () => deleteUsRule(id), true);

    head.append(toggleWrap, dragHandle, name, collapseBtn, shareOne, dup, del);

    const body = document.createElement("div"); body.className = "rule-body us-body" + (isCollapsed ? " collapsed" : "");
    const triggerBy = rule.triggerBy || "url";
    body.append(fieldRow("Trigger", sel(triggerBy, [
      { value: "url", label: "URL matches" },
      { value: "element", label: "Element appears on the page" },
    ], (v) => patchUsRule(id, { triggerBy: v }))));

    if (triggerBy === "element") {
      const esWrap = document.createElement("div"); esWrap.className = "rule-field full";
      const esLbl = document.createElement("label"); esLbl.textContent = "Element selector (redirects once it shows up, anywhere on the page)";
      const esRow = document.createElement("div"); esRow.className = "us-url-row";
      const esInput = txt(rule.elementSelector, "CSS / xpath= / text=  (a || b = fallback)", (v) => patchUsRule(id, { elementSelector: v }));
      esRow.append(
        esInput,
        pickSelectorBtn({ forUsElement: true, ruleId: id }),
        highlightSelectorBtn(() => esInput.value),
      );
      esWrap.append(esLbl, esRow);
      body.append(esWrap);
    } else {
      const isPathMode = rule.matchMode === "exact" || rule.matchMode === "partial";
      body.append(
        fieldRow("Match", sel(rule.matchMode, ["exact", "partial", "contains", "not contains"], (v) => patchUsRule(id, { matchMode: v }))),
        usUrlField(isPathMode ? "Path" : "Text in URL", rule.matchValue, usMatchPlaceholder(rule.matchMode), isPathMode ? "path" : "href", (v) => patchUsRule(id, { matchValue: v })),
      );
    }

    body.append(usUrlField("Redirect to", rule.targetUrl, "https://… or /a-path-on-this-site", "href", (v) => {
      const patch = { targetUrl: v };
      if (!rule.nameCustom) { const derived = usDeriveName(v); if (derived) patch.name = derived; }
      patchUsRule(id, patch);
    }));

    card.append(head, body);
    return card;
  }

  function renderUsRules() {
    if (!usListEl) return;
    chrome.storage.local.get([US_KEY, US_SEARCH_KEY], (res) => {
      const rules = (res[US_KEY] || []).map(usNormalizeRule);
      const search = (res[US_SEARCH_KEY] || "").trim().toLowerCase();
      const shown = search ? rules.filter((r) => matchesUsSearch(r, search)) : rules;
      wireExpandToggle("us-expand-toggle", shown.map((r) => String(r.id)), usCollapsed, () => { persistUsCollapse(); renderUsRules(); }, "redirect rules");
      usListEl.textContent = "";
      if (!rules.length) {
        const e = document.createElement("div"); e.className = "logs-empty"; e.textContent = "No redirect rules yet";
        usListEl.appendChild(e); return;
      }
      if (!shown.length) {
        const e = document.createElement("div"); e.className = "logs-empty"; e.textContent = "No rules match your search.";
        usListEl.appendChild(e); return;
      }
      shown.forEach((rule) => usListEl.appendChild(buildUsCard(rule)));
    });
  }

  wireInfoToggle("us-info-btn", "us-info-panel");

  const usAddBtn = document.getElementById("us-add");
  if (usAddBtn) usAddBtn.onclick = addUsRule;

  if (usSearchEl) {
    chrome.storage.local.get([US_SEARCH_KEY], (res) => { usSearchEl.value = res[US_SEARCH_KEY] || ""; });
    usSearchEl.addEventListener("input", (e) => { chrome.storage.local.set({ [US_SEARCH_KEY]: e.target.value }); renderUsRules(); });
  }

  // Share / Import link / Export / Import — identical infrastructure to
  // rules and workflows, applied to the whole autoUrlShiftRules array.
  const usShareBtn = document.getElementById("us-share");
  if (usShareBtn) usShareBtn.onclick = () => {
    chrome.storage.local.get([US_KEY], (res) => shareRuleArray(res[US_KEY] || [], usShareBtn));
  };

  const usDelAllBtn = document.getElementById("us-delete-all");
  if (usDelAllBtn) usDelAllBtn.onclick = () => {
    withUsRules((rules) => {
      if (!rules.length) { alert("No redirect rules to delete."); return; }
      if (!confirm(`Delete all ${rules.length} redirect rule(s)? This can be undone with Ctrl+Z.`)) return;
      saveUsRules([], renderUsRules);
    });
  };

  const usImpLinkBtn = document.getElementById("us-import-link");
  if (usImpLinkBtn) usImpLinkBtn.onclick = async () => {
    const text = window.prompt("Paste a Nuskomate redirect-rules link:");
    if (text == null || !text.trim()) return;
    let imported = null;
    const code = shareCodeFrom(text);
    if (code && window.NkLicense && window.NkLicense.fetchSharedRules) {
      const r = await window.NkLicense.fetchSharedRules(code);
      if (r && r.ok && Array.isArray(r.rules)) imported = r.rules;
      else if (!/[#?&]r=/.test(text)) { alert("Import failed: " + ((r && r.error) || "server unreachable")); return; }
    }
    if (!imported) {
      try { imported = decodeRulesLink(text); } catch (err) { alert("Import failed: " + err.message); return; }
    }
    if (!imported.length) { alert("That link has no rules."); return; }
    withUsRules((rules) => saveUsRules([...rules, ...imported.map(usNormalizeRule)], () => { alert(`Imported ${imported.length} rule(s) from link.`); renderUsRules(); }));
  };

  const usExportBtn = document.getElementById("us-export");
  if (usExportBtn) usExportBtn.onclick = () => {
    chrome.storage.local.get([US_KEY], (res) => {
      const rules = res[US_KEY] || [];
      if (!rules.length) { alert("No redirect rules to export."); return; }
      const blob = new Blob([JSON.stringify(rules, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `redirect-rules-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    });
  };

  const usImportBtn = document.getElementById("us-import");
  const usImportFile = document.getElementById("us-import-file");
  if (usImportBtn && usImportFile) usImportBtn.onclick = () => usImportFile.click();
  if (usImportFile) usImportFile.addEventListener("change", (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const imported = JSON.parse(ev.target.result);
        if (!Array.isArray(imported)) throw new Error("Expected an array of rules.");
        withUsRules((rules) => saveUsRules([...rules, ...imported.map(usNormalizeRule)], () => { alert(`Imported ${imported.length} rule(s).`); renderUsRules(); }));
      } catch (err) { alert(`Import failed: ${err.message}`); }
    };
    reader.readAsText(file); usImportFile.value = "";
  });

  chrome.storage.onChanged.addListener((c, a) => {
    if (a !== "local" || !c[US_KEY]) return;
    if (suppressNextToggleRender) suppressNextToggleRender = false;
    else renderUsRules();
  });

  // Restore persisted Hide/Show state BEFORE the first render, so nothing
  // flashes open-then-collapsed. Both renders persist their own state again
  // right after, so subsequent toggles just work off the live Sets.
  chrome.storage.local.get(["acKnownRuleIds", "acCollapsedRuleIds", "acCollapsedGroups", "acWfCollapsed", "acWfSettingsOpen", "acUsCollapsed"], (res) => {
    (res.acKnownRuleIds || []).forEach((id) => knownRuleIds.add(id));
    (res.acCollapsedRuleIds || []).forEach((id) => collapsedRuleIds.add(id));
    (res.acCollapsedGroups || []).forEach((k) => collapsedGroups.add(k));
    (res.acWfCollapsed || []).forEach((id) => wfCollapsed.add(id));
    (res.acWfSettingsOpen || []).forEach((id) => wfSettingsOpen.add(id));
    (res.acUsCollapsed || []).forEach((id) => usCollapsed.add(id));
    renderRules();
    renderWorkflows();
    renderUsRules();
  });
});
