// Outline: a magnetic lasso for a finger. Pure, no DOM, deterministic.
//
// The finger drags a rough loop around something; the path clings to the
// nearest strong edge within `snapRadius` as it goes (Mortensen & Barrett,
// "Intelligent scissors", 1995: Dijkstra over a per-pixel cost where edges are
// cheap). Anchors are dropped every `anchorSpacing` px along the snapped path;
// between anchors the path is fixed, and the "live" tail from the last anchor
// to the finger is recomputed on every move inside a small corridor, so a move
// costs well under a millisecond. On lift the loop closes along edges too.
//
// Spaces. The cost map is built from the cropped output at a reduced analysis
// size (the caller downsamples: ed.readOutput({ maxSide: 1024, tone: false })),
// so every lasso coordinate is an ANALYSIS px: output px × (analysisW / outputW).
// Pixel (i, j) covers [i, i+1) × [j, j+1); path and polygon vertices sit on
// pixel centres (i + 0.5). To land on source pixels after crop/rotate/flip,
// map the polygon with transformPolygon(poly, multiply(outputToSource(crop, W, H),
// [1/k, 0, 0, 1/k, 0, 0])) where k = analysisW / outputW (lib/geometry.js).
//
// Integration (lib/remove-plan.js, lib/inpaint.js):
//   const polyS = transformPolygon(poly, analysisToSource);     // source px
//   const box = polygonBounds(polyS, 1, { width: W, height: H, pad: DILATE_PX });
//   const boxMask = polygonMask(polyS, { ...box, x: box.x, y: box.y, feather: 0, grow: DILATE_PX });
//   const win = planRemoval(box, W, H);                           // or rubWindow
// polygonBounds returns planRemoval's { x, y, width, height }; polygonMask over
// any rect/scale stands in for strokeMaskFast (0..255, non-zero = selected).
// The polygon is a few hundred numbers after simplification: store
// polygonRecord(poly) in the fill's pool entry and bring it back with
// revivePolygon(), the way remove-plan's recipeRecord/reviveRecipe do.

// Local cost weights (sum to 1): gradient magnitude, Laplacian zero crossing,
// gradient direction (on the link). Mortensen-Barrett use 0.14/0.43/0.43, which
// suits a mouse on clean scans; a finger on a phone photo wants magnitude to
// dominate so the path takes the strong edge rather than a faint parallel one.
const WG = 0.6, WZ = 0.25, WD = 0.15;
// Pull toward the finger's chord, up to this per px at `snapRadius` from it: in
// a flat area the path follows the finger instead of some arbitrary corner of
// the corridor, and a weak edge far from the finger doesn't win over nothing.
const WB = 0.2;
// Endpoint snap: a pixel `snapRadius` away must be this much cheaper than the
// one under the finger to take the live segment there.
const LAMBDA = 0.5;
// Gradient magnitudes are normalised by a high percentile; this floor stops a
// flat photo's noise from being stretched into "edges" (≈ a 30/255 step).
const G_FLOOR = 0.06;
const G_PERCENTILE = 0.995;
// A zero crossing only counts on an edge at least this strong (a share of
// gmax, and a multiple of the noise), else noise in a smooth sky would be a
// lattice of cheap pixels.
const ZC_MIN = 0.15;
const ZC_NOISE = 3;
const NOISE_MEDIANS = 2; // gradient taken as noise: this many median magnitudes
// Both sides of a crossing are marked when the smaller |Laplacian| is at least
// this share of the larger.
const ZC_RATIO = 1 / 1.5;
const L_EPS = 1e-3; // |Laplacian| below this is zero, not a sign
// Finger samples kept per live segment for the bias polyline (decimated past it).
const GUIDE_MAX = 64;
export const SIMPLIFY_EPS = 0.75;

