// Earned hints (SPEC F17, §4). A hint appears once, ever, at the moment the user's
// behaviour shows it would help; never on a timer, never as a tutorial. This module
// is the data and the pure decision; ui/hints-ui.js shows the text in the panel's
// header hint slot for HINT_MS and persists the shown ids under HINTS_KEY.
//
// Flow for every behaviour event:
//   counters = countEvent(counters, event)          // per-session counts (memory only)
//   id = nextHint(event, counters, shown)           // shown ids persist across sessions
// or both at once with observe(). Events are a name, or { name, ...data }:
//
//   'ruler-drag'   { tool }   a ruler drag (any ruler, any tool; once per drag)
//   'before-tap'              the Before button was tapped
//   'before-hold'             the Before button was held
//   'hold-photo'   { tool }   a still hold on the photo showed Before
//   'undo'                    Undo was tapped
//   'heal'                    a tapped spot was healed (Remove)
//   'rub-fill'                a rubbed area was filled (Remove)
//   'try-another'             Try another was tapped (Remove)
//   'caption-done'            the caption edit bar's Done was tapped
//   'home-with-caption'       the panel returned to Home with a caption on the photo
//   'ratio-chip'              the 4:5 or 16:9 chip was tapped (Crop)
//   'paint-select'            the Paint dial was selected (Light)
//   'auto-enhance'            Auto-enhance was tapped (Home)
// These are the names ui/editor.js and ui/tools/* emit; any other name is ignored.

export const HINT_MS = 4000;
export const HINTS_KEY = 'gesso:hints'; // localStorage: JSON array of shown ids
export const PHOTO_DRAG_KEY = 'gesso:photoDrag'; // localStorage: set by H1's side effect

function deepFreeze(o) {
  Object.freeze(o);
  for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  return o;
}

// What a session counts. `match` narrows an event by its data: every listed field
// must hold one of the listed values.
export const COUNTERS = deepFreeze({
  rulerDrag: { event: 'ruler-drag' },
  rulerDragLightColor: { event: 'ruler-drag', match: { tool: ['light', 'color'] } },
  beforeTap: { event: 'before-tap' },
  beforeHold: { event: 'before-hold' },
  undoTap: { event: 'undo' },
  heal: { event: 'heal' },
  rubFill: { event: 'rub-fill' },
  tryAnother: { event: 'try-another' },
  photoHoldRemove: { event: 'hold-photo', match: { tool: ['remove'] } },
  captionDone: { event: 'caption-done' },
  homeWithCaption: { event: 'home-with-caption' },
  ratioChip: { event: 'ratio-chip' },
  paintSelect: { event: 'paint-select' },
  autoEnhance: { event: 'auto-enhance' },
});

// SPEC §4 hints table. A hint is eligible on its trigger event when the event itself
// qualifies for `counter` and that count is within [min, max] (max null = no limit).
// Thresholds are "at least", not "exactly", so a hint that could not show on its
// first chance (another hint was up) gets the next one; only H3 has a window.
// sideEffect: 'photoDrag' means set PHOTO_DRAG_KEY when the hint shows (SPEC F6).
const hint = (id, trigger, counter, min, max, when, text, sideEffect = null) => ({ id, trigger, counter, min, max, when, text, sideEffect });

