import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PARAMS, PARAM_KEYS, paramInfo, defaultAdjust, clampParam, reviveAdjust, changedParams,
  LOOKS, lookById, resolve, uniforms, developPixel, developImage, srgbToLinear, linearToSrgb,
  luma, hashNoise, shoulder, DEVELOP_GLSL,
} from '../lib/develop.js';

const U = (params = {}, look) => uniforms(resolve({ ...defaultAdjust(), ...params }, look));
const px = (rgb, params, blur, uv = [0.5, 0.5]) => developPixel(rgb[0], rgb[1], rgb[2], U(params), blur, uv[0], uv[1], 0);
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('params are well-formed and defaults are all zero', () => {
  for (const p of PARAMS) {
    assert.ok(p.min < p.max);
    assert.ok(p.min <= 0 && p.max >= 0);
    assert.ok(['light', 'color'].includes(p.group));
  }
  assert.ok(Object.values(defaultAdjust()).every((v) => v === 0));
  assert.throws(() => paramInfo('nope'), /unknown param/);
});

test('clampParam and reviveAdjust sanitise input', () => {
  assert.equal(clampParam('contrast', 250), 100);
  assert.equal(clampParam('grain', -5), 0);
  assert.equal(clampParam('warmth', '12.6'), 13);
  assert.equal(clampParam('tint', 'x'), 0);
  const r = reviveAdjust({ contrast: 40, bogus: 9, grain: 900 });
  assert.equal(r.contrast, 40);
  assert.equal(r.grain, 100);
  assert.ok(!('bogus' in r));
  assert.deepEqual(Object.keys(reviveAdjust(null)), PARAM_KEYS);
  assert.deepEqual(changedParams({ ...defaultAdjust(), shadows: 5 }), ['shadows']);
});

test('sRGB transfer functions round-trip', () => {
  for (let i = 0; i <= 255; i++) {
    const c = i / 255;
    assert.ok(close(linearToSrgb(srgbToLinear(c)), c, 1e-9));
  }
});

test('neutral settings are an exact identity (to 8-bit rounding)', () => {
  const img = { width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4) };
  for (let i = 0; i < img.data.length; i++) img.data[i] = (i * 37 + 11) % 256;
  const out = developImage(img, resolve(defaultAdjust()));
  for (let i = 0; i < img.data.length; i++) {
    if (i % 4 === 3) continue;
    assert.ok(Math.abs(out.data[i] - img.data[i]) <= 1, `index ${i}: ${img.data[i]} -> ${out.data[i]}`);
  }
});

test('brightness lifts midtones but pins black and white', () => {
  const [mid] = px([0.4, 0.4, 0.4], { brightness: 60 });
  assert.ok(mid > 0.5);
  assert.ok(close(px([0, 0, 0], { brightness: 100 })[0], 0));
  assert.ok(close(px([1, 1, 1], { brightness: 100 })[0], 1));
  assert.ok(px([0.4, 0.4, 0.4], { brightness: -60 })[0] < 0.3);
});

test('contrast spreads tones around mid-grey', () => {
  assert.ok(px([0.25, 0.25, 0.25], { contrast: 80 })[0] < 0.25);
  assert.ok(px([0.75, 0.75, 0.75], { contrast: 80 })[0] > 0.75);
  assert.ok(close(px([0.5, 0.5, 0.5], { contrast: 80 })[0], 0.5, 1e-9));
  assert.ok(px([0.1, 0.1, 0.1], { contrast: -80 })[0] > 0.1);
});

test('warmth and tint shift colour while roughly keeping grey luminance', () => {
  const warm = px([0.5, 0.5, 0.5], { warmth: 80 });
  assert.ok(warm[0] > warm[2] + 0.1, 'warmer = redder than bluer');
  const cool = px([0.5, 0.5, 0.5], { warmth: -80 });
  assert.ok(cool[2] > cool[0] + 0.1);
  const magenta = px([0.5, 0.5, 0.5], { tint: 80 });
  assert.ok(magenta[1] < magenta[0] && magenta[1] < magenta[2]);
  const lin = (c) => luma(srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]));
  assert.ok(Math.abs(lin(warm) - srgbToLinear(0.5)) < 0.03);
});

test('saturation -100 is greyscale; vibrance boosts muted colours more than vivid ones', () => {
  const g = px([0.8, 0.3, 0.2], { saturation: -100 });
  assert.ok(close(g[0], g[1], 1e-9) && close(g[1], g[2], 1e-9));
  const chroma = (c) => Math.max(...c) - Math.min(...c);
  const mutedGain = chroma(px([0.55, 0.5, 0.45], { vibrance: 80 })) / chroma([0.55, 0.5, 0.45]);
  const vividGain = chroma(px([0.9, 0.2, 0.1], { vibrance: 80 })) / chroma([0.9, 0.2, 0.1]);
  assert.ok(mutedGain > vividGain);
});

