import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_WORKING_PIXELS, MAX_SIDE, MAX_AREA, WORK_MAX_PIXELS, WORK_FALLBACK_PIXELS,
  fitWorkingSize, canvasSizeOk, megapixels, sniffImageType, importProblem, exportFileName,
  readImageInfo, orientedDims, bandPlan, exportPeakBytes,
} from '../lib/image-io.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ limits

test('the limits are the §5.4 numbers', () => {
  assert.equal(MAX_SIDE, 8192);
  assert.equal(MAX_AREA, 67_108_864);
  assert.equal(WORK_MAX_PIXELS, 24_500_000);
  assert.equal(WORK_FALLBACK_PIXELS, 12_000_000);
  assert.equal(MAX_WORKING_PIXELS, WORK_MAX_PIXELS, 'deprecated alias');
});

test('small images are left alone', () => {
  assert.deepEqual(fitWorkingSize(3024, 4032), { width: 3024, height: 4032, scale: 1, downscaled: false });
});

test('native 24 MP iPhone frames pass through unscaled', () => {
  for (const [w, h] of [[5712, 4284], [4284, 5712]]) {
    assert.deepEqual(fitWorkingSize(w, h), { width: w, height: h, scale: 1, downscaled: false });
  }
});

test('48 MP frames shrink to the working budget, keeping aspect', () => {
  for (const [w, h] of [[8064, 6048], [6048, 8064]]) {
    const r = fitWorkingSize(w, h);
    assert.ok(r.downscaled);
    assert.ok(r.width * r.height <= WORK_MAX_PIXELS);
    assert.ok(r.width * r.height > WORK_MAX_PIXELS * 0.998, 'uses the budget');
    assert.ok(Math.abs(r.width / r.height - w / h) < 0.002);
    assert.equal(r.scale, r.width / w);
  }
});

test('the fallback budget is honoured', () => {
  const r = fitWorkingSize(5712, 4284, WORK_FALLBACK_PIXELS);
  assert.ok(r.downscaled && r.width * r.height <= WORK_FALLBACK_PIXELS);
  const o = fitWorkingSize(5712, 4284, { maxPixels: WORK_FALLBACK_PIXELS });
  assert.deepEqual(o, r, 'options object form');
});

test('panoramas respect the 8192 px per-side canvas cap', () => {
  const r = fitWorkingSize(30000, 2000, Infinity);
  assert.ok(r.width <= MAX_SIDE);
  assert.ok(r.height >= 1);
});

test('the canvas limits hold whatever budget is asked for', () => {
  const big = fitWorkingSize(12000, 12000, Infinity);
  assert.deepEqual([big.width, big.height], [8192, 8192]);
  assert.ok(big.width * big.height <= MAX_AREA);
  const side = fitWorkingSize(20000, 100, Infinity, 50000);
  assert.equal(side.width, MAX_SIDE, 'a maxSide above the canvas cap is capped');
  const opts = fitWorkingSize(20000, 100, { maxPixels: 1e12, maxSide: 1e6 });
  assert.equal(opts.width, MAX_SIDE);
  assert.equal(fitWorkingSize(4000, 3000, Infinity, 1000).width, 1000, 'a tighter maxSide wins');
});

test('unusable limits fall back to the defaults', () => {
  const def = fitWorkingSize(8064, 6048);
  for (const bad of [NaN, 0, -5, undefined, null, '24000000']) {
    assert.deepEqual(fitWorkingSize(8064, 6048, bad), def, String(bad));
  }
  assert.deepEqual(fitWorkingSize(8064, 6048, {}), def);
  assert.deepEqual(fitWorkingSize(30000, 2000, undefined, -1), fitWorkingSize(30000, 2000));
});

test('slivers and tiny budgets stay at least 1 px and within the budget', () => {
  assert.deepEqual(fitWorkingSize(100000, 1), { width: 8192, height: 1, scale: 8192 / 100000, downscaled: true });
  assert.deepEqual(fitWorkingSize(1, 1), { width: 1, height: 1, scale: 1, downscaled: false });
  const r = fitWorkingSize(1e9, 1, 2);
  assert.ok(r.width * r.height <= 2 && r.width >= 1 && r.height >= 1);
  const t = fitWorkingSize(1, 1e9, 2);
  assert.ok(t.width * t.height <= 2 && t.height >= 1);
  const huge = fitWorkingSize(1e200, 1e200);
  assert.deepEqual([huge.width, huge.height], [1, 1]);
});

