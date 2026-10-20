import test from 'node:test';
import assert from 'node:assert/strict';
import {
  orientedSize, rectFits, maxCenteredRect, aspectValue, initialCrop, isIdentityCrop,
  setAspect, setAngle, rotateQuarter, toggleTall, isTall, flipHorizontal, moveRect, dragHandle, MIN_CROP,
  multiply, invert, apply, sourceToOriented, outputToSource, sourceToOutput, outputSize,
} from '../lib/geometry.js';

const W = 4000, H = 3000;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const assertPt = (p, q, eps = 1e-6) => assert.ok(near(p[0], q[0], eps) && near(p[1], q[1], eps), `${p} ≈ ${q}`);
const fitsCrop = (crop) => {
  const o = orientedSize(W, H, crop.quarter);
  return rectFits(crop.rect, o.width, o.height, crop.angle);
};

test('orientedSize swaps on odd quarter turns', () => {
  assert.deepEqual(orientedSize(W, H, 0), { width: W, height: H });
  assert.deepEqual(orientedSize(W, H, 1), { width: H, height: W });
  assert.deepEqual(orientedSize(W, H, 2), { width: W, height: H });
  assert.deepEqual(orientedSize(W, H, 3), { width: H, height: W });
});

test('initial crop is the identity and covers the image', () => {
  const c = initialCrop(W, H);
  assert.ok(isIdentityCrop(c, W, H));
  assert.ok(fitsCrop(c));
  assert.deepEqual(outputSize(c), { width: W, height: H });
  assertPt(apply(outputToSource(c, W, H), 0, 0), [0, 0]);
  assertPt(apply(outputToSource(c, W, H), W, H), [W, H]);
});

test('maxCenteredRect at 0° is the full image and shrinks as the angle grows', () => {
  const r0 = maxCenteredRect(W, H, 0);
  assert.ok(near(r0.width, W) && near(r0.height, H));
  let prev = r0.width;
  for (const a of [1, 5, 10, 20, 45]) {
    const r = maxCenteredRect(W, H, a);
    assert.ok(r.width < prev);
    assert.ok(rectFits(r, W, H, a));
    // and it is maximal: 0.5% bigger no longer fits
    const big = { x: r.x * 1.005, y: r.y * 1.005, width: r.width * 1.005, height: r.height * 1.005 };
    assert.ok(!rectFits(big, W, H, a));
    assert.ok(near(r.width / r.height, W / H, 1e-9));
    prev = r.width;
  }
  assert.ok(near(maxCenteredRect(W, H, -12).width, maxCenteredRect(W, H, 12).width));
});

test('aspectValue resolves presets and original', () => {
  assert.equal(aspectValue('free', W, H), null);
  assert.equal(aspectValue('square', W, H), 1);
  assert.ok(near(aspectValue('original', W, H), 4 / 3));
  assert.ok(near(aspectValue('9:16', W, H), 9 / 16));
  assert.throws(() => aspectValue('7:5', W, H), /unknown aspect/);
});

test('setAspect fits the largest rect of that ratio', () => {
  const sq = setAspect(initialCrop(W, H), W, H, 'square');
  assert.equal(sq.aspect, 'square');
  assert.ok(near(sq.rect.width, H) && near(sq.rect.height, H));
  assert.ok(fitsCrop(sq));
  const tall = setAspect(initialCrop(W, H), W, H, '9:16');
  assert.ok(near(tall.rect.height, H) && near(tall.rect.width, H * 9 / 16));
  const free = setAspect(sq, W, H, 'free');
  assert.deepEqual(free.rect, sq.rect);
});

test('setAngle never shows empty corners and restores fully at 0°', () => {
  let c = initialCrop(W, H);
  for (const a of [0.5, 3, 8.2, -15, 30, 45, 60, -90]) {
    c = setAngle(c, W, H, a);
    assert.ok(fitsCrop(c), `fits at ${a}`);
    assert.ok(Math.abs(c.angle) <= 45);
    assert.ok(near(c.rect.width / c.rect.height, W / H, 1e-9), 'aspect kept');
  }
  c = setAngle(c, W, H, 0);
  assert.ok(near(c.rect.width, W, 1e-6) && near(c.rect.height, H, 1e-6));
});

