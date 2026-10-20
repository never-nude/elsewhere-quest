// The rewind tape (SPEC F13), pure. Holding Undo raises a tape of every named step,
// Original first, with the chosen step centred under a fixed needle. The finger
// drags the tape: sliding right pulls earlier steps under the needle, sliding left
// brings later ones back. The thumb holding Undo sits at the left edge, so rewinding
// gets the whole width of the screen to travel in.
//
// The drag is relative, like the ruler: holding never jumps, and a fast slide covers
// FAST_GAIN times the ground. The pitch (finger travel per step) shrinks as the
// history grows, so a slow slide across about SPAN_PT reaches the Original.

import { FAST_PT_PER_MS, FAST_GAIN } from './ruler.js';

export const HOLD_MS = 400; // press this long on Undo to raise the tape
export const SPAN_PT = 300;
export const MIN_PITCH_PT = 18;
export const MAX_PITCH_PT = 44;

const clampIndex = (i, count) => Math.max(0, Math.min(count - 1, Math.round(i)));

export function pitchFor(count, span = SPAN_PT) {
  if (!(count > 1)) return MAX_PITCH_PT;
  return Math.min(MAX_PITCH_PT, Math.max(MIN_PITCH_PT, span / (count - 1)));
}

// A scrub that starts on history entry `index` of `count`, the finger at x (pt) at
// time t (ms).
export function startScrub(index, count, x, t) {
  const n = Math.max(1, Math.floor(Number.isFinite(count) ? count : 1));
  const i = clampIndex(Number.isFinite(index) ? index : n - 1, n);
  return Object.freeze({ start: i, index: i, count: n, pitch: pitchFor(n), offset: 0, x, t });
}

export function moveScrub(s, x, t) {
  if (!Number.isFinite(x)) return s;
  const time = Number.isFinite(t) ? t : s.t;
  const dx = x - s.x;
  // No usable clock: count the travel as slow rather than guess.
  const speed = Number.isFinite(t) ? Math.abs(dx) / Math.max(1, time - s.t) : 0;
  const gain = speed > FAST_PT_PER_MS ? FAST_GAIN : 1;
  // Clamped to the ends, so turning back answers at once instead of first
  // unwinding travel spent past the Original or the newest step.
  const hi = s.start * s.pitch;
  const lo = (s.start - (s.count - 1)) * s.pitch;
  const offset = Math.min(hi, Math.max(lo, s.offset + dx * gain));
  const index = clampIndex(s.start - offset / s.pitch, s.count);
  return Object.freeze({ ...s, offset, index, x, t: time });
}

const steps = (n) => `${n} step${n === 1 ? '' : 's'}`;

// The tape's one line of guidance: what lifting here would do.
export function scrubStatus(s) {
  const d = s.index - s.start;
  if (d === 0) {
    if (s.start > 0) return 'Slide right to go back';
    return s.count > 1 ? 'Slide left to go forward' : 'Nothing to rewind yet';
  }
  if (s.index === 0) return 'Lift to go back to the original';
  return d < 0 ? `Lift to undo ${steps(-d)}` : `Lift to redo ${steps(d)}`;
}

// The toast after landing, or null when the finger came back to where it started.
// `rows` is lib/history labels().
export function landingText(rows, start, index) {
  if (index === start || !rows?.[index]) return null;
  return `${index < start ? 'Rewound to' : 'Forward to'}: ${rows[index].label}`;
}
