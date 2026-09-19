// Offscreen documents are hidden, and a hidden document never fires
// requestAnimationFrame — which pdf.js's page renderer waits on, so a PDF
// render would hang forever. Run callbacks on a timer instead.
window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
window.cancelAnimationFrame = (id) => clearTimeout(id);