test('setAngle keeps a tightened crop tight and off-centre framing where it fits', () => {
  let c = initialCrop(W, H);
  c = { ...c, rect: { x: 200, y: -400, width: 1200, height: 900 } }; // tight, right of centre
  const s = setAngle(c, W, H, 5);
  assert.ok(fitsCrop(s));
  assert.ok(s.rect.width <= 1200 + 1e-9);
  assert.ok(near(s.rect.x + s.rect.width / 2, 800, 1)); // centre kept
});

test('rotateQuarter turns the rect, swaps aspect presets, and 4 turns are the identity', () => {
  let c = setAspect(initialCrop(W, H), W, H, '4:5');
  const start = structuredClone(c);
  c = rotateQuarter(c, W, H);
  assert.equal(c.quarter, 1);
  assert.equal(c.aspect, '5:4');
  assert.ok(fitsCrop(c));
  for (let i = 0; i < 3; i++) c = rotateQuarter(c, W, H);
  assert.equal(c.quarter, 0);
  assert.equal(c.aspect, '4:5');
  for (const k of ['x', 'y', 'width', 'height']) assert.ok(near(c.rect[k], start.rect[k], 1e-6));
});

test('flipHorizontal mirrors framing and the straighten angle; twice is the identity', () => {
  let c = setAngle({ ...initialCrop(W, H), rect: { x: -1800, y: -1000, width: 1000, height: 750 } }, W, H, 7);
  const f = flipHorizontal(c);
  assert.equal(f.angle, -7);
  assert.ok(f.flip);
  assert.ok(near(f.rect.x, -(c.rect.x + c.rect.width)));
  assert.ok(fitsCrop(f));
  const ff = flipHorizontal(f);
  assert.deepEqual(ff, c);
});

test('rotate after flip still turns clockwise on screen', () => {
  // A source pixel at the top-left of the view should move to the top-right after a turn.
  const base = flipHorizontal(initialCrop(W, H));
  const topLeftSrc = apply(outputToSource(base, W, H), 1, 1);
  const turned = rotateQuarter(base, W, H);
  const out = apply(sourceToOutput(turned, W, H), ...topLeftSrc);
  const size = outputSize(turned);
  assert.ok(near(out[0], size.width - 1, 1e-6) && near(out[1], 1, 1e-6), `got ${out}`);
});

test('moveRect slides along edges instead of escaping the image', () => {
  const c = setAspect(initialCrop(W, H), W, H, 'square'); // 3000 x 3000 centred
  const m = moveRect(c, W, H, 10_000, 50);
  assert.ok(fitsCrop(m));
  assert.ok(near(m.rect.x + m.rect.width, W / 2, 0.01)); // pinned to the right edge
  const t = moveRect(c, W, H, 100, 0);
  assert.ok(near(t.rect.x, c.rect.x + 100));
});

test('dragHandle resizes freely, respects the minimum, and stays inside', () => {
  const c = initialCrop(W, H);
  const d = dragHandle(c, W, H, 'se', -1000, -500);
  assert.ok(near(d.rect.width, W - 1000) && near(d.rect.height, H - 500));
  assert.ok(near(d.rect.x, c.rect.x) && near(d.rect.y, c.rect.y));
  const out = dragHandle(c, W, H, 'nw', -500, -500); // can't grow past the image
  assert.ok(fitsCrop(out));
  const tiny = dragHandle(c, W, H, 'e', -W, 0);
  assert.ok(tiny.rect.width >= MIN_CROP - 0.01);
});

