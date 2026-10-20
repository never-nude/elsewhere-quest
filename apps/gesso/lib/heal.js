// Remove's fast path: heal a tapped spot (and Try another / a dragged Source) by
// copying from one nearby offset, then hiding the seam with a smooth correction.
//
// The copy carries real texture at full sharpness. The correction c solves
// Laplace's equation inside the hole, with c = target − copy on the boundary, so
// copy + c agrees with the surroundings at the edge and varies smoothly in
// between. That is a Poisson blend of the copied patch (Pérez et al. 2003), and
// because c is smooth it can be solved at search scale and upsampled on the GPU
// without softening the fill. Rubbed areas use PatchMatch instead (inpaint.js).
//
// Pure: no DOM. Images are { width, height, data: RGBA bytes }; masks are
// Uint8Array(width * height), non-zero = heal. Pixel (x, y) has its centre at
// (x + 0.5, y + 0.5), the convention WebGL rasterizes with, so masks built here
// line up with the ones the GPU draws from the same stroke.

import { inpaintScaled } from './inpaint.js';
import { cleanPoints } from './stroke.js';

// A single heal may cover at most this fraction of the photo, by bounding box.
export const AREA_CAP = 0.2;

const OMEGA = 1.8; // SOR over-relaxation
const COARSE_MASK_PX = 16; // exhaustive search runs where the mask is about this thick...
const COARSE_MAX_PX = 64; // ...and at most this long
const COARSE_KEEP = 8; // candidates carried from the coarse search into refinement
const MIN_SEARCH = 32; // px: smallest search window, so tiny spots still look around
const LUMA = [0.2126, 0.7152, 0.0722];

// ------------------------------------------------------------------ masks

export function diskMask(cx, cy, r, w, h) {
  checkSize(w, h);
  const mask = new Uint8Array(w * h);
  if (Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(r) && r > 0) {
    stampCapsule(mask, w, h, cx, cy, cx, cy, r);
  }
  return mask;
}

// Every pixel within r of the polyline: the union of discs centred anywhere along
// it, not just at the points, so it's gap-free however far apart the points are.
export function strokeMask(points, r, w, h) {
  checkSize(w, h);
  const mask = new Uint8Array(w * h);
  if (!Number.isFinite(r) || !(r > 0)) return mask;
  const pts = cleanPoints(points);
  if (pts.length === 2) stampCapsule(mask, w, h, pts[0], pts[1], pts[0], pts[1], r);
  for (let i = 2; i < pts.length; i += 2) {
    stampCapsule(mask, w, h, pts[i - 2], pts[i - 1], pts[i], pts[i + 1], r);
  }
  return mask;
}

// Tight box of the mask plus its pixel count (`area`), or null when empty.
export function maskBounds(mask, w, h) {
  checkMask(mask, w, h);
  let x0 = w, y0 = h, x1 = -1, y1 = -1, area = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!mask[row + x]) continue;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area };
}

// The Remove size cap is measured by bounding box, not by painted pixels: a thin
// ring around a big object still needs a fill that big. Only the part of the box
// on the photo counts (when the rect has a position): rubbing out something at
// the frame's edge usually strays past it, and strokeBounds() isn't clipped.
export function exceedsAreaCap(rect, imageW, imageH) {
  if (!rect) return false;
  let { w, h } = rect;
  if (Number.isFinite(rect.x) && Number.isFinite(rect.y)) {
    w = Math.min(imageW, rect.x + rect.w) - Math.max(0, rect.x);
    h = Math.min(imageH, rect.y + rect.h) - Math.max(0, rect.y);
  }
  if (!(w > 0) || !(h > 0)) return false; // nothing on the photo to fill
  return w * h > AREA_CAP * imageW * imageH;
}

// ------------------------------------------------------------------ search

