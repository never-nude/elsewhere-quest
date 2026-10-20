// Shared plumbing for dial-and-ruler tools (Light, Color): the same chip, the
// same ruler, the same drag-on-photo — so learning one tool teaches the other.

import { RULERS, formatValue, stepValue } from '../../lib/ruler.js';
import { setIn } from '../../lib/doc.js';

const LABELS = {
  brightness: 'Brightness', contrast: 'Contrast', highlights: 'Highlights', shadows: 'Shadows',
  warmth: 'Warmth', tint: 'Tint', vividness: 'Vividness', strength: 'Strength',
  straighten: 'Straighten', removeSize: 'Size', textSize: 'Size', textAngle: 'Angle',
};

export function rulerSpec(id) {
  return { ...RULERS[id], id, label: LABELS[id] ?? id };
}

export function dialChip(id, value, { selected = false, disabled = false } = {}) {
  const spec = rulerSpec(id);
  return { id, label: spec.label, value: formatValue(spec, value), changed: Math.abs(value - spec.def) > 1e-9, selected, disabled, kind: 'dial' };
}

const PHOTO_DRAG_KEY = 'gesso:photoDrag';

export function photoDragEnabled() {
  try { return localStorage.getItem(PHOTO_DRAG_KEY) === '1'; } catch { return false; }
}

export function enablePhotoDrag() {
  try { localStorage.setItem(PHOTO_DRAG_KEY, '1'); } catch { /* private mode: stays off */ }
}

// A dial edit through the ruler: live while moving, one undo step on release.
export function rulerEdit(ed, path, phase, value, { round = true } = {}) {
  const v = round ? Math.round(value) : value;
  if (phase === 'start') return;
  if (phase === 'reset') {
    const def = rulerSpec(path[path.length - 1] === 'vividness' ? 'vividness' : path[path.length - 1]).def;
    const next = setIn(ed.committed, path, def);
    ed.commit(next);
    return;
  }
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
      ed.live(setIn(ed.committed, s.path, Math.round(s.value)));
      return { value: s.value, ticked: r.ticked };
    },
    end(ed) {
      if (!s) return;
      const next = setIn(ed.committed, s.path, Math.round(s.value));
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
