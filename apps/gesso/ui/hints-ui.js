// Earned hints on screen (SPEC F17). lib/hints.js decides which hint a behaviour
// event earns; this shows it in the panel's hint line for HINT_MS, once ever. The id
// is stored under HINTS_KEY the moment it shows, so no reload repeats it. Counters
// live in memory for the session only (H5 is "third Undo in a session").
//
// One hint at a time: a hint earned while another is still up is neither shown nor
// marked, so it gets its next chance (lib/hints.js thresholds are "at least"). A
// hint earned while the panel is faded under a ruler or photo drag, or covered by
// the rewind tape, waits for the panel to come back, so it is read at full
// strength for its whole time. One earned under the Save sheet or the keyboard is
// dropped instead (also unmarked): by the time those go, its moment has passed.
//
// The decision waits for the handler that earned the hint to finish (`defer`, a
// microtask): Save asks for H11 as it closes the tool, then raises its sheet.
//
// Events reach here through ed.hint(name, data); names lib/hints.js does not know
// ('pinch', 'first-ruler-drag') are counted as nothing.

import { observe, initialCounters, reviveShown, markShown, hintById, HINT_MS, HINTS_KEY, PHOTO_DRAG_KEY } from '../lib/hints.js';
import { TAPED } from './tape.js';
import { subjectLiftAvailable } from './platform.js';

const HIDDEN_BY = ['is-faded', TAPED]; // #panel classes under which a tip can't be read

export function createHints(getEditor, {
  storage = browserStorage(),
  now = () => Date.now(),
  panelEl = () => globalThis.document?.getElementById('panel') ?? null,
  watchFade = domWatch,
  // Surfaces that hide the whole panel: the Save sheet, its touch-and-hold
  // fallback, and the Text edit bar (the keyboard is up under it).
  covers = () => ['sheet', 'fallback', 'editbar'].map((id) => globalThis.document?.getElementById(id)),
  defer = (fn) => queueMicrotask(fn),
} = {}) {
  let counters = initialCounters();
  let shown = reviveShown(read(storage, HINTS_KEY));
  let upUntil = 0;
  let pending = null;
  let unwatch = null;

  const isFaded = () => {
    const list = panelEl()?.classList;
    return !!list && HIDDEN_BY.some((c) => list.contains(c));
  };

  function show(id) {
    const h = hintById(id);
    const panel = getEditor?.()?.panel;
    if (!h || !panel) return false;
    // Another tab, or this one before a reload, may have shown it since we loaded.
    shown = reviveShown([...reviveShown(read(storage, HINTS_KEY)), ...shown]);
    if (shown.includes(id)) return false;
    shown = markShown(shown, id);
    write(storage, HINTS_KEY, JSON.stringify(shown));
    if (h.sideEffect === 'photoDrag') write(storage, PHOTO_DRAG_KEY, '1');
    panel.showTip(id === 'H15' && subjectLiftAvailable() ? 'Tap it, or loop around it. The line snaps to edges.' : h.text, HINT_MS);
    upUntil = now() + HINT_MS;
    return true;
  }

  // Show `id` now, hold it for the panel, or drop it. `pending` is cleared here
  // and set again only while it waits for a fade or the tape.
  function offer(id) {
    pending = null;
    // A fill can land after Save was tapped or Text was opened: marked under the
    // sheet or the keyboard, the hint would never be read.
    if (covers().some((el) => el && !el.hidden)) return false;
    if (isFaded()) {
      unwatch = watchFade(panelEl(), release);
      if (unwatch) {
        pending = id;
        return false;
      }
    }
    return show(id);
  }

  function release() {
    if (isFaded()) return;
    unwatch?.();
    unwatch = null;
    if (pending) offer(pending);
  }

  return {
    // Returns the id shown, when `defer` runs at once (tests); in the app the
    // decision comes a microtask later and this returns null.
    event(name, data) {
      const e = data && typeof data === 'object' ? { ...data, name } : name;
      const r = observe(counters, e, shown);
      counters = r.counters;
      const id = r.hint;
      if (!id || pending || now() < upUntil) return null;
      pending = id;
      let result = null;
      defer(() => {
        if (pending === id && !unwatch) result = offer(id) ? id : null;
      });
      return result;
    },
    // For tests and the probe: what has been shown ever, and whether one is up now.
    get shown() { return [...shown]; },
    get showing() { return now() < upUntil; },
    get pending() { return pending; },
  };
}

function domWatch(el, onChange) {
  if (!el || typeof MutationObserver !== 'function') return null;
  const mo = new MutationObserver(onChange);
  mo.observe(el, { attributes: true, attributeFilter: ['class'] });
  return () => mo.disconnect();
}

function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage blocked: hints still show, just not remembered
  }
}

function read(storage, key) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage, key, value) {
  try {
    storage?.setItem(key, value);
  } catch {
    /* private mode or full: memory only */
  }
}
