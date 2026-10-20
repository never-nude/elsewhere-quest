// Color › Pick white, driven the way the editor drives it (through tool.onGesture):
// a press shows the loupe and the lift picks; a hold the reducer cancels (a second
// finger landing to zoom, an iOS pointercancel) picks nothing and stays in Pick.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDoc } from '../lib/doc.js';

globalThis.window ??= globalThis;
globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.requestAnimationFrame ??= () => 0; // panel() queues the look thumbnails; never painted here

const { default: color } = await import('../ui/tools/color.js');

const W = 600, H = 480;

function fakeEditor() {
  const history = [createDoc({ id: 'd1', sourceType: 'jpeg', natW: W, natH: H, w: W, h: H, now: 0 })];
  let at = 0;
  const ed = {
    log: { commits: [], toasts: [], renders: 0 },
    get doc() { return history[at]; },
    get committed() { return history[at]; },
    get revision() { return at; },
    view: { x: 0, y: 0, scale: 0.5 },
    renderer: {
      // a warm patch: never neutral, so a pick always makes a step
      readRect: ({ w, h }) => { const px = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < px.length; i += 4) px.set([200, 170, 130, 255], i); return px; },
    },
    panel: { ruler: () => null },
    stageSize: () => ({ width: 402, height: 486 }),
    stageToDoc: (x, y) => [x / 0.5, y / 0.5],
    stageToSource: (x, y) => [x / 0.5, y / 0.5],
    readOutput: () => { throw new Error('no loupe pixels in node'); }, // loupeImage catches: a loupe with no image
    requestRender() { ed.log.renders++; },
    toast(text) { ed.log.toasts.push(text); },
    refresh() {},
    hint() {},
    commit(next, label) {
      if (next === history[at]) return;
      history.length = at + 1;
      history.push(next);
      at++;
      ed.log.commits.push(label);
    },
  };
  return ed;
}

// Records the overlay calls, so "nothing drawn" is checkable.
function recorder() {
  const calls = [];
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...a) => { calls.push(k); return a; }), set: (t, k, v) => { t[k] = v; return true; } });
  return { ctx, calls };
}

function pickMode(ed) {
  color.close(); // as the editor does between sessions: the last pick's loupe flash is gone
  color.open(ed, {});
  color.onDial(ed, 'pick');
  assert.equal(color.claimsHold, true, 'Pick white claims the hold');
}

test('a press shows the loupe and the lift picks the white point as one step', () => {
  const ed = fakeEditor();
  pickMode(ed);
  assert.ok(color.onGesture(ed, { type: 'hold-start', x: 100, y: 120, t: 500 }));
  const { ctx, calls } = recorder();
  color.drawOverlay(ed, ctx);
  assert.ok(calls.includes('arc'), 'the loupe crosshair is drawn while pressing');
  assert.ok(color.onGesture(ed, { type: 'hold-move', x: 110, y: 125, t: 600 }));
  assert.ok(color.onGesture(ed, { type: 'hold-end', t: 900 }));
  assert.deepEqual(ed.log.commits, ['Picked white']);
  assert.equal(color.claimsHold, false, 'picking is over');
  assert.equal(color.panel(ed).dials.find((d) => d.id === 'pick').selected, false);
});

test('a cancelled hold picks nothing, drops the loupe and stays in Pick', () => {
  const ed = fakeEditor();
  pickMode(ed);
  assert.ok(color.onGesture(ed, { type: 'hold-start', x: 100, y: 120, t: 500 }));
  assert.ok(color.onGesture(ed, { type: 'hold-move', x: 140, y: 160, t: 700 }));
  const renders = ed.log.renders;
  assert.ok(color.onGesture(ed, { type: 'hold-end', cancelled: true }), 'the tool still owns the hold it claimed');
  assert.deepEqual(ed.log.commits, [], 'no step from wherever the loupe was');
  assert.deepEqual(ed.log.toasts, []);
  assert.equal(color.claimsHold, true, 'still picking');
  assert.equal(color.panel(ed).dials.find((d) => d.id === 'pick').selected, true);
  assert.ok(ed.log.renders > renders, 'a frame clears the loupe');
  const { ctx, calls } = recorder();
  color.drawOverlay(ed, ctx);
  assert.deepEqual(calls, [], 'no loupe left on the overlay');
  // The second finger's pinch is the editor's: not taken.
  assert.equal(color.onGesture(ed, { type: 'pinch-start' }), false);
  // And the next press picks as before.
  assert.ok(color.onGesture(ed, { type: 'hold-start', x: 100, y: 120, t: 2000 }));
  assert.ok(color.onGesture(ed, { type: 'hold-end', t: 2600 }));
  assert.deepEqual(ed.log.commits, ['Picked white']);
});

test('a cancelled hold-end with no loupe (a cancel before the press registered) is not the tool\'s', () => {
  const ed = fakeEditor();
  pickMode(ed);
  assert.equal(color.onGesture(ed, { type: 'hold-end', cancelled: true }), false);
  assert.equal(color.claimsHold, true);
});
