import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS, DEFAULT_SIZE, brushRadius, solveFactor, discBox, clipRect, grow, findRegion, fullOffsets, rankSources,
  rubWindow, mapPoints, extendBounds, boundsRect, discRing, refineOffset, subBlock, readPadded, shrink, shrinkMask,
  stackSide, stackLayout, stackPair, correctionField, upsampleCorrection, cutTile, upsampleFill, addCorrection,
  recipeRecord, reviveRecipe, strokeMaskFast, shrinkFill, silhouetteSvg, outlineBox, outlineMask, polygonSvg, DILATE_PX,
} from '../lib/remove-plan.js';
import { diskMask, strokeMask, maskBounds, composeRef, handleHealMessage } from '../lib/heal.js';
import { planRemoval, mulberry32 } from '../lib/inpaint.js';
import { strokeBounds } from '../lib/stroke.js';
import { polygonMask, polygonBounds, transformPolygon } from '../lib/lasso.js';

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

const px = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
const crop = (img, r) => {
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) out.set(img.data.subarray(((y + r.y) * img.width + r.x) * 4, ((y + r.y) * img.width + r.x + r.w) * 4), y * r.w * 4);
  return out;
};

test('brush sizes: presets, Medium by default, constant on screen', () => {
  assert.deepEqual({ ...PRESETS }, { small: 20, medium: 36, large: 64 });
  assert.equal(DEFAULT_SIZE, 36);
  assert.equal(brushRadius(36, 2), 36); // 18 pt radius, 2 source px per pt
  assert.equal(brushRadius(36, 0.5), 9); // zoomed in: finer on the photo
  for (const bad of [[0, 1], [36, 0], [NaN, 1], [36, Infinity], [-5, 1]]) assert.equal(brushRadius(...bad), 0);
});

test('solveFactor shrinks a hole to at most SOLVE_PX across, by a whole factor', () => {
  assert.equal(solveFactor(10), 1);
  assert.equal(solveFactor(64), 1);
  assert.equal(solveFactor(65), 2);
  assert.equal(solveFactor(176.5), 3);
  for (const r of [10, 100, 300, 1000]) assert.ok((2 * r) / solveFactor(r) <= 128);
  for (const bad of [0, -1, NaN, Infinity]) assert.equal(solveFactor(bad), 1);
});

test('discBox holds every pixel diskMask marks, clipped to the image', () => {
  for (const [cx, cy, r] of [[20.3, 17.8, 6.2], [0.5, 0.5, 4], [39, 29, 9], [10, 10, 0.2]]) {
    const W = 40, H = 30;
    const box = discBox(cx, cy, r, W, H);
    const b = maskBounds(diskMask(cx, cy, r, W, H), W, H);
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.w <= W && box.y + box.h <= H);
    assert.ok(b.x >= box.x && b.y >= box.y && b.x + b.w <= box.x + box.w && b.y + b.h <= box.y + box.h, `${cx},${cy},${r}`);
  }
  assert.equal(discBox(-50, -50, 3, 40, 30), null);
  assert.equal(discBox(NaN, 1, 3, 40, 30), null);
});

test('rect helpers clip and grow inside the image', () => {
  assert.deepEqual(clipRect({ x: -5, y: 2, w: 10, h: 100 }, 20, 30), { x: 0, y: 2, w: 5, h: 28 });
  assert.equal(clipRect({ x: 25, y: 0, w: 3, h: 3 }, 20, 30), null);
  assert.deepEqual(grow({ x: 2, y: 2, w: 4, h: 4 }, 3, 20, 30), { x: 0, y: 0, w: 9, h: 9 });
  const reg = findRegion(50, 40, 5, 200, 100, 6);
  assert.deepEqual(reg, { x: 14, y: 4, w: 72, h: 72 }); // disc box 44..55 grown by 30
  assert.deepEqual(findRegion(2, 2, 5, 200, 100, 6), { x: 0, y: 0, w: 38, h: 38 });
  assert.deepEqual(findRegion(50, 40, 5, 200, 100), { x: 24, y: 14, w: 52, h: 52 }); // default reach 4
});

test('fullOffsets scales shrunk offsets up, dropping repeats, zero and junk', () => {
  const region = { x: 0, y: 0, w: 300, h: 200 };
  const small = { width: 100, height: 50 };
  const out = fullOffsets([{ dx: 10, dy: -5 }, { dx: 10.1, dy: -5 }, { dx: 0, dy: 0 }, { dx: NaN, dy: 1 }, { dx: -3, dy: 2 }], region, small);
  assert.deepEqual(out, [{ dx: 30, dy: -20 }, { dx: -9, dy: 8 }]);
  assert.deepEqual(fullOffsets(null, region, small), []);
});

