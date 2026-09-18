document.addEventListener("DOMContentLoaded", () => {

  // ── Click-feedback pulse for every small icon button (Refresh/Copy/Clear/
  // Clear Stuck/etc. across Logs, Pipeline Queue, Pipeline Logs, ...) ──────
  // Delegated once here instead of wired per-button, so it covers every
  // .logs-btn everywhere in the popup (present and future) with no extra
  // code at each call site. See popup.css's nk-btn-pulse for the animation.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".logs-btn");
    if (!btn) return;
    btn.classList.remove("nk-btn-clicked");
    void btn.offsetWidth; // force reflow so the animation restarts on a rapid re-click
    btn.classList.add("nk-btn-clicked");
  });

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
      "toggle-reload": "reload", "toggle-overlay": "overlay",
      "toggle-issue-date": "issuedate", "toggle-vaccine": "vaccine", "toggle-ocr": "ocr",
      "toggle-father": "father", "toggle-batch": "batch",
      "toggle-workflows": "workflows",
      "toggle-autorules": ["autorules", "autoclick", "fillrules", "autoselect"],
      "toggle-urlshift": "urlshift",
      "toggle-brnrequest": "brnrequest",
      "toggle-mvtotals": "mvtotals",
      "toggle-translaterules": "translaterules",
      "toggle-groups": "groups",
      "toggle-talabcopy": "talabcopy",
      "toggle-autodatepicker": "autodatepicker",
      "toggle-packagecreator": "packagecreator",
    };

    // Is a given tool unlocked for the current key? (features null = all
    // tools). `feat` can be a single id or an array of acceptable ids — used
    // for autorules, which accepts its own new id OR any of the 3 old ones
    // (autoclick/fillrules/autoselect) it replaced, so already-issued keys
    // keep working without needing to be reissued.
    function has(st, feat) {
      if (!st.activated) return false;
      if (st.features === null) return true;
      if (!Array.isArray(st.features)) return false;
      const feats = Array.isArray(feat) ? feat : [feat];
      return feats.some((f) => st.features.includes(f));
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
      // Automation tabs: each has its own tool id now (autorules also
      // accepts the 3 old ids it replaced — see has() above).
      [["ar-upsell", "ar-content", ["autorules", "autoclick", "fillrules", "autoselect"]], ["wf-upsell", "wf-content", "workflows"], ["us-upsell", "us-content", "urlshift"], ["brn-upsell", "brn-content", "brnrequest"], ["tr-upsell", "tr-content", "translaterules"], ["pc-upsell", "pc-content", "packagecreator"], ["ft-upsell", "ft-content", "filetools"], ["mg-upsell", "mg-content", "mediagrabber"]].forEach(([up, ct, feat]) => {
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
      if (!(await window.nkConfirm("Deactivate premium on this device? It frees the seat for another device.", { confirmText: "Deactivate", danger: true }))) return;
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
    ["ar-upsell-btn", "wf-upsell-btn", "us-upsell-btn", "brn-upsell-btn", "tr-upsell-btn", "pc-upsell-btn", "ft-upsell-btn", "mg-upsell-btn"].forEach((idb) => {
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
    const syncNowBtn  = document.getElementById("sync-now-btn");
    if (!toggle) return;

    function renderBanner(inProgress) {
      if (banner) banner.style.display = inProgress ? "flex" : "none";
      if (syncNowBtn) {
        syncNowBtn.classList.toggle("spinning", inProgress);
        syncNowBtn.disabled = inProgress;
      }
    }
    chrome.storage.local.get(["cloudSyncInProgress"], (res) => renderBanner(!!res.cloudSyncInProgress));

    if (syncNowBtn) {
      syncNowBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "nkSyncNow" }, () => void chrome.runtime.lastError);
      });
    }

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
      if (syncNowBtn) syncNowBtn.style.display = on ? "" : "none";
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

  // ── Extension language (default target language for Translation Rules) ──
  const LANG_KEY = "nkLanguage";
  const langSelect = document.getElementById("nk-language");
  if (langSelect) {
    chrome.storage.local.get([LANG_KEY], (res) => { langSelect.value = res[LANG_KEY] || "system"; });
    langSelect.addEventListener("change", (e) => {
      chrome.storage.local.set({ [LANG_KEY]: e.target.value });
    });
  }

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
    { id: "toggle-issue-date", key: "moduleIssueDateCalc"  },
    { id: "toggle-vaccine",    key: "moduleVaccineUpload"  },
    { id: "toggle-ocr",       key: "moduleOcr"            },
    { id: "toggle-father",    key: "moduleFatherName"     },
    { id: "toggle-batch",     key: "moduleBatchUpload"    },
    // The automation-tab toggles show "(Module off)" inline in their own
    // module-name instead of a separate pill elsewhere on the tab.
    { id: "toggle-autorules",  key: "moduleAutoRules", offLabel: true    },
    { id: "toggle-workflows",   key: "moduleWorkflows", offLabel: true    },
    { id: "toggle-urlshift",    key: "moduleUrlShift", offLabel: true     },
    { id: "toggle-brnrequest",  key: "moduleBrnRequest", offLabel: true   },
    { id: "toggle-mvtotals",    key: "moduleMvTotals"                    },
    { id: "toggle-translaterules", key: "moduleTranslateRules", offLabel: true },
    { id: "toggle-groups",      key: "moduleGroupsExport"                },
    { id: "toggle-talabcopy",   key: "moduleTalabCopy"                   },
    { id: "toggle-autodatepicker", key: "moduleAutoDatePicker"           },
    { id: "toggle-packagecreator", key: "modulePackageCreator", offLabel: true },
    { id: "toggle-pipeline",    key: "modulePipeline", offLabel: true, lockPanel: "panel-pipeline" },
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

  // Fully locks a tab-panel's OWN body when its module toggle is off — every
  // input/button/textarea/select inside it is natively `.disabled`'d (blocks
  // clicks AND keyboard activation, not just a visual cue), and the panel
  // gets a dimmed look via CSS. The module-card section itself (first .section
  // child — name, description, the toggle switch, its "i" info button) is
  // deliberately left untouched, since that's the only way back on.
  function applyPanelLock(panelId, enabled) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    panel.classList.toggle("module-off-locked", !enabled);
    const moduleCardSection = panel.querySelector(".section");
    panel.querySelectorAll("input, button, textarea, select").forEach((el) => {
      if (moduleCardSection && moduleCardSection.contains(el)) return;
      el.disabled = !enabled;
    });
  }

  function initToggles() {
    toggles.forEach(({ id, key, offLabel, lockPanel }) => {
      const el = document.getElementById(id);
      if (!el) return;
      chrome.storage.local.get([key], (res) => {
        const val = key in res ? res[key] : (defaultOnKeys.has(key) ? true : false);
        el.checked = !!val;
        // Persist the default so the content script reads it correctly on next load
        if (!(key in res) && defaultOnKeys.has(key)) chrome.storage.local.set({ [key]: true });
        if (offLabel) reflectModuleOffLabel(el);
        if (lockPanel) applyPanelLock(lockPanel, val);
      });
      el.addEventListener("change", () => {
        chrome.storage.local.set({ [key]: el.checked });
        if (offLabel) reflectModuleOffLabel(el);
        if (lockPanel) applyPanelLock(lockPanel, el.checked);
      });
    });
  }

  // One-time migration: moduleAutoRules replaces the 3 old separately-
  // licensed toggles (moduleAutoClicker/moduleAutoFillRules/moduleAutoSelect).
  // Runs BEFORE initToggles() so its own read of moduleAutoRules never races
  // the generic "default to true" write above. Inherits "on" if ANY of the 3
  // old toggles were on, rather than the generic default silently deciding
  // for an install that already had an explicit preference.
  chrome.storage.local.get(["moduleAutoRules", "moduleAutoClicker", "moduleAutoFillRules", "moduleAutoSelect"], (res) => {
    if ("moduleAutoRules" in res) { initToggles(); return; }
    const hadOldKeys = ("moduleAutoClicker" in res) || ("moduleAutoFillRules" in res) || ("moduleAutoSelect" in res);
    const migrated = hadOldKeys
      ? (res.moduleAutoClicker !== false || res.moduleAutoFillRules !== false || res.moduleAutoSelect !== false)
      : true; // brand-new install, no history — same "default on" as everything else
    chrome.storage.local.set({ moduleAutoRules: migrated }, initToggles);
  });


  // ── Gear buttons — expand/collapse a module-card's settings. Collapsed by
  // default for a card nobody's touched yet, but remembered per-gear once you
  // do open one — same "stays how you left it" behavior as expanded rule
  // cards, instead of silently re-collapsing every time the popup reopens. ──
  const GEAR_OPEN_KEY = "moduleGearOpen";
  function wireGearToggle(gearId, extraId) {
    const gear = document.getElementById(gearId);
    const extra = document.getElementById(extraId);
    if (!gear || !extra) return;
    function setOpen(open) {
      extra.style.display = open ? "" : "none";
      gear.classList.toggle("module-gear-open", open);
    }
    chrome.storage.local.get([GEAR_OPEN_KEY], (res) => {
      setOpen(!!(res[GEAR_OPEN_KEY] || {})[gearId]);
    });
    gear.addEventListener("click", () => {
      const open = extra.style.display === "none";
      setOpen(open);
      chrome.storage.local.get([GEAR_OPEN_KEY], (res) => {
        const all = { ...(res[GEAR_OPEN_KEY] || {}) };
        all[gearId] = open;
        chrome.storage.local.set({ [GEAR_OPEN_KEY]: all });
      });
    });
  }
  wireGearToggle("batch-settings-btn", "batch-module-extra");
  wireGearToggle("reload-settings-btn", "reload-module-extra");

  // Auto Date Picker's "i" info panel — no settings/gear, just this.
  (function () {
    const infoBtn = document.getElementById("adp-info-btn");
    const infoPanel = document.getElementById("adp-info-panel");
    if (!infoBtn || !infoPanel) return;
    infoBtn.addEventListener("click", () => {
      const open = infoPanel.style.display !== "none";
      infoPanel.style.display = open ? "none" : "";
      infoBtn.classList.toggle("info-btn-open", !open);
    });
  })();


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


  // ── Contact phone ───────────────────────────────────────────
  // Shown as a single row (icon + number + edit pencil), same compact
  // inline-edit interaction as the email/Totals lists: click the pencil,
  // the number becomes a small editable field right in place — Enter
  // saves, Esc cancels, click-away cancels.
  (function () {
    const KEY = "mobile";
    const display = document.getElementById("mobile-display");
    const editBtn = document.getElementById("mobile-edit-btn");
    if (!display || !editBtn) return;

    let value = "";
    let editing = false;

    function render() {
      display.textContent = value || "No phone saved";
      display.classList.toggle("af-sum-empty", !value);
    }

    function startEdit() {
      editing = true;
      display.style.display = "none";

      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "inline-text-input inline-addr-input";
      inp.value = value;
      inp.placeholder = "03001234567";
      inp.title = "Enter to save · Esc to cancel";

      const doSave = () => {
        value = inp.value.trim();
        chrome.storage.local.set({ [KEY]: value });
        editing = false;
        inp.remove();
        display.style.display = "";
        render();
      };
      const doCancel = () => {
        editing = false;
        inp.remove();
        display.style.display = "";
      };

      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); doSave(); }
        if (e.key === "Escape") { e.preventDefault(); doCancel(); }
      });
      inp.addEventListener("focusout", () => {
        setTimeout(() => { if (editing) doCancel(); }, 0);
      });

      display.insertAdjacentElement("afterend", inp);
      inp.focus();
      inp.select();
    }

    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!editing) startEdit();
    });

    chrome.storage.local.get([KEY], (res) => {
      value = res[KEY] || "";
      render();
    });
  })();


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
  const emailLabelInput = document.getElementById("email-label-input");

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
  // Just the selected email, always visible right below the description —
  // the full editor (email list, add bar, CSV, mobile input) stays hidden
  // behind the ⚙ gear button instead of a separate Edit button.
  function renderAfSummary() {
    const emailSum = document.getElementById("af-email-sum");
    if (!emailSum) return;
    const active = emailList.find(e => e.id === activeEmailId);
    emailSum.textContent = active ? (active.label ? `${active.label} — ${active.email}` : active.email) : "No email saved";
    emailSum.classList.toggle("af-sum-empty", !active);
  }

  // Gear button — the ONLY toggle now, expands/collapses the whole editor
  // (email search/add/list + phone field, nested inside the card like
  // Totals' own module-extra). Collapsed by default for a card nobody's
  // opened yet, but remembered (via GEAR_OPEN_KEY, same as the other gear
  // buttons) once you do — reopening the popup no longer silently
  // re-collapses it.
  const afSettingsBtn = document.getElementById("af-settings-btn");
  const afModuleSub = document.getElementById("af-module-sub");
  if (afSettingsBtn && afModuleSub) {
    function setAfOpen(open) {
      afModuleSub.style.display = open ? "" : "none";
      afSettingsBtn.classList.toggle("module-gear-open", open);
    }
    chrome.storage.local.get([GEAR_OPEN_KEY], (res) => {
      setAfOpen(!!(res[GEAR_OPEN_KEY] || {})["af-settings-btn"]);
    });
    afSettingsBtn.addEventListener("click", () => {
      const open = afModuleSub.style.display === "none";
      setAfOpen(open);
      chrome.storage.local.get([GEAR_OPEN_KEY], (res) => {
        const all = { ...(res[GEAR_OPEN_KEY] || {}) };
        all["af-settings-btn"] = open;
        chrome.storage.local.set({ [GEAR_OPEN_KEY]: all });
      });
      // Closing — drop out of any unsaved add/edit form state so reopening
      // later starts clean; setEmailMode("search") also refreshes the
      // summary (via renderList → renderAfSummary) to reflect any edits.
      if (!open) setEmailMode("search");
    });
  }

  // The top bar has two modes:
  //   search (default) — typing live-filters the list below
  //   add              — typing an email + Enter/Save adds it to the list
  // Editing an existing entry happens INLINE, right in that entry's own row
  // (editingEmailId below) — not through this shared bar, so editing a row
  // near the bottom of a long list doesn't jump you back to the top.
  let emailMode = "search";
  let emailFilter = "";
  let editingEmailId = null;

  function setEmailMode(mode, prefill) {
    emailMode = mode;
    emailFilter = "";
    emailInput.classList.remove("email-input-error");
    editingEmailId = null; // the add-bar and inline row-editing are mutually exclusive
    if (mode === "add") {
      emailInput.type = "email";
      emailInput.value = prefill || "";
      emailInput.placeholder = "Type email, Enter to save (Esc = cancel)";
      emailSave.textContent = "Save";
      emailSave.style.display = ""; // always visible while actually adding
      if (emailLabelInput) { emailLabelInput.style.display = ""; emailLabelInput.value = ""; }
      emailInput.focus();
    } else {
      emailInput.value = "";
      emailInput.type = "search";
      emailInput.placeholder = "Search emails…";
      emailSave.textContent = "+ Add new";
      if (emailLabelInput) emailLabelInput.style.display = "none";
    }
    renderList();
  }

  // Shared validate+save logic for editing an existing entry in place —
  // used by the inline row-edit form. Handles the same "editing to an email
  // that collides with a different saved entry" merge as the add flow.
  function saveEmailChanges(entry, newEmail, newLabel, onError) {
    newEmail = newEmail.trim();
    if (!newEmail) { onError("Email can't be empty"); return false; }
    if (!isValidEmail(newEmail)) { onError("Enter a valid email"); return false; }
    const collision = emailList.find(e => e.id !== entry.id && e.email.toLowerCase() === newEmail.toLowerCase());
    if (collision) {
      emailList = emailList.filter(e => e.id !== entry.id);
      if (newLabel) collision.label = newLabel;
      if (activeEmailId === entry.id) activeEmailId = collision.id;
      saveEmails();
      showToast("✓ Merged with the existing entry for that email");
      return true;
    }
    entry.email = newEmail;
    entry.label = newLabel;
    saveEmails();
    showToast("✓ Changes saved");
    return true;
  }

  function renderList() {
    renderAfSummary();
    emailListEl.innerHTML = "";

    const q = emailFilter.trim().toLowerCase();
    const shown = q
      ? emailList.filter(e => e.email.toLowerCase().includes(q) || (e.label || "").toLowerCase().includes(q))
      : emailList;

    // "+ Add new" only shows once you've searched for something that isn't
    // there — keeps the bar looking like a plain search box the rest of the
    // time instead of always offering to add.
    if (emailMode === "search") emailSave.style.display = (q && !shown.length) ? "" : "none";

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

      // ── Inline edit mode: the row's own label/address text becomes small
      // editable fields right where they already sit — no separate box,
      // no Save/Cancel buttons. Enter saves, Esc cancels, click-away cancels. ──
      if (entry.id === editingEmailId) {
        row.classList.add("email-item-editing");

        const check = document.createElement("span");
        check.className = "email-check";

        const textWrap = document.createElement("span");
        textWrap.className = "email-text";

        const labelInp = document.createElement("input");
        labelInp.type = "text"; labelInp.className = "inline-text-input inline-label-input";
        labelInp.value = entry.label || ""; labelInp.placeholder = "Label";
        labelInp.title = "Enter to save · Esc to cancel";

        const emailInp = document.createElement("input");
        emailInp.type = "email"; emailInp.className = "inline-text-input inline-addr-input";
        emailInp.value = entry.email;
        emailInp.title = "Enter to save · Esc to cancel";

        const errEl = document.createElement("div");
        errEl.className = "inline-edit-error";

        const doSave = () => {
          const ok = saveEmailChanges(entry, emailInp.value, labelInp.value.trim(), (msg) => {
            emailInp.classList.add("email-input-error");
            errEl.textContent = msg;
            errEl.style.display = "";
          });
          if (ok) { editingEmailId = null; renderList(); }
        };
        const doCancel = () => { editingEmailId = null; renderList(); };

        [labelInp, emailInp].forEach((inp) => {
          inp.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); doSave(); }
            if (e.key === "Escape") { e.preventDefault(); doCancel(); }
          });
        });
        emailInp.addEventListener("input", () => {
          emailInp.classList.remove("email-input-error");
          errEl.style.display = "none";
        });

        // Click away from the row (without Enter/Esc) cancels — never leaves
        // the row silently "stuck" in edit mode.
        row.addEventListener("focusout", () => {
          setTimeout(() => {
            if (editingEmailId === entry.id && !row.contains(document.activeElement)) doCancel();
          }, 0);
        });

        textWrap.append(labelInp, emailInp, errEl);
        row.append(check, textWrap);
        emailListEl.appendChild(row);
        emailInp.focus();
        emailInp.select();
        return;
      }

      const check = document.createElement("span");
      check.className = "email-check";
      check.innerHTML = isActive
        ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>'
        : "";

      // Label (who this belongs to) stacks above the address when set — same
      // "identifier below, human name above" idea as the Keys admin list.
      const textWrap = document.createElement("span");
      textWrap.className = "email-text";

      const addr = document.createElement("span");
      addr.className = "email-addr";
      addr.textContent = entry.email;
      addr.title = isActive ? "Active email" : "Click to set active";
      textWrap.appendChild(addr);

      if (entry.label) {
        const label = document.createElement("span");
        label.className = "email-label";
        label.textContent = entry.label;
        textWrap.prepend(label);
      }

      const editBtn = document.createElement("button");
      editBtn.className = "email-edit";
      editBtn.title = "Edit";
      editBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';

      const del = document.createElement("button");
      del.className = "email-del";
      del.title = "Delete";
      del.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';

      // Click row → set active
      row.addEventListener("click", (e) => {
        if (e.target.closest(".email-del") || e.target.closest(".email-edit")) return;
        activeEmailId = entry.id;
        saveEmails();
        renderList();
      });

      // Edit — turns THIS row into an inline form (closes the add-bar first
      // if it was open, since the two are mutually exclusive)
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (emailMode !== "search") setEmailMode("search");
        editingEmailId = entry.id;
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

      row.append(check, textWrap, editBtn, del);
      emailListEl.appendChild(row);
    });
  }

  function submitEmailForm() {
    const val = emailInput.value.trim();
    if (!val) return;

    if (!isValidEmail(val)) {
      emailInput.classList.add("email-input-error");
      showToast("✗ Enter a valid email");
      return;
    }
    emailInput.classList.remove("email-input-error");
    const label = emailLabelInput ? emailLabelInput.value.trim() : "";

    // Duplicate (case-insensitive) → never added twice; just make it active
    // (and pick up a newly-typed label, so re-adding an old un-labeled entry
    // is also a valid way to label it, not just the pencil icon).
    const existing = emailList.find(e => e.email.toLowerCase() === val.toLowerCase());
    if (existing) {
      activeEmailId = existing.id;
      if (label) existing.label = label;
      saveEmails();
      setEmailMode("search");
      showToast("✓ Already saved — set as active");
      return;
    }

    const id = "em_" + Date.now();
    emailList.push({ id, email: val, label });
    activeEmailId = id; // newest becomes active
    saveEmails();
    setEmailMode("search");
    showToast("✓ Email saved & set as active");
  }

  // Button: search mode (only shown when the search found nothing) →
  // switch to add, prefilled with whatever was searched; add/edit mode →
  // submit the form.
  emailSave.addEventListener("click", () => {
    if (emailMode === "search") setEmailMode("add", emailFilter.trim());
    else submitEmailForm();
  });
  emailInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && emailMode !== "search") { e.preventDefault(); submitEmailForm(); }
    if (e.key === "Escape" && emailMode !== "search") { e.preventDefault(); setEmailMode("search"); }
  });
  if (emailLabelInput) {
    emailLabelInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submitEmailForm(); }
      if (e.key === "Escape") { e.preventDefault(); setEmailMode("search"); }
    });
  }
  emailInput.addEventListener("input", () => {
    emailInput.classList.remove("email-input-error");
    if (emailMode === "search") { emailFilter = emailInput.value; renderList(); }
  });

  // ── Export CSV ──────────────────────────────────────────────
  document.getElementById("export-emails").addEventListener("click", () => {
    if (!emailList.length) { showToast("No emails to export"); return; }
    const rows = [["Label", "Email"], ...emailList.map(e => [e.label || "", e.email])];
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
        // The column with an @ is the email; whatever else is on the line
        // (any column order — Label,Email or Email,Label) is the label.
        const cols  = line.split(",").map(v => v.replace(/^"|"$/g, "").trim());
        const email = cols.find(c => c.includes("@"));
        const label = cols.filter(c => c && !c.includes("@")).join(" ").trim();
        if (!email || !isValidEmail(email)) { skipped++; return; }
        const existing = emailList.find(en => en.email.toLowerCase() === email.toLowerCase());
        if (existing) { if (label && !existing.label) existing.label = label; skipped++; return; }
        emailList.push({ id: "em_" + Date.now() + "_" + i, email, label });
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
  // Shared by every "bring your own API key" field (OCR, remove.bg, …):
  // masked view + an Edit button once saved, same idea as a saved password;
  // the plain input only appears while actively entering/changing it.
  function wireApiKeyField(storageKey, ids) {
    const input = document.getElementById(ids.input);
    if (!input) return;
    const hint = document.getElementById(ids.hint);
    const view = document.getElementById(ids.view);
    const masked = document.getElementById(ids.masked);
    const editBtn = document.getElementById(ids.edit);
    const maskKey = (k) => k.length <= 7 ? "•".repeat(k.length) : k.slice(0, 3) + "•".repeat(Math.max(4, k.length - 6)) + k.slice(-3);

    function showKeyView(key) {
      if (view) { view.style.display = "flex"; if (masked) masked.textContent = maskKey(key); }
      input.style.display = "none";
      if (hint) hint.style.display = "none";
    }
    function showKeyEdit() {
      if (view) view.style.display = "none";
      input.style.display = "";
      if (hint) hint.style.display = input.value.trim() ? "none" : "";
      input.focus();
    }

    chrome.storage.local.get([storageKey], (res) => {
      input.value = res[storageKey] || "";
      if (res[storageKey]) showKeyView(res[storageKey]); else showKeyEdit();
    });
    input.addEventListener("input", () => {
      chrome.storage.local.set({ [storageKey]: input.value.trim() });
      if (hint) hint.style.display = input.value.trim() ? "none" : "";
    });
    input.addEventListener("blur", () => { const v = input.value.trim(); if (v) showKeyView(v); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
    if (editBtn) editBtn.addEventListener("click", showKeyEdit);
  }
  wireApiKeyField("ocrApiKey", { input: "ocr-api-key", hint: "ocr-key-hint", view: "ocr-key-view", masked: "ocr-key-masked", edit: "ocr-key-edit-btn" });
  wireApiKeyField("removeBgApiKey", { input: "removebg-api-key", hint: "removebg-key-hint", view: "removebg-key-view", masked: "removebg-key-masked", edit: "removebg-key-edit-btn" });
  // CRM login (setup.nebraspk.com) — same masked-view/edit pattern as the API
  // key fields above, just two fields instead of one. Not read by anything
  // yet; this is only the storage side, for the WhatsApp automation plan to
  // use once it's actually built (see project_whatsapp_automation_plan memory).
  wireApiKeyField("crmUsername", { input: "crm-username", view: "crm-username-view", masked: "crm-username-masked", edit: "crm-username-edit-btn" });
  wireApiKeyField("crmPassword", { input: "crm-password", view: "crm-password-view", masked: "crm-password-masked", edit: "crm-password-edit-btn" });

  // CRM Lookup test harness — talks to modules/crm-lookup.js on whichever
  // setup.nebraspk.com tab is open, same "message a Masar tab directly"
  // pattern as BRN Request's Quick Send (see popup/brn-request.js). Standalone
  // sanity check for Phase 1 of the WhatsApp automation plan — nothing else
  // reads this result yet.
  const crmTestResNo  = document.getElementById("crm-test-resno");
  const crmTestBtn    = document.getElementById("crm-test-lookup");
  const crmTestResult = document.getElementById("crm-test-result");
  function runCrmTestLookup() {
    const reservationNo = (crmTestResNo && crmTestResNo.value.trim()) || "";
    if (!reservationNo) { window.nkToast("Enter a reservation number first.", "error"); return; }
    if (crmTestResult) { crmTestResult.style.display = "block"; crmTestResult.textContent = "Looking up…"; }
    chrome.tabs.query({ url: "https://setup.nebraspk.com/*" }, (allTabs) => {
      const tabs = allTabs || [];
      if (!tabs.length) {
        window.nkToast("Open a setup.nebraspk.com tab first.", "error");
        if (crmTestResult) crmTestResult.textContent = "No setup.nebraspk.com tab found — open one first.";
        return;
      }
      // Several CRM tabs can easily be open (stale ones from earlier testing,
      // a login-page tab, etc.) — prefer whichever one is actually active/
      // focused right now instead of just picking whatever Chrome lists
      // first, which has no relation to which tab the user is looking at.
      const target = tabs.find((t) => t.active) || tabs[0];

      function sendLookup() {
        chrome.tabs.sendMessage(target.id, { type: "nkCrmLookupReservation", reservationNo }, (resp) => {
          if (chrome.runtime.lastError) {
            const msg = "Could not reach the CRM tab — refresh it and try again.";
            window.nkToast(msg, "error");
            if (crmTestResult) crmTestResult.textContent = msg;
            return;
          }
          if (crmTestResult) crmTestResult.textContent = JSON.stringify(resp, null, 2);
          if (resp && resp.ok) window.nkToast(resp.found ? "Found" : "Not found", resp.found ? "success" : "warning");
          else window.nkToast((resp && resp.error) || "Lookup failed.", "error");
        });
      }

      // Chrome throttles timers in tabs that aren't the active tab of a
      // focused window — this automation leans on setTimeout-based waits
      // throughout, so an unfocused CRM tab can run noticeably slower/less
      // reliably. Bring it to the front first (switch to its tab + focus its
      // window) so the user never has to manually click over to it — the
      // whole point is this works no matter what tab/window they're on.
      chrome.tabs.update(target.id, { active: true }, () => {
        if (target.windowId != null) {
          chrome.windows.update(target.windowId, { focused: true }, sendLookup);
        } else {
          sendLookup();
        }
      });
    });
  }
  if (crmTestBtn) crmTestBtn.addEventListener("click", runCrmTestLookup);
  if (crmTestResNo) crmTestResNo.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runCrmTestLookup(); } });

  // Focuses a tab (and its window) matching `urlPattern` before running
  // `fn(tab)` against it — background/inactive tabs get their timers
  // throttled by Chrome, which these automations lean on heavily for their
  // waits, so this brings the target tab to the front first regardless of
  // what the user currently has focused. Shared by every pipeline test
  // harness in this section.
  function withFocusedTab(urlPattern, notFoundMsg, fn) {
    chrome.tabs.query({ url: urlPattern }, (allTabs) => {
      const tabs = allTabs || [];
      if (!tabs.length) { window.nkToast(notFoundMsg, "error"); fn(null); return; }
      const target = tabs.find((t) => t.active) || tabs[0];
      chrome.tabs.update(target.id, { active: true }, () => {
        if (target.windowId != null) chrome.windows.update(target.windowId, { focused: true }, () => fn(target));
        else fn(target);
      });
    });
  }

  // Masar Add-Mutamer test — reads the picked file as a data URL (same shape
  // WA-Campaigns' getMessageMedia will eventually hand over from a real
  // WhatsApp message) and hands it to modules/masar-add-mutamer.js.
  const masarTestFile   = document.getElementById("masar-test-file");
  const masarTestBtn    = document.getElementById("masar-test-run");
  const masarTestResult = document.getElementById("masar-test-result");
  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Could not read " + file.name));
      reader.readAsDataURL(file);
    });
  }
  async function runMasarTest() {
    const files = masarTestFile && masarTestFile.files ? Array.from(masarTestFile.files) : [];
    if (!files.length) { window.nkToast("Pick one or more passport images first.", "error"); return; }
    if (masarTestResult) { masarTestResult.style.display = "block"; masarTestResult.textContent = `Handing ${files.length} passport(s) to the Bulk Passport Parser queue…`; }
    withFocusedTab("https://masar.nusuk.sa/*", "Open a masar.nusuk.sa tab first.", async (target) => {
      if (!target) { if (masarTestResult) masarTestResult.textContent = "No masar.nusuk.sa tab found — open one first."; return; }
      // Sent as ONE batch, same as a manual multi-select — see
      // batch-passport.js's feedOrQueue for why this must not be split into
      // one round-trip per file (that's exactly what raced earlier).
      const items = await Promise.all(files.map(async (file) => ({ dataUrl: await readAsDataUrl(file), filename: file.name })));
      // Registered BEFORE feeding starts, same order the files will be fed
      // in — this is what makes the OCR-relay actually log a result back
      // here instead of silently going nowhere (this test tool messages the
      // content script directly, same as every other test harness, so
      // without this the pipeline never learns these are worth tracking).
      await new Promise((resolve) => chrome.runtime.sendMessage({ type: "nkMasarRegisterTestFeed", labels: items.map((i) => i.filename) }, resolve));
      chrome.tabs.sendMessage(target.id, { type: "nkMasarQueuePassport", files: items }, (resp) => {
        if (chrome.runtime.lastError) {
          const msg = "Could not reach the Masar tab — refresh it and try again.";
          window.nkToast(msg, "error");
          if (masarTestResult) masarTestResult.textContent = msg;
          return;
        }
        if (masarTestResult) masarTestResult.textContent = JSON.stringify(resp, null, 2);
        if (resp && resp.ok) window.nkToast(`Queued ${files.length} passport(s) — watch Pipeline Logs for OCR results.`, "success");
        else window.nkToast((resp && resp.error) || "Queuing failed.", "error");
      });
    });
  }
  if (masarTestBtn) masarTestBtn.addEventListener("click", runMasarTest);

  // Masar Create Group test — modules/masar-group.js.
  const groupTestName      = document.getElementById("group-test-name");
  const groupTestPassports = document.getElementById("group-test-passports");
  const groupTestBtn       = document.getElementById("group-test-run");
  const groupTestResult    = document.getElementById("group-test-result");
  function runGroupTest() {
    const groupName = (groupTestName && groupTestName.value.trim()) || "";
    const passportNumbers = ((groupTestPassports && groupTestPassports.value) || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    if (!groupName) { window.nkToast("Enter a group name first.", "error"); return; }
    if (!passportNumbers.length) { window.nkToast("Enter at least one passport number.", "error"); return; }
    if (groupTestResult) { groupTestResult.style.display = "block"; groupTestResult.textContent = "Creating group… this can take 20-40s."; }
    withFocusedTab("https://masar.nusuk.sa/*", "Open a masar.nusuk.sa tab first.", (target) => {
      if (!target) { if (groupTestResult) groupTestResult.textContent = "No masar.nusuk.sa tab found — open one first."; return; }
      const mutamers = passportNumbers.map((passportNo) => ({ passportNo }));
      chrome.tabs.sendMessage(target.id, { type: "nkMasarCreateGroup", groupName, mutamers }, (resp) => {
        if (chrome.runtime.lastError) {
          const msg = "Could not reach the Masar tab — refresh it and try again.";
          window.nkToast(msg, "error");
          if (groupTestResult) groupTestResult.textContent = msg;
          return;
        }
        if (groupTestResult) groupTestResult.textContent = JSON.stringify(resp, null, 2);
        if (resp && resp.ok && resp.submitted) window.nkToast(`Group created: ${groupName}`, "success");
        else if (resp && resp.ok) window.nkToast("Finished but didn't land on Group List — check the result.", "warning");
        else window.nkToast((resp && resp.error) || "Create group failed.", "error");
      });
    });
  }
  if (groupTestBtn) groupTestBtn.addEventListener("click", runGroupTest);

  // Masar Group Reply Assets test — modules/masar-group-reply.js.
  const replyTestGroupName = document.getElementById("reply-test-groupname");
  const replyTestBtn       = document.getElementById("reply-test-run");
  const replyTestResult    = document.getElementById("reply-test-result");
  const replyTestImg       = document.getElementById("reply-test-img");
  function runReplyTest() {
    const expectedGroupName = (replyTestGroupName && replyTestGroupName.value.trim()) || undefined;
    if (replyTestResult) { replyTestResult.style.display = "block"; replyTestResult.textContent = "Fetching caption + screenshot…"; }
    if (replyTestImg) replyTestImg.style.display = "none";
    withFocusedTab("https://masar.nusuk.sa/*", "Open a masar.nusuk.sa tab first.", (target) => {
      if (!target) { if (replyTestResult) replyTestResult.textContent = "No masar.nusuk.sa tab found — open one first."; return; }
      chrome.tabs.sendMessage(target.id, { type: "nkMasarGetGroupReplyAssets", expectedGroupName }, (resp) => {
        if (chrome.runtime.lastError) {
          const msg = "Could not reach the Masar tab — refresh it and try again.";
          window.nkToast(msg, "error");
          if (replyTestResult) replyTestResult.textContent = msg;
          return;
        }
        if (resp && resp.ok) {
          const { screenshotDataUrl, ...rest } = resp;
          if (replyTestResult) replyTestResult.textContent = JSON.stringify(rest, null, 2);
          if (replyTestImg && screenshotDataUrl) { replyTestImg.src = screenshotDataUrl; replyTestImg.style.display = "block"; }
          window.nkToast(`Got assets for ${resp.groupName || "the group"} (${resp.mutamerCount} mutamer(s))`, "success");
        } else {
          if (replyTestResult) replyTestResult.textContent = JSON.stringify(resp, null, 2);
          window.nkToast((resp && resp.error) || "Failed to get reply assets.", "error");
        }
      });
    });
  }
  if (replyTestBtn) replyTestBtn.addEventListener("click", runReplyTest);

  // WhatsApp Pipeline: Live Sending toggle + team mention WA ID — plain
  // storage-backed fields, same load/save pattern used throughout Settings.
  const waPipelineLiveEl = document.getElementById("wa-pipeline-live");
  const waMentionIdEl    = document.getElementById("wa-mention-id");
  chrome.storage.local.get(["waPipelineLive", "waMentionId"], (res) => {
    if (waPipelineLiveEl) waPipelineLiveEl.checked = !!res.waPipelineLive;
    if (waMentionIdEl) waMentionIdEl.value = res.waMentionId || "";
  });
  if (waPipelineLiveEl) waPipelineLiveEl.addEventListener("change", () => {
    chrome.storage.local.set({ waPipelineLive: waPipelineLiveEl.checked });
    window.nkToast(waPipelineLiveEl.checked ? "Live sending ENABLED — real WhatsApp replies will go out." : "Live sending disabled — pipeline replies are dry-run only.", waPipelineLiveEl.checked ? "warning" : "success");
  });
  if (waMentionIdEl) waMentionIdEl.addEventListener("change", () => {
    chrome.storage.local.set({ waMentionId: waMentionIdEl.value.trim() });
  });

  // WA-Campaigns Raw Action Test — calls background's nkWaCallAction relay,
  // which calls modules/whatsapp-pipeline.js's callWaAction directly (the
  // exact same function the real pipeline uses) against WA-Campaigns' real
  // external API. Deliberately NOT gated by the Live Sending toggle above —
  // this is meant to be tested BEFORE that toggle is ever turned on.
  const waTestWaId      = document.getElementById("wa-test-waid");
  const waTestText      = document.getElementById("wa-test-text");
  const waTestMediaFile = document.getElementById("wa-test-mediafile");
  const waTestResult    = document.getElementById("wa-test-result");
  function showWaTestResult(obj) {
    if (!waTestResult) return;
    waTestResult.style.display = "block";
    waTestResult.textContent = JSON.stringify(obj, null, 2);
  }
  function callWaActionFromPopup(action, payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "nkWaCallAction", action, payload }, (resp) => {
        if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
        resolve(resp);
      });
    });
  }
  document.getElementById("wa-test-openchat")?.addEventListener("click", async () => {
    const waId = (waTestWaId && waTestWaId.value.trim()) || "";
    if (!waId) { window.nkToast("Enter a WhatsApp ID first.", "error"); return; }
    const resp = await callWaActionFromPopup("openChat", { waId });
    showWaTestResult(resp);
    window.nkToast(resp && resp.ok ? "openChat sent." : (resp && resp.error) || "openChat failed.", resp && resp.ok ? "success" : "error");
  });
  document.getElementById("wa-test-sendtext")?.addEventListener("click", async () => {
    const waId = (waTestWaId && waTestWaId.value.trim()) || "";
    const text = (waTestText && waTestText.value.trim()) || "";
    if (!waId || !text) { window.nkToast("Enter a WhatsApp ID and text first.", "error"); return; }
    const resp = await callWaActionFromPopup("sendText", { waId, text });
    showWaTestResult(resp);
    window.nkToast(resp && resp.ok ? "Text sent — check the chat." : (resp && resp.error) || "sendText failed.", resp && resp.ok ? "success" : "error");
  });
  document.getElementById("wa-test-sendmedia")?.addEventListener("click", () => {
    const waId = (waTestWaId && waTestWaId.value.trim()) || "";
    const file = waTestMediaFile && waTestMediaFile.files && waTestMediaFile.files[0];
    if (!waId || !file) { window.nkToast("Enter a WhatsApp ID and pick an image first.", "error"); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      const resp = await callWaActionFromPopup("sendMedia", { waId, dataUrl: reader.result, filename: file.name, caption: (waTestText && waTestText.value.trim()) || "" });
      showWaTestResult(resp);
      window.nkToast(resp && resp.ok ? "Media sent — check the chat." : (resp && resp.error) || "sendMedia failed.", resp && resp.ok ? "success" : "error");
    };
    reader.onerror = () => window.nkToast("Could not read the picked file.", "error");
    reader.readAsDataURL(file);
  });

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

  // ══════════════════════════════════════════════════════════
  // ── PIPELINE (Queue + Pipeline Logs) ─────────────────────────
  // ══════════════════════════════════════════════════════════
  // Same render-from-storage + chrome.storage.onChanged live-update pattern
  // as the Logs tab above (fmtLogTime, .log-row/.log-time/.log-msg, .logs-empty
  // are all reused from there).

  // WhatsApp Pipeline's own "i" info panel — no settings/gear, just this.
  (function () {
    const infoBtn = document.getElementById("pipeline-info-btn");
    const infoPanel = document.getElementById("pipeline-info-panel");
    if (!infoBtn || !infoPanel) return;
    infoBtn.addEventListener("click", () => {
      const open = infoPanel.style.display !== "none";
      infoPanel.style.display = open ? "none" : "";
      infoBtn.classList.toggle("info-btn-open", !open);
    });
  })();

  const RESERVATIONS_KEY = "waReservations";
  const pipelineQueueList  = document.getElementById("pipeline-queue-list");
  const pipelineQueueEmpty = document.getElementById("pipeline-queue-empty");
  const pipelineQueueRefresh = document.getElementById("pipeline-queue-refresh");
  const pipelineQueueClearStuck = document.getElementById("pipeline-queue-clear-stuck");
  const pipelineQueueClearAll = document.getElementById("pipeline-queue-clear-all");
  const pipelineLogsList   = document.getElementById("pipeline-logs-list");
  const pipelineLogsEmpty  = document.getElementById("pipeline-logs-empty");
  const pipelineLogsRefresh = document.getElementById("pipeline-logs-refresh");
  const pipelineLogsCopy   = document.getElementById("pipeline-logs-copy");
  const pipelineLogsClear  = document.getElementById("pipeline-logs-clear");
  const tabPipelineCount   = document.getElementById("tab-pipeline-count");

  const STATUS_COLORS = {
    confirmed: "#22c55e", cancelled: "#ef4444", conflict: "#ef4444",
    draft: "#f59e0b", not_found: "#9ca3af", unknown: "#9ca3af",
  };
  // Returns an element, not an HTML string — statuses come from this
  // codebase's own vocabulary so the injection risk is low either way, but
  // groupName/chatName below are ultimately sourced from CRM/WhatsApp text,
  // so the whole row is built via DOM APIs (textContent) rather than
  // innerHTML, matching how renderPipelineLogs already does it below.
  function statusBadge(status) {
    const span = document.createElement("span");
    span.textContent = (status || "unknown").toUpperCase();
    span.style.cssText = `display:inline-block; padding:1px 7px; border-radius:5px; font-size:10.5px; font-weight:700; color:#fff; background:${STATUS_COLORS[status] || "#9ca3af"};`;
    return span;
  }

  function renderPipelineQueue(db) {
    const records = Object.values(db || {}).sort((a, b) => (b.checkedAt || 0) - (a.checkedAt || 0));
    if (tabPipelineCount) {
      const active = records.filter((r) => r.status === "confirmed" && !r.repliedAt).length;
      tabPipelineCount.textContent = active > 99 ? "99+" : (active || "");
    }
    if (!records.length) {
      if (pipelineQueueEmpty) pipelineQueueEmpty.style.display = "block";
      if (pipelineQueueList) pipelineQueueList.innerHTML = "";
      return;
    }
    if (pipelineQueueEmpty) pipelineQueueEmpty.style.display = "none";
    if (!pipelineQueueList) return;
    const frag = document.createDocumentFragment();
    for (const r of records) {
      const row = document.createElement("div");
      row.className = "log-row";

      // Reservation number is the primary key someone scans this table for —
      // gets its own bolder class rather than the muted, timestamp-sized
      // .log-time treatment reused for the actual Logs tab.
      const resNo = document.createElement("span");
      resNo.className = "queue-resno";
      resNo.textContent = `UR-${r.reservationNo}`;

      const msg = document.createElement("span");
      msg.className = "log-msg";
      msg.appendChild(statusBadge(r.status));
      const mutamerCount = (r.mutamers || []).length;
      const paxLine = r.expectedPax ? ` ${mutamerCount}/${r.expectedPax} mutamer(s)` : ` ${mutamerCount} mutamer(s)`;
      const groupLine = r.groupName ? ` — group: ${r.groupName}` : "";
      const repliedTag = r.repliedAt ? " ✓ replied" : "";
      msg.appendChild(document.createTextNode(paxLine + groupLine + repliedTag));

      row.append(resNo, msg);
      frag.appendChild(row);
    }
    pipelineQueueList.innerHTML = "";
    pipelineQueueList.appendChild(frag);
  }
  function loadPipelineQueue() {
    chrome.storage.local.get([RESERVATIONS_KEY], (res) => renderPipelineQueue(res[RESERVATIONS_KEY]));
  }
  if (pipelineQueueRefresh) pipelineQueueRefresh.addEventListener("click", loadPipelineQueue);

  // Turning the Pipeline module off only stops NEW events from being
  // accepted — it doesn't touch anything already recorded, so a reservation
  // that got stuck mid-flight (an error, a page reload, the extension
  // itself reloading) stays stuck and can resurface once the module's
  // switched back on. This clears exactly that: reservations still marked
  // "confirmed" with no reply sent yet, plus the internal queue that
  // correlates OCR results back to a reservation. Anything already resolved
  // (not found/on hold/cancelled/conflict/already replied) is left alone.
  if (pipelineQueueClearStuck) pipelineQueueClearStuck.addEventListener("click", async () => {
    const ok = await window.nkConfirm(
      "Clear any reservation stuck mid-processing, plus the internal OCR-wait queue? Reservations that already got a reply (or were On hold/Cancelled/Not found) are left alone.",
      { confirmText: "Clear stuck queue", danger: true }
    );
    if (!ok) return;
    chrome.runtime.sendMessage({ type: "nkPipelineClearQueue" }, (res) => {
      if (!res || !res.ok) { window.nkToast(`Failed to clear: ${(res && res.error) || "unknown error"}`, "error"); return; }
      const n = res.clearedReservations.length;
      window.nkToast(`Cleared ${n} stuck reservation${n === 1 ? "" : "s"} and ${res.clearedFeedOrderCount} pending queue entr${res.clearedFeedOrderCount === 1 ? "y" : "ies"}`, "success");
      loadPipelineQueue();
    });
  });

  // Full reset — wipes EVERY tracked reservation, including already-replied
  // ones, plus the passport-reuse conflict index. For deliberately starting
  // fresh (clearing out accumulated test data), not routine stuck-reservation
  // recovery (that's the button above).
  if (pipelineQueueClearAll) pipelineQueueClearAll.addEventListener("click", async () => {
    const ok = await window.nkConfirm(
      "Clear the ENTIRE queue — including already-replied reservations — and the passport-reuse conflict history? This can't be undone. Use this to start completely fresh.",
      { confirmText: "Clear everything", danger: true }
    );
    if (!ok) return;
    chrome.runtime.sendMessage({ type: "nkPipelineClearAll" }, (res) => {
      if (!res || !res.ok) { window.nkToast(`Failed to clear: ${(res && res.error) || "unknown error"}`, "error"); return; }
      const n = res.clearedReservations.length;
      window.nkToast(`Cleared all ${n} reservation${n === 1 ? "" : "s"} — starting fresh`, "success");
      loadPipelineQueue();
    });
  });

  function renderPipelineLogs(logs) {
    const pipelineLogs = (Array.isArray(logs) ? logs : []).filter((e) => e.m && e.m.startsWith("Pipeline:"));
    if (!pipelineLogs.length) {
      if (pipelineLogsEmpty) pipelineLogsEmpty.style.display = "block";
      if (pipelineLogsList) pipelineLogsList.innerHTML = "";
      return;
    }
    if (pipelineLogsEmpty) pipelineLogsEmpty.style.display = "none";
    if (!pipelineLogsList) return;
    const frag = document.createDocumentFragment();
    for (let i = pipelineLogs.length - 1; i >= 0; i--) {
      const entry = pipelineLogs[i];
      const row = document.createElement("div");
      row.className = "log-row" + (entry.lvl === "warn" ? " log-warn" : entry.lvl === "error" ? " log-error" : "");
      const time = document.createElement("span");
      time.className = "log-time";
      time.textContent = fmtLogTime(entry.t);
      const msg = document.createElement("span");
      msg.className = "log-msg";
      msg.textContent = entry.m.replace(/^Pipeline:\s*/, "");
      row.append(time, msg);
      frag.appendChild(row);
    }
    pipelineLogsList.innerHTML = "";
    pipelineLogsList.appendChild(frag);
  }
  function loadPipelineLogs() {
    chrome.storage.local.get([LOGS_KEY], (res) => renderPipelineLogs(res[LOGS_KEY]));
  }
  if (pipelineLogsRefresh) pipelineLogsRefresh.addEventListener("click", loadPipelineLogs);

  if (pipelineLogsCopy) pipelineLogsCopy.addEventListener("click", () => {
    chrome.storage.local.get([LOGS_KEY], (res) => {
      const pipelineLogs = (Array.isArray(res[LOGS_KEY]) ? res[LOGS_KEY] : []).filter((e) => e.m && e.m.startsWith("Pipeline:"));
      if (!pipelineLogs.length) { showToast("No pipeline logs to copy"); return; }
      const text = pipelineLogs.map((e) => {
        const tag = e.lvl === "warn" ? " [WARN]" : e.lvl === "error" ? " [ERROR]" : "";
        return `${fmtLogTime(e.t)}${tag} ${e.m.replace(/^Pipeline:\s*/, "")}`;
      }).join("\n");
      navigator.clipboard.writeText(text)
        .then(() => showToast(`✓ Copied ${pipelineLogs.length} pipeline logs`))
        .catch(() => showToast("✗ Copy failed"));
    });
  });

  // Removes only the Pipeline-prefixed entries from the shared nkLogs array —
  // NOT the same as the main Logs tab's Clear, which wipes everything. This
  // section's own log volume can get noisy on its own (e.g. the WA-Campaigns
  // connect/disconnect churn before that was fixed), and clearing it
  // shouldn't also blow away unrelated module logs.
  if (pipelineLogsClear) pipelineLogsClear.addEventListener("click", () => {
    chrome.storage.local.get([LOGS_KEY], (res) => {
      const all = Array.isArray(res[LOGS_KEY]) ? res[LOGS_KEY] : [];
      const kept = all.filter((e) => !(e.m && e.m.startsWith("Pipeline:")));
      const removed = all.length - kept.length;
      if (!removed) { showToast("No pipeline logs to clear"); return; }
      chrome.storage.local.set({ [LOGS_KEY]: kept }, () => {
        showToast(`✓ Cleared ${removed} pipeline log${removed === 1 ? "" : "s"}`);
      });
    });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[RESERVATIONS_KEY]) renderPipelineQueue(changes[RESERVATIONS_KEY].newValue);
    if (changes[LOGS_KEY]) renderPipelineLogs(changes[LOGS_KEY].newValue);
  });

  loadPipelineQueue();
  loadPipelineLogs();

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
