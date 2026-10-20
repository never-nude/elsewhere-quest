// Level: find how far the photo is tilted, from its own edges. Pure, no DOM.
//
// The idea (SPEC §7 Level): a tilted photo's strong straight edges — a horizon, a
// shoreline, door frames, building corners — all lean by the same small angle, while
// texture (grass, leaves, noise) points every which way. So vote: every strong edge
// pixel casts its local line angle, weighted by how strong it is, into a fine
// histogram; near-horizontal and near-vertical edges vote for the same rotation. A
// clear, narrow peak is the tilt; a flat histogram means "no clear horizon".
//
// Sign convention (lib/geometry.js): a positive straighten angle turns the image
// clockwise on screen (y down). `angleDeg` is the CORRECTION — the angle to hand to
// geometry's setAngle — so a horizon that rises to the right comes back positive,
// and one that falls to the right comes back negative. It is relative to the image
// passed in: for the un-straightened photo it is the absolute angle; for an image
// that already has the crop's angle applied, add it to crop.angle. A quarter turn
// leaves it unchanged (horizontal and vertical edges vote together); a mirror
// negates it.
//
// Feed it a filtered downscale (mipmapped or area-averaged, as the renderer's
// readback is), not a nearest-neighbour one: an aliased edge is a staircase of
// level runs, and every run votes "level".

const DEG = 180 / Math.PI;
const BIN = 0.1; // degrees per histogram bin
const SIGMA_BINS = 0.3 / BIN; // histogram smoothing, σ = 0.3°
// Votes are also collected a little past ±maxDeg, so a tilt near the limit sees
// both sides of its peak and a steeper family just outside can't pose as a peak
// on the rim.
const MARGIN_DEG = 2;
const TOP_FRACTION = 0.1; // keep the strongest 10% of gradients
// Below this (luma per pixel, after the pre-blur) a gradient is sensor noise or
// JPEG mush in a flat sky, not an edge. About an 8/255 step.
const MIN_MAG = 0.01;
const MIN_PROMINENCE = 2.5; // peak vs the median bin
const MIN_SHARE = 0.03; // peak window vs all strong-edge weight
const WINDOW_BINS = 5; // the peak "holds" the weight within ±0.5°
const POLISH_SIGMA = 1; // degrees, the mean-shift kernel
const POLISH_MAX_MOVE = 1; // degrees; past this the polish has wandered off
const BASIN = 0.5; // the polish keeps to bins at least this share of the peak's height
const BORDER = 2; // pixels skipped at the frame edge (pre-blur + gradient support)

export const NO_TILT = Object.freeze({ angleDeg: 0, confidence: 0, kind: 'none' });

// Luma (Rec. 709 weights on the sRGB-encoded values, 0..1) of an RGBA buffer.
// Alpha is ignored: the analysis readback is opaque.
export function toGray(rgba, w, h) {
  const n = validSize(w, h) ? w * h : 0;
  const out = new Float32Array(n);
  const m = Math.min(n, Math.floor((rgba?.length ?? 0) / 4));
  for (let i = 0; i < m; i++) {
    const j = i * 4;
    out[i] = (0.2126 * rgba[j] + 0.7152 * rgba[j + 1] + 0.0722 * rgba[j + 2]) / 255;
  }
  return out;
}

