// Keys admin tab — create / edit / reset / revoke / delete license keys.
// Only functional for the master key (the tab is hidden otherwise, and the
// server rejects these calls unless the request carries a master key).
document.addEventListener("DOMContentLoaded", () => {
  if (!window.NkLicense) return;

  const TOOL_LABELS = {
    autofill: "Mutamer Details Fill",
    translate: "Auto Translate",
    issuedate: "Issue Date Calc",
    vaccine: "Vaccine Upload",
    ocr: "Passport OCR (page scan)",
    father: "Father Name fill",
    batch: "Batch Passports",
    fillrules: "Autofill (fill rules)",
    autoclick: "Auto Clicker",
    autoselect: "Auto Select",
    workflows: "Workflows",
    bulk: "Bulk Parser",
    reload: "Auto Reload",
    overlay: "Disable Overlay",
  };
  // Tools grouped the way they appear in the extension. Each group header is a
  // select-all checkbox: clicking it checks/unchecks every tool inside it.
  const TOOL_GROUPS = [
    { name: "Mutamer Details Fill", tools: ["autofill", "translate", "issuedate", "vaccine", "ocr", "father", "batch"] },
    { name: "Automation",           tools: ["fillrules", "autoclick", "autoselect", "workflows"] },
    { name: "Passport Parser",      tools: ["bulk"] },
    { name: "Utilities",            tools: ["reload", "overlay"] },
  ];

  const $ = (id) => document.getElementById(id);
  const nameEl = $("k-name"), keyEl = $("k-key"), seatsEl = $("k-seats");
  const allEl = $("k-all"), toolsEl = $("k-tools");
  const yearsEl = $("k-years"), monthsEl = $("k-months"), daysEl = $("k-days"), dateEl = $("k-expiry");
  const saveBtn = $("k-save"), cancelBtn = $("k-cancel"), msgEl = $("k-msg");
  const titleEl = $("k-form-title"), listEl = $("k-list"), countEl = $("k-count");
  const refreshBtn = $("k-refresh"), tabBtn = $("tab-keys");
  if (!listEl) return;

  let editing = null;   // { key, devices, master, expires } when editing
  let loaded  = false;  // have we fetched the list yet?

  // ── tool checkboxes (grouped, with select-all group headers) ──
  TOOL_GROUPS.forEach((grp) => {
    const wrap = document.createElement("div");
    wrap.className = "k-group";
    const head = document.createElement("label");
    head.className = "k-check k-group-head";
    head.innerHTML = `<input type="checkbox" class="k-group-all" /> <b>${grp.name}</b>`;
    wrap.appendChild(head);
    grp.tools.forEach((t) => {
      const lbl = document.createElement("label");
      lbl.className = "k-check";
      lbl.innerHTML = `<input type="checkbox" class="k-tool" value="${t}" /> ${TOOL_LABELS[t] || t}`;
      wrap.appendChild(lbl);
    });
    toolsEl.appendChild(wrap);
  });
  const toolBoxes = () => [...toolsEl.querySelectorAll(".k-tool")];
  const groupEls  = () => [...toolsEl.querySelectorAll(".k-group")];

  // Header ⇄ children sync: header click sets all; child changes update the
  // header (checked = all, unchecked = none, indeterminate = some).
  function refreshGroupHeads() {
    groupEls().forEach((g) => {
      const head = g.querySelector(".k-group-all");
      const kids = [...g.querySelectorAll(".k-tool")];
      const on = kids.filter((k) => k.checked).length;
      head.checked = on === kids.length && kids.length > 0;
      head.indeterminate = on > 0 && on < kids.length;
    });
  }
  groupEls().forEach((g) => {
    const head = g.querySelector(".k-group-all");
    head.addEventListener("change", () => {
      g.querySelectorAll(".k-tool").forEach((k) => { if (!k.disabled) k.checked = head.checked; });
      refreshGroupHeads();
    });
    g.querySelectorAll(".k-tool").forEach((k) => k.addEventListener("change", refreshGroupHeads));
  });

  function syncAll() {
    const all = allEl.checked;
    toolBoxes().forEach((b) => { b.disabled = all; if (all) b.checked = false; });
    toolsEl.querySelectorAll(".k-group-all").forEach((h) => { h.disabled = all; if (all) { h.checked = false; h.indeterminate = false; } });
    toolsEl.style.opacity = all ? ".5" : "1";
    refreshGroupHeads();
  }
  allEl.addEventListener("change", syncAll);
  syncAll();

  // ── helpers ────────────────────────────────────────────────
  function genKey() {
    let h = "";
    for (let i = 0; i < 8; i++) h += "0123456789ABCDEF"[Math.floor(Math.random() * 16)];
    return "NUSK-" + h.slice(0, 4) + "-" + h.slice(4);
  }
  // ── Validity: keep the Years/Months/Days boxes and the exact-date field in
  //    sync, both ways, live. The date field is the source of truth on save.
  function today0() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  function fmtLocal(d) { const p = (n) => String(n).padStart(2, "0"); return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); }
  function parseLocal(s) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ""); if (!m) return null; const d = new Date(+m[1], +m[2] - 1, +m[3]); d.setHours(0, 0, 0, 0); return d; }

  // Calendar breakdown of (target - today) into whole years, months, days.
  function diffYMD(from, to) {
    let y = to.getFullYear() - from.getFullYear();
    let m = to.getMonth() - from.getMonth();
    let d = to.getDate() - from.getDate();
    if (d < 0) { m--; d += new Date(to.getFullYear(), to.getMonth(), 0).getDate(); }
    if (m < 0) { y--; m += 12; }
    return { y: Math.max(0, y), m: Math.max(0, m), d: Math.max(0, d) };
  }

  // duration boxes changed → recompute the exact date (programmatic .value
  // assignment does NOT fire events, so there's no feedback loop)
  function durationToDate() {
    const y = parseInt(yearsEl.value, 10) || 0;
    const m = parseInt(monthsEl.value, 10) || 0;
    const d = parseInt(daysEl.value, 10) || 0;
    if (y <= 0 && m <= 0 && d <= 0) { dateEl.value = ""; return; }
    const dt = today0();
    dt.setFullYear(dt.getFullYear() + y);
    dt.setMonth(dt.getMonth() + m);
    dt.setDate(dt.getDate() + d);
    dateEl.value = fmtLocal(dt);
  }

  // date changed → recompute the Years/Months/Days breakdown
  function dateToDuration() {
    const target = parseLocal(dateEl.value);
    if (!target) { yearsEl.value = ""; monthsEl.value = ""; daysEl.value = ""; return; }
    const { y, m, d } = diffYMD(today0(), target);
    yearsEl.value = y || ""; monthsEl.value = m || ""; daysEl.value = d || "";
  }

  [yearsEl, monthsEl, daysEl].forEach((el) => el.addEventListener("input", durationToDate));
  dateEl.addEventListener("input", dateToDuration);
  dateEl.addEventListener("change", dateToDuration);

  // On save, the date field holds the resolved expiry ("" = never).
  function computeExpiry() { return dateEl.value || ""; }
  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : s; return d.innerHTML; }
  function setMsg(t, cls) { msgEl.textContent = t || ""; msgEl.className = "act-msg" + (cls ? " " + cls : ""); }
  function selectedFeatures() { return allEl.checked ? null : toolBoxes().filter((b) => b.checked).map((b) => b.value); }

  function resetForm() {
    editing = null;
    titleEl.textContent = "Create a key";
    saveBtn.textContent = "Create key";
    cancelBtn.style.display = "none";
    nameEl.value = ""; keyEl.value = ""; keyEl.disabled = false;
    seatsEl.value = 4;
    yearsEl.value = ""; monthsEl.value = ""; daysEl.value = ""; dateEl.value = "";
    allEl.checked = true; syncAll();
    setMsg("");
  }

  // ── render the key list ────────────────────────────────────
  function toolText(k) {
    if (k.master) return "MASTER (all)";
    if (k.features === null) return "all tools";
    return k.features.length ? k.features.join(", ") : "none";
  }
  function addBtn(parent, label, fn, danger) {
    const b = document.createElement("button");
    b.className = "k-mini" + (danger ? " k-mini-danger" : "");
    b.textContent = label;
    b.addEventListener("click", fn);
    parent.appendChild(b);
  }
  function render(keys) {
    countEl.textContent = keys.length;
    if (!keys.length) { listEl.innerHTML = '<div class="logs-empty">No keys yet</div>'; return; }
    listEl.innerHTML = "";
    keys.forEach((k) => {
      const row = document.createElement("div");
      row.className = "k-item" + (k.revoked ? " k-item-revoked" : "");
      const seats = k.seats == null ? "?" : k.seats;
      const used = Array.isArray(k.devices) ? k.devices.length : 0;
      const exp = k.expires ? `· exp ${esc(k.expires)}` : "· no expiry";
      row.innerHTML =
        `<div class="k-item-main">` +
          `<div class="k-item-key">${esc(k.key)}</div>` +
          `<div class="k-item-name">${esc(k.name)}</div>` +
          `<div class="k-item-meta">${k.revoked ? "REVOKED" : `${used}/${seats} devices · ${esc(toolText(k))} ${exp}`}</div>` +
        `</div><div class="k-item-btns"></div>`;
      const btns = row.querySelector(".k-item-btns");
      if (k.master) {
        const tag = document.createElement("span"); tag.className = "k-master-tag"; tag.textContent = "master";
        btns.appendChild(tag);
      } else {
        addBtn(btns, "Edit", () => loadForEdit(k));
        addBtn(btns, "Reset", () => resetDevices(k));
        if (!k.revoked) addBtn(btns, "Revoke", () => revokeKey(k), true);
        addBtn(btns, "Del", () => deleteKey(k), true);
      }
      listEl.appendChild(row);
    });
  }

  let loading = false;
  async function refresh() {
    if (loading) return;
    loading = true; loaded = true;
    listEl.innerHTML = '<div class="logs-empty">Loading…</div>';
    const r = await window.NkLicense.adminList();
    loading = false;
    if (r && r.ok) render(r.keys || []);
    else listEl.innerHTML = `<div class="logs-empty">${esc((r && r.error) || "Failed to load")}</div>`;
  }

  // ── form actions ───────────────────────────────────────────
  function loadForEdit(k) {
    editing = { key: k.key, devices: k.devices || [], master: !!k.master, expires: k.expires || "" };
    titleEl.textContent = "Edit key";
    saveBtn.textContent = "Save changes";
    cancelBtn.style.display = "";
    nameEl.value = k.name || "";
    keyEl.value = k.key; keyEl.disabled = true;          // can't rename the key id
    seatsEl.value = k.seats || 4;
    dateEl.value = k.expires || "";                       // prefill current expiry; clear = never
    dateToDuration();                                     // sync the Years/Months/Days boxes to it
    if (k.features === null) allEl.checked = true;
    else { allEl.checked = false; toolBoxes().forEach((b) => { b.checked = k.features.includes(b.value); }); }
    syncAll();
    setMsg(`Editing ${k.key} — current expiry: ${k.expires || "never"}.`);
    nameEl.scrollIntoView({ block: "nearest" });
  }

  async function save() {
    const name = nameEl.value.trim() || "Customer";
    let seats = parseInt(seatsEl.value, 10); if (!Number.isFinite(seats) || seats < 1) seats = 4;
    const key = editing ? editing.key : (keyEl.value.trim() || genKey());

    const record = { name, seats, devices: editing ? editing.devices : [] };
    const features = selectedFeatures();
    if (features !== null) record.features = features;

    const exp = computeExpiry();             // date field, or yr/mo/day from today, or "" = never
    if (exp) record.expires = exp;
    if (editing && editing.master) record.master = true;

    saveBtn.disabled = true; setMsg("Saving…");
    const r = await window.NkLicense.adminPut(key, record);
    saveBtn.disabled = false;
    if (r && r.ok) {
      const wasCreate = !editing;
      await refresh();
      if (wasCreate) { resetForm(); setMsg("✓ Created — give this key to the customer:  " + key, "ok"); }
      else { resetForm(); setMsg("✓ Updated " + key, "ok"); }
    } else {
      setMsg("✗ " + ((r && r.error) || "Failed"), "err");
    }
  }

  async function resetDevices(k) {
    if (!confirm(`Free all device seats on ${k.key}?`)) return;
    const record = { name: k.name, seats: k.seats || 4, devices: [] };
    if (k.features !== null) record.features = k.features;
    if (k.expires) record.expires = k.expires;
    const r = await window.NkLicense.adminPut(k.key, record);
    if (r && r.ok) refresh(); else setMsg("✗ " + ((r && r.error) || "Failed"), "err");
  }
  async function revokeKey(k) {
    if (!confirm(`Revoke ${k.key}? It stops working immediately.`)) return;
    const r = await window.NkLicense.adminRevoke(k.key);
    if (r && r.ok) refresh(); else setMsg("✗ " + ((r && r.error) || "Failed"), "err");
  }
  async function deleteKey(k) {
    if (!confirm(`Delete ${k.key} permanently?`)) return;
    const r = await window.NkLicense.adminDelete(k.key);
    if (r && r.ok) refresh(); else setMsg("✗ " + ((r && r.error) || "Failed"), "err");
  }

  // ── wire up ────────────────────────────────────────────────
  saveBtn.addEventListener("click", save);
  cancelBtn.addEventListener("click", resetForm);
  refreshBtn.addEventListener("click", refresh);
  if (tabBtn) tabBtn.addEventListener("click", () => { if (!loaded) refresh(); });

  window.NkLicense.getStatus().then((st) => { if (st.master) refresh(); });
  chrome.storage.onChanged.addListener((c, a) => {
    if (a === "local" && c.licenseMaster) window.NkLicense.getStatus().then((st) => { if (st.master && !loaded) refresh(); });
  });
});
