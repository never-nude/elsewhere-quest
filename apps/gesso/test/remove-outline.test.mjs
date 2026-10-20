// Remove › Outline's edge map, driven the way the editor drives it: built off the
// finger when the chip comes on, never under a loop being traced, and rebuilt off
// the finger when a loop ends after a fill landed meanwhile (the fill's own
// rebuild had to skip: `trace` was set), so the next drag-start never pays for it.
// The editor and renderer are fakes; the lasso and the magnifier's placement are real.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDoc } from '../lib/doc.js';
import { fitView, stageToContent } from '../lib/view.js';
import { outputSize } from '../lib/geometry.js';
import { mulberry32 } from '../lib/inpaint.js';

// ui/magnifier.js reads pixels into a 2D canvas: enough of the DOM for that to run.
const noop = () => {};
const ctx2d = () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => { t[k] = v; return true; } });
globalThis.window ??= globalThis;
globalThis.document ??= { createElement: () => ({ width: 0, height: 0, getContext: ctx2d }), getElementById: () => null }; // no #shimmer
globalThis.ImageData ??= class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
globalThis.localStorage ??= { getItem: () => null, setItem: noop };

const { default: remove } = await import('../ui/tools/remove.js');

const W = 600, H = 480; // source = output = analysis px (≤ 1024)
const STAGE = { width: 402, height: 486 };

