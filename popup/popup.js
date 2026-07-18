document.addEventListener("DOMContentLoaded", () => {

  // ── Footer version (always reflects the manifest) ────────────
  const verEl = document.getElementById("footer-version");
  if (verEl && chrome.runtime?.getManifest) verEl.textContent = "v" + chrome.runtime.getManifest().version;

  // ── Sidebar collapse / expand (remembered) ───────────────────
  // No dedicated button: double-clicking any tab button toggles it (a single
  // click on a tab still just switches to it, as usual, same as before).
  const layoutEl = document.querySelector(".layout");
  const tabbarEl = document.querySelector(".tabbar");
  if (layoutEl && tabbarEl) {
    chrome.storage.local.get(["uiSidebarCollapsed"], (r) => {
      if (r.uiSidebarCollapsed) layoutEl.classList.add("collapsed");
    });
    tabbarEl.addEventListener("dblclick", (e) => {
      if (!e.target.closest(".tab")) return;              // only tab buttons trigger this
      const collapsed = layoutEl.classList.toggle("collapsed");
      chrome.storage.local.set({ uiSidebarCollapsed: collapsed });
    });
  }

  // ── Update check (GitHub releases) ───────────────────────────
  // Chrome can't auto-install a sideloaded extension, so we notify + one-click
  // open the new build. Compares this build's version to the latest release.
  (function checkForUpdate() {
    // Points at the public releases-only repo, NOT the (private) source repo
    // — a private repo's API/release assets require auth, which this
    // unauthenticated fetch can't provide.
    const REPO = "ranakiller/nuskomate-releases";
    const cur = (chrome.runtime?.getManifest && chrome.runtime.getManifest().version) || "0";
    const banner = document.getElementById("update-banner");
    const text   = document.getElementById("update-text");
    const btn    = document.getElementById("update-btn");
    if (!banner) return;

    const cmpVer = (a, b) => {
      const pa = String(a).split("."), pb = String(b).split(".");
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
        if (d) return d > 0 ? 1 : -1;
      }
      return 0;
    };

    fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((rel) => {
        if (!rel || !rel.tag_name) return;
        const latest = String(rel.tag_name).replace(/^v/i, "");
        if (cmpVer(latest, cur) <= 0) return; // already up to date
        // Prefer the obfuscated release .zip — NOT the "-raw" source zip
        // (build.js's --raw output, published alongside it for AMO's source
        // review requirement). Asset order from the GitHub API isn't
        // guaranteed to match upload order, so this must exclude "-raw" by
        // name rather than just grabbing the first .zip found.
        const asset = (rel.assets || []).find((a) => /\.zip$/i.test(a.name) && !/-raw\.zip$/i.test(a.name));
        const url = (asset && asset.browser_download_url) || rel.html_url;
        text.textContent = `Update available — v${latest}`;
        btn.addEventListener("click", () => {
          if (chrome.tabs?.create) chrome.tabs.create({ url }); else window.open(url, "_blank");
        });
        banner.style.display = "flex";
      })
      .catch(() => {});
  })();

  // ── Activation ──────────────────────────────────────────────
  // Every module (including Autofill) is premium now — nothing works without a
  // valid key. Each toggle is gated by its tool entitlement (TOGGLE_FEATURE);
  // until a key is entered here in Settings, all modules stay locked. The
  // crown-jewel features (OCR/parse) are ALSO enforced server-side.
  (function () {
    if (!window.NkLicense) return;
    const keyIn      = document.getElementById("act-key");
    const eye        = document.getElementById("act-eye");
    const activateBt = document.getElementById("act-activate");
    const deactivate = document.getElementById("act-deactivate");
    const entry      = document.getElementById("act-entry");
    const msg        = document.getElementById("act-msg");
    const dot        = document.getElementById("act-dot");
    const statusText = document.getElementById("act-status-text");
    const upsell     = document.getElementById("premium-upsell");
    const ppContent  = document.getElementById("passport-content");
    const upsellBtn  = document.getElementById("premium-upsell-btn");

    // Each premium toggle maps to the tool id the key must include.
    const TOGGLE_FEATURE = {
      "toggle-autofill": "autofill",
      "toggle-reload": "reload", "toggle-overlay": "overlay", "toggle-translate": "translate",
      "toggle-issue-date": "issuedate", "toggle-vaccine": "vaccine", "toggle-ocr": "ocr",
      "toggle-father": "father", "toggle-batch": "batch",
      "toggle-autoclicker": "autoclick", "toggle-workflows": "workflows",
      "toggle-autofill-rules": "fillrules", "toggle-autoselect": "autoselect",
      "toggle-urlshift": "urlshift",
    };

    // Is a given tool unlocked for the current key? (features null = all tools)
    function has(st, feat) {
      if (!st.activated) return false;
      return st.features === null || (Array.isArray(st.features) && st.features.includes(feat));
    }

    // Passport OCR, Father Name, and Batch Passports also need the
    // customer's own ocr.space key (Settings → OCR) — locked here too when
    // it's missing, on top of the normal license check, with a description
    // that explains why instead of the usual one-liner. Starts fail-closed
    // (locked) like the license check itself, until the async read confirms
    // otherwise, so there's no flash of "on" that then snaps to locked.
    const OCR_GATED_DESC = {
      "toggle-ocr": "Auto-scan passport on upload",
      "toggle-father": "Fill names from OCR (off: keep Masar's)",
      "toggle-batch": "Select many, auto-feed each",
    };
    let hasOcrKey = false;
    function refreshOcrKeyGate() {
      chrome.storage.local.get(["ocrApiKey"], (res) => {
        hasOcrKey = !!(res.ocrApiKey && res.ocrApiKey.trim());
        refresh();
      });
    }

    function applyLocks(st) {
      // Lock/unlock each premium module card by its specific tool entitlement
      Object.keys(TOGGLE_FEATURE).forEach((id) => {
        const el = document.getElementById(id);
        const card = el && el.closest(".module-card");
        if (!card) return;
        const licensed = has(st, TOGGLE_FEATURE[id]);
        const needsOcrKey = id in OCR_GATED_DESC;
        const ok = licensed && (!needsOcrKey || hasOcrKey);
        card.classList.toggle("module-locked", !ok);
        if (el) el.disabled = !ok;
        if (needsOcrKey) {
          const descEl = document.getElementById(id.replace("toggle-", "") + "-module-desc");
          if (descEl) descEl.textContent = (licensed && !hasOcrKey) ? "Add your OCR key in Settings to turn this on" : OCR_GATED_DESC[id];
        }
      });
      // Passport tab: upsell when not activated at all; otherwise show content.
      if (upsell)    upsell.style.display    = st.activated ? "none" : "block";
      if (ppContent) ppContent.style.display = st.activated ? ""     : "none";
      // The Bulk Parser section needs the "bulk" tool specifically.
      const bulkSection = document.getElementById("bulk-section");
      if (bulkSection) bulkSection.style.display = has(st, "bulk") ? "" : "none";
      // Automation tabs: each has its own tool id now.
      [["ac-upsell", "ac-content", "autoclick"], ["wf-upsell", "wf-content", "workflows"], ["as-upsell", "as-content", "autoselect"], ["us-upsell", "us-content", "urlshift"], ["fill-upsell", "fill-content", "fillrules"], ["groups-upsell", "groups-content", "groups"]].forEach(([up, ct, feat]) => {
        const ok = has(st, feat);
        const u = document.getElementById(up), c = document.getElementById(ct);
        if (u) u.style.display = ok ? "none" : "block";
        if (c) c.style.display = ok ? ""     : "none";
      });
    }

    function renderStatus(st) {
      const activated = st.activated;
      if (dot) dot.classList.toggle("on", activated);
      if (statusText) {
        let t = activated
          ? (st.name ? `Premium active — ${st.name}` : "Premium active")
          : "Not activated — enter a key to use Nuskomate";
        if (activated && st.expires) t += `  ·  expires ${st.expires}`;
        statusText.textContent = t;
      }
      if (entry)      entry.style.display      = activated ? "none" : "flex";
      if (deactivate) deactivate.style.display = activated ? "block" : "none";

      // The Keys admin tab is only visible to the master key.
      const keysTab = document.getElementById("tab-keys");
      if (keysTab) {
        keysTab.style.display = st.master ? "" : "none";
        // If we're sitting on the Keys tab but lost master, bounce to Modules.
        if (!st.master && keysTab.classList.contains("tab-active")) {
          const m = document.querySelector('[data-tab="modules"]');
          if (m) m.click();
        }
      }
      applyLocks(st);
    }

    function refresh() { window.NkLicense.getStatus().then(renderStatus); }

    // Eye toggle: reveal/hide the key (password field)
    if (eye && keyIn) {
      eye.addEventListener("click", () => {
        keyIn.type = keyIn.type === "password" ? "text" : "password";
        eye.classList.toggle("on", keyIn.type === "text");
      });
    }

    async function doActivate() {
      activateBt.disabled = true;
      msg.textContent = "Activating…";
      msg.className = "act-msg";
      const r = await window.NkLicense.activate(keyIn.value);
      activateBt.disabled = false;
      if (r.ok) {
        msg.textContent = "✓ Activated" + (r.name ? ` — ${r.name}` : "");
        msg.className = "act-msg ok";
        keyIn.value = "";
        refresh();
      } else {
        msg.textContent = "✗ " + (r.error || "Activation failed");
        msg.className = "act-msg err";
      }
    }

    if (activateBt) activateBt.addEventListener("click", doActivate);
    if (keyIn) keyIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); doActivate(); }
    });

    if (deactivate) deactivate.addEventListener("click", async () => {
      if (!confirm("Deactivate premium on this device? It frees the seat for another device.")) return;
      await window.NkLicense.deactivate();
      msg.textContent = "Deactivated"; msg.className = "act-msg";
      refresh();
    });

    // Upsell buttons → jump to Settings so the user can enter a key
    const jumpToSettings = () => {
      const tab = document.querySelector('[data-tab="settings"]');
      if (tab) tab.click();
      setTimeout(() => keyIn && keyIn.focus(), 50);
    };
    if (upsellBtn) upsellBtn.addEventListener("click", jumpToSettings);
    ["ac-upsell-btn", "wf-upsell-btn", "as-upsell-btn", "us-upsell-btn", "fill-upsell-btn", "groups-upsell-btn"].forEach((idb) => {
      const b = document.getElementById(idb);
      if (b) b.addEventListener("click", jumpToSettings);
    });

    // Keep the UI in sync if activation changes elsewhere
    chrome.storage.onChanged.addListener((c, a) => {
      if (a === "local" && c.licenseValid !== undefined) refresh();
      if (a === "local" && c.ocrApiKey !== undefined) refreshOcrKeyGate();
    });

    refresh();
    refreshOcrKeyGate();
  })();

  // ── Cloud Sync (rules + settings, tied to your license key) ──
  // One on/off switch. All the actual work (auto-push on every tracked
  // change, and the one-time pull when you flip it on) lives in background.js
  // so it keeps working even while this popup is closed — e.g. a workflow
  // step picked straight on the page writes to storage with the popup
  // already gone. This panel only displays status and flips the switch.
  (function () {
    const toggle     = document.getElementById("toggle-cloud-sync");
    const dot         = document.getElementById("sync-dot");
    const statusText  = document.getElementById("sync-status-text");
    const infoBtn     = document.getElementById("sync-info-btn");
    const infoPanel   = document.getElementById("sync-info-panel");
    const banner      = document.getElementById("sync-banner");
    if (!toggle) return;

    function renderBanner(inProgress) {
      if (banner) banner.style.display = inProgress ? "flex" : "none";
    }
    chrome.storage.local.get(["cloudSyncInProgress"], (res) => renderBanner(!!res.cloudSyncInProgress));

    if (infoBtn && infoPanel) {
      infoBtn.addEventListener("click", () => {
        const open = infoPanel.style.display !== "none";
        infoPanel.style.display = open ? "none" : "";
        infoBtn.classList.toggle("info-btn-open", !open);
      });
    }

    function render(res) {
      const on = !!res.cloudSyncEnabled;
      toggle.checked = on;
      if (!on) { statusText.textContent = "Sync is off"; statusText.className = ""; dot.classList.remove("on"); return; }
      if (res.cloudSyncLastError) {
        statusText.textContent = "Sync error: " + res.cloudSyncLastError;
        statusText.className = "err";
        dot.classList.remove("on");
      } else if (res.cloudSyncLastAt) {
        statusText.textContent = "Synced " + new Date(res.cloudSyncLastAt).toLocaleString();
        statusText.className = "";
        dot.classList.add("on");
      } else {
        statusText.textContent = "On — waiting for the first change";
        statusText.className = "";
        dot.classList.add("on");
      }
    }

    chrome.storage.local.get(["cloudSyncEnabled", "cloudSyncLastAt", "cloudSyncLastError"], render);
    chrome.storage.onChanged.addListener((c, a) => {
      if (a !== "local") return;
      if (c.cloudSyncInProgress) renderBanner(!!c.cloudSyncInProgress.newValue);
      // A pull can silently change things this popup only reads once at open
      // time (module toggles, saved email/phone, OCR key…) — reload so
      // everything reflects the freshly-pulled data instead of going stale.
      if (c.cloudSyncPulledAt) { location.reload(); return; }
      if (c.cloudSyncEnabled || c.cloudSyncLastAt || c.cloudSyncLastError) {
        chrome.storage.local.get(["cloudSyncEnabled", "cloudSyncLastAt", "cloudSyncLastError"], render);
      }
    });

    toggle.addEventListener("change", () => {
      chrome.storage.local.set({ cloudSyncEnabled: toggle.checked, cloudSyncLastError: "" });
    });

    // Popup just opened — ask the background worker to check for remote
    // changes right away, instead of waiting for the once-a-minute alarm.
    chrome.storage.local.get(["cloudSyncEnabled"], (res) => {
      if (res.cloudSyncEnabled) chrome.runtime.sendMessage({ type: "nkSyncPollNow" }, () => void chrome.runtime.lastError);
    });
  })();

  // ── Theme ───────────────────────────────────────────────────
  const THEME_KEY = "uiTheme";
  const themeButtons = {
    system: document.getElementById("theme-system"),
    light:  document.getElementById("theme-light"),
    dark:   document.getElementById("theme-dark"),
  };

  function applyTheme(preference) {
    const isDark = preference === "dark" ||
      (preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
    Object.entries(themeButtons).forEach(([key, btn]) =>
      btn.classList.toggle("active", key === preference));
  }

  chrome.storage.local.get([THEME_KEY], (res) => applyTheme(res[THEME_KEY] || "system"));
  Object.entries(themeButtons).forEach(([key, btn]) => {
    btn.addEventListener("click", () => {
      chrome.storage.local.set({ [THEME_KEY]: key });
      applyTheme(key);
    });
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    chrome.storage.local.get([THEME_KEY], (res) => {
      if ((res[THEME_KEY] || "system") === "system") applyTheme("system");
    });
  });


  // ── Master Toggle ───────────────────────────────────────────
  const masterEl     = document.getElementById("toggle-master");
  const masterStatus = document.getElementById("master-status");

  function applyMasterState(enabled) {
    masterStatus.textContent = enabled ? "On" : "Off";
    masterStatus.classList.toggle("off", !enabled);
    document.body.classList.toggle("ext-disabled", !enabled);
  }

  chrome.storage.local.get(["extensionEnabled"], (res) => {
    const enabled = res.extensionEnabled !== false;
    masterEl.checked = enabled;
    applyMasterState(enabled);
  });

  masterEl.addEventListener("change", () => {
    chrome.storage.local.set({ extensionEnabled: masterEl.checked });
    applyMasterState(masterEl.checked);
  });


  // ── Tabs ────────────────────────────────────────────────────
  const tabs   = [...document.querySelectorAll(".tab")];
  const panels = [...document.querySelectorAll(".tab-panel")];

  function activateTab(name) {
    tabs.forEach(t => t.classList.toggle("tab-active", t.dataset.tab === name));
    panels.forEach(p => p.classList.toggle("tab-panel-active", p.id === "panel-" + name));
  }

  tabs.forEach(t => t.addEventListener("click", () => {
    activateTab(t.dataset.tab);
    chrome.storage.local.set({ uiTab: t.dataset.tab });
  }));

  chrome.storage.local.get(["uiTab"], (res) => {
    if (res.uiTab && document.getElementById("panel-" + res.uiTab)) activateTab(res.uiTab);
  });


  // ── UI mode: popup ↔ side panel ─────────────────────────────
  // The side panel loads this same page with ?panel=1 so we know the context.
  const isPanel = new URLSearchParams(location.search).get("panel") === "1";
  if (isPanel) document.documentElement.classList.add("as-panel");
  const uiModeBtn = document.getElementById("ui-mode-btn");
  if (uiModeBtn) {
    uiModeBtn.title = isPanel ? "Pop out to a popup" : "Dock as a side panel";
    if (isPanel) uiModeBtn.classList.add("is-panel");
    uiModeBtn.addEventListener("click", () => {
      if (isPanel) {
        // Back to popup mode; background restores the action popup on storage change.
        chrome.storage.local.set({ uiMode: "popup" });
        setTimeout(() => window.close(), 60); // close the side panel
      } else {
        // Switch to side panel and open it within this click gesture.
        chrome.storage.local.set({ uiMode: "sidepanel" });
        try {
          chrome.windows.getCurrent((w) => {
            if (chrome.sidePanel && chrome.sidePanel.open) chrome.sidePanel.open({ windowId: w.id }).catch(() => {});
          });
        } catch (_) {}
        setTimeout(() => window.close(), 120); // close the popup
      }
    });
  }


  // ── Module Toggles ──────────────────────────────────────────
  const toggles = [
    { id: "toggle-reload",     key: "moduleReload"         },
    { id: "toggle-overlay",    key: "moduleDisableOverlay" },
    { id: "toggle-autofill",   key: "moduleAutofill"       },
    { id: "toggle-translate",  key: "moduleTranslate"      },
    { id: "toggle-issue-date", key: "moduleIssueDateCalc"  },
    { id: "toggle-vaccine",    key: "moduleVaccineUpload"  },
    { id: "toggle-ocr",       key: "moduleOcr"            },
    { id: "toggle-father",    key: "moduleFatherName"     },
    { id: "toggle-batch",     key: "moduleBatchUpload"    },
    // The 4 automation-tab toggles show "(Module off)" inline in their own
    // module-name instead of a separate pill elsewhere on the tab.
    { id: "toggle-autoclicker", key: "moduleAutoClicker", offLabel: true  },
    { id: "toggle-autofill-rules", key: "moduleAutoFillRules", offLabel: true },
    { id: "toggle-autoselect",  key: "moduleAutoSelect", offLabel: true   },
    { id: "toggle-workflows",   key: "moduleWorkflows", offLabel: true    },
    { id: "toggle-urlshift",    key: "moduleUrlShift", offLabel: true     },
  ];

  // ALL modules default ON for new installs (key never set = treat as true).
  // Actual availability still depends on activation + that specific tool
  // being included in the key's features — this only controls what the
  // toggle looks like the very first time, before the user's ever touched it.
  const defaultOnKeys = new Set(toggles.map((t) => t.key));

  // Appends/removes " (Module off)" on the module-card's own name — as a
  // separate <span> so it can be styled distinctly from the base name —
  // instead of a separate off-tag pill elsewhere on the tab.
  // IMPORTANT: .module-name also contains the inline ⓘ info button, so this
  // must never touch .textContent on the whole element (that would wipe out
  // the button along with the name — exactly the bug that turned the info
  // button into a stray "i" of plain text). Only ever add/remove the
  // dedicated suffix <span>, leaving every other child node untouched.
  function reflectModuleOffLabel(toggleEl) {
    const card = toggleEl.closest(".module-card");
    const nameEl = card && card.querySelector(".module-name");
    if (!nameEl) return;
    const existing = nameEl.querySelector(".module-off-suffix");
    if (existing) existing.remove();
    if (!toggleEl.checked) {
      const suffix = document.createElement("span");
      suffix.className = "module-off-suffix";
      suffix.textContent = " (Module off)";
      nameEl.appendChild(suffix);
    }
  }

  toggles.forEach(({ id, key, offLabel }) => {
    const el = document.getElementById(id);
    if (!el) return;
    chrome.storage.local.get([key], (res) => {
      const val = key in res ? res[key] : (defaultOnKeys.has(key) ? true : false);
      el.checked = !!val;
      // Persist the default so the content script reads it correctly on next load
      if (!(key in res) && defaultOnKeys.has(key)) chrome.storage.local.set({ [key]: true });
      if (offLabel) reflectModuleOffLabel(el);
    });
    el.addEventListener("change", () => {
      chrome.storage.local.set({ [key]: el.checked });
      if (offLabel) reflectModuleOffLabel(el);
    });
  });


  // ── Reload Interval ─────────────────────────────────────────
  const reloadInput = document.getElementById("reload-time");
  if (reloadInput) {
    chrome.storage.local.get(["reloadInterval"], (res) => {
      reloadInput.value = res.reloadInterval || 1.5;
    });
    reloadInput.addEventListener("change", (e) => {
      let val = parseFloat(e.target.value);
      if (!Number.isFinite(val) || val < 0.5) val = 0.5;
      e.target.value = val;
      chrome.storage.local.set({ reloadInterval: val });
    });
  }


  // ── Batch Delay ─────────────────────────────────────────────
  const batchDelayInput = document.getElementById("batch-delay");
  if (batchDelayInput) {
    chrome.storage.local.get(["batchDelay"], (res) => {
      batchDelayInput.value = res.batchDelay ?? 2;
    });
    batchDelayInput.addEventListener("change", (e) => {
      let val = parseFloat(e.target.value);
      if (!Number.isFinite(val) || val < 0.5) val = 0.5;
      e.target.value = val;
      chrome.storage.local.set({ batchDelay: val });
    });
  }


  // ── Other Autofill Fields ───────────────────────────────────
  [
    { id: "field-mobile", key: "mobile" },
  ].forEach(({ id, key }) => {
    const el = document.getElementById(id);
    if (!el) return;
    chrome.storage.local.get([key], (res) => { el.value = res[key] || ""; });
    el.addEventListener("input", () => chrome.storage.local.set({ [key]: el.value }));
  });


  // ── Toast helper ────────────────────────────────────────────
  function showToast(msg) {
    document.querySelectorAll(".nk-toast").forEach(t => t.remove());
    const t = document.createElement("div");
    t.className = "nk-toast";
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add("nk-toast-in"));
    setTimeout(() => { t.classList.remove("nk-toast-in"); setTimeout(() => t.remove(), 300); }, 2200);
  }


  // ══════════════════════════════════════════════════════════
  // ── LOGS ──────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════

  const LOGS_KEY    = "nkLogs";
  const logsBox     = document.getElementById("logs-box");
  const logsEmpty   = document.getElementById("logs-empty");
  const logsCount   = document.getElementById("logs-count");
  const logsRefresh = document.getElementById("logs-refresh");
  const logsCopy    = document.getElementById("logs-copy");
  const logsClear   = document.getElementById("logs-clear");

  function fmtLogTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  const tabLogCount = document.getElementById("tab-log-count");
  const logsSearch  = document.getElementById("logs-search");
  let allLogs = [];

  // The logs matching the current search term (or all of them when empty).
  function filteredLogs() {
    const term = (logsSearch && logsSearch.value || "").trim().toLowerCase();
    if (!term) return allLogs;
    return allLogs.filter((e) => (e.m || "").toLowerCase().includes(term) || fmtLogTime(e.t).includes(term));
  }

  // Draw the (optionally filtered) logs, newest first.
  function drawLogs() {
    const term = (logsSearch && logsSearch.value || "").trim();
    const filtered = filteredLogs();

    logsCount.textContent = term ? `${filtered.length}/${allLogs.length}` : allLogs.length;

    if (!filtered.length) {
      logsBox.innerHTML = `<div class="logs-empty">${allLogs.length ? "No matching logs" : "No logs yet"}</div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    for (let i = filtered.length - 1; i >= 0; i--) {
      const entry = filtered[i];
      const row = document.createElement("div");
      row.className = "log-row" + (entry.lvl === "warn" ? " log-warn" : entry.lvl === "error" ? " log-error" : "");
      const time = document.createElement("span");
      time.className = "log-time";
      time.textContent = fmtLogTime(entry.t);
      const msg = document.createElement("span");
      msg.className = "log-msg";
      msg.textContent = entry.m;
      row.append(time, msg);
      frag.appendChild(row);
    }
    logsBox.innerHTML = "";
    logsBox.appendChild(frag);
  }

  function renderLogs(logs) {
    allLogs = Array.isArray(logs) ? logs : [];
    if (tabLogCount) tabLogCount.textContent = allLogs.length > 99 ? "99+" : (allLogs.length || "");
    drawLogs();
  }

  if (logsSearch) logsSearch.addEventListener("input", drawLogs);

  function loadLogs() {
    chrome.storage.local.get([LOGS_KEY], (res) => renderLogs(res[LOGS_KEY]));
  }

  logsRefresh.addEventListener("click", loadLogs);

  logsCopy.addEventListener("click", () => {
    // Copy what's shown — i.e. the current search results (or all if no filter).
    const logs = filteredLogs();
    if (!logs.length) { showToast("No logs to copy"); return; }
    // Chronological (oldest → newest), with a level tag for warn/error.
    const text = logs.map((e) => {
      const tag = e.lvl === "warn" ? " [WARN]" : e.lvl === "error" ? " [ERROR]" : "";
      return `${fmtLogTime(e.t)}${tag} ${e.m}`;
    }).join("\n");
    navigator.clipboard.writeText(text)
      .then(() => showToast(`✓ Copied ${logs.length} logs`))
      .catch(() => showToast("✗ Copy failed"));
  });

  logsClear.addEventListener("click", () => {
    chrome.storage.local.set({ [LOGS_KEY]: [] }, () => {
      renderLogs([]);
      showToast("✓ Logs cleared");
    });
  });

  // Live-update while the popup is open
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[LOGS_KEY]) renderLogs(changes[LOGS_KEY].newValue);
  });

  loadLogs();

  // ══════════════════════════════════════════════════════════
  // ── EMAIL MANAGER ─────────────────────────────────────────
  // ══════════════════════════════════════════════════════════

  const emailInput = document.getElementById("email-input");
  const emailSave  = document.getElementById("email-save");
  const emailListEl = document.getElementById("email-list");

  let emailList     = [];
  let activeEmailId = null;

  function saveEmails() {
    chrome.storage.local.set({ emailList, activeEmailId });
    const active = emailList.find(e => e.id === activeEmailId);
    // `email` is the key the autofill module reads
    chrome.storage.local.set({ email: active ? active.email : "" });
  }

  function isValidEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  }

  // ── Compact summary under the Mutamer Details module card ──
  // Shows just the selected email + saved phone; the full editor (email list,
  // add bar, CSV, mobile input) stays hidden behind the ⚙ Edit button.
  function renderAfSummary() {
    const emailSum = document.getElementById("af-email-sum");
    const emailTag = document.getElementById("af-email-tag");
    const phoneSum = document.getElementById("af-phone-sum");
    const phoneTag = document.getElementById("af-phone-tag");
    if (!emailSum) return;
    const active = emailList.find(e => e.id === activeEmailId);
    emailSum.textContent = active ? active.email : "No email saved";
    emailSum.classList.toggle("af-sum-empty", !active);
    if (emailTag) emailTag.style.display = active ? "" : "none";
    chrome.storage.local.get(["mobile"], (res) => {
      const mob = (res.mobile || "").trim();
      phoneSum.textContent = mob || "No phone saved";
      phoneSum.classList.toggle("af-sum-empty", !mob);
      if (phoneTag) phoneTag.style.display = mob ? "" : "none";
    });
  }

  const afEditBtn = document.getElementById("af-edit");
  const afEditor = document.getElementById("af-editor");
  if (afEditBtn && afEditor) {
    afEditBtn.addEventListener("click", () => {
      const open = afEditor.style.display !== "none";
      afEditor.style.display = open ? "none" : "";
      const lbl = document.getElementById("af-edit-label");
      if (lbl) lbl.textContent = open ? "Edit" : "Done";
      afEditBtn.classList.toggle("af-edit-open", !open);
      if (open) renderAfSummary(); // closing → reflect any edits in the summary
    });
  }
  const mobileField = document.getElementById("field-mobile");
  if (mobileField) mobileField.addEventListener("input", () => renderAfSummary());

  // The bar has two modes:
  //   search (default) — typing live-filters the list below
  //   add              — typing an email + Enter/Save adds it to the list
  let emailMode = "search";
  let emailFilter = "";

  function setEmailMode(mode) {
    emailMode = mode;
    emailFilter = "";
    emailInput.value = "";
    emailInput.classList.remove("email-input-error");
    if (mode === "add") {
      emailInput.type = "email";
      emailInput.placeholder = "Type email, Enter to save (Esc = cancel)";
      emailSave.textContent = "Save";
      emailInput.focus();
    } else {
      emailInput.type = "search";
      emailInput.placeholder = "Search emails…";
      emailSave.textContent = "+ Add new";
    }
    renderList();
  }

  function renderList() {
    renderAfSummary();
    emailListEl.innerHTML = "";

    const q = emailFilter.trim().toLowerCase();
    const shown = q ? emailList.filter(e => e.email.toLowerCase().includes(q)) : emailList;

    if (!shown.length) {
      const empty = document.createElement("div");
      empty.className = "email-empty";
      empty.textContent = emailList.length ? "No emails match your search" : "No saved emails yet";
      emailListEl.appendChild(empty);
      return;
    }

    shown.forEach(entry => {
      const isActive = entry.id === activeEmailId;
      const row = document.createElement("div");
      row.className = "email-item" + (isActive ? " active" : "");

      const check = document.createElement("span");
      check.className = "email-check";
      check.innerHTML = isActive
        ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>'
        : "";

      const addr = document.createElement("span");
      addr.className = "email-addr";
      addr.textContent = entry.email;
      addr.title = isActive ? "Active email" : "Click to set active";

      const del = document.createElement("button");
      del.className = "email-del";
      del.title = "Delete";
      del.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';

      // Click row → set active
      row.addEventListener("click", (e) => {
        if (e.target.closest(".email-del")) return;
        activeEmailId = entry.id;
        saveEmails();
        renderList();
      });

      // Delete
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        emailList = emailList.filter(en => en.id !== entry.id);
        if (activeEmailId === entry.id) activeEmailId = emailList[0]?.id ?? null;
        saveEmails();
        renderList();
      });

      row.append(check, addr, del);
      emailListEl.appendChild(row);
    });
  }

  function addEmail() {
    const val = emailInput.value.trim();
    if (!val) return;

    if (!isValidEmail(val)) {
      emailInput.classList.add("email-input-error");
      showToast("✗ Enter a valid email");
      return;
    }
    emailInput.classList.remove("email-input-error");

    // Duplicate (case-insensitive) → never added twice; just make it active
    const existing = emailList.find(e => e.email.toLowerCase() === val.toLowerCase());
    if (existing) {
      activeEmailId = existing.id;
      saveEmails();
      setEmailMode("search");
      showToast("✓ Already saved — set as active");
      return;
    }

    const id = "em_" + Date.now();
    emailList.push({ id, email: val });
    activeEmailId = id; // newest becomes active
    saveEmails();
    setEmailMode("search");
    showToast("✓ Email saved & set as active");
  }

  // Button: search mode → switch to add; add mode → save the typed email.
  emailSave.addEventListener("click", () => {
    if (emailMode === "search") setEmailMode("add");
    else addEmail();
  });
  emailInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && emailMode === "add") { e.preventDefault(); addEmail(); }
    if (e.key === "Escape" && emailMode === "add") { e.preventDefault(); setEmailMode("search"); }
  });
  emailInput.addEventListener("input", () => {
    emailInput.classList.remove("email-input-error");
    if (emailMode === "search") { emailFilter = emailInput.value; renderList(); }
  });

  // ── Export CSV ──────────────────────────────────────────────
  document.getElementById("export-emails").addEventListener("click", () => {
    if (!emailList.length) { showToast("No emails to export"); return; }
    const rows = [["Email"], ...emailList.map(e => [e.email])];
    const csv  = rows.map(r => r.map(v => `"${v.replace(/"/g,'""')}"`).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement("a"), {
      href: url, download: "nuskomate-emails.csv"
    });
    a.click();
    URL.revokeObjectURL(url);
    showToast("✓ Emails exported");
  });

  // ── Import CSV ──────────────────────────────────────────────
  document.getElementById("import-emails").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const lines = ev.target.result.split(/\r?\n/).filter(l => l.trim());
      let added = 0, skipped = 0;
      lines.forEach((line, i) => {
        if (i === 0 && line.toLowerCase().includes("email") && !line.includes("@")) return; // header
        // Take the last column that contains an @ (handles old Label,Email CSVs)
        const cols  = line.split(",").map(v => v.replace(/^"|"$/g, "").trim());
        const email = cols.find(c => c.includes("@"));
        if (!email || !isValidEmail(email)) { skipped++; return; }
        if (emailList.some(en => en.email.toLowerCase() === email.toLowerCase())) { skipped++; return; }
        emailList.push({ id: "em_" + Date.now() + "_" + i, email });
        added++;
      });
      if (!activeEmailId && emailList.length) activeEmailId = emailList[0].id;
      saveEmails(); renderList();
      showToast(`✓ ${added} imported${skipped ? `, ${skipped} skipped` : ""}`);
      e.target.value = "";
    };
    reader.readAsText(file);
  });
  // ══════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════
  // ── PASSPORT OCR (read-only viewer) ───────────────────────
  // ══════════════════════════════════════════════════════════
  // Scanning happens on the page (content script). This panel just shows the
  // details of the last passport scanned there, live-updated via storage.

  // OCR requires the customer's own ocr.space key (see utils/license.js's
  // scan()) — kept device-local by Cloud Sync on purpose, never pushed/pulled,
  // so it's never silently overwritten by another device. Shown masked with
  // an Edit button once saved, same idea as a saved password; the plain
  // input only appears while actively entering/changing it.
  const ocrApiKeyEl   = document.getElementById("ocr-api-key");
  const ocrKeyHintEl  = document.getElementById("ocr-key-hint");
  const ocrKeyViewEl  = document.getElementById("ocr-key-view");
  const ocrKeyMaskedEl = document.getElementById("ocr-key-masked");
  const ocrKeyEditBtn = document.getElementById("ocr-key-edit-btn");
  if (ocrApiKeyEl) {
    const maskKey = (k) => k.length <= 7 ? "•".repeat(k.length) : k.slice(0, 3) + "•".repeat(Math.max(4, k.length - 6)) + k.slice(-3);

    function showKeyView(key) {
      if (ocrKeyViewEl) { ocrKeyViewEl.style.display = "flex"; if (ocrKeyMaskedEl) ocrKeyMaskedEl.textContent = maskKey(key); }
      ocrApiKeyEl.style.display = "none";
      if (ocrKeyHintEl) ocrKeyHintEl.style.display = "none";
    }
    function showKeyEdit() {
      if (ocrKeyViewEl) ocrKeyViewEl.style.display = "none";
      ocrApiKeyEl.style.display = "";
      if (ocrKeyHintEl) ocrKeyHintEl.style.display = ocrApiKeyEl.value.trim() ? "none" : "";
      ocrApiKeyEl.focus();
    }

    chrome.storage.local.get(["ocrApiKey"], (res) => {
      ocrApiKeyEl.value = res.ocrApiKey || "";
      if (res.ocrApiKey) showKeyView(res.ocrApiKey); else showKeyEdit();
    });
    ocrApiKeyEl.addEventListener("input", () => {
      chrome.storage.local.set({ ocrApiKey: ocrApiKeyEl.value.trim() });
      if (ocrKeyHintEl) ocrKeyHintEl.style.display = ocrApiKeyEl.value.trim() ? "none" : "";
    });
    ocrApiKeyEl.addEventListener("blur", () => {
      const v = ocrApiKeyEl.value.trim();
      if (v) showKeyView(v);
    });
    ocrApiKeyEl.addEventListener("keydown", (e) => { if (e.key === "Enter") ocrApiKeyEl.blur(); });
    if (ocrKeyEditBtn) ocrKeyEditBtn.addEventListener("click", showKeyEdit);
  }

  const ocrEmptyEl = document.getElementById("ocr-empty");
  const ocrViewEl  = document.getElementById("ocr-view");
  const ocrTimeEl  = document.getElementById("ocr-scan-time");
  const ocrBadgeEl = document.getElementById("ocr-badge");
  const ocrClearEl = document.getElementById("ocr-clear");

  if (ocrClearEl) {
    ocrClearEl.addEventListener("click", () => {
      chrome.storage.local.remove("ocrDisplay");
      renderScan(null);
    });
  }

  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = (val === undefined || val === null || val === "") ? "—" : val;
  }

  function renderScan(payload) {
    if (!payload || !payload.details) {
      ocrViewEl.style.display = "none";
      ocrEmptyEl.style.display = "block";
      ocrTimeEl.textContent = "";
      if (ocrClearEl) ocrClearEl.style.display = "none";
      return;
    }
    const d = payload.details, boxes = payload.nameBoxes || [];
    ocrEmptyEl.style.display = "none";
    ocrViewEl.style.display = "block";
    if (ocrClearEl) ocrClearEl.style.display = "";

    setText("d-fullname", d.fullName);
    setText("d-surname",  d.surname);
    setText("d-given",    d.givenNames);
    setText("d-father",   d.fatherName);
    setText("d-city",     d.birthCity);
    setText("d-dob",      d.dob);
    setText("d-sex",      d.sex);
    setText("d-type",     d.docType);
    setText("d-passport", d.passportNo);
    setText("d-nat",      d.nationality);
    setText("d-country",  d.issuingCountry);
    setText("d-personal", d.personalNo);
    setText("d-issue",    d.issueDate);
    setText("d-expiry",   d.expiry);
    setText("d-b1", boxes[0]); setText("d-b2", boxes[1]);
    setText("d-b3", boxes[2]); setText("d-b4", boxes[3]);
    setText("d-mrz1", d.mrzLine1);
    setText("d-mrz2", d.mrzLine2);

    // Check-digit chips — show the correct digit when one is wrong
    const checksEl = document.getElementById("d-checks");
    if (checksEl) {
      const c = d.checks || {};
      const exp = c.expected || {};
      const chip = (label, key) => {
        const ok = c[key] !== false;
        const need = (!ok && exp[key] !== undefined) ? ` (should be ${exp[key]})` : "";
        return `<span class="ocr-chip ${ok ? "ocr-chip-ok" : "ocr-chip-bad"}">${ok ? "✓" : "✗"} ${label}${need}</span>`;
      };
      checksEl.innerHTML =
        chip("Passport No", "passportNo") +
        chip("DOB", "dob") +
        chip("Expiry", "expiry") +
        chip("Composite", "composite");
    }

    const warn = payload.blurry || !payload.mrzValid;
    ocrBadgeEl.textContent = payload.mrzValid
      ? (payload.blurry ? "Verify — possible OCR issues" : "MRZ valid")
      : "MRZ checksum failed — verify carefully";
    ocrBadgeEl.className = "ocr-badge " + (warn ? "ocr-badge-warn" : "ocr-badge-ok");

    if (payload.scannedAt) {
      const dt = new Date(payload.scannedAt);
      const p = (n) => String(n).padStart(2, "0");
      ocrTimeEl.textContent = p(dt.getHours()) + ":" + p(dt.getMinutes()) + ":" + p(dt.getSeconds());
    }
  }

  function loadScan() {
    chrome.storage.local.get(["ocrDisplay"], (res) => {
      let payload = null;
      try { payload = res.ocrDisplay ? JSON.parse(res.ocrDisplay) : null; } catch (_) {}
      renderScan(payload);
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.ocrDisplay) {
      try { renderScan(JSON.parse(changes.ocrDisplay.newValue)); } catch (_) { renderScan(null); }
    }
  });

  loadScan();

  // ══════════════════════════════════════════════════════════

  chrome.storage.local.get(["emailList", "activeEmailId"], (res) => {
    emailList     = res.emailList || [];
    activeEmailId = res.activeEmailId || (emailList[0]?.id ?? null);

    if (!emailList.length) {
      // Migrate a legacy single saved email if present
      chrome.storage.local.get(["email"], (r) => {
        if (r.email) {
          const id = "em_legacy";
          emailList = [{ id, email: r.email }];
          activeEmailId = id;
          saveEmails();
        }
        renderList();
      });
    } else {
      renderList();
    }
  });

});
