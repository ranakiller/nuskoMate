(function () {
  "use strict";

  let isEnabled = false;
  let processedForThisForm = false;
  let isProcessing = false;
  let pollTimer = null;

  function isTargetPage() {
    return window.location.pathname === "/umrah/mutamer/add-mutamer";
  }

  function formatDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function copyToClipboard(value) {
    if (!navigator.clipboard?.writeText) { console.log("Calculated issue date:", value); return; }
    navigator.clipboard.writeText(value).catch(() => console.log("Calculated issue date:", value));
  }

  function handleDateLogic() {
    if (!isEnabled || !isTargetPage() || processedForThisForm || isProcessing) return;
    const expiryInput = document.querySelector('p-calendar[formcontrolname="passportExpiryDate"] input');
    const issueInput = document.querySelector('p-calendar[formcontrolname="passportIssueDate"] input');
    if (!expiryInput || expiryInput.value.trim().length < 8 || (issueInput && issueInput.value)) return;
    isProcessing = true;
    setTimeout(() => {
      const expiryDate = new Date(expiryInput.value.trim());
      if (Number.isNaN(expiryDate.getTime())) { isProcessing = false; return; }
      processedForThisForm = true;
      const expiryYear = expiryDate.getFullYear();
      const defaultSub = expiryYear - 5 > new Date().getFullYear() ? 10 : 5;
      const years = parseInt(prompt("Subtract years:", defaultSub), 10);
      const days = parseInt(prompt("Add days:", "1"), 10);
      if (Number.isFinite(years) && Number.isFinite(days)) {
        expiryDate.setFullYear(expiryDate.getFullYear() - years);
        expiryDate.setDate(expiryDate.getDate() + days);
        copyToClipboard(formatDate(expiryDate));
      }
      isProcessing = false;
    }, 500);
  }

  function start() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (!isTargetPage()) { processedForThisForm = false; isProcessing = false; return; }
      if (!document.querySelector('p-calendar[formcontrolname="passportExpiryDate"]')) processedForThisForm = false;
      handleDateLogic();
    }, 500);
    window.addEventListener("nusuk-route-change", () => { processedForThisForm = false; isProcessing = false; handleDateLogic(); });
  }

  function stop() {
    isEnabled = false;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  chrome.storage.local.get(["extensionEnabled", "moduleIssueDateCalc"], (res) => {
    if (res.extensionEnabled === false) return;
    isEnabled = !!res.moduleIssueDateCalc;
    start();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.extensionEnabled) {
      if (!changes.extensionEnabled.newValue) { stop(); return; }
      else { chrome.storage.local.get(["moduleIssueDateCalc"], (r) => { isEnabled = !!r.moduleIssueDateCalc; start(); }); return; }
    }
    if (changes.moduleIssueDateCalc) { isEnabled = !!changes.moduleIssueDateCalc.newValue; if (isEnabled) handleDateLogic(); }
  });
})();
