import test from 'node:test';
import assert from 'node:assert/strict';
import { toGray, detectTilt, NO_TILT } from '../lib/level.js';
import { initialCrop, setAngle, sourceToOutput, apply } from '../lib/geometry.js';

const DEG = Math.PI / 180;
const W = 320, H = 240;

// Deterministic noise so every run sees the same pixels.
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// Sample f at pixel centres.
function render(w, h, f) {
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = f(x + 0.5, y + 0.5);
  return g;
}

// Average k x k samples per pixel: what a mipmapped downscale of a sharp photo
// looks like.
function renderBox(w, h, f, k = 8) {
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) s += f(x + (i + 0.5) / k, y + (j + 0.5) / k);
      g[y * w + x] = s / (k * k);
    }
  }
  return g;
}

// A lens-soft edge: 0 on one side, 1 on the other, about `width` px across.
const soft = (d, width = 0.8) => 1 / (1 + Math.exp(-d / (width * 0.5)));

// Lightly blurred noise, like foliage or grain riding on the scene.
function texture(w, h, amp, seed) {
  const rnd = lcg(seed);
  const n = Float32Array.from({ length: w * h }, () => rnd() - 0.5);
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let s = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += n[(y + j) * w + x + i];
      out[y * w + x] = (s / 9) * amp;
    }
  }
  return out;
}

// `lean` is how far the scene is turned clockwise on screen (y down): a positive
// lean makes the horizon fall to the right, so the correction is -lean.
function horizon(lean, { tex = 0.06, seed = 1, w = W, h = H } = {}) {
  const c = Math.cos(lean * DEG), s = Math.sin(lean * DEG);
  const t = texture(w, h, tex, seed);
  return render(w, h, (x, y) => {
    const d = -(x - w / 2) * s + (y - h / 2) * c; // > 0 below the horizon
    return 0.72 - 0.45 * soft(d) + t[Math.floor(y) * w + Math.floor(x)];
  });
}

// Parallel stripes, period 24 px: horizontal ones, or vertical ones (posts,
// door frames, building edges) with no horizon at all.
function stripes(lean, { vertical = false, w = W, h = H } = {}) {
  const c = Math.cos(lean * DEG), s = Math.sin(lean * DEG);
  return render(w, h, (x, y) => {
    const u = vertical ? (x - w / 2) * c + (y - h / 2) * s : -(x - w / 2) * s + (y - h / 2) * c;
    const p = ((u % 24) + 24) % 24;
    return 0.3 + 0.35 * (soft(p - 6) - soft(p - 18));
  });
}

const near = (a, b, eps) => Math.abs(a - b) <= eps;
const tilt = (img, opts) => detectTilt(img, W, H, opts);

// ------------------------------------------------------------------ toGray

test('toGray is Rec. 709 luma of the sRGB bytes, 0..1, ignoring alpha', () => {
  const rgba = new Uint8ClampedArray([
    255, 255, 255, 255,
    0, 0, 0, 0,
    255, 0, 0, 255,
    0, 255, 0, 10,
    0, 0, 255, 255,
    51, 102, 153, 128,
  ]);
  const g = toGray(rgba, 3, 2);
  assert.ok(g instanceof Float32Array);
  assert.equal(g.length, 6);
  const want = [1, 0, 0.2126, 0.7152, 0.0722, (0.2126 * 51 + 0.7152 * 102 + 0.0722 * 153) / 255];
  want.forEach((v, i) => assert.ok(near(g[i], v, 1e-6), `${i}: ${g[i]} vs ${v}`));
});

test('toGray tolerates short buffers and bad sizes', () => {
  assert.deepEqual([...toGray(new Uint8ClampedArray(4).fill(255), 2, 1)], [1, 0]);
  assert.equal(toGray(new Uint8ClampedArray(16), 0, 4).length, 0);
  assert.equal(toGray(new Uint8ClampedArray(16), 2.5, 2).length, 0);
  assert.equal(toGray(null, 2, 2).length, 4);
});