const DX = [1, -1, 0, 0, 1, -1, 1, -1];
const DY = [0, 0, 1, -1, 1, 1, -1, -1];
const SQRT2 = Math.SQRT2;
const LEN = [1, 1, 1, 1, SQRT2, SQRT2, SQRT2, SQRT2];
// Unit link vectors for the direction term.
const LX = DX.map((d, k) => d / LEN[k]);
const LY = DY.map((d, k) => d / LEN[k]);
// acos by table (dot products are quantised to 1/127 anyway). The index is
// (v + 1) * 256 rounded; the table runs a little past ±1 because two rounded
// Int8 tangents can dot to 1.004.
const ACOS = new Float32Array(520);
for (let i = 0; i < 520; i++) ACOS[i] = Math.acos(Math.max(-1, Math.min(1, i / 256 - 1)));
const acosT = (v) => ACOS[(v * 256 + 256.5) | 0];
const D_SCALE = 2 / (3 * Math.PI);

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ------------------------------------------------------------------ cost map

// { width, height, cost: Float32Array (0 = strong edge … 1 = flat), tx, ty:
// Int8Array edge tangents (×127), gmax }. RGBA rows, top first.
export function buildCostMap({ data, width: w, height: h }) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 3 || h < 3) throw new RangeError(`bad size ${w}x${h}`);
  if (!data || data.length < w * h * 4) throw new RangeError('short image data');
  const n = w * h;
  const lum = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) lum[i] = (0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2]) / 255;

  // Sobel on the raw luma, so a step edge stays two pixels wide; a pre-blur
  // would spread it into a plateau the path could wander across. Borders
  // replicate the edge pixel, so an object touching the frame still has one.
  const mag = new Float32Array(n), tx = new Int8Array(n), ty = new Int8Array(n);
  const hist = new Uint32Array(1024);
  const sobel = (i, a, b, c, d, f, g, k, l) => {
    const gx = (c + 2 * f + l - a - 2 * d - g) / 8;
    const gy = (g + 2 * k + l - a - 2 * b - c) / 8;
    const m = Math.sqrt(gx * gx + gy * gy);
    mag[i] = m;
    hist[m >= 1 ? 1023 : (m * 1024) | 0]++;
    if (m > 1e-6) {
      // The edge runs perpendicular to the gradient; (v + ±0.5) | 0 rounds.
      const s = 127 / m, ux = gy * s, uy = -gx * s;
      tx[i] = (ux + (ux < 0 ? -0.5 : 0.5)) | 0;
      ty[i] = (uy + (uy < 0 ? -0.5 : 0.5)) | 0;
    }
  };
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1, i = y * w + 1; x < w - 1; x++, i++) {
      sobel(i, lum[i - w - 1], lum[i - w], lum[i - w + 1], lum[i - 1], lum[i + 1], lum[i + w - 1], lum[i + w], lum[i + w + 1]);
    }
  }
  const border = (x, y) => {
    const xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : w - 1;
    const ym = (y > 0 ? y - 1 : 0) * w, yp = (y < h - 1 ? y + 1 : h - 1) * w, y0 = y * w;
    sobel(y0 + x, lum[ym + xm], lum[ym + x], lum[ym + xp], lum[y0 + xm], lum[y0 + xp], lum[yp + xm], lum[yp + x], lum[yp + xp]);
  };
  for (let x = 0; x < w; x++) { border(x, 0); border(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { border(0, y); border(w - 1, y); }
  // Normalise by a high percentile rather than the maximum: one specular glint
  // must not make every real edge look weak.
  const percentile = (q) => {
    let acc = 0, bin = 0;
    const want = n * q;
    while (bin < 1023 && acc + hist[bin] < want) acc += hist[bin++];
    return (bin + 1) / 1024;
  };
  const gmax = Math.max(G_FLOOR, percentile(G_PERCENTILE));
  // The median gradient is the photo's noise and grain, not an edge: take it
  // off, so a flat sky costs the same everywhere instead of dipping at every
  // speck the finger passes.
  const noise = NOISE_MEDIANS * percentile(0.5);
  const gspan = Math.max(gmax - noise, 0.5 * gmax);

  // Laplacian zero crossings on a lightly blurred luma, marked on both pixels
  // straddling the crossing when their Laplacians are alike (a crisp edge):
  // marking one side only made the mark flip sides with the noise, and the
  // path hop after it. Gated by gradient strength: see ZC_MIN.
  const sm = blur3(lum, w, h);
  const lap = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = sm[i - w] + sm[i + w] + sm[i - 1] + sm[i + 1] - 4 * sm[i];
      lap[i] = Math.abs(v) < L_EPS ? 0 : v;
    }
  }
  const zmin = Math.max(ZC_MIN * gmax, 0.5 * G_FLOOR, ZC_NOISE * noise);
  const cost = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let zc = false;
      if (mag[i] >= zmin && y > 0 && y < h - 1 && x > 0 && x < w - 1) {
        const v = lap[i];
        if (v !== 0) {
          const lim = ZC_RATIO * Math.abs(v);
          const r = lap[i + 1], l = lap[i - 1], dn = lap[i + w], up = lap[i - w];
          zc = (r !== 0 && (v < 0) !== (r < 0) && Math.abs(r) >= lim)
            || (l !== 0 && (v < 0) !== (l < 0) && Math.abs(l) >= lim)
            || (dn !== 0 && (v < 0) !== (dn < 0) && Math.abs(dn) >= lim)
            || (up !== 0 && (v < 0) !== (up < 0) && Math.abs(up) >= lim);
        }
      }
      cost[i] = WG * (1 - clamp((mag[i] - noise) / gspan, 0, 1)) + (zc ? 0 : WZ);
    }
  }
  return { width: w, height: h, cost, tx, ty, gmax, noise };
}

