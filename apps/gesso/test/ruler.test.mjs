import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RULERS, stepValue, formatValue, valueText, clampValue, isDefault, nudge, ticks, isDoubleTap,
  FAST_PT_PER_MS, FAST_GAIN, DETENT_PT, DOUBLE_TAP_MS,
} from '../lib/ruler.js';

const B = RULERS.brightness;
const SLOW = 0.1; // pt/ms
const FAST = 1.0;

// Drive a whole drag: a list of [dxPt, speed] moves from a starting value.
function drag(spec, value, moves) {
  let ds = null;
  const ticks = [];
  for (const [dx, speed] of moves) {
    const r = stepValue(spec, value, dx, speed, ds);
    value = r.value;
    ds = r.detentState;
    ticks.push(r.ticked);
  }
  return { value, ds, ticks };
}

const repeat = (n, move) => Array.from({ length: n }, () => move);

test('every ruler in the spec table exists with sane limits', () => {
  const ids = ['brightness', 'contrast', 'highlights', 'shadows', 'warmth', 'tint', 'vividness', 'strength', 'straighten', 'removeSize', 'textSize', 'textAngle'];
  assert.deepEqual(Object.keys(RULERS).sort(), [...ids].sort());
  for (const [id, s] of Object.entries(RULERS)) {
    assert.equal(s.id, id);
    assert.ok(s.label, id);
    assert.ok(s.min < s.max, id);
    assert.ok(s.def >= s.min && s.def <= s.max, `${id} default in range`);
    assert.ok(s.unitsPerPt > 0 && s.tick > 0 && s.major >= s.tick && s.nudge > 0, id);
    assert.ok(s.detents.includes(s.def), `${id} sticks at its default`);
    for (const d of s.detents) assert.ok(d >= s.min && d <= s.max, `${id} detent ${d} in range`);
    assert.ok(Object.isFrozen(s) && Object.isFrozen(s.detents), `${id} is frozen`);
  }
  for (const id of ['brightness', 'contrast', 'highlights', 'shadows', 'warmth', 'tint', 'vividness']) {
    assert.deepEqual([RULERS[id].min, RULERS[id].max, RULERS[id].def, RULERS[id].unitsPerPt], [-100, 100, 0, 0.25], id);
  }
  assert.deepEqual([RULERS.strength.min, RULERS.strength.max, RULERS.strength.def, RULERS.strength.unitsPerPt], [0, 100, 100, 0.25]);
  assert.deepEqual([RULERS.straighten.min, RULERS.straighten.max, RULERS.straighten.def, RULERS.straighten.unitsPerPt], [-45, 45, 0, 0.1]);
  assert.deepEqual([RULERS.removeSize.min, RULERS.removeSize.max, RULERS.removeSize.def, RULERS.removeSize.unitsPerPt], [8, 120, 36, 0.25]);
  assert.deepEqual([RULERS.textSize.min, RULERS.textSize.max, RULERS.textSize.def], [0.03, 0.3, 0.08]);
  assert.deepEqual([RULERS.textAngle.min, RULERS.textAngle.max, RULERS.textAngle.def], [-180, 180, 0]);
  assert.deepEqual([...RULERS.textAngle.detents].sort((a, b) => a - b), [-90, 0, 90]);
});

test('a slow drag moves 1 unit per 4pt, right = more, and slow 1pt moves add up', () => {
  assert.equal(drag(B, 0, [[40, SLOW]]).value, 10);
  assert.equal(drag(B, 0, [[-40, SLOW]]).value, -10);
  // Forty 1pt moves must not each round away to nothing.
  assert.equal(drag(B, 20, repeat(40, [1, SLOW])).value, 30);
  assert.equal(drag(B, 20, repeat(40, [-1, SLOW])).value, 10);
});

test('straighten moves 0.1° per pt', () => {
  assert.equal(drag(RULERS.straighten, 2, [[10, SLOW]]).value, 3);
  assert.equal(drag(RULERS.straighten, 2, repeat(7, [1, SLOW])).value, 2.7);
  assert.equal(drag(RULERS.straighten, -2, [[-3, SLOW]]).value, -2.3);
});

