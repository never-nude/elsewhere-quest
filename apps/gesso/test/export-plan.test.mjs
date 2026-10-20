import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JPEG_TYPE, JPEG_QUALITY, RENDER_SHARE, ENCODE_CEILING, bandMatrix, bandRendered, renderProgress, encodeEstimateMs,
  coverRect, clipToBand, compositeOver, shareRoute, shareOutcome, previewFit,
  swipeCloses, sheetOffset, SWIPE_CLOSE_PT, SWIPE_FLICK_MIN_PT,
} from '../lib/export-plan.js';
import { bandPlan } from '../lib/image-io.js';
import { apply } from '../lib/geometry.js';

test('the export is a quality 0.92 JPEG (§5.7)', () => {
  assert.equal(JPEG_TYPE, 'image/jpeg');
  assert.equal(JPEG_QUALITY, 0.92);
  assert.ok(RENDER_SHARE > 0 && RENDER_SHARE < ENCODE_CEILING && ENCODE_CEILING < 1);
});

test('each band matrix puts the band top on row 0 and tiles the output exactly', () => {
  const outW = 5715, outH = 4287;
  const plan = bandPlan(outW, outH);
  assert.ok(plan.length > 1, 'a 24.5 MP export needs several bands');
  let covered = 0;
  for (const band of plan) {
    const m = bandMatrix(band);
    assert.deepEqual(apply(m, 10, band.y), [10, 0], 'first row of the band -> row 0');
    assert.deepEqual(apply(m, 10, band.y + band.h), [10, band.h], 'band bottom -> band height');
    assert.ok(band.h * outW * 4 <= 32 * 2 ** 20, 'band within 32 MB');
    assert.equal(band.y, covered, 'bands are contiguous');
    covered += band.h;
  }
  assert.equal(covered, outH);
});

test('bandRendered accepts an opaque readback and rejects a lost context', () => {
  const ok = new Uint8ClampedArray(4 * 1000).fill(255);
  assert.equal(bandRendered(ok), true);
  assert.equal(bandRendered(new Uint8ClampedArray(4 * 1000)), false, 'all zeros: the context was lost');
  const last = ok.slice();
  last[4 * 999 + 3] = 0;
  assert.equal(bandRendered(last), false, 'the last pixel is always sampled');
  const first = ok.slice();
  first[3] = 0;
  assert.equal(bandRendered(first), false, 'so is the first');
  assert.equal(bandRendered(new Uint8ClampedArray([1, 2, 3, 255])), true, 'one pixel');
  assert.equal(bandRendered(new Uint8ClampedArray(0)), false);
  assert.equal(bandRendered(null), false);
});

test('render progress fills the render share in order, then stops', () => {
  assert.equal(renderProgress(0, 3), 0);
  assert.ok(Math.abs(renderProgress(1, 3) - RENDER_SHARE / 3) < 1e-12);
  assert.equal(renderProgress(3, 3), RENDER_SHARE);
  assert.equal(renderProgress(9, 3), RENDER_SHARE, 'clamped');
  assert.equal(renderProgress(1, 0), RENDER_SHARE, 'no bands = rendered');
});

test('the encode estimate grows with pixels and stays bounded', () => {
  const small = encodeEstimateMs(600, 400), mid = encodeEstimateMs(4000, 3000), big = encodeEstimateMs(5715, 4287);
  assert.ok(small < mid && mid < big);
  assert.ok(small >= 250);
  assert.ok(encodeEstimateMs(1e6, 1e6) <= 20000);
  assert.equal(encodeEstimateMs(-5, 10), 250);
});

test('coverRect unions caption boxes with their margins and clips to the output', () => {
  const r = coverRect([
    { x: 100.4, y: 200.6, width: 50, height: 20, margin: 5 },
    { x: 300, y: 50, width: 10, height: 10 },
  ], 1000, 800);
  // x: floor(95.4) .. 310; y: 50 .. ceil(225.6)
  assert.deepEqual(r, { x: 95, y: 50, width: 215, height: 176 });
  assert.deepEqual(coverRect([{ x: -50, y: -50, width: 2000, height: 2000 }], 1000, 800), { x: 0, y: 0, width: 1000, height: 800 });
  assert.equal(coverRect([{ x: 2000, y: 10, width: 10, height: 10 }], 1000, 800), null, 'entirely off the output');
  assert.equal(coverRect([], 1000, 800), null);
  assert.equal(coverRect([{ x: NaN, y: 0, width: 1, height: 1 }], 10, 10), null, 'unusable boxes are ignored');
});

test('clipToBand keeps only the rows a band holds', () => {
  const rect = { x: 10, y: 90, width: 30, height: 40 };
  assert.deepEqual(clipToBand(rect, { y: 0, h: 100 }), { x: 10, y: 90, width: 30, height: 10 });
  assert.deepEqual(clipToBand(rect, { y: 100, h: 100 }), { x: 10, y: 100, width: 30, height: 30 });
  assert.equal(clipToBand(rect, { y: 130, h: 100 }), null);
  assert.equal(clipToBand(null, { y: 0, h: 100 }), null);
});

