import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CAP, ORIGINAL, createHistory, push, undo, redo, jumpTo, canUndo, canRedo, current,
  undoLabel, redoLabel, labels, setMark, clearMark, revertToMark, serialize, revive, referencedIds,
} from '../lib/history.js';
import { createDoc, setIn, describeChange } from '../lib/doc.js';
import { setAngle } from '../lib/geometry.js';

// Light-weight states for the bookkeeping tests; real DocStates where revive matters.
const s = (n) => ({ n });
const states = (H) => H.entries.map((e) => e.state.n);
const build = (count, opts) => {
  let H = createHistory(s(0), opts);
  for (let i = 1; i <= count; i++) H = push(H, s(i), `step ${i}`, 'light');
  return H;
};

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

test('a new history holds only the Original', () => {
  const H = createHistory(s(0));
  assert.equal(H.cap, DEFAULT_CAP);
  assert.equal(current(H).n, 0);
  assert.deepEqual(labels(H), [{ label: ORIGINAL, tool: null }]);
  assert.equal(canUndo(H), false);
  assert.equal(canRedo(H), false);
  assert.equal(undoLabel(H), null);
  assert.equal(redoLabel(H), null);
  assert.equal(H.mark, null);
  assert.throws(() => createHistory(null), TypeError);
  assert.throws(() => createHistory(s(0), { cap: 1 }), RangeError);
  assert.throws(() => createHistory(s(0), { cap: 2.5 }), RangeError);
  assert.throws(() => createHistory(s(0), { cap: Infinity }), RangeError);
});

test('push, undo and redo walk the snapshots with their labels', () => {
  let H = build(2);
  assert.deepEqual(labels(H), [{ label: 'Original', tool: null }, { label: 'step 1', tool: 'light' }, { label: 'step 2', tool: 'light' }]);
  assert.equal(undoLabel(H), 'step 2');
  H = undo(H);
  assert.equal(current(H).n, 1);
  assert.equal(undoLabel(H), 'step 1');
  assert.equal(redoLabel(H), 'step 2');
  assert.ok(canRedo(H));
  H = undo(undo(H));
  assert.equal(current(H).n, 0);
  H = redo(H);
  assert.equal(current(H).n, 1);
});

test('no-ops return the very same history object', () => {
  const H0 = createHistory(s(0));
  assert.equal(undo(H0), H0);
  assert.equal(redo(H0), H0);
  const H = build(3);
  assert.equal(redo(H), H);
  assert.equal(jumpTo(H, 3), H);
  assert.equal(jumpTo(H, NaN), H);
  assert.equal(jumpTo(H, '1'), H);
  assert.equal(jumpTo(H, 99), H); // clamps onto the current (last) entry
  assert.equal(push(H, current(H), 'again'), H);
  assert.equal(revertToMark(H), H);
  assert.equal(clearMark(H), H);
  const M = setMark(H);
  assert.equal(setMark(M), M);
});

test('pushing an equal copy of the state on screen records nothing and keeps redo', () => {
  // Regression: only the identical object was a no-op, so a rebuilt-but-equal state
  // (a straighten release at the same angle, a caption Done with no change) added a
  // step whose Undo showed no difference.
  const H = undo(build(3));
  const copy = push(H, { ...current(H) }, 'copy', 'light');
  assert.equal(copy, H);
  assert.ok(canRedo(copy), 'the redo branch survives');
  const d = createDoc({ id: 'doc', w: 400, h: 300 });
  const R = createHistory(d);
  const again = { ...d, crop: setAngle(d.crop, 400, 300, 0) };
  assert.notEqual(again.crop, d.crop);
  assert.equal(push(R, again, 'Straightened 0°', 'crop'), R);
  assert.equal(push(R, JSON.parse(JSON.stringify(d)), 'Edit'), R);
  // a real change, however small, still records
  const one = push(R, setIn(d, ['light', 'brightness'], 1), 'Brightness +1', 'light');
  assert.equal(one.entries.length, 2);
  assert.equal(push(one, { ...d, crop: setAngle(d.crop, 400, 300, 0.1) }, 'Straightened 0.1°').entries.length, 3);
});

