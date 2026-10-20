// Object removal: multi-scale PatchMatch inpainting (Wexler et al. 2007 completion,
// Barnes et al. 2009 nearest-neighbour search) — the same family of technique as
// Photoshop's Content-Aware Fill, small enough to run in a worker on a phone.
//
// Pure: no DOM. Images are { width, height, data: Uint8ClampedArray RGBA }, masks are
// Uint8Array (non-zero = remove). Only masked pixels change; the caller feathers the
// seam by compositing the result through its own soft brush mask.

const DEFAULTS = {
  patchRadius: 3, // 7x7 patches
  seed: 1,
  minLevelSide: 24, // stop building the pyramid below this
  maxLevels: 8,
  coarseEm: 8, // EM iterations on the coarsest level...
  fineEm: 3, // ...tapering to this on the finest
  searchIters: 3, // PatchMatch sweeps per EM iteration
  shiftIters: 2, // mean-shift passes per vote (0 = plain weighted mean)
  bandwidth: 24, // mean-shift colour bandwidth, 0-255 units
  finalVote: 'center', // 'center' | 'best' | 'mean': last pass at full resolution
};

// Deterministic PRNG so results (and tests) are reproducible.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function maskBounds(mask, width, height) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (mask[row + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

// Where to look for replacement texture, and at what scale. The window grows the
// hole's bounding box by `marginFactor` of its size on every side (at least
// `minMargin` px), clamped to the image. Staying local matters: searching the
// whole photo lets a large unrelated region (the table) out-vote the surface the
// object actually sits on (the saucer). If the window is bigger than `maxArea`
// pixels, run at `scale` < 1 via inpaintScaled.
export function planRemoval(bounds, imageWidth, imageHeight, opts = {}) {
  const { marginFactor = 0.75, minMargin = 40, maxArea = 600 * 600 } = opts;
  const mx = Math.max(minMargin, Math.round(bounds.width * marginFactor));
  const my = Math.max(minMargin, Math.round(bounds.height * marginFactor));
  const x = Math.max(0, bounds.x - mx);
  const y = Math.max(0, bounds.y - my);
  const width = Math.min(imageWidth, bounds.x + bounds.width + mx) - x;
  const height = Math.min(imageHeight, bounds.y + bounds.height + my) - y;
  const area = width * height;
  const scale = area > maxArea ? Math.sqrt(maxArea / area) : 1;
  return { x, y, width, height, scale };
}

// inpaint() at a reduced resolution for big selections, then upsampled back. Pixels
// outside the mask are returned untouched at full resolution.
export function inpaintScaled(image, mask, scale, options = {}) {
  if (!(scale < 1)) return inpaint(image, mask, options);
  const r = options.patchRadius ?? DEFAULTS.patchRadius;
  const { width, height } = image;
  const sw = Math.max(2 * r + 1, Math.round(width * scale));
  const sh = Math.max(2 * r + 1, Math.round(height * scale));
  const small = resizeArea(image, sw, sh);
  const smallMask = new Uint8Array(sw * sh);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / height));
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) smallMask[sy * sw + Math.min(sw - 1, Math.floor((x * sw) / width))] = 1;
    }
  }
  const filled = inpaint(small, smallMask, options);
  const out = new Uint8ClampedArray(image.data);
  for (let y = 0; y < height; y++) {
    const fy = Math.min(sh - 1, Math.max(0, ((y + 0.5) * sh) / height - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      const fx = Math.min(sw - 1, Math.max(0, ((x + 0.5) * sw) / width - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const a = filled.data[(y0 * sw + x0) * 4 + c], b = filled.data[(y0 * sw + x1) * 4 + c];
        const d = filled.data[(y1 * sw + x0) * 4 + c], e = filled.data[(y1 * sw + x1) * 4 + c];
        out[i * 4 + c] = (a + (b - a) * tx) * (1 - ty) + (d + (e - d) * tx) * ty;
      }
      out[i * 4 + 3] = 255;
    }
  }
  return { width, height, data: out };
}

// Box-filter (area-average) resize, for shrinking only.
function resizeArea(image, dw, dh) {
  const { width: sw, height: sh, data } = image;
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let dy = 0; dy < dh; dy++) {
    const y0 = Math.floor((dy * sh) / dh), y1 = Math.max(y0 + 1, Math.floor(((dy + 1) * sh) / dh));
    for (let dx = 0; dx < dw; dx++) {
      const x0 = Math.floor((dx * sw) / dw), x1 = Math.max(x0 + 1, Math.floor(((dx + 1) * sw) / dw));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * sw + x) * 4;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        }
      }
      const o = (dy * dw + dx) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { width: dw, height: dh, data: out };
}

