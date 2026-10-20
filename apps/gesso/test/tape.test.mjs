import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOLD_MS, SPAN_PT, MIN_PITCH_PT, MAX_PITCH_PT,
  pitchFor, startScrub, moveScrub, scrubStatus, landingText,
} from '../lib/tape.js';
import { FAST_GAIN } from '../lib/ruler.js';
import { createHistory, push, labels, undo } from '../lib/history.js';

// A slow slide: `steps` moves of `dx` pt, 16 ms apart.
function slide(s, dx, steps = 1) {
  for (let i = 0; i < steps; i++) s = moveScrub(s, s.x + dx, s.t + 16);
  return s;
}

test('the hold is 0.4 s (SPEC F13)', () => {
  assert.equal(HOLD_MS, 400);
});

test('pitch spans the history over SPAN_PT, within its bounds', () => {
  assert.equal(pitchFor(1), MAX_PITCH_PT);
  assert.equal(pitchFor(2), MAX_PITCH_PT);
  assert.equal(pitchFor(11), SPAN_PT / 10);
  assert.equal(pitchFor(300), MIN_PITCH_PT);
  for (let n = 1; n < 400; n++) {
    const p = pitchFor(n);
    assert.ok(p >= MIN_PITCH_PT && p <= MAX_PITCH_PT, `n=${n}`);
  }
});

test('starting a scrub sits on the current step and never jumps', () => {
  const s = startScrub(4, 9, 60, 1000);
  assert.equal(s.index, 4);
  assert.equal(s.start, 4);
  assert.equal(moveScrub(s, 60, 1016).index, 4);
  assert.ok(Object.isFrozen(s));
});

test('sliding right goes back, sliding left comes forward', () => {
  const s = startScrub(5, 9, 60, 0);
  const p = s.pitch;
  assert.equal(slide(s, p / 4, 4).index, 4); // one pitch right = one step back
  assert.equal(slide(s, p / 4, 8).index, 3);
  assert.equal(slide(s, -p / 4, 4).index, 6);
});

test('a slow slide across SPAN_PT reaches the Original from the newest step', () => {
  const n = 11;
  let s = startScrub(n - 1, n, 50, 0);
  s = slide(s, 5, Math.ceil(SPAN_PT / 5));
  assert.equal(s.index, 0);
});

test('a fast slide covers FAST_GAIN times the ground', () => {
  const s = startScrub(20, 21, 50, 0);
  const slow = moveScrub(s, 50 + 3 * s.pitch, 1000); // 3 pitches over a second
  const fast = moveScrub(s, 50 + 3 * s.pitch, 10); // the same in 10 ms
  assert.equal(slow.index, 17);
  assert.equal(fast.index, 20 - 3 * FAST_GAIN);
});

test('the ends hold, and turning back answers at once', () => {
  let s = startScrub(2, 6, 50, 0);
  s = slide(s, 10, 100); // far past the Original
  assert.equal(s.index, 0);
  s = slide(s, -s.pitch * 0.15, 4); // a little over half a pitch back
  assert.equal(s.index, 1);
  s = slide(s, -10, 200); // far past the newest step
  assert.equal(s.index, 5);
  s = slide(s, s.pitch * 0.15, 4);
  assert.equal(s.index, 4);
});

test('junk input is ignored', () => {
  const s = startScrub(3, 5, 10, 0);
  assert.equal(moveScrub(s, NaN, 20), s);
  assert.equal(moveScrub(s, 10 + s.pitch, NaN).index, 2);
  const odd = startScrub(NaN, 0, 0, 0);
  assert.equal(odd.count, 1);
  assert.equal(odd.index, 0);
  assert.equal(startScrub(99, 4, 0, 0).index, 3);
});

test('the status line says what lifting would do', () => {
  const s = startScrub(4, 9, 0, 0);
  assert.equal(scrubStatus(s), 'Slide right to go back');
  assert.equal(scrubStatus({ ...s, index: 3 }), 'Lift to undo 1 step');
  assert.equal(scrubStatus({ ...s, index: 1 }), 'Lift to undo 3 steps');
  assert.equal(scrubStatus({ ...s, index: 0 }), 'Lift to go back to the original');
  assert.equal(scrubStatus({ ...s, index: 6 }), 'Lift to redo 2 steps');
  assert.equal(scrubStatus(startScrub(0, 3, 0, 0)), 'Slide left to go forward');
  assert.equal(scrubStatus(startScrub(0, 1, 0, 0)), 'Nothing to rewind yet');
});

test('landing text names the step, or nothing when back where it started', () => {
  let h = createHistory({ v: 0 });
  h = push(h, { v: 1 }, 'Brightness +18', 'light');
  h = push(h, { v: 2 }, 'Removed spot', 'remove');
  h = undo(h);
  const rows = labels(h);
  assert.equal(landingText(rows, 1, 0), 'Rewound to: Original');
  assert.equal(landingText(rows, 1, 2), 'Forward to: Removed spot');
  assert.equal(landingText(rows, 1, 1), null);
  assert.equal(landingText(rows, 1, 7), null);
  assert.equal(landingText(null, 1, 0), null);
});
