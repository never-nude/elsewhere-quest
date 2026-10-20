import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialHistory, makeEntry, record, canUndo, canRedo, undoLabel, redoLabel,
  undo, redo, collapse, rollback,
} from '../lib/history.js';

const doc = (v) => ({ v });
const step = (label, a, b, patches) => makeEntry({ label, before: doc(a), after: doc(b), patches });

test('empty history has nothing to undo or redo', () => {
  const h = initialHistory();
  assert.equal(canUndo(h), false);
  assert.equal(canRedo(h), false);
  assert.equal(undo(h), null);
  assert.equal(redo(h), null);
  assert.equal(undoLabel(h), null);
});

test('record, undo and redo walk the steps with their labels', () => {
  let h = initialHistory();
  h = record(h, step('Brighter', 0, 1));
  h = record(h, step('Crop', 1, 2));
  assert.equal(undoLabel(h), 'Crop');
  const u = undo(h);
  assert.equal(u.entry.label, 'Crop');
  assert.deepEqual(u.entry.before, doc(1));
  h = u.history;
  assert.equal(undoLabel(h), 'Brighter');
  assert.equal(redoLabel(h), 'Crop');
  const r = redo(h);
  assert.deepEqual(r.entry.after, doc(2));
  assert.equal(canRedo(r.history), false);
});

test('a new step after undo discards redo and frees its bytes', () => {
  const px = new Uint8ClampedArray(1000);
  let h = initialHistory();
  h = record(h, step('Paint', 0, 1, [{ layer: 'draw', rect: {}, before: px, after: px }]));
  assert.equal(h.bytes, 2000);
  h = undo(h).history;
  h = record(h, step('Text', 0, 2));
  assert.equal(canRedo(h), false);
  assert.equal(h.bytes, 0);
});

test('makeEntry counts ImageData-like and typed-array buffers', () => {
  const e = makeEntry({ label: 'x', before: 0, after: 1, patches: [
    { before: { data: new Uint8ClampedArray(400) }, after: new Uint8Array(100) },
  ] });
  assert.equal(e.bytes, 500);
});

test('budget drops the oldest steps first', () => {
  const big = new Uint8Array(600);
  let h = initialHistory();
  const limits = { maxBytes: 2500, maxSteps: 100 };
  for (let i = 0; i < 5; i++) h = record(h, step(`s${i}`, i, i + 1, [{ before: big, after: big }]), limits);
  assert.ok(h.bytes <= 2500);
  assert.equal(h.past.length, 2);
  assert.equal(h.past[0].label, 's3');
});

test('step limit applies, and protected steps survive', () => {
  let h = initialHistory();
  for (let i = 0; i < 5; i++) h = record(h, step(`s${i}`, i, i + 1), { maxBytes: Infinity, maxSteps: 3 });
  assert.deepEqual(h.past.map((e) => e.label), ['s2', 's3', 's4']);
  // A session opened at depth 1 protects past[1..]: only one old step may drop.
  let g = initialHistory();
  for (let i = 0; i < 3; i++) g = record(g, step(`t${i}`, i, i + 1), { maxBytes: Infinity, maxSteps: 2 }, 1);
  assert.ok(g.past.length >= 2);
});

test('the newest step is kept even if it alone exceeds the budget', () => {
  const huge = new Uint8Array(10_000);
  const h = record(initialHistory(), step('Remove', 0, 1, [{ before: huge, after: huge }]), { maxBytes: 100, maxSteps: 10 });
  assert.equal(h.past.length, 1);
});

test('collapse merges a tool session into one named step', () => {
  let h = record(initialHistory(), step('Crop', 0, 1));
  const depth = h.past.length;
  h = record(h, step('Brightness', 1, 2, [{ before: new Uint8Array(4), after: new Uint8Array(4) }]));
  h = record(h, step('Contrast', 2, 3, [{ before: new Uint8Array(8), after: new Uint8Array(8) }]));
  h = collapse(h, depth, 'Light');
  assert.equal(h.past.length, 2);
  const merged = h.past[1];
  assert.equal(merged.label, 'Light');
  assert.deepEqual(merged.before, doc(1));
  assert.deepEqual(merged.after, doc(3));
  assert.equal(merged.patches.length, 2);
  assert.equal(merged.bytes, 24);
  assert.equal(collapse(h, h.past.length, 'x'), h); // nothing to merge
});

test('rollback returns the session newest-first and forgets it', () => {
  let h = record(initialHistory(), step('Crop', 0, 1));
  const depth = h.past.length;
  h = record(h, step('A', 1, 2, [{ before: new Uint8Array(10), after: new Uint8Array(10) }]));
  h = record(h, step('B', 2, 3));
  const rb = rollback(h, depth);
  assert.deepEqual(rb.entries.map((e) => e.label), ['B', 'A']);
  assert.deepEqual(rb.history.past.map((e) => e.label), ['Crop']);
  assert.equal(rb.history.bytes, 0);
  assert.equal(rollback(rb.history, depth), null);
});

test('history objects are never mutated', () => {
  const h0 = record(initialHistory(), step('A', 0, 1));
  const frozen = structuredClone(h0);
  record(h0, step('B', 1, 2));
  undo(h0);
  collapse(h0, 0, 'x');
  rollback(h0, 0);
  assert.deepEqual(h0, frozen);
});
