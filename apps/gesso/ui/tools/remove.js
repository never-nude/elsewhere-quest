// Remove (SPEC F10): tap a spot to heal it, or rub over something to fill it.
//
// A tap copies the spot from the best place nearby and hides the seam with a
// smooth correction (lib/heal.js). The search and the seam solve run in the heal
// worker on a shrunk copy; the copy itself is composed here at full size, so the
// fill is as sharp as the photo around it. A rub is filled by PatchMatch
// (lib/inpaint.js) inside a window around the area: local on purpose, because a
// whole-photo search lets a big unrelated surface (the table) out-vote the one the
// object sits on (the saucer).
//
// Every fill is a tile of exact final pixels (lib/patches.js). Try another and a
// moved Source replace the newest tile, so each is one undo step. Fills run one at
// a time, in the order they were asked for; each re-checks on landing that the
// photo underneath is still the one it was computed from. How each fill was made
// rides in its pool entry (`how`), so Try another and Source still work after a
// relaunch. `settle()` resolves once every fill asked for has landed, so Save can
// wait for a fill still computing instead of saving the photo without it.
//
// Outline (SPEC F19) is a mode chip in the dial row. While it is on, a drag
// traces a loop whose line clings to the nearest strong edge (lib/lasso.js, on a
// 1024 px copy of the cropped photo), with the photo around the finger shown at
// 3x in a corner window (ui/magnifier.js) so the hand never hides the edge. Lift
// closes the loop along edges and fills the inside through the rub pipeline with
// the polygon as the shape; the polygon is kept in source px, so a later crop or
// rotation doesn't move the fill, and goes in the pool entry like a rub's path.

import { RULERS, formatValue, clampValue } from '../../lib/ruler.js';
import { diskMask, maskBounds, exceedsAreaCap, composeRef } from '../../lib/heal.js';
import { strokeBounds } from '../../lib/stroke.js';
import { sourceToOutput, outputToSource, multiply, apply } from '../../lib/geometry.js';
import { buildCostMap, createLasso, transformPolygon, polygonArea, polygonBounds, polygonRecord } from '../../lib/lasso.js';
import {
  PRESETS, DEFAULT_SIZE, DILATE_PX, FILTER_BLEED, brushRadius, solveFactor, discBox, clipRect, grow,
  findRegion, fullOffsets, rubWindow, mapPoints, extendBounds, boundsRect, readPadded, shrink, shrinkMask,
  stackSide, stackPair, correctionField, upsampleCorrection, cutTile, upsampleFill, discRing, refineOffset, subBlock,
  rankSources, addCorrection, SEAM_PX, recipeRecord, reviveRecipe, strokeMaskFast, shrinkFill, silhouetteSvg, copyByMatches,
  outlineBox, outlineMask, polygonSvg,
} from '../../lib/remove-plan.js';
import { createHealClient } from '../heal-client.js';
import { createMagnifier, drawTrace } from '../magnifier.js';
import { createSubjectLift } from '../subject.js';
import { subjectLiftAvailable, haptic } from '../platform.js';

const SPEC = RULERS.removeSize;
const CORAL = 'rgba(255, 77, 109, 0.45)';
const INK = 'rgba(243, 238, 230, 0.95)';
const SHADOW = 'rgba(0, 0, 0, 0.45)';
const SHIMMER_MIN_MS = 400; // SPEC F10: a tap's fill lands with a 0.4 s shimmer
const RING_HIT_PT = 22; // the Source ring is grabbable within at least a 44pt circle
const CAP_TIP = 'Big area. Do it in smaller pieces.';
const MATCH_MAX_PX = 8_000_000; // a rub's window read back at full size (32 MB) to copy its matches
const ANALYSIS_PX = 1024; // the lasso's edge map: the cropped photo at this long side
const SNAP_PT = 18; // SPEC F19: the line snaps to an edge within this of the finger, on screen
const ANCHOR_PT = 24; // an anchor every this far along the snapped line, on screen
const TINY_PT2 = 16; // a loop enclosing less than this on screen (4 x 4 pt) is nothing to fill

let size = DEFAULT_SIZE; // brush diameter, pt on screen
let dial = 'size'; // 'size' | 'outline' | 'source'
let stroke = null; // the rub under the finger: { pts, r, rr, b (point box), capped (when the cap tip last showed), x, y }
// Outline's edge map: { cm, kx, ky (analysis px per output px), crop, remove (what it was built from) }.
// Built off the finger when Outline comes on and after every fill; dropped on close.
let costMap = null;
let costTimer = 0;
// The loop under the finger: { lasso, pending (analysis px, moved once per frame), kx, ky, spacing,
// reach (the snap radius on screen), crop (what the edge map was built through) }.
let trace = null;
// A loop a held finger just lifted: filled on the next microtask unless the
// reducer's next word is pinch-start (see onGesture 'hold-end').
let ending = null;
let mag = null; // the corner magnifier, made on the first trace
let ringDrag = null; // { id, rec, start: [x, y], cur: [x, y] } source px
let movedRing = null; // a dropped ring, drawn there until its fill lands
let sizing = false; // the size ruler is being dragged: preview the brush
const jobs = []; // asked-for fills not landed yet, drawn as rings / coral
let chain = Promise.resolve();
let generation = 0; // bumped by Cancel: anything in flight is dropped
let running = null; // { under, job } of the fill being computed
let docId = null; // the photo the fills below belong to
const fills = new Map(); // patch id -> how it was made, for Try another and Source
let heal = null;
let shimmerAt = 0;
let shimmerTimer = 0;
let shimmerMask = ''; // the mask #shimmer has now (set only on change: it can be long)

