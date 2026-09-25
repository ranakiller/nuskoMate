// AI tab — chat against a picked model: Gemini (cloud, needs the customer's
// own free key) or one of several local WebLLM models (free forever, no
// key, runs on-device via WebGPU — see webllm-runner.js). Also doubles as
// the live test for all of them: which is fast/accurate/rate-limited
// enough to actually build a pipeline decision on.
// Classic script, shares window.* globals with the rest of the popup.
(function () {
  "use strict";

  // value -> { provider: "gemini"|"local", supportsImage, hint }. "value" is
  // exactly the <option value> in popup.html's #ai-model-select — for local
  // models that's "local:<WebLLM model_id>", split apart in askProvider().
  const MODELS = {
    "gemini": { provider: "gemini", supportsImage: true, hint: "Cloud, best quality, but the free tier is rate-limited (~5 requests/min) — fine for occasional testing, not for a batch run." },
    "local:Qwen2.5-0.5B-Instruct-q4f16_1-MLC": { provider: "local", supportsImage: false, hint: "Smallest/fastest local model — expect weak judgment on nuanced decisions." },
    "local:Llama-3.2-1B-Instruct-q4f16_1-MLC": { provider: "local", supportsImage: false, hint: "Small local model — in testing here it hallucinated reservation numbers that weren't in the message." },
    "local:Qwen2.5-1.5B-Instruct-q4f16_1-MLC": { provider: "local", supportsImage: false, hint: "Mid-size local model." },
    "local:Llama-3.2-3B-Instruct-q4f16_1-MLC": { provider: "local", supportsImage: false, hint: "Bigger local model — better reasoning, bigger download, slower." },
    "local:Phi-3.5-mini-instruct-q4f16_1-MLC": { provider: "local", supportsImage: false, hint: "Strongest text-only local model in this list, ~3.7GB." },
    "local:Phi-3.5-vision-instruct-q4f16_1-MLC": { provider: "local", supportsImage: true, hint: "Only local model here with image support — ~4GB, needs a real GPU to be usable." },
  };

  const log = document.getElementById("ai-chat-log");
  const empty = document.getElementById("ai-chat-empty");
  const input = document.getElementById("ai-chat-input");
  const sendBtn = document.getElementById("ai-chat-send");
  const clearBtn = document.getElementById("ai-chat-clear");
  const keyWarning = document.getElementById("ai-key-warning");
  const keyWarningBtn = document.getElementById("ai-key-warning-btn");
  const localWarning = document.getElementById("ai-local-warning");
  const localWarningText = document.getElementById("ai-local-warning-text");
  const localProgress = document.getElementById("ai-local-progress");
  const localProgressText = document.getElementById("ai-local-progress-text");
  const localProgressFill = document.getElementById("ai-local-progress-fill");
  const modelSelect = document.getElementById("ai-model-select");
  const modelHint = document.getElementById("ai-model-hint");
  const modelDownloadBtn = document.getElementById("ai-model-download");
  const modelDeleteBtn = document.getElementById("ai-model-delete");
  const attachBtn = document.querySelector(".ai-attach-btn");
  const attachInput = document.getElementById("ai-attach-input");
  const attachPreview = document.getElementById("ai-attach-preview");
  const attachThumb = document.getElementById("ai-attach-thumb");
  const attachName = document.getElementById("ai-attach-name");
  const attachRemove = document.getElementById("ai-attach-remove");
  if (!log || !input || !sendBtn) return;

  // Persisted in chrome.storage.local (unlimitedStorage is already granted,
  // so base64 image attachments in history aren't a quota concern) — the
  // popup tears itself down on every close, so without this the chat reset
  // each time it reopened.
  const HISTORY_KEY = "aiChatHistory";
  const MODEL_KEY = "aiChatModel";
  let history = [];
  let sending = false;
  let pendingImage = null; // { dataUrl, mimeType, name }
  let selectedValue = "gemini"; // key into MODELS / <option value>
  let downloadStateToken = 0; // guards refreshDownloadState() against a fast model switch mid-check

  function currentModel() { return MODELS[selectedValue] || MODELS.gemini; }
  function localModelId() { return selectedValue.startsWith("local:") ? selectedValue.slice(6) : null; }

  function refreshKeyWarning() {
    chrome.storage.local.get(["geminiApiKey"], (res) => {
      const hasKey = !!(res.geminiApiKey && res.geminiApiKey.trim());
      if (keyWarning) keyWarning.style.display = (currentModel().provider === "gemini" && !hasKey) ? "flex" : "none";
    });
  }
  refreshKeyWarning();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.geminiApiKey) refreshKeyWarning();
  });

  if (keyWarningBtn) keyWarningBtn.addEventListener("click", () => {
    const tab = document.querySelector('[data-tab="settings"]');
    if (tab) tab.click();
    setTimeout(() => {
      const el = document.getElementById("gemini-api-key");
      if (el) el.focus();
    }, 50);
  });

  function setLocalWarning(text) {
    if (!localWarning) return;
    localWarning.style.display = text ? "flex" : "none";
    if (text && localWarningText) localWarningText.textContent = text;
  }

  function applyModelUI() {
    const model = currentModel();
    if (modelSelect) modelSelect.value = selectedValue;
    input.placeholder = model.provider === "local" ? "Message local model…" : "Message Gemini…";
    if (modelHint) modelHint.textContent = model.hint || "";
    // Only models flagged supportsImage can take an attachment — hide the
    // control otherwise so it can't imply support that isn't there.
    if (attachBtn) attachBtn.style.display = model.supportsImage ? "flex" : "none";
    if (!model.supportsImage) clearAttachment();
    refreshKeyWarning();

    if (model.provider === "local") {
      if (!window.NkWebLLM || !window.NkWebLLM.isSupported()) {
        setLocalWarning(window.NkWebLLM ? "WebGPU isn't available in this browser — local AI can't run here." : "Local AI failed to load — try reloading the extension.");
        if (modelDownloadBtn) modelDownloadBtn.style.display = "none";
        if (modelDeleteBtn) modelDeleteBtn.style.display = "none";
        return;
      }
      setLocalWarning(null);
      // Deliberately NOT loading/downloading here — picking a model from the
      // dropdown is just a selection. Download/delete are separate, explicit
      // actions via the two manual buttons below (refreshDownloadState()
      // decides which one to show); chat() still downloads on demand if the
      // user sends a message without clicking Download first.
      refreshDownloadState();
    } else {
      setLocalWarning(null);
      if (modelDownloadBtn) modelDownloadBtn.style.display = "none";
      if (modelDeleteBtn) modelDeleteBtn.style.display = "none";
    }
  }

  // Cache-only check (never downloads) — toggles which of the two manual
  // buttons is visible for the currently selected local model.
  async function refreshDownloadState() {
    const modelId = localModelId();
    if (!modelId || !window.NkWebLLM) return;
    const token = ++downloadStateToken;
    let downloaded = false;
    try {
      downloaded = await window.NkWebLLM.isDownloaded(modelId);
    } catch (err) {
      downloaded = false;
    }
    if (token !== downloadStateToken) return; // user switched models while this was in flight
    if (modelDownloadBtn) modelDownloadBtn.style.display = downloaded ? "none" : "inline-block";
    if (modelDeleteBtn) modelDeleteBtn.style.display = downloaded ? "inline-block" : "none";
  }

  function setModel(value) {
    if (value === selectedValue || !MODELS[value]) return;
    selectedValue = value;
    chrome.storage.local.set({ [MODEL_KEY]: selectedValue });
    applyModelUI();
  }
  if (modelSelect) modelSelect.addEventListener("change", () => setModel(modelSelect.value));

  if (modelDownloadBtn) modelDownloadBtn.addEventListener("click", async () => {
    const modelId = localModelId();
    if (!modelId || !window.NkWebLLM) return;
    modelDownloadBtn.disabled = true;
    try {
      await window.NkWebLLM.load(modelId, (text, fraction) => showLocalProgress(text, fraction));
      hideLocalProgress();
      if (window.nkToast) window.nkToast("Downloaded — ready to use.", "success");
      await refreshDownloadState();
    } catch (err) {
      hideLocalProgress();
      setLocalWarning((err && err.message) || "Failed to download this model.");
    }
    modelDownloadBtn.disabled = false;
  });

  if (modelDeleteBtn) modelDeleteBtn.addEventListener("click", async () => {
    const modelId = localModelId();
    if (!modelId || !window.NkWebLLM) return;
    const label = modelSelect ? modelSelect.options[modelSelect.selectedIndex].textContent : modelId;
    const ok = window.nkConfirm
      ? await window.nkConfirm(`Delete "${label}"'s downloaded files from disk? You'll need to re-download it (the full size again) to use it after this.`, { confirmText: "Delete", danger: true })
      : confirm(`Delete "${label}" from disk?`);
    if (!ok) return;
    modelDeleteBtn.disabled = true;
    try {
      await window.NkWebLLM.deleteModel(modelId);
      // Safe to re-check cache state here (unlike the old eager-load-on-select
      // path this used to dodge) — refreshDownloadState() only reads the
      // cache, it never downloads, so this just flips back to the Download button.
      await refreshDownloadState();
      if (window.nkToast) window.nkToast("Deleted from disk — it'll re-download next time you use it.", "success");
    } catch (err) {
      if (window.nkToast) window.nkToast("Couldn't delete: " + ((err && err.message) || "unknown error"), "error");
    }
    modelDeleteBtn.disabled = false;
  });

  function showLocalProgress(text, fraction) {
    if (!localProgress) return;
    localProgress.style.display = "block";
    if (localProgressText) localProgressText.textContent = text || "Loading local model…";
    if (localProgressFill && typeof fraction === "number") localProgressFill.style.width = Math.round(Math.max(0, Math.min(1, fraction)) * 100) + "%";
  }
  function hideLocalProgress() {
    if (localProgress) localProgress.style.display = "none";
    if (localProgressFill) localProgressFill.style.width = "0%";
  }

  if (attachInput) attachInput.addEventListener("change", () => {
    const file = attachInput.files && attachInput.files[0];
    attachInput.value = ""; // allow re-picking the same file later
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      pendingImage = { dataUrl: reader.result, mimeType: file.type || "image/jpeg", name: file.name };
      if (attachThumb) attachThumb.src = pendingImage.dataUrl;
      if (attachName) attachName.textContent = file.name;
      if (attachPreview) attachPreview.style.display = "flex";
    };
    reader.readAsDataURL(file);
  });

  function clearAttachment() {
    pendingImage = null;
    if (attachPreview) attachPreview.style.display = "none";
    if (attachThumb) attachThumb.src = "";
  }
  if (attachRemove) attachRemove.addEventListener("click", clearAttachment);

  function appendBubble(role, text, imageDataUrl) {
    if (empty) empty.style.display = "none";
    const row = document.createElement("div");
    row.className = "ai-msg ai-msg-" + role;
    const bubble = document.createElement("div");
    bubble.className = "ai-bubble";
    if (imageDataUrl) {
      const img = document.createElement("img");
      img.className = "ai-bubble-img";
      img.src = imageDataUrl;
      bubble.appendChild(img);
    }
    const textNode = document.createElement("span");
    textNode.textContent = text;
    bubble.appendChild(textNode);
    row.appendChild(bubble);
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    return { row, bubble, textNode };
  }

  function saveHistory() {
    chrome.storage.local.set({ [HISTORY_KEY]: history });
  }

  function renderHistory() {
    log.innerHTML = "";
    if (empty) log.appendChild(empty);
    if (!history.length) {
      if (empty) empty.style.display = "block";
      return;
    }
    history.forEach((m) => appendBubble(m.role, m.text, m.image && m.image.dataUrl));
  }

  chrome.storage.local.get([HISTORY_KEY, MODEL_KEY], (res) => {
    history = Array.isArray(res[HISTORY_KEY]) ? res[HISTORY_KEY] : [];
    renderHistory();
    selectedValue = MODELS[res[MODEL_KEY]] ? res[MODEL_KEY] : "gemini";
    applyModelUI();
  });
  // webllm-runner.js is a deferred module script — window.NkWebLLM may not
  // exist yet on the very first tick, so re-check once it's had a chance to load.
  window.addEventListener("load", () => { if (currentModel().provider === "local") applyModelUI(); });

  function setSending(v) {
    sending = v;
    sendBtn.disabled = v;
  }

  function autoGrow() {
    input.style.height = "auto";
    // scrollHeight reads 0 while the AI panel is hidden (another tab active)
    // — skip the resize then rather than collapsing the box to 0px.
    if (input.scrollHeight > 0) input.style.height = Math.min(input.scrollHeight, 120) + "px";
  }
  input.addEventListener("input", autoGrow);
  autoGrow();

  // Shared by the chat send() below and the batch decision tester — one
  // independent call to whichever provider is currently selected. `messages`
  // is the same [{role, text, image?}] shape used throughout; not tied to
  // the running chat `history`, so the batch tester can fire isolated
  // single-turn calls without polluting (or being polluted by) the chat.
  function askProvider(messages, onLocalProgress) {
    if (currentModel().provider === "local") {
      if (!window.NkWebLLM || !window.NkWebLLM.isSupported()) {
        return Promise.reject(new Error("WebGPU isn't available in this browser — local AI can't run here."));
      }
      return window.NkWebLLM.chat(localModelId(), messages, onLocalProgress);
    }
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "nkAiChat", messages }, (resp) => {
        if (!resp || !resp.ok) reject(new Error((resp && resp.error) || "no response"));
        else resolve(resp.text);
      });
    });
  }

  function finishAssistantTurn(pending, ok, textOrError) {
    setSending(false);
    hideLocalProgress();
    pending.bubble.classList.remove("ai-bubble-pending");
    if (!ok) {
      pending.textNode.textContent = "Error: " + textOrError;
      pending.row.classList.add("ai-msg-error");
      return;
    }
    pending.textNode.textContent = textOrError;
    history.push({ role: "assistant", text: textOrError });
    saveHistory();
    input.focus();
  }

  function send() {
    const text = input.value.trim();
    const image = currentModel().supportsImage ? pendingImage : null;
    if ((!text && !image) || sending) return;
    input.value = "";
    autoGrow();
    clearAttachment();
    const userMsg = { role: "user", text };
    if (image) userMsg.image = { dataUrl: image.dataUrl, mimeType: image.mimeType };
    history.push(userMsg);
    saveHistory();
    appendBubble("user", text || (image ? "(image only)" : ""), image && image.dataUrl);
    setSending(true);
    const pending = appendBubble("assistant", "Thinking…");
    pending.bubble.classList.add("ai-bubble-pending");

    askProvider(history, (progressText, fraction) => showLocalProgress(progressText, fraction))
      .then((replyText) => finishAssistantTurn(pending, true, replyText))
      .catch((err) => finishAssistantTurn(pending, false, (err && err.message) || "request failed"));
  }

  sendBtn.addEventListener("click", send);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  if (clearBtn) clearBtn.addEventListener("click", () => {
    history = [];
    chrome.storage.local.remove(HISTORY_KEY);
    clearAttachment();
    log.innerHTML = "";
    if (empty) {
      log.appendChild(empty);
      empty.style.display = "block";
    }
  });

  // ── Batch decision tester ─────────────────────────────────────────────
  const batchToggle = document.getElementById("ai-batch-toggle");
  const batchBody = document.getElementById("ai-batch-body");
  const batchInstruction = document.getElementById("ai-batch-instruction");
  const batchMessages = document.getElementById("ai-batch-messages");
  const batchRunBtn = document.getElementById("ai-batch-run");
  const batchResults = document.getElementById("ai-batch-results");

  if (batchToggle && batchBody) {
    batchToggle.addEventListener("click", () => {
      const showing = batchBody.style.display !== "none";
      batchBody.style.display = showing ? "none" : "block";
      batchToggle.textContent = showing ? "▾" : "▴";
    });
  }

  async function runBatch() {
    if (!batchInstruction || !batchMessages || !batchResults) return;
    const instruction = batchInstruction.value.trim();
    const lines = batchMessages.value.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!instruction || !lines.length) return;

    batchResults.innerHTML = "";
    batchRunBtn.disabled = true;
    const rows = lines.map((line) => {
      const row = document.createElement("div");
      row.className = "ai-batch-row ai-batch-row-pending";
      const msgEl = document.createElement("div");
      msgEl.className = "ai-batch-row-msg";
      msgEl.textContent = line;
      const resultEl = document.createElement("div");
      resultEl.className = "ai-batch-row-result";
      resultEl.textContent = "Running…";
      row.appendChild(msgEl);
      row.appendChild(resultEl);
      batchResults.appendChild(row);
      return { line, row, resultEl };
    });

    // Sequential, not parallel — a local model can only run one inference at
    // a time anyway. For Gemini, also paced with a delay between messages:
    // firing requests back-to-back (each already retrying up to 4x on a 503)
    // was enough to trip a hard network-level throttle from Google — real
    // pipeline usage is naturally spaced out by message arrival, this is
    // purely an artifact of a tight batch-test loop.
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (i > 0 && currentModel().provider === "gemini") await new Promise((res) => setTimeout(res, 1500));
      try {
        const text = await askProvider([{ role: "user", text: `${instruction}\n\nMessage: ${r.line}` }]);
        r.row.className = "ai-batch-row";
        r.resultEl.textContent = text;
      } catch (err) {
        r.row.className = "ai-batch-row ai-batch-row-error";
        r.resultEl.textContent = "Error: " + ((err && err.message) || "request failed");
      }
    }
    batchRunBtn.disabled = false;
  }
  if (batchRunBtn) batchRunBtn.addEventListener("click", runBatch);
})();