// Best offsets (dx, dy) to copy the hole from, best first. Each candidate is
// scored on the ring just outside the hole: does the ring around the source
// look like the ring around the target? Score = mean ring SSD (RGB) + 0.5 · mean
// ring gradient SSD (luma) + 0.002 · |offset|², the last term preferring nearby
// texture when two places match equally. Exhaustive at a coarse level, refined
// at each finer one; alternatives are kept at least 0.5 r apart so Try another
// shows something actually different. Offsets reach up to 4x the hole's longer
// side (at least 32 px) — the whole region, for the region Remove reads.
export function findSources(img, mask, { maxResults = 4 } = {}) {
  const { width, height } = checkImage(img);
  checkMask(mask, width, height);
  const want = Math.floor(maxResults ?? 4); // null means "default", as in the worker
  if (!(want >= 1)) return [];
  const bounds = maskBounds(mask, width, height);
  if (!bounds || bounds.area === width * height) return [];

  const holeBox = { x0: bounds.x, y0: bounds.y, x1: bounds.x + bounds.w - 1, y1: bounds.y + bounds.h - 1 };
  const r = holeRadius(mask, width, height, holeBox);
  const ringW = Math.max(3, Math.round(0.25 * r));
  const nms = Math.max(2, 0.5 * r);
  const long = Math.max(bounds.w, bounds.h);
  const searchRadius = Math.max(MIN_SEARCH, 4 * long);

  // Nothing a valid offset can touch lies further than searchRadius + ringW from
  // the hole, so work on that window (offsets don't care where it sits): a small
  // spot in a big region then costs what a small region would.
  const win = cropOf(holeBox, searchRadius + ringW + 1, width, height);
  const w = win.w, h = win.h;
  const hole = cropBits(mask, width, win, false);
  const box = { x0: holeBox.x0 - win.x, y0: holeBox.y0 - win.y, x1: holeBox.x1 - win.x, y1: holeBox.y1 - win.y };

  // The coarse level is the coarsest where the hole is still COARSE_MASK_PX or
  // more across its thickness (16-32 px): squashed thinner, fine texture
  // averages away and the true source stops standing out. It is also never
  // longer than COARSE_MAX_PX, which bounds the scan's cost for long thin strokes.
  const byThickness = Math.floor(Math.log2((2 * r) / COARSE_MASK_PX));
  const byLength = Math.ceil(Math.log2(long / COARSE_MAX_PX));
  let depth = Math.max(0, byThickness, byLength);
  while (depth > 0 && Math.min(w, h) >> depth < 8) depth--;
  const full = makeLevel(toRgb(img, win), hole, w, h, ringW, box);
  if (!full.ring.length) return [];
  const levels = [full];
  for (let l = 1; l <= depth; l++) {
    const prev = levels[l - 1];
    const down = downsample(prev.rgb, prev.hole, prev.w, prev.h);
    // A coarse pixel is hole iff a child is, so the hole's box just halves. The
    // ring keeps its full-resolution width, so every level scores the same band.
    const b = { x0: box.x0 >> l, y0: box.y0 >> l, x1: box.x1 >> l, y1: box.y1 >> l };
    levels.push(makeLevel(down.rgb, down.hole, down.w, down.h, Math.max(1, Math.round(ringW / 2 ** l)), b));
  }

  // Validity is always judged at full resolution. A coarse level's inflated hole
  // would otherwise rule out tight offsets that are perfectly valid, before
  // refinement ever got near them.
  const valid = (l) => (ox, oy) => fits(full, ox * 2 ** l, oy * 2 ** l);
  // A level's scan only visits multiples of its scale. When the only room left
  // lies between them (a big hole in a tight region, or one pressed against the
  // photo's edge), drop a level and look again: at full resolution every valid
  // offset within the search window is visited, so [] really means none fits.
  for (let d = depth; d >= 0; d--) {
    const top = levels[d];
    const scale = 2 ** d;
    // Stride 2 only samples the score properly if the image is band-limited to
    // half its pixel rate: on fine texture (white noise at the extreme) a match
    // that falls between grid points is otherwise invisible. So the scan scores
    // a [1 2 1]-blurred copy (one that never smears the object into the ring),
    // and the ±1 refinement below uses the sharp level.
    const soft = blur121(top.rgb, top.hole, top.w, top.h);
    const scan = { ...top, rgb: soft, ...gradients(soft, top.w, top.h) };
    let cands = coarseSearch(scan, full, scale, searchRadius, valid(d));
    if (!cands.length) continue;
    cands = suppress(cands, nms / scale, Math.max(COARSE_KEEP, 2 * want));
    cands = cands.map((c) => refine(top, c.dx, c.dy, 1, scale, valid(d))).filter(Boolean);
    for (let l = d - 1; l >= 0; l--) {
      cands = cands.map((c) => refine(levels[l], 2 * c.dx, 2 * c.dy, 2, 2 ** l, valid(l))).filter(Boolean);
    }
    return suppress(cands, nms, want);
  }
  return [];
}

// Stride-2 scan (in level px) of every offset within the search window that is
// valid at full resolution. Falls back to stride 1 when the room is too tight for
// stride 2 to land on any.
function coarseSearch(L, full, scale, searchRadius, valid) {
  const { x0, y0, x1, y1 } = full.box;
  const oxMin = Math.ceil(Math.max(-x0, -searchRadius) / scale);
  const oxMax = Math.floor(Math.min(full.w - 1 - x1, searchRadius) / scale);
  const oyMin = Math.ceil(Math.max(-y0, -searchRadius) / scale);
  const oyMax = Math.floor(Math.min(full.h - 1 - y1, searchRadius) / scale);
  for (const stride of [2, 1]) {
    const out = [];
    for (let oy = Math.ceil(oyMin / stride) * stride; oy <= oyMax; oy += stride) {
      for (let ox = Math.ceil(oxMin / stride) * stride; ox <= oxMax; ox += stride) {
        if (!valid(ox, oy)) continue;
        const s = score(L, ox, oy, scale);
        if (s < Infinity) out.push({ dx: ox, dy: oy, score: s });
      }
    }
    if (out.length) return out;
  }
  return [];
}

