import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_SPACING, MAX_POINTS, cleanPoints, resample, smooth, dabs, strokeBounds } from '../lib/stroke.js';
import { mulberry32 } from '../lib/inpaint.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const pairs = (flat) => {
  const out = [];
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
};
const gaps = (flat) => {
  const p = pairs(flat);
  return p.slice(1).map(([x, y], i) => Math.hypot(x - p[i][0], y - p[i][1]));
};

// Distance from (x, y) to the nearest point of the polyline.
function distToPolyline(pts, x, y) {
  let best = Infinity;
  for (let i = 2; i < pts.length; i += 2) {
    const ax = pts[i - 2], ay = pts[i - 1], vx = pts[i] - ax, vy = pts[i + 1] - ay;
    const l2 = vx * vx + vy * vy;
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - ax - t * vx, y - ay - t * vy));
  }
  return best;
}

function randomWalk(seed, n) {
  const rand = mulberry32(seed);
  const pts = [50, 50];
  for (let i = 1; i < n; i++) pts.push(pts[2 * i - 2] + (rand() - 0.5) * 12, pts[2 * i - 1] + (rand() - 0.5) * 12);
  return pts;
}

test('cleanPoints drops non-finite pairs and a dangling odd value', () => {
  assert.deepEqual(cleanPoints([1, 2, NaN, 3, 4, Infinity, 5, 6, 7]), [1, 2, 5, 6]);
  assert.deepEqual(cleanPoints(null), []);
  assert.deepEqual(cleanPoints(new Float32Array([1, 2, 3, 4])), [1, 2, 3, 4]);
});

test('resample spaces points evenly and keeps both ends exactly', () => {
  assert.deepEqual(resample([0, 0, 10, 0], 2.5), [0, 0, 2.5, 0, 5, 0, 7.5, 0, 10, 0]);
  // 10 / 3 doesn't divide: four equal gaps of 2.5, never wider than asked.
  const r = resample([0, 0, 10, 0], 3);
  assert.equal(r.length, 10);
  for (const g of gaps(r)) assert.ok(near(g, 2.5, 1e-9));
  // An L-shaped path: equal gaps along the path, every point on it.
  const L = [0, 0, 12, 0, 12, 9];
  const out = resample(L, 2);
  assert.deepEqual(out.slice(0, 2), [0, 0]);
  assert.deepEqual(out.slice(-2), [12, 9]);
  for (const [x, y] of pairs(out)) assert.ok(distToPolyline(L, x, y) < 1e-9);
  // Points straddling the corner are closer than the path step: compare path length instead.
  assert.equal(out.length / 2 - 1, Math.ceil(21 / 2));
});

test('resample: degenerate inputs', () => {
  assert.deepEqual(resample([], 2), []);
  assert.deepEqual(resample([3, 4], 2), [3, 4]);
  assert.deepEqual(resample([3, 4, 3, 4, 3, 4], 2), [3, 4]); // zero-length stroke
  assert.deepEqual(resample([0, 0, 1, 0], 5), [0, 0, 1, 0]); // shorter than one step
  assert.deepEqual(resample([0, 0, NaN, 1, 4, 0], 2), [0, 0, 2, 0, 4, 0]);
  assert.throws(() => resample([0, 0, 1, 1], 0), RangeError);
  assert.throws(() => resample([0, 0, 1, 1], -1), RangeError);
  assert.throws(() => resample([0, 0, 1, 1], NaN), RangeError);
  // A silly spacing is floored rather than allocating millions of points...
  assert.equal(resample([0, 0, 100, 0], 1e-9).length / 2, 100 / MIN_SPACING + 1);
  // ...and an absurd length is capped, still evenly, still ending on the last point.
  const huge = resample([0, 0, 1e12, 0], 1);
  assert.ok(huge.length / 2 <= 1 << 20);
  assert.deepEqual(huge.slice(-2), [1e12, 0]);
  const g = gaps(huge);
  assert.ok(near(g[0], g[g.length - 1], 1));
});

test('smooth keeps the ends, leaves straight evenly-spaced lines alone and calms jitter', () => {
  const line = [0, 0, 1, 1, 2, 2, 3, 3];
  assert.deepEqual(smooth(line, 1), line);
  const zig = [0, 0, 1, 2, 2, 0, 3, 2, 4, 0];
  const s = smooth(zig, 0.5);
  assert.deepEqual(s.slice(0, 2), [0, 0]);
  assert.deepEqual(s.slice(-2), [4, 0]);
  // Interior y moved halfway to its neighbours' midpoint: 2 -> 1, 0 -> 1.
  assert.deepEqual(pairs(s).slice(1, 4).map(([, y]) => y), [1, 1, 1]);
  assert.deepEqual(smooth(zig, 1).slice(2, 4), [1, 0]);
});

test('smooth: amount is clamped, zero is a copy, short strokes pass through, input untouched', () => {
  const zig = [0, 0, 1, 2, 2, 0];
  const copy = zig.slice();
  const z = smooth(zig, 0);
  assert.deepEqual(z, zig);
  assert.notEqual(z, zig);
  assert.deepEqual(smooth(zig, 7), smooth(zig, 1));
  assert.deepEqual(smooth(zig, -3), zig);
  assert.deepEqual(smooth(zig, NaN), zig);
  assert.deepEqual(smooth([1, 2, 3, 4], 1), [1, 2, 3, 4]);
  assert.deepEqual(smooth([], 1), []);
  assert.deepEqual(zig, copy);
});

