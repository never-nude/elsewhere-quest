import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyze, autoLight, autoColor, autoEnhance, whiteFromSample, suggestion, formatChange,
  LIGHT_DIALS, COLOR_DIALS,
} from '../lib/autofix.js';
import { developImage, resolve, defaultAdjust, luma, uniforms, srgbToLinear } from '../lib/develop.js';

function makeImage(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fn(x / (width - 1), y / (height - 1), x, y);
      const i = (y * width + x) * 4;
      data[i] = r * 255; data[i + 1] = g * 255; data[i + 2] = b * 255; data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

const median = (img) => {
  const ys = [];
  for (let i = 0; i < img.data.length; i += 4) ys.push(luma(img.data[i] / 255, img.data[i + 1] / 255, img.data[i + 2] / 255));
  ys.sort((a, b) => a - b);
  return ys[ys.length >> 1];
};

// Mean linear rgb of the pixels between two rows (fractions of the height).
const meanLinear = (img, v0, v1) => {
  const { width, height, data } = img;
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = Math.round(v0 * height); y < Math.round(v1 * height); y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      r += srgbToLinear(data[i] / 255); g += srgbToLinear(data[i + 1] / 255); b += srgbToLinear(data[i + 2] / 255); n++;
    }
  }
  return [r / n, g / n, b / n];
};

// A scene with structure: a gradient sky, some mid ground, darker foreground.
const scene = (gain = 1, bias = 0, cast = [1, 1, 1]) => makeImage(64, 48, (u, v) => {
  const base = v < 0.4 ? 0.75 - v * 0.4 : v < 0.75 ? 0.45 + 0.1 * Math.sin(u * 12) : 0.18 + 0.1 * u;
  const tex = 0.06 * Math.sin(u * 37 + v * 23);
  const y = Math.max(0, Math.min(1, (base + tex) * gain + bias));
  return [Math.min(1, y * cast[0]), Math.min(1, y * cast[1]), Math.min(1, y * cast[2])];
});

// A colourful scene: hue varies across the frame at moderate saturation.
const colourful = (sat) => makeImage(64, 48, (u, v) => {
  const y = 0.3 + 0.4 * v;
  const h = u * Math.PI * 2;
  return [y * (1 + sat * Math.cos(h)), y * (1 + sat * Math.cos(h - 2.1)), y * (1 + sat * Math.cos(h + 2.1))].map((c) => Math.max(0, Math.min(1, c)));
});

const DOC = Object.freeze({
  v: 1, id: 'doc-1', createdAt: 1,
  source: Object.freeze({ type: 'jpeg', natW: 64, natH: 48, w: 64, h: 48 }),
  light: Object.freeze({ brightness: 0, contrast: 0, highlights: 0, shadows: 0 }),
  color: Object.freeze({ warmth: 0, tint: 0, vividness: 0, look: 'none', strength: 100 }),
  paint: Object.freeze([]),
  crop: Object.freeze({ quarter: 0, flip: false, angle: 0, aspect: 'free', rect: Object.freeze({ x: -32, y: -24, width: 64, height: 48 }) }),
  remove: Object.freeze([]),
  text: Object.freeze([]),
});

const withDials = (doc, light = {}, color = {}) => ({ ...doc, light: { ...doc.light, ...light }, color: { ...doc.color, ...color } });

// The develop-pipeline adjust a doc means (contract: vividness -> vibrance).
const adjustOf = (doc) => ({
  ...defaultAdjust(),
  ...doc.light,
  warmth: doc.color.warmth, tint: doc.color.tint, vibrance: doc.color.vividness,
});
const develop = (img, doc) => developImage(img, resolve(adjustOf(doc), { id: doc.color.look, amount: doc.color.strength }));

const gainsOf = (warmth, tint) => uniforms(resolve({ ...defaultAdjust(), warmth, tint })).wb;

const isDial = (v, lo = -100, hi = 100) => Number.isInteger(v) && v >= lo && v <= hi && !Object.is(v, -0);

// ------------------------------------------------------------------ analyze