// Separable 1-2-1 blur with replicated borders.
function blur3(src, w, h) {
  const t = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      t[r + x] = (src[r + (x > 0 ? x - 1 : 0)] + 2 * src[r + x] + src[r + (x < w - 1 ? x + 1 : w - 1)]) / 4;
    }
  }
  for (let y = 0; y < h; y++) {
    const r = y * w, ru = (y > 0 ? y - 1 : 0) * w, rd = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) out[r + x] = (t[ru + x] + 2 * t[r + x] + t[rd + x]) / 4;
  }
  return out;
}

// ------------------------------------------------------------------ live wire

// Scratch for the corridor search, grown as needed and reused across moves so
// a drag doesn't allocate per event.
function scratch() {
  return { dist: new Float32Array(0), prev: new Int32Array(0), state: new Uint8Array(0), bias: new Float32Array(0), hk: new Float64Array(64), hv: new Int32Array(64), last: null };
}

function ensure(S, area) {
  if (S.dist.length >= area) return;
  const n = Math.max(area, S.dist.length * 2);
  S.dist = new Float32Array(n);
  S.prev = new Int32Array(n);
  S.state = new Uint8Array(n);
  S.bias = new Float32Array(n);
}

// Distance of every corridor pixel's centre from the polyline `guide` (flat
// [x, y, …], at least one point): the finger's own route since the last
// anchor, which the path is pulled toward and walled around.
function biasMap(S, c, guide) {
  const { bias } = S;
  const cw = c.w, ch = c.h;
  bias.fill(Infinity, 0, cw * ch);
  const m = guide.length;
  for (let s = 0; s + 1 < Math.max(m, 4); s += 2) {
    const ax = guide[s], ay = guide[s + 1];
    const bx = m > 2 ? guide[s + 2] : ax, by = m > 2 ? guide[s + 3] : ay;
    const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
    for (let ly = 0, i = 0; ly < ch; ly++) {
      const qy = c.y + ly + 0.5 - ay;
      for (let lx = 0; lx < cw; lx++, i++) {
        const qx = c.x + lx + 0.5 - ax;
        let t = l2 > 0 ? (qx * vx + qy * vy) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = qx - t * vx, ey = qy - t * vy;
        const d = ex * ex + ey * ey;
        if (d < bias[i]) bias[i] = d;
      }
    }
  }
  for (let i = 0, n = cw * ch; i < n; i++) bias[i] = Math.sqrt(bias[i]);
}

