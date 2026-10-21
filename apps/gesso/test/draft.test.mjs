import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DRAFT_VERSION, TILE_HEADER_BYTES, encodeTileHeader, decodeTileHeader, draftRecord, reviveDraft,
  draftKeys, sourceKey, tileKey, workingCapFor,
} from '../lib/draft.js';
import * as H from '../lib/history.js';
import { createDoc, setIn, deepEqual } from '../lib/doc.js';
import { fitWorkingSize, WORK_MAX_PIXELS, WORK_FALLBACK_PIXELS } from '../lib/image-io.js';
import { openStore } from '../ui/store.js';
import { createAutosave } from '../ui/autosave.js';

const W = 4000, HH = 3000;
const doc0 = (id = 'd1') => createDoc({ id, sourceType: 'jpeg', natW: 8000, natH: 6000, w: W, h: HH, now: 1_700_000_000_000 });
const stroke = (over = {}) => ({ mode: 'brighten', r: 24, pts: [10, 10, 40.5, 12, 80, 30], ...over });
const patch = (over = {}) => ({ x: 100, y: 200, w: 3, h: 2, ...over });
const rgbaFor = (p, seed = 1) => Uint8ClampedArray.from({ length: p.w * p.h * 4 }, (_, i) => (i * 37 + seed) & 255);

// A history with a brightness step, a paint stroke, two fills (one undone and then
// overwritten, so its pools entry is garbage) and a caption.
function sampleHistory(id = 'd1') {
  let h = H.createHistory(doc0(id));
  let s = H.current(h);
  h = H.push(h, setIn(s, ['light', 'brightness'], 18), 'Brightness +18', 'light');
  s = H.current(h);
  h = H.push(h, { ...s, paint: ['s1'] }, 'Painted light', 'light');
  s = H.current(h);
  h = H.push(h, { ...s, remove: ['p1'] }, 'Removed spot', 'remove');
  s = H.current(h);
  h = H.push(h, { ...s, remove: ['p1', 'gone'] }, 'Removed spot', 'remove');
  h = H.undo(h);
  s = H.current(h);
  h = H.push(h, { ...s, remove: ['p1', 'p2'] }, 'Removed spot', 'remove');
  s = H.current(h);
  h = H.push(h, { ...s, text: [{ id: 'c1', text: 'Hello', style: 'bold', color: '#ffffff', cx: 0.5, cy: 0.78, size: 0.08, angle: 0 }] }, "Caption 'Hello'", 'text');
  return h;
}

const samplePools = () => ({
  strokes: { s1: stroke(), cancelled: stroke({ mode: 'darken' }) },
  patches: { p1: patch(), p2: patch({ x: 10, y: 10, w: 4, h: 4 }), gone: patch({ x: 0, y: 0 }) },
});

const serialized = (h, pools, savedRevision = false) => ({ history: H.serialize(h), pools, savedRevision });

// ------------------------------------------------------------------ tiles

test('a tile header round-trips its rect and checks the size', () => {
  const r = { x: 12, y: 3400, w: 640, h: 3 };
  const head = encodeTileHeader(r, r.w * r.h * 4);
  assert.equal(head.length, TILE_HEADER_BYTES);
  assert.deepEqual(decodeTileHeader(head, TILE_HEADER_BYTES + r.w * r.h * 4), r);
  assert.deepEqual(decodeTileHeader(head), r);
  assert.throws(() => decodeTileHeader(head, TILE_HEADER_BYTES + r.w * r.h * 4 - 1), /size/);
  assert.throws(() => encodeTileHeader(r, 10), RangeError);
  assert.throws(() => encodeTileHeader({ x: -1, y: 0, w: 1, h: 1 }, 4), RangeError);
  assert.throws(() => encodeTileHeader({ x: 0, y: 0, w: 0, h: 1 }, 0), RangeError);
  const bad = head.slice();
  bad[0] = 0;
  assert.throws(() => decodeTileHeader(bad), /not a tile/);
  assert.throws(() => decodeTileHeader(head.slice(0, 8)), /short/);
  // A view into a larger buffer reads from its own offset.
  const big = new Uint8Array(TILE_HEADER_BYTES + 7);
  big.set(head, 7);
  assert.deepEqual(decodeTileHeader(big.subarray(7)), r);
});

