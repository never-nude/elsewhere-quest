// Earned hints on screen (SPEC F17). lib/hints.js decides which hint a behaviour
// event earns; this shows it in the panel's hint line for HINT_MS, once ever. The id
// is stored under HINTS_KEY the moment it shows, so no reload repeats it. Counters
// live in memory for the session only (H5 is "third Undo in a session").
//
// One hint at a time: a hint earned while another is still up is neither shown nor
// marked, so it gets its next chance (lib/hints.js thresholds are "at least"). A
// hint earned while the panel is faded under a ruler or photo drag, or covered by
// the rewind tape, waits for the panel to come back, so it is read at full
// strength for its whole time.
//
// Events reach here through ed.hint(name, data); names lib/hints.js does not know
// ('pinch', 'first-ruler-drag') are counted as nothing.

import { observe, initialCounters, reviveShown, markShown, hintById, HINT_MS, HINTS_KEY, PHOTO_DRAG_KEY } from '../lib/hints.js';
import { TAPED } from './tape.js';

const HIDDEN_BY = ['is-faded', TAPED]; // #panel classes under which a tip can't be read

export function createHints(getEditor, {
  storage = browserStorage(),
  now = () => Date.now(),
  panelEl = () => globalThis.document?.getElementById('panel') ?? null,
  watchFade = domWatch,
  // Surfaces that hide the whole panel: the Save sheet, its touch-and-hold
  // fallback, and the Text edit bar (the keyboard is up under it).
  covers = () => ['sheet', 'fallback', 'editbar'].map((id) => globalThis.document?.getElementById(id)),
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
    panel.showTip(h.text, HINT_MS);
    upUntil = now() + HINT_MS;
    return true;
  }

  function release() {
    if (isFaded()) return;
    unwatch?.();
    unwatch = null;
    const id = pending;
    pending = null;
    if (id) show(id);
  }

  return {
    event(name, data) {
      const e = data && typeof data === 'object' ? { ...data, name } : name;
      const r = observe(counters, e, shown);
      counters = r.counters;
      const id = r.hint;
      if (!id || pending || now() < upUntil) return null;
      // A fill can land after Save was tapped or Text was opened. Under the sheet or
      // the keyboard the hint would be marked but never read; dropped, it gets its
      // next chance.
      if (covers().some((el) => el && !el.hidden)) return null;
      if (isFaded()) {
        unwatch = watchFade(panelEl(), release);
        if (unwatch) {
          pending = id;
          return null;
        }
      }
      return show(id) ? id : null;
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