// Minimum-cost 8-connected path from pixel a to pixel b inside the corridor
// `c` ({ x, y, w, h }, whole px, inside the map). Only pixels in the corridor
// are read, and only those within R (plus a step) of the finger's route
// (`guide`) are entered: the search is a band along the finger, not the whole
// bounding box, which for the closing segment of a big loop is most of the
// photo. Returns whole-px coordinates [ax, ay, …, bx, by].
function wire(cm, S, ax, ay, bx, by, c, guide, R) {
  const wall = R + SQRT2;
  const { width: W, cost, tx, ty } = cm;
  const cw = c.w, ch = c.h, area = cw * ch;
  ensure(S, area);
  biasMap(S, c, guide);
  const { dist, prev, state, bias } = S;
  dist.fill(Infinity, 0, area);
  state.fill(0, 0, area);
  let hk = S.hk, hv = S.hv, hn = 0;
  const push = (key, v) => {
    if (hn === hk.length) {
      const k2 = new Float64Array(hn * 2), v2 = new Int32Array(hn * 2);
      k2.set(hk); v2.set(hv);
      S.hk = hk = k2; S.hv = hv = v2;
    }
    let i = hn++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hk[p] <= key) break;
      hk[i] = hk[p]; hv[i] = hv[p]; i = p;
    }
    hk[i] = key; hv[i] = v;
  };
  const pop = () => {
    const key = hk[--hn], v = hv[hn];
    let i = 0;
    for (;;) {
      let ch2 = 2 * i + 1;
      if (ch2 >= hn) break;
      if (ch2 + 1 < hn && hk[ch2 + 1] < hk[ch2]) ch2++;
      if (hk[ch2] >= key) break;
      hk[i] = hk[ch2]; hv[i] = hv[ch2]; i = ch2;
    }
    hk[i] = key; hv[i] = v;
  };
  const start = (ay - c.y) * cw + (ax - c.x), goal = (by - c.y) * cw + (bx - c.x);
  dist[start] = 0;
  prev[start] = -1;
  push(0, start);
  let popped = 0;
  while (hn) {
    const d = hk[0], u = hv[0];
    pop();
    if (state[u] === 2) continue; // a stale heap entry
    state[u] = 2;
    popped++;
    if (u === goal) break;
    const ux = u % cw, uy = (u - ux) / cw;
    const gi = (c.y + uy) * W + c.x + ux;
    const px = tx[gi] / 127, py = ty[gi] / 127;
    for (let k = 0; k < 8; k++) {
      const nx = ux + DX[k], ny = uy + DY[k];
      if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
      const v = ny * cw + nx;
      if (state[v] === 2) continue;
      const gx = c.x + nx, gy = c.y + ny, vi = gy * W + gx;
      // Direction (Mortensen-Barrett f_D): cheap to move along the edge's
      // tangent at both ends of the link, dear to cut across it.
      const lx = LX[k], ly = LY[k];
      const dp = px * lx + py * ly;
      const sgn = dp < 0 ? -1 : 1;
      const fd = (acosT(sgn * dp) + acosT(sgn * (tx[vi] * lx + ty[vi] * ly) / 127)) * D_SCALE;
      const away = bias[v];
      if (away > wall && v !== goal) continue;
      const nd = d + LEN[k] * (cost[vi] + WD * fd + WB * Math.min(1, away / R));
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; push(nd, v); }
    }
  }
  S.last = { x: c.x, y: c.y, w: cw, h: ch, popped };
  const rev = [];
  for (let u = goal; u >= 0; u = prev[u]) {
    const ux = u % cw;
    rev.push(c.x + ux, c.y + (u - ux) / cw);
  }
  const out = new Array(rev.length);
  for (let i = 0, j = rev.length - 2; j >= 0; i += 2, j -= 2) { out[i] = rev[j]; out[i + 1] = rev[j + 1]; }
  return out;
}

// The cheapest pixel whose centre is within R of the finger (fx, fy), with a
// pull toward the finger so nearly uniform costs leave it where the finger is.
// Reads only the corridor, which holds the disc by construction.
function snap(cm, fx, fy, c, R) {
  const { width: W, cost } = cm;
  const x0 = Math.max(c.x, Math.floor(fx - R)), x1 = Math.min(c.x + c.w - 1, Math.ceil(fx + R));
  const y0 = Math.max(c.y, Math.floor(fy - R)), y1 = Math.min(c.y + c.h - 1, Math.ceil(fy + R));
  const r2 = R * R;
  let best = Infinity, bx = Math.min(c.x + c.w - 1, Math.max(c.x, Math.floor(fx))), by = Math.min(c.y + c.h - 1, Math.max(c.y, Math.floor(fy)));
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - fy;
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - fx, d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const s = cost[y * W + x] + (LAMBDA * Math.sqrt(d2)) / R;
      if (s < best) { best = s; bx = x; by = y; }
    }
  }
  return [bx, by];
}