test('above 0.6pt/ms the gain is 3x; at exactly 0.6 it is not', () => {
  assert.equal(drag(B, 20, [[40, FAST]]).value, 20 + 10 * FAST_GAIN);
  assert.equal(drag(B, 20, [[40, FAST_PT_PER_MS]]).value, 30);
  assert.equal(drag(B, 20, [[40, FAST_PT_PER_MS + 0.01]]).value, 50);
  assert.equal(drag(B, 50, [[-40, -FAST]]).value, 20, 'a signed speed counts by magnitude');
  for (const bad of [NaN, undefined, null, -0]) assert.equal(drag(B, 20, [[40, bad]]).value, 30, String(bad));
});

test('the value never jumps: a drag starting anywhere starts from that value', () => {
  assert.deepEqual(stepValue(B, 37, 0, SLOW, null), { value: 37, detentState: { raw: 37, held: null }, ticked: false });
  assert.equal(stepValue(B, 37, 2, SLOW, null).value, 38); // 37.5 rounds away from zero
  assert.equal(stepValue(B, -37, -2, SLOW, null).value, -38, 'and symmetrically to the left');
});

test('the value clamps at the ends and reverses at once (the rubber band is visual only)', () => {
  const pushed = drag(B, 90, [[400, SLOW]]);
  assert.equal(pushed.value, 100);
  assert.equal(pushed.ds.raw, 100, 'no hidden travel stored past the end');
  const back = drag(B, 90, [[400, SLOW], [-8, SLOW]]);
  assert.equal(back.value, 98);
  assert.equal(drag(B, -90, [[-4000, FAST]]).value, -100);
  assert.equal(drag(RULERS.removeSize, 20, [[-4000, FAST]]).value, 8);
});

test('the default is a sticky detent for 12pt of travel, and it ticks when it snaps', () => {
  // From +5 going left: 20pt reaches 0, then the next 12pt stay at 0.
  let r = stepValue(B, 5, -20, SLOW, null);
  assert.equal(r.value, 0);
  assert.equal(r.ticked, true);
  let ds = r.detentState;
  for (let i = 0; i < DETENT_PT - 1; i++) {
    r = stepValue(B, 0, -1, SLOW, ds);
    assert.equal(r.value, 0, `held after ${i + 1}pt`);
    assert.equal(r.ticked, false, 'ticks once, on the snap');
    ds = r.detentState;
  }
  r = stepValue(B, 0, -1, SLOW, ds); // the 12th pt pulls free with no excess yet
  assert.equal(r.value, 0);
  assert.equal(r.detentState.held, null);
  r = stepValue(B, 0, -4, SLOW, r.detentState);
  assert.equal(r.value, -1, 'free again: 4pt is one unit');
});

test('a detent can be pulled free to either side', () => {
  // Arrive from the right, then go back right: also needs 12pt.
  const back = drag(B, 5, [[-20, SLOW], [11, SLOW]]);
  assert.equal(back.value, 0);
  assert.equal(drag(B, 5, [[-20, SLOW], [12 + 8, SLOW]]).value, 2);
});

test('passing a detent costs the same travel however the motion is sliced', () => {
  const whole = drag(B, -10, [[40 + DETENT_PT + 20, SLOW]]);
  const sliced = drag(B, -10, repeat(40 + DETENT_PT + 20, [1, SLOW]));
  assert.equal(whole.value, 5);
  assert.equal(sliced.value, 5);
  assert.equal(whole.ticks[0], true, 'flicking straight through still reports the tick');
  // Fast: the units come 3x quicker but the detent still costs 12pt of finger travel.
  assert.equal(drag(B, -30, [[40 + DETENT_PT + 16, FAST]]).value, 12);
});

test('starting exactly on a detent does not stick', () => {
  assert.equal(drag(B, 0, [[4, SLOW]]).value, 1);
  assert.equal(drag(B, 0, [[-4, SLOW]]).value, -1);
  assert.deepEqual(drag(B, 0, [[4, SLOW]]).ticks, [false]);
});

test('extra detents: text angle sticks at 0 and ±90', () => {
  const A = RULERS.textAngle; // 0.5°/pt
  assert.equal(drag(A, 80, [[30, SLOW]]).value, 90);
  assert.equal(drag(A, 80, [[30, SLOW], [1, SLOW]]).value, 90);
  assert.equal(drag(A, 80, [[20 + DETENT_PT + 10, SLOW]]).value, 95);
  assert.equal(drag(A, -80, [[-30, SLOW]]).value, -90);
  // Sweeping 0 → past 90 in one move costs both detents.
  assert.equal(drag(A, -10, [[20 + DETENT_PT + 180 + DETENT_PT + 20, SLOW]]).value, 100);
});

