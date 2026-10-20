// The ruler: the one amount control behind every dial (SPEC F4). A strip of ticks
// slides under a fixed needle. This module is the pure maths of it: relative drag
// with a speed gain, sticky detents, clamping, the tick marks, and the words the
// ruler shows and speaks. The view (ui/ruler-view.js) owns pixels and pointers.
//
// A drag is a run of stepValue calls threaded through `detentState`: pass null on
// the first move of a drag and the returned detentState on every move after it.

export const FAST_PT_PER_MS = 0.6; // finger speed above which the gain kicks in
export const FAST_GAIN = 3;
export const DETENT_PT = 12; // finger travel a detent holds the value for
export const DOUBLE_TAP_MS = 300; // ruler double-tap = reset (SPEC F4, hint H2)
export const DOUBLE_TAP_PT = 44;

const MINUS = '−';

// format: how the value reads.
//   signed   '+18' / '−12' / '0'      degrees  '2.8°' / '−2.8°' / '0°'
//   plain    '60'                     pt       '36 pt'
//   percent  share of the default size: '100%'
// tick / major: tick spacing in units (major ticks are drawn longer).
// nudge: one VoiceOver swipe (or arrow key) step.
const dial = (id, label) => ({
  id, label, min: -100, max: 100, def: 0, unitsPerPt: 0.25, decimals: 0,
  format: 'signed', detents: [0], tick: 5, major: 25, nudge: 5,
});

function deepFreeze(o) {
  Object.freeze(o);
  for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  return o;
}

export const RULERS = deepFreeze({
  brightness: dial('brightness', 'Brightness'),
  contrast: dial('contrast', 'Contrast'),
  highlights: dial('highlights', 'Highlights'),
  shadows: dial('shadows', 'Shadows'),
  warmth: dial('warmth', 'Warmth'),
  tint: dial('tint', 'Tint'),
  vividness: dial('vividness', 'Vividness'),
  strength: {
    id: 'strength', label: 'Strength', min: 0, max: 100, def: 100, unitsPerPt: 0.25, decimals: 0,
    format: 'plain', detents: [100], tick: 5, major: 25, nudge: 5,
  },
  straighten: {
    id: 'straighten', label: 'Straighten', min: -45, max: 45, def: 0, unitsPerPt: 0.1, decimals: 1,
    format: 'degrees', detents: [0], tick: 1, major: 5, nudge: 0.5,
  },
  removeSize: {
    id: 'removeSize', label: 'Size', min: 8, max: 120, def: 36, unitsPerPt: 0.25, decimals: 0,
    format: 'pt', detents: [36], tick: 4, major: 20, nudge: 4,
  },
  // Caption size as a fraction of the output's short side; it reads as a share of
  // the default ('100%'), which means more to a person than '0.08'.
  textSize: {
    id: 'textSize', label: 'Size', min: 0.03, max: 0.3, def: 0.08, unitsPerPt: 0.0008, decimals: 4,
    format: 'percent', detents: [0.08], tick: 0.01, major: 0.05, nudge: 0.004,
  },
  textAngle: {
    id: 'textAngle', label: 'Angle', min: -180, max: 180, def: 0, unitsPerPt: 0.5, decimals: 0,
    format: 'degrees', detents: [-90, 0, 90], tick: 5, major: 45, nudge: 5,
  },
});

// A spec written by hand in SPEC §5.9's shape ({ min, max, def, unitsPerPt }) has
// none of the optional fields; without these fallbacks clampValue returned NaN
// (10 ** undefined), stepValue threw on the missing detents and nudge reset the
// dial to its default. Whole units, a detent at the default, 40 nudges end to end.
const decimalsOf = (spec) => (Number.isInteger(spec.decimals) && spec.decimals >= 0 ? Math.min(spec.decimals, 10) : 0);
const detentsOf = (spec) => (Array.isArray(spec.detents) ? spec.detents : [spec.def]);
const nudgeOf = (spec) => (Number.isFinite(spec.nudge) && spec.nudge > 0 ? spec.nudge : (spec.max - spec.min) / 40);

