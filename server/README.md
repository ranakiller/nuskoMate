# Nuskomate license server

A tiny Cloudflare Worker that gates the extension. It holds your OCR.space key
and runs the passport parser **server-side**, so the valuable logic never ships
inside the extension, and no scan happens without a key you issued.

## Why this is the secure part
- The extension becomes a thin client: it sends an image + the customer's key,
  and gets back parsed data. It contains **no parser and no OCR key**.
- Remove the client-side checks? Doesn't matter — the server still refuses
  without a valid key, and there's no parser to steal.
- Revoke a key in KV → that customer stops working within seconds.

## One-time setup
You need a free [Cloudflare](https://dash.cloudflare.com/sign-up) account.

```bash
cd server
npm i -g wrangler            # or: npx wrangler ...
wrangler login

# 1) Create the KV namespace that stores your keys
wrangler kv namespace create LICENSES
#   → copy the printed id into wrangler.toml ([[kv_namespaces]] id = "...")

# 2) Store your ocr.space API key as a secret (get a free one at ocr.space/ocrapi)
wrangler secret put OCR_SPACE_KEY
#   → paste your key when prompted

# 3) Deploy
wrangler deploy
#   → it prints your URL, e.g. https://nuskomate-license.<you>.workers.dev
```

Give that URL to me and I'll wire the extension to it (the `LICENSE_SERVER`
constant in `utils/license.js`).

## Device binding (anti-sharing)
Each install gets a random device id. A key works on a limited number of
devices (**seats**); the server registers each new device on first use and
rejects any beyond the limit ("Device limit reached"). Default is **2 seats**.

Because a freeloader who clears storage just consumes another seat, a shared
key can never exceed its cap — sharing is self-defeating.

## Issuing a key to a paying customer

> **Easiest:** activate the extension with the **master key**, open the **Keys**
> tab that appears, and create / edit / reset / revoke / delete keys right there
> (pick the tools and validity per key). The CLI below is just a fallback.

Pick any hard-to-guess string (e.g. a UUID). For the **default 2 seats**, a
plain note is enough:

```bash
wrangler kv key put --binding=LICENSES "NUSK-3F9A-7C21-B8E4" "Ali Travels (paid 2026-06)" --remote
```

To set a **custom number of seats**, store a JSON value instead:

```bash
wrangler kv key put --binding=LICENSES "NUSK-3F9A-7C21-B8E4" "{\"name\":\"Big Agency\",\"seats\":5,\"devices\":[]}" --remote
```

Send `NUSK-3F9A-7C21-B8E4` to the customer; they paste it into the extension.

> ⚠️ Always pass `--remote` — without it you only write to a local test copy.

## Resetting a customer's devices (new PC, reinstall)
Clear the registered devices but keep their seats/name:

```bash
wrangler kv key put --binding=LICENSES "NUSK-3F9A-7C21-B8E4" "{\"name\":\"Ali Travels\",\"seats\":2,\"devices\":[]}" --remote
```

(Or just re-issue with a plain note, which resets to default seats.)

## Revoking a key
```bash
wrangler kv key put --binding=LICENSES "NUSK-3F9A-7C21-B8E4" "revoked" --remote
# or delete it entirely:
wrangler kv key delete --binding=LICENSES "NUSK-3F9A-7C21-B8E4" --remote
```

## List / audit keys
```bash
wrangler kv key list --binding=LICENSES --remote
# inspect one key's devices:
wrangler kv key get --binding=LICENSES "NUSK-3F9A-7C21-B8E4" --remote
```

> You can also do all of this from the Cloudflare dashboard:
> Workers & Pages → KV → your LICENSES namespace.

## Note on `worker.js`
`worker.js` imports `../utils/passport-parser.js`. Wrangler bundles it
automatically (esbuild), so the parser is compiled into the deployed Worker —
it is **not** part of the extension build (`build.js` excludes the `server/`
folder).