test('a detent at the end of the range (Strength 100) snaps and clamps', () => {
  const S = RULERS.strength;
  assert.equal(drag(S, 98, [[20, SLOW]]).value, 100);
  const r = drag(S, 98, [[20, SLOW], [400, SLOW], [-4, SLOW]]);
  assert.equal(r.value, 99);
});

test('a value changed under the drag (Auto, reset) restarts from the new value', () => {
  let r = stepValue(B, 0, 2, SLOW, null);
  assert.equal(r.value, 1);
  const ds = r.detentState;
  r = stepValue(B, 40, 4, SLOW, ds);
  assert.equal(r.value, 41);
  // A stale held detent is dropped too.
  const held = stepValue(B, 5, -20, SLOW, null).detentState;
  assert.equal(stepValue(B, 50, 4, SLOW, held).value, 51);
});

test('junk input never produces NaN', () => {
  for (const [value, dx, speed, ds] of [[NaN, 4, SLOW, null], [5, NaN, SLOW, null], [5, Infinity, SLOW, null], [5, 4, SLOW, { raw: NaN, held: { at: 3, travel: NaN } }], [5, 4, SLOW, 'junk'], ['12', 4, SLOW, null]]) {
    const r = stepValue(B, value, dx, speed, ds);
    assert.ok(Number.isFinite(r.value), `${value} ${dx} ${JSON.stringify(ds)}`);
    assert.ok(r.value >= B.min && r.value <= B.max);
  }
  assert.equal(stepValue(B, NaN, 0, SLOW, null).value, 0);
  assert.equal(stepValue(B, '12', 4, SLOW, null).value, 13);
});

// Regression: a spec in SPEC §5.9's documented shape has no decimals, detents or
// nudge. clampValue returned NaN, stepValue threw, and nudge reset to the default.
test('a minimal hand-written spec ({ min, max, def, unitsPerPt }) still works', () => {
  const S = Object.freeze({ id: 'x', label: 'X', min: -100, max: 100, def: 0, unitsPerPt: 0.25 });
  assert.equal(clampValue(S, 12.4), 12);
  assert.equal(clampValue(S, -0.4), 0);
  assert.equal(stepValue(S, 10, 8, SLOW, null).value, 12);
  // It sticks at its default like every ruler.
  const r = drag(S, 2, [[-8, SLOW], [-4, SLOW]]);
  assert.equal(r.value, 0);
  assert.deepEqual(r.ticks, [true, false]);
  assert.equal(nudge(S, 10, 1), 15);
  assert.equal(formatValue(S, -12), '−12');
  assert.equal(valueText(S, 12), 'X 12');
  assert.ok(Array.isArray(ticks(S, 0, 40)));
});

test('stepValue never mutates its detentState', () => {
  const ds = Object.freeze({ raw: 0, held: Object.freeze({ at: 0, travel: 3 }) });
  const r = stepValue(B, 0, 2, SLOW, ds);
  assert.deepEqual(ds, { raw: 0, held: { at: 0, travel: 3 } });
  assert.deepEqual(r.detentState.held, { at: 0, travel: 5 });
});

test('clampValue rounds to the precision, clamps, and never yields −0', () => {
  assert.equal(clampValue(B, 12.4), 12);
  assert.equal(clampValue(B, 250), 100);
  assert.ok(Object.is(clampValue(B, -0.3), 0));
  assert.equal(clampValue(RULERS.straighten, 2.84), 2.8);
  assert.equal(clampValue(RULERS.textSize, 0.08081), 0.0808);
  assert.equal(clampValue(RULERS.strength, 'x'), 100);
});

test('formatValue: signed, minus sign U+2212, degrees, pt, plain and percent', () => {
  assert.equal(formatValue(B, 18), '+18');
  assert.equal(formatValue(B, -12), '−12');
  assert.equal(formatValue(B, 0), '0');
  assert.equal(formatValue(B, -0.2), '0');
  assert.equal(formatValue(B, 300), '+100');
  assert.equal(formatValue(RULERS.straighten, 2.8), '2.8°');
  assert.equal(formatValue(RULERS.straighten, -2.8), '−2.8°');
  assert.equal(formatValue(RULERS.straighten, -3), '−3.0°');
  assert.equal(formatValue(RULERS.straighten, 0), '0°');
  assert.equal(formatValue(RULERS.straighten, -0.04), '0°');
  assert.equal(formatValue(RULERS.removeSize, 36), '36 pt');
  assert.equal(formatValue(RULERS.strength, 60), '60');
  assert.equal(formatValue(RULERS.textAngle, -90), '−90°');
  assert.equal(formatValue(RULERS.textSize, 0.08), '100%');
  assert.equal(formatValue(RULERS.textSize, 0.12), '150%');
  assert.ok(!formatValue(B, -12).includes('-'), 'never a hyphen-minus');
});

