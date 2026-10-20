import test from 'node:test';
import assert from 'node:assert/strict';
import { inpaint, inpaintScaled, maskBounds, planRemoval, mulberry32 } from '../lib/inpaint.js';

function makeImage(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * width + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

function rectMask(width, height, rx, ry, rw, rh) {
  const mask = new Uint8Array(width * height);
  for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) mask[y * width + x] = 1;
  return mask;
}

// Paint a foreign "object" into the hole so the test proves it was removed, not kept.
function stamp(image, mask, rgb) {
  const out = { ...image, data: new Uint8ClampedArray(image.data) };
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    out.data[i * 4] = rgb[0]; out.data[i * 4 + 1] = rgb[1]; out.data[i * 4 + 2] = rgb[2];
  }
  return out;
}

function holeError(result, truth, mask) {
  let sum = 0, n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    for (let c = 0; c < 3; c++) sum += Math.abs(result.data[i * 4 + c] - truth.data[i * 4 + c]);
    n += 3;
  }
  return sum / n;
}

test('mulberry32 is deterministic and in [0, 1)', () => {
  const a = mulberry32(42), b = mulberry32(42);
  for (let i = 0; i < 1000; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
  }
});

test('maskBounds finds the tight box, or null for an empty mask', () => {
  const m = rectMask(50, 40, 10, 5, 7, 3);
  assert.deepEqual(maskBounds(m, 50, 40), { x: 10, y: 5, width: 7, height: 3 });
  assert.equal(maskBounds(new Uint8Array(50 * 40), 50, 40), null);
});

test('planRemoval pads the hole, clamps to the image, and asks to downscale big windows', () => {
  const small = planRemoval({ x: 100, y: 100, width: 20, height: 20 }, 1000, 800);
  assert.deepEqual([small.x, small.y, small.width, small.height, small.scale], [60, 60, 100, 100, 1]);
  const edge = planRemoval({ x: 0, y: 0, width: 10, height: 10 }, 1000, 800);
  assert.equal(edge.x, 0);
  assert.equal(edge.y, 0);
  const big = planRemoval({ x: 500, y: 500, width: 1500, height: 1500 }, 4000, 3000);
  assert.ok(big.scale < 1);
  assert.ok(Math.abs(big.width * big.height * big.scale ** 2 - 600 * 600) < 1);
});

test('fills a hole in a flat colour exactly', () => {
  const truth = makeImage(64, 64, () => [120, 80, 200]);
  const mask = rectMask(64, 64, 24, 24, 16, 16);
  const out = inpaint(stamp(truth, mask, [255, 0, 0]), mask);
  assert.ok(holeError(out, truth, mask) < 0.5);
});

test('reconstructs vertical stripes through the hole', () => {
  // 4px on / 4px off. A blur would give mid-grey; PatchMatch should continue the pattern.
  const truth = makeImage(96, 96, (x) => (x % 8 < 4 ? [230, 220, 200] : [30, 40, 60]));
  const mask = rectMask(96, 96, 38, 36, 20, 22);
  const out = inpaint(stamp(truth, mask, [255, 0, 0]), mask);
  const err = holeError(out, truth, mask);
  assert.ok(err < 12, `mean abs error ${err.toFixed(2)} should be small for a periodic texture`);
});

test('continues a smooth gradient without seams far off the true values', () => {
  const truth = makeImage(80, 80, (x, y) => [x * 3, y * 3, 128]);
  const mask = rectMask(80, 80, 30, 30, 14, 14);
  const out = inpaint(stamp(truth, mask, [0, 255, 0]), mask);
  const err = holeError(out, truth, mask);
  assert.ok(err < 14, `mean abs error ${err.toFixed(2)}`);
});

test('handles a hole touching the image border', () => {
  const truth = makeImage(64, 48, (x) => (x % 6 < 3 ? [200, 200, 200] : [50, 50, 50]));
  const mask = rectMask(64, 48, 0, 0, 12, 10);
  const out = inpaint(stamp(truth, mask, [255, 0, 255]), mask);
  const err = holeError(out, truth, mask);
  assert.ok(err < 25, `mean abs error ${err.toFixed(2)}`);
  // and the magenta object is gone
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) assert.ok(!(out.data[i * 4] > 240 && out.data[i * 4 + 2] > 240 && out.data[i * 4 + 1] < 20));
  }
});

test('never touches pixels outside the mask, and output is opaque', () => {
  const src = makeImage(48, 48, (x, y) => [(x * 5) & 255, (y * 7) & 255, (x * y) & 255]);
  const mask = rectMask(48, 48, 18, 18, 9, 9);
  const out = inpaint(src, mask);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) { assert.equal(out.data[i * 4 + 3], 255); continue; }
    for (let c = 0; c < 4; c++) assert.equal(out.data[i * 4 + c], src.data[i * 4 + c]);
  }
});

test('same seed, same result; inputs are not mutated', () => {
  const src = makeImage(56, 56, (x, y) => [(x * 13) % 256, (y * 9) % 256, ((x + y) * 5) % 256]);
  const before = new Uint8ClampedArray(src.data);
  const mask = rectMask(56, 56, 20, 22, 10, 8);
  const maskCopy = new Uint8Array(mask);
  const a = inpaint(src, mask, { seed: 7 });
  const b = inpaint(src, mask, { seed: 7 });
  assert.deepEqual(a.data, b.data);
  assert.deepEqual(src.data, before);
  assert.deepEqual(mask, maskCopy);
});

test('a mask that swallows every whole patch still returns a smooth fill', () => {
  const src = makeImage(16, 16, () => [90, 90, 90]);
  const mask = new Uint8Array(16 * 16).fill(1);
  for (let x = 0; x < 16; x++) mask[x] = 0; // only the top row is known
  const out = inpaint(src, mask);
  for (let i = 16; i < 256; i++) assert.ok(Math.abs(out.data[i * 4] - 90) <= 1);
});

test('rejects mismatched masks and images smaller than a patch', () => {
  const img = makeImage(20, 20, () => [0, 0, 0]);
  assert.throws(() => inpaint(img, new Uint8Array(10)), /mask size/);
  assert.throws(() => inpaint(makeImage(5, 5, () => [0, 0, 0]), new Uint8Array(25)), /smaller than one patch/);
});

test('inpaintScaled fills big holes at reduced resolution and keeps the rest exact', () => {
  const truth = makeImage(160, 120, (x) => (x % 10 < 5 ? [210, 190, 170] : [60, 50, 40]));
  const mask = rectMask(160, 120, 60, 40, 30, 30);
  const src = stamp(truth, mask, [0, 0, 255]);
  const out = inpaintScaled(src, mask, 0.5);
  assert.equal(out.width, 160);
  assert.equal(out.height, 120);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) { assert.ok(out.data[i * 4 + 2] < 200, 'blue object removed'); continue; }
    for (let c = 0; c < 4; c++) assert.equal(out.data[i * 4 + c], src.data[i * 4 + c]);
  }
  // Half-resolution can't hold 5px stripes perfectly; it should still land near the right tones.
  assert.ok(holeError(out, truth, mask) < 60);
});

test('inpaintScaled at scale 1 is plain inpaint', () => {
  const src = makeImage(40, 40, (x, y) => [x * 6, y * 6, 100]);
  const mask = rectMask(40, 40, 15, 15, 8, 8);
  assert.deepEqual(inpaintScaled(src, mask, 1).data, inpaint(src, mask).data);
});
