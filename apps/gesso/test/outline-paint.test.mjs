import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EV_MAX, FEATHER_PX, DEFAULT_AMOUNT, ERASE_AMOUNT,
  entryFromRuler, rulerFromEntry, amountEV, outlineLabel, isOutlineEntry, paintMaskSize, outlinePaint, traceAnchors, newEntryId,
} from '../lib/outline-paint.js';
import { polygonRecord } from '../lib/lasso.js';

const SRC = { width: 4000, height: 3000 };
const SCALE = 0.25;
// A 400 x 300 source-px rectangle, stored the way a pool entry stores it.
const RECT = polygonRecord([800, 600, 1200, 600, 1200, 900, 800, 900]);

test('the ruler is signed: right brightens, left darkens, ±100 is ±1.5 EV, +67 about +1 EV', () => {
  assert.deepEqual(entryFromRuler(67), { mode: 'brighten', amount: 0.67 });
  assert.deepEqual(entryFromRuler(-30), { mode: 'darken', amount: 0.3 });
  assert.deepEqual(entryFromRuler(0), { mode: 'brighten', amount: 0 });
  assert.deepEqual(entryFromRuler(100), { mode: 'brighten', amount: 1 });
  assert.deepEqual(entryFromRuler(-250), { mode: 'darken', amount: 1 }, 'clamped');
  assert.deepEqual(entryFromRuler(NaN), { mode: 'brighten', amount: DEFAULT_AMOUNT / 100 }, 'junk is the default');
  assert.deepEqual(entryFromRuler(-80, 'erase'), { mode: 'erase', amount: ERASE_AMOUNT }, 'erase ignores the ruler');
  assert.deepEqual(entryFromRuler(0, 'darken'), { mode: 'darken', amount: 0 }, 'the segment names the mode where the sign cannot');
  assert.deepEqual(entryFromRuler(-0, 'darken'), { mode: 'darken', amount: 0 });
  assert.deepEqual(entryFromRuler(40, 'darken'), { mode: 'darken', amount: 0.4 }, 'and wins over the sign');
  assert.deepEqual(entryFromRuler(-40, 'brighten'), { mode: 'brighten', amount: 0.4 });
  assert.equal(outlineLabel(entryFromRuler(0, 'darken').mode), 'Darkened inside outline');
  assert.equal(EV_MAX, 1.5);
  assert.ok(Math.abs(amountEV(entryFromRuler(100)) - 1.5) < 1e-9);
  assert.ok(Math.abs(amountEV(entryFromRuler(67)) - 1.005) < 1e-9);
  assert.ok(Math.abs(amountEV(entryFromRuler(-100)) + 1.5) < 1e-9);
  assert.equal(amountEV(entryFromRuler(0, 'erase')), 0);
});

test('an entry reads back as the ruler value it was made from', () => {
  for (const v of [-100, -67, -1, 0, 1, 42, 67, 100]) {
    assert.equal(rulerFromEntry({ kind: 'outline', ...entryFromRuler(v), poly: RECT }), v, `${v}`);
  }
  assert.equal(rulerFromEntry({ kind: 'outline', mode: 'erase', amount: 1, poly: RECT }), DEFAULT_AMOUNT, 'an erase has no amount');
  assert.equal(rulerFromEntry(null), DEFAULT_AMOUNT);
  assert.equal(rulerFromEntry({ mode: 'darken', amount: 7 }), -100, 'clamped');
});

test('labels name the step the way Undo reads it', () => {
  assert.equal(outlineLabel('brighten'), 'Brightened inside outline');
  assert.equal(outlineLabel('darken'), 'Darkened inside outline');
  assert.equal(outlineLabel('erase'), 'Erased inside outline');
});

test('isOutlineEntry accepts what endTrace stores and nothing else', () => {
  assert.ok(isOutlineEntry({ kind: 'outline', mode: 'brighten', poly: RECT, amount: 0.67 }));
  assert.ok(isOutlineEntry({ kind: 'outline', mode: 'erase', poly: RECT, amount: 1 }));
  assert.ok(!isOutlineEntry({ mode: 'brighten', r: 24, pts: [1, 2, 3, 4] }), 'a brush stroke');
  assert.ok(!isOutlineEntry({ kind: 'outline', mode: 'smudge', poly: RECT, amount: 0.5 }));
  assert.ok(!isOutlineEntry({ kind: 'outline', mode: 'brighten', poly: [1, 2, 3, 4], amount: 0.5 }), 'two points');
  assert.ok(!isOutlineEntry({ kind: 'outline', mode: 'brighten', poly: RECT, amount: 1.5 }));
  assert.ok(!isOutlineEntry({ kind: 'outline', mode: 'brighten', poly: RECT, amount: NaN }));
  assert.ok(!isOutlineEntry(null));
});