// Round to the spec's precision and clamp. Halves round away from zero, so a drag
// left reaches −1 as soon as a drag right reaches +1. NaN and other junk become the
// default; -0 becomes 0 so it never prints as '−0'.
export function clampValue(spec, v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return spec.def;
  const f = 10 ** decimalsOf(spec);
  const c = Math.max(spec.min, Math.min(spec.max, n));
  const q = (Math.sign(c) * Math.round(Math.abs(c) * f)) / f;
  return q === 0 ? 0 : q;
}

export function isDefault(spec, v) {
  return clampValue(spec, v) === spec.def;
}

// One accessibility step up (dir > 0) or down (dir < 0).
export function nudge(spec, v, dir) {
  const d = Number.isFinite(dir) ? Math.sign(dir) : 0;
  return clampValue(spec, clampValue(spec, v) + d * nudgeOf(spec));
}

// The first detent strictly past `from` and up to `to`, in the direction of travel.
function nextDetent(spec, from, to) {
  let best = null;
  for (const d of detentsOf(spec)) {
    if (to > from && d > from && d <= to && (best === null || d < best)) best = d;
    if (to < from && d < from && d >= to && (best === null || d > best)) best = d;
  }
  return best;
}

// One move of a ruler drag (SPEC F4):
//   - relative: dxPt is the finger's travel since the last move, right = more;
//   - 1 unit per 1/unitsPerPt pt, FAST_GAIN times that above FAST_PT_PER_MS;
//   - a detent (the default, plus any extras) holds the value for DETENT_PT of finger
//     travel. Passing a detent always costs that travel, so the result does not
//     depend on how the finger's motion is sliced into events;
//   - the value clamps at min/max (the rubber band at the ends is visual only).
// The unrounded position rides along in detentState, so slow drags add up instead
// of rounding away to nothing on every 1pt move.
// Returns { value, detentState, ticked }: ticked is true when this move reached a
// detent (flash the needle).
export function stepValue(spec, value, dxPt, speedPtPerMs, detentState) {
  const v0 = clampValue(spec, value);
  const ds = detentState && typeof detentState === 'object' ? detentState : null;
  // Reuse the carried position only while it still describes `value`; if the value
  // was changed under the drag (Auto, reset), start from the value given.
  const carried = ds !== null && Number.isFinite(ds.raw) && clampValue(spec, ds.raw) === v0;
  let pos = carried ? Math.max(spec.min, Math.min(spec.max, ds.raw)) : v0;
  let held = carried && ds.held && ds.held.at === pos && Number.isFinite(ds.held.travel) ? ds.held : null;

  const dx = Number.isFinite(dxPt) ? dxPt : 0;
  // Speed is a magnitude; a signed dx/dt from the view works the same either way.
  const k = spec.unitsPerPt * (Math.abs(speedPtPerMs) > FAST_PT_PER_MS ? FAST_GAIN : 1);
  let ticked = false;
  let remaining = dx; // finger pt still to apply

  if (held) {
    const travel = held.travel + dx;
    if (Math.abs(travel) < DETENT_PT) {
      return { value: clampValue(spec, pos), detentState: { raw: pos, held: { at: held.at, travel } }, ticked: false };
    }
    // Pulled free, to whichever side the finger went; the rest carries on.
    remaining = travel - Math.sign(travel) * DETENT_PT;
    held = null;
  }

  while (remaining !== 0) {
    const to = pos + remaining * k;
    const d = nextDetent(spec, pos, to);
    if (d === null) {
      pos = to;
      break;
    }
    ticked = true;
    const left = remaining - (d - pos) / k; // pt of travel past the detent
    pos = d;
    if (Math.abs(left) < DETENT_PT) {
      held = { at: d, travel: left };
      break;
    }
    remaining = left - Math.sign(left) * DETENT_PT;
  }

  pos = Math.max(spec.min, Math.min(spec.max, pos));
  if (held && held.at !== pos) held = null; // a detent outside the range: the clamp wins
  return { value: clampValue(spec, pos), detentState: { raw: pos, held }, ticked };
}

