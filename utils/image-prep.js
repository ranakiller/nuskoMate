// utils/image-prep.js — shared, DOM-canvas image preparation used wherever a
// photo/scan needs to be made OCR-ready: the JPG tools (Auto-Straighten, OCR
// Enhancer) and, later, the WhatsApp pipeline (via a hidden page, since a
// background service worker has no canvas). Plain classic script exposing
// window.NkImagePrep — no dependencies, no network.
//
//   detectOrientation(canvas) → which way is "up": clockwise quarter turns to
//                               APPLY (0-3), found from where the passport's
//                               MRZ text block sits, with a weaker text-shape
//                               fallback for ordinary documents
//   detectSkewAngle / rotateCanvasByAngle — fine tilt (moved here from file-tools.js)
//   detectContentBounds — trim blank borders (moved here from file-tools.js)
//   enhanceForOcr(canvas, {mode})  → text-focused version: flatten uneven
//                               lighting, sharpen, and (strong) bold black-on-white
//   prepareForOcr(fileOrCanvas)    → orient + straighten + trim in one call
(function () {
  "use strict";

// ── Auto-straighten: detect a crooked scan/photo's tilt angle ──────────────
// A "projection profile" skew detector — the same basic technique real
// document scanners use, no ML model or vendored library needed. The idea:
// for the CORRECT rotation, a page's text sits in neat horizontal bands (row
// after row of "mostly ink" alternating with "mostly white gap"), which
// makes the row-by-row darkness profile spike sharply. Any wrong angle
// smears text across rows instead, flattening that profile out. So: try a
// range of candidate angles, score each by how spiky its profile is, and the
// biggest spike wins.
//
// This can only ever find a rotation whose two directions look genuinely
// different from each other — which a small tilt always does, but an exact
// 180°/pointing-the-other-way flip does NOT (upside-down text still makes
// the same horizontal bands, just in reverse row order — same variance
// either way, so nothing here can tell "upside down" from "right side up").
// That's why this only searches a modest range around the image's OWN
// current orientation (assumes it's already roughly upright, just tilted)
// rather than also trying to guess between all four 90° rotations — being
// confidently wrong about "sideways vs. upside-down" would make a document
// worse, not better, so it isn't attempted.
//
// Returns null when nothing in the image looks line-like enough to trust
// (a photo of a face, a plain graphic, anything without real text/ruled
// lines) — callers should fall back to asking for a manual angle instead of
// silently applying a guess.
function detectSkewAngle(sourceCanvas, maxAngle = 20) {
  const maxDim = 480; // plenty of resolution for this; more just costs time
  const scale = Math.min(1, maxDim / Math.max(sourceCanvas.width, sourceCanvas.height));
  const w = Math.max(1, Math.round(sourceCanvas.width * scale));
  const h = Math.max(1, Math.round(sourceCanvas.height * scale));
  const small = document.createElement("canvas");
  small.width = w; small.height = h;
  const sctx = small.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(sourceCanvas, 0, 0, w, h);
  const { data } = sctx.getImageData(0, 0, w, h);

  // Precompute "darkness" (0 = white, 255 = black) once — every candidate
  // angle re-buckets these same values, never touches the canvas again.
  const dark = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    dark[p] = 255 - (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  }

  const cx = w / 2, cy = h / 2;
  const numBuckets = Math.ceil(Math.sqrt(w * w + h * h)) + 2;
  const mid = numBuckets / 2;
  const buckets = new Float64Array(numBuckets); // reused every call, cleared each time

  // Projects every dark pixel onto the axis perpendicular to candidate
  // angle `deg`, filling `buckets` with that angle's row-darkness profile —
  // the shared step both scoreAngle() and the final trust-check need.
  function computeBuckets(deg) {
    buckets.fill(0);
    const rad = (deg * Math.PI) / 180, sin = Math.sin(rad), cos = Math.cos(rad);
    for (let y = 0; y < h; y++) {
      const yy = y - cy;
      const rowOffset = y * w;
      for (let x = 0; x < w; x++) {
        const d = dark[rowOffset + x];
        if (d < 12) continue; // background pixels never help — skip for speed
        const bucket = ((x - cx) * sin + yy * cos + mid) | 0;
        if (bucket >= 0 && bucket < numBuckets) buckets[bucket] += d;
      }
    }
    return buckets;
  }
  function scoreAngle(deg) {
    const b = computeBuckets(deg);
    let mean = 0;
    for (let i = 0; i < numBuckets; i++) mean += b[i];
    mean /= numBuckets;
    let variance = 0;
    for (let i = 0; i < numBuckets; i++) { const dd = b[i] - mean; variance += dd * dd; }
    return variance / numBuckets;
  }

  // Coarse sweep (1° steps) to find the neighborhood, then refine (0.15°
  // steps) around it — cheap enough to just always do both passes.
  let sum = 0, count = 0, best = { angle: 0, score: -Infinity };
  for (let a = -maxAngle; a <= maxAngle; a += 1) {
    const s = scoreAngle(a);
    sum += s; count++;
    if (s > best.score) best = { angle: a, score: s };
  }
  const coarseAngle = best.angle;
  for (let a = coarseAngle - 0.9; a <= coarseAngle + 0.9; a += 0.15) {
    const s = scoreAngle(a);
    if (s > best.score) best = { angle: a, score: s };
  }

  // Trust check, two parts — both matter, confirmed empirically (a smooth
  // photo/gradient can score deceptively well on variance alone):
  //   1. confidence — the winning angle must clearly beat the average of
  //      every angle tried; a flat/textureless image scores similarly no
  //      matter what angle is tried.
  //   2. band count — the winning angle's OWN profile must actually look
  //      like multiple alternating text-line bands, not just one smooth
  //      hump. Counted as contiguous above-threshold runs (not per-point
  //      local maxima) so it isn't fooled by pixel-level noise inside a
  //      single true band.
  const avg = sum / count;
  const confidence = avg > 0 ? Math.max(0, Math.min(1, (best.score - avg) / avg)) : 0;
  const winProfile = computeBuckets(best.angle);
  const bandThresh = Math.max(...winProfile) * 0.3;
  let bands = 0, wasAbove = false;
  for (let i = 0; i < numBuckets; i++) {
    const above = winProfile[i] > bandThresh;
    if (above && !wasAbove) bands++;
    wasAbove = above;
  }
  if (confidence < 0.12 || bands < 4) return null;
  return { angle: Math.round(best.angle * 10) / 10, confidence };
}

// Rotates by an ARBITRARY angle (unlike the 90°-multiple case elsewhere,
// which swaps width/height exactly) — the canvas has to grow to fit the
// rotated rectangle without clipping its corners, and whatever background
// shows in the newly-exposed corners is filled white, same as real scanner
// apps do after straightening a page.
function rotateCanvasByAngle(source, w, h, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
  const newW = Math.ceil(w * cos + h * sin), newH = Math.ceil(w * sin + h * cos);
  const canvas = document.createElement("canvas");
  canvas.width = newW; canvas.height = newH;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, newW, newH);
  ctx.translate(newW / 2, newH / 2);
  ctx.rotate(rad);
  ctx.drawImage(source, -w / 2, -h / 2, w, h);
  return canvas;
}

// ── Trim whitespace: auto-crop blank margins ────────────────────────────────
// Unlike skew detection, this has no ambiguity to worry about — either a row
// of pixels is basically all one color or it isn't. Works out from each edge
// toward the center until it hits real content, on a downscaled copy for
// speed (the crop rectangle then scales back up to the original resolution,
// so the OUTPUT is never touched by the downscale — only where it detects
// the cut lines).
function estimateBorderColor(data, w, h) {
  // Median of a ring of sample points around all four edges — robust to one
  // stray dark pixel/dust speck near a corner throwing off the estimate,
  // which a single-pixel corner sample wouldn't be.
  const step = Math.max(1, Math.floor(Math.min(w, h) / 100));
  const rs = [], gs = [], bs = [];
  const sample = (x, y) => { const i = (y * w + x) * 4; rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]); };
  for (let x = 0; x < w; x += step) { sample(x, 0); sample(x, h - 1); }
  for (let y = 0; y < h; y += step) { sample(0, y); sample(w - 1, y); }
  const mid = (arr) => arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)];
  return { r: mid(rs), g: mid(gs), b: mid(bs) };
}

