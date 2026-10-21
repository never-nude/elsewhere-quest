// Remove's plumbing between the photo and lib/heal.js / lib/inpaint.js: which
// pixels to read, at what scale, how to lay them out for the heal worker, and how
// to turn what comes back into a fill tile of exact final pixels. Pure: no DOM.
//
// Rects are { x, y, w, h } in whole source px. Images are RGBA rows, top first.
//
// A tapped spot is healed in two sizes at once. The seam correction c is smooth,
// so it is solved on a copy shrunk until the hole is about SOLVE_PX across (fast
// in the worker); the copy itself is composed at full size, so the fill keeps all
// of the photo's texture. To keep the worker's input small, the hole's
// neighbourhood (the target block) and the place it copies from (the source block)
// are laid side by side in one "stacked" image, with the copy offset between them.

import { planRemoval } from './inpaint.js';
import { cleanPoints } from './stroke.js';
import { polygonBounds, polygonMask, transformPolygon, polygonRecord, revivePolygon } from './lasso.js';

export const PRESETS = Object.freeze({ small: 20, medium: 36, large: 64 }); // on-screen diameters, pt
export const DEFAULT_SIZE = PRESETS.medium;
// The fill reaches this far (source px) past the brush, so an object's soft edge
// goes too; composeRef only feathers inward.
export const DILATE_PX = 2;
export const SOLVE_PX = 128; // hole diameter the search and the seam solve run at
// Search window margin, in brush radii. SPEC §7 says 3, but a source must sit at
// least 2.5 radii away (hole and ring may not overlap their copy), so 3 leaves
// only a thin diagonal band of candidates; 4 lets the search follow an edge or a
// grain sideways (up to about 3.75 radii) at half the cost of reaching further.
export const SEARCH_REACH = 4;
// A GPU readback shrunk through mipmaps smears each pixel up to about two shrunk
// pixels; holes in such a copy grow by this much so the object can't leak into
// what counts as known surroundings.
export const FILTER_BLEED = 2.5;
// A rubbed area's seam correction is solved with the area at most this long.
export const SEAM_PX = 160;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ------------------------------------------------------------------ sizes and rects

// Brush radius in source px for an on-screen diameter: constant on screen, so a
// zoomed-in brush is finer on the photo.
export function brushRadius(diameterPt, sourcePerStagePx) {
  const d = Number(diameterPt), k = Number(sourcePerStagePx);
  if (!(d > 0) || !(k > 0) || !Number.isFinite(d) || !Number.isFinite(k)) return 0;
  return (d / 2) * k;
}

// Whole-number shrink factor that brings a hole of this radius to SOLVE_PX across.
export function solveFactor(radius, maxPx = SOLVE_PX) {
  if (!(radius > 0) || !Number.isFinite(radius)) return 1;
  return Math.max(1, Math.ceil((2 * radius) / maxPx));
}

