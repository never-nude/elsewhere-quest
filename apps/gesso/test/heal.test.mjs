import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AREA_CAP, diskMask, strokeMask, maskBounds, exceedsAreaCap, findSources, solveCorrection, composeRef,
  handleHealMessage,
} from '../lib/heal.js';
import { inpaintScaled, mulberry32 } from '../lib/inpaint.js';
import { strokeBounds } from '../lib/stroke.js';

// ------------------------------------------------------------------ fixtures

function makeImage(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = fn(x, y);
      const i = (y * width + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
  }
  return { width, height, data };
}

// Every pixel independent: only the planted copy can match the target's ring.
function noise(width, height, seed) {
  const rand = mulberry32(seed);
  return makeImage(width, height, () => [rand() * 256, rand() * 256, rand() * 256]);
}

// Copy the block of half-size `half` around (tx + dx, ty + dy) onto (tx, ty), so
// the neighbourhood of the target reappears exactly at offset (dx, dy).
function plant(img, tx, ty, dx, dy, half) {
  const { width: w, height: h } = img;
  const data = new Uint8ClampedArray(img.data);
  for (let y = ty - half; y <= ty + half; y++) {
    for (let x = tx - half; x <= tx + half; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const t = (y * w + x) * 4, s = ((y + dy) * w + x + dx) * 4;
      for (let c = 0; c < 4; c++) data[t + c] = img.data[s + c];
    }
  }
  return { width: w, height: h, data };
}

// Paint an object into the hole, so a search that peeked inside would be fooled.
function blemish(img, mask, rgb = [255, 0, 255]) {
  const data = new Uint8ClampedArray(img.data);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) { data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; }
  }
  return { ...img, data };
}

const count = (mask) => mask.reduce((n, v) => n + (v ? 1 : 0), 0);
const px = (img, x, y, c = 0) => img.data[(y * img.width + x) * 4 + c];

// For each hole pixel next to a non-hole pixel, the jump across that edge.
function boundaryJumps(img, mask) {
  const { width: w, height: h } = img;
  const out = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || mask[ny * w + nx]) continue;
        let d = 0;
        for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(px(img, x, y, c) - px(img, nx, ny, c)));
        out.push(d);
      }
    }
  }
  return out;
}

// Checks a source offset honours the search's contract: the hole plus its ring
// (width 3 for these radii; the ring is clipped where the image ends) lands
// inside the image, and the copied pixels don't come from the hole itself.
function assertFits(mask, w, h, dx, dy, ring = 3) {
  const b = maskBounds(mask, w, h);
  const x0 = Math.max(0, b.x - ring), y0 = Math.max(0, b.y - ring);
  const x1 = Math.min(w - 1, b.x + b.w - 1 + ring), y1 = Math.min(h - 1, b.y + b.h - 1 + ring);
  assert.ok(x0 + dx >= 0 && y0 + dy >= 0 && x1 + dx < w && y1 + dy < h, `in bounds ${dx},${dy}`);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % w, y = (i / w) | 0;
    assert.equal(mask[(y + dy) * w + x + dx], 0, `source ${dx},${dy} overlaps the hole`);
  }
}

// ------------------------------------------------------------------ masks

test('diskMask marks pixel centres within r', () => {
  const m = diskMask(10, 10, 3, 20, 20);
  const b = maskBounds(m, 20, 20);
  assert.deepEqual([b.x, b.y, b.w, b.h], [7, 7, 6, 6]); // centres 7.5..12.5 are within 3 of 10
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      assert.equal(m[y * 20 + x], Math.hypot(x + 0.5 - 10, y + 0.5 - 10) <= 3 ? 1 : 0);
    }
  }
  const big = diskMask(50.5, 50.5, 30, 101, 101);
  assert.ok(Math.abs(count(big) - Math.PI * 900) / (Math.PI * 900) < 0.01);
});

