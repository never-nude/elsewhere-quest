// Light: Auto · Brighter · Darker · Punchier · Softer; dials for Brightness,
// Contrast, Highlights, Shadows; and Paint — dodge and burn with a finger.

import { analyze, autoLight } from '../../lib/autofix.js';
import { dabs } from '../../lib/stroke.js';
import { setIn } from '../../lib/doc.js';
import { formatValue } from '../../lib/ruler.js';
import { rulerSpec, dialChip, rulerEdit, photoDragEnabled, enablePhotoDrag, createPhotoScrub } from './dials.js';

const DIALS = ['brightness', 'contrast', 'highlights', 'shadows'];
const BRUSH_PT = 48; // on-screen brush diameter

let selected = 'brightness';
let paintMode = 'brighten';
let stroke = null; // { id, mode, r, pts: [] }
let ring = null; // { x, y } stage px while painting
const scrub = createPhotoScrub();
let strokeCount = 0;

const clamp100 = (v) => Math.max(-100, Math.min(100, Math.round(v)));

function nudge(ed, changes, label) {
  let next = ed.committed;
  for (const [k, d] of Object.entries(changes)) next = setIn(next, ['light', k], clamp100(next.light[k] + d));
  if (next !== ed.committed) ed.commit(next, label);
}

export default {
  id: 'light',
  label: 'Light',
  viewMode: 'output',

  open(ed, opts = {}) {
    selected = opts.dial && DIALS.includes(opts.dial) ? opts.dial : 'brightness';
    stroke = null;
    ring = null;
  },

  close() {
    stroke = null;
    ring = null;
  },

  panel(ed) {
    const L = ed.doc.light;
    const painting = selected === 'paint';
    return {
      title: 'Light',
      hint: painting ? 'Drag on the photo to paint light.' : 'Tap Auto, or pick a dial and drag.',
      cancel: true,
      done: true,
      quick: [
        { id: 'auto', label: 'Auto', kind: 'action', isDefault: true },
        { id: 'brighter', label: 'Brighter', kind: 'action' },
        { id: 'darker', label: 'Darker', kind: 'action' },
        { id: 'punchier', label: 'Punchier', kind: 'action' },
        { id: 'softer', label: 'Softer', kind: 'action' },
      ],
      dials: [
        ...DIALS.map((d) => dialChip(d, L[d], { selected: selected === d })),
        { id: 'paint', label: 'Paint', value: ed.doc.paint.length ? `${ed.doc.paint.length}` : '–', changed: ed.doc.paint.length > 0, selected: painting, kind: 'mode' },
      ],
      slot: painting
        ? { kind: 'segment', id: 'paint', options: [{ id: 'brighten', label: 'Brighten' }, { id: 'darken', label: 'Darken' }, { id: 'erase', label: 'Erase' }], selected: paintMode }
        : { kind: 'ruler', id: selected, spec: rulerSpec(selected), value: L[selected] },
    };
  },

  onQuick(ed, id) {
    if (id === 'auto') {
      const stats = analyze(ed.readOutput({ maxSide: 512 }));
      const L = autoLight(stats);
      let next = ed.committed;
      for (const k of DIALS) next = setIn(next, ['light', k], L[k] ?? 0);
      if (next === ed.committed) ed.toast('Light looks good already');
      else {
        const from = ed.committed.light[selected];
        ed.commit(next, 'Auto light');
        ed.panel.ruler()?.animateTo(next.light[selected], 400, from);
      }
    } else if (id === 'brighter') nudge(ed, { brightness: 15 }, null);
    else if (id === 'darker') nudge(ed, { brightness: -15 }, null);
    else if (id === 'punchier') nudge(ed, { contrast: 15 }, null);
    else if (id === 'softer') nudge(ed, { contrast: -15, shadows: 10 }, 'Softer');
  },

  onDial(ed, id) {
    selected = id;
    if (id === 'paint') ed.hint('paint-select');
  },

  onSegment(ed, id) {
    paintMode = id;
  },

  onRuler(ed, phase, value) {
    if (phase === 'end') {
      strokeCount++;
      if (!photoDragEnabled()) {
        enablePhotoDrag();
        ed.hint('first-ruler-drag');
      }
    }
    rulerEdit(ed, ['light', selected], phase, value);
  },

  dragAxis() {
    if (selected === 'paint') return 'free';
    return photoDragEnabled() ? 'x' : 'none';
  },

  onGesture(ed, g) {
    if (selected === 'paint') return paintGesture(ed, g);
    if (g.type === 'drag-start') {
      scrub.start(ed, selected, ['light', selected], g.x);
      return true;
    }
    if (g.type === 'drag' && scrub.active) {
      scrub.move(ed, g.x, g.t);
      ed.bubble?.(formatValue(rulerSpec(selected), Math.round(scrub.value)), g.x, g.y);
      return true;
    }
    if (g.type === 'drag-end' && scrub.active) {
      ed.bubble?.(null);
      scrub.end(ed);
      return true;
    }
    if (g.type === 'drag-cancel' && scrub.active) {
      ed.bubble?.(null);
      scrub.cancel(ed);
      return true;
    }
    return false;
  },

  drawOverlay(ed, ctx) {
    if (!ring) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(243,238,230,0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, BRUSH_PT / 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, BRUSH_PT / 2 + 1.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  },

  hitTarget(ed, x, y) {
    return ed.hitCaption?.(x, y) ?? null;
  },
};

// Points are kept at half-pixel precision as they arrive, and dabs come from the
// same dabs() the editor replays with — and dabs() is prefix-stable — so a stroke
// looks exactly the same after undo, redo or a reload as it did while painting.
function paintGesture(ed, g) {
  const half = (v) => Math.round(v * 2) / 2;
  if (g.type === 'drag-start') {
    const r = (BRUSH_PT / 2) * ed.sourcePerStagePx();
    const [sx, sy] = ed.stageToSource(g.x, g.y);
    stroke = { id: newId(), mode: paintMode, r, pts: [half(sx), half(sy)], painted: 0 };
    ring = { x: g.x, y: g.y };
    paintNew();
    ed.requestRender();
    return true;
  }
  if (g.type === 'drag' && stroke) {
    const [sx, sy] = ed.stageToSource(g.x, g.y);
    stroke.pts.push(half(sx), half(sy));
    paintNew();
    ring = { x: g.x, y: g.y };
    ed.requestRender();
    return true;
  }
  if (g.type === 'drag-end' && stroke) {
    const s = stroke;
    stroke = null;
    ring = null;
    ed.pools = { ...ed.pools, strokes: { ...ed.pools.strokes, [s.id]: { mode: s.mode, r: s.r, pts: s.pts } } };
    const next = { ...ed.committed, paint: [...ed.committed.paint, s.id] };
    ed.commit(next, s.mode === 'brighten' ? 'Painted light' : s.mode === 'darken' ? 'Painted shade' : 'Erased paint');
    return true;
  }
  if (g.type === 'drag-cancel' && stroke) {
    stroke = null;
    ring = null;
    ed.replayPaint(); // replay without the half stroke
    return true;
  }
  return false;

  function paintNew() {
    const all = dabs(stroke.pts, stroke.r);
    if (all.length > stroke.painted) {
      ed.renderer.paintDabs(stroke.mode, all.slice(stroke.painted), stroke.r);
      stroke.painted = all.length;
    }
  }
}

function newId() {
  return `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export { strokeCount };