function photo(seed = 5) {
  const rand = mulberry32(seed);
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inside = x >= 180 && x < 380 && y >= 140 && y < 300;
      const v = Math.round((inside ? 200 : 40) + (rand() - 0.5) * 12), i = (y * W + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

function fakeEditor() {
  const history = [createDoc({ id: 'd1', sourceType: 'jpeg', natW: W, natH: H, w: W, h: H, now: 0 })];
  let at = 0;
  let view = null;
  const ensureView = () => (view ??= fitView(W, H, STAGE.width, STAGE.height, 12));
  const ed = {
    log: { reads: [], renders: 0 },
    session: 1,
    get doc() { return history[at]; },
    get committed() { return history[at]; },
    get revision() { return at; },
    get view() { return ensureView(); },
    renderer: { size: { width: W, height: H } },
    panel: { showTip: noop },
    stageSize: () => STAGE,
    requestRender() { ed.log.renders++; },
    hint: noop,
    refresh: noop,
    toast: noop,
    outputSize: () => outputSize(ed.committed.crop),
    stageToDoc: (x, y) => stageToContent(ensureView(), x, y),
    docToStage: (x, y) => { const v = ensureView(); return [v.x + x * v.scale, v.y + y * v.scale]; },
    sourcePerStagePx() { return 1 / ensureView().scale; },
    readOutput({ maxSide = 512, rect = null, tone = false } = {}) {
      ed.log.reads.push({ maxSide, rect: !!rect, tone });
      if (rect) return { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) };
      return photo();
    },
    // A fill landed: the step's `remove` is a new list, which the edge map is keyed on.
    fillLanded() {
      const st = history[at];
      history.push({ ...st, remove: [...st.remove, `p${at}`] });
      at++;
    },
  };
  return ed;
}

const builds = (ed) => ed.log.reads.filter((r) => !r.rect && r.maxSide === 1024).length;
const tick = () => new Promise((r) => setTimeout(r, 0)); // the map builds on a setTimeout(0)
const P = [120, 160]; // stage px, on the photo
const start = (ed, t) => assert.ok(remove.onGesture(ed, { type: 'drag-start', target: 'photo', x: P[0], y: P[1], t }), 'the drag is taken');
// What the fill's landing does when the edge map's photo changed (its `finally`), with `trace` still set.
const fillLandsMidLoop = async (ed) => { ed.fillLanded(); remove.onHistory(ed); await tick(); };

test('the edge map: built off the finger when Outline comes on, never under a loop', async () => {
  const ed = fakeEditor();
  remove.open(ed);
  remove.onDial(ed, 'outline');
  assert.equal(builds(ed), 0, 'not built on the tap itself');
  await tick();
  assert.equal(builds(ed), 1, 'built once the tap is over');
  start(ed, 1000);
  remove.onGesture(ed, { type: 'drag', target: 'photo', x: 150, y: 170, dx: 0, dy: 0, t: 1016 });
  assert.equal(builds(ed), 1, 'fresh: nothing read under the finger');
  const before = builds(ed);
  await fillLandsMidLoop(ed);
  assert.equal(builds(ed), before, 'the rebuild waits for the finger');
  remove.close(ed, { cancel: false });
});

test('a fill landing mid-loop: the map is rebuilt off the finger when the loop ends, on every exit', async () => {
  const ed = fakeEditor();
  remove.open(ed);
  remove.onDial(ed, 'outline');
  await tick();
  // cancelled (a second finger, a pointercancel)
  start(ed, 1000);
  await fillLandsMidLoop(ed);
  remove.onGesture(ed, { type: 'hold-end', cancelled: true }); // only a loop can be under a held finger
  assert.equal(builds(ed), 1, 'not on the lift itself');
  await tick();
  assert.equal(builds(ed), 2, 'rebuilt off the finger after the cancel');
  start(ed, 2000);
  assert.equal(builds(ed), 2, 'the next loop starts on the fresh map: no build under the finger');
  remove.onGesture(ed, { type: 'drag-cancel', t: 2100 });
  await tick();
  assert.equal(builds(ed), 2, 'still fresh: a loop ending on a fresh map reads nothing');
  // lifted (a tap-sized loop: no fill, but the same exit)
  start(ed, 3000);
  await fillLandsMidLoop(ed);
  remove.onGesture(ed, { type: 'drag-end', x: P[0], y: P[1], t: 3100 });
  await tick();
  assert.equal(builds(ed), 3, 'rebuilt off the finger after the lift');
  start(ed, 4000);
  assert.equal(builds(ed), 3);
  remove.onGesture(ed, { type: 'drag-cancel', t: 4100 });
  await tick();
  // leaving the tool, or Outline, drops the map instead of rebuilding it
  start(ed, 5000);
  await fillLandsMidLoop(ed);
  remove.close(ed, { cancel: false });
  await tick();
  assert.equal(builds(ed), 3, 'close: no stray build');
  remove.open(ed);
  remove.onDial(ed, 'outline');
  await tick();
  assert.equal(builds(ed), 4);
  start(ed, 6000);
  await fillLandsMidLoop(ed);
  remove.onDial(ed, 'outline'); // off
  await tick();
  assert.equal(builds(ed), 4, 'Outline off: no stray build');
  remove.close(ed, { cancel: false });
});

// A loop under a held finger (hold-start, claimsHold) ends with hold-end, which the
// reducer also says for a second finger landing (then pinch-start in the same
// batch) and, marked, for a cancel. Only a real lift fills.
test('a held loop: hold-end then pinch-start in one batch is no fill; a plain lift ends it on the next microtask', async () => {
  const ed = fakeEditor();
  remove.open(ed);
  remove.onDial(ed, 'outline');
  await tick();
  const hold = (t) => assert.ok(remove.onGesture(ed, { type: 'hold-start', target: 'photo', x: P[0], y: P[1], t }), 'a still finger starts the loop');
  // second finger: hold-end (unmarked) then pinch-start, the editor's pinch still its own
  hold(1000);
  remove.onGesture(ed, { type: 'hold-move', x: P[0] + 40, y: P[1] + 10 });
  remove.onGesture(ed, { type: 'hold-move', x: P[0] + 60, y: P[1] + 50 });
  assert.ok(remove.onGesture(ed, { type: 'hold-end' }), 'the lift is the tool\'s');
  assert.equal(remove.onGesture(ed, { type: 'pinch-start', cx: P[0], cy: P[1], target: 'photo' }), false);
  await Promise.resolve();
  assert.equal(remove.settle(), null, 'no fill asked for');
  await tick();
  assert.equal(builds(ed), 1, 'a loop cancelled on a fresh map reads nothing');
  // the same, marked by the reducer
  hold(2000);
  assert.ok(remove.onGesture(ed, { type: 'hold-end', cancelled: true }));
  await tick();
  assert.equal(remove.settle(), null);
  // a plain lift: the loop ends a microtask later (a tap-sized one: no fill, but the exit runs)
  hold(3000);
  const renders = ed.log.renders;
  assert.ok(remove.onGesture(ed, { type: 'hold-end' }));
  assert.equal(ed.log.renders, renders, 'nothing yet: the batch may still bring a pinch-start');
  await Promise.resolve();
  assert.ok(ed.log.renders > renders, 'the loop closed on the next microtask');
  assert.equal(remove.onGesture(ed, { type: 'pinch-start', cx: P[0], cy: P[1], target: 'photo' }), false, 'a later pinch finds no loop to cancel');
  // and the next held loop starts clean
  hold(4000);
  remove.onGesture(ed, { type: 'drag-cancel', t: 4100 });
  remove.close(ed, { cancel: false });
});
