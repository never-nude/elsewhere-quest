// Auto: read a small copy of the photo and choose dial values, the way a careful
// person would. It only ever moves the dials the user can see — Light's
// Brightness, Contrast, Highlights, Shadows and Color's Warmth, Tint, Vividness —
// and reports them as a short list ("Shadows +24") so the user can see, and learn,
// what it did.
//
// The corrections are gentle on purpose: a dusk shot is meant to be dusky and a
// golden-hour shot golden, so Auto moves the photo part of the way toward "normal"
// and never all of it.
//
// Input to analyze() is a downscaled RGBA image (a few hundred px is plenty) read
// back WITHOUT any tone edits, so every dial value here is absolute: the value the
// dial should hold, not a nudge from where it is. Pure, no DOM.
//
// Docs are the DocState shape from lib/doc.js (doc.light, doc.color); this module
// reads and writes those fields directly and never imports doc.js.

import { srgbToLinear, luma, uniforms, resolve, defaultAdjust } from './develop.js';

const MAX_CHANGES = 5;
const MIN_DELTA = 3; // smaller moves aren't worth a chip, so they aren't made
const MINUS = '−'; // U+2212, the chip's minus sign

export const LIGHT_DIALS = Object.freeze(['brightness', 'contrast', 'highlights', 'shadows']);
export const COLOR_DIALS = Object.freeze(['warmth', 'tint', 'vividness']);
const AUTO_DIALS = [...LIGHT_DIALS, ...COLOR_DIALS];
const LABELS = {
  brightness: 'Brightness', contrast: 'Contrast', highlights: 'Highlights', shadows: 'Shadows',
  warmth: 'Warmth', tint: 'Tint', vividness: 'Vividness',
};

// sRGB byte -> linear, once.
const LINEAR = Float64Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255));
const HIST_BINS = 1024;

// ------------------------------------------------------------------ analysis

// Stats for Auto and the home suggestion. Accepts an image { width, height, data }
// or (rgba, w, h). Pixels with alpha < 128 are skipped. Returns null when there is
// nothing to measure.
//   p01..p99    luma percentiles (sRGB-encoded luma, 0..1)
//   mean        mean luma
//   dark        share of pixels with luma < 0.15
//   clipLow     share with luma <= 0.02 (crushed)
//   clipHigh    share with luma >= 0.98 (blown)
//   meanSat     mean HSV saturation over pixels that aren't near-black (whose
//               "colour" is noise)
//   neutral     mean LINEAR rgb of near-neutral midtones, or null — the grey-world
//               reference: a red barn shouldn't read as a cast
//   neutralShare  share of pixels that went into `neutral`
//   n           pixels measured
export function analyze(image, w, h) {
  const bare = ArrayBuffer.isView(image) || Array.isArray(image);
  const img = bare ? { data: image, width: w, height: h } : image;
  if (!img || !img.data) return null;
  const { width, height, data } = img;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  const total = Math.min(width * height, Math.floor(data.length / 4));

  const hist = new Uint32Array(HIST_BINS);
  let n = 0, sumY = 0, dark = 0, clipLow = 0, clipHigh = 0;
  let satSum = 0, satN = 0;
  let nr = 0, ng = 0, nb = 0, neutral = 0;
  for (let i = 0; i < total; i++) {
    const j = i * 4;
    if (!(data[j + 3] >= 128)) continue;
    const R = clampByte(data[j]), G = clampByte(data[j + 1]), B = clampByte(data[j + 2]);
    const r = R / 255, g = G / 255, b = B / 255;
    const y = luma(r, g, b);
    hist[Math.min(HIST_BINS - 1, Math.floor(y * HIST_BINS))]++;
    n++;
    sumY += y;
    if (y < 0.15) dark++;
    if (y <= 0.02) clipLow++;
    if (y >= 0.98) clipHigh++;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx >= 0.08) { satSum += (mx - mn) / mx; satN++; }
    // Near-neutral: low saturation in the midtones. Saturation rather than raw
    // chroma, so a dim brown counts as a colour, not as a grey under a warm cast.
    if (y > 0.15 && y < 0.85 && mx - mn < 0.3 * mx) {
      nr += LINEAR[R]; ng += LINEAR[G]; nb += LINEAR[B]; neutral++;
    }
  }
  if (n === 0) return null;

  const pct = (q) => {
    const target = q * n;
    let acc = 0;
    for (let i = 0; i < HIST_BINS; i++) {
      acc += hist[i];
      if (acc >= target) return (i + 0.5) / HIST_BINS;
    }
    return 1;
  };
  return {
    n,
    mean: sumY / n,
    p01: pct(0.01), p05: pct(0.05), p50: pct(0.5), p95: pct(0.95), p99: pct(0.99),
    dark: dark / n,
    clipLow: clipLow / n,
    clipHigh: clipHigh / n,
    meanSat: satN ? satSum / satN : 0,
    neutralShare: neutral / n,
    neutral: neutral ? [nr / neutral, ng / neutral, nb / neutral] : null,
  };
}

