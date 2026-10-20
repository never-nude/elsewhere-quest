import test from 'node:test';
import assert from 'node:assert/strict';
import { initialGestures, reduceGesture, SLOP, HOLD_MS, TWO_TAP_MS } from '../lib/gestures.js';

// Feed a script of events, collect every gesture type emitted (with payloads).
function run(events, state = initialGestures()) {
  const all = [];
  for (const ev of events) {
    const r = reduceGesture(state, ev);
    state = r.state;
    all.push(...r.gestures);
  }
  return { gestures: all, types: all.map((g) => g.type), state };
}

const down = (t, x, y, id = 1) => ({ type: 'down', id, x, y, t });
const move = (t, x, y, id = 1) => ({ type: 'move', id, x, y, t });
const up = (t, x, y, id = 1) => ({ type: 'up', id, x, y, t });
const tick = (t) => ({ type: 'tick', t });

test('a quick still touch is a tap', () => {
  const { types, gestures, state } = run([down(0, 100, 100), move(50, 103, 102), up(120, 103, 102)]);
  assert.deepEqual(types, ['tap']);
  assert.deepEqual([gestures[0].x, gestures[0].y], [100, 100]);
  assert.equal(state.mode, 'idle');
});

test('two taps close together also fire double-tap; far apart they do not', () => {
  assert.deepEqual(run([down(0, 100, 100), up(80, 100, 100), down(200, 110, 105), up(260, 110, 105)]).types, ['tap', 'tap', 'double-tap']);
  assert.deepEqual(run([down(0, 100, 100), up(80, 100, 100), down(200, 300, 300), up(260, 300, 300)]).types, ['tap', 'tap']);
  assert.deepEqual(run([down(0, 100, 100), up(80, 100, 100), down(900, 100, 100), up(960, 100, 100)]).types, ['tap', 'tap']);
});

test('a triple tap is double-tap then a fresh tap', () => {
  const ev = [down(0, 50, 50), up(50, 50, 50), down(150, 50, 50), up(200, 50, 50), down(300, 50, 50), up(350, 50, 50)];
  assert.deepEqual(run(ev).types, ['tap', 'tap', 'double-tap', 'tap']);
});

test('travel past SLOP becomes a drag with deltas from the start', () => {
  const { types, gestures } = run([down(0, 10, 10), move(30, 10 + SLOP + 1, 10), move(60, 60, 30), up(90, 60, 30)]);
  assert.deepEqual(types, ['drag-start', 'drag', 'drag', 'drag-end']);
  assert.deepEqual([gestures[2].dx, gestures[2].dy], [50, 20]);
});

test('a slow touch is not a tap, and a still hold fires hold-start / hold-move / hold-end', () => {
  assert.deepEqual(run([down(0, 0, 0), up(600, 0, 0)]).types, []);
  const { types, gestures } = run([down(0, 200, 200), tick(HOLD_MS - 1), tick(HOLD_MS), move(500, 260, 200), up(700, 260, 200)]);
  assert.deepEqual(types, ['hold-start', 'hold-move', 'hold-end']);
  assert.equal(gestures[1].x, 260);
});

test('a drag never turns into a hold', () => {
  const { types } = run([down(0, 0, 0), move(20, 40, 0), tick(HOLD_MS + 100), up(800, 40, 0)]);
  assert.deepEqual(types, ['drag-start', 'drag', 'drag-end']);
});

test('two fingers moving is a pinch with scale, rotation and pan from the start', () => {
  const { types, gestures } = run([
    down(0, 100, 100, 1), down(10, 200, 100, 2),
    move(40, 50, 100, 1), move(41, 250, 100, 2), // spread to double distance
    move(80, 150, 50, 1), move(81, 150, 250, 2), // twist 90°
    up(120, 150, 50, 1), up(130, 150, 250, 2),
  ]);
  assert.equal(types[0], 'pinch-start');
  const spread = gestures.find((g) => g.type === 'pinch' && Math.abs(g.scale - 2) < 1e-9);
  assert.ok(spread, 'scale 2 reported');
  const last = gestures.filter((g) => g.type === 'pinch').at(-1);
  assert.ok(Math.abs(last.rotation - Math.PI / 2) < 1e-9);
  assert.equal(last.originX, 150);
  assert.ok(types.includes('pinch-end'));
  assert.ok(!types.includes('tap') && !types.includes('drag-start'), 'lifting fingers fires nothing stray');
});

test('two fingers down and up quickly without moving is a two-tap', () => {
  assert.deepEqual(run([down(0, 100, 100, 1), down(20, 160, 100, 2), up(120, 100, 100, 1), up(130, 160, 100, 2)]).types, ['two-tap']);
  // too slow: nothing
  assert.deepEqual(run([down(0, 100, 100, 1), down(20, 160, 100, 2), up(20 + TWO_TAP_MS + 50, 100, 100, 1), up(400, 160, 100, 2)]).types, []);
});

test('a second finger landing early in a drag cancels the stroke; late, it commits it', () => {
  const early = run([down(0, 0, 0), move(30, 20, 0), down(80, 200, 0, 2), move(120, 210, 0, 2), up(200, 20, 0), up(210, 210, 0, 2)]);
  assert.deepEqual(early.types.slice(0, 3), ['drag-start', 'drag', 'drag-cancel']);
  const late = run([down(0, 0, 0), move(30, 20, 0), move(400, 300, 0), down(600, 500, 500, 2), up(700, 300, 0), up(710, 500, 500, 2)]);
  assert.ok(late.types.includes('drag-end') && !late.types.includes('drag-cancel'));
});

test('pointercancel ends a drag as a cancel, and a hold cleanly', () => {
  assert.deepEqual(run([down(0, 0, 0), move(10, 30, 0), { type: 'cancel', id: 1, x: 30, y: 0, t: 20 }]).types, ['drag-start', 'drag', 'drag-cancel']);
  assert.deepEqual(run([down(0, 0, 0), tick(HOLD_MS), { type: 'cancel', id: 1, x: 0, y: 0, t: 500 }]).types, ['hold-start', 'hold-end']);
});

test('a third finger is ignored and unknown pointers are harmless', () => {
  const r = run([down(0, 0, 0, 1), down(5, 50, 0, 2), down(8, 90, 0, 3), up(50, 0, 0, 1), up(60, 50, 0, 2), up(70, 90, 0, 3), move(80, 1, 1, 9), up(90, 1, 1, 9)]);
  assert.equal(r.state.mode, 'idle');
  assert.ok(!r.types.includes('tap'));
});

test('the reducer never mutates its input state', () => {
  const s0 = initialGestures();
  const frozen = structuredClone(s0);
  reduceGesture(s0, down(0, 1, 1));
  assert.deepEqual(s0, frozen);
});