test('analyze reports ordered percentiles, clipping and colour stats', () => {
  const s = analyze(scene());
  assert.ok(s.p01 <= s.p05 && s.p05 <= s.p50 && s.p50 <= s.p95 && s.p95 <= s.p99);
  for (const k of ['p01', 'p05', 'p50', 'p95', 'p99', 'mean', 'dark', 'clipLow', 'clipHigh', 'meanSat', 'neutralShare']) {
    assert.ok(s[k] >= 0 && s[k] <= 1, `${k} ${s[k]}`);
  }
  assert.equal(s.n, 64 * 48);
  assert.equal(s.meanSat, 0); // a grey scene
  assert.ok(s.neutralShare > 0.5);
  assert.ok(Math.abs(s.neutral[0] - s.neutral[1]) < 1e-9 && Math.abs(s.neutral[1] - s.neutral[2]) < 1e-9);
});

test('analyze counts blown and crushed pixels', () => {
  const img = makeImage(10, 10, (u, v, x, y) => (y < 2 ? [1, 1, 1] : y < 5 ? [0, 0, 0] : [0.5, 0.5, 0.5]));
  const s = analyze(img);
  assert.ok(Math.abs(s.clipHigh - 0.2) < 1e-9);
  assert.ok(Math.abs(s.clipLow - 0.3) < 1e-9);
  assert.ok(Math.abs(s.dark - 0.3) < 1e-9);
  assert.ok(Math.abs(s.p50 - 0.5) < 0.01);
});

test('analyze accepts (rgba, w, h) and skips transparent pixels', () => {
  const img = scene(0.6);
  assert.deepEqual(analyze(img.data, img.width, img.height), analyze(img));
  // a plain array of bytes too, not only a typed array (it used to return null)
  assert.deepEqual(analyze(Array.from(img.data), img.width, img.height), analyze(img));
  const half = { ...img, data: Uint8ClampedArray.from(img.data) };
  for (let i = 0; i < half.data.length / 2; i += 4) half.data[i + 3] = 0;
  assert.equal(analyze(half).n, img.width * img.height / 2);
});

test('analyze returns null when there is nothing to measure', () => {
  assert.equal(analyze({ width: 2, height: 2, data: new Uint8ClampedArray(16) }), null); // all transparent
  assert.equal(analyze({ width: 0, height: 0, data: new Uint8ClampedArray(0) }), null);
  assert.equal(analyze(null), null);
  assert.equal(analyze({ width: 2.5, height: 2, data: new Uint8ClampedArray(20) }), null);
  // a short buffer is read as far as it goes
  const s = analyze({ width: 10, height: 10, data: new Uint8ClampedArray([128, 128, 128, 255]) });
  assert.equal(s.n, 1);
});

test('analyze leaves its input untouched', () => {
  const img = scene(0.7, 0, [1, 0.9, 0.8]);
  const copy = Uint8ClampedArray.from(img.data);
  analyze(img);
  assert.deepEqual(img.data, copy);
});

// ------------------------------------------------------------------ autoLight

test('autoLight returns exactly the four Light dials, as whole numbers', () => {
  for (const img of [scene(0.3), scene(1.4), scene(0.35, 0.33), scene()]) {
    const L = autoLight(analyze(img));
    assert.deepEqual(Object.keys(L).sort(), [...LIGHT_DIALS].sort());
    for (const v of Object.values(L)) assert.ok(isDial(v) && (v === 0 || Math.abs(v) >= 3), `${v}`);
  }
  assert.deepEqual(autoLight(null), { brightness: 0, contrast: 0, highlights: 0, shadows: 0 });
  assert.deepEqual(autoLight({}), { brightness: 0, contrast: 0, highlights: 0, shadows: 0 });
});

test('a dark photo gets brighter, but a dusk stays dusky', () => {
  for (const img of [scene(0.4), scene(0.5, 0, [0.85, 0.85, 1])]) {
    const s = analyze(img);
    const L = autoLight(s);
    assert.ok(L.brightness > 10, JSON.stringify(L));
    const after = develop(img, withDials(DOC, L));
    assert.ok(median(after) > median(img) + 0.08, `${median(img)} -> ${median(after)}`);
    // lifted part of the way, never flattened to a daytime mid-grey
    assert.ok(median(after) < 0.42, `${median(after)}`);
  }
});

