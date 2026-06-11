(function () {
  "use strict";

  const STORAGE_KEY = "nkLogs";
  const MAX_ENTRIES = 10000; // rolling cap; oldest drop off, newest kept

  let buffer    = [];
  let seeded    = false;
  let flushTimer = null;

  // Seed the in-memory buffer from storage once (so logs persist across reloads)
  chrome.storage.local.get([STORAGE_KEY], (res) => {
    if (Array.isArray(res[STORAGE_KEY])) buffer = res[STORAGE_KEY];
    seeded = true;
  });

  function stringifyArg(a) {
    if (typeof a === "string") return a;
    if (a instanceof Error) return a.message;
    try { return JSON.stringify(a); } catch (_) { return String(a); }
  }

  function flush() {
    chrome.storage.local.set({ [STORAGE_KEY]: buffer });
  }

  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 150);
  }

  function persist(entry) {
    // If storage hasn't seeded yet, retry shortly so we don't drop early logs
    if (!seeded) { setTimeout(() => persist(entry), 50); return; }
    buffer.push(entry);
    if (buffer.length > MAX_ENTRIES) buffer = buffer.slice(-MAX_ENTRIES);
    scheduleFlush();
  }

  function write(level, args) {
    // Mirror to devtools console once so the old workflow still works
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    fn.apply(console, args);

    persist({ t: Date.now(), lvl: level, m: args.map(stringifyArg).join(" ") });
  }

  // Public API — variadic, same call signature as console.log
  const nkLog = (...args) => write("info", args);
  nkLog.info  = (...args) => write("info", args);
  nkLog.warn  = (...args) => write("warn", args);
  nkLog.error = (...args) => write("error", args);

  window.nkLog = nkLog;
})();