test('keys name the draft original and its tiles', () => {
  assert.equal(sourceKey('d1'), 'source:d1');
  assert.equal(tileKey('p1'), 'tile:p1');
  assert.deepEqual([...draftKeys('d1', ['p1', 'p2'])].sort(), ['source:d1', 'tile:p1', 'tile:p2']);
});

// ------------------------------------------------------------------ record

test('a record keeps the whole history and only the pools it refers to', () => {
  const h = sampleHistory();
  const rec = draftRecord({ id: 'd1', info: { type: 'jpeg', natW: 8000, natH: 6000, name: 'IMG_1.JPG' }, serialized: serialized(h, samplePools(), true), maxPixels: WORK_MAX_PIXELS, now: 5 });
  assert.equal(rec.v, DRAFT_VERSION);
  assert.equal(rec.id, 'd1');
  assert.equal(rec.savedAt, 5);
  assert.equal(rec.savedRevision, true);
  assert.equal(rec.maxPixels, WORK_MAX_PIXELS);
  assert.deepEqual(Object.keys(rec.pools.strokes), ['s1']);
  assert.deepEqual(Object.keys(rec.pools.patches).sort(), ['p1', 'p2']);
  assert.equal(rec.history.entries.length, h.entries.length);
  assert.throws(() => draftRecord({ id: '', serialized: serialized(h, {}) }), /id/);
  assert.throws(() => draftRecord({ id: 'd1', serialized: {} }), /nothing/);
});

test('a record survives structured clone (IndexedDB) and revives deep-equal', () => {
  const h = sampleHistory();
  const pools = samplePools();
  const rec = structuredClone(draftRecord({ id: 'd1', info: { type: 'jpeg', natW: 8000, natH: 6000, name: 'IMG_1.JPG' }, serialized: serialized(h, pools), maxPixels: 12_000_000 }));
  const d = reviveDraft(rec, 'd1');
  assert.deepEqual(H.labels(d.history), H.labels(h));
  assert.equal(d.history.index, h.index);
  for (let i = 0; i < h.entries.length; i++) assert.ok(deepEqual(d.history.entries[i].state, h.entries[i].state), `entry ${i}`);
  assert.deepEqual(d.pools.strokes, { s1: pools.strokes.s1 });
  assert.deepEqual(d.pools.patches, { p1: pools.patches.p1, p2: pools.patches.p2 });
  assert.deepEqual(d.tileIds.sort(), ['p1', 'p2']);
  assert.deepEqual(d.info, { type: 'jpeg', natW: 8000, natH: 6000, name: 'IMG_1.JPG' });
  assert.equal(d.savedRevision, false);
  assert.equal(d.maxPixels, 12_000_000);
});

test('revive drops an open tool mark: the app reopens at home', () => {
  const h = H.setMark(sampleHistory());
  assert.notEqual(h.mark, null);
  const d = reviveDraft(structuredClone(draftRecord({ id: 'd1', serialized: serialized(h, samplePools()) })));
  assert.equal(d.history.mark, null);
});

test('revive fills in missing info from the document and ignores a bad cap', () => {
  const h = sampleHistory();
  const rec = structuredClone(draftRecord({ id: 'd1', info: null, serialized: serialized(h, samplePools()) }));
  rec.maxPixels = -3;
  const d = reviveDraft(rec);
  assert.deepEqual(d.info, { type: 'jpeg', natW: 8000, natH: 6000, name: '' });
  assert.equal(d.maxPixels, null);
});

// Light › Outline keeps a polygon and an amount in pools.strokes, no brush.
test('an outline entry in pools.strokes revives as stored, and a damaged one throws', () => {
  const outline = { kind: 'outline', mode: 'darken', poly: [10, 10, 40.5, 12, 80, 30, 20, 60], amount: 0.67 };
  let h = sampleHistory();
  h = H.push(h, { ...H.current(h), paint: ['s1', 'o1'] }, 'Darkened inside outline', 'light');
  const pools = { ...samplePools(), strokes: { ...samplePools().strokes, o1: outline } };
  const good = () => structuredClone(draftRecord({ id: 'd1', serialized: serialized(h, pools) }));
  assert.deepEqual(reviveDraft(good(), 'd1').pools.strokes, { s1: pools.strokes.s1, o1: outline });
  const broken = [
    ['an outline with a bad mode', () => { const r = good(); r.pools.strokes.o1.mode = 'smudge'; return r; }],
    ['an outline with two points', () => { const r = good(); r.pools.strokes.o1.poly = [1, 2, 3, 4]; return r; }],
    ['an outline with an odd coordinate list', () => { const r = good(); r.pools.strokes.o1.poly = [1, 2, 3, 4, 5, 6, 7]; return r; }],
    ['an outline with a NaN point', () => { const r = good(); r.pools.strokes.o1.poly[1] = NaN; return r; }],
    ['an outline with an amount above 1', () => { const r = good(); r.pools.strokes.o1.amount = 1.5; return r; }],
    ['an outline with no amount', () => { const r = good(); delete r.pools.strokes.o1.amount; return r; }],
  ];
  for (const [what, make] of broken) assert.throws(() => reviveDraft(make(), 'd1'), /outline o1/, what);
});

