# Nuskomate — Chrome / Edge / Firefox Extension

> Automation toolkit for [masar.nusuk.sa](https://masar.nusuk.sa) Umrah registration — autofill, passport OCR, reactive click/fill/select rules, multi-step workflows, URL redirects, and cross-device sync. Licensed per-key, with server-side entitlement enforcement.

This is the **source repository** (private). Built releases (obfuscated, zip only) are published to the public [nuskomate-releases](https://github.com/ranakiller/nuskomate-releases) repo — that's what customers download and what the in-extension update checker points at.

---

## Modules — Passport & Form Automation

| Module | What it does |
|---|---|
| **Mutamer Details Autofill** | Pre-fills Email, Mobile, City, Profession, Passport Type, Birth Country, Marital Status, and phone country code automatically |
| **Auto Date Picker** | Type a short code (`DD`, `DDMM`, `DDMMYY`, or `DDMMYYYY`) into any calendar field on the page and it fills the date in — Enter, Tab, or a short pause confirms it. Type two dates at once (space-separated, or `+Nd`/`+Nm`/`+Ny` math off the first) to fill a date-range pair in one go |
| **Auto Issue Date** | Calculates the passport issue date from the expiry date and copies it to your clipboard |
| **Vaccine Image Upload** | Auto-uploads the bundled vaccine placeholder image to the vaccine file input |
| **Passport OCR** | Scans an uploaded passport image server-side (your own [free ocr.space key](https://ocr.space/ocrapi/freekey) + a custom MRZ-aware parser) and fills the form — name boxes, DOB, gender, issue date. Validates MRZ check digits and warns on a blurry/unreliable scan instead of silently filling wrong data. **Requires an OCR API key saved in Settings** — see note below |
| **Father Name** | Fills the father/husband name from OCR (toggle off to keep whatever Masar already has) — needs the same OCR key |
| **Batch Passports** | Select many passport images at once; the extension feeds them through the form one at a time — needs the same OCR key |
| **Auto Reload** | Reloads the tab after a configurable idle period — skips the tab while it's active, so it never interrupts you mid-edit |
| **Disable Overlay** | Removes Masar's blocking loading spinner so the page stays interactive |
| **Totals** | Running Mutamer/Voucher total + visible row count injected next to the paginator, on whichever pages you list |
| **Groups Export** | One click — fetches every page of Masar's Groups List (any filter tab) and immediately downloads a formatted `.xlsx`, clustered by Arrival date with a live `=SUM()` subtotal per date, a grand total, and a per-row Stay formula |
| **Copy** | Adds a one-click copy button (plus a fully configurable keyboard shortcut) on the Hotel Agreement, Mutamers List, Groups List, and Agreements pages — copies a clean, paste-ready summary to your clipboard. Every line of every format can be turned on/off individually in Settings |

> **OCR requires your own free ocr.space API key.** Every OCR-dependent feature (Passport OCR, Father Name, Batch Passports) sends that key to the license server with each scan, which uses it to call ocr.space on your behalf — there's no shared/fallback key. This is deliberate: with potentially thousands of installs, one shared key would hit ocr.space's free-tier rate limit for everyone at once. Add yours in Settings → OCR (a "get a free key" link is shown until one's saved); nothing OCR-related runs without it.

## Automation Tabs — Reactive Rules & Workflows

| Tab | What it does |
|---|---|
| **Automation Rules** | Reactive rules that click, fill, or select — one tab covers what used to be three separate ones (Autofill/Auto Clicker/Auto Select) |
| **Workflows** | Programmable step sequences — clicks, fills, waits, loops, if/else conditions, CSV data-driven runs, hotkeys, and an on-page recorder that turns your own clicks/typing into steps |
| **Translation Rules** | Field-to-field translation, or auto-detect-and-translate any foreign text on a page — either replaces the text in place, or leaves it untouched and shows the translation in an instant hover tooltip with a one-key commit if you want it copied into the page after all. Ships with 4 ready-made rules translating the Add Mutamer name fields to Arabic — edit or turn them off like any other rule |
| **URL Shifter** | Redirects to a target URL either when the current URL matches a condition, or when a chosen element appears anywhere on the page (even dynamically inserted ones) |
| **BRN Request** | A hotkey-driven hotel search bar with auto-captured hotel IDs and agreement auto-fill |
| **Package Creator** | Seven helpers for the create-package flow, each with its own switch: an on-page **Runner** that takes pasted Talab blocks and drives the whole wizard end to end (dates → latest flight → trips → hotels/BRNs/room counts → save, then straight on to the next queued block); **Ground Service** row ticking + price; **Flight Selection** (auto-picks the only flight left after filtering, or the latest one on a configurable hotkey); **Hotel & Services Prices** (accordions, trip numbers, acknowledge boxes, prices, beds); **Services Selection** for the Enrichment/Additional dialogs (first available date, random destination from your own allow-list); **Transport Selection** (Train over Land, trip number, price) |

Every rule/step/redirect-rule list shares the same tooling:
- **Pick** an element on the live page via the on-page inspector, then **Highlight** it to confirm, all through one consistent button pair everywhere a selector is needed
- **Share by link** — a single rule, a whole URL group, or an entire tab's rules, as a short server-backed link (falls back to a self-contained offline link if the server's unreachable)
- **Bulk delete** — per URL group or "delete all" per tab, alongside per-rule delete
- One-click **expand/collapse all** per tab
- Full **Undo/Redo** (Ctrl+Z / Ctrl+Y) across rules, workflows, and redirect rules in the same popup session
- Advanced selector syntax everywhere: plain CSS, `xpath=`, `text=`/`text*=`, and `a || b` fallback chains

## Licensing & Cross-Device Sync

| Feature | What it does |
|---|---|
| **Activation** | Per-device license key activation against a Cloudflare Worker; each key can gate specific tools, a device-seat limit, and an expiry date. The device id is cached in `chrome.storage.sync` as well as `local`, so reinstalling the extension in the same signed-in browser profile reuses the same id instead of burning a fresh seat |
| **Heartbeat** | Re-validates the key every few minutes while the page is open — a revoked/expired/edited key locks out mid-session, no popup reopen needed |
| **Native device helper** (optional, Windows) | A small local helper ([setup instructions](https://nuskomate-license.ranakiller-59.workers.dev/install), shipped inside the extension's own release zip) that lets Chrome, Edge, and Opera on the *same PC* share one device slot instead of one each, by reading the machine's own stable Windows id — something no browser extension can do on its own. One double-click installer (self-elevating, no PowerShell command to type). Falls back to the normal per-browser id if it isn't installed |
| **Cloud Sync** | One on/off toggle — while on, any rule/workflow/setting change auto-pushes to the server under your license key (debounced); changes from other devices are pulled on popup open and roughly once a minute in the background. Off = completely inert, no upload or download |
| **Keys admin** (master key only) | Create/edit/revoke/delete license keys, reset device seats, set per-key tool entitlements and expiry — the create/edit form lives behind a **+** button |

---

## Installation

### For customers
1. Download and unzip the latest release from [nuskomate-releases](https://github.com/ranakiller/nuskomate-releases/releases/latest)
2. Chrome/Edge: open `chrome://extensions/` or `edge://extensions/`, enable **Developer mode**, click **Load unpacked**, select the unzipped folder
3. Firefox: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** (or install the AMO-reviewed build once published)
4. Pin the extension icon, then enter your activation key in **Settings**

### For development
```bash
npm install
node build.js          # obfuscated build → dist/ + releases/nuskomate-vX.X.X.zip
node build.js --raw     # readable build → dist/ + releases/nuskomate-vX.X.X-raw.zip
```
`dist/` is fully rebuilt on every run — whichever variant you ran last is what's sitting there. Load `dist/` unpacked to test. The `--raw` build exists only for Firefox AMO's source-review requirement; it's never published to the public releases repo.

---

## Usage

### Opening the popup
Click the extension icon in the toolbar, or dock it as a side panel via the header button.

### Theme
Three buttons in Settings → Appearance: **System** (follows OS), **Light**, **Dark**. Remembered across sessions.

### Sidebar
Double-click any tab button to collapse/expand the sidebar to icons-only. A single click still just switches tabs.

### Enabling modules
Each module/automation tab has its own on/off slider. Premium tools require an activated key with that tool included in its entitlement.

---

## File Structure

```
nuskoMate/
├── manifest.json                    # Extension config (Manifest V3)
├── background.js                    # Service worker — license API relay + Cloud Sync engine
├── build.js                         # Build script (obfuscate/zip → dist/, releases/)
├── images/
├── popup/
│   ├── popup.html / popup.css / popup.js   # Shell UI, tabs, settings, Cloud Sync, update check
│   ├── auto-clicker.js              # Automation Rules, Workflows, Translation Rules, URL Shifter UI
│   ├── bulk.js                      # Bulk passport parser panel
│   ├── groups.js                    # Groups Export — one-click fetch + formatted .xlsx download
│   ├── mv-totals.js                 # Totals module settings (page list)
│   ├── brn-request.js               # BRN Request tab (hotkey + hotel list)
│   ├── talab-copy.js                # Copy tool settings (per-line toggles + hotkey)
│   ├── package-creator.js           # Package Creator tab (helper switches + per-helper settings)
│   └── keys-admin.js                # License Keys admin tab
├── modules/                         # Content-script feature modules (one per toggle)
│   ├── autofill.js, auto-reload.js, issue-date-calc.js,
│   │   vaccine-upload.js, disable-loading-overlay.js, ocr.js, batch-passport.js
│   ├── auto-clicker.js              # Executes click/fill/select/translate rules + workflows
│   ├── url-shifter.js               # Executes URL/element-trigger redirect rules
│   ├── groups-export.js             # Scrapes Masar's Groups List table across every page
│   ├── mv-totals.js                 # Injects the running Mutamer/Voucher/Rows total
│   ├── brn-request.js               # Hotel search bar + auto-capture + agreement autofill
│   ├── talab-copy.js                # Injects the Copy button/hotkey on 4 Masar pages
│   ├── auto-date-picker.js          # Type-a-shorthand date filler for any calendar field
│   └── package-creator.js           # The seven create-package helpers + the Runner state machine
├── utils/
│   ├── license.js                   # Client licensing API (activate, sync, share links, heartbeat)
│   ├── route-watcher.js             # SPA route-change detection
│   ├── angular-simulator.js         # Angular-compatible input events
│   ├── dropdown-helper.js           # PrimeNG dropdown handler
│   ├── element-type-detector.js, inspector.js, countries.js, passport-parser.js,
│   │   logger.js, xlsx-mini.js      # xlsx-mini.js: dependency-free .xlsx writer
├── native-host/                     # Shipped INSIDE the release zip (see build.js) — /install just links to it
│   ├── nuskomate-host.ps1            # Native Messaging host — reads this PC's Windows machine id
│   ├── install.ps1                  # Installer — writes the host + registers it with Chrome/Edge/Opera
│   └── Install-DeviceHelper.bat      # Double-click launcher — self-elevates, then runs install.ps1
└── server/
    ├── worker.js                    # Cloudflare Worker — licensing, OCR proxy, share links, Cloud Sync, /install page
    └── wrangler.toml
```

---

## Permissions

| Permission | Reason |
|---|---|
| `storage` / `unlimitedStorage` | Save rules, settings, and Cloud Sync snapshots |
| `activeTab` | Read the current tab's URL to know which modules to activate |
| `scripting` | Inject content scripts into the page |
| `clipboardWrite` | Copy the calculated issue date, and the Copy tool's formatted summaries, to clipboard |
| `downloads` | Reliable Excel downloads (Groups Export) via the extension's own download API, instead of a synthetic link click |
| `sidePanel` | Optional docked side-panel UI mode |
| `alarms` | Once-a-minute Cloud Sync poll for changes made on other devices |
| `nativeMessaging` | Optional — talks to the native device helper (native-host/), if installed, to read a shared machine id across browsers |
| `https://translate.googleapis.com/*` | Arabic name transliteration |
| `https://api.ocr.space/*` | Passport OCR (dev-mode fallback only; production scans route through the license server) |
| `https://*.workers.dev/*` | License server — activation, heartbeat, OCR proxy (using each customer's own ocr.space key), rule sharing, Cloud Sync |
| `https://api.github.com/*` | Update checker (points at the public releases repo) |

---

## Architecture Notes

- **Obfuscation**: production builds run every JS file through `javascript-obfuscator`; `utils/passport-parser.js` is replaced with a harmless stub in obfuscated builds — the real parsing logic runs server-side only.
- **This repo is private.** The public [nuskomate-releases](https://github.com/ranakiller/nuskomate-releases) repo hosts only built zips, no source — that split exists because GitHub exposes a full source archive per tag on any *public* repo regardless of what's in Releases.
- **License server**: `server/worker.js`, a Cloudflare Worker backed by a KV namespace. Endpoints: `/activate`, `/status` (heartbeat), `/scan` (OCR), `/share` + `/share/CODE` (rule links), `/sync/push` + `/sync/pull` (Cloud Sync), `/admin/*` (master-key-gated key management), `/install` (native device helper setup page — links to the extension's own release zip, resolved at page-load via the GitHub API so it never goes stale between versions).
- **Stable extension id**: `manifest.json` carries a fixed `"key"` so every install (any folder, any machine) resolves to the same extension id — required for the native host's `allowed_origins` whitelist to work at all. Changing this key again would break native messaging for existing installs the same way introducing it did (see the v3.4.6 note below).

**Release checklist**: whenever a new version ships, update this README (and the [releases repo's README](https://github.com/ranakiller/nuskomate-releases)) to reflect current features — both should always describe what's actually in that release, not what shipped several versions ago.

Current version: **v3.7.0** — see [Releases](https://github.com/ranakiller/nuskomate-releases/releases) for the full per-version changelog.
