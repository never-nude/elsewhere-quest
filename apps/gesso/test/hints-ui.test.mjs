// ui/hints-ui.js against fakes: storage, clock, panel and the fade watcher. The
// browser half (the hint line itself) is covered by the Playwright harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHints } from '../ui/hints-ui.js';
import { HINT_MS, HINTS_KEY, PHOTO_DRAG_KEY, hintById } from '../lib/hints.js';
import { TAPED } from '../ui/tape.js';

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    map: m,
  };
}

function rig({ storage = fakeStorage(), faded = false, covers = [] } = {}) {
  let t = 1000;
  const tips = [];
  const fade = { on: faded, cb: null };
  const editor = { panel: { showTip: (text, ms) => tips.push({ text, ms }) } };
  const hints = createHints(() => editor, {
    storage,
    now: () => t,
    panelEl: () => ({ classList: { contains: (c) => c === 'is-faded' && fade.on } }),
    watchFade: (el, cb) => {
      fade.cb = cb;
      return () => { fade.cb = null; };
    },
    covers: () => covers,
    defer: (fn) => fn(),
  });
  return {
    hints, tips, storage, fade,
    wait(ms) { t += ms; },
    unfade() { fade.on = false; fade.cb?.(); },
  };
}

test('an earned hint shows once, for HINT_MS, and is stored', () => {
  const r = rig();
  assert.equal(r.hints.event('auto-enhance'), 'H14');
  assert.deepEqual(r.tips, [{ text: hintById('H14').text, ms: HINT_MS }]);
  assert.deepEqual(JSON.parse(r.storage.getItem(HINTS_KEY)), ['H14']);
  r.wait(HINT_MS + 1);
  assert.equal(r.hints.event('auto-enhance'), null);
  assert.equal(r.tips.length, 1);
});

test('no hint shows twice across reloads', () => {
  const storage = fakeStorage();
  const a = rig({ storage });
  assert.equal(a.hints.event('paint-select'), 'H13');
  const b = rig({ storage }); // a reload: fresh counters, same storage
  assert.equal(b.hints.event('paint-select'), null);
  assert.equal(b.tips.length, 0);
  assert.deepEqual(b.hints.shown, ['H13']);
});

test('one shown in another tab after load is not shown again', () => {
  const storage = fakeStorage();
  const a = rig({ storage });
  const b = rig({ storage });
  assert.equal(a.hints.event('heal'), 'H6');
  assert.equal(b.hints.event('heal'), null);
  assert.equal(b.tips.length, 0);
});

test('at most one hint at a time; the blocked one gets its next chance', () => {
  const r = rig();
  assert.equal(r.hints.event('auto-enhance'), 'H14');
  assert.equal(r.hints.event('paint-select'), null); // H14 still up
  assert.equal(r.tips.length, 1);
  assert.ok(!r.hints.shown.includes('H13'));
  r.wait(HINT_MS);
  assert.equal(r.hints.event('paint-select'), 'H13');
  assert.equal(r.tips.length, 2);
});

test('H3 has a window: a second Before tap can still earn it, a third cannot', () => {
  const r = rig();
  r.hints.event('auto-enhance'); // something else is up
  assert.equal(r.hints.event('before-tap'), null);
  r.wait(HINT_MS);
  assert.equal(r.hints.event('before-tap'), 'H3');

  const late = rig();
  late.hints.event('auto-enhance');
  late.hints.event('before-tap');
  late.hints.event('before-tap');
  late.wait(HINT_MS);
  assert.equal(late.hints.event('before-tap'), null);
});

test('H5 is the third Undo of the session; counters do not persist', () => {
  const storage = fakeStorage();
  const a = rig({ storage });
  assert.equal(a.hints.event('undo'), null);
  assert.equal(a.hints.event('undo'), null);
  const b = rig({ storage }); // reload: the count starts again
  assert.equal(b.hints.event('undo'), null);
  assert.equal(b.hints.event('undo'), null);
  assert.equal(b.hints.event('undo'), 'H5');
});

test('H1 turns on photo drag; H2 follows on a later ruler drag', () => {
  const r = rig();
  assert.equal(r.hints.event('ruler-drag', { tool: 'light', scrub: true }), 'H1');
  assert.equal(r.storage.getItem(PHOTO_DRAG_KEY), '1');
  assert.equal(r.hints.event('ruler-drag', { tool: 'light', scrub: true }), null); // H1 still up
  r.wait(HINT_MS);
  assert.equal(r.hints.event('ruler-drag', { tool: 'crop', scrub: false }), 'H2');
});