export const HINTS = deepFreeze([
  hint('H1', 'ruler-drag', 'rulerDragLightColor', 1, null, 'first ruler drag in Light or Color', 'Tip: you can also drag sideways on the photo.', 'photoDrag'),
  hint('H2', 'ruler-drag', 'rulerDrag', 2, null, 'second ruler drag', 'Double-tap the ruler to reset.'),
  hint('H3', 'before-tap', 'beforeTap', 1, 2, 'each of the first 2 taps on Before', 'Hold to compare.'),
  hint('H4', 'before-hold', 'beforeHold', 1, null, 'first Before-button hold', 'You can also hold the photo. Slide to wipe.'),
  hint('H5', 'undo', 'undoTap', 3, null, 'third Undo tap in a session', 'Hold Undo to rewind through every step.'),
  hint('H6', 'heal', 'heal', 1, null, 'first heal', 'Pinch to zoom in on small things.'),
  hint('H7', 'rub-fill', 'rubFill', 1, null, 'first rub fill', 'Not quite right? Tap Try another.'),
  hint('H8', 'try-another', 'tryAnother', 2, null, 'second Try another', 'Tap Source to choose where to copy from.'),
  hint('H9', 'hold-photo', 'photoHoldRemove', 1, null, 'a Before-hold while in Remove', 'Quick tap to remove. Holding shows the original.'),
  hint('H10', 'caption-done', 'captionDone', 1, null, 'first caption Done', 'Drag to move · pinch to resize · tap it to edit.'),
  hint('H11', 'home-with-caption', 'homeWithCaption', 1, null, 'first return to Home with a caption present', 'Tap a caption anytime to edit it.'),
  hint('H12', 'ratio-chip', 'ratioChip', 1, null, 'first 4:5 or 16:9 tap', 'Tap Tall/Wide to turn the frame.'),
  hint('H13', 'paint-select', 'paintSelect', 1, null, 'first Paint selection', 'Paint with one finger. Paint again to build it up.'),
  hint('H14', 'auto-enhance', 'autoEnhance', 1, null, 'first Auto-enhance', 'Tap a change to fine-tune it.'),
]);

const BY_ID = new Map(HINTS.map((h) => [h.id, h]));

export function hintById(id) {
  return BY_ID.get(id) ?? null;
}

// SPEC §4 gesture table: every gesture, and how a person finds it without being
// told — a visible control (a selector into the static chrome or panel) and/or the
// earned hint that teaches it. test/hints.test.mjs checks every row has one.
const g = (id, gesture, context, effect, visibleEquivalent, hintId) => ({ id, gesture, context, effect, visibleEquivalent, hint: hintId });

export const GESTURES = deepFreeze([
  g('tap-dock-tool', 'Tap dock tool', 'always', 'open; tap the active tool = Done; tap another = Done and switch', '#dock [data-tool]', null),
  g('tap-undo-redo', 'Tap Undo / Redo', 'always', 'one step; toast "Undid: …"', '#undo, #redo', null),
  g('hold-undo', 'Hold Undo 0.4s, slide', 'always', 'rewind tape through named steps; lift lands', '#undo', 'H5'),
  g('before-button', 'Hold / tap Before', 'always', 'Before until release / for 1.2s', '#before', 'H3'),
  g('hold-photo', 'Hold photo still 0.5s, slide', 'every tool', 'Before; sliding moves a wipe line', '#before', 'H4'),
  g('pinch-pan', 'Two-finger pinch / drag', 'photo, every tool', 'zoom 1–8× about the fingers / pan; below 1× springs to fit', '#zoom-pill, #navigator', 'H6'),
  g('navigator', 'Drag navigator frame / tap "Fit"', 'while zoomed', 'pan / fit', '#navigator, #zoom-pill', null),
  g('drag-ruler', 'Drag ruler', 'any ruler', 'relative adjust; slow is fine, fast is coarse; sticks at the default', '#ruler', null),
  g('double-tap-ruler', 'Double-tap ruler', 'any ruler', 'reset dial', '#ruler', 'H2'),
  g('scrub-photo', 'One-finger horizontal drag on photo', 'Light, Color (after the first ruler drag; Paint not selected)', 'adjust the selected dial, with a value bubble', '#ruler', 'H1'),
  g('paint-photo', 'One-finger drag on photo', 'Light with Paint selected', 'paint brighten / darken / erase', '[data-dial="paint"]', 'H13'),
  g('tap-caption-elsewhere', 'Tap caption', 'Home, Light, Color', 'open Text with that caption selected', null, 'H11'),
  // ui/tools/color.js names the Pick white chip 'pick'; this row has no hint to fall
  // back on, so the selector must match the real chip.
  g('pick-white', 'Press, then lift on photo', 'Color with Pick white', 'loupe; lift sets the white point', '[data-dial="pick"]', null),
  g('crop-handle', 'Drag corner / edge', 'Crop', 'resize (aspect kept if locked); thirds grid while touching', '#stage', null),
  g('crop-move', 'Drag inside frame', 'Crop', 'move the frame', '#panel', null),
  g('remove-tap', 'Tap photo', 'Remove', 'heal the spot at brush size', '#panel', null),
  g('remove-rub', 'One-finger drag on photo', 'Remove', 'paint the area; lift fills it', '#panel', null),
  g('remove-source', 'Drag dashed ring', 'Remove, Source selected', 'choose the copy source; lift re-fills', '[data-dial="source"]', 'H8'),
  g('text-tap-caption', 'Tap caption / tap the selected caption', 'Text', 'select / edit words (keyboard)', null, 'H10'),
  g('text-drag-caption', 'Drag caption', 'Text', 'move with centre and thirds snapping, with guide lines', null, 'H10'),
  g('text-handle', 'Drag corner handle', 'Text, selected caption', 'scale and rotate', '#stage', null),
  g('text-pinch', 'Pinch / twist starting on the selected caption', 'Text', 'size / angle', '[data-dial="size"], [data-dial="angle"]', 'H10'),
  g('text-tap-empty', 'Tap empty photo', 'Text', 'deselect', '#dock [data-tool="text"]', null),
  // The Save sheet's Keep editing button, as index.html names it (no hint either).
  g('sheet-swipe', 'Swipe down on grabber', 'Save sheet', 'close', '#sheet-keep', null),
]);