test('push after undo discards the redo branch', () => {
  let H = undo(undo(build(4)));
  assert.deepEqual(states(H), [0, 1, 2, 3, 4]);
  H = push(H, s(9), 'branch');
  assert.deepEqual(states(H), [0, 1, 2, 9]);
  assert.equal(canRedo(H), false);
  assert.equal(H.index, 3);
});

test('labels and tools are cleaned', () => {
  let H = createHistory(s(0));
  H = push(H, s(1), '', '');
  H = push(H, s(2), undefined, 42);
  H = push(H, s(3), '   ');
  assert.deepEqual(labels(H).slice(1), [{ label: 'Edit', tool: null }, { label: 'Edit', tool: null }, { label: 'Edit', tool: null }]);
  assert.throws(() => push(H, null, 'x'), TypeError);
});

test('jumpTo lands anywhere and clamps scrubs past the ends', () => {
  const H = build(5);
  assert.equal(current(jumpTo(H, 2)).n, 2);
  assert.equal(current(jumpTo(H, 2.4)).n, 2);
  assert.equal(current(jumpTo(H, -3)).n, 0);
  assert.equal(current(jumpTo(H, -Infinity)).n, 0);
  assert.equal(current(jumpTo(jumpTo(H, 0), Infinity)).n, 5);
  assert.equal(jumpTo(H, 1).entries, H.entries, 'moving shares the entry list');
});

test('the cap drops the oldest steps but always keeps the Original', () => {
  let H = build(10, { cap: 5 });
  assert.equal(H.entries.length, 5);
  assert.deepEqual(states(H), [0, 7, 8, 9, 10]);
  assert.equal(H.entries[0].label, ORIGINAL);
  assert.equal(H.index, 4);
  assert.equal(current(H).n, 10);
  // the tape still reaches the real original photo
  assert.equal(current(jumpTo(H, 0)).n, 0);
  // capping after undo: redo was discarded first, then the oldest step dropped
  H = push(undo(undo(H)), s(11), 'x');
  assert.deepEqual(states(H), [0, 7, 8, 11]);
});

test('the cap never drops the open tool\'s mark, so Cancel still lands exactly', () => {
  let H = build(3, { cap: 4 });
  H = setMark(H); // tool opened on state 3
  assert.equal(H.mark, 3);
  for (let i = 4; i <= 12; i++) H = push(H, s(i), `step ${i}`);
  assert.ok(H.entries.length <= 4);
  assert.equal(H.entries[H.mark].state.n, 3);
  const C = revertToMark(H);
  assert.equal(current(C).n, 3);
  assert.deepEqual(states(C), [0, 3]);
  // cap 2 with the mark on entry 1: nothing is safe to drop, so it runs one over
  let T = setMark(push(createHistory(s(0), { cap: 2 }), s(1), 'a'));
  T = push(T, s(2), 'b');
  assert.deepEqual(states(T), [0, 1, 2]);
  assert.equal(current(revertToMark(T)).n, 1);
});

test('Cancel reverts to the mark, removes the session and clears redo', () => {
  let H = build(2);
  H = setMark(H);
  H = push(H, s(3), 'a');
  H = push(H, s(4), 'b');
  H = undo(H); // something to redo
  const C = revertToMark(H);
  assert.equal(current(C).n, 2);
  assert.deepEqual(states(C), [0, 1, 2]);
  assert.equal(canRedo(C), false);
  assert.equal(C.mark, 2);
  assert.equal(revertToMark(C), C, 'a second Cancel does nothing');
  // Done instead: keep the work, forget the mark
  const D = clearMark(H);
  assert.equal(D.mark, null);
  assert.equal(current(D).n, 3);
  assert.equal(revertToMark(D), D);
});

test('undo past the mark moves the mark down; redo does not move it back up', () => {
  let H = setMark(build(4)); // mark 4
  H = undo(undo(H)); // index 2
  assert.equal(H.mark, 2);
  H = redo(H);
  assert.equal(H.mark, 2);
  assert.equal(current(revertToMark(H)).n, 2);
  const J = jumpTo(setMark(build(4)), 1);
  assert.equal(J.mark, 1);
  // undo that stays at or above the mark leaves it alone
  let K = setMark(build(2));
  K = push(K, s(3), 'a');
  K = undo(K);
  assert.equal(K.mark, 2);
});