// { begin(p), move(p), end() -> Float32Array polygon, cancel(), path() ->
// Float32Array polyline so far, active, lastSearch() } with p = { x, y } in
// cost-map px. Points off the map are clamped onto it.
export function createLasso(cm, { snapRadius = 20, anchorSpacing = 24 } = {}) {
  const { width: W, height: H } = cm;
  const R = Number.isFinite(snapRadius) ? clamp(snapRadius, 1, 512) : 20;
  const spacing = Number.isFinite(anchorSpacing) ? Math.max(2, anchorSpacing) : 24;
  const S = scratch();
  let committed = null; // pixel centres, first anchor first
  let live = null; // pixel centres from the last anchor (inclusive) to the live end
  let anchor = null; // [ix, iy] whole px
  let first = null;
  let guide = null; // finger samples since the last anchor dropped

  const clampPt = (p) => [clamp(Number(p?.x) || 0, 0, W - 1e-3), clamp(Number(p?.y) || 0, 0, H - 1e-3)];
  // The box around both points grown by R, kept on the map.
  const corridorOf = (ax, ay, bx, by) => {
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - R)), y0 = Math.max(0, Math.floor(Math.min(ay, by) - R));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + R)), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + R));
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  };
  const centres = (pts, from = 0) => {
    const out = [];
    for (let i = from; i < pts.length; i++) out.push(pts[i] + 0.5);
    return out;
  };

  // Remember where the finger went since the last anchor: the live wire is
  // pulled toward that route, so with no edge to follow it follows the finger.
  function sample(fx, fy) {
    const m = guide.length;
    if (m && Math.hypot(fx - guide[m - 2], fy - guide[m - 1]) < 1) { guide[m - 2] = fx; guide[m - 1] = fy; return; }
    guide.push(fx, fy);
    if (guide.length > 2 * GUIDE_MAX) {
      const kept = [];
      for (let i = 0; i < guide.length - 2; i += 4) kept.push(guide[i], guide[i + 1]);
      kept.push(fx, fy);
      guide = kept;
    }
  }

  // The live wire from the anchor to the finger; anchors drop every `spacing`
  // px along it, and the rest stays live.
  function trace(fx, fy, target = null) {
    const c = corridorOf(anchor[0] + 0.5, anchor[1] + 0.5, fx, fy);
    const [ex, ey] = target ?? snap(cm, fx, fy, c, R);
    const pts = wire(cm, S, anchor[0], anchor[1], ex, ey, c, [anchor[0] + 0.5, anchor[1] + 0.5, ...guide], R);
    let len = 0, cut = 0;
    for (let i = 2; i < pts.length; i += 2) {
      len += pts[i] !== pts[i - 2] && pts[i + 1] !== pts[i - 1] ? SQRT2 : 1;
      if (len >= spacing) {
        for (let j = cut + 2; j <= i + 1; j++) committed.push(pts[j] + 0.5);
        cut = i;
        len = 0;
      }
    }
    if (cut) guide = [fx, fy];
    anchor = [pts[cut], pts[cut + 1]];
    live = centres(pts, cut);
  }

  return {
    get active() { return committed !== null; },
    lastSearch() { return S.last; },
    begin(p) {
      const [fx, fy] = clampPt(p);
      const [ix, iy] = snap(cm, fx, fy, corridorOf(fx, fy, fx, fy), R);
      anchor = [ix, iy];
      first = [ix, iy];
      committed = [ix + 0.5, iy + 0.5];
      live = [ix + 0.5, iy + 0.5];
      guide = [];
    },
    move(p) {
      if (!committed) return;
      const [fx, fy] = clampPt(p);
      sample(fx, fy);
      trace(fx, fy);
    },
    cancel() {
      committed = live = anchor = first = guide = null;
    },
    path() {
      if (!committed) return new Float32Array(0);
      const out = new Float32Array(committed.length + live.length - 2);
      out.set(committed);
      for (let i = 2; i < live.length; i++) out[committed.length + i - 2] = live[i];
      return out;
    },
    // Close the loop back to the first point along edges; the polygon (pixel
    // centres, simplified) is implicitly closed.
    end() {
      if (!committed) return null;
      for (let i = 2; i < live.length; i++) committed.push(live[i]);
      anchor = [live[live.length - 2] - 0.5, live[live.length - 1] - 0.5];
      if (anchor[0] !== first[0] || anchor[1] !== first[1]) {
        live = null;
        guide = [first[0] + 0.5, first[1] + 0.5]; // straight home, along edges
        trace(first[0] + 0.5, first[1] + 0.5, first);
        // committed now ends on the anchor; the live tail ends on `first`,
        // which is already the polygon's start.
        for (let i = 2; i < live.length - 2; i++) committed.push(live[i]);
      }
      const poly = simplifyPolygon(committed, SIMPLIFY_EPS);
      this.cancel();
      return poly;
    },
  };
}

