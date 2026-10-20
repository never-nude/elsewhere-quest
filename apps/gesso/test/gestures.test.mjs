import test from 'node:test';
import assert from 'node:assert/strict';
import { initialGestures, reduceGesture, showsBefore, SLOP, HOLD_MS, AXIS_LOCK, AXIS_RATIO } from '../lib/gestures.js';

// Feed a script of events, collect every gesture emitted (with payloads) and the
// wakeAt after each event.
function run(events, state = initialGestures()) {
  const all = [];
  const wakes = [];
  for (const ev of events) {
    const r = reduceGesture(state, ev);
    state = r.state;
    all.push(...r.gestures);
    wakes.push(r.wakeAt);
  }
  return { gestures: all, types: all.map((g) => g.type), state, wakes };
}

const down = (t, x, y, id = 1, extra = {}) => ({ type: 'down', id, x, y, t, ...extra });
const move = (t, x, y, id = 1) => ({ type: 'move', id, x, y, t });
const up = (t, x, y, id = 1) => ({ type: 'up', id, x, y, t });
const cancel = (t, x, y, id = 1) => ({ type: 'cancel', id, x, y, t });
const tick = (t) => ({ type: 'tick', t });

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

test('the arbitration thresholds match SPEC §4', () => {
  assert.equal(SLOP, 8);
  assert.equal(HOLD_MS, 500);
  assert.equal(AXIS_LOCK, 10);
  assert.equal(AXIS_RATIO, 1.5);
});

// ------------------------------------------------------------------ taps

test('a quick still touch is a tap, recognised on lift, with the down point and target', () => {
  const s1 = reduceGesture(initialGestures(), down(0, 100, 100, 1, { target: 'caption:c1' }));
  assert.deepEqual(s1.gestures, []);
  const s2 = reduceGesture(s1.state, move(50, 103, 102));
  assert.deepEqual(s2.gestures, []);
  const s3 = reduceGesture(s2.state, up(120, 103, 102));
  assert.deepEqual(s3.gestures, [{ type: 'tap', x: 100, y: 100, target: 'caption:c1', t: 120 }]);
  assert.equal(s3.state.mode, 'idle');
  assert.equal(s3.wakeAt, null);
});

test('target defaults to photo and unknown axes to free', () => {
  const { gestures } = run([down(0, 5, 5, 1, { axis: 'diagonal' }), up(10, 5, 5)]);
  assert.equal(gestures[0].target, 'photo');
  assert.deepEqual(run([down(0, 0, 0, 1, { axis: 'bogus' }), move(10, 0, 30)]).types, ['drag-start', 'drag']);
});

test('there is no double-tap: two quick taps in the same place are just two taps', () => {
  const r = run([down(0, 100, 100), up(80, 100, 100), down(150, 101, 100), up(200, 101, 100), down(260, 100, 100), up(300, 100, 100)]);
  assert.deepEqual(r.types, ['tap', 'tap', 'tap']);
});

test('a two-finger quick tap is not Undo: it is only an empty pinch', () => {
  const r = run([down(0, 100, 100, 1), down(20, 160, 100, 2), up(120, 100, 100, 1), up(130, 160, 100, 2)]);
  assert.deepEqual(r.types, ['pinch-start', 'pinch-end']);
  assert.ok(!r.types.includes('two-tap') && !r.types.includes('tap'));
});

test('travel of exactly SLOP is still a tap; a hair more is a drag', () => {
  assert.deepEqual(run([down(0, 0, 0), move(20, SLOP, 0), up(40, SLOP, 0)]).types, ['tap']);
  assert.deepEqual(run([down(0, 0, 0), move(20, SLOP + 0.01, 0), up(40, SLOP + 0.01, 0)]).types, ['drag-start', 'drag', 'drag-end']);
  // Travel is measured from the down point, not along the path.
  assert.deepEqual(run([down(0, 0, 0), move(10, 6, 0), move(20, 0, 6), move(30, -6, 0), up(40, 0, 0)]).types, ['tap']);
});

test('a lift just before HOLD_MS is a tap; at HOLD_MS a photo touch is a hold even without a tick', () => {
  assert.deepEqual(run([down(1000, 0, 0), up(1000 + HOLD_MS - 1, 0, 0)]).types, ['tap']);
  assert.deepEqual(run([down(1000, 0, 0), up(1000 + HOLD_MS, 0, 0)]).types, ['hold-start', 'hold-end']);
});

