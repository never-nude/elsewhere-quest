// Crop: the whole photo with a frame. Auto straightens and fits; aspect chips
// re-shape the frame; corners and edges resize it; dragging inside moves it.
// Straighten on the ruler; Rotate (counter-clockwise), Flip and Tall/Wide as dials.

import { setAspect, setAngle, rotateQuarter, flipHorizontal, toggleTall, isTall, dragHandle, moveRect, MAX_STRAIGHTEN } from '../../lib/geometry.js';
import { formatValue } from '../../lib/ruler.js';
import { rulerSpec } from './dials.js';
import { orientedTilt } from './home.js';

const QUICK = [
  { id: 'auto', label: 'Auto', isDefault: true },
  { id: 'free', label: 'Free' },
  { id: 'original', label: 'Original' },
  { id: 'square', label: 'Square' },
  { id: '4:5', label: '4:5' },
  { id: '16:9', label: '16:9' },
];
const HANDLE_HIT = 24; // half of a 48pt hit box
const HANDLE_LEN = 24;

let drag = null; // { target, start: crop, x0, y0 }
let rulerStart = null;
let touching = false;

function chipFor(aspect) {
  if (aspect === '4:5' || aspect === '5:4') return '4:5';
  if (aspect === '16:9' || aspect === '9:16') return '16:9';
  return aspect;
}

function commitCrop(ed, crop, label) {
  const next = { ...ed.committed, crop };
  if (crop !== ed.committed.crop) ed.commit(next, label);
}