// ------------------------------------------------------------------ polygons

// Douglas-Peucker on a closed polygon (flat [x, y, …]): split at the vertex
// farthest from the first, simplify both chains. Keeps the first vertex.
export function simplifyPolygon(poly, eps = SIMPLIFY_EPS) {
  const n = poly.length >> 1;
  if (n < 4 || !(eps > 0)) return Float32Array.from(poly.length % 2 ? Array.prototype.slice.call(poly, 0, n * 2) : poly);
  let k = 1, far = -1;
  for (let i = 1; i < n; i++) {
    const d = (poly[2 * i] - poly[0]) ** 2 + (poly[2 * i + 1] - poly[1]) ** 2;
    if (d > far) { far = d; k = i; }
  }
  const keep = new Uint8Array(n + 1);
  keep[0] = keep[k] = 1;
  const at = (i) => (i === n ? 0 : i); // the second chain wraps to the start
  const stack = [[0, k], [k, n]];
  const e2 = eps * eps;
  while (stack.length) {
    const [i0, i1] = stack.pop();
    if (i1 - i0 < 2) continue;
    const ax = poly[2 * at(i0)], ay = poly[2 * at(i0) + 1], bx = poly[2 * at(i1)], by = poly[2 * at(i1) + 1];
    const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
    let best = -1, bi = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const qx = poly[2 * i] - ax, qy = poly[2 * i + 1] - ay;
      let d;
      if (l2 > 0) {
        const t = Math.max(0, Math.min(1, (qx * vx + qy * vy) / l2));
        d = (qx - t * vx) ** 2 + (qy - t * vy) ** 2;
      } else d = qx * qx + qy * qy;
      if (d > best) { best = d; bi = i; }
    }
    if (best > e2) { keep[bi] = 1; stack.push([i0, bi], [bi, i1]); }
  }
  let m = 0;
  for (let i = 0; i < n; i++) m += keep[i];
  const out = new Float32Array(2 * m);
  for (let i = 0, j = 0; i < n; i++) if (keep[i]) { out[j++] = poly[2 * i]; out[j++] = poly[2 * i + 1]; }
  return out;
}

// Vertices through a 2x3 matrix [a, b, c, d, e, f] as lib/geometry.js apply().
export function transformPolygon(poly, m) {
  const out = new Float32Array(poly.length & ~1);
  for (let i = 0; i + 1 < poly.length; i += 2) {
    out[i] = m[0] * poly[i] + m[2] * poly[i + 1] + m[4];
    out[i + 1] = m[1] * poly[i] + m[3] * poly[i + 1] + m[5];
  }
  return out;
}

export function scalePolygon(poly, s) {
  return transformPolygon(poly, [s, 0, 0, s, 0, 0]);
}

// Shoelace area in polygon units² (× scale² for another space).
export function polygonArea(poly) {
  const n = poly.length >> 1;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += poly[2 * j] * poly[2 * i + 1] - poly[2 * i] * poly[2 * j + 1];
  return Math.abs(a) / 2;
}

// Whole-px box of the polygon scaled by `scale`, grown by `pad`, clipped to
// width x height: planRemoval's { x, y, width, height }, or null off the image.
export function polygonBounds(poly, scale = 1, { width = Infinity, height = Infinity, pad = 0 } = {}) {
  if (!poly || poly.length < 2) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 1 < poly.length; i += 2) {
    const x = poly[i] * scale, y = poly[i + 1] * scale;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x0 === Infinity) return null;
  const ax = Math.max(0, Math.floor(x0 - pad)), ay = Math.max(0, Math.floor(y0 - pad));
  const bx = Math.min(width, Math.max(Math.ceil(x1 + pad), Math.floor(x1) + 1)), by = Math.min(height, Math.max(Math.ceil(y1 + pad), Math.floor(y1) + 1));
  return bx > ax && by > ay ? { x: ax, y: ay, width: bx - ax, height: by - ay } : null;
}