export function inpaint(image, mask, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const { width, height } = image;
  const r = opts.patchRadius;
  if (mask.length !== width * height) throw new Error('mask size mismatch');
  if (width < 2 * r + 1 || height < 2 * r + 1) throw new Error('image smaller than one patch');

  const rand = mulberry32(opts.seed);

  // Level 0 = full resolution. Float RGB, interleaved.
  const levels = [{ width, height, rgb: toRgb(image), hole: binarize(mask) }];
  while (levels.length < opts.maxLevels) {
    const prev = levels[levels.length - 1];
    const w = prev.width >> 1, h = prev.height >> 1;
    if (Math.min(w, h) < Math.max(opts.minLevelSide, 2 * r + 1)) break;
    levels.push(downsample(prev, w, h));
  }

  let nnf = null;
  for (let li = levels.length - 1; li >= 0; li--) {
    const L = levels[li];
    const sources = validSources(L, r);
    if (sources.length === 0) {
      // The hole swallows every whole patch: nothing to copy from. Smooth fill is
      // the honest best effort here.
      diffuseFill(L);
      nnf = null;
      continue;
    }
    const targets = targetCenters(L, r);
    if (nnf === null) {
      diffuseFill(L);
      nnf = randomNnf(targets, sources, L.width, rand);
    } else {
      nnf = upsampleNnf(nnf, levels[li + 1], L, targets, sources, r, rand);
      vote(L, targets, nnf, r, true); // first estimate built only from known pixels
    }
    const t = levels.length === 1 ? 1 : li / (levels.length - 1);
    const em = Math.round(opts.fineEm + (opts.coarseEm - opts.fineEm) * t);
    for (let i = 0; i < em; i++) {
      for (let s = 0; s < opts.searchIters; s++) {
        patchMatchSweep(L, targets, sources, nnf, r, rand, (i * opts.searchIters + s) % 2 === 1);
      }
      vote(L, targets, nnf, r, false, opts.shiftIters, opts.bandwidth);
    }
    nnf.targets = targets;
  }

  const base = levels[0];
  let from = null; // hole pixel -> the pixel it copied (-1: none), so a caller can redo the copy at a larger size
  if (nnf && opts.finalVote !== 'mean') {
    // Averaging overlapping patches blurs fine texture. Refresh the matches against
    // the converged estimate, then copy real source pixels instead of averaging.
    const sources = validSources(base, r);
    patchMatchSweep(base, nnf.targets, sources, nnf, r, rand, false);
    if (opts.finalVote === 'best') bestVote(base, nnf.targets, nnf, r);
    else centerCopy(base, nnf.targets, nnf, r, (from = new Int32Array(width * height).fill(-1)));
  }

  const out = new Uint8ClampedArray(image.data);
  for (let i = 0, n = width * height; i < n; i++) {
    if (!base.hole[i]) continue;
    out[i * 4] = base.rgb[i * 3];
    out[i * 4 + 1] = base.rgb[i * 3 + 1];
    out[i * 4 + 2] = base.rgb[i * 3 + 2];
    out[i * 4 + 3] = 255;
  }
  return from ? { width, height, data: out, from } : { width, height, data: out };
}

// ------------------------------------------------------------------ internals

function toRgb(image) {
  const n = image.width * image.height;
  const rgb = new Float32Array(n * 3);
  const d = image.data;
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = d[i * 4];
    rgb[i * 3 + 1] = d[i * 4 + 1];
    rgb[i * 3 + 2] = d[i * 4 + 2];
  }
  return rgb;
}

function binarize(mask) {
  const hole = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) hole[i] = mask[i] ? 1 : 0;
  return hole;
}

// A coarse pixel is a hole if any of its children is (so the hole never shrinks
// away); its colour averages only the known children.
function downsample(L, w, h) {
  const rgb = new Float32Array(w * h * 3);
  const hole = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, n = 0, anyHole = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const sx = Math.min(L.width - 1, 2 * x + dx);
          const sy = Math.min(L.height - 1, 2 * y + dy);
          const si = sy * L.width + sx;
          if (L.hole[si]) { anyHole = 1; continue; }
          r += L.rgb[si * 3]; g += L.rgb[si * 3 + 1]; b += L.rgb[si * 3 + 2]; n++;
        }
      }
      const di = y * w + x;
      hole[di] = anyHole;
      if (n) { rgb[di * 3] = r / n; rgb[di * 3 + 1] = g / n; rgb[di * 3 + 2] = b / n; }
    }
  }
  return { width: w, height: h, rgb, hole };
}