const client = () => (heal ??= createHealClient());
const subject = createSubjectLift();

export default {
  id: 'remove',
  label: 'Remove',
  viewMode: 'output',
  // While Outline is on a still finger is the start of a loop, not Before.
  get claimsHold() { return dial === 'outline'; },

  open(ed) {
    subject.cancel();
    size = DEFAULT_SIZE;
    dial = 'size';
    stroke = null;
    ringDrag = null;
    sizing = false;
    const id = ed?.committed?.id ?? null;
    if (id !== docId) {
      // Another photo: nothing still computing or remembered belongs to it.
      docId = id;
      dropPending();
      fills.clear();
    }
    client().warm();
  },

  close(ed, { cancel } = {}) {
    subject.cancel();
    if (cancel) dropSession(ed.session);
    stroke = null;
    ringDrag = null;
    sizing = false;
    cancelTrace(ed);
    dropCostMap();
    mag?.dispose();
    mag = null;
  },

  // An Undo or Redo under a fill still computing makes that fill moot (it would be
  // dropped on landing): stop it now so the next fill doesn't wait behind it.
  onHistory(ed) {
    subject.cancel();
    if (running && ed.committed?.remove !== running.under) heal?.cancel();
    if (dial === 'outline') scheduleCostMap(ed); // the photo under the loop may have changed
  },

  // Resolves when every fill asked for so far has landed (or been dropped); null
  // when nothing is pending. Save waits on it so the saved copy has the fill.
  settle() {
    return jobs.length ? chain : null;
  },

  panel(ed) {
    const last = lastFill(ed);
    const sourceOk = last?.rec.kind === 'tap';
    const showSource = dial === 'source' && sourceOk;
    const outline = dial === 'outline';
    const filling = outline && jobs.some((j) => j.kind === 'outline');
    return {
      title: 'Remove',
      hint: subject.pending ? 'Finding the subject…' : filling ? 'Filling inside the outline…' : outline ? (subjectLiftAvailable() ? 'Tap it, or loop around it. The line snaps to edges.' : 'Loop around it. The line snaps to edges.') : 'Tap a spot, or rub over something.',
      cancel: true,
      done: true,
      quick: [
        { id: 'small', label: 'Small', kind: 'state', selected: size === PRESETS.small },
        { id: 'medium', label: 'Medium', kind: 'state', selected: size === PRESETS.medium },
        { id: 'large', label: 'Large', kind: 'state', selected: size === PRESETS.large },
        { id: 'another', label: 'Try another', kind: 'action', disabled: !last },
      ],
      dials: [
        { id: 'size', label: 'Size', value: formatValue(SPEC, size), selected: !showSource && !outline, kind: 'dial' },
        { id: 'outline', label: 'Outline', kind: 'mode', selected: outline, value: outline ? 'On' : 'Off' },
        {
          id: 'source', label: 'Source', kind: 'mode', selected: showSource, disabled: !sourceOk,
          value: sourceOk ? (last.rec.moved ? 'Moved' : 'Auto') : '–',
        },
      ],
      slot: showSource
        ? { kind: 'message', text: 'Drag the circle to copy from somewhere else.' }
        : { kind: 'ruler', id: 'size', spec: SPEC, value: size },
    };
  },

  onQuick(ed, id) {
    subject.cancel(ed);
    if (Object.hasOwn(PRESETS, id)) {
      size = PRESETS[id];
      setDial(ed, 'size');
    } else if (id === 'another') {
      tryAnother(ed);
    }
    ed.requestRender();
  },

  onDial(ed, id) {
    subject.cancel(ed);
    // Outline is a switch: tapping it again turns it off (back to the brush).
    if (id === 'outline') setDial(ed, dial === 'outline' ? 'size' : 'outline');
    else if (id === 'size' || id === 'source') setDial(ed, id);
    ed.requestRender();
  },

  onRuler(ed, phase, value) {
    subject.cancel(ed);
    if (phase === 'start') sizing = true;
    else if (phase === 'reset') { size = SPEC.def; sizing = false; }
    else {
      size = clampValue(SPEC, value);
      if (phase === 'end') sizing = false;
    }
    ed.requestRender();
  },

  dragAxis() {
    return 'free';
  },

  // SPEC F10: the rub under the finger shows in a 2x loupe (stage px of the finger).
  // A loop has the corner magnifier instead.
  loupe() {
    return stroke ? { x: stroke.x, y: stroke.y } : null;
  },

  // Captions are dimmed and ignore touches here; only the Source ring is a target.
  hitTarget(ed, x, y) {
    const ring = sourceRing(ed);
    if (!ring) return null;
    const [rx, ry] = toStage(ed)(ring.x, ring.y);
    const reach = Math.max(ring.r / ed.sourcePerStagePx(), RING_HIT_PT) + 6;
    return Math.hypot(x - rx, y - ry) <= reach ? 'ring' : null;
  },

  onGesture(ed, g) {
    if (['tap', 'drag-start', 'hold-start', 'pinch-start', 'drag-cancel'].includes(g.type)) subject.cancel(ed);
    switch (g.type) {
      case 'tap':
        if (g.target !== 'ring' && dial === 'outline' && subjectLiftAvailable()) {
          return subject.tap(ed, g.x, g.y, { tool: 'remove', commit: commitOutline, isCurrent: () => dial === 'outline' });
        }
        return g.target === 'ring' ? true : tap(ed, g.x, g.y);
      case 'drag-start':
      case 'hold-start': // only while Outline is on (claimsHold): a still finger starts the loop too
        if (g.target === 'ring') return g.type === 'drag-start' && startRing(ed, g);
        return dial === 'outline' ? startTrace(ed, g) : g.type === 'drag-start' && startRub(ed, g);
      case 'drag':
      case 'hold-move':
        if (ringDrag) return moveRing(ed, g);
        if (stroke) return moveRub(ed, g);
        if (trace) return moveTrace(ed, g);
        return false;
      case 'drag-end':
        if (ringDrag) return endRing(ed);
        if (stroke) return endRub(ed);
        if (trace) return endTrace(ed);
        return false;
      case 'hold-end':
        // Only a loop can be under a held finger (claimsHold). The reducer says
        // hold-end for a second finger landing and for a pointercancel as well as
        // for a lift (SPEC §4 rule 2 wants those to cancel, not fill): a pinch-start
        // follows the second finger in the same batch, so the fill waits a
        // microtask for it; a reducer that marks the other says `cancelled`.
        if (!trace) return false;
        if (g.cancelled) { cancelTrace(ed); return true; }
        return endTrace(ed, { later: true });
      case 'pinch-start':
        cancelTrace(ed); // a loop still live or just lifted by the first finger: no step
        return false;
      case 'drag-cancel':
        if (!ringDrag && !stroke && !trace) return false;
        ringDrag = null;
        stroke = null;
        cancelTrace(ed);
        ed.requestRender();
        return true;
      default:
        return false;
    }
  },

  drawOverlay(ed, ctx) {
    const map = toStage(ed);
    const k = 1 / ed.sourcePerStagePx(); // stage px per source px
    ctx.save();
    for (const j of jobs) {
      if (j.kind === 'rub') coral(ctx, map, j.pts, j.rr * k);
      else if (j.kind === 'outline') drawTrace(ctx, { path: stagePoints(map, j.poly), closed: true });
    }
    if (stroke) {
      coral(ctx, map, stroke.pts, stroke.rr * k);
      ring(ctx, stroke.x, stroke.y, size / 2);
      const L = ed.loupe;
      if (L) {
        // The same coral and brush, twice the size, inside the loupe the renderer drew.
        ctx.save();
        ctx.beginPath();
        ctx.rect(L.cx - L.r, L.cy - L.r, 2 * L.r, 2 * L.r);
        ctx.clip();
        ctx.translate(L.cx - 2 * L.x, L.cy - 2 * L.y);
        ctx.scale(2, 2);
        coral(ctx, map, stroke.pts, stroke.rr * k);
        ring(ctx, stroke.x, stroke.y, size / 2);
        ctx.restore();
        ctx.lineWidth = 3;
        ctx.strokeStyle = SHADOW;
        ctx.strokeRect(L.cx - L.r, L.cy - L.r, 2 * L.r, 2 * L.r);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = INK;
        ctx.strokeRect(L.cx - L.r, L.cy - L.r, 2 * L.r, 2 * L.r);
      }
    }
    for (const j of jobs) if (j.kind === 'tap') ring(ctx, ...map(j.cx, j.cy), j.rr * k);
    const src = sourceRing(ed);
    if (src) {
      const [tx, ty] = map(src.cx, src.cy);
      const [sx, sy] = map(src.x, src.y);
      ring(ctx, tx, ty, src.r * k, [2, 4], 0.6);
      ring(ctx, sx, sy, src.r * k, [6, 5]);
    }
    if (sizing) {
      const s = ed.stageSize();
      ring(ctx, s.width / 2, s.height / 2, size / 2);
    }
    ctx.restore();
    placeShimmer(ed, map);
    drawTraceOverlay(ed, ctx); // last: the magnifier sits on top of everything
  },
};