test('dragHandle with a locked aspect pins the opposite corner', () => {
  const c = setAspect(initialCrop(W, H), W, H, 'square');
  const d = dragHandle(c, W, H, 'nw', 600, 300);
  assert.ok(near(d.rect.width, d.rect.height, 1e-6));
  assert.ok(near(d.rect.x + d.rect.width, c.rect.x + c.rect.width, 1e-6));
  assert.ok(near(d.rect.y + d.rect.height, c.rect.y + c.rect.height, 1e-6));
  assert.ok(fitsCrop(d));
});

test('matrix helpers: invert and multiply round-trip', () => {
  const m = [0.8, 0.6, -0.6, 0.8, 120, -40];
  const id = multiply(m, invert(m));
  [1, 0, 0, 1, 0, 0].forEach((v, i) => assert.ok(near(id[i], v, 1e-9)));
  assert.throws(() => invert([1, 2, 2, 4, 0, 0]), /singular/);
});

test('sourceToOriented maps corners correctly for every quarter and flip', () => {
  const cases = [
    [0, false, [0, 0], [0, 0]], [1, false, [0, 0], [H, 0]], [2, false, [0, 0], [W, H]], [3, false, [0, 0], [0, W]],
    [0, true, [0, 0], [W, 0]], [1, true, [0, 0], [0, 0]],
  ];
  for (const [q, f, src, dst] of cases) assertPt(apply(sourceToOriented(W, H, q, f), ...src), dst);
});

test('outputToSource lands every output corner inside the source image', () => {
  let c = initialCrop(W, H);
  c = setAngle(c, W, H, 11);
  c = rotateQuarter(c, W, H);
  c = flipHorizontal(c);
  c = setAspect(c, W, H, '4:5');
  const m = outputToSource(c, W, H);
  const { width, height } = outputSize(c);
  for (const [x, y] of [[0, 0], [width, 0], [0, height], [width, height]]) {
    const [sx, sy] = apply(m, x, y);
    assert.ok(sx >= -0.5 && sx <= W + 0.5 && sy >= -0.5 && sy <= H + 0.5, `${sx},${sy}`);
  }
  // and sourceToOutput is its inverse
  const back = apply(sourceToOutput(c, W, H), ...apply(m, 123, 456));
  assertPt(back, [123, 456], 1e-6);
});

test('counter-clockwise rotation undoes clockwise, flipped or not', () => {
  for (const flip of [false, true]) {
    let c = setAspect({ ...initialCrop(W, H), flip }, W, H, '4:5');
    c = setAngle(c, W, H, 6);
    const start = structuredClone(c);
    const back = rotateQuarter(rotateQuarter(c, W, H), W, H, { ccw: true });
    assert.equal(back.quarter, start.quarter);
    assert.equal(back.aspect, start.aspect);
    for (const k of ['x', 'y', 'width', 'height']) assert.ok(near(back.rect[k], start.rect[k], 1e-6));
  }
});

test('rotate counter-clockwise moves the top-right of the view to the top-left', () => {
  const base = initialCrop(W, H);
  const size0 = outputSize(base);
  const topRightSrc = apply(outputToSource(base, W, H), size0.width - 1, 1);
  const turned = rotateQuarter(base, W, H, { ccw: true });
  const out = apply(sourceToOutput(turned, W, H), ...topRightSrc);
  assert.ok(near(out[0], 1, 1e-6) && near(out[1], 1, 1e-6), `got ${out}`);
});

test('toggleTall turns 4:5 into 5:4 and back, and leaves free/square alone', () => {
  const tall = setAspect(initialCrop(W, H), W, H, '4:5');
  assert.ok(isTall(tall));
  const wide = toggleTall(tall, W, H);
  assert.equal(wide.aspect, '5:4');
  assert.ok(!isTall(wide));
  assert.ok(fitsCrop(wide));
  assert.equal(toggleTall(wide, W, H).aspect, '4:5');
  const sq = setAspect(initialCrop(W, H), W, H, 'square');
  assert.equal(toggleTall(sq, W, H), sq);
  assert.equal(toggleTall(initialCrop(W, H), W, H).aspect, 'free');
});
