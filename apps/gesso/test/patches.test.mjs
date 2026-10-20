import test from 'node:test';
import assert from 'node:assert/strict';
import { planReconcile, repaintPlan, reconcileOps, rectIntersect, rectUnion, rectArea } from '../lib/patches.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ rects

test('rectIntersect returns the overlap, or null when rects only touch or miss', () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  assert.deepEqual(rectIntersect(a, { x: 5, y: 6, w: 10, h: 10 }), { x: 5, y: 6, w: 5, h: 4 });
  assert.deepEqual(rectIntersect(a, { x: 2, y: 2, w: 3, h: 3 }), { x: 2, y: 2, w: 3, h: 3 });
  assert.deepEqual(rectIntersect(a, a), a);
  assert.equal(rectIntersect(a, { x: 10, y: 0, w: 5, h: 5 }), null, 'touching edge');
  assert.equal(rectIntersect(a, { x: 0, y: 10, w: 5, h: 5 }), null);
  assert.equal(rectIntersect(a, { x: 20, y: 20, w: 5, h: 5 }), null);
  assert.equal(rectIntersect(a, { x: 1, y: 1, w: 0, h: 5 }), null, 'empty rect');
  assert.equal(rectIntersect(a, { x: 1, y: 1, w: -3, h: 5 }), null);
  assert.equal(rectIntersect(a, { x: NaN, y: 1, w: 3, h: 5 }), null);
  assert.equal(rectIntersect(a, null), null);
  assert.equal(rectIntersect(undefined, a), null);
});

test('rectUnion bounds both and ignores empty sides; rectArea is never negative', () => {
  assert.deepEqual(rectUnion({ x: 0, y: 0, w: 2, h: 2 }, { x: 5, y: -1, w: 1, h: 1 }), { x: 0, y: -1, w: 6, h: 3 });
  assert.deepEqual(rectUnion(null, { x: 1, y: 2, w: 3, h: 4 }), { x: 1, y: 2, w: 3, h: 4 });
  assert.deepEqual(rectUnion({ x: 1, y: 2, w: 3, h: 4 }, { x: 99, y: 99, w: 0, h: 0 }), { x: 1, y: 2, w: 3, h: 4 });
  assert.equal(rectUnion(null, { x: 0, y: 0, w: 0, h: 1 }), null);
  const a = { x: 1, y: 2, w: 3, h: 4 };
  assert.notEqual(rectUnion(a, null), a, 'a copy, never the input');
  assert.equal(rectArea({ x: 0, y: 0, w: 3, h: 4 }), 12);
  assert.equal(rectArea({ x: 0, y: 0, w: -3, h: 4 }), 0);
  assert.equal(rectArea({ x: 0, y: 0, w: Infinity, h: 4 }), 0);
  assert.equal(rectArea(null), 0);
});

// ------------------------------------------------------------------ plans

test('planReconcile keeps the common prefix, reverts newest first, applies in order', () => {
  assert.deepEqual(planReconcile(['a', 'b', 'c'], ['a', 'b', 'c']), { keep: 3, revert: [], apply: [] });
  assert.deepEqual(planReconcile(['a', 'b', 'c'], ['a']), { keep: 1, revert: ['c', 'b'], apply: [] });
  assert.deepEqual(planReconcile(['a'], ['a', 'b', 'c']), { keep: 1, revert: [], apply: ['b', 'c'] });
  assert.deepEqual(planReconcile(['a', 'b', 'c'], ['a', 'x', 'c']), { keep: 1, revert: ['c', 'b'], apply: ['x', 'c'] });
  assert.deepEqual(planReconcile(['a', 'b'], ['x', 'y']), { keep: 0, revert: ['b', 'a'], apply: ['x', 'y'] });
  assert.deepEqual(planReconcile([], []), { keep: 0, revert: [], apply: [] });
  assert.deepEqual(planReconcile(null, ['a']), { keep: 0, revert: [], apply: ['a'] });
  const cur = Object.freeze(['a', 'b']), tgt = Object.freeze(['a', 'c']);
  assert.doesNotThrow(() => planReconcile(cur, tgt));
  const p = planReconcile(cur, tgt);
  assert.notEqual(p.apply, tgt);
});