// ------------------------------------------------------------------ accuracy

test('a tilted horizon is measured within 0.3°, and the answer is the correction', () => {
  for (const lean of [-7, -3, 3, 7]) {
    const r = tilt(horizon(lean, { seed: 10 + lean }));
    assert.equal(r.kind, 'horizon');
    assert.ok(r.confidence > 0 && r.confidence <= 1, `${lean}: confidence ${r.confidence}`);
    assert.ok(near(r.angleDeg, -lean, 0.3), `lean ${lean}: got ${r.angleDeg}`);
  }
});

test('parallel horizontal lines are measured within 0.3°', () => {
  for (const lean of [-7, -3, -1, 1, 3, 7, 11]) {
    const r = tilt(stripes(lean));
    assert.equal(r.kind, 'horizon');
    assert.ok(near(r.angleDeg, -lean, 0.3), `lean ${lean}: got ${r.angleDeg}`);
  }
});

test('a level photo comes back as already level (under 0.3°), with confidence', () => {
  for (const img of [horizon(0, { seed: 3 }), stripes(0), stripes(0, { vertical: true })]) {
    const r = tilt(img);
    assert.ok(r.confidence > 0);
    assert.ok(Math.abs(r.angleDeg) < 0.3, `${r.angleDeg}`);
  }
  // and a tiny real tilt is still reported as tiny, not rounded into a big one
  const r = tilt(horizon(0.2, { seed: 4 }));
  assert.ok(Math.abs(r.angleDeg) < 0.3, `${r.angleDeg}`);
});

test('vertical lines alone give kind "verticals" and the same rotation', () => {
  for (const lean of [-7, -3, 3, 7]) {
    const r = tilt(stripes(lean, { vertical: true }));
    assert.equal(r.kind, 'verticals');
    assert.ok(r.confidence > 0);
    assert.ok(near(r.angleDeg, -lean, 0.3), `lean ${lean}: got ${r.angleDeg}`);
  }
});

test('the acceptance fixture: a sharp photo tilted +3°, read back mipmapped, needs −3°', () => {
  const rnd = lcg(42);
  const grain = Float32Array.from({ length: 64 * 64 }, () => rnd());
  const c = Math.cos(3 * DEG), s = Math.sin(3 * DEG);
  const img = renderBox(W, H, (x, y) => {
    const below = -(x - W / 2) * s + (y - H / 2) * c > 0;
    // dark ground with a little grain, brighter sky: median about 0.3
    return (below ? 0.18 : 0.55) + 0.06 * grain[(Math.floor(y * 2) % 64) * 64 + (Math.floor(x * 2) % 64)];
  });
  const r = tilt(img);
  assert.equal(r.kind, 'horizon');
  assert.ok(near(r.angleDeg, -3, 0.3), `${r.angleDeg}`);
});

test('the sign matches lib/geometry.js: setAngle(angleDeg) makes the horizon level on screen', () => {
  for (const lean of [-5, 4]) {
    const r = tilt(horizon(lean, { seed: 5 }));
    const crop = setAngle(initialCrop(W, H), W, H, r.angleDeg);
    const m = sourceToOutput(crop, W, H);
    // two points far apart on the horizon line, in source pixels
    const c = Math.cos(lean * DEG), s = Math.sin(lean * DEG);
    const a = apply(m, W / 2 - 100 * c, H / 2 - 100 * s);
    const b = apply(m, W / 2 + 100 * c, H / 2 + 100 * s);
    const slopeDeg = Math.atan2(b[1] - a[1], b[0] - a[0]) / DEG;
    assert.ok(Math.abs(slopeDeg) < 0.3, `lean ${lean}: still ${slopeDeg}° after straightening`);
  }
});

// ------------------------------------------------------------------ symmetry

const mirror = (g, w, h) => {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = g[y * w + (w - 1 - x)];
  return out;
};
// 90° clockwise: (x, y) -> (h - 1 - y, x), giving an h x w image.
const turn = (g, w, h) => {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[x * h + (h - 1 - y)] = g[y * w + x];
  return out;
};