test('valueText speaks the value for VoiceOver', () => {
  assert.equal(valueText(B, 18), 'Brightness plus 18');
  assert.equal(valueText(RULERS.shadows, -24), 'Shadows minus 24');
  assert.equal(valueText(B, 0), 'Brightness 0');
  assert.equal(valueText(RULERS.straighten, -2.8), 'Straighten minus 2.8 degrees');
  assert.equal(valueText(RULERS.straighten, 1), 'Straighten 1 degree');
  assert.equal(valueText(RULERS.straighten, 0), 'Straighten 0 degrees');
  assert.equal(valueText(RULERS.removeSize, 36), 'Size 36 points');
  assert.equal(valueText(RULERS.strength, 60), 'Strength 60');
  assert.equal(valueText(RULERS.textSize, 0.08), 'Size 100 percent');
  assert.equal(valueText(RULERS.textAngle, 90), 'Angle 90 degrees');
  for (const s of Object.values(RULERS)) assert.ok(valueText(s, s.def).length > 0);
});

test('isDefault drives the Reset affordance', () => {
  assert.equal(isDefault(B, 0), true);
  assert.equal(isDefault(B, 0.3), true);
  assert.equal(isDefault(B, 1), false);
  assert.equal(isDefault(RULERS.strength, 100), true);
  assert.equal(isDefault(RULERS.removeSize, 36), true);
});

test('nudge steps one notch and clamps', () => {
  assert.equal(nudge(B, 0, 1), 5);
  assert.equal(nudge(B, 0, -1), -5);
  assert.equal(nudge(B, 98, 1), 100);
  assert.equal(nudge(RULERS.straighten, 0, -3), -0.5);
  assert.equal(nudge(B, 7, 0), 7);
  assert.equal(nudge(B, 7, NaN), 7);
});

test('ticks: spacing, majors, detents and ends', () => {
  const t = ticks(B, 0, 50); // ±12.5 units
  assert.deepEqual(t.map((x) => x.value), [-10, -5, 0, 5, 10]);
  assert.deepEqual(t.map((x) => x.offsetPt), [-40, -20, 0, 20, 40]);
  assert.deepEqual(t.map((x) => x.major), [false, false, true, false, false]);
  assert.deepEqual(t.map((x) => x.detent), [false, false, true, false, false]);
  // Near an end the strip stops.
  assert.deepEqual(ticks(B, 98, 50).map((x) => x.value), [90, 95, 100]);
  // Fractional ticks land exactly, including the ends of the range.
  const ts = ticks(RULERS.textSize, 0.03, 1000).map((x) => x.value);
  assert.equal(ts[0], 0.03);
  assert.equal(ts.at(-1), 0.3);
  assert.ok(ticks(RULERS.textSize, 0.08, 100).find((x) => x.value === 0.08).detent);
  // A smooth (unrounded) position slides the strip.
  assert.equal(ticks(B, 0.5, 10).find((x) => x.value === 0).offsetPt, -2);
  // Junk is bounded.
  assert.deepEqual(ticks(B, NaN, NaN).map((x) => x.value), [0]);
  assert.ok(ticks(B, 0, 1e12).length <= 2000);
});

test('isDoubleTap pairs two quick taps close together', () => {
  assert.equal(isDoubleTap({ x: 10, y: 10, t: 0 }, { x: 20, y: 12, t: 200 }), true);
  assert.equal(isDoubleTap({ x: 10, y: 10, t: 0 }, { x: 20, y: 12, t: DOUBLE_TAP_MS + 1 }), false);
  assert.equal(isDoubleTap({ x: 10, y: 10, t: 0 }, { x: 200, y: 10, t: 100 }), false);
  assert.equal(isDoubleTap({ x: 10, y: 10, t: 100 }, { x: 10, y: 10, t: 100 }), false);
  assert.equal(isDoubleTap(null, { x: 0, y: 0, t: 0 }), false);
});
