import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCostMap, createLasso, simplifyPolygon, transformPolygon, scalePolygon, polygonArea, polygonBounds,
  polygonMask, polygonRecord, revivePolygon, SIMPLIFY_EPS,
} from '../lib/lasso.js';
import { mulberry32 } from '../lib/inpaint.js';

// ------------------------------------------------------------------ fixtures

// Grey RGBA image from a luma function (0..255), as the analysis readback is.
function image(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.max(0, Math.min(255, Math.round(fn(x, y)))), i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

const RECT = { w: 300, h: 240, x: 90, y: 75, rw: 120, rh: 90 };
function rectImage(seed = 7, noise = 12) {
  const rand = mulberry32(seed);
  const { x, y, rw, rh } = RECT;
  return image(RECT.w, RECT.h, (px, py) => (px >= x && px < x + rw && py >= y && py < y + rh ? 200 : 40) + (rand() - 0.5) * noise);
}
const DISC = { w: 160, h: 160, cx: 80, cy: 80, r: 40 };
function discImage() {
  const rand = mulberry32(11);
  const { cx, cy, r } = DISC;
  return image(DISC.w, DISC.h, (x, y) => ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 < r * r ? 60 : 190) + (rand() - 0.5) * 8);
}
// A soft diagonal ramp: no edge anywhere.
const gradientImage = () => image(240, 240, (x, y) => 40 + ((x + y) / 480) * 160);

// Finger points every `step` px around a shape, wandering ±amp px off it.
function fingerAround(points, { step = 6, amp = 12, seed = 3 } = {}) {
  const rand = mulberry32(seed);
  const out = [];
  for (let s = 0; s < points.length; s++) {
    const [ax, ay] = points[s], [bx, by] = points[(s + 1) % points.length];
    const L = Math.hypot(bx - ax, by - ay), nx = -(by - ay) / L, ny = (bx - ax) / L;
    for (let d = 0; d < L; d += step) {
      const off = (rand() - 0.5) * 2 * amp;
      out.push(ax + ((bx - ax) * d) / L + nx * off, ay + ((by - ay) * d) / L + ny * off);
    }
  }
  return out;
}
const rectCorners = ({ x, y, rw, rh }) => [[x, y], [x + rw, y], [x + rw, y + rh], [x, y + rh]];
function circlePoints(cx, cy, r, n = 72) {
  const out = [];
  for (let i = 0; i < n; i++) out.push([cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);
  return out;
}

// Drive a lasso along finger points; collect the live end's distance from the finger.
function run(cm, pts, opts) {
  const lasso = createLasso(cm, opts);
  lasso.begin({ x: pts[0], y: pts[1] });
  let maxEnd = 0;
  for (let i = 2; i < pts.length; i += 2) {
    lasso.move({ x: pts[i], y: pts[i + 1] });
    const p = lasso.path();
    maxEnd = Math.max(maxEnd, Math.hypot(p[p.length - 2] - pts[i], p[p.length - 1] - pts[i + 1]));
  }
  return { poly: lasso.end(), maxEnd };
}

const pairs = (flat) => {
  const out = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
};
function distToPolyline(pts, x, y, closed = false) {
  let best = Infinity;
  const n = pts.length;
  for (let i = 2; i < n + (closed ? 2 : 0); i += 2) {
    const ax = pts[i - 2], ay = pts[i - 1], bx = pts[i % n], by = pts[(i + 1) % n];
    const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - ax - t * vx, y - ay - t * vy));
  }
  return best;
}
// Distance from (x, y) to the rectangle's border (its edges, in px coordinates).
function rectBorderDist({ x, y, rw, rh }, px, py) {
  const inX = px >= x && px <= x + rw, inY = py >= y && py <= y + rh;
  if (inX && inY) return Math.min(px - x, x + rw - px, py - y, y + rh - py);
  return Math.hypot(Math.max(x - px, 0, px - (x + rw)), Math.max(y - py, 0, py - (y + rh)));
}
const maskArea = (mask) => mask.reduce((a, v) => a + v / 255, 0);

// ------------------------------------------------------------------ cost map