// Every pixel a disc can mark (lib/heal.js tests pixel centres), clipped to the
// image; null when that is nothing.
export function discBox(cx, cy, r, W, H) {
  if (![cx, cy, r].every(Number.isFinite) || r < 0) return null;
  const x0 = Math.max(0, Math.floor(cx - r - 0.5)), y0 = Math.max(0, Math.floor(cy - r - 0.5));
  const x1 = Math.min(W - 1, Math.ceil(cx + r - 0.5)), y1 = Math.min(H - 1, Math.ceil(cy + r - 0.5));
  if (x1 < x0 || y1 < y0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function clipRect(r, W, H) {
  if (!r) return null;
  const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
  const x1 = Math.min(W, r.x + r.w), y1 = Math.min(H, r.y + r.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

// The rect grown by m on every side, clipped to the image.
export function grow(r, m, W, H) {
  return clipRect({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m }, W, H);
}

// Where a tapped spot looks for something to copy (SPEC §7: the hole's box plus
// three radii), in source px.
export function findRegion(cx, cy, r, W, H, reach = SEARCH_REACH) {
  const box = discBox(cx, cy, r, W, H);
  return box ? grow(box, Math.ceil(reach * r), W, H) : null;
}

// findSources' offsets are in the shrunk region's px; these are source px. Two
// alternatives that land on the same whole-pixel offset count once.
export function fullOffsets(sources, region, small) {
  const kx = region.w / small.width, ky = region.h / small.height;
  const out = [];
  const seen = new Set();
  for (const s of sources ?? []) {
    if (!Number.isFinite(s?.dx) || !Number.isFinite(s?.dy)) continue;
    const dx = Math.round(s.dx * kx), dy = Math.round(s.dy * ky);
    const key = `${dx},${dy}`;
    if (seen.has(key) || (dx === 0 && dy === 0)) continue;
    seen.add(key);
    out.push({ dx, dy });
  }
  return out;
}

// findSources only scores the ring around a candidate, so a source whose ring
// matches but which hides something inside (a highlight, the edge of another
// object) looks perfect and pastes that thing into the hole. This re-ranks
// candidates (offsets in `img` px, a hole of radius r at (cx, cy)) by
// score + lambda * how unlike its own ring the candidate's inside is (per-channel
// mean and spread), and keeps the best `keep`.
export function rankSources(img, cx, cy, r, sources, { keep = 4, lambda = 1, ringW = Math.max(2, 0.25 * r) } = {}) {
  const ranked = (sources ?? []).map((s) => ({ ...s, rank: s.score + lambda * insideVsRing(img, cx + s.dx, cy + s.dy, r, ringW) }));
  ranked.sort((a, b) => a.rank - b.rank);
  return ranked.slice(0, keep);
}

function insideVsRing(img, cx, cy, r, ringW) {
  const { width: w, height: h, data } = img;
  const acc = [new Float64Array(7), new Float64Array(7)]; // n, Σrgb, Σrgb²
  const R = r + ringW;
  const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(h - 1, Math.ceil(cy + R));
  const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(w - 1, Math.ceil(cx + R));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d > R) continue;
      const a = acc[d <= r ? 0 : 1], i = (y * w + x) * 4;
      a[0]++;
      for (let c = 0; c < 3; c++) { a[1 + c] += data[i + c]; a[4 + c] += data[i + c] * data[i + c]; }
    }
  }
  const [inn, out] = acc;
  if (!inn[0] || !out[0]) return 0;
  let p = 0;
  for (let c = 0; c < 3; c++) {
    const mi = inn[1 + c] / inn[0], mo = out[1 + c] / out[0];
    const si = Math.sqrt(Math.max(0, inn[4 + c] / inn[0] - mi * mi)), so = Math.sqrt(Math.max(0, out[4 + c] / out[0] - mo * mo));
    p += (mi - mo) ** 2 + (si - so) ** 2;
  }
  return p;
}

// A rubbed area's window for PatchMatch: local on purpose (see lib/inpaint.js
// planRemoval). Each Try another looks a little further afield.
export function rubWindow(box, W, H, attempt = 0, { maxArea = 600 * 600 } = {}) {
  const marginFactor = Math.min(1.5, 0.75 + 0.25 * Math.max(0, attempt | 0));
  const p = planRemoval({ x: box.x, y: box.y, width: box.w, height: box.h }, W, H, { marginFactor, maxArea });
  return { rect: { x: p.x, y: p.y, w: p.width, h: p.height }, scale: p.scale };
}

// Flat [x, y, ...] points moved into a rect's own coordinates and scaled.
export function mapPoints(pts, rect, kx = 1, ky = kx) {
  const out = new Array(pts.length);
  for (let i = 0; i + 1 < pts.length; i += 2) {
    out[i] = (pts[i] - rect.x) * kx;
    out[i + 1] = (pts[i + 1] - rect.y) * ky;
  }
  return out;
}

// Running box of a stroke's points, and its size once the brush is added (the
// same whole-pixel rule as lib/stroke.js strokeBounds), for the 20% cap.
export function extendBounds(b, x, y) {
  if (!b) return { x0: x, y0: y, x1: x, y1: y };
  return { x0: Math.min(b.x0, x), y0: Math.min(b.y0, y), x1: Math.max(b.x1, x), y1: Math.max(b.y1, y) };
}

export function boundsRect(b, r) {
  if (!b) return null;
  const x = Math.floor(b.x0 - r), y = Math.floor(b.y0 - r);
  return {
    x, y,
    w: Math.max(Math.ceil(b.x1 + r), Math.floor(b.x1) + 1) - x,
    h: Math.max(Math.ceil(b.y1 + r), Math.floor(b.y1) + 1) - y,
  };
}

// ------------------------------------------------------------------ masks

// lib/heal.js strokeMask, pixel for pixel, at a cost that grows with the rows a
// stroke covers rather than its area. A capsule is convex, so it meets each row
// in one run of pixels; the run's ends are found by bisection with the very same
// inside test. strokeMask tests every pixel of every capsule's box, which for a
// capped rub on a 48 MP photo is about a second on the main thread, twice.
export function strokeMaskFast(points, r, w, h) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 0 || h < 0) throw new RangeError(`bad size ${w}x${h}`);
  const mask = new Uint8Array(w * h);
  if (!Number.isFinite(r) || !(r > 0)) return mask;
  const pts = cleanPoints(points);
  if (pts.length === 2) spanCapsule(mask, w, h, pts[0], pts[1], pts[0], pts[1], r);
  for (let i = 2; i < pts.length; i += 2) spanCapsule(mask, w, h, pts[i - 2], pts[i - 1], pts[i], pts[i + 1], r);
  return mask;
}