test('diskMask clips at the edges and degrades gracefully', () => {
  const m = diskMask(0, 0, 5, 16, 16);
  assert.deepEqual(maskBounds(m, 16, 16), { x: 0, y: 0, w: 5, h: 5, area: count(m) });
  assert.equal(count(diskMask(-50, 5, 5, 16, 16)), 0); // wholly off the image
  assert.equal(count(diskMask(5, 5, 0, 16, 16)), 0);
  assert.equal(count(diskMask(5, 5, -1, 16, 16)), 0);
  assert.equal(count(diskMask(NaN, 5, 3, 16, 16)), 0);
  assert.equal(count(diskMask(5, 5, Infinity, 16, 16)), 0);
  // A sub-pixel brush still marks the pixel under it.
  const tiny = diskMask(5, 5, 0.1, 16, 16);
  assert.equal(count(tiny), 1);
  assert.equal(tiny[5 * 16 + 5], 1);
  assert.equal(diskMask(1, 1, 1, 0, 0).length, 0);
  assert.throws(() => diskMask(1, 1, 1, 2.5, 4), RangeError);
  assert.throws(() => diskMask(1, 1, 1, -1, 4), RangeError);
});

test('strokeMask is the union of discs along the whole polyline, gap-free at any spacing', () => {
  const pts = [5, 5, 45, 12, 30, 38];
  const r = 2.5;
  const m = strokeMask(pts, r, 50, 45);
  // Every disc centred anywhere on the path is inside the mask...
  const dense = new Uint8Array(50 * 45);
  const denser = new Uint8Array(50 * 45);
  for (let i = 2; i < pts.length; i += 2) {
    const len = Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
    for (let s = 0; s <= len; s += 0.05) {
      const x = pts[i - 2] + ((pts[i] - pts[i - 2]) * s) / len, y = pts[i - 1] + ((pts[i + 1] - pts[i - 1]) * s) / len;
      diskMask(x, y, r, 50, 45).forEach((v, k) => { if (v) dense[k] = 1; });
      diskMask(x, y, r + 0.06, 50, 45).forEach((v, k) => { if (v) denser[k] = 1; });
    }
  }
  for (let k = 0; k < m.length; k++) {
    if (dense[k]) assert.equal(m[k], 1, `missing pixel ${k}`);
    if (m[k]) assert.equal(denser[k], 1, `extra pixel ${k}`);
  }
  // ...and extra collinear points change nothing.
  assert.deepEqual(strokeMask([5, 5, 45, 12], r, 50, 45), strokeMask([5, 5, 25, 8.5, 45, 12], r, 50, 45));
});

test('strokeMask: single point is a disc; empty and bad input give an empty mask', () => {
  assert.deepEqual(strokeMask([12, 9], 4, 30, 20), diskMask(12, 9, 4, 30, 20));
  assert.equal(count(strokeMask([], 4, 30, 20)), 0);
  assert.equal(count(strokeMask(null, 4, 30, 20)), 0);
  assert.equal(count(strokeMask([1, 1, 20, 1], 0, 30, 20)), 0);
  assert.equal(count(strokeMask([1, 1, 20, 1], NaN, 30, 20)), 0);
  assert.deepEqual(strokeMask([12, 9, NaN, 3], 4, 30, 20), diskMask(12, 9, 4, 30, 20));
  assert.equal(count(strokeMask([-100, -100, -200, -50], 3, 30, 20)), 0);
});

test('maskBounds: tight box and pixel count, null when empty, sizes checked', () => {
  const m = new Uint8Array(40 * 30);
  m[5 * 40 + 7] = 1; m[9 * 40 + 20] = 3; m[6 * 40 + 9] = 255;
  assert.deepEqual(maskBounds(m, 40, 30), { x: 7, y: 5, w: 14, h: 5, area: 3 });
  assert.equal(maskBounds(new Uint8Array(40 * 30), 40, 30), null);
  assert.equal(maskBounds(new Uint8Array(0), 0, 0), null);
  assert.throws(() => maskBounds(new Uint8Array(10), 40, 30), RangeError);
  // The GPU's tile box (strokeBounds) always contains the rasterized mask.
  const pts = [10.3, 4.8, 17.9, 20.2];
  const b = maskBounds(strokeMask(pts, 3.2, 40, 30), 40, 30);
  const s = strokeBounds(pts, 3.2);
  assert.ok(s.x <= b.x && s.y <= b.y && s.x + s.w >= b.x + b.w && s.y + s.h >= b.y + b.h);
});

