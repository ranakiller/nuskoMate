// Auto Clicker — rules manager for the "Clicker" tab.
// Rules are stored in chrome.storage.local under "autoClickRules" and executed
// by modules/auto-clicker.js on the Masar page. The enable toggle lives in the
// Modules tab (moduleAutoClicker); this panel only creates/edits rules.
document.addEventListener("DOMContentLoaded", () => {
  const RULES_KEY = "autoClickRules";
  const TYPE_LABELS = { button: "BTN", input: "INP", dropdown: "SEL", checkbox: "CHK", radio: "RAD" };

  // Reactive rules split into three category views by element type:
  //   click  → Auto Clicker (buttons/checkbox/radio)   → moduleAutoClicker
  //   fill   → Autofill      (input fields)             → moduleAutoFillRules
  //   select → Auto Select   (dropdowns)                → moduleAutoSelect
  const CATS = [
    { cat: "click",  list: "ac-list",   search: "ac-search",   offTag: "ac-off-tag",   add: "ac-add",   exp: "ac-export",   imp: "ac-import",   impFile: "ac-import-file",   share: "ac-share",   impLink: "ac-import-link",   searchKey: "acSearch_click",  module: "moduleAutoClicker",   empty: "No click rules yet",  file: "click-rules" },
    { cat: "fill",   list: "fill-list", search: "fill-search", offTag: "fill-off-tag", add: "fill-add", exp: "fill-export", imp: "fill-import", impFile: "fill-import-file", share: "fill-share", impLink: "fill-import-link", searchKey: "acSearch_fill",   module: "moduleAutoFillRules", empty: "No fill rules yet",   file: "fill-rules" },
    { cat: "select", list: "as-list",   search: "as-search",   offTag: "as-off-tag",   add: "as-add",   exp: "as-export",   imp: "as-import",   impFile: "as-import-file",   share: "as-share",   impLink: "as-import-link",   searchKey: "acSearch_select", module: "moduleAutoSelect",    empty: "No select rules yet", file: "select-rules" },
  ];
  const wfOffTag = document.getElementById("wf-off-tag");
  if (!document.getElementById("ac-list")) return;

  const collapsedRuleIds = new Set();
  const knownRuleIds = new Set();
  const collapsedGroups = new Set(); // "cat|path" groups collapsed in the rules lists
  let draggedId = null; // id of the rule currently being dragged (reliable across drop)

  function categoryOf(rule) {
    const t = rule.type || "button";
    return t === "input" ? "fill" : t === "dropdown" ? "select" : "click";
  }

  // ── "module off" hints ─────────────────────────────────────────────────────
  function refreshOffTag() {
    chrome.storage.local.get(["moduleAutoClicker", "moduleAutoFillRules", "moduleAutoSelect", "moduleWorkflows"], (res) => {
      CATS.forEach((c) => { const el = document.getElementById(c.offTag); if (el) el.style.display = res[c.module] ? "none" : ""; });
      if (wfOffTag) wfOffTag.style.display = res.moduleWorkflows ? "none" : "";
    });
  }

  // ── Per-category search ────────────────────────────────────────────────────
  CATS.forEach((c) => {
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
      fillValue: rule.fillValue || "",
      clearFirst: rule.clearFirst !== false,
      triggerAngularEvents: rule.triggerAngularEvents !== false,
      selectValue: rule.selectValue || "",
      selectMatchBy: rule.selectMatchBy || "value",
      targetState: rule.targetState || "checked",
    };
  }

  // ── Search matching ─────────────────────────────────────────────────────
  function matchesSearch(rule, search) {
    return [
      rule.name, rule.type, rule.pathname, rule.pathMatch, rule.fillValue, rule.selectValue,
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

  // ── Undo / redo (Tier 3) ───────────────────────────────────────────────────
  // Every rule/workflow mutation snapshots BOTH stores first, so Ctrl+Z walks
  // back edits, deletes, imports, reorders and profile loads. Per popup session.
  const HISTORY_MAX = 60;
  const history = { undo: [], redo: [] };
  let restoringHistory = false;

  function historySnapshot(cb) {
    chrome.storage.local.get([RULES_KEY, "autoWorkflows"], (res) =>
      cb({ rules: res[RULES_KEY] || [], wfs: res.autoWorkflows || [] }));
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
    chrome.storage.local.set({ [RULES_KEY]: snap.rules, autoWorkflows: snap.wfs }, () => {
      restoringHistory = false;
      renderRules(); renderWorkflows(); updateHistoryButtons();
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

  function reorderRules(sourceId, targetId, rules) {
    const from = rules.findIndex((r) => String(r.id) === String(sourceId));
    const to = rules.findIndex((r) => String(r.id) === String(targetId));
    if (from < 0 || to < 0 || from === to) return;
    const next = [...rules];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    saveRules(next, renderRules);
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
      (options || []).forEach((val) => {
        const opt = document.createElement("option");
        opt.value = val; opt.textContent = val; control.appendChild(opt);
      });
    } else {
      control.type = isSecondsField(key) ? "number" : "text";
      if (isSecondsField(key)) { control.min = "0"; control.step = "0.5"; }
    }
    control.value = getRuleValue(rule, key);
    control.addEventListener("change", (e) => {
      const nextRules = rules.map((r) => String(r.id) === String(rule.id) ? setRuleValue(r, key, e.target.value) : r);
      saveRules(nextRules, key === "actionType" ? renderRules : undefined);
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
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "secondary-btn";
        removeBtn.textContent = "×";
        removeBtn.addEventListener("click", () => {
          const next = [...values];
          next.splice(index, 1);
          saveRules(rules.map((r) => String(r.id) === String(rule.id) ? { ...r, [key]: next.filter(Boolean) } : r), renderRules);
        });
        row.append(input, removeBtn);
        list.appendChild(row);
      });
    };

    const pickBtn = document.createElement("button");
    pickBtn.type = "button";
    pickBtn.className = "secondary-btn";
    pickBtn.textContent = `Pick ${labelText.replace(/s$/, "")}`;
    pickBtn.addEventListener("click", () => startPicker({ mode, ruleId: rule.id }));

    wrapper.append(label, list, pickBtn);
    renderItems();
    return wrapper;
  }

  function getTypeSpecificFields(rule, rules) {
    switch (rule.type) {
      case "input":
        return [
          createField(rule, "fillValue", "Fill value", "input", rules, null, "full"),
          createCheckboxField(rule, "clearFirst", "Clear first", rules),
          createCheckboxField(rule, "triggerAngularEvents", "Angular events", rules),
        ];
      case "dropdown":
        return [
          createField(rule, "selectValue", "Select value", "input", rules, null, "full"),
          createField(rule, "selectMatchBy", "Match by", "select", rules, ["value", "text"]),
        ];
      case "checkbox":
      case "radio":
        return [createField(rule, "targetState", "Target state", "select", rules, ["checked", "unchecked", "toggle"])];
      default:
        return [];
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function renderRules() {
    chrome.storage.local.get([RULES_KEY, "autoButtons", "acSearch_click", "acSearch_fill", "acSearch_select"], (res) => {
      const rules = (res[RULES_KEY] || res.autoButtons || []).map(normalizeRule);

      const buildRuleCard = (rule) => {
        const id = String(rule.id);
        if (!knownRuleIds.has(id)) { knownRuleIds.add(id); collapsedRuleIds.add(id); }

        const card = document.createElement("div");
        card.className = "rule-card";

        const head = document.createElement("div");
        head.className = "rule-head";

        const toggle = document.createElement("input");
        toggle.type = "checkbox";
        toggle.className = "enable-toggle";
        toggle.dataset.id = id;
        toggle.checked = !!rule.enabled;

        const dragHandle = document.createElement("span");
        dragHandle.className = "drag-handle";
        dragHandle.textContent = "☰";

        const title = document.createElement("div");
        title.className = "rule-title";
        title.textContent = rule.name || rule.requiredElements[0] || "Unnamed";

        const badge = document.createElement("span");
        badge.className = `type-badge type-badge--${rule.type}`;
        badge.textContent = TYPE_LABELS[rule.type] || "BTN";

        const collapseBtn = document.createElement("button");
        collapseBtn.className = "collapse-rule";
        collapseBtn.type = "button";
        collapseBtn.dataset.id = id;
        collapseBtn.textContent = collapsedRuleIds.has(id) ? "Show" : "Hide";

        const delBtn = document.createElement("button");
        delBtn.className = "delete-rule del-btn";
        delBtn.dataset.id = id;
        delBtn.type = "button";
        delBtn.textContent = "Delete";

        head.append(toggle, dragHandle, title, badge, collapseBtn, delBtn);

        const summary = document.createElement("div");
        summary.className = "rule-summary";
        const delayText = rule.action.type === "delay" ? ` ${rule.action.delayMs / 1000}s` : "";
        const repeatText = rule.repeat ? ` | repeat ${rule.repeatIntervalMs / 1000}s` : "";
        summary.textContent = `${rule.action.type}${delayText}${repeatText} | ${rule.pathMatch}: ${rule.pathname || "any path"}`;

        const body = document.createElement("div");
        body.className = collapsedRuleIds.has(id) ? "rule-body collapsed" : "rule-body";
        body.append(
          createField(rule, "name", "Rule name", "input", rules),
          createField(rule, "pathMatch", "Path match", "select", rules, ["exact", "includes"]),
          createField(rule, "pathname", "Page path", "input", rules, null, "full"),
          createMultiSelectorField(rule, "requiredElements", "Required selectors", rules, ".btn, [data-action]", "required"),
          createMultiSelectorField(rule, "forbiddenElements", "Forbidden selectors", rules, ".error, button[disabled]", "forbidden"),
          createField(rule, "actionType", "Action", "select", rules, ["run", "stop", "delay"]),
        );
        if (rule.action.type === "delay") body.append(createField(rule, "actionDelaySeconds", "Delay sec", "input", rules));
        body.append(createField(rule, "jitterSeconds", "Jitter max sec (human-like)", "input", rules));
        body.append(createCheckboxField(rule, "repeat", "Repeat", rules, renderRules));
        if (rule.repeat) body.append(createField(rule, "repeatIntervalSeconds", "Repeat interval sec", "input", rules));

        const typeFields = getTypeSpecificFields(rule, rules);
        if (typeFields.length) {
          const divider = document.createElement("hr");
          divider.className = "field-divider";
          body.append(divider, ...typeFields);
        }

        // Drag to reorder — enabled ONLY from the handle so the form inputs
        // don't hijack it into a text-drag (which was losing the rule id on drop).
        card.draggable = false;
        dragHandle.addEventListener("mousedown", () => { card.draggable = true; });
        dragHandle.addEventListener("mouseup", () => { card.draggable = false; });
        card.addEventListener("dragstart", (e) => {
          draggedId = id;
          e.dataTransfer.effectAllowed = "move";
          try { e.dataTransfer.setData("text/plain", id); } catch (_) {}
          card.classList.add("dragging");
        });
        card.addEventListener("dragend", () => {
          card.classList.remove("dragging");
          card.draggable = false;
          draggedId = null;
        });
        card.addEventListener("dragover", (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          card.classList.add("drag-over");
        });
        card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
        card.addEventListener("drop", (e) => {
          e.preventDefault();
          card.classList.remove("drag-over");
          const srcId = draggedId || e.dataTransfer.getData("text/plain");
          if (srcId && String(srcId) !== id) reorderRules(srcId, id, rules);
        });

        card.append(head, summary, body);
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
          const e = document.createElement("div"); e.className = "logs-empty";
          e.textContent = catRules.length ? "No rules match your search." : cfg.empty;
          listEl.appendChild(e); return;
        }
        const groups = new Map();
        displayed.forEach((rule) => { const key = (rule.pathname || "").trim() || "__any__"; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(rule); });

        // Expand-all / collapse-all for this category's URL groups (only useful
        // when there is more than one group).
        if (groups.size > 1) {
          const gkeys = [...groups.keys()].map((k) => cfg.cat + "|" + k);
          const ctrl = document.createElement("div"); ctrl.className = "rule-group-controls";
          const expBtn = document.createElement("button"); expBtn.type = "button"; expBtn.className = "group-ctrl-btn"; expBtn.textContent = "Expand all";
          expBtn.onclick = () => { gkeys.forEach((k) => collapsedGroups.delete(k)); renderRules(); };
          const colBtn = document.createElement("button"); colBtn.type = "button"; colBtn.className = "group-ctrl-btn"; colBtn.textContent = "Collapse all";
          colBtn.onclick = () => { gkeys.forEach((k) => collapsedGroups.add(k)); renderRules(); };
          ctrl.append(expBtn, colBtn);
          listEl.appendChild(ctrl);
        }

        groups.forEach((grpRules, key) => {
          const gkey = cfg.cat + "|" + key;
          const gh = document.createElement("div"); gh.className = "rule-group-head";
          const gcol = collapsedGroups.has(gkey);
          const caret = document.createElement("span"); caret.className = "rule-group-caret"; caret.textContent = gcol ? "▸" : "▾";
          const gt = document.createElement("span"); gt.className = "rule-group-title"; gt.textContent = key === "__any__" ? "Any page" : key;
          const gc = document.createElement("span"); gc.className = "rule-group-count"; gc.textContent = grpRules.length;
          gh.append(caret, gt, gc);
          gh.addEventListener("click", () => { collapsedGroups.has(gkey) ? collapsedGroups.delete(gkey) : collapsedGroups.add(gkey); renderRules(); });
          listEl.appendChild(gh);
          if (gcol) return;
          grpRules.forEach((rule) => listEl.appendChild(buildRuleCard(rule)));
        });
        listEl.querySelectorAll(".enable-toggle").forEach((cb) => {
          cb.onchange = (e) => { const rid = e.target.dataset.id; saveRules(rules.map((r) => String(r.id) === rid ? { ...r, enabled: e.target.checked } : r)); };
        });
        listEl.querySelectorAll(".collapse-rule").forEach((btn) => {
          btn.onclick = (e) => { const rid = e.currentTarget.dataset.id; collapsedRuleIds.has(rid) ? collapsedRuleIds.delete(rid) : collapsedRuleIds.add(rid); renderRules(); };
        });
        listEl.querySelectorAll(".del-btn").forEach((btn) => {
          btn.onclick = (e) => { const rid = e.currentTarget.dataset.id; collapsedRuleIds.delete(rid); knownRuleIds.delete(rid); saveRules(rules.filter((r) => String(r.id) !== rid), renderRules); };
        });
      });
    });
  }

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

  // ── Per-category toolbars (Add picks only that type; export/import filter) ──
  CATS.forEach((cfg) => {
    const addBtn = document.getElementById(cfg.add);
    if (addBtn) addBtn.onclick = () => startPicker({ mode: "required" });

    // Share this category's rules — short server link, long link as fallback.
    const shareBtn = document.getElementById(cfg.share);
    if (shareBtn) shareBtn.onclick = () => {
      chrome.storage.local.get([RULES_KEY], async (res) => {
        const rules = (res[RULES_KEY] || []).filter((r) => categoryOf(normalizeRule(r)) === cfg.cat);
        if (!rules.length) { alert("No rules to share."); return; }
        shareBtn.disabled = true; shareBtn.textContent = "Sharing…";
        const done = () => { shareBtn.disabled = false; shareBtn.textContent = "Share link"; };
        if (window.NkLicense && window.NkLicense.shareRules) {
          const r = await window.NkLicense.shareRules(rules);
          done();
          if (r && r.ok && r.url) {
            copyText(r.url, `Short link copied — ${rules.length} rule(s), valid 180 days.\nAnyone imports it with "Import link".`);
            return;
          }
          // Server refused / unreachable → offer the offline self-contained link.
          if (!confirm(`Could not create a short link (${(r && r.error) || "server unreachable"}).\nCopy a long offline link instead?`)) return;
        } else done();
        copyText(encodeRulesLink(rules), `Long link copied — ${rules.length} rule(s). Paste it to anyone; they import it with "Import link".`);
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

  // ══ Named profiles (Tier 3) ═══════════════════════════════════════════════
  // A profile = a named snapshot of ALL rules + workflows. Loading one replaces
  // the current set (undo-able via the shared history).
  const PROF_KEY = "acProfiles";
  const profSelect = document.getElementById("prof-select");
  const profInfo = document.getElementById("prof-info");

  function withProfiles(fn) { chrome.storage.local.get([PROF_KEY], (res) => fn(res[PROF_KEY] || [])); }

  function renderProfiles() {
    if (!profSelect) return;
    withProfiles((profs) => {
      const cur = profSelect.value;
      profSelect.textContent = "";
      if (!profs.length) {
        const o = document.createElement("option"); o.value = ""; o.textContent = "— no profiles saved —";
        profSelect.appendChild(o);
      } else {
        profs.forEach((p) => {
          const o = document.createElement("option"); o.value = String(p.id);
          o.textContent = `${p.name} (${(p.rules || []).length} rules · ${(p.wfs || []).length} workflows)`;
          profSelect.appendChild(o);
        });
        if ([...profSelect.options].some((o) => o.value === cur)) profSelect.value = cur;
      }
      if (profInfo) {
        const p = profs.find((x) => String(x.id) === profSelect.value);
        profInfo.textContent = p ? `Saved ${new Date(p.savedAt).toLocaleString()}` : "";
      }
    });
  }

  function currentSnapshot(cb) {
    chrome.storage.local.get([RULES_KEY, "autoWorkflows"], (res) =>
      cb({ rules: res[RULES_KEY] || [], wfs: res.autoWorkflows || [] }));
  }
  function selectedProfile(profs) { return profs.find((p) => String(p.id) === (profSelect ? profSelect.value : "")); }

  if (profSelect) {
    profSelect.addEventListener("change", renderProfiles);

    document.getElementById("prof-save").addEventListener("click", () => {
      const name = window.prompt("Profile name:");
      if (name == null || !name.trim()) return;
      currentSnapshot((snap) => withProfiles((profs) => {
        const prof = { id: Date.now(), name: name.trim(), rules: snap.rules, wfs: snap.wfs, savedAt: Date.now() };
        chrome.storage.local.set({ [PROF_KEY]: [...profs, prof] }, () => {
          renderProfiles();
          setTimeout(() => { profSelect.value = String(prof.id); renderProfiles(); }, 50);
        });
      }));
    });

    document.getElementById("prof-load").addEventListener("click", () => withProfiles((profs) => {
      const p = selectedProfile(profs);
      if (!p) { alert("Select a profile first."); return; }
      if (!confirm(`Load "${p.name}"? Current rules + workflows will be replaced (Ctrl+Z undoes it).`)) return;
      pushUndo(() => chrome.storage.local.set({ [RULES_KEY]: p.rules || [], autoWorkflows: p.wfs || [] }, () => {
        renderRules(); renderWorkflows();
        alert(`Loaded profile "${p.name}".`);
      }));
    }));

    document.getElementById("prof-update").addEventListener("click", () => withProfiles((profs) => {
      const p = selectedProfile(profs);
      if (!p) { alert("Select a profile first."); return; }
      if (!confirm(`Overwrite "${p.name}" with the CURRENT rules + workflows?`)) return;
      currentSnapshot((snap) => {
        const next = profs.map((x) => x.id === p.id ? { ...x, rules: snap.rules, wfs: snap.wfs, savedAt: Date.now() } : x);
        chrome.storage.local.set({ [PROF_KEY]: next }, renderProfiles);
      });
    }));

    document.getElementById("prof-delete").addEventListener("click", () => withProfiles((profs) => {
      const p = selectedProfile(profs);
      if (!p) { alert("Select a profile first."); return; }
      if (!confirm(`Delete profile "${p.name}"? (The active rules/workflows are not affected.)`)) return;
      chrome.storage.local.set({ [PROF_KEY]: profs.filter((x) => x.id !== p.id) }, renderProfiles);
    }));

    renderProfiles();
  }

  // ══ Workflows ═════════════════════════════════════════════════════════════
  const WF_KEY = "autoWorkflows";
  const STATUS_KEY = "acRunStatus";
  const wfListEl = document.getElementById("wf-list");
  const wfKnown = new Set();
  const wfSettingsOpen = new Set(); // workflow ids whose settings panel is expanded
  const wfCollapsed = new Set();    // collapsed (hidden body) workflow ids
  let draggedWfId = null;
  let liveStatus = {};

  const STEP_LABEL = {
    button: "CLICK", click: "CLICK", input: "FILL", dropdown: "SELECT",
    checkbox: "CHECK", radio: "RADIO", waitFor: "WAIT+", waitGone: "WAIT-", wait: "DELAY", delay: "DELAY",
    capture: "GET", if: "IF", else: "ELSE", endif: "END IF", loopStart: "LOOP", loopEnd: "END LOOP",
  };
  const MARKER_TYPES = new Set(["else", "endif", "loopEnd"]);       // no fields, minimal row
  const NO_HIGHLIGHT = new Set(["wait", "delay", "else", "endif", "loopEnd", "loopStart"]);

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

  const uid = () => Date.now() + Math.floor(Math.random() * 1000);

  function patchWorkflow(wfId, patch) {
    withWorkflows((wfs) => saveWorkflows(wfs.map((w) => String(w.id) === String(wfId) ? { ...w, ...patch } : w), renderWorkflows));
  }
  function patchStep(wfId, stepId, patch) {
    withWorkflows((wfs) => saveWorkflows(wfs.map((w) => String(w.id) !== String(wfId) ? w
      : { ...w, steps: (w.steps || []).map((s) => String(s.id) === String(stepId) ? { ...s, ...patch } : s) }), renderWorkflows));
  }
  function removeStep(wfId, stepId) {
    withWorkflows((wfs) => saveWorkflows(wfs.map((w) => String(w.id) !== String(wfId) ? w
      : { ...w, steps: (w.steps || []).filter((s) => String(s.id) !== String(stepId)) }), renderWorkflows));
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
  function addWaitStep(wfId, type) {
    const step = type === "wait"
      ? { id: uid(), type: "wait", name: "Delay", waitMs: 1000 }
      : { id: uid(), type, name: type === "waitFor" ? "Wait for element" : "Wait until gone", requiredElements: [""], selector: "", timeoutMs: 15000 };
    withWorkflows((wfs) => saveWorkflows(wfs.map((w) => String(w.id) === String(wfId) ? { ...w, steps: [...(w.steps || []), step] } : w), renderWorkflows));
  }
  function deleteWorkflow(wfId) {
    if (!confirm("Delete this workflow?")) return;
    withWorkflows((wfs) => saveWorkflows(wfs.filter((w) => String(w.id) !== String(wfId)), renderWorkflows));
  }
  function addWorkflow() {
    withWorkflows((wfs) => { const wf = { id: uid(), name: `Workflow ${wfs.length + 1}`, steps: [] }; saveWorkflows([...wfs, wf], renderWorkflows); });
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
  function addStep(wfId, step) {
    withWorkflows((wfs) => saveWorkflows(wfs.map((w) => String(w.id) === String(wfId) ? { ...w, steps: [...(w.steps || []), step] } : w), renderWorkflows));
  }
  function addSteps(wfId, arr) {
    withWorkflows((wfs) => saveWorkflows(wfs.map((w) => String(w.id) === String(wfId) ? { ...w, steps: [...(w.steps || []), ...arr] } : w), renderWorkflows));
  }
  function addCapture(wfId) { addStep(wfId, { id: uid(), type: "capture", name: "Capture", requiredElements: [""], selector: "", varName: "myVar", captureSource: "text", timeoutMs: 8000 }); }
  function addIf(wfId)   { addSteps(wfId, [{ id: uid(), type: "if", name: "If", requiredElements: [""], selector: "", condition: "visible", value: "" }, { id: uid(), type: "endif", name: "End if" }]); }
  function addElse(wfId) { addStep(wfId, { id: uid(), type: "else", name: "Else" }); }
  function addLoop(wfId) { addSteps(wfId, [{ id: uid(), type: "loopStart", name: "Loop", loopMode: "count", count: 2, requiredElements: [""], selector: "" }, { id: uid(), type: "loopEnd", name: "End loop" }]); }

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
    opts.forEach((o) => { const op = document.createElement("option"); op.value = o; op.textContent = o; s.appendChild(op); });
    s.value = value; s.addEventListener("change", (e) => onchange(e.target.value)); return s;
  }

  function stepFields(wf, step) {
    const P = (patch) => patchStep(wf.id, step.id, patch);
    const selVal = (step.requiredElements && step.requiredElements[0]) || step.selector || "";
    const isDelay = step.type === "wait" || step.type === "delay";
    const isWait = step.type === "waitFor" || step.type === "waitGone";
    const isText = step.type === "if" && (step.condition === "textIncludes" || step.condition === "textEquals");
    const fields = [];

    // ── loop marker ──
    if (step.type === "loopStart") {
      fields.push(fieldRow("Repeat", sel(step.loopMode || "count", ["count", "while"], (v) => P({ loopMode: v }))));
      if ((step.loopMode || "count") === "while") fields.push(fieldRow("While selector visible", txt(selVal, "CSS / xpath= / text=  (a || b = fallback)", (v) => P({ requiredElements: [v], selector: v }))));
      else fields.push(fieldRow("Times", num(step.count == null ? 2 : step.count, (v) => P({ count: v }))));
      return fields;
    }
    // ── conditional ──
    if (step.type === "if") {
      fields.push(fieldRow("Selector", txt(selVal, "CSS / xpath= / text=  (a || b = fallback)", (v) => P({ requiredElements: [v], selector: v }))));
      fields.push(fieldRow("Condition", sel(step.condition || "visible", ["visible", "hidden", "textIncludes", "textEquals"], (v) => P({ condition: v }))));
      if (isText) fields.push(fieldRow("Text", txt(step.value, "", (v) => P({ value: v }))));
      return fields;
    }
    // ── capture into a variable ──
    if (step.type === "capture") {
      fields.push(fieldRow("Selector", txt(selVal, "CSS / xpath= / text=  (a || b = fallback)", (v) => P({ requiredElements: [v], selector: v }))));
      fields.push(fieldRow("Variable name", txt(step.varName, "e.g. name", (v) => P({ varName: v }))));
      fields.push(fieldRow("Read", sel(step.captureSource || "text", ["text", "value"], (v) => P({ captureSource: v }))));
      return fields;
    }

    // ── action / wait steps ──
    if (!isDelay) fields.push(fieldRow("Selector", txt(selVal, "CSS / xpath= / text=  (a || b = fallback)", (v) => P({ requiredElements: [v], selector: v }))));
    if (step.type === "input") fields.push(fieldRow("Fill value", txt(step.fillValue, "text or {{column}}", (v) => P({ fillValue: v }))));
    if (step.type === "dropdown") {
      fields.push(fieldRow("Select value", txt(step.selectValue, "text or {{column}}", (v) => P({ selectValue: v }))));
      fields.push(fieldRow("Match by", sel(step.selectMatchBy || "value", ["value", "text"], (v) => P({ selectMatchBy: v }))));
    }
    if (step.type === "checkbox" || step.type === "radio") fields.push(fieldRow("Target state", sel(step.targetState || "checked", ["checked", "unchecked", "toggle"], (v) => P({ targetState: v }))));
    if (isDelay) fields.push(fieldRow("Delay (ms)", num(step.waitMs, (v) => P({ waitMs: v }))));
    if (isWait || !isDelay) fields.push(fieldRow(isWait ? "Timeout (ms)" : "Element timeout (ms)", num(step.timeoutMs == null ? (isWait ? 15000 : 8000) : step.timeoutMs, (v) => P({ timeoutMs: v }))));

    const optWrap = document.createElement("div"); optWrap.className = "check-row";
    const opt = document.createElement("input"); opt.type = "checkbox"; opt.checked = !!step.optional;
    opt.addEventListener("change", (e) => P({ optional: e.target.checked }));
    const optl = document.createElement("label"); optl.textContent = "Optional (skip if it fails)";
    optWrap.append(opt, optl); fields.push(optWrap);
    return fields;
  }

  function renderStepCard(wf, step, index, total, activeIndex, depth) {
    const isMarker = MARKER_TYPES.has(step.type);
    const card = document.createElement("div");
    card.className = "wf-step" + (isMarker ? " wf-step-marker" : "") + (activeIndex === index ? " wf-step-active" : "");
    if (depth > 0) card.style.marginLeft = Math.min(depth, 4) * 14 + "px";

    const head = document.createElement("div"); head.className = "wf-step-head";
    const numTag = document.createElement("span"); numTag.className = "wf-step-num"; numTag.textContent = index + 1;
    const badge = document.createElement("span"); badge.className = `type-badge type-badge--${step.type}`; badge.textContent = STEP_LABEL[step.type] || "STEP";
    const up = mini("↑", () => moveStep(wf.id, step.id, -1));
    const down = mini("↓", () => moveStep(wf.id, step.id, +1));
    const del = mini("×", () => removeStep(wf.id, step.id), true);

    // Block markers (else / endif / end loop) are a single compact row.
    if (isMarker) {
      const lbl = document.createElement("span"); lbl.className = "wf-marker-label"; lbl.textContent = stepSummary(step);
      head.append(numTag, badge, lbl, up, down, del);
      card.append(head);
      return card;
    }

    const name = document.createElement("input"); name.className = "wf-step-name"; name.value = step.name || step.type;
    name.addEventListener("change", (e) => patchStep(wf.id, step.id, { name: e.target.value }));
    const hi = mini("◎", () => { const s = (step.requiredElements && step.requiredElements[0]) || step.selector; if (s) sendToPage({ action: "HIGHLIGHT_ELEMENT", selector: s }); });
    hi.title = "Flash this element on the page";
    hi.disabled = NO_HIGHLIGHT.has(step.type);
    head.append(numTag, badge, name, up, down, hi, del);

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
      const trig = txt(wf.triggerSelector, "CSS selector (blank = first step)", (v) => patchWorkflow(wf.id, { triggerSelector: v }));
      const trigRow = fieldRow("Trigger element (runs when it appears)", trig);
      const trigBtns = document.createElement("div"); trigBtns.className = "wf-data-row";
      trigBtns.append(
        mini("Pick", () => startPicker({ forWorkflowTrigger: true, workflowId: wf.id })),
        mini("◎ Highlight", () => { const s = (wf.triggerSelector || "").trim(); if (s) sendToPage({ action: "HIGHLIGHT_ELEMENT", selector: s }); else alert("Set a trigger selector first (or it uses the first step)."); }),
      );
      trigRow.append(trigBtns);
      panel.append(trigRow);
      const th = document.createElement("div"); th.className = "wf-data-hint";
      th.textContent = "Auto-run fires once when the element appears; it re-arms after the element disappears. Leave the selector blank to use the first step's element.";
      panel.append(th);
    }
    panel.append(fieldRow("Hotkey (e.g. Alt+1)", txt(wf.hotkey, "Ctrl+Shift+K", (v) => patchWorkflow(wf.id, { hotkey: v }))));

    // Human-like: random reaction pause before actions + varied step gaps.
    const humWrap = document.createElement("div"); humWrap.className = "check-row";
    const hum = document.createElement("input"); hum.type = "checkbox"; hum.checked = !!wf.humanize;
    hum.addEventListener("change", (e) => patchWorkflow(wf.id, { humanize: e.target.checked }));
    const humLbl = document.createElement("label"); humLbl.textContent = "Human-like delays (randomized timing)";
    humWrap.append(hum, humLbl); panel.append(humWrap);

    panel.append(fieldRow("Repeat", sel(repeat.mode || "off", ["off", "count", "whileVisible", "perRow"], (v) => patchRepeat(wf.id, { mode: v }))));
    if (repeat.mode === "count") panel.append(fieldRow("Times", num(repeat.count == null ? 1 : repeat.count, (v) => patchRepeat(wf.id, { count: v }))));
    if (repeat.mode === "whileVisible") panel.append(fieldRow("While selector visible", txt(repeat.whileSelector, "CSS / xpath= / text=  (a || b = fallback)", (v) => patchRepeat(wf.id, { whileSelector: v }))));

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

  function renderWorkflowCard(wf) {
    const running = liveStatus.running && String(liveStatus.id) === String(wf.id);
    const paused = running && liveStatus.paused;
    const activeIndex = running ? liveStatus.stepIndex : -1;

    const id = String(wf.id);
    const collapsed = wfCollapsed.has(id);
    const card = document.createElement("div"); card.className = "wf-card" + (running ? " wf-card-running" : "");

    const head = document.createElement("div"); head.className = "wf-head";
    const dragHandle = document.createElement("span"); dragHandle.className = "drag-handle wf-drag"; dragHandle.textContent = "☰"; dragHandle.title = "Drag to reorder";
    const name = document.createElement("input"); name.className = "wf-name"; name.value = wf.name || "Workflow";
    name.addEventListener("change", (e) => patchWorkflow(wf.id, { name: e.target.value }));

    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.className = "wf-run" + (running ? " wf-run-stop" : "");
    runBtn.textContent = running ? "■ Stop" : "▶ Run";
    runBtn.onclick = () => running ? sendToPage({ action: "STOP_WORKFLOW" }) : sendToPage({ action: "RUN_WORKFLOW", workflowId: wf.id });

    const pauseBtn = document.createElement("button");
    pauseBtn.type = "button";
    pauseBtn.className = "wf-mini";
    pauseBtn.textContent = paused ? "▶" : "❚❚";
    pauseBtn.title = paused ? "Resume" : "Pause";
    pauseBtn.style.display = running ? "" : "none";
    pauseBtn.onclick = () => sendToPage({ action: paused ? "RESUME_WORKFLOW" : "PAUSE_WORKFLOW" });

    const recBtn = mini("● Rec", () => {
      sendToPage({ action: "START_RECORD", workflowId: wf.id }, (ok) => { if (ok) window.close(); });
    });
    recBtn.title = "Record on the page — your clicks, typing and dropdown picks become steps";
    recBtn.classList.add("wf-rec");

    const gear = mini("⚙", () => { wfSettingsOpen.has(id) ? wfSettingsOpen.delete(id) : wfSettingsOpen.add(id); renderWorkflows(); });
    gear.title = "Workflow settings (hotkey, repeat, data)";
    const collapseBtn = mini(collapsed ? "Show" : "Hide", () => { wfCollapsed.has(id) ? wfCollapsed.delete(id) : wfCollapsed.add(id); renderWorkflows(); });
    const del = mini("Delete", () => deleteWorkflow(wf.id), true);

    head.append(dragHandle, name, runBtn, pauseBtn, recBtn, gear, collapseBtn, del);

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

    // steps (indented by loop/if nesting)
    const stepsWrap = document.createElement("div"); stepsWrap.className = "wf-steps";
    const steps = wf.steps || [];
    if (!steps.length) { const e = document.createElement("div"); e.className = "wf-empty"; e.textContent = "No steps yet — add one below."; stepsWrap.appendChild(e); }
    else {
      const depths = computeDepths(steps);
      steps.forEach((s, i) => stepsWrap.appendChild(renderStepCard(wf, s, i, steps.length, activeIndex, depths[i])));
    }

    // add-step toolbar
    const add = document.createElement("div"); add.className = "wf-add-row";
    add.append(
      mini("+ Pick element", () => startPicker({ forWorkflow: true, workflowId: wf.id })),
      mini("+ Wait for", () => addWaitStep(wf.id, "waitFor")),
      mini("+ Wait gone", () => addWaitStep(wf.id, "waitGone")),
      mini("+ Delay", () => addWaitStep(wf.id, "wait")),
      mini("+ Capture", () => addCapture(wf.id)),
      mini("+ If", () => addIf(wf.id)),
      mini("+ Else", () => addElse(wf.id)),
      mini("+ Loop", () => addLoop(wf.id)),
    );

    card.append(head, status);
    if (!collapsed) {
      if (settings) card.append(settings);
      card.append(stepsWrap, add);
    }

    // Drag to reorder workflows — only from the ☰ handle (inputs don't hijack it).
    card.draggable = false;
    dragHandle.addEventListener("mousedown", () => { card.draggable = true; });
    dragHandle.addEventListener("mouseup", () => { card.draggable = false; });
    card.addEventListener("dragstart", (e) => { draggedWfId = id; e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", id); } catch (_) {} card.classList.add("dragging"); });
    card.addEventListener("dragend", () => { card.classList.remove("dragging"); card.draggable = false; draggedWfId = null; });
    card.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; card.classList.add("drag-over"); });
    card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
    card.addEventListener("drop", (e) => {
      e.preventDefault(); card.classList.remove("drag-over");
      const src = draggedWfId || e.dataTransfer.getData("text/plain");
      if (src && String(src) !== id) reorderWorkflows(src, id);
    });
    return card;
  }

  function renderWorkflows() {
    if (!wfListEl) return;
    chrome.storage.local.get([WF_KEY, STATUS_KEY], (res) => {
      const wfs = res[WF_KEY] || [];
      liveStatus = res[STATUS_KEY] || {};
      wfListEl.textContent = "";
      if (!wfs.length) {
        const e = document.createElement("div"); e.className = "logs-empty";
        e.textContent = "No workflows yet — create one to build a step sequence.";
        wfListEl.appendChild(e); return;
      }
      wfs.forEach((wf) => wfListEl.appendChild(renderWorkflowCard(wf)));
    });
  }

  const wfAddBtn = document.getElementById("wf-add");
  if (wfAddBtn) wfAddBtn.onclick = addWorkflow;

  // Keep in sync if rules / workflows / status / toggle change elsewhere.
  chrome.storage.onChanged.addListener((c, a) => {
    if (a !== "local") return;
    if (c[RULES_KEY] || c.autoButtons) renderRules();
    if (c[WF_KEY] || c[STATUS_KEY]) renderWorkflows();
    if (c.moduleAutoClicker || c.moduleAutoFillRules || c.moduleAutoSelect || c.moduleWorkflows) refreshOffTag();
  });

  refreshOffTag();
  renderRules();
  renderWorkflows();
});
