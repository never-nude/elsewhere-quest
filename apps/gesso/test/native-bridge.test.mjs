import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  NATIVE_ORIGIN, TIMEOUTS, NativeError, createNativeBridge, createTransfers,
  transferURL, fileRef, imageInfo, subjectResult,
} from '../lib/native-bridge.js';

const flag = { api: 1, bridge: 'gesso', origin: NATIVE_ORIGIN, capabilities: ['subject'] };
const url = `${NATIVE_ORIGIN}/xfer/12345678-1234-1234-1234-123456789abc.jpg`;
const ref = (size = 10) => ({ url, size, name: 'photo.jpg', type: 'image/jpeg' });
const errorCode = (code) => (err) => err instanceof NativeError && err.code === code;

test('native requires the pinned identity, supported API and callable reply handler', async () => {
  for (const invalid of [undefined, {}, { ...flag, api: 2 }, { ...flag, origin: 'gesso://app' }, { ...flag, bridge: 'other' }]) {
    const b = createNativeBridge({ flag: invalid, handler: { postMessage() {} } });
    assert.equal(b.isNative, false);
    await assert.rejects(b.call('ping'), errorCode('web'));
  }
  assert.equal(createNativeBridge({ flag, handler: {} }).isNative, false);
});

test('one promise per {op,args}, without request IDs or mutable reply maps', async () => {
  const sent = [];
  const b = createNativeBridge({ flag, handler: { postMessage(body) {
    sent.push(body); return Promise.resolve({ ok: true, result: { api: 1 } });
  } } });
  assert.deepEqual(await b.call('ping'), { api: 1 });
  assert.deepEqual(sent, [{ op: 'ping', args: {} }]);
  assert.equal(b.native, flag);
});

test('concurrent replies settle their own calls even when returned in reverse order', async () => {
  const pending = [];
  const b = createNativeBridge({ flag, handler: { postMessage() { return new Promise((resolve) => pending.push(resolve)); } } });
  const a = b.call('one'), z = b.call('two');
  pending[1]({ ok: true, result: 'second' });
  pending[0]({ ok: true, result: 'first' });
  assert.deepEqual(await Promise.all([a, z]), ['first', 'second']);
});

test('success, null cancellation, native errors and malformed replies are distinct', async () => {
  const answers = [{ ok: true, result: null }, { ok: false, error: { code: 'busy', message: 'Busy' } },
    null, { ok: true }, { ok: false, error: { message: 'missing code' } }, { result: {} }];
  const b = createNativeBridge({ flag, handler: { postMessage() { return Promise.resolve(answers.shift()); } } });
  assert.equal(await b.call('photo.pick'), null);
  await assert.rejects(b.call('ping'), errorCode('busy'));
  for (let i = 0; i < 4; i++) await assert.rejects(b.call('ping'), errorCode('protocol'));
});

test('synchronous handler throw, rejection and non-promise replies are contained', async () => {
  for (const postMessage of [() => { throw new Error('sync'); }, () => Promise.reject(new Error('async'))]) {
    await assert.rejects(createNativeBridge({ flag, handler: { postMessage } }).call('ping'), errorCode('transport'));
  }
  await assert.rejects(createNativeBridge({ flag, handler: { postMessage: () => ({ ok: true, result: {} }) } }).call('ping'), errorCode('protocol'));
});

test('timers are cleared on success and rejection; a late rejection after timeout is consumed', async () => {
  let clearCount = 0, expire, lateReject;
  const b = createNativeBridge({ flag, setTimer: (fn) => { expire = fn; return 37; }, clearTimer: (id) => { assert.equal(id, 37); clearCount++; },
    handler: { postMessage: () => new Promise((_, reject) => { lateReject = reject; }) } });
  const pending = b.call('ping');
  expire();
  await assert.rejects(pending, errorCode('timeout'));
  lateReject(new Error('arrived after timeout'));
  await new Promise((r) => setImmediate(r));
  assert.equal(clearCount, 1);
  for (const reply of [{ ok: true, result: {} }, { ok: false, error: { code: 'failed', message: 'no' } }]) {
    const p = createNativeBridge({ flag, setTimer: () => 37, clearTimer: () => clearCount++, handler: { postMessage: () => Promise.resolve(reply) } }).call('ping');
    await p.catch(() => {});
  }
  assert.equal(clearCount, 3);
});

test('a misbehaving thenable cannot double-settle a bridge promise', async () => {
  const b = createNativeBridge({ flag, handler: { postMessage: () => ({ then(resolve, reject) {
    resolve({ ok: true, result: 'first' }); reject(new Error('second')); resolve({ ok: true, result: 'third' });
  } }) } });
  assert.equal(await b.call('ping'), 'first');
});