test('rankSources demotes a candidate that hides something inside its ring', () => {
  // Flat grey everywhere, except a bright blob in the middle of candidate A's disc.
  const img = makeImage(120, 60, (x, y) => (Math.hypot(x - 80, y - 30) < 5 ? [250, 250, 250] : [100, 100, 100]));
  const cands = [{ dx: 50, dy: 0, score: 10 }, { dx: -20, dy: 0, score: 12 }]; // A hides the blob, B is clean
  const ranked = rankSources(img, 30, 30, 10, cands);
  assert.deepEqual(ranked.map((c) => c.dx), [-20, 50]);
  assert.ok(ranked.every((c) => Number.isFinite(c.rank)));
  assert.equal(rankSources(img, 30, 30, 10, cands, { keep: 1 }).length, 1);
  assert.deepEqual(rankSources(img, 30, 30, 10, []), []);
});

test('rubWindow is planRemoval at first and looks further on each Try another', () => {
  const box = { x: 400, y: 300, w: 120, h: 80 };
  const p = planRemoval({ x: 400, y: 300, width: 120, height: 80 }, 2000, 1500);
  const w0 = rubWindow(box, 2000, 1500, 0);
  assert.deepEqual(w0.rect, { x: p.x, y: p.y, w: p.width, h: p.height });
  assert.equal(w0.scale, p.scale);
  const w1 = rubWindow(box, 2000, 1500, 1);
  const w2 = rubWindow(box, 2000, 1500, 2);
  assert.ok(w1.rect.w > w0.rect.w && w2.rect.w > w1.rect.w);
  for (const w of [w0, w1, w2]) {
    assert.ok(w.rect.x <= box.x && w.rect.y <= box.y && w.rect.x + w.rect.w >= box.x + box.w && w.rect.y + w.rect.h >= box.y + box.h);
    assert.ok(w.scale > 0 && w.scale <= 1);
  }
  assert.ok(rubWindow({ x: 0, y: 0, w: 3000, h: 2000 }, 4000, 3000, 0).scale < 1, 'big windows run shrunk');
});

test('mapPoints moves and scales flat points into a rect', () => {
  assert.deepEqual(mapPoints([10, 20, 30, 40], { x: 10, y: 10 }, 0.5), [0, 5, 10, 15]);
  assert.deepEqual(mapPoints([10, 20], { x: 0, y: 0 }, 2, 3), [20, 60]);
});

test('extendBounds + boundsRect agree with strokeBounds', () => {
  const rand = mulberry32(5);
  for (let t = 0; t < 20; t++) {
    const pts = [];
    let b = null;
    for (let i = 0; i < 6; i++) {
      const x = rand() * 500, y = rand() * 300;
      pts.push(x, y);
      b = extendBounds(b, x, y);
    }
    const r = 1 + rand() * 40;
    assert.deepEqual(boundsRect(b, r), strokeBounds(pts, r));
  }
  assert.equal(boundsRect(null, 3), null);
});

test('readPadded reads on-photo rects as is and repeats the edge beyond it', () => {
  const W = 8, H = 6;
  const img = makeImage(W, H, (x, y) => [x * 10, y * 10, 7]);
  const read = (r) => crop(img, r);
  const inside = { x: 1, y: 1, w: 3, h: 2 };
  assert.deepEqual(readPadded(read, inside, W, H), read(inside));
  const out = readPadded(read, { x: -2, y: 4, w: 4, h: 4 }, W, H);
  const at = (x, y) => Array.from(out.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4));
  assert.deepEqual(at(0, 0), [0, 40, 7, 255]); // (-2, 4) -> (0, 4)
  assert.deepEqual(at(3, 3), [10, 50, 7, 255]); // (1, 7) -> (1, 5)
  assert.equal(readPadded(read, { x: 20, y: 0, w: 2, h: 2 }, W, H), null);
});

test('shrink box-averages whole blocks and partial edge blocks; masks shrink by any', () => {
  const img = makeImage(5, 3, (x, y) => [x * 10 + y, 100, 200]);
  const s = shrink(img.data, 5, 3, 2);
  assert.equal(s.width, 3);
  assert.equal(s.height, 2);
  assert.equal(s.data[0], Math.round((0 + 10 + 1 + 11) / 4));
  assert.equal(s.data[(1 * 3 + 2) * 4], 42); // the lone corner pixel (4, 2)
  const same = shrink(img.data, 5, 3, 1);
  assert.deepEqual(same.data, img.data);
  assert.notEqual(same.data, img.data);
  const m = new Uint8Array(5 * 3);
  m[2 * 5 + 4] = 1;
  m[1] = 1;
  assert.deepEqual(Array.from(shrinkMask(m, 5, 3, 2)), [1, 0, 0, 0, 0, 1]);
});

