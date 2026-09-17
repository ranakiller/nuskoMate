// Settings → Sites — where Nuskomate DOESN'T run.
//
// Nuskomate has <all_urls> host permission outright (manifest.json,
// 2026-09-16) — it runs everywhere by default, no per-site Chrome prompt.
// "Never run on" (blockedSites) is the one remaining lever: a plain
// preference this file owns end-to-end (no chrome.permissions involved at
// all anymore).
//
// Also exposes window.NkSiteAccess, which the rule editor in auto-clicker.js
// uses to warn when a rule names a blocked site.
(function () {
  "use strict";
  const U = window.NkUrlMatch;
  const KEYS = ["blockedSites"];

  let state = { blocked: [], loaded: false };
  const subs = [];

  function load(cb) {
    chrome.storage.local.get(KEYS, (res) => {
      state = {
        blocked: Array.isArray(res.blockedSites) ? res.blockedSites : [],
        loaded: true,
      };
      if (cb) cb(state);
      subs.forEach((f) => { try { f(state); } catch (_) {} });
    });
  }
  chrome.storage.onChanged.addListener((c, a) => { if (a === "local" && KEYS.some((k) => k in c)) load(); });
  load();

  const isBlocked = (host) => !U.isMasarHost(host) && state.blocked.some((b) => U.hostMatches(host, b));

  function setBlocked(next, cb) { chrome.storage.local.set({ blockedSites: next }, cb); }
  function blockHost(raw) {
    const host = U.parseInput(raw, "site").host;
    if (!host || !U.isValidHost(host)) { window.nkToast("Enter a website address, like example.com.", "error"); return false; }
    if (U.isMasarHost(host) || U.hostMatches(U.MASAR_HOST, host)) { window.nkToast("Masar is always on — it can't be blocked.", "warning"); return false; }
    if (state.blocked.includes(host)) { window.nkToast(`${host} is already on the list.`, "info"); return false; }
    setBlocked([...state.blocked, host].sort());
    return true;
  }
  const unblockHost = (host) => setBlocked(state.blocked.filter((b) => b !== host));

  window.NkSiteAccess = {
    get: () => state,
    onChange: (cb) => { if (typeof cb === "function") subs.push(cb); },
    isBlocked,
    blockHost, unblockHost,
  };

  // ── Settings UI ─────────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", () => {
    const section = document.getElementById("sites-section");
    if (!section) return;
    const $ = (id) => document.getElementById(id);

    const infoBtn = $("sites-info-btn"), infoPanel = $("sites-info-panel");
    if (infoBtn && infoPanel) infoBtn.addEventListener("click", () => {
      const open = infoPanel.style.display !== "none";
      infoPanel.style.display = open ? "none" : "";
      infoBtn.classList.toggle("info-btn-open", !open);
    });

    const ICON_TRASH = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';

    // The active tab's host, read once when the popup opens (and again when
    // the side panel follows you to another tab) — just to show/drive the
    // "Block this tab" affordance.
    let tab = { host: null, http: false };
    function readTab() {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const url = tabs && tabs[0] && tabs[0].url;
        if (!url) tab = { host: null, http: false };
        else {
          try { const u = new URL(url); tab = { host: u.hostname.toLowerCase(), http: /^https?:$/.test(u.protocol) }; }
          catch (_) { tab = { host: null, http: false }; }
        }
        renderCurrent();
      });
    }
    try {
      chrome.tabs.onActivated.addListener(readTab);
      chrome.tabs.onUpdated.addListener((_id, info) => { if (info.url || info.status === "complete") readTab(); });
    } catch (_) {}

    function setDot(el, kind) { el.className = "act-dot" + (kind ? " " + kind : ""); }

    function renderCurrent() {
      const hostEl = $("site-current-host"), stateEl = $("site-current-state"), dot = $("site-current-dot");
      const btn2 = $("site-current-btn2");
      btn2.hidden = true; btn2.onclick = null;

      if (tab.host === null) {
        hostEl.textContent = "This tab";
        stateEl.textContent = "Its address isn't visible from here — type the site below instead.";
        setDot(dot, ""); return;
      }
      if (!tab.http) {
        hostEl.textContent = "Browser page";
        stateEl.textContent = "Chrome doesn't let extensions run on its own pages.";
        setDot(dot, ""); return;
      }
      const host = U.cleanHost(tab.host);
      hostEl.textContent = host;
      if (U.isMasarHost(host)) {
        stateEl.textContent = "Always on";
        setDot(dot, "on"); return;
      }
      if (isBlocked(host)) {
        stateEl.textContent = "Blocked — it's on your Never run on list";
        setDot(dot, "warn");
        const b = state.blocked.find((x) => U.hostMatches(host, x));
        btn2.textContent = "Unblock"; btn2.hidden = false;
        btn2.onclick = () => unblockHost(b);
        return;
      }
      stateEl.textContent = "Running";
      setDot(dot, "on");
    }

    function row(host, opts) {
      const r = document.createElement("div");
      r.className = "email-item email-item-static site-item";
      const dot = document.createElement("span");
      setDot(dot, opts.dot || "");
      const text = document.createElement("span");
      text.className = "email-text";
      const addr = document.createElement("span");
      addr.className = "email-addr site-host";
      addr.textContent = host;
      text.appendChild(addr);
      r.append(dot, text);
      if (opts.onRemove) {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "email-del";
        del.title = opts.removeTitle || "Remove";
        del.setAttribute("aria-label", del.title);
        del.innerHTML = ICON_TRASH;
        del.addEventListener("click", opts.onRemove);
        r.appendChild(del);
      }
      return r;
    }

    function renderLists() {
      const blockList = $("site-block-list");
      blockList.textContent = "";
      if (!state.blocked.length) {
        const e = document.createElement("div");
        e.className = "email-empty";
        e.textContent = "Nothing blocked";
        blockList.appendChild(e);
      }
      state.blocked.forEach((h) => blockList.appendChild(row(h, {
        dot: "warn",
        removeTitle: `Unblock ${h}`,
        onRemove: () => unblockHost(h),
      })));
    }

    function render() { renderLists(); renderCurrent(); }

    const blockInput = $("site-block-input");
    function blockTyped() { if (blockHost(blockInput.value)) blockInput.value = ""; }
    $("site-block-add").addEventListener("click", blockTyped);
    blockInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); blockTyped(); } });
    $("site-block-current").addEventListener("click", () => {
      if (!tab.host || !tab.http) { window.nkToast("Open the website you want to block in this tab first.", "error"); return; }
      blockHost(tab.host);
    });

    subs.push(render);
    if (state.loaded) render();
    readTab();
  });
})();
