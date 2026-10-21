import test from 'node:test';
import assert from 'node:assert/strict';
import { createDoc } from '../lib/doc.js';
import { outputSize, outputToSource, multiply, rotateQuarter, flipHorizontal } from '../lib/geometry.js';
import { polygonRecord, transformPolygon } from '../lib/lasso.js';
import { createSubjectLift } from '../ui/subject.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

function editor() {
  const doc = createDoc({ id: 'subject', w: 4000, h: 3000, natW: 4000, natH: 3000, sourceType: 'jpeg', now: 0 });
  const ed = {
    committed: doc, session: 3, revision: 0, history: {}, toolId: 'light', view: { scale: 0.25 },
    outputSize: () => outputSize(ed.committed.crop), stageToDoc: (x, y) => [x * 4, y * 4],
    readOutput(options) {
      ed.reads.push(options);
      const o = ed.outputSize(), k = 1024 / Math.max(o.width, o.height);
      return { width: Math.round(o.width * k), height: Math.round(o.height * k), data: new Uint8ClampedArray(4) };
    },
    reads: [], notices: [], refreshes: 0,
    toast(text) { ed.notices.push(text); }, refresh() { ed.refreshes++; },
  };
  return ed;
}

test('subject uses the current analysis output and the lasso crop/rotation/flip matrix', async () => {
  const ed = editor();
  ed.committed = { ...ed.committed, crop: flipHorizontal(rotateQuarter(ed.committed.crop, 4000, 3000), 4000, 3000) };
  let sent;
  const commits = [];
  const ring = [80, 100, 280, 100, 280, 400, 80, 400];
  const lift = createSubjectLift({
    request: async (image, x, y, options) => {
      sent = { image, x, y, options };
      return { found: true, w: image.width, h: image.height, polygons: [[10, 10, 12, 10, 12, 12], ring] };
    }, feedback() {},
  });
  assert.equal(lift.tap(ed, 150, 200, { tool: 'light', commit: (_, poly) => commits.push(poly) }), true);
  await flush();
  assert.deepEqual(ed.reads, [{ maxSide: 1024, tone: false }]);
  assert.equal(commits.length, 1, 'disconnected subject parts become one step');
  const o = ed.outputSize(), kx = sent.image.width / o.width, ky = sent.image.height / o.height;
  assert.equal(sent.x, 600 * kx); assert.equal(sent.y, 800 * ky);
  assert.deepEqual(sent.options, { radius: 12 });
  const matrix = multiply(outputToSource(ed.committed.crop, 4000, 3000), [1 / kx, 0, 0, 1 / ky, 0, 0]);
  assert.deepEqual(commits[0], polygonRecord(transformPolygon(ring, matrix)));
  assert.equal(lift.pending, false);
});

test('old subject results cannot cross Done/Cancel, document changes, history, or later requests', async () => {
  for (const invalidate of [
    (ed, lift) => lift.cancel(),
    (ed) => { ed.session++; },
    (ed) => { ed.toolId = 'home'; },
    (ed) => { ed.committed = { ...ed.committed, id: 'new-photo' }; },
    (ed) => { ed.revision++; },
    (ed) => { ed.history = {}; },
  ]) {
    const ed = editor(), wait = deferred(), commits = [];
    const lift = createSubjectLift({ request: () => wait.promise, feedback() {} });
    lift.tap(ed, 100, 100, { tool: 'light', commit: (_, p) => commits.push(p) });
    invalidate(ed, lift);
    wait.resolve({ found: true, polygons: [[20, 20, 300, 20, 300, 300, 20, 300]] });
    await flush();
    assert.equal(commits.length, 0);
    assert.deepEqual(ed.notices, [], 'stale completion stays quiet');
  }
  const ed = editor(), a = deferred(), b = deferred(), commits = [];
  let count = 0;
  const lift = createSubjectLift({ request: () => (++count === 1 ? a.promise : b.promise), feedback() {} });
  const options = { tool: 'light', commit: (_, p) => commits.push(p) };
  lift.tap(ed, 100, 100, options); lift.tap(ed, 110, 100, options);
  a.resolve({ found: false }); await flush();
  assert.equal(lift.pending, true, 'old completion cannot clear the next request’s progress');
  b.resolve({ found: true, polygons: [[20, 20, 300, 20, 300, 300, 20, 300]] }); await flush();
  assert.equal(commits.length, 1); assert.equal(lift.pending, false);
  assert.deepEqual(ed.notices, []);
});

test('no subject, unsupported inference, tiny regions and off-photo taps are safe no-ops', async () => {
  for (const result of [
    { found: false },
    { found: true, polygons: [[1, 1, 2, 1, 2, 2]] },
    new Error('Vision unsupported'),
  ]) {
    const ed = editor(), feedback = [], commits = [];
    const lift = createSubjectLift({ request: async () => { if (result instanceof Error) throw result; return result; }, feedback: (kind) => feedback.push(kind) });
    lift.tap(ed, 100, 100, { tool: 'light', commit: (_, p) => commits.push(p) }); await flush();
    assert.equal(commits.length, 0); assert.equal(ed.notices.length, 1);
    assert.deepEqual(feedback, ['light', 'warning']); assert.equal(lift.pending, false);
  }
  const ed = editor(); let calls = 0;
  const lift = createSubjectLift({ request() { calls++; }, feedback() {} });
  lift.tap(ed, -10, 0, { tool: 'light', commit() { assert.fail('off-photo commit'); } }); await flush();
  assert.equal(calls, 0); assert.equal(lift.pending, false); assert.deepEqual(ed.notices, []);
});
