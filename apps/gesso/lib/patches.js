// Remove fills as tiles, and how to move the edited image between any two points
// in history without keeping full-frame copies (SPEC §5.5). Pure.
//
// A tile is raw RGBA over its bbox (source px, { x, y, w, h }): alpha 255 where
// the fill wrote, 0 elsewhere, RGB the exact final values. The edited image
// ("base") is therefore a function of the ordered id list alone:
//
//   base = pristine, then each tile in order, copied wherever its alpha is 255.
//
// To go from one list to another, keep the common prefix, take the extra tiles off
// newest first, and put the new ones on. Taking tile P off means: copy P's bbox
// from pristine, then re-paste the earlier tiles that touch that bbox, in order,
// CLIPPED TO P's BBOX. Outside it, later tiles may have painted over those earlier
// ones, and an unclipped paste would undo their work. Tiles hold final pixels, so
// the result is bit-exact (test/patches.test.mjs replays it).
//
// Which earlier tiles? Every tile below P is exact at each step. Only the kept
// prefix is enough when the whole revert list is run before anything else reads
// base: each reverted bbox then ends as pristine + kept tiles, and outside those
// bboxes no reverted tile ever wrote. reconcileOps does the cheaper one.

// Ids are compared by identity, position by position. `keep` is the length of the
// common prefix, so currentIds.slice(0, keep) are the tiles that stay.
export function planReconcile(currentIds, targetIds) {
  const cur = Array.isArray(currentIds) ? currentIds : [];
  const tgt = Array.isArray(targetIds) ? targetIds : [];
  const n = Math.min(cur.length, tgt.length);
  let keep = 0;
  while (keep < n && cur[keep] === tgt[keep]) keep++;
  return { keep, revert: cur.slice(keep).reverse(), apply: tgt.slice(keep) };
}

// Of `priorIds` (tiles below the one being taken off, in order), those that must be
// re-pasted, clipped to `rect`, after `rect` is restored from pristine. Ids with no
// usable bbox are skipped: there is no tile to paste for them.
export function repaintPlan(rect, priorIds, patchMeta) {
  if (!isRect(rect) || !Array.isArray(priorIds)) return [];
  const out = [];
  for (const id of priorIds) {
    const m = metaFor(patchMeta, id);
    if (m && rectIntersect(rect, m)) out.push(id);
  }
  return out;
}

// The whole reconcile as a list of operations the renderer runs in order, all of
// them before base is read again:
//   { op: 'restore', id, rect }     copy rect from pristine into base (taking `id` off)
//   { op: 'paste', id, clip }       paste tile `id`; clip is a rect, or null for all of it
// Throws if a tile being taken off has no bbox, since its pixels could not be
// cleared; the caller should rebuild base from scratch instead.
export function reconcileOps(currentIds, targetIds, patchMeta) {
  const cur = Array.isArray(currentIds) ? currentIds : [];
  const { keep, revert, apply } = planReconcile(cur, targetIds);
  const kept = cur.slice(0, keep);
  const ops = [];
  for (const id of revert) {
    const rect = metaFor(patchMeta, id);
    if (!rect) throw new Error(`patches: no bbox for ${String(id)}`);
    const restore = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    ops.push({ op: 'restore', id, rect: restore });
    for (const pid of repaintPlan(restore, kept, patchMeta)) {
      ops.push({ op: 'paste', id: pid, clip: rectIntersect(restore, metaFor(patchMeta, pid)) });
    }
  }
  for (const id of apply) ops.push({ op: 'paste', id, clip: null });
  return ops;
}

function metaFor(patchMeta, id) {
  if (patchMeta === null || typeof patchMeta !== 'object') return null;
  let m;
  if (patchMeta instanceof Map) m = patchMeta.get(id);
  else if ((typeof id === 'string' || typeof id === 'number') && Object.hasOwn(patchMeta, id)) m = patchMeta[id];
  return isRect(m) ? m : null;
}

// ------------------------------------------------------------------ rects { x, y, w, h }

// A rect with no area (or non-finite fields) is treated as nothing at all.
function isRect(r) {
  return r !== null && typeof r === 'object' &&
    Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.w) && Number.isFinite(r.h) &&
    r.w > 0 && r.h > 0;
}

// Overlap of two rects, or null when they only touch or are apart.
export function rectIntersect(a, b) {
  if (!isRect(a) || !isRect(b)) return null;
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Bounding box of both; an empty side contributes nothing. null if both are empty.
export function rectUnion(a, b) {
  const okA = isRect(a), okB = isRect(b);
  if (!okA && !okB) return null;
  if (!okA) return { x: b.x, y: b.y, w: b.w, h: b.h };
  if (!okB) return { x: a.x, y: a.y, w: a.w, h: a.h };
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w), y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function rectArea(r) {
  return isRect(r) ? r.w * r.h : 0;
}