// Best valid offset within ±rad of (ox, oy), or null when none is valid. Nearest
// the prediction first: that is usually the best, which lets score() abandon
// the rest early, and it breaks ties toward the prediction.
function refine(L, ox, oy, rad, scale, valid) {
  let best = null;
  for (const [i, j] of spiral(rad)) {
    if (!valid(ox + i, oy + j)) continue;
    const bound = best ? best.score : Infinity;
    const s = score(L, ox + i, oy + j, scale, bound);
    if (s < bound) best = { dx: ox + i, dy: oy + j, score: s };
  }
  return best;
}

const spirals = new Map();
function spiral(rad) {
  if (!spirals.has(rad)) {
    const out = [];
    for (let j = -rad; j <= rad; j++) for (let i = -rad; i <= rad; i++) out.push([i, j]);
    out.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1])); // stable: ties keep scan order
    spirals.set(rad, out);
  }
  return spirals.get(rad);
}

// Non-maximum suppression: best first, skipping anything within `radius` of a
// candidate already taken.
function suppress(cands, radius, keep) {
  const sorted = cands.slice().sort((a, b) => a.score - b.score);
  const r2 = radius * radius;
  const out = [];
  for (const c of sorted) {
    if (out.length >= keep) break;
    if (out.some((o) => (o.dx - c.dx) ** 2 + (o.dy - c.dy) ** 2 < r2)) continue;
    out.push(c);
  }
  return out;
}

// The dilated hole (hole + ring) shifted by the offset must stay inside the image
// and must not overlap itself, or we'd compare against — or copy — the very
// thing being removed. Tested run against run, row by row, not pixel by pixel:
// the full-resolution scan can test every offset in the window, and a big hole's
// dilated area is hundreds of thousands of pixels but only a few hundred runs.
function fits(L, ox, oy) {
  const { x0, y0, x1, y1 } = L.box;
  if (x0 + ox < 0 || y0 + oy < 0 || x1 + ox >= L.w || y1 + oy >= L.h) return false;
  if (x0 + ox > x1 || x1 + ox < x0 || y0 + oy > y1 || y1 + oy < y0) return true; // boxes apart
  const { runs, rowRuns, runY } = L;
  const ya = Math.max(y0, y0 - oy), yb = Math.min(y1, y1 - oy);
  for (let y = ya; y <= yb; y++) {
    // Row y's runs, shifted by the offset, against row (y + oy)'s runs: both
    // lists are sorted and disjoint, so a merge finds any intersection.
    let a = rowRuns[y - runY], b = rowRuns[y + oy - runY];
    const aEnd = rowRuns[y - runY + 1], bEnd = rowRuns[y + oy - runY + 1];
    while (a < aEnd && b < bEnd) {
      const as = runs[2 * a] + ox, ae = runs[2 * a + 1] + ox, bs = runs[2 * b], be = runs[2 * b + 1];
      if (as <= be && bs <= ae) return false;
      if (ae < be) a++;
      else b++;
    }
  }
  return true;
}

// Infinity when no ring pixel lands on the image. Full-resolution offsets always
// keep the whole ring on it; a coarse level's slightly fatter ring can hang off
// an edge by a pixel, and then only the part on the image is compared.
// With a `bound`, gives up as soon as the partial sum proves the score is no
// better, returning that (≥ bound) partial value: every term only adds.
function score(L, ox, oy, scale, bound = Infinity) {
  const { w, h, box } = L;
  const whole = box.x0 + ox >= 0 && box.y0 + oy >= 0 && box.x1 + ox < w && box.y1 + oy < h;
  const fx = ox * scale, fy = oy * scale; // the distance penalty is in full-size px
  const penalty = 0.002 * (fx * fx + fy * fy);
  if (!whole) return clippedScore(L, ox, oy) + penalty;
  if (penalty >= bound) return penalty;
  const { rgb, gx, gy, ring, ringG } = L;
  if (!ring.length) return Infinity;
  const off = oy * w + ox;
  const nr = 1 / ring.length, ng = ringG.length ? 0.5 / ringG.length : 0;
  let s = 0;
  for (let k = 0; k < ring.length; k++) {
    const p = ring[k] * 3, q = (ring[k] + off) * 3;
    const a = rgb[p] - rgb[q], b = rgb[p + 1] - rgb[q + 1], c = rgb[p + 2] - rgb[q + 2];
    s += a * a + b * b + c * c;
    if ((k & 63) === 63 && s * nr + penalty >= bound) return s * nr + penalty;
  }
  const base = s * nr + penalty;
  let g = 0;
  for (let k = 0; k < ringG.length; k++) {
    const p = ringG[k], q = p + off;
    const a = gx[p] - gx[q], b = gy[p] - gy[q];
    g += a * a + b * b;
    if ((k & 63) === 63 && base + g * ng >= bound) return base + g * ng;
  }
  return base + g * ng;
}