test('stackSide keeps the source block off the photo edges the hole touches', () => {
  assert.equal(stackSide({ x: 2, y: 2, w: 4, h: 4 }, 10, 10), 'below');
  assert.equal(stackSide({ x: 2, y: 4, w: 4, h: 6 }, 10, 10), 'right'); // touches the bottom
  assert.equal(stackSide({ x: 4, y: 4, w: 6, h: 6 }, 10, 10), 'above'); // bottom and right
  assert.equal(stackSide({ x: 4, y: 0, w: 6, h: 10 }, 10, 10), 'left');
  assert.equal(stackSide({ x: 0, y: 0, w: 10, h: 10 }, 10, 10), 'below');
});

test('stackPair puts the source exactly (dx, dy) from the target, mask in the target', () => {
  const w = 3, h = 2;
  const t = makeImage(w, h, (x, y) => [1, x, y]).data;
  const s = makeImage(w, h, (x, y) => [2, x, y]).data;
  const mask = Uint8Array.from([0, 1, 0, 0, 0, 1]);
  for (const side of ['below', 'right', 'above', 'left']) {
    const S = stackPair(t, s, mask, w, h, side);
    const L = stackLayout(w, h, side);
    assert.equal(S.img.width, L.width);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        assert.deepEqual(px(S.img, x + S.tx, y + S.ty), [1, x, y, 255], side);
        assert.deepEqual(px(S.img, x + S.tx + S.dx, y + S.ty + S.dy), [2, x, y, 255], side);
        assert.equal(S.mask[(y + S.ty) * S.width + x + S.tx], mask[y * w + x]);
        assert.equal(S.mask[(y + S.sy) * S.width + x + S.sx], 0);
      }
    }
  }
});

test('discRing is the band just outside the disc', () => {
  const w = 40, h = 40;
  const ring = discRing(20, 20, 8, 3, w, h);
  const hole = diskMask(20, 20, 8, w, h);
  assert.ok(ring.length > 0);
  for (const p of ring) {
    const d = Math.hypot((p % w) + 0.5 - 20, Math.floor(p / w) + 0.5 - 20);
    assert.ok(d > 8 && d <= 11);
    assert.equal(hole[p], 0);
  }
});

test('refineOffset finds the true shift within ±m, and stays put on ties', () => {
  const rand = mulberry32(3);
  const big = makeImage(60, 60, () => [rand() * 255, rand() * 255, rand() * 255]);
  const w = 20, h = 20, m = 3;
  // target = big at (20, 20); the copy at offset (D + nudge) = target exactly
  const target = crop(big, { x: 20, y: 20, w, h });
  const truth = { dx: 1, dy: -2 };
  const wide = crop(big, { x: 20 - truth.dx - m, y: 20 - truth.dy - m, w: w + 2 * m, h: h + 2 * m });
  const ring = discRing(10, 10, 5, 3, w, h);
  assert.deepEqual(refineOffset(target, wide, w, h, m, ring), truth);
  const block = subBlock(wide, w + 2 * m, m + truth.dx, m + truth.dy, w, h);
  assert.deepEqual(block, target);
  const flat = makeImage(w + 2 * m, h + 2 * m, () => [9, 9, 9]).data;
  assert.deepEqual(refineOffset(makeImage(w, h, () => [9, 9, 9]).data, flat, w, h, m, ring), { dx: 0, dy: 0 });
});

test('correctionField reads c back out of the worker result', () => {
  const w = 2, h = 2;
  const S = stackPair(new Uint8ClampedArray(16).fill(50), new Uint8ClampedArray(16).fill(20), Uint8Array.from([1, 0, 0, 0]), w, h, 'right');
  const result = new Uint8ClampedArray(S.img.data);
  result[0] = 80; result[1] = 10; result[2] = 20; // hole pixel: copy + c
  const c = correctionField(result, S);
  assert.deepEqual(Array.from(c.subarray(0, 3)), [60, -10, 0]);
  assert.deepEqual(Array.from(c.subarray(3, 6)), [30, 30, 30]); // outside: target - copy
});

