// End-to-end adapter tests: the real platform/transport/importer, with only the
// native host and local HTTP responses replaced. No image bytes cross messages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitWorkingSize, WORK_MAX_PIXELS, WORK_FALLBACK_PIXELS } from '../lib/image-io.js';
import { createNativeBridge, createTransfers, NativeError, NATIVE_ORIGIN } from '../lib/native-bridge.js';
import { decodeForEditing } from '../ui/importer.js';

const ok = (result) => ({ ok: true, result });
const failure = (code) => ({ ok: false, error: { code, message: code } });
const hasCode = (code) => (error) => error?.code === code;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
let unique = 0;

function png(width, height) {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

async function setup(t, { capabilities = ['photos', 'decode', 'subject', 'haptic', 'transfer-post'] } = {}) {
  const saved = new Map(['__gessoNative', 'webkit', 'fetch', 'document', 'createImageBitmap'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const host = {
    files: new Map(), calls: [], fetches: [], hooks: {}, picked: null,
    info: { natW: 8000, natH: 6000, raw: true },
    issue(bytes, { name = 'photo.png', type = 'image/png', ...extra } = {}) {
      const ext = type === 'image/png' ? 'png' : type === 'image/jpeg' ? 'jpg' : 'dng';
      const url = `${NATIVE_ORIGIN}/xfer/00000000-0000-4000-8000-${String(++unique).padStart(12, '0')}.${ext}`;
      const ref = { url, name, type, size: bytes.length, ...extra };
      host.files.set(url, { bytes, ref });
      return ref;
    },
    defaultReply(op, args) {
      if (op === 'photo.pick') return ok(host.picked);
      if (op === 'image.info') return ok(host.info);
      if (op === 'image.decode') return ok(host.issue(png(args.w, args.h), { w: args.w, h: args.h }));
      if (op === 'xfer.create') return ok(host.issue(new Uint8Array(args.size), args));
      if (op === 'xfer.release') { host.files.delete(args.url); return ok({}); }
      if (op === 'photos.save') return ok({ saved: true });
      if (op === 'share') return ok({ completed: true, activity: 'com.apple.UIKit.activity.SaveToCameraRoll' });
      return ok({});
    },
  };
  globalThis.__gessoNative = { api: 1, bridge: 'gesso', origin: NATIVE_ORIGIN, capabilities };
  globalThis.webkit = { messageHandlers: { gesso: { postMessage({ op, args }) {
    host.calls.push({ op, args });
    try { return Promise.resolve(host.hooks[op] ? host.hooks[op](args) : host.defaultReply(op, args)); }
    catch (error) { return Promise.reject(error); }
  } } } };
  globalThis.fetch = async (url, options = {}) => {
    host.fetches.push({ url, ...options });
    const entry = host.files.get(url);
    if (!entry) return new Response('', { status: 404 });
    if (options.method === 'POST') {
      assert.ok(options.body instanceof ArrayBuffer);
      entry.bytes = new Uint8Array(options.body);
      return Response.json({ size: entry.bytes.length });
    }
    return new Response(entry.bytes, { headers: { 'Content-Type': entry.ref.type } });
  };
  globalThis.document = { querySelector: () => null };
  host.platform = await import(`../ui/platform.js?native-audit=${++unique}`);
  host.releases = () => host.calls.filter(({ op }) => op === 'xfer.release').map(({ args }) => args.url);
  return host;
}

test('native picker cancel does not fetch or decode; common photos keep their bytes and metadata', async (t) => {
  const host = await setup(t), p = host.platform;
  assert.equal(await p.pickPhoto({ input: null }), null);
  assert.deepEqual(host.calls.map(({ op }) => op), ['photo.pick']);
  assert.deepEqual(host.fetches, []);
  const bytes = new Uint8Array([255, 216, 255, 1, 2, 3]);
  host.picked = host.issue(bytes, { type: 'image/jpeg', name: 'normal.jpg' });
  host.info = { natW: 4032, natH: 3024, raw: false };
  const file = await p.pickPhoto({ maxPixels: WORK_MAX_PIXELS, input: null });
  assert.equal(file.name, 'normal.jpg'); assert.equal(file.type, 'image/jpeg');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
  assert.deepEqual(p.nativeInfo(file), { natW: 4032, natH: 3024, raw: false, rendered: false, downscaled: false });
  assert.equal(host.calls.some(({ op }) => op === 'image.decode'), false);
  assert.deepEqual(host.releases(), [host.picked.url]);
  assert.equal(host.files.size, 0);
});

test('RAW import develops before download, requests exact JS fit, and stores only PNG pixels', async (t) => {
  const host = await setup(t), p = host.platform;
  host.picked = host.issue(new Uint8Array([73, 73, 42, 0, 1, 2]), { type: 'image/x-adobe-dng', name: 'ProRAW.dng' });
  const file = await p.pickPhoto({ maxPixels: WORK_MAX_PIXELS, input: null });
  const fit = fitWorkingSize(8000, 6000, WORK_MAX_PIXELS);
  const decode = host.calls.find(({ op }) => op === 'image.decode');
  assert.deepEqual(decode.args, { url: host.picked.url, w: fit.width, h: fit.height });
  assert.equal(file.type, 'image/png');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), png(fit.width, fit.height));
  assert.deepEqual(p.nativeInfo(file), { natW: 8000, natH: 6000, rendered: true, downscaled: true });
  assert.equal(host.fetches.length, 1);
  assert.notEqual(host.fetches[0].url, host.picked.url, 'original DNG never enters WebContent');
  assert.equal(host.releases().length, 2); assert.equal(host.files.size, 0);
});

test('native RAW allocation failure retries once at 12MP without another picker or RAW download', async (t) => {
  const host = await setup(t);
  host.picked = host.issue(new Uint8Array([73, 73, 42, 0, 1, 2]), { type: 'image/x-adobe-dng' });
  host.hooks['image.decode'] = (args) => args.w * args.h > WORK_FALLBACK_PIXELS ? failure('memory') : host.defaultReply('image.decode', args);
  const file = await host.platform.pickPhoto({ maxPixels: WORK_MAX_PIXELS, input: null });
  const decodes = host.calls.filter(({ op }) => op === 'image.decode');
  const smaller = fitWorkingSize(8000, 6000, WORK_FALLBACK_PIXELS);
  assert.equal(decodes.length, 2);
  assert.deepEqual(decodes[1].args, { url: host.picked.url, w: smaller.width, h: smaller.height });
  assert.equal(host.calls.filter(({ op }) => op === 'photo.pick').length, 1);
  assert.equal(host.fetches.length, 1); assert.notEqual(host.fetches[0].url, host.picked.url);
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), png(smaller.width, smaller.height));
  assert.equal(host.files.size, 0);
});