test('a slow still press on a handle, caption, ring or ruler is neither a tap nor a hold', () => {
  for (const target of ['handle:nw', 'caption:a', 'ring', 'ruler']) {
    const r = run([down(0, 0, 0, 1, { target }), tick(HOLD_MS), up(HOLD_MS + 100, 0, 0)]);
    assert.deepEqual(r.types, [], target);
    assert.deepEqual(r.wakes, [null, null, null], `${target} never asks for a hold timer`);
  }
});

// Regression: holds used to fire only for target 'photo', so Crop (whose hitTarget
// reports 'frame' for the whole interior, which is the whole photo on open) could
// never show Before by holding, against SPEC F12 / acceptance check 11.
test("a still press on a tool's own photo-area target (Crop's 'frame') is a hold, like the photo", () => {
  const r = run([down(0, 50, 50, 1, { target: 'frame' }), tick(HOLD_MS), move(600, 90, 50), up(700, 90, 50)]);
  assert.deepEqual(r.types, ['hold-start', 'hold-move', 'hold-end']);
  assert.deepEqual(r.gestures[0], { type: 'hold-start', x: 50, y: 50, target: 'frame' });
  assert.equal(r.wakes[0], HOLD_MS, 'it asks for the hold timer');
  // And a quick drag on it is still a drag that names it.
  const d = run([down(0, 50, 50, 1, { target: 'frame' }), move(20, 90, 50), up(40, 90, 50)]);
  assert.deepEqual(d.types, ['drag-start', 'drag', 'drag-end']);
  assert.equal(d.gestures[0].target, 'frame');
});

test('showsBefore: only handles, captions, the ring and the ruler block a hold (SPEC F12)', () => {
  for (const t of ['photo', 'frame', 'anything-else', undefined]) assert.equal(showsBefore(t), true, String(t));
  for (const t of ['handle:nw', 'handle:se', 'handle', 'caption:c1', 'caption', 'ring', 'ruler']) assert.equal(showsBefore(t), false, t);
  // 'handles' or 'captioned' are not handle/caption targets.
  assert.equal(showsBefore('captioned'), true);
});

test('a cancelled touch is never a tap', () => {
  assert.deepEqual(run([down(0, 0, 0), cancel(50, 0, 0)]).types, []);
});

// ------------------------------------------------------------------ holds

test('a still photo touch asks for a tick at the hold deadline, and the tick starts the hold', () => {
  const s1 = reduceGesture(initialGestures(), down(1000, 200, 200));
  assert.equal(s1.wakeAt, 1000 + HOLD_MS);
  const early = reduceGesture(s1.state, tick(1000 + HOLD_MS - 1));
  assert.deepEqual(early.gestures, []);
  assert.equal(early.wakeAt, 1000 + HOLD_MS, 'an early tick is a no-op that keeps the same deadline');
  const s2 = reduceGesture(early.state, move(1100, 203, 201));
  assert.equal(s2.wakeAt, 1000 + HOLD_MS, 'small jitter keeps the deadline');
  const s3 = reduceGesture(s2.state, tick(1000 + HOLD_MS));
  assert.deepEqual(s3.gestures, [{ type: 'hold-start', x: 200, y: 200, target: 'photo' }]);
  assert.equal(s3.wakeAt, null);
});

test('a hold slides (wipe) and ends on lift; it never becomes a drag', () => {
  const { types, gestures } = run([down(0, 200, 200), tick(HOLD_MS), move(600, 260, 200), move(650, 300, 400), up(700, 300, 400)]);
  assert.deepEqual(types, ['hold-start', 'hold-move', 'hold-move', 'hold-end']);
  assert.deepEqual([gestures[1].x, gestures[1].y], [260, 200]);
});

test('a lift where the finger already was adds no extra move', () => {
  assert.deepEqual(run([down(0, 0, 0), tick(HOLD_MS), move(600, 50, 0), up(700, 50, 0)]).types, ['hold-start', 'hold-move', 'hold-end']);
  assert.deepEqual(run([down(0, 0, 0), move(10, 30, 0), up(20, 30, 0)]).types, ['drag-start', 'drag', 'drag-end']);
});

