/*
 * Nuskomate notifications — replaces every native alert()/confirm() (and any
 * bare console.log/warn used for user-facing feedback) with the extension's
 * own themed UI: a bottom-anchored toast for one-way messages, a themed
 * modal for yes/no confirmations (nkConfirm resolves to a boolean, same as
 * confirm() did — just async).
 *
 * Loaded BOTH as a content script (injected into masar.nusuk.sa, where a
 * native alert() would block the live page and look nothing like the rest
 * of the extension) and from popup.html (so popup/*.js gets the same API
 * instead of the OS dialog box). Same reasoning as utils/logger.js's
 * window.nkLog: one small always-loaded module, one global API, used
 * everywhere.
 *
 * Rendered inside a Shadow DOM host so masar.nusuk.sa's own (Angular/
 * PrimeNG) global CSS can never leak in, and our styles can never leak onto
 * the page either — this file carries its own copy of Nuskomate's theme
 * tokens (see popup/popup.css :root / [data-theme="dark"]) since a content
 * script has no access to that stylesheet.
 */
(function () {
  "use strict";
  if (window.nkToast && window.nkConfirm) return; // already injected in this document

  // ── Theme: mirror popup.js's uiTheme logic (system / light / dark) so an
  // on-page toast matches whatever the user picked in Settings, even though
  // this document never loads popup.css or sets data-theme itself. ────────
  let _theme = "light";
  function systemPrefersDark() {
    try { return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches; }
    catch (_) { return false; }
  }
  function refreshTheme() {
    try {
      chrome.storage.local.get(["uiTheme"], (res) => {
        const pref = res && res.uiTheme;
        _theme = (pref === "dark" || pref === "light") ? pref : (systemPrefersDark() ? "dark" : "light");
      });
    } catch (_) { _theme = systemPrefersDark() ? "dark" : "light"; }
  }
  refreshTheme();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.uiTheme) refreshTheme();
    });
  } catch (_) {}
  try { window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => refreshTheme()); } catch (_) {}

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ── Shadow host — created lazily, once, on first toast/confirm ─────────
  const CSS_TEXT = `
    :host {
      all: initial;
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      pointer-events: none;
      font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
      --nk-surface:     #ffffff;
      --nk-border:      #e2e7f0;
      --nk-text:        #1a2035;
      --nk-text-muted:  #6b7a99;
      --nk-accent:      #4f6ef7;
      --nk-accent-soft: #eef0ff;
      --nk-success:     #22c55e;
      --nk-warn:        #f97316;
      --nk-danger:      #e74c3c;
      --nk-shadow:      0 4px 20px rgba(20,25,50,.16);
      --nk-radius:      12px;
      --nk-radius-sm:   8px;
    }
    :host([data-theme="dark"]) {
      --nk-surface:     #1a1d27;
      --nk-border:      #2c3050;
      --nk-text:        #e8ecf8;
      --nk-text-muted:  #8892b0;
      --nk-accent:      #6c8bff;
      --nk-accent-soft: #1a2054;
      --nk-success:     #3ecf6e;
      --nk-warn:        #f0a040;
      --nk-danger:      #ec5f5f;
      --nk-shadow:      0 4px 22px rgba(0,0,0,.5);
    }
    * { box-sizing: border-box; }

    .nk-toast-container {
      position: fixed;
      left: 50%;
      bottom: 16px;
      transform: translateX(-50%);
      width: calc(100% - 32px);
      max-width: 340px;
      display: flex;
      flex-direction: column-reverse;
      gap: 8px;
      pointer-events: none;
    }
    .nk-toast {
      display: flex;
      align-items: flex-start;
      gap: 9px;
      padding: 11px 12px;
      border-radius: var(--nk-radius-sm);
      background: var(--nk-surface);
      color: var(--nk-text);
      border: 1px solid var(--nk-border);
      border-left: 3px solid var(--nk-text-muted);
      box-shadow: var(--nk-shadow);
      font-size: 12.5px;
      line-height: 1.45;
      pointer-events: auto;
      opacity: 0;
      transform: translateY(14px);
      transition: opacity .2s ease, transform .2s ease;
    }
    .nk-toast.show { opacity: 1; transform: translateY(0); }
    .nk-toast.hide { opacity: 0; transform: translateY(10px); }
    .nk-toast.success { border-left-color: var(--nk-success); }
    .nk-toast.warning { border-left-color: var(--nk-warn); }
    .nk-toast.error   { border-left-color: var(--nk-danger); }
    .nk-toast.info    { border-left-color: var(--nk-accent); }
    .nk-toast-icon { flex-shrink: 0; margin-top: 1px; display: flex; }
    .nk-toast.success .nk-toast-icon { color: var(--nk-success); }
    .nk-toast.warning .nk-toast-icon { color: var(--nk-warn); }
    .nk-toast.error   .nk-toast-icon { color: var(--nk-danger); }
    .nk-toast.info    .nk-toast-icon { color: var(--nk-accent); }
    .nk-toast-message { flex: 1; word-break: break-word; white-space: pre-line; }
    .nk-toast-close {
      flex-shrink: 0;
      background: none;
      border: none;
      color: var(--nk-text-muted);
      cursor: pointer;
      padding: 1px;
      display: flex;
      opacity: .7;
    }
    .nk-toast-close:hover { opacity: 1; color: var(--nk-text); }

    .nk-confirm-overlay {
      position: fixed;
      inset: 0;
      background: rgba(10, 14, 26, .48);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      opacity: 0;
      transition: opacity .15s ease;
      pointer-events: auto;
    }
    .nk-confirm-overlay.show { opacity: 1; }
    .nk-confirm-dialog {
      background: var(--nk-surface);
      color: var(--nk-text);
      border: 1px solid var(--nk-border);
      border-radius: var(--nk-radius);
      box-shadow: var(--nk-shadow);
      padding: 18px;
      width: 100%;
      max-width: 300px;
      transform: scale(.94) translateY(6px);
      transition: transform .15s ease;
    }
    .nk-confirm-overlay.show .nk-confirm-dialog { transform: scale(1) translateY(0); }
    .nk-confirm-message { margin: 0 0 16px; font-size: 13px; line-height: 1.5; white-space: pre-line; }
    .nk-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
    .nk-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 13px;
      border-radius: var(--nk-radius-sm);
      font-size: 12.5px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      border: 1.5px solid transparent;
      transition: background .15s ease, border-color .15s ease, color .15s ease;
    }
    .nk-btn:focus-visible { outline: 2px solid var(--nk-accent); outline-offset: 2px; }
    .nk-btn-ghost { background: transparent; border-color: var(--nk-border); color: var(--nk-text-muted); }
    .nk-btn-ghost:hover { border-color: var(--nk-text-muted); color: var(--nk-text); }
    .nk-btn-primary { background: var(--nk-accent); border-color: var(--nk-accent); color: #fff; }
    .nk-btn-primary:hover { filter: brightness(1.08); }
    .nk-btn-primary.danger { background: var(--nk-danger); border-color: var(--nk-danger); }
  `;

  const ICONS = {
    success: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 17.01"/></svg>',
    error: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    warning: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    info: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  };
  const CHECK_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
  const TRASH_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
  const CLOSE_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  const TOAST_DURATIONS = { error: 6000, warning: 5000, success: 3500, info: 4000 };

  let root = null;
  let toastContainer = null;
  function ensureRoot() {
    if (root) {
      root.host.setAttribute("data-theme", _theme);
      return root;
    }
    const host = document.createElement("div");
    host.setAttribute("data-theme", _theme);
    (document.body || document.documentElement).appendChild(host);
    root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS_TEXT;
    root.appendChild(style);
    toastContainer = document.createElement("div");
    toastContainer.className = "nk-toast-container";
    root.appendChild(toastContainer);
    return root;
  }

  function nkToast(message, type) {
    type = ICONS[type] ? type : "info";
    ensureRoot();
    const toast = document.createElement("div");
    toast.className = `nk-toast ${type}`;
    toast.innerHTML = `
      <span class="nk-toast-icon">${ICONS[type]}</span>
      <span class="nk-toast-message"></span>
      <button type="button" class="nk-toast-close" aria-label="Dismiss">${CLOSE_SVG}</button>
    `;
    toast.querySelector(".nk-toast-message").textContent = message;
    toastContainer.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("show"));

    let dismissTimer = null;
    function dismiss() {
      clearTimeout(dismissTimer);
      toast.classList.remove("show");
      toast.classList.add("hide");
      toast.addEventListener("transitionend", () => toast.remove(), { once: true });
    }
    toast.querySelector(".nk-toast-close").addEventListener("click", dismiss);
    dismissTimer = setTimeout(dismiss, TOAST_DURATIONS[type]);
  }

  // Replaces every confirm() — resolves to a boolean the same way confirm()
  // did, just async. `danger: true` renders the confirm button solid red
  // (destructive actions) with a trash icon instead of a checkmark.
  function nkConfirm(message, options) {
    options = options || {};
    const confirmText = options.confirmText || "OK";
    const cancelText = options.cancelText || "Cancel";
    const danger = !!options.danger;
    ensureRoot();
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "nk-confirm-overlay";
      overlay.innerHTML = `
        <div class="nk-confirm-dialog">
          <p class="nk-confirm-message"></p>
          <div class="nk-confirm-actions">
            <button type="button" class="nk-btn nk-btn-ghost nk-confirm-cancel">${CLOSE_SVG}${escapeHtml(cancelText)}</button>
            <button type="button" class="nk-btn nk-btn-primary${danger ? " danger" : ""} nk-confirm-ok">${danger ? TRASH_SVG : CHECK_SVG}${escapeHtml(confirmText)}</button>
          </div>
        </div>
      `;
      overlay.querySelector(".nk-confirm-message").textContent = message;
      root.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add("show"));

      const okBtn = overlay.querySelector(".nk-confirm-ok");
      okBtn.focus();

      let resolved = false;
      function close(result) {
        if (resolved) return;
        resolved = true;
        document.removeEventListener("keydown", onKeydown, true);
        overlay.classList.remove("show");
        overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
        resolve(result);
      }
      function onKeydown(e) {
        if (e.key === "Escape") { e.preventDefault(); close(false); }
        else if (e.key === "Enter") { e.preventDefault(); close(true); }
      }
      overlay.querySelector(".nk-confirm-cancel").addEventListener("click", () => close(false));
      okBtn.addEventListener("click", () => close(true));
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });
      // capture:true — on the live Masar page (unlike an isolated popup
      // document) the site's own Angular keydown handlers can otherwise
      // intercept Enter/Escape first and stop it from ever reaching us.
      document.addEventListener("keydown", onKeydown, true);
    });
  }

  window.nkToast = nkToast;
  window.nkConfirm = nkConfirm;
})();