// ------------------------------------------------------------------ outline

function setDial(ed, id) {
  if (id === dial) return;
  const was = dial;
  dial = id;
  if (id === 'outline') {
    ed.hint('outline-on', { tool: 'remove' });
    scheduleCostMap(ed);
  } else if (was === 'outline') {
    cancelTrace(ed);
    dropCostMap();
  }
}

// The lasso's edge map of the cropped photo at analysis size, built once per
// photo state (design/lasso-integration.md §5: ~40–90 ms, so off the finger when possible) and
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
    if (dial !== 'outline' || trace || !ed.committed) return;
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
  // A fill landing mid-trace found `trace` set and left the map stale: now, off the finger.
  if (dial === 'outline') scheduleCostMap(ed);
  if (!poly) return true;
  const st = ed.committed;
  // Undo under the other hand took the crop the loop was traced through away:
  // its analysis px no longer mean anything on this photo.
  if (st.crop !== t.crop) return true;
  // A tap-sized loop, or a line out and back, encloses nothing worth a step.
  const areaPt = (polygonArea(poly) / (kx * ky)) * ed.view.scale ** 2;
  if (areaPt < TINY_PT2) return true;
  const toSource = multiply(outputToSource(st.crop, st.source.w, st.source.h), [1 / kx, 0, 0, 1 / ky, 0, 0]);
  // Kept at 0.1 px, exactly as the pool entry stores it, so a retry after a
  // relaunch rasterises the very same pixels.
  const polyS = Float32Array.from(polygonRecord(transformPolygon(poly, toSource)));
  return commitOutline(ed, polyS);
}