test('a very dark night shot is lifted gently, with shadows opened', () => {
  const L = autoLight(analyze(scene(0.15)));
  assert.ok(L.brightness > 0 && L.brightness <= 50);
  assert.ok(L.shadows > 10);
});

test('a bright photo comes down, and blown highlights are pulled back', () => {
  const L = autoLight(analyze(scene(1.4)));
  assert.ok(L.brightness < 0 && L.brightness >= -35, JSON.stringify(L));
  assert.ok(L.highlights < 0);
  const clip = makeImage(50, 50, (u, v) => (v < 0.3 ? [1, 1, 1] : [0.4 + u * 0.2, 0.4, 0.35]));
  assert.ok(autoLight(analyze(clip)).highlights < 0);
});

test('a flat, foggy photo gets contrast; a punchy one is never flattened', () => {
  const L = autoLight(analyze(scene(0.35, 0.33)));
  assert.ok(L.contrast > 5, JSON.stringify(L));
  const punchy = makeImage(64, 64, (u) => (u < 0.5 ? [0.03, 0.03, 0.03] : [0.97, 0.97, 0.97]));
  assert.ok(autoLight(analyze(punchy)).contrast >= 0);
});

test('a well-exposed photo is mostly left alone', () => {
  const img = makeImage(64, 64, (u, v) => {
    const y = Math.min(1, Math.max(0, u * 0.6 + v * 0.4));
    const hue = Math.sin(u * 9 + v * 4) * 0.25;
    return [Math.min(1, y * (1 + hue)), y, Math.min(1, y * (1 - hue))];
  });
  const L = autoLight(analyze(img));
  assert.equal(L.brightness, 0);
  for (const [k, v] of Object.entries(L)) assert.ok(Math.abs(v) <= 30, `${k} ${v}`);
});

test('autoLight is continuous: a hair across a threshold never jumps a dial', () => {
  const base = analyze(scene());
  for (const p50 of [0.4399, 0.44, 0.4401, 0.5799, 0.58, 0.5801]) {
    const L = autoLight({ ...base, p50 });
    assert.ok(Math.abs(L.brightness) <= 3, `${p50}: ${L.brightness}`);
  }
});

// A grey that needs exactly (warmth, tint) to come back neutral.
const castFor = (warmth, tint) => gainsOf(warmth, tint).map((g) => 0.2 / g);

test('no rule switches on with a jump: a hair across any threshold moves a dial by at most 2', () => {
  // Regression: hard gates used to give Shadows +30 vs 0 (p05 0.0799 vs 0.0801),
  // Warmth +18 vs +30 (p50 either side of 0.3), Vividness 0 vs +24 (meanSat
  // either side of 0.03) and +6 vs 0 (either side of 0.4), and halved the tint
  // the moment a cast turned from cool to warm.
  const base = {
    n: 1000, mean: 0.3, p01: 0.03, p05: 0.07, p50: 0.3, p95: 0.7, p99: 0.85,
    dark: 0.35, clipLow: 0, clipHigh: 0, meanSat: 0.5, neutralShare: 0.5, neutral: castFor(60, -30),
  };
  const probes = [
    ['p05', 0.08, { dark: 0.35 }],
    ['dark', 0.12, { p05: 0.02 }],
    ['dark', 0.1, { p05: 0.02 }],
    ['clipLow', 0.01, { dark: 0.05, p05: 0.1 }],
    ['clipLow', 0.015, { dark: 0.05, p05: 0.1 }],
    ['clipHigh', 0.005, {}],
    ['clipHigh', 0.0075, {}],
    ['p50', 0.3, {}],
    ['p50', 0.25, {}],
    ['p50', 0.35, {}],
    ['meanSat', 0.03, { neutral: null }],
    ['meanSat', 0.08, { neutral: null }],
    ['meanSat', 0.38, { neutral: null }],
    ['meanSat', 0.4, { neutral: null }],
    ['meanSat', 0.42, { neutral: null }],
  ];
  const all = (s) => ({ ...autoLight(s), ...autoColor(s) });
  for (const [key, at, extra] of probes) {
    const lo = all({ ...base, ...extra, [key]: at - 1e-4 });
    const hi = all({ ...base, ...extra, [key]: at + 1e-4 });
    for (const k of Object.keys(lo)) assert.ok(Math.abs(lo[k] - hi[k]) <= 2, `${key} ≈ ${at}: ${k} ${lo[k]} -> ${hi[k]}`);
  }
  // the green/magenta correction eases off smoothly as a cast turns warm
  for (const tint of [30, 60]) {
    const a = autoColor({ ...base, neutral: castFor(-4.95, tint) });
    const b = autoColor({ ...base, neutral: castFor(-5.05, tint) });
    assert.ok(Math.abs(a.tint - b.tint) <= 1, `tint ${tint}: ${a.tint} -> ${b.tint}`);
  }
});

