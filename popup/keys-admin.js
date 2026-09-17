// Keys admin tab — create / edit / reset / revoke / delete license keys.
// Only functional for the master key (the tab is hidden otherwise, and the
// server rejects these calls unless the request carries a master key).
document.addEventListener("DOMContentLoaded", () => {
  if (!window.NkLicense) return;

  const TOOL_LABELS = {
    autofill: "Mutamer Details Fill",
    issuedate: "Issue Date Calc",
    vaccine: "Vaccine Upload",
    ocr: "Passport OCR (page scan)",
    father: "Father Name fill",
    batch: "Batch Passports",
    // autoclick/fillrules/autoselect merged into one "autorules" tool — kept
    // here (not shown in TOOL_GROUPS below) only so an old key's saved label
    // still renders somewhere if ever inspected directly; new/edited keys
    // should use "autorules" going forward.
    autorules: "Automation Rules (click/fill/select)",
    fillrules: "Autofill (fill rules) — legacy id",
    autoclick: "Auto Clicker — legacy id",
    autoselect: "Auto Select — legacy id",
    workflows: "Workflows",
    urlshift: "URL Shifter",
    groups: "Groups Export",
    brnrequest: "BRN Request",
    translaterules: "Translation Rules",
    packagecreator: "Package Creator",
    mvtotals: "Mutamer/Voucher Totals",
    bulk: "Bulk Parser",
    reload: "Auto Reload",
    overlay: "Disable Overlay",
    filetools: "PDF-JPG Tools",
    mediagrabber: "Media Grabber",
  };
  // Tools grouped the way they appear in the extension. Each group header is a
  // select-all checkbox: clicking it checks/unchecks every tool inside it.
  // NOTE: editing and saving a key that still carries an old legacy id
  // (autoclick/fillrules/autoselect) will replace it with "autorules" here —
  // that's fine, the two are equivalent entitlements; see featOK("autorules")
  // in modules/auto-clicker.js / popup.js for the read-side backward compat.
  const TOOL_GROUPS = [
    { name: "Mutamer Details Fill", tools: ["autofill", "translaterules", "issuedate", "vaccine", "ocr", "father", "batch"] },
    { name: "Automation",           tools: ["autorules", "workflows", "urlshift", "brnrequest", "packagecreator"] },
    { name: "Passport Parser",      tools: ["bulk"] },
    { name: "Utilities",            tools: ["reload", "overlay", "mvtotals", "groups", "talabcopy", "autodatepicker"] },
    { name: "File Tools",           tools: ["filetools", "mediagrabber"] },
  ];

  // Icon-only row buttons (Edit/Reset/Revoke/Del) — same visual language as
  // the automation tabs' icon toolbars, with a title tooltip standing in for
  // the label text that used to be printed on the button.
  const K_ICON = {
    copy:   '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    check:  '<polyline points="20 6 9 17 4 12"/>',
    edit:   '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
    reset:  '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
    revoke: '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>',
    trash:  '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  };
  function kIconSvg(iconName) {
    return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">${K_ICON[iconName] || ""}</svg>`;
  }
  function kIconBtn(iconName, title, fn, danger) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "k-mini k-icon-btn" + (danger ? " k-mini-danger" : "");
    b.innerHTML = kIconSvg(iconName);
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("click", fn);
    return b;
  }
  // Copies the key text, flashes a checkmark for a beat, then reverts —
  // self-contained feedback since keys-admin.js is a separate script from
  // popup.js's own toast helper (showToast), not worth wiring cross-file for
  // one small confirmation.
  function kCopyBtn(key) {
    const b = kIconBtn("copy", "Copy key", () => {
      navigator.clipboard.writeText(key).then(() => {
        b.innerHTML = kIconSvg("check");
        b.classList.add("k-copy-done");
        setTimeout(() => { b.innerHTML = kIconSvg("copy"); b.classList.remove("k-copy-done"); }, 1200);
      }).catch(() => {});
    });
    return b;
  }

  const $ = (id) => document.getElementById(id);
  const nameEl = $("k-name"), keyEl = $("k-key"), seatsEl = $("k-seats");
  const allEl = $("k-all"), toolsEl = $("k-tools");
  const yearsEl = $("k-years"), monthsEl = $("k-months"), daysEl = $("k-days"), dateEl = $("k-expiry");
  const saveBtn = $("k-save"), cancelBtn = $("k-cancel"), msgEl = $("k-msg");
  const titleEl = $("k-form-title"), listEl = $("k-list"), countEl = $("k-count");
  const refreshBtn = $("k-refresh"), tabBtn = $("tab-keys");
  const formSection = $("k-form-section"), addToggleBtn = $("k-add-toggle");
  const searchEl = $("k-search");
  if (!listEl) return;

  // ── Show / hide the create/edit form behind the + button ──────
  function showForm() {
    if (formSection) formSection.style.display = "";
    if (addToggleBtn) { addToggleBtn.classList.add("k-add-toggle-open"); addToggleBtn.title = "Hide form"; }
  }
  function hideForm() {
    if (formSection) formSection.style.display = "none";
    if (addToggleBtn) { addToggleBtn.classList.remove("k-add-toggle-open"); addToggleBtn.title = "Create a new key"; }
  }
  if (addToggleBtn) addToggleBtn.addEventListener("click", () => {
    const open = formSection && formSection.style.display !== "none";
    if (open) { hideForm(); resetForm(); } else { resetForm(); showForm(); }
  });

  let editing = null;   // { key, devices, master, expires } when editing
  let loaded  = false;  // have we fetched the list yet?
  let allKeys = [];     // full unfiltered list from the last /admin/list — k-search filters this client-side

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
  // 6-char alphanumeric tail, e.g. "A8B8C8" — used both for a fresh
  // auto-generated key and appended to any custom key the admin types.
  function randCode6() {
    const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let s = "";
    for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return s;
  }
  // Blank key field → NUSKO-<first word of customer name>-<random 6>.
  function genKey(name) {
    const firstWord = (name || "Customer").trim().split(/\s+/)[0].replace(/[^a-zA-Z0-9]/g, "").toUpperCase() || "CUSTOMER";
    return `NUSKO-${firstWord}-${randCode6()}`;
  }
  // Custom key typed in → always gets -<random 6> appended, so two admins
  // typing the same friendly name can never collide.
  function withRandomSuffix(customKey) {
    return `${customKey.trim().replace(/-+$/, "")}-${randCode6()}`;
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

  // "2027-01-11" → "1 year 6 months left" (shows the two most significant
  // non-zero units, same calendar math as the create/edit form's duration boxes).
  function timeLeftText(expiresStr) {
    const target = parseLocal(expiresStr);
    if (!target) return "";
    const t0 = today0();
    if (target < t0) return "Expired";
    if (target.getTime() === t0.getTime()) return "Expires today";
    const { y, m, d } = diffYMD(t0, target);
    const unit = (n, s) => `${n} ${s}${n === 1 ? "" : "s"}`;
    if (y > 0) return (m > 0 ? `${unit(y, "year")} ${unit(m, "month")}` : unit(y, "year")) + " left";
    if (m > 0) return (d > 0 ? `${unit(m, "month")} ${unit(d, "day")}` : unit(m, "month")) + " left";
    return unit(d, "day") + " left";
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
  // Summarize by GROUP instead of listing every individual tool id — e.g.
  // "Mutamer Details Fill" / "Automation (partial)" as separate lines
  // instead of a wall of 11 comma-separated tool names. A group name alone
  // means every tool in it is included; "(partial)" means only some are.
  function toolLines(k) {
    if (k.master) return ["MASTER (all)"];
    if (k.features === null) return ["All tools"];
    const feats = k.features || [];
    if (!feats.length) return ["none"];
    const featSet = new Set(feats);
    const parts = TOOL_GROUPS.map((grp) => {
      const have = grp.tools.filter((t) => featSet.has(t)).length;
      if (!have) return null;
      return have === grp.tools.length ? grp.name : `${grp.name} (partial)`;
    }).filter(Boolean);
    // Any tool id that isn't in a known group (future-proofing) still shows up by name.
    const knownTools = new Set(TOOL_GROUPS.flatMap((g) => g.tools));
    feats.filter((f) => !knownTools.has(f)).forEach((f) => parts.push(TOOL_LABELS[f] || f));
    return parts.length ? parts : ["none"];
  }
  function render(keys, searching) {
    countEl.textContent = `(${keys.length})`;
    if (!keys.length) {
      listEl.innerHTML = `<div class="logs-empty">${searching ? "No keys match your search" : "No keys yet"}</div>`;
      return;
    }
    listEl.innerHTML = "";
    keys.forEach((k) => {
      const row = document.createElement("div");
      row.className = "k-item" + (k.revoked ? " k-item-revoked" : "");
      const seats = k.seats == null ? "?" : k.seats;
      const used = Array.isArray(k.devices) ? k.devices.length : 0;
      const left = k.expires ? timeLeftText(k.expires) : "";
      const exp = k.expires ? `Exp: ${esc(k.expires)}${left ? ` (${esc(left)})` : ""}` : "No expiry";
      // Devices / each tool group / expiry each get their own line instead
      // of being crammed into a single run-on line.
      const metaLines = k.revoked
        ? ["REVOKED"]
        : [`${used}/${seats} devices`, ...toolLines(k).map(esc), exp];
      row.innerHTML =
        `<div class="k-item-main">` +
          `<div class="k-item-key">${esc(k.key)}</div>` +
          `<div class="k-item-name">${esc(k.name)}</div>` +
          `<div class="k-item-meta">${metaLines.map((l) => `<div>${l}</div>`).join("")}</div>` +
        `</div><div class="k-item-btns"></div>`;
      const btns = row.querySelector(".k-item-btns");
      btns.append(kCopyBtn(k.key));
      if (k.master) {
        const tag = document.createElement("span"); tag.className = "k-master-tag"; tag.textContent = "master";
        btns.appendChild(tag);
      } else {
        btns.append(
          kIconBtn("edit", "Edit this key", () => loadForEdit(k)),
          // This IS "clean all (old) devices" — it frees every device seat
          // on the key, so a customer who's hit their device limit (or
          // shows more devices used than seats, e.g. after you lowered
          // seats) gets a clean slate.
          kIconBtn("reset", "Clear all devices — frees every seat on this key", () => resetDevices(k)),
        );
        if (!k.revoked) btns.append(kIconBtn("revoke", "Revoke this key — stops working immediately", () => revokeKey(k), true));
        btns.append(kIconBtn("trash", "Delete this key permanently", () => deleteKey(k), true));
      }
      listEl.appendChild(row);
    });
  }

  // Filters the last-fetched list client-side by key text or customer name —
  // matches how every other list in this popup (rules, workflows, logs)
  // already searches, just against the two fields an admin actually
  // recognizes a key by.
  function applyFilter() {
    const q = (searchEl && searchEl.value || "").trim().toLowerCase();
    const filtered = q
      ? allKeys.filter((k) => (k.key || "").toLowerCase().includes(q) || (k.name || "").toLowerCase().includes(q))
      : allKeys;
    render(filtered, !!q);
  }
  // Persisted across popup close/reopen, same as every other search box in
  // this popup (Fill Rules, Click Rules, Logs, …) — restore it before the
  // first render so reopening the popup doesn't silently drop the filter.
  const SEARCH_STORAGE_KEY = "keysSearch";
  if (searchEl) {
    chrome.storage.local.get([SEARCH_STORAGE_KEY], (res) => {
      searchEl.value = res[SEARCH_STORAGE_KEY] || "";
      applyFilter();
    });
    searchEl.addEventListener("input", () => {
      chrome.storage.local.set({ [SEARCH_STORAGE_KEY]: searchEl.value });
      applyFilter();
    });
  }

  let loading = false;
  async function refresh() {
    if (loading) return;
    loading = true; loaded = true;
    listEl.innerHTML = '<div class="logs-empty">Loading…</div>';
    const r = await window.NkLicense.adminList();
    loading = false;
    if (r && r.ok) { allKeys = r.keys || []; applyFilter(); }
    else listEl.innerHTML = `<div class="logs-empty">${esc((r && r.error) || "Failed to load")}</div>`;
  }

  // ── form actions ───────────────────────────────────────────
  function loadForEdit(k) {
    showForm();
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
    const typedKey = keyEl.value.trim();
    const key = editing ? editing.key : (typedKey ? withRandomSuffix(typedKey) : genKey(name));

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
    if (!(await window.nkConfirm(`Free all device seats on ${k.key}?`, { confirmText: "Reset devices", danger: true }))) return;
    const record = { name: k.name, seats: k.seats || 4, devices: [] };
    if (k.features !== null) record.features = k.features;
    if (k.expires) record.expires = k.expires;
    const r = await window.NkLicense.adminPut(k.key, record);
    if (r && r.ok) refresh(); else setMsg("✗ " + ((r && r.error) || "Failed"), "err");
  }
  async function revokeKey(k) {
    if (!(await window.nkConfirm(`Revoke ${k.key}? It stops working immediately.`, { confirmText: "Revoke", danger: true }))) return;
    const r = await window.NkLicense.adminRevoke(k.key);
    if (r && r.ok) refresh(); else setMsg("✗ " + ((r && r.error) || "Failed"), "err");
  }
  async function deleteKey(k) {
    if (!(await window.nkConfirm(`Delete ${k.key} permanently?`, { confirmText: "Delete", danger: true }))) return;
    const r = await window.NkLicense.adminDelete(k.key);
    if (r && r.ok) refresh(); else setMsg("✗ " + ((r && r.error) || "Failed"), "err");
  }

  // ── wire up ────────────────────────────────────────────────
  saveBtn.addEventListener("click", save);
  cancelBtn.addEventListener("click", () => { resetForm(); hideForm(); });
  refreshBtn.addEventListener("click", refresh);
  if (tabBtn) tabBtn.addEventListener("click", () => { if (!loaded) refresh(); });

  window.NkLicense.getStatus().then((st) => { if (st.master) refresh(); });
  chrome.storage.onChanged.addListener((c, a) => {
    if (a === "local" && c.licenseMaster) window.NkLicense.getStatus().then((st) => { if (st.master && !loaded) refresh(); });
  });
});