test('the area cap is 20% of the photo, measured by bounding box', () => {
  assert.equal(AREA_CAP, 0.2);
  assert.equal(exceedsAreaCap({ x: 0, y: 0, w: 200, h: 100 }, 1000, 100), false); // exactly 20%
  assert.equal(exceedsAreaCap({ x: 0, y: 0, w: 201, h: 100 }, 1000, 100), true);
  assert.equal(exceedsAreaCap({ x: 700, y: 20, w: 150, h: 80 }, 1000, 100), false);
  assert.equal(exceedsAreaCap(null, 1000, 100), false);
  // Only the part on the photo counts: a rub along the edge that strays 60 px
  // past it fills a 16% strip, not the 28% its unclipped box suggests.
  const edge = strokeBounds([-50, 20, -50, 980], 10); // x -60..-40: entirely off the photo
  assert.equal(exceedsAreaCap(edge, 1000, 1000), false);
  const stray = strokeBounds([150, 0, 150, 1000, -100, 1000], 10); // 160 px of it on the photo
  assert.equal(stray.w * stray.h > 0.2 * 1000 * 1000, true);
  assert.equal(exceedsAreaCap(stray, 1000, 1000), false);
  assert.equal(exceedsAreaCap({ x: -100, y: 0, w: 320, h: 1000 }, 1000, 1000), true); // 220 px on
  // A size-only rect is taken as given.
  assert.equal(exceedsAreaCap({ w: 500, h: 500 }, 1000, 1000), true);
  assert.equal(exceedsAreaCap({ w: 400, h: 500 }, 1000, 1000), false);
});

// ------------------------------------------------------------------ search

test('findSources finds a planted copy of the surroundings', () => {
  const [tx, ty, dx, dy] = [60, 70, 45, -30];
  const base = plant(noise(160, 160, 1), tx, ty, dx, dy, 24);
  const mask = diskMask(tx, ty, 10, 160, 160);
  const img = blemish(base, mask);
  const found = findSources(img, mask);
  assert.deepEqual([found[0].dx, found[0].dy], [dx, dy]);
  // A perfect ring match leaves only the distance penalty.
  assert.ok(Math.abs(found[0].score - 0.002 * (dx * dx + dy * dy)) < 1e-6);
});

test('findSources finds the planted offset for a rubbed (stroke) mask, at a coarse pyramid level', () => {
  const [dx, dy] = [-70, 52];
  const base = plant(noise(256, 256, 2), 150, 100, dx, dy, 50);
  const mask = strokeMask([125, 90, 150, 100, 172, 112], 9, 256, 256);
  const found = findSources(blemish(base, mask, [0, 0, 0]), mask);
  assert.deepEqual([found[0].dx, found[0].dy], [dx, dy]);
});

test('findSources alternatives are distinct, sorted, in bounds and clear of the hole', () => {
  const img = noise(128, 128, 3);
  const r = 8;
  const mask = diskMask(64, 64, r, 128, 128);
  const found = findSources(img, mask, { maxResults: 4 });
  assert.equal(found.length, 4);
  for (let i = 1; i < found.length; i++) assert.ok(found[i].score >= found[i - 1].score);
  for (let i = 0; i < found.length; i++) {
    assertFits(mask, 128, 128, found[i].dx, found[i].dy);
    for (let j = 0; j < i; j++) {
      assert.ok(Math.hypot(found[i].dx - found[j].dx, found[i].dy - found[j].dy) >= 0.5 * r - 1e-9);
    }
  }
  assert.equal(findSources(img, mask, { maxResults: 1 }).length, 1);
  assert.deepEqual(findSources(img, mask, { maxResults: 1 })[0], found[0]);
  assert.deepEqual(findSources(img, mask, { maxResults: 0 }), []);
  assert.deepEqual(findSources(img, mask, { maxResults: NaN }), []);
});

test('findSources handles a hole on the image border', () => {
  const [dx, dy] = [40, 6];
  const base = plant(noise(96, 96, 4), 3, 40, dx, dy, 16);
  const mask = diskMask(3, 40, 6, 96, 96);
  const found = findSources(blemish(base, mask), mask);
  assert.ok(found.length > 0);
  assert.deepEqual([found[0].dx, found[0].dy], [dx, dy]);
  for (const f of found) assertFits(mask, 96, 96, f.dx, f.dy);
  // A corner hole too.
  const corner = diskMask(0, 0, 7, 96, 96);
  for (const f of findSources(noise(96, 96, 5), corner)) assertFits(corner, 96, 96, f.dx, f.dy);
});