const trimmed = (spec, n) => String(Number(Math.abs(n).toFixed(decimalsOf(spec))));

// The ruler bubble and dial chip text.
export function formatValue(spec, v) {
  const q = clampValue(spec, v);
  const abs = Math.abs(q).toFixed(decimalsOf(spec));
  const sign = q < 0 ? MINUS : '';
  switch (spec.format) {
    case 'signed':
      return q > 0 ? `+${abs}` : q < 0 ? `${MINUS}${abs}` : '0';
    case 'degrees':
      return q === 0 ? '0°' : `${sign}${abs}°`;
    case 'pt':
      return `${sign}${abs} pt`;
    case 'percent':
      return `${Math.round((q / spec.def) * 100)}%`;
    default:
      return `${sign}${abs}`;
  }
}

// aria-valuetext for the ruler's role=slider: 'Brightness plus 18'.
export function valueText(spec, v) {
  const q = clampValue(spec, v);
  const n = trimmed(spec, q);
  const signWord = q > 0 ? 'plus ' : q < 0 ? 'minus ' : '';
  const minus = q < 0 ? 'minus ' : '';
  switch (spec.format) {
    case 'signed':
      return `${spec.label} ${signWord}${n}`;
    case 'degrees':
      return `${spec.label} ${minus}${n} ${n === '1' ? 'degree' : 'degrees'}`;
    case 'pt':
      return `${spec.label} ${minus}${n} ${n === '1' ? 'point' : 'points'}`;
    case 'percent':
      return `${spec.label} ${Math.round((q / spec.def) * 100)} percent`;
    default:
      return `${spec.label} ${minus}${n}`;
  }
}

// Tick marks within halfWidthPt either side of the needle when the ruler shows
// `value` (the unrounded drag position, so the strip slides smoothly). offsetPt is
// the tick's distance right of the needle. No ticks beyond min/max: the strip ends.
const MAX_TICKS = 2000;
export function ticks(spec, value, halfWidthPt) {
  const n = Number(value);
  const v = Number.isFinite(n) ? Math.max(spec.min, Math.min(spec.max, n)) : spec.def;
  const half = Number.isFinite(halfWidthPt) ? Math.max(0, halfWidthPt) : 0;
  const lo = Math.max(spec.min, v - half * spec.unitsPerPt);
  const hi = Math.min(spec.max, v + half * spec.unitsPerPt);
  // Tick values are integer multiples of `tick`; the epsilon keeps float noise
  // (0.03 / 0.01 = 2.9999999999999996) from dropping the end ticks.
  const i0 = Math.ceil(lo / spec.tick - 1e-9);
  const i1 = Math.floor(hi / spec.tick + 1e-9);
  const every = Math.max(1, Math.round(spec.major / spec.tick));
  const f = 10 ** (decimalsOf(spec) + 2);
  const detents = detentsOf(spec);
  const out = [];
  for (let i = i0; i <= i1 && out.length < MAX_TICKS; i++) {
    const tv = Math.round(i * spec.tick * f) / f;
    out.push({
      value: tv === 0 ? 0 : tv,
      offsetPt: (tv - v) / spec.unitsPerPt,
      major: i % every === 0,
      detent: detents.some((d) => Math.abs(d - tv) < 1e-9),
    });
  }
  return out;
}

// Two taps on the ruler close enough in time and place to reset the dial. The
// gesture recogniser has no double-tap (SPEC cuts it from the photo), so the ruler
// view pairs its own taps: prev and next are { x, y, t } from consecutive taps.
export function isDoubleTap(prev, next) {
  if (!prev || !next) return false;
  const dt = next.t - prev.t;
  return dt > 0 && dt <= DOUBLE_TAP_MS && Math.hypot(next.x - prev.x, next.y - prev.y) <= DOUBLE_TAP_PT;
}
