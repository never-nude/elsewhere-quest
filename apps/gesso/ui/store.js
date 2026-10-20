// On-device storage for the draft (SPEC §5.6): IndexedDB database 'gesso' with
// three stores, 'blobs', 'docs' and 'meta', all with out-of-line keys.
//
// openStore() -> Promise<Store>
// Store = {
//   available: boolean,          // false when IndexedDB is unavailable (Private Browsing, Lockdown): memory only
//   persistent: boolean,         // result of navigator.storage.persist()
//   putBlob(key, blob), getBlob(key) -> Blob|null, deleteBlob(key),
//   putDoc(id, record, { current = false }), getDoc(id) -> record|null, deleteDoc(id), docKeys() -> string[],
//                                // current: also point meta 'current' at id, in the same transaction
//   getCurrent() -> id|null, setCurrent(id|null),
//   blobKeys() -> string[], gc(keep: Set<string> | (key) => boolean) -> string[] dropped
// }
//
// WebKit realities this works around:
// - Every read is by primary key, never through an index: iOS 18.4 crashes reading
//   Blobs through one. Listing uses getAllKeys(), which reads no values.
// - iOS drops the connection to the IndexedDB server while the app is in the
//   background ("Connection to Indexed Database server lost"); a transaction that
//   fails that way reopens the database and runs once more.
// - Some WebKit builds (Private Browsing in particular) refuse to store Blobs;
//   those fall back to storing the bytes, and getBlob hands back a Blob either way.
// - Without IndexedDB at all, or if it cannot be opened or written within a few
//   seconds, the same API runs in memory and reports available: false.
// A write's transaction is created synchronously inside the call whenever the
// connection is open, so a flush from pagehide reaches IndexedDB before the page
// can be frozen.

const DB_NAME = 'gesso';
const DB_VERSION = 1;
const STORES = ['blobs', 'docs', 'meta'];
const OPEN_TIMEOUT_MS = 3000;
const PERSIST_TIMEOUT_MS = 1000;
const CURRENT = 'current';
// Failures that mean the connection, not the request, went bad. WebKit reports a
// lost server connection as an UnknownError that says so.
const CONNECTION_ERRORS = new Set(['InvalidStateError', 'TransactionInactiveError']);
const LOST_CONNECTION = /connection|server|lost/i;

export async function openStore({ idb = globalThis.indexedDB, timeoutMs = OPEN_TIMEOUT_MS } = {}) {
  const persisting = requestPersist();
  let db = null;
  try {
    if (!idb || typeof idb.open !== 'function') throw new Error('IndexedDB is unavailable');
    db = await openDb(idb, timeoutMs);
    await probe(db);
  } catch (err) {
    console.warn('Gesso: storing edits in memory only', err);
    try { db?.close(); } catch { /* already gone */ }
    db = null;
  }
  const persistent = await persisting;
  return db ? idbStore(idb, db, persistent, timeoutMs) : memoryStore(persistent);
}

// Ask iOS not to evict our data (granted in a Home Screen app). The answer is only
// recorded; nothing waits on it for long.
async function requestPersist() {
  try {
    const p = globalThis.navigator?.storage?.persist?.();
    if (!p) return false;
    return (await withTimeout(p, PERSIST_TIMEOUT_MS, false)) === true;
  } catch {
    return false;
  }
}

function withTimeout(promise, ms, fallback) {
  let timer = 0;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function openDb(idb, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    // Some WebKit releases leave open() pending forever on a cold start.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('IndexedDB open timed out'));
    }, timeoutMs);
    let req;
    try {
      req = idb.open(DB_NAME, DB_VERSION);
    } catch (err) {
      clearTimeout(timer);
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
    };
    req.onsuccess = () => {
      const db = req.result;
      if (settled) { db.close(); return; } // too late: we already went memory-only
      settled = true;
      clearTimeout(timer);
      resolve(db);
    };
    req.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(req.error ?? new Error('IndexedDB open failed'));
    };
    req.onblocked = () => { /* another tab holds an old version; onsuccess follows when it closes */ };
  });
}

// Opening can succeed where writing cannot (a full disk, some private modes).
function probe(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['meta'], 'readwrite');
    tx.objectStore('meta').put({ at: Date.now() }, 'probe');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB probe aborted'));
  });
}

function request(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function finished(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
  });
}