test('buildCostMap: edges are cheap, flat areas dear, output is well-formed', () => {
  const cm = buildCostMap(rectImage());
  assert.equal(cm.width, RECT.w);
  assert.equal(cm.cost.length, RECT.w * RECT.h);
  const row = RECT.y + 40;
  const at = (x) => cm.cost[row * RECT.w + x];
  // The two pixels either side of the left edge (x = 90) are the cheap ones.
  assert.ok(Math.min(at(RECT.x - 1), at(RECT.x)) < 0.1, `edge cost ${at(RECT.x - 1)} ${at(RECT.x)}`);
  assert.ok(at(RECT.x - 6) > 0.7 && at(RECT.x + 6) > 0.7, 'flat is dear');
  for (const v of cm.cost) assert.ok(v >= 0 && v <= 1);
  // A flat image is uniformly dear, not stretched into edges.
  const flat = buildCostMap(image(20, 20, () => 100));
  for (const v of flat.cost) assert.ok(v > 0.8);
  assert.throws(() => buildCostMap({ data: new Uint8ClampedArray(4), width: 1, height: 1 }), RangeError);
  assert.throws(() => buildCostMap({ data: new Uint8ClampedArray(4), width: 10, height: 10 }), RangeError);
});

// ------------------------------------------------------------------ snapping

test('a finger wandering ±12 px around a rectangle yields its border', () => {
  const cm = buildCostMap(rectImage());
  const pts = fingerAround(rectCorners(RECT), { step: 6, amp: 12 });
  const { poly, maxEnd } = run(cm, pts, { snapRadius: 20, anchorSpacing: 24 });
  assert.ok(poly.length / 2 >= 4);
  let worst = 0;
  for (const [x, y] of pairs(poly)) worst = Math.max(worst, rectBorderDist(RECT, x, y));
  assert.ok(worst <= 1.5, `a vertex is ${worst.toFixed(2)} px off the border`);
  const area = maskArea(polygonMask(poly, { width: RECT.w, height: RECT.h }));
  const truth = RECT.rw * RECT.rh;
  assert.ok(Math.abs(area - truth) / truth <= 0.03, `mask area ${area} vs ${truth}`);
  assert.ok(Math.abs(polygonArea(poly) - truth) / truth <= 0.03);
  assert.ok(maxEnd <= 20, `live end ${maxEnd} px from the finger`);
  // The polygon is compact enough for a history step (420 px of border).
  assert.ok(poly.length / 2 < 100, `${poly.length / 2} vertices`);
});

test('with no edges the path follows the finger', () => {
  const cm = buildCostMap(gradientImage());
  const pts = fingerAround(circlePoints(120, 120, 90), { step: 5, amp: 0.5, seed: 5 });
  const { poly } = run(cm, pts);
  let worst = 0;
  for (const [x, y] of pairs(poly)) worst = Math.max(worst, distToPolyline(pts, x, y, true));
  assert.ok(worst <= 2, `polygon strays ${worst.toFixed(2)} px from the finger`);
  // And the other way round: the finger's loop is all covered.
  for (const [x, y] of pairs(pts)) assert.ok(distToPolyline(poly, x, y, true) <= 2.5);
});

test('on a flat, noisy area the path stays near the finger', () => {
  const rand = mulberry32(21);
  const cm = buildCostMap(image(240, 240, () => 110 + (rand() - 0.5) * 8));
  const pts = fingerAround(circlePoints(120, 120, 80), { step: 5, amp: 0.5, seed: 9 });
  const { poly } = run(cm, pts);
  let worst = 0;
  for (const [x, y] of pairs(poly)) worst = Math.max(worst, distToPolyline(pts, x, y, true));
  assert.ok(worst <= 4, `polygon strays ${worst.toFixed(2)} px from the finger over noise`);
});

test('a disc is traced on its circle', () => {
  const cm = buildCostMap(discImage());
  const { cx, cy, r } = DISC;
  const pts = fingerAround(circlePoints(cx, cy, r), { step: 5, amp: 10, seed: 4 });
  const { poly } = run(cm, pts);
  let sum = 0, n = 0;
  for (const [x, y] of pairs(poly)) { sum += Math.abs(Math.hypot(x - cx, y - cy) - r); n++; }
  assert.ok(n >= 8);
  assert.ok(sum / n < 1, `mean radial error ${(sum / n).toFixed(2)} px`);
  const area = polygonArea(poly);
  assert.ok(Math.abs(area - Math.PI * r * r) / (Math.PI * r * r) < 0.06);
});