test('a damaged record throws instead of half-restoring', () => {
  const good = () => structuredClone(draftRecord({ id: 'd1', serialized: serialized(sampleHistory(), samplePools()) }));
  const broken = [
    ['not an object', () => null],
    ['wrong version', () => ({ ...good(), v: 99 })],
    ['stored under another id', () => good(), 'other'],
    ['no history', () => ({ ...good(), history: null })],
    ['empty history', () => ({ ...good(), history: { v: 1, entries: [] } })],
    ['a state without a source size', () => { const r = good(); r.history.entries[2].state = { ...r.history.entries[2].state, source: { w: 0, h: 0 } }; return r; }],
    ['a state from another photo', () => { const r = good(); r.history.entries[1].state = { ...r.history.entries[1].state, id: 'd2' }; return r; }],
    ['a missing stroke', () => { const r = good(); delete r.pools.strokes.s1; return r; }],
    ['a stroke with a bad mode', () => { const r = good(); r.pools.strokes.s1.mode = 'smudge'; return r; }],
    ['a stroke with a NaN point', () => { const r = good(); r.pools.strokes.s1.pts[1] = NaN; return r; }],
    ['a missing fill', () => { const r = good(); delete r.pools.patches.p2; return r; }],
    ['a fill off the photo', () => { const r = good(); r.pools.patches.p2.x = W - 1; return r; }],
    ['no pools at all', () => ({ ...good(), pools: undefined })],
  ];
  for (const [what, make, id = 'd1'] of broken) assert.throws(() => reviveDraft(make(), id), Error, what);
});

// ------------------------------------------------------------------ working size

test('the stored cap decodes back to exactly the working size', () => {
  const cands = [WORK_MAX_PIXELS, WORK_MAX_PIXELS, WORK_FALLBACK_PIXELS];
  for (const [nw, nh] of [[8064, 6048], [6048, 8064], [4032, 3024], [5712, 4284], [12000, 1000], [600, 400]]) {
    for (const cap of [WORK_MAX_PIXELS, WORK_FALLBACK_PIXELS]) {
      const f = fitWorkingSize(nw, nh, cap);
      const got = workingCapFor(nw, nh, f.width, f.height, cands);
      const back = fitWorkingSize(nw, nh, got);
      assert.deepEqual([back.width, back.height], [f.width, f.height], `${nw}x${nh} at ${cap}`);
      // WebKit can hand the bitmap back turned.
      const turned = workingCapFor(nw, nh, f.height, f.width, cands);
      const b2 = fitWorkingSize(nw, nh, turned);
      assert.deepEqual([b2.width, b2.height], [f.width, f.height]);
    }
  }
  assert.equal(workingCapFor(8064, 6048, 17, 3, [123, 456]), 123, 'no match: the cap in effect');
  assert.equal(workingCapFor(8064, 6048, 17, 3, []), null);
});

// ------------------------------------------------------------------ autosave (memory store)

function fakeEditor(id = 'd1') {
  const ed = {
    history: H.createHistory(doc0(id)),
    pools: { strokes: {}, patches: {} },
    sourceInfo: { type: 'jpeg', natW: 8000, natH: 6000, name: 'IMG_1.JPG' },
    isSaved: false,
    toasts: [],
    toast(t) { this.toasts.push(t); },
    serialize() { return { history: H.serialize(this.history), pools: this.pools, savedRevision: this.isSaved }; },
    commit(next, label, tool = 'light') { this.history = H.push(this.history, next, label, tool); },
    get committed() { return H.current(this.history); },
  };
  return ed;
}