test('RAW errors other than allocation are not retried and release the picker file', async (t) => {
  const host = await setup(t);
  host.picked = host.issue(new Uint8Array([73, 73, 42, 0, 1, 2]), { type: 'image/x-adobe-dng' });
  host.hooks['image.decode'] = () => failure('unreadable');
  await assert.rejects(host.platform.pickPhoto({ maxPixels: WORK_MAX_PIXELS, input: null }), hasCode('unreadable'));
  assert.equal(host.calls.filter(({ op }) => op === 'image.decode').length, 1);
  assert.deepEqual(host.releases(), [host.picked.url]); assert.equal(host.files.size, 0);
});

test('native fallback reuploads ordinary files byte-exactly and releases source and output', async (t) => {
  const host = await setup(t), p = host.platform;
  const bytes = new Uint8Array([73, 73, 42, 0, 7, 8, 9]);
  const file = new File([bytes], 'restore.dng', { type: 'image/x-adobe-dng' });
  const result = await p.decodeNative(file, { maxPixels: WORK_FALLBACK_PIXELS });
  const post = host.fetches.find(({ method }) => method === 'POST');
  assert.deepEqual(new Uint8Array(post.body), bytes);
  assert.deepEqual([result.natW, result.natH, result.downscaled], [8000, 6000, true]);
  assert.equal(result.file.type, 'image/png');
  assert.equal(p.nativeInfo(result.file).rendered, true);
  assert.equal(host.releases().length, 2); assert.equal(host.files.size, 0);
});

