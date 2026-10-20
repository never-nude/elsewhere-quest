// Undo/redo as a list of whole-document snapshots (SPEC §5.5). Pure and immutable:
// every operation returns a new history, and a no-op returns the same object, so
// callers can skip re-rendering by identity.
//
// H = { entries: [{ state, label, tool }], index, mark, cap }
//   entries[0]  the photo as opened, labelled 'Original'. It is never dropped, so
//               undo and the rewind tape can always get back to it.
//   index       the entry on screen.
//   mark        where the open tool's session started (setMark), or null. Cancel
//               (revertToMark) goes back there. Invariant: mark <= index.
//   cap         maximum number of entries.
//
// Snapshots are cheap because DocStates share structure and refer to stroke and
// patch bodies by id. Undo never needs the inverse of an edit: the renderer is
// handed the target snapshot and reconciles (lib/patches.js for Remove tiles).

import { reviveDoc, deepEqual } from './doc.js';

export const DEFAULT_CAP = 300;
export const ORIGINAL = 'Original';

function make(entries, index, mark, cap) {
  return Object.freeze({ entries: Object.freeze(entries), index, mark, cap });
}

function entry(state, label, tool) {
  return Object.freeze({ state, label, tool });
}

function checkCap(cap) {
  if (!Number.isInteger(cap) || cap < 2) throw new RangeError(`history: cap must be an integer >= 2, got ${String(cap)}`);
}

function cleanLabel(label) {
  return typeof label === 'string' && label.trim() !== '' ? label : 'Edit';
}

function cleanTool(tool) {
  return typeof tool === 'string' && tool !== '' ? tool : null;
}

export function createHistory(state, { cap = DEFAULT_CAP } = {}) {
  checkCap(cap);
  if (state === null || typeof state !== 'object') throw new TypeError('history: the initial state must be an object');
  return make([entry(state, ORIGINAL, null)], 0, null, cap);
}

// Record a step. Anything that was undone (the redo branch) is discarded. Pushing
// the state already on screen records nothing and keeps the redo branch, whether
// it is the same object or an equal copy: tools rebuild objects freely (setAngle
// at an unchanged angle, a caption Done with no change), and such a release must
// not leave a step whose Undo shows no difference ("Undid: Edit").
// Snapshots share structure, so deepEqual stops at the first shared branch.
export function push(H, state, label, tool = null) {
  if (state === null || typeof state !== 'object') throw new TypeError('history: state must be an object');
  const now = current(H);
  if (state === now || deepEqual(state, now)) return H;
  const entries = H.entries.slice(0, H.index + 1);
  entries.push(entry(state, cleanLabel(label), cleanTool(tool)));
  return withCap(entries, entries.length - 1, H.mark, H.cap);
}

// Over the cap, drop the oldest step — but never the Original (the tape must reach
// it), the entry on screen, or the open tool's mark (Cancel must land exactly where
// the tool opened). Dropping entry k folds its change into entry k+1: both are
// whole snapshots, so nothing is lost but one name on the tape. With cap 2 and a
// mark on entry 1 there is nothing safe to drop, and the list runs one over.
function withCap(entries, index, mark, cap) {
  while (entries.length > cap) {
    let drop = -1;
    for (let i = 1; i < entries.length - 1; i++) if (i !== mark && i !== index) { drop = i; break; }
    if (drop < 0) break;
    entries.splice(drop, 1);
    if (index > drop) index--;
    if (mark !== null && mark > drop) mark--;
  }
  return make(entries, index, mark, cap);
}

// Moving below the mark means the tool session now began earlier: the mark
// follows, so Cancel never jumps forward past what the user has undone.
function moveTo(H, i) {
  const mark = H.mark !== null && H.mark > i ? i : H.mark;
  return make(H.entries, i, mark, H.cap);
}

export function undo(H) {
  return H.index > 0 ? moveTo(H, H.index - 1) : H;
}

export function redo(H) {
  return H.index < H.entries.length - 1 ? moveTo(H, H.index + 1) : H;
}

// The rewind tape. Scrubbing past either end lands on that end; a non-number is
// ignored.
export function jumpTo(H, i) {
  if (typeof i !== 'number' || Number.isNaN(i)) return H;
  const j = Math.max(0, Math.min(H.entries.length - 1, Math.round(i)));
  return j === H.index ? H : moveTo(H, j);
}

export function canUndo(H) {
  return H.index > 0;
}

export function canRedo(H) {
  return H.index < H.entries.length - 1;
}

export function current(H) {
  return H.entries[H.index].state;
}