// Uint8Array mask (0..255) over a width x height rect whose origin is (x, y) in
// scaled px: polygon vertex P lands at P * scale - (x, y). Even-odd fill at
// pixel centres; the edge is a `feather`-wide ramp (0 = hard), and `grow` moves
// it outward by that many px (a fill wants an object's soft fringe too).
export function polygonMask(poly, { width, height, scale = 1, feather = 1.5, x = 0, y = 0, grow = 0 } = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) throw new RangeError(`bad size ${width}x${height}`);
  const mask = new Uint8Array(width * height);
  const n = (poly?.length ?? 0) >> 1;
  if (n < 3 || !width || !height) return mask;
  const px = new Float64Array(n), py = new Float64Array(n);
  for (let i = 0; i < n; i++) { px[i] = poly[2 * i] * scale - x; py[i] = poly[2 * i + 1] * scale - y; }
  const f = feather > 0 ? feather : 0, g = Number.isFinite(grow) ? grow : 0;
  const band = Math.max(0, g) + f / 2 + 1; // every pixel centre this close to an edge gets a distance
  const inside = new Uint8Array(width), rowD = new Float32Array(width);
  const xs = [];
  for (let r = 0; r < height; r++) {
    const yc = r + 0.5;
    inside.fill(0);
    rowD.fill(Infinity);
    xs.length = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = px[j], ay = py[j], bx = px[i], by = py[i];
      if ((ay <= yc) !== (by <= yc)) xs.push(ax + ((yc - ay) * (bx - ax)) / (by - ay));
      const lo = Math.min(ay, by), hi = Math.max(ay, by);
      if (yc < lo - band || yc > hi + band) continue;
      // The part of the edge within `band` rows of this one, then the pixels
      // within `band` of it sideways.
      const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
      let t0 = 0, t1 = 1;
      if (vy !== 0) {
        const ta = (yc - band - ay) / vy, tb = (yc + band - ay) / vy;
        t0 = Math.max(0, Math.min(ta, tb)); t1 = Math.min(1, Math.max(ta, tb));
      }
      const ex0 = ax + t0 * vx, ex1 = ax + t1 * vx;
      const xa = Math.max(0, Math.floor(Math.min(ex0, ex1) - band)), xb = Math.min(width - 1, Math.ceil(Math.max(ex0, ex1) + band));
      for (let c = xa; c <= xb; c++) {
        const qx = c + 0.5 - ax, qy = yc - ay;
        let t = l2 > 0 ? (qx * vx + qy * vy) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.sqrt((qx - t * vx) ** 2 + (qy - t * vy) ** 2);
        if (d < rowD[c]) rowD[c] = d;
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(xs[k] - 0.5)), c1 = Math.min(width, Math.ceil(xs[k + 1] - 0.5));
      if (c1 > c0) inside.fill(1, c0, c1);
    }
    const row = r * width;
    for (let c = 0; c < width; c++) {
      const dd = rowD[c];
      if (dd > band) { mask[row + c] = inside[c] ? 255 : 0; continue; }
      const d = (inside[c] ? dd : -dd) + g;
      mask[row + c] = f > 0 ? Math.round(255 * clamp(0.5 + d / f, 0, 1)) : (inside[c] ? d >= 0 : d > 0) ? 255 : 0;
    }
  }
  return mask;
}

// A polygon as plain numbers (0.1 px) for a pool entry, and back; null when the
// stored thing isn't a usable polygon (an older draft, damage).
export function polygonRecord(poly) {
  const out = [];
  for (let i = 0; i + 1 < (poly?.length ?? 0); i += 2) {
    if (Number.isFinite(poly[i]) && Number.isFinite(poly[i + 1])) out.push(Math.round(poly[i] * 10) / 10, Math.round(poly[i + 1] * 10) / 10);
  }
  return out;
}

export function revivePolygon(json) {
  if (!Array.isArray(json) || json.length < 6 || json.length % 2 || json.length > 1 << 20) return null;
  if (!json.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  return Float32Array.from(json);
}