test('a late timer gives the same gestures as a punctual one', () => {
  const punctual = run([down(0, 10, 10), tick(HOLD_MS), move(700, 80, 10), up(800, 80, 10)]);
  const late = run([down(0, 10, 10), move(700, 80, 10), tick(900), up(800, 80, 10)]);
  assert.deepEqual(late.gestures, punctual.gestures);
});

test('a drag never turns into a hold, and stops asking for a timer', () => {
  const r = run([down(0, 0, 0), move(20, 40, 0), tick(HOLD_MS + 100), up(800, 40, 0)]);
  assert.deepEqual(r.types, ['drag-start', 'drag', 'drag-end']);
  assert.deepEqual(r.wakes, [HOLD_MS, null, null, null]);
});

test('a long rest on a caption still lets the caption be dragged afterwards', () => {
  const r = run([down(0, 50, 50, 1, { target: 'caption:c' }), tick(2000), move(2100, 80, 50), up(2200, 80, 50)]);
  assert.deepEqual(r.types, ['drag-start', 'drag', 'drag-end']);
  assert.equal(r.gestures[0].target, 'caption:c');
});

// ------------------------------------------------------------------ drags

test('travel past SLOP becomes a drag with target, time and deltas from the down point', () => {
  const { types, gestures } = run([down(0, 10, 10, 1, { target: 'handle:se' }), move(30, 10 + SLOP + 1, 10), move(60, 60, 30), up(90, 60, 30)]);
  assert.deepEqual(types, ['drag-start', 'drag', 'drag', 'drag-end']);
  assert.deepEqual(gestures[0], { type: 'drag-start', x: 10, y: 10, target: 'handle:se' });
  assert.deepEqual(gestures[2], { type: 'drag', x: 60, y: 30, dx: 50, dy: 20, t: 60 });
});

test('a flick whose only travel is in the up event is still a drag', () => {
  assert.deepEqual(run([down(0, 0, 0), up(40, 50, 0)]).types, ['drag-start', 'drag', 'drag-end']);
});

test("axis 'x': a horizontal drag scrubs", () => {
  const r = run([down(0, 100, 100, 1, { axis: 'x' }), move(20, 109, 102), move(40, 140, 120), up(60, 140, 120)]);
  assert.deepEqual(r.types, ['drag-start', 'drag', 'drag', 'drag-end']);
  assert.equal(r.gestures.at(-2).dy, 20, 'once locked, later vertical travel is still reported');
});

test("axis 'x': a vertical drag is ignored until lift: no drag, no tap, no hold", () => {
  const r = run([down(0, 100, 100, 1, { axis: 'x' }), move(20, 100, 112), tick(HOLD_MS), move(600, 100, 100), move(650, 140, 100), up(700, 140, 100)]);
  assert.deepEqual(r.types, []);
  assert.equal(r.state.mode, 'idle');
  assert.deepEqual(r.wakes, [HOLD_MS, null, null, null, null, null]);
});

test("axis 'x': the decision can wait until AXIS_LOCK, and no later", () => {
  // Diagonal at 9pt: undecided. Horizontal by 10pt: a drag.
  const late = run([down(0, 0, 0, 1, { axis: 'x' }), move(10, 6, 6.7), move(20, 10, 0.5)]);
  assert.deepEqual(late.types, ['drag-start', 'drag']);
  // Still not horizontal at 10pt: ignored for good, even if it turns horizontal later.
  const never = run([down(0, 0, 0, 1, { axis: 'x' }), move(10, 6, 6.7), move(20, 7, 7.2), move(30, 60, 7), up(40, 60, 7)]);
  assert.deepEqual(never.types, []);
  // A lift while undecided is not a tap (it travelled past SLOP).
  assert.deepEqual(run([down(0, 0, 0, 1, { axis: 'x' }), move(10, 6, 6.7), up(20, 6, 6.7)]).types, []);
});

test("axis 'x': exactly the ratio is not horizontal enough", () => {
  const dy = 6, dx = AXIS_RATIO * dy; // travel ≈ 10.8 > AXIS_LOCK
  assert.deepEqual(run([down(0, 0, 0, 1, { axis: 'x' }), move(10, dx, dy), up(20, dx, dy)]).types, []);
  assert.deepEqual(run([down(0, 0, 0, 1, { axis: 'x' }), move(10, dx + 0.01, dy), up(20, dx + 0.01, dy)]).types, ['drag-start', 'drag', 'drag-end']);
});

