// Media Grabber — scans the page open in the current tab for images, video,
// audio, inline SVGs and document links, shows them in a filterable/sortable
// grid, and downloads any one or a batch of them straight from their own
// source.
//
// The scan itself runs INSIDE the target page via chrome.scripting.
// executeScript's `func` — a plain, dependency-free function Chrome
// serializes and re-runs there directly, so (unlike Element Screenshot's
// interactive on-page picker) no separate injected content-script file is
// needed at all: this is one scan-and-return, not an ongoing on-page UI.
// Works on any http(s) tab with zero extra permissions.
//
// WhatsApp Web is the main target this was built for: it serves every
// image/video/sticker as an in-page `blob:` URL (confirmed against how
// existing WA media-scraper extensions target it — `img[src^="blob:"],
// video[src^="blob:"]`), never a real network URL, and only creates that
// blob once the item has actually been rendered/loaded in the chat — a
// message you've never scrolled to or opened simply has nothing to find
// yet. blob: URLs only resolve inside the document that created them, so
// they're converted to data URLs during the scan itself (see the
// blob-resolution pass below) rather than being handed to the popup as a
// bare blob: string it could never read. Document messages in WhatsApp
// often have no recognizable file extension in their link either — that's
// why isDocLink() below also treats a plain blob:-sourced <a> as a document
// candidate, not just one matching a known extension.
(function () {
  "use strict";

  // ── Runs INSIDE the page — must be fully self-contained (no closures over
  // anything outside itself; Chrome serializes this function's source and
  // re-parses it in the target document, so it can only use its own
  // parameters and standard globals). Captures EVERYTHING it finds — size
  // filtering happens client-side in the popup so the threshold can be
  // changed without re-scanning, and so a small image can still be revealed
  // by lowering it. ─────────────────────────────────────────────────────
  async function scanPageMedia() {
    const results = [];
    const seen = new Set();

    function push(item) {
      if (!item.url || seen.has(item.url)) return;
      seen.add(item.url);
      results.push(item);
    }
    function nameFromUrl(url) {
      try {
        const u = new URL(url, location.href);
        return decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
      } catch (_) { return ""; }
    }
    const isUsable = (src) => typeof src === "string" && /^(https?:|data:|blob:)/i.test(src);

    document.querySelectorAll("img").forEach((img) => {
      const src = img.currentSrc || img.src || img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("data-original");
      if (!isUsable(src)) return;
      const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      push({ type: "image", url: src, width: w || null, height: h || null, name: nameFromUrl(src) || "image" });
    });

    // CSS background-images — a huge share of real "photos" on the web are
    // painted this way rather than with an <img>, so skipping this would
    // miss most of a typical gallery/hero-image site.
    document.querySelectorAll("*").forEach((el) => {
      let bg;
      try { bg = getComputedStyle(el).backgroundImage; } catch (_) { return; }
      if (!bg || bg === "none") return;
      const m = /url\((['"]?)(.*?)\1\)/.exec(bg);
      if (!m) return;
      const src = m[2];
      if (!isUsable(src)) return;
      const rect = el.getBoundingClientRect();
      push({ type: "image", url: src, width: Math.round(rect.width) || null, height: Math.round(rect.height) || null, name: nameFromUrl(src) || "background-image" });
    });

    let svgIndex = 0;
    document.querySelectorAll("svg").forEach((svgEl) => {
      const rect = svgEl.getBoundingClientRect();
      try {
        if (!svgEl.getAttribute("xmlns")) svgEl.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        const xml = new XMLSerializer().serializeToString(svgEl);
        const dataUrl = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(xml)));
        svgIndex++;
        push({ type: "svg", url: dataUrl, width: Math.round(rect.width) || null, height: Math.round(rect.height) || null, name: `svg-${svgIndex}.svg` });
      } catch (_) {}
    });

    ["video", "audio"].forEach((tag) => {
      let i = 0;
      document.querySelectorAll(tag).forEach((el) => {
        const candidates = [el.currentSrc, el.getAttribute("src"), ...[...el.querySelectorAll("source")].map((s) => s.src)].filter(Boolean);
        const src = candidates.find(isUsable);
        if (!src) return;
        i++;
        push({ type: tag, url: src, poster: tag === "video" ? (el.poster || null) : null, name: nameFromUrl(src) || `${tag}-${i}` });
      });
    });

    // A document link either has a recognizable file extension, an explicit
    // download attribute, OR — WhatsApp Web's own pattern — a blob: href
    // with no extension at all (the visible filename is just text content).
    const DOC_EXT = /\.(pdf|docx?|pptx?|xlsx?|csv|zip|rar|7z|txt)(\?|#|$)/i;
    document.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href") || "";
      const resolved = a.href;
      if (!isUsable(resolved)) return;
      const looksLikeDoc = DOC_EXT.test(resolved) || a.hasAttribute("download") || href.startsWith("blob:");
      if (!looksLikeDoc) return;
      push({ type: "document", url: resolved, name: nameFromUrl(resolved) || (a.textContent || "").trim().slice(0, 60) || "document" });
    });

    // blob: sources only resolve inside the document that created them —
    // convert what's still readable to a data URL right here; anything that
    // fails (common for streaming/MediaSource video, or a blob WhatsApp has
    // since revoked) is flagged rather than silently dropped, so the grid
    // can show it as unavailable instead of just missing.
    for (const item of results) {
      if (!item.url.startsWith("blob:")) continue;
      try {
        const blob = await fetch(item.url).then((r) => r.blob());
        item.bytes = blob.size;
        item.url = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = () => reject(fr.error);
          fr.readAsDataURL(blob);
        });
      } catch (_) {
        item.unavailable = true;
      }
    }

    return { pageTitle: document.title, items: results };
  }

  // ── Icons (feather-style, matches the rest of the extension) ───────────
  const ICONS = {
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    document: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
    video: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>',
    audio: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    alert: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  };
  const svg = (name, size) => `<svg width="${size || 14}" height="${size || 14}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${ICONS[name] || ""}</svg>`;
  const TYPE_LABEL = { image: "Image", svg: "SVG", video: "Video", audio: "Audio", document: "Document" };
  const typeLabel = (t) => TYPE_LABEL[t] || t;
  const typeIcon = (t) => ({ video: "video", audio: "audio", document: "document" }[t] || "image");

  function extOf(item) {
    const name = item.name || "";
    const m = /\.([a-z0-9]{2,5})$/i.exec(name);
    if (m) return m[1].toLowerCase();
    const mimeMatch = /^data:([^;]+);/.exec(item.url || "");
    if (mimeMatch) {
      const mimeExt = { "image/svg+xml": "svg", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "audio/mpeg": "mp3", "application/pdf": "pdf" };
      if (mimeExt[mimeMatch[1]]) return mimeExt[mimeMatch[1]];
    }
    return "";
  }

  document.addEventListener("DOMContentLoaded", () => {
    const grid = document.getElementById("mg-grid");
    const empty = document.getElementById("mg-empty");
    const countEl = document.getElementById("mg-count");
    const rescanBtn = document.getElementById("mg-rescan");
    const dlSelectedBtn = document.getElementById("mg-dl-selected");
    const dlAllBtn = document.getElementById("mg-dl-all");
    const dlAllZipBtn = document.getElementById("mg-dl-all-zip");
    const selectAllBtn = document.getElementById("mg-select-all");
    const selectNoneBtn = document.getElementById("mg-select-none");
    const typeChipsEl = document.getElementById("mg-type-chips");
    const extFilterInput = document.getElementById("mg-ext-filter");
    const minSizeInput = document.getElementById("mg-min-size");
    const maxSizeInput = document.getElementById("mg-max-size");
    const sortSelect = document.getElementById("mg-sort");
    if (!grid) return; // this popup build doesn't have the Media tab

    let items = [];       // full scan result, stable order/index — selection is keyed to THIS array
    let checks = [];      // parallel to items
    let activeTypes = null; // null = "all types present" (set lazily once items are known)
    let visible = [];      // indices into items currently shown, after filter+sort

    // ── Range selection: shift+click a checkbox, or press-drag across cards
    // (Explorer/Photos-style "paint" select). Both work in terms of
    // POSITION WITHIN `visible` (what's actually on screen right now), not
    // the raw `items` index, since that's what "everything between here and
    // there" means to someone looking at the grid.
    let cbByIndex = new Map();  // item index -> its live checkbox element, rebuilt every render
    let lastVisIdx = null;      // shift-click anchor
    let dragging = false, dragPaintValue = null, dragLastVisIdx = null;
    function setCheck(idx, val) {
      if (items[idx].unavailable) return;
      checks[idx] = val;
      const cb = cbByIndex.get(idx);
      if (cb) cb.checked = val;
    }
    function paintRange(fromVisIdx, toVisIdx, val) {
      const lo = Math.min(fromVisIdx, toVisIdx), hi = Math.max(fromVisIdx, toVisIdx);
      for (let p = lo; p <= hi; p++) setCheck(visible[p], val);
      refreshSelectedEnabled();
    }
    // A drag that ends outside the grid (or outside the window entirely)
    // still has to stop "painting" — mouseup only reliably reaches
    // `document` if the button comes up while still inside it, so `blur`
    // covers the mouse leaving the window mid-drag too.
    document.addEventListener("mouseup", () => { dragging = false; });
    window.addEventListener("blur", () => { dragging = false; });

    // Download Selected always reflects the GLOBAL selection (checks persist
    // across filter changes — you can check some SVGs, switch the type
    // filter to Documents, check a couple of those too, and Download
    // Selected still covers all of them). The other three act on whatever's
    // currently VISIBLE, so "All"/"None" mean "of what I'm looking at now".
    function refreshSelectedEnabled() {
      dlSelectedBtn.disabled = !checks.some(Boolean);
    }
    function setVisibleButtonsEnabled(has) {
      dlAllBtn.disabled = !has;
      dlAllZipBtn.disabled = !has;
      selectAllBtn.disabled = !has;
      selectNoneBtn.disabled = !has;
    }

    function buildTypeChips() {
      typeChipsEl.textContent = "";
      const present = [...new Set(items.map((it) => it.type))];
      if (!present.length) return;
      const allBtn = document.createElement("button");
      allBtn.type = "button"; allBtn.className = "mg-chip" + (activeTypes === null ? " mg-chip-active" : "");
      allBtn.textContent = "All";
      allBtn.addEventListener("click", () => { activeTypes = null; buildTypeChips(); applyFiltersAndSort(); });
      typeChipsEl.appendChild(allBtn);
      present.forEach((t) => {
        const count = items.filter((it) => it.type === t).length;
        const btn = document.createElement("button");
        btn.type = "button";
        const isActive = activeTypes === null || activeTypes.has(t);
        btn.className = "mg-chip" + (isActive ? " mg-chip-active" : "");
        btn.textContent = `${typeLabel(t)} (${count})`;
        btn.addEventListener("click", () => {
          // First click while "All" is active narrows down to just this type;
          // afterwards chips toggle independently so more than one can be on.
          if (activeTypes === null) activeTypes = new Set([t]);
          else if (activeTypes.has(t)) { activeTypes.delete(t); if (!activeTypes.size) activeTypes = null; }
          else activeTypes.add(t);
          buildTypeChips();
          applyFiltersAndSort();
        });
        typeChipsEl.appendChild(btn);
      });
    }

    // The size filter is ONE dual-handle range. Slider units are non-linear
    // (finer near zero, where the interesting sizes are — 32px icons vs 4000px
    // photos) so a short track still allows precise small values.
    const SLIDER_MAX = 1000, PX_MAX = 4000;
    const sliderToPx = (v) => Math.round(PX_MAX * Math.pow(Number(v) / SLIDER_MAX, 2));
    const rangeFill = document.getElementById("mg-range-fill");
    const rangeMinVal = document.getElementById("mg-range-min-val");
    const rangeMaxVal = document.getElementById("mg-range-max-val");
    function syncRangeUi() {
      const lo = Number(minSizeInput.value), hi = Number(maxSizeInput.value);
      if (rangeFill) { rangeFill.style.left = (lo / SLIDER_MAX * 100) + "%"; rangeFill.style.right = (100 - hi / SLIDER_MAX * 100) + "%"; }
      if (rangeMinVal) rangeMinVal.textContent = sliderToPx(lo);
      if (rangeMaxVal) rangeMaxVal.textContent = hi >= SLIDER_MAX ? PX_MAX + "+" : sliderToPx(hi);
      // Whichever handle is on top must stay grabbable when both sit at the same end.
      minSizeInput.style.zIndex = lo > SLIDER_MAX * 0.9 ? 3 : 2;
    }
    function passesFilters(item) {
      if (activeTypes && !activeTypes.has(item.type)) return false;
      const extFilter = extFilterInput.value.trim().replace(/^\./, "").toLowerCase();
      if (extFilter && !extOf(item).includes(extFilter)) return false;
      const minSize = sliderToPx(minSizeInput.value);
      if (minSize > 0 && item.width && item.height && (item.width < minSize || item.height < minSize)) return false;
      if (Number(maxSizeInput.value) < SLIDER_MAX) { // slider fully right = no upper limit
        const maxSize = sliderToPx(maxSizeInput.value);
        if (item.width && item.height && (item.width > maxSize || item.height > maxSize)) return false;
      }
      return true;
    }

    function sortIndices(indices) {
      const mode = sortSelect.value;
      const area = (i) => (items[i].width && items[i].height) ? items[i].width * items[i].height : -1;
      const withArea = indices.filter((i) => area(i) >= 0), noArea = indices.filter((i) => area(i) < 0);
      switch (mode) {
        case "type":
          return [...indices].sort((a, b) => typeLabel(items[a].type).localeCompare(typeLabel(items[b].type)) || a - b);
        case "name":
          return [...indices].sort((a, b) => (items[a].name || "").localeCompare(items[b].name || ""));
        case "largest":
          return [...withArea.sort((a, b) => area(b) - area(a)), ...noArea];
        case "smallest":
          return [...withArea.sort((a, b) => area(a) - area(b)), ...noArea];
        default:
          return indices; // "found" — scan order
      }
    }

    function filenameFor(item, i) {
      let name = (item.name || "").trim();
      if (!name || name.length > 100) name = `${item.type}-${i + 1}`;
      if (!/\.[a-z0-9]{2,5}$/i.test(name)) {
        const ext = extOf(item) || (item.type === "video" ? "mp4" : item.type === "audio" ? "mp3" : item.type === "document" ? "pdf" : "jpg");
        name = `${name}.${ext}`;
      }
      name = name.replace(/[\\/:*?"<>|]/g, "_");
      return window.nkBrandFilename ? window.nkBrandFilename(name) : name;
    }

    function downloadOne(item, i) {
      chrome.downloads.download({ url: item.url, filename: filenameFor(item, i) }, () => { void chrome.runtime.lastError; });
    }
    function downloadMany(list) {
      // Staggered — firing many downloads in the same instant is exactly the
      // pattern Chrome's own "site is trying to download multiple files"
      // guard watches for (same reasoning as File Tools' downloadEach).
      list.forEach(({ item, i }, n) => setTimeout(() => downloadOne(item, i), n * 350));
    }

    // chrome.downloads.download() from a blob: URL, same pattern as
    // groups.js's own Excel export — the blob URL is only revoked once the
    // download actually finishes, since chrome.downloads needs it to stay
    // alive while it reads the data.
    function downloadBlobFile(blob, filename) {
      const url = URL.createObjectURL(blob);
      chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
        if (chrome.runtime.lastError || !downloadId) { URL.revokeObjectURL(url); return; }
        const onChanged = (delta) => {
          if (delta.id !== downloadId || !delta.state) return;
          URL.revokeObjectURL(url);
          chrome.downloads.onChanged.removeListener(onChanged);
        };
        chrome.downloads.onChanged.addListener(onChanged);
      });
    }

    // Unlike a single item's download (handed straight to chrome.downloads
    // as a URL — Chrome fetches it directly, the popup never touches the
    // bytes), a zip needs the actual bytes in hand to pack, so this fetches
    // every item itself first. host_permissions is <all_urls>, so this
    // fetch isn't subject to the target page's own CORS policy the way a
    // content script's would be.
    async function downloadAllAsZip() {
      const list = visible.filter((i) => !items[i].unavailable);
      if (!list.length) return;
      const label = dlAllZipBtn.textContent;
      dlAllZipBtn.disabled = true; dlAllZipBtn.textContent = "Zipping…";
      try {
        const used = new Set();
        const entries = [];
        for (const i of list) {
          let name = filenameFor(items[i], i);
          if (used.has(name)) {
            const dot = name.lastIndexOf(".");
            let n = 2, candidate;
            do { candidate = dot < 0 ? `${name} (${n})` : `${name.slice(0, dot)} (${n})${name.slice(dot)}`; n++; } while (used.has(candidate));
            name = candidate;
          }
          used.add(name);
          const blob = await fetch(items[i].url).then((r) => r.blob());
          entries.push({ name, blob });
        }
        const zipBlob = await window.NkZip.blob(entries);
        const zipName = window.nkBrandFilename ? window.nkBrandFilename("media.zip") : "media.zip";
        downloadBlobFile(zipBlob, zipName);
      } catch (err) {
        window.nkToast && window.nkToast("Couldn't build the zip: " + ((err && err.message) || "unknown error"), "error");
      } finally {
        dlAllZipBtn.disabled = !visible.length;
        dlAllZipBtn.textContent = label;
      }
    }

    function card(item, i) {
      const el = document.createElement("div");
      el.className = "mg-card" + (item.unavailable ? " mg-unavailable" : "");

      const thumbWrap = document.createElement("div");
      thumbWrap.className = "mg-thumb";
      const thumbSrc = item.type === "video" ? item.poster : (item.type === "image" || item.type === "svg" ? item.url : null);
      if (thumbSrc && !item.unavailable) {
        const img = document.createElement("img");
        img.src = thumbSrc; img.loading = "lazy"; img.alt = item.name || "";
        img.draggable = false; // otherwise a native image-drag ghost fights the press-drag select below
        img.addEventListener("error", () => {
          thumbWrap.textContent = "";
          thumbWrap.classList.add("mg-thumb-icon");
          thumbWrap.innerHTML = svg(typeIcon(item.type), 26);
        });
        thumbWrap.appendChild(img);
      } else {
        thumbWrap.classList.add("mg-thumb-icon");
        thumbWrap.innerHTML = svg(item.unavailable ? "alert" : typeIcon(item.type), 26);
      }

      const check = document.createElement("label");
      check.className = "mg-select";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!checks[i];
      cb.disabled = !!item.unavailable;
      cbByIndex.set(i, cb);
      // State is fully driven by the card's own mousedown handler below
      // (checked directly on it, not just the checkbox) — this just
      // swallows the checkbox's native click-to-toggle default action so it
      // can never race against our own write. Without this, a click landing
      // exactly on the checkbox toggles it natively as PART OF the click
      // event's default action; since that happens AFTER our mousedown
      // handler already wrote the correct value, the browser's own toggle
      // silently overwrites it right back on the one checkbox actually
      // clicked — which looked like "the range applies to everything
      // except the one I clicked."
      cb.addEventListener("click", (e) => e.preventDefault());
      check.appendChild(cb);

      const dl = document.createElement("button");
      dl.type = "button";
      dl.className = "mg-dl-btn";
      dl.title = item.unavailable ? "Not downloadable — its source is no longer readable" : "Download";
      dl.innerHTML = svg("download", 13);
      dl.disabled = !!item.unavailable;
      dl.addEventListener("click", () => downloadOne(item, i));

      const meta = document.createElement("div");
      meta.className = "mg-meta";
      const typeSpan = document.createElement("span"); typeSpan.className = "mg-type"; typeSpan.textContent = typeLabel(item.type);
      meta.appendChild(typeSpan);
      if (item.width && item.height) {
        const dimSpan = document.createElement("span"); dimSpan.className = "mg-dim"; dimSpan.textContent = `${item.width}×${item.height}`;
        meta.appendChild(dimSpan);
      }

      // Press-and-drag across cards (e.g. from row 1 down through row 3,
      // then release) selects everything the pointer passed over — same
      // "paint" gesture as Google Photos/Explorer. Starts from ANYWHERE on
      // the card, including the checkbox itself (its own native toggle is
      // fully disabled above, precisely so this one handler is the single
      // source of truth instead of fighting the browser's default action) —
      // everything except the standalone download button. Shift+click is
      // handled here too, before the drag-start branch, since a plain
      // drag-start would otherwise treat a shift+click as "start a new
      // one-item drag here" instead of "extend the range from last click".
      if (!item.unavailable) {
        el.addEventListener("mousedown", (e) => {
          if (e.button !== 0 || e.target.closest(".mg-dl-btn")) return;
          e.preventDefault(); // don't let the browser start a text/image selection while painting
          const visIdx = visible.indexOf(i);
          if (e.shiftKey && lastVisIdx !== null) {
            paintRange(lastVisIdx, visIdx, true);
            lastVisIdx = visIdx;
            return;
          }
          dragging = true;
          dragPaintValue = !checks[i];
          dragLastVisIdx = visIdx;
          lastVisIdx = visIdx;
          setCheck(i, dragPaintValue);
          refreshSelectedEnabled();
        });
        el.addEventListener("mouseenter", () => {
          if (!dragging) return;
          const visIdx = visible.indexOf(i);
          paintRange(dragLastVisIdx, visIdx, dragPaintValue);
          dragLastVisIdx = visIdx;
          lastVisIdx = visIdx;
        });
      }

      el.append(check, thumbWrap, dl, meta);
      return el;
    }

    // Re-filters/sorts/re-renders WITHOUT re-scanning the page — filters and
    // sort are purely client-side over the already-scanned `items`, so
    // changing the min-size threshold (or any other filter) to reveal a
    // previously-hidden small image is instant.
    function applyFiltersAndSort() {
      const allIndices = items.map((_, i) => i);
      visible = sortIndices(allIndices.filter((i) => passesFilters(items[i])));
      grid.textContent = "";
      refreshSelectedEnabled();
      if (!items.length) {
        empty.hidden = false;
        empty.textContent = "No media found on this page.";
        setVisibleButtonsEnabled(false);
        return;
      }
      if (!visible.length) {
        empty.hidden = false;
        empty.textContent = "Nothing matches the current filters.";
        setVisibleButtonsEnabled(false);
        return;
      }
      empty.hidden = true;
      visible.forEach((i) => grid.appendChild(card(items[i], i)));
      setVisibleButtonsEnabled(true);
    }

    function render() {
      checks = items.map(() => false);
      activeTypes = null;
      const counts = {};
      items.forEach((it) => { counts[it.type] = (counts[it.type] || 0) + 1; });
      countEl.textContent = items.length
        ? Object.keys(counts).map((t) => `${counts[t]} ${typeLabel(t).toLowerCase()}${counts[t] > 1 ? "s" : ""}`).join(", ")
        : "No media found";
      buildTypeChips();
      applyFiltersAndSort();
    }

    dlSelectedBtn.addEventListener("click", () => downloadMany(items.map((item, i) => ({ item, i })).filter((_, i) => checks[i])));
    dlAllBtn.addEventListener("click", () => downloadMany(visible.map((i) => ({ item: items[i], i })).filter(({ item }) => !item.unavailable)));
    dlAllZipBtn.addEventListener("click", downloadAllAsZip);
    selectAllBtn.addEventListener("click", () => {
      visible.forEach((i) => { if (!items[i].unavailable) checks[i] = true; });
      applyFiltersAndSort();
    });
    selectNoneBtn.addEventListener("click", () => {
      visible.forEach((i) => { checks[i] = false; });
      applyFiltersAndSort();
    });
    extFilterInput.addEventListener("input", applyFiltersAndSort);
    minSizeInput.addEventListener("input", () => {
      if (Number(minSizeInput.value) > Number(maxSizeInput.value)) maxSizeInput.value = minSizeInput.value; // handles can meet, never cross
      syncRangeUi(); applyFiltersAndSort();
    });
    maxSizeInput.addEventListener("input", () => {
      if (Number(maxSizeInput.value) < Number(minSizeInput.value)) minSizeInput.value = maxSizeInput.value;
      syncRangeUi(); applyFiltersAndSort();
    });
    syncRangeUi();
    sortSelect.addEventListener("change", applyFiltersAndSort);

    async function scan() {
      countEl.textContent = "Scanning…";
      grid.textContent = ""; empty.hidden = true;
      typeChipsEl.textContent = "";
      setVisibleButtonsEnabled(false);
      dlSelectedBtn.disabled = true;
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id || !/^https?:/.test(tab.url || "")) {
          countEl.textContent = "Open a regular web page first";
          items = [];
          return;
        }
        const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scanPageMedia });
        items = (res && res.result && res.result.items) || [];
        render();
      } catch (err) {
        countEl.textContent = "Couldn't scan this page";
        items = [];
        window.nkToast && window.nkToast("Media scan failed: " + ((err && err.message) || "unknown error"), "error");
      }
    }

    rescanBtn.addEventListener("click", scan);
    scan();
  });
})();
