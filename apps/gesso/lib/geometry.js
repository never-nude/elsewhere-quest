// Crop, straighten, rotate and flip — pure geometry, no DOM.
//
// Spaces:
//   source    the working image, W x H pixels, origin top-left.
//   oriented  source after quarter turns (`quarter`, clockwise 0..3) and an optional
//             horizontal mirror (`flip`, applied after turning). Size W' x H'.
//   frame     oriented space rotated by `angle` degrees (clockwise, the straighten
//             angle) about the oriented image's centre, with the origin at that
//             centre. The crop rectangle lives here, axis-aligned.
//   output    the cropped result: rect.width x rect.height pixels, origin top-left.
//
// Matrices are 2D affine [a, b, c, d, e, f] meaning x' = a*x + c*y + e,
// y' = b*x + d*y + f (the same order as CanvasRenderingContext2D.setTransform).

export const MAX_STRAIGHTEN = 45;

const DEG = Math.PI / 180;

export function orientedSize(width, height, quarter = 0) {
  return quarter % 2 === 0 ? { width, height } : { width: height, height: width };
}

// The rect fits iff all four corners, rotated back by -angle, land inside the
// oriented image. `slack` absorbs float error so a rect computed to fit exactly
// is accepted.
export function rectFits(rect, width, height, angle, slack = 1e-6) {
  const c = Math.cos(angle * DEG), s = Math.sin(angle * DEG);
  const hw = width / 2 + slack, hh = height / 2 + slack;
  const xs = [rect.x, rect.x + rect.width];
  const ys = [rect.y, rect.y + rect.height];
  for (const x of xs) {
    for (const y of ys) {
      // Inverse rotation (frame -> oriented) is rotation by -angle.
      const ox = x * c + y * s;
      const oy = -x * s + y * c;
      if (Math.abs(ox) > hw || Math.abs(oy) > hh) return false;
    }
  }
  return true;
}

// Largest centred rect with the given aspect (width / height) inside a width x height
// image rotated by `angle`. With no aspect, keeps the image's own.
export function maxCenteredRect(width, height, angle, aspect = width / height) {
  const c = Math.abs(Math.cos(angle * DEG)), s = Math.abs(Math.sin(angle * DEG));
  const w = Math.min(width / (c + s / aspect), height / (s + c / aspect));
  const h = w / aspect;
  return { x: -w / 2, y: -h / 2, width: w, height: h };
}

export const ASPECTS = {
  free: null,
  original: 'original',
  square: 1,
  '4:5': 4 / 5,
  '5:4': 5 / 4,
  '3:4': 3 / 4,
  '4:3': 4 / 3,
  '2:3': 2 / 3,
  '3:2': 3 / 2,
  '9:16': 9 / 16,
  '16:9': 16 / 9,
};

// Resolve an aspect key into a number (or null for free) for a given oriented image.
export function aspectValue(key, orientedWidth, orientedHeight) {
  const v = ASPECTS[key];
  if (v === undefined) throw new Error(`unknown aspect ${key}`);
  if (v === 'original') return orientedWidth / orientedHeight;
  return v;
}

export function initialCrop(width, height) {
  const o = orientedSize(width, height, 0);
  return {
    quarter: 0,
    flip: false,
    angle: 0,
    aspect: 'free',
    rect: { x: -o.width / 2, y: -o.height / 2, width: o.width, height: o.height },
  };
}

export function isIdentityCrop(crop, width, height) {
  const r = crop.rect;
  return crop.quarter === 0 && !crop.flip && crop.angle === 0 &&
    Math.abs(r.x + width / 2) < 0.5 && Math.abs(r.y + height / 2) < 0.5 &&
    Math.abs(r.width - width) < 0.5 && Math.abs(r.height - height) < 0.5;
}

// Fit the largest rect of `aspect` (null = keep current rect's) that is centred on
// the current rect's centre where possible, else on the image centre.
export function fitRect(crop, width, height, aspect) {
  const o = orientedSize(width, height, crop.quarter);
  const a = aspect ?? crop.rect.width / crop.rect.height;
  const best = maxCenteredRect(o.width, o.height, crop.angle, a);
  // Try to keep the user's framing: centre on their rect if it still fits.
  const cx = crop.rect.x + crop.rect.width / 2, cy = crop.rect.y + crop.rect.height / 2;
  const moved = { ...best, x: cx - best.width / 2, y: cy - best.height / 2 };
  if (rectFits(moved, o.width, o.height, crop.angle)) return moved;
  return translateToFit(moved, best, o.width, o.height, crop.angle);
}

export function setAspect(crop, width, height, key) {
  const o = orientedSize(width, height, crop.quarter);
  const a = aspectValue(key, o.width, o.height);
  const next = { ...crop, aspect: key };
  if (a === null) return next;
  return { ...next, rect: fitRect(crop, width, height, a) };
}

