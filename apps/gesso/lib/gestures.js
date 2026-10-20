// One gesture grammar for the photo, as a pure state machine (SPEC §4). The DOM
// layer feeds it pointer events, plus a 'tick' when the hold timer it asked for
// comes due; it answers with high-level gestures. Every tool sees the same meanings:
//
//   tap          lifted before HOLD_MS without ever travelling more than SLOP.
//                Recognised on lift: there is no double-tap, so nothing waits to see
//                whether a second tap follows.
//   hold-start / hold-move / hold-end
//                a touch kept still for HOLD_MS on anything but a handle, caption,
//                ring or ruler (Before; slide to wipe). See showsBefore().
//   drag-start / drag / drag-end
//                one finger travelling more than SLOP (brush, scrub, move, ruler)
//   drag-cancel  the drag was interrupted (a second finger, pointercancel, reset):
//                the tool throws the partial action away with no history step
//   pinch-start / pinch / pinch-end
//                two fingers: zoom, pan and twist together, relative to where the
//                pinch started
//
// Payloads: tap { x, y, target, t }; hold-start { x, y, target }; hold-move { x, y };
// drag-start { x, y, target }; drag { x, y, dx, dy, t } (dx, dy from the down point);
// drag-end / drag-cancel { target }; pinch-start { cx, cy, target, onCaption };
// pinch { scale, rotation, cx, cy, dx, dy, originX, originY, onCaption };
// pinch-end { target, onCaption }. target and onCaption on pinch events come from the
// FIRST finger: a pinch that starts on a caption resizes it (SPEC §4 rule 1).
//
// Events in:
//   { type: 'down', id, x, y, t, target?, axis? }
//       target  what the UI hit-tested under the finger (SPEC §4 rule 4):
//               'photo' (default) | 'handle:<id>' | 'caption:<id>' | 'ring' | 'ruler'
//               | any other tool-specific string (e.g. Crop's 'frame'), which
//               behaves like the photo for holds
//       axis    'free' (default) | 'x' (Light/Color scrub: horizontal drags only)
//               | 'none' (one finger never drags; taps and holds still work)
//   { type: 'move' | 'up' | 'cancel', id, x, y, t }
//   { type: 'tick', t }    the hold timer fired
//   { type: 'reset' }      drop everything (blur, page hidden, lost pointer capture)
//
// reduceGesture returns { state, gestures, wakeAt }. wakeAt is the time the UI should
// send a tick at (the hold deadline), or null for no timer; after every call the UI
// clears its timer and sets a new one if wakeAt is not null. Every t must come from
// one clock (PointerEvent.timeStamp and performance.now() share one).
//
// The outcome depends only on event timestamps, never on when ticks arrive: a touch
// that is still past its deadline is promoted to a hold by whichever event comes
// first, so a late timer gives the same gestures as a punctual one.

export const SLOP = 8; // pt: more travel than this and a touch is no longer a tap or hold
export const HOLD_MS = 500;
export const AXIS_LOCK = 10; // pt: an axis 'x' touch must prove itself horizontal by here
export const AXIS_RATIO = 1.5; // horizontal means |dx| > AXIS_RATIO * |dy|

const AXES = ['free', 'x', 'none'];

export function initialGestures() {
  return {
    pointers: {}, // key -> { x, y, x0, y0, t0, target }
    order: [], // pointer keys in landing order (at most two)
    // idle | pending | deciding | ignored | hold | drag | pinch | settling
    mode: 'idle',
    start: null, // the one-finger touch: { key, x, y, t, target, axis }
    pinch: null, // { cx, cy, d, lastAngle, rotation, target, onCaption }
  };
}

const finite = (...v) => v.every(Number.isFinite);

// SPEC F12: a still press shows Before "with the finger not on a handle, caption or
// ring" (and the ruler is a control, never the photo). Everything else a tool
// reports is the photo for this purpose: the bare photo, and also tool-specific
// targets such as Crop's 'frame' interior, which covers the whole photo when Crop
// opens, so a whitelist of 'photo' alone would make Before unreachable there
// (acceptance check 11: "in every tool state"). A press on a blocker stays a
// candidate for a drag however long it rests.
export function showsBefore(target) {
  if (typeof target !== 'string') return true;
  return target !== 'ring' && target !== 'ruler' && !/^(handle|caption)(:|$)/.test(target);
}