function commitOutline(ed, polygon) {
  const polyS = Float32Array.from(polygon);
  const { width: W, height: H } = ed.renderer.size;
  const box = outlineBox(polyS, W, H);
  if (!box) return true;
  if (exceedsAreaCap(box, W, H)) {
    // The finger can't be stopped mid-loop like a rub, so the cap is judged on lift.
    ed.panel.showTip(CAP_TIP);
    haptic('warning');
    return true;
  }
  const job = { kind: 'outline', poly: polyS, seed: 1, attempt: 0 };
  enqueue(ed, job, (gen) => fillOutline(ed, job, gen));
  ed.refresh(); // the hint says the fill is computing (enqueue refreshes again when it lands)
  return true;
}

function cancelTrace(ed) {
  const t = trace ?? ending;
  if (!t) return;
  trace = ending = null;
  t.lasso.cancel();
  mag?.cancel();
  ed.requestRender();
  if (dial === 'outline') scheduleCostMap(ed); // as finishTrace; close()/setDial drop it right after
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
  const anchors = [];
  let len = 0;
  for (let i = 2; i < p.length; i += 2) {
    len += p[i] !== p[i - 2] && p[i + 1] !== p[i - 1] ? Math.SQRT2 : 1;
    if (len >= spacing) { anchors.push(path[i], path[i + 1]); len = 0; }
  }
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

// Flat source-px points (a polygon) mapped to stage px.
function stagePoints(map, pts) {
  const out = new Float32Array(pts.length);
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const [sx, sy] = map(pts[i], pts[i + 1]);
    out[i] = sx;
    out[i + 1] = sy;
  }
  return out;
}

// A fill's shape, rubbed { pts, rr } or outlined { poly }: its box, and its mask
// over a rect seen at kx, ky with `bleed` extra px of reach.
function shapeBox(s, W, H) {
  return s.poly ? outlineBox(s.poly, W, H) : clipRect(strokeBounds(s.pts, s.rr), W, H);
}

function shapeMask(s, rect, w = rect.w, h = rect.h, kx = 1, ky = kx, bleed = 0) {
  if (s.poly) return outlineMask(s.poly, rect, w, h, kx, ky, bleed);
  return strokeMaskFast(mapPoints(s.pts, rect, kx, ky), s.rr * Math.max(kx, ky) + bleed, w, h);
}

const shapeOf = (s) => (s.poly ? { poly: s.poly } : { pts: s.pts });

// ------------------------------------------------------------------ gestures

function tap(ed, x, y) {
  const [ox, oy] = ed.stageToDoc(x, y);
  const o = ed.outputSize();
  if (!(ox >= 0 && oy >= 0 && ox < o.width && oy < o.height)) return false; // the ground, not the photo
  const [cx, cy] = ed.stageToSource(x, y);
  const rr = brushRadius(size, ed.sourcePerStagePx()) + DILATE_PX;
  const job = { kind: 'tap', cx, cy, rr };
  enqueue(ed, job, (gen) => healSpot(ed, job, gen));
  return true;
}

function startRub(ed, g) {
  const [sx, sy] = ed.stageToSource(g.x, g.y);
  const r = brushRadius(size, ed.sourcePerStagePx());
  stroke = { pts: [sx, sy], r, rr: r + DILATE_PX, b: extendBounds(null, sx, sy), capped: 0, x: g.x, y: g.y };
  ed.requestRender();
  return true;
}

function moveRub(ed, g) {
  stroke.x = g.x;
  stroke.y = g.y;
  const [sx, sy] = ed.stageToSource(g.x, g.y);
  const n = stroke.pts.length;
  // Points closer than a fifth of the brush add nothing to the area but cost
  // every later mask rasterization a segment.
  if (Math.hypot(sx - stroke.pts[n - 2], sy - stroke.pts[n - 1]) >= stroke.r * 0.2) {
    const b = extendBounds(stroke.b, sx, sy);
    const { width: W, height: H } = ed.renderer.size;
    if (exceedsAreaCap(boundsRect(b, stroke.rr), W, H)) {
      // SPEC F10: past 20% of the photo the area stops growing; rubbing inside it
      // still works. The tip stays up for as long as the finger keeps pushing out.
      const now = performance.now();
      if (!stroke.capped || now - stroke.capped > 1000) {
        ed.panel.showTip(CAP_TIP);
        stroke.capped = now;
      }
    } else {
      stroke.pts.push(sx, sy);
      stroke.b = b;
    }
  }
  ed.requestRender();
  return true;
}

function endRub(ed) {
  const { pts, rr } = stroke;
  stroke = null;
  const job = { kind: 'rub', pts, rr, seed: 1, attempt: 0 };
  enqueue(ed, job, (gen) => fillArea(ed, job, gen));
  return true;
}

function startRing(ed, g) {
  const last = lastFill(ed);
  if (last?.rec.kind !== 'tap') return false;
  const { rec } = last;
  const at = [rec.cx + rec.D.dx, rec.cy + rec.D.dy];
  ringDrag = { id: last.id, rec, start: at, cur: at };
  ed.requestRender();
  return true;
}

function moveRing(ed, g) {
  const [x0, y0] = toStage(ed)(...ringDrag.start);
  const [sx, sy] = ed.stageToSource(x0 + g.dx, y0 + g.dy); // dx, dy run from the down point
  const { width: W, height: H } = ed.renderer.size;
  ringDrag.cur = [Math.min(W - 1, Math.max(0, sx)), Math.min(H - 1, Math.max(0, sy))];
  ed.requestRender();
  return true;
}

