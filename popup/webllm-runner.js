// AI tab — local/offline models via WebLLM (WebGPU in-browser inference).
// Free forever, no API key, no rate limit — the trade is a one-time
// download per model (cached in the browser's Cache Storage after, real
// disk space — see deleteModel() below for reclaiming it) and, for the
// smaller models, weaker judgment than a hosted model. Lives in the popup
// page (has WebGPU + DOM); background.js can't host this without becoming a
// module service worker, which is a bigger, separate change — see
// popup.html's comment where this script is loaded.
import { MLCEngine, deleteModelAllInfoInCache, hasModelInCache } from "../utils/web-llm.min.js";

// One shared engine instance — switching models calls engine.reload(id)
// (WebLLM's own documented way to swap models) rather than constructing a
// new engine each time, so the runtime/cache machinery is reused.
let currentProgressHandler = null;
const engine = new MLCEngine({
  initProgressCallback: (report) => {
    if (currentProgressHandler) currentProgressHandler(report && report.text || "Loading…", report && typeof report.progress === "number" ? report.progress : null);
  },
});
let loadedModelId = null;
let loadPromise = null;

function ensureModel(modelId, onProgress) {
  currentProgressHandler = onProgress || null;
  if (loadedModelId === modelId) return Promise.resolve();
  if (loadPromise && loadPromise.modelId === modelId) return loadPromise.promise;
  const promise = engine.reload(modelId).then(() => { loadedModelId = modelId; loadPromise = null; });
  loadPromise = { modelId, promise };
  return promise.catch((err) => {
    loadPromise = null;
    throw err;
  });
}

window.NkWebLLM = {
  isSupported: () => "gpu" in navigator,

  // Cache-only check — never triggers a download. Drives the Download vs
  // Delete button toggle in ai.js.
  async isDownloaded(modelId) {
    return hasModelInCache(modelId);
  },

  // Loads (downloading first if needed) — called from the manual Download
  // button and from chat() below, never automatically on model select.
  async load(modelId, onProgress) {
    if (!("gpu" in navigator)) throw new Error("WebGPU isn't available in this browser — local AI can't run here.");
    return ensureModel(modelId, onProgress);
  },

  // messages: [{role: "user"|"assistant", text}] — same shape ai.js already
  // uses for Gemini. None of the text-only local models accept images.
  async chat(modelId, messages, onProgress) {
    if (!("gpu" in navigator)) {
      throw new Error("WebGPU isn't available in this browser — local AI can't run here.");
    }
    await ensureModel(modelId, onProgress);
    const oaMessages = (messages || [])
      .filter((m) => m.text)
      .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.text }));
    const reply = await engine.chat.completions.create({ messages: oaMessages });
    return reply.choices[0].message.content;
  },

  // Frees the real disk space a model's weights/wasm/config take up in the
  // browser's Cache Storage — not just an in-memory reference.
  async deleteModel(modelId) {
    await deleteModelAllInfoInCache(modelId);
    if (loadedModelId === modelId) loadedModelId = null; // force a real re-download if picked again
  },
};