// Patch centres whose whole (2r+1)^2 patch is inside the image and hole-free.
function validSources(L, r) {
  const { width: w, height: h, hole } = L;
  // Summed-area table over the hole mask answers "any hole in this box?" in O(1).
  const sat = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += hole[y * w + x];
      sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + rowSum;
    }
  }
  const out = [];
  for (let y = r; y < h - r; y++) {
    for (let x = r; x < w - r; x++) {
      const x0 = x - r, y0 = y - r, x1 = x + r + 1, y1 = y + r + 1;
      const holes = sat[y1 * (w + 1) + x1] - sat[y0 * (w + 1) + x1] - sat[y1 * (w + 1) + x0] + sat[y0 * (w + 1) + x0];
      if (holes === 0) out.push(y * w + x);
    }
  }
  const valid = new Uint8Array(w * h);
  for (const i of out) valid[i] = 1;
  const list = Int32Array.from(out);
  list.valid = valid;
  return list;
}

// Patch centres (kept inside the image) whose patch overlaps the hole. Every hole
// pixel is covered: the pixel clamped into [r, side-1-r] is a centre within r of it.
function targetCenters(L, r) {
  const { width: w, height: h, hole } = L;
  const mark = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!hole[y * w + x]) continue;
      const cx0 = Math.max(r, x - r), cx1 = Math.min(w - 1 - r, x + r);
      const cy0 = Math.max(r, y - r), cy1 = Math.min(h - 1 - r, y + r);
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) mark[cy * w + cx] = 1;
      }
    }
  }
  const out = [];
  for (let i = 0; i < mark.length; i++) if (mark[i]) out.push(i);
  return Int32Array.from(out);
}

// Onion-peel fill: each hole pixel takes the mean of its already-known 8-neighbours,
// layer by layer from the boundary inward. A smooth starting guess for EM.
function diffuseFill(L) {
  const { width: w, height: h, rgb, hole } = L;
  const known = new Uint8Array(w * h);
  for (let i = 0; i < known.length; i++) known[i] = hole[i] ? 0 : 1;
  let frontier = [];
  for (let i = 0; i < known.length; i++) if (!known[i] && hasKnownNeighbour(i, w, h, known)) frontier.push(i);
  if (frontier.length === 0) return; // whole image is hole: nothing to diffuse from
  while (frontier.length) {
    const filled = [];
    for (const i of frontier) {
      const x = i % w, y = (i / w) | 0;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if ((dx || dy) && nx >= 0 && ny >= 0 && nx < w && ny < h && known[ny * w + nx]) {
            const j = ny * w + nx;
            r += rgb[j * 3]; g += rgb[j * 3 + 1]; b += rgb[j * 3 + 2]; n++;
          }
        }
      }
      if (n) { rgb[i * 3] = r / n; rgb[i * 3 + 1] = g / n; rgb[i * 3 + 2] = b / n; filled.push(i); }
    }
    for (const i of filled) known[i] = 1;
    const next = new Set();
    for (const i of filled) {
      const x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && !known[ny * w + nx]) next.add(ny * w + nx);
        }
      }
    }
    frontier = [...next];
  }
}

function hasKnownNeighbour(i, w, h, known) {
  const x = i % w, y = (i / w) | 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if ((dx || dy) && nx >= 0 && ny >= 0 && nx < w && ny < h && known[ny * w + nx]) return true;
    }
  }
  return false;
}

function randomNnf(targets, sources, w, rand) {
  const match = new Int32Array(targets.length);
  const dist = new Float64Array(targets.length).fill(Infinity);
  for (let k = 0; k < targets.length; k++) match[k] = sources[(rand() * sources.length) | 0];
  return { match, dist, stale: true };
}

// Carry matches up a level: target t at fine level inherits its coarse parent's
// match, scaled by 2 and shifted by t's sub-pixel offset. Invalid results are
// re-randomised.
function upsampleNnf(coarse, C, F, targets, sources, r, rand) {
  const lookup = new Int32Array(C.width * C.height).fill(-1);
  const ct = coarse.targets;
  for (let k = 0; k < ct.length; k++) lookup[ct[k]] = coarse.match[k];
  const match = new Int32Array(targets.length);
  const valid = sources.valid;
  for (let k = 0; k < targets.length; k++) {
    const t = targets[k];
    const tx = t % F.width, ty = (t / F.width) | 0;
    const cx = Math.min(C.width - 1, tx >> 1), cy = Math.min(C.height - 1, ty >> 1);
    const cm = lookup[cy * C.width + cx];
    let s = -1;
    if (cm >= 0) {
      const sx = 2 * (cm % C.width) + (tx - 2 * cx);
      const sy = 2 * ((cm / C.width) | 0) + (ty - 2 * cy);
      if (sx >= r && sy >= r && sx < F.width - r && sy < F.height - r && valid[sy * F.width + sx]) s = sy * F.width + sx;
    }
    match[k] = s >= 0 ? s : sources[(rand() * sources.length) | 0];
  }
  return { match, dist: new Float64Array(targets.length).fill(Infinity), stale: true };
}