test('findSources: nothing to search gives []', () => {
  const img = noise(64, 48, 6);
  assert.deepEqual(findSources(img, new Uint8Array(64 * 48)), []);
  assert.deepEqual(findSources(img, new Uint8Array(64 * 48).fill(1)), []);
  // A hole so big no shifted copy of it fits in the image.
  assert.deepEqual(findSources(img, diskMask(32, 24, 22, 64, 48)), []);
  assert.deepEqual(findSources({ width: 0, height: 0, data: new Uint8ClampedArray(0) }, new Uint8Array(0)), []);
  assert.throws(() => findSources(img, new Uint8Array(5)), RangeError);
  assert.throws(() => findSources({ width: 4, height: 4, data: new Uint8ClampedArray(3) }, new Uint8Array(16)), RangeError);
  assert.throws(() => findSources(null, new Uint8Array(0)), TypeError);
});

test('findSources is deterministic and leaves its inputs alone', () => {
  const img = blemish(noise(120, 90, 7), diskMask(50, 40, 7, 120, 90));
  const mask = diskMask(50, 40, 7, 120, 90);
  const data = new Uint8ClampedArray(img.data), m = new Uint8Array(mask);
  const a = findSources(img, mask), b = findSources(img, mask);
  assert.deepEqual(a, b);
  assert.deepEqual(img.data, data);
  assert.deepEqual(mask, m);
});

test('findSources continues structure: a spot on the horizon heals from along the horizon', () => {
  const rand = mulberry32(21);
  const img = makeImage(220, 120, (x, y) => {
    const n = (rand() - 0.5) * 16;
    return y < 60 ? [120 + y + n, 160 + y + n, 230 + n] : [110 + n, 80 + n, 50 + n];
  });
  const mask = diskMask(110, 60, 8, 220, 120);
  const found = findSources(blemish(img, mask), mask);
  assert.equal(found.length, 4);
  for (const f of found) assert.ok(Math.abs(f.dy) <= 1, `source ${f.dx},${f.dy} leaves the horizon`);
});

test('findSources prefers a nearby match when two are equally good', () => {
  // Flat colour: every ring matches perfectly, so the distance penalty decides.
  const img = makeImage(100, 100, () => [90, 120, 150]);
  const mask = diskMask(50, 50, 6, 100, 100);
  const [best] = findSources(img, mask);
  const d = Math.hypot(best.dx, best.dy);
  // The nearest offset that clears the dilated hole is about two (radius + ring) away.
  assert.ok(d >= 2 * (6 + 3) - 2 && d <= 2 * (6 + 3) + 3, `distance ${d}`);
});

test('findSources falls back to finer levels when the only room is off the coarse grid', () => {
  // A 2.5 px wire along a 22 px strip: its pyramid is 2 levels deep (by length),
  // and the one offset that fits, straight down by 11, is odd, so no coarse scan
  // visits it. It used to come back [] here.
  const strip = noise(140, 22, 1);
  const wire = strokeMask([4, 5.5, 134, 5.5], 2.5, 140, 22);
  assert.deepEqual(findSources(strip, wire).map((f) => [f.dx, f.dy]), [[0, 11]]);
  // A big spot in a tight region: the valid offsets miss the 2-px coarse grid.
  const img = noise(167, 84, 1);
  const spot = diskMask(43, 42, 33, 167, 84);
  const found = findSources(img, spot);
  assert.ok(found.length > 0, 'a source that fits exists');
  for (const f of found) assertFits(spot, 167, 84, f.dx, f.dy, 8);
});