test('a ruler drag outside Light and Color earns nothing on the first go', () => {
  const r = rig();
  assert.equal(r.hints.event('ruler-drag', { tool: 'crop', scrub: false }), null);
  assert.equal(r.storage.getItem(PHOTO_DRAG_KEY), null);
});

test('a hint earned while the panel is faded waits for the fade to lift', () => {
  const r = rig({ faded: true });
  assert.equal(r.hints.event('ruler-drag', { tool: 'color', scrub: true }), null);
  assert.equal(r.hints.pending, 'H1');
  assert.equal(r.tips.length, 0);
  assert.equal(r.storage.getItem(HINTS_KEY), null); // not marked until seen
  r.hints.event('auto-enhance'); // a second earned hint while one waits: not queued
  r.unfade();
  assert.deepEqual(r.tips.map((t) => t.text), [hintById('H1').text]);
  assert.equal(r.hints.pending, null);
  assert.deepEqual(JSON.parse(r.storage.getItem(HINTS_KEY)), ['H1']);
  r.wait(HINT_MS);
  assert.equal(r.hints.event('auto-enhance'), 'H14');
});

test('a hint earned under the rewind tape waits for the tape to go', () => {
  const tips = [];
  const classes = new Set([TAPED]);
  let watcher = null;
  const hints = createHints(() => ({ panel: { showTip: (text) => tips.push(text) } }), {
    storage: fakeStorage(),
    now: () => 1000,
    panelEl: () => ({ classList: { contains: (c) => classes.has(c) } }),
    watchFade: (el, cb) => { watcher = cb; return () => { watcher = null; }; },
    covers: () => [],
    defer: (fn) => fn(),
  });
  assert.equal(hints.event('undo'), null);
  assert.equal(hints.event('undo'), null);
  assert.equal(hints.event('undo'), null);
  assert.equal(hints.pending, 'H5');
  classes.add('is-faded'); // still hidden: a class change alone does not release it
  watcher();
  assert.equal(tips.length, 0);
  classes.clear();
  watcher();
  assert.deepEqual(tips, [hintById('H5').text]);
});

test('a hint earned under the Save sheet or the keyboard is dropped, not marked', () => {
  const sheet = { hidden: false };
  const r = rig({ covers: [sheet, null] });
  assert.equal(r.hints.event('heal'), null);
  assert.equal(r.tips.length, 0);
  assert.equal(r.storage.getItem(HINTS_KEY), null);
  assert.equal(r.hints.pending, null);
  sheet.hidden = true;
  assert.equal(r.hints.event('heal'), 'H6'); // its next chance
  assert.deepEqual(JSON.parse(r.storage.getItem(HINTS_KEY)), ['H6']);
});

test('the decision waits for the handler that earned it', async () => {
  const tips = [];
  const sheet = { hidden: true };
  const storage = fakeStorage();
  const hints = createHints(() => ({ panel: { showTip: (text) => tips.push(text) } }), {
    storage, now: () => 1000, panelEl: () => null, covers: () => [sheet],
  });
  // Save closes Text with a caption on the photo (H11), then raises its sheet.
  hints.event('home-with-caption');
  sheet.hidden = false;
  hints.event('auto-enhance'); // same handler: waits behind the first, not queued
  await Promise.resolve();
  assert.equal(tips.length, 0);
  assert.equal(storage.getItem(HINTS_KEY), null);
  sheet.hidden = true;
  hints.event('home-with-caption');
  await Promise.resolve();
  assert.deepEqual(tips, [hintById('H11').text]);
});

test('unknown events and junk are ignored; broken storage still shows hints', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const r = rig({ storage: broken });
  assert.equal(r.hints.event('pinch'), null);
  assert.equal(r.hints.event('first-ruler-drag'), null);
  assert.equal(r.hints.event(''), null);
  assert.equal(r.hints.event(null), null);
  assert.equal(r.hints.event('caption-done'), 'H10');
  assert.equal(r.tips.length, 1);
});

test('stored junk is tolerated', () => {
  const r = rig({ storage: fakeStorage({ [HINTS_KEY]: '{oops' }) });
  assert.equal(r.hints.event('ratio-chip'), 'H12');
  const s = rig({ storage: fakeStorage({ [HINTS_KEY]: '["H12","nope",3]' }) });
  assert.equal(s.hints.event('ratio-chip'), null);
});

test('no editor yet: nothing shows and nothing is marked', () => {
  const storage = fakeStorage();
  const hints = createHints(() => null, { storage, now: () => 0, panelEl: () => null, covers: () => [], defer: (fn) => fn() });
  assert.equal(hints.event('auto-enhance'), null);
  assert.equal(storage.getItem(HINTS_KEY), null);
});
