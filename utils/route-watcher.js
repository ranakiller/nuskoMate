(function () {
  "use strict";

  let lastUrl = location.href;

  function notifyRouteChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    window.dispatchEvent(new CustomEvent("nusuk-route-change"));
  }

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function (...args) {
    const result = originalPushState.apply(this, args);
    setTimeout(notifyRouteChange, 0);
    return result;
  };

  history.replaceState = function (...args) {
    const result = originalReplaceState.apply(this, args);
    setTimeout(notifyRouteChange, 0);
    return result;
  };

  window.addEventListener("popstate", () => setTimeout(notifyRouteChange, 0));

  const observer = new MutationObserver(notifyRouteChange);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
