import test from 'node:test';
import assert from 'node:assert/strict';
import { FRAME_SLOP, insideFrame, centerOn, dragBy } from '../lib/navpan.js';
import { fitView, zoomAt, clampView, navigatorFrame, stageToContent } from '../lib/view.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const NAV_W = 88, NAV_H = 66;
const STAGE = { w: 440, h: 496 };
const CONTENT = { w: 4032, h: 2688 };

function zoomed(factor = 4) {
  const fit = fitView(CONTENT.w, CONTENT.h, STAGE.w, STAGE.h, 12);
  return clampView(zoomAt(fit, factor, STAGE.w / 2, STAGE.h / 2), CONTENT.w, CONTENT.h, STAGE.w, STAGE.h);
}
const frameOf = (v) => navigatorFrame(v, STAGE.w, STAGE.h, CONTENT.w, CONTENT.h, NAV_W, NAV_H);

test('insideFrame grabs the frame with a little slop', () => {
  const f = { x: 20, y: 10, width: 10, height: 8 };
  assert.ok(insideFrame(f, 25, 14));
  assert.ok(insideFrame(f, 20 - FRAME_SLOP, 10 - FRAME_SLOP));
  assert.ok(!insideFrame(f, 20 - FRAME_SLOP - 1, 14));
  assert.ok(!insideFrame(f, 25, 18 + FRAME_SLOP + 1));
  assert.ok(insideFrame(f, 31, 14, 1) && !insideFrame(f, 32, 14, 1));
});

test('centerOn puts the touched content point in the middle of the stage', () => {
  const v = zoomed();
  const f = frameOf(v);
  const nx = f.offsetX + 1000 * f.scale, ny = f.offsetY + 700 * f.scale;
  const c = centerOn(v, f, nx, ny, STAGE.w, STAGE.h);
  const [cx, cy] = stageToContent(c, STAGE.w / 2, STAGE.h / 2);
  assert.ok(near(cx, 1000) && near(cy, 700));
  assert.equal(c.scale, v.scale);
  assert.equal(c.fit, v.fit);
});

test('the frame follows the finger', () => {
  const v = zoomed();
  const f0 = frameOf(v);
  const moved = clampView(dragBy(v, f0, -6, 4), CONTENT.w, CONTENT.h, STAGE.w, STAGE.h);
  const f1 = frameOf(moved);
  assert.ok(near(f1.x, f0.x - 6, 1e-6), `${f1.x} vs ${f0.x - 6}`);
  assert.ok(near(f1.y, f0.y + 4, 1e-6), `${f1.y} vs ${f0.y + 4}`);
  assert.ok(near(f1.width, f0.width) && near(f1.height, f0.height));
});

test('dragging past the edge stops the frame at the edge', () => {
  const v = zoomed();
  const f0 = frameOf(v);
  const far = clampView(dragBy(v, f0, 500, 500), CONTENT.w, CONTENT.h, STAGE.w, STAGE.h);
  const f = frameOf(far);
  assert.ok(near(f.x + f.width, f.offsetX + CONTENT.w * f.scale, 1e-6));
  assert.ok(near(f.y + f.height, f.offsetY + CONTENT.h * f.scale, 1e-6));
});

test('a drag measured from its start does not drift', () => {
  const v = zoomed(3);
  const f0 = frameOf(v);
  let last = v;
  for (const d of [3, 9, 14, 9, 3, 0]) last = dragBy(v, f0, d, 0);
  assert.ok(near(last.x, v.x) && near(last.y, v.y));
});
