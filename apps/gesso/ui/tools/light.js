// Light: Auto · Brighter · Darker · Punchier · Softer; dials for Brightness,
// Contrast, Highlights, Shadows; Paint — dodge and burn with a finger; and
// Outline (SPEC F19) — loop around something and the inside is brightened,
// darkened or erased.
//
// Outline is a mode chip. While it is on, a drag traces a loop whose line clings
// to the nearest strong edge (lib/lasso.js, on a 1024 px copy of the cropped
// photo), with the photo around the finger shown at 3x in a corner window
// (ui/magnifier.js). Lift closes the loop along edges and paints the inside at
// once, as one step, through a polygon mask (lib/outline-paint.js): the entry
// goes in pools.strokes like a stroke, with the polygon in source px so a later
// crop or rotation doesn't move it. The Brighten/Darken/Erase segment picks the
// mode for the loop; after a lift the slot becomes the Amount ruler for that
// loop (right brightens, left darkens), which re-commits the entry under a new
// id on each release, so Undo brings back the exact pixels of the amount before.

import { analyze, autoLight } from '../../lib/autofix.js';
import { dabs } from '../../lib/stroke.js';
import { setIn } from '../../lib/doc.js';
import { RULERS, formatValue, clampValue } from '../../lib/ruler.js';
import { outputToSource, multiply } from '../../lib/geometry.js';
import { buildCostMap, createLasso, transformPolygon, polygonArea, polygonRecord } from '../../lib/lasso.js';
import { DEFAULT_AMOUNT, entryFromRuler, rulerFromEntry, outlineLabel, isOutlineEntry, traceAnchors, newEntryId } from '../../lib/outline-paint.js';
import { rulerSpec, dialChip, rulerEdit, photoDragEnabled, enablePhotoDrag, createPhotoScrub } from './dials.js';
import { createMagnifier, drawTrace } from '../magnifier.js';

const DIALS = ['brightness', 'contrast', 'highlights', 'shadows'];
const BRUSH_PT = 48; // on-screen brush diameter
const ANALYSIS_PX = 1024; // the lasso's edge map: the cropped photo at this long side
const SNAP_PT = 18; // SPEC F19: the line snaps to an edge within this of the finger, on screen
const ANCHOR_PT = 24; // an anchor every this far along the snapped line, on screen
const TINY_PT2 = 16; // a loop enclosing less than this on screen (4 x 4 pt) is nothing to paint
const INK = 'rgba(243, 238, 230, 0.95)';
const SEGMENT = { kind: 'segment', id: 'paint', options: [{ id: 'brighten', label: 'Brighten' }, { id: 'darken', label: 'Darken' }, { id: 'erase', label: 'Erase' }] };
// Until lib/ruler.js carries it (the integrator's diff), the Amount ruler's spec lives here too.
const AMOUNT = RULERS.outlineAmount ?? Object.freeze({
  id: 'outlineAmount', label: 'Amount', min: -100, max: 100, def: DEFAULT_AMOUNT, unitsPerPt: 0.25, decimals: 0,
  format: 'signed', detents: [0, DEFAULT_AMOUNT], tick: 5, major: 25, nudge: 5,
});

