// Auto: read a small copy of the photo and choose slider values, the way a
// careful person would. It only ever moves the visible dials, and returns them as
// a short list ("Shadows +24") so the user can see — and learn — what it did.
//
// Input is a downscaled RGBA image (a few hundred px is plenty). Pure, no DOM.

import { srgbToLinear, luma, clampParam } from './develop.js';

const MAX_CHANGES = 5;

export function analyze(image) {
  const { width, height, data } = image;
  const hist = new Uint32Array(256);
  let n = 0;
  let satSum = 0;
  // Grey-world over near-neutral midtones only: a red barn shouldn't read as a cast.
  let nr = 0, ng = 0, nb = 0, neutral = 0;
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4] / 255, g = data[i * 4 + 1] / 255, b = data[i * 4 + 2] / 255;
    if (data[i * 4 + 3] < 128) continue;
    const y = luma(r, g, b);
    hist[Math.min(255, Math.round(y * 255))]++;
    n++;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx > 0 ? (mx - mn) / mx : 0;
    satSum += sat;
    if (y > 0.15 && y < 0.85 && sat < 0.3) {
      nr += srgbToLinear(r); ng += srgbToLinear(g); nb += srgbToLinear(b); neutral++;
    }
  }
  if (n === 0) return null;
  const pct = (q) => {
    const target = q * n;
    let acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i / 255; }
    return 1;
  };
  const frac = (lo, hi) => {
    let c = 0;
    for (let i = Math.round(lo * 255); i <= Math.round(hi * 255); i++) c += hist[i];
    return c / n;
  };
  return {
    p01: pct(0.01), p05: pct(0.05), p50: pct(0.5), p95: pct(0.95), p99: pct(0.99),
    dark: frac(0, 0.15), clipped: frac(0.98, 1),
    meanSat: satSum / n,
    neutralShare: neutral / n,
    neutral: neutral ? [nr / neutral, ng / neutral, nb / neutral] : null,
  };
}

export function autoAdjust(image) {
  const a = analyze(image);
  if (!a) return { params: {}, changes: [] };
  const p = {};

  // Brightness: a midtone gamma that carries the median toward ~0.46.
  if (a.p50 > 0.02 && a.p50 < 0.98 && (a.p50 < 0.38 || a.p50 > 0.6)) {
    const g = Math.log(0.46) / Math.log(a.p50);
    // Capped: a dusk shot is meant to be dusky; Auto should lift it, not flatten it.
    p.brightness = Math.max(-40, Math.min(50, (-Math.log2(g) / 0.85) * 100 * 0.7));
  }

  // Shadows: open them up when a lot of the frame is buried.
  if (a.dark > 0.12 && a.p05 < 0.08) p.shadows = Math.min(45, (a.dark - 0.08) * 160);

  // Highlights: pull back when the sky (or anything) is clipping.
  if (a.clipped > 0.015) p.highlights = -Math.min(50, 10 + a.clipped * 400);

  // Contrast and end points: stretch a flat, foggy histogram.
  const range = a.p95 - a.p05;
  if (range < 0.62) p.contrast = Math.min(35, (0.72 - range) * 110);
  if (a.p01 > 0.06) p.blacks = Math.min(40, (a.p01 / 0.12) * 100 * 0.5);
  if (a.p99 < 0.88 && a.clipped < 0.005) p.whites = Math.min(40, ((0.97 - a.p99) / 0.12) * 100 * 0.5);

  // White balance from neutral midtones, corrected less than halfway so the
  // light's mood (golden hour stays golden) survives.
  if (a.neutral && a.neutralShare > 0.05) {
    const [r, g, b] = a.neutral;
    if (r > 1e-4 && b > 1e-4 && g > 1e-4) {
      const warm = Math.log(b / r) / 0.68; // warmth gains shift r/b by e^(0.68 w)
      const tint = Math.log(g / ((r + b) / 2)) / 0.28; // and g/(r,b) by e^(-0.28 t)
      if (Math.abs(warm) > 0.05) p.warmth = Math.max(-30, Math.min(30, warm * 100 * 0.4));
      if (Math.abs(tint) > 0.05) p.tint = Math.max(-20, Math.min(20, tint * 100 * 0.4));
    }
  }

  // A little life for muted photos.
  if (a.meanSat < 0.2) p.vibrance = Math.min(30, (0.25 - a.meanSat) * 150);
  else if (a.meanSat < 0.4) p.vibrance = 8;

  const params = {};
  for (const [k, v] of Object.entries(p)) {
    const c = clampParam(k, v);
    if (Math.abs(c) >= 3) params[k] = c;
  }
  const changes = Object.entries(params)
    .sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))
    .slice(0, MAX_CHANGES)
    .map(([key, value]) => ({ key, value }));
  // Only what we report is applied, so the chips are the whole story.
  return { params: Object.fromEntries(changes.map((c) => [c.key, c.value])), changes };
}

// "Shadows +24" — the chip text.
export function formatChange(label, value) {
  return `${label} ${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value)}`;
}