test('dabs are spaced by distance along the path, starting on the first point', () => {
  const d = dabs([0, 0, 10, 0], 4); // step 1
  assert.equal(d.length, 22);
  pairs(d).forEach(([x, y], i) => assert.ok(near(x, i) && y === 0));
  // Spacing carries across corners: every dab sits a whole number of steps along the path.
  const path = [0, 0, 2.5, 0, 2.5, 3.7, 9, 3.7];
  const dd = dabs(path, 8, 0.25); // step 2
  assert.deepEqual(dd.slice(0, 2), [0, 0]);
  const along = pairs(dd).map(([x, y]) => (y === 0 ? x : x === 2.5 ? 2.5 + y : 6.2 + (x - 2.5)));
  along.forEach((s, i) => assert.ok(near(s, 2 * i, 1e-9), `dab ${i} at ${s}`));
  assert.ok(12.2 - along[along.length - 1] < 2, 'the lift lands within one step of the last dab');
});

test('dabs do not depend on how many events the finger sent', () => {
  const sparse = dabs([0, 0, 30, 40], 6);
  const dense = [];
  for (let i = 0; i <= 1000; i++) dense.push(0.03 * i, 0.04 * i);
  const fromDense = dabs(dense, 6);
  assert.equal(fromDense.length, sparse.length);
  for (let i = 0; i < sparse.length; i++) assert.ok(near(sparse[i], fromDense[i], 1e-6));
  // A finger resting still produces one dab, not one per event.
  assert.deepEqual(dabs([5, 5, 5, 5, 5, 5, 5.01, 5], 20), [5, 5]);
});

test('dabs are prefix-stable, so a live stroke can paint only its new dabs', () => {
  const pts = randomWalk(11, 60);
  const full = dabs(pts, 9);
  for (let k = 1; k <= 60; k++) {
    const part = dabs(pts.slice(0, 2 * k), 9);
    assert.deepEqual(part, full.slice(0, part.length), `prefix of ${k} points`);
  }
});

test('dabs: degenerate inputs', () => {
  assert.deepEqual(dabs([], 5), []);
  assert.deepEqual(dabs([7, 8], 5), [7, 8]);
  assert.deepEqual(dabs([0, 0, 10, 0], 0), []);
  assert.deepEqual(dabs([0, 0, 10, 0], -2), []);
  assert.deepEqual(dabs([0, 0, 10, 0], NaN), []);
  assert.deepEqual(dabs([0, 0, 10, 0], Infinity), []);
  assert.throws(() => dabs([0, 0, 10, 0], 5, 0), RangeError);
  assert.throws(() => dabs([0, 0, 10, 0], 5, NaN), RangeError);
  // Spacing is floored at MIN_SPACING for tiny brushes.
  assert.equal(dabs([0, 0, 10, 0], 0.1).length / 2, 10 / MIN_SPACING + 1);
  // Bad events are skipped, not propagated.
  assert.deepEqual(dabs([0, 0, NaN, NaN, 4, 0], 8), [0, 0, 2, 0, 4, 0]);
});

test('dabs: a corrupt huge stroke is capped instead of exhausting memory', () => {
  // One stored coordinate at 1e9 used to mean 4e9 dabs: the replay ran out of
  // memory. The cap only cuts the tail, so the dabs that are kept are unchanged.
  const t0 = performance.now();
  const d = dabs([0, 0, 1e9, 0], 1);
  assert.ok(performance.now() - t0 < 2000);
  assert.equal(d.length / 2, MAX_POINTS);
  pairs(d.slice(0, 8)).forEach(([x, y], i) => assert.ok(near(x, 0.25 * i, 1e-9) && y === 0));
  assert.ok(near(d[d.length - 2], (MAX_POINTS - 1) * 0.25, 1e-6));
  // Coordinates near ±1e308: every dab stays finite and on its segment, and a
  // segment whose length overflows to Infinity gets no dabs at all.
  const o = dabs([0, 0, -1e308, 0, 1e308, 0, 1e308, 2], 4);
  assert.ok(o.every(Number.isFinite));
  assert.deepEqual(o.slice(0, 2), [0, 0]);
  assert.ok(near(o[2], -1, 1e-9) && o[3] === 0);
  for (const [x, y] of pairs(o)) assert.ok(x <= 0 && x >= -1e308 && y === 0);
  // A ratio so large the step overflows still gives only the first dab.
  assert.deepEqual(dabs([0, 0, 10, 0, 20, 0], 1e300, 1e300), [0, 0]);
});

test('resample: a path too long to measure keeps its ends rather than going NaN', () => {
  const r = resample([-1e308, 0, 0, 0, 1e308, 0], 1);
  assert.ok(r.every(Number.isFinite));
  assert.deepEqual(r, [-1e308, 0, 1e308, 0]);
});

test('strokeBounds covers every disc along the stroke in whole pixels', () => {
  assert.deepEqual(strokeBounds([10, 10], 3), { x: 7, y: 7, w: 6, h: 6 });
  assert.deepEqual(strokeBounds([10, 10, 20.5, 4], 2), { x: 8, y: 2, w: 15, h: 10 });
  assert.deepEqual(strokeBounds([5.5, 6.2], 0), { x: 5, y: 6, w: 1, h: 1 });
  assert.deepEqual(strokeBounds([5, 6], NaN), { x: 5, y: 6, w: 1, h: 1 });
  // Zero radius: the far point owns its pixel even on a whole-number coordinate.
  assert.deepEqual(strokeBounds([0.5, 0.5, 3, 0.5], 0), { x: 0, y: 0, w: 4, h: 1 });
  assert.deepEqual(strokeBounds([0.5, 0.5, 0.5, 7], 0), { x: 0, y: 0, w: 1, h: 8 });
  assert.equal(strokeBounds([], 3), null);
  assert.equal(strokeBounds([NaN, 1], 3), null);
});