// score() without the penalty, over only the ring pixels that land on the image.
function clippedScore(L, ox, oy) {
  const { w, h, rgb, gx, gy, ring, ringG } = L;
  const off = oy * w + ox;
  let s = 0, n = 0, g = 0, ng = 0;
  for (let k = 0; k < ring.length; k++) {
    const x = (ring[k] % w) + ox, y = ((ring[k] / w) | 0) + oy;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const p = ring[k] * 3, q = (ring[k] + off) * 3;
    const a = rgb[p] - rgb[q], b = rgb[p + 1] - rgb[q + 1], c = rgb[p + 2] - rgb[q + 2];
    s += a * a + b * b + c * c;
    n++;
  }
  for (let k = 0; k < ringG.length; k++) {
    const x = (ringG[k] % w) + ox, y = ((ringG[k] / w) | 0) + oy;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const p = ringG[k], q = p + off;
    const a = gx[p] - gx[q], b = gy[p] - gy[q];
    g += a * a + b * b;
    ng++;
  }
  return n ? s / n + (ng ? (0.5 * g) / ng : 0) : Infinity;
}

// One pyramid level, ready to score: the ring of width `ringW` around the hole,
// the dilated hole (as row runs) for the overlap test, and luma gradients. `hb`
// is the hole's box; every ring pixel lies within ringW of it, so distances are
// only computed there (exactly: a shortest chamfer path stays inside the box of
// its two ends).
function makeLevel(rgb, hole, w, h, ringW, hb) {
  const crop = cropOf(hb, ringW, w, h);
  const out = chamfer(cropBits(hole, w, crop, false), crop.w, crop.h);
  const ring = [], ringG = [], runs = [];
  // rowRuns[k] .. rowRuns[k + 1] index the runs (pairs in `runs`) of row crop.y + k.
  const rowRuns = new Int32Array(crop.h + 1);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = crop.y; y < crop.y + crop.h; y++) {
    let open = -1; // x where the current run started
    for (let x = crop.x; x <= crop.x + crop.w; x++) {
      const i = y * w + x;
      const on = x < crop.x + crop.w && (hole[i] || out[(y - crop.y) * crop.w + x - crop.x] <= ringW);
      if (on && open < 0) open = x;
      if (!on && open >= 0) { runs.push(open, x - 1); open = -1; }
      if (!on) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (hole[i]) continue;
      ring.push(i);
      // Gradients next to the hole would difference against the object itself.
      const touches = (x > 0 && hole[i - 1]) || (x < w - 1 && hole[i + 1])
        || (y > 0 && hole[i - w]) || (y < h - 1 && hole[i + w]);
      if (!touches) ringG.push(i);
    }
    rowRuns[y - crop.y + 1] = runs.length / 2;
  }
  const { gx, gy } = gradients(rgb, w, h);
  return {
    w, h, rgb, hole, gx, gy,
    ring: Int32Array.from(ring), ringG: Int32Array.from(ringG),
    runs: Int32Array.from(runs), rowRuns, runY: crop.y,
    box: { x0, y0, x1, y1 },
  };
}

// Half-size level: colours box-averaged, and a coarse pixel is hole if any of its
// children is, so the object can never leak into the coarse ring.
function downsample(rgb, hole, w, h) {
  const cw = (w + 1) >> 1, ch = (h + 1) >> 1;
  const crgb = new Float32Array(cw * ch * 3);
  const chole = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    const ra = 2 * y * w, rb = Math.min(h - 1, 2 * y + 1) * w;
    for (let x = 0; x < cw; x++) {
      const xa = 2 * x, xb = Math.min(w - 1, 2 * x + 1);
      const a = ra + xa, b = ra + xb, c = rb + xa, d = rb + xb; // clamped children
      const o = y * cw + x;
      chole[o] = hole[a] | hole[b] | hole[c] | hole[d];
      for (let k = 0; k < 3; k++) {
        crgb[o * 3 + k] = (rgb[a * 3 + k] + rgb[b * 3 + k] + rgb[c * 3 + k] + rgb[d * 3 + k]) / 4;
      }
    }
  }
  return { rgb: crgb, hole: chole, w: cw, h: ch };
}

