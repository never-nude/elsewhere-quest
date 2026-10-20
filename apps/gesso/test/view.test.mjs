import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ZOOM, fitView, viewMatrix, stageToContent, zoomAt, panBy, clampView, isZoomed,
  outputQuad, frameQuad, frameBounds,
} from '../lib/view.js';
import { initialCrop, setAngle, setAspect, rotateQuarter, outputSize } from '../lib/geometry.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('fitView letterboxes and centres', () => {
  const v = fitView(4000, 3000, 400, 600, 0);
  assert.ok(near(v.scale, 0.1));
  assert.ok(near(v.x, 0) && near(v.y, 150));
  const p = fitView(1000, 1000, 400, 600, 20);
  assert.ok(near(p.scale, 0.36) && near(p.x, 20));
});

test('zoomAt keeps the point under the fingers fixed and clamps', () => {
  const v = fitView(4000, 3000, 400, 600);
  const before = stageToContent(v, 120, 300);
  const z = zoomAt(v, 3, 120, 300);
  const after = stageToContent(z, 120, 300);
  assert.ok(near(before[0], after[0], 1e-9) && near(before[1], after[1], 1e-9));
  assert.ok(isZoomed(z));
  assert.ok(near(zoomAt(z, 1000, 0, 0).scale, v.fit * MAX_ZOOM));
  assert.ok(near(zoomAt(z, 0.0001, 0, 0).scale, v.fit));
  assert.equal(isZoomed(v), false);
});

test('clampView centres small content and keeps big content covering the stage', () => {
  const v = fitView(4000, 3000, 400, 600);
  const panned = clampView(panBy(v, 300, 300), 4000, 3000, 400, 600);
  assert.ok(near(panned.x, v.x) && near(panned.y, v.y), 'fitted image snaps back to centre');
  const z = zoomAt(v, 4, 200, 300);
  const far = clampView(panBy(z, 5000, -5000), 4000, 3000, 400, 600);
  assert.ok(near(far.x, 0)); // left edge pinned
  assert.ok(near(far.y, 600 - 3000 * z.scale)); // bottom edge pinned
  assert.deepEqual(viewMatrix({ scale: 2, x: 3, y: 4 }), [2, 0, 0, 2, 3, 4]);
});

test('outputQuad of an identity crop maps corners to the image corners', () => {
  const crop = initialCrop(400, 300);
  const q = outputQuad(crop, 400, 300, 400, 300, [0.5, 0, 0, 0.5, 10, 20]);
  assert.deepEqual(q.map((c) => [c.u, c.v]), [[0, 0], [1, 0], [0, 1], [1, 1]]);
  assert.deepEqual(q.map((c) => [c.x, c.y]), [[10, 20], [210, 20], [10, 170], [210, 170]]);
  assert.deepEqual(q.map((c) => [c.ox, c.oy]), [[0, 0], [1, 0], [0, 1], [1, 1]]);
});

test('outputQuad of a straightened crop samples inside the source', () => {
  let crop = setAngle(initialCrop(400, 300), 400, 300, 12);
  crop = setAspect(crop, 400, 300, 'square');
  const { width, height } = outputSize(crop);
  for (const c of outputQuad(crop, 400, 300, width, height, [1, 0, 0, 1, 0, 0])) {
    assert.ok(c.u >= -1e-3 && c.u <= 1 + 1e-3 && c.v >= -1e-3 && c.v <= 1 + 1e-3, `${c.u},${c.v}`);
  }
});

test('frameQuad covers the whole image, and its crop-rect corners land at output 0..1', () => {
  let crop = setAngle(initialCrop(400, 300), 400, 300, 10);
  crop = rotateQuarter(crop, 400, 300);
  const q = frameQuad(crop, 400, 300, [1, 0, 0, 1, 0, 0]);
  const uvs = q.map((c) => [Math.round(c.u * 1e6) / 1e6, Math.round(c.v * 1e6) / 1e6]).sort();
  for (const [u, v] of uvs) assert.ok((near(u, 0) || near(u, 1)) && (near(v, 0) || near(v, 1)), `${u},${v}`);
  // a frame-space point at the crop rect's top-left has output (0, 0)
  const r = crop.rect;
  const toOut = (fx, fy) => {
    // interpolate along the quad: solve via the affine through three corners
    const [a, b, c] = q;
    const det = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    const s = ((fx - a.x) * (c.y - a.y) - (c.x - a.x) * (fy - a.y)) / det;
    const t = ((b.x - a.x) * (fy - a.y) - (fx - a.x) * (b.y - a.y)) / det;
    return [a.ox + s * (b.ox - a.ox) + t * (c.ox - a.ox), a.oy + s * (b.oy - a.oy) + t * (c.oy - a.oy)];
  };
  const tl = toOut(r.x, r.y), br = toOut(r.x + r.width, r.y + r.height);
  assert.ok(near(tl[0], 0, 1e-6) && near(tl[1], 0, 1e-6) && near(br[0], 1, 1e-6) && near(br[1], 1, 1e-6));
});

test('frameBounds grows with the straighten angle and swaps on a quarter turn', () => {
  const c0 = initialCrop(400, 300);
  assert.deepEqual(frameBounds(c0, 400, 300), { x: -200, y: -150, width: 400, height: 300 });
  const tilted = frameBounds(setAngle(c0, 400, 300, 20), 400, 300);
  assert.ok(tilted.width > 400 && tilted.height > 300);
  const turned = frameBounds(rotateQuarter(c0, 400, 300), 400, 300);
  assert.ok(near(turned.width, 300) && near(turned.height, 400));
});