const holdable = (start) => start !== null && showsBefore(start.target);

function frame(a, b) {
  return {
    cx: (a.x + b.x) / 2,
    cy: (a.y + b.y) / 2,
    d: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
    angle: Math.atan2(b.y - a.y, b.x - a.x),
  };
}

// The helpers below mutate `s`, which is always the reducer's private copy; nested
// objects (start, pinch, pointer records) are replaced, never edited, because the
// caller's state shares them.

function catchUp(s, t, out) {
  if (s.mode === 'pending' && holdable(s.start) && Number.isFinite(t) && t - s.start.t >= HOLD_MS) {
    s.mode = 'hold';
    out.push({ type: 'hold-start', x: s.start.x, y: s.start.y, target: s.start.target });
  }
}

function startPinch(s, out) {
  // The finger that has been down longest decides whether this is a caption pinch.
  const [a, b] = s.order.map((k) => s.pointers[k]);
  const f = frame(a, b);
  const target = a.target;
  const onCaption = target.startsWith('caption:');
  s.mode = 'pinch';
  s.start = null;
  s.pinch = { cx: f.cx, cy: f.cy, d: f.d, lastAngle: f.angle, rotation: 0, target, onCaption };
  out.push({ type: 'pinch-start', cx: f.cx, cy: f.cy, target, onCaption });
}

function pinchMove(s, out) {
  const [a, b] = s.order.map((k) => s.pointers[k]);
  const f = frame(a, b);
  // Unwrap the angle step by step so a twist past 180° keeps counting instead of
  // jumping to the other sign.
  let step = f.angle - s.pinch.lastAngle;
  if (step > Math.PI) step -= 2 * Math.PI;
  else if (step <= -Math.PI) step += 2 * Math.PI;
  const p = { ...s.pinch, lastAngle: f.angle, rotation: s.pinch.rotation + step };
  s.pinch = p;
  out.push({
    type: 'pinch',
    scale: f.d / p.d,
    rotation: p.rotation,
    cx: f.cx, cy: f.cy,
    dx: f.cx - p.cx, dy: f.cy - p.cy,
    originX: p.cx, originY: p.cy,
    onCaption: p.onCaption,
  });
}

// The one-finger touch moved to (x, y) at t.
function oneFingerMove(s, x, y, t, out) {
  catchUp(s, t, out);
  const st = s.start;
  const dx = x - st.x, dy = y - st.y;
  if (s.mode === 'pending' || s.mode === 'deciding') {
    const travel = Math.hypot(dx, dy);
    if (s.mode === 'pending' && !(travel > SLOP)) return;
    if (st.axis === 'none') {
      s.mode = 'ignored';
    } else if (st.axis === 'free' || Math.abs(dx) > AXIS_RATIO * Math.abs(dy)) {
      s.mode = 'drag';
      out.push({ type: 'drag-start', x: st.x, y: st.y, target: st.target });
      out.push({ type: 'drag', x, y, dx, dy, t });
    } else if (travel >= AXIS_LOCK) {
      // Vertical (or too diagonal) by the end of the lock distance: this touch does
      // nothing until it lifts.
      s.mode = 'ignored';
    } else {
      s.mode = 'deciding';
    }
  } else if (s.mode === 'drag') {
    out.push({ type: 'drag', x, y, dx, dy, t });
  } else if (s.mode === 'hold') {
    out.push({ type: 'hold-move', x, y });
  }
}

