/*
 * Nuskomate license + scan server (Cloudflare Worker).
 *
 * This is the part that actually protects the product:
 *   • The OCR.space API key lives here as a secret (never in the extension).
 *   • The passport PARSER runs here (imported from the shared module), so the
 *     valuable logic is never shipped to users.
 *   • Every scan requires a valid activation key, checked against a KV list you
 *     control — revoke a key and that customer is cut off within seconds.
 *
 * Endpoints:
 *   POST /activate   { key }                       → { ok, name? }
 *   POST /scan       multipart "file" + X-License   → { ok, result, raw }
 *
 * Bindings (see wrangler.toml / README):
 *   LICENSES   KV namespace   key → customer name ("revoked" disables it)
 *   OCR_SPACE_KEY   secret    your ocr.space API key
 */
import NkPassport from "../utils/passport-parser.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-License",
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });

// A key is valid when it exists in KV and is not marked "revoked".
async function keyInfo(env, key) {
  if (!key || !env.LICENSES) return null;
  const val = await env.LICENSES.get(key.trim());
  if (val == null) return null;
  if (String(val).toLowerCase() === "revoked") return null;
  return val || "active";
}

async function ocrSpace(env, file) {
  const fd = new FormData();
  fd.append("file", file, file.name || "scan.jpg");
  fd.append("apikey", env.OCR_SPACE_KEY);
  fd.append("language", "eng");
  fd.append("scale", "true");
  fd.append("OCREngine", "2");
  fd.append("detectOrientation", "true");
  const res = await fetch("https://api.ocr.space/parse/image", { method: "POST", body: fd });
  if (!res.ok) throw new Error("OCR HTTP " + res.status);
  const data = await res.json();
  if (data.IsErroredOnProcessing) throw new Error(data.ErrorMessage?.[0] || "OCR error");
  return data.ParsedResults?.[0]?.ParsedText || "";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Nuskomate license server — OK", { headers: CORS });
    }

    try {
      if (url.pathname === "/activate" && request.method === "POST") {
        const { key } = await request.json();
        const info = await keyInfo(env, key);
        return info ? json({ ok: true, name: info }) : json({ ok: false, error: "Invalid or revoked key" }, 403);
      }

      if (url.pathname === "/scan" && request.method === "POST") {
        const key = request.headers.get("X-License") || "";
        const info = await keyInfo(env, key);
        if (!info) return json({ ok: false, error: "Invalid or revoked key" }, 403);

        const form = await request.formData();
        const file = form.get("file");
        if (!file) return json({ ok: false, error: "No image" }, 400);

        const raw = await ocrSpace(env, file);
        const parsed = NkPassport.parse(raw); // parser runs server-side
        return json({ ok: true, result: parsed, raw });
      }

      return json({ ok: false, error: "Not found" }, 404);
    } catch (err) {
      return json({ ok: false, error: String(err && err.message || err) }, 500);
    }
  },
};