let selected = 'brightness'; // a dial, 'paint' or 'outline'
let lastDial = 'brightness'; // the dial the ruler goes back to when a mode chip is switched off
let paintMode = 'brighten'; // the segment: Paint's brush and Outline's loops share it
let stroke = null; // { id, mode, r, pts: [] }
let ring = null; // { x, y } stage px while painting
const scrub = createPhotoScrub();
let strokeCount = 0;
// Outline's edge map: { cm, kx, ky (analysis px per output px), crop, remove (what it was built from) }.
// Built off the finger when Outline comes on and after a history move; dropped on close.
let costMap = null;
let costTimer = 0;
// The loop under the finger: { lasso, pending (analysis px, moved once per frame), kx, ky, spacing,
// reach (the snap radius on screen), crop (what the edge map was built through) }.
let trace = null;
// A loop a held finger just lifted: painted on the next microtask unless the
// reducer's next word is pinch-start (see traceGesture 'hold-end').
let ending = null;
let mag = null; // the corner magnifier, made on the first trace
let amount = DEFAULT_AMOUNT; // the Amount ruler, signed: what the next loop gets and the last one is set to
// This session's newest loop, while the ruler can still change it: its polygon,
// which every re-commit of the loop shares (`next` spreads `was`), so Undo and
// Redo among those re-commits keep the ruler.
let adjusting = null;
// While the Amount ruler is dragged: { id (the entry re-made live under it),
// was (the entry it sets), wasId (where that entry sits: the newest paint step) }.
let rulerDrag = null;

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
  // While Outline is on a still finger is the start of a loop, not Before.
  get claimsHold() { return selected === 'outline'; },

  open(ed, opts = {}) {
    selected = opts.dial && DIALS.includes(opts.dial) ? opts.dial : 'brightness';
    lastDial = selected;
    stroke = null;
    ring = null;
    adjusting = null;
    rulerDrag = null;
  },

  close(ed) {
    stroke = null;
    ring = null;
    dropRulerDrag(ed); // Done or Cancel under the other hand, the ruler still held
    adjusting = null;
    cancelTrace(ed);
    dropCostMap();
    mag?.dispose();
    mag = null;
  },

  // An Undo or Redo may have put a fill under the loop, or taken one away —
  // or taken the loop the held ruler was setting off the top — or put a loop
  // at another amount (or direction) on top, which the next loop then takes.
  onHistory(ed) {
    rulerDragLost(ed);
    follow(ed);
    if (selected === 'outline') scheduleCostMap(ed);
  },

  panel(ed) {
    const L = ed.doc.light;
    const painting = selected === 'paint';
    const outline = selected === 'outline';
    const entry = adjustable(ed);
    const n = ed.doc.paint.length;
    return {
      title: 'Light',
      hint: outline ? 'Loop around it. The line snaps to edges.' : painting ? 'Drag on the photo to paint light.' : 'Tap Auto, or pick a dial and drag.',
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
        { id: 'paint', label: 'Paint', value: n ? `${n}` : '–', changed: n > 0, selected: painting, kind: 'mode' },
        { id: 'outline', label: 'Outline', value: outline ? 'On' : 'Off', selected: outline, kind: 'mode' },
      ],
      slot: outline && entry
        ? { kind: 'ruler', id: 'outlineAmount', spec: AMOUNT, value: rulerDrag ? amount : rulerFromEntry(entry) }
        : painting || outline
          ? { ...SEGMENT, selected: paintMode }
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
        if (DIALS.includes(selected)) ed.panel.ruler()?.animateTo(next.light[selected], 400, from);
      }
    } else if (id === 'brighter') nudge(ed, { brightness: 15 }, null);
    else if (id === 'darker') nudge(ed, { brightness: -15 }, null);
    else if (id === 'punchier') nudge(ed, { contrast: 15 }, null);
    else if (id === 'softer') nudge(ed, { contrast: -15, shadows: 10 }, 'Softer');
  },

  onDial(ed, id) {
    // Outline is a switch: tapping it again turns it off (back to the dial).
    const next = id === 'outline' && selected === 'outline' ? lastDial : id;
    select(ed, next);
    if (next === 'paint') ed.hint('paint-select');
  },

  onSegment(ed, id) {
    paintMode = id;
    // The next loop's direction follows the segment; the amount stays.
    if (selected === 'outline') amount = id === 'darken' ? -Math.abs(amount) : Math.abs(amount);
  },

  onRuler(ed, phase, value) {
    if (selected === 'outline') return amountRuler(ed, phase, value);
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
    if (selected === 'paint' || selected === 'outline') return 'free';
    return photoDragEnabled() ? 'x' : 'none';
  },

  onGesture(ed, g) {
    if (selected === 'outline') return traceGesture(ed, g);
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
    if (ring) {
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
    }
    drawTraceOverlay(ed, ctx); // last: the magnifier sits on top of everything
  },

  hitTarget(ed, x, y) {
    return ed.hitCaption?.(x, y) ?? null;
  },
};