test('findSources never looks inside the hole: what is painted there cannot change the answer', () => {
  // The coarse scan blurs before scoring. A plain blur smeared the object into
  // the inner ring, so a black or white blemish steered the search to different
  // (worse) sources. Every fill of the hole must give the very same result.
  const rand = mulberry32(3);
  const img = makeImage(128, 128, (x, y) => {
    const v = 120 + 50 * Math.sin(0.11 * x) * Math.cos(0.17 * y), e = (rand() - 0.5) * 14;
    return [v + e, 0.8 * v + e, 0.6 * v + 30 + e];
  });
  const mask = diskMask(64, 64, 19, 128, 128); // deep enough for a coarse level
  const want = findSources(img, mask);
  assert.equal(want.length, 4);
  assert.deepEqual(findSources(blemish(img, mask, [0, 0, 0]), mask), want);
  assert.deepEqual(findSources(blemish(img, mask, [255, 255, 255]), mask), want);
  const junk = noise(128, 128, 30);
  const mixed = new Uint8ClampedArray(img.data);
  for (let i = 0; i < mask.length; i++) if (mask[i]) for (let c = 0; c < 4; c++) mixed[i * 4 + c] = junk.data[i * 4 + c];
  assert.deepEqual(findSources({ ...img, data: mixed }, mask), want);
});

test('findSources: a hole too big to copy from anywhere gives [] promptly', () => {
  // Every pyramid level is scanned before giving up, down to full resolution, so
  // the overlap test must stay cheap for a hole of ~200k pixels.
  const img = noise(768, 768, 31);
  const mask = diskMask(384, 384, 190, 768, 768);
  const t0 = performance.now();
  assert.deepEqual(findSources(img, mask), []);
  const ms = performance.now() - t0;
  assert.ok(ms < 2000, `took ${ms.toFixed(0)}ms`); // ~80 ms measured; seconds if it walks every pixel
});

test('findSources: maxResults null means the default, as in the worker', () => {
  const img = noise(128, 128, 3);
  const mask = diskMask(64, 64, 8, 128, 128);
  assert.deepEqual(findSources(img, mask, { maxResults: null }), findSources(img, mask));
  assert.equal(findSources(img, mask, { maxResults: null }).length, 4);
});

test('findSources on a 512x512 region with a 40px-radius hole is fast', () => {
  const base = plant(noise(512, 512, 8), 256, 256, 150, 40, 70);
  const mask = diskMask(256, 256, 40, 512, 512);
  const img = blemish(base, mask);
  findSources(img, mask); // warm up the JIT
  const t0 = performance.now();
  const found = findSources(img, mask);
  const ms = performance.now() - t0;
  assert.deepEqual([found[0].dx, found[0].dy], [150, 40]);
  // Target is ~50ms (about 20ms measured); the bound is loose so a busy CI box doesn't flake.
  assert.ok(ms < 400, `took ${ms.toFixed(1)}ms`);
});

// ------------------------------------------------------------------ seam correction

test('solveCorrection: a linear ramp heals exactly (the copy is just brighter)', () => {
  const img = makeImage(64, 64, (x, y) => [40 + x + y, 30 + x, 200 - y]);
  const mask = diskMask(30, 32, 8, 64, 64);
  const [dx, dy] = [20, 5];
  const corr = solveCorrection(img, mask, dx, dy);
  assert.equal(corr.length, 64 * 64 * 3);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const want = [-(dx + dy), -dx, dy];
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(corr[i * 3 + c] - want[c]) < 0.01, `pixel ${i}`);
  }
  const out = composeRef(img, mask, dx, dy, corr, 0);
  for (let i = 0; i < mask.length; i++) for (let c = 0; c < 4; c++) assert.ok(Math.abs(out.data[i * 4 + c] - img.data[i * 4 + c]) <= 1);
});

test('solveCorrection converges to the true membrane for a non-trivial boundary', () => {
  // x² − y² is harmonic on the pixel grid, so it's exactly what the solver must
  // reach from boundary values alone. The copy region is flat grey.
  for (const r of [12, 40]) {
    const W = 4 * (r + 4), H = 2 * (r + 4), cx = r + 4, cy = r + 4;
    const f = (x, y) => ((x - cx) ** 2 - (y - cy) ** 2) / (r / 3);
    const img = makeImage(W, H, (x, y) => {
      if (x >= W / 2) return [100, 100, 100];
      const v = 128 + f(x, y);
      return [v, 255 - v, 128];
    });
    const mask = diskMask(cx, cy, r, W, H);
    const corr = solveCorrection(img, mask, W / 2, 0);
    let worst = 0;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const x = i % W, y = (i / W) | 0;
      // Rounding the boundary to bytes moves the true answer by at most 0.5.
      worst = Math.max(worst, Math.abs(corr[i * 3] - (28 + f(x, y))), Math.abs(corr[i * 3 + 1] - (27 - f(x, y))));
    }
    assert.ok(worst < 1, `r=${r}: worst error ${worst.toFixed(3)}`);
  }
});

