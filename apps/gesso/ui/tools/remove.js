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

import { RULERS, formatValue, clampValue } from '../../lib/ruler.js';
import { diskMask, maskBounds, exceedsAreaCap, composeRef } from '../../lib/heal.js';
import { strokeBounds } from '../../lib/stroke.js';
import { sourceToOutput, apply } from '../../lib/geometry.js';
import {
  PRESETS, DEFAULT_SIZE, DILATE_PX, FILTER_BLEED, brushRadius, solveFactor, discBox, clipRect, grow,
  findRegion, fullOffsets, rubWindow, mapPoints, extendBounds, boundsRect, readPadded, shrink, shrinkMask,
  stackSide, stackPair, correctionField, upsampleCorrection, cutTile, upsampleFill, discRing, refineOffset, subBlock,
  rankSources, addCorrection, SEAM_PX, recipeRecord, reviveRecipe, strokeMaskFast, shrinkFill,
} from '../../lib/remove-plan.js';
import { createHealClient } from '../heal-client.js';

const SPEC = RULERS.removeSize;
const CORAL = 'rgba(255, 77, 109, 0.45)';
const INK = 'rgba(243, 238, 230, 0.95)';
const SHADOW = 'rgba(0, 0, 0, 0.45)';
const SHIMMER_MIN_MS = 400; // SPEC F10: a tap's fill lands with a 0.4 s shimmer
const RING_HIT_PT = 22; // the Source ring is grabbable within at least a 44pt circle
const CAP_TIP = 'Big area. Do it in smaller pieces.';

let size = DEFAULT_SIZE; // brush diameter, pt on screen
let dial = 'size'; // 'size' | 'source'
let stroke = null; // the rub under the finger: { pts, r, rr, b (point box), capped (when the cap tip last showed), x, y }
let ringDrag = null; // { id, rec, start: [x, y], cur: [x, y] } source px
let movedRing = null; // a dropped ring, drawn there until its fill lands
let sizing = false; // the size ruler is being dragged: preview the brush
const jobs = []; // asked-for fills not landed yet, drawn as rings / coral
let chain = Promise.resolve();
let generation = 0; // bumped by Cancel: anything in flight is dropped
let running = null; // { under } of the fill being computed
let docId = null; // the photo the fills below belong to
const fills = new Map(); // patch id -> how it was made, for Try another and Source
let heal = null;
let shimmerAt = 0;
let shimmerTimer = 0;

const client = () => (heal ??= createHealClient());

