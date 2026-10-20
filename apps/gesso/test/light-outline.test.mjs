// Light › Outline, driven the way the editor drives it: the chip, the segment,
// the gestures (through tool.onGesture), the lift that makes one step, the
// Amount ruler that re-commits it, Cancel and close. The editor, renderer and
// the overlay canvas are fakes; the lasso, the magnifier's placement and the
// pool entries are real.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDoc } from '../lib/doc.js';
import { fitView, stageToContent } from '../lib/view.js';
import { outputSize, outputToSource, sourceToOutput, apply, rotateQuarter, flipHorizontal } from '../lib/geometry.js';
import { polygonArea, polygonBounds, revivePolygon } from '../lib/lasso.js';
import { mulberry32 } from '../lib/inpaint.js';

// ui/magnifier.js reads pixels into a 2D canvas: enough of the DOM for that to run.
const noop = () => {};
const ctx2d = () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => { t[k] = v; return true; } });
globalThis.window ??= globalThis;
globalThis.document ??= { createElement: () => ({ width: 0, height: 0, getContext: ctx2d }) };
globalThis.ImageData ??= class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
globalThis.localStorage ??= { getItem: () => null, setItem: noop };

const { default: light } = await import('../ui/tools/light.js');

// ------------------------------------------------------------------ fixtures

const W = 600, H = 480; // source = output = analysis px (≤ 1024)
const RECT = { x: 180, y: 140, w: 200, h: 160 }; // a bright block on a dark ground, source px
const STAGE = { width: 402, height: 486 };