test('fitWorkingSize never breaks a limit, never upscales (random sizes)', () => {
  const rnd = mulberry32(7);
  for (let i = 0; i < 3000; i++) {
    const w = 1 + Math.floor(rnd() ** 3 * 60000), h = 1 + Math.floor(rnd() ** 3 * 60000);
    const cap = [WORK_MAX_PIXELS, WORK_FALLBACK_PIXELS, Infinity, 1 + Math.floor(rnd() * 1e8)][i % 4];
    const r = fitWorkingSize(w, h, cap);
    assert.ok(Number.isInteger(r.width) && Number.isInteger(r.height) && r.width >= 1 && r.height >= 1);
    assert.ok(r.width <= w && r.height <= h, 'no upscaling');
    assert.ok(r.width <= MAX_SIDE && r.height <= MAX_SIDE);
    assert.ok(r.width * r.height <= Math.min(cap, MAX_AREA), `${w}x${h} cap ${cap}`);
    assert.ok(canvasSizeOk(r.width, r.height));
    assert.equal(r.downscaled, r.width < w || r.height < h);
    if (r.width > 50 && r.height > 50) assert.ok(Math.abs(r.width / r.height - w / h) / (w / h) < 0.03);
  }
});

test('rejects images without pixels', () => {
  assert.throws(() => fitWorkingSize(0, 100), /no pixels/);
  assert.throws(() => fitWorkingSize(NaN, 100), /no pixels/);
  assert.throws(() => fitWorkingSize(100, -3), /no pixels/);
  assert.throws(() => fitWorkingSize(Infinity, 100), /no pixels/);
  assert.throws(() => fitWorkingSize('100', 100), /no pixels/);
});

test('canvasSizeOk is the iOS canvas limit', () => {
  assert.equal(canvasSizeOk(8192, 8192), true);
  assert.equal(canvasSizeOk(8193, 10), false);
  assert.equal(canvasSizeOk(10, 8193), false);
  assert.equal(canvasSizeOk(1, 1), true);
  for (const [w, h] of [[0, 5], [5, 0], [1.5, 5], [NaN, 5], [Infinity, 1]]) assert.equal(canvasSizeOk(w, h), false);
});

test('megapixels rounds to one decimal', () => {
  assert.equal(megapixels(4032, 3024), 12.2);
  assert.equal(megapixels(8064, 6048), 48.8);
});

// ------------------------------------------------------------------ sniffing

const bytes = (...parts) => Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));

test('sniffImageType identifies formats by magic bytes', () => {
  assert.equal(sniffImageType(bytes([0xff, 0xd8, 0xff, 0xe1])), 'jpeg');
  assert.equal(sniffImageType(bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a])), 'png');
  assert.equal(sniffImageType(bytes([0, 0, 0, 0x18], 'ftypheic', [0, 0])), 'heic');
  assert.equal(sniffImageType(bytes([0, 0, 0, 0x18], 'ftypmif1')), 'heic');
  assert.equal(sniffImageType(bytes([0, 0, 0, 0x18], 'ftypavif')), 'avif');
  assert.equal(sniffImageType(bytes('RIFF', [1, 2, 3, 4], 'WEBP')), 'webp');
  assert.equal(sniffImageType(bytes('GIF89a')), 'gif');
  assert.equal(sniffImageType(bytes([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0])), 'tiff');
  assert.equal(sniffImageType(bytes([0x4d, 0x4d, 0x00, 0x2a])), 'tiff');
  assert.equal(sniffImageType(bytes('BM', [0x36, 0, 0, 0])), 'bmp');
  assert.equal(sniffImageType(bytes([0xff, 0x0a, 0xfa, 0x7f])), 'jxl');
  assert.equal(sniffImageType(bytes([0, 0, 0, 0x0c], 'JXL ', [0x0d, 0x0a, 0x87, 0x0a])), 'jxl');
  assert.equal(sniffImageType(bytes('hello world!')), 'unknown');
  assert.equal(sniffImageType(new Uint8Array(0)), 'unknown');
});

test('importProblem explains RAW and unknown files, and passes good ones', () => {
  assert.match(importProblem('raw'), /RAW/);
  assert.match(importProblem('unknown'), /JPEG, HEIC or PNG/);
  for (const ok of ['jpeg', 'png', 'heic', 'avif', 'webp', 'gif', 'tiff', 'bmp', 'jxl']) assert.equal(importProblem(ok), null);
});

// ------------------------------------------------------------------ fixtures
// Real headers built byte by byte. Parts are numbers, strings (as ASCII) or
// nested arrays of either.

const flat = (parts) => parts.flatMap((p) => (Array.isArray(p) || p instanceof Uint8Array
  ? flat([...p])
  : typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : [p]));