test('paintMaskSize rounds like renderer.clearPaint', () => {
  assert.deepEqual(paintMaskSize(4000, 3000, 0.25), { width: 1000, height: 750 });
  assert.deepEqual(paintMaskSize(3, 2, 0.25), { width: 1, height: 1 });
  assert.deepEqual(paintMaskSize(9000, 6000, 2048 / 9000), { width: 2048, height: 1365 });
});

test('outlinePaint rasterises the polygon at the mask scale: full inside, zero outside, a soft edge between', () => {
  const p = outlinePaint(RECT, SRC, SCALE);
  assert.ok(p);
  const pad = Math.ceil(FEATHER_PX / 2) + 1;
  assert.deepEqual([p.rect.x, p.rect.y, p.rect.w, p.rect.h], [800 - pad / SCALE, 600 - pad / SCALE, 400 + (2 * pad) / SCALE, 300 + (2 * pad) / SCALE], 'rect is the padded box in source px');
  assert.equal(p.w, 100 + 2 * pad);
  assert.equal(p.h, 75 + 2 * pad);
  assert.equal(p.mask.length, p.w * p.h);
  const at = (mx, my) => p.mask[(my - p.rect.y * SCALE) * p.w + (mx - p.rect.x * SCALE)]; // mask px of the whole mask
  assert.equal(at(250, 187), 255, 'deep inside');
  assert.equal(at(200 + 10, 150 + 10), 255, 'inside, past the feather');
  assert.equal(at(197, 147), 0, 'outside, past the feather');
  assert.equal(at(196, 187), 0, '4 px left of the edge');
  const edge = at(200, 187), inner = at(202, 187), outer = at(198, 187);
  assert.ok(edge > 100 && edge < 160, `the edge itself is half (${edge})`);
  assert.ok(inner > edge && outer < edge, 'a ramp across the edge');
  assert.ok(at(203, 187) === 255 && at(196, 187) === 0 && at(197, 187) > 0 && at(202, 187) < 255, `a ${FEATHER_PX} px ramp (197..202)`);
});

test('outlinePaint is deterministic and clips to the mask', () => {
  const a = outlinePaint(RECT, SRC, SCALE), b = outlinePaint(Float32Array.from(RECT), SRC, SCALE);
  assert.deepEqual(a.mask, b.mask, 'the same texels from the stored numbers and from the live polygon');
  const edge = outlinePaint(polygonRecord([-100, -100, 200, -100, 200, 200, -100, 200]), SRC, SCALE);
  assert.deepEqual([edge.rect.x, edge.rect.y], [0, 0], 'a loop off the corner starts at the texture');
  assert.equal(edge.mask[0], 255);
  assert.equal(outlinePaint(polygonRecord([-100, -100, -50, -100, -50, -50]), SRC, SCALE), null, 'wholly off the photo');
  assert.equal(outlinePaint([1, 2, 3, 4], SRC, SCALE), null, 'not a polygon');
  assert.equal(outlinePaint(RECT, SRC, 0), null);
});

test('traceAnchors drops one every `spacing` px of 8-connected length, measured on the source path', () => {
  // A 10 px straight run, then a 10 px diagonal: lengths 10 and 10√2.
  const src = [];
  for (let i = 0; i <= 10; i++) src.push(i, 0);
  for (let i = 1; i <= 10; i++) src.push(10 + i, i);
  const stage = src.map((v) => v * 2);
  assert.deepEqual(traceAnchors(stage, 10, src), [20, 0, 36, 16], 'at 10 straight, then after 8 diagonals (7√2 < 10 ≤ 8√2)');
  assert.deepEqual(traceAnchors(stage, 100, src), []);
  assert.deepEqual(traceAnchors(stage, 0, src), []);
  assert.deepEqual(traceAnchors(src, 5), [5, 0, 10, 0, 14, 4, 18, 8]);
});

test('entry ids are strings that never collide with stroke ids', () => {
  const a = newEntryId(1000, 0.5), b = newEntryId(1000, 0.25);
  assert.match(a, /^o[0-9a-z]+$/);
  assert.notEqual(a, b);
  assert.notEqual(newEntryId(), newEntryId());
});