function endRing(ed) {
  const { id, rec, cur } = ringDrag;
  ringDrag = null;
  const D = { dx: Math.round(cur[0] - rec.cx), dy: Math.round(cur[1] - rec.cy) };
  if ((D.dx === rec.D.dx && D.dy === rec.D.dy) || (D.dx === 0 && D.dy === 0)) {
    ed.requestRender();
    return true;
  }
  movedRing = { cx: rec.cx, cy: rec.cy, x: rec.cx + D.dx, y: rec.cy + D.dy, r: rec.rr };
  const job = jobFor(rec);
  enqueue(ed, job, async (gen) => {
    try {
      const under = ed.committed.remove;
      if (under.at(-1) !== id) return;
      const tile = await healTile(ed, rec, D, rec.f);
      await land(ed, tile, { ...rec, D: tile?.D, moved: true }, { under, gen, replace: true, label: 'Moved source' });
    } finally {
      movedRing = null;
    }
  });
  return true;
}

// ------------------------------------------------------------------ fills

function tryAnother(ed) {
  const last = lastFill(ed);
  if (!last) return;
  if (last.rec.kind === 'tap') {
    // Only a tap fill has a Source, which the second Try another's hint points to.
    ed.hint('try-another');
    if (last.rec.offsets.length < 2) {
      ed.panel.showTip('Nothing else matches nearby. Tap Source to choose.');
      return;
    }
  }
  const job = jobFor(last.rec);
  enqueue(ed, job, async (gen) => {
    // Retry whatever is newest by now, so quick repeated taps of Try another (or
    // one made while a fill was still computing) each move on to the next one.
    const now = lastFill(ed);
    if (!now) return;
    const { rec } = now;
    if (rec.kind === 'tap' && rec.offsets.length < 2) return;
    Object.assign(job, jobFor(rec), { mask: null });
    const under = ed.committed.remove;
    if (rec.kind === 'tap') {
      const index = (rec.index + 1) % rec.offsets.length;
      const D = rec.offsets[index];
      const tile = await healTile(ed, rec, D, rec.f);
      await land(ed, tile, { ...rec, index, D: tile?.D, moved: false }, { under, gen, replace: true });
    } else {
      // PatchMatch can bend a straight line it fills across (a horizon behind
      // someone). The alternative is a tap's copy from one place, over the rubbed
      // or outlined shape: lines carry straight on, and it has a Source to drag.
      const found = await rubOffsets(ed, rec);
      if (found) {
        const tile = await healTile(ed, found, found.offsets[0], found.f);
        await land(ed, tile, { ...found, index: 0, D: tile?.D, moved: false }, { under, gen, replace: true });
        return;
      }
      const next = { ...rec, seed: rec.seed + 1, attempt: rec.attempt + 1 };
      const tile = await rubTile(ed, next);
      await land(ed, tile, next, { under, gen, replace: true });
    }
  });
}

function jobFor(rec) {
  if (rec.kind === 'tap' && !rec.pts && !rec.poly) return { kind: 'tap', cx: rec.cx, cy: rec.cy, rr: rec.rr };
  return rec.poly ? { kind: 'outline', poly: rec.poly } : { kind: 'rub', pts: rec.pts, rr: rec.rr };
}

// Where a rubbed or outlined shape could be copied from in one piece, searched
// like a tap (healSpot) with the shape's long side as its size; null when
// nowhere fits. An outline has no brush: its half long side stands in for rr
// (the seam ring's width, the shimmer's box).
async function rubOffsets(ed, rec) {
  const { width: W, height: H } = ed.renderer.size;
  const box = shapeBox(rec, W, H);
  if (!box) return null;
  const half = Math.max(box.w, box.h) / 2;
  const f = solveFactor(half);
  const region = findRegion(box.x + box.w / 2, box.y + box.h / 2, half, W, H);
  const small = f === 1
    ? { width: region.w, height: region.h, data: ed.renderer.readRect(region) }
    : pick(ed.renderer.readSource({ rect: region, scale: 1 / f }));
  const size = { width: small.width, height: small.height }; // the worker takes `small`
  const kx = small.width / region.w, ky = small.height / region.h;
  const mask = shapeMask(rec, region, small.width, small.height, kx, ky, f > 1 ? FILTER_BLEED : 0);
  const offsets = fullOffsets(await client().find(small, mask, { maxResults: 4 }), region, size);
  if (!offsets.length) return null;
  return { kind: 'tap', ...shapeOf(rec), cx: box.x + box.w / 2, cy: box.y + box.h / 2, rr: rec.rr ?? half, f, offsets };
}

