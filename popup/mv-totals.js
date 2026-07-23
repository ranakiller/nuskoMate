// Mutamer/Voucher Totals — page list manager, living in Modules > Utilities.
// Search-first list (same visual language as the saved-emails list), but
// adding is a single "grab the current tab's URL" action instead of typing —
// this list is about "which pages am I on", so that's almost always what you
// actually want. The actual computing/injecting happens in
// modules/mv-totals.js on the page.
document.addEventListener("DOMContentLoaded", () => {
  const listEl = document.getElementById("mv-url-list");
  if (!listEl) return;

  const URLS_KEY = "mvTotalsUrls";
  const input = document.getElementById("mv-url-input");
  const addCurrentBtn = document.getElementById("mv-add-current");
  const exportBtn = document.getElementById("mv-export");
  const importInput = document.getElementById("mv-import");
  const infoBtn = document.getElementById("mv-info-btn");
  const infoPanel = document.getElementById("mv-info-panel");

  if (infoBtn && infoPanel) {
    infoBtn.addEventListener("click", () => {
      const open = infoPanel.style.display !== "none";
      infoPanel.style.display = open ? "none" : "";
      infoBtn.classList.toggle("info-btn-open", !open);
    });
  }

  // Gear button — expands/collapses the page-list block, collapsed by
  // default so the card doesn't show its settings permanently.
  const settingsBtn = document.getElementById("mv-settings-btn");
  const moduleExtra = document.getElementById("mv-module-extra");
  if (settingsBtn && moduleExtra) {
    settingsBtn.addEventListener("click", () => {
      const open = moduleExtra.style.display !== "none";
      moduleExtra.style.display = open ? "none" : "";
      settingsBtn.classList.toggle("module-gear-open", !open);
    });
  }

  let urls = [];
  let filter = "";
  let editingUrl = null; // the entry currently shown as an inline edit form

  function saveUrls(next, cb) {
    urls = next;
    chrome.storage.local.set({ [URLS_KEY]: next }, cb);
  }

  function render() {
    listEl.innerHTML = "";
    const q = filter.trim().toLowerCase();
    const shown = q ? urls.filter((u) => u.toLowerCase().includes(q)) : urls;

    if (!shown.length) {
      const empty = document.createElement("div");
      empty.className = "email-empty";
      empty.textContent = urls.length ? "No pages match your search" : "No pages added yet";
      listEl.appendChild(empty);
      return;
    }

    shown.forEach((url) => {
      const row = document.createElement("div");
      row.className = "email-item";

      // ── Inline edit mode: the row's own text becomes a small editable
      // field right where it sits — no separate box, no Save/Cancel
      // buttons. Enter saves, Esc cancels, click-away cancels. ──
      if (url === editingUrl) {
        row.classList.add("email-item-editing");

        const textWrap = document.createElement("span");
        textWrap.className = "email-text";

        const urlInp = document.createElement("input");
        urlInp.type = "text"; urlInp.className = "inline-text-input inline-addr-input";
        urlInp.value = url; urlInp.placeholder = "Page URL";
        urlInp.title = "Enter to save · Esc to cancel";

        const errEl = document.createElement("div");
        errEl.className = "inline-edit-error";

        const doSave = () => {
          const val = urlInp.value.trim();
          if (!val) { urlInp.classList.add("email-input-error"); errEl.textContent = "Can't be empty."; errEl.style.display = ""; return; }
          if (val !== url && urls.includes(val)) { urlInp.classList.add("email-input-error"); errEl.textContent = "Already in the list."; errEl.style.display = ""; return; }
          const next = urls.map((u) => (u === url ? val : u));
          editingUrl = null;
          saveUrls(next, render);
        };
        const doCancel = () => { editingUrl = null; render(); };

        urlInp.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); doSave(); }
          if (e.key === "Escape") { e.preventDefault(); doCancel(); }
        });
        urlInp.addEventListener("input", () => {
          urlInp.classList.remove("email-input-error");
          errEl.style.display = "none";
        });

        // Click away from the row (without Enter/Esc) cancels — never
        // leaves the row silently "stuck" in edit mode.
        row.addEventListener("focusout", () => {
          setTimeout(() => {
            if (editingUrl === url && !row.contains(document.activeElement)) doCancel();
          }, 0);
        });

        textWrap.append(urlInp, errEl);
        row.append(textWrap);
        listEl.appendChild(row);
        urlInp.focus();
        urlInp.select();
        return;
      }

      const textWrap = document.createElement("span");
      textWrap.className = "email-text";
      const addr = document.createElement("span");
      addr.className = "email-addr";
      addr.textContent = url;
      textWrap.appendChild(addr);

      const edit = document.createElement("button");
      edit.className = "email-edit";
      edit.title = "Edit";
      edit.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
      edit.addEventListener("click", (e) => { e.stopPropagation(); editingUrl = url; render(); });

      const del = document.createElement("button");
      del.className = "email-del";
      del.title = "Remove";
      del.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        saveUrls(urls.filter((u) => u !== url), render);
      });

      row.append(textWrap, edit, del);
      listEl.appendChild(row);
    });
  }

  input.addEventListener("input", () => { filter = input.value; render(); });

  if (addCurrentBtn) {
    addCurrentBtn.addEventListener("click", () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabUrl = tabs[0] && tabs[0].url;
        if (!tabUrl) return;
        let path;
        try { path = new URL(tabUrl).pathname; } catch (_) { path = tabUrl; }
        if (urls.includes(path)) return; // already saved, nothing to do
        saveUrls([...urls, path], render);
      });
    });
  }

  if (exportBtn) {
    exportBtn.addEventListener("click", () => {
      if (!urls.length) return;
      const blob = new Blob([urls.join("\n")], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), { href: url, download: "nuskomate-totals-pages.txt" });
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  if (importInput) {
    importInput.addEventListener("change", () => {
      const file = importInput.files && importInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const lines = String(reader.result || "").split("\n").map((s) => s.trim()).filter(Boolean);
        const merged = [...urls];
        lines.forEach((l) => { if (!merged.includes(l)) merged.push(l); });
        saveUrls(merged, render);
      };
      reader.readAsText(file);
      importInput.value = "";
    });
  }

  chrome.storage.local.get([URLS_KEY], (res) => {
    urls = Array.isArray(res[URLS_KEY]) ? res[URLS_KEY] : [];
    render();
  });
});