test('upsampleCorrection: identity at f = 1, flat stays flat, only hole pixels written', () => {
  const w = 6, h = 4;
  const mask = new Uint8Array(w * h);
  mask[1 * w + 2] = mask[2 * w + 3] = 1;
  const F = stackPair(new Uint8ClampedArray(w * h * 4), new Uint8ClampedArray(w * h * 4), mask, w, h, 'below');
  const c = new Float32Array(w * h * 3).map((_, i) => i);
  const up = upsampleCorrection(c, w, h, 1, F);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = ((y + F.ty) * F.width + x + F.tx) * 3;
      const want = mask[y * w + x] ? [c[(y * w + x) * 3], c[(y * w + x) * 3 + 1], c[(y * w + x) * 3 + 2]] : [0, 0, 0];
      assert.deepEqual(Array.from(up.subarray(o, o + 3)), want);
    }
  }
  const flat = upsampleCorrection(new Float32Array(3 * 2 * 3).fill(7), 3, 2, 2, F);
  assert.equal(flat[((1 + F.ty) * F.width + 2 + F.tx) * 3], 7);
});

test('addCorrection adds the upsampled correction to masked tile pixels only, clamped', () => {
  const box = { w: 4, h: 3 };
  const rgba = new Uint8ClampedArray(4 * 3 * 4).fill(100);
  const mask = Uint8Array.from([1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1]);
  // a flat correction over a 3 x 2 block shrunk by 2: every masked pixel gets it
  const c = new Float32Array(3 * 2 * 3).fill(10);
  addCorrection(rgba, box, mask, c, 3, 2, 2, 1, 0);
  for (let i = 0; i < 12; i++) assert.equal(rgba[i * 4], mask[i] ? 110 : 100);
  // f = 1 reads c pixel for pixel at the box's offset in the block
  const one = new Uint8ClampedArray(4 * 3 * 4).fill(250);
  const ramp = new Float32Array(6 * 5 * 3).map((_, i) => Math.floor(i / 3));
  addCorrection(one, box, new Uint8Array(12).fill(1), ramp, 6, 5, 1, 1, 2);
  assert.equal(one[0], 255); // 250 + c(1, 2) = 250 + 13, clamped
  const neg = new Uint8ClampedArray(4).fill(5);
  addCorrection(neg, { w: 1, h: 1 }, Uint8Array.of(1), new Float32Array(3).fill(-20), 1, 1, 1, 0, 0);
  assert.equal(neg[0], 0);
});

test('cutTile keeps exact pixels inside the mask and marks the rest "leave alone"', () => {
  const img = makeImage(6, 6, (x, y) => [x, y, 99]);
  const mask = new Uint8Array(4 * 4);
  mask[1 * 4 + 1] = mask[2 * 4 + 2] = 1;
  const tile = cutTile(img.data, 6, { x: 1, y: 1, w: 2, h: 2 }, 2, 1, mask, 4);
  // mask (1, 1) -> data (1 + 2, 1 + 1); mask (2, 2) -> data (4, 3)
  assert.deepEqual(Array.from(tile), [3, 2, 99, 255, 0, 0, 0, 0, 0, 0, 0, 0, 4, 3, 99, 255]);
});

test('upsampleFill: a full-size "small" image comes back exactly inside the mask', () => {
  const win = { x: 10, y: 20, w: 8, h: 6 };
  const small = makeImage(8, 6, (x, y) => [x * 20, y * 20, 5]);
  const box = { x: 12, y: 21, w: 3, h: 3 };
  const mask = Uint8Array.from([1, 1, 0, 0, 1, 0, 0, 0, 1]);
  const tile = upsampleFill(small, win, box, mask);
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 3; x++) {
      const t = Array.from(tile.subarray((y * 3 + x) * 4, (y * 3 + x) * 4 + 4));
      assert.deepEqual(t, mask[y * 3 + x] ? [(x + 2) * 20, (y + 1) * 20, 5, 255] : [0, 0, 0, 0]);
    }
  }
  // a flat shrunk fill stays flat at full size
  const flat = upsampleFill(makeImage(4, 3, () => [77, 66, 55]), win, box, new Uint8Array(9).fill(1));
  for (let i = 0; i < 9; i++) assert.deepEqual(Array.from(flat.subarray(i * 4, i * 4 + 4)), [77, 66, 55, 255]);
});

