// Save to Photos decisions that don't need a DOM (§F15, §5.7): where each export
// band sits, which part of the output the captions can touch, how captions land
// on the pixels, how the progress fill is paced, and what to do with whatever
// navigator.share does. ui/exporter.js and ui/savesheet.js do the GPU and DOM work.

export const JPEG_TYPE = 'image/jpeg';
export const JPEG_QUALITY = 0.92;

// The progress fill: the GPU bands report as they finish and fill this share; the
// encoder reports nothing, so the rest is paced by encodeEstimateMs.
export const RENDER_SHARE = 0.5;
export const ENCODE_CEILING = 0.95; // where the paced fill waits for the real end

// Output px -> band px: the band's first row becomes row 0 of its framebuffer
// (renderPixels returns rows top-first).
export function bandMatrix(band) {
  return [1, 0, 0, 1, 0, -band.y];
}

// Did a band really come back from the GPU? The develop pass writes alpha 1
// everywhere and the clear is opaque, but a context lost mid-export (iOS resets the
// GPU under memory pressure) reads back zeros, before 'webglcontextlost' has fired
// to say so. Saving that would put a black stripe in Photos.
export function bandRendered(px, samples = 64) {
  const n = Math.floor((px?.length ?? 0) / 4);
  if (n === 0) return false;
  const k = Math.max(1, Math.min(n, samples));
  for (let i = 0; i < k; i++) {
    const p = k === 1 ? 0 : Math.round((i * (n - 1)) / (k - 1));
    if (px[p * 4 + 3] !== 255) return false;
  }
  return true;
}

export function renderProgress(done, total) {
  if (!(total > 0)) return RENDER_SHARE;
  return RENDER_SHARE * Math.min(1, Math.max(0, done / total));
}

// A guess at the JPEG encode time, only to pace the fill while the encoder is
// silent. Desktop Chromium does about 60 ms per MP; a phone's efficiency cores
// take longer, and a fill that stops short reads better than one that overshoots.
export function encodeEstimateMs(width, height) {
  const mp = (Math.max(0, width) * Math.max(0, height)) / 1e6;
  return Math.round(Math.min(20000, 250 + 90 * mp));
}

// Integer output-px rectangle covering every rect in `rects` ({ x, y, width,
// height }, any of them fractional), each grown by its `margin`, clipped to the
// output. null when nothing lands on the output.
export function coverRect(rects, outW, outH) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects ?? []) {
    if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite)) continue;
    const m = Number.isFinite(r.margin) && r.margin > 0 ? r.margin : 0;
    x0 = Math.min(x0, r.x - m);
    y0 = Math.min(y0, r.y - m);
    x1 = Math.max(x1, r.x + r.width + m);
    y1 = Math.max(y1, r.y + r.height + m);
  }
  const x = Math.max(0, Math.floor(x0)), y = Math.max(0, Math.floor(y0));
  const right = Math.min(outW, Math.ceil(x1)), bottom = Math.min(outH, Math.ceil(y1));
  if (!(right > x && bottom > y)) return null;
  return { x, y, width: right - x, height: bottom - y };
}

// The part of `rect` inside a band's rows, or null.
export function clipToBand(rect, band) {
  if (!rect) return null;
  const y = Math.max(rect.y, band.y);
  const bottom = Math.min(rect.y + rect.height, band.y + band.h);
  if (bottom <= y) return null;
  return { x: rect.x, y, width: rect.width, height: bottom - y };
}

// Lay straight-alpha RGBA `src` (srcW x srcH, e.g. getImageData of the caption
// raster) over the opaque photo `dst` (dstW x dstH) with its top-left at (x0, y0),
// in place. Fully transparent pixels are skipped, so a mostly empty raster costs
// little. The photo stays opaque: JPEG has no alpha, and putImageData would
// premultiply anything less than 255.
export function compositeOver(dst, dstW, dstH, src, srcW, srcH, x0 = 0, y0 = 0) {
  const xa = Math.max(0, x0), ya = Math.max(0, y0);
  const xb = Math.min(dstW, x0 + srcW), yb = Math.min(dstH, y0 + srcH);
  for (let y = ya; y < yb; y++) {
    let s = ((y - y0) * srcW + (xa - x0)) * 4;
    let d = (y * dstW + xa) * 4;
    for (let x = xa; x < xb; x++, s += 4, d += 4) {
      const a = src[s + 3];
      if (a === 0) continue;
      if (a === 255) {
        dst[d] = src[s];
        dst[d + 1] = src[s + 1];
        dst[d + 2] = src[s + 2];
      } else {
        const k = 255 - a;
        // `| 0` after +127 rounds the same way into any byte array type.
        dst[d] = ((src[s] * a + dst[d] * k + 127) / 255) | 0;
        dst[d + 1] = ((src[s + 1] * a + dst[d + 1] * k + 127) / 255) | 0;
        dst[d + 2] = ((src[s + 2] * a + dst[d + 2] * k + 127) / 255) | 0;
      }
      dst[d + 3] = 255;
    }
  }
  return dst;
}

// What a Save to Photos tap should do in this browser. navigator.share with files
// is Web Share level 2; where canShare exists it is asked first, and where it
// doesn't the share call itself is tried (a rejection then opens the fallback).
export function shareRoute(nav, data) {
  if (!nav || typeof nav.share !== 'function') return 'fallback';
  if (typeof nav.canShare === 'function') {
    try {
      if (!nav.canShare(data)) return 'fallback';
    } catch {
      return 'fallback';
    }
  }
  return 'share';
}

// How a share promise settled: resolved = saved (iOS resolves once an action such
// as Save Image ran), AbortError = the user closed the share sheet (leave the sheet
// as it was), anything else = show the long-press fallback.
export function shareOutcome(error) {
  if (error == null) return 'saved';
  if (error?.name === 'AbortError') return 'cancelled';
  return 'failed';
}

// The preview canvas: the output fitted inside boxW x boxH CSS px (never larger
// than the output itself), and the pixel side to render it at for this DPR.
export function previewFit(outW, outH, boxW, boxH, dpr = 1) {
  const k = Math.min(1, Math.max(1, boxW) / outW, Math.max(1, boxH) / outH);
  const cssW = Math.max(1, Math.round(outW * k));
  const cssH = Math.max(1, Math.round(outH * k));
  const d = Number.isFinite(dpr) && dpr > 0 ? Math.min(dpr, 3) : 1;
  const maxSide = Math.max(1, Math.min(Math.max(outW, outH), Math.ceil(Math.max(cssW, cssH) * d)));
  return { cssW, cssH, maxSide };
}

// Swiping the sheet down: past CLOSE_PT, or a downward flick, closes it. Upward
// travel is damped so the sheet feels attached rather than draggable off the top.
export const SWIPE_CLOSE_PT = 90;
export const SWIPE_FLICK_PT_PER_MS = 0.5;
export const SWIPE_FLICK_MIN_PT = 16;

export function swipeCloses(dy, velocity) {
  if (!Number.isFinite(dy)) return false;
  if (dy >= SWIPE_CLOSE_PT) return true;
  return dy >= SWIPE_FLICK_MIN_PT && Number.isFinite(velocity) && velocity >= SWIPE_FLICK_PT_PER_MS;
}

export function sheetOffset(dy) {
  if (!Number.isFinite(dy)) return 0;
  return dy >= 0 ? dy : -Math.sqrt(-dy) * 2;
}