// Returns the detected content rectangle in the SOURCE canvas's own pixel
// coordinates, or null if nothing looked croppable (an entirely blank image,
// or content running edge-to-edge with no margin to trim at all).
function detectContentBounds(sourceCanvas, { tolerance = 20 } = {}) {
  const maxDim = 500;
  const scale = Math.min(1, maxDim / Math.max(sourceCanvas.width, sourceCanvas.height));
  const w = Math.max(1, Math.round(sourceCanvas.width * scale));
  const h = Math.max(1, Math.round(sourceCanvas.height * scale));
  const small = document.createElement("canvas");
  small.width = w; small.height = h;
  const ctx = small.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(sourceCanvas, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const bg = estimateBorderColor(data, w, h);
  const tol2 = tolerance * tolerance;

  const isBg = (x, y) => {
    const i = (y * w + x) * 4;
    const dr = data[i] - bg.r, dg = data[i + 1] - bg.g, db = data[i + 2] - bg.b;
    return dr * dr + dg * dg + db * db <= tol2;
  };
  // A row/column counts as "blank" up to a small amount of noise (JPEG
  // ringing, a fleck of dust) — otherwise a single stray pixel could pin the
  // crop right up against the actual content.
  const noiseAllowance = 0.006;
  const rowBlank = (y) => { let bad = 0; const max = w * noiseAllowance; for (let x = 0; x < w; x++) { if (!isBg(x, y) && ++bad > max) return false; } return true; };
  const colBlank = (x) => { let bad = 0; const max = h * noiseAllowance; for (let y = 0; y < h; y++) { if (!isBg(x, y) && ++bad > max) return false; } return true; };

  let top = 0, bottom = h - 1, left = 0, right = w - 1;
  while (top < bottom && rowBlank(top)) top++;
  while (bottom > top && rowBlank(bottom)) bottom--;
  while (left < right && colBlank(left)) left++;
  while (right > left && colBlank(right)) right--;

  if (right - left < w * 0.02 || bottom - top < h * 0.02) return null; // degenerate — e.g. a fully blank image
  if (top === 0 && bottom === h - 1 && left === 0 && right === w - 1) return null; // nothing to trim

  const inv = 1 / scale;
  return {
    x: Math.max(0, Math.floor(left * inv)), y: Math.max(0, Math.floor(top * inv)),
    width: Math.ceil((right - left + 1) * inv), height: Math.ceil((bottom - top + 1) * inv),
  };
}



  // ══ Document finder (colour-based crop) ═════════════════════════════════
  // detectContentBounds only peels UNIFORM margins. A phone screenshot of a
  // passport has non-uniform chrome around it — a black status bar, an overlay
  // toast, a page counter — so it finds "nothing to trim". Passports are
  // colourful (green/cream/orange) while that chrome is black/white/grey, so
  // find the biggest block of rows and columns with real colour in them.
  // Returns a rect in SOURCE pixels, or null when nothing colourful stands out
  // (a black-and-white scan) or the colour fills nearly the whole frame.
  function detectDocumentBounds(sourceCanvas) {
    const maxDim = 600;
    const scale = Math.min(1, maxDim / Math.max(sourceCanvas.width, sourceCanvas.height));
    const w = Math.max(1, Math.round(sourceCanvas.width * scale)), h = Math.max(1, Math.round(sourceCanvas.height * scale));
    const c = makeCanvas(w, h);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(sourceCanvas, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    const mask = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx > 70 && (mx - mn) / mx > 0.08) mask[p] = 1;
    }
    // Longest run of indices with value >= thr, tolerating short gaps.
    const longestRun = (vals, thr, maxGap) => {
      let best = null, start = -1, last = -1;
      for (let i = 0; i <= vals.length; i++) {
        const on = i < vals.length && vals[i] >= thr;
        if (on) { if (start < 0) start = i; last = i; }
        else if (start >= 0 && (i >= vals.length || i - last > maxGap)) {
          if (!best || last - start > best.end - best.start) best = { start, end: last };
          start = -1;
        }
      }
      return best;
    };
    const rowFrac = new Float32Array(h);
    for (let y = 0; y < h; y++) { let n = 0; for (let x = 0; x < w; x++) n += mask[y * w + x]; rowFrac[y] = n / w; }
    const rows = longestRun(rowFrac, 0.12, Math.max(2, Math.round(h * 0.03)));
    if (!rows || rows.end - rows.start < h * 0.12) return null;
    const colFrac = new Float32Array(w);
    for (let x = 0; x < w; x++) { let n = 0; for (let y = rows.start; y <= rows.end; y++) n += mask[y * w + x]; colFrac[x] = n / (rows.end - rows.start + 1); }
    const cols = longestRun(colFrac, 0.10, Math.max(2, Math.round(w * 0.03)));
    if (!cols || cols.end - cols.start < w * 0.12) return null;
    const area = ((rows.end - rows.start + 1) * (cols.end - cols.start + 1)) / (w * h);
    if (area > 0.97 || area < 0.15) return null;
    const inv = 1 / scale;
    return {
      x: Math.max(0, Math.floor(cols.start * inv)), y: Math.max(0, Math.floor(rows.start * inv)),
      width: Math.min(sourceCanvas.width, Math.ceil((cols.end - cols.start + 1) * inv)),
      height: Math.min(sourceCanvas.height, Math.ceil((rows.end - rows.start + 1) * inv)),
    };
  }

  // ══ Orientation (which way is up) ═══════════════════════════════════════
  // detectSkewAngle above can only fix a small tilt — it can't tell upright
  // from sideways/upside-down (those make identical text bands). Orientation
  // is decided here by evidence of WHERE THINGS SIT, not by band statistics:
  //  1. A passport/ID's MRZ (two dense, full-width lines of OCR-B text) sits
  //     along the bottom edge when upright. Score all four edges for "looks
  //     like an MRZ"; the edge that wins tells exactly how far to turn.
  //  2. No MRZ (an ordinary document): up-vs-down can't be told reliably from
  //     text shape alone (tried: ascender/descender bias flips sign with font
  //     and content), so no rotation is guessed — turns:null, with only a
  //     horizontal/vertical hint. A confident wrong rotation is worse than none.
  function makeCanvas(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }

  function grayScaled(canvas, maxDim) {
    const scale = Math.min(1, maxDim / Math.max(canvas.width, canvas.height));
    const w = Math.max(1, Math.round(canvas.width * scale)), h = Math.max(1, Math.round(canvas.height * scale));
    const c = makeCanvas(w, h);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(canvas, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    const gray = new Float32Array(w * h);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    return { w, h, gray };
  }

  // Local-contrast "ink" mask: a pixel is ink if it is clearly darker than its
  // neighbourhood average (so guilloche/background patterns and lighting
  // gradients don't count, only real dark strokes).
  function inkMask(gray, w, h, ratio = 0.7) {
    const W = w + 1;
    const integ = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) { row += gray[y * w + x]; integ[(y + 1) * W + x + 1] = integ[y * W + x + 1] + row; }
    }
    const r = Math.max(6, Math.round(Math.min(w, h) / 30));
    const ink = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        const mean = (integ[y1 * W + x1] - integ[y0 * W + x1] - integ[y1 * W + x0] + integ[y0 * W + x0]) / ((x1 - x0) * (y1 - y0));
        const g = gray[y * w + x];
        if (g < mean * ratio && g < 170) ink[y * w + x] = 1;
      }
    }
    return ink;
  }

  // How much the outer 35% along one edge looks like an MRZ block: two nearby
  // lines whose ink spans (nearly) the whole line length at moderate density.
  function mrzEdgeScore(ink, w, h, edge) {
    const horizontal = edge === "bottom" || edge === "top";
    const along = horizontal ? w : h;
    const depthMax = horizontal ? h : w;
    const strip = Math.max(8, Math.floor(depthMax * 0.35));
    const SEG = 12;
    const raw = new Float32Array(strip);
    for (let d = 0; d < strip; d++) {
      let count = 0;
      const seg = new Uint16Array(SEG);
      for (let t = 0; t < along; t++) {
        let x, y;
        if (edge === "bottom") { x = t; y = h - 1 - d; }
        else if (edge === "top") { x = t; y = d; }
        else if (edge === "left") { x = d; y = t; }
        else { x = w - 1 - d; y = t; }
        if (ink[y * w + x]) { count++; seg[Math.min(SEG - 1, ((t * SEG) / along) | 0)]++; }
      }
      const frac = count / along;
      const segLen = along / SEG;
      let cov = 0;
      for (let k = 0; k < SEG; k++) if (seg[k] / segLen > 0.06) cov++;
      raw[d] = (frac > 0.06 && frac < 0.55) ? frac * (cov / SEG) : 0;
    }
    const sm = new Float32Array(strip);
    for (let d = 0; d < strip; d++) {
      let s = 0, n = 0;
      for (let k = -2; k <= 2; k++) { const i = d + k; if (i >= 0 && i < strip) { s += raw[i]; n++; } }
      sm[d] = s / n;
    }
    const minGap = Math.max(4, Math.round(depthMax / 60));
    const maxGap = Math.max(minGap + 2, Math.round(depthMax * 0.09));
    let best = 0, bestA = 0, bestB = 0, bestD = 0, bestD2 = 0;
    // The pair must START close to the edge (an MRZ hugs it), so only look for
    // first lines there — a denser block further in (a barcode, a photo, a
    // paragraph) can't outscore the real MRZ and get it discarded.
    const firstMax = Math.min(strip, Math.floor(depthMax * 0.2) + 1);
    for (let d = 0; d < firstMax; d++) {
      let other = 0, otherD = 0;
      for (let g = minGap; g <= maxGap && d + g < strip; g++) if (sm[d + g] > other) { other = sm[d + g]; otherD = d + g; }
      if (sm[d] + other > best) { best = sm[d] + other; bestA = sm[d]; bestB = other; bestD = d; bestD2 = otherD; }
    }
    // An MRZ hugs the document's edge — the pair must start close to it. A
    // block of body text that merely ENDS somewhere inside the strip (a
    // paragraph with a bottom margin) sits further in and is not an MRZ.
    if (best === 0) return 0;
    // An MRZ is exactly TWO lines of matching strength. Ordinary paragraph
    // text also looks "dense and full-width", but it has many comparable lines
    // stacked up — reject anything with a third strong line, or with two
    // lines of very different strength.
    if (best === 0 || Math.min(bestA, bestB) / Math.max(bestA, bestB) < 0.6) return 0;
    // Count separate strong LINES as contiguous runs, but only in the pair's
    // own neighbourhood (up to a short way past the second line): an MRZ has
    // exactly two, paragraph text has a third right behind them. Anything
    // further in (a barcode block, the photo) isn't part of the question.
    let strongLines = 0, inRun = false;
    const strongThr = Math.max(bestA, bestB) * 0.6;
    const windowEnd = Math.min(strip, Math.max(bestD, bestD2) + Math.round(depthMax * 0.06));
    for (let d = 0; d < windowEnd; d++) {
      const on = sm[d] >= strongThr;
      if (on && !inRun) strongLines++;
      inRun = on;
    }
    if (strongLines > 2) return 0;
    return best;
  }

  // Rotates a mask by `turns` clockwise quarter turns (index remap only).
  function rotateMask(ink, w, h, turns) {
    turns = ((turns % 4) + 4) % 4;
    if (turns === 0) return { mask: ink, w, h };
    const w2 = turns % 2 ? h : w, h2 = turns % 2 ? w : h;
    const out = new Uint8Array(w2 * h2);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!ink[y * w + x]) continue;
      let nx, ny;
      if (turns === 1) { nx = h - 1 - y; ny = x; }
      else if (turns === 2) { nx = w - 1 - x; ny = h - 1 - y; }
      else { nx = y; ny = w - 1 - x; }
      out[ny * w2 + nx] = 1;
    }
    return { mask: out, w: w2, h: h2 };
  }

  function rowSpikiness(mask, w, h) {
    const rows = new Float64Array(h);
    for (let y = 0; y < h; y++) { let s = 0; for (let x = 0; x < w; x++) s += mask[y * w + x]; rows[y] = s; }
    let mean = 0; for (let y = 0; y < h; y++) mean += rows[y]; mean /= h;
    if (mean <= 0) return { score: 0, rows };
    let v = 0; for (let y = 0; y < h; y++) v += (rows[y] - mean) * (rows[y] - mean);
    return { score: v / h / (mean * mean), rows };
  }

  // → { turns: 0|1|2|3|null, confidence: 0..1, method: "mrz"|"text"|"none", detail }
  // `turns` = clockwise quarter turns to APPLY to make the image upright.
  function detectOrientation(canvas) {
    const { w, h, gray } = grayScaled(canvas, 800);
    const ink = inkMask(gray, w, h);
    const scores = {
      bottom: mrzEdgeScore(ink, w, h, "bottom"), right: mrzEdgeScore(ink, w, h, "right"),
      top: mrzEdgeScore(ink, w, h, "top"), left: mrzEdgeScore(ink, w, h, "left"),
    };
    const TURNS = { bottom: 0, right: 1, top: 2, left: 3 }; // MRZ edge → turns that bring it to the bottom
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const bestEdge = ranked[0][0], best = ranked[0][1];
    const second = ranked[1][1];
    if (best >= 0.3 && best >= second * 1.3) {
      return { turns: TURNS[bestEdge], confidence: Math.min(1, (best - second) / best), method: "mrz", detail: scores };
    }
    // No MRZ evidence (an ordinary document, or a photo too blurry/tilted to
    // show one). Text-shape cues for up-vs-down were tried and are NOT
    // reliable across fonts/content, so no rotation is guessed — but the text
    // direction (horizontal vs sideways) is still reported as a hint.
    const horiz = rowSpikiness(ink, w, h).score;
    const rot = rotateMask(ink, w, h, 1);
    const vert = rowSpikiness(rot.mask, rot.w, rot.h).score;
    const axis = horiz === 0 && vert === 0 ? null : (Math.abs(horiz - vert) / Math.max(horiz, vert) > 0.25 ? (horiz > vert ? "horizontal" : "vertical") : null);
    return { turns: null, confidence: 0, method: "none", axis, detail: scores };
  }

  function rotateQuarter(source, turns) {
    turns = ((turns % 4) + 4) % 4;
    if (!turns) return source;
    const swap = turns % 2 === 1;
    const c = makeCanvas(swap ? source.height : source.width, swap ? source.width : source.height);
    const ctx = c.getContext("2d");
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((turns * Math.PI) / 2);
    ctx.drawImage(source, -source.width / 2, -source.height / 2);
    return c;
  }

  // ══ OCR enhancement ═════════════════════════════════════════════════════
  // gentle: flatten uneven lighting/shadows (divide by a local paper estimate),
  //         stretch contrast so ink is properly dark, darken mid-tones a touch
  //         (thickens faint strokes), then sharpen edges. Keeps grey levels —
  //         safe for thin MRZ characters. Try this first.
  // strong: pure black text on white (Otsu on the flattened image) with a
  //         1px thickening — the rescue for very faint/blurry text; can break
  //         very thin characters, so it is a second attempt, not the default.
  function boxMean(src, w, h, r) {
    const W = w + 1;
    const integ = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += src[y * w + x]; integ[(y + 1) * W + x + 1] = integ[y * W + x + 1] + row; } }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        out[y * w + x] = (integ[y1 * W + x1] - integ[y0 * W + x1] - integ[y1 * W + x0] + integ[y0 * W + x0]) / ((x1 - x0) * (y1 - y0));
      }
    }
    return out;
  }

  function otsu(hist, total) {
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, t = 128;
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; t = i; }
    }
    return t;
  }

  function enhanceForOcr(source, { mode = "gentle", minLongEdge = 2000, maxLongEdge = 3200, grayscale = true } = {}) {
    const long = Math.max(source.width, source.height);
    let scale = 1;
    if (long < minLongEdge) scale = Math.min(3, minLongEdge / long);
    else if (long > maxLongEdge) scale = maxLongEdge / long;
    const w = Math.max(1, Math.round(source.width * scale)), h = Math.max(1, Math.round(source.height * scale));
    const c = makeCanvas(w, h);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const gray = new Float32Array(w * h);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) gray[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

    // Paper/background estimate: brightest sample per block (ink is darker than
    // paper, so the block maximum IS the paper), smoothed, sampled back up.
    const f = Math.max(1, Math.round(Math.max(w, h) / 500));
    const sw = Math.max(1, Math.ceil(w / f)), sh = Math.max(1, Math.ceil(h / f));
    const small = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      let m = 0;
      for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) {
        const yy = Math.min(h - 1, y * f + dy), xx = Math.min(w - 1, x * f + dx);
        const g = gray[yy * w + xx]; if (g > m) m = g;
      }
      small[y * sw + x] = m;
    }
    const bgSmall = boxMean(small, sw, sh, Math.max(3, Math.round(Math.min(sw, sh) / 12)));
    const bgAt = (x, y) => {
      const fx = Math.min(sw - 1, Math.max(0, x / f - 0.5)), fy = Math.min(sh - 1, Math.max(0, y / f - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
      const tx = fx - x0, ty = fy - y0;
      const a = bgSmall[y0 * sw + x0] * (1 - tx) + bgSmall[y0 * sw + x1] * tx;
      const b = bgSmall[y1 * sw + x0] * (1 - tx) + bgSmall[y1 * sw + x1] * tx;
      return Math.max(40, a * (1 - ty) + b * ty);
    };
    const ratio = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const r = gray[y * w + x] / bgAt(x, y); ratio[y * w + x] = r > 1 ? 1 : r; }

    const out = new Uint8ClampedArray(w * h);
    if (mode === "strong") {
      const hist = new Array(256).fill(0);
      for (let i = 0; i < ratio.length; i++) hist[(ratio[i] * 255) | 0]++;
      const t = otsu(hist, ratio.length) / 255;
      const thr = Math.min(0.86, Math.max(0.45, t));
      const black = new Uint8Array(w * h);
      for (let i = 0; i < ratio.length; i++) black[i] = ratio[i] < thr ? 1 : 0;
      const bold = scale >= 1.5;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let v = black[y * w + x];
        if (!v && bold) {
          if ((x > 0 && black[y * w + x - 1]) || (x < w - 1 && black[y * w + x + 1]) || (y > 0 && black[(y - 1) * w + x]) || (y < h - 1 && black[(y + 1) * w + x])) v = 1;
        }
        out[y * w + x] = v ? 0 : 255;
      }
    } else {
      // percentile floor so the darkest ink maps to ~0 without one outlier deciding it
      const hist = new Array(256).fill(0);
      for (let i = 0; i < ratio.length; i++) hist[(ratio[i] * 255) | 0]++;
      let acc = 0, lowBin = 0; const target = ratio.length * 0.02;
      for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) { lowBin = i; break; } }
      const low = Math.min(0.6, lowBin / 255);
      const v = new Float32Array(w * h);
      for (let i = 0; i < ratio.length; i++) {
        const s = Math.max(0, Math.min(1, (ratio[i] - low) / (1 - low)));
        v[i] = Math.pow(s, 1.5) * 255;
      }
      const blur = boxMean(v, w, h, Math.max(1, Math.round(Math.max(w, h) / 1200)));
      for (let i = 0; i < v.length; i++) out[i] = Math.max(0, Math.min(255, v[i] + 0.9 * (v[i] - blur[i])));
    }
    // grayscale:false (Gentle only) keeps the photo's colours — the same
    // per-pixel brightening/darkening is applied as a gain on the original RGB.
    const keepColour = mode !== "strong" && grayscale === false;
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      if (keepColour) {
        const k = out[p] / Math.max(1, gray[p]);
        d[i] = Math.min(255, d[i] * k); d[i + 1] = Math.min(255, d[i + 1] * k); d[i + 2] = Math.min(255, d[i + 2] * k);
      } else {
        d[i] = d[i + 1] = d[i + 2] = out[p];
      }
      d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // ══ One-call preparation ════════════════════════════════════════════════
  async function toCanvas(src) {
    if (src && src.getContext) return src;
    const bmp = await createImageBitmap(src);
    const c = makeCanvas(bmp.width, bmp.height);
    c.getContext("2d").drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    return c;
  }
  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't encode the image."))), type, quality));
  }

  // Straightens (orientation + tilt) and trims a photo. Returns
  // { canvas, info:{ turns, orientation, skew, trimmed } } — the CLEAN image
  // (colour, safe to hand to Masar); run enhanceForOcr on it for OCR input.
  async function prepareForOcr(src, { trim = true } = {}) {
    const original = await toCanvas(src);
    let canvas = original;
    const info = { turns: 0, orientation: null, skew: null, trimmed: false };
    // Every rotation is recorded so it can be replayed on the UNTRIMMED photo
    // when the caller asked for no cropping (the Straightener): detection always
    // runs on a trimmed copy — a screenshot's status bar or a desk around a
    // passport breaks it otherwise — but the output keeps the whole frame.
    const ops = [];
    const quarter = (c, n) => { ops.push({ q: n }); return rotateQuarter(c, n); };
    const skewBy = (c, angle) => { ops.push({ a: angle }); return rotateCanvasByAngle(c, c.width, c.height, angle); };
    const cropTo = (rect) => {
      const c = makeCanvas(rect.width, rect.height);
      c.getContext("2d").drawImage(canvas, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
      canvas = c; info.trimmed = true;
    };
    const trimNow = () => {
      // Uniform blank margins first, then non-uniform chrome (a screenshot's
      // status bar / toast) by finding the colourful document block.
      const rect = detectContentBounds(canvas, { tolerance: 20 });
      if (rect && rect.width * rect.height >= canvas.width * canvas.height * 0.4) cropTo(rect);
      const doc = detectDocumentBounds(canvas);
      if (doc && doc.width * doc.height >= canvas.width * canvas.height * 0.2) cropTo(doc);
    };
    trimNow(); // the MRZ only hugs the DOCUMENT's edge, so crop to the document before looking for it

    let o = detectOrientation(canvas);
    if (o.method !== "mrz") {
      // A tilted photo smears the MRZ lines across rows so it can't be found
      // yet. Level the text first (skew detection doesn't care which way is up,
      // only that lines are near-horizontal) and look again — for the image as
      // it is AND turned a quarter (a sideways shot). A quarter turn is only
      // ever KEPT when the MRZ then shows up (real evidence); otherwise it is
      // dropped, so an ordinary text page is never spun sideways on a guess.
      let chosen = null;
      for (const q of [0, 1]) {
        const c = q ? rotateQuarter(canvas, q) : canvas;
        const sk = detectSkewAngle(c);
        if (!sk) continue;
        const leveled = Math.abs(sk.angle) >= 0.3 ? rotateCanvasByAngle(c, c.width, c.height, sk.angle) : c;
        const o2 = detectOrientation(leveled);
        if (o2.method === "mrz") { chosen = { q, leveled, sk, o2 }; break; }
        if (q === 0) chosen = { q: 0, leveled, sk, o2 };
      }
      if (chosen) {
        if (chosen.q) ops.push({ q: chosen.q });
        if (Math.abs(chosen.sk.angle) >= 0.3) ops.push({ a: chosen.sk.angle });
        canvas = chosen.leveled; info.turns = chosen.q; info.skew = chosen.sk.angle; o = chosen.o2;
      }
    }
    info.orientation = { method: o.method, confidence: Math.round(o.confidence * 100) / 100, turns: o.turns, axis: o.axis || null };
    if (o.turns) { canvas = quarter(canvas, o.turns); info.turns = (info.turns + o.turns) % 4; }
    const skew = detectSkewAngle(canvas);
    if (skew && Math.abs(skew.angle) >= 0.3) {
      canvas = skewBy(canvas, skew.angle);
      info.skew = (info.skew || 0) + skew.angle;
    }
    if (trim) {
      trimNow(); // rotation/straightening exposes new white corners — trim those too
      return { canvas, info };
    }
    // No cropping wanted: replay just the rotations on the whole original frame.
    let out = original;
    for (const op of ops) out = op.q ? rotateQuarter(out, op.q) : rotateCanvasByAngle(out, out.width, out.height, op.a);
    info.trimmed = false;
    return { canvas: out, info };
  }

  window.NkImagePrep = {
    detectOrientation, detectSkewAngle, rotateCanvasByAngle, rotateQuarter, detectContentBounds, detectDocumentBounds,
    enhanceForOcr, prepareForOcr, toCanvas, canvasToBlob,
    _internals: { grayScaled, inkMask, mrzEdgeScore, rotateMask },
  };
})();