const photo = (name = 'IMG_1.JPG') => new File([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])], name, { type: 'image/jpeg' });

// Node has no IndexedDB: the in-memory store, told it lasts, stands in for it.
const diskStore = async () => ({ ...(await openStore()), available: true });

async function setup(id = 'd1') {
  const store = await diskStore();
  let ed = fakeEditor(id);
  const auto = createAutosave(store, () => ed, { debounceMs: 20 });
  return { store, auto, ed, swap(next) { ed = next; } };
}

test('without IndexedDB the store runs in memory and says so', async () => {
  const store = await openStore();
  assert.equal(store.available, false);
  assert.equal(typeof store.persistent, 'boolean');
  await store.putBlob('a', new Blob(['x']));
  assert.equal(await (await store.getBlob('a')).text(), 'x');
  assert.equal(await store.getBlob('nope'), null);
  await store.setCurrent('d1');
  assert.equal(await store.getCurrent(), 'd1');
  await store.setCurrent(null);
  assert.equal(await store.getCurrent(), null);
  await store.putBlob('b', new Blob(['y']));
  assert.deepEqual(await store.gc(new Set(['a'])), ['b']);
  assert.deepEqual(await store.blobKeys(), ['a']);
  assert.deepEqual(await store.gc((k) => k !== 'a'), ['a']);
});

test('a started draft with edits and a fill loads back the same', async () => {
  const { auto, ed } = await setup();
  await auto.startDraft('d1', photo());
  ed.commit(setIn(ed.committed, ['light', 'brightness'], 12), 'Brightness +12');
  const p = patch();
  const rgba = rgbaFor(p);
  ed.pools = { ...ed.pools, patches: { p1: p } };
  assert.equal(await auto.saveTile('p1', rgba, p), true);
  ed.commit({ ...ed.committed, remove: ['p1'] }, 'Removed spot', 'remove');
  ed.isSaved = true;
  await auto.flush();

  const d = await auto.loadDraft();
  assert.ok(d);
  assert.deepEqual(H.labels(d.history).map((l) => l.label), ['Original', 'Brightness +12', 'Removed spot']);
  assert.ok(deepEqual(H.current(d.history), H.current(ed.history)));
  assert.deepEqual(d.pools.patches, { p1: p });
  assert.deepEqual([...d.tiles.keys()], ['p1']);
  assert.deepEqual(d.tiles.get('p1'), rgba);
  assert.equal(d.savedRevision, true);
  assert.equal(d.info.name, 'IMG_1.JPG');
  assert.equal(d.file.name, 'IMG_1.JPG');
  assert.equal(d.file.size, photo().size);
  assert.ok(d.maxPixels > 0);
});

test('schedule debounces; flush writes at once and returns when stored', async () => {
  const writes = [];
  const base = await diskStore();
  const store = { ...base, putDoc: async (id, rec, opts) => { writes.push(rec.history.index); return base.putDoc(id, rec, opts); } };
  let ed = fakeEditor();
  const auto = createAutosave(store, () => ed, { debounceMs: 30 });
  await auto.startDraft('d1', photo());
  writes.length = 0;
  for (let i = 1; i <= 5; i++) {
    ed.commit(setIn(ed.committed, ['light', 'contrast'], i), `Contrast +${i}`);
    auto.schedule();
  }
  assert.equal(writes.length, 0, 'nothing written inside the debounce');
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(writes, [5], 'one write, of the latest step');
  await auto.flush();
  assert.deepEqual(writes, [5], 'flush with nothing new writes nothing');
  ed.commit(setIn(ed.committed, ['light', 'contrast'], 9), 'Contrast +9');
  auto.schedule();
  await auto.flush();
  assert.deepEqual(writes, [5, 6], 'flush writes at once');
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(writes, [5, 6], 'and cancels the pending debounce');
  ed = null;
});

