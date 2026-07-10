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
 *   POST /share      { rules } + X-License          → { ok, code }   (short share link)
 *   GET  /share/CODE                                → { ok, rules }  (fetch a share)
 *
 * Bindings (see wrangler.toml / README):
 *   LICENSES   KV namespace   key → customer name ("revoked" disables it)
 *   OCR_SPACE_KEY   secret    your ocr.space API key
 */
import NkPassport from "../utils/passport-parser.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-License, X-Device, X-Feature, X-Admin",
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });

// Default number of devices a single key may run on. Override per key by
// storing a JSON value: {"name":"Ali","seats":3,"devices":[]}
const DEFAULT_SEATS = 2;

// Load a key's record. A KV value can be either:
//   • a JSON object  {name, seats, devices, features?, expires?}   (full record)
//   • a JSON object  {name, master:true}            (MASTER — everything, never expires)
//   • a plain string "Ali Travels"                  (legacy → default seats, all features)
//   • the word       "revoked"                       (disabled)
// features : array of enabled tool ids, or null = ALL enabled (legacy/default).
// expires  : ISO date "YYYY-MM-DD" or epoch ms, or null = never expires.
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
  rec.features = Array.isArray(rec.features) ? rec.features.map(String) : null; // null = all
  if (rec.expires === undefined) rec.expires = null;
  return rec;
}

// A key is expired when "expires" is set and we're past the END of that day.
function isExpired(rec) {
  if (rec.master || !rec.expires) return false;
  const t = typeof rec.expires === "number" ? rec.expires : Date.parse(rec.expires);
  return Number.isFinite(t) && Date.now() > (t + 86400000); // +1 day = valid through that date
}

// Whether a key includes a given tool. Master / null features = everything.
function featureAllowed(rec, feature) {
  if (rec.master || rec.features === null) return true;
  return rec.features.includes(feature);
}

// Admin = the request carries a valid MASTER key in X-Admin. Only the master
// key holder may list/create/update/delete keys.
async function isAdmin(env, request) {
  const k = request.headers.get("X-Admin") || "";
  const rec = await getRecord(env, k);
  return !!(rec && rec.master);
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

// ── Rule sharing (short links) ───────────────────────────────────────────────
// Shared rule sets live in the SAME KV under a "share:" prefix (kept out of the
// admin key list). Creating a share requires a valid license; fetching one only
// needs the unguessable code. Shares expire after 180 days.
const SHARE_PREFIX = "share:";
const SHARE_TTL_SECONDS = 180 * 24 * 3600;
const SHARE_MAX_BYTES = 200000; // ~200 KB of rules is plenty

function newShareCode() {
  // 10 chars, no confusable characters (0/O, 1/l/I).
  const alphabet = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const b of bytes) code += alphabet[b % alphabet.length];
  return code;
}