test('all documented operations have bounded waits and exact spelling', () => {
  const contract = readFileSync(new URL('../ios/BRIDGE.md', import.meta.url), 'utf8');
  const ops = [...contract.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual(Object.keys(TIMEOUTS).sort(), ops.sort());
  assert.ok(Object.values(TIMEOUTS).every((n) => Number.isFinite(n) && n > 0));
});

test('only canonical issued-name transfer URLs are accepted', () => {
  assert.equal(transferURL(url), url);
  for (const bad of [null, 'file:///etc/passwd', 'gesso://app/xfer/a.jpg', `${url}?x=1`, `${url}#x`,
    url.replace('localhost', 'localhost:80'), url.replace('localhost', 'user@localhost'),
    `${NATIVE_ORIGIN}/xfer/../secret`, `${NATIVE_ORIGIN}/xfer/%2e%2e/secret`,
    `${NATIVE_ORIGIN}/xfer/photo.jpg`, `${NATIVE_ORIGIN}/xfer/12345678-1234-1234-1234-123456789abc.jpg/`,
    url.replace('jpg', '%6apg')]) assert.throws(() => transferURL(bad), errorCode('badUrl'));
});

test('file and image metadata are validated before fetching or fitting', () => {
  assert.equal(fileRef(ref()).size, 10);
  for (const bad of [{ ...ref(), size: -1 }, { ...ref(), size: 2 ** 30 }, { ...ref(), size: 1.5 },
    { ...ref(), type: 'text/html\r\nx: y' }, { ...ref(), name: '' }]) assert.throws(() => fileRef(bad), errorCode('protocol'));
  assert.equal(imageInfo({ natW: 8000, natH: 6000, raw: true }).raw, true);
  for (const bad of [{ natW: 0, natH: 2, raw: true }, { natW: 2, natH: NaN, raw: true },
    { natW: 2, natH: 2 }]) assert.throws(() => imageInfo(bad), errorCode('protocol'));
});

test('a 5 MB photo transfers byte-exactly through an issued ArrayBuffer POST and is released', async () => {
  const bytes = new Uint8Array(5 * 1024 ** 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 17) & 255;
  const blob = new Blob([bytes], { type: 'image/jpeg' });
  const calls = [];
  let stored;
  const t = createTransfers({ call: async (op, args) => {
    calls.push({ op, args });
    return op === 'xfer.create' ? ref(blob.size) : {};
  }, fetch: async (at, options) => {
    assert.equal(at, url);
    if (options.method === 'POST') {
      assert.ok(options.body instanceof ArrayBuffer);
      stored = new Uint8Array(options.body);
      return Response.json({ size: stored.byteLength });
    }
    return new Response(stored, { headers: { 'Content-Type': 'image/jpeg' } });
  } });
  await t.withFile(blob, 'photo.jpg', async (r) => {
    const file = await t.fetchFile(r);
    assert.equal(file.name, 'photo.jpg');
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
  });
  assert.deepEqual(calls.map((c) => c.op), ['xfer.create', 'xfer.release']);
  assert.equal(JSON.stringify(calls).includes('base64'), false);
  assert.deepEqual(calls[1].args, { url });
});

test('failed or short uploads release reservations, and failed operations release completed files', async () => {
  for (const mode of ['http', 'short', 'operation']) {
    const ops = [];
    const t = createTransfers({ call: async (op) => { ops.push(op); return op === 'xfer.create' ? ref(3) : {}; },
      fetch: async () => mode === 'http' ? new Response('', { status: 400 }) : Response.json({ size: mode === 'short' ? 2 : 3 }) });
    await assert.rejects(t.withFile(new Blob(['abc'], { type: 'image/jpeg' }), 'photo.jpg', () => { throw new Error('operation failed'); }));
    assert.deepEqual(ops, ['xfer.create', 'xfer.release']);
  }
});

test('download rejects short files and an upload timeout aborts and releases its reservation', async () => {
  const ops = [];
  const short = createTransfers({ call: async () => ({}), fetch: async () => new Response('a') });
  await assert.rejects(short.fetchFile(ref(3)), errorCode('transfer'));
  let signal;
  const stalled = createTransfers({ timeout: 5, call: async (op) => { ops.push(op); return op === 'xfer.create' ? ref(3) : {}; },
    fetch: async (_, options) => { signal = options.signal; return new Promise(() => {}); } });
  await assert.rejects(stalled.putFile(new Blob(['abc'], { type: 'image/jpeg' })), errorCode('timeout'));
  assert.equal(signal.aborted, true);
  assert.deepEqual(ops, ['xfer.create', 'xfer.release']);
});

test('subject replies cannot introduce mismatched dimensions or invalid polygons', () => {
  assert.deepEqual(subjectResult({ found: false }, 10, 10), { found: false });
  const good = { found: true, w: 10, h: 10, polygons: [[1, 1, 9, 1, 9, 9]] };
  assert.equal(subjectResult(good, 10, 10), good);
  for (const bad of [{ ...good, w: 9 }, { ...good, polygons: [] }, { ...good, polygons: [[0, 0, NaN, 1, 2, 2]] },
    { ...good, polygons: [[0, 0, 11, 1, 2, 2]] }, { ...good, polygons: [[0, 0, 1, 1]] }]) {
    assert.throws(() => subjectResult(bad, 10, 10), errorCode('protocol'));
  }
});

test('the platform module is inert without a bridge and its web picker uses the supplied input', async () => {
  const platform = await import('../ui/platform.js');
  assert.equal(platform.isNative, false);
  assert.equal(platform.native, null);
  assert.equal(platform.subjectLiftAvailable(), false);
  assert.equal(platform.subjectMatteAvailable(), false);
  let clicked = 0;
  assert.equal(await platform.pickPhoto({ input: { click: () => clicked++ } }), null);
  assert.equal(clicked, 1);
  platform.haptic('success');
  assert.deepEqual(await platform.subjectAt(null, 0, 0), { found: false });
  assert.deepEqual(await platform.subjectMatte(null), { found: false });
});

test('optional subject matte has the same bounded Vision timeout as outlines', () => {
  assert.equal(TIMEOUTS['subject.matte'], 25000);
  assert.equal(TIMEOUTS['subject.mask'], 25000);
});
