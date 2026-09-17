/*
 * Rule / workflow URL matching — shared by the page engine
 * (modules/auto-clicker.js) and the popup (rule editor, grouping, Settings →
 * Sites), so "does this rule run here?" has exactly one answer everywhere.
 *
 * A rule or workflow carries a list of places it runs:
 *   urls: [{ match, host, path }]
 *     match "site"     → any page on `host` (subdomains included)
 *     match "page"     → exactly `host` + `path` (trailing slash ignored)
 *     match "contains" → `host` (if set) and the address contains `path`
 *     match "any"      → every site Nuskomate is allowed on
 * It runs on a page when ANY entry matches.
 */
(function () {
  "use strict";
  if (window.NkUrlMatch) return;

  const MASAR_HOST = "masar.nusuk.sa";
  const MATCHES = ["site", "page", "contains", "any"];

  // Written into the old single-path fields of a rule that has no Masar
  // entry at all (see urlFields). An older Nuskomate on another device —
  // Cloud Sync, or an imported share link — only understands pathname, and
  // treats a blank one as "every Masar page". This value can never equal a
  // real pathname, so those versions simply never run the rule.
  const NO_MASAR_PATH = "/__nuskomate_other_sites__";

  function cleanHost(h) {
    return String(h || "").trim().toLowerCase().replace(/:\d+$/, "").replace(/^www\./, "").replace(/\.$/, "");
  }
  const isHostLike = (s) => /^([a-z0-9-]+\.)+[a-z0-9-]+(:\d+)?$/i.test(s) || /^localhost(:\d+)?$/i.test(s);
  const isValidHost = (h) => /^([a-z0-9-]+\.)*[a-z0-9-]+$/i.test(h || "");

  // "web.whatsapp.com" matches web.whatsapp.com; "whatsapp.com" matches it
  // AND every subdomain, the same way Chrome's *.host site permission does.
  function hostMatches(host, want) {
    host = cleanHost(host); want = cleanHost(want);
    if (!host || !want) return false;
    return host === want || host.endsWith("." + want);
  }
  const isMasarHost = (host) => hostMatches(host, MASAR_HOST);

  function normPath(p) {
    let s = String(p || "").split(/[?#]/)[0] || "/";
    if (s[0] !== "/") s = "/" + s;
    return s.length > 1 ? s.replace(/\/+$/, "") || "/" : s;
  }

  function normEntry(e) {
    if (!e || typeof e !== "object") return null;
    const match = MATCHES.includes(e.match) ? e.match : "site";
    if (match === "any") return { match, host: "", path: "" };
    return { match, host: cleanHost(e.host), path: match === "site" ? "" : String(e.path || "") };
  }

  // Rules saved before multi-URL support have a single pathname/pathMatch
  // pair that always meant Masar (plus the short-lived `site` tag some
  // workflows/rules got for WhatsApp) — translated here, on read, so nothing
  // ever needs a storage migration.
  function legacyUrls(item) {
    const host = item.site === "whatsapp" ? "web.whatsapp.com" : MASAR_HOST;
    const raw = item.pathname !== undefined ? item.pathname : item.path;
    const path = String(raw || "").trim();
    if (!path) return [{ match: "site", host, path: "" }];
    const mode = item.pathMatch || item.urlMatch || "exact";
    return [{ match: mode === "includes" ? "contains" : "page", host, path }];
  }

  // An explicit array always wins — including an EMPTY one, which means the
  // user removed every URL and the rule runs nowhere (not "fall back to Masar").
  function urlsOf(item) {
    if (!item) return [];
    if (Array.isArray(item.urls)) return item.urls.map(normEntry).filter(Boolean);
    return legacyUrls(item);
  }

  // The fields to store on a rule for a given url list: `urls` itself plus
  // best-effort pathname/pathMatch for older versions (see NO_MASAR_PATH).
  function urlFields(urls) {
    const list = (urls || []).map(normEntry).filter(Boolean);
    const masar = list.find((e) => e.match === "any" || (e.host ? hostMatches(MASAR_HOST, e.host) : e.match !== "site"));
    let pathname = NO_MASAR_PATH, pathMatch = "exact";
    if (masar) {
      if (masar.match === "any" || masar.match === "site") pathname = "";
      else { pathname = masar.path; pathMatch = masar.match === "contains" ? "includes" : "exact"; }
    }
    return { urls: list, pathname, pathMatch };
  }

  function entryMatches(e, loc) {
    if (!e) return false;
    if (e.match === "any") return true;
    if (e.host && !hostMatches(loc.hostname, e.host)) return false;
    if (e.match === "site") return !!e.host;
    if (e.match === "page") return normPath(loc.pathname) === normPath(e.path);
    if (e.match === "contains") return !!e.path && (loc.pathname + loc.search).includes(e.path);
    return false;
  }
  const matches = (item, loc) => urlsOf(item).some((e) => entryMatches(e, loc || window.location));

  // Free text typed into a URL row → { host, path }. Accepts a full URL, a
  // bare host, host/path, or (for "page"/"contains") a path with no host,
  // which then applies on any allowed site.
  function parseInput(text, match) {
    let s = String(text || "").trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    if (!s) return { host: "", path: "" };
    let host = "", path = s;
    if (s[0] !== "/") {
      const cut = s.search(/[/?#]/);
      const head = cut < 0 ? s : s.slice(0, cut);
      if (isHostLike(head)) { host = cleanHost(head); path = cut < 0 ? "" : s.slice(cut); }
    }
    if (match === "site") path = "";
    if (match === "page") path = host && !path ? "/" : normPath(path);
    return { host, path };
  }

  function fromUrl(href, match) {
    try {
      const u = new URL(href);
      if (!/^https?:$/.test(u.protocol)) return null;
      return normEntry({ match: match || "page", host: u.hostname, path: u.pathname });
    } catch (_) { return null; }
  }

  // What the row's text box shows — parseInput(inputValue(e), e.match)
  // round-trips back to the same entry.
  function inputValue(e) {
    if (!e || e.match === "any") return "";
    if (e.match === "site") return e.host;
    if (!e.host) return e.path;
    const p = e.path || "";
    return e.host + (p && p[0] !== "/" && p[0] !== "?" ? "/" + p : p);
  }

  function label(e) {
    if (!e) return "";
    if (e.match === "any") return "Any site";
    if (e.match === "site") return e.host || "(no site set)";
    if (e.match === "page") return (e.host || "any site") + normPath(e.path);
    return (e.host ? e.host + " · " : "") + "contains “" + (e.path || "") + "”";
  }

  function summary(item) {
    const list = urlsOf(item);
    if (!list.length) return "no URLs — runs nowhere";
    return label(list[0]) + (list.length > 1 ? ` +${list.length - 1} more` : "");
  }

  // Hosts a rule names that aren't Masar — what Settings → Sites has to allow
  // for the rule to run. `anyHost` is true when an entry isn't tied to one
  // host ("any", or a host-less page/contains), which needs "all sites".
  function hostsNeeded(item) {
    const hosts = new Set();
    let anyHost = false;
    urlsOf(item).forEach((e) => {
      if (e.match === "any" || (!e.host && e.match !== "site")) anyHost = true;
      else if (e.host && !isMasarHost(e.host)) hosts.add(e.host);
    });
    return { hosts: [...hosts], anyHost };
  }

  // Chrome match pattern covering a host and all its subdomains, http + https.
  const originFor = (host) => `*://*.${cleanHost(host)}/*`;
  const ALL_SITES_ORIGIN = "*://*/*";
  // ...and back: "*://*.example.com/*" / "https://example.com/*" → "example.com".
  function hostFromOrigin(o) {
    const m = /^(\*|https?):\/\/(\*\.)?([^/*]+)\/\*$/.exec(o || "");
    return m ? cleanHost(m[3]) : "";
  }

  window.NkUrlMatch = {
    MASAR_HOST, NO_MASAR_PATH, ALL_SITES_ORIGIN, MATCHES,
    cleanHost, isValidHost, hostMatches, isMasarHost,
    urlsOf, urlFields, matches, entryMatches, parseInput, fromUrl,
    inputValue, label, summary, hostsNeeded, originFor, hostFromOrigin,
  };
})();