test('solveCorrection makes the seam invisible on a gradient where a plain copy jumps', () => {
  // Left: a gentle ramp. Right: a brighter area with a curved shading.
  const img = makeImage(128, 64, (x, y) => {
    if (x < 64) return [60 + 0.8 * x, 50 + 0.5 * y, 90];
    return [150 + 0.02 * (y - 32) ** 2, 120 + 0.3 * x, 60 + 0.01 * (x - 96) ** 2];
  });
  const mask = diskMask(32, 32, 12, 128, 64);
  const plain = composeRef(img, mask, 64, 0, null, 0);
  const healed = composeRef(img, mask, 64, 0, solveCorrection(img, mask, 64, 0), 0);
  const before = Math.max(...boundaryJumps(plain, mask));
  const after = Math.max(...boundaryJumps(healed, mask));
  assert.ok(before > 40, `plain copy jump ${before}`);
  assert.ok(after <= 2, `healed jump ${after}`);
});

test('solveCorrection: Neumann at the image edge, so an edge hole isn\'t dragged to zero', () => {
  const img = makeImage(80, 40, (x, y) => [50 + x + y, 50, 50]);
  const mask = diskMask(0, 20, 9, 80, 40);
  const corr = solveCorrection(img, mask, 30, 0);
  for (let i = 0; i < mask.length; i++) if (mask[i]) assert.ok(Math.abs(corr[i * 3] + 30) < 0.01 && Math.abs(corr[i * 3 + 1]) < 0.01);
  // Outside the hole the correction is exactly target − copy (the source clamps at the edge).
  assert.equal(corr[(5 * 80 + 10) * 3], -30);
  assert.equal(corr[(5 * 80 + 79) * 3], 0); // copy clamped onto itself
});

test('solveCorrection: empty, full and odd inputs', () => {
  const img = makeImage(20, 10, (x) => [x * 10, 0, 0]);
  const none = solveCorrection(img, new Uint8Array(200), 3, 0);
  assert.equal(none[0], -30);
  const full = solveCorrection(img, new Uint8Array(200).fill(1), 3, 0);
  assert.ok(full.every((v) => v === 0), 'no boundary data: no correction');
  // Offsets off the image clamp instead of throwing; fractional ones round.
  const mask = diskMask(10, 5, 3, 20, 10);
  assert.ok(solveCorrection(img, mask, 500, -500).every(Number.isFinite));
  assert.deepEqual(solveCorrection(img, mask, 2.6, 0), solveCorrection(img, mask, 3, 0));
  assert.throws(() => solveCorrection(img, mask, NaN, 0), RangeError);
  assert.throws(() => solveCorrection(img, new Uint8Array(3), 1, 0), RangeError);
  // iters: 0 still returns a finite first guess; huge counts stop at convergence.
  assert.ok(solveCorrection(img, mask, 3, 0, { iters: 0 }).every(Number.isFinite));
  assert.ok(solveCorrection(img, mask, 3, 0, { iters: 1e9 }).every(Number.isFinite));
  assert.deepEqual(solveCorrection(img, mask, 3, 0, { iters: NaN }), solveCorrection(img, mask, 3, 0));
});

test('a long hairline hole: search stays valid and the solve stays seamless', () => {
  // One pixel wide and 150 long: the coarse solve has no unknowns at all, and the
  // search's pyramid depth comes from length, not thickness.
  const img = makeImage(200, 120, (x, y) => [40 + 0.5 * x + 0.3 * y, 90 + 0.2 * y, 140]);
  const mask = new Uint8Array(200 * 120);
  for (let x = 25; x < 175; x++) mask[60 * 200 + x] = 1;
  const found = findSources(blemish(img, mask), mask);
  assert.ok(found.length > 0);
  for (const f of found) assertFits(mask, 200, 120, f.dx, f.dy);
  const { dx, dy } = found[0];
  const out = composeRef(img, mask, dx, dy, solveCorrection(img, mask, dx, dy), 0);
  for (let x = 25; x < 175; x++) assert.ok(Math.abs(px(out, x, 60) - px(img, x, 60)) <= 1, `x=${x}`);
});