// ------------------------------------------------------------------ autoColor

test('autoColor returns exactly the three Color dials, as whole numbers', () => {
  for (const img of [scene(1, 0, [0.82, 0.92, 1]), scene(), colourful(0.3)]) {
    const C = autoColor(analyze(img));
    assert.deepEqual(Object.keys(C).sort(), [...COLOR_DIALS].sort());
    for (const v of Object.values(C)) assert.ok(isDial(v) && (v === 0 || Math.abs(v) >= 3), `${v}`);
  }
  assert.deepEqual(autoColor(null), { warmth: 0, tint: 0, vividness: 0 });
});

test('a blue cast is warmed and a green cast gets magenta tint, part of the way', () => {
  const blue = scene(1, 0, [0.82, 0.92, 1]);
  const C = autoColor(analyze(blue));
  assert.ok(C.warmth > 5, JSON.stringify(C));
  // closer to neutral afterwards, but not forced all the way
  const before = meanLinear(blue, 0, 0.4);
  const after = meanLinear(develop(blue, withDials(DOC, {}, { warmth: C.warmth, tint: C.tint })), 0, 0.4);
  const cast = (c) => Math.abs(Math.log(c[2] / c[0]));
  assert.ok(cast(after) < cast(before) * 0.85, `${cast(before)} -> ${cast(after)}`);
  assert.ok(cast(after) > 0.02);
  assert.ok(autoColor(analyze(scene(1, 0, [0.9, 1, 0.9]))).tint > 3);
});

test('golden hour stays golden', () => {
  // a strong warm light: too saturated to be read as a grey that went wrong
  const strong = autoColor(analyze(scene(1, 0, [1, 0.82, 0.55])));
  assert.equal(strong.warmth, 0);
  // a softer warm light is cooled only a little, and still reads warm afterwards
  const img = scene(1, 0, [1, 0.9, 0.74]);
  const C = autoColor(analyze(img));
  assert.ok(C.warmth <= 0 && C.warmth >= -20, JSON.stringify(C));
  assert.ok(C.tint <= 15);
  const after = meanLinear(develop(img, withDials(DOC, {}, { warmth: C.warmth, tint: C.tint })), 0, 0.4);
  assert.ok(after[0] > after[2] * 1.15, `still warm: ${after}`);
});

test('a dark photo keeps more of its colour mood than a bright one', () => {
  const cast = [0.85, 0.85, 1];
  const dusk = autoColor(analyze(scene(0.5, 0, cast)));
  const day = autoColor(analyze(scene(1, 0, cast)));
  assert.ok(dusk.warmth > 0 && dusk.warmth < day.warmth, `${dusk.warmth} vs ${day.warmth}`);
});

test('vividness: gentle life for muted colour, none for black-and-white or vivid photos', () => {
  assert.equal(autoColor(analyze(scene())).vividness, 0); // grey
  const muted = autoColor(analyze(colourful(0.15)));
  assert.ok(muted.vividness > 5 && muted.vividness <= 24, JSON.stringify(muted));
  assert.equal(autoColor(analyze(colourful(0.9))).vividness, 0);
});

test('a black-and-white photo with a little chroma noise gets no more than a token of vividness', () => {
  // Regression: ±3/255 of per-channel noise lifts meanSat just past 0.03, which
  // used to earn the maximum, Vividness +24.
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const bw = makeImage(128, 96, (u, v) => {
    const y = 0.05 + 0.9 * u * (0.6 + 0.4 * v);
    return [0, 1, 2].map(() => Math.max(0, Math.min(1, y + (rnd() * 2 - 1) * 3 / 255)));
  });
  const s = analyze(bw);
  assert.ok(s.meanSat > 0.03 && s.meanSat < 0.05, `${s.meanSat}`);
  const C = autoColor(s);
  assert.ok(C.vividness <= 6, JSON.stringify(C));
  assert.ok(C.vividness < autoColor(analyze(colourful(0.15))).vividness);
});