test('a flush during a slow write is not lost, and the newest write wins', async () => {
  const base = await diskStore();
  const gates = [];
  const store = {
    ...base,
    // Writes land in the order they were made, each after a delay, like IndexedDB
    // transactions on the same store.
    putDoc(id, rec, opts) {
      const prev = gates.at(-1) ?? Promise.resolve();
      const p = prev.then(() => new Promise((r) => setTimeout(r, 25))).then(() => base.putDoc(id, rec, opts));
      gates.push(p);
      return p;
    },
  };
  const ed = fakeEditor();
  const auto = createAutosave(store, () => ed, { debounceMs: 10 });
  await auto.startDraft('d1', photo());
  ed.commit(setIn(ed.committed, ['light', 'shadows'], 10), 'Shadows +10');
  const first = auto.flush();
  ed.commit(setIn(ed.committed, ['light', 'shadows'], 20), 'Shadows +20');
  const second = auto.flush();
  await Promise.all([first, second]);
  const d = await auto.loadDraft();
  assert.equal(H.current(d.history).light.shadows, 20);
  assert.equal(d.history.entries.length, 3);
});

test('a failed write is retried by the next flush', async () => {
  const base = await diskStore();
  let fail = false;
  const store = { ...base, putDoc: async (id, rec, opts) => { if (fail) throw new Error('disk hiccup'); return base.putDoc(id, rec, opts); } };
  const ed = fakeEditor();
  const auto = createAutosave(store, () => ed, { debounceMs: 10 });
  await auto.startDraft('d1', photo());
  fail = true;
  ed.commit(setIn(ed.committed, ['color', 'warmth'], 30), 'Warmth +30');
  const warn = console.warn;
  console.warn = () => {};
  try { await auto.flush(); } finally { console.warn = warn; }
  fail = false;
  await auto.flush();
  const d = await auto.loadDraft();
  assert.equal(H.current(d.history).color.warmth, 30);
});

test('a new photo replaces the draft and sweeps the old one', async () => {
  const { store, auto, ed, swap } = await setup('d1');
  await auto.startDraft('d1', photo('one.jpg'));
  const p = patch();
  ed.pools = { strokes: {}, patches: { p1: p } };
  await auto.saveTile('p1', rgbaFor(p), p);
  ed.commit({ ...ed.committed, remove: ['p1'] }, 'Removed spot', 'remove');
  await auto.flush();
  assert.deepEqual((await store.blobKeys()).sort(), ['source:d1', 'tile:p1']);

  const ed2 = fakeEditor('d2');
  swap(ed2);
  await auto.startDraft('d2', photo('two.jpg'));
  assert.deepEqual(await store.blobKeys(), ['source:d2']);
  assert.deepEqual(await store.docKeys(), ['d2']);
  assert.equal(await store.getCurrent(), 'd2');
  const d = await auto.loadDraft();
  assert.equal(d.file.name, 'two.jpg');
  assert.equal(H.current(d.history).id, 'd2');
});

test('loading sweeps tiles nothing refers to any more', async () => {
  const { store, auto, ed } = await setup();
  await auto.startDraft('d1', photo());
  const p = patch();
  ed.pools = { strokes: {}, patches: { p1: p, p9: p } };
  await auto.saveTile('p1', rgbaFor(p), p);
  await auto.saveTile('p9', rgbaFor(p, 9), p); // a fill dropped before its step
  ed.commit({ ...ed.committed, remove: ['p1'] }, 'Removed spot', 'remove');
  await auto.flush();
  await store.putBlob('tile:stray', new Blob(['?']));
  await store.putDoc('d0', { v: 1 });
  const d = await auto.loadDraft();
  assert.deepEqual([...d.tiles.keys()], ['p1']);
  assert.deepEqual((await store.blobKeys()).sort(), ['source:d1', 'tile:p1']);
  assert.deepEqual(await store.docKeys(), ['d1']);
});

test('no draft: loadDraft gives null and clears leftovers', async () => {
  const store = await openStore();
  await store.putBlob('source:x', new Blob(['x']));
  const auto = createAutosave(store, () => null);
  assert.equal(await auto.loadDraft(), null);
  assert.deepEqual(await store.blobKeys(), []);
});