const u8 = (...parts) => Uint8Array.from(flat(parts));
const be16 = (v) => [(v >>> 8) & 255, v & 255];
const be24 = (v) => [(v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const be32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const le16 = (v) => [v & 255, (v >>> 8) & 255];
const le32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];

// JPEG
const seg = (marker, ...payload) => {
  const body = flat(payload);
  return [0xff, marker, be16(body.length + 2), body];
};
const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];
const APP0 = seg(0xe0, 'JFIF', 0, [1, 1, 0], be16(72), be16(72), [0, 0]);
const DQT = seg(0xdb, 0, new Array(64).fill(1));
const DHT = seg(0xc4, 0x00, new Array(16).fill(0), []);
const sof = (w, h, marker = 0xc0) => seg(marker, 8, be16(h), be16(w), 3, [1, 0x22, 0], [2, 0x11, 1], [3, 0x11, 1]);
const SOS = seg(0xda, 3, [1, 0], [2, 0x11], [3, 0x11], [0, 63, 0]);
const SCAN = [0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78];

// Exif APP1: TIFF header + IFD0 with the given entries [tag, type, count, valueBytes(4)].
function exif({ le = false, entries = [], ifdOffset = 8 } = {}) {
  const w16 = le ? le16 : be16, w32 = le ? le32 : be32;
  const ifd = [w16(entries.length), entries.map(([t, type, count, value]) => [w16(t), w16(type), w32(count), value]), w32(0)];
  return seg(0xe1, 'Exif', [0, 0], le ? 'II' : 'MM', w16(42), w32(ifdOffset), ifd);
}
const orient = (v, le = false) => [0x0112, 3, 1, le ? [le16(v), 0, 0] : [be16(v), 0, 0]];
const imageWidthTag = (le = false) => [0x0100, 4, 1, le ? le32(4032) : be32(4032)];

const jpeg = (...segments) => u8(SOI, ...segments, SOS, SCAN, EOI);

test('JPEG without Exif: frame size, upright', () => {
  const info = readImageInfo(jpeg(APP0, DQT, DHT, sof(4032, 3024)));
  assert.deepEqual(info, { type: 'jpeg', width: 4032, height: 3024, orientation: 1 });
});

test('JPEG Exif Orientation in both byte orders', () => {
  for (const le of [false, true]) {
    for (const o of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const info = readImageInfo(jpeg(exif({ le, entries: [imageWidthTag(le), orient(o, le)] }), DQT, sof(4032, 3024)));
      assert.deepEqual(info, { type: 'jpeg', width: 4032, height: 3024, orientation: o }, `${le ? 'II' : 'MM'} ${o}`);
    }
  }
});

test('JPEG Orientation stored as LONG, or out of range', () => {
  const asLong = [0x0112, 4, 1, be32(6)];
  assert.equal(readImageInfo(jpeg(exif({ entries: [asLong] }), sof(10, 20))).orientation, 6);
  assert.equal(readImageInfo(jpeg(exif({ entries: [orient(9)] }), sof(10, 20))).orientation, 1);
  assert.equal(readImageInfo(jpeg(exif({ entries: [orient(0)] }), sof(10, 20))).orientation, 1);
  const asAscii = [0x0112, 2, 2, ['6', 0, 0, 0]];
  assert.equal(readImageInfo(jpeg(exif({ entries: [asAscii] }), sof(10, 20))).orientation, 1);
});

test('JPEG with Exif but no Orientation tag is upright', () => {
  assert.equal(readImageInfo(jpeg(exif({ entries: [imageWidthTag()] }), sof(10, 20))).orientation, 1);
  assert.equal(readImageInfo(jpeg(exif({ entries: [] }), sof(10, 20))).orientation, 1);
});

test('JPEG: XMP APP1 is skipped and only the first Exif block counts', () => {
  const xmp = seg(0xe1, 'http://ns.adobe.com/xap/1.0/', 0, '<x:xmpmeta/>');
  assert.equal(readImageInfo(jpeg(xmp, exif({ entries: [orient(6)] }), sof(10, 20))).orientation, 6);
  const first = exif({ entries: [orient(1)] }), second = exif({ entries: [orient(6)] });
  assert.equal(readImageInfo(jpeg(first, second, sof(10, 20))).orientation, 1);
});

test('JPEG: an embedded Exif thumbnail does not fool the frame size', () => {
  // The thumbnail is a whole JPEG inside APP1, with its own SOF.
  const thumb = flat([SOI, sof(160, 120), SOS, SCAN, EOI]);
  const app1 = seg(0xe1, 'Exif', [0, 0], 'MM', be16(42), be32(8), be16(1), orient(6).map((x, i) => (i < 2 ? be16(x) : i === 2 ? be32(x) : x)), be32(0), thumb);
  const info = readImageInfo(jpeg(app1, sof(4032, 3024)));
  assert.deepEqual(info, { type: 'jpeg', width: 4032, height: 3024, orientation: 6 });
});

