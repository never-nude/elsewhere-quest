// All native access stays here; the same editor still runs in Safari.
import { fitWorkingSize, WORK_FALLBACK_PIXELS } from '../lib/image-io.js';
import {
  createNativeBridge, createTransfers, NativeError, imageInfo, subjectResult,
} from '../lib/native-bridge.js';

const bridge = createNativeBridge({
  flag: globalThis.__gessoNative,
  handler: globalThis.webkit?.messageHandlers?.gesso,
});
export const { isNative, native, call } = bridge;
const transfers = createTransfers({ call });
const metadata = new WeakMap();
export const nativeInfo = (file) => metadata.get(file) ?? null;
export const putFile = transfers.putFile;
export const fetchFile = transfers.fetchFile;
export const release = transfers.release;
export const subjectLiftAvailable = () => isNative && Array.isArray(native.capabilities) && native.capabilities.includes('subject');

export function pickPhoto({ maxPixels, input = globalThis.document?.querySelector('#file') } = {}) {
  if (!isNative) { input?.click(); return Promise.resolve(null); }
  return call('photo.pick').then(async (value) => {
    if (value === null) return null;
    const ref = await transfers.acceptRef(value);
    try {
      const info = imageInfo(await call('image.info', { url: ref.url }));
      if (info.raw) {
        try { return (await decodeRef(ref, info, maxPixels)).file; }
        catch (err) {
          const fit = fitWorkingSize(info.natW, info.natH, maxPixels);
          if (!['memory', 'size'].includes(err?.code) || fit.width * fit.height <= WORK_FALLBACK_PIXELS) throw err;
          return (await decodeRef(ref, info, WORK_FALLBACK_PIXELS)).file;
        }
      }
      const file = await transfers.fetchFile(ref);
      metadata.set(file, { ...info, rendered: false, downscaled: false });
      return file;
    } finally { await transfers.release(ref.url); }
  });
}

async function decodeRef(ref, info, maxPixels) {
  const fit = fitWorkingSize(info.natW, info.natH, maxPixels);
  const rendered = await transfers.acceptRef(await call('image.decode', { url: ref.url, w: fit.width, h: fit.height }));
  try {
    if (rendered.w !== fit.width || rendered.h !== fit.height || rendered.type !== 'image/png') {
      throw new NativeError('protocol', 'Native decode returned the wrong image size.');
    }
    const file = await transfers.fetchFile(rendered);
    const meta = { natW: info.natW, natH: info.natH, rendered: true, downscaled: fit.downscaled };
    metadata.set(file, meta);
    return { file, ...meta };
  } finally { await transfers.release(rendered.url); }
}

export async function decodeNative(file, { maxPixels } = {}) {
  if (!isNative) throw new NativeError('web', 'Native decoding unavailable.');
  if (nativeInfo(file)?.rendered) return { file, ...nativeInfo(file) };
  return transfers.withFile(file, file.name || 'photo', async (ref) => {
    const info = imageInfo(await call('image.info', { url: ref.url }));
    return decodeRef(ref, info, maxPixels);
  });
}

// This function calls Web Share before returning; activation belongs to the tap.
function webShare(blob, name) {
  const data = { files: [new File([blob], name, { type: blob.type })] };
  try {
    if (typeof globalThis.navigator?.share !== 'function' ||
        (navigator.canShare && !navigator.canShare(data))) return Promise.resolve({ fallback: true });
    return Promise.resolve(navigator.share(data)).then(() => ({ completed: true, activity: null }));
  } catch (err) { return Promise.reject(err); }
}

export function saveToPhotos(blob, name = 'gesso.jpg') {
  if (!isNative) return webShare(blob, name);
  return transfers.withFile(blob, name, (ref) => call('photos.save', { url: ref.url, name })).then((r) => {
    if (r?.saved === true || (r?.saved === false && ['denied', 'restricted', 'failed'].includes(r.reason))) return r;
    throw new NativeError('protocol', 'Invalid Photos reply.');
  });
}

export function share(blob, name = 'gesso.jpg') {
  if (!isNative) return webShare(blob, name);
  return transfers.withFile(blob, name, (ref) => call('share', { url: ref.url, name })).then((r) => {
    if (typeof r?.completed !== 'boolean' || !(r.activity === null || typeof r.activity === 'string')) {
      throw new NativeError('protocol', 'Invalid share reply.');
    }
    return r;
  });
}

export async function subjectAt(image, x, y, { radius = 12 } = {}) {
  if (!subjectLiftAvailable()) return { found: false };
  const { width, height, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > 1024 || height > 1024 || data?.length !== width * height * 4 ||
      !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x >= width || y < 0 || y >= height ||
      !Number.isFinite(radius) || radius < 0 || radius > 128) throw new NativeError('badArgs', 'Invalid subject image.');
  const canvas = document.createElement('canvas');
  let blob;
  try {
    canvas.width = width; canvas.height = height;
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
    blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new NativeError('memory', "Couldn't prepare the subject image.");
  } finally { canvas.width = canvas.height = 0; }
  return transfers.withFile(blob, 'subject.png', async (ref) =>
    subjectResult(await call('subject.mask', { url: ref.url, x, y, radius }), width, height));
}

let tickAt = -Infinity;
export function haptic(kind = 'light') {
  if (!isNative) return;
  if (kind === 'tick') {
    const now = performance.now();
    if (now - tickAt < 50) return;
    tickAt = now;
  }
  call('haptic', { kind }).catch(() => {});
}

export const openSettings = () => isNative ? call('settings.open') : Promise.resolve({});
export function clipboardWrite(text) {
  if (isNative) return call('clipboard.write', { text });
  return globalThis.navigator?.clipboard?.writeText(text) ?? Promise.resolve(false);
}