test('repaintPlan lists earlier tiles touching the rect, in order', () => {
  const meta = {
    a: { x: 0, y: 0, w: 10, h: 10 },
    b: { x: 20, y: 20, w: 5, h: 5 },
    c: { x: 8, y: 8, w: 4, h: 4 },
    d: { x: 10, y: 0, w: 5, h: 5 }, // touches the rect's right edge only
    toString: { x: 0, y: 0, w: 1, h: 1 },
  };
  const rect = { x: 0, y: 0, w: 10, h: 10 };
  assert.deepEqual(repaintPlan(rect, ['c', 'b', 'a', 'd'], meta), ['c', 'a']);
  assert.deepEqual(repaintPlan(rect, ['missing', 'a'], meta), ['a'], 'no bbox, no tile');
  assert.deepEqual(repaintPlan(rect, ['constructor', 'a'], {}), [], 'prototype keys are not tiles');
  assert.deepEqual(repaintPlan(rect, ['a'], new Map([['a', meta.a]])), ['a'], 'a Map works too');
  assert.deepEqual(repaintPlan(null, ['a'], meta), []);
  assert.deepEqual(repaintPlan(rect, null, meta), []);
  assert.deepEqual(repaintPlan(rect, ['a'], null), []);
});

test('reconcileOps spells out restore and clipped repaints', () => {
  const meta = { a: { x: 0, y: 0, w: 10, h: 10 }, b: { x: 5, y: 5, w: 10, h: 10 }, c: { x: 40, y: 40, w: 2, h: 2 } };
  assert.deepEqual(reconcileOps(['a', 'b'], ['a', 'c'], meta), [
    { op: 'restore', id: 'b', rect: { x: 5, y: 5, w: 10, h: 10 } },
    { op: 'paste', id: 'a', clip: { x: 5, y: 5, w: 5, h: 5 } },
    { op: 'paste', id: 'c', clip: null },
  ]);
  assert.deepEqual(reconcileOps(['a'], ['a'], meta), []);
  // Taking several off: only the kept tiles are re-pasted (b is going too).
  assert.deepEqual(reconcileOps(['a', 'b', 'c'], ['a'], { ...meta, c: { x: 6, y: 6, w: 2, h: 2 } }), [
    { op: 'restore', id: 'c', rect: { x: 6, y: 6, w: 2, h: 2 } },
    { op: 'paste', id: 'a', clip: { x: 6, y: 6, w: 2, h: 2 } },
    { op: 'restore', id: 'b', rect: { x: 5, y: 5, w: 10, h: 10 } },
    { op: 'paste', id: 'a', clip: { x: 5, y: 5, w: 5, h: 5 } },
  ]);
  assert.deepEqual(reconcileOps(['a'], [], meta), [{ op: 'restore', id: 'a', rect: meta.a }]);
  assert.throws(() => reconcileOps(['a', 'zzz'], ['a'], meta), /no bbox for zzz/);
});

// ------------------------------------------------------------------ bit-exact replay
// A plain-array simulation of the GPU: pristine and base are RGBA buffers, a tile
// is RGBA over its bbox with alpha 255 where the fill wrote and 0 elsewhere.

const IW = 64, IH = 48;

function makePristine(rng) {
  const px = new Uint8Array(IW * IH * 4);
  for (let i = 0; i < px.length; i++) px[i] = i % 4 === 3 ? 255 : Math.floor(rng() * 256);
  return px;
}

