// Color: Auto, then six looks shown as live thumbnails of the user's own photo;
// dials for Warmth, Tint, Vividness and the look's Strength; and Pick white.

import { analyze, autoColor, whiteFromSample } from '../../lib/autofix.js';
import { setIn } from '../../lib/doc.js';
import { LOOKS, srgbToLinear } from '../../lib/develop.js';
import { formatValue } from '../../lib/ruler.js';
import { rulerSpec, dialChip, rulerEdit, photoDragEnabled, enablePhotoDrag, createPhotoScrub } from './dials.js';

const DIALS = ['warmth', 'tint', 'vividness', 'strength'];
let selected = 'warmth';
let picking = false;
let thumbsFor = '';
let loupe = null;
const scrub = createPhotoScrub();

export default {
  id: 'color',
  label: 'Color',
  viewMode: 'output',
  // While picking, a press is the pick (with a loupe), not Before.
  get claimsHold() { return picking; },

  open(ed, opts = {}) {
    selected = opts.dial && DIALS.includes(opts.dial) ? opts.dial : 'warmth';
    picking = false;
    thumbsFor = '';
  },

  close() {
    picking = false;
    loupe = null;
  },

  panel(ed) {
    const C = ed.doc.color;
    const noLook = C.look === 'none';
    queueThumbs(ed);
    return {
      title: 'Color',
      hint: picking ? 'Tap something that should be white or grey.' : 'Tap Auto or a look.',
      cancel: true,
      done: true,
      quick: [
        { id: 'auto', label: 'Auto', kind: 'action', isDefault: true },
        ...LOOKS.map((l) => ({ id: `look:${l.id}`, label: l.label, kind: 'thumb', selected: C.look === l.id })),
      ],
      dials: [
        dialChip('warmth', C.warmth, { selected: !picking && selected === 'warmth' }),
        dialChip('tint', C.tint, { selected: !picking && selected === 'tint' }),
        dialChip('vividness', C.vividness, { selected: !picking && selected === 'vividness' }),
        { ...dialChip('strength', noLook ? 100 : C.strength, { selected: !picking && selected === 'strength', disabled: noLook }), changed: !noLook && C.strength !== 100 },
        { id: 'pick', label: 'Pick white', value: '◎', selected: picking, kind: 'mode' },
      ],
      slot: picking
        ? { kind: 'message', text: 'Tap something that should be white or grey.' }
        : { kind: 'ruler', id: selected, spec: rulerSpec(selected), value: C[selected] },
    };
  },

  onQuick(ed, id) {
    if (id === 'auto') {
      const stats = analyze(ed.readOutput({ maxSide: 512 }));
      const c = autoColor(stats);
      let next = ed.committed;
      for (const k of ['warmth', 'tint', 'vividness']) next = setIn(next, ['color', k], c[k] ?? 0);
      if (next === ed.committed) ed.toast('Color looks good already');
      else ed.commit(next, 'Auto color');
      return;
    }
    if (id.startsWith('look:')) {
      const look = id.slice(5);
      let next = setIn(ed.committed, ['color', 'look'], look);
      next = setIn(next, ['color', 'strength'], 100);
      if (next !== ed.committed) ed.commit(next);
      if (look !== 'none') selected = 'strength';
    }
  },

  onDial(ed, id) {
    if (id === 'pick') {
      picking = !picking;
      return;
    }
    picking = false;
    selected = id;
  },

  onRuler(ed, phase, value) {
    if (phase === 'end' && !photoDragEnabled()) {
      enablePhotoDrag();
      ed.hint('first-ruler-drag');
    }
    rulerEdit(ed, ['color', selected], phase, value);
  },

  dragAxis() {
    if (picking) return 'none';
    return photoDragEnabled() ? 'x' : 'none';
  },

  onGesture(ed, g) {
    if (picking) {
      if (g.type === 'tap') {
        pickWhite(ed, g.x, g.y);
        return true;
      }
      if (g.type === 'hold-start' || g.type === 'hold-move') {
        loupe = { x: g.x, y: g.y, live: true };
        ed.requestRender();
        return true;
      }
      if (g.type === 'hold-end' && loupe) {
        pickWhite(ed, loupe.x, loupe.y);
        return true;
      }
      return false;
    }
    if (g.type === 'drag-start') {
      if (selected === 'strength' && ed.committed.color.look === 'none') return false;
      scrub.start(ed, selected, ['color', selected], g.x, performance.now());
      return true;
    }
    if (g.type === 'drag' && scrub.active) {
      scrub.move(ed, g.x, performance.now());
      ed.bubble?.(formatValue(rulerSpec(selected), Math.round(scrub.value)), g.x, g.y);
      return true;
    }
    if ((g.type === 'drag-end' || g.type === 'drag-cancel') && scrub.active) {
      ed.bubble?.(null);
      if (g.type === 'drag-end') scrub.end(ed);
      else scrub.cancel(ed);
      return true;
    }
    return false;
  },

  drawOverlay(ed, ctx) {
    if (!loupe) return;
    ctx.save();
    ctx.strokeStyle = '#f3eee6';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(loupe.x, loupe.y, 14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(loupe.x - 6, loupe.y); ctx.lineTo(loupe.x + 6, loupe.y);
    ctx.moveTo(loupe.x, loupe.y - 6); ctx.lineTo(loupe.x, loupe.y + 6);
    ctx.stroke();
    ctx.restore();
  },

  hitTarget(ed, x, y) {
    return picking ? null : ed.hitCaption?.(x, y) ?? null;
  },

  onHistory() {
    thumbsFor = '';
  },
};

// Average a 9×9 patch of the photo (fills included, before any tone) in linear
// light and set Warmth/Tint so it reads neutral.
function pickWhite(ed, x, y) {
  const st = ed.committed;
  const [sx, sy] = ed.stageToSource(x, y);
  const r = { x: Math.max(0, Math.min(st.source.w - 9, Math.round(sx) - 4)), y: Math.max(0, Math.min(st.source.h - 9, Math.round(sy) - 4)), w: 9, h: 9 };
  const px = ed.renderer.readRect(r);
  let lr = 0, lg = 0, lb = 0;
  for (let i = 0; i < px.length; i += 4) {
    lr += srgbToLinear(px[i] / 255);
    lg += srgbToLinear(px[i + 1] / 255);
    lb += srgbToLinear(px[i + 2] / 255);
  }
  const n = px.length / 4;
  const wb = whiteFromSample([lr / n, lg / n, lb / n]);
  let next = setIn(st, ['color', 'warmth'], wb.warmth);
  next = setIn(next, ['color', 'tint'], wb.tint);
  loupe = { x, y };
  setTimeout(() => { loupe = null; ed.requestRender(); }, 600);
  picking = false;
  selected = 'warmth';
  if (next !== st) ed.commit(next, 'Picked white');
  else ed.toast('Already neutral');
  ed.refresh();
}

// Paint each look chip with the user's own photo through that look.
function queueThumbs(ed) {
  const st = ed.committed;
  const key = `${ed.revision}:${st.crop.rect.width}x${st.crop.rect.height}`;
  if (key === thumbsFor) return;
  thumbsFor = key;
  requestAnimationFrame(() => {
    for (const l of LOOKS) {
      const canvas = ed.panel.thumbCanvas(`look:${l.id}`);
      if (!canvas) continue;
      const css = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(css.width * dpr)), h = Math.max(1, Math.round(css.height * dpr));
      let state = setIn(st, ['color', 'look'], l.id);
      state = setIn(state, ['color', 'strength'], 100);
      // a centre crop that fills the chip
      const img = ed.readOutput({ maxSide: Math.max(w, h) * 2, tone: true, state });
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      const tmp = new OffscreenCanvas(img.width, img.height);
      tmp.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
      const s = Math.max(w / img.width, h / img.height);
      ctx.drawImage(tmp, (w - img.width * s) / 2, (h - img.height * s) / 2, img.width * s, img.height * s);
    }
  });
}