// The whole tap heal as remove.js runs it, on a smooth photo whose copy source is
// a brighter version of the hole's surroundings: the seam correction solved
// shrunk and applied at full size must match the surroundings at the edge.
test('two-scale heal: shrunk seam solve + full-size copy is seamless on a gradient', () => {
  const W = 160, H = 120;
  const photo = makeImage(W, H, (x, y) => [60 + x * 0.6, 40 + y * 0.8, 90 + (x + y) * 0.2]);
  const cx = 50.5, cy = 60.5, rr = 14;
  const D = { dx: 55, dy: -10 };
  // brighten the source area so a plain copy would show a seam
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (Math.hypot(x - cx - D.dx, y - cy - D.dy) < rr + 10) {
        const i = (y * W + x) * 4;
        photo.data[i] += 30; photo.data[i + 1] += 30; photo.data[i + 2] += 30;
      }
    }
  }
  const f = 2;
  const T = grow(discBox(cx, cy, rr, W, H), 3 * f, W, H);
  const holeMask = diskMask(cx - T.x, cy - T.y, rr, T.w, T.h);
  const hole = maskBounds(holeMask, T.w, T.h);
  const read = (r) => crop(photo, r);
  const target = read(T);
  const source = readPadded(read, { x: T.x + D.dx, y: T.y + D.dy, w: T.w, h: T.h }, W, H);
  const side = stackSide(hole, T.w, T.h);
  const full = stackPair(target, source, holeMask, T.w, T.h, side);
  const ts = shrink(target, T.w, T.h, f), ss = shrink(source, T.w, T.h, f);
  const small = stackPair(ts.data, ss.data, shrinkMask(holeMask, T.w, T.h, f), ts.width, ts.height, side);
  const { message } = handleHealMessage({ type: 'correct', job: 1, img: small.img, mask: small.mask, dx: small.dx, dy: small.dy, featherPx: 0 });
  assert.equal(message.type, 'corrected');
  const corr = upsampleCorrection(correctionField(message.tile.data, small), ts.width, ts.height, f, full);
  const out = composeRef(full.img, full.mask, full.dx, full.dy, corr, 2);
  const tile = cutTile(out.data, full.width, hole, full.tx, full.ty, holeMask, T.w);
  let worst = 0;
  for (let y = 0; y < hole.h; y++) {
    for (let x = 0; x < hole.w; x++) {
      const i = (y * hole.w + x) * 4;
      if (!holeMask[(y + hole.y) * T.w + x + hole.x]) { assert.equal(tile[i + 3], 0); continue; }
      assert.equal(tile[i + 3], 255);
      const truth = px(photo, T.x + hole.x + x, T.y + hole.y + y); // the gradient, un-brightened here
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(tile[i + c] - truth[c]));
    }
  }
  assert.ok(worst <= 3, `fill strays ${worst} levels from the gradient`);
});

test('a rub mask built in a window crops to the same pixels as one built on its box', () => {
  const pts = [130.2, 140.7, 170.5, 150.1, 185, 190.4];
  const rr = 9.5;
  const box = clipRect(strokeBounds(pts, rr), 400, 300);
  const win = rubWindow(box, 400, 300, 0).rect;
  const a = strokeMask(mapPoints(pts, box), rr, box.w, box.h);
  const b = strokeMask(mapPoints(pts, win), rr, win.w, win.h);
  let diff = 0;
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) if (a[y * box.w + x] !== b[(y + box.y - win.y) * win.w + x + box.x - win.x]) diff++;
  }
  assert.equal(diff, 0);
});

test('a fill recipe survives structured clone and JSON exactly', () => {
  const tap = { kind: 'tap', cx: 100.123456789, cy: 50.5, rr: 20.004, f: 2, offsets: [{ dx: 40, dy: -3 }, { dx: -41, dy: 2 }], index: 1, D: { dx: -40, dy: 2 }, moved: false, extra: 'dropped', mask: 'data:…' };
  const want = { kind: 'tap', cx: 100.123456789, cy: 50.5, rr: 20.004, f: 2, offsets: [{ dx: 40, dy: -3 }, { dx: -41, dy: 2 }], index: 1, D: { dx: -40, dy: 2 }, moved: false };
  assert.deepEqual(reviveRecipe(structuredClone(recipeRecord(tap))), want);
  assert.deepEqual(reviveRecipe(JSON.parse(JSON.stringify(recipeRecord(tap)))), want);
  const rub = { kind: 'rub', pts: [1.234, 2, 3.5, 4.0001], rr: 7.5, seed: 3, attempt: 2, mask: 'data:…' };
  assert.deepEqual(reviveRecipe(JSON.parse(JSON.stringify(recipeRecord(rub)))), { kind: 'rub', pts: [1.234, 2, 3.5, 4.0001], rr: 7.5, seed: 3, attempt: 2 });
  assert.equal(recipeRecord({ kind: 'tap', cx: 1, cy: 1, rr: 1, f: 1, offsets: [] }), null); // no D: nothing to retry from
  // a typed-array stroke is stored as a plain array
  assert.ok(Array.isArray(recipeRecord({ ...rub, pts: Float64Array.from(rub.pts) }).pts));
});