test('JPEG: progressive and other SOF markers; DHT, JPG and DAC are not frames', () => {
  for (const m of [0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]) {
    assert.equal(readImageInfo(jpeg(sof(640, 480, m))).width, 640, m.toString(16));
  }
  // A C8 / CC segment shaped like a frame header must be skipped, not read.
  for (const m of [0xc4, 0xc8, 0xcc]) {
    const fake = seg(m, 8, be16(1), be16(1), 3, [1, 0x22, 0], [2, 0x11, 1], [3, 0x11, 1]);
    assert.equal(readImageInfo(jpeg(fake, sof(640, 480))).width, 640, m.toString(16));
  }
});

test('JPEG: fill bytes before a marker are allowed', () => {
  const info = readImageInfo(u8(SOI, [0xff, 0xff, 0xff], APP0, [0xff], sof(300, 200), SOS, SCAN, EOI));
  assert.deepEqual([info.width, info.height], [300, 200]);
});

test('JPEG: no frame size before the scan, cut short, or broken gives null', () => {
  assert.equal(readImageInfo(u8(SOI, APP0, SOS, SCAN, sof(10, 10))), null, 'scan before the frame');
  assert.equal(readImageInfo(u8(SOI, APP0, EOI, sof(10, 10))), null, 'EOI before the frame');
  // A big APP2 (ICC, MPF) that runs past the bytes we read.
  const big = u8(SOI, APP0, [0xff, 0xe2, 0xff, 0xf0], new Array(100).fill(0));
  assert.equal(readImageInfo(big), null);
  const full = jpeg(APP0, sof(4032, 3024));
  const sofAt = full.length - flat([SOS, SCAN, EOI]).length - flat([sof(4032, 3024)]).length;
  assert.equal(readImageInfo(full.subarray(0, sofAt + 6)), null, 'cut inside the frame header');
  assert.equal(readImageInfo(full.subarray(0, sofAt + 9)).width, 4032, 'just enough');
  assert.equal(readImageInfo(u8(SOI, [0xff, 0xe0, 0, 1], APP0, sof(10, 10))), null, 'length < 2');
  assert.equal(readImageInfo(u8(SOI, [0x12, 0x34], sof(10, 10))), null, 'not a marker');
  assert.equal(readImageInfo(u8(SOI, [0xff, 0x00], sof(10, 10))), null, 'stuffed byte outside a scan');
  assert.equal(readImageInfo(jpeg(sof(640, 0))), null, 'height defined later by DNL');
  assert.equal(readImageInfo(u8(SOI, [0xff])), null);
});

test('JPEG: a frame header too short for its size fields gives null', () => {
  // Regression: SOF dims were read past the segment's own length, so a truncated
  // frame header took its "size" from the next segment's bytes (here the DHT's
  // 0xffc4 marker read as a width of 65476, next to a height of 10).
  const stub = seg(0xc0, 8, be16(10)); // precision and height, no width
  assert.equal(readImageInfo(jpeg(stub, DHT, sof(640, 480))), null);
  const empty = seg(0xc2); // length 2, no payload at all
  assert.equal(readImageInfo(jpeg(empty, sof(640, 480))), null);
  // Exactly enough payload for the dims is fine.
  assert.deepEqual(readImageInfo(jpeg(seg(0xc0, 8, be16(480), be16(640)))), { type: 'jpeg', width: 640, height: 480, orientation: 1 });
});

test('JPEG: a damaged Exif block costs the orientation, not the size', () => {
  const badIfd = exif({ entries: [orient(6)], ifdOffset: 5000 });
  assert.deepEqual(readImageInfo(jpeg(badIfd, sof(10, 20))), { type: 'jpeg', width: 10, height: 20, orientation: 1 });
  const badOrder = seg(0xe1, 'Exif', [0, 0], 'XX', be16(42), be32(8), be16(0), be32(0));
  assert.equal(readImageInfo(jpeg(badOrder, sof(10, 20))).orientation, 1);
  const badMagic = seg(0xe1, 'Exif', [0, 0], 'MM', be16(43), be32(8), be16(1), be16(0x0112), be16(3), be32(1), be16(6), [0, 0], be32(0));
  assert.equal(readImageInfo(jpeg(badMagic, sof(10, 20))).orientation, 1);
  // IFD claims many entries but the segment ends: stop at the segment.
  const lying = seg(0xe1, 'Exif', [0, 0], 'MM', be16(42), be32(8), be16(500), be16(0x0100), be16(3), be32(1), [0, 1, 0, 0]);
  assert.equal(readImageInfo(jpeg(lying, sof(10, 20))).width, 10);
});

