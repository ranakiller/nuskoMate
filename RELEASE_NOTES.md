# Nuskomate v2.0 — Release Notes

## ✨ New

**Passport OCR** — the headline feature
- Upload a passport image on the Masar form and the extension automatically scans it (powered by OCR.space) and fills the form for you
- Extracts the **full name** from the MRZ and the **father/husband name** from the passport body, then packs everything into the four name boxes respecting the **15-character limit per box** — words are never cut mid-way; they roll into the next box instead
- Auto-fills **Date of Birth**, **gender**, and the **Release (issue) date**
- The issue date is also copied to your clipboard as a backup
- **Blurry-image protection**: validates the passport's MRZ check digits and cleans up common misreads (e.g. `0→O`, `1→I`, `5→S`). If the scan looks unreliable you get a yellow "verify names" warning instead of a silent wrong fill
- Skips city/country lines (e.g. `MULTAN, PAK`) so they're never mistaken for the father's name
- Each new upload fully resets the previous scan, so stale data never carries over between people
- Optional: add your own free [OCR.space API key](https://ocr.space/ocrapi) in the popup for higher scan limits

**Logs tab** in the popup
- Every module action is recorded to a persistent, color-coded log (info / warning / error)
- Survives page reloads — clears only when you hit the trash button
- Live entry counter, refresh, and one-click clear

## 🔧 Improved

- **Auto-Translate** now transliterates **all four** name boxes (First, Father, Grandfather, Family) — previously only two
- **Email Manager** completely simplified: just type an email and press **Enter** (or click **Save**). All saved emails are listed below — click one to make it active, trash icon to delete. No more confusing search box. Export/Import CSV still available
- **Issue Date Calculator** now syncs to the real passport issue date when OCR is used, so the calculated value matches what's on the document

## ⚙️ Changes

- **Profession** field removed from settings — it's now always filled as **"Nil"** automatically
- On a fresh install, **all modules are ON by default** except the Issue Date Calculator (which stays off)