test('a damaged or missing recipe revives as null, never throws', () => {
  const tap = recipeRecord({ kind: 'tap', cx: 10, cy: 10, rr: 5, f: 1, offsets: [{ dx: 20, dy: 0 }], index: 0, D: { dx: 20, dy: 0 } });
  assert.ok(reviveRecipe(tap));
  for (const bad of [
    null, undefined, 3, 'tap', {}, { kind: 'paint' },
    { ...tap, offsets: [] }, { ...tap, index: 1 }, { ...tap, index: -1 }, { ...tap, f: 0 }, { ...tap, f: 1.5 },
    { ...tap, rr: 0 }, { ...tap, cx: NaN }, { ...tap, D: null }, { ...tap, offsets: [{ dx: 1.5, dy: 0 }] },
    { kind: 'rub', pts: [1, 2, 3], rr: 4, seed: 1, attempt: 0 }, { kind: 'rub', pts: [], rr: 4, seed: 1, attempt: 0 },
    { kind: 'rub', pts: [1, 'x'], rr: 4, seed: 1, attempt: 0 }, { kind: 'rub', pts: [1, 2], rr: -1, seed: 1, attempt: 0 },
    { kind: 'rub', pts: [1, 2], rr: 4 },
  ]) {
    assert.equal(reviveRecipe(bad), null, JSON.stringify(bad));
  }
  assert.equal(recipeRecord(null), null);
});

test('strokeMaskFast marks exactly the pixels lib/heal.js strokeMask does', () => {
  const rand = mulberry32(7);
  const cases = [
    { pts: [10.5, 10.5], r: 0.3 }, // sub-pixel disc: just the pixel it sits in
    { pts: [5, 5, 5, 5], r: 4 }, // a zero-length segment
    { pts: [-20, 30, 140, 30], r: 12.5 }, // horizontal, starting off the image
    { pts: [60, -40, 60, 130], r: 7.25 }, // vertical, through top and bottom
    { pts: [0, 0, 119, 89], r: 0.5 }, // thin diagonal
    { pts: [200, 200, 300, 300], r: 20 }, // wholly off the image
    { pts: [30, 40, NaN, 3, 80, 70], r: 9 }, // a bad point is skipped, as strokeMask does
    { pts: [-30, 45, 150, 45], r: 200 }, // covers everything
  ];
  for (let k = 0; k < 40; k++) {
    const n = 1 + Math.floor(rand() * 8);
    const pts = [];
    for (let i = 0; i < n; i++) pts.push(rand() * 160 - 20, rand() * 130 - 20);
    cases.push({ pts, r: 0.2 + rand() * (k % 3 === 0 ? 3 : 30) });
  }
  for (const { pts, r } of cases) {
    const a = strokeMask(pts, r, 120, 90);
    const b = strokeMaskFast(pts, r, 120, 90);
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    assert.equal(diff, 0, `${diff} pixels differ for r ${r} pts ${pts.map((v) => v.toFixed?.(2)).join(',')}`);
  }
  assert.equal(strokeMaskFast([1, 1], 0, 4, 4).some(Boolean), false);
  assert.throws(() => strokeMaskFast([1, 1], 2, 3.5, 4), RangeError);
});

test('strokeMaskFast stays quick on a capped rub', () => {
  // A zig-zag across a 5453 x 1524 box with a 440 px brush, points every 0.2 r.
  const pts = [];
  const corners = [[600, 900], [5100, 900], [5100, 1500], [600, 1500], [600, 1100], [5100, 1300]];
  for (let i = 0; i + 1 < corners.length; i++) {
    const [ax, ay] = corners[i], [bx, by] = corners[i + 1];
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) / 88);
    for (let k = 0; k < n; k++) pts.push(ax + ((bx - ax) * k) / n - 160, ay + ((by - ay) * k) / n - 450);
  }
  const t = performance.now();
  const m = strokeMaskFast(pts, 440, 5453, 1524);
  assert.ok(performance.now() - t < 400, `took ${performance.now() - t} ms`);
  assert.ok(maskBounds(m, 5453, 1524).area > 5e6);
});