test('JPEG: a near-64 KB Exif thumbnail is stepped over', () => {
  const thumb = new Array(60000).fill(0);
  const app1 = exif({ entries: [orient(8)] });
  const withThumb = [...app1.slice(0, 2), be16(flat(app1).length - 2 + thumb.length), ...app1.slice(3), thumb];
  const file = u8(SOI, withThumb, sof(4032, 3024), SOS, SCAN, EOI);
  assert.equal(readImageInfo(file.subarray(0, 32 * 1024)), null, 'no frame size in the first 32 KB');
  assert.deepEqual(readImageInfo(file.subarray(0, 64 * 1024)), { type: 'jpeg', width: 4032, height: 3024, orientation: 8 });
});

// PNG
const pngSig = [0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a];
const chunk = (type, ...data) => { const d = flat(data); return [be32(d.length), type, d, be32(0)]; };
const ihdr = (w, h) => chunk('IHDR', be32(w), be32(h), 8, 6, 0, 0, 0);

test('PNG: IHDR size, always upright', () => {
  assert.deepEqual(readImageInfo(u8(pngSig, ihdr(1170, 2532), chunk('IEND'))), { type: 'png', width: 1170, height: 2532, orientation: 1 });
  assert.deepEqual(readImageInfo(u8(pngSig, ihdr(0x7fffffff, 1))), { type: 'png', width: 0x7fffffff, height: 1, orientation: 1 });
});

test("PNG: Apple's CgBI chunk before IHDR is tolerated", () => {
  assert.equal(readImageInfo(u8(pngSig, chunk('CgBI', [0x50, 0, 0x20, 2]), ihdr(60, 40))).width, 60);
});

test('PNG: bad or missing IHDR gives null', () => {
  assert.equal(readImageInfo(u8(pngSig, ihdr(0, 10))), null);
  assert.equal(readImageInfo(u8(pngSig, ihdr(10, 0))), null);
  assert.equal(readImageInfo(u8(pngSig, ihdr(0x80000000, 10))), null);
  assert.equal(readImageInfo(u8(pngSig, chunk('gAMA', be32(45455)), ihdr(10, 10))), null);
  assert.equal(readImageInfo(u8(pngSig, ihdr(10, 10)).subarray(0, 23)), null);
});

// ISO-BMFF (HEIC / AVIF)
const bx = (type, ...payload) => { const b = flat(payload); return [be32(b.length + 8), type, b]; };
const full = (type, version, flags, ...payload) => bx(type, version, be24(flags), ...payload);
const ftyp = (brand) => bx('ftyp', brand, be32(0), 'mif1', brand);
const hdlr = full('hdlr', 0, 0, be32(0), 'pict', be32(0), be32(0), be32(0), 0);
const ispe = (w, h) => full('ispe', 0, 0, be32(w), be32(h));
const irot = (q) => bx('irot', q);
const imir = (axis) => bx('imir', axis);
// ipma version 0, 8-bit indices: [itemId, [index, ...]] (0x80 = essential).
const ipma0 = (...entries) => full('ipma', 0, 0, be32(entries.length), entries.map(([id, idx]) => [be16(id), idx.length, idx]));

// iPhone-like: a grid primary (item 1) whose 512 px tiles (item 2) and thumbnail
// (item 3) carry their own, smaller ispe.
function heic({ rot = null, mirror = null, order = ['irot', 'imir'], primary = 1 } = {}) {
  const props = [bx('hvcC', 1, 2, 3), ispe(512, 512), ispe(4032, 3024), ispe(320, 240)];
  const assoc = [3];
  const transforms = { irot: rot === null ? null : irot(rot), imir: mirror === null ? null : imir(mirror) };
  for (const t of order) {
    if (transforms[t]) { props.push(transforms[t]); assoc.push(0x80 | props.length); }
  }
  const ipco = bx('ipco', props);
  const ipma = ipma0([2, [0x81, 2]], [primary === 1 ? 1 : 9, assoc], [3, [0x81, 4]]);
  const meta = full('meta', 0, 0, hdlr, full('pitm', 0, 0, be16(1)), bx('iinf', be16(0)), bx('iprp', ipco, ipma));
  return u8(ftyp('heic'), meta, bx('mdat', new Array(32).fill(7)));
}

test('HEIC: the primary item size, not a tile or the thumbnail', () => {
  assert.deepEqual(readImageInfo(heic()), { type: 'heic', width: 4032, height: 3024, orientation: 1 });
});