// Heal a tapped spot: find where to copy from, then copy with a seam correction.
async function healSpot(ed, job, gen) {
  const under = ed.committed.remove;
  const { width: W, height: H } = ed.renderer.size;
  const f = solveFactor(job.rr);
  const region = findRegion(job.cx, job.cy, job.rr, W, H);
  if (!region) return;
  const small = f === 1
    ? { width: region.w, height: region.h, data: ed.renderer.readRect(region) }
    : pick(ed.renderer.readSource({ rect: region, scale: 1 / f }));
  const kx = small.width / region.w, ky = small.height / region.h;
  const scx = (job.cx - region.x) * kx, scy = (job.cy - region.y) * ky, sr = job.rr * kx;
  const mask = diskMask(scx, scy, sr + (f > 1 ? FILTER_BLEED : 0), small.width, small.height);
  const look = { width: small.width, height: small.height, data: small.data.slice() }; // the worker takes `small`
  const found = await client().find(small, mask, { maxResults: 8 });
  const offsets = fullOffsets(rankSources(look, scx, scy, sr, found, { keep: 4 }), region, look);
  if (!offsets.length) {
    // Nowhere to copy a spot this big from (e.g. most of a tight crop): fill it like a rub.
    const rub = { kind: 'rub', pts: [job.cx, job.cy], rr: job.rr, seed: 1, attempt: 0 };
    const tile = await rubTile(ed, rub);
    if (await land(ed, tile, rub, { under, gen })) ed.hint('heal');
    return;
  }
  const spot = { cx: job.cx, cy: job.cy, rr: job.rr };
  const tile = await healTile(ed, spot, offsets[0], f);
  const rec = { kind: 'tap', ...spot, f, offsets, index: 0, D: tile?.D, moved: false };
  if (await land(ed, tile, rec, { under, gen })) ed.hint('heal');
}

// The heal at one offset D (source px), as a tile. Reads exact pixels of the
// hole's neighbourhood and of the place it copies from; the worker solves the
// seam on both shrunk by f; the copy plus the upsampled correction is composed
// here at full size.
async function healTile(ed, spot, D, f) {
  const { width: W, height: H } = ed.renderer.size;
  const shaped = !!(spot.pts || spot.poly); // a rub or an outline healed from one place
  const box = shaped ? shapeBox(spot, W, H) : discBox(spot.cx, spot.cy, spot.rr, W, H);
  if (!box) return null;
  const T = grow(box, 3 * f, W, H); // ≥ 2 shrunk px of known surroundings
  const holeMask = shaped ? shapeMask(spot, T) : diskMask(spot.cx - T.x, spot.cy - T.y, spot.rr, T.w, T.h);
  const hole = maskBounds(holeMask, T.w, T.h);
  if (!hole) return null;
  const side = stackSide(hole, T.w, T.h);
  const read = (r) => ed.renderer.readRect(r);
  const target = read(T);
  // Line the copy up to the pixel: the offset came from a shrunk search, or a finger.
  const m = Math.max(2, f);
  const wide = readPadded(read, { x: T.x + D.dx - m, y: T.y + D.dy - m, w: T.w + 2 * m, h: T.h + 2 * m }, W, H);
  if (!wide) return null;
  // Only the band right at the seam decides whether lines carry on across it.
  const ringW = Math.max(3, Math.min(16, Math.round(0.25 * spot.rr)));
  const ring = shaped ? shapeRing(holeMask, shapeMask(spot, T, T.w, T.h, 1, 1, ringW)) : discRing(spot.cx - T.x, spot.cy - T.y, spot.rr, ringW, T.w, T.h);
  const nudge = refineOffset(target, wide, T.w, T.h, m, ring);
  const used = { dx: D.dx + nudge.dx, dy: D.dy + nudge.dy };
  const source = subBlock(wide, T.w + 2 * m, m + nudge.dx, m + nudge.dy, T.w, T.h);
  const full = stackPair(target, source, holeMask, T.w, T.h, side);

  const ts = shrink(target, T.w, T.h, f);
  const ss = shrink(source, T.w, T.h, f);
  const small = stackPair(ts.data, ss.data, shrinkMask(holeMask, T.w, T.h, f), ts.width, ts.height, side);
  const solved = await client().correct(small.img, small.mask, small.dx, small.dy, { featherPx: 0 });
  const c = correctionField(solved.data, small);
  const corr = upsampleCorrection(c, ts.width, ts.height, f, full);
  const out = composeRef(full.img, full.mask, full.dx, full.dy, corr, 2);
  return {
    rect: { x: T.x + hole.x, y: T.y + hole.y, w: hole.w, h: hole.h },
    rgba: cutTile(out.data, full.width, hole, full.tx, full.ty, holeMask, T.w),
    D: used,
  };
}

// The band just outside a rubbed shape: set in `outer` (the shape grown by the
// band's width), not in `hole`.
function shapeRing(hole, outer) {
  const out = [];
  for (let i = 0; i < hole.length; i++) if (outer[i] && !hole[i]) out.push(i);
  return Int32Array.from(out);
}

async function fillArea(ed, job, gen) {
  const under = ed.committed.remove;
  const tile = await rubTile(ed, job);
  if (await land(ed, tile, job, { under, gen, label: 'Removed area' })) ed.hint('rub-fill');
}

async function fillOutline(ed, job, gen) {
  const under = ed.committed.remove;
  const tile = await rubTile(ed, job);
  if (await land(ed, tile, job, { under, gen, label: 'Removed outline' })) ed.hint('outline-done', { tool: 'remove' });
}