test('shrinkFill is upsampleFill shrunk, without the full-size copy', () => {
  // texture, not just a ramp: a block average must not alias it
  const small = makeImage(37, 23, (x, y) => [x * 6, y * 9, (x * 53 + y * 97) % 256]);
  const win = { x: 100, y: 50, w: 370, h: 230 };
  const T = { x: 130, y: 61, w: 203, h: 151 };
  const ones = new Uint8Array(T.w * T.h).fill(1);
  const full = upsampleFill(small, win, T, ones);
  for (const f of [1, 2, 5, 16, 400]) {
    const want = shrink(full, T.w, T.h, f);
    const got = shrinkFill(small, win, T, f);
    assert.equal(got.width, want.width);
    assert.equal(got.height, want.height);
    let worst = 0;
    for (let i = 0; i < got.data.length; i++) worst = Math.max(worst, Math.abs(got.data[i] - want.data[i]));
    assert.ok(worst <= 1, `f ${f}: off by ${worst}`);
  }
});

test('silhouetteSvg draws the rubbed path into its box as an SVG data URL', () => {
  const url = silhouetteSvg([110, 220, 150.04, 260, 190, 230], 12.34, { x: 100, y: 200, w: 120.5, h: 80 });
  assert.ok(url.startsWith('data:image/svg+xml,'));
  const svg = decodeURIComponent(url.slice('data:image/svg+xml,'.length));
  assert.match(svg, /viewBox="0 0 120.5 80"/);
  assert.match(svg, /preserveAspectRatio="none"/);
  assert.match(svg, /d="M10 20L50 60L90 30"/);
  assert.match(svg, /stroke-width="24.6"/);
  assert.ok(!url.includes('"'), 'safe inside url("…")');
  const dot = decodeURIComponent(silhouetteSvg([105, 210], 3, { x: 100, y: 200, w: 10, h: 10 }).split(',')[1]);
  assert.match(dot, /<circle cx="5" cy="10" r="3"/);
});

// ------------------------------------------------------------------ outlines (SPEC F15)

const TRI = Float32Array.from([20.5, 10.5, 60.5, 30.5, 30.5, 70.5]); // source px

test('outlineBox is polygonBounds grown by DILATE_PX in remove-plan\'s rect shape, clipped', () => {
  const b = polygonBounds(TRI, 1, { width: 200, height: 100, pad: DILATE_PX });
  assert.deepEqual(outlineBox(TRI, 200, 100), { x: b.x, y: b.y, w: b.width, h: b.height });
  assert.deepEqual(outlineBox(TRI, 200, 100), { x: 18, y: 8, w: 45, h: 65 });
  assert.deepEqual(outlineBox(TRI, 40, 100), { x: 18, y: 8, w: 22, h: 65 }, 'clipped to the image');
  assert.equal(outlineBox(TRI, 10, 5), null, 'off the image');
  assert.equal(outlineBox(Float32Array.from([-30, -30, -10, -30, -20, -10]), 100, 100), null);
});

test('outlineMask is the polygon grown by DILATE_PX as a 0/1 mask, like strokeMaskFast', () => {
  const box = outlineBox(TRI, 200, 100);
  const m = outlineMask(TRI, box, box.w, box.h);
  assert.equal(m.length, box.w * box.h);
  assert.ok(m.every((v) => v === 0 || v === 1));
  const want = polygonMask(TRI, { width: box.w, height: box.h, x: box.x, y: box.y, feather: 0, grow: DILATE_PX });
  for (let i = 0; i < m.length; i++) assert.equal(m[i], want[i] ? 1 : 0);
  const bounds = maskBounds(m, box.w, box.h);
  assert.ok(bounds.area > 0);
  // the grown shape fills its box to the edges (the box is the polygon plus the growth)
  assert.ok(bounds.x <= 1 && bounds.y <= 1 && bounds.x + bounds.w >= box.w - 1 && bounds.y + bounds.h >= box.h - 1);
  // inside the triangle's centroid, outside near a far corner
  const cx = Math.round((20.5 + 60.5 + 30.5) / 3 - box.x), cy = Math.round((10.5 + 30.5 + 70.5) / 3 - box.y);
  assert.equal(m[cy * box.w + cx], 1);
  assert.equal(m[box.w - 1], 0);
});

