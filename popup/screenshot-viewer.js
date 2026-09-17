// Standalone viewer for the "Open in a new tab" delivery mode of the Element
// Screenshot tool (popup/file-tools.js). Reads the just-captured image out of
// chrome.storage.session (background.js's runWebshotCapture put it there
// right before opening this page) rather than putting the image data straight
// in this page's own URL — a multi-megabyte data: URL as an address-bar URL
// is exactly the kind of thing that's slow/janky to navigate to directly.
(async () => {
  const img = document.getElementById("img");
  const empty = document.getElementById("empty");
  const dlBtn = document.getElementById("dl");
  const copyBtn = document.getElementById("copy");

  const { nkPendingScreenshot } = await chrome.storage.session.get(["nkPendingScreenshot"]);
  if (!nkPendingScreenshot || !nkPendingScreenshot.dataUrl) {
    empty.hidden = false;
    dlBtn.disabled = true;
    copyBtn.disabled = true;
    return;
  }

  img.src = nkPendingScreenshot.dataUrl;
  img.hidden = false;
  document.title = (nkPendingScreenshot.filename || "screenshot.png") + " — Nuskomate";

  dlBtn.addEventListener("click", () => {
    chrome.downloads.download({ url: nkPendingScreenshot.dataUrl, filename: nkPendingScreenshot.filename, saveAs: false });
  });
  copyBtn.addEventListener("click", async () => {
    try {
      const blob = await (await fetch(nkPendingScreenshot.dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = "Copy to clipboard"; }, 1500);
    } catch (err) {
      alert("Couldn't copy: " + (err && err.message));
    }
  });
})();