export function detectTilt(gray, w, h, opts = {}) {
  // Read the option by hand rather than destructuring, so `null` options don't throw.
  const maxDeg = opts?.maxDeg ?? 12;
  if (!validSize(w, h) || w < 2 * BORDER + 3 || h < 2 * BORDER + 3) return NO_TILT;
  if (!gray || !(gray.length >= w * h)) return NO_TILT;
  // Past ±45° the horizontal and vertical families would overlap.
  const range = Number.isFinite(maxDeg) && maxDeg > 0 ? Math.min(40, Math.max(1, maxDeg)) : 12;
  const reach = range + MARGIN_DEG;

  const img = blur(gray, w, h);

  // 3x3 gradient with Scharr's weights (3, 10, 3) rather than Sobel's (1, 2, 1):
  // same operator, but its direction is nearly unbiased, where Sobel reads a
  // crisp 7° edge as 6.1–6.7° and would under-straighten every photo.
  // Normalised to a per-pixel derivative.
  const n = w * h;
  const gx = new Float32Array(n), gy = new Float32Array(n), mag = new Float32Array(n);
  const interior = new Float32Array((w - 2 * BORDER) * (h - 2 * BORDER));
  let count = 0;
  for (let y = BORDER; y < h - BORDER; y++) {
    for (let x = BORDER; x < w - BORDER; x++) {
      const i = y * w + x;
      const a = img[i - w - 1], b = img[i - w], c = img[i - w + 1];
      const d = img[i - 1], f = img[i + 1];
      const g = img[i + w - 1], k = img[i + w], l = img[i + w + 1];
      const sx = (3 * (c + l - a - g) + 10 * (f - d)) / 32;
      const sy = (3 * (g + l - a - c) + 10 * (k - b)) / 32;
      gx[i] = sx; gy[i] = sy;
      mag[i] = interior[count++] = Math.hypot(sx, sy);
    }
  }

  // Keep the strongest 10% of the interior.
  interior.sort();
  const threshold = Math.max(MIN_MAG, interior[Math.min(count - 1, Math.floor(count * (1 - TOP_FRACTION)))]);

  // Vote. Two histograms (horizontal and vertical families) so we can say which
  // one the peak came from; the peak itself is found on their sum.
  const half = Math.round(reach / BIN);
  const inner = Math.round(range / BIN);
  const bins = 2 * half + 1;
  const histH = new Float64Array(bins), histV = new Float64Array(bins);
  const voteTilt = new Float32Array(count), voteWeight = new Float32Array(count);
  let votes = 0, total = 0;
  for (let y = BORDER; y < h - BORDER; y++) {
    for (let x = BORDER; x < w - BORDER; x++) {
      const i = y * w + x;
      const wgt = mag[i];
      if (!(wgt >= threshold)) continue; // also drops NaN
      total += wgt;
      // The edge runs perpendicular to the gradient. Wrap its angle to (-90, 90]:
      // 0 is horizontal, positive leans clockwise (falls to the right, y down).
      let line = Math.atan2(gy[i], gx[i]) * DEG + 90;
      line -= 180 * Math.round(line / 180);
      if (line <= -90) line += 180;
      let tilt, hist;
      if (Math.abs(line) <= reach) { tilt = line; hist = histH; } else {
        // A vertical edge leaning by t has line angle 90 + t (or -90 + t).
        tilt = line > 0 ? line - 90 : line + 90;
        if (Math.abs(tilt) > reach) continue;
        hist = histV;
      }
      voteTilt[votes] = tilt; voteWeight[votes] = wgt; votes++;
      // Soft binning keeps sub-bin precision for the parabolic refinement.
      const pos = tilt / BIN + half;
      const i0 = Math.floor(pos), frac = pos - i0;
      if (i0 >= 0 && i0 < bins) hist[i0] += wgt * (1 - frac);
      if (i0 + 1 < bins) hist[i0 + 1] += wgt * frac;
    }
  }
  if (!(total > 0) || !Number.isFinite(total) || votes === 0) return NO_TILT;

  const raw = new Float64Array(bins);
  for (let i = 0; i < bins; i++) raw[i] = histH[i] + histV[i];
  const smooth = gaussian1d(raw, SIGMA_BINS);

  // The highest local maximum within ±maxDeg. Requiring a true local maximum
  // (not just the highest bin) keeps the shoulder of a family outside the range
  // from passing as a peak on its rim.
  let peak = -1;
  for (let i = half - inner; i <= half + inner; i++) {
    if (smooth[i] > smooth[i - 1] && smooth[i] >= smooth[i + 1] && (peak < 0 || smooth[i] > smooth[peak])) peak = i;
  }
  if (peak < 0 || !(smooth[peak] > 0)) return NO_TILT;

  const within = Float64Array.from(smooth.subarray(half - inner, half + inner + 1)).sort();
  const median = within[(within.length - 1) / 2]; // 2*inner+1 bins: odd
  let inH = 0, inV = 0;
  for (let i = peak - WINDOW_BINS; i <= peak + WINDOW_BINS; i++) { inH += histH[i]; inV += histV[i]; }
  const share = (inH + inV) / total;
  const prominence = median > 0 ? smooth[peak] / median : Infinity;
  if (!(prominence >= MIN_PROMINENCE) || !(share >= MIN_SHARE)) return NO_TILT; // NaN-safe

  // Parabolic refinement through the peak and its neighbours...
  const y0 = smooth[peak - 1], y1 = smooth[peak], y2 = smooth[peak + 1];
  const den = y0 - 2 * y1 + y2;
  const offset = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0;
  const coarse = (peak - half + offset) * BIN;
  // ...then a mean-shift polish on the votes themselves. Texture riding on a
  // horizon jitters each pixel's angle by a degree or two; the mode of a 0.3°
  // histogram wanders with that jitter, the local weighted mean doesn't.
  // Only the peak's own votes take part: those inside its half-maximum basin.
  // A 1° kernel would otherwise reach across a valley into a second family of
  // lines 1–2° away (a shoreline under a horizon, a fence) and pull the answer
  // half a degree toward it.
  let lo = peak, hi = peak;
  const floor = BASIN * smooth[peak];
  while (lo > 0 && smooth[lo - 1] >= floor) lo--;
  while (hi < bins - 1 && smooth[hi + 1] >= floor) hi++;
  const fine = polish(voteTilt, voteWeight, votes, coarse, (lo - half - 0.5) * BIN, (hi - half + 0.5) * BIN);
  const tilt = Math.abs(fine - coarse) <= POLISH_MAX_MOVE ? fine : coarse;

  // Confidence: 0.2 at the acceptance bar, rising to 1 for a peak that holds a
  // fifth of all edge weight and stands 10x above the floor.
  const a = clamp01((share - MIN_SHARE) / (0.2 - MIN_SHARE));
  const b = clamp01((prominence - MIN_PROMINENCE) / (10 - MIN_PROMINENCE));
  return {
    angleDeg: -Math.max(-range, Math.min(range, tilt)) + 0, // + 0 turns -0 into 0
    confidence: 0.2 + 0.8 * Math.sqrt(a * b),
    kind: inH >= inV ? 'horizon' : 'verticals',
  };
}

