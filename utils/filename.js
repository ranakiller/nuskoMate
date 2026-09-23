// Every file this extension puts on disk carries "Nuskomate" in its name —
// so a Downloads folder full of files from a dozen different sources still
// makes it obvious at a glance which ones came from here. One small
// always-loaded module, one global API (same pattern as utils/logger.js's
// window.nkLog) — called from every popup script that actually triggers a
// download: File Tools, Bulk Passport Parser, Media Grabber, Auto Clicker's
// JSON exports, Masar Accounts' group export.
(function () {
  "use strict";

  function nkBrandFilename(name) {
    const n = String(name || "").trim() || "file";
    if (/nuskomate/i.test(n)) return n; // already branded — don't double up
    const m = /^(.*)(\.[^.\\/]+)$/.exec(n);
    return m ? `Nuskomate-${m[1]}${m[2]}` : `Nuskomate-${n}`;
  }

  window.nkBrandFilename = nkBrandFilename;
})();