// Separable [1 2 1] blur, edges clamped, over non-hole pixels only (normalized
// convolution: each tap's weight is zero on the hole). A plain blur would smear
// the object into the inner ring, and a bright blemish would then steer the scan
// towards sources that happen to look like it. Pixels with no non-hole tap (deep
// inside the hole, never scored) keep their own value.
function blur121(rgb, hole, w, h) {
  const tmp = new Float32Array(rgb.length), tw = new Float32Array(w * h), out = new Float32Array(rgb.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x, l = y * w + Math.max(0, x - 1), r = y * w + Math.min(w - 1, x + 1);
      const kl = hole[l] ? 0 : 1, kp = hole[p] ? 0 : 2, kr = hole[r] ? 0 : 1;
      tw[p] = kl + kp + kr;
      for (let c = 0; c < 3; c++) tmp[p * 3 + c] = kl * rgb[l * 3 + c] + kp * rgb[p * 3 + c] + kr * rgb[r * 3 + c];
    }
  }
  for (let y = 0; y < h; y++) {
    const u = Math.max(0, y - 1) * w, d = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) {
      const p = y * w + x, a = u + x, e = d + x;
      const wt = tw[a] + 2 * tw[p] + tw[e];
      for (let c = 0; c < 3; c++) {
        out[p * 3 + c] = wt > 0 ? (tmp[a * 3 + c] + 2 * tmp[p * 3 + c] + tmp[e * 3 + c]) / wt : rgb[p * 3 + c];
      }
    }
  }
  return out;
}

function gradients(rgb, w, h) {
  const n = w * h;
  const Y = new Float32Array(n);
  for (let i = 0; i < n; i++) Y[i] = LUMA[0] * rgb[i * 3] + LUMA[1] * rgb[i * 3 + 1] + LUMA[2] * rgb[i * 3 + 2];
  const gx = new Float32Array(n), gy = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const yu = Math.max(0, y - 1), yd = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      gx[i] = Y[y * w + Math.min(w - 1, x + 1)] - Y[y * w + Math.max(0, x - 1)];
      gy[i] = Y[yd * w + x] - Y[yu * w + x];
    }
  }
  return { gx, gy };
}

// Half-thickness of the hole: its deepest pixel's distance to the outside. For a
// disc that's the radius; for a rubbed stroke, the brush radius.
function holeRadius(hole, w, h, hb) {
  const d = insideDistance(hole, w, h, hb);
  let r = 0;
  for (let i = 0; i < d.dist.length; i++) if (d.dist[i] < Infinity && d.dist[i] > r) r = d.dist[i];
  return r;
}

// Distance from each hole pixel to the nearest non-hole pixel, on the hole's box
// grown by one. That one-pixel frame is all non-hole (or off the image), so it
// holds every hole pixel's nearest outside neighbour. Non-hole pixels read 0.
function insideDistance(hole, w, h, hb) {
  const crop = cropOf(hb, 1, w, h);
  return { crop, dist: chamfer(cropBits(hole, w, crop, true), crop.w, crop.h) };
}

// The box grown by `m` and clipped to the image, as { x, y, w, h }.
function cropOf(b, m, w, h) {
  const x = Math.max(0, b.x0 - m), y = Math.max(0, b.y0 - m);
  return { x, y, w: Math.min(w - 1, b.x1 + m) - x + 1, h: Math.min(h - 1, b.y1 + m) - y + 1 };
}

// The crop of a 0/1 mask, inverted on request.
function cropBits(bits, w, crop, invert) {
  const out = new Uint8Array(crop.w * crop.h);
  for (let y = 0; y < crop.h; y++) {
    const row = (y + crop.y) * w + crop.x;
    for (let x = 0; x < crop.w; x++) out[y * crop.w + x] = (bits[row + x] ? 1 : 0) ^ (invert ? 1 : 0);
  }
  return out;
}

// ------------------------------------------------------------------ seam