test('solveCorrection is deterministic and leaves its inputs alone', () => {
  const img = noise(70, 50, 9);
  const mask = strokeMask([10, 10, 30, 25, 22, 40], 4, 70, 50);
  const data = new Uint8ClampedArray(img.data), m = new Uint8Array(mask);
  assert.deepEqual(solveCorrection(img, mask, 40, 2), solveCorrection(img, mask, 40, 2));
  assert.deepEqual(img.data, data);
  assert.deepEqual(mask, m);
});

// ------------------------------------------------------------------ compose

test('composeRef never touches pixels outside the hole and makes the hole opaque', () => {
  const img = makeImage(48, 40, (x, y) => [x * 5, y * 6, (x * y) & 255, 77]);
  const mask = strokeMask([10, 10, 25, 20], 4, 48, 40);
  const corr = solveCorrection(img, mask, 18, 12);
  for (const feather of [0, 2, 5]) {
    const out = composeRef(img, mask, 18, 12, corr, feather);
    assert.equal(out.width, 48);
    assert.equal(out.height, 40);
    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) { assert.equal(out.data[i * 4 + 3], 255); continue; }
      for (let c = 0; c < 4; c++) assert.equal(out.data[i * 4 + c], img.data[i * 4 + c]);
    }
  }
});

test('composeRef: copy + correction inside, feathered inward from the edge', () => {
  const img = makeImage(40, 40, (x) => (x < 20 ? [10, 10, 10] : [210, 110, 60]));
  const mask = diskMask(8, 20, 5, 40, 40);
  const hard = composeRef(img, mask, 22, 0, null, 0);
  const soft = composeRef(img, mask, 22, 0, null, 2);
  // Centre: fully the copy. Rim pixel (1px in): halfway between original and copy.
  assert.deepEqual([px(hard, 8, 20, 0), px(soft, 8, 20, 0)], [210, 210]);
  assert.equal(mask[20 * 40 + 3], 1);
  assert.equal(mask[20 * 40 + 2], 0);
  assert.equal(px(soft, 3, 20, 0), 110);
  assert.equal(px(hard, 3, 20, 0), 210);
  // A correction adds on top of the copy (and clamps to bytes).
  const corr = new Float32Array(40 * 40 * 3).fill(-500);
  assert.equal(px(composeRef(img, mask, 22, 0, corr, 0), 8, 20, 0), 0);
  const plus = new Float32Array(40 * 40 * 3).fill(12.4);
  assert.equal(px(composeRef(img, mask, 22, 0, plus, 0), 8, 20, 1), 122);
});

test('composeRef: degenerate inputs', () => {
  const img = makeImage(16, 16, (x, y) => [x * 16, y * 16, 0]);
  const empty = composeRef(img, new Uint8Array(256), 3, 3, null);
  assert.deepEqual(empty.data, img.data);
  assert.notEqual(empty.data, img.data);
  // Off-image offsets repeat the edge pixels.
  const mask = diskMask(8, 8, 3, 16, 16);
  const off = composeRef(img, mask, 100, 0, null, 0);
  assert.equal(px(off, 8, 8, 0), 240);
  assert.throws(() => composeRef(img, mask, 1, 1, new Float32Array(5)), RangeError);
  assert.throws(() => composeRef(img, new Uint8Array(4), 1, 1, null), RangeError);
  assert.throws(() => composeRef(img, mask, Infinity, 1, null), RangeError);
  // Whole image masked: nothing to fade towards, so no feather and no NaN.
  const all = composeRef(img, new Uint8Array(256).fill(1), 0, 0, null, 2);
  assert.deepEqual(all.data, img.data);
});

// ------------------------------------------------------------------ worker protocol

test('handleHealMessage: find', () => {
  const base = plant(noise(100, 100, 10), 40, 50, 30, 10, 18);
  const mask = diskMask(40, 50, 6, 100, 100);
  const img = blemish(base, mask);
  const { message, transfer } = handleHealMessage({ type: 'find', job: 7, img, mask, maxResults: 3 });
  assert.equal(message.type, 'found');
  assert.equal(message.job, 7);
  assert.deepEqual(message.sources, findSources(img, mask, { maxResults: 3 }));
  assert.deepEqual([message.sources[0].dx, message.sources[0].dy], [30, 10]);
  assert.deepEqual(transfer, []);
});