test("axis 'x' and 'none' still tap and hold when the finger stays put", () => {
  for (const axis of ['x', 'none']) {
    assert.deepEqual(run([down(0, 0, 0, 1, { axis }), move(10, 3, 3), up(100, 3, 3)]).types, ['tap'], axis);
    assert.deepEqual(run([down(0, 0, 0, 1, { axis }), tick(HOLD_MS), move(600, 0, 90), up(700, 0, 90)]).types, ['hold-start', 'hold-move', 'hold-end'], axis);
  }
});

test("axis 'none': one-finger travel never becomes a drag (nor a tap)", () => {
  const r = run([down(0, 0, 0, 1, { axis: 'none' }), move(10, 30, 0), move(20, 90, 0), tick(HOLD_MS), up(600, 90, 0)]);
  assert.deepEqual(r.types, []);
  assert.deepEqual(run([down(0, 0, 0, 1, { axis: 'none' }), up(40, 90, 0)]).types, []);
});

// ------------------------------------------------------------------ second finger

test('a second finger landing during a drag always cancels it, however long it ran', () => {
  const early = run([down(0, 0, 0), move(30, 20, 0), down(80, 200, 0, 2), move(120, 210, 0, 2), up(200, 20, 0), up(210, 210, 0, 2)]);
  assert.deepEqual(early.types, ['drag-start', 'drag', 'drag-cancel', 'pinch-start', 'pinch', 'pinch-end']);
  const late = run([down(0, 0, 0), move(30, 20, 0), move(400, 300, 0), down(5000, 500, 500, 2), up(5100, 300, 0), up(5110, 500, 500, 2)]);
  assert.deepEqual(late.types, ['drag-start', 'drag', 'drag', 'drag-cancel', 'pinch-start', 'pinch-end']);
  assert.ok(!late.types.includes('drag-end'));
});

test('a second finger during a hold ends the hold and becomes a pinch', () => {
  const r = run([down(0, 0, 0), tick(HOLD_MS), down(700, 100, 0, 2), move(750, 150, 0, 2)]);
  assert.deepEqual(r.types, ['hold-start', 'hold-end', 'pinch-start', 'pinch']);
  // Same result if the hold timer never fired before the second finger landed.
  assert.deepEqual(run([down(0, 0, 0), down(700, 100, 0, 2), move(750, 150, 0, 2)]).types, r.types);
});

test('a second finger before anything was decided makes a pinch, never a tap', () => {
  for (const axis of ['free', 'x', 'none']) {
    const r = run([down(0, 0, 0, 1, { axis }), down(50, 100, 0, 2), up(100, 0, 0, 1), up(110, 100, 0, 2)]);
    assert.deepEqual(r.types, ['pinch-start', 'pinch-end'], axis);
  }
  // Also from an ignored (vertical) axis-x touch.
  assert.deepEqual(run([down(0, 0, 0, 1, { axis: 'x' }), move(10, 0, 30), down(50, 100, 0, 2), move(60, 120, 0, 2)]).types, ['pinch-start', 'pinch']);
});