function spanCapsule(mask, w, h, ax, ay, bx, by, r) {
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r - 0.5));
  const x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + r - 0.5));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r - 0.5));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + r - 0.5));
  const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy, r2 = r * r;
  // Exactly lib/heal.js stampCapsule's test, so the two masks agree bit for bit.
  const inside = (x, py) => {
    const px = x + 0.5;
    let t = len2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = px - ax - t * vx, ey = py - ay - t * vy;
    return ex * ex + ey * ey <= r2;
  };
  for (let y = y0; y <= y1 && x0 <= x1; y++) {
    const py = y + 0.5;
    // Where the segment comes nearest this row lies inside the capsule whenever
    // any of the row does, so the row's run (if any) holds a pixel next to it.
    let t = vy !== 0 ? (py - ay) / vy : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const s = Math.floor(ax + t * vx - 0.5);
    const a = clamp(s, x0, x1), b = clamp(s + 1, x0, x1);
    const seed = inside(a, py) ? a : inside(b, py) ? b : -1;
    if (seed < 0) continue;
    let lo = x0, hi = seed; // left end: the first inside pixel in [x0, seed]
    if (inside(lo, py)) hi = lo;
    else while (hi - lo > 1) { const m = (lo + hi) >> 1; if (inside(m, py)) hi = m; else lo = m; }
    const left = hi;
    lo = seed; hi = x1; // right end: the last inside pixel in [seed, x1]
    if (inside(hi, py)) lo = hi;
    else while (hi - lo > 1) { const m = (lo + hi) >> 1; if (inside(m, py)) lo = m; else hi = m; }
    mask.fill(1, y * w + left, y * w + lo + 1);
  }
  for (const [px, py] of [[ax, ay], [bx, by]]) {
    const x = Math.floor(px), y = Math.floor(py);
    if (x >= 0 && y >= 0 && x < w && y < h) mask[y * w + x] = 1;
  }
}

// An outlined polygon (lib/lasso.js, source px) as a fill's shape, so it goes
// through the rub pipeline in place of a brushed path: its box in remove-plan's
// rect shape, grown by `pad` like a rub's rr = r + DILATE_PX, clipped to the
// image; null when none of it is on the photo.
export function outlineBox(poly, W, H, pad = DILATE_PX) {
  const b = polygonBounds(poly, 1, { width: W, height: H, pad });
  return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null;
}

// The polygon's mask over `rect` (source px) as a w x h image of it seen at kx,
// ky (a shrunk window): grown by DILATE_PX, so the object's soft fringe goes too,
// plus `bleed` px of the shrunk image (FILTER_BLEED, a seam ring's width). 0/1,
// as strokeMaskFast makes it, so every consumer treats the two shapes alike.
export function outlineMask(poly, rect, w, h, kx = 1, ky = kx, bleed = 0) {
  const p = transformPolygon(poly, [kx, 0, 0, ky, -rect.x * kx, -rect.y * ky]);
  const m = polygonMask(p, { width: w, height: h, feather: 0, grow: DILATE_PX * Math.max(kx, ky) + bleed });
  for (let i = 0; i < m.length; i++) m[i] = m[i] ? 1 : 0;
  return m;
}

