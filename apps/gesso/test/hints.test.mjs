import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  HINTS, GESTURES, COUNTERS, HINT_MS, HINTS_KEY, PHOTO_DRAG_KEY,
  hintById, initialCounters, countEvent, nextHint, observe, reviveShown, markShown,
} from '../lib/hints.js';

// The DOM selectors the shared contract promises the UI provides. A visible
// equivalent may combine several with commas.
const CONTRACT = [
  /^#dock \[data-tool\]$/,
  /^#dock \[data-tool="(crop|light|color|remove|text)"\]$/,
  /^#(undo|redo|before|save|panel|stage|ruler|zoom-pill|navigator)$/,
  /^\[data-quick="[^"]+"\]$/,
  /^\[data-dial="[^"]+"\]$/,
];
// Not in the shared contract: the Save sheet's Keep editing button (the only visible
// way to close the sheet besides the swipe), by its id in index.html.
const EXTRA = ['#sheet-keep'];

const parts = (sel) => sel.split(',').map((s) => s.trim());
const inContract = (sel) => parts(sel).every((s) => CONTRACT.some((re) => re.test(s)) || EXTRA.includes(s));

// Acceptance check 12 wants the selectors to exist in index.html. Ids and dock
// tools are static chrome there; dial and quick chips are drawn by ui/panel.js and
// '#ruler' by ui/ruler-view.js at runtime, so only their form is checked here.
const RUNTIME_IDS = ['ruler'];
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const staticIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const staticTools = new Set([...html.matchAll(/\bdata-tool="([^"]+)"/g)].map((m) => m[1]));
function missingFromHtml(sel) {
  const missing = [];
  for (const s of parts(sel)) {
    const id = /^#([\w-]+)$/.exec(s);
    const tool = /^#dock \[data-tool(?:="([^"]+)")?\]$/.exec(s);
    if (id && !RUNTIME_IDS.includes(id[1]) && !staticIds.has(id[1])) missing.push(s);
    if (tool && (!staticIds.has('dock') || (tool[1] ? !staticTools.has(tool[1]) : staticTools.size === 0))) missing.push(s);
  }
  return missing;
}

// Play a list of events through observe, as hints-ui would: a shown hint is
// remembered forever.
function play(events, shown = new Set(), counters = initialCounters()) {
  const fired = [];
  for (const ev of events) {
    const r = observe(counters, ev, shown);
    counters = r.counters;
    if (r.hint) {
      fired.push(r.hint);
      shown = new Set([...shown, r.hint]);
    }
  }
  return { fired, shown, counters };
}

const repeat = (n, ev) => Array.from({ length: n }, () => ev);

test('HINTS is exactly H1..H17 from the spec, with text and side effects', () => {
  assert.deepEqual(HINTS.map((h) => h.id), Array.from({ length: 17 }, (_, i) => `H${i + 1}`));
  const text = Object.fromEntries(HINTS.map((h) => [h.id, h.text]));
  assert.equal(text.H1, 'Tip: you can also drag sideways on the photo.');
  assert.equal(text.H2, 'Double-tap the ruler to reset.');
  assert.equal(text.H3, 'Hold to compare.');
  assert.equal(text.H4, 'You can also hold the photo. Slide to wipe.');
  assert.equal(text.H5, 'Hold Undo to rewind through every step.');
  assert.equal(text.H6, 'Pinch to zoom in on small things.');
  assert.equal(text.H7, 'Not quite right? Tap Try another.');
  assert.equal(text.H8, 'Tap Source to choose where to copy from.');
  assert.equal(text.H9, 'Quick tap to remove. Holding shows the original.');
  assert.equal(text.H10, 'Drag to move · pinch to resize · tap it to edit.');
  assert.equal(text.H11, 'Tap a caption anytime to edit it.');
  assert.equal(text.H12, 'Tap Tall/Wide to turn the frame.');
  assert.equal(text.H13, 'Paint with one finger. Paint again to build it up.');
  assert.equal(text.H14, 'Tap a change to fine-tune it.');
  assert.equal(text.H15, 'Loop loosely around it. The line snaps to the edges.');
  assert.equal(text.H16, 'Filled inside the outline. Try another gives a different fill.');
  assert.equal(text.H17, 'Drag the ruler to change how much.');
  assert.equal(hintById('H1').sideEffect, 'photoDrag');
  for (const h of HINTS.slice(1)) assert.equal(h.sideEffect, null, h.id);
  for (const h of HINTS) {
    assert.ok(COUNTERS[h.counter], `${h.id} counts something real`);
    assert.equal(COUNTERS[h.counter].event, h.trigger, `${h.id} counter listens to its trigger`);
    assert.ok(h.when && h.text, h.id);
  }
  assert.equal(hintById('H99'), null);
  assert.equal(HINT_MS, 4000);
  assert.equal(HINTS_KEY, 'gesso:hints');
  assert.equal(PHOTO_DRAG_KEY, 'gesso:photoDrag');
  assert.ok(Object.isFrozen(HINTS) && Object.isFrozen(HINTS[0]) && Object.isFrozen(GESTURES) && Object.isFrozen(COUNTERS.rulerDragLightColor.match.tool));
});

test('coverage: every gesture has a visible equivalent from the contract or a hint that exists', () => {
  assert.equal(GESTURES.length, 26, 'one entry per row of the SPEC §4 gesture table');
  const ids = new Set();
  for (const g of GESTURES) {
    assert.ok(!ids.has(g.id), `${g.id} unique`);
    ids.add(g.id);
    assert.ok(g.gesture && g.context && g.effect, g.id);
    assert.ok(g.visibleEquivalent !== null || g.hint !== null, `${g.id} is discoverable`);
    if (g.visibleEquivalent !== null) {
      assert.equal(typeof g.visibleEquivalent, 'string');
      assert.ok(inContract(g.visibleEquivalent), `${g.id}: ${g.visibleEquivalent} is a contract selector`);
    }
    if (g.hint !== null) assert.ok(hintById(g.hint), `${g.id}: hint ${g.hint} exists`);
  }
});

// Regression: 'sheet-swipe' pointed at '#keep-editing', which exists nowhere (the
// button is #sheet-keep), and 'pick-white' at a chip id the Color tool does not
// use; neither row has a hint to fall back on.
test('coverage: static selectors exist in index.html (acceptance check 12)', () => {
  for (const g of GESTURES) {
    if (g.visibleEquivalent === null) continue;
    assert.deepEqual(missingFromHtml(g.visibleEquivalent), [], `${g.id}: ${g.visibleEquivalent}`);
  }
  assert.equal(GESTURES.find((g) => g.id === 'sheet-swipe').visibleEquivalent, '#sheet-keep');
  assert.equal(GESTURES.find((g) => g.id === 'pick-white').visibleEquivalent, '[data-dial="pick"]');
});

test('the gesture table carries the hints the spec names', () => {
  const by = Object.fromEntries(GESTURES.map((g) => [g.id, g]));
  assert.equal(by['hold-undo'].hint, 'H5');
  assert.equal(by['before-button'].hint, 'H3');
  assert.equal(by['hold-photo'].hint, 'H4');
  assert.equal(by['pinch-pan'].hint, 'H6');
  assert.equal(by['double-tap-ruler'].hint, 'H2');
  assert.equal(by['scrub-photo'].hint, 'H1');
  assert.equal(by['paint-photo'].hint, 'H13');
  assert.equal(by['tap-caption-elsewhere'].hint, 'H11');
  assert.equal(by['remove-source'].hint, 'H8');
  assert.equal(by['outline-remove'].hint, 'H16');
  assert.equal(by['outline-light'].hint, 'H17');
  for (const id of ['text-tap-caption', 'text-drag-caption', 'text-pinch']) assert.equal(by[id].hint, 'H10');
});

test('H1 fires on the first ruler drag in Light or Color that a photo drag could adjust, not elsewhere', () => {
  assert.deepEqual(play([{ name: 'ruler-drag', tool: 'light', scrub: true }]).fired, ['H1']);
  assert.deepEqual(play([{ name: 'ruler-drag', tool: 'color', scrub: true }]).fired, ['H1']);
  assert.deepEqual(play([{ name: 'ruler-drag', tool: 'crop', scrub: false }]).fired, []);
  // Light's Amount ruler (Outline on) or Paint: a photo drag traces or paints, so no H1.
  assert.deepEqual(play([{ name: 'ruler-drag', tool: 'light', scrub: false }]).fired, []);
  assert.deepEqual(play([{ name: 'ruler-drag', tool: 'light' }]).fired, [], 'no scrub flag, no H1');
  assert.deepEqual(play(['ruler-drag']).fired, [], 'no tool, no H1');
});

test('H2 fires on the second ruler drag in any tool, scrub or not', () => {
  assert.deepEqual(play([{ name: 'ruler-drag', tool: 'light', scrub: true }, { name: 'ruler-drag', tool: 'light', scrub: true }]).fired, ['H1', 'H2']);
  assert.deepEqual(play([{ name: 'ruler-drag', tool: 'crop', scrub: false }, { name: 'ruler-drag', tool: 'remove', scrub: false }]).fired, ['H2']);
  assert.deepEqual(play([{ name: 'ruler-drag', tool: 'light', scrub: false }, { name: 'ruler-drag', tool: 'text', scrub: false }]).fired, ['H2']);
});

test('when one event earns two hints the lower id shows and the other waits its turn', () => {
  // Crop first, then Light: the Light drag is both the first Light drag and the second drag.
  const r = play([{ name: 'ruler-drag', tool: 'crop', scrub: false }, { name: 'ruler-drag', tool: 'light', scrub: true }, { name: 'ruler-drag', tool: 'crop', scrub: false }]);
  assert.deepEqual(r.fired, ['H1', 'H2']);
});

test('a hint that could not show gets its next chance (thresholds are at least)', () => {
  // The UI dropped H6 on the first heal (another hint was up), so it is not in shown.
  let counters = countEvent(initialCounters(), 'heal');
  counters = countEvent(counters, 'heal');
  assert.equal(nextHint('heal', counters, []), 'H6');
  // But H1 never fires from a non-qualifying event even when its count is already met.
  const c = countEvent(initialCounters(), { name: 'ruler-drag', tool: 'light', scrub: true });
  const c2 = countEvent(c, { name: 'ruler-drag', tool: 'crop', scrub: false });
  assert.equal(nextHint({ name: 'ruler-drag', tool: 'crop', scrub: false }, c2, ['H2']), null);
});

test('H3 is eligible on each of the first two Before taps only, and shows once', () => {
  assert.deepEqual(play(repeat(5, 'before-tap')).fired, ['H3']);
  // Missed on tap 1 (not marked shown) → offered again on tap 2 → never on tap 3.
  let c = countEvent(initialCounters(), 'before-tap');
  c = countEvent(c, 'before-tap');
  assert.equal(nextHint('before-tap', c, []), 'H3');
  c = countEvent(c, 'before-tap');
  assert.equal(nextHint('before-tap', c, []), null);
});

test('H4 on the first Before-button hold; H9 on a photo hold in Remove only', () => {
  assert.deepEqual(play(['before-hold', 'before-hold']).fired, ['H4']);
  assert.deepEqual(play([{ name: 'hold-photo', tool: 'light' }, { name: 'hold-photo', tool: 'crop' }]).fired, []);
  assert.deepEqual(play([{ name: 'hold-photo', tool: 'light' }, { name: 'hold-photo', tool: 'remove' }, { name: 'hold-photo', tool: 'remove' }]).fired, ['H9']);
});

test('H5 on the third Undo tap of a session', () => {
  assert.deepEqual(play(repeat(2, 'undo')).fired, []);
  const r = play(repeat(6, 'undo'));
  assert.deepEqual(r.fired, ['H5']);
  assert.equal(r.counters.undoTap, 6);
  // A new session starts counting from zero again, but H5 already showed: never again.
  assert.deepEqual(play(repeat(6, 'undo'), r.shown).fired, []);
});

test('Remove hints: H6 first heal, H7 first rub fill, H8 second Try another', () => {
  assert.deepEqual(play(['heal', 'heal', 'rub-fill', 'try-another', 'rub-fill', 'try-another', 'try-another']).fired, ['H6', 'H7', 'H8']);
  assert.deepEqual(play(['try-another']).fired, []);
});

test('Text hints: H10 first caption Done, H11 first Home with a caption', () => {
  assert.deepEqual(play(['caption-done', 'caption-done']).fired, ['H10']);
  assert.deepEqual(play(['home', 'home-with-caption', 'home-with-caption']).fired, ['H11']);
});

test('H12 on the first 4:5 or 16:9 chip', () => {
  assert.deepEqual(play(['ratio-chip', 'ratio-chip']).fired, ['H12']);
});

test('events the UI emits that earn no hint are ignored', () => {
  assert.deepEqual(play(['first-ruler-drag', 'pinch', 'first-ruler-drag']).fired, []);
});

test('H13 on the first Paint selection, H14 on the first Auto-enhance', () => {
  assert.deepEqual(play(['paint-select', 'paint-select']).fired, ['H13']);
  assert.deepEqual(play(['auto-enhance', 'auto-enhance']).fired, ['H14']);
});

test('no hint ever fires twice, across any mix of events and sessions', () => {
  const pool = [
    { name: 'ruler-drag', tool: 'light', scrub: true }, { name: 'ruler-drag', tool: 'color', scrub: true }, { name: 'ruler-drag', tool: 'crop', scrub: false },
    { name: 'ruler-drag', tool: 'light', scrub: false }, 'before-tap', 'before-hold', { name: 'hold-photo', tool: 'remove' }, { name: 'hold-photo', tool: 'text' },
    'undo', 'heal', 'rub-fill', 'try-another', 'caption-done', 'home-with-caption', 'home',
    'ratio-chip', 'pinch', 'first-ruler-drag', 'paint-select', 'auto-enhance', 'nonsense',
  ];
  // A deterministic LCG (no Math.random in tests either: failures must replay).
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let shown = new Set();
  const all = [];
  for (let session = 0; session < 5; session++) {
    const events = Array.from({ length: 60 }, () => pool[Math.floor(rand() * pool.length)]);
    const r = play(events, shown); // fresh counters each session
    all.push(...r.fired);
    shown = r.shown;
  }
  assert.equal(new Set(all).size, all.length, `fired twice: ${all}`);
  assert.deepEqual([...shown].sort(), [...new Set(all)].sort());
});

test('every hint can actually be earned', () => {
  const events = [
    { name: 'ruler-drag', tool: 'light', scrub: true }, { name: 'ruler-drag', tool: 'light', scrub: true }, 'before-tap', 'before-hold',
    ...repeat(3, 'undo'), 'heal', 'rub-fill', 'try-another', 'try-another', { name: 'hold-photo', tool: 'remove' },
    'caption-done', 'home-with-caption', 'ratio-chip', 'paint-select', 'auto-enhance',
    { name: 'outline-on', tool: 'remove' }, { name: 'outline-done', tool: 'remove' }, { name: 'outline-done', tool: 'light' },
  ];
  assert.deepEqual(play(events).fired, HINTS.map((h) => h.id));
  // H16 and H17 share a trigger and are told apart by the tool, so neither fires for the other's.
  assert.deepEqual(play([{ name: 'outline-done', tool: 'light' }]).fired, ['H17']);
  assert.deepEqual(play([{ name: 'outline-done', tool: 'remove' }]).fired, ['H16']);
  assert.deepEqual(play(['outline-done']).fired, [], 'no tool, no hint');
});

test('countEvent is pure and tolerant', () => {
  const c0 = Object.freeze(initialCounters());
  const c1 = countEvent(c0, { name: 'ruler-drag', tool: 'color', scrub: true });
  assert.equal(c0.rulerDrag, 0, 'input untouched');
  assert.equal(c1.rulerDrag, 1);
  assert.equal(c1.rulerDragLightColor, 1);
  assert.equal(countEvent(c0, { name: 'ruler-drag', tool: 'color', scrub: false }).rulerDragLightColor, 0, 'no scrub, no H1 count');
  assert.equal(countEvent(c0, 'nonsense'), c0, 'unknown events change nothing');
  assert.equal(countEvent(c0, null), c0);
  assert.equal(countEvent(c0, { tool: 'light' }), c0, 'an event needs a name');
  assert.deepEqual(countEvent(undefined, 'heal'), { heal: 1 });
  assert.deepEqual(countEvent({ heal: NaN }, 'heal'), { heal: 1 }, 'junk counts restart');
  assert.deepEqual(countEvent('junk', 'heal'), { heal: 1 });
});

test('nextHint takes shown as a Set or an array, and is tolerant of junk', () => {
  const c = countEvent(initialCounters(), 'auto-enhance');
  assert.equal(nextHint('auto-enhance', c, new Set(['H14'])), null);
  assert.equal(nextHint('auto-enhance', c, ['H14']), null);
  assert.equal(nextHint('auto-enhance', c, null), 'H14');
  assert.equal(nextHint('auto-enhance', c, 'H14'), 'H14', 'a bare string is not a list');
  // Regression: the raw stored string (the form reviveShown and markShown accept)
  // used to read as "nothing shown", so every hint would come back each launch.
  assert.equal(nextHint('auto-enhance', c, '["H14"]'), null);
  assert.equal(nextHint('auto-enhance', c, '["H1"]'), 'H14');
  assert.equal(nextHint('auto-enhance', c, 'not json'), 'H14');
  assert.equal(observe(initialCounters(), 'auto-enhance', JSON.stringify(markShown([], 'H14'))).hint, null);
  assert.equal(nextHint('auto-enhance', initialCounters(), []), null, 'counters must include the event');
  assert.equal(nextHint(null, c, []), null);
  assert.equal(nextHint('', c, []), null);
  assert.equal(nextHint('auto-enhance', null, []), null);
});

test('reviveShown and markShown keep the stored list clean', () => {
  assert.deepEqual(reviveShown('["H3","H1","H1","H99",4,null]'), ['H1', 'H3']);
  assert.deepEqual(reviveShown('not json'), []);
  assert.deepEqual(reviveShown('{"H1":true}'), []);
  assert.deepEqual(reviveShown(null), []);
  assert.deepEqual(reviveShown(new Set(['H2'])), ['H2']);
  assert.deepEqual(markShown(['H3'], 'H1'), ['H1', 'H3']);
  assert.deepEqual(markShown('["H1"]', 'H1'), ['H1']);
  assert.deepEqual(markShown(['H1'], 'H99'), ['H1']);
  assert.deepEqual(markShown(new Set(['H5']), 'H6'), ['H5', 'H6']);
  const stored = ['H2'];
  markShown(stored, 'H4');
  assert.deepEqual(stored, ['H2'], 'input untouched');
});