test('two fingers moving is a pinch with scale, rotation and pan from the start', () => {
  const { types, gestures } = run([
    down(0, 100, 100, 1), down(10, 200, 100, 2),
    move(40, 50, 100, 1), move(41, 250, 100, 2), // spread to double distance
    move(80, 150, 50, 1), move(81, 150, 250, 2), // twist 90°
    up(120, 150, 50, 1), up(130, 150, 250, 2),
  ]);
  assert.deepEqual(gestures[0], { type: 'pinch-start', cx: 150, cy: 100, target: 'photo', onCaption: false });
  const spread = gestures.find((g) => g.type === 'pinch' && Math.abs(g.scale - 2) < 1e-9);
  assert.ok(spread, 'scale 2 reported');
  const last = gestures.filter((g) => g.type === 'pinch').at(-1);
  assert.ok(Math.abs(last.rotation - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(last.scale - 2) < 1e-9);
  assert.equal(last.originX, 150);
  assert.equal(last.originY, 100);
  assert.equal(last.dx, 0);
  assert.equal(last.dy, 50);
  assert.equal(last.onCaption, false);
  assert.equal(types.filter((t) => t === 'pinch-end').length, 1);
  assert.ok(!types.includes('tap') && !types.includes('drag-start'), 'lifting fingers fires nothing stray');
});

test('rotation keeps counting past half a turn instead of wrapping', () => {
  // Finger 2 circles finger 1 three quarters of the way round.
  const steps = [];
  for (let i = 1; i <= 27; i++) {
    const a = (i * 10 * Math.PI) / 180;
    steps.push(move(10 + i, 100 * Math.cos(a), 100 * Math.sin(a), 2));
  }
  const r = run([down(0, 0, 0, 1), down(5, 100, 0, 2), ...steps]);
  const last = r.gestures.at(-1);
  assert.ok(Math.abs(last.rotation - (3 * Math.PI) / 2) < 1e-9, `rotation ${last.rotation}`);
});

test('a pinch whose first finger landed on a caption is a caption pinch', () => {
  const r = run([down(0, 100, 100, 1, { target: 'caption:c7' }), down(30, 200, 100, 2), move(60, 250, 100, 2)]);
  assert.deepEqual(r.gestures[0], { type: 'pinch-start', cx: 150, cy: 100, target: 'caption:c7', onCaption: true });
  assert.equal(r.gestures[1].onCaption, true);
  // Only the FIRST finger counts.
  const second = run([down(0, 100, 100, 1), down(30, 200, 100, 2, { target: 'caption:c7' }), move(60, 250, 100, 2)]);
  assert.equal(second.gestures[0].onCaption, false);
  assert.equal(second.gestures[1].onCaption, false);
  // A caption drag interrupted by a second finger becomes the caption pinch.
  const dragged = run([down(0, 100, 100, 1, { target: 'caption:c7' }), move(20, 130, 100), down(40, 300, 100, 2), up(60, 300, 100, 2)]);
  assert.deepEqual(dragged.types, ['drag-start', 'drag', 'drag-cancel', 'pinch-start', 'pinch-end']);
  assert.deepEqual(dragged.gestures[2], { type: 'drag-cancel', target: 'caption:c7' });
  assert.equal(dragged.gestures[3].onCaption, true);
  // pinch-end says which pinch ended, so the Text tool can commit its one step.
  assert.deepEqual(dragged.gestures[4], { type: 'pinch-end', target: 'caption:c7', onCaption: true });
});

test('drag-end names the target the drag started on', () => {
  const r = run([down(0, 0, 0, 1, { target: 'ring' }), move(10, 30, 0), up(20, 30, 0)]);
  assert.deepEqual(r.gestures.at(-1), { type: 'drag-end', target: 'ring' });
});

test('after a pinch the remaining finger does nothing; a new second finger pinches again', () => {
  const r = run([
    down(0, 0, 0, 1), down(10, 100, 0, 2), move(20, 120, 0, 2),
    up(30, 120, 0, 2), // pinch ends, finger 1 remains
    move(40, 60, 0, 1), move(50, 90, 40, 1), tick(5000), // nothing
    down(6000, 200, 40, 3), move(6010, 250, 40, 3), // a fresh pinch with finger 1 first
    up(6020, 250, 40, 3), up(6030, 90, 40, 1),
  ]);
  assert.deepEqual(r.types, ['pinch-start', 'pinch', 'pinch-end', 'pinch-start', 'pinch', 'pinch-end']);
  assert.deepEqual([r.gestures[3].cx, r.gestures[3].cy], [145, 40]);
  assert.equal(r.state.mode, 'idle');
});

test('a third finger is ignored and unknown pointers are harmless', () => {
  const r = run([
    down(0, 0, 0, 1), down(5, 50, 0, 2), down(8, 90, 0, 3),
    move(20, 500, 500, 3), // the third finger moving changes nothing
    up(50, 0, 0, 1), up(60, 50, 0, 2), up(70, 90, 0, 3),
    move(80, 1, 1, 9), up(90, 1, 1, 9), cancel(95, 1, 1, 9),
  ]);
  assert.deepEqual(r.types, ['pinch-start', 'pinch-end']);
  assert.equal(r.state.mode, 'idle');
  assert.deepEqual(r.state.pointers, {});
});

// ------------------------------------------------------------------ cancel, reset, robustness

test('pointercancel cancels a drag, ends a hold and a pinch cleanly', () => {
  assert.deepEqual(run([down(0, 0, 0), move(10, 30, 0), cancel(20, 30, 0)]).types, ['drag-start', 'drag', 'drag-cancel']);
  assert.deepEqual(run([down(0, 0, 0), tick(HOLD_MS), cancel(600, 0, 0)]).types, ['hold-start', 'hold-end']);
  assert.deepEqual(run([down(0, 0, 0), down(10, 50, 0, 2), cancel(20, 50, 0, 2), up(30, 0, 0)]).types, ['pinch-start', 'pinch-end']);
});

// A tool that acts on a held finger (Outline claims the hold) must tell a lift
// from an interruption: only a lift is a plain hold-end.
test('a hold that is interrupted says so', () => {
  const last = (evs) => run(evs).gestures.find((g) => g.type === 'hold-end');
  assert.deepEqual(last([down(0, 0, 0), tick(HOLD_MS), up(600, 0, 0)]), { type: 'hold-end' });
  assert.deepEqual(last([down(0, 0, 0), tick(HOLD_MS), cancel(600, 0, 0)]), { type: 'hold-end', cancelled: true });
  assert.deepEqual(last([down(0, 0, 0), tick(HOLD_MS), { type: 'reset' }]), { type: 'hold-end', cancelled: true });
  assert.deepEqual(last([down(0, 0, 0), tick(HOLD_MS), down(600, 50, 0, 2)]), { type: 'hold-end', cancelled: true });
});

test('reset drops everything and says what ended', () => {
  const drag = run([down(0, 0, 0), move(10, 30, 0), { type: 'reset' }]);
  assert.deepEqual(drag.types, ['drag-start', 'drag', 'drag-cancel']);
  assert.deepEqual(drag.state, initialGestures());
  assert.equal(drag.wakes.at(-1), null);
  assert.deepEqual(run([down(0, 0, 0), tick(HOLD_MS), { type: 'reset' }]).types, ['hold-start', 'hold-end']);
  assert.deepEqual(run([down(0, 0, 0), down(1, 9, 9, 2), { type: 'reset' }]).types, ['pinch-start', 'pinch-end']);
  // Lifting the forgotten fingers afterwards is harmless.
  assert.deepEqual(run([down(0, 0, 0), { type: 'reset' }, up(30, 0, 0)]).types, []);
});

test('the same pointer id landing again ends the stale touch first', () => {
  const r = run([down(0, 0, 0), move(10, 30, 0), down(500, 200, 200), up(550, 200, 200)]);
  assert.deepEqual(r.types, ['drag-start', 'drag', 'drag-cancel', 'tap']);
  assert.deepEqual(r.gestures.at(-1), { type: 'tap', x: 200, y: 200, target: 'photo', t: 550 });
});

test('a missing or malformed state starts fresh', () => {
  for (const bad of [undefined, null, {}, { pointers: {} }]) {
    const r = reduceGesture(bad, down(0, 1, 1));
    assert.equal(r.state.mode, 'pending');
    assert.equal(r.wakeAt, HOLD_MS);
  }
});

test('junk events are ignored without throwing', () => {
  const r = run([
    null, undefined, 42, {}, { type: 'wiggle' },
    down(0, NaN, 0), down(0, 0, Infinity), down(undefined, 0, 0),
    down(0, 10, 10), move(10, NaN, 50), move(20, 10, undefined), tick(NaN), up(Number.NaN, 10, 10),
  ]);
  assert.deepEqual(r.types, []);
  assert.equal(r.state.mode, 'idle');
});

test('the reducer never mutates its input state, through a whole script', () => {
  const script = [
    down(0, 0, 0, 1, { target: 'caption:x' }), move(10, 20, 0), down(20, 90, 0, 2), move(30, 120, 10, 2),
    up(40, 120, 10, 2), move(50, 30, 30), up(60, 30, 30),
    down(100, 5, 5), tick(HOLD_MS + 100), move(700, 40, 5), up(800, 40, 5),
  ];
  let s = deepFreeze(initialGestures());
  for (const ev of script) {
    const snapshot = structuredClone(s);
    const r = reduceGesture(s, ev); // frozen input: any write would throw in strict mode
    assert.deepEqual(s, snapshot);
    s = deepFreeze(r.state);
  }
});

test('the same script always gives the same gestures', () => {
  const script = [down(0, 0, 0), move(5, 3, 0), move(15, 30, 4), down(40, 90, 0, 2), move(60, 120, 30, 2), up(70, 120, 30, 2), up(80, 30, 4)];
  assert.deepEqual(run(script).gestures, run(script).gestures);
});
