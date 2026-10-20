// JPEG encoding for Save, off the main thread: canvas.toBlob would freeze the UI
// for the whole encode (§5.7). Started per export as a module worker and
// terminated afterwards, so its OffscreenCanvas memory goes with it:
//   new Worker(new URL('../workers/export-worker.js', import.meta.url), { type: 'module' })
//
//   { type: 'encode', buffer, w, h, quality } -> { type: 'blob', blob }
//                                              | { type: 'error', message, buffer }
//
// `buffer` (w * h RGBA, opaque, top row first) is transferred in. On failure it is
// transferred back when still intact, so the page can encode on the main thread
// without rendering the photo again. No imports: nothing else is needed here.

self.addEventListener('message', async (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'encode') return;
  const { buffer, w, h } = msg;
  const quality = Number.isFinite(msg.quality) ? msg.quality : 0.92;
  let canvas = null;
  try {
    if (typeof OffscreenCanvas !== 'function') throw new Error('OffscreenCanvas is not available in workers here');
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== w * h * 4) throw new Error('pixel buffer does not match the size');
    canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2D context on the OffscreenCanvas');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(buffer), w, h), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    // Unsupported types silently come back as PNG: Photos must get a JPEG.
    if (!blob || blob.size === 0 || blob.type !== 'image/jpeg') throw new Error(`encoder returned ${blob ? blob.type || 'no type' : 'nothing'}`);
    self.postMessage({ type: 'blob', blob });
  } catch (err) {
    const intact = buffer instanceof ArrayBuffer && buffer.byteLength > 0;
    self.postMessage({ type: 'error', message: String(err?.message ?? err), buffer: intact ? buffer : null }, intact ? [buffer] : []);
  } finally {
    // iOS keeps canvas backing stores until GC; zeroing frees ~100 MB now.
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
});
