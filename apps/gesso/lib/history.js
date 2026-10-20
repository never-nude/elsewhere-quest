// Undo/redo as plain data. Pure: no DOM, no clocks.
//
// An entry is { label, before, after, patches, bytes }:
//   before/after  document snapshots (small, immutable objects the caller owns)
//   patches       raster changes [{ layer, rect, before, after }] whose pixel
//                 buffers the caller restores; undo applies them in reverse order
//   bytes         memory the entry pins (pixel buffers), for the budget
//
// A tool session (open a tool -> Done/Cancel) is bracketed by its starting depth:
// Done collapses everything since into one named step, Cancel rolls it back.

export const DEFAULT_LIMITS = { maxBytes: 96 * 1024 * 1024, maxSteps: 80 };

export function initialHistory() {
  return { past: [], future: [], bytes: 0 };
}

export function makeEntry({ label, before, after, patches = [] }) {
  let bytes = 0;
  for (const p of patches) bytes += byteSize(p.before) + byteSize(p.after);
  return { label, before, after, patches, bytes };
}

function byteSize(buf) {
  if (!buf) return 0;
  if (typeof buf.byteLength === 'number') return buf.byteLength;
  if (buf.data && typeof buf.data.byteLength === 'number') return buf.data.byteLength;
  return 0;
}

// Push a new step. Redo history is discarded (and its bytes freed). The oldest
// steps fall off when the budget is exceeded — but never `protect` steps or newer,
// so an open tool session can't lose its own start point.
export function record(history, entry, limits = DEFAULT_LIMITS, protect = Infinity) {
  const past = [...history.past, entry];
  let bytes = history.bytes - sumBytes(history.future) + entry.bytes;
  let dropped = 0;
  while (past.length > 1 && dropped < protect && (bytes > limits.maxBytes || past.length > limits.maxSteps)) {
    bytes -= past.shift().bytes;
    dropped++;
  }
  return { past, future: [], bytes, dropped };
}

export function canUndo(history) {
  return history.past.length > 0;
}

export function canRedo(history) {
  return history.future.length > 0;
}

export function undoLabel(history) {
  return history.past.length ? history.past[history.past.length - 1].label : null;
}

export function redoLabel(history) {
  return history.future.length ? history.future[0].label : null;
}

// Returns { history, entry } — the caller restores entry.before and applies the
// patches' `before` buffers in reverse — or null when there is nothing to undo.
export function undo(history) {
  if (!history.past.length) return null;
  const entry = history.past[history.past.length - 1];
  return {
    entry,
    history: { past: history.past.slice(0, -1), future: [entry, ...history.future], bytes: history.bytes },
  };
}

// Returns { history, entry } — the caller restores entry.after and applies the
// patches' `after` buffers in order — or null.
export function redo(history) {
  if (!history.future.length) return null;
  const entry = history.future[0];
  return {
    entry,
    history: { past: [...history.past, entry], future: history.future.slice(1), bytes: history.bytes },
  };
}

// Done: merge every step since `depth` (a past.length captured when the tool
// opened) into one. Nothing recorded -> history is returned unchanged.
export function collapse(history, depth, label) {
  const tail = history.past.slice(depth);
  if (tail.length === 0) return history;
  const merged = {
    label: label ?? tail[tail.length - 1].label,
    before: tail[0].before,
    after: tail[tail.length - 1].after,
    patches: tail.flatMap((e) => e.patches),
    bytes: sumBytes(tail),
  };
  return { ...history, past: [...history.past.slice(0, depth), merged] };
}

// Cancel: drop every step since `depth`. Returns { history, entries } where entries
// are newest-first, ready to be undone in that order (or null if nothing to roll back).
export function rollback(history, depth) {
  const tail = history.past.slice(depth);
  if (tail.length === 0) return null;
  return {
    entries: tail.reverse(),
    history: { past: history.past.slice(0, depth), future: [], bytes: history.bytes - sumBytes(tail) - sumBytes(history.future) },
  };
}

function sumBytes(entries) {
  let n = 0;
  for (const e of entries) n += e.bytes;
  return n;
}
