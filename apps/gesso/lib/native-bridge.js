// The reply bridge already pairs each call with a promise; no id map can leak.
export const NATIVE_ORIGIN = 'gesso://localhost';
export const MAX_TRANSFER_BYTES = 128 * 1024 ** 2;
export const TIMEOUTS = Object.freeze({
  ping: 2000, 'photo.pick': 300000, 'image.info': 15000, 'image.decode': 60000,
  'xfer.create': 5000, 'xfer.release': 5000, 'photos.save': 300000, share: 300000,
  'subject.mask': 25000, haptic: 1000, 'settings.open': 5000, 'clipboard.write': 2000,
});

export class NativeError extends Error {
  constructor(code, message) { super(message); this.name = 'NativeError'; this.code = code; }
}

export function within(promise, ms, { setTimer = setTimeout, clearTimer = clearTimeout, onTimeout = () => {} } = {}) {
  let timer;
  // Both handlers remain attached after a timeout, consuming a late rejection.
  return new Promise((resolve, reject) => {
    timer = setTimer(() => {
      try { onTimeout(); } catch { /* timeout still settles if cancellation fails */ }
      reject(new NativeError('timeout', 'Gesso took too long to respond.'));
    }, ms);
    Promise.resolve(promise).then(resolve, reject);
  }).finally(() => clearTimer(timer));
}

export function createNativeBridge({ flag, handler, timeouts = TIMEOUTS, setTimer, clearTimer } = {}) {
  const isNative = !!(flag?.api === 1 && flag.bridge === 'gesso' && flag.origin === NATIVE_ORIGIN &&
    typeof handler?.postMessage === 'function');
  function call(op, args = {}) {
    if (!isNative) return Promise.reject(new NativeError('web', 'Native operation unavailable.'));
    if (typeof op !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) {
      return Promise.reject(new NativeError('badArgs', 'Invalid bridge arguments.'));
    }
    let reply;
    try { reply = handler.postMessage({ op, args }); }
    catch (err) { return Promise.reject(new NativeError('transport', String(err?.message ?? err))); }
    if (typeof reply?.then !== 'function') return Promise.reject(new NativeError('protocol', 'The bridge did not return a promise.'));
    return within(reply, timeouts[op] ?? 5000, { setTimer, clearTimer }).then((r) => {
      if (r?.ok === true && Object.hasOwn(r, 'result') && r.result !== undefined && !Object.hasOwn(r, 'error')) return r.result;
      if (r?.ok === false && !Object.hasOwn(r, 'result') && typeof r.error?.code === 'string' && typeof r.error.message === 'string') {
        throw new NativeError(r.error.code, r.error.message);
      }
      throw new NativeError('protocol', 'Invalid bridge reply.');
    }, (err) => {
      if (err instanceof NativeError) throw err;
      throw new NativeError('transport', String(err?.message ?? err));
    });
  }
  return { isNative, native: isNative ? flag : null, call };
}

export function transferURL(value) {
  if (typeof value !== 'string') throw new NativeError('badUrl', 'Invalid transfer URL.');
  let url;
  try { url = new URL(value); } catch { throw new NativeError('badUrl', 'Invalid transfer URL.'); }
  if (url.protocol !== 'gesso:' || url.hostname !== 'localhost' || url.port || url.username || url.password ||
      url.search || url.hash || !/^\/xfer\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,12}$/i.test(url.pathname) ||
      url.href !== value) throw new NativeError('badUrl', 'Invalid transfer URL.');
  return value;
}

export function fileRef(ref) {
  transferURL(ref?.url);
  if (typeof ref.name !== 'string' || !ref.name || ref.name.length > 255 ||
      typeof ref.type !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(ref.type) ||
      !Number.isInteger(ref.size) || ref.size < 1 || ref.size > MAX_TRANSFER_BYTES) {
    throw new NativeError('protocol', 'Invalid transfer description.');
  }
  return ref;
}

export function imageInfo(info) {
  if (!Number.isInteger(info?.natW) || !Number.isInteger(info?.natH) || info.natW < 1 || info.natH < 1 ||
      info.natW > 100000 || info.natH > 100000 || typeof info.raw !== 'boolean') {
    throw new NativeError('protocol', 'Invalid image dimensions.');
  }
  return info;
}

export function subjectResult(result, width, height) {
  if (result?.found === false) return { found: false };
  if (result?.found !== true || result.w !== width || result.h !== height ||
      !Array.isArray(result.polygons) || !result.polygons.length || result.polygons.length > 256) {
    throw new NativeError('protocol', 'Invalid subject reply.');
  }
  let total = 0;
  for (const poly of result.polygons) {
    if (!Array.isArray(poly) || poly.length < 6 || poly.length % 2 || (total += poly.length) > 200000) {
      throw new NativeError('protocol', 'Invalid subject outline.');
    }
    for (let i = 0; i < poly.length; i++) {
      if (!Number.isFinite(poly[i]) || poly[i] < 0 || poly[i] > (i % 2 ? height : width)) {
        throw new NativeError('protocol', 'Invalid subject coordinate.');
      }
    }
  }
  return result;
}

export function createTransfers({ call, fetch: fetcher = globalThis.fetch, timeout = 60000 } = {}) {
  async function release(url) {
    transferURL(url);
    try { await call('xfer.release', { url }); } catch { /* launch purge is the last resort */ }
  }
  async function acceptRef(value) {
    try { return fileRef(value); }
    catch (err) {
      try { await release(value?.url); } catch { /* never follow an untrusted URL */ }
      throw err;
    }
  }
  async function request(url, options, consume) {
    const controller = new AbortController();
    const pending = Promise.resolve().then(async () => {
      const response = await fetcher(url, { ...options, signal: controller.signal });
      if (!response.ok) throw new NativeError('transfer', `Local file transfer failed (${response.status}).`);
      return consume(response);
    });
    try { return await within(pending, timeout, { onTimeout: () => controller.abort() }); }
    catch (err) {
      if (err instanceof NativeError) throw err;
      throw new NativeError('transfer', String(err?.message ?? err));
    }
  }
  async function putFile(blob, name = 'photo.jpg') {
    if (!Number.isInteger(blob?.size) || blob.size < 1 || blob.size > MAX_TRANSFER_BYTES) {
      throw new NativeError('size', 'This photo is too large to transfer.');
    }
    const ref = await acceptRef(await call('xfer.create', { name, type: blob.type || 'application/octet-stream', size: blob.size }));
    try {
      if (ref.size !== blob.size) throw new NativeError('protocol', 'Transfer length changed.');
      const body = await blob.arrayBuffer();
      const reply = await request(ref.url, { method: 'POST', headers: { 'Content-Type': ref.type }, body }, (r) => r.json());
      if (reply?.size !== blob.size) throw new NativeError('transfer', 'The photo transfer was incomplete.');
      return ref;
    } catch (err) {
      await release(ref.url);
      throw err;
    }
  }
  async function fetchFile(value) {
    const ref = fileRef(value);
    const blob = await request(ref.url, {}, (r) => r.blob());
    if (blob.size !== ref.size) throw new NativeError('transfer', 'The photo transfer was incomplete.');
    return new File([blob], ref.name, { type: ref.type });
  }
  async function withFile(blob, name, operation) {
    const ref = await putFile(blob, name);
    try { return await operation(ref); } finally { await release(ref.url); }
  }
  return { putFile, fetchFile, release, withFile, acceptRef };
}