function release(s, key, t, cancelled, out) {
  const single = s.start !== null && s.start.key === key;
  if (s.mode === 'pinch') {
    out.push({ type: 'pinch-end', target: s.pinch.target, onCaption: s.pinch.onCaption });
    s.mode = 'settling';
    s.pinch = null;
  } else if (single) {
    catchUp(s, t, out);
    if (s.mode === 'pending') {
      if (!cancelled && Number.isFinite(t) && t - s.start.t < HOLD_MS) {
        out.push({ type: 'tap', x: s.start.x, y: s.start.y, target: s.start.target, t });
      }
    } else if (s.mode === 'drag') {
      out.push({ type: cancelled ? 'drag-cancel' : 'drag-end', target: s.start.target });
    } else if (s.mode === 'hold') {
      out.push({ type: 'hold-end' });
    }
    s.mode = 'idle';
    s.start = null;
  }
  const pointers = { ...s.pointers };
  delete pointers[key];
  s.pointers = pointers;
  s.order = s.order.filter((k) => k !== key);
  // After a two-finger gesture the remaining finger does nothing until it lifts,
  // so lifting fingers one at a time never fires a stray tap or drag.
  if (s.order.length === 0) {
    s.mode = 'idle';
    s.start = null;
    s.pinch = null;
  }
}

export function reduceGesture(state, ev) {
  const base = state && typeof state === 'object' && state.pointers && Array.isArray(state.order) ? state : initialGestures();
  const s = { ...base, pointers: { ...base.pointers }, order: [...base.order] };
  const out = [];
  const type = ev && typeof ev === 'object' ? ev.type : undefined;

  switch (type) {
    case 'down': {
      if (!finite(ev.x, ev.y, ev.t)) break;
      const key = String(ev.id);
      // The same id landing again means its up was lost: end the stale touch first.
      if (s.pointers[key]) release(s, key, ev.t, true, out);
      // A third finger is ignored (iOS owns three-finger gestures).
      if (s.order.length >= 2) break;
      const target = typeof ev.target === 'string' && ev.target ? ev.target : 'photo';
      const axis = AXES.includes(ev.axis) ? ev.axis : 'free';
      s.pointers[key] = { x: ev.x, y: ev.y, x0: ev.x, y0: ev.y, t0: ev.t, target };
      s.order.push(key);
      if (s.order.length === 1) {
        s.mode = 'pending';
        s.start = { key, x: ev.x, y: ev.y, t: ev.t, target, axis };
      } else {
        // SPEC §4 rule 2: a second finger cancels the one-finger action with no
        // history step, whatever it was, and the pair becomes a pinch.
        catchUp(s, ev.t, out);
        if (s.mode === 'drag') out.push({ type: 'drag-cancel', target: s.start.target });
        else if (s.mode === 'hold') out.push({ type: 'hold-end' });
        startPinch(s, out);
      }
      break;
    }

    case 'move': {
      const key = String(ev.id);
      const p = s.pointers[key];
      if (!p || !finite(ev.x, ev.y, ev.t)) break;
      s.pointers[key] = { ...p, x: ev.x, y: ev.y };
      if (s.mode === 'pinch') pinchMove(s, out);
      else if (s.start !== null && s.start.key === key) oneFingerMove(s, ev.x, ev.y, ev.t, out);
      break;
    }

    case 'tick': {
      catchUp(s, ev.t, out);
      break;
    }

    case 'up':
    case 'cancel': {
      const key = String(ev.id);
      const p = s.pointers[key];
      if (!p) break;
      // A lift somewhere new counts as a last move, so a flick whose only travel shows
      // up in the up event is still a drag, not a tap.
      const moved = finite(ev.x, ev.y, ev.t) && (ev.x !== p.x || ev.y !== p.y);
      if (type === 'up' && moved && s.start !== null && s.start.key === key) {
        s.pointers[key] = { ...p, x: ev.x, y: ev.y };
        oneFingerMove(s, ev.x, ev.y, ev.t, out);
      }
      release(s, key, ev.t, type === 'cancel', out);
      break;
    }

    case 'reset': {
      if (s.mode === 'drag') out.push({ type: 'drag-cancel', target: s.start.target });
      else if (s.mode === 'hold') out.push({ type: 'hold-end' });
      else if (s.mode === 'pinch') out.push({ type: 'pinch-end', target: s.pinch.target, onCaption: s.pinch.onCaption });
      return { state: initialGestures(), gestures: out, wakeAt: null };
    }

    default:
      break;
  }

  const wakeAt = s.mode === 'pending' && holdable(s.start) ? s.start.t + HOLD_MS : null;
  return { state: s, gestures: out, wakeAt };
}