test('the invariants hold under random operation sequences', () => {
  const rng = mulberry32(42);
  for (let trial = 0; trial < 40; trial++) {
    const cap = 3 + Math.floor(rng() * 6);
    let H = createHistory(s(0), { cap });
    let next = 1;
    let markState = null; // the state the open tool started from, tracked independently
    for (let k = 0; k < 120; k++) {
      const r = rng();
      const before = H;
      if (r < 0.4) H = push(H, s(next++), 'x');
      else if (r < 0.55) H = undo(H);
      else if (r < 0.65) H = redo(H);
      else if (r < 0.72) H = jumpTo(H, Math.floor(rng() * (H.entries.length + 2)) - 1);
      else if (r < 0.8) { H = setMark(H); markState = current(H); }
      else if (r < 0.86) { H = clearMark(H); markState = null; }
      else if (r < 0.92) {
        H = revertToMark(H);
        // Cancel lands on the state the tool opened with (or the lowered mark's).
        if (markState) {
          assert.equal(current(H), markState, 'Cancel lands on the mark state');
          assert.equal(canRedo(H), false, 'Cancel clears redo');
        }
      } else {
        H = push(H, rng() < 0.5 ? current(H) : { ...current(H) }, 'same');
        assert.equal(H, before, 'pushing the state on screen is a no-op');
      }
      // a lowered mark follows the undo
      if (H.mark !== null && before.mark !== null && H.mark < before.mark) markState = H.entries[H.mark].state;
      assert.ok(H.entries.length <= cap, 'within the cap');
      assert.ok(Number.isInteger(H.index) && H.index >= 0 && H.index < H.entries.length);
      assert.ok(H.mark === null || (H.mark >= 0 && H.mark <= H.index), 'mark <= index');
      if (H.mark !== null && markState) assert.equal(H.entries[H.mark].state, markState, 'mark state survives');
      assert.equal(H.entries[0].state.n, 0, 'Original kept');
      assert.equal(H.entries[0].label, ORIGINAL);
      assert.ok(Object.isFrozen(H) && Object.isFrozen(H.entries));
    }
  }
});

test('histories are frozen and never mutated by operations', () => {
  const H = setMark(build(3));
  const snapshot = structuredClone(serialize(H));
  push(H, s(9), 'x');
  undo(H); redo(undo(H)); jumpTo(H, 0); revertToMark(push(H, s(8), 'y')); clearMark(H);
  assert.deepEqual(serialize(H), snapshot);
  assert.throws(() => { H.index = 0; }, TypeError);
  assert.throws(() => { H.entries.push(1); }, TypeError);
  assert.throws(() => { H.entries[0].label = 'x'; }, TypeError);
});

// ------------------------------------------------------------------ persistence

function realHistory() {
  const d0 = createDoc({ id: 'doc', sourceType: 'jpeg', w: 400, h: 300, now: 1 });
  let H = createHistory(d0);
  const step = (fn, tool) => {
    const prev = current(H);
    const next = fn(prev);
    H = push(H, next, describeChange(prev, next), tool);
  };
  step((d) => setIn(d, ['light', 'brightness'], 18), 'light');
  step((d) => setIn(d, ['light', 'shadows'], 24), 'light');
  step((d) => ({ ...d, remove: [...d.remove, 'p1'] }), 'remove');
  step((d) => ({ ...d, paint: [...d.paint, 's1'] }), 'light');
  step((d) => setIn(d, ['color', 'look'], 'film'), 'color');
  H = setMark(undo(H));
  step((d) => ({ ...d, remove: [...d.remove, 'p2'] }), 'remove');
  return H;
}

test('serialize and revive round-trip through JSON exactly', () => {
  const H = realHistory();
  const text = JSON.stringify(serialize(H));
  const R = revive(JSON.parse(text));
  assert.deepEqual(serialize(R), JSON.parse(text));
  assert.deepEqual(current(R), current(H));
  assert.deepEqual(labels(R), labels(H));
  assert.equal(R.index, H.index);
  assert.equal(R.mark, H.mark);
  assert.equal(R.cap, H.cap);
  assert.deepEqual(labels(R).map((l) => l.label), ['Original', 'Brightness +18', 'Shadows +24', 'Removed spot', 'Painted light', 'Removed spot']);
  // a JSON string is accepted too
  assert.deepEqual(serialize(revive(text)), JSON.parse(text));
});

