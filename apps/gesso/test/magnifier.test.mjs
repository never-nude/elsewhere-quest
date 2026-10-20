import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SIZE, INSET, TOP, MAG, AVOID, HYST, FADE_MS, MOVE_PT,
  windowRect, rectDistance, initialCorner, pickCorner, sourceRect, readSide, magnifyTransform, fadeAlpha, movedFar,
} from '../lib/magnifier.js';
import { fitView } from '../lib/view.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const PORTRAIT = 440; // stage width on the 17 Pro Max
const LANDSCAPE = 560; // the stage beside the 384 pt column at 956x440
const NARROW = 402; // the 17 Pro

test('the window sits 12 pt in from the edge and 10 pt down, in either corner', () => {
  assert.deepEqual(windowRect('left', PORTRAIT), { x: INSET, y: TOP, w: SIZE, h: SIZE });
  assert.deepEqual(windowRect('right', PORTRAIT), { x: PORTRAIT - INSET - SIZE, y: TOP, w: SIZE, h: SIZE });
  assert.equal(windowRect('right', LANDSCAPE).x + SIZE + INSET, LANDSCAPE);
  assert.equal(SIZE, 140);
  assert.equal(MAG, 3);
});

test('rectDistance is 0 inside, the edge gap beside, the corner gap diagonally', () => {
  const r = { x: 10, y: 10, w: 100, h: 100 };
  assert.equal(rectDistance(r, 50, 50), 0);
  assert.equal(rectDistance(r, 10, 10), 0);
  assert.equal(rectDistance(r, 140, 50), 30);
  assert.equal(rectDistance(r, 50, 2), 8);
  assert.ok(near(rectDistance(r, 113, 114), 5));
});

test('starts top-left, or top-right when the finger is already under the left window', () => {
  assert.equal(initialCorner(220, 300, PORTRAIT), 'left');
  assert.equal(initialCorner(80, 80, PORTRAIT), 'right');
  assert.equal(initialCorner(INSET + SIZE + AVOID, 80, PORTRAIT), 'left'); // exactly at reach: not near
  assert.equal(initialCorner(INSET + SIZE + AVOID - 1, 80, PORTRAIT), 'right');
});

test('the window jumps away when the finger comes within 40 pt of it', () => {
  const left = windowRect('left', PORTRAIT);
  const edgeX = left.x + left.w + AVOID;
  assert.equal(pickCorner('left', edgeX, 80, PORTRAIT), 'left');
  assert.equal(pickCorner('left', edgeX - 0.5, 80, PORTRAIT), 'right');
  assert.equal(pickCorner('left', 80, left.y + left.h + AVOID - 1, PORTRAIT), 'right');
  // a finger over the window itself, too
  assert.equal(pickCorner('left', 60, 60, PORTRAIT), 'right');
  // …and far below it, no
  assert.equal(pickCorner('left', 60, 400, PORTRAIT), 'left');
  // symmetric for the right corner
  const right = windowRect('right', PORTRAIT);
  assert.equal(pickCorner('right', right.x - AVOID + 1, 80, PORTRAIT), 'left');
  assert.equal(pickCorner('right', right.x - AVOID, 80, PORTRAIT), 'right');
});

test('a finger jittering at the threshold never bounces the window back', () => {
  const left = windowRect('left', PORTRAIT);
  const x = left.x + left.w + AVOID - 1; // just inside the left window's reach
  let corner = 'left';
  const seen = [];
  for (const dx of [0, 1, -1, 2, -2, 0, 3, -3, 0]) {
    corner = pickCorner(corner, x + dx, 80, PORTRAIT);
    seen.push(corner);
  }
  assert.deepEqual([...new Set(seen)], ['right'], 'jumped once and stayed');
});

test('an approach to the other corner brings it back, once, with a dead band', () => {
  let corner = 'left';
  const jumps = [];
  // sweep left to right along the top of the stage and back
  const xs = [];
  for (let x = 220; x >= 100; x -= 4) xs.push(x);
  for (let x = 100; x <= PORTRAIT - 100; x += 4) xs.push(x);
  for (let x = PORTRAIT - 100; x >= 100; x -= 4) xs.push(x);
  for (const x of xs) {
    const next = pickCorner(corner, x, 80, PORTRAIT);
    if (next !== corner) jumps.push([x, next]);
    corner = next;
  }
  assert.deepEqual(jumps.map(([, c]) => c), ['right', 'left', 'right']);
  // the second jump happened near the right window, after leaving the left one by the dead band
  const [[x1], [x2]] = jumps;
  assert.ok(x1 <= INSET + SIZE + AVOID, `first jump at ${x1}`);
  assert.ok(rectDistance(windowRect('left', PORTRAIT), x2, 80) >= AVOID + HYST, `second jump at ${x2} is clear of the left window`);
  assert.ok(rectDistance(windowRect('right', PORTRAIT), x2, 80) < AVOID, `…and within reach of the right one`);
});