// ------------------------------------------------------------------ Light

// develop.js's brightness is a midtone gamma, p^(2^(-k*B/100)). Read k from
// develop itself so Auto stays in lockstep with the renderer.
const BRIGHTNESS_STOPS = -Math.log2(uniforms(resolve({ ...defaultAdjust(), brightness: 100 })).gamma);

export function autoLight(stats) {
  const out = { brightness: 0, contrast: 0, highlights: 0, shadows: 0 };
  if (!validStats(stats)) return out;
  const s = stats;

  // Brightness: carry the median part of the way toward the comfortable middle.
  // Dark photos travel 75% of the way to 0.44, bright ones half of the way down to
  // 0.58, and in between nothing moves. Capped: a dusk shot is lifted, not flattened.
  const m = s.p50;
  let target = m;
  if (m < 0.44) target = m + 0.75 * (0.44 - m);
  else if (m > 0.58) target = m - 0.5 * (m - 0.58);
  let brightness = 0;
  if (target !== m && m > 0.004 && m < 0.996) {
    const g = Math.log(target) / Math.log(m); // m^g = target
    brightness = (-Math.log2(g) / BRIGHTNESS_STOPS) * 100;
  }
  out.brightness = clampInt(brightness, -35, 50);

  // Contrast: stretch a flat, foggy histogram; never flatten a punchy one. Judge
  // the range as it will be after the brightness move, and hold back on a photo
  // that stays dark: contrast pivots at mid-grey, so it would push a low-key
  // photo's shadows back down.
  const gamma = Math.pow(2, (-BRIGHTNESS_STOPS * out.brightness) / 100);
  const range = Math.pow(s.p95, gamma) - Math.pow(s.p05, gamma);
  const lowKey = clamp01(1 - 4 * Math.max(0, 0.4 - Math.pow(m, gamma)));
  out.contrast = clampInt((0.7 - range) * 110, 0, 40 * lowKey);

  // Shadows: open them up when a lot of the frame is buried or crushed — a little
  // less when brightness is already lifting everything. Each rule fades in over a
  // narrow band rather than switching on: a hard "dark over 0.12 and p05 under
  // 0.08" gate made p05 0.0799 vs 0.0801 the difference between Shadows +30 and 0,
  // and the 256px suggestion readback and 512px Auto readback can land either side.
  const buried = (s.dark - 0.08) * 160 * ramp(s.dark, 0.1, 0.12) * ramp(s.p05, 0.09, 0.07);
  const crushed = s.clipLow * 1500 * ramp(s.clipLow, 0.01, 0.015); // over 1% crushed (SPEC §7)
  const lift = Math.max(buried, crushed) * (1 - 0.3 * Math.max(0, out.brightness) / 50);
  out.shadows = clampInt(lift, 0, 45);

  // Highlights: pull back when the sky (or anything) is clipping: over 0.5% blown
  // (SPEC §7), fully by 0.75%.
  out.highlights = clampInt(-(8 + s.clipHigh * 600) * ramp(s.clipHigh, 0.005, 0.0075), -40, 0);

  return snapSmall(out);
}

// ------------------------------------------------------------------ Color

export function autoColor(stats) {
  const out = { warmth: 0, tint: 0, vividness: 0 };
  if (!validStats(stats)) return out;
  const s = stats;

  // White balance from the near-neutral midtones (grey world), trusted only as far
  // as there are enough of them. Corrected only part of the way, and cooling less
  // than warming: a blue shade cast is almost always unwanted, warm light usually
  // is the point (golden hour stays golden). Warm light is also yellower than
  // develop's warmth axis, so its "green" is not corrected as hard; and in a dark
  // photo the cast is mostly mood (blue hour, candlelight), so it is halved. Each
  // of these fades in over a short span instead of switching, so two nearly equal
  // photos never get visibly different answers (a hard p50 < 0.3 gate made it
  // Warmth +18 vs +30).
  if (s.neutral && s.neutralShare >= 0.05) {
    const need = solveWhite(s.neutral);
    if (need) {
      const trust = clamp01((s.neutralShare - 0.05) / 0.15) * (0.5 + 0.5 * ramp(s.p50, 0.25, 0.35));
      const w = shrink(need.warmth, 5);
      const t = shrink(need.tint, 5);
      out.warmth = clampInt(w * (w > 0 ? 0.5 : 0.3) * trust, -20, 30);
      out.tint = clampInt(t * (t > 0 ? 0.4 - 0.2 * ramp(w, 0, -5) : 0.4) * trust, -15, 15);
    }
  }

  // A little life for muted photos. Not for black-and-white ones: there is no
  // colour to bring out, and a chip that changes nothing teaches the wrong thing.
  // Faded in from meanSat 0.03 (and out toward 0.4): a hard cut-off gave the
  // most muted colour photo — or a black-and-white one with a little chroma
  // noise — the full +24 right next to a 0.
  const vivid = (6 + (0.4 - s.meanSat) * 60) * ramp(s.meanSat, 0.03, 0.08) * ramp(s.meanSat, 0.42, 0.38);
  out.vividness = clampInt(vivid, 0, 24);

  return snapSmall(out);
}