test('a neutral grey photo needs no colour correction', () => {
  assert.deepEqual(autoColor(analyze(scene())), { warmth: 0, tint: 0, vividness: 0 });
});

// ------------------------------------------------------------------ whiteFromSample

test('whiteFromSample inverts develop\'s white balance exactly', () => {
  for (const warmth of [-90, -40, -7, 0, 12, 55, 100]) {
    for (const tint of [-100, -33, 0, 5, 64]) {
      const g = gainsOf(warmth, tint);
      // a grey that has been given the opposite cast
      const sample = [0.3 / g[0], 0.3 / g[1], 0.3 / g[2]];
      assert.deepEqual(whiteFromSample(sample), { warmth, tint }, `${warmth}/${tint}`);
    }
  }
});

test('applying whiteFromSample\'s answer makes the sample neutral', () => {
  const samples = [[0.2, 0.3, 0.4], [0.5, 0.45, 0.3], [0.18, 0.22, 0.17], [0.05, 0.05, 0.07], [0.9, 0.8, 0.85]];
  for (const s of samples) {
    const { warmth, tint } = whiteFromSample(s);
    assert.ok(isDial(warmth) && isDial(tint));
    if (Math.abs(warmth) === 100 || Math.abs(tint) === 100) continue; // at the dial's end stop
    const g = gainsOf(warmth, tint);
    const out = s.map((c, i) => c * g[i]);
    const m = (out[0] + out[1] + out[2]) / 3;
    for (const c of out) assert.ok(Math.abs(c / m - 1) < 0.01, `${s} -> ${out}`);
  }
});

test('whiteFromSample: neutral is zero, scale does not matter, extremes clamp', () => {
  assert.deepEqual(whiteFromSample([0.4, 0.4, 0.4]), { warmth: 0, tint: 0 });
  assert.deepEqual(whiteFromSample([0.02, 0.03, 0.04]), whiteFromSample([0.2, 0.3, 0.4]));
  const red = whiteFromSample([1, 0, 0]);
  assert.equal(red.warmth, -100);
  assert.ok(isDial(red.tint));
  const blue = whiteFromSample([0, 0, 1]);
  assert.equal(blue.warmth, 100);
});

test('whiteFromSample gives up gracefully on unusable samples', () => {
  for (const bad of [[0, 0, 0], [NaN, 0.2, 0.2], [0.2, 0.2], null, undefined, [-1, -1, -1], [Infinity, 1, 1]]) {
    assert.deepEqual(whiteFromSample(bad), { warmth: 0, tint: 0 }, String(bad));
  }
  // negative noise in one channel is treated as zero light there
  assert.equal(whiteFromSample([-0.01, 0.2, 0.3]).warmth, 100);
});

// ------------------------------------------------------------------ autoEnhance

test('autoEnhance sets the visible dials and leaves everything else alone', () => {
  const stats = analyze(scene(0.45, 0, [0.85, 0.9, 1]));
  const doc = withDials(DOC, {}, { look: 'film', strength: 60 });
  const { next, changes } = autoEnhance(stats, doc);
  assert.ok(changes.length > 0 && changes.length <= 5);
  assert.equal(next.color.look, 'film');
  assert.equal(next.color.strength, 60);
  for (const k of ['v', 'id', 'createdAt', 'source', 'paint', 'crop', 'remove', 'text']) assert.equal(next[k], doc[k], k);
  assert.ok(next.light.brightness > 0);
  assert.ok(next.color.warmth > 0);
  // the doc's develop mapping only ever moves user-visible params
  const a0 = adjustOf(doc), a1 = adjustOf(next);
  for (const k of ['exposure', 'blacks', 'whites', 'saturation', 'vignette', 'grain']) assert.equal(a1[k], a0[k], k);
});