// The correction field, Float32Array(width * height * 3) aligned with img.
// Inside the hole: the membrane solution. Outside it: exactly target − copy, so
// copy + c reproduces the original there, and a bilinear upsample of c near the
// edge (the GPU's composeFill) reads true boundary values rather than zeros.
export function solveCorrection(img, mask, dx, dy, { iters = 120 } = {}) {
  const { width: w, height: h, data } = checkImage(img);
  checkMask(mask, w, h);
  const ox = toOffset(dx), oy = toOffset(dy);
  const its = Number.isFinite(iters) ? Math.min(10000, Math.max(0, Math.floor(iters))) : 120;
  const corr = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const srcRow = Math.min(h - 1, Math.max(0, y + oy)) * w;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i]) continue;
      const sx = x + ox, s = (srcRow + (sx < 0 ? 0 : sx >= w ? w - 1 : sx)) * 4, t = i * 4, o = i * 3;
      corr[o] = data[t] - data[s];
      corr[o + 1] = data[t + 1] - data[s + 1];
      corr[o + 2] = data[t + 2] - data[s + 2];
    }
  }
  const b = maskBounds(mask, w, h);
  if (!b) return corr;

  // Only the hole and its one-pixel boundary take part, so solve on that crop. A
  // crop edge is then either boundary data or the image edge (Neumann there).
  const cx0 = Math.max(0, b.x - 1), cy0 = Math.max(0, b.y - 1);
  const cw = Math.min(w - 1, b.x + b.w) - cx0 + 1, ch = Math.min(h - 1, b.y + b.h) - cy0 + 1;
  const field = new Float32Array(cw * ch * 3);
  const cropHole = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = (y + cy0) * w + x + cx0, k = y * cw + x;
      cropHole[k] = mask[i] ? 1 : 0;
      for (let c = 0; c < 3; c++) field[k * 3 + c] = corr[i * 3 + c];
    }
  }
  solveMembrane(field, cropHole, cw, ch, its);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const k = y * cw + x;
      if (!cropHole[k]) continue;
      const i = (y + cy0) * w + x + cx0;
      for (let c = 0; c < 3; c++) corr[i * 3 + c] = field[k * 3 + c];
    }
  }
  return corr;
}

// Laplace inside `hole` with the values already in `field` outside it as
// boundary data, in place. Starts from a half-resolution solve (recursively),
// which removes the slow low-frequency error SOR alone would take thousands of
// sweeps to shift; the full-resolution sweeps then only clean up detail.
function solveMembrane(field, hole, w, h, iters) {
  const idx = [];
  for (let i = 0; i < hole.length; i++) if (hole[i]) idx.push(i);
  if (!idx.length) return;
  if (idx.length > 64 && w >= 4 && h >= 4) {
    // Coarse cell is unknown only if all its children are; otherwise it holds the
    // mean of its known children, which keeps the boundary data at every level.
    const cw = (w + 1) >> 1, ch = (h + 1) >> 1;
    const cfield = new Float32Array(cw * ch * 3);
    const chole = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        let n = 0, r = 0, g = 0, b = 0;
        for (let sy = 2 * y; sy <= Math.min(h - 1, 2 * y + 1); sy++) {
          for (let sx = 2 * x; sx <= Math.min(w - 1, 2 * x + 1); sx++) {
            const i = sy * w + sx;
            if (hole[i]) continue;
            r += field[i * 3]; g += field[i * 3 + 1]; b += field[i * 3 + 2]; n++;
          }
        }
        const o = y * cw + x;
        if (n) { cfield[o * 3] = r / n; cfield[o * 3 + 1] = g / n; cfield[o * 3 + 2] = b / n; }
        else chole[o] = 1;
      }
    }
    solveMembrane(cfield, chole, cw, ch, iters);
    for (const p of idx) {
      const x = p % w, y = (p / w) | 0;
      const u = Math.min(cw - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
      const v = Math.min(ch - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const u0 = Math.floor(u), v0 = Math.floor(v);
      const u1 = Math.min(cw - 1, u0 + 1), v1 = Math.min(ch - 1, v0 + 1);
      const fu = u - u0, fv = v - v0;
      for (let c = 0; c < 3; c++) {
        const a = cfield[(v0 * cw + u0) * 3 + c], b = cfield[(v0 * cw + u1) * 3 + c];
        const d = cfield[(v1 * cw + u0) * 3 + c], e = cfield[(v1 * cw + u1) * 3 + c];
        field[p * 3 + c] = (a + (b - a) * fu) * (1 - fv) + (d + (e - d) * fu) * fv;
      }
    }
  } else {
    // Small enough to converge from a flat start: the mean boundary value.
    let n = 0;
    const sum = [0, 0, 0];
    for (let i = 0; i < hole.length; i++) {
      if (hole[i]) continue;
      const x = i % w, y = (i / w) | 0;
      const nearHole = (x > 0 && hole[i - 1]) || (x < w - 1 && hole[i + 1])
        || (y > 0 && hole[i - w]) || (y < h - 1 && hole[i + w]);
      if (!nearHole) continue;
      for (let c = 0; c < 3; c++) sum[c] += field[i * 3 + c];
      n++;
    }
    for (const p of idx) for (let c = 0; c < 3; c++) field[p * 3 + c] = n ? sum[c] / n : 0;
  }
  sor(field, idx, w, h, iters);
}

