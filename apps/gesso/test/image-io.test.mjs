import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_WORKING_PIXELS, MAX_SIDE, fitWorkingSize, megapixels, sniffImageType, importProblem, exportFileName,
} from '../lib/image-io.js';

test('small images are left alone', () => {
  assert.deepEqual(fitWorkingSize(3024, 4032), { width: 3024, height: 4032, scale: 1, downscaled: false });
});

test('24 MP and 48 MP iPhone frames shrink to the working budget, keeping aspect', () => {
  for (const [w, h] of [[5712, 4284], [8064, 6048], [4284, 5712]]) {
    const r = fitWorkingSize(w, h);
    assert.ok(r.downscaled);
    assert.ok(r.width * r.height <= MAX_WORKING_PIXELS);
    assert.ok(Math.abs(r.width / r.height - w / h) < 0.002);
  }
});

test('panoramas respect the 8192 px per-side canvas cap', () => {
  const r = fitWorkingSize(30000, 2000, Infinity);
  assert.ok(r.width <= MAX_SIDE);
  assert.ok(r.height >= 1);
});

test('rejects images without pixels', () => {
  assert.throws(() => fitWorkingSize(0, 100), /no pixels/);
  assert.throws(() => fitWorkingSize(NaN, 100), /no pixels/);
});

test('megapixels rounds to one decimal', () => {
  assert.equal(megapixels(4032, 3024), 12.2);
  assert.equal(megapixels(8064, 6048), 48.8);
});

const bytes = (...parts) => Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));

test('sniffImageType identifies formats by magic bytes', () => {
  assert.equal(sniffImageType(bytes([0xff, 0xd8, 0xff, 0xe1])), 'jpeg');
  assert.equal(sniffImageType(bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a])), 'png');
  assert.equal(sniffImageType(bytes([0, 0, 0, 0x18], 'ftypheic', [0, 0])), 'heic');
  assert.equal(sniffImageType(bytes([0, 0, 0, 0x18], 'ftypmif1')), 'heic');
  assert.equal(sniffImageType(bytes([0, 0, 0, 0x18], 'ftypavif')), 'avif');
  assert.equal(sniffImageType(bytes('RIFF', [1, 2, 3, 4], 'WEBP')), 'webp');
  assert.equal(sniffImageType(bytes('GIF89a')), 'gif');
  assert.equal(sniffImageType(bytes([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0])), 'raw');
  assert.equal(sniffImageType(bytes([0x4d, 0x4d, 0x00, 0x2a])), 'raw');
  assert.equal(sniffImageType(bytes('hello world!')), 'unknown');
  assert.equal(sniffImageType(new Uint8Array(0)), 'unknown');
});

test('importProblem explains RAW and unknown files, and passes good ones', () => {
  assert.match(importProblem('raw'), /RAW/);
  assert.match(importProblem('unknown'), /JPEG, HEIC or PNG/);
  for (const ok of ['jpeg', 'png', 'heic', 'avif', 'webp', 'gif']) assert.equal(importProblem(ok), null);
});

test('exportFileName is sortable local time', () => {
  assert.equal(exportFileName(new Date(2026, 9, 20, 9, 41)), 'gesso-2026-10-20-0941.jpg');
  assert.equal(exportFileName(new Date(2026, 0, 5, 23, 7), 'png'), 'gesso-2026-01-05-2307.png');
});