test('handleHealMessage: correct returns the composed tile, transferable', () => {
  const img = noise(60, 50, 11);
  const mask = diskMask(20, 25, 5, 60, 50);
  const { message, transfer } = handleHealMessage({ type: 'correct', job: 'a', img, mask, dx: 24.2, dy: -3 });
  assert.equal(message.type, 'corrected');
  assert.equal(message.job, 'a');
  assert.deepEqual([message.dx, message.dy], [24, -3]);
  const want = composeRef(img, mask, 24, -3, solveCorrection(img, mask, 24, -3), 2);
  assert.deepEqual(message.tile, want);
  assert.deepEqual(transfer, [message.tile.data.buffer]);
  assert.notEqual(message.tile.data.buffer, img.data.buffer);
});

test('handleHealMessage: inpaint runs PatchMatch through inpaintScaled', () => {
  const img = makeImage(48, 48, (x) => (x % 6 < 3 ? [200, 180, 160] : [40, 50, 60]));
  const mask = diskMask(24, 24, 5, 48, 48);
  const { message, transfer } = handleHealMessage({ type: 'inpaint', job: 3, img, mask, scale: 0.5, seed: 9 });
  assert.equal(message.type, 'inpainted');
  assert.equal(message.job, 3);
  assert.deepEqual(message.tile, inpaintScaled(img, mask, 0.5, { seed: 9 }));
  assert.deepEqual(transfer, [message.tile.data.buffer]);
  // No seed or scale: inpaint's own defaults at full resolution.
  const plain = handleHealMessage({ type: 'inpaint', job: 4, img, mask }).message;
  assert.deepEqual(plain.tile, inpaintScaled(img, mask, 1));
  // A broken scale is an error, not a fill from a 7x7 thumbnail.
  for (const scale of [0, -0.5, NaN, Infinity]) {
    const { message, transfer } = handleHealMessage({ type: 'inpaint', job: 5, img, mask, scale });
    assert.equal(message.type, 'error', `scale ${scale}`);
    assert.match(message.message, /bad scale/);
    assert.deepEqual(transfer, []);
  }
});

test('handleHealMessage accepts transferred ArrayBuffers', () => {
  const img = noise(40, 40, 12);
  const mask = diskMask(20, 20, 4, 40, 40);
  const msg = {
    type: 'correct', job: 1, dx: 12, dy: 0,
    img: { width: 40, height: 40, data: img.data.slice().buffer }, mask: mask.slice().buffer,
  };
  const { message } = handleHealMessage(msg);
  assert.equal(message.type, 'corrected');
  assert.deepEqual(message.tile.data, composeRef(img, mask, 12, 0, solveCorrection(img, mask, 12, 0)).data);
});

test('handleHealMessage turns every failure into an error message and never throws', () => {
  const img = noise(20, 20, 13);
  const mask = diskMask(10, 10, 3, 20, 20);
  const cases = [
    [{ type: 'nope', job: 1, img, mask }, /unknown heal message type/],
    [{ type: 'find', job: 2, mask }, /img/],
    [{ type: 'find', job: 3, img, mask: new Uint8Array(4) }, /mask size/],
    [{ type: 'find', job: 4, img, mask: [1, 2, 3] }, /Uint8Array/],
    [{ type: 'correct', job: 5, img, mask, dx: NaN, dy: 0 }, /offset/],
    [{ type: 'inpaint', job: 6, img: noise(4, 4, 1), mask: new Uint8Array(16) }, /smaller than one patch/],
    [{ type: 'inpaint', job: 7, img, mask: new Uint8Array(3) }, /mask size/],
  ];
  for (const [msg, re] of cases) {
    const { message, transfer } = handleHealMessage(msg);
    assert.equal(message.type, 'error');
    assert.equal(message.job, msg.job);
    assert.match(message.message, re);
    assert.deepEqual(transfer, []);
  }
  for (const bad of [null, undefined, 42, 'find']) {
    const { message } = handleHealMessage(bad);
    assert.equal(message.type, 'error');
    assert.equal(message.job, undefined);
  }
});