test('HEIC: irot turns map to EXIF orientations', () => {
  assert.equal(readImageInfo(heic({ rot: 0 })).orientation, 1);
  assert.equal(readImageInfo(heic({ rot: 1 })).orientation, 8, 'a quarter anticlockwise');
  assert.equal(readImageInfo(heic({ rot: 2 })).orientation, 3);
  assert.equal(readImageInfo(heic({ rot: 3 })).orientation, 6, 'three quarters anticlockwise = one clockwise');
  assert.equal(readImageInfo(heic({ rot: 0xfd })).orientation, 8, 'reserved bits ignored');
  assert.deepEqual(orientedDims(readImageInfo(heic({ rot: 3 }))), { w: 3024, h: 4032 });
});

test('HEIC: imir and its order relative to irot', () => {
  assert.equal(readImageInfo(heic({ mirror: 0 })).orientation, 2);
  assert.equal(readImageInfo(heic({ mirror: 1 })).orientation, 4);
  assert.equal(readImageInfo(heic({ rot: 2, mirror: 0 })).orientation, 4);
  assert.equal(readImageInfo(heic({ rot: 1, mirror: 0 })).orientation, 7, 'turn, then mirror');
  assert.equal(readImageInfo(heic({ rot: 1, mirror: 0, order: ['imir', 'irot'] })).orientation, 5, 'mirror, then turn');
  assert.equal(readImageInfo(heic({ rot: 3, mirror: 0 })).orientation, 5);
});

test('HEIC: without usable associations the largest ispe wins, upright', () => {
  const noIpma = u8(ftyp('heic'), full('meta', 0, 0, hdlr, full('pitm', 0, 0, be16(1)),
    bx('iprp', bx('ipco', ispe(512, 512), ispe(4032, 3024), irot(1), ispe(320, 240)))), bx('mdat'));
  assert.deepEqual(readImageInfo(noIpma), { type: 'heic', width: 4032, height: 3024, orientation: 1 });
  assert.deepEqual(readImageInfo(heic({ rot: 1, primary: 9 })), { type: 'heic', width: 4032, height: 3024, orientation: 1 }, 'primary has no entry');
});

test('AVIF: 32-bit item ids, 16-bit property indices, odd top-level boxes', () => {
  const ipco = bx('ipco', bx('av1C', 0x81, 0, 0, 0), ispe(1920, 1080), irot(3));
  const ipma = full('ipma', 1, 1, be32(1), be32(70000), 2, be16(0x8001 + 1), be16(0x8000 | 3));
  const meta = full('meta', 0, 0, hdlr, full('pitm', 1, 0, be32(70000)), bx('iprp', ipco, ipma));
  const uuid = [be32(8 + 16 + 4), 'uuid', new Array(16).fill(0xab), [1, 2, 3, 4]];
  const large = [be32(1), 'free', be32(0), be32(16 + 3), [9, 9, 9]];
  const file = u8(ftyp('avif'), uuid, large, bx('free', 0, 0), meta, [be32(0), 'mdat', 1, 2, 3]);
  assert.deepEqual(readImageInfo(file), { type: 'avif', width: 1920, height: 1080, orientation: 6 });
});

test('HEIF: missing, cut short or malformed boxes give null', () => {
  assert.equal(readImageInfo(u8(ftyp('heic'), bx('mdat', 1, 2, 3))), null, 'no meta');
  const whole = heic();
  const ipcoAt = flat([whole]).findIndex((_, i) => String.fromCharCode(...whole.subarray(i, i + 4)) === 'ipco');
  assert.equal(readImageInfo(whole.subarray(0, ipcoAt - 2)), null, 'cut before the properties');
  assert.equal(readImageInfo(u8(ftyp('heic'), [be32(4), 'meta'])), null, 'box smaller than its header');
  assert.equal(readImageInfo(u8(ftyp('heic'), [be32(1), 'meta', be32(0), be32(4)])), null, 'largesize too small');
  assert.equal(readImageInfo(u8(ftyp('heic'), full('meta', 0, 0, bx('iprp', bx('ipco', ispe(0, 10)))))), null, 'zero size');
  // An ispe cut off mid-number is not read past the data.
  const cut = u8(ftyp('heic'), full('meta', 0, 0, bx('iprp', bx('ipco', ispe(4032, 3024)))));
  assert.equal(readImageInfo(cut.subarray(0, cut.length - 3)), null);
  // ipma that claims more entries and associations than it holds.
  const liar = u8(ftyp('heic'), full('meta', 0, 0, full('pitm', 0, 0, be16(1)),
    bx('iprp', bx('ipco', ispe(800, 600)), full('ipma', 0, 0, be32(99999), be16(1), 200, 1))));
  assert.deepEqual(readImageInfo(liar), { type: 'heic', width: 800, height: 600, orientation: 1 });
});