test('a damaged draft makes loadDraft throw; discard then forgets it', async () => {
  for (const damage of ['tile', 'source', 'record', 'tileSize']) {
    const { store, auto, ed } = await setup();
    await auto.startDraft('d1', photo());
    const p = patch();
    ed.pools = { strokes: {}, patches: { p1: p } };
    await auto.saveTile('p1', rgbaFor(p), p);
    ed.commit({ ...ed.committed, remove: ['p1'] }, 'Removed spot', 'remove');
    await auto.flush();
    if (damage === 'tile') await store.deleteBlob('tile:p1');
    if (damage === 'source') await store.deleteBlob('source:d1');
    if (damage === 'record') await store.deleteDoc('d1');
    if (damage === 'tileSize') await store.putBlob('tile:p1', new Blob([encodeTileHeader(p, p.w * p.h * 4), new Uint8Array(3)]));
    // A relaunch: nothing is on screen yet.
    const relaunched = createAutosave(store, () => null);
    await assert.rejects(relaunched.loadDraft(), Error, damage);
    await relaunched.discard();
    assert.equal(await store.getCurrent(), null);
    assert.deepEqual(await store.blobKeys(), []);
    assert.deepEqual(await store.docKeys(), []);
    assert.equal(await relaunched.loadDraft(), null);
  }
});

test('Discard, then keep editing a photo with fills: its tiles are kept and it restores', async () => {
  const { store, auto, ed } = await setup();
  ed.tiles = new Map();
  await auto.startDraft('d1', photo());
  const p = patch();
  const rgba = rgbaFor(p);
  ed.tiles.set('p1', rgba);
  ed.pools = { strokes: {}, patches: { p1: p } };
  await auto.saveTile('p1', rgba, p);
  ed.commit({ ...ed.committed, remove: ['p1'] }, 'Removed spot', 'remove');
  await auto.flush();
  await auto.discard();
  assert.equal(await store.getCurrent(), null);
  assert.deepEqual(await store.docKeys(), []);
  // The picker was cancelled: the photo on screen keeps its original and fills.
  assert.deepEqual((await store.blobKeys()).sort(), ['source:d1', 'tile:p1']);
  ed.commit(setIn(ed.committed, ['light', 'brightness'], 7), 'Brightness +7');
  await auto.flush();
  const d = await createAutosave(store, () => null).loadDraft();
  assert.ok(d);
  assert.deepEqual(H.labels(d.history).map((l) => l.label), ['Original', 'Removed spot', 'Brightness +7']);
  assert.deepEqual(d.tiles.get('p1'), rgba);
});

test('a fill whose tile failed to store is stored again before any record names it', async () => {
  const base = await diskStore();
  let failTiles = 1;
  const store = {
    ...base,
    async putBlob(k, b) {
      if (k.startsWith('tile:') && failTiles > 0) {
        failTiles--;
        throw new DOMException('full', 'QuotaExceededError');
      }
      return base.putBlob(k, b);
    },
  };
  const ed = fakeEditor();
  ed.tiles = new Map();
  const auto = createAutosave(store, () => ed, { debounceMs: 10 });
  await auto.startDraft('d1', photo());
  ed.commit(setIn(ed.committed, ['light', 'brightness'], 9), 'Brightness +9');
  await auto.flush();
  const p = patch();
  const rgba = rgbaFor(p, 3);
  ed.tiles.set('p1', rgba);
  ed.pools = { strokes: {}, patches: { p1: p } };
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await auto.saveTile('p1', rgba, p), false);
    ed.commit({ ...ed.committed, remove: ['p1'] }, 'Removed spot', 'remove');
    await auto.flush(); // stores the tile again, then the record
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(ed.toasts, ["This iPhone is out of space, so this edit isn't being kept."]);
  const d = await createAutosave(store, () => null).loadDraft();
  assert.equal(H.current(d.history).remove[0], 'p1');
  assert.deepEqual(d.tiles.get('p1'), rgba);

  // When it cannot be stored at all, the last record that can be restored stays.
  failTiles = Infinity;
  const q = patch({ x: 50 });
  ed.tiles.set('p2', rgbaFor(q, 4));
  ed.pools = { strokes: {}, patches: { p1: p, p2: q } };
  console.warn = () => {};
  try {
    await auto.saveTile('p2', ed.tiles.get('p2'), q);
    ed.commit({ ...ed.committed, remove: ['p1', 'p2'] }, 'Removed spot', 'remove');
    await auto.flush();
    ed.commit(setIn(ed.committed, ['light', 'contrast'], 5), 'Contrast +5');
    await auto.flush();
  } finally {
    console.warn = warn;
  }
  const d2 = await createAutosave(store, () => null).loadDraft();
  assert.deepEqual(H.labels(d2.history).map((l) => l.label), ['Original', 'Brightness +9', 'Removed spot']);
});