export default {
  id: 'remove',
  label: 'Remove',
  viewMode: 'output',

  open(ed) {
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
    if (cancel) dropPending();
    stroke = null;
    ringDrag = null;
    sizing = false;
  },

  // An Undo or Redo under a fill still computing makes that fill moot (it would be
  // dropped on landing): stop it now so the next fill doesn't wait behind it.
  onHistory(ed) {
    if (running && ed.committed?.remove !== running.under) heal?.cancel();
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
    return {
      title: 'Remove',
      hint: 'Tap a spot, or rub over something.',
      cancel: true,
      done: true,
      quick: [
        { id: 'small', label: 'Small', kind: 'state', selected: size === PRESETS.small },
        { id: 'medium', label: 'Medium', kind: 'state', selected: size === PRESETS.medium },
        { id: 'large', label: 'Large', kind: 'state', selected: size === PRESETS.large },
        { id: 'another', label: 'Try another', kind: 'action', disabled: !last },
      ],
      dials: [
        { id: 'size', label: 'Size', value: formatValue(SPEC, size), selected: !showSource, kind: 'dial' },
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
    if (Object.hasOwn(PRESETS, id)) {
      size = PRESETS[id];
      dial = 'size';
    } else if (id === 'another') {
      tryAnother(ed);
    }
    ed.requestRender();
  },

  onDial(ed, id) {
    if (id === 'size' || id === 'source') dial = id;
    ed.requestRender();
  },

  onRuler(ed, phase, value) {
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

  // Captions are dimmed and ignore touches here; only the Source ring is a target.
  hitTarget(ed, x, y) {
    const ring = sourceRing(ed);
    if (!ring) return null;
    const [rx, ry] = toStage(ed)(ring.x, ring.y);
    const reach = Math.max(ring.r / ed.sourcePerStagePx(), RING_HIT_PT) + 6;
    return Math.hypot(x - rx, y - ry) <= reach ? 'ring' : null;
  },

  onGesture(ed, g) {
    switch (g.type) {
      case 'tap':
        return g.target === 'ring' ? true : tap(ed, g.x, g.y);
      case 'drag-start':
        return g.target === 'ring' ? startRing(ed, g) : startRub(ed, g);
      case 'drag':
        if (ringDrag) return moveRing(ed, g);
        if (stroke) return moveRub(ed, g);
        return false;
      case 'drag-end':
        if (ringDrag) return endRing(ed);
        if (stroke) return endRub(ed);
        return false;
      case 'drag-cancel':
        if (!ringDrag && !stroke) return false;
        ringDrag = null;
        stroke = null;
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
    for (const j of jobs) if (j.kind === 'rub') coral(ctx, map, j.pts, j.rr * k);
    if (stroke) {
      coral(ctx, map, stroke.pts, stroke.rr * k);
      ring(ctx, stroke.x, stroke.y, size / 2);
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
  },
};

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
  const job = { kind: 'tap', cx: rec.cx, cy: rec.cy, rr: rec.rr };
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
      const next = { ...rec, seed: rec.seed + 1, attempt: rec.attempt + 1 };
      const tile = await rubTile(ed, next);
      await land(ed, tile, next, { under, gen, replace: true });
    }
  });
}

function jobFor(rec) {
  return rec.kind === 'tap' ? { kind: 'tap', cx: rec.cx, cy: rec.cy, rr: rec.rr } : { kind: 'rub', pts: rec.pts, rr: rec.rr };
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
  const box = discBox(spot.cx, spot.cy, spot.rr, W, H);
  if (!box) return null;
  const T = grow(box, 3 * f, W, H); // ≥ 2 shrunk px of known surroundings
  const holeMask = diskMask(spot.cx - T.x, spot.cy - T.y, spot.rr, T.w, T.h);
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
  const ring = discRing(spot.cx - T.x, spot.cy - T.y, spot.rr, Math.max(3, Math.min(16, Math.round(0.25 * spot.rr))), T.w, T.h);
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

async function fillArea(ed, job, gen) {
  const under = ed.committed.remove;
  const tile = await rubTile(ed, job);
  if (await land(ed, tile, job, { under, gen })) ed.hint('rub-fill');
}

// PatchMatch over the rubbed area, inside its local window. Small windows run at
// full size on exact pixels; bigger ones on a shrunk copy whose fill is brought
// back up inside the area.
async function rubTile(ed, rec) {
  const { width: W, height: H } = ed.renderer.size;
  const box = clipRect(strokeBounds(rec.pts, rec.rr), W, H);
  if (!box) return null;
  const boxMask = strokeMaskFast(mapPoints(rec.pts, box), rec.rr, box.w, box.h);
  if (!maskBounds(boxMask, box.w, box.h)) return null;
  const { rect: win, scale } = rubWindow(box, W, H, rec.attempt);
  let rgba;
  if (scale >= 1) {
    const img = { width: win.w, height: win.h, data: ed.renderer.readRect(win) };
    const mask = strokeMaskFast(mapPoints(rec.pts, win), rec.rr, win.w, win.h);
    const filled = await client().inpaint(img, mask, { seed: rec.seed });
    rgba = cutTile(filled.data, win.w, { x: 0, y: 0, w: box.w, h: box.h }, box.x - win.x, box.y - win.y, boxMask, box.w);
  } else {
    const small = pick(ed.renderer.readSource({ rect: win, scale }));
    const kx = small.width / win.w, ky = small.height / win.h;
    const mask = strokeMaskFast(mapPoints(rec.pts, win, kx, ky), rec.rr * Math.max(kx, ky) + FILTER_BLEED, small.width, small.height);
    const filled = await client().inpaint(small, mask, { seed: rec.seed });
    rgba = upsampleFill(filled, win, box, boxMask);
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
  const holeMask = strokeMaskFast(mapPoints(rec.pts, T), rec.rr, T.w, T.h);
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
  const fresh = () => gen === generation && ed.committed?.remove === under;
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
  const keep = replace ? under.slice(0, -1) : under;
  // A fill that lands after Done is still Remove's step, whatever tool is open.
  ed.commit({ ...ed.committed, remove: [...keep, id] }, label, { tool: 'remove' });
  return true;
}

// Fills run one after another, each on the photo the last one left.
function enqueue(ed, job, work) {
  const gen = generation;
  jobs.push(job);
  if (jobs.length === 1) placeShimmer(ed, toStage(ed));
  showShimmer();
  ed.requestRender();
  chain = chain.then(async () => {
    if (gen !== generation) return;
    running = { under: ed.committed?.remove };
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
    }
  });
}

// Cancel, or another photo: drop every fill asked for and not landed yet.
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
    const b = strokeBounds(j.pts, j.rr);
    for (const [x, y] of [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]]) add(x, y);
  }
  el.style.left = `${x0}px`;
  el.style.top = `${y0}px`;
  el.style.width = `${Math.max(1, x1 - x0)}px`;
  el.style.height = `${Math.max(1, y1 - y0)}px`;
  el.style.borderRadius = j.kind === 'tap' ? '50%' : '0';
  // A rubbed area shimmers in its own shape. The mask is drawn once, in this
  // frame's stage px; mask-size 100% keeps it fitted through a pinch.
  if (j.kind === 'rub' && !j.mask) j.mask = silhouette(map, j, x0, y0, x1 - x0, y1 - y0, ed.sourcePerStagePx());
  const url = j.kind === 'rub' && j.mask ? `url(${j.mask})` : 'none';
  el.style.maskImage = el.style.webkitMaskImage = url;
  el.style.maskSize = el.style.webkitMaskSize = '100% 100%';
}

function silhouette(map, j, x0, y0, w, h, perPx) {
  try {
    const s = Math.min(1, 256 / Math.max(w, h, 1));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s));
    c.height = Math.max(1, Math.round(h * s));
    const ctx = c.getContext('2d');
    ctx.setTransform(s, 0, 0, s, -x0 * s, -y0 * s);
    coral(ctx, map, j.pts, j.rr / perPx, '#fff');
    const url = c.toDataURL();
    c.width = c.height = 0;
    return url;
  } catch {
    return null; // a plain box shimmer is fine
  }
}

function pick({ width, height, data }) {
  return { width, height, data };
}

function newId() {
  return `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