test('the chips are the whole story: sorted, at least 3, at most 5, true minus signs', () => {
  for (const img of [scene(0.3), scene(1.3), scene(0.5, 0.2, [1, 0.9, 0.8]), scene(0.4, 0, [0.8, 0.9, 1]), colourful(0.1)]) {
    const doc = withDials(DOC, { contrast: 10 }, { warmth: -12 });
    const { next, changes } = autoEnhance(analyze(img), doc);
    assert.ok(changes.length <= 5);
    const changed = [...LIGHT_DIALS, ...COLOR_DIALS].filter((k) => (next.light[k] ?? next.color[k]) !== (doc.light[k] ?? doc.color[k]));
    assert.deepEqual(changed.sort(), changes.map((c) => c.dial).sort());
    for (let i = 0; i < changes.length; i++) {
      const c = changes[i];
      const prev = doc.light[c.dial] ?? doc.color[c.dial];
      const now = next.light[c.dial] ?? next.color[c.dial];
      assert.equal(c.value, now);
      assert.equal(c.delta, now - prev);
      assert.ok(Math.abs(c.delta) >= 3);
      assert.ok(isDial(c.value));
      assert.match(c.label, /^(Brightness|Contrast|Highlights|Shadows|Warmth|Tint|Vividness) ([+−]\d+|0)$/);
      assert.equal(c.label.includes('-'), false);
      if (i) assert.ok(Math.abs(changes[i - 1].delta) >= Math.abs(c.delta));
    }
  }
});

test('labels name the dial and its new value', () => {
  const stats = analyze(scene(0.4, 0, [0.82, 0.92, 1]));
  const { changes } = autoEnhance(stats, DOC);
  const b = changes.find((c) => c.dial === 'brightness');
  assert.equal(b.label, `Brightness +${b.value}`);
  const { changes: down } = autoEnhance(analyze(scene(1.4)), DOC);
  const d = down.find((c) => c.dial === 'brightness');
  assert.equal(d.label, `Brightness −${-d.value}`);
});

test('at most five dials move even when Auto has an opinion on all seven', () => {
  const stats = {
    n: 1000, mean: 0.25, p01: 0.01, p05: 0.02, p50: 0.2, p95: 0.42, p99: 0.99,
    dark: 0.4, clipLow: 0.03, clipHigh: 0.03, meanSat: 0.12, neutralShare: 0.5, neutral: [0.08, 0.16, 0.2],
  };
  const want = { ...autoLight(stats), ...autoColor(stats) };
  assert.equal(Object.values(want).filter((v) => v !== 0).length, 7, JSON.stringify(want));
  const { next, changes } = autoEnhance(stats, DOC);
  assert.equal(changes.length, 5);
  // pressing it again finds nothing left to do
  const again = autoEnhance(stats, next);
  assert.deepEqual(again.changes, []);
  assert.equal(again.next, next);
  // the weakest opinions are left out, and their dials keep what the user set
  const weakest = Object.keys(want).sort((a, b) => Math.abs(want[a]) - Math.abs(want[b])).slice(0, 2);
  const edited = withDials(DOC, {}, {});
  for (const k of weakest) (k in edited.light ? edited.light : edited.color)[k] = -7;
  const r = autoEnhance(stats, edited);
  for (const k of weakest) assert.equal(r.next.light[k] ?? r.next.color[k], -7, k);
  assert.ok(r.changes.every((c) => !weakest.includes(c.dial)));
});

test('a dial Auto wants at zero puts a stray value back, and says so', () => {
  const stats = analyze(scene());
  assert.equal(autoLight(stats).brightness, 0);
  const { next, changes } = autoEnhance(stats, withDials(DOC, { brightness: 60 }));
  assert.equal(next.light.brightness, 0);
  const c = changes.find((x) => x.dial === 'brightness');
  assert.deepEqual(c, { dial: 'brightness', label: 'Brightness 0', value: 0, delta: -60 });
});

test('Auto-enhance twice is the same as once', () => {
  for (const img of [scene(0.3), scene(1.3, 0, [0.9, 0.95, 1]), scene(0.35, 0.33)]) {
    const stats = analyze(img);
    const once = autoEnhance(stats, DOC);
    const twice = autoEnhance(stats, once.next);
    assert.deepEqual(twice.changes, []);
    assert.equal(twice.next, once.next);
  }
});

