// Element Screenshot's on-page picker — injected on demand via
// chrome.scripting.executeScript (see popup/file-tools.js's "webshot" tool),
// NOT a persistent content script, so it only ever runs while actually
// picking. Same overall technique as utils/inspector.js (ElementInspector):
// capture-phase document listeners, highlight by mutating the target
// element's own inline style (saved/restored, no page CSS ever touched),
// Escape to cancel — but this picks a RANGE (drag from one element to
// another) instead of a single element, so it's its own small module rather
// than a mode bolted onto ElementInspector.
(function () {
  "use strict";

  // A earlier picker session in this same tab (user re-clicked "Capture
  // Elements" before finishing/canceling the last one) — tear it down first
  // so listeners never pile up and there's only ever one active picker.
  if (window.__nkWebshotCleanup) { try { window.__nkWebshotCleanup(); } catch (_) {} }
  if (window.__nkWebshotMsgListener) { try { chrome.runtime.onMessage.removeListener(window.__nkWebshotMsgListener); } catch (_) {} }

  const HOVER_STYLE = { outline: "2px solid #4f6ef7", outlineOffset: "-1px", backgroundColor: "rgba(79,110,247,.12)" };
  const ANCHOR_STYLE = { outline: "2px solid #22c55e", outlineOffset: "-1px", backgroundColor: "rgba(34,197,94,.14)" };
  const EDGE = 44;        // px from a viewport edge that triggers autoscroll while dragging
  const SCROLL_STEP = 22; // px per animation frame while autoscrolling

  let phase = "hover"; // "hover" | "dragging" | "done"
  let hoverEl = null, startEl = null, endEl = null;
  let lastClientX = 0, lastClientY = 0;
  let rafId = null;
  // Captured NOW, before any autoscroll-during-drag can move the page — the
  // scroll position to put back once capture finishes has to be where the
  // user actually was before they started picking, not wherever the drag
  // happened to leave the page sitting (nkWebshotPrepare, below, only runs
  // AFTER the whole pick gesture is already over).
  const origScrollX = window.scrollX, origScrollY = window.scrollY;

  // ── Shadow-hosted banner + live preview box — isolated the same way
  // utils/notify.js's toasts are, so nothing here can be affected by (or
  // leak into) the host page's own CSS, on any site. ─────────────────────
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
  (document.body || document.documentElement).appendChild(host);
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      .banner {
        position: fixed; top: 14px; left: 50%; transform: translateX(-50%);
        display: flex; align-items: center; gap: 10px;
        background: #1a1d27; color: #e8ecf8; border: 1px solid #2c3050; border-radius: 10px;
        padding: 9px 14px; font: 600 12.5px/1.4 "Segoe UI", system-ui, sans-serif;
        box-shadow: 0 4px 20px rgba(0,0,0,.35); pointer-events: auto;
      }
      .cancel { flex-shrink: 0; background: #2c3050; border: none; color: #e8ecf8; border-radius: 6px; padding: 5px 10px; font: inherit; cursor: pointer; }
      .cancel:hover { background: #3a3f66; }
      .preview {
        position: fixed; border: 2px dashed #22c55e; background: rgba(34,197,94,.10);
        box-sizing: border-box; display: none;
      }
    </style>
    <div class="banner"><span>Click an element, drag to another, release to capture that area &mdash; Esc to cancel</span><button type="button" class="cancel">Cancel</button></div>
    <div class="preview"></div>
  `;
  const previewBox = root.querySelector(".preview");
  root.querySelector(".cancel").addEventListener("click", () => userCancel());

  function isOwnUi(e) {
    const path = e.composedPath ? e.composedPath() : [];
    return path.indexOf(host) !== -1;
  }
  function setHighlight(el, style) {
    if (!el || !el.style || el === document.documentElement || el === document.body) return;
    if (!el.__nkWebshotOrig) el.__nkWebshotOrig = { outline: el.style.outline, outlineOffset: el.style.outlineOffset, backgroundColor: el.style.backgroundColor };
    Object.assign(el.style, style);
  }
  function clearHighlight(el) {
    if (!el || !el.__nkWebshotOrig) return;
    Object.assign(el.style, el.__nkWebshotOrig);
    delete el.__nkWebshotOrig;
  }
  function elementUnder(x, y) {
    const el = document.elementFromPoint(x, y);
    return el || document.body;
  }
  function paintPreview() {
    if (phase !== "dragging" || !startEl) { previewBox.style.display = "none"; return; }
    const a = startEl.getBoundingClientRect(), b = (endEl || startEl).getBoundingClientRect();
    const left = Math.min(a.left, b.left), top = Math.min(a.top, b.top);
    const right = Math.max(a.right, b.right), bottom = Math.max(a.bottom, b.bottom);
    previewBox.style.display = "block";
    previewBox.style.left = left + "px"; previewBox.style.top = top + "px";
    previewBox.style.width = Math.max(1, right - left) + "px"; previewBox.style.height = Math.max(1, bottom - top) + "px";
  }
  // Holding the drag near a viewport edge keeps scrolling even if the mouse
  // itself stops moving — a rAF loop, not tied to mousemove firing rate, is
  // what makes that work (this is exactly how it behaves in Photoshop/OS
  // drag-select tools).
  function autoscrollTick() {
    if (phase !== "dragging") { rafId = null; return; }
    let dx = 0, dy = 0;
    if (lastClientY < EDGE) dy = -SCROLL_STEP; else if (lastClientY > window.innerHeight - EDGE) dy = SCROLL_STEP;
    if (lastClientX < EDGE) dx = -SCROLL_STEP; else if (lastClientX > window.innerWidth - EDGE) dx = SCROLL_STEP;
    if (dx || dy) { window.scrollBy(dx, dy); endEl = elementUnder(lastClientX, lastClientY); paintPreview(); }
    rafId = requestAnimationFrame(autoscrollTick);
  }

  function onMouseMove(e) {
    lastClientX = e.clientX; lastClientY = e.clientY;
    if (isOwnUi(e)) return;
    if (phase === "hover") {
      const el = elementUnder(e.clientX, e.clientY);
      if (el !== hoverEl) { clearHighlight(hoverEl); hoverEl = el; setHighlight(hoverEl, HOVER_STYLE); }
    } else if (phase === "dragging") {
      endEl = elementUnder(e.clientX, e.clientY);
      paintPreview();
    }
  }
  function onMouseDown(e) {
    if (e.button !== 0 || isOwnUi(e)) return;
    e.preventDefault(); e.stopPropagation();
    clearHighlight(hoverEl); hoverEl = null;
    startEl = elementUnder(e.clientX, e.clientY);
    endEl = startEl;
    setHighlight(startEl, ANCHOR_STYLE);
    phase = "dragging";
    document.body.style.userSelect = "none";
    paintPreview();
    if (!rafId) rafId = requestAnimationFrame(autoscrollTick);
  }
  function onMouseUp(e) {
    if (phase !== "dragging" || isOwnUi(e)) return;
    e.preventDefault(); e.stopPropagation();
    endEl = elementUnder(e.clientX, e.clientY) || startEl;
    finish();
  }
  function onKeyDown(e) {
    if (e.key === "Escape" || e.key === "Esc") { e.preventDefault(); userCancel(); }
  }
  // The mousedown/mouseup this just consumed would otherwise still fire the
  // page's own click right after (a link, a button) — this is borrowing the
  // click for a selection, not asking the page to react to it.
  function onClickSuppress(e) {
    if (phase === "done" && !isOwnUi(e)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }
  }

  function finish() {
    const a = startEl.getBoundingClientRect(), b = endEl.getBoundingClientRect();
    const left = Math.min(a.left, b.left), top = Math.min(a.top, b.top);
    const right = Math.max(a.right, b.right), bottom = Math.max(a.bottom, b.bottom);
    const rect = {
      x: Math.round(left + window.scrollX), y: Math.round(top + window.scrollY),
      width: Math.round(right - left), height: Math.round(bottom - top),
    };
    phase = "done";
    tearDownUi();
    if (rect.width < 4 || rect.height < 4) {
      window.nkToast && window.nkToast("That selection was too small to capture.", "warning");
      window.__nkWebshotCleanup = null;
      return;
    }
    window.nkToast && window.nkToast("Capturing screenshot…", "info");
    registerDeliveryListener();
    chrome.runtime.sendMessage({ type: "nkWebshotSelected", rect, dpr: window.devicePixelRatio || 1, pageTitle: document.title })
      .catch(() => { window.nkToast && window.nkToast("Couldn't reach the extension to capture this — try again.", "error"); });
    window.__nkWebshotCleanup = null;
  }

  function tearDownUi() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    clearHighlight(hoverEl); clearHighlight(startEl); clearHighlight(endEl);
    document.body.style.userSelect = "";
    host.remove();
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("mousedown", onMouseDown, true);
    document.removeEventListener("mouseup", onMouseUp, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("click", onClickSuppress, true);
  }
  function userCancel() {
    tearDownUi();
    window.nkToast && window.nkToast("Screenshot selection canceled.", "info");
    window.__nkWebshotCleanup = null;
  }

  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("mouseup", onMouseUp, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("click", onClickSuppress, true);
  window.__nkWebshotCleanup = () => tearDownUi();

  // ── Messages FROM background, during the scroll + capture + stitch pass
  // that follows a successful selection. Only registered once picking is
  // actually done (finish() calls this) — no reason for the picker itself to
  // field these while the user's still choosing an area. ──────────────────
  function registerDeliveryListener() {
    function listener(msg, _sender, sendResponse) {
      if (msg.type === "nkWebshotPrepare") {
        const fixedEls = [].slice.call(document.querySelectorAll("*")).filter((el) => {
          const cs = getComputedStyle(el);
          return (cs.position === "fixed" || cs.position === "sticky") && el.offsetParent !== null;
        });
        window.__nkWebshotHidden = fixedEls.map((el) => ({ el, prev: el.style.visibility }));
        fixedEls.forEach((el) => { el.style.visibility = "hidden"; });
        sendResponse({ vw: window.innerWidth, vh: window.innerHeight });
        return true;
      }
      if (msg.type === "nkWebshotScrollTo") {
        window.scrollTo(msg.x, msg.y);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          setTimeout(() => sendResponse({ actualX: window.scrollX, actualY: window.scrollY }), 60);
        }));
        return true;
      }
      if (msg.type === "nkWebshotRestore") {
        (window.__nkWebshotHidden || []).forEach(({ el, prev }) => { el.style.visibility = prev; });
        window.__nkWebshotHidden = null;
        window.scrollTo(origScrollX, origScrollY);
        sendResponse({ ok: true });
        return true;
      }
      if (msg.type === "nkWebshotCopyClipboard") {
        (async () => {
          try {
            const blob = await (await fetch(msg.dataUrl)).blob();
            await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
            window.nkToast && window.nkToast("Screenshot copied to clipboard.", "success");
          } catch (err) {
            window.nkToast && window.nkToast("Couldn't copy to clipboard: " + (err && err.message), "error");
          }
          sendResponse({ ok: true });
        })();
        return true;
      }
      if (msg.type === "nkWebshotFailed") {
        window.nkToast && window.nkToast("Screenshot failed: " + (msg.error || "unknown error"), "error");
        chrome.runtime.onMessage.removeListener(listener);
        window.__nkWebshotMsgListener = null;
        return false;
      }
      if (msg.type === "nkWebshotDelivered") {
        const label = msg.mode === "download" ? "Screenshot downloaded."
          : msg.mode === "tab" ? "Screenshot opened in a new tab."
          : "Screenshot ready — open the extension to view it.";
        window.nkToast && window.nkToast(label, "success");
        chrome.runtime.onMessage.removeListener(listener);
        window.__nkWebshotMsgListener = null;
        return false;
      }
    }
    window.__nkWebshotMsgListener = listener;
    chrome.runtime.onMessage.addListener(listener);
  }
})();
