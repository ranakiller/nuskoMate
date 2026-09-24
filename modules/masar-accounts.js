(function () {
  "use strict";

  // Masar Accounts — auto-scans the "Registered Entities" picker
  // (/nProtected/services) and the account header (rendered on authenticated
  // pages generally — NOT scoped to any one path prefix, confirmed live
  // 2026-09-23 on /umrah/reception/subeacontracts, so this never gates
  // reading it by path) so the popup can show a one-click card per entity
  // and switch between them, instead of the user hunting for the right
  // "Login" button by hand. Also watches the /pub/login email field so
  // scanned entities can be tagged with the account they belong to.
  //
  // Real markup confirmed live by the user (2026-09-23) — see the three
  // selectors below (.entity__name/.entity__description, .user-dropdown
  // .role/.username, g-input-text's Email field). Clicking reuses
  // window.nkClickElement (modules/auto-clicker.js) rather than
  // re-deriving a click sequence.
  //
  // Switching across a COLD start (popup click while sitting on some
  // unrelated page) needs a real navigation to /nProtected/services —
  // `location.href = ...` is a hard navigation, which tears down this
  // whole script's JS context the moment it commits. Confirmed live
  // (2026-09-23): a single unbroken async chain that awaits past that
  // line never resumes — the popup saw the tab land on the services page
  // but nothing clicked, and only a SECOND click (now already on the
  // page, no navigation needed) worked. Fixed by splitting the flow at
  // the navigation boundary: write the intent to storage BEFORE
  // navigating, then the fresh script instance that loads on the new
  // page picks it up itself (resumePendingSwitch, hooked into the normal
  // page-load/route-change path) and finishes the click. The result is
  // reported back via chrome.storage (nkMasarSwitchResult), not the
  // original sendMessage response, since that channel is exactly what
  // the navigation killed — same reasoning as masar-add-mutamer.js's own
  // confirm-queue relay, which survives page loads the same way.

  const alog = (m) => { try { (window.nkLog || console.log)("[Nuskomate Accounts] " + m); } catch (_) { console.log(m); } };

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  async function waitFor(check, { timeout = 15000, interval = 250 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const v = check();
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }
  function debounce(fn, ms) {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  const SERVICES_PATH = "/nProtected/services";
  const LOGIN_PATH = "/pub/login";
  const ENTITIES_KEY = "nkMasarEntities";       // { [email]: { firstSeenAt, list: [{name, description, status, updatedAt}] } }
  const LAST_EMAIL_KEY = "nkMasarLastLoginEmail";
  const CREDENTIALS_KEY = "nkMasarCredentials"; // { [email]: { password, updatedAt } } — local only, never sent anywhere
  const CURRENT_KEY = "nkMasarCurrentEntity";   // { name, username, updatedAt }
  const PENDING_KEY = "nkMasarPendingSwitch";   // { name, email, requestedAt } — survives the navigation
  const RESULT_KEY = "nkMasarSwitchResult";     // { name, email, ok, status, reason, currentName, at }

  // Cosmetic differences between the entity-card name ("SKYPASS TRAVEL AND
  // TOURS") and the header's role text ("Sky Pass SHWB Siyahati" — extra
  // spaces, different case) are expected, confirmed live — compare with
  // punctuation/spacing/case stripped so those don't cause a false mismatch.
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

  let moduleEnabled = false;
  const premiumOK = () => !window.NkLicense || window.NkLicense.featureOK("masaraccounts");
  function refreshEnabled(after) {
    chrome.storage.local.get(["moduleMasarAccounts", "extensionEnabled"], (res) => {
      moduleEnabled = res.extensionEnabled !== false && res.moduleMasarAccounts !== false && premiumOK();
      if (after) after();
    });
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.moduleMasarAccounts || changes.extensionEnabled) refreshEnabled();
  });
  window.NkLicense && window.NkLicense.onPremiumChange(refreshEnabled);

  // ── /pub/login: capture which email + password are signed in ────────────
  function findEmailInput() {
    const wrappers = Array.from(document.querySelectorAll("g-input-text"));
    for (const w of wrappers) {
      const label = w.querySelector(".input-label");
      if (label && /email/i.test(label.textContent || "")) {
        const input = w.querySelector("input");
        if (input) return input;
      }
    }
    return null;
  }
  // Real markup confirmed live (2026-09-23): <p-password formcontrolname="password">
  // — that attribute is specific enough to key off directly. The input's own
  // `type` toggles between text/password as the user clicks the eye icon, so
  // it can't be used to identify the field, only formcontrolname/label can.
  function findPasswordInput() {
    const scoped = document.querySelector('p-password[formcontrolname="password"] input');
    if (scoped) return scoped;
    const wrappers = Array.from(document.querySelectorAll("p-password"));
    for (const w of wrappers) {
      const wrap = w.closest(".col-sm-12") || w.parentElement;
      const label = wrap && wrap.querySelector("label");
      if (label && /password/i.test(label.textContent || "")) {
        const input = w.querySelector("input");
        if (input) return input;
      }
    }
    return null;
  }
  let lastSeenEmail = "";
  let lastSeenPassword = "";
  function pollLoginForm() {
    if (!moduleEnabled) return;
    const emailInput = findEmailInput();
    const email = ((emailInput && emailInput.value) || "").trim();
    if (email && email !== lastSeenEmail && email.includes("@")) {
      lastSeenEmail = email;
      chrome.storage.local.set({ [LAST_EMAIL_KEY]: email });
      alog(`captured login email: ${email}`);
    }
    const passwordInput = findPasswordInput();
    const password = (passwordInput && passwordInput.value) || "";
    // Only save once BOTH fields look real (a plausible email, a non-empty
    // password) — half-typed input isn't worth persisting, and pairing them
    // this way is the only way to know which email a captured password
    // belongs to (the form has no other link between the two fields).
    if (email && email.includes("@") && password && password !== lastSeenPassword) {
      lastSeenPassword = password;
      chrome.storage.local.get([CREDENTIALS_KEY], (res) => {
        const all = (res[CREDENTIALS_KEY] && typeof res[CREDENTIALS_KEY] === "object") ? res[CREDENTIALS_KEY] : {};
        all[email] = { password, updatedAt: Date.now() };
        chrome.storage.local.set({ [CREDENTIALS_KEY]: all });
      });
      alog(`captured password for ${email}`);
    }
  }
  let loginPollTimer = null;
  function startLoginEmailWatch() {
    if (loginPollTimer) return;
    loginPollTimer = setInterval(pollLoginForm, 800);
  }
  function stopLoginEmailWatch() {
    if (loginPollTimer) { clearInterval(loginPollTimer); loginPollTimer = null; }
  }

  // ── Account header: who's currently signed in / which entity is active ──
  function readCurrentEntity() {
    const dd = document.querySelector(".user-dropdown");
    if (!dd) return null;
    const username = ((dd.querySelector(".username") || {}).textContent || "").replace(/\s+/g, " ").trim();
    const name = ((dd.querySelector(".role") || {}).textContent || "").replace(/\s+/g, " ").trim();
    if (!name) return null;
    return { name, username };
  }
  let lastEntitySig = "";
  function reportCurrentEntity() {
    if (!moduleEnabled) return;
    const cur = readCurrentEntity();
    if (!cur) return;
    const sig = cur.name + "|" + cur.username;
    if (sig === lastEntitySig) return;
    lastEntitySig = sig;
    chrome.storage.local.set({ [CURRENT_KEY]: { ...cur, updatedAt: Date.now() } });
    alog(`current entity: ${cur.name}`);
  }

  // ── Registered Entities grid ──────────────────────────────────────────
  function findEntityCards() {
    return Array.from(document.querySelectorAll("app-entity-card"));
  }
  function readEntityCard(card) {
    const name = ((card.querySelector(".entity__name") || {}).textContent || "").replace(/\s+/g, " ").trim();
    const description = ((card.querySelector(".entity__description") || {}).textContent || "").replace(/\s+/g, " ").trim();
    const tagOuter = card.querySelector(".p-tag");
    const status = ((tagOuter && tagOuter.querySelector("span")) || {}).textContent || "";
    return { name, description, status: status.replace(/\s+/g, " ").trim() };
  }
  function findLoginButtonIn(card) {
    return Array.from(card.querySelectorAll("button")).find((b) => (b.textContent || "").replace(/\s+/g, " ").trim() === "Login") || null;
  }

  let scanning = false;
  async function scanEntities() {
    if (!moduleEnabled || scanning) return;
    const cards = findEntityCards();
    if (!cards.length) return;
    scanning = true;
    try {
      const entities = cards.map(readEntityCard).filter((e) => e.name);
      if (!entities.length) return;
      const { [LAST_EMAIL_KEY]: email } = await chrome.storage.local.get([LAST_EMAIL_KEY]);
      const key = email || "";
      const { [ENTITIES_KEY]: existing } = await chrome.storage.local.get([ENTITIES_KEY]);
      const all = (existing && typeof existing === "object") ? existing : {};
      const now = Date.now();
      const next = entities.map((e) => ({ ...e, updatedAt: now }));
      const prevGroup = all[key];
      const prevList = (prevGroup && Array.isArray(prevGroup.list)) ? prevGroup.list : (Array.isArray(prevGroup) ? prevGroup : []);
      // Skip the write entirely when nothing actually changed — this runs off
      // a document-wide MutationObserver, so an identical re-scan is common.
      const same = (a, b) => JSON.stringify(a.map((e) => ({ name: e.name, description: e.description, status: e.status }))) ===
                              JSON.stringify(b.map((e) => ({ name: e.name, description: e.description, status: e.status })));
      if (same(prevList, next)) return;
      all[key] = { firstSeenAt: (prevGroup && prevGroup.firstSeenAt) || now, list: next };
      await chrome.storage.local.set({ [ENTITIES_KEY]: all });
      alog(`scanned ${entities.length} entit${entities.length === 1 ? "y" : "ies"} for ${email || "(unknown email)"}`);
    } finally {
      scanning = false;
    }
  }

  // ── Switch to a named entity ──────────────────────────────────────────
  // The click step (attemptClick) is shared by both the "already on the
  // services page" path and the "resuming after a hard navigation" path —
  // see the file header comment for why those have to be two entry points
  // instead of one continuous await chain.
  async function attemptClick(name, email) {
    // Covers the "logged out / session expired mid-switch, redirected back
    // to sign-in" case — no point waiting up to 15s for cards that will
    // never appear on the login page.
    if (location.pathname === LOGIN_PATH) return finishSwitch({ name, email, ok: false, reason: "not-logged-in" });
    const wantName = norm(name);
    const gotCards = await waitFor(() => findEntityCards().length > 0, { timeout: 15000 });
    if (!gotCards) return finishSwitch({ name, email, ok: false, reason: "no-cards" });
    await scanEntities().catch(() => {});

    const match = findEntityCards().find((c) => norm(readEntityCard(c).name) === wantName);
    if (!match) return finishSwitch({ name, email, ok: false, reason: "not-found" });

    const btn = findLoginButtonIn(match);
    if (!btn) return finishSwitch({ name, email, ok: false, reason: "no-login-button" });

    if (typeof window.nkClickElement !== "function") return finishSwitch({ name, email, ok: false, reason: "click-tool-missing" });
    window.nkClickElement(btn);

    const switched = await waitFor(() => {
      const cur = readCurrentEntity();
      return cur && norm(cur.name) === wantName;
    }, { timeout: 15000 });

    if (!switched) return finishSwitch({ name, email, ok: false, reason: "switch-not-confirmed" });
    return finishSwitch({ name, email, ok: true, status: "switched" });
  }

  async function finishSwitch(result) {
    await chrome.storage.local.remove(PENDING_KEY);
    await chrome.storage.local.set({ [RESULT_KEY]: { ...result, at: Date.now() } });
    alog(`switch result for ${result.name}: ${JSON.stringify(result)}`);
  }

  // Entry point for the popup's message — decides whether a navigation is
  // needed and, if so, starts it and returns immediately (this script's
  // context won't survive the navigation to report anything further; see
  // resumePendingSwitch for how the rest completes).
  async function beginSwitch(name, email) {
    const wantName = norm(name);
    if (!wantName) return finishSwitch({ name, email, ok: false, reason: "no-name" });
    // Fallback for the popup's own URL pre-check (which covers the common
    // case without even sending this message) — belt-and-suspenders in
    // case that read was stale, or this script instance is reached some
    // other way. No session to switch within at all on the sign-in page.
    if (location.pathname === LOGIN_PATH) return finishSwitch({ name, email, ok: false, reason: "not-logged-in" });

    const already = readCurrentEntity();
    if (already && norm(already.name) === wantName) {
      return finishSwitch({ name, email, ok: true, status: "already", currentName: already.name });
    }

    if (location.pathname === SERVICES_PATH) {
      await attemptClick(name, email);
      return;
    }

    await chrome.storage.local.set({ [PENDING_KEY]: { name, email, requestedAt: Date.now() } });
    location.href = "https://masar.nusuk.sa" + SERVICES_PATH;
    // Nothing more can run here — the navigation above tears this context
    // down. resumePendingSwitch() on the freshly-loaded page picks it up.
  }

  let resuming = false;
  async function resumePendingSwitch() {
    if (resuming) return;
    const { [PENDING_KEY]: pending } = await chrome.storage.local.get([PENDING_KEY]);
    if (!pending || !pending.name) return;
    if (Date.now() - (pending.requestedAt || 0) > 60000) { // stale — nobody's still waiting on this
      await chrome.storage.local.remove(PENDING_KEY);
      return;
    }
    resuming = true;
    try {
      await attemptClick(pending.name, pending.email);
    } finally {
      resuming = false;
    }
  }

  // ── Wiring ────────────────────────────────────────────────────────────
  function onRouteOrLoad() {
    if (!moduleEnabled) return;
    const path = location.pathname;
    if (path === LOGIN_PATH) startLoginEmailWatch(); else stopLoginEmailWatch();
    // Not gated by path — the account header (.user-dropdown) turned out to
    // render on authenticated pages OUTSIDE /nProtected/* too (confirmed
    // live 2026-09-23: /umrah/reception/subeacontracts has it). Gating this
    // by path meant nkMasarCurrentEntity went stale while browsing those
    // pages, which then fed a false "wrong email" block against an entity
    // that actually did belong to the live account. readCurrentEntity()
    // already returns null harmlessly when the header genuinely isn't
    // there (e.g. /pub/login), so there's nothing to gain from filtering
    // by path here at all.
    reportCurrentEntity();
    if (path === SERVICES_PATH) {
      resumePendingSwitch();
      waitFor(() => findEntityCards().length > 0, { timeout: 8000 }).then((got) => { if (got) scanEntities(); });
    }
  }
  window.addEventListener("nusuk-route-change", onRouteOrLoad);
  // NOT a bare `onRouteOrLoad()` here — moduleEnabled is only set inside
  // refreshEnabled's chrome.storage.local.get callback, which is always
  // asynchronous. Confirmed live (2026-09-23) that calling onRouteOrLoad
  // synchronously at script-load time — i.e. right here, on EVERY fresh
  // page load including the one instant this matters most, landing on the
  // services page right after the Login-switch navigation — always saw
  // moduleEnabled still at its false default and silently did nothing.
  // Waiting for refreshEnabled's own callback before the first call fixes
  // that; every LATER call (route-change events, the interval/observer
  // below) already runs well after this resolves so they were never at risk.
  refreshEnabled(onRouteOrLoad);

  // The header renders async on first load (no route-change fires for that),
  // and the entity grid can repaint once its "Activated" badge resolves — a
  // debounced document-wide observer catches both without a constant poll.
  const debouncedCheck = debounce(() => {
    if (!moduleEnabled) return;
    reportCurrentEntity();
    if (location.pathname === SERVICES_PATH) scanEntities();
  }, 400);
  new MutationObserver(debouncedCheck).observe(document.documentElement, { childList: true, subtree: true });

  // Safety net alongside the observer above, same combination
  // modules/url-shifter.js already relies on (its own MutationObserver PLUS
  // a plain setInterval) rather than trusting mutation events alone — a
  // debounced observer can go quiet if the page stops mutating right after
  // it settles, and scanEntities()/reportCurrentEntity() are cheap no-ops
  // when nothing's actually changed, so polling costs nothing extra.
  setInterval(() => {
    if (!moduleEnabled) return;
    reportCurrentEntity();
    if (location.pathname === SERVICES_PATH) scanEntities();
  }, 2000);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;

    if (msg.type === "nkMasarSwitchEntity") {
      // Scanning is gated behind moduleEnabled everywhere, but this handler
      // used to skip that check and let a switch through even while the
      // module was off/unlicensed (the popup normally hides the whole tab
      // in that case, but this closes the gap for any other caller). Report
      // it the same way every other beginSwitch failure is reported — via
      // finishSwitch/RESULT_KEY — so the popup's existing onResult listener
      // picks it up immediately instead of waiting out its 25s timeout.
      if (!moduleEnabled) {
        sendResponse({ ok: false, status: "module-off" });
        finishSwitch({ name: msg.name, email: msg.email, ok: false, reason: "module-off" });
        return;
      }
      // Just an ack that the request arrived — the real outcome is reported
      // via chrome.storage (RESULT_KEY), which survives the navigation this
      // sendMessage channel does not. beginSwitch runs after responding so a
      // dead channel (post-navigation) can never block it.
      sendResponse({ ok: true, status: "started" });
      beginSwitch(msg.name, msg.email);
      return;
    }
  });
})();
