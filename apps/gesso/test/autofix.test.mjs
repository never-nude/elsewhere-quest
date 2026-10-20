import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, autoAdjust, formatChange } from '../lib/autofix.js';
import { developImage, resolve, defaultAdjust, luma } from '../lib/develop.js';

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

// A scene with structure: a gradient sky, some mid ground, darker foreground.
const scene = (gain = 1, bias = 0, cast = [1, 1, 1]) => makeImage(64, 48, (u, v) => {
  const base = v < 0.4 ? 0.75 - v * 0.4 : v < 0.75 ? 0.45 + 0.1 * Math.sin(u * 12) : 0.18 + 0.1 * u;
  const tex = 0.06 * Math.sin(u * 37 + v * 23);
  const y = Math.max(0, Math.min(1, (base + tex) * gain + bias));
  return [Math.min(1, y * cast[0]), Math.min(1, y * cast[1]), Math.min(1, y * cast[2])];
});

test('a dark photo gets brighter, and developing it moves the median toward mid-grey', () => {
  const img = scene(0.4);
  const { params, changes } = autoAdjust(img);
  assert.ok(params.brightness > 10, JSON.stringify(params));
  const after = developImage(img, resolve({ ...defaultAdjust(), ...params }));
  assert.ok(median(after) > median(img) + 0.08);
  assert.ok(changes.length > 0 && changes.length <= 5);
});

test('a flat, foggy photo gets contrast and end points', () => {
  const img = scene(0.35, 0.33);
  const { params } = autoAdjust(img);
  assert.ok(params.contrast > 5, JSON.stringify(params));
  assert.ok((params.blacks ?? 0) > 0 || (params.whites ?? 0) > 0);
});

test('a blue cast is warmed; a green cast gets magenta tint', () => {
  assert.ok(autoAdjust(scene(1, 0, [0.82, 0.92, 1])).params.warmth > 5);
  assert.ok(autoAdjust(scene(1, 0, [0.9, 1, 0.9])).params.tint > 3);
});

test('a well-exposed neutral photo is mostly left alone', () => {
  const img = makeImage(64, 64, (u, v) => {
    const y = Math.min(1, Math.max(0, (u * 0.6 + v * 0.4) * 1.0));
    const hue = Math.sin(u * 9 + v * 4) * 0.25;
    return [Math.min(1, y * (1 + hue)), y, Math.min(1, y * (1 - hue))];
  });
  const { params } = autoAdjust(img);
  for (const [k, v] of Object.entries(params)) assert.ok(Math.abs(v) <= 30, `${k} ${v}`);
  assert.equal(params.brightness, undefined);
});

test('clipping highlights are pulled back', () => {
  const img = makeImage(50, 50, (u, v) => (v < 0.3 ? [1, 1, 1] : [0.4 + u * 0.2, 0.4, 0.35]));
  assert.ok(autoAdjust(img).params.highlights < 0);
});

test('results are integers within slider ranges and the chip list matches the params', () => {
  for (const img of [scene(0.3), scene(1.3), scene(0.5, 0.2, [1, 0.9, 0.8])]) {
    const { params, changes } = autoAdjust(img);
    assert.deepEqual(Object.fromEntries(changes.map((c) => [c.key, c.value])), params);
    for (const v of Object.values(params)) assert.ok(Number.isInteger(v) && Math.abs(v) >= 3 && Math.abs(v) <= 100);
    for (let i = 1; i < changes.length; i++) assert.ok(Math.abs(changes[i - 1].value) >= Math.abs(changes[i].value));
  }
});

test('transparent or empty images produce no changes', () => {
  const img = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
  assert.equal(analyze(img), null);
  assert.deepEqual(autoAdjust(img), { params: {}, changes: [] });
});

test('formatChange uses a true minus sign', () => {
  assert.equal(formatChange('Shadows', 24), 'Shadows +24');
  assert.equal(formatChange('Warmth', -6), 'Warmth −6');
  assert.equal(formatChange('Tint', 0), 'Tint 0');
});
