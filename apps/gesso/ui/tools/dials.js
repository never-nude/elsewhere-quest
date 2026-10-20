// Shared plumbing for dial-and-ruler tools (Light, Color): the same chip, the
// same ruler, the same drag-on-photo — so learning one tool teaches the other.

import { RULERS, formatValue, stepValue, clampValue } from '../../lib/ruler.js';
import { setIn } from '../../lib/doc.js';
import { PHOTO_DRAG_KEY } from '../../lib/hints.js';

export function rulerSpec(id) {
  return RULERS[id];
}

export function dialChip(id, value, { selected = false, disabled = false } = {}) {
  const spec = rulerSpec(id);
  return { id, label: spec.label, value: formatValue(spec, value), changed: Math.abs(value - spec.def) > 1e-9, selected, disabled, kind: 'dial' };
}

export function photoDragEnabled() {
  try { return localStorage.getItem(PHOTO_DRAG_KEY) === '1'; } catch { return false; }
}

export function enablePhotoDrag() {
  try { localStorage.setItem(PHOTO_DRAG_KEY, '1'); } catch { /* private mode: stays off */ }
}

// A dial edit through the ruler: live while moving, one undo step on release.
export function rulerEdit(ed, path, phase, value, specId = path[path.length - 1]) {
  const spec = rulerSpec(specId);
  if (phase === 'start') return;
  if (phase === 'reset') {
    ed.commit(setIn(ed.committed, path, spec.def));
    return;
  }
  const v = clampValue(spec, value);
  const next = setIn(ed.committed, path, v);
  if (phase === 'move') ed.live(next);
  else ed.commit(next);
}

// Drag sideways on the photo to move the selected dial (after the user has met
// the ruler once). Same gain and detents as the ruler.
export function createPhotoScrub() {
  let s = null;
  return {
    start(ed, id, path, x, t) {
      const doc = ed.committed;
      s = { id, path, x, t, value: path.reduce((o, k) => o[k], doc), detent: null };
    },
    move(ed, x, t) {
      if (!s) return null;
      const spec = rulerSpec(s.id);
      const dx = x - s.x;
      const r = stepValue(spec, s.value, dx, Math.abs(dx) / Math.max(1, t - s.t), s.detent);
      s.value = r.value;
      s.detent = r.detentState;
      s.x = x;
      s.t = t;
      ed.live(setIn(ed.committed, s.path, clampValue(spec, s.value)));
      return { value: s.value, ticked: r.ticked };
    },
    end(ed) {
      if (!s) return;
      const next = setIn(ed.committed, s.path, clampValue(rulerSpec(s.id), s.value));
      s = null;
      ed.commit(next);
    },
    cancel(ed) {
      if (!s) return;
      s = null;
      ed.live(null);
    },
    get active() { return !!s; },
    get value() { return s?.value; },
  };
}
