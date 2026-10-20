// Where the Outline magnifier sits and what it shows, pure (ui/magnifier.js
// draws it). A 140 pt window in a top corner of the stage shows the photo around
// the finger at 3x, so the finger never hides the edge the line is snapping to.
// It starts top-left and jumps to the other corner when the finger comes near
// it. A finger hovering right at the edge of that reach must not bounce it back
// and forth, so the jump needs the other corner to be clear by a wider margin
// than the one that triggered it (a dead band), and on a stage so narrow that
// both corners are crowded it stays where it is.

export const SIZE = 140; // pt, the window's side
export const RADIUS = 18; // pt, its corner radius
export const INSET = 12; // pt from the stage's left or right edge
export const TOP = 10; // pt from the stage's top
export const MAG = 3; // magnification: one window pt shows 1/MAG stage pt of photo
export const AVOID = 40; // pt: a finger this close to the window sends it to the other corner…
export const HYST = 24; // …if that corner is at least AVOID + HYST from the finger
export const FADE_MS = 300; // the window fades out over this after lift
export const MOVE_PT = 2; // the finger must move this far before the pixels are read again

export function windowRect(corner, stageW, { size = SIZE, inset = INSET, top = TOP } = {}) {
  return { x: corner === 'right' ? stageW - inset - size : inset, y: top, w: size, h: size };
}

// Distance from (x, y) to the nearest point of `r` (0 inside it).
export function rectDistance(r, x, y) {
  const dx = Math.max(r.x - x, 0, x - (r.x + r.w));
  const dy = Math.max(r.y - y, 0, y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

export const otherCorner = (corner) => (corner === 'right' ? 'left' : 'right');

// The corner to start in: top-left, unless the finger is already near it and
// the right is farther.
export function initialCorner(x, y, stageW, opts = {}) {
  const { avoid = AVOID } = opts;
  const dl = rectDistance(windowRect('left', stageW, opts), x, y);
  if (dl >= avoid) return 'left';
  return rectDistance(windowRect('right', stageW, opts), x, y) > dl ? 'right' : 'left';
}

// The corner the window is in once the finger has moved to (x, y), given the
// one it is in now.
export function pickCorner(corner, x, y, stageW, opts = {}) {
  const { avoid = AVOID, hyst = HYST } = opts;
  if (rectDistance(windowRect(corner, stageW, opts), x, y) >= avoid) return corner;
  const o = otherCorner(corner);
  return rectDistance(windowRect(o, stageW, opts), x, y) >= avoid + hyst ? o : corner;
}

// What the window shows: the output px around the finger (stage pt) at `mag`,
// clamped to the photo, and where inside the window (pt from its top-left) that
// part lands, so the part off the photo stays the window's own ground. `view` is
// the editor's { scale, x, y } (output px -> stage pt). null when no photo is
// within reach of the finger at all.
export function sourceRect(finger, view, out, { size = SIZE, mag = MAG } = {}) {
  const span = size / (2 * view.scale * mag); // output px from the finger to the window's edge
  const cx = (finger.x - view.x) / view.scale, cy = (finger.y - view.y) / view.scale;
  const full = { x: cx - span, y: cy - span, w: 2 * span, h: 2 * span };
  const x0 = Math.max(0, full.x), y0 = Math.max(0, full.y);
  const x1 = Math.min(out.width, full.x + full.w), y1 = Math.min(out.height, full.y + full.h);
  if (x1 <= x0 || y1 <= y0) return null;
  const k = size / full.w; // window pt per output px (= view.scale * mag)
  return {
    rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    dest: { x: (x0 - full.x) * k, y: (y0 - full.y) * k, w: (x1 - x0) * k, h: (y1 - y0) * k },
    scale: k,
  };
}

// readOutput's `maxSide` for `src` (readOutput scales a rect so its long side is
// maxSide): one texel per device px of the window, whatever the clamp cut off.
export function readSide(src, dpr) {
  return Math.max(1, Math.round(dpr * Math.max(src.dest.w, src.dest.h)));
}

// Stage pt -> overlay pt inside the window, with the finger at its centre:
// what to ctx.transform(...) by to draw stage-space things magnified.
export function magnifyTransform(r, finger, mag = MAG) {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  return [mag, 0, 0, mag, cx - mag * finger.x, cy - mag * finger.y];
}

// 1 while the finger is down, falling to 0 over `ms` after lift (`endedAt`).
export function fadeAlpha(now, endedAt, ms = FADE_MS) {
  if (endedAt == null) return 1;
  return Math.max(0, Math.min(1, 1 - (now - endedAt) / ms));
}

// Has the finger moved enough since the pixels were last read?
export function movedFar(from, to, pt = MOVE_PT) {
  return !from || !to || Math.hypot(to.x - from.x, to.y - from.y) > pt;
}