test('a thin 1 px line is followed from beside it', () => {
  const rand = mulberry32(13);
  const cm = buildCostMap(image(200, 120, (x, y) => (y === 60 && x >= 20 && x < 180 ? 220 : 50) + (rand() - 0.5) * 6));
  const lasso = createLasso(cm, { snapRadius: 15 });
  lasso.begin({ x: 25, y: 66 });
  for (let x = 30; x <= 175; x += 5) lasso.move({ x, y: 60 + 8 * Math.sin(x / 9) });
  const p = lasso.path();
  let worst = 0;
  for (const [x, y] of pairs(p)) if (x > 30 && x < 170) worst = Math.max(worst, Math.abs(y - 60.5));
  assert.ok(worst <= 1.5, `path is ${worst} px off the line`);
  lasso.cancel();
  assert.equal(lasso.path().length, 0);
});

test('the live segment never ends more than snapRadius from the (clamped) finger', () => {
  const cm = buildCostMap(rectImage(5));
  for (const R of [6, 20, 35]) {
    const lasso = createLasso(cm, { snapRadius: R, anchorSpacing: 16 });
    const rand = mulberry32(R);
    lasso.begin({ x: 60, y: 60 });
    let worst = 0;
    for (let i = 0; i < 150; i++) {
      // Random walk, including off the image, where the finger is clamped on.
      const fx = -20 + rand() * (RECT.w + 40), fy = -20 + rand() * (RECT.h + 40);
      lasso.move({ x: fx, y: fy });
      const p = lasso.path();
      const cx = Math.min(RECT.w - 1e-3, Math.max(0, fx)), cy = Math.min(RECT.h - 1e-3, Math.max(0, fy));
      worst = Math.max(worst, Math.hypot(p[p.length - 2] - cx, p[p.length - 1] - cy));
      assert.ok(p.every(Number.isFinite));
    }
    assert.ok(worst <= R, `R ${R}: live end ${worst.toFixed(2)} px from the finger`);
    assert.ok(lasso.end().every(Number.isFinite));
  }
});

test('the corridor search never reads a pixel outside the corridor', () => {
  const W = 200, H = 160, n = W * H;
  const read = new Set();
  const spy = (arr) => new Proxy(arr, {
    get(t, k) {
      const i = typeof k === 'string' ? Number(k) : NaN;
      if (Number.isInteger(i)) read.add(i);
      return t[k];
    },
  });
  // Dear inside, free outside: a search that leaked would route through the
  // free pixels and the path would leave the corridor.
  const cost = new Float32Array(n).fill(1);
  const R = 20;
  const anchor = { x: 100, y: 70 }, finger = { x: 131.5, y: 82.3 };
  const inside = (x, y) => x >= Math.floor(anchor.x - R) && x <= Math.ceil(finger.x + R) && y >= Math.floor(anchor.y - R) && y <= Math.ceil(finger.y + R);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!inside(x, y)) cost[y * W + x] = 0;
  const cm = { width: W, height: H, cost: spy(cost), tx: spy(new Int8Array(n)), ty: spy(new Int8Array(n)), gmax: 1 };
  const lasso = createLasso(cm, { snapRadius: R, anchorSpacing: 1e9 });
  lasso.begin({ x: anchor.x + 0.5, y: anchor.y + 0.5 });
  read.clear();
  lasso.move(finger);
  assert.ok(read.size > 0);
  for (const i of read) {
    const x = i % W, y = (i - x) / W;
    assert.ok(inside(x, y), `read pixel (${x}, ${y}) outside the corridor`);
  }
  const s = lasso.lastSearch();
  assert.deepEqual([s.x, s.y, s.x + s.w - 1, s.y + s.h - 1], [anchor.x - R, anchor.y - R, Math.ceil(finger.x + R), Math.ceil(finger.y + R)]);
  assert.ok(s.popped <= s.w * s.h);
  for (const [x, y] of pairs(lasso.path())) assert.ok(inside(x - 0.5, y - 0.5));
  // The path is the straight line between the two in a uniform field.
  for (const [x, y] of pairs(lasso.path())) assert.ok(distToPolyline([anchor.x + 0.5, anchor.y + 0.5, finger.x, finger.y], x, y) <= 1.2);
  // Begin reads only the disc's box around the finger.
  read.clear();
  lasso.cancel();
  lasso.begin({ x: 10, y: 10 });
  for (const i of read) {
    const x = i % W, y = (i - x) / W;
    assert.ok(x <= 30 && y <= 30, `begin read (${x}, ${y})`);
  }
});