// The rubbed area's outline as an SVG data URL, for the shimmer's CSS mask:
// `pts` (flat x, y) and `radius` in the same px as the box { x, y, w, h } it is
// drawn into. A string, not a canvas: a canvas readback (toDataURL) waits for the
// GPU, which is busy with the photo, and stalled the main thread for seconds.
export function silhouetteSvg(pts, radius, box) {
  const n = (v) => Math.round(v * 10) / 10;
  const w = Math.max(1, n(box.w)), h = Math.max(1, n(box.h));
  const r = Math.max(0.5, n(radius));
  let shape = '';
  const at = (i) => `${n(pts[i] - box.x)} ${n(pts[i + 1] - box.y)}`;
  if (pts.length === 2) {
    shape = `<circle cx="${n(pts[0] - box.x)}" cy="${n(pts[1] - box.y)}" r="${r}" fill="#fff"/>`;
  } else if (pts.length > 2) {
    let d = `M${at(0)}`;
    for (let i = 2; i + 1 < pts.length; i += 2) d += `L${at(i)}`;
    shape = `<path d="${d}" fill="none" stroke="#fff" stroke-width="${n(2 * r)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  return svgUrl(shape, w, h);
}

// The same for an outlined polygon: the loop, filled.
export function polygonSvg(pts, box) {
  const n = (v) => Math.round(v * 10) / 10;
  const w = Math.max(1, n(box.w)), h = Math.max(1, n(box.h));
  let shape = '';
  if (pts.length >= 6) {
    let d = '';
    for (let i = 0; i + 1 < pts.length; i += 2) d += `${i ? 'L' : 'M'}${n(pts[i] - box.x)} ${n(pts[i + 1] - box.y)}`;
    shape = `<path d="${d}Z" fill="#fff"/>`;
  }
  return svgUrl(shape, w, h);
}

function svgUrl(shape, w, h) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none">${shape}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// ------------------------------------------------------------------ reading pixels

// The rect's pixels, with anything off the photo filled by repeating the nearest
// edge pixel — how lib/heal.js copies from beyond the edge, for a Source ring
// dragged half off the photo. `read(rect)` returns an on-photo rect's RGBA.
export function readPadded(read, rect, W, H) {
  const inner = clipRect(rect, W, H);
  if (!inner) return null;
  const px = read(inner);
  if (inner.x === rect.x && inner.y === rect.y && inner.w === rect.w && inner.h === rect.h) return px;
  const out = new Uint8ClampedArray(rect.w * rect.h * 4);
  for (let y = 0; y < rect.h; y++) {
    const sy = clamp(rect.y + y, inner.y, inner.y + inner.h - 1) - inner.y;
    for (let x = 0; x < rect.w; x++) {
      const sx = clamp(rect.x + x, inner.x, inner.x + inner.w - 1) - inner.x;
      const s = (sy * inner.w + sx) * 4, d = (y * rect.w + x) * 4;
      out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2]; out[d + 3] = px[s + 3];
    }
  }
  return out;
}

// ------------------------------------------------------------------ full-size offset refinement

// The band just outside a disc hole, as indices into a w x h block: pixel centres
// more than r and at most r + ringW from (cx, cy).
export function discRing(cx, cy, r, ringW, w, h) {
  const out = [];
  const r0 = r * r, r1 = (r + ringW) ** 2;
  const y0 = Math.max(0, Math.floor(cy - r - ringW)), y1 = Math.min(h - 1, Math.ceil(cy + r + ringW));
  const x0 = Math.max(0, Math.floor(cx - r - ringW)), x1 = Math.min(w - 1, Math.ceil(cx + r + ringW));
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx, d = dx * dx + dy * dy;
      if (d > r0 && d <= r1) out.push(y * w + x);
    }
  }
  return Int32Array.from(out);
}

// An offset found on a copy shrunk by f is only good to about f px at full size,
// which is enough to break wood grain or a hairline at the seam. `wide` holds the
// source block grown by m on every side ((w + 2m) x (h + 2m)); this finds the
// shift within ±m whose ring matches the target's ring best (RGB SSD), nearest
// the found offset on ties.
export function refineOffset(target, wide, w, h, m, ring) {
  const ww = w + 2 * m;
  let best = { dx: 0, dy: 0 }, bestS = Infinity, bestD = Infinity;
  for (let j = -m; j <= m; j++) {
    for (let i = -m; i <= m; i++) {
      let s = 0, k = 0;
      for (; k < ring.length && s <= bestS; k++) {
        const p = ring[k], x = p % w, y = (p - x) / w;
        const a = p * 4, b = ((y + m + j) * ww + x + m + i) * 4;
        const r = target[a] - wide[b], g = target[a + 1] - wide[b + 1], u = target[a + 2] - wide[b + 2];
        s += r * r + g * g + u * u;
      }
      if (k < ring.length) continue; // gave up early: already worse
      const d = i * i + j * j;
      if (s < bestS || (s === bestS && d < bestD)) { bestS = s; bestD = d; best = { dx: i, dy: j }; }
    }
  }
  return best;
}

// The w x h block at (x, y) inside an RGBA image `ww` wide.
export function subBlock(data, ww, x, y, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) out.set(data.subarray(((row + y) * ww + x) * 4, ((row + y) * ww + x + w) * 4), row * w * 4);
  return out;
}

// ------------------------------------------------------------------ shrinking

// Box-average shrink by a whole factor; a short last row or column averages what
// it has. f = 1 returns a copy.
export function shrink(data, w, h, f) {
  const sw = Math.ceil(w / f), sh = Math.ceil(h / f);
  const out = new Uint8ClampedArray(sw * sh * 4);
  if (f === 1) { out.set(data.subarray(0, w * h * 4)); return { width: w, height: h, data: out }; }
  for (let y = 0; y < sh; y++) {
    const ya = y * f, yb = Math.min(h, ya + f);
    for (let x = 0; x < sw; x++) {
      const xa = x * f, xb = Math.min(w, xa + f);
      let r = 0, g = 0, b = 0, a = 0;
      for (let yy = ya; yy < yb; yy++) {
        for (let xx = xa; xx < xb; xx++) {
          const i = (yy * w + xx) * 4;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; a += data[i + 3];
        }
      }
      const n = (yb - ya) * (xb - xa), o = (y * sw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { width: sw, height: sh, data: out };
}

// A shrunk pixel is hole if any of its pixels is, so known shrunk pixels hold only
// known colour and the hole never loses ground.
export function shrinkMask(mask, w, h, f) {
  const sw = Math.ceil(w / f), sh = Math.ceil(h / f);
  const out = new Uint8Array(sw * sh);
  for (let y = 0; y < h; y++) {
    const row = y * w, srow = Math.floor(y / f) * sw;
    for (let x = 0; x < w; x++) if (mask[row + x]) out[srow + Math.floor(x / f)] = 1;
  }
  return out;
}

// ------------------------------------------------------------------ the stacked heal image

// Which side of the target block the source block goes. The heal treats the image
// edge as "no neighbour" (Neumann) and composeRef doesn't feather towards it, which
// is right where the hole meets the photo's real edge, so the source block must
// not sit against such an edge. `hole` is the hole's box inside the w x h target.
export function stackSide(hole, w, h) {
  if (hole.y + hole.h < h) return 'below';
  if (hole.x + hole.w < w) return 'right';
  if (hole.y > 0) return 'above';
  if (hole.x > 0) return 'left';
  return 'below'; // a hole spanning the whole block: no good side
}

export function stackLayout(w, h, side) {
  switch (side) {
    case 'right': return { width: 2 * w, height: h, tx: 0, ty: 0, sx: w, sy: 0 };
    case 'above': return { width: w, height: 2 * h, tx: 0, ty: h, sx: 0, sy: 0 };
    case 'left': return { width: 2 * w, height: h, tx: w, ty: 0, sx: 0, sy: 0 };
    default: return { width: w, height: 2 * h, tx: 0, ty: 0, sx: 0, sy: h };
  }
}

// Target and source blocks (each w x h RGBA) in one image, the hole mask in the
// target block, and the copy offset (dx, dy) from target to source.
export function stackPair(target, source, mask, w, h, side) {
  const L = stackLayout(w, h, side);
  const data = new Uint8ClampedArray(L.width * L.height * 4);
  const m = new Uint8Array(L.width * L.height);
  for (let y = 0; y < h; y++) {
    data.set(target.subarray(y * w * 4, (y + 1) * w * 4), ((y + L.ty) * L.width + L.tx) * 4);
    data.set(source.subarray(y * w * 4, (y + 1) * w * 4), ((y + L.sy) * L.width + L.sx) * 4);
    m.set(mask.subarray(y * w, (y + 1) * w), (y + L.ty) * L.width + L.tx);
  }
  return { ...L, w, h, img: { width: L.width, height: L.height, data }, mask: m, dx: L.sx - L.tx, dy: L.sy - L.ty };
}

// The seam correction over the target block, from the worker's 'correct' result
// on a stacked image. composeRef (featherPx 0) wrote copy + c into the hole and
// left everything else alone, so c = result − copy there; outside the hole that
// difference is target − copy, which is c's definition. Float32Array(w*h*3).
export function correctionField(result, S) {
  const { w, h, width: W } = S;
  const c = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = ((y + S.ty) * W + x + S.tx) * 4, s = ((y + S.sy) * W + x + S.sx) * 4, o = (y * w + x) * 3;
      c[o] = result[t] - result[s];
      c[o + 1] = result[t + 1] - result[s + 1];
      c[o + 2] = result[t + 2] - result[s + 2];
    }
  }
  return c;
}

// c, solved over a target block shrunk by f (cw x ch), brought up to full size at
// the hole pixels of the full stacked image F, as composeRef wants it (one
// Float32Array of F's size). Bilinear between shrunk pixel centres: c is smooth,
// so this loses nothing that matters (SPEC §7).
export function upsampleCorrection(c, cw, ch, f, F) {
  const { w, h, width: W } = F;
  const out = new Float32Array(F.width * F.height * 3);
  for (let y = 0; y < h; y++) {
    const v = clamp((y + 0.5) / f - 0.5, 0, ch - 1);
    const v0 = Math.floor(v), v1 = Math.min(ch - 1, v0 + 1), fv = v - v0;
    for (let x = 0; x < w; x++) {
      const p = (y + F.ty) * W + x + F.tx;
      if (!F.mask[p]) continue;
      const u = clamp((x + 0.5) / f - 0.5, 0, cw - 1);
      const u0 = Math.floor(u), u1 = Math.min(cw - 1, u0 + 1), fu = u - u0;
      const a = (v0 * cw + u0) * 3, b = (v0 * cw + u1) * 3, d = (v1 * cw + u0) * 3, e = (v1 * cw + u1) * 3;
      for (let k = 0; k < 3; k++) {
        out[p * 3 + k] = (c[a + k] + (c[b + k] - c[a + k]) * fu) * (1 - fv) + (c[d + k] + (c[e + k] - c[d + k]) * fu) * fv;
      }
    }
  }
  return out;
}

// The same correction added straight onto a fill tile over `box` (alpha set where
// `mask`, box-sized), for a fill that isn't a copy (PatchMatch brought up from a
// shrunk window): c was solved over a block shrunk by f whose origin lies at
// (-ox, -oy) from the box, i.e. the box starts at (ox, oy) inside that block.
export function addCorrection(rgba, box, mask, c, cw, ch, f, ox, oy) {
  const U0 = new Int32Array(box.w), U1 = new Int32Array(box.w), FU = new Float64Array(box.w);
  for (let x = 0; x < box.w; x++) {
    const u = clamp((x + ox + 0.5) / f - 0.5, 0, cw - 1);
    const u0 = Math.floor(u);
    U0[x] = u0; U1[x] = Math.min(cw - 1, u0 + 1); FU[x] = u - u0;
  }
  for (let y = 0; y < box.h; y++) {
    const v = clamp((y + oy + 0.5) / f - 0.5, 0, ch - 1);
    const v0 = Math.floor(v), v1 = Math.min(ch - 1, v0 + 1), fv = v - v0;
    for (let x = 0; x < box.w; x++) {
      const i = y * box.w + x;
      if (!mask[i]) continue;
      const u0 = U0[x], u1 = U1[x], fu = FU[x];
      const a = (v0 * cw + u0) * 3, b = (v0 * cw + u1) * 3, d = (v1 * cw + u0) * 3, e = (v1 * cw + u1) * 3;
      for (let k = 0; k < 3; k++) {
        rgba[i * 4 + k] += (c[a + k] + (c[b + k] - c[a + k]) * fu) * (1 - fv) + (c[d + k] + (c[e + k] - c[d + k]) * fu) * fv;
      }
    }
  }
  return rgba;
}

// ------------------------------------------------------------------ how a fill was made

// Try another and Source need to know how the newest fill was made. That rides
// along in the fill's pool entry (pools.patches[id].how), so it survives autosave
// and a relaunch. Numbers are kept exactly (doubles survive JSON and structured
// clone), so a retry after a relaunch covers exactly the pixels the fill did.
//   tap: { kind: 'tap', cx, cy, rr, f, offsets: [{ dx, dy }], index, D: { dx, dy }, moved, pts? | poly? }
//        (pts or poly: a rub or an outline healed from one place, Try another's
//        alternative to PatchMatch)
//   rub: { kind: 'rub', pts: [x, y, ...], rr, seed, attempt }
//   outline: { kind: 'outline', poly: [x, y, ...] (source px, 0.1 px), seed, attempt }
export function recipeRecord(rec) {
  if (rec?.kind === 'tap') {
    if (!rec.D || !Array.isArray(rec.offsets)) return null;
    if (rec.poly && polygonRecord(rec.poly).length < 6) return null;
    return {
      kind: 'tap', cx: rec.cx, cy: rec.cy, rr: rec.rr, f: rec.f,
      offsets: rec.offsets.map(({ dx, dy }) => ({ dx, dy })), index: rec.index,
      D: { dx: rec.D.dx, dy: rec.D.dy }, moved: !!rec.moved,
      ...(rec.poly ? { poly: polygonRecord(rec.poly) } : rec.pts ? { pts: Array.from(rec.pts) } : {}),
    };
  }
  if (rec?.kind === 'rub') {
    return { kind: 'rub', pts: Array.from(rec.pts), rr: rec.rr, seed: rec.seed | 0, attempt: rec.attempt | 0 };
  }
  if (rec?.kind === 'outline') {
    const poly = polygonRecord(rec.poly);
    return poly.length >= 6 ? { kind: 'outline', poly, seed: rec.seed | 0, attempt: rec.attempt | 0 } : null;
  }
  return null;
}

// The recipe back from a pool entry, or null when it is missing or doesn't make
// sense (an older draft, damage): the fill then just can't be retried.
export function reviveRecipe(how) {
  const fin = (...v) => v.every(Number.isFinite);
  const isOffset = (o) => o && typeof o === 'object' && Number.isInteger(o.dx) && Number.isInteger(o.dy);
  if (!how || typeof how !== 'object') return null;
  if (how.kind === 'tap') {
    const { cx, cy, rr, f, offsets, index, D } = how;
    if (!fin(cx, cy, rr) || !(rr > 0) || !Number.isInteger(f) || f < 1) return null;
    if (!Array.isArray(offsets) || !offsets.length || offsets.length > 16 || !offsets.every(isOffset)) return null;
    if (!Number.isInteger(index) || index < 0 || index >= offsets.length || !isOffset(D)) return null;
    const pts = how.pts;
    if (pts !== undefined && (!Array.isArray(pts) || pts.length < 2 || pts.length % 2 || !pts.every((v) => Number.isFinite(v)))) return null;
    const poly = how.poly !== undefined ? revivePolygon(how.poly) : null;
    if ((how.poly !== undefined && !poly) || (poly && pts)) return null;
    return {
      kind: 'tap', cx, cy, rr, f, offsets: offsets.map(({ dx, dy }) => ({ dx, dy })), index, D: { dx: D.dx, dy: D.dy }, moved: how.moved === true,
      ...(poly ? { poly } : pts ? { pts: pts.slice() } : {}),
    };
  }
  if (how.kind === 'rub') {
    const { pts, rr, seed, attempt } = how;
    if (!Array.isArray(pts) || pts.length < 2 || pts.length % 2 || !pts.every((v) => Number.isFinite(v))) return null;
    if (!fin(rr, seed, attempt) || !(rr > 0)) return null;
    return { kind: 'rub', pts: pts.slice(), rr, seed: seed | 0, attempt: Math.max(0, attempt | 0) };
  }
  if (how.kind === 'outline') {
    const poly = revivePolygon(how.poly);
    if (!poly || !fin(how.seed, how.attempt)) return null;
    return { kind: 'outline', poly, seed: how.seed | 0, attempt: Math.max(0, how.attempt | 0) };
  }
  return null;
}

// ------------------------------------------------------------------ tiles

// A fill tile over `box` (coordinates of `mask`, which is maskW wide): RGBA from
// `data` (dataW wide, the mask's origin at (ox, oy) in it) where the mask is set,
// alpha 255; everything else alpha 0, meaning "leave the photo alone".
export function cutTile(data, dataW, box, ox, oy, mask, maskW) {
  const out = new Uint8ClampedArray(box.w * box.h * 4);
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      if (!mask[(box.y + y) * maskW + box.x + x]) continue;
      const s = ((box.y + y + oy) * dataW + box.x + x + ox) * 4, d = (y * box.w + x) * 4;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = 255;
    }
  }
  return out;
}

// PatchMatch ran on `small`, a shrunk copy of `win` (source px). Bring the fill
// back to full size inside the hole: a tile over `box` (source px) with alpha 255
// where `mask` (box-sized) is set. Bilinear between shrunk pixel centres, as
// lib/inpaint.js inpaintScaled does.
export function upsampleFill(small, win, box, mask) {
  const sw = small.width, sh = small.height, d = small.data;
  const kx = sw / win.w, ky = sh / win.h;
  const out = new Uint8ClampedArray(box.w * box.h * 4);
  // Columns repeat on every row: work their taps out once (a capped rub is millions of pixels).
  const U0 = new Int32Array(box.w), U1 = new Int32Array(box.w), FU = new Float64Array(box.w);
  for (let x = 0; x < box.w; x++) {
    const u = clamp((box.x + x - win.x + 0.5) * kx - 0.5, 0, sw - 1);
    const u0 = Math.floor(u);
    U0[x] = u0; U1[x] = Math.min(sw - 1, u0 + 1); FU[x] = u - u0;
  }
  for (let y = 0; y < box.h; y++) {
    const v = clamp((box.y + y - win.y + 0.5) * ky - 0.5, 0, sh - 1);
    const v0 = Math.floor(v), v1 = Math.min(sh - 1, v0 + 1), fv = v - v0;
    const r0 = v0 * sw, r1 = v1 * sw;
    for (let x = 0; x < box.w; x++) {
      const i = y * box.w + x;
      if (!mask[i]) continue;
      const u0 = U0[x], u1 = U1[x], fu = FU[x];
      const a = (r0 + u0) * 4, b = (r0 + u1) * 4, c = (r1 + u0) * 4, e = (r1 + u1) * 4;
      for (let k = 0; k < 3; k++) {
        out[i * 4 + k] = (d[a + k] + (d[b + k] - d[a + k]) * fu) * (1 - fv) + (d[c + k] + (d[e + k] - d[c + k]) * fu) * fv;
      }
      out[i * 4 + 3] = 255;
    }
  }
  return out;
}

// PatchMatch on `small` (a shrunk copy of `win`) says which small pixel each hole
// pixel copied (`small.from`, -1 for none). Bring the fill up by those matches, not
// only by its colours: each hole pixel of `box` takes the exact pixel of `full`
// (win's pixels at full size) at the same offset, scaled up, so the photo's fine
// texture survives. A match that lands outside win or in its hole (`winMask`)
// keeps the colour upsampleFill gave it.
export function copyByMatches(rgba, small, full, win, box, boxMask, winMask) {
  const sw = small.width, sh = small.height, from = small.from;
  const kx = sw / win.w, ky = sh / win.h;
  for (let y = 0; y < box.h; y++) {
    const Y = box.y + y - win.y;
    const v = Math.min(sh - 1, Math.floor((Y + 0.5) * ky));
    for (let x = 0; x < box.w; x++) {
      const i = y * box.w + x;
      if (!boxMask[i]) continue;
      const X = box.x + x - win.x;
      const u = Math.min(sw - 1, Math.floor((X + 0.5) * kx));
      const q = from[v * sw + u];
      if (q < 0) continue;
      const sx = X + Math.round(((q % sw) - u) / kx), sy = Y + Math.round((Math.floor(q / sw) - v) / ky);
      if (sx < 0 || sy < 0 || sx >= win.w || sy >= win.h || winMask[sy * win.w + sx]) continue;
      const s = (sy * win.w + sx) * 4;
      rgba[i * 4] = full[s]; rgba[i * 4 + 1] = full[s + 1]; rgba[i * 4 + 2] = full[s + 2];
    }
  }
}

// The same fill seen shrunk by f over the rect T: what shrink(upsampleFill(...)
// over all of T, f) gives (to within rounding), without making that full-size
// copy first, which for a capped rub is tens of megabytes and a long main-thread
// stall. Bilinear sampling is separable, so a block's average is the small
// image's pixels weighted by each axis's averaged taps.
export function shrinkFill(small, win, T, f) {
  const sw = small.width, sh = small.height, d = small.data;
  const W = Math.ceil(T.w / f), H = Math.ceil(T.h / f);
  const cols = blockTaps(T.x - win.x, T.w, f, sw / win.w, sw);
  const rows = blockTaps(T.y - win.y, T.h, f, sh / win.h, sh);
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const { start: j0, w: wy } = rows[y];
    for (let x = 0; x < W; x++) {
      const { start: i0, w: wx } = cols[x];
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < wy.length; j++) {
        const q = wy[j];
        if (!q) continue;
        let rr = 0, gg = 0, bb = 0;
        for (let i = 0, p = ((j0 + j) * sw + i0) * 4; i < wx.length; i++, p += 4) {
          rr += d[p] * wx[i]; gg += d[p + 1] * wx[i]; bb += d[p + 2] * wx[i];
        }
        r += rr * q; g += gg * q; b += bb * q;
      }
      const o = (y * W + x) * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
    }
  }
  return { width: W, height: H, data: out };
}

// Along one axis: for each block of f full px (n px in all, the first at offset
// o from the window's origin, k small px per full px, m small px), the run of
// small px it reads and their weights, averaging upsampleFill's bilinear taps
// over the block's pixels.
function blockTaps(o, n, f, k, m) {
  const out = [];
  for (let a = 0; a < n; a += f) {
    const b = Math.min(n, a + f);
    const taps = [];
    let lo = Infinity, hi = -1;
    for (let x = a; x < b; x++) {
      const u = clamp((o + x + 0.5) * k - 0.5, 0, m - 1);
      const u0 = Math.floor(u), u1 = Math.min(m - 1, u0 + 1), fu = u - u0;
      taps.push(u0, 1 - fu, u1, fu);
      if (u0 < lo) lo = u0;
      if (u1 > hi) hi = u1;
    }
    const w = new Float64Array(hi - lo + 1);
    for (let t = 0; t < taps.length; t += 2) w[taps[t] - lo] += taps[t + 1] / (b - a);
    out.push({ start: lo, w });
  }
  return out;
}