function photo(seed = 5) {
  const rand = mulberry32(seed);
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inside = x >= RECT.x && x < RECT.x + RECT.w && y >= RECT.y && y < RECT.y + RECT.h;
      const v = Math.round((inside ? 200 : 40) + (rand() - 0.5) * 12), i = (y * W + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

function fakeEditor({ crop = null } = {}) {
  let doc = createDoc({ id: 'd1', sourceType: 'jpeg', natW: W, natH: H, w: W, h: H, now: 0 });
  if (crop) doc = { ...doc, crop: crop(doc.crop) };
  const history = [doc];
  let at = 0;
  let live = null;
  let pools = { strokes: {}, patches: {} };
  const o = () => outputSize(ed.committed.crop);
  let view = null;
  const ensureView = () => {
    const s = o();
    view ??= fitView(s.width, s.height, STAGE.width, STAGE.height, 12);
    return view;
  };
  const ed = {
    log: { commits: [], lives: [], hints: [], renders: 0, reads: [] },
    get doc() { return live ?? history[at]; },
    get committed() { return history[at]; },
    get pools() { return pools; },
    set pools(p) { pools = p; },
    get view() { return ensureView(); },
    get revision() { return at; },
    renderer: { size: { width: W, height: H }, paintScale: () => 0.25, paintDabs: noop },
    panel: { ruler: () => null, showTip: noop },
    stageSize: () => STAGE,
    requestRender() { ed.log.renders++; },
    hint(name, data) { ed.log.hints.push({ name, ...data }); },
    outputSize: o,
    stageToDoc: (x, y) => stageToContent(ensureView(), x, y),
    docToStage: (x, y) => { const v = ensureView(); return [v.x + x * v.scale, v.y + y * v.scale]; },
    stageToSource(x, y) { const st = ed.doc; return apply(outputToSource(st.crop, W, H), ...ed.stageToDoc(x, y)); },
    sourcePerStagePx() { return 1 / ensureView().scale; },
    readOutput({ maxSide = 512, rect = null, tone = false } = {}) {
      ed.log.reads.push({ maxSide, rect: !!rect, tone });
      if (rect) return { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) };
      // The cropped photo at output size (the crop may turn it).
      const s = o();
      const img = photo();
      const out = { width: s.width, height: s.height, data: new Uint8ClampedArray(s.width * s.height * 4) };
      const m = outputToSource(ed.committed.crop, W, H);
      for (let y = 0; y < s.height; y++) {
        for (let x = 0; x < s.width; x++) {
          const [sx, sy] = apply(m, x + 0.5, y + 0.5);
          const si = (Math.min(H - 1, Math.max(0, Math.floor(sy))) * W + Math.min(W - 1, Math.max(0, Math.floor(sx)))) * 4;
          out.data.set(img.data.subarray(si, si + 4), (y * s.width + x) * 4);
        }
      }
      return out;
    },
    commit(next, label) {
      live = null;
      if (next === history[at]) return;
      history.length = at + 1;
      history.push(next);
      at++;
      ed.log.commits.push({ label, paint: next.paint });
    },
    live(next) { live = next; ed.log.lives.push(next); },
    undo() { if (at > 0) at--; live = null; light.onHistory?.(ed); },
    redo() { if (at < history.length - 1) at++; live = null; light.onHistory?.(ed); },
  };
  return ed;
}

// Finger points (stage px) wandering ±amp px around the block, in output px first.
function fingerAround(ed, { amp = 10, step = 7, seed = 3 } = {}) {
  const st = ed.committed;
  const m = sourceToOutput(st.crop, W, H);
  const c = [[RECT.x, RECT.y], [RECT.x + RECT.w, RECT.y], [RECT.x + RECT.w, RECT.y + RECT.h], [RECT.x, RECT.y + RECT.h]].map(([x, y]) => apply(m, x, y));
  const rand = mulberry32(seed);
  const out = [];
  for (let s = 0; s < 4; s++) {
    const [ax, ay] = c[s], [bx, by] = c[(s + 1) % 4];
    const L = Math.hypot(bx - ax, by - ay), nx = -(by - ay) / L, ny = (bx - ax) / L;
    for (let d = 0; d < L; d += step) {
      const off = (rand() - 0.5) * 2 * amp;
      out.push(ed.docToStage(ax + ((bx - ax) * d) / L + nx * off, ay + ((by - ay) * d) / L + ny * off));
    }
  }
  return out;
}

const overlay = ctx2d();
function loop(ed, pts, { cancel = false } = {}) {
  const t = 1000;
  assert.ok(light.onGesture(ed, { type: 'drag-start', target: 'photo', x: pts[0][0], y: pts[0][1], t }), 'the drag is taken');
  for (let i = 1; i < pts.length; i++) {
    light.onGesture(ed, { type: 'drag', target: 'photo', x: pts[i][0], y: pts[i][1], dx: 0, dy: 0, t: t + i * 16 });
    light.drawOverlay(ed, overlay); // the frame: the lasso moves once per frame
  }
  if (cancel) return light.onGesture(ed, { type: 'drag-cancel', t: t + 2000 });
  return light.onGesture(ed, { type: 'drag-end', x: pts.at(-1)[0], y: pts.at(-1)[1], t: t + 2000 });
}

const slot = (ed) => light.panel(ed).slot;
const chip = (ed, id) => light.panel(ed).dials.find((d) => d.id === id);
const entry = (ed) => ed.pools.strokes[ed.committed.paint.at(-1)];
const boundsOf = (poly) => { const b = polygonBounds(revivePolygon(poly)); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const rectNear = (b, r, tol) => near(b.x, r.x, tol) && near(b.y, r.y, tol) && near(b.w, r.w, tol) && near(b.h, r.h, tol);

// ------------------------------------------------------------------ tests

test('the Outline chip: off by default, a switch, with the segment in the slot and the hold claimed while on', () => {
  const ed = fakeEditor();
  light.open(ed, {});
  const p = light.panel(ed);
  assert.deepEqual(p.dials.map((d) => d.id), ['brightness', 'contrast', 'highlights', 'shadows', 'paint', 'outline']);
  assert.deepEqual(chip(ed, 'outline'), { id: 'outline', label: 'Outline', value: 'Off', selected: false, kind: 'mode' });
  assert.equal(p.slot.kind, 'ruler');
  assert.equal(light.claimsHold, false);
  light.onDial(ed, 'outline');
  assert.equal(chip(ed, 'outline').value, 'On');
  assert.ok(chip(ed, 'outline').selected);
  assert.equal(chip(ed, 'brightness').selected, false);
  assert.equal(light.panel(ed).hint, 'Loop around it. The line snaps to edges.');
  assert.deepEqual(slot(ed), { kind: 'segment', id: 'paint', options: [{ id: 'brighten', label: 'Brighten' }, { id: 'darken', label: 'Darken' }, { id: 'erase', label: 'Erase' }], selected: 'brighten' });
  assert.equal(light.claimsHold, true);
  assert.equal(light.dragAxis(ed), 'free');
  assert.deepEqual(ed.log.hints, [{ name: 'outline-on', tool: 'light' }]);
  light.onDial(ed, 'outline');
  assert.equal(chip(ed, 'outline').value, 'Off');
  assert.ok(chip(ed, 'brightness').selected, 'back to the dial it had');
  assert.equal(light.claimsHold, false);
  light.close(ed, {});
});

test('a loop makes one step on lift: an outline entry in pools.strokes, its id in doc.paint, the ruler next', () => {
  const ed = fakeEditor();
  light.open(ed, {});
  light.onDial(ed, 'outline');
  const pts = fingerAround(ed);
  assert.ok(loop(ed, pts));
  assert.equal(ed.log.commits.length, 1);
  assert.equal(ed.log.commits[0].label, 'Brightened inside outline');
  assert.equal(ed.committed.paint.length, 1);
  const e = entry(ed);
  assert.equal(e.kind, 'outline');
  assert.equal(e.mode, 'brighten');
  assert.equal(e.amount, 0.67);
  assert.ok(Array.isArray(e.poly) && e.poly.every((v) => typeof v === 'number'), 'plain numbers for the store');
  assert.ok(e.poly.every((v) => v === Math.round(v * 10) / 10), 'at 0.1 px');
  const poly = revivePolygon(e.poly);
  assert.ok(poly, 'revives');
  assert.ok(rectNear(boundsOf(e.poly), RECT, 4), `the loop snapped to the block: ${JSON.stringify(boundsOf(e.poly))}`);
  assert.ok(near(polygonArea(poly), RECT.w * RECT.h, 0.08 * RECT.w * RECT.h), 'and encloses it');
  assert.deepEqual(ed.log.hints.at(-1), { name: 'outline-done', tool: 'light' });
  const s = slot(ed);
  assert.equal(s.kind, 'ruler');
  assert.equal(s.id, 'outlineAmount');
  assert.equal(s.spec.label, 'Amount');
  assert.deepEqual([s.spec.min, s.spec.max, s.spec.def], [-100, 100, 67]);
  assert.equal(s.value, 67);
  assert.equal(chip(ed, 'paint').value, '1', 'the Paint count includes it');
  assert.equal(ed.log.reads.filter((r) => r.maxSide === 1024).length, 1, 'the edge map was read once');
  light.close(ed, {});
});

test('the Amount ruler previews live and re-commits the loop once on release, keeping the old entry for Undo', () => {
  const ed = fakeEditor();
  light.open(ed, {});
  light.onDial(ed, 'outline');
  loop(ed, fingerAround(ed));
  const oldId = ed.committed.paint[0];
  const old = structuredClone(ed.pools.strokes[oldId]);
  light.onRuler(ed, 'start');
  light.onRuler(ed, 'move', 40);
  assert.equal(ed.log.lives.length, 1);
  const liveId = ed.log.lives[0].paint[0];
  assert.notEqual(liveId, oldId, 'the preview is a fresh entry');
  assert.deepEqual(ed.pools.strokes[liveId], { ...old, mode: 'brighten', amount: 0.4 });
  light.onRuler(ed, 'move', -30);
  assert.equal(ed.log.lives[1].paint[0], liveId, 'one id for the whole drag');
  assert.deepEqual(ed.pools.strokes[liveId], { ...old, mode: 'darken', amount: 0.3 });
  assert.equal(slot(ed).value, -30, 'the ruler shows the live amount');
  light.onRuler(ed, 'end', -30);
  assert.equal(ed.log.commits.length, 2, 'one step per release');
  assert.equal(ed.log.commits[1].label, 'Darkened inside outline');
  assert.deepEqual(ed.committed.paint, [liveId]);
  assert.deepEqual(ed.pools.strokes[oldId], old, 'the entry before is untouched, so Undo is exact');
  assert.equal(slot(ed).value, -30);
  // Undo of the re-commit: the loop at its earlier amount is still the newest
  // step, so the ruler stays (and can be nudged again); past the loop it goes.
  ed.undo();
  assert.deepEqual(ed.committed.paint, [oldId]);
  assert.deepEqual([slot(ed).kind, slot(ed).value], ['ruler', 67]);
  ed.undo();
  assert.deepEqual(ed.committed.paint, []);
  assert.equal(slot(ed).kind, 'segment');
  ed.redo();
  assert.deepEqual([slot(ed).kind, slot(ed).value], ['ruler', 67]);
  ed.redo();
  assert.deepEqual([slot(ed).kind, slot(ed).value], ['ruler', -30]);
  // A release at the value it started from is not a step, and the preview is cleared.
  const lives = ed.log.lives.length;
  light.onRuler(ed, 'start');
  light.onRuler(ed, 'move', -31);
  light.onRuler(ed, 'move', -30);
  light.onRuler(ed, 'end', -30);
  assert.equal(ed.log.commits.length, 2);
  assert.equal(ed.log.lives.at(-1), null, 'the preview ends');
  assert.equal(ed.log.lives.at(-2), ed.committed, 'after the committed paint went back on the GPU');
  assert.equal(ed.log.lives.length, lives + 4);
  assert.ok(!Object.keys(ed.pools.strokes).some((id) => id !== oldId && id !== liveId), 'no stray entry');
  // Reset (double-tap) is a step back to the default.
  light.onRuler(ed, 'reset');
  assert.equal(ed.log.commits.length, 3);
  assert.equal(ed.log.commits[2].label, 'Brightened inside outline');
  assert.equal(entry(ed).amount, 0.67);
  assert.equal(slot(ed).value, 67);
  light.close(ed, {});
});

test('a history move under the other hand while the Amount ruler is held drops the drag, not the step on top', () => {
  const ed = fakeEditor();
  light.open(ed, {});
  light.onDial(ed, 'outline');
  // A Paint stroke, then the loop: Undo mid-drag puts the stroke on top.
  const brush = { mode: 'brighten', r: 10, pts: [10, 10, 20, 20] };
  ed.pools = { ...ed.pools, strokes: { ...ed.pools.strokes, s1: brush } };
  ed.commit({ ...ed.committed, paint: ['s1'] }, 'Painted light');
  loop(ed, fingerAround(ed));
  const loopId = ed.committed.paint[1];
  assert.deepEqual(ed.committed.paint, ['s1', loopId]);
  light.onRuler(ed, 'start');
  light.onRuler(ed, 'move', 40);
  const liveId = ed.log.lives.at(-1).paint.at(-1);
  ed.undo();
  assert.deepEqual(ed.committed.paint, ['s1']);
  assert.ok(!(liveId in ed.pools.strokes), 'the live entry left the pool with the drag');
  const lives = ed.log.lives.length;
  light.onRuler(ed, 'move', 30);
  light.onRuler(ed, 'end', 30);
  assert.equal(ed.log.lives.length, lives, 'the rest of the drag is nothing');
  assert.equal(ed.log.lives.at(-1), null, 'the committed state shows');
  assert.equal(ed.log.commits.length, 2, 'no step');
  assert.deepEqual(ed.committed.paint, ['s1']);
  assert.equal(ed.pools.strokes.s1, brush, 'the stroke on top is untouched');
  assert.deepEqual(Object.keys(ed.pools.strokes).sort(), ['s1', loopId].sort(), 'no stray entry');
  assert.equal(slot(ed).kind, 'segment', 'a brush stroke on top: nothing to set');
  // Redo puts the loop back on top: the ruler returns and a new drag works.
  ed.redo();
  assert.deepEqual([slot(ed).kind, slot(ed).value], ['ruler', 67]);
  light.onRuler(ed, 'start');
  light.onRuler(ed, 'move', 40);
  light.onRuler(ed, 'end', 40);
  assert.equal(ed.log.commits.length, 3);
  assert.equal(entry(ed).amount, 0.4);
  // A step landing from elsewhere (no history hook) is caught at the next move.
  light.onRuler(ed, 'start');
  light.onRuler(ed, 'move', 50);
  const stray = ed.log.lives.at(-1).paint.at(-1);
  ed.pools = { ...ed.pools, strokes: { ...ed.pools.strokes, s2: brush } };
  ed.commit({ ...ed.committed, paint: [...ed.committed.paint, 's2'] }, 'Painted light');
  light.onRuler(ed, 'move', 60);
  light.onRuler(ed, 'end', 60);
  assert.equal(ed.log.commits.length, 4);
  assert.equal(ed.committed.paint.at(-1), 's2');
  assert.ok(!(stray in ed.pools.strokes));
  assert.equal(ed.log.lives.at(-1), null);
  light.close(ed, {});
});

test('a new loop takes the ruler as shown: Undo or Redo of a re-commit sets the amount and direction', () => {
  const ed = fakeEditor();
  light.open(ed, {});
  light.onDial(ed, 'outline');
  loop(ed, fingerAround(ed));
  const drag = (v) => { light.onRuler(ed, 'start'); light.onRuler(ed, 'move', v); light.onRuler(ed, 'end', v); };
  drag(67); // the ruler is the tool's own state: from the default
  drag(-30);
  assert.deepEqual([entry(ed).mode, entry(ed).amount], ['darken', 0.3]);
  // Undo: the ruler reads plus 67 again, so that is what the next loop gets,
  // not the darken 30 of the step undone (SPEC F19).
  ed.undo();
  assert.deepEqual([slot(ed).kind, slot(ed).value], ['ruler', 67]);
  loop(ed, fingerAround(ed, { seed: 9 }));
  assert.equal(ed.log.commits.at(-1).label, 'Brightened inside outline');
  assert.deepEqual([entry(ed).mode, entry(ed).amount], ['brighten', 0.67]);
  // Redo onto a darken re-commit: the next loop darkens by as much.
  drag(-30);
  ed.undo();
  ed.redo();
  assert.deepEqual([slot(ed).kind, slot(ed).value], ['ruler', -30]);
  loop(ed, fingerAround(ed, { seed: 11 }));
  assert.equal(ed.log.commits.at(-1).label, 'Darkened inside outline');
  assert.deepEqual([entry(ed).mode, entry(ed).amount], ['darken', 0.3]);
  // The segment, when it shows again, agrees with the sign the ruler had.
  ed.undo(); // past that loop: the one before is not this session's newest
  assert.deepEqual([slot(ed).kind, slot(ed).selected], ['segment', 'darken']);
  ed.redo();
  drag(50);
  ed.undo();
  assert.deepEqual([slot(ed).kind, slot(ed).value], ['ruler', -30]);
  ed.redo();
  assert.deepEqual([slot(ed).kind, slot(ed).value], ['ruler', 50]);
  light.onDial(ed, 'outline');
  light.onDial(ed, 'outline');
  assert.deepEqual([slot(ed).kind, slot(ed).selected], ['segment', 'brighten']);
  light.close(ed, {});
});

test('a dropped Amount drag reads as before it; a chip or Done under the other hand drops it too', () => {
  const ed = fakeEditor();
  light.open(ed, {});
  light.onDial(ed, 'outline');
  loop(ed, fingerAround(ed, { seed: 4 }));
  light.onRuler(ed, 'start');
  light.onRuler(ed, 'move', 67);
  light.onRuler(ed, 'end', 67); // the ruler is the tool's own state: from the default
  // A Paint stroke, then the loop: Undo mid-drag puts the stroke on top.
  const brush = { mode: 'brighten', r: 10, pts: [10, 10, 20, 20] };
  ed.pools = { ...ed.pools, strokes: { ...ed.pools.strokes, s1: brush } };
  ed.commit({ ...ed.committed, paint: [...ed.committed.paint, 's1'] }, 'Painted light');
  loop(ed, fingerAround(ed));
  // Undo mid-drag: the segment shows; the next loop gets the loop's amount
  // before the drag, not where the finger had got to.
  light.onRuler(ed, 'start');
  light.onRuler(ed, 'move', -20);
  ed.undo();
  light.onRuler(ed, 'end', -20);
  assert.deepEqual([slot(ed).kind, slot(ed).selected], ['segment', 'brighten']);
  loop(ed, fingerAround(ed, { seed: 9 }));
  assert.deepEqual([entry(ed).mode, entry(ed).amount], ['brighten', 0.67]);
  // A dial chip tapped while the ruler is held: the preview ends, the live
  // entry leaves the pool, and Outline on again starts a fresh session.
  light.onRuler(ed, 'start');
  light.onRuler(ed, 'move', 20);
  let liveId = ed.log.lives.at(-1).paint.at(-1);
  let n = ed.log.commits.length;
  light.onDial(ed, 'brightness');
  assert.equal(ed.log.lives.at(-1), null, 'the preview is cleared');
  assert.equal(ed.log.lives.at(-2), ed.committed, 'after the committed paint went back on the GPU');
  assert.ok(!(liveId in ed.pools.strokes), 'no stray entry');
  assert.equal(ed.log.commits.length, n, 'no step');
  assert.equal(slot(ed).id, 'brightness');
  light.onDial(ed, 'outline');
  assert.equal(slot(ed).kind, 'segment');
  // Done (close) while the ruler is held: the same, before the tool lets go.
  loop(ed, fingerAround(ed, { seed: 11 }));
  light.onRuler(ed, 'start');
  light.onRuler(ed, 'move', 20);
  liveId = ed.log.lives.at(-1).paint.at(-1);
  n = ed.log.commits.length;
  light.close(ed, { cancel: false });
  assert.equal(ed.log.lives.at(-1), null);
  assert.equal(ed.log.lives.at(-2), ed.committed);
  assert.ok(!(liveId in ed.pools.strokes));
  assert.equal(ed.log.commits.length, n);
  light.open(ed, {});
  light.onDial(ed, 'outline');
  assert.equal(slot(ed).kind, 'segment', 'a fresh session');
  light.close(ed, {});
});

test('a loop with the Amount ruler at 0 is no step; the label follows the segment', () => {
  const ed = fakeEditor();
  light.open(ed, {});
  light.onDial(ed, 'outline');
  loop(ed, fingerAround(ed));
  light.onRuler(ed, 'start');
  light.onRuler(ed, 'move', 0);
  light.onRuler(ed, 'end', 0);
  assert.equal(ed.log.commits.length, 2);
  assert.equal(entry(ed).amount, 0);
  assert.equal(slot(ed).value, 0);
  const strokes = Object.keys(ed.pools.strokes).length, hints = ed.log.hints.length, renders = ed.log.renders;
  assert.ok(loop(ed, fingerAround(ed, { seed: 9 })), 'the drag is taken');
  assert.equal(ed.log.commits.length, 2, 'but paints nothing, so makes no step');
  assert.equal(ed.committed.paint.length, 1);
  assert.equal(Object.keys(ed.pools.strokes).length, strokes, 'and leaves no entry');
  assert.equal(ed.log.hints.length, hints);
  assert.ok(ed.log.renders > renders, 'the loop still closed on screen');
  assert.deepEqual([slot(ed).kind, slot(ed).value], ['ruler', 0], 'the loop before is still up for adjusting');
  // Once no ruler shows that 0 (the chip off and on; Undo past the loop would do
  // too) a loop is not stuck at nothing: it takes the default, and the segment
  // names it (at 0 the sign cannot).
  light.onDial(ed, 'outline');
  light.onDial(ed, 'outline');
  light.onSegment(ed, 'darken');
  assert.equal(slot(ed).kind, 'segment');
  loop(ed, fingerAround(ed, { seed: 9 }));
  assert.equal(ed.log.commits.length, 3);
  assert.equal(ed.log.commits.at(-1).label, 'Darkened inside outline');
  assert.deepEqual([entry(ed).mode, entry(ed).amount], ['darken', 0.67]);
  assert.deepEqual([slot(ed).kind, slot(ed).value], ['ruler', -67]);
  light.onRuler(ed, 'start');
  light.onRuler(ed, 'move', -20);
  light.onRuler(ed, 'end', -20);
  assert.equal(ed.log.commits.at(-1).label, 'Darkened inside outline');
  loop(ed, fingerAround(ed, { seed: 11 }));
  assert.equal(ed.log.commits.at(-1).label, 'Darkened inside outline');
  assert.deepEqual([entry(ed).mode, entry(ed).amount], ['darken', 0.2]);
  light.onRuler(ed, 'reset'); // the ruler is the tool's own state: back to the default for the tests after
  assert.deepEqual([entry(ed).mode, entry(ed).amount], ['brighten', 0.67]);
  light.close(ed, {});
});

test('a change under a loop being traced rebuilds the edge map off the finger once the loop is over', async () => {
  const ed = fakeEditor();
  ed.commit({ ...ed.committed, crop: { ...ed.committed.crop } }, 'Crop'); // a step Undo can take away
  light.open(ed, {});
  light.onDial(ed, 'outline');
  const pts = fingerAround(ed);
  const reads = () => ed.log.reads.filter((r) => r.maxSide === 1024).length;
  const tick = () => new Promise((r) => setTimeout(r, 2));
  await tick();
  assert.equal(reads(), 1, 'built off the finger when the chip came on');
  const half = (t0) => {
    light.onGesture(ed, { type: 'drag-start', target: 'photo', x: pts[0][0], y: pts[0][1], t: t0 });
    for (let i = 1; i < pts.length; i++) {
      light.onGesture(ed, { type: 'drag', target: 'photo', x: pts[i][0], y: pts[i][1], dx: 0, dy: 0, t: t0 + i });
      light.drawOverlay(ed, overlay);
    }
  };
  // Undo takes the crop away while the finger is down: the hook's rebuild
  // waits, the lift's rebuild lands, and the next loop starts at once.
  half(1000);
  ed.undo();
  await tick();
  assert.equal(reads(), 1, 'not under the finger');
  light.onGesture(ed, { type: 'drag-end', t: 2000 });
  assert.equal(reads(), 1, 'nor on lift');
  await tick();
  assert.equal(reads(), 2, 'rebuilt off the finger');
  loop(ed, pts);
  assert.equal(reads(), 2, 'the next loop started on the map it had');
  assert.equal(ed.log.commits.length, 2, 'the Crop; the dropped loop; then one step');
  // The same through a cancel, with a step landing (no history hook) mid-trace.
  half(3000);
  ed.commit({ ...ed.committed, crop: { ...ed.committed.crop } }, 'Crop');
  assert.ok(light.onGesture(ed, { type: 'drag-cancel', t: 4000 }));
  assert.equal(reads(), 2);
  await tick();
  assert.equal(reads(), 3);
  loop(ed, fingerAround(ed, { seed: 4 }));
  assert.equal(reads(), 3);
  assert.equal(ed.log.commits.length, 4);
  light.close(ed, {});
});

test('the segment picks the mode; Erase clears the inside fully and shows no ruler; a new loop takes the ruler amount', () => {
  const ed = fakeEditor();
  light.open(ed, {});
  light.onDial(ed, 'outline');
  light.onSegment(ed, 'darken');
  loop(ed, fingerAround(ed));
  assert.equal(ed.log.commits[0].label, 'Darkened inside outline');
  assert.deepEqual([entry(ed).mode, entry(ed).amount], ['darken', 0.67]);
  assert.equal(slot(ed).value, -67);
  light.onRuler(ed, 'start');
  light.onRuler(ed, 'move', 50);
  light.onRuler(ed, 'end', 50);
  assert.equal(entry(ed).mode, 'brighten');
  // A second loop (around the same block, another wander) takes +50.
  const hints = ed.log.hints.length;
  loop(ed, fingerAround(ed, { seed: 9 }));
  assert.equal(ed.committed.paint.length, 2);
  assert.deepEqual([entry(ed).mode, entry(ed).amount], ['brighten', 0.5]);
  assert.equal(slot(ed).value, 50);
  assert.equal(ed.log.hints.length, hints + 1, 'outline-done is asked for again (the editor shows a hint once)');
  // Off and on brings the segment back, agreeing with the ruler's sign.
  light.onDial(ed, 'outline');
  light.onDial(ed, 'outline');
  assert.deepEqual([slot(ed).kind, slot(ed).selected], ['segment', 'brighten']);
  light.onSegment(ed, 'erase');
  const before = ed.log.hints.length;
  loop(ed, fingerAround(ed, { seed: 11 }));
  assert.equal(ed.log.commits.at(-1).label, 'Erased inside outline');
  assert.deepEqual([entry(ed).mode, entry(ed).amount], ['erase', 1]);
  assert.equal(slot(ed).kind, 'segment', 'nothing to set on an erase');
  assert.equal(ed.log.hints.length, before, 'no ruler, no ruler hint');
  light.close(ed, {});
});

test('a cancelled trace, a tap-sized loop and a loop off the photo make no step', () => {
  const ed = fakeEditor();
  light.open(ed, {});
  light.onDial(ed, 'outline');
  const pts = fingerAround(ed);
  assert.ok(loop(ed, pts.slice(0, 20), { cancel: true }));
  assert.equal(ed.log.commits.length, 0);
  assert.ok(loop(ed, [pts[0], [pts[0][0] + 1, pts[0][1] + 1]]), 'a tap-sized drag is taken');
  assert.equal(ed.log.commits.length, 0, 'but makes nothing');
  // Off the photo: every point in the ground beside it (the lasso clamps onto the map).
  const off = [[2, 100], [2, 140], [4, 180], [2, 220]];
  assert.ok(loop(ed, off));
  assert.equal(ed.log.commits.length, 0, 'a loop along the clamped edge encloses nothing');
  assert.ok(loop(ed, pts), 'and the tool is still fine');
  assert.equal(ed.log.commits.length, 1);
  light.close(ed, {});
});

test('a second finger (drag-cancel) mid-loop leaves no half loop; a hold starts a loop too', async () => {
  const ed = fakeEditor();
  light.open(ed, {});
  light.onDial(ed, 'outline');
  const pts = fingerAround(ed);
  light.onGesture(ed, { type: 'drag-start', target: 'photo', x: pts[0][0], y: pts[0][1], t: 0 });
  light.onGesture(ed, { type: 'drag', target: 'photo', x: pts[1][0], y: pts[1][1], dx: 0, dy: 0, t: 16 });
  assert.ok(light.onGesture(ed, { type: 'drag-cancel', t: 32 }));
  assert.ok(!light.onGesture(ed, { type: 'drag-end', x: 0, y: 0, t: 40 }), 'nothing to end');
  const hold = (n = pts.length) => {
    assert.ok(light.onGesture(ed, { type: 'hold-start', target: 'photo', x: pts[0][0], y: pts[0][1], t: 100 }));
    for (let i = 1; i < n; i++) {
      light.onGesture(ed, { type: 'hold-move', target: 'photo', x: pts[i][0], y: pts[i][1], t: 100 + i });
      light.drawOverlay(ed, overlay);
    }
  };
  // The reducer says hold-end for a second finger landing (then pinch-start in the
  // same batch) and for a pointercancel too: neither may paint (SPEC §4 rule 2).
  hold();
  assert.ok(light.onGesture(ed, { type: 'hold-end' }));
  assert.ok(!light.onGesture(ed, { type: 'pinch-start', cx: 0, cy: 0, target: 'photo' }), 'the editor still gets its pinch');
  await Promise.resolve();
  assert.equal(ed.log.commits.length, 0, 'a second finger on a held loop: no step');
  hold();
  assert.ok(light.onGesture(ed, { type: 'hold-end', cancelled: true }));
  await Promise.resolve();
  assert.equal(ed.log.commits.length, 0, 'a cancelled held loop: no step');
  // A plain lift of the held finger paints, after the microtask.
  hold();
  assert.ok(light.onGesture(ed, { type: 'hold-end', x: pts.at(-1)[0], y: pts.at(-1)[1], t: 900 }));
  assert.equal(ed.log.commits.length, 0, 'not yet');
  await Promise.resolve();
  assert.equal(ed.log.commits.length, 1);
  // Undo under the other hand changed the crop the loop was traced through: the loop is dropped.
  light.onGesture(ed, { type: 'drag-start', target: 'photo', x: pts[0][0], y: pts[0][1], t: 2000 });
  for (let i = 1; i < pts.length; i++) {
    light.onGesture(ed, { type: 'drag', target: 'photo', x: pts[i][0], y: pts[i][1], dx: 0, dy: 0, t: 2000 + i });
    light.drawOverlay(ed, overlay);
  }
  ed.commit({ ...ed.committed, crop: { ...ed.committed.crop } }, 'Crop');
  assert.ok(light.onGesture(ed, { type: 'drag-end', t: 3000 }));
  assert.equal(ed.log.commits.length, 2, 'no loop step after the crop moved under it');
  assert.equal(ed.committed.paint.length, 1);
  light.close(ed, {});
});

test('the polygon is stored in source px: a turned and flipped crop traces to the same place', () => {
  const ed = fakeEditor({ crop: (c) => flipHorizontal(rotateQuarter(c, W, H)) });
  light.open(ed, {});
  light.onDial(ed, 'outline');
  loop(ed, fingerAround(ed));
  assert.equal(ed.log.commits.length, 1);
  assert.ok(rectNear(boundsOf(entry(ed).poly), RECT, 4), `source-px box ${JSON.stringify(boundsOf(entry(ed).poly))}`);
  light.close(ed, {});
});

test('close drops the edge map and the loop; open starts clean', () => {
  const ed = fakeEditor();
  light.open(ed, {});
  light.onDial(ed, 'outline');
  loop(ed, fingerAround(ed));
  const reads = () => ed.log.reads.filter((r) => r.maxSide === 1024).length;
  assert.equal(reads(), 1);
  loop(ed, fingerAround(ed, { seed: 4 }));
  assert.equal(reads(), 1, 'the map is kept while the photo is the same');
  light.close(ed, {});
  light.open(ed, {});
  assert.equal(chip(ed, 'outline').value, 'Off');
  assert.equal(light.claimsHold, false);
  light.onDial(ed, 'outline');
  assert.equal(slot(ed).kind, 'segment', 'a fresh session: the last loop is not up for adjusting');
  loop(ed, fingerAround(ed, { seed: 6 }));
  assert.equal(reads(), 2, 'rebuilt after close');
  assert.equal(ed.committed.paint.length, 3);
  light.close(ed, {});
});