function makeTile(rng, base, at = null) {
  const w = at?.w ?? 3 + Math.floor(rng() * 22), h = at?.h ?? 3 + Math.floor(rng() * 18);
  const x = at?.x ?? Math.floor(rng() * (IW - w + 1)), y = at?.y ?? Math.floor(rng() * (IH - h + 1));
  const data = new Uint8Array(w * h * 4);
  // Like a real fill, the result depends on what is underneath (a shifted copy of
  // the base, tinted) inside an irregular mask.
  const dx = Math.floor(rng() * 7) - 3, dy = Math.floor(rng() * 7) - 3, tint = Math.floor(rng() * 40);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const o = (j * w + i) * 4;
      if (rng() < 0.25) continue; // alpha 0: the fill did not touch this pixel
      const sx = Math.min(IW - 1, Math.max(0, x + i + dx)), sy = Math.min(IH - 1, Math.max(0, y + j + dy));
      const s = (sy * IW + sx) * 4;
      data[o] = (base[s] + tint) & 255; data[o + 1] = base[s + 1] ^ tint; data[o + 2] = 255 - base[s + 2]; data[o + 3] = 255;
    }
  }
  return { x, y, w, h, data };
}

function paste(base, tile, clip = null) {
  const r = clip ? rectIntersect(clip, tile) : tile;
  if (!r) return;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const t = ((y - tile.y) * tile.w + (x - tile.x)) * 4;
      if (tile.data[t + 3] !== 255) continue;
      const b = (y * IW + x) * 4;
      base[b] = tile.data[t]; base[b + 1] = tile.data[t + 1]; base[b + 2] = tile.data[t + 2];
    }
  }
}

function restore(base, pristine, r) {
  for (let y = r.y; y < r.y + r.h; y++) {
    const from = (y * IW + r.x) * 4;
    base.set(pristine.subarray(from, from + r.w * 4), from);
  }
}

function fromScratch(pristine, tiles, ids) {
  const base = pristine.slice();
  for (const id of ids) paste(base, tiles[id]);
  return base;
}

// The renderer's job, written with the two primitives as SPEC §5.5 says: every
// tile below the one coming off is re-pasted (exact after each single step).
function reconcileByPlan(base, pristine, tiles, meta, cur, tgt) {
  const { revert, apply } = planReconcile(cur, tgt);
  revert.forEach((id, j) => {
    const rect = meta[id];
    restore(base, pristine, rect);
    for (const pid of repaintPlan(rect, cur.slice(0, cur.length - 1 - j), meta)) paste(base, tiles[pid], rect);
  });
  for (const id of apply) paste(base, tiles[id]);
}

function reconcileByOps(base, pristine, tiles, meta, cur, tgt) {
  for (const op of reconcileOps(cur, tgt, meta)) {
    if (op.op === 'restore') restore(base, pristine, op.rect);
    else paste(base, tiles[op.id], op.clip);
  }
}

function assertSameImage(a, b, msg) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) assert.fail(`${msg}: first difference at byte ${i} (pixel ${(i >> 2) % IW},${Math.floor((i >> 2) / IW)}): ${a[i]} vs ${b[i]}`);
  }
}

// A history-shaped walk over Remove lists: new fills, Try another (replace the
// newest), undo, redo, and tape jumps, with every tile built on the base it saw.
function walk(seed, reconcile) {
  const rng = mulberry32(seed);
  const pristine = makePristine(rng);
  const tiles = {}, meta = {};
  let n = 0;
  const lists = [[]]; // history entries' remove lists
  let index = 0;
  let shown = [];
  const base = pristine.slice();
  for (let step = 0; step < 80; step++) {
    const r = rng();
    let target;
    if (r < 0.4 || lists.length === 1) {
      // new fill on top of what is shown (may sit right on an earlier tile)
      const reuse = rng() < 0.3 && shown.length ? meta[shown[Math.floor(rng() * shown.length)]] : null;
      const t = makeTile(rng, base, reuse);
      const id = `p${n++}`;
      tiles[id] = t; meta[id] = { x: t.x, y: t.y, w: t.w, h: t.h };
      target = [...lists[index], id];
      lists.splice(index + 1, Infinity, target);
      index++;
    } else if (r < 0.5 && lists[index].length) {
      // Try another: the newest fill is replaced by a different one in the same bbox
      const last = lists[index][lists[index].length - 1];
      const under = fromScratch(pristine, tiles, lists[index].slice(0, -1));
      const t = makeTile(rng, under, meta[last]);
      const id = `p${n++}`;
      tiles[id] = t; meta[id] = { ...meta[last] };
      target = [...lists[index].slice(0, -1), id];
      lists.splice(index + 1, Infinity, target);
      index++;
    } else if (r < 0.7) {
      index = Math.max(0, index - 1);
      target = lists[index];
    } else if (r < 0.8) {
      index = Math.min(lists.length - 1, index + 1);
      target = lists[index];
    } else {
      index = Math.floor(rng() * lists.length);
      target = lists[index];
    }
    reconcile(base, pristine, tiles, meta, shown, target);
    shown = target;
    assertSameImage(base, fromScratch(pristine, tiles, target), `seed ${seed} step ${step}`);
  }
  return n;
}