function idbStore(idb, first, persistent, timeoutMs) {
  let db = first;
  let opening = null;
  let blobsAsBytes = false;
  watch(first);

  function watch(d) {
    d.onversionchange = () => { try { d.close(); } catch { /* ignore */ } if (db === d) db = null; };
    d.onclose = () => { if (db === d) db = null; };
  }

  function reopen() {
    if (!opening) {
      opening = openDb(idb, timeoutMs).then((d) => { watch(d); db = d; return d; }).finally(() => { opening = null; });
    }
    return opening;
  }

  function drop(d) {
    if (db !== d) return;
    db = null;
    try { d.close(); } catch { /* already closed */ }
  }

  // Run `body(tx)` in a fresh transaction and resolve with its result once the
  // transaction has completed. `body` issues its requests synchronously. With an
  // open connection the transaction is created before this returns.
  async function run(names, mode, body, { commit = mode === 'readwrite' } = {}) {
    for (let attempt = 0; ; attempt++) {
      let d = null;
      let tx;
      try {
        d = db ?? (await reopen());
        tx = d.transaction(names, mode);
      } catch (err) {
        if (d) drop(d);
        if (attempt === 0) continue;
        throw err;
      }
      let result;
      try {
        result = body(tx);
        if (commit) tx.commit?.();
      } catch (err) {
        try { tx.abort(); } catch { /* already finished */ }
        throw err;
      }
      const done = finished(tx);
      try {
        const [value] = await Promise.all([result, done]);
        return value;
      } catch (err) {
        // A request in an aborted transaction only says AbortError; the
        // transaction's own error says why.
        const why = (await done.then(() => null, (e) => e)) ?? err;
        if (attempt === 0 && (lostConnection(why, d) || lostConnection(err, d))) { drop(d); continue; }
        throw why?.name === 'AbortError' ? err : why;
      }
    }
  }

  function lostConnection(err, d) {
    if (db !== d) return true; // closed under us (onclose / onversionchange)
    if (CONNECTION_ERRORS.has(err?.name)) return true;
    return err?.name === 'UnknownError' && LOST_CONNECTION.test(String(err?.message ?? ''));
  }

  const get = (name, key) => run([name], 'readonly', (tx) => request(tx.objectStore(name).get(key)));
  const put = (names, name, value, key) => run(names, 'readwrite', (tx) => request(tx.objectStore(name).put(value, key)));
  const del = (name, key) => run([name], 'readwrite', (tx) => request(tx.objectStore(name).delete(key)));
  const keys = (name) => run([name], 'readonly', (tx) => request(tx.objectStore(name).getAllKeys()));

  return {
    available: true,
    persistent,

    async putBlob(key, blob) {
      if (!blobsAsBytes) {
        try {
          await put(['blobs'], 'blobs', blob, key);
          return;
        } catch (err) {
          if (err?.name === 'QuotaExceededError') throw err;
          blobsAsBytes = true;
        }
      }
      const bytes = await blob.arrayBuffer();
      await put(['blobs'], 'blobs', { bytes, type: blob.type || '', name: typeof blob.name === 'string' ? blob.name : '' }, key);
    },

    async getBlob(key) {
      return toBlob(await get('blobs', key));
    },

    deleteBlob: (key) => del('blobs', key),

    // Scoped over 'blobs' too: IndexedDB runs overlapping read-write transactions in
    // the order they were created, so a record can never land before a tile write
    // that was started ahead of it. With `current`, the record and the pointer to it
    // land together or not at all.
    putDoc(id, record, { current = false } = {}) {
      if (!current) return put(['blobs', 'docs'], 'docs', record, id);
      return run(['blobs', 'docs', 'meta'], 'readwrite', (tx) => {
        const done = request(tx.objectStore('docs').put(record, id));
        tx.objectStore('meta').put({ docId: id }, CURRENT);
        return done;
      });
    },
    getDoc: async (id) => (await get('docs', id)) ?? null,
    deleteDoc: (id) => del('docs', id),
    docKeys: () => keys('docs'),

    async getCurrent() {
      const v = await get('meta', CURRENT);
      return v && typeof v.docId === 'string' && v.docId !== '' ? v.docId : null;
    },
    setCurrent: (id) => (id ? put(['meta'], 'meta', { docId: id }, CURRENT) : del('meta', CURRENT)),

    blobKeys: () => keys('blobs'),

    // One transaction: list, then delete what is not kept. Writes started after
    // this call queue behind it, so nothing stored later can be swept by mistake.
    gc(keep) {
      const keeps = typeof keep === 'function' ? keep : (k) => keep.has(k);
      return run(['blobs'], 'readwrite', (tx) => new Promise((resolve, reject) => {
        const st = tx.objectStore('blobs');
        const r = st.getAllKeys();
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const dropped = [];
          for (const k of r.result) if (!keeps(k)) { st.delete(k); dropped.push(k); }
          resolve(dropped);
        };
      }), { commit: false });
    },
  };
}

function toBlob(v) {
  if (!v) return null;
  if (typeof Blob !== 'undefined' && v instanceof Blob) return v;
  if (v.bytes instanceof ArrayBuffer) {
    const opts = { type: typeof v.type === 'string' ? v.type : '' };
    if (v.name && typeof File !== 'undefined') {
      try { return new File([v.bytes], v.name, opts); } catch { /* old WebKit: no File constructor */ }
    }
    return new Blob([v.bytes], opts);
  }
  return null;
}

// The same API with nothing kept past this page: Private Browsing, Lockdown Mode.
function memoryStore(persistent) {
  const blobs = new Map(), docs = new Map();
  let current = null;
  return {
    available: false,
    persistent,
    async putBlob(k, b) { blobs.set(k, b); },
    async getBlob(k) { return blobs.get(k) ?? null; },
    async deleteBlob(k) { blobs.delete(k); },
    async putDoc(id, r, { current: point = false } = {}) {
      docs.set(id, r);
      if (point) current = id;
    },
    async getDoc(id) { return docs.get(id) ?? null; },
    async deleteDoc(id) { docs.delete(id); },
    async docKeys() { return [...docs.keys()]; },
    async getCurrent() { return current; },
    async setCurrent(id) { current = id || null; },
    async blobKeys() { return [...blobs.keys()]; },
    async gc(keep) {
      const keeps = typeof keep === 'function' ? keep : (k) => keep.has(k);
      const dropped = [];
      for (const k of [...blobs.keys()]) if (!keeps(k)) { blobs.delete(k); dropped.push(k); }
      return dropped;
    },
  };
}
