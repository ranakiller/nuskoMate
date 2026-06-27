// Keys admin tab — create / edit / reset / revoke / delete license keys.
// Only functional for the master key (the tab is hidden otherwise, and the
// server rejects these calls unless the request carries a master key).
document.addEventListener("DOMContentLoaded", () => {
  if (!window.NkLicense) return;

  const TOOL_LABELS = {
    ocr: "Passport OCR (page scan)",
    bulk: "Bulk Parser",
    batch: "Batch Passports",
    translate: "Auto Translate",
    vaccine: "Vaccine Upload",
    issuedate: "Issue Date Calc",
    reload: "Auto Reload",
    overlay: "Disable Overlay",
  };
  const TOOLS = window.NkLicense.FEATURES || Object.keys(TOOL_LABELS);

  const $ = (id) => document.getElementById(id);
  const nameEl = $("k-name"), keyEl = $("k-key"), seatsEl = $("k-seats");
  const allEl = $("k-all"), toolsEl = $("k-tools"), monthsEl = $("k-months");
  const saveBtn = $("k-save"), cancelBtn = $("k-cancel"), msgEl = $("k-msg");
  const titleEl = $("k-form-title"), listEl = $("k-list"), countEl = $("k-count");
  const refreshBtn = $("k-refresh"), tabBtn = $("tab-keys");
  if (!listEl) return;

  let editing = null;   // { key, devices, master, expires } when editing
  let loaded  = false;  // have we fetched the list yet?

  // ── tool checkboxes ────────────────────────────────────────
  TOOLS.forEach((t) => {
    const lbl = document.createElement("label");
    lbl.className = "k-check";
    lbl.innerHTML = `<input type="checkbox" class="k-tool" value="${t}" /> ${TOOL_LABELS[t] || t}`;
    toolsEl.appendChild(lbl);
  });
  const toolBoxes = () => [...toolsEl.querySelectorAll(".k-tool")];

  function syncAll() {
    const all = allEl.checked;
    toolBoxes().forEach((b) => { b.disabled = all; if (all) b.checked = false; });
    toolsEl.style.opacity = all ? ".5" : "1";
  }
  allEl.addEventListener("change", syncAll);
  syncAll();

  // ── helpers ────────────────────────────────────────────────
  function genKey() {
    let h = "";
    for (let i = 0; i < 8; i++) h += "0123456789ABCDEF"[Math.floor(Math.random() * 16)];
    return "NUSK-" + h.slice(0, 4) + "-" + h.slice(4);
  }
  function monthsToExpiry(m) {
    const n = parseInt(m, 10);
    if (!Number.isFinite(n) || n < 1) return "";
    const d = new Date(); d.setMonth(d.getMonth() + n);
    return d.toISOString().slice(0, 10);
  }
  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : s; return d.innerHTML; }
  function setMsg(t, cls) { msgEl.textContent = t || ""; msgEl.className = "act-msg" + (cls ? " " + cls : ""); }
  function selectedFeatures() { return allEl.checked ? null : toolBoxes().filter((b) => b.checked).map((b) => b.value); }

  function resetForm() {
    editing = null;
    titleEl.textContent = "Create a key";
    saveBtn.textContent = "Create key";
    cancelBtn.style.display = "none";
    nameEl.value = ""; keyEl.value = ""; keyEl.disabled = false;
    seatsEl.value = 4; monthsEl.value = "";
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
    monthsEl.value = "";                                  // blank = keep current expiry
    if (k.features === null) allEl.checked = true;
    else { allEl.checked = false; toolBoxes().forEach((b) => { b.checked = k.features.includes(b.value); }); }
    syncAll();
    setMsg(`Editing ${k.key} — leave Months blank to keep its expiry (${k.expires || "never"}).`);
    nameEl.scrollIntoView({ block: "nearest" });
  }

  async function save() {
    const name = nameEl.value.trim() || "Customer";
    let seats = parseInt(seatsEl.value, 10); if (!Number.isFinite(seats) || seats < 1) seats = 4;
    const key = editing ? editing.key : (keyEl.value.trim() || genKey());

    const record = { name, seats, devices: editing ? editing.devices : [] };
    const features = selectedFeatures();
    if (features !== null) record.features = features;

    const newExp = monthsToExpiry(monthsEl.value);
    if (newExp) record.expires = newExp;                 // months entered → new date
    else if (editing && editing.expires) record.expires = editing.expires; // keep current
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