function sor(field, idx, w, h, iters) {
  const m = idx.length;
  const nb = new Int32Array(m * 4).fill(-1);
  const inv = new Float32Array(m);
  for (let k = 0; k < m; k++) {
    const p = idx[k], x = p % w, y = (p / w) | 0;
    let n = 0;
    // A neighbour off the image is simply absent: zero flux (Neumann) there.
    if (x > 0) nb[k * 4 + n++] = p - 1;
    if (x < w - 1) nb[k * 4 + n++] = p + 1;
    if (y > 0) nb[k * 4 + n++] = p - w;
    if (y < h - 1) nb[k * 4 + n++] = p + w;
    inv[k] = n ? 1 / n : 0;
  }
  for (let it = 0; it < iters; it++) {
    let maxDelta = 0;
    for (let k = 0; k < m; k++) {
      if (!inv[k]) continue;
      const p3 = idx[k] * 3, q0 = nb[k * 4], q1 = nb[k * 4 + 1], q2 = nb[k * 4 + 2], q3 = nb[k * 4 + 3];
      for (let c = 0; c < 3; c++) {
        let s = field[q0 * 3 + c]; // every hole pixel has at least one neighbour here
        if (q1 >= 0) s += field[q1 * 3 + c];
        if (q2 >= 0) s += field[q2 * 3 + c];
        if (q3 >= 0) s += field[q3 * 3 + c];
        const d = OMEGA * (s * inv[k] - field[p3 + c]);
        field[p3 + c] += d;
        if (d > maxDelta) maxDelta = d;
        else if (-d > maxDelta) maxDelta = -d;
      }
    }
    if (maxDelta < 1e-4) break; // converged far below one 8-bit step
  }
}

// ------------------------------------------------------------------ compose

// Reference composite (the GPU's FRAG_FILL does the same at full resolution).
// Hole pixels become copy(p + offset) + corr, blended in through a mask feathered
// `featherPx` inward; everything outside the hole is returned untouched. Hole
// pixels come out opaque. `corr` may be null for a plain clone.
export function composeRef(img, mask, dx, dy, corr, featherPx = 2) {
  const { width: w, height: h, data } = checkImage(img);
  checkMask(mask, w, h);
  if (corr != null && !(corr.length >= w * h * 3)) throw new RangeError('correction size mismatch');
  const ox = toOffset(dx), oy = toOffset(dy);
  const feather = Number.isFinite(featherPx) && featherPx > 0 ? featherPx : 0;
  const out = new Uint8ClampedArray(data);
  const b = maskBounds(mask, w, h);
  if (!b) return { width: w, height: h, data: out };
  const box = { x0: b.x, y0: b.y, x1: b.x + b.w - 1, y1: b.y + b.h - 1 };
  const inside = feather ? insideDistance(mask, w, h, box) : null;
  for (let y = box.y0; y <= box.y1; y++) {
    for (let x = box.x0; x <= box.x1; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      // Off-image neighbours don't count as outside, so a hole on the photo's
      // edge isn't faded there (nothing to fade towards).
      const a = inside ? Math.min(1, inside.dist[(y - inside.crop.y) * inside.crop.w + x - inside.crop.x] / feather) : 1;
      const s = sourceIndex(x + ox, y + oy, w, h) * 4;
      for (let c = 0; c < 3; c++) {
        const fill = data[s + c] + (corr ? corr[i * 3 + c] : 0);
        out[i * 4 + c] = data[i * 4 + c] + a * (fill - data[i * 4 + c]);
      }
      out[i * 4 + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

// ------------------------------------------------------------------ worker protocol

// The heal worker's whole job, as a pure function so it can be tested in node:
// message in, { message, transfer } out. Never throws; failures become
// { type: 'error', job, message } so the caller can settle its promise.
export function handleHealMessage(msg) {
  const job = msg && typeof msg === 'object' ? msg.job : undefined;
  try {
    if (!msg || typeof msg !== 'object') throw new TypeError('heal message must be an object');
    const img = toImage(msg.img);
    const mask = toMask(msg.mask);
    switch (msg.type) {
      case 'find': {
        const sources = findSources(img, mask, { maxResults: msg.maxResults ?? 4 });
        return { message: { type: 'found', job, sources }, transfer: [] };
      }
      case 'correct': {
        const dx = toOffset(msg.dx), dy = toOffset(msg.dy);
        const corr = solveCorrection(img, mask, dx, dy, msg.iters != null ? { iters: msg.iters } : {});
        const tile = composeRef(img, mask, dx, dy, corr, msg.featherPx ?? 2);
        return { message: { type: 'corrected', job, tile, dx, dy }, transfer: [tile.data.buffer] };
      }
      case 'inpaint': {
        if (mask.length !== img.width * img.height) throw new RangeError('mask size mismatch');
        // inpaintScaled floors the work size at one patch, so a zero, negative or
        // NaN scale would quietly fill from a 7x7 thumbnail instead of failing.
        const scale = msg.scale ?? 1;
        if (!(scale > 0) || !Number.isFinite(scale)) throw new RangeError(`bad scale ${scale}`);
        const opts = msg.seed != null ? { seed: msg.seed } : {};
        const tile = inpaintScaled(img, mask, scale, opts);
        return { message: { type: 'inpainted', job, tile }, transfer: tile.from ? [tile.data.buffer, tile.from.buffer] : [tile.data.buffer] };
      }
      default:
        throw new TypeError(`unknown heal message type ${msg.type}`);
    }
  } catch (err) {
    return { message: { type: 'error', job, message: String((err && err.message) || err) }, transfer: [] };
  }
}

// Structured clone may hand us bare ArrayBuffers if the sender transferred them.
function toImage(img) {
  if (!img || typeof img !== 'object') throw new TypeError('img must be { width, height, data }');
  const data = img.data instanceof ArrayBuffer ? new Uint8ClampedArray(img.data) : img.data;
  return checkImage({ width: img.width, height: img.height, data });
}

function toMask(mask) {
  if (mask instanceof ArrayBuffer) return new Uint8Array(mask);
  if (!ArrayBuffer.isView(mask)) throw new TypeError('mask must be a Uint8Array');
  return mask;
}

// ------------------------------------------------------------------ shared internals

function checkSize(w, h) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 0 || h < 0) throw new RangeError(`bad size ${w}x${h}`);
}

function checkImage(img) {
  if (!img || typeof img !== 'object') throw new TypeError('img must be { width, height, data }');
  const { width, height, data } = img;
  checkSize(width, height);
  if (!data || data.length !== width * height * 4) throw new RangeError('image data size mismatch');
  return img;
}

function checkMask(mask, w, h) {
  checkSize(w, h);
  if (!mask || mask.length !== w * h) throw new RangeError('mask size mismatch');
}

function toOffset(v) {
  if (!Number.isFinite(v)) throw new RangeError(`bad offset ${v}`);
  return Math.round(v);
}

// Copy source for a pixel. Offsets from findSources always land inside; a
// dragged Source ring can hang off the edge, and then the edge pixels repeat.
function sourceIndex(x, y, w, h) {
  return Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x));
}