test('on a narrow stage with both corners crowded it stays put', () => {
  // 402 wide: 98 pt between the windows, so a finger at the top centre is within
  // 49 of each. Near the left, the right is not clear by 64: stay.
  const mid = NARROW / 2;
  assert.ok(rectDistance(windowRect('left', NARROW), mid, 80) < AVOID + HYST);
  assert.equal(pickCorner('left', mid - 12, 80, NARROW), 'left');
  assert.equal(pickCorner('right', mid + 12, 80, NARROW), 'right');
  // the window still gets out of the way of a finger that is fully over it
  assert.equal(pickCorner('left', 40, 80, NARROW), 'right');
});

test('sourceRect reads 140/3 stage pt of photo around the finger, one window px per readback texel', () => {
  const out = { width: 4000, height: 3000 };
  const view = fitView(out.width, out.height, PORTRAIT, 496, 12); // scale 0.104
  const finger = { x: 220, y: 248 };
  const src = sourceRect(finger, view, out);
  const span = SIZE / 2 / view.scale / MAG;
  const [cx, cy] = [(finger.x - view.x) / view.scale, (finger.y - view.y) / view.scale];
  assert.ok(near(src.rect.x, cx - span) && near(src.rect.y, cy - span));
  assert.ok(near(src.rect.w, 2 * span) && near(src.rect.h, 2 * span));
  assert.ok(src.dest.x === 0 && src.dest.y === 0 && near(src.dest.w, SIZE) && near(src.dest.h, SIZE), JSON.stringify(src.dest));
  assert.ok(near(src.scale, view.scale * MAG));
  assert.equal(readSide(src, 3), 420);
  assert.equal(readSide(src, 2), 280);
  // the stage pt the window spans
  assert.ok(near(src.rect.w * view.scale, SIZE / MAG));
});

test('sourceRect is clamped to the photo and the clamped part lands where the photo is', () => {
  const out = { width: 4000, height: 3000 };
  const view = fitView(out.width, out.height, PORTRAIT, 496, 12);
  // a finger 5 stage pt inside the photo's top-left corner
  const finger = { x: view.x + 5, y: view.y + 5 };
  const src = sourceRect(finger, view, out);
  assert.equal(src.rect.x, 0);
  assert.equal(src.rect.y, 0);
  const span = SIZE / 2 / view.scale / MAG;
  assert.ok(near(src.rect.w, 5 / view.scale + span));
  // the cut-off part is the left/top of the window: the photo starts 5 stage pt (x3) short of the centre
  assert.ok(near(src.dest.x, SIZE / 2 - 5 * MAG), `${src.dest.x}`);
  assert.ok(near(src.dest.y, SIZE / 2 - 5 * MAG));
  assert.ok(near(src.dest.x + src.dest.w, SIZE));
  assert.ok(near(src.scale, view.scale * MAG));
  // the readback stays at the same density
  assert.equal(readSide(src, 3), Math.round(3 * src.dest.w));
  // a finger off the far side of the photo: the right edge of the photo clamps
  const far = sourceRect({ x: view.x + out.width * view.scale + 2, y: 248 }, view, out);
  assert.ok(near(far.rect.x + far.rect.w, out.width));
  assert.ok(far.dest.x === 0 && near(far.dest.x + far.dest.w, SIZE / 2 - 2 * MAG));
});

test('sourceRect is null with no photo in reach', () => {
  const out = { width: 4000, height: 3000 };
  const view = fitView(out.width, out.height, PORTRAIT, 496, 12);
  assert.equal(sourceRect({ x: view.x - 30, y: 248 }, view, out), null);
  assert.equal(sourceRect({ x: 220, y: view.y + out.height * view.scale + 30 }, view, out), null);
  assert.notEqual(sourceRect({ x: view.x - 20, y: 248 }, view, out), null); // 23.3 pt reach
});

test('magnifyTransform puts the finger at the window centre and scales 3x about it', () => {
  const r = windowRect('left', PORTRAIT);
  const finger = { x: 300, y: 400 };
  const [a, b, c, d, e, f] = magnifyTransform(r, finger);
  const map = (x, y) => [a * x + c * y + e, b * x + d * y + f];
  assert.deepEqual(map(finger.x, finger.y), [r.x + r.w / 2, r.y + r.h / 2]);
  const [x, y] = map(finger.x + 10, finger.y - 4);
  assert.ok(near(x, r.x + r.w / 2 + 30) && near(y, r.y + r.h / 2 - 12));
  // the snap reach (18 pt) ring fits inside the window with room to spare
  assert.ok(18 * MAG * 2 < SIZE);
});

test('fadeAlpha is 1 while down, 0 after 300 ms, linear between', () => {
  assert.equal(fadeAlpha(1000, null), 1);
  assert.equal(fadeAlpha(1000, 1000), 1);
  assert.ok(near(fadeAlpha(1150, 1000), 0.5));
  assert.equal(fadeAlpha(1000 + FADE_MS, 1000), 0);
  assert.equal(fadeAlpha(5000, 1000), 0);
  assert.equal(fadeAlpha(900, 1000), 1); // a clock that went backwards is not a fade
});

test('movedFar needs more than 2 pt', () => {
  assert.equal(movedFar({ x: 0, y: 0 }, { x: MOVE_PT, y: 0 }), false);
  assert.equal(movedFar({ x: 0, y: 0 }, { x: 1.5, y: 1.5 }), true);
  assert.equal(movedFar(null, { x: 0, y: 0 }), true);
});