test('a photo opened while the last edit was still loading wins', async () => {
  const { store, auto, ed, swap } = await setup('d1');
  await auto.startDraft('d1', photo('one.jpg'));
  ed.commit(setIn(ed.committed, ['light', 'brightness'], 4), 'Brightness +4');
  await auto.flush();
  // Relaunch: the restore starts, and a picked photo lands before it finishes.
  let shown = null;
  const auto2 = createAutosave(store, () => shown, { debounceMs: 10 });
  const loading = auto2.loadDraft();
  shown = fakeEditor('d2');
  const starting = auto2.startDraft('d2', photo('two.jpg'));
  assert.equal(await loading, null, 'the older draft is not resumed over the new photo');
  await starting;
  shown.commit(setIn(shown.committed, ['color', 'warmth'], 12), 'Warmth +12');
  await auto2.flush();
  const d = await createAutosave(store, () => null).loadDraft();
  assert.equal(H.current(d.history).id, 'd2');
  assert.equal(H.current(d.history).color.warmth, 12);
  assert.deepEqual(await store.blobKeys(), ['source:d2']);
  swap(null);
});

test("a new photo whose original can't be stored leaves nothing to restore, not the previous photo", async () => {
  const base = await diskStore();
  let failSource = false;
  const store = {
    ...base,
    async putBlob(k, b) {
      if (failSource && k.startsWith('source:')) throw new DOMException('full', 'QuotaExceededError');
      return base.putBlob(k, b);
    },
  };
  let ed = fakeEditor('d1');
  const auto = createAutosave(store, () => ed, { debounceMs: 10 });
  await auto.startDraft('d1', photo('one.jpg'));
  ed.commit(setIn(ed.committed, ['light', 'brightness'], 4), 'Brightness +4');
  await auto.flush();
  assert.equal(await store.getCurrent(), 'd1');
  failSource = true;
  ed = fakeEditor('d2');
  const warn = console.warn;
  console.warn = () => {};
  try {
    await auto.startDraft('d2', photo('two.jpg'));
    ed.commit(setIn(ed.committed, ['light', 'brightness'], 8), 'Brightness +8');
    await auto.flush();
  } finally {
    console.warn = warn;
  }
  assert.equal(await store.getCurrent(), null);
  assert.equal(await createAutosave(store, () => null).loadDraft(), null);
});

test('Discard, then keep editing the same photo: the draft comes back', async () => {
  const { store, auto, ed } = await setup();
  await auto.startDraft('d1', photo());
  await auto.discard();
  assert.equal(await store.getCurrent(), null);
  // The picker was cancelled and the user carried on.
  ed.commit(setIn(ed.committed, ['light', 'highlights'], -20), 'Highlights −20');
  await auto.flush();
  await auto.flush();
  const d = await auto.loadDraft();
  assert.ok(d);
  assert.equal(H.current(d.history).light.highlights, -20);
});

test('writes for a photo that has no draft yet wait for startDraft', async () => {
  const { store, auto, ed } = await setup();
  ed.commit(setIn(ed.committed, ['light', 'brightness'], 5), 'Brightness +5');
  await auto.flush();
  assert.deepEqual(await store.docKeys(), []);
  await auto.startDraft('d1', photo());
  const d = await auto.loadDraft();
  assert.equal(H.current(d.history).light.brightness, 5);
});

test('memory only: tiles are not copied, and editing carries on', async () => {
  const store = await openStore();
  assert.equal(store.available, false);
  const puts = [];
  const spy = { ...store, putBlob: async (k, b) => { puts.push(k); return store.putBlob(k, b); } };
  const ed = fakeEditor();
  const auto = createAutosave(spy, () => ed, { debounceMs: 10 });
  await auto.startDraft('d1', photo());
  const p = patch();
  ed.pools = { strokes: {}, patches: { p1: p } };
  assert.equal(await auto.saveTile('p1', rgbaFor(p), p), true);
  ed.commit({ ...ed.committed, remove: ['p1'] }, 'Removed spot', 'remove');
  await auto.flush();
  assert.deepEqual(puts, ['source:d1'], 'the original is only a reference; no tile copy');
  assert.deepEqual(await store.docKeys(), ['d1']);
});

test('saveTile never throws, even for a tile that does not fit its rect', async () => {
  const { auto } = await setup();
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await auto.saveTile('p1', new Uint8ClampedArray(5), patch()), false);
  } finally {
    console.warn = warn;
  }
});