test('compositeOver blends straight alpha onto the opaque photo, in place, clipped', () => {
  const W = 4, H = 3;
  const dst = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < dst.length; i += 4) dst.set([100, 150, 200, 255], i);
  // a 3x2 source at (2, 2): only its top-left 2x1 lands on the 4x3 photo
  const src = new Uint8ClampedArray(3 * 2 * 4);
  src.set([255, 0, 0, 255], 0); // opaque red
  src.set([0, 0, 0, 128], 4); // half black
  src.set([9, 9, 9, 0], 8); // transparent (off the photo anyway)
  src.fill(77, 12); // second row: off the photo
  const before = dst.slice();
  const out = compositeOver(dst, W, H, src, 3, 2, 2, 2);
  assert.equal(out, dst, 'in place');
  const px = (x, y) => [...dst.slice((y * W + x) * 4, (y * W + x) * 4 + 4)];
  assert.deepEqual(px(2, 2), [255, 0, 0, 255]);
  assert.deepEqual(px(3, 2), [50, 75, 100, 255], 'source-over: 100*(127/255) etc., rounded');
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (y === 2 && x >= 2) continue;
      assert.deepEqual(px(x, y), [...before.slice((y * W + x) * 4, (y * W + x) * 4 + 4)], `(${x},${y}) untouched`);
    }
  }
});

test('compositeOver matches exact source-over within rounding, and skips clear pixels', () => {
  const dst = new Uint8Array(4 * 256);
  const src = new Uint8Array(4 * 256);
  for (let a = 0; a < 256; a++) {
    dst.set([20, 120, 240, 255], a * 4);
    src.set([250, 10, 128, a], a * 4);
  }
  compositeOver(dst, 256, 1, src, 256, 1, 0, 0);
  for (let a = 0; a < 256; a++) {
    const want = [250, 10, 128].map((s, c) => (s * a + [20, 120, 240][c] * (255 - a)) / 255);
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(dst[a * 4 + c] - want[c]) <= 0.5 + 1e-9, `alpha ${a} channel ${c}`);
    assert.equal(dst[a * 4 + 3], 255, 'stays opaque');
  }
  assert.deepEqual([...dst.slice(0, 4)], [20, 120, 240, 255], 'alpha 0 leaves the photo');
});

test('compositeOver with a source entirely outside the photo changes nothing', () => {
  const dst = new Uint8ClampedArray(16).fill(9);
  const src = new Uint8ClampedArray(16).fill(255);
  compositeOver(dst, 2, 2, src, 2, 2, 5, -7);
  compositeOver(dst, 2, 2, src, 2, 2, -2, 0);
  assert.ok(dst.every((v) => v === 9));
});

test('shareRoute: files need share; canShare is asked when it exists', () => {
  const data = { files: [{}] };
  assert.equal(shareRoute(undefined, data), 'fallback');
  assert.equal(shareRoute({}, data), 'fallback', 'no navigator.share');
  assert.equal(shareRoute({ share() {} }, data), 'share', 'no canShare: try, a rejection falls back');
  assert.equal(shareRoute({ share() {}, canShare: () => true }, data), 'share');
  assert.equal(shareRoute({ share() {}, canShare: () => false }, data), 'fallback');
  assert.equal(shareRoute({ share() {}, canShare: () => { throw new TypeError('bad'); } }, data), 'fallback');
  let asked = null;
  shareRoute({ share() {}, canShare: (d) => { asked = d; return true; } }, data);
  assert.equal(asked, data, 'canShare sees exactly what share will get');
});

test('shareOutcome: resolved saves, AbortError cancels, anything else falls back', () => {
  assert.equal(shareOutcome(null), 'saved');
  assert.equal(shareOutcome(undefined), 'saved');
  const abort = new Error('cancelled');
  abort.name = 'AbortError';
  assert.equal(shareOutcome(abort), 'cancelled');
  const notAllowed = new Error('no activation');
  notAllowed.name = 'NotAllowedError';
  assert.equal(shareOutcome(notAllowed), 'failed');
  assert.equal(shareOutcome(new TypeError('files unsupported')), 'failed');
  assert.equal(shareOutcome('weird'), 'failed');
});

test('previewFit fits the output in the box, never upscales, and renders at DPR', () => {
  // landscape 12 MP into a 408 x 280 box at 3x
  const a = previewFit(4000, 3000, 408, 280, 3);
  assert.deepEqual([a.cssW, a.cssH], [373, 280]);
  assert.equal(a.maxSide, 1119);
  // portrait: height-limited
  const b = previewFit(3024, 4032, 408, 280, 3);
  assert.deepEqual([b.cssW, b.cssH], [210, 280]);
  assert.equal(b.maxSide, 840);
  // a tiny output is not blown up
  const c = previewFit(200, 100, 408, 280, 3);
  assert.deepEqual([c.cssW, c.cssH, c.maxSide], [200, 100, 200]);
  // odd inputs stay usable
  const d = previewFit(4000, 3000, 0, 0, NaN);
  assert.ok(d.cssW >= 1 && d.cssH >= 1 && d.maxSide >= 1);
});

test('a swipe closes past the distance or on a downward flick, never upward', () => {
  assert.equal(swipeCloses(SWIPE_CLOSE_PT, 0), true);
  assert.equal(swipeCloses(SWIPE_CLOSE_PT - 1, 0), false);
  assert.equal(swipeCloses(SWIPE_FLICK_MIN_PT, 1), true, 'flick');
  assert.equal(swipeCloses(SWIPE_FLICK_MIN_PT - 1, 5), false, 'a twitch is not a flick');
  assert.equal(swipeCloses(-200, 3), false);
  assert.equal(swipeCloses(NaN, 1), false);
  assert.equal(sheetOffset(40), 40);
  assert.ok(sheetOffset(-100) < 0 && sheetOffset(-100) > -100, 'upward travel is damped');
  assert.equal(sheetOffset(NaN), 0);
});