test('a mirror negates the angle; a quarter turn keeps it and swaps the family', () => {
  const img = horizon(4, { seed: 8 });
  const r = tilt(img);
  const m = tilt(mirror(img, W, H));
  assert.ok(near(m.angleDeg, -r.angleDeg, 0.05), `${m.angleDeg} vs ${r.angleDeg}`);
  const q = detectTilt(turn(img, W, H), H, W);
  assert.equal(q.kind, 'verticals');
  assert.ok(near(q.angleDeg, r.angleDeg, 0.05), `${q.angleDeg} vs ${r.angleDeg}`);
});

// ------------------------------------------------------------------ rejection

test('noise has no horizon: confidence 0, kind none', () => {
  for (const seed of [1, 2, 3]) {
    const rnd = lcg(seed);
    const img = Float32Array.from({ length: W * H }, () => rnd());
    assert.deepEqual(tilt(img), NO_TILT);
  }
  // smooth noise (blotchy texture) too
  const t = texture(W, H, 1, 9);
  assert.deepEqual(tilt(t.map((v) => v + 0.5)), NO_TILT);
});

test('round things have no horizon', () => {
  const rnd = lcg(77);
  const disks = Array.from({ length: 40 }, () => [rnd() * W, rnd() * H, 6 + rnd() * 30, rnd()]);
  const img = render(W, H, (x, y) => {
    let v = 0.4;
    for (const [cx, cy, r, tone] of disks) v += (tone - 0.5) * 0.5 * (1 - soft(Math.hypot(x - cx, y - cy) - r));
    return v;
  });
  const res = tilt(img);
  assert.equal(res.confidence, 0, JSON.stringify(res));
});

test('a flat or empty image has no horizon', () => {
  assert.deepEqual(tilt(new Float32Array(W * H).fill(0.5)), NO_TILT);
  assert.deepEqual(tilt(new Float32Array(W * H)), NO_TILT);
  // a faint gradient is below the edge floor
  assert.deepEqual(tilt(render(W, H, (x, y) => 0.4 + 0.0002 * y)), NO_TILT);
});

test('lines steeper than maxDeg are not reported as a tilt on the rim', () => {
  const r = tilt(stripes(15));
  assert.equal(r.confidence, 0, JSON.stringify(r));
  const r5 = tilt(stripes(8), { maxDeg: 5 });
  assert.equal(r5.confidence, 0, JSON.stringify(r5));
  // just past the limit, inside the 2° band where votes are still collected
  // (the case that band exists for): the shoulder must not pass as a peak
  for (const [lean, maxDeg] of [[5.5, 5], [-6.5, 5], [12.4, 12], [-13, 12]]) {
    for (const vertical of [false, true]) {
      const r = tilt(stripes(lean, { vertical }), { maxDeg });
      assert.equal(r.confidence, 0, `${lean} past ${maxDeg}: ${JSON.stringify(r)}`);
    }
  }
  // ...while maxDeg wide enough finds it
  assert.ok(near(tilt(stripes(15), { maxDeg: 20 }).angleDeg, -15, 0.3));
});

test('a strong horizon still wins over a weaker, differently leaning structure', () => {
  const a = horizon(-3, { seed: 6 });
  const b = stripes(6);
  const img = a.map((v, i) => v + 0.15 * (b[i] - 0.45));
  const r = tilt(img);
  assert.ok(near(r.angleDeg, 3, 0.3), `${r.angleDeg}`);
});

test('a second family of lines a degree or two away does not drag the answer', () => {
  // Regression: the mean-shift polish (σ = 1°) used to reach across the valley
  // between two peaks and land up to 0.6° off, toward the weaker family.
  const band = (lean, keep) => {
    const s = stripes(lean);
    return s.map((v, i) => (keep(Math.floor(i / W)) ? v - 0.3 : 0));
  };
  for (const [main, other] of [[3, 4.5], [3, 4], [-2, -0.5], [0, 1.5], [1, 2], [-4, -2.5]]) {
    for (const split of [0.55, 0.6, 0.7]) {
      const a = band(main, (y) => y < H * split);
      const b = band(other, (y) => y >= H * split);
      const r = tilt(a.map((v, i) => 0.3 + v + b[i]));
      assert.ok(r.confidence > 0);
      assert.ok(near(r.angleDeg, -main, 0.1), `${main} beside ${other} at ${split}: got ${r.angleDeg}`);
    }
  }
});