function patchDistance(L, t, s, r, cutoff) {
  const { width: w, rgb } = L;
  let d = 0;
  for (let dy = -r; dy <= r; dy++) {
    let ti = ((t + dy * w) - r) * 3;
    let si = ((s + dy * w) - r) * 3;
    for (let dx = -r; dx <= r; dx++, ti += 3, si += 3) {
      const a = rgb[ti] - rgb[si], b = rgb[ti + 1] - rgb[si + 1], c = rgb[ti + 2] - rgb[si + 2];
      d += a * a + b * b + c * c;
    }
    if (d >= cutoff) return d; // early out: already worse than the best
  }
  return d;
}

function patchMatchSweep(L, targets, sources, nnf, r, rand, reverse) {
  const { width: w, height: h } = L;
  const valid = sources.valid;
  const { match, dist } = nnf;
  // Index of each target centre, so propagation can find its neighbours' matches.
  if (nnf.indexFor !== targets) {
    nnf.index = new Int32Array(w * h).fill(-1);
    for (let k = 0; k < targets.length; k++) nnf.index[targets[k]] = k;
    nnf.indexFor = targets;
  }
  const index = nnf.index;
  if (nnf.stale) {
    for (let k = 0; k < targets.length; k++) dist[k] = patchDistance(L, targets[k], match[k], r, Infinity);
    nnf.stale = false;
  }
  const step = reverse ? -1 : 1;
  const start = reverse ? targets.length - 1 : 0;
  const maxR = Math.max(w, h);
  for (let n = 0, k = start; n < targets.length; n++, k += step) {
    const t = targets[k];
    const tx = t % w, ty = (t / w) | 0;
    let best = match[k], bestD = dist[k];
    // Propagation: a neighbour's good match, shifted by one, is often good here too.
    for (let p = 0; p < 2; p++) {
      const nx = p === 0 ? tx - step : tx, ny = p === 0 ? ty : ty - step;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nk = index[ny * w + nx];
      if (nk < 0) continue;
      const nm = match[nk];
      const sx = (nm % w) + (tx - nx), sy = ((nm / w) | 0) + (ty - ny);
      if (sx < r || sy < r || sx >= w - r || sy >= h - r) continue;
      const s = sy * w + sx;
      if (!valid[s] || s === best) continue;
      const d = patchDistance(L, t, s, r, bestD);
      if (d < bestD) { best = s; bestD = d; }
    }
    // Random search in exponentially shrinking windows around the current best.
    const bx = best % w, by = (best / w) | 0;
    for (let rad = maxR; rad >= 1; rad >>= 1) {
      const sx = Math.round(bx + (rand() * 2 - 1) * rad);
      const sy = Math.round(by + (rand() * 2 - 1) * rad);
      if (sx < r || sy < r || sx >= w - r || sy >= h - r) continue;
      const s = sy * w + sx;
      if (!valid[s] || s === best) continue;
      const d = patchDistance(L, t, s, r, bestD);
      if (d < bestD) { best = s; bestD = d; }
    }
    match[k] = best;
    dist[k] = bestD;
  }
}