// PatchMatch over the rubbed or outlined area, inside its local window. Small
// windows run at full size on exact pixels; bigger ones on a shrunk copy whose
// fill is brought back up inside the area.
async function rubTile(ed, rec) {
  const { width: W, height: H } = ed.renderer.size;
  const box = shapeBox(rec, W, H);
  if (!box) return null;
  const boxMask = shapeMask(rec, box);
  if (!maskBounds(boxMask, box.w, box.h)) return null;
  const { rect: win, scale } = rubWindow(box, W, H, rec.attempt);
  let rgba;
  if (scale >= 1) {
    const img = { width: win.w, height: win.h, data: ed.renderer.readRect(win) };
    const mask = shapeMask(rec, win);
    const filled = await client().inpaint(img, mask, { seed: rec.seed });
    rgba = cutTile(filled.data, win.w, { x: 0, y: 0, w: box.w, h: box.h }, box.x - win.x, box.y - win.y, boxMask, box.w);
  } else {
    const small = pick(ed.renderer.readSource({ rect: win, scale }));
    const kx = small.width / win.w, ky = small.height / win.h;
    const mask = shapeMask(rec, win, small.width, small.height, kx, ky, FILTER_BLEED);
    const filled = await client().inpaint(small, mask, { seed: rec.seed });
    rgba = upsampleFill(filled, win, box, boxMask);
    if (filled.from && win.w * win.h <= MATCH_MAX_PX) {
      const winMask = shapeMask(rec, win);
      copyByMatches(rgba, filled, ed.renderer.readRect(win), win, box, boxMask, winMask);
    }
    await matchSeam(ed, rec, filled, win, box, boxMask, rgba);
  }
  return { rect: box, rgba };
}

// A fill brought up from a shrunk window is right in its broad strokes but not
// in the photo's exact shading at the edge, which shows as a faint halo on smooth
// things (a saucer, a sky). Treat it as the copy in a heal: solve the smooth
// correction that makes it meet the photo exactly at the edge, and add it.
async function matchSeam(ed, rec, filled, win, box, boxMask, rgba) {
  const { width: W, height: H } = ed.renderer.size;
  const f = Math.max(1, Math.ceil(Math.max(box.w, box.h) / SEAM_PX));
  const T = grow(box, 3 * f, W, H);
  const holeMask = shapeMask(rec, T);
  const hole = maskBounds(holeMask, T.w, T.h);
  if (!hole) return;
  const target = ed.renderer.readRect(T);
  const ts = shrink(target, T.w, T.h, f);
  const fs = shrinkFill(filled, win, T, f);
  const small = stackPair(ts.data, fs.data, shrinkMask(holeMask, T.w, T.h, f), ts.width, ts.height, stackSide(hole, T.w, T.h));
  const solved = await client().correct(small.img, small.mask, small.dx, small.dy, { featherPx: 0 });
  addCorrection(rgba, box, boxMask, correctionField(solved.data, small), ts.width, ts.height, f, box.x - T.x, box.y - T.y);
}

// Put a finished tile on the photo as one undo step — unless the photo underneath
// changed while it was being computed (Undo, Cancel, a new photo), in which case
// it is dropped: it was made for pixels that are no longer there.
async function land(ed, tile, rec, { under, gen, replace = false, label } = {}) {
  const fresh = () => gen === generation && !running?.job.dropped && ed.committed?.remove === under;
  if (!tile || !fresh()) return false;
  const id = newId();
  const meta = { ...tile.rect, how: recipeRecord(rec) };
  ed.tiles.set(id, tile.rgba);
  ed.pools = { ...ed.pools, patches: { ...ed.pools.patches, [id]: meta } };
  try {
    await ed.saveTile(id, tile.rgba, meta); // stored before the step that needs it
  } catch (err) {
    console.warn('Remove: tile not stored', err);
  }
  if (!fresh()) {
    ed.tiles.delete(id);
    const patches = { ...ed.pools.patches };
    delete patches[id];
    ed.pools = { ...ed.pools, patches };
    return false;
  }
  fills.set(id, rec);
  const remove = [...(replace ? under.slice(0, -1) : under), id];
  // A fill that lands after Done is still Remove's step, whatever tool is open, and
  // goes in under that tool's session so its Cancel keeps it.
  ed.commitBelow((s) => (s.remove === under ? { ...s, remove } : s), label, { tool: 'remove', session: running?.job.session });
  if (rec.kind === 'outline') haptic('medium');
  return true;
}

// Fills run one after another, each on the photo the last one left.
function enqueue(ed, job, work) {
  const gen = generation;
  job.session = ed.session;
  jobs.push(job);
  if (jobs.length === 1) placeShimmer(ed, toStage(ed));
  showShimmer();
  ed.requestRender();
  chain = chain.then(async () => {
    if (gen !== generation || job.dropped) return;
    running = { under: ed.committed?.remove, job };
    try {
      await work(gen);
    } catch (err) {
      if (err?.code !== 'cancelled') console.warn('Remove failed', err);
      if (gen === generation && err?.code !== 'cancelled') {
        ed.toast(err?.code === 'timeout' ? 'That took too long. Try a smaller area.' : "Couldn't remove that. Try again.", 2400);
      }
    } finally {
      running = null;
      const i = jobs.indexOf(job);
      if (i >= 0) jobs.splice(i, 1);
      if (!jobs.length) hideShimmer(false);
      ed.requestRender();
      ed.refresh();
      // The photo the edge map saw has changed: rebuild it now, off the finger,
      // not under the next drag-start.
      if (dial === 'outline') scheduleCostMap(ed);
    }
  });
}

// Cancel: drop the fills this session asked for. One still computing from an
// earlier Remove session (left with Done) is that session's step, and lands.
function dropSession(session) {
  for (let i = jobs.length - 1; i >= 0; i--) {
    if (jobs[i].session !== session) continue;
    jobs[i].dropped = true;
    jobs.splice(i, 1);
  }
  movedRing = null;
  if (running?.job.dropped) heal?.cancel();
  if (!jobs.length) hideShimmer(true);
}