// ------------------------------------------------------------------ robustness

test('bad input returns no tilt instead of throwing', () => {
  assert.deepEqual(detectTilt(null, W, H), NO_TILT);
  assert.deepEqual(detectTilt(new Float32Array(10), W, H), NO_TILT);
  assert.deepEqual(detectTilt(new Float32Array(16), 4, 4), NO_TILT);
  assert.deepEqual(detectTilt(new Float32Array(W * H), 0, H), NO_TILT);
  assert.deepEqual(detectTilt(new Float32Array(W * H), W, NaN), NO_TILT);
  assert.deepEqual(detectTilt(new Float32Array(W * H), W + 0.5, H), NO_TILT);
  // absurd values overflow to Infinity inside; still no NaN out
  const wild = Float32Array.from({ length: W * H }, (_, i) => (i % 7 ? 3e38 : -3e38));
  assert.deepEqual(detectTilt(wild, W, H), NO_TILT);
  const huge = Array.from({ length: W * H }, (_, i) => (i > (W * H) / 2 ? 1e300 : 0));
  const r = detectTilt(huge, W, H);
  assert.ok(Number.isFinite(r.angleDeg) && Number.isFinite(r.confidence));
});

test('NaN and Infinity pixels are ignored, not spread', () => {
  const img = horizon(3, { seed: 12 });
  for (let i = 0; i < img.length; i += 97) img[i] = i % 2 ? NaN : Infinity;
  const r = tilt(img);
  assert.ok(Number.isFinite(r.angleDeg) && Number.isFinite(r.confidence));
  assert.ok(near(r.angleDeg, -3, 0.5), `${r.angleDeg}`);
});

test('silly maxDeg values fall back to something sane', () => {
  const img = stripes(3);
  for (const maxDeg of [NaN, -5, 0, Infinity, 'x']) {
    const r = tilt(img, { maxDeg });
    assert.ok(near(r.angleDeg, -3, 0.3), `${maxDeg}: ${r.angleDeg}`);
  }
  assert.ok(near(tilt(img, { maxDeg: 90 }).angleDeg, -3, 0.3)); // clamped below 45
  // null options (not just undefined) used to throw while destructuring
  assert.ok(near(detectTilt(img, W, H, null).angleDeg, -3, 0.3));
  assert.ok(near(detectTilt(img, W, H, { maxDeg: null }).angleDeg, -3, 0.3));
});

test('deterministic, and the input is left untouched', () => {
  const img = horizon(-2.5, { seed: 21 });
  const copy = Float32Array.from(img);
  const a = tilt(img), b = tilt(img);
  assert.deepEqual(a, b);
  assert.deepEqual(img, copy);
  assert.ok(!Object.is(a.angleDeg, -0) && !Object.is(NO_TILT.angleDeg, -0));
  assert.ok(Object.isFrozen(NO_TILT));
});

test('works on non-square and portrait images and at the 512 px analysis size', () => {
  const tall = horizon(5, { w: 180, h: 320, seed: 30 });
  const r = detectTilt(tall, 180, 320);
  assert.ok(near(r.angleDeg, -5, 0.3), `${r.angleDeg}`);
  const big = horizon(-2, { w: 512, h: 384, seed: 31 });
  const t0 = performance.now();
  const r2 = detectTilt(big, 512, 384);
  const ms = performance.now() - t0;
  assert.ok(near(r2.angleDeg, 2, 0.3), `${r2.angleDeg}`);
  assert.ok(ms < 1000, `${ms} ms`);
});