// Straighten: like iOS Photos, the crop keeps its centre and aspect and shrinks just
// enough that no empty corner shows. Angles clamp to ±MAX_STRAIGHTEN.
export function setAngle(crop, width, height, angle) {
  const a = Math.max(-MAX_STRAIGHTEN, Math.min(MAX_STRAIGHTEN, angle));
  const o = orientedSize(width, height, crop.quarter);
  const aspect = crop.rect.width / crop.rect.height;
  const cx = crop.rect.x + crop.rect.width / 2, cy = crop.rect.y + crop.rect.height / 2;
  // Start from the largest rect of this aspect, but never grow past the user's
  // current crop when they've tightened it.
  const max = maxCenteredRect(o.width, o.height, a, aspect);
  const unrotatedMax = maxCenteredRect(o.width, o.height, crop.angle, aspect);
  const userScale = Math.min(1, crop.rect.width / unrotatedMax.width);
  let w = max.width * userScale, h = max.height * userScale;
  let rect = { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
  if (!rectFits(rect, o.width, o.height, a)) {
    const centred = { x: -w / 2, y: -h / 2, width: w, height: h };
    rect = translateToFit(rect, centred, o.width, o.height, a);
  }
  return { ...crop, angle: a, rect };
}

// Quarter turn as seen on screen — clockwise, or counter-clockwise with { ccw }
// (the Rotate button, like iOS Photos). The crop rect and straighten angle turn
// with the image (2D rotations commute, so the angle is unchanged).
export function rotateQuarter(crop, width, height, { ccw = false } = {}) {
  const r = crop.rect;
  // 90° clockwise (y down) maps (x, y) -> (-y, x); counter-clockwise (x, y) -> (y, -x).
  const rect = ccw
    ? { x: r.y, y: -(r.x + r.width), width: r.height, height: r.width }
    : { x: -(r.y + r.height), y: r.x, width: r.height, height: r.width };
  // A mirror reverses the sense of rotation in source space: F·R(90) = R(-90)·F.
  const step = (ccw ? 3 : 1) * (crop.flip ? 3 : 1);
  const quarter = (crop.quarter + step) % 4;
  const next = { ...crop, quarter, aspect: flipAspectKey(crop.aspect), rect };
  return { ...next, ...fixFit(next, width, height) };
}

// Tall/Wide: turn a fixed-ratio frame on its side (4:5 <-> 5:4, 16:9 <-> 9:16),
// refitting the largest frame of the new shape. Free and square are unchanged.
export function toggleTall(crop, width, height) {
  const key = flipAspectKey(crop.aspect);
  if (key === crop.aspect) return crop;
  return setAspect(crop, width, height, key);
}

export function isTall(crop) {
  return crop.rect.height > crop.rect.width;
}

function fixFit(crop, width, height) {
  const o = orientedSize(width, height, crop.quarter);
  if (rectFits(crop.rect, o.width, o.height, crop.angle)) return {};
  return { rect: fitRect(crop, width, height, null) };
}

function flipAspectKey(key) {
  if (key === 'free' || key === 'original' || key === 'square') return key;
  const [a, b] = key.split(':');
  const swapped = `${b}:${a}`;
  return swapped in ASPECTS ? swapped : key;
}

// Mirror left-right in the current view: the frame flips, the straighten angle
// negates, and the crop rect mirrors about the centre.
export function flipHorizontal(crop) {
  const r = crop.rect;
  return { ...crop, flip: !crop.flip, angle: crop.angle === 0 ? 0 : -crop.angle, rect: { ...r, x: -(r.x + r.width) } };
}

// Move a rect by (dx, dy) as far as it can go toward the target while still fitting.
export function moveRect(crop, width, height, dx, dy) {
  const o = orientedSize(width, height, crop.quarter);
  const to = { ...crop.rect, x: crop.rect.x + dx, y: crop.rect.y + dy };
  if (rectFits(to, o.width, o.height, crop.angle)) return { ...crop, rect: to };
  // Slide along each axis separately so the frame glides along an edge.
  let rect = crop.rect;
  const tx = { ...rect, x: rect.x + dx };
  rect = rectFits(tx, o.width, o.height, crop.angle) ? tx : bisect(rect, tx, (r) => rectFits(r, o.width, o.height, crop.angle));
  const ty = { ...rect, y: rect.y + dy };
  rect = rectFits(ty, o.width, o.height, crop.angle) ? ty : bisect(rect, ty, (r) => rectFits(r, o.width, o.height, crop.angle));
  return { ...crop, rect };
}

// Drag a corner or edge handle. `handle` is any of 'n','s','e','w','ne','nw','se','sw'.
// With a fixed aspect the opposite corner stays pinned and the rect scales.
export const MIN_CROP = 32;

export function dragHandle(crop, width, height, handle, dx, dy) {
  const o = orientedSize(width, height, crop.quarter);
  const fits = (r) => r.width >= MIN_CROP && r.height >= MIN_CROP && rectFits(r, o.width, o.height, crop.angle);
  const aspect = aspectValue(crop.aspect, o.width, o.height);
  const target = resizeByHandle(crop.rect, handle, dx, dy, aspect);
  if (fits(target)) return { ...crop, rect: target };
  return { ...crop, rect: bisect(crop.rect, target, fits) };
}

function resizeByHandle(r, handle, dx, dy, aspect) {
  let x0 = r.x, y0 = r.y, x1 = r.x + r.width, y1 = r.y + r.height;
  if (handle.includes('w')) x0 += dx;
  if (handle.includes('e')) x1 += dx;
  if (handle.includes('n')) y0 += dy;
  if (handle.includes('s')) y1 += dy;
  if (x1 - x0 < 1) { if (handle.includes('w')) x0 = x1 - 1; else x1 = x0 + 1; }
  if (y1 - y0 < 1) { if (handle.includes('n')) y0 = y1 - 1; else y1 = y0 + 1; }
  if (!aspect) return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  // Locked aspect: decide size from the dominant change, pin the opposite side.
  let w = x1 - x0, h = y1 - y0;
  const horizontal = handle === 'e' || handle === 'w';
  const vertical = handle === 'n' || handle === 's';
  if (horizontal) h = w / aspect;
  else if (vertical) w = h * aspect;
  else if (Math.abs(dx) * r.height >= Math.abs(dy) * r.width) h = w / aspect;
  else w = h * aspect;
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  const nx = handle.includes('w') ? r.x + r.width - w : handle.includes('e') ? r.x : cx - w / 2;
  const ny = handle.includes('n') ? r.y + r.height - h : handle.includes('s') ? r.y : cy - h / 2;
  return { x: nx, y: ny, width: w, height: h };
}

// Interpolate from a known-good rect toward a target, returning the furthest
// rect along that path that passes `ok`.
function bisect(from, to, ok, steps = 24) {
  let lo = 0, hi = 1;
  const lerp = (t) => ({
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    width: from.width + (to.width - from.width) * t,
    height: from.height + (to.height - from.height) * t,
  });
  for (let i = 0; i < steps; i++) {
    const mid = (lo + hi) / 2;
    if (ok(lerp(mid))) lo = mid; else hi = mid;
  }
  return lerp(lo);
}

// Slide `rect` toward `safe` (a rect of the same size known to fit) until it fits.
function translateToFit(rect, safe, width, height, angle) {
  return bisect(safe, rect, (r) => rectFits(r, width, height, angle));
}

// ------------------------------------------------------------------ matrices

export function multiply(m, n) {
  // m ∘ n: apply n first, then m.
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) throw new Error('singular matrix');
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

// source px -> oriented px (quarter turns clockwise, then mirror).
export function sourceToOriented(width, height, quarter, flip) {
  const o = orientedSize(width, height, quarter);
  let m;
  switch (quarter % 4) {
    case 0: m = [1, 0, 0, 1, 0, 0]; break;
    case 1: m = [0, 1, -1, 0, height, 0]; break; // (x, y) -> (H - y, x)
    case 2: m = [-1, 0, 0, -1, width, height]; break;
    default: m = [0, -1, 1, 0, 0, width]; break; // (x, y) -> (y, W - x)
  }
  if (flip) m = multiply([-1, 0, 0, 1, o.width, 0], m);
  return m;
}

// output px -> source px, for sampling the source when rendering the crop.
export function outputToSource(crop, width, height) {
  const o = orientedSize(width, height, crop.quarter);
  const c = Math.cos(crop.angle * DEG), s = Math.sin(crop.angle * DEG);
  // output -> frame: shift by rect origin
  const outToFrame = [1, 0, 0, 1, crop.rect.x, crop.rect.y];
  // frame -> oriented: rotate by -angle about the centre, then move origin to top-left
  const frameToOriented = [c, -s, s, c, o.width / 2, o.height / 2];
  const orientedToSource = invert(sourceToOriented(width, height, crop.quarter, crop.flip));
  return multiply(orientedToSource, multiply(frameToOriented, outToFrame));
}

export function sourceToOutput(crop, width, height) {
  return invert(outputToSource(crop, width, height));
}

export function outputSize(crop) {
  return { width: Math.max(1, Math.round(crop.rect.width)), height: Math.max(1, Math.round(crop.rect.height)) };
}
