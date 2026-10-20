// Save's pixels (§5.7): the edit rendered at the full output size, band by band on
// the GPU (each band at most 32 MB), captions laid on top, then JPEG-encoded off
// the main thread.
//
//   exportJpeg(ed, { captions, onProgress, signal, quality }) -> Promise<Blob>
//       image/jpeg, exactly ed.outputSize(). Rejects with an ExportError, or the
//       signal's AbortError when aborted.
//   renderOutput(ed, { doc, captions, onProgress, signal }) -> Promise<{ width, height, data }>
//       the opaque RGBA of the whole output, top row first.
//
// onProgress(f), f in 0..1: the bands fill up to RENDER_SHARE; the encoder is
// silent until it finishes (1).
//
// The encode runs in workers/export-worker.js (OffscreenCanvas.convertToBlob) with
// the pixel buffer transferred, not copied. Without OffscreenCanvas, or if the
// worker fails, canvas.toBlob runs here after a frame has been yielded so the
// sheet's "Preparing…" is on screen first.

import { bandPlan } from '../lib/image-io.js';
import { outputSize } from '../lib/geometry.js';
import { outputQuad } from '../lib/view.js';
import { developInput } from '../lib/doc.js';
import { resolve, uniforms as developUniforms } from '../lib/develop.js';
import { captionBounds } from '../lib/text-layout.js';
import { JPEG_QUALITY, JPEG_TYPE, bandMatrix, bandRendered, renderProgress, coverRect, clipToBand, compositeOver } from '../lib/export-plan.js';

const WORKER_URL = new URL('../workers/export-worker.js', import.meta.url);
// A 24 MP encode takes about a second on a phone; far past that the worker is
// stuck, and a stuck "Preparing…" is worse than the main-thread fallback.
const WORKER_TIMEOUT_MS = 30000;

export class ExportError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ExportError';
    this.code = code; // 'gpu' | 'stale' | 'encode' | 'not-jpeg'
  }
}

export async function exportJpeg(ed, { captions = null, onProgress, signal, quality = JPEG_QUALITY } = {}) {
  const doc = ed.doc;
  const revision = ed.revision;
  const render = async () => {
    const out = await renderOutput(ed, { doc, captions, onProgress, signal });
    // The GPU holds one state (fills, painted light): a change mid-export would mix two.
    if (ed.revision !== revision || ed.doc !== doc) throw new ExportError('the photo changed while it was being saved', 'stale');
    return out;
  };
  let img = await render();
  throwIfAborted(signal);
  let blob = null;
  if (workerEncodes()) {
    try {
      blob = await encodeInWorker(img, quality, signal);
    } catch (err) {
      if (isAbort(err)) throw err;
      console.warn('export worker failed; encoding on the main thread', err);
      // The worker hands the pixels back when it can; if it died holding them,
      // render again rather than keep a second 100 MB copy around just in case.
      img = err.buffer ? { ...img, data: new Uint8ClampedArray(err.buffer) } : await render();
    }
  }
  if (!blob) blob = await encodeOnMainThread(img, quality, signal);
  assertJpeg(blob);
  onProgress?.(1);
  return blob;
}

export async function renderOutput(ed, { doc = ed.doc, captions = null, onProgress, signal } = {}) {
  const { renderer } = ed;
  const { width: outW, height: outH } = outputSize(doc.crop);
  const srcW = doc.source.w, srcH = doc.source.h;
  const { adjust, look } = developInput(doc);
  const uniforms = developUniforms(resolve(adjust, look));
  const words = captions ? captionCover(captions, doc, outW, outH) : null;
  const plan = bandPlan(outW, outH);
  // Let the sheet paint before the first band holds the main thread.
  await nextFrame();
  throwIfAborted(signal);
  const data = new Uint8ClampedArray(outW * outH * 4);
  for (let i = 0; i < plan.length; i++) {
    throwIfAborted(signal);
    const band = plan[i];
    const quad = outputQuad(doc.crop, srcW, srcH, outW, outH, bandMatrix(band));
    renderBand(renderer, { width: outW, height: band.h, quad, uniforms, grainScale: [outW, outH], into: data, offset: band.y * outW * 4 });
    const part = words === 'all' ? clipToBand({ x: 0, y: 0, width: outW, height: outH }, band) : clipToBand(words, band);
    if (part) overlayCaptions(captions, doc, data, outW, outH, part);
    onProgress?.(renderProgress(i + 1, plan.length));
    if (i < plan.length - 1) await nextFrame();
  }
  return { width: outW, height: outH, data };
}