// ------------------------------------------------------------------ outline

function select(ed, id) {
  if (id === selected) return;
  const was = selected;
  selected = id;
  if (DIALS.includes(id)) lastDial = id;
  if (id === 'outline') {
    adjusting = null; // a fresh session: the segment first, the ruler after a loop
    amount = paintMode === 'darken' ? -Math.abs(amount) : Math.abs(amount);
    ed.hint('outline-on', { tool: 'light' });
    scheduleCostMap(ed);
  } else if (was === 'outline') {
    dropRulerDrag(ed); // a chip under the other hand, the ruler still held
    adjusting = null;
    cancelTrace(ed);
    dropCostMap();
  }
  ed.requestRender();
}

// The loop the Amount ruler sets: this session's newest, while it (at any of
// its amounts) is still the newest paint step: an Undo past it takes the ruler
// away with it; Redo brings it back.
function adjustable(ed) {
  if (rulerDrag) return rulerDrag.was; // mid-drag the shown state names the live copy
  const s = adjusting && ed.pools.strokes[ed.doc.paint.at(-1)];
  return s && s.poly === adjusting && isOutlineEntry(s) && s.mode !== 'erase' ? s : null;
}

// The lasso's edge map of the cropped photo at analysis size, built once per
// photo state (SPEC F19 note §5: ~40–90 ms, so off the finger when possible) and
// keyed on what it saw: the crop and the fills.
function ensureCostMap(ed) {
  const st = ed.committed;
  if (costMap && costMap.crop === st.crop && costMap.remove === st.remove) return costMap;
  const a = ed.readOutput({ maxSide: ANALYSIS_PX, tone: false });
  const o = ed.outputSize();
  costMap = { cm: buildCostMap(a), kx: a.width / o.width, ky: a.height / o.height, crop: st.crop, remove: st.remove };
  return costMap;
}

function scheduleCostMap(ed) {
  clearTimeout(costTimer);
  costTimer = setTimeout(() => {
    costTimer = 0;
    if (selected !== 'outline' || trace || !ed.committed) return;
    try {
      ensureCostMap(ed);
    } catch (err) {
      console.warn('Outline: edge map not built', err); // tried again on the next drag-start
    }
  }, 0);
}

function dropCostMap() {
  clearTimeout(costTimer);
  costTimer = 0;
  costMap = null;
}

// Finger (stage px) -> the lasso's analysis px.
function toAnalysis(ed, x, y, kx, ky) {
  const [ox, oy] = ed.stageToDoc(x, y);
  return { x: ox * kx, y: oy * ky };
}

function traceGesture(ed, g) {
  switch (g.type) {
    case 'drag-start':
    case 'hold-start': // claimsHold: a still finger starts the loop too
      return startTrace(ed, g);
    case 'drag':
    case 'hold-move':
      return trace ? moveTrace(ed, g) : false;
    case 'drag-end':
      return trace ? endTrace(ed) : false;
    case 'hold-end':
      // The reducer says hold-end for a second finger landing and for a
      // pointercancel as well as for a lift (SPEC §4 rule 2 wants those to
      // cancel, not paint): a pinch-start follows the second finger in the same
      // batch, so the step waits a microtask for it; a reducer that marks the
      // other says `cancelled`.
      if (!trace) return false;
      if (g.cancelled) { cancelTrace(ed); return true; }
      return endTrace(ed, { later: true });
    case 'pinch-start':
      cancelTrace(ed); // a loop still live or just lifted by the first finger: no step
      return false;
    case 'drag-cancel':
      if (!trace) return false;
      cancelTrace(ed);
      return true;
    default:
      return false;
  }
}

