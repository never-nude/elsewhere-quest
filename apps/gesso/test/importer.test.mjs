import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeForEditing, ImportError } from '../ui/importer.js';

function png(width = 4000, height = 3000) {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width); view.setUint32(20, height);
  return new File([bytes], 'photo.png', { type: 'image/png' });
}

const raw = () => new File([new Uint8Array([73, 73, 42, 0, 1, 2])], 'photo.dng');
const web = { isNative: false };
function bitmapMock(t, decode) {
  const before = globalThis.createImageBitmap;
  globalThis.createImageBitmap = decode;
  t.after(() => {
    if (before === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = before;
  });
}
const bitmap = (width, height) => ({ width, height, close() {} });

test('plain web import retains its exact resize and unsupported-file behavior', async (t) => {
  const file = png();
  let called = 0;
  bitmapMock(t, async (source, options) => {
    called++;
    assert.equal(source, file);
    assert.deepEqual(options, { resizeWidth: 2000, resizeHeight: 1500, resizeQuality: 'high' });
    return bitmap(2000, 1500);
  });
  const result = await decodeForEditing(file, { maxPixels: 3_000_000, nativeAdapter: web });
  assert.deepEqual([result.natW, result.natH, result.downscaled], [4000, 3000, true]);
  assert.equal(result.sourceFile, undefined, 'ordinary web originals remain unchanged');
  await assert.rejects(decodeForEditing(new File(['text'], 'not-photo'), { nativeAdapter: web }), (err) => err instanceof ImportError && err.unsupported);
  assert.equal(called, 1);
});

test('native decode rescues RAW and returns normalized pixels as the draft source', async (t) => {
  const file = raw(), normalized = png(2000, 1500);
  const adapter = {
    isNative: true, nativeInfo: () => null,
    async decodeNative(source, options) {
      assert.equal(source, file);
      assert.equal(options.maxPixels, 3_000_000);
      return { file: normalized, natW: 8000, natH: 6000, downscaled: true };
    },
  };
  bitmapMock(t, async (source, options) => {
    if (source === file) throw new Error('WebKit cannot decode RAW');
    assert.equal(source, normalized);
    return bitmap(options.resizeWidth, options.resizeHeight);
  });
  const result = await decodeForEditing(file, { maxPixels: 3_000_000, nativeAdapter: adapter });
  assert.equal(result.sourceFile, normalized);
  assert.deepEqual([result.type, result.natW, result.natH, result.downscaled], ['png', 8000, 6000, true]);
  const restored = await decodeForEditing(normalized, { maxPixels: 3_000_000, nativeAdapter: web });
  assert.deepEqual([restored.bitmap.width, restored.bitmap.height], [2000, 1500], 'the saved PNG restores through plain WebKit');
});

test('native unsupported imports can be normalized before any web decode', async (t) => {
  const file = new File(['camera-format'], 'photo.camera'), normalized = png(12, 8);
  let decodes = 0;
  bitmapMock(t, async (source) => { decodes++; assert.equal(source, normalized); return bitmap(12, 8); });
  const result = await decodeForEditing(file, { nativeAdapter: {
    isNative: true, nativeInfo: () => null,
    decodeNative: async () => ({ file: normalized, natW: 12, natH: 8, downscaled: false }),
  } });
  assert.equal(result.sourceFile, normalized);
  assert.equal(decodes, 1);
});

test('native-rendered PNG allocation failure remains eligible for the smaller retry', async (t) => {
  const file = png(4000, 3000);
  let rescues = 0;
  const adapter = {
    isNative: true, nativeInfo: () => ({ natW: 8000, natH: 6000, rendered: true, downscaled: true }),
    decodeNative: async () => { rescues++; throw Object.assign(new Error('no original transfer'), { code: 'unsupported' }); },
  };
  bitmapMock(t, async (source, options) => {
    if (options.resizeWidth === 4000) throw new Error('allocation failed');
    return bitmap(options.resizeWidth, options.resizeHeight);
  });
  await assert.rejects(decodeForEditing(file, { nativeAdapter: adapter }), (err) => err instanceof ImportError && !err.unsupported && !err.message.includes('Safari'));
  const smaller = await decodeForEditing(file, { maxPixels: 3_000_000, nativeAdapter: adapter });
  assert.deepEqual([smaller.bitmap.width, smaller.bitmap.height, smaller.natW, smaller.natH], [2000, 1500, 8000, 6000]);
  assert.equal(rescues, 0, 'normalized files never need their old transfer');
});

test('native rescue failure does not turn an ordinary allocation failure into unsupported', async (t) => {
  bitmapMock(t, async () => { throw new Error('allocation failed'); });
  const adapter = {
    isNative: true, nativeInfo: () => null,
    decodeNative: async () => { throw Object.assign(new Error('native JPEG unavailable'), { code: 'unsupported' }); },
  };
  await assert.rejects(decodeForEditing(png(), { nativeAdapter: adapter }), (err) => err instanceof ImportError && !err.unsupported);
  adapter.decodeNative = async () => { throw Object.assign(new Error('allocation failed'), { code: 'memory' }); };
  await assert.rejects(decodeForEditing(new File(['raw'], 'photo.raw'), { nativeAdapter: adapter }), (err) => !err.unsupported);
});

test('a headerless full-size bitmap is closed even when its resize fails', async (t) => {
  let closed = false;
  const full = { width: 8000, height: 6000, close() { closed = true; } };
  bitmapMock(t, async (source) => {
    if (source === full) throw new Error('allocation failed');
    return full;
  });
  const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'photo.jpg');
  await assert.rejects(decodeForEditing(file, { maxPixels: 3_000_000, nativeAdapter: web }), ImportError);
  assert.equal(closed, true);
});