// ------------------------------------------------------------------ decisions

function normalize(event) {
  if (typeof event === 'string') return event ? { name: event } : null;
  if (event && typeof event === 'object' && typeof event.name === 'string' && event.name) return event;
  return null;
}

function qualifies(counter, e) {
  if (counter.event !== e.name) return false;
  if (!counter.match) return true;
  return Object.entries(counter.match).every(([field, values]) => values.includes(e[field]));
}

const countOf = (counters, key) => {
  const n = counters && typeof counters === 'object' ? counters[key] : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export function initialCounters() {
  return Object.fromEntries(Object.keys(COUNTERS).map((k) => [k, 0]));
}

// Count one behaviour event. Returns a new object when anything was counted, the
// input itself when nothing was (unknown or junk events).
export function countEvent(counters, event) {
  const e = normalize(event);
  const base = counters && typeof counters === 'object' ? counters : {};
  if (!e) return base;
  let next = null;
  for (const [key, c] of Object.entries(COUNTERS)) {
    if (!qualifies(c, e)) continue;
    next ??= { ...base };
    next[key] = countOf(base, key) + 1;
  }
  return next ?? base;
}

// The stored list may arrive as the raw localStorage string (reviveShown and
// markShown take that form too). Treating it as "nothing shown" would show every
// hint again on each launch, so a JSON string is parsed; anything else that is not
// a Set or an array means nothing shown.
function parseStored(raw) {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function toSet(shown) {
  const list = parseStored(shown);
  if (list instanceof Set) return list;
  if (Array.isArray(list)) return new Set(list);
  return new Set();
}

// The hint this event earns, or null. `counters` must already include this event
// (countEvent first, or use observe). `shown` (a Set, an array, or the stored JSON
// string) holds every id ever shown; a shown id never comes back. When an event
// earns two hints, the lower id wins and the other waits for its next chance.
export function nextHint(event, counters, shown) {
  const e = normalize(event);
  if (!e) return null;
  const seen = toSet(shown);
  for (const h of HINTS) {
    if (h.trigger !== e.name || seen.has(h.id)) continue;
    if (!qualifies(COUNTERS[h.counter], e)) continue;
    const n = countOf(counters, h.counter);
    if (n >= h.min && (h.max === null || n <= h.max)) return h.id;
  }
  return null;
}

// countEvent then nextHint, in the right order.
export function observe(counters, event, shown) {
  const next = countEvent(counters, event);
  return { counters: next, hint: nextHint(event, next, shown) };
}

// The shown ids as stored under HINTS_KEY, read defensively: a JSON string, an
// array or a Set; unknown ids, duplicates and junk are dropped. Returns ids in
// table order.
export function reviveShown(raw) {
  const have = toSet(raw);
  return HINTS.filter((h) => have.has(h.id)).map((h) => h.id);
}

// The shown list with `id` added (for storing back under HINTS_KEY).
export function markShown(shown, id) {
  const ids = reviveShown(shown instanceof Set ? [...shown] : shown);
  if (!BY_ID.has(id) || ids.includes(id)) return ids;
  return reviveShown([...ids, id]);
}
