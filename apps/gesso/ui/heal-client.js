// Remove's link to workers/heal-worker.js: one module worker, one promise per job.
//
//   const heal = createHealClient();
//   heal.find(img, mask, { maxResults })          -> Promise<[{ dx, dy, score }]>
//   heal.correct(img, mask, dx, dy, { iters, featherPx }) -> Promise<{ width, height, data }>
//   heal.inpaint(img, mask, { scale, seed })      -> Promise<{ width, height, data }>
//   heal.warm()      start the worker early (Remove opening), so the first tap is quick
//   heal.dispose()
//
// img is { width, height, data: Uint8ClampedArray RGBA }, mask a Uint8Array of
// width * height. Their buffers are TRANSFERRED to the worker (they are detached
// here afterwards), so pass copies of anything you still need.
//
// A job that takes longer than `timeoutMs` rejects with code 'timeout' and the
// worker is replaced: a stuck PatchMatch must not hold every later fill hostage.
// If module workers can't start at all, jobs run in this thread instead (slower to
// paint around, but Remove still works).

export class HealError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'HealError';
    this.code = code; // 'timeout' | 'crashed' | 'failed'
  }
}

export function createHealClient({ timeoutMs = 20000, url = new URL('../workers/heal-worker.js', import.meta.url) } = {}) {
  let worker = null;
  let workerOk = false; // this worker has answered at least once
  let inProcess = typeof Worker === 'undefined';
  let nextJob = 1;
  const pending = new Map(); // job -> { resolve, reject, timer }

  function settleAll(err) {
    for (const [job, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(job);
      p.reject(err);
    }
  }

  function drop() {
    if (!worker) return;
    worker.terminate();
    worker = null;
    workerOk = false;
  }

  function spawn() {
    if (worker) return worker;
    try {
      worker = new Worker(url, { type: 'module' });
    } catch {
      inProcess = true;
      return null;
    }
    worker.addEventListener('message', (e) => {
      workerOk = true;
      const msg = e.data;
      const p = pending.get(msg?.job);
      if (!p) return; // timed out already
      pending.delete(msg.job);
      clearTimeout(p.timer);
      if (msg.type === 'error') p.reject(new HealError(msg.message || 'heal failed', 'failed'));
      else p.resolve(msg);
    });
    const crash = (e) => {
      e?.preventDefault?.();
      // A worker that never answered couldn't load (no module workers): stop trying.
      if (!workerOk) inProcess = true;
      drop();
      settleAll(new HealError('The heal worker stopped', 'crashed'));
    };
    worker.addEventListener('error', crash);
    worker.addEventListener('messageerror', crash);
    return worker;
  }

  async function runHere(msg) {
    const { handleHealMessage } = await import('../lib/heal.js');
    await new Promise((r) => setTimeout(r, 0)); // let the ring and shimmer paint first
    const { message } = handleHealMessage(msg);
    if (message.type === 'error') throw new HealError(message.message || 'heal failed', 'failed');
    return message;
  }

  function run(msg, transfer) {
    const job = nextJob++;
    msg.job = job;
    if (inProcess || !spawn()) return runHere(msg);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(job);
        reject(new HealError('Removing took too long', 'timeout'));
        // The worker is busy with this job and everything queued behind it.
        drop();
        settleAll(new HealError('The heal worker was restarted', 'crashed'));
      }, timeoutMs);
      pending.set(job, { resolve, reject, timer });
      try {
        worker.postMessage(msg, uniqueBuffers(transfer));
      } catch (err) {
        clearTimeout(timer);
        pending.delete(job);
        reject(new HealError(String(err?.message || err), 'failed'));
      }
    });
  }

  return {
    async find(img, mask, { maxResults = 4 } = {}) {
      const res = await run({ type: 'find', img, mask, maxResults }, [img.data.buffer, mask.buffer]);
      return res.sources;
    },
    async correct(img, mask, dx, dy, { iters, featherPx } = {}) {
      const msg = { type: 'correct', img, mask, dx, dy };
      if (iters != null) msg.iters = iters;
      if (featherPx != null) msg.featherPx = featherPx;
      const res = await run(msg, [img.data.buffer, mask.buffer]);
      return asImage(res.tile);
    },
    async inpaint(img, mask, { scale = 1, seed } = {}) {
      const msg = { type: 'inpaint', img, mask, scale };
      if (seed != null) msg.seed = seed;
      const res = await run(msg, [img.data.buffer, mask.buffer]);
      return asImage(res.tile);
    },
    // Start the worker and load lib/heal.js ahead of the first tap.
    warm() {
      if (inProcess || worker) return;
      const img = { width: 8, height: 8, data: new Uint8ClampedArray(256) };
      const mask = new Uint8Array(64);
      mask[27] = 1;
      run({ type: 'find', img, mask, maxResults: 1 }, [img.data.buffer, mask.buffer]).catch(() => {});
    },
    dispose() {
      drop();
      settleAll(new HealError('Remove was closed', 'crashed'));
    },
    get pending() { return pending.size; },
  };
}

// The same buffer twice in a transfer list is a DataCloneError.
function uniqueBuffers(list) {
  return [...new Set(list.filter((b) => b instanceof ArrayBuffer && b.byteLength > 0))];
}

function asImage(tile) {
  const data = tile.data instanceof ArrayBuffer ? new Uint8ClampedArray(tile.data) : tile.data;
  return { width: tile.width, height: tile.height, data };
}