test('deltas are measured from the doc as it is, and small ones are not made', () => {
  const stats = analyze(scene(0.4));
  const fresh = autoEnhance(stats, DOC);
  const b = fresh.next.light.brightness;
  // already nearly there: a 2-point move is not worth a chip, so it isn't made
  const close = withDials(DOC, { brightness: b - 2 });
  const r = autoEnhance(stats, close);
  assert.equal(r.next.light.brightness, b - 2);
  assert.equal(r.changes.find((c) => c.dial === 'brightness'), undefined);
  // a manual overshoot is brought back, and the chip says by how much
  const over = withDials(DOC, { brightness: b + 30 });
  const back = autoEnhance(stats, over).changes.find((c) => c.dial === 'brightness');
  assert.equal(back.delta, -30);
  assert.equal(back.value, b);
});

test('nothing to do returns the same doc and no chips', () => {
  const stats = analyze(scene());
  const settled = autoEnhance(stats, DOC).next;
  assert.deepEqual(autoEnhance(stats, settled), { next: settled, changes: [] });
  assert.deepEqual(autoEnhance(null, DOC), { next: DOC, changes: [] });
  assert.deepEqual(autoEnhance({ p50: NaN }, DOC), { next: DOC, changes: [] });
});

test('autoEnhance never mutates its inputs and survives odd docs', () => {
  const stats = Object.freeze(analyze(scene(0.4)));
  const { next } = autoEnhance(stats, DOC); // DOC is deeply frozen
  assert.notEqual(next, DOC);
  assert.notEqual(next.light, DOC.light);
  // NaN or missing dials count as 0
  const odd = { ...DOC, light: { brightness: NaN }, color: { look: 'mono', strength: 40 } };
  const r = autoEnhance(stats, odd);
  assert.ok(r.next.light.brightness > 0);
  assert.equal(r.next.color.look, 'mono');
  assert.equal(autoEnhance(stats, null).next, null);
});

// ------------------------------------------------------------------ suggestion

test('a clear tilt is suggested first, as a straighten', () => {
  const dark = analyze(scene(0.4));
  assert.deepEqual(suggestion(dark, { angleDeg: -2.84, confidence: 0.7, kind: 'horizon' }),
    { text: 'Looks tilted 2.8° — Straighten it', action: 'straighten' });
  assert.equal(suggestion(null, { angleDeg: 3.06, confidence: 0.3, kind: 'verticals' }).text, 'Looks tilted 3.1° — Straighten it');
});

test('no tilt suggestion without confidence or under half a degree', () => {
  const ok = analyze(scene());
  assert.equal(suggestion(ok, { angleDeg: 4, confidence: 0, kind: 'none' }), null);
  assert.equal(suggestion(ok, { angleDeg: 0.4, confidence: 0.9, kind: 'horizon' }), null);
  assert.equal(suggestion(ok, { angleDeg: NaN, confidence: 0.9, kind: 'horizon' }), null);
  assert.equal(suggestion(ok, null), null);
  assert.equal(suggestion(null, null), null);
});

test('a dark, bright or flat photo suggests Auto-enhance', () => {
  assert.deepEqual(suggestion(analyze(scene(0.4)), null), { text: 'A bit dark — try Auto-enhance', action: 'enhance' });
  assert.equal(suggestion(analyze(scene(1.5)), null)?.action, 'enhance');
  assert.equal(suggestion(analyze(scene(0.35, 0.33)), null)?.action, 'enhance');
  assert.equal(suggestion(analyze(scene()), null), null);
});

test('once the user has set Light themselves, no nagging about it', () => {
  const dark = analyze(scene(0.4));
  assert.equal(suggestion(dark, null, withDials(DOC, { shadows: 20 })), null);
  assert.ok(suggestion(dark, null, DOC));
  // a tilt is still worth saying
  assert.equal(suggestion(dark, { angleDeg: 2, confidence: 1 }, withDials(DOC, { brightness: 30 })).action, 'straighten');
});

// ------------------------------------------------------------------ formatChange

test('formatChange uses a true minus sign', () => {
  assert.equal(formatChange('Shadows', 24), 'Shadows +24');
  assert.equal(formatChange('Warmth', -6), 'Warmth −6');
  assert.equal(formatChange('Tint', 0), 'Tint 0');
});