test('a normalized RAW PNG keeps the plain-web smaller retry after allocation failure', async (t) => {
  const host = await setup(t), p = host.platform;
  host.picked = host.issue(new Uint8Array([73, 73, 42, 0, 1, 2]), { type: 'image/x-adobe-dng' });
  const file = await p.pickPhoto({ maxPixels: WORK_MAX_PIXELS, input: null });
  const initial = fitWorkingSize(8000, 6000, WORK_MAX_PIXELS), resizes = [];
  const callCount = host.calls.length;
  globalThis.createImageBitmap = async (source, options) => {
    assert.equal(source, file); resizes.push(options);
    if (options.resizeWidth === initial.width) throw new Error('WebContent allocation failed');
    return { width: options.resizeWidth, height: options.resizeHeight, close() {} };
  };
  await assert.rejects(decodeForEditing(file, { maxPixels: WORK_MAX_PIXELS, nativeAdapter: p }), (error) => !error.unsupported);
  const decoded = await decodeForEditing(file, { maxPixels: WORK_FALLBACK_PIXELS, nativeAdapter: p });
  assert.equal(decoded.sourceFile, file);
  assert.deepEqual([decoded.natW, decoded.natH], [8000, 6000]);
  assert.ok(decoded.bitmap.width * decoded.bitmap.height <= WORK_FALLBACK_PIXELS);
  assert.equal(host.calls.length, callCount, 'step-down needs no released source URL or native rescue');
  assert.equal(resizes.length, 2);
});

test('Photos outcomes and sharing retain the local file through completion and always release it', async (t) => {
  const host = await setup(t), p = host.platform, blob = new Blob(['jpeg'], { type: 'image/jpeg' });
  for (const outcome of [{ saved: true }, ...['denied', 'restricted', 'failed'].map((reason) => ({ saved: false, reason }))]) {
    host.hooks['photos.save'] = ({ url, name }) => {
      assert.ok(host.files.has(url)); assert.equal(name, 'edited.jpg'); return ok(outcome);
    };
    assert.deepEqual(await p.saveToPhotos(blob, 'edited.jpg'), outcome);
    assert.equal(host.files.size, 0);
  }
  for (const outcome of [
    { completed: false, activity: null },
    { completed: true, activity: 'com.apple.UIKit.activity.AirDrop' },
    { completed: true, activity: 'com.apple.UIKit.activity.SaveToCameraRoll' },
  ]) {
    const completion = deferred(); let liveURL;
    host.hooks.share = ({ url }) => { liveURL = url; return completion.promise; };
    const result = p.share(blob, 'edited.jpg');
    while (!liveURL) await flush();
    assert.ok(host.files.has(liveURL), 'native work owns a live file until it finishes');
    completion.resolve(ok(outcome));
    assert.deepEqual(await result, outcome); assert.equal(host.files.size, 0);
  }
  assert.equal(host.calls.filter(({ op }) => op === 'photos.save').length, 4);
  assert.equal(host.calls.filter(({ op }) => op === 'share').length, 3);
});

test('malformed Photos/share results and native errors never leak their uploaded file', async (t) => {
  const host = await setup(t), blob = new Blob(['jpeg'], { type: 'image/jpeg' });
  for (const [op, result] of [['photos.save', { saved: false }], ['photos.save', { saved: 1 }], ['share', { completed: true }], ['share', { completed: 1, activity: null }]]) {
    host.hooks[op] = () => ok(result);
    await assert.rejects(op === 'photos.save' ? host.platform.saveToPhotos(blob) : host.platform.share(blob), hasCode('protocol'));
    assert.equal(host.files.size, 0);
  }
  for (const op of ['photos.save', 'share']) {
    host.hooks[op] = () => failure('busy');
    await assert.rejects(op === 'photos.save' ? host.platform.saveToPhotos(blob) : host.platform.share(blob), hasCode('busy'));
    assert.equal(host.files.size, 0);
  }
});

