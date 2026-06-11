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

// Default number of devices a single key may run on. Override per key by
// storing a JSON value: {"name":"Ali","seats":3,"devices":[]}
const DEFAULT_SEATS = 2;

// Load a key's record. A KV value can be either:
//   • a JSON object  {name, seats, devices}        (full record)
//   • a JSON object  {name, master:true}           (MASTER — unlimited devices)
//   • a plain string "Ali Travels"                 (legacy → default seats)
//   • the word       "revoked"                      (disabled)
// Returns a normalized {name, seats, devices, master} object, or null if invalid.
async function getRecord(env, key) {
  if (!key || !env.LICENSES) return null;
  const raw = await env.LICENSES.get(key.trim());
  if (raw == null) return null;
  if (String(raw).trim().toLowerCase() === "revoked") return null;

  let rec = null;
  try { rec = JSON.parse(raw); } catch (_) { /* legacy plain string */ }
  if (!rec || typeof rec !== "object") rec = { name: String(raw) };

  if (typeof rec.seats !== "number" || rec.seats < 1) rec.seats = DEFAULT_SEATS;
  if (!Array.isArray(rec.devices)) rec.devices = [];
  if (!rec.name) rec.name = "active";
  rec.master = !!rec.master;
  return rec;
}

// Decide whether this device may use the key, registering it if there's room.
// Mutates rec.devices when a new device is admitted (caller persists it).
function admitDevice(rec, device) {
  if (rec.master) return { ok: true, changed: false }; // master key = unlimited, no tracking
  device = (device || "").trim();
  if (!device) return { ok: false, error: "Missing device id" };
  if (rec.devices.includes(device)) return { ok: true, changed: false };
  if (rec.devices.length < rec.seats) {
    rec.devices.push(device);
    return { ok: true, changed: true };
  }
  return { ok: false, error: `Device limit reached (${rec.seats}). Contact support to reset.` };
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
        const { key, device } = await request.json();
        const rec = await getRecord(env, key);
        if (!rec) return json({ ok: false, error: "Invalid or revoked key" }, 403);
        const adm = admitDevice(rec, device);
        if (!adm.ok) return json({ ok: false, error: adm.error }, 403);
        if (adm.changed) await env.LICENSES.put(key.trim(), JSON.stringify(rec));
        return json({ ok: true, name: rec.name, seats: rec.seats, used: rec.devices.length });
      }

      if (url.pathname === "/scan" && request.method === "POST") {
        const key = request.headers.get("X-License") || "";
        const device = request.headers.get("X-Device") || "";
        const rec = await getRecord(env, key);
        if (!rec) return json({ ok: false, error: "Invalid or revoked key" }, 403);
        const adm = admitDevice(rec, device);
        if (!adm.ok) return json({ ok: false, error: adm.error }, 403);
        if (adm.changed) await env.LICENSES.put(key.trim(), JSON.stringify(rec));

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