test('shadows lift dark areas far more than bright ones; highlights recover bright areas', () => {
  const dark = [0.12, 0.12, 0.12], bright = [0.85, 0.85, 0.85];
  const blurOf = (c) => srgbToLinear(c[0]);
  const dLift = px(dark, { shadows: 80 }, blurOf(dark))[0] - dark[0];
  const bLift = px(bright, { shadows: 80 }, blurOf(bright))[0] - bright[0];
  assert.ok(dLift > 0.06 && bLift < 0.03, `${dLift} ${bLift}`);
  const bRecover = px(bright, { highlights: -80 }, blurOf(bright))[0] - bright[0];
  const dRecover = px(dark, { highlights: -80 }, blurOf(dark))[0] - dark[0];
  assert.ok(bRecover < -0.05 && Math.abs(dRecover) < 0.01, `${bRecover} ${dRecover}`);
});

test('exposure doubles light per stop and rolls off instead of clipping', () => {
  const up = px([0.3, 0.3, 0.3], { exposure: 50 }); // +1 stop
  assert.ok(up[0] > 0.38);
  const a = px([0.8, 0.8, 0.8], { exposure: 100 })[0], b = px([0.95, 0.95, 0.95], { exposure: 100 })[0];
  assert.ok(a < 1 && b <= 1 && b >= a, 'bright tones stay ordered under the shoulder');
  assert.equal(shoulder(0.5), 0.5);
  assert.ok(shoulder(3) < 1.0000001);
});

test('blacks and whites move the end points', () => {
  assert.ok(px([0.08, 0.08, 0.08], { blacks: 60 })[0] < 0.08);
  assert.ok(px([0.9, 0.9, 0.9], { whites: 60 })[0] > 0.9);
});

test('vignette darkens the corners and leaves the centre', () => {
  const c = px([0.6, 0.6, 0.6], { vignette: 100 }, null, [0.5, 0.5])[0];
  const corner = px([0.6, 0.6, 0.6], { vignette: 100 }, null, [0.02, 0.02])[0];
  assert.ok(close(c, 0.6, 1e-9));
  assert.ok(corner < 0.3);
  assert.ok(px([0.4, 0.4, 0.4], { vignette: -100 }, null, [0.02, 0.98])[0] > 0.4);
});

test('grain is deterministic, zero-ish mean noise', () => {
  assert.equal(hashNoise(10, 20), hashNoise(10, 20));
  let sum = 0;
  for (let i = 0; i < 4000; i++) {
    const n = hashNoise(i % 97, Math.floor(i / 97));
    assert.ok(n >= -0.5 && n < 0.5);
    sum += n;
  }
  assert.ok(Math.abs(sum / 4000) < 0.03);
});

test('looks are the same dials pushed, scaled by amount', () => {
  const base = { ...defaultAdjust(), contrast: 10 };
  assert.deepEqual(resolve(base, { id: 'none', amount: 100 }).params, base);
  assert.deepEqual(resolve(base, { id: 'vivid', amount: 0 }).params, base);
  const vivid = resolve(base, { id: 'vivid', amount: 50 });
  assert.equal(vivid.params.contrast, 10 + 9);
  assert.equal(vivid.params.vibrance, 18);
  const mono = developPixel(0.8, 0.3, 0.2, uniforms(resolve(defaultAdjust(), { id: 'mono', amount: 100 })), null);
  assert.ok(close(mono[0], mono[1], 1e-9) && close(mono[1], mono[2], 1e-9));
  assert.equal(lookById('bogus').id, 'none');
  assert.ok(LOOKS.length <= 8, 'looks must fit one row without scrolling');
});

test('the shader declares a uniform for every value uniforms() produces', () => {
  const u = uniforms(resolve(defaultAdjust()));
  for (const key of Object.keys(u)) {
    const name = 'u' + key[0].toUpperCase() + key.slice(1);
    assert.match(DEVELOP_GLSL, new RegExp(`\\b${name}\\b`), `${name} missing from GLSL`);
  }
});

test('every slider extreme keeps a grey ramp in order (no tone inversions or banding)', () => {
  for (const p of PARAMS) {
    if (p.key === 'vignette' || p.key === 'grain') continue; // spatial, not tonal
    for (const v of [p.min, p.max]) {
      let prev = -1;
      for (let i = 0; i <= 255; i++) {
        const c = i / 255;
        const y = px([c, c, c], { [p.key]: v }, srgbToLinear(c))[1];
        assert.ok(y >= prev - 1e-9, `${p.key}=${v} inverts at ${i}: ${prev} -> ${y}`);
        prev = y;
      }
    }
  }
});