function startTrace(ed, g) {
  let map;
  try {
    map = ensureCostMap(ed);
  } catch (err) {
    console.warn('Outline: edge map not built', err);
    return false;
  }
  const { cm, kx, ky } = map;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // Snap reach and anchor spacing are constant on screen, like brush sizes.
  const R = clamp((SNAP_PT / ed.view.scale) * kx, 6, 40);
  const spacing = clamp((ANCHOR_PT / ed.view.scale) * kx, 8, 48);
  const lasso = createLasso(cm, { snapRadius: R, anchorSpacing: spacing });
  lasso.begin(toAnalysis(ed, g.x, g.y, kx, ky));
  trace = { lasso, pending: null, kx, ky, spacing, reach: (R / kx) * ed.view.scale, crop: map.crop };
  (mag ??= createMagnifier(ed)).begin({ x: g.x, y: g.y });
  ed.requestRender();
  return true;
}

// Moves arrive per coalesced pointer event; the lasso is moved once per frame
// (drawTraceOverlay), a search costing up to a few ms.
function moveTrace(ed, g) {
  trace.pending = toAnalysis(ed, g.x, g.y, trace.kx, trace.ky);
  mag.move({ x: g.x, y: g.y });
  ed.requestRender();
  return true;
}

function endTrace(ed, { later = false } = {}) {
  const t = trace;
  trace = null;
  if (!later) return finishTrace(ed, t);
  ending = t;
  queueMicrotask(() => {
    if (ending !== t) return; // a pinch-start (or a close) got there first
    ending = null;
    finishTrace(ed, t);
  });
  return true;
}

function finishTrace(ed, t) {
  const { lasso, pending, kx, ky } = t;
  if (pending) lasso.move(pending);
  mag.end();
  const poly = lasso.end(); // closes the loop along edges; analysis px
  ed.requestRender();
  // An Undo mid-trace found `trace` set and left the map stale: now, off the finger.
  if (selected === 'outline') scheduleCostMap(ed);
  if (!poly) return true;
  const st = ed.committed;
  // Undo under the other hand took the crop the loop was traced through away:
  // its analysis px no longer mean anything on this photo.
  if (st.crop !== t.crop) return true;
  // A tap-sized loop, or a line out and back, encloses nothing worth a step.
  const areaPt = (polygonArea(poly) / (kx * ky)) * ed.view.scale ** 2;
  if (areaPt < TINY_PT2) return true;
  // The segment names the step (the ruler's sign agrees, except at 0). At 0 a
  // loop would paint nothing: no step while the ruler shows that 0; a 0 no
  // ruler shows any more (its loop undone, the chip off and on) is nothing to
  // start a loop from, so the default is.
  if (!amount && !adjustable(ed)) amount = paintMode === 'darken' ? -DEFAULT_AMOUNT : DEFAULT_AMOUNT;
  const { mode, amount: a } = entryFromRuler(amount, paintMode);
  if (a === 0) return true;
  const toSource = multiply(outputToSource(st.crop, st.source.w, st.source.h), [1 / kx, 0, 0, 1 / ky, 0, 0]);
  const id = newEntryId();
  const entry = { kind: 'outline', mode, poly: polygonRecord(transformPolygon(poly, toSource)), amount: a };
  ed.pools = { ...ed.pools, strokes: { ...ed.pools.strokes, [id]: entry } };
  adjusting = mode === 'erase' ? null : entry.poly;
  ed.commit({ ...st, paint: [...st.paint, id] }, outlineLabel(mode));
  if (mode !== 'erase') ed.hint('outline-done', { tool: 'light' });
  return true;
}

function cancelTrace(ed) {
  const t = trace ?? ending;
  if (!t) return;
  trace = ending = null;
  t.lasso.cancel();
  mag?.cancel();
  ed.requestRender();
  if (selected === 'outline') scheduleCostMap(ed); // as finishTrace; close()/select() drop it right after
}

