// Auto Clicker — rules manager for the "Clicker" tab.
// Rules are stored in chrome.storage.local under "autoClickRules" and executed
// by modules/auto-clicker.js on the Masar page. The enable toggle lives in the
// Modules tab (moduleAutoClicker); this panel only creates/edits rules.
document.addEventListener("DOMContentLoaded", () => {
  const RULES_KEY = "autoClickRules";
  const SEARCH_KEY = "autoClickRuleSearch";
  const TYPE_LABELS = { button: "BTN", input: "INP", dropdown: "SEL", checkbox: "CHK", radio: "RAD" };

  const listDiv = document.getElementById("ac-list");
  if (!listDiv) return;

  const searchInput = document.getElementById("ac-search");
  const offTag = document.getElementById("ac-off-tag");

  const collapsedRuleIds = new Set();
  const knownRuleIds = new Set();
  let draggedId = null; // id of the rule currently being dragged (reliable across drop)

  // ── "module off" hint ─────────────────────────────────────────────────────
  function refreshOffTag() {
    if (!offTag) return;
    chrome.storage.local.get(["moduleAutoClicker"], (res) => {
      offTag.style.display = res.moduleAutoClicker ? "none" : "";
    });
  }

  // ── Search ────────────────────────────────────────────────────────────────
  if (searchInput) {
    chrome.storage.local.get([SEARCH_KEY], (res) => { searchInput.value = res[SEARCH_KEY] || ""; });
    searchInput.addEventListener("input", (e) => {
      chrome.storage.local.set({ [SEARCH_KEY]: e.target.value });
      renderRules();
    });
  }

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

  // ── Persistence ─────────────────────────────────────────────────────────
  function saveRules(rules, callback) { chrome.storage.local.set({ [RULES_KEY]: rules }, callback); }

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
    return rule[key] !== undefined ? rule[key] : "";
  }
  function isSecondsField(key) { return key === "actionDelaySeconds" || key === "repeatIntervalSeconds"; }
  function normalizeActionType(type) { return ["run", "stop", "delay"].includes(type) ? type : "run"; }

  function setRuleValue(rule, key, value) {
    if (key === "actionType") return { ...rule, action: { ...rule.action, type: normalizeActionType(value) } };
    if (key === "actionDelaySeconds") return { ...rule, action: { ...rule.action, delayMs: Math.max(Number(value) || 0, 0) * 1000 } };
    if (key === "repeatIntervalSeconds") return { ...rule, repeatIntervalMs: Math.max(Number(value) || 0, 0) * 1000 };
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
    chrome.storage.local.get([RULES_KEY, "autoButtons", SEARCH_KEY], (res) => {
      listDiv.textContent = "";
      const rules = (res[RULES_KEY] || res.autoButtons || []).map(normalizeRule);
      const search = (res[SEARCH_KEY] || "").trim().toLowerCase();
      if (searchInput) searchInput.value = res[SEARCH_KEY] || "";

      const displayed = search ? rules.filter((r) => matchesSearch(r, search)) : rules;

      if (!displayed.length) {
        const empty = document.createElement("div");
        empty.className = "logs-empty";
        empty.textContent = rules.length ? "No rules match your search." : "No rules saved yet";
        listDiv.appendChild(empty);
        return;
      }

      displayed.forEach((rule) => {
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
        listDiv.appendChild(card);
      });

      listDiv.querySelectorAll(".enable-toggle").forEach((cb) => {
        cb.onchange = (e) => {
          const rid = e.target.dataset.id;
          saveRules(rules.map((r) => String(r.id) === rid ? { ...r, enabled: e.target.checked } : r));
        };
      });
      listDiv.querySelectorAll(".collapse-rule").forEach((btn) => {
        btn.onclick = (e) => {
          const rid = e.currentTarget.dataset.id;
          collapsedRuleIds.has(rid) ? collapsedRuleIds.delete(rid) : collapsedRuleIds.add(rid);
          renderRules();
        };
      });
      listDiv.querySelectorAll(".del-btn").forEach((btn) => {
        btn.onclick = (e) => {
          const rid = e.currentTarget.dataset.id;
          collapsedRuleIds.delete(rid);
          knownRuleIds.delete(rid);
          saveRules(rules.filter((r) => String(r.id) !== rid), renderRules);
        };
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

  // ── Toolbar ─────────────────────────────────────────────────────────────
  const addBtn = document.getElementById("ac-add");
  if (addBtn) addBtn.onclick = () => startPicker({ mode: "required" });

  const exportBtn = document.getElementById("ac-export");
  if (exportBtn) exportBtn.onclick = () => {
    chrome.storage.local.get([RULES_KEY], (res) => {
      const rules = res[RULES_KEY] || [];
      if (!rules.length) { alert("No rules to export."); return; }
      const blob = new Blob([JSON.stringify(rules, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `auto-click-rules-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  };

  const importBtn = document.getElementById("ac-import");
  const importFile = document.getElementById("ac-import-file");
  if (importBtn && importFile) importBtn.onclick = () => importFile.click();
  if (importFile) importFile.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const imported = JSON.parse(ev.target.result);
        if (!Array.isArray(imported)) throw new Error("Expected an array of rules.");
        chrome.storage.local.get([RULES_KEY], (res) => {
          const merged = [...(res[RULES_KEY] || []), ...imported];
          chrome.storage.local.set({ [RULES_KEY]: merged }, () => {
            alert(`Imported ${imported.length} rule(s). Total: ${merged.length}`);
            renderRules();
          });
        });
      } catch (err) { alert(`Import failed: ${err.message}`); }
    };
    reader.readAsText(file);
    importFile.value = "";
  });

  // ══ Workflows ═════════════════════════════════════════════════════════════
  const WF_KEY = "autoWorkflows";
  const STATUS_KEY = "acRunStatus";
  const wfListEl = document.getElementById("wf-list");
  const wfKnown = new Set();
  let liveStatus = {};

  const STEP_LABEL = {
    button: "CLICK", click: "CLICK", input: "FILL", dropdown: "SELECT",
    checkbox: "CHECK", radio: "RADIO", waitFor: "WAIT+", waitGone: "WAIT-", wait: "DELAY", delay: "DELAY",
  };

  function saveWorkflows(wfs, cb) { chrome.storage.local.set({ [WF_KEY]: wfs }, cb); }
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

  function stepSummary(step) {
    const sel = (step.requiredElements && step.requiredElements[0]) || step.selector || "—";
    switch (step.type) {
      case "wait": case "delay": return `delay ${Number(step.waitMs) || 0} ms`;
      case "waitFor":  return `wait for ${sel}`;
      case "waitGone": return `wait until gone ${sel}`;
      case "input":    return `fill "${step.fillValue || ""}"`;
      case "dropdown": return `select "${step.selectValue || ""}"`;
      case "checkbox": case "radio": return `${step.targetState || "checked"}`;
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
    const selVal = (step.requiredElements && step.requiredElements[0]) || step.selector || "";
    const isDelay = step.type === "wait" || step.type === "delay";
    const isWait = step.type === "waitFor" || step.type === "waitGone";
    const fields = [];

    if (!isDelay) fields.push(fieldRow("Selector", txt(selVal, "CSS selector", (v) => patchStep(wf.id, step.id, { requiredElements: [v], selector: v }))));
    if (step.type === "input") fields.push(fieldRow("Fill value", txt(step.fillValue, "", (v) => patchStep(wf.id, step.id, { fillValue: v }))));
    if (step.type === "dropdown") {
      fields.push(fieldRow("Select value", txt(step.selectValue, "", (v) => patchStep(wf.id, step.id, { selectValue: v }))));
      fields.push(fieldRow("Match by", sel(step.selectMatchBy || "value", ["value", "text"], (v) => patchStep(wf.id, step.id, { selectMatchBy: v }))));
    }
    if (step.type === "checkbox" || step.type === "radio") fields.push(fieldRow("Target state", sel(step.targetState || "checked", ["checked", "unchecked", "toggle"], (v) => patchStep(wf.id, step.id, { targetState: v }))));
    if (isDelay) fields.push(fieldRow("Delay (ms)", num(step.waitMs, (v) => patchStep(wf.id, step.id, { waitMs: v }))));
    if (isWait || !isDelay) fields.push(fieldRow(isWait ? "Timeout (ms)" : "Element timeout (ms)", num(step.timeoutMs == null ? (isWait ? 15000 : 8000) : step.timeoutMs, (v) => patchStep(wf.id, step.id, { timeoutMs: v }))));

    const optWrap = document.createElement("div"); optWrap.className = "check-row";
    const opt = document.createElement("input"); opt.type = "checkbox"; opt.checked = !!step.optional;
    opt.addEventListener("change", (e) => patchStep(wf.id, step.id, { optional: e.target.checked }));
    const optl = document.createElement("label"); optl.textContent = "Optional (skip if it fails)";
    optWrap.append(opt, optl); fields.push(optWrap);
    return fields;
  }

  function renderStepCard(wf, step, index, total, activeIndex) {
    const card = document.createElement("div");
    card.className = "wf-step" + (activeIndex === index ? " wf-step-active" : "");

    const head = document.createElement("div"); head.className = "wf-step-head";
    const numTag = document.createElement("span"); numTag.className = "wf-step-num"; numTag.textContent = index + 1;
    const badge = document.createElement("span"); badge.className = `type-badge type-badge--${step.type}`; badge.textContent = STEP_LABEL[step.type] || "STEP";
    const name = document.createElement("input"); name.className = "wf-step-name"; name.value = step.name || step.type;
    name.addEventListener("change", (e) => patchStep(wf.id, step.id, { name: e.target.value }));

    const up = mini("↑", () => moveStep(wf.id, step.id, -1));
    const down = mini("↓", () => moveStep(wf.id, step.id, +1));
    const canHighlight = step.type !== "wait" && step.type !== "delay";
    const hi = mini("◎", () => { const s = (step.requiredElements && step.requiredElements[0]) || step.selector; if (s) sendToPage({ action: "HIGHLIGHT_ELEMENT", selector: s }); });
    hi.title = "Flash this element on the page";
    hi.disabled = !canHighlight;
    const del = mini("×", () => removeStep(wf.id, step.id), true);

    head.append(numTag, badge, name, up, down, hi, del);

    const summary = document.createElement("div"); summary.className = "wf-step-sum"; summary.textContent = stepSummary(step);

    const body = document.createElement("div"); body.className = "wf-step-body";
    stepFields(wf, step).forEach((f) => body.append(f));

    card.append(head, summary, body);
    return card;
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

    const card = document.createElement("div"); card.className = "wf-card" + (running ? " wf-card-running" : "");

    const head = document.createElement("div"); head.className = "wf-head";
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

    const del = mini("Delete", () => deleteWorkflow(wf.id), true);

    head.append(name, runBtn, pauseBtn, del);

    // status line
    const status = document.createElement("div"); status.className = "wf-status";
    const isThis = String(liveStatus.id) === String(wf.id);
    if (running) status.textContent = `${paused ? "Paused" : "Running"} — step ${Math.min((liveStatus.stepIndex || 0) + 1, liveStatus.total)}/${liveStatus.total || (wf.steps || []).length}`;
    else if (isThis && liveStatus.lastError) { status.textContent = "✖ " + liveStatus.lastError; status.classList.add("wf-status-err"); }
    else if (isThis && liveStatus.done && !liveStatus.stopped) { status.textContent = "✔ finished"; status.classList.add("wf-status-ok"); }
    else if (isThis && liveStatus.stopped) status.textContent = "■ stopped";
    else status.textContent = `${(wf.steps || []).length} step(s)`;

    // steps
    const stepsWrap = document.createElement("div"); stepsWrap.className = "wf-steps";
    const steps = wf.steps || [];
    if (!steps.length) { const e = document.createElement("div"); e.className = "wf-empty"; e.textContent = "No steps yet — capture one below."; stepsWrap.appendChild(e); }
    else steps.forEach((s, i) => stepsWrap.appendChild(renderStepCard(wf, s, i, steps.length, activeIndex)));

    // add-step toolbar
    const add = document.createElement("div"); add.className = "wf-add-row";
    add.append(
      mini("+ Pick element", () => startPicker({ forWorkflow: true, workflowId: wf.id })),
      mini("+ Wait for", () => addWaitStep(wf.id, "waitFor")),
      mini("+ Wait gone", () => addWaitStep(wf.id, "waitGone")),
      mini("+ Delay", () => addWaitStep(wf.id, "wait")),
    );

    card.append(head, status, stepsWrap, add);
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
    if (c.moduleAutoClicker) refreshOffTag();
  });

  refreshOffTag();
  renderRules();
  renderWorkflows();
});