test('determinism: the same input gives bit-identical cost maps and polygons', () => {
  const a = buildCostMap(rectImage()), b = buildCostMap(rectImage());
  assert.deepEqual(a.cost, b.cost);
  assert.deepEqual(a.tx, b.tx);
  const pts = fingerAround(rectCorners(RECT), { step: 7, amp: 10, seed: 2 });
  const p1 = run(a, pts).poly, p2 = run(b, pts).poly;
  assert.deepEqual(p1, p2);
  // A reused lasso (after end and after cancel) gives the same again.
  const lasso = createLasso(a);
  const go = () => { lasso.begin({ x: pts[0], y: pts[1] }); for (let i = 2; i < pts.length; i += 2) lasso.move({ x: pts[i], y: pts[i + 1] }); };
  go();
  assert.deepEqual(lasso.end(), p1);
  go();
  lasso.cancel();
  assert.equal(lasso.end(), null);
  go();
  assert.deepEqual(lasso.end(), p1);
});

test('degenerate drags', () => {
  const cm = buildCostMap(rectImage());
  const lasso = createLasso(cm);
  assert.equal(lasso.active, false);
  assert.equal(lasso.end(), null);
  lasso.move({ x: 5, y: 5 }); // before begin: nothing
  assert.equal(lasso.path().length, 0);
  lasso.begin({ x: 50.2, y: 60.7 });
  assert.equal(lasso.active, true);
  assert.deepEqual(Array.from(lasso.path()), [50.5, 60.5]);
  assert.deepEqual(Array.from(lasso.end()), [50.5, 60.5]); // a tap: one vertex, no area
  assert.equal(polygonArea(lasso.end() ?? []), 0);
  lasso.begin({ x: NaN, y: -40 }); // garbage lands on the map
  lasso.move({ x: 1e9, y: 1e9 });
  const p = lasso.end();
  assert.ok(p.every((v) => Number.isFinite(v) && v >= 0 && v <= 300));
});

// ------------------------------------------------------------------ polygons