// What Undo would undo ("Undid: Shadows +24"), or null at the Original.
export function undoLabel(H) {
  return H.index > 0 ? H.entries[H.index].label : null;
}

export function redoLabel(H) {
  return H.index < H.entries.length - 1 ? H.entries[H.index + 1].label : null;
}

// The rewind tape's rows, oldest first; row 0 is always 'Original'.
export function labels(H) {
  return H.entries.map((e) => ({ label: e.label, tool: e.tool }));
}

// A tool opened: Cancel will come back to this entry.
export function setMark(H) {
  return H.mark === H.index ? H : make(H.entries, H.index, H.index, H.cap);
}

// Done (or leaving the tool by any other way that keeps its work).
export function clearMark(H) {
  return H.mark === null ? H : make(H.entries, H.index, null, H.cap);
}

// Cancel: back to the mark, and the session's steps are gone — including any that
// were undone, so there is nothing to redo into. The mark stays, so a second
// Cancel is a no-op.
export function revertToMark(H) {
  const m = H.mark;
  if (m === null) return H;
  if (H.index === m && H.entries.length === m + 1) return H;
  return make(H.entries.slice(0, m + 1), m, m, H.cap);
}

// ------------------------------------------------------------------ persistence

export function serialize(H) {
  return {
    v: 1,
    cap: H.cap,
    index: H.index,
    mark: H.mark,
    entries: H.entries.map((e) => ({ state: e.state, label: e.label, tool: e.tool })),
  };
}

// Rebuild a history from storage. Each snapshot goes through `reviveState`
// (reviveDoc by default), which throws on an unusable one; the editor then
// discards the draft rather than resume something half-broken. Scalars are
// repaired instead: a bad index lands on the newest entry, a bad mark is dropped,
// and the cap is re-applied.
export function revive(json, { reviveState = reviveDoc } = {}) {
  const raw = typeof json === 'string' ? JSON.parse(json) : json;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('history: not an object');
  if (raw.v !== undefined && raw.v !== 1) throw new Error(`history: unsupported version ${String(raw.v)}`);
  if (!Array.isArray(raw.entries) || raw.entries.length === 0) throw new Error('history: no entries');
  const cap = Number.isInteger(raw.cap) && raw.cap >= 2 ? raw.cap : DEFAULT_CAP;

  // Structured clone (IndexedDB) keeps shared references; reviving each entry
  // separately would not. Revive each distinct raw snapshot once, then re-share
  // unchanged branches with the previous entry so the history is as small in
  // memory as the one that was saved.
  const memo = new Map();
  let prev = null;
  const entries = raw.entries.map((e, i) => {
    if (e === null || typeof e !== 'object') throw new Error(`history: entry ${i} is not an object`);
    let state = e.state !== null && typeof e.state === 'object' ? memo.get(e.state) : undefined;
    if (!state) {
      state = share(prev, reviveState(e.state));
      if (state === null || typeof state !== 'object') throw new Error(`history: entry ${i} has no state`);
      if (e.state !== null && typeof e.state === 'object') memo.set(e.state, state);
    }
    prev = state;
    return i === 0 ? entry(state, ORIGINAL, null) : entry(state, cleanLabel(e.label), cleanTool(e.tool));
  });

  const last = entries.length - 1;
  const index = Number.isInteger(raw.index) ? Math.max(0, Math.min(last, raw.index)) : last;
  const mark = Number.isInteger(raw.mark) && raw.mark >= 0 && raw.mark <= index ? raw.mark : null;
  return withCap(entries, index, mark, cap);
}

function share(prev, next) {
  if (!isPlain(prev) || !isPlain(next)) return next;
  const out = {};
  let same = Object.keys(prev).length === Object.keys(next).length;
  for (const k of Object.keys(next)) {
    const reuse = Object.hasOwn(prev, k) && deepEqual(prev[k], next[k]);
    out[k] = reuse ? prev[k] : next[k];
    if (!reuse) same = false;
  }
  return same ? prev : out;
}

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Every stroke and patch id any entry refers to, redo branch included: blobs not
// in these sets can be garbage-collected (§5.6).
export function referencedIds(H) {
  const strokes = new Set(), patches = new Set();
  const seen = new Set(); // shared arrays only need one pass
  const add = (list, into) => {
    if (!Array.isArray(list) || seen.has(list)) return;
    seen.add(list);
    for (const id of list) into.add(id);
  };
  for (const { state } of H.entries) {
    add(state?.paint, strokes);
    add(state?.remove, patches);
  }
  return { strokes, patches };
}