// One band into its rows of `opts.into`. A renderer that reads straight into the
// output (§5.7) hands `into` back; otherwise it returns the band's own pixels to copy.
function renderBand(renderer, opts) {
  const { into, offset, width, height } = opts;
  let px;
  try {
    px = renderer.renderPixels(opts);
  } catch (err) {
    throw new ExportError(`could not render the photo: ${err?.message ?? err}`, 'gpu');
  }
  const rows = px === into ? into.subarray(offset, offset + width * height * 4) : px;
  if (renderer.lost || !bandRendered(rows)) throw new ExportError('the GPU was reset while the photo was being saved', 'gpu');
  if (px !== into) into.set(px, offset);
}

// The output rows the captions can reach (their shadows included), so bands
// without words skip the raster, and bands with words raster only that strip.
// 'all' when the captions module can't say where its words are.
function captionCover(captions, doc, outW, outH) {
  const list = Array.isArray(doc.text) ? doc.text : [];
  if (list.length === 0) return null;
  if (typeof captions.layout !== 'function') return 'all';
  try {
    return coverRect(list.map((cap) => {
      const lay = captions.layout(cap, outW, outH);
      // the same reach captions.rasterize allows for the shadow
      return { ...captionBounds(cap, lay, outW, outH), margin: lay.fontPx * 0.5 + 2 };
    }), outW, outH);
  } catch {
    return 'all';
  }
}

function overlayCaptions(captions, doc, data, outW, outH, rect) {
  const raster = captions.rasterize(doc, outW, outH, rect);
  if (!raster) return;
  try {
    const ctx = raster.getContext('2d');
    // A raster of the whole output means `rect` was not honoured: read our part of it.
    const whole = raster.width === outW && raster.height === outH;
    const sx = whole ? rect.x : 0, sy = whole ? rect.y : 0;
    const img = ctx.getImageData(sx, sy, rect.width, rect.height);
    compositeOver(data, outW, outH, img.data, img.width, img.height, rect.x, rect.y);
  } finally {
    // iOS keeps a canvas's pixels until GC, and this one can be a whole band
    // (~32 MB) at the export's memory peak.
    if (typeof captions.release === 'function') captions.release(raster);
    else raster.width = raster.height = 0;
  }
}

// ------------------------------------------------------------------ encoding

function workerEncodes() {
  return typeof Worker === 'function' && typeof OffscreenCanvas === 'function';
}

function encodeInWorker(img, quality, signal) {
  return new Promise((resolvePromise, reject) => {
    let worker;
    try {
      worker = new Worker(WORKER_URL, { type: 'module' });
    } catch (err) {
      // nothing was transferred: the pixels are still ours
      reject(Object.assign(new ExportError(`export worker would not start: ${err?.message ?? err}`, 'encode'), { buffer: img.data.buffer }));
      return;
    }
    let timer = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      fn(value);
    };
    const fail = (message, buffer) => finish(reject, Object.assign(new ExportError(message, 'encode'), { buffer }));
    const onAbort = () => finish(reject, abortReason(signal));
    worker.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg?.type === 'blob') finish(resolvePromise, msg.blob);
      else fail(msg?.message || 'the encoder failed', msg?.buffer ?? null);
    });
    worker.addEventListener('error', (e) => {
      e.preventDefault?.();
      fail(`export worker crashed: ${e.message || 'unknown'}`, null);
    });
    timer = setTimeout(() => fail('the encoder took too long', null), WORKER_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    const buffer = img.data.buffer;
    try {
      worker.postMessage({ type: 'encode', buffer, w: img.width, h: img.height, quality }, [buffer]);
    } catch (err) {
      fail(`could not hand the pixels to the encoder: ${err?.message ?? err}`, buffer.byteLength ? buffer : null);
    }
  });
}

async function encodeOnMainThread(img, quality, signal) {
  // toBlob holds this thread for the whole encode: show "Preparing…" first.
  await nextFrame();
  throwIfAborted(signal);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new ExportError('no 2D canvas for the encoder', 'encode');
    ctx.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
    const blob = await new Promise((res) => canvas.toBlob(res, JPEG_TYPE, quality));
    if (!blob) throw new ExportError('the encoder returned nothing (out of memory?)', 'encode');
    return blob;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function assertJpeg(blob) {
  if (!blob || blob.size === 0) throw new ExportError('the JPEG is empty', 'encode');
  // Unsupported types silently become PNG on iOS; never hand Photos the wrong thing.
  if (blob.type !== JPEG_TYPE) throw new ExportError(`expected ${JPEG_TYPE}, got ${blob.type || 'no type'}`, 'not-jpeg');
}

// ------------------------------------------------------------------ helpers

// After the next paint, or soon if frames aren't coming (a hidden page).
function nextFrame() {
  return new Promise((done) => {
    let settled = false;
    const go = () => { if (!settled) { settled = true; done(); } };
    const fallback = setTimeout(go, 100);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => setTimeout(() => { clearTimeout(fallback); go(); }, 0));
    }
  });
}

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('The export was cancelled', 'AbortError');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

export function isAbort(err) {
  return err?.name === 'AbortError';
}