// Each hole pixel is rebuilt from what every overlapping target patch's match says
// it should be. Close matches count more (Wexler's exp(-d / 2σ²)). A plain weighted
// mean blurs wherever the votes disagree, so with `shiftIters` > 0 the estimate
// instead starts at the best-matching vote and mean-shifts toward the dominant
// colour mode around it (Wexler §3.3) — sharp texture, still robust to outliers.
function vote(L, targets, nnf, r, knownOnly, shiftIters = 0, bandwidth = 24) {
  const { width: w, rgb, hole } = L;
  const { match } = nnf;
  const n = L.width * L.height;
  let weights = null; // distances aren't meaningful yet: plain average
  if (!knownOnly && !nnf.stale) {
    const sorted = Float64Array.from(nnf.dist).sort();
    const sigma2 = Math.max(1, sorted[Math.floor(sorted.length * 0.75)] || 1);
    weights = new Float64Array(targets.length);
    for (let k = 0; k < targets.length; k++) weights[k] = Math.exp(-nnf.dist[k] / (2 * sigma2)) + 1e-6;
  }

  const est = new Float32Array(n * 3);
  const acc = new Float64Array(n * 3);
  const wsum = new Float64Array(n);
  const shifting = shiftIters > 0 && weights !== null;

  if (shifting) {
    // Seed: the vote from the overlapping patch with the smallest distance.
    const bestD = new Float64Array(n).fill(Infinity);
    for (let k = 0; k < targets.length; k++) {
      const t = targets[k], s = match[k], d = nnf.dist[k];
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const p = t + dy * w + dx;
          if (!hole[p] || d >= bestD[p]) continue;
          const q = s + dy * w + dx;
          bestD[p] = d;
          est[p * 3] = rgb[q * 3]; est[p * 3 + 1] = rgb[q * 3 + 1]; est[p * 3 + 2] = rgb[q * 3 + 2];
        }
      }
    }
  }

  const passes = shifting ? shiftIters : 1;
  const inv2h2 = 1 / (2 * bandwidth * bandwidth);
  for (let pass = 0; pass < passes; pass++) {
    acc.fill(0);
    wsum.fill(0);
    for (let k = 0; k < targets.length; k++) {
      const t = targets[k], s = match[k];
      const wk = weights ? weights[k] : 1;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const p = t + dy * w + dx;
          if (!hole[p]) continue;
          const q = s + dy * w + dx;
          const cr = rgb[q * 3], cg = rgb[q * 3 + 1], cb = rgb[q * 3 + 2];
          let wv = wk;
          if (shifting) {
            const er = cr - est[p * 3], eg = cg - est[p * 3 + 1], eb = cb - est[p * 3 + 2];
            wv *= Math.exp(-(er * er + eg * eg + eb * eb) * inv2h2);
          }
          acc[p * 3] += wv * cr; acc[p * 3 + 1] += wv * cg; acc[p * 3 + 2] += wv * cb;
          wsum[p] += wv;
        }
      }
    }
    for (let p = 0; p < n; p++) {
      if (!hole[p] || wsum[p] < 1e-12) continue; // no support: keep the seed
      est[p * 3] = acc[p * 3] / wsum[p];
      est[p * 3 + 1] = acc[p * 3 + 1] / wsum[p];
      est[p * 3 + 2] = acc[p * 3 + 2] / wsum[p];
    }
  }

  for (let p = 0; p < n; p++) {
    if (!hole[p]) continue;
    if (!shifting && wsum[p] === 0) continue;
    rgb[p * 3] = est[p * 3]; rgb[p * 3 + 1] = est[p * 3 + 1]; rgb[p * 3 + 2] = est[p * 3 + 2];
  }
  nnf.stale = true; // pixels moved, so cached distances are out of date
}

// Each hole pixel copies the matching pixel of the patch centred on it (or, near
// the border, on its clamped centre). Neighbouring matches are shift-coherent after
// PatchMatch, so this reproduces source texture at full sharpness.
function centerCopy(L, targets, nnf, r, from) {
  const { width: w, height: h, rgb, hole } = L;
  const index = new Int32Array(w * h).fill(-1);
  for (let k = 0; k < targets.length; k++) index[targets[k]] = k;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!hole[p]) continue;
      const cx = Math.min(w - 1 - r, Math.max(r, x)), cy = Math.min(h - 1 - r, Math.max(r, y));
      const k = index[cy * w + cx];
      if (k < 0) continue;
      const q = nnf.match[k] + (y - cy) * w + (x - cx);
      from[p] = q;
      rgb[p * 3] = rgb[q * 3]; rgb[p * 3 + 1] = rgb[q * 3 + 1]; rgb[p * 3 + 2] = rgb[q * 3 + 2];
    }
  }
}

// Each hole pixel copies from whichever overlapping patch matched best.
function bestVote(L, targets, nnf, r) {
  const { width: w, rgb, hole } = L;
  const n = L.width * L.height;
  const bestD = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  for (let k = 0; k < targets.length; k++) {
    const t = targets[k], s = nnf.match[k], d = nnf.dist[k];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const p = t + dy * w + dx;
        if (hole[p] && d < bestD[p]) { bestD[p] = d; from[p] = s + dy * w + dx; }
      }
    }
  }
  for (let p = 0; p < n; p++) {
    const q = from[p];
    if (q < 0) continue;
    rgb[p * 3] = rgb[q * 3]; rgb[p * 3 + 1] = rgb[q * 3 + 1]; rgb[p * 3 + 2] = rgb[q * 3 + 2];
  }
}