// The Amount ruler re-makes this session's newest loop with the new amount (and
// the direction the sign says): live under a fresh id while the finger moves,
// committed as one step on release. The entry it replaces stays in the pool, so
// Undo lands on exactly the pixels it had.
function amountRuler(ed, phase, value) {
  if (phase === 'start') {
    const was = adjustable(ed);
    if (!was) return;
    rulerDrag = { id: newEntryId(), was, wasId: ed.committed.paint.at(-1) };
    amount = rulerFromEntry(was);
    return;
  }
  if (rulerDragLost(ed)) return;
  if (!rulerDrag && phase !== 'reset') return; // a drag dropped under the finger: the rest of it is nothing
  const was = adjustable(ed);
  if (!was) return;
  const st = ed.committed;
  const v = phase === 'reset' ? AMOUNT.def : clampValue(AMOUNT, value);
  const { mode, amount: a } = entryFromRuler(v);
  const next = { ...was, mode, amount: a };
  const id = rulerDrag?.id ?? newEntryId();
  const paint = [...st.paint.slice(0, -1), id];
  amount = v;
  if (phase === 'move') {
    ed.pools = { ...ed.pools, strokes: { ...ed.pools.strokes, [id]: next } };
    ed.live({ ...st, paint });
    return;
  }
  if (mode === was.mode && a === was.amount) {
    dropRulerDrag(ed); // back where it started: no step
    return;
  }
  rulerDrag = null;
  ed.pools = { ...ed.pools, strokes: { ...ed.pools.strokes, [id]: next } };
  paintMode = mode; // the segment (shown again when Outline is switched off and on) agrees with the sign
  ed.commit({ ...st, paint }, outlineLabel(mode));
}

// The drag sets one loop. A history move under the other hand (Undo, Redo, the
// rewind tape) that takes that loop off the top ends the drag: the committed
// state shows, rather than the loop re-made over whatever step is newest now,
// and the ruler reads as before the drag. True when the drag was dropped.
function rulerDragLost(ed) {
  if (!rulerDrag || ed.committed.paint.at(-1) === rulerDrag.wasId) return false;
  follow(ed, dropRulerDrag(ed));
  return true;
}

// Ends the Amount drag without a step: its live entry leaves the pool, and the
// committed paint goes back on the GPU (the mask holds the live amount) before
// the preview is cleared. Returns the entry the drag was setting.
function dropRulerDrag(ed) {
  if (!rulerDrag) return null;
  const { id, was } = rulerDrag;
  rulerDrag = null;
  const strokes = { ...ed.pools.strokes };
  delete strokes[id];
  ed.pools = { ...ed.pools, strokes };
  ed.live(ed.committed);
  ed.live(null);
  return was;
}

// `amount` and the segment agree with the slot (SPEC F19: a new loop takes the
// ruler's amount and direction as shown): the ruler of the loop up for
// adjusting, else `fallback` (what a dropped drag was setting), else as they were.
function follow(ed, fallback = null) {
  const e = rulerDrag ? null : (adjustable(ed) ?? fallback);
  if (!e) return;
  amount = rulerFromEntry(e);
  paintMode = e.mode;
}

// The snapped line on the stage at 1x, then the magnifier. While the magnifier
// fades after lift it shows the last trace it drew and asks for frames itself.
function drawTraceOverlay(ed, ctx) {
  if (!trace) {
    if (mag?.active) mag.draw(ctx);
    return;
  }
  const { lasso, kx, ky, spacing, reach } = trace;
  if (trace.pending) {
    lasso.move(trace.pending);
    trace.pending = null;
  }
  const p = lasso.path();
  const path = new Float32Array(p.length);
  for (let i = 0; i + 1 < p.length; i += 2) {
    const [sx, sy] = ed.docToStage(p[i] / kx, p[i + 1] / ky);
    path[i] = sx;
    path[i + 1] = sy;
  }
  // The lasso drops an anchor every `spacing` px along its 8-connected path and
  // doesn't list them, so they are found again the way it counts.
  const anchors = traceAnchors(path, spacing, p);
  ctx.save();
  if (path.length >= 6) {
    // The chord back to the start, so the loop the lift will close is visible.
    ctx.beginPath();
    ctx.moveTo(path[path.length - 2], path[path.length - 1]);
    ctx.lineTo(path[0], path[1]);
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = INK;
    ctx.globalAlpha = 0.5;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
  drawTrace(ctx, { path, anchors });
  ctx.restore();
  mag.draw(ctx, { path, anchors, snapRadius: reach }); // the reach as clamped, not as asked for
}

// ------------------------------------------------------------------ paint

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
    ed.paintingLive?.(stroke.id);
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