// Pick white: the Warmth and Tint that make this sample (mean LINEAR rgb of the
// pressed spot, before any tone) come out neutral. Clamped to the dials' ±100, so
// an extreme sample gets as close as the dials allow.
export function whiteFromSample(rgbLinear) {
  const need = solveWhite(rgbLinear);
  if (!need) return { warmth: 0, tint: 0 };
  return { warmth: clampInt(need.warmth, -100, 100), tint: clampInt(need.tint, -100, 100) };
}

// The (unclamped, fractional) warmth and tint whose white-balance gains turn
// `rgb` neutral, or null if the sample is unusable.
//
// develop.js's gains are luminance-normalised exponentials of warmth and tint, so
// the two balance conditions — gr*r = gb*b and gg*g = sqrt(gr*r * gb*b) — are
// linear in (warmth, tint) once logged, and the normalisation cancels out of
// both. Rather than copying develop's constants, probe uniforms() for that linear
// map and invert it; a few Newton steps keep it exact even if develop's gains ever
// stop being exactly log-linear.
function solveWhite(rgb) {
  if (!rgb || rgb.length < 3) return null;
  let [r, g, b] = [Number(rgb[0]), Number(rgb[1]), Number(rgb[2])];
  if (![r, g, b].every(Number.isFinite)) return null;
  const mx = Math.max(r, g, b);
  if (!(mx > 1e-6)) return null; // black carries no colour
  // A zero channel would ask for infinite gain; floor it so the answer just hits
  // the dial's end stop.
  const floor = mx * 1e-4;
  r = Math.max(r, floor); g = Math.max(g, floor); b = Math.max(b, floor);
  const target = [Math.log(b / r), 0.5 * (Math.log(r) + Math.log(b)) - Math.log(g)];

  let w = 0, t = 0;
  for (let iter = 0; iter < 8; iter++) {
    const f = balance(w, t);
    const e0 = f[0] - target[0], e1 = f[1] - target[1];
    if (Math.abs(e0) < 1e-10 && Math.abs(e1) < 1e-10) break;
    // Jacobian by central differences (1 dial unit).
    const fw1 = balance(w + 1, t), fw0 = balance(w - 1, t);
    const ft1 = balance(w, t + 1), ft0 = balance(w, t - 1);
    const a = (fw1[0] - fw0[0]) / 2, c = (fw1[1] - fw0[1]) / 2;
    const bb = (ft1[0] - ft0[0]) / 2, d = (ft1[1] - ft0[1]) / 2;
    const det = a * d - bb * c;
    if (!(Math.abs(det) > 1e-12)) return null;
    w -= (d * e0 - bb * e1) / det;
    t -= (a * e1 - c * e0) / det;
    // Far past the dials' range the answer is "as far as it goes" anyway.
    w = Math.max(-1000, Math.min(1000, w));
    t = Math.max(-1000, Math.min(1000, t));
  }
  if (!Number.isFinite(w) || !Number.isFinite(t)) return null;
  return { warmth: w, tint: t };
}

// The two log-balance terms of develop's white-balance gains at (warmth, tint),
// in dial units: [ln(gr/gb), ln gg - (ln gr + ln gb)/2].
function balance(warmth, tint) {
  const [gr, gg, gb] = uniforms(resolve({ ...defaultAdjust(), warmth, tint })).wb;
  return [Math.log(gr / gb), Math.log(gg) - 0.5 * (Math.log(gr) + Math.log(gb))];
}

// ------------------------------------------------------------------ Auto-enhance