test('simplifyPolygon keeps corners and drops collinear points', () => {
  const sq = [];
  for (let x = 0; x <= 10; x++) sq.push(x + 0.5, 0.5);
  for (let y = 1; y <= 10; y++) sq.push(10.5, y + 0.5);
  for (let x = 9; x >= 0; x--) sq.push(x + 0.5, 10.5);
  for (let y = 9; y >= 1; y--) sq.push(0.5, y + 0.5);
  assert.deepEqual(Array.from(simplifyPolygon(sq)), [0.5, 0.5, 10.5, 0.5, 10.5, 10.5, 0.5, 10.5]);
  // A half-px zig-zag along an edge is within eps and goes; a 2 px bump stays.
  const zig = [0, 0, 2, 0.5, 4, 0, 6, 0.5, 8, 0, 8, 10, 0, 10];
  assert.deepEqual(Array.from(simplifyPolygon(zig, SIMPLIFY_EPS)), [0, 0, 8, 0, 8, 10, 0, 10]);
  const bump = [0, 0, 4, 2, 8, 0, 8, 10, 0, 10];
  assert.deepEqual(Array.from(simplifyPolygon(bump)), bump);
  assert.deepEqual(Array.from(simplifyPolygon([1, 2, 3, 4, 5, 6])), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(Array.from(simplifyPolygon([1, 2, 3, 4, 5, 6, 7, 8, 9], 0)), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('transformPolygon, scalePolygon, polygonArea, records', () => {
  const tri = new Float32Array([0, 0, 4, 0, 0, 3]);
  assert.equal(polygonArea(tri), 6);
  assert.deepEqual(Array.from(scalePolygon(tri, 2)), [0, 0, 8, 0, 0, 6]);
  assert.equal(polygonArea(scalePolygon(tri, 2)), 24);
  // A quarter turn plus a shift, as geometry.apply would do it.
  assert.deepEqual(Array.from(transformPolygon(tri, [0, 1, -1, 0, 10, 0])), [10, 0, 10, 4, 7, 0]);
  assert.deepEqual(polygonRecord([1.26, 2.34, NaN, 1, 3, 4]), [1.3, 2.3, 3, 4]);
  assert.deepEqual(Array.from(revivePolygon([1, 2, 3, 4, 5, 6])), [1, 2, 3, 4, 5, 6]);
  assert.equal(revivePolygon([1, 2, 3, 4]), null);
  assert.equal(revivePolygon([1, 2, 3, 4, 5]), null);
  assert.equal(revivePolygon([1, 2, 3, 4, 5, '6']), null);
  assert.equal(revivePolygon([1, 2, 3, 4, 5, Infinity]), null);
  assert.equal(revivePolygon(null), null);
});

test('polygonMask: feather only near the edge, 255 inside, 0 outside', () => {
  const sq = [10, 10, 40, 10, 40, 40, 10, 40];
  const W = 60, H = 60, feather = 1.5;
  const mask = polygonMask(sq, { width: W, height: H, feather });
  const edgeDist = (px, py) => rectBorderDist({ x: 10, y: 10, rw: 30, rh: 30 }, px, py);
  let mids = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = mask[y * W + x], d = edgeDist(x + 0.5, y + 0.5);
      const inside = x + 0.5 > 10 && x + 0.5 < 40 && y + 0.5 > 10 && y + 0.5 < 40;
      if (v > 0 && v < 255) { mids++; assert.ok(d <= feather + 1, `mid value at ${d} px from the edge`); }
      if (d > feather + 1) assert.equal(v, inside ? 255 : 0);
    }
  }
  assert.ok(mids > 0, 'the edge is feathered');
  assert.equal(mask[30 * W + 30], 255);
  assert.equal(mask[2 * W + 2], 0);
  // Symmetric ramp: the area is the polygon's.
  assert.ok(Math.abs(maskArea(mask) - 900) < 2);
  // A hard mask has only 0 and 255, and pixel centres decide.
  const hard = polygonMask(sq, { width: W, height: H, feather: 0 });
  assert.ok(hard.every((v) => v === 0 || v === 255));
  assert.equal(maskArea(hard), 900);
  assert.equal(hard[10 * W + 10], 255);
  assert.equal(hard[9 * W + 10], 0);
  // grow pushes the edge out (by distance, so the corners round: 4 px short).
  const grown = polygonMask(sq, { width: W, height: H, feather: 0, grow: 2 });
  assert.equal(maskArea(grown), 34 * 34 - 4);
  assert.equal(grown[8 * W + 20], 255);
  assert.equal(grown[7 * W + 20], 0);
});

test('polygonMask: even-odd fill, scale and offset', () => {
  // Bow-tie: both lobes filled, the waist empty.
  const bow = [0, 0, 20, 20, 20, 0, 0, 20];
  const m = polygonMask(bow, { width: 20, height: 20, feather: 0 });
  assert.equal(m[10 * 20 + 3], 255);
  assert.equal(m[10 * 20 + 16], 255);
  assert.equal(m[3 * 20 + 10], 0);
  assert.equal(m[16 * 20 + 10], 0);
  // A loop inside a loop, both wound the same way: even-odd leaves a hole
  // where nonzero winding would fill.
  const nested = [0, 0, 30, 0, 30, 30, 0, 30, 0, 0, 10, 10, 20, 10, 20, 20, 10, 20, 10, 10];
  const n = polygonMask(nested, { width: 30, height: 30, feather: 0 });
  assert.equal(n[15 * 30 + 15], 0);
  assert.equal(n[5 * 30 + 15], 255);
  assert.equal(n[15 * 30 + 25], 255);
  // scale maps polygon px to mask px; x, y is the mask's origin in those px.
  const sq = [10, 10, 20, 10, 20, 20, 10, 20];
  // The square lands at [5, 25) in the mask.
  const s = polygonMask(sq, { width: 30, height: 30, scale: 2, x: 15, y: 15, feather: 0 });
  assert.equal(maskArea(s), 20 * 20);
  assert.equal(s[0], 0);
  assert.equal(s[5 * 30 + 5], 255);
  assert.equal(s[4 * 30 + 4], 0);
  assert.equal(s[25 * 30 + 25], 0);
  assert.equal(s[24 * 30 + 24], 255);
  // Nothing to draw: empty masks, never a throw.
  assert.equal(maskArea(polygonMask([1, 1, 2, 2], { width: 5, height: 5 })), 0);
  assert.equal(polygonMask(sq, { width: 0, height: 5 }).length, 0);
  assert.throws(() => polygonMask(sq, { width: -1, height: 5 }), RangeError);
});

test('polygonBounds clamps to the image and grows by pad', () => {
  const poly = [-5, 10.2, 40.6, 10.2, 40.6, 70, -5, 70];
  assert.deepEqual(polygonBounds(poly, 1, { width: 30, height: 50 }), { x: 0, y: 10, width: 30, height: 40 });
  // The image origin is always 0; a point on a whole number still owns its pixel.
  assert.deepEqual(polygonBounds(poly, 1), { x: 0, y: 10, width: 41, height: 61 });
  assert.deepEqual(polygonBounds(poly, 2, { width: 100, height: 100 }), { x: 0, y: 20, width: 82, height: 80 });
  assert.deepEqual(polygonBounds(poly, 1, { width: 100, height: 100, pad: 3 }), { x: 0, y: 7, width: 44, height: 66 });
  assert.equal(polygonBounds(poly, 1, { width: 100, height: 5 }), null);
  assert.equal(polygonBounds([200, 200, 210, 200, 210, 210], 1, { width: 100, height: 100 }), null);
  assert.equal(polygonBounds([], 1), null);
  // A point owns its pixel even on a whole number.
  assert.deepEqual(polygonBounds([5, 5], 1), { x: 5, y: 5, width: 1, height: 1 });
  // Feeds lib/inpaint.js planRemoval as is.
  const b = polygonBounds(poly, 1, { width: 30, height: 50 });
  assert.ok(Number.isInteger(b.x) && Number.isInteger(b.width));
});

// ------------------------------------------------------------------ speed

test('speed: a 1024x768 cost map and 200 moves', () => {
  const rand = mulberry32(99);
  buildCostMap(rectImage()); // warm the JIT
  const big = image(1024, 768, (x, y) => 128 + 60 * Math.sin(x / 37) * Math.cos(y / 23) + (rand() - 0.5) * 10);
  let t0 = performance.now();
  const cm = buildCostMap(big);
  const build = performance.now() - t0;
  const lasso = createLasso(cm);
  lasso.begin({ x: 400, y: 350 });
  t0 = performance.now();
  for (let i = 0; i < 200; i++) lasso.move({ x: 400 + 300 * Math.sin(i / 32) + (rand() - 0.5) * 10, y: 350 + 250 * Math.cos(i / 32) + (rand() - 0.5) * 10 });
  const moves = performance.now() - t0;
  t0 = performance.now();
  const poly = lasso.end();
  const close = performance.now() - t0;
  t0 = performance.now();
  const mask = polygonMask(poly, { width: 4096, height: 3072, scale: 4 });
  const rasterize = performance.now() - t0;
  console.log(`lasso: cost map 1024x768 ${build.toFixed(1)} ms, 200 moves ${moves.toFixed(1)} ms (${(moves / 200).toFixed(2)} ms each), close ${close.toFixed(1)} ms, ${poly.length / 2} vertices, 4096x3072 mask ${rasterize.toFixed(1)} ms`);
  assert.ok(build < 250, `cost map took ${build} ms`);
  assert.ok(moves < 400, `200 moves took ${moves} ms`);
  assert.ok(mask.length === 4096 * 3072);
});