test('metadata rejection still releases valid issued picker and decoded files', async (t) => {
  const host = await setup(t), p = host.platform;
  const picker = host.issue(new Uint8Array([1, 2, 3]));
  host.picked = { ...picker, name: '' };
  await assert.rejects(p.pickPhoto({ input: null }), hasCode('protocol'));
  assert.deepEqual(host.releases(), [picker.url]); assert.equal(host.files.size, 0);
  host.picked = host.issue(new Uint8Array([73, 73, 42, 0]));
  let invalid;
  host.hooks['image.decode'] = (args) => {
    invalid = host.issue(png(args.w, args.h), { w: args.w, h: args.h });
    return ok({ ...invalid, size: -1 });
  };
  await assert.rejects(p.pickPhoto({ input: null }), hasCode('protocol'));
  assert.ok(host.releases().includes(invalid.url)); assert.equal(host.files.size, 0);
});

test('a malformed transfer reservation is released only if its URL is canonical', async (t) => {
  const host = await setup(t), blob = new Blob(['abc'], { type: 'image/png' });
  let reservation;
  host.hooks['xfer.create'] = (args) => {
    reservation = host.defaultReply('xfer.create', args).result;
    return ok({ ...reservation, name: '' });
  };
  await assert.rejects(host.platform.putFile(blob), hasCode('protocol'));
  assert.deepEqual(host.releases(), [reservation.url]); assert.equal(host.files.size, 0);
  const releaseCount = host.releases().length;
  host.hooks['xfer.create'] = () => ok({ ...reservation, url: 'file:///etc/passwd' });
  await assert.rejects(host.platform.putFile(blob), hasCode('badUrl'));
  assert.equal(host.releases().length, releaseCount, 'foreign URLs never reach another native operation');
});

test('decoded dimension/type mismatches fail protocol and release both native files', async (t) => {
  const host = await setup(t);
  for (const mismatch of [{ w: 1 }, { type: 'image/jpeg' }]) {
    host.picked = host.issue(new Uint8Array([73, 73, 42, 0]));
    host.hooks['image.decode'] = (args) => ok({ ...host.defaultReply('image.decode', args).result, ...mismatch });
    await assert.rejects(host.platform.pickPhoto({ input: null }), hasCode('protocol'));
    assert.equal(host.files.size, 0);
  }
});

test('malformed injected capability metadata disables subject UI without throwing', async (t) => {
  for (const capabilities of [{}, null, 'subject', 17]) {
    const host = await setup(t, { capabilities });
    assert.equal(host.platform.subjectLiftAvailable(), false);
  }
});

test('ambiguous or undefined native envelopes cannot turn an error into success', async () => {
  const flag = { api: 1, bridge: 'gesso', origin: NATIVE_ORIGIN };
  const replies = [
    { ok: true, result: undefined },
    { ok: true, result: { saved: true }, error: { code: 'failed', message: 'Save failed' } },
    { ok: false, result: { saved: true }, error: { code: 'failed', message: 'Save failed' } },
  ];
  const bridge = createNativeBridge({ flag, handler: { postMessage: async () => replies.shift() } });
  for (let i = 0; i < 3; i++) await assert.rejects(bridge.call('photos.save'), hasCode('protocol'));
});

test('transfer deadline covers stalled upload/download bodies and aborts their request', async () => {
  for (const operation of ['upload', 'download']) {
    const body = deferred(), calls = []; let signal;
    const url = `${NATIVE_ORIGIN}/xfer/00000000-0000-4000-8000-000000000001.png`;
    const ref = { url, name: 'photo.png', type: 'image/png', size: 3 };
    const transfers = createTransfers({ timeout: 10,
      call: async (op) => { calls.push(op); return op === 'xfer.create' ? ref : {}; },
      fetch: async (_, options) => { signal = options.signal; return { ok: true, json: () => body.promise, blob: () => body.promise }; },
    });
    const pending = operation === 'upload' ? transfers.putFile(new Blob(['abc'], { type: 'image/png' })) : transfers.fetchFile(ref);
    let deadline;
    try {
      const bounded = Promise.race([pending, new Promise((_, reject) => { deadline = setTimeout(() => reject(new NativeError('watchdog', 'Transfer body never timed out')), 80); })]);
      await assert.rejects(bounded, hasCode('timeout'));
      assert.equal(signal.aborted, true);
      if (operation === 'upload') assert.deepEqual(calls, ['xfer.create', 'xfer.release']);
    } finally {
      clearTimeout(deadline);
      body.reject(new Error('late body rejection'));
      await pending.catch(() => {});
    }
  }
});