// Light Auto and Color Auto as one step. Returns the next doc (light and color
// replaced; look, strength and everything else untouched) and the change chips:
// dials that moved by at least 3, largest move first, at most five. Only what the
// chips list is applied, so the chips are the whole story. With nothing to change
// it returns the same doc object.
//
// Auto's recipe is its five strongest opinions; a sixth or seventh is left out
// (that dial keeps whatever it holds) rather than made, so from an unedited photo
// a second press finds nothing more to do. A dial Auto wants at 0 is still an
// opinion: like Light's Auto, it puts a stray value back.
export function autoEnhance(stats, doc) {
  if (!validStats(stats) || !doc) return { next: doc, changes: [] };
  const want = { ...autoLight(stats), ...autoColor(stats) };
  const byStrength = (a, b) => Math.abs(want[b]) - Math.abs(want[a]) || AUTO_DIALS.indexOf(a) - AUTO_DIALS.indexOf(b);
  const strongest = AUTO_DIALS.filter((k) => want[k] !== 0).sort(byStrength).slice(0, MAX_CHANGES);
  const recipe = AUTO_DIALS.filter((k) => want[k] === 0 || strongest.includes(k));

  const light = doc.light ?? {}, color = doc.color ?? {};
  const prevOf = (k) => {
    const v = LIGHT_DIALS.includes(k) ? light[k] : color[k];
    return Number.isFinite(v) ? v : 0;
  };
  const changes = recipe
    .map((dial) => ({ dial, value: want[dial], delta: want[dial] - prevOf(dial) }))
    .filter((c) => Math.abs(c.delta) >= MIN_DELTA)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || AUTO_DIALS.indexOf(a.dial) - AUTO_DIALS.indexOf(b.dial))
    .slice(0, MAX_CHANGES)
    .map(({ dial, value, delta }) => ({ dial, label: formatChange(LABELS[dial], value), value, delta }));
  if (changes.length === 0) return { next: doc, changes };

  const nextLight = { ...light }, nextColor = { ...color };
  for (const c of changes) {
    if (LIGHT_DIALS.includes(c.dial)) nextLight[c.dial] = c.value;
    else nextColor[c.dial] = c.value;
  }
  return { next: { ...doc, light: nextLight, color: nextColor }, changes };
}

// "Shadows +24", "Warmth −6" — the chip text, with a true minus sign.
export function formatChange(label, value) {
  return `${label} ${value > 0 ? '+' : value < 0 ? MINUS : ''}${Math.abs(value)}`;
}

// ------------------------------------------------------------------ suggestion

// The one line on the home panel, read from the photo, or null when there is
// nothing worth saying. A clear tilt comes first (it is the thing people miss);
// otherwise a nudge toward Auto-enhance when it would make a real difference.
// `stats` should describe the photo as it currently looks. Pass `doc` to stay
// quiet about light once the user has set any Light dial themselves.
export function suggestion(stats, tilt, doc = null) {
  if (tilt && tilt.confidence > 0 && Number.isFinite(tilt.angleDeg) && Math.abs(tilt.angleDeg) >= 0.5) {
    return { text: `Looks tilted ${Math.abs(tilt.angleDeg).toFixed(1)}° — Straighten it`, action: 'straighten' };
  }
  if (!validStats(stats)) return null;
  if (doc?.light && LIGHT_DIALS.some((k) => Number.isFinite(doc.light[k]) && doc.light[k] !== 0)) return null;
  const L = autoLight(stats);
  if (stats.p50 < 0.33 && L.brightness >= 10) return { text: 'A bit dark — try Auto-enhance', action: 'enhance' };
  if (stats.p50 > 0.72 && L.brightness <= -10) return { text: 'A bit bright — try Auto-enhance', action: 'enhance' };
  if (stats.p95 - stats.p05 < 0.4 && L.contrast >= 10) return { text: 'Looks flat — try Auto-enhance', action: 'enhance' };
  return null;
}

// ------------------------------------------------------------------ helpers

function validStats(s) {
  return !!s && typeof s === 'object' &&
    ['p05', 'p50', 'p95', 'dark', 'clipLow', 'clipHigh', 'meanSat', 'neutralShare'].every((k) => Number.isFinite(s[k]));
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
// 0 at a, 1 at b, linear between (a > b ramps down). For fading a rule in.
const ramp = (x, a, b) => clamp01((x - a) / (b - a));
const clampByte = (v) => (v >= 255 ? 255 : v > 0 ? Math.round(v) : 0);

// Round to a whole dial value inside [lo, hi]; NaN becomes 0. `+ 0` turns -0 into 0.
function clampInt(v, lo, hi) {
  if (!Number.isFinite(v)) return 0;
  return Math.round(Math.max(lo, Math.min(hi, v))) + 0;
}

// Soft dead zone: the first `by` units count for nothing, and the rest carries on
// from zero, so there is no jump at the threshold.
function shrink(v, by) {
  return Math.sign(v) * Math.max(0, Math.abs(v) - by);
}

// A dial move under 3 is invisible; report it as no move at all.
function snapSmall(o) {
  for (const k of Object.keys(o)) if (Math.abs(o[k]) < MIN_DELTA) o[k] = 0;
  return o;
}