test('an outline mask built in a shrunk window covers the same shape as one on its box', () => {
  const W = 400, H = 300;
  const poly = Float32Array.from([120.5, 80.5, 200.5, 90.5, 230.5, 170.5, 150.5, 210.5, 100.5, 150.5]);
  const box = outlineBox(poly, W, H);
  const win = { x: 60, y: 40, w: 240, h: 220 };
  const full = outlineMask(poly, win, win.w, win.h);
  const onBox = outlineMask(poly, box, box.w, box.h);
  let diff = 0;
  for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) diff += full[(y + box.y - win.y) * win.w + x + box.x - win.x] !== onBox[y * box.w + x];
  assert.equal(diff, 0, 'window and box agree pixel for pixel');
  // at half size the hole is the shape shrunk and grown by DILATE_PX/2 plus the bleed
  const kx = 0.5, ky = 0.5, sw = win.w * kx, sh = win.h * ky;
  const small = outlineMask(poly, win, sw, sh, kx, ky, 2.5);
  const want = polygonMask(transformPolygon(poly, [kx, 0, 0, ky, -win.x * kx, -win.y * ky]), { width: sw, height: sh, feather: 0, grow: DILATE_PX * kx + 2.5 });
  for (let i = 0; i < small.length; i++) assert.equal(small[i], want[i] ? 1 : 0);
  assert.ok(maskBounds(small, sw, sh).area > maskBounds(outlineMask(poly, win, sw, sh, kx, ky), sw, sh).area, 'bleed grows the hole');
});

test('polygonSvg fills the loop into its box as an SVG data URL', () => {
  const url = polygonSvg([110, 220, 150.04, 260, 190, 230], { x: 100, y: 200, w: 120.5, h: 80 });
  assert.ok(url.startsWith('data:image/svg+xml,'));
  const svg = decodeURIComponent(url.slice('data:image/svg+xml,'.length));
  assert.match(svg, /viewBox="0 0 120.5 80"/);
  assert.match(svg, /<path d="M10 20L50 60L90 30Z" fill="#fff"\/>/);
  assert.ok(!url.includes('"'), 'safe inside url("…")');
  assert.ok(!decodeURIComponent(polygonSvg([1, 2, 3, 4], { x: 0, y: 0, w: 10, h: 10 }).split(',')[1]).includes('<path'), 'two points are no loop');
});

test('an outline recipe survives JSON and structured clone; a tap healed from one place keeps its polygon', () => {
  const poly = Float32Array.from([10.04, 20, 30.5, 40.96, 50, 60]);
  const want = { kind: 'outline', poly: Float32Array.from([10, 20, 30.5, 41, 50, 60]), seed: 2, attempt: 1 };
  assert.deepEqual(reviveRecipe(JSON.parse(JSON.stringify(recipeRecord({ kind: 'outline', poly, seed: 2, attempt: 1, mask: 'x' })))), want);
  assert.deepEqual(reviveRecipe(structuredClone(recipeRecord({ kind: 'outline', poly, seed: 2, attempt: 1 }))), want);
  // the stored polygon is already 0.1 px: storing it again changes nothing
  const twice = recipeRecord(reviveRecipe(recipeRecord({ kind: 'outline', poly, seed: 2, attempt: 1 })));
  assert.deepEqual(twice, recipeRecord({ kind: 'outline', poly, seed: 2, attempt: 1 }));
  assert.equal(recipeRecord({ kind: 'outline', poly: [1, 2, 3, 4], seed: 1, attempt: 0 }), null, 'two points are no loop');
  const tap = { kind: 'tap', poly, cx: 30, cy: 40, rr: 25, f: 1, offsets: [{ dx: 80, dy: 0 }], index: 0, D: { dx: 80, dy: 0 }, moved: false };
  const back = reviveRecipe(JSON.parse(JSON.stringify(recipeRecord(tap))));
  assert.deepEqual(back, { ...tap, poly: want.poly });
  assert.equal(back.pts, undefined);
});

test('a damaged outline recipe revives as null', () => {
  const ok = recipeRecord({ kind: 'outline', poly: [1, 2, 3, 4, 5, 6], seed: 1, attempt: 0 });
  assert.ok(reviveRecipe(ok));
  for (const bad of [
    { ...ok, poly: [1, 2, 3, 4] }, { ...ok, poly: [1, 2, 3, 4, 5] }, { ...ok, poly: [1, 2, 3, 4, 5, 'x'] }, { ...ok, poly: null }, { ...ok, poly: [1, 2, 3, 4, 5, NaN] },
    { ...ok, seed: 'a' }, { kind: 'outline', poly: [1, 2, 3, 4, 5, 6] },
  ]) {
    assert.equal(reviveRecipe(bad), null, JSON.stringify(bad));
  }
  const tap = recipeRecord({ kind: 'tap', poly: [1, 2, 3, 4, 5, 6], cx: 3, cy: 3, rr: 5, f: 1, offsets: [{ dx: 20, dy: 0 }], index: 0, D: { dx: 20, dy: 0 } });
  assert.ok(reviveRecipe(tap));
  assert.equal(reviveRecipe({ ...tap, poly: [1, 2] }), null);
  assert.equal(reviveRecipe({ ...tap, pts: [1, 2] }), null, 'a shape is a path or a polygon, not both');
});
