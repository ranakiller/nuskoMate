# Masar Nusuk Pro — Chrome / Edge Extension

> Automation toolkit for [masar.nusuk.sa](https://masar.nusuk.sa) — fills forms, reloads tabs, removes spinners, translates names, and more.

---

## Modules

| Module | What it does |
|---|---|
| **Auto Reload** | Reloads the tab after a configurable idle period (default 1.5 min) |
| **Disable Overlay** | Removes the blocking loading spinner so the page is always interactive |
| **Autofill Constants** | Pre-fills Email, Mobile, City, Profession, Passport Type, Birth Country, Marital Status, and phone country code (+92) automatically |
| **Auto Translate Names** | Transliterates English names into Arabic script in the Arabic name fields |
| **Issue Date Calc** | Calculates the passport issue date from the expiry date and copies it to your clipboard |
| **Vaccine Image Upload** | Auto-uploads the bundled vaccine placeholder image to the vaccine file input |
| **Embassy Selector** | Auto-selects the Islamabad consulate on the group creation page (runs with Autofill) |

---

## Installation

> **No build step required** — load the unpacked folder directly.

1. Download and **unzip** `masar-nusuk-pro.zip`
2. Open Chrome → `chrome://extensions/` &nbsp;or&nbsp; Edge → `edge://extensions/`
3. Enable **Developer mode** (toggle, top-right corner)
4. Click **"Load unpacked"**
5. Select the **`masar-extension`** folder (the one containing `manifest.json`)
6. The extension icon appears in your toolbar — pin it for quick access

---

## Usage

### Opening the popup
Click the **M** icon in the Chrome/Edge toolbar.

### Choosing a theme
Three buttons in the top-right of the popup:
- **Monitor icon** — follows your OS dark/light setting automatically
- **Sun icon** — force Light theme
- **Moon icon** — force Dark theme

Your choice is remembered across sessions.

### Enabling modules
Each module has its own toggle switch. Flip it on — the change takes effect immediately on the active tab (no page reload needed for most modules).

### Auto Reload
- Toggle **Auto Reload** on
- Set the **Interval** (in minutes, minimum 0.5)
- The tab reloads only when it is **inactive** (hidden/backgrounded) — active tabs are skipped

### Autofill Settings
Fill in your details once:
- **Email** — used in the email field
- **Mobile** — 11-digit Pakistani number (e.g. `03001234567`)
- **City** — used for Issue City and Birth City
- **Profession** — used in the profession field

Values are saved instantly as you type and applied whenever the mutamer form is open.

### Issue Date Calculator
When the passport expiry date is entered on the form, a prompt will appear asking:
1. How many years to subtract (default: 5 or 10 depending on expiry year)
2. How many days to add (default: 1)

The calculated issue date is **copied to your clipboard** automatically.

### Embassy Selector
Runs automatically alongside Autofill on the group creation page (`/add-group/create-group`). Selects **Islamabad** from the consulate dropdown and returns focus to the Group Name field.

---

## File Structure

```
masar-extension/
├── manifest.json                  # Extension config (Manifest V3)
├── background.js                  # Service worker (reserved)
├── images/
│   └── vaccine.jpg                # Bundled vaccine placeholder image
├── popup/
│   ├── popup.html                 # Extension popup UI
│   ├── popup.css                  # Popup styles (light + dark theme)
│   └── popup.js                   # Popup logic & storage sync
├── modules/
│   ├── autofill.js                # Form field autofill
│   ├── auto-reload.js             # Tab auto-reload
│   ├── disable-loading-overlay.js # Spinner removal
│   ├── translation.js             # Name transliteration
│   ├── issue-date-calc.js         # Passport issue date calculator
│   ├── vaccine-upload.js          # Vaccine image auto-upload
│   └── embassy-selector.js        # Consulate dropdown selector
└── utils/
    ├── route-watcher.js           # SPA route change detection
    ├── angular-simulator.js       # Angular-compatible input events
    ├── dropdown-helper.js         # PrimeNG dropdown handler
    └── inspector.js               # DOM inspection utilities
```

---

## Notes & Tips

- **Settings persist** — all toggles and field values are saved in Chrome local storage and survive browser restarts.
- **Autofill only runs on** `/umrah/mutamer/add-mutamer` — it won't interfere with other pages.
- **Embassy Selector only runs on** `/umrah/mutamer-group/add-group/create-group`.
- **Vaccine upload targets** the 5th file input on the mutamer form (index 4).
- **Auto Reload skips active tabs** — you won't be interrupted while working; it only reloads when the tab is hidden.
- **Issue Date Calc uses `prompt()`** — the browser's built-in dialog, so it will appear on top of the page when triggered.
- Changing the **Interval** while Auto Reload is running reschedules the timer immediately.
- If the page uses Angular and a field doesn't stick, the extension uses `simulateAngularInput` to force Angular's change detection.

---

## Permissions

| Permission | Reason |
|---|---|
| `storage` | Save your settings and autofill values |
| `activeTab` | Read the current tab's URL to know which modules to activate |
| `scripting` | Inject content scripts into the page |
| `clipboardWrite` | Copy the calculated issue date to clipboard |
| `https://translate.googleapis.com/*` | Fetch Arabic transliterations for name translation |

---

## Version

**v2.0** — Auto Clicker removed; all other modules retained; new themed popup UI.