test('replaying a reconcile plan is bit-exact against applying the list from scratch', () => {
  let tilesMade = 0;
  for (let seed = 1; seed <= 25; seed++) tilesMade += walk(seed, reconcileByPlan);
  assert.ok(tilesMade > 300, `exercised ${tilesMade} tiles`);
});

test('reconcileOps (kept tiles only) replays bit-exact too', () => {
  for (let seed = 101; seed <= 120; seed++) walk(seed, reconcileByOps);
});

// Jumps between unrelated lists (no shared history shape at all).
function jumpAround(reconcile) {
  const rng = mulberry32(9);
  const pristine = makePristine(rng);
  const tiles = {}, meta = {};
  const ids = [];
  for (let i = 0; i < 30; i++) {
    const t = makeTile(rng, pristine);
    tiles[`t${i}`] = t; meta[`t${i}`] = { x: t.x, y: t.y, w: t.w, h: t.h };
    ids.push(`t${i}`);
  }
  const pick = () => ids.filter(() => rng() < 0.35).sort(() => rng() - 0.5);
  let shown = [];
  const base = pristine.slice();
  for (let k = 0; k < 200; k++) {
    const target = rng() < 0.1 ? [] : pick();
    reconcile(base, pristine, tiles, meta, shown, target);
    shown = target;
    assertSameImage(base, fromScratch(pristine, tiles, target), `jump ${k}`);
  }
}

test('arbitrary jumps between unrelated lists are bit-exact (every tile below)', () => jumpAround(reconcileByPlan));
test('arbitrary jumps between unrelated lists are bit-exact (kept tiles only)', () => jumpAround(reconcileByOps));

test('the repaint must be clipped to the reverted bbox', () => {
  // T1 is wide; T2 paints over T1's left end; T3 overlaps T1's right end only.
  // Taking T3 off and re-pasting T1 whole would wipe T2's pixels.
  const rng = mulberry32(3);
  const pristine = makePristine(rng);
  const solid = (x, y, w, h, v) => ({ x, y, w, h, data: new Uint8Array(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : v)) });
  const tiles = { t1: solid(0, 0, 20, 4, 10), t2: solid(0, 0, 8, 4, 20), t3: solid(15, 0, 10, 4, 30) };
  const meta = Object.fromEntries(Object.entries(tiles).map(([k, t]) => [k, { x: t.x, y: t.y, w: t.w, h: t.h }]));
  const cur = ['t1', 't2', 't3'], tgt = ['t1', 't2'];
  assert.deepEqual(repaintPlan(meta.t3, ['t1', 't2'], meta), ['t1']);

  const good = fromScratch(pristine, tiles, cur);
  reconcileByPlan(good, pristine, tiles, meta, cur, tgt);
  assertSameImage(good, fromScratch(pristine, tiles, tgt), 'clipped');

  const naive = fromScratch(pristine, tiles, cur);
  restore(naive, pristine, meta.t3);
  for (const id of repaintPlan(meta.t3, ['t1', 't2'], meta)) paste(naive, tiles[id]); // unclipped
  assert.notDeepEqual(naive, fromScratch(pristine, tiles, tgt));
});