export default {
  id: 'crop',
  label: 'Crop',
  viewMode: 'frame',
  wantsCaptions: false,

  open(ed, opts = {}) {
    drag = null;
    rulerStart = null;
    if (opts.auto) setTimeout(() => { this.onQuick(ed, 'auto'); ed.refresh(); }, 0);
  },

  close() {
    drag = null;
    touching = false;
  },

  panel(ed) {
    const c = ed.doc.crop;
    const shaped = ['4:5', '5:4', '16:9', '9:16'].includes(c.aspect);
    return {
      title: 'Crop',
      hint: 'Tap Auto or a shape, or drag a corner.',
      cancel: true,
      done: true,
      quick: QUICK.map((q) => ({
        id: q.id,
        label: q.label,
        kind: q.isDefault ? 'action' : 'state',
        isDefault: q.isDefault,
        selected: !q.isDefault && chipFor(c.aspect) === q.id,
      })),
      dials: [
        { id: 'straighten', label: 'Straighten', value: formatValue(rulerSpec('straighten'), c.angle), changed: c.angle !== 0, selected: true, kind: 'dial' },
        { id: 'rotate', label: 'Rotate', value: '⟲ 90°', kind: 'action' },
        { id: 'flip', label: 'Flip', value: '⇋', changed: c.flip, kind: 'action' },
        { id: 'tall', label: 'Tall/Wide', value: shaped ? (isTall(c) ? 'Tall' : 'Wide') : '–', disabled: !shaped, kind: 'action' },
      ],
      slot: { kind: 'ruler', id: 'straighten', spec: rulerSpec('straighten'), value: c.angle },
    };
  },

  onQuick(ed, id) {
    const st = ed.committed;
    const { w, h } = st.source;
    if (id === 'auto') {
      const tilt = orientedTilt(ed);
      if (!tilt || tilt.confidence <= 0) {
        ed.panel.showTip('No clear horizon. Drag the ruler.');
        return;
      }
      const angle = Math.max(-MAX_STRAIGHTEN, Math.min(MAX_STRAIGHTEN, Math.round(tilt.angleDeg * 10) / 10));
      if (Math.abs(angle - st.crop.angle) < 0.3) {
        ed.panel.showTip('Already level');
        return;
      }
      commitCrop(ed, setAngle(st.crop, w, h, angle), `Straightened ${formatValue(rulerSpec('straighten'), angle).replace(/^\+/, '')}`);
      ed.panel.ruler()?.animateTo(angle, 400, st.crop.angle);
      ed.panel.showTip(`Straightened ${Math.abs(angle).toFixed(1)}°`);
      return;
    }
    let key = id;
    if (id === '4:5') key = st.crop.aspect === '5:4' ? '5:4' : '4:5';
    if (id === '16:9') key = st.crop.aspect === '9:16' ? '9:16' : '16:9';
    if (id === '4:5' || id === '16:9') ed.hint('ratio-chip');
    commitCrop(ed, setAspect(st.crop, w, h, key), id === 'free' ? null : `Crop ${QUICK.find((q) => q.id === id).label}`);
  },

  onDial(ed, id) {
    const st = ed.committed;
    const { w, h } = st.source;
    if (id === 'rotate') commitCrop(ed, rotateQuarter(st.crop, w, h, { ccw: true }), 'Rotated');
    else if (id === 'flip') commitCrop(ed, flipHorizontal(st.crop), 'Flipped');
    else if (id === 'tall') commitCrop(ed, toggleTall(st.crop, w, h), isTall(st.crop) ? 'Crop wide' : 'Crop tall');
  },

  onRuler(ed, phase, value) {
    const st = ed.committed;
    const { w, h } = st.source;
    if (phase === 'start') {
      rulerStart = st.crop;
      touching = true;
      return;
    }
    if (phase === 'reset') {
      commitCrop(ed, setAngle(st.crop, w, h, 0), 'Straightened 0°');
      return;
    }
    // Shrink from the frame at drag start, so returning to an angle restores it.
    const base = rulerStart ?? st.crop;
    const crop = setAngle(base, w, h, Math.round(value * 10) / 10);
    if (phase === 'move') ed.live({ ...st, crop });
    else {
      touching = false;
      rulerStart = null;
      commitCrop(ed, crop);
    }
  },

  dragAxis() {
    return 'free';
  },

  hitTarget(ed, x, y) {
    const r = ed.doc.crop.rect;
    const [x0, y0] = ed.docToStage(r.x, r.y);
    const [x1, y1] = ed.docToStage(r.x + r.width, r.y + r.height);
    const near = (a, b) => Math.abs(a - b) <= HANDLE_HIT;
    const inX = x >= x0 - HANDLE_HIT && x <= x1 + HANDLE_HIT;
    const inY = y >= y0 - HANDLE_HIT && y <= y1 + HANDLE_HIT;
    if (!inX || !inY) return 'photo';
    const n = near(y, y0), s = near(y, y1), w = near(x, x0), e = near(x, x1);
    if (n && w) return 'handle:nw';
    if (n && e) return 'handle:ne';
    if (s && w) return 'handle:sw';
    if (s && e) return 'handle:se';
    const midX = Math.abs(x - (x0 + x1) / 2) <= HANDLE_HIT * 1.5;
    const midY = Math.abs(y - (y0 + y1) / 2) <= HANDLE_HIT * 1.5;
    if (n && midX) return 'handle:n';
    if (s && midX) return 'handle:s';
    if (w && midY) return 'handle:w';
    if (e && midY) return 'handle:e';
    if (x > x0 && x < x1 && y > y0 && y < y1) return 'frame';
    return 'photo';
  },

  onGesture(ed, g) {
    const st = ed.committed;
    const { w, h } = st.source;
    if (g.type === 'drag-start') {
      const t = g.target ?? 'photo';
      if (t === 'photo') return true;
      drag = { target: t, start: st.crop, x0: g.x, y0: g.y };
      touching = true;
      ed.requestRender();
      return true;
    }
    if (g.type === 'drag' && drag) {
      const k = 1 / ed.view.scale;
      const dx = (g.x - drag.x0) * k, dy = (g.y - drag.y0) * k;
      const crop = drag.target === 'frame'
        ? moveRect(drag.start, w, h, dx, dy)
        : dragHandle(drag.start, w, h, drag.target.slice(7), dx, dy);
      ed.live({ ...st, crop });
      return true;
    }
    if ((g.type === 'drag-end' || g.type === 'drag-cancel') && drag) {
      const crop = ed.doc.crop;
      drag = null;
      touching = false;
      if (g.type === 'drag-end') commitCrop(ed, crop, 'Crop');
      else ed.live(null);
      return true;
    }
    return false;
  },

  // Dim outside the frame; frame line, L-handles, edge bars; thirds while touching.
  drawOverlay(ed, ctx) {
    const r = ed.doc.crop.rect;
    const [x0, y0] = ed.docToStage(r.x, r.y);
    const [x1, y1] = ed.docToStage(r.x + r.width, r.y + r.height);
    const { width: W, height: H } = ed.stageSize();
    ctx.save();
    ctx.fillStyle = 'rgba(13,12,11,0.6)';
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.fill('evenodd');
    ctx.strokeStyle = '#f3eee6';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    if (touching || drag) {
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const t of [1 / 3, 2 / 3]) {
        ctx.moveTo(x0 + (x1 - x0) * t, y0); ctx.lineTo(x0 + (x1 - x0) * t, y1);
        ctx.moveTo(x0, y0 + (y1 - y0) * t); ctx.lineTo(x1, y0 + (y1 - y0) * t);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    const L = Math.min(HANDLE_LEN, (x1 - x0) / 3, (y1 - y0) / 3);
    ctx.beginPath();
    for (const [cx, cy, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) {
      ctx.moveTo(cx, cy + sy * L); ctx.lineTo(cx, cy); ctx.lineTo(cx + sx * L, cy);
    }
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, b = Math.min(10, (x1 - x0) / 6, (y1 - y0) / 6);
    ctx.moveTo(mx - b, y0); ctx.lineTo(mx + b, y0);
    ctx.moveTo(mx - b, y1); ctx.lineTo(mx + b, y1);
    ctx.moveTo(x0, my - b); ctx.lineTo(x0, my + b);
    ctx.moveTo(x1, my - b); ctx.lineTo(x1, my + b);
    ctx.stroke();
    ctx.restore();
  },
};