// Another photo: drop every fill asked for and not landed yet.
function dropPending() {
  generation++;
  jobs.length = 0;
  movedRing = null;
  heal?.cancel();
  hideShimmer(true);
}

// ------------------------------------------------------------------ drawing

// The newest fill and how it was made: remembered from this session, or read back
// from its pool entry after a relaunch.
function lastFill(ed) {
  const ids = ed.committed?.remove;
  if (!ids?.length) return null;
  const id = ids[ids.length - 1];
  let rec = fills.get(id);
  if (!rec) {
    rec = reviveRecipe(ed.pools?.patches?.[id]?.how);
    if (rec) fills.set(id, rec);
  }
  return rec ? { id, rec } : null;
}

// Where the newest tap fill copied from (source px), when Source is showing.
function sourceRing(ed) {
  if (dial !== 'source') return null;
  const last = lastFill(ed);
  if (last?.rec.kind !== 'tap') return null;
  const { rec } = last;
  if (ringDrag) return { cx: rec.cx, cy: rec.cy, x: ringDrag.cur[0], y: ringDrag.cur[1], r: rec.rr };
  if (movedRing) return movedRing;
  return { cx: rec.cx, cy: rec.cy, x: rec.cx + rec.D.dx, y: rec.cy + rec.D.dy, r: rec.rr };
}

function toStage(ed) {
  const st = ed.doc;
  const m = sourceToOutput(st.crop, st.source.w, st.source.h);
  return (x, y) => {
    const [ox, oy] = apply(m, x, y);
    return ed.docToStage(ox, oy);
  };
}

// The rubbed area: one stroke of the whole path, so overlaps don't darken.
function coral(ctx, map, pts, radius, colour = CORAL) {
  if (pts.length < 2) return;
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = 2 * radius;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([]);
  const [x0, y0] = map(pts[0], pts[1]);
  ctx.beginPath();
  if (pts.length === 2) {
    ctx.arc(x0, y0, radius, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.moveTo(x0, y0);
  for (let i = 2; i + 1 < pts.length; i += 2) ctx.lineTo(...map(pts[i], pts[i + 1]));
  ctx.stroke();
}

function ring(ctx, x, y, r, dash = [], alpha = 1) {
  ctx.globalAlpha = alpha;
  ctx.setLineDash(dash);
  ctx.lineWidth = 3;
  ctx.strokeStyle = SHADOW;
  ctx.beginPath();
  ctx.arc(x, y, Math.max(1, r), 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

// #shimmer sweeps over the first fill still computing (SPEC §8: a soft diagonal
// light sweep). Re-placed every frame, so it follows a pinch.
function shimmerEl() {
  return typeof document === 'undefined' ? null : document.getElementById('shimmer');
}

function showShimmer() {
  const el = shimmerEl();
  if (!el) return;
  clearTimeout(shimmerTimer);
  if (el.hidden) shimmerAt = performance.now();
  el.hidden = false;
}

function hideShimmer(now) {
  const el = shimmerEl();
  if (!el) return;
  clearTimeout(shimmerTimer);
  const wait = now ? 0 : Math.max(0, SHIMMER_MIN_MS - (performance.now() - shimmerAt));
  shimmerTimer = setTimeout(() => { if (!jobs.length) el.hidden = true; }, wait);
}

function placeShimmer(ed, map) {
  const el = shimmerEl();
  const j = jobs[0];
  if (!el || !j) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y) => {
    const [sx, sy] = map(x, y);
    x0 = Math.min(x0, sx); y0 = Math.min(y0, sy); x1 = Math.max(x1, sx); y1 = Math.max(y1, sy);
  };
  if (j.kind === 'tap') {
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) add(j.cx + dx * j.rr, j.cy + dy * j.rr);
  } else {
    const b = j.kind === 'outline' ? polyRect(j.poly) : strokeBounds(j.pts, j.rr);
    for (const [x, y] of [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]]) add(x, y);
  }
  el.style.left = `${x0}px`;
  el.style.top = `${y0}px`;
  el.style.width = `${Math.max(1, x1 - x0)}px`;
  el.style.height = `${Math.max(1, y1 - y0)}px`;
  el.style.borderRadius = j.kind === 'tap' ? '50%' : '0';
  // A rubbed or outlined area shimmers in its own shape. The mask is drawn once,
  // in this frame's stage px; mask-size 100% keeps it fitted through a pinch.
  if (j.kind !== 'tap' && !j.mask) j.mask = silhouette(map, j, x0, y0, x1 - x0, y1 - y0, ed.sourcePerStagePx());
  const url = j.kind !== 'tap' && j.mask ? `url("${j.mask}")` : 'none';
  if (url !== shimmerMask) {
    shimmerMask = url;
    el.style.maskImage = el.style.webkitMaskImage = url;
    el.style.maskSize = el.style.webkitMaskSize = '100% 100%';
  }
}

function polyRect(poly) {
  const b = polygonBounds(poly, 1, { pad: DILATE_PX });
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}

function silhouette(map, j, x0, y0, w, h, perPx) {
  const box = { x: x0, y: y0, w, h };
  if (j.kind === 'outline') return polygonSvg(stagePoints(map, j.poly), box);
  const pts = [];
  for (let i = 0; i + 1 < j.pts.length; i += 2) pts.push(...map(j.pts[i], j.pts[i + 1]));
  return silhouetteSvg(pts, j.rr / perPx, box);
}

function pick({ width, height, data }) {
  return { width, height, data };
}

function newId() {
  return `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