// RGB of the crop { x, y, w, h } as floats.
function toRgb(img, crop) {
  const d = img.data;
  const rgb = new Float32Array(crop.w * crop.h * 3);
  for (let y = 0; y < crop.h; y++) {
    let s = ((y + crop.y) * img.width + crop.x) * 4, o = y * crop.w * 3;
    for (let x = 0; x < crop.w; x++, s += 4, o += 3) {
      rgb[o] = d[s];
      rgb[o + 1] = d[s + 1];
      rgb[o + 2] = d[s + 2];
    }
  }
  return rgb;
}

// Two-pass chamfer distance (steps 1 and √2, within 8% of Euclidean) from every
// pixel to the nearest seed. Infinity everywhere when there are no seeds. Off
// the image counts as "not a seed", so a hole touching the edge isn't treated
// as thin there.
function chamfer(seed, w, h) {
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = seed[i] ? 0 : Infinity;
  const D = Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0 && d[i - 1] + 1 < v) v = d[i - 1] + 1;
      if (y > 0) {
        if (d[i - w] + 1 < v) v = d[i - w] + 1;
        if (x > 0 && d[i - w - 1] + D < v) v = d[i - w - 1] + D;
        if (x < w - 1 && d[i - w + 1] + D < v) v = d[i - w + 1] + D;
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < w - 1 && d[i + 1] + 1 < v) v = d[i + 1] + 1;
      if (y < h - 1) {
        if (d[i + w] + 1 < v) v = d[i + w] + 1;
        if (x < w - 1 && d[i + w + 1] + D < v) v = d[i + w + 1] + D;
        if (x > 0 && d[i + w - 1] + D < v) v = d[i + w - 1] + D;
      }
      d[i] = v;
    }
  }
  return d;
}

// Marks pixels whose centre is within r of segment a-b (a disc when a = b), plus
// the pixels holding the end points so a sub-pixel brush still marks something.
function stampCapsule(mask, w, h, ax, ay, bx, by, r) {
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r - 0.5));
  const x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + r - 0.5));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r - 0.5));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + r - 0.5));
  const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy, r2 = r * r;
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5;
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      let t = len2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = px - ax - t * vx, ey = py - ay - t * vy;
      if (ex * ex + ey * ey <= r2) mask[y * w + x] = 1;
    }
  }
  for (const [px, py] of [[ax, ay], [bx, by]]) {
    const x = Math.floor(px), y = Math.floor(py);
    if (x >= 0 && y >= 0 && x < w && y < h) mask[y * w + x] = 1;
  }
}
