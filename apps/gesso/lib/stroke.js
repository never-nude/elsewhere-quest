// Brush strokes as points placed by distance, never per input event.
//
// iPhone pointer events arrive at whatever rate the finger and the coalescing
// give us: a slow drag sends dozens of events per pixel, a fast flick one event
// per 40 px. Painting a dab per event would make density depend on speed, so
// every consumer (the paint mask, Remove's rub mask, the GPU's dab pass) goes
// through these helpers and gets the same spacing at any speed.
//
// Pure: no DOM. Points are flat [x0, y0, x1, y1, ...] arrays in source pixels.
// Pairs with a non-finite coordinate (and a dangling odd value) are dropped, so a
// single bad event can't poison a whole stroke.

// Below a quarter pixel extra points buy nothing visible, and a tiny spacing on a
// long stroke would allocate millions of points.
export const MIN_SPACING = 0.25;
// resample() and dabs() never return more points than this, however absurd the
// input: a corrupt stored stroke with one coordinate at 1e12 must not take the
// editor down when it is replayed.
export const MAX_POINTS = 1 << 20;

export function cleanPoints(points) {
  const out = [];
  if (!points) return out;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = points[i], y = points[i + 1];
    if (Number.isFinite(x) && Number.isFinite(y)) out.push(x, y);
  }
  return out;
}

// Points every `spacing` (at most) along the polyline. The length is split into
// equal steps so both end points are kept exactly and every gap is the same.
export function resample(points, spacing) {
  if (!(spacing > 0) || !Number.isFinite(spacing)) throw new RangeError(`bad spacing ${spacing}`);
  const step0 = Math.max(MIN_SPACING, spacing);
  const pts = cleanPoints(points);
  const m = pts.length / 2;
  if (m <= 1) return pts;
  const cum = new Float64Array(m);
  for (let i = 1; i < m; i++) {
    cum[i] = cum[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
  }
  const total = cum[m - 1];
  if (total === 0) return [pts[0], pts[1]];
  // Finite coordinates near ±1e308 can still overflow the length: such a path
  // can't be measured, so keep only its ends rather than emit NaN points.
  if (!Number.isFinite(total)) return [pts[0], pts[1], pts[2 * m - 2], pts[2 * m - 1]];
  // The epsilon keeps an exact multiple (10 / 2.5) from gaining a needless step.
  const n = Math.min(MAX_POINTS - 1, Math.max(1, Math.ceil(total / step0 - 1e-9)));
  const step = total / n;
  const out = [pts[0], pts[1]];
  let seg = 0;
  for (let k = 1; k < n; k++) {
    const t = k * step;
    while (seg < m - 2 && cum[seg + 1] < t) seg++;
    const len = cum[seg + 1] - cum[seg];
    const f = len > 0 ? (t - cum[seg]) / len : 0;
    out.push(
      pts[2 * seg] + (pts[2 * seg + 2] - pts[2 * seg]) * f,
      pts[2 * seg + 1] + (pts[2 * seg + 3] - pts[2 * seg + 1]) * f,
    );
  }
  out.push(pts[2 * m - 2], pts[2 * m - 1]);
  return out;
}

// One light Laplacian pass: each interior point moves `amount` (0..1) of the way
// to the midpoint of its neighbours. Takes the jitter out of a finger without
// shortening the stroke: the end points never move.
export function smooth(points, amount) {
  const pts = cleanPoints(points);
  const a = Number.isFinite(amount) ? Math.min(1, Math.max(0, amount)) : 0;
  const m = pts.length / 2;
  if (m < 3 || a === 0) return pts;
  const out = pts.slice();
  for (let i = 1; i < m - 1; i++) {
    for (let c = 0; c < 2; c++) {
      const p = pts[2 * i + c];
      out[2 * i + c] = p + a * ((pts[2 * i - 2 + c] + pts[2 * i + 2 + c]) / 2 - p);
    }
  }
  return out;
}

// Dab centres every `radius * spacingRatio` of travel, starting on the first point.
// Prefix-stable: the dabs of a stroke's first k points are exactly the first dabs
// of the whole stroke, so a live stroke can paint only its new dabs as it grows
// and still match a replay of the finished stroke bit for bit. (That is why the
// last point isn't forced in: a lift lands at most one spacing past the last dab,
// well inside its radius.) A brush with no size leaves no dabs. At most
// MAX_POINTS dabs (the cap keeps prefix stability: it only ever cuts the tail).
export function dabs(points, radius, spacingRatio = 0.25) {
  if (!(spacingRatio > 0) || !Number.isFinite(spacingRatio)) throw new RangeError(`bad spacingRatio ${spacingRatio}`);
  if (!(radius > 0) || !Number.isFinite(radius)) return [];
  const step = Math.min(Number.MAX_VALUE, Math.max(MIN_SPACING, radius * spacingRatio));
  const pts = cleanPoints(points);
  if (!pts.length) return [];
  const out = [pts[0], pts[1]];
  const cap = 2 * MAX_POINTS;
  let travelled = 0; // since the last dab
  for (let i = 2; i < pts.length && out.length < cap; i += 2) {
    const ax = pts[i - 2], ay = pts[i - 1], bx = pts[i], by = pts[i + 1];
    const len = Math.hypot(bx - ax, by - ay);
    // A segment too long to measure (coordinates near ±1e308) gets no dabs.
    if (len === 0 || !Number.isFinite(len)) continue;
    let t = step - travelled;
    while (t <= len && out.length < cap) {
      // Fraction first: (bx - ax) * t can overflow where the dab itself can't.
      const f = t / len;
      out.push(ax + (bx - ax) * f, ay + (by - ay) * f);
      t += step;
    }
    travelled = len - (t - step);
  }
  return out;
}

// Whole-pixel box covering every disc of `radius` along the stroke, for the
// Remove size cap and patch bounding boxes. Not clipped to the image.
export function strokeBounds(points, radius) {
  const pts = cleanPoints(points);
  if (!pts.length) return null;
  const r = Number.isFinite(radius) && radius > 0 ? radius : 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < x0) x0 = pts[i];
    if (pts[i] > x1) x1 = pts[i];
    if (pts[i + 1] < y0) y0 = pts[i + 1];
    if (pts[i + 1] > y1) y1 = pts[i + 1];
  }
  const x = Math.floor(x0 - r), y = Math.floor(y0 - r);
  // max(…, floor + 1) so every point, even with zero radius, owns the pixel it
  // sits in: ceil alone drops it when the far point lands on a whole number.
  const w = Math.max(Math.ceil(x1 + r), Math.floor(x1) + 1) - x;
  const h = Math.max(Math.ceil(y1 + r), Math.floor(y1) + 1) - y;
  return { x, y, w, h };
}