test('revive restores structural sharing between neighbouring snapshots', () => {
  const R = revive(JSON.parse(JSON.stringify(serialize(realHistory()))));
  const [e0, e1, e2] = R.entries.map((e) => e.state);
  assert.equal(e1.color, e0.color, 'untouched branch shared');
  assert.equal(e1.crop, e0.crop);
  assert.notEqual(e1.light, e0.light);
  assert.equal(e2.remove, e1.remove);
  // structured clone keeps identical snapshots identical; revive does not split them
  const shared = createDoc({ id: 'd', w: 10, h: 10 });
  const raw = { v: 1, cap: 10, index: 1, mark: null, entries: [{ state: shared, label: 'Original' }, { state: shared, label: 'x' }] };
  const S = revive(raw);
  assert.equal(S.entries[0].state, S.entries[1].state);
});

test('revive repairs scalars and rejects unusable records', () => {
  const good = JSON.parse(JSON.stringify(serialize(realHistory())));
  const last = good.entries.length - 1;
  assert.equal(revive({ ...good, index: 99 }).index, last);
  assert.equal(revive({ ...good, index: 'x' }).index, last);
  assert.equal(revive({ ...good, index: -4 }).index, 0);
  assert.equal(revive({ ...good, mark: 99 }).mark, null);
  assert.equal(revive({ ...good, mark: 1.5 }).mark, null);
  assert.equal(revive({ ...good, index: 1, mark: 3 }).mark, null, 'a mark above the index is corrupt');
  assert.equal(revive({ ...good, cap: 'big' }).cap, DEFAULT_CAP);
  const relabelled = revive({ ...good, entries: good.entries.map((e, i) => ({ ...e, label: i === 0 ? 'Hacked' : 7, tool: {} })) });
  assert.deepEqual(labels(relabelled).slice(0, 2), [{ label: 'Original', tool: null }, { label: 'Edit', tool: null }]);
  const capped = revive({ ...good, cap: 3, mark: null });
  assert.equal(capped.entries.length, 3);
  assert.deepEqual(current(capped), current(revive(good)));
  assert.throws(() => revive(null), /not an object/);
  assert.throws(() => revive([]), /not an object/);
  assert.throws(() => revive({ ...good, v: 2 }), /version/);
  assert.throws(() => revive({ ...good, entries: [] }), /no entries/);
  assert.throws(() => revive({ ...good, entries: [null] }), /entry 0/);
  assert.throws(() => revive({ ...good, entries: [...good.entries, { state: { v: 1 }, label: 'bad' }] }), /doc:/);
  assert.throws(() => revive('{'), SyntaxError);
});

test('revive takes a custom state reviver', () => {
  const raw = { cap: 5, index: 1, mark: 0, entries: [{ state: { n: 0 } }, { state: { n: 1 }, label: 'one' }] };
  const R = revive(raw, { reviveState: (x) => ({ n: Number(x.n) }) });
  assert.equal(current(R).n, 1);
  assert.equal(R.mark, 0);
  assert.throws(() => revive(raw, { reviveState: () => 5 }), /no state/);
});

test('referencedIds covers every entry, including the redo branch', () => {
  let H = createHistory({ paint: [], remove: [] });
  H = push(H, { paint: ['s1'], remove: [] }, 'a');
  H = push(H, { paint: ['s1'], remove: ['p1'] }, 'b');
  H = push(H, { paint: ['s1', 's2'], remove: ['p1', 'p2'] }, 'c');
  H = undo(undo(H));
  const ids = referencedIds(H);
  assert.deepEqual([...ids.strokes].sort(), ['s1', 's2']);
  assert.deepEqual([...ids.patches].sort(), ['p1', 'p2']);
  // after a new branch the old redo steps are unreferenced, so their blobs can go
  H = push(H, { paint: ['s1'], remove: ['p3'] }, 'd');
  const after = referencedIds(H);
  assert.deepEqual([...after.strokes].sort(), ['s1']);
  assert.deepEqual([...after.patches].sort(), ['p3']);
  // states without lists are tolerated
  assert.deepEqual(referencedIds(createHistory({})).strokes.size, 0);
});