// Friendly page shown if someone opens a share link in a browser.
function sharePage(code) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Nuskomate rules</title>
<body style="font-family:system-ui;max-width:480px;margin:60px auto;text-align:center;color:#222">
<h2>Nuskomate shared rules</h2>
<p>This link contains a shared rule set for the Nuskomate extension.</p>
<p>To import it: open the extension → the matching rules tab → <b>Import link</b> → paste this link.</p>
<p style="font-size:13px;color:#777">Code: <code>${code}</code></p></body>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } });
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
      // ── Fetch a shared rule set (no license needed — the code is the secret) ─
      const shareMatch = /^\/share\/([A-Za-z0-9]{6,24})$/.exec(url.pathname);
      if (shareMatch && request.method === "GET") {
        const raw = await env.LICENSES.get(SHARE_PREFIX + shareMatch[1]);
        if (raw == null) {
          // Browsers get the friendly page either way; the extension gets JSON.
          if ((request.headers.get("Accept") || "").includes("text/html")) return sharePage(shareMatch[1]);
          return json({ ok: false, error: "Share link not found or expired" }, 404);
        }
        if ((request.headers.get("Accept") || "").includes("text/html")) return sharePage(shareMatch[1]);
        let rules;
        try { rules = JSON.parse(raw); } catch (_) { return json({ ok: false, error: "Corrupt share" }, 500); }
        return json({ ok: true, rules });
      }

      // ── Create a share (requires a valid, licensed device) ────────────────
      if (url.pathname === "/share" && request.method === "POST") {
        const key = request.headers.get("X-License") || "";
        const device = request.headers.get("X-Device") || "";
        const rec = await getRecord(env, key);
        if (!rec) return json({ ok: false, error: "Invalid or revoked key" }, 403);
        if (isExpired(rec)) return json({ ok: false, error: "Key expired" }, 403);
        const adm = admitDevice(rec, device);
        if (!adm.ok) return json({ ok: false, error: adm.error }, 403);
        if (adm.changed) await env.LICENSES.put(key.trim(), JSON.stringify(rec));

        const body = await request.json().catch(() => null);
        const rules = body && body.rules;
        if (!Array.isArray(rules) || !rules.length) return json({ ok: false, error: "No rules to share" }, 400);
        const payload = JSON.stringify(rules);
        if (payload.length > SHARE_MAX_BYTES) return json({ ok: false, error: "Rule set too large to share" }, 400);

        const code = newShareCode();
        await env.LICENSES.put(SHARE_PREFIX + code, payload, { expirationTtl: SHARE_TTL_SECONDS });
        return json({ ok: true, code });
      }

      if (url.pathname === "/activate" && request.method === "POST") {
        const { key, device } = await request.json();
        const rec = await getRecord(env, key);
        if (!rec) return json({ ok: false, error: "Invalid or revoked key" }, 403);
        if (isExpired(rec)) return json({ ok: false, error: "Key expired" }, 403);
        const adm = admitDevice(rec, device);
        if (!adm.ok) return json({ ok: false, error: adm.error }, 403);
        if (adm.changed) await env.LICENSES.put(key.trim(), JSON.stringify(rec));
        return json({
          ok: true, name: rec.name, seats: rec.seats, used: rec.devices.length,
          features: rec.master ? null : rec.features, // null = all tools
          expires: rec.expires || null,
          master: rec.master, // unlocks the in-extension Keys admin tab
        });
      }

      // ── Admin (master key only): manage the whole key list ──────────────
      if (url.pathname.startsWith("/admin/") && request.method === "POST") {
        if (!(await isAdmin(env, request))) return json({ ok: false, error: "Not authorized" }, 403);

        if (url.pathname === "/admin/list") {
          const list = await env.LICENSES.list();
          const keys = [];
          for (const k of list.keys) {
            if (k.name.startsWith(SHARE_PREFIX)) continue; // rule shares aren't license keys
            const raw = await env.LICENSES.get(k.name);
            const revoked = String(raw || "").trim().toLowerCase() === "revoked";
            let rec = null;
            try { rec = JSON.parse(raw); } catch (_) {}
            if (rec && typeof rec === "object") {
              keys.push({
                key: k.name, name: rec.name || "", seats: rec.seats ?? null,
                devices: Array.isArray(rec.devices) ? rec.devices : [],
                features: Array.isArray(rec.features) ? rec.features : null,
                expires: rec.expires || null, master: !!rec.master, revoked: false,
              });
            } else {
              keys.push({
                key: k.name, name: revoked ? "(revoked)" : String(raw || ""),
                seats: null, devices: [], features: null, expires: null,
                master: false, revoked,
              });
            }
          }
          keys.sort((a, b) => a.key.localeCompare(b.key));
          return json({ ok: true, keys });
        }

        if (url.pathname === "/admin/put") {
          const { key, record } = await request.json();
          if (!key || !key.trim()) return json({ ok: false, error: "No key" }, 400);
          if (!record || typeof record !== "object") return json({ ok: false, error: "Bad record" }, 400);
          await env.LICENSES.put(key.trim(), JSON.stringify(record));
          return json({ ok: true });
        }

        if (url.pathname === "/admin/revoke") {
          const { key } = await request.json();
          if (!key || !key.trim()) return json({ ok: false, error: "No key" }, 400);
          await env.LICENSES.put(key.trim(), "revoked");
          return json({ ok: true });
        }

        if (url.pathname === "/admin/delete") {
          const { key } = await request.json();
          if (!key || !key.trim()) return json({ ok: false, error: "No key" }, 400);
          await env.LICENSES.delete(key.trim());
          return json({ ok: true });
        }

        return json({ ok: false, error: "Unknown admin action" }, 404);
      }

      if (url.pathname === "/scan" && request.method === "POST") {
        const key = request.headers.get("X-License") || "";
        const device = request.headers.get("X-Device") || "";
        const feature = request.headers.get("X-Feature") || "ocr";
        const rec = await getRecord(env, key);
        if (!rec) return json({ ok: false, error: "Invalid or revoked key" }, 403);
        if (isExpired(rec)) return json({ ok: false, error: "Key expired" }, 403);
        const adm = admitDevice(rec, device);
        if (!adm.ok) return json({ ok: false, error: adm.error }, 403);
        if (!featureAllowed(rec, feature)) return json({ ok: false, error: "This key does not include this feature" }, 403);
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
