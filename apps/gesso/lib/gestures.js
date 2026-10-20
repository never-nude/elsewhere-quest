// One gesture grammar for the photo, as a pure state machine. The DOM layer feeds
// it pointer events (and a 'tick' when a hold timer fires); it answers with a list
// of high-level gestures. Every tool sees the same meanings:
//
//   tap         quick touch, no travel
//   double-tap  a second tap close by, soon after (the first still emits tap)
//   hold-start / hold-move / hold-end
//               touch and stay still for HOLD_MS (Before: hold to compare, slide to wipe)
//   drag-start / drag / drag-end
//               one finger travelling past SLOP (brush, scrub, move)
//   drag-cancel a drag that a second finger turned into a pinch: the tool should
//               throw the partial stroke away
//   pinch-start / pinch / pinch-end
//               two fingers: zoom, pan and twist together (scale, rotation, pan
//               relative to where the pinch started)
//   two-tap     two fingers down and up quickly without moving (Undo)
//
// Events in: { type: 'down'|'move'|'up'|'cancel', id, x, y, t } and { type: 'tick', t }.

export const SLOP = 10; // px of travel before a touch becomes a drag
export const HOLD_MS = 420;
export const TAP_MS = 300;
export const DOUBLE_TAP_MS = 320;
export const DOUBLE_TAP_PX = 30;
export const TWO_TAP_MS = 250;
// A drag younger/shorter than this when a second finger lands was really the
// start of a pinch.
const PINCH_GRACE_MS = 200;
const PINCH_GRACE_PX = 40;

export function initialGestures() {
  return {
    pointers: {}, // id -> { x, y, x0, y0, t0 }
    mode: 'idle', // idle | pending | hold | drag | pinch | two-pending
    start: null,
    lastTap: null,
    pinch: null,
    twoTap: null,
  };
}

const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

function pinchFrame(p) {
  const [a, b] = Object.values(p);
  return {
    cx: (a.x + b.x) / 2,
    cy: (a.y + b.y) / 2,
    d: Math.max(1, dist(a.x, a.y, b.x, b.y)),
    angle: Math.atan2(b.y - a.y, b.x - a.x),
  };
}

export function reduceGesture(state, ev) {
  const s = { ...state, pointers: { ...state.pointers } };
  const out = [];
  const count = () => Object.keys(s.pointers).length;

  switch (ev.type) {
    case 'down': {
      s.pointers[ev.id] = { x: ev.x, y: ev.y, x0: ev.x, y0: ev.y, t0: ev.t };
      if (count() === 1) {
        s.mode = 'pending';
        s.start = { x: ev.x, y: ev.y, t: ev.t, id: ev.id };
      } else if (count() === 2) {
        if (s.mode === 'drag') {
          const young = ev.t - s.start.t < PINCH_GRACE_MS;
          const p = s.pointers[s.start.id];
          const short = p && dist(p.x, p.y, s.start.x, s.start.y) < PINCH_GRACE_PX;
          out.push({ type: young || short ? 'drag-cancel' : 'drag-end' });
        } else if (s.mode === 'hold') {
          out.push({ type: 'hold-end' });
        }
        s.mode = 'two-pending';
        s.twoTap = { t: ev.t };
        s.pinch = pinchFrame(s.pointers);
      }
      // A third finger is ignored (the iOS system owns three-finger gestures).
      break;
    }

    case 'move': {
      const p = s.pointers[ev.id];
      if (!p) break;
      s.pointers[ev.id] = { ...p, x: ev.x, y: ev.y };
      if (s.mode === 'pending' && ev.id === s.start.id) {
        if (dist(ev.x, ev.y, s.start.x, s.start.y) > SLOP) {
          s.mode = 'drag';
          out.push({ type: 'drag-start', x: s.start.x, y: s.start.y });
          out.push({ type: 'drag', x: ev.x, y: ev.y, dx: ev.x - s.start.x, dy: ev.y - s.start.y });
        }
      } else if (s.mode === 'drag' && ev.id === s.start.id) {
        out.push({ type: 'drag', x: ev.x, y: ev.y, dx: ev.x - s.start.x, dy: ev.y - s.start.y });
      } else if (s.mode === 'hold' && ev.id === s.start.id) {
        out.push({ type: 'hold-move', x: ev.x, y: ev.y });
      } else if ((s.mode === 'two-pending' || s.mode === 'pinch') && count() === 2) {
        const f = pinchFrame(s.pointers);
        const moved = Object.values(s.pointers).some((q) => dist(q.x, q.y, q.x0, q.y0) > SLOP);
        if (s.mode === 'two-pending' && moved) {
          s.mode = 'pinch';
          out.push({ type: 'pinch-start', cx: s.pinch.cx, cy: s.pinch.cy });
        }
        if (s.mode === 'pinch') {
          let rotation = f.angle - s.pinch.angle;
          if (rotation > Math.PI) rotation -= 2 * Math.PI;
          if (rotation < -Math.PI) rotation += 2 * Math.PI;
          out.push({
            type: 'pinch',
            scale: f.d / s.pinch.d,
            rotation,
            cx: f.cx, cy: f.cy,
            dx: f.cx - s.pinch.cx, dy: f.cy - s.pinch.cy,
            originX: s.pinch.cx, originY: s.pinch.cy,
          });
        }
      }
      break;
    }

    case 'tick': {
      if (s.mode === 'pending' && ev.t - s.start.t >= HOLD_MS) {
        s.mode = 'hold';
        out.push({ type: 'hold-start', x: s.start.x, y: s.start.y });
      }
      break;
    }

    case 'up':
    case 'cancel': {
      const p = s.pointers[ev.id];
      if (!p) break;
      delete s.pointers[ev.id];
      const cancelled = ev.type === 'cancel';
      if (s.mode === 'pending' && ev.id === s.start.id) {
        if (!cancelled && ev.t - s.start.t <= TAP_MS) {
          out.push({ type: 'tap', x: s.start.x, y: s.start.y });
          const prev = s.lastTap;
          if (prev && s.start.t - prev.t <= DOUBLE_TAP_MS && dist(prev.x, prev.y, s.start.x, s.start.y) <= DOUBLE_TAP_PX) {
            out.push({ type: 'double-tap', x: s.start.x, y: s.start.y });
            s.lastTap = null;
          } else {
            s.lastTap = { x: s.start.x, y: s.start.y, t: ev.t };
          }
        }
        s.mode = 'idle';
      } else if (s.mode === 'drag' && ev.id === s.start.id) {
        out.push({ type: cancelled ? 'drag-cancel' : 'drag-end' });
        s.mode = 'idle';
      } else if (s.mode === 'hold' && ev.id === s.start.id) {
        out.push({ type: 'hold-end' });
        s.mode = 'idle';
      } else if (s.mode === 'two-pending') {
        // Two-finger tap: recognised on lift, so it never fights a pinch.
        if (!cancelled && ev.t - s.twoTap.t <= TWO_TAP_MS) out.push({ type: 'two-tap' });
        s.mode = 'settling';
      } else if (s.mode === 'pinch') {
        out.push({ type: 'pinch-end' });
        s.mode = 'settling';
      }
      // After a two-finger gesture the remaining finger does nothing until it lifts,
      // so lifting fingers one at a time never fires a stray tap or drag.
      if (count() === 0) {
        s.mode = 'idle';
        s.pinch = null;
        s.twoTap = null;
      }
      break;
    }

    default:
      break;
  }
  return { state: s, gestures: out };
}