// ------------------------------------------------------------------ helpers

function validSize(w, h) {
  return Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0;
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// A light 5-tap binomial blur (σ ≈ 1 px) before the gradient, so an edge's local
// angle is steady from pixel to pixel instead of jittering with its sub-pixel
// phase. Edges clamp. Non-finite input reads as 0.
function blur(src, w, h) {
  const k = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let t = -2; t <= 2; t++) {
        const xx = x + t < 0 ? 0 : x + t >= w ? w - 1 : x + t;
        const v = src[row + xx];
        s += k[t + 2] * (Number.isFinite(v) ? v : 0);
      }
      tmp[row + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let t = -2; t <= 2; t++) {
        const yy = y + t < 0 ? 0 : y + t >= h ? h - 1 : y + t;
        s += k[t + 2] * tmp[yy * w + x];
      }
      out[y * w + x] = s;
    }
  }
  return out;
}

// Gaussian smoothing of a histogram, zero outside it (the angle axis is not
// periodic over this range).
function gaussian1d(src, sigma) {
  const r = Math.ceil(3 * sigma);
  const k = [];
  let sum = 0;
  for (let t = -r; t <= r; t++) { const v = Math.exp(-(t * t) / (2 * sigma * sigma)); k.push(v); sum += v; }
  const out = new Float64Array(src.length);
  for (let i = 0; i < src.length; i++) {
    let s = 0;
    for (let t = -r; t <= r; t++) {
      const j = i + t;
      if (j >= 0 && j < src.length) s += src[j] * k[t + r];
    }
    out[i] = s / sum;
  }
  return out;
}

// Mean shift with a Gaussian kernel: move to the weighted mean of nearby votes
// until it settles on the local mode. Votes outside [lo, hi] are ignored, so the
// answer stays inside that range.
function polish(tilts, weights, n, start, lo, hi) {
  let t = start;
  const inv = 1 / (2 * POLISH_SIGMA * POLISH_SIGMA);
  const cut = 3 * POLISH_SIGMA;
  for (let iter = 0; iter < 30; iter++) {
    let sw = 0, st = 0;
    for (let i = 0; i < n; i++) {
      if (tilts[i] < lo || tilts[i] > hi) continue;
      const d = tilts[i] - t;
      if (d > cut || d < -cut) continue;
      const k = weights[i] * Math.exp(-d * d * inv);
      sw += k; st += k * tilts[i];
    }
    if (!(sw > 0)) return start;
    const next = st / sw;
    if (Math.abs(next - t) < 1e-4) return next;
    t = next;
  }
  return t;
}
