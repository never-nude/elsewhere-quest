// Exercise the actual tool tap cases and platform transfer with a native stub.
// Vision is the only replaced computation; Outline entries/caps remain real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDoc } from '../lib/doc.js';
import { outputSize } from '../lib/geometry.js';

const noop = () => {};
const files = new Map(), calls = [], requests = [];
let serial = 0;
globalThis.__gessoNative = { api: 1, bridge: 'gesso', origin: 'gesso://localhost', capabilities: ['subject'] };
globalThis.webkit = { messageHandlers: { gesso: { async postMessage({ op, args }) {
  calls.push({ op, args });
  if (op === 'xfer.create') {
    const url = `gesso://localhost/xfer/00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}.png`;
    const ref = { url, ...args }; files.set(url, ref);
    return { ok: true, result: ref };
  }
  if (op === 'xfer.release') { files.delete(args.url); return { ok: true, result: {} }; }
  if (op === 'subject.mask') return new Promise((resolve) => requests.push({ args, resolve: (result) => resolve({ ok: true, result }) }));
  return { ok: true, result: {} };
} } } };
globalThis.fetch = async (url, options) => {
  assert.ok(files.has(url));
  assert.equal(options.method, 'POST');
  assert.ok(options.body instanceof ArrayBuffer, 'analysis pixels never travel as base64');
  return new Response(JSON.stringify({ size: options.body.byteLength }), { status: 200 });
};
const context = () => new Proxy({}, { get: (t, k) => t[k] ?? noop, set: (t, k, value) => { t[k] = value; return true; } });
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: context, toBlob: (done) => done(new Blob(['png'], { type: 'image/png' })) }),
  getElementById: () => null,
};
globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: noop };
const { default: light } = await import('../ui/tools/light.js');
const { default: remove } = await import('../ui/tools/remove.js');
const { createHints } = await import('../ui/hints-ui.js');

const W = 600, H = 480;
function editor(toolId) {
  const ed = {
    toolId, session: 1, revision: 0,
    committed: createDoc({ id: `native-${toolId}`, w: W, h: H, natW: W, natH: H, sourceType: 'jpeg', now: 0 }),
    get doc() { return ed.committed; }, pools: { strokes: {}, patches: {} }, view: { scale: 1 },
    renderer: { size: { width: W, height: H }, readRect: () => assert.fail('subject tap cannot enter spot healing') },
    outputSize: () => outputSize(ed.committed.crop), stageToDoc: (x, y) => [x, y],
    readOutput: () => ({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4) }),
    refresh: noop, requestRender: noop, hint: noop, notices: [], commits: [],
    panel: { ruler: () => null, showTip: (text) => ed.notices.push(text) }, toast: (text) => ed.notices.push(text),
    commit(next, label) { ed.committed = next; ed.revision++; ed.commits.push(label); },
  };
  return ed;
}
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((done) => setImmediate(done)); };
async function start(tool, ed) {
  const n = requests.length;
  assert.equal(tool.onGesture(ed, { type: 'tap', target: 'photo', x: 240, y: 200 }), true);
  await flush();
  assert.equal(requests.length, n + 1);
  assert.equal(tool.panel(ed).hint, 'Finding the subject…');
  return requests.at(-1);
}
const found = (ring = [180, 140, 380, 140, 380, 300, 180, 300]) => ({ found: true, w: W, h: H, polygons: [ring] });

test('Light Outline tap makes an ordinary adjustable polygon step through native transfer', async () => {
  const ed = editor('light'); light.open(ed); light.onDial(ed, 'outline');
  const req = await start(light, ed);
  assert.equal(req.args.x, 240); assert.equal(req.args.y, 200); assert.equal(req.args.radius, 12);
  req.resolve(found()); await flush();
  assert.equal(ed.committed.paint.length, 1);
  const entry = ed.pools.strokes[ed.committed.paint[0]];
  assert.equal(entry.kind, 'outline'); assert.equal(entry.mode, 'brighten');
  assert.deepEqual(entry.poly, [180, 140, 380, 140, 380, 300, 180, 300]);
  assert.equal(light.panel(ed).slot.id, 'outlineAmount');
  assert.equal(files.size, 0, 'analysis transfer is released');
  light.close(ed);
});

test('Remove Outline tap respects its existing area cap and never falls through to spot healing', async () => {
  const ed = editor('remove'); remove.open(ed); remove.onDial(ed, 'outline');
  const req = await start(remove, ed);
  req.resolve(found([0, 0, W, 0, W, H, 0, H])); await flush();
  assert.deepEqual(ed.notices, ['Big area. Do it in smaller pieces.']);
  assert.equal(remove.settle(), null); assert.deepEqual(ed.committed.remove, []);
  assert.equal(files.size, 0);
  remove.close(ed, { cancel: true });
});

test('tool close, history, mode changes and another gesture invalidate pending subject work', async () => {
  for (const tool of [light, remove]) {
    for (const action of ['done', 'cancel', 'history', 'mode', 'gesture']) {
      const ed = editor(tool.id); tool.open(ed); tool.onDial(ed, 'outline');
      const req = await start(tool, ed);
      if (action === 'done' || action === 'cancel') tool.close(ed, { cancel: action === 'cancel' });
      else if (action === 'history') tool.onHistory(ed);
      else if (action === 'mode') tool.onDial(ed, tool.id === 'light' ? 'brightness' : 'size');
      else tool.onGesture(ed, { type: 'pinch-start', target: 'photo' });
      req.resolve(found()); await flush();
      assert.deepEqual(ed.commits, [], `${tool.id} after ${action}`);
      assert.deepEqual(ed.notices, [], `${tool.id} stale completion stays quiet`);
      assert.equal(tool.settle?.() ?? null, null);
      tool.close(ed, { cancel: true });
    }
  }
  assert.equal(files.size, 0, 'even discarded results release their native files');
});

test('native first-use Outline hint teaches tap and loop together', () => {
  const tips = [], store = new Map();
  const hints = createHints(() => ({ panel: { showTip: (text) => tips.push(text) } }), {
    storage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) },
    panelEl: () => null, covers: () => [], defer: (fn) => fn(),
  });
  hints.event('outline-on', { tool: 'light' });
  assert.deepEqual(tips, ['Tap it, or loop around it. The line snaps to edges.']);
});

test('Light Outline leaves caption taps for the editor’s Text selection', async () => {
  const ed = editor('light'); light.open(ed); light.onDial(ed, 'outline');
  const count = requests.length;
  assert.equal(light.onGesture(ed, { type: 'tap', target: 'caption:one', x: 240, y: 200 }), false);
  await flush();
  assert.equal(requests.length, count);
  light.close(ed);
});