test('HEIF: a property box is read only within itself', () => {
  // Regression: irot/imir/ispe payloads were bounds-checked against the whole
  // buffer, not their own box, so an empty or short property borrowed the next
  // box's header bytes as its value.
  // An empty irot followed by a box whose size field starts with 0x03: the old
  // read took 3 as the rotation (orientation 6, w and h swapped).
  const bigNext = [be32(0x03000010), 'free', be32(0), be32(0)];
  const props = bx('ipco', ispe(4032, 3024), bx('irot'), bigNext);
  const ipma = ipma0([1, [0x81, 0x82]]);
  const file = u8(ftyp('heic'), full('meta', 0, 0, hdlr, full('pitm', 0, 0, be16(1)), bx('iprp', props, ipma)));
  assert.deepEqual(readImageInfo(file), { type: 'heic', width: 4032, height: 3024, orientation: 1 });
  // An ispe holding only a width must not take its height from the next box.
  const shortIspe = full('ispe', 0, 0, be32(4032));
  const props2 = bx('ipco', shortIspe, ispe(512, 512));
  const file2 = u8(ftyp('heic'), full('meta', 0, 0, hdlr, full('pitm', 0, 0, be16(1)), bx('iprp', props2, ipma0([1, [0x81]]))));
  assert.deepEqual(readImageInfo(file2), { type: 'heic', width: 512, height: 512, orientation: 1 }, 'falls back to a whole ispe');
});

test('readImageInfo: other formats and junk give null; any byte container works', () => {
  assert.equal(readImageInfo(bytes('GIF89a', [10, 0, 10, 0])), null);
  assert.equal(readImageInfo(bytes('RIFF', [1, 2, 3, 4], 'WEBPVP8 ')), null);
  assert.equal(readImageInfo(bytes([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0])), null);
  assert.equal(readImageInfo(new Uint8Array(0)), null);
  assert.equal(readImageInfo(null), null);
  assert.equal(readImageInfo(undefined), null);
  assert.equal(readImageInfo({}), null);
  const file = jpeg(exif({ entries: [orient(6)] }), sof(4032, 3024));
  assert.deepEqual(readImageInfo(file.buffer), readImageInfo(file), 'ArrayBuffer');
  assert.deepEqual(readImageInfo(Array.from(file)), readImageInfo(file), 'plain array');
  const padded = new Uint8Array(file.length + 7);
  padded.set(file, 7);
  assert.deepEqual(readImageInfo(padded.subarray(7)), readImageInfo(file), 'a view with a byte offset');
});

test('readImageInfo survives random corruption without throwing', () => {
  const rnd = mulberry32(42);
  const seeds = [jpeg(exif({ le: true, entries: [orient(6)] }), DQT, sof(4032, 3024)), u8(pngSig, ihdr(10, 10)), heic({ rot: 1, mirror: 0 })];
  for (let i = 0; i < 3000; i++) {
    const src = seeds[i % seeds.length];
    const b = Uint8Array.from(src.subarray(0, Math.floor(rnd() * (src.length + 1))));
    for (let k = Math.floor(rnd() * 6); k > 0; k--) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
    const info = readImageInfo(b);
    if (info) {
      assert.ok(info.width > 0 && info.height > 0 && Number.isInteger(info.orientation));
      assert.ok(info.orientation >= 1 && info.orientation <= 8);
    }
  }
});

test('orientedDims swaps width and height for orientations 5-8', () => {
  for (let o = 1; o <= 8; o++) {
    const d = orientedDims({ type: 'jpeg', width: 4032, height: 3024, orientation: o });
    assert.deepEqual(d, o >= 5 ? { w: 3024, h: 4032 } : { w: 4032, h: 3024 }, String(o));
  }
  for (const o of [0, 9, NaN, undefined, '6']) {
    assert.deepEqual(orientedDims({ width: 4, height: 3, orientation: o }), { w: 4, h: 3 }, String(o));
  }
});

// ------------------------------------------------------------------ export

const covers = (plan, outH) => {
  let y = 0;
  for (const band of plan) {
    assert.equal(band.y, y, 'contiguous, in order');
    assert.ok(Number.isInteger(band.h) && band.h >= 1);
    y += band.h;
  }
  assert.equal(y, outH, 'every row exactly once');
};

test('bandPlan covers every row once within the band budget', () => {
  for (const [w, h] of [[1, 1], [5712, 4284], [5715, 4286], [8192, 8192], [4096, 3072], [8192, 1], [1, 20000], [3, 7]]) {
    const plan = bandPlan(w, h);
    covers(plan, h);
    for (const band of plan) {
      assert.ok(w * band.h * 4 <= 32 * 2 ** 20 || band.h === 1);
      assert.ok(band.h <= MAX_SIDE, 'a band fits in a framebuffer');
    }
  }
});

