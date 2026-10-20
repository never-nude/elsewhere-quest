// Light › Outline (SPEC F19): the pure half of painting light inside a traced
// loop. The pool entry is { kind: 'outline', mode, poly, amount }: `poly` the
// polygon in SOURCE px as plain numbers (lib/lasso polygonRecord), `amount` the
// paint-mask value inside it (0..1; 1 = 1.5 EV, the mask's own scale), `mode`
// as a paint stroke's. The paint mask is RG8 at S/4, so the polygon is
// rasterised at that scale with a soft edge and splatted in one draw
// (renderer.paintMask) — the same maths on every replay, so undo, redo and a
// relaunch bring back the very same pixels.
//
// The Amount ruler is signed: right brightens, left darkens, so one ruler reads
// as "how much, and which way" and the mode follows its sign. Pure: no DOM.

import { polygonBounds, polygonMask, revivePolygon } from './lasso.js';

export const EV_MAX = 1.5; // mask 1.0, as lib/develop applies it
export const FEATHER_PX = 6; // mask px of fall-off at the edge: ~24 source px at S/4
export const DEFAULT_AMOUNT = 67; // ruler units: 1 EV
export const ERASE_AMOUNT = 1; // Erase inside the outline clears it fully
export const PAINT_MODES = ['brighten', 'darken', 'erase'];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Ruler value (−100…100) -> the entry's mode and amount. With no `mode` the
// sign picks it; the segment's mode, given, wins (at 0 the sign says nothing).
// Erase ignores the ruler: the loop is cleared.
export function entryFromRuler(value, mode = null) {
  if (mode === 'erase') return { mode: 'erase', amount: ERASE_AMOUNT };
  const v = Number.isFinite(value) ? clamp(Math.round(value), -100, 100) : DEFAULT_AMOUNT;
  return { mode: mode ?? (v < 0 ? 'darken' : 'brighten'), amount: Math.abs(v) / 100 };
}

// The entry's amount as the ruler shows it (signed). An erase has no amount
// (the ruler is not shown for it); it reads as the default so a later
// brighten starts from something sensible.
export function rulerFromEntry(entry) {
  if (!entry || entry.mode === 'erase' || !Number.isFinite(entry.amount)) return DEFAULT_AMOUNT;
  const v = Math.round(clamp(entry.amount, 0, 1) * 100);
  return entry.mode === 'darken' ? -v : v;
}

export function amountEV(entry) {
  if (!entry || entry.mode === 'erase') return 0;
  return (entry.mode === 'darken' ? -1 : 1) * clamp(entry.amount, 0, 1) * EV_MAX;
}

// The history label (SPEC F13: one step per loop or ruler release).
export function outlineLabel(mode) {
  return mode === 'darken' ? 'Darkened inside outline' : mode === 'erase' ? 'Erased inside outline' : 'Brightened inside outline';
}

export function isOutlineEntry(s) {
  return !!s && s.kind === 'outline' && PAINT_MODES.includes(s.mode) && revivePolygon(s.poly) !== null
    && Number.isFinite(s.amount) && s.amount >= 0 && s.amount <= 1;
}

// The paint mask's size for a source of W x H at `scale` (renderer.clearPaint's
// rounding, so a mask rect never lands off the texture).
export function paintMaskSize(W, H, scale) {
  return { width: Math.max(1, Math.round(W * scale)), height: Math.max(1, Math.round(H * scale)) };
}

// The polygon (source px) as a mask over its box at the paint mask's scale:
// { mask (Uint8Array w*h), rect (source px, what paintMask takes), w, h } or
// null when the loop lies off the photo or is degenerate. The box is padded by
// the feather so the soft edge is not cut off; rect is the box in source px,
// so mask texels and paint-mask texels line up 1:1.
export function outlinePaint(poly, { width: W, height: H }, scale, feather = FEATHER_PX) {
  const p = ArrayBuffer.isView(poly) ? poly : revivePolygon(poly);
  if (!p || !(scale > 0) || !(W > 0) || !(H > 0)) return null;
  const size = paintMaskSize(W, H, scale);
  const b = polygonBounds(p, scale, { width: size.width, height: size.height, pad: Math.ceil(feather / 2) + 1 });
  if (!b) return null;
  const mask = polygonMask(p, { width: b.width, height: b.height, scale, x: b.x, y: b.y, feather });
  return { mask, w: b.width, h: b.height, rect: { x: b.x / scale, y: b.y / scale, w: b.width / scale, h: b.height / scale } };
}

// Anchors along a traced path (flat x, y; stage or analysis px): one every
// `spacing` px of its 8-connected length, counted the way the lasso drops them.
export function traceAnchors(path, spacing, srcPath = path) {
  const out = [];
  if (!(spacing > 0)) return out;
  let len = 0;
  for (let i = 2; i + 1 < srcPath.length; i += 2) {
    len += srcPath[i] !== srcPath[i - 2] && srcPath[i + 1] !== srcPath[i - 1] ? Math.SQRT2 : 1;
    if (len >= spacing) { out.push(path[i], path[i + 1]); len = 0; }
  }
  return out;
}

export function newEntryId(now = Date.now(), rand = Math.random()) {
  return `o${now.toString(36)}${Math.floor(rand * 1e6).toString(36)}`;
}