test('bandPlan evens the bands out instead of leaving a sliver', () => {
  assert.deepEqual(bandPlan(5712, 4284), [{ y: 0, h: 1428 }, { y: 1428, h: 1428 }, { y: 2856, h: 1428 }]);
  const plan = bandPlan(1000, 8193, Infinity);
  assert.deepEqual(plan, [{ y: 0, h: 4097 }, { y: 4097, h: 4096 }]);
  const odd = bandPlan(4000, 10001);
  const hs = odd.map((b) => b.h);
  assert.ok(Math.max(...hs) - Math.min(...hs) < odd.length);
});

test('bandPlan with a budget smaller than a row goes one row at a time', () => {
  const plan = bandPlan(100, 5, 10);
  assert.deepEqual(plan.map((b) => b.h), [1, 1, 1, 1, 1]);
  covers(plan, 5);
  assert.deepEqual(bandPlan(100, 50, 400 * 50), [{ y: 0, h: 50 }]);
  assert.deepEqual(bandPlan(100, 50, NaN), bandPlan(100, 50), 'bad budget: the default');
});

test('bandPlan rejects sizes that are not whole pixels', () => {
  for (const [w, h] of [[0, 10], [10, 0], [1.5, 10], [10, NaN], [-1, 5], [Infinity, 5]]) {
    assert.throws(() => bandPlan(w, h), RangeError, `${w}x${h}`);
  }
});

test('bandPlan covers every row for random sizes and budgets', () => {
  const rnd = mulberry32(3);
  for (let i = 0; i < 500; i++) {
    const w = 1 + Math.floor(rnd() * 8192), h = 1 + Math.floor(rnd() * 12000);
    const budget = Math.floor(rnd() * 64 * 2 ** 20);
    covers(bandPlan(w, h, budget), h);
  }
});

test('exportPeakBytes counts band, readback, worker canvas and JPEG', () => {
  assert.equal(exportPeakBytes(100, 100), 100 * 100 * 4 + 2 * 100 * 100 * 4 + 100 * 100);
  // One band of 1428 rows at 5712 wide, plus full frames.
  assert.equal(exportPeakBytes(5712, 4284), 5712 * 1428 * 4 + 2 * 5712 * 4284 * 4 + 5712 * 4284);
  const withTextures = exportPeakBytes(5712, 4284, 5712, 4284);
  assert.equal(withTextures - exportPeakBytes(5712, 4284), 2 * Math.ceil((5712 * 4284 * 16) / 3));
  // §5.4: about 560 MB at the 24.5 MP cap, inside the 900 MB ledger.
  const peak = exportPeakBytes(5715, 4286, 5715, 4286);
  assert.ok(peak > 450 * 2 ** 20 && peak < 600 * 2 ** 20, `${Math.round(peak / 2 ** 20)} MB`);
  assert.ok(exportPeakBytes(2000, 1500) < exportPeakBytes(4000, 3000));
  assert.equal(exportPeakBytes(100, 100, NaN, 5), exportPeakBytes(100, 100));
  assert.throws(() => exportPeakBytes(0, 10), RangeError);
});

test('exportFileName is the §5.7 sortable local time, to the second', () => {
  assert.equal(exportFileName(new Date(2026, 9, 20, 14, 30, 5)), 'gesso-20261020-143005.jpg');
  assert.equal(exportFileName(new Date(2026, 0, 5, 23, 7)), 'gesso-20260105-230700.jpg');
  assert.equal(exportFileName(new Date(2026, 0, 5, 23, 7, 59), 'png'), 'gesso-20260105-230759.png');
  // Regression: two saves in the same minute used to get the same name.
  assert.notEqual(exportFileName(new Date(2026, 9, 20, 9, 41, 1)), exportFileName(new Date(2026, 9, 20, 9, 41, 2)));
  // Sorting the names sorts the times.
  const times = [new Date(2026, 11, 31, 23, 59, 59), new Date(2026, 0, 1, 0, 0, 0), new Date(2026, 9, 20, 9, 5, 7)];
  const names = times.map((d) => exportFileName(d));
  assert.deepEqual([...names].sort(), [...times].sort((a, b) => a - b).map((d) => exportFileName(d)));
});

test('exportFileName still names a file when the clock is broken', () => {
  // Regression: an invalid date gave 'gesso-NaN-NaN-NaN-NaNNaN.jpg'.
  assert.equal(exportFileName(new Date(NaN)), 'gesso.jpg');
  assert.equal(exportFileName(undefined), 'gesso.jpg');
  assert.equal(exportFileName(null, 'png'), 'gesso.png');
  assert.equal(exportFileName(1760000000000), 'gesso.jpg');
});
