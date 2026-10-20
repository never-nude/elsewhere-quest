// Autosave and resume (SPEC §5.6, F16): the original file, the whole history, the
// pools and every Remove tile are kept on the device after each step, so a
// relaunch (or iOS killing the app) reopens exactly where the user left off.
//
// createAutosave(store, getEditor, { debounceMs = 300 }) -> {
//   schedule()                    called by the editor after every committed step: debounce a draft write
//   flush()                       write now (visibility hidden / pagehide), best effort; resolves when
//                                 every write in flight has settled
//   startDraft(id, file)          a new photo: store the original File/Blob as 'source:<id>', set current
//   saveTile(id, rgba, meta)      a Remove fill tile: write 'tile:<id>' BEFORE the history entry that references it
//   loadDraft() -> null | { file, info, history, pools, tiles: Map<id, Uint8ClampedArray>, savedRevision: boolean, maxPixels }
//                                 throws when the stored draft is damaged (the app then discards it)
//   discard()                     forget the current draft and its blobs
// }
// The editor exposes ed.serialize() -> { history, pools, savedRevision }, ed.sourceInfo
// and ed.tiles.
//
// v1 keeps one draft. Nothing here ever throws into the editor: storage trouble is
// logged, and only a full disk is worth telling the user about.
//
// Invariant: meta 'current' only ever names a record whose original and every
// tile are stored, so whatever it names can be restored. The record and 'current'
// are written in one transaction, and a record is held back while any tile it
// names is not known to be stored (it is stored again from ed.tiles first).

import {
  draftRecord, reviveDraft, draftKeys, encodeTileHeader, decodeTileHeader, TILE_HEADER_BYTES,
  sourceKey, tileKey, workingCapFor,
} from '../lib/draft.js';
import { referencedIds } from '../lib/history.js';
import { WORK_MAX_PIXELS, WORK_FALLBACK_PIXELS } from '../lib/image-io.js';

const WORK_CAP_KEY = 'gesso:workCap'; // app.js records a memory step-down here

export function createAutosave(store, getEditor, { debounceMs = 300, now = () => Date.now() } = {}) {
  let timer = 0;
  let draftId = null; // the draft that writes go to; null after discard()
  let draftCap = null; // the decode cap that reproduces its working size
  let source = null; // { id, file } of the photo being edited, kept to re-create a discarded draft
  // Blob keys of that photo: `stored` are known to be in the store; `kept` were
  // written or are being written, and are never swept while it is on screen.
  let stored = new Set();
  let kept = new Set();
  let written = null; // { history, pools, saved } as last handed to the store
  let pointed; // what meta 'current' is known to name (undefined: not known yet)
  let epoch = 0; // bumped by startDraft and discard, so an older loadDraft stands down
  let healing = null; // tiles being stored again before a record may name them
  let toldFull = false;
  const inflight = new Set();
  let ops = Promise.resolve(); // startDraft / loadDraft / discard, one at a time, in call order

  const editor = () => {
    try { return getEditor?.() ?? null; } catch { return null; }
  };
  const docIdOf = (ed) => ed?.history?.entries?.[0]?.state?.id ?? null;

  function queue(task) {
    const p = ops.then(task);
    ops = p.then(() => {}, () => {});
    return p;
  }

  function track(p) {
    const settled = p.then(() => {}, () => {});
    inflight.add(settled);
    settled.then(() => inflight.delete(settled));
    return p;
  }

  function report(err) {
    console.warn('Gesso autosave:', err);
    if (err?.name === 'QuotaExceededError' && !toldFull) {
      toldFull = true;
      editor()?.toast?.("This iPhone is out of space, so this edit isn't being kept.", 3000);
    }
  }

  // Hand the editor's current history to the store. The record is built and the
  // store's transaction opened synchronously, so a pagehide flush is not lost to a
  // frozen page, and writes reach IndexedDB in the order they were made (the last
  // one wins). Returns the write's promise, or null when there was nothing to do.
  function write() {
    clearTimeout(timer);
    timer = 0;
    const ed = editor();
    const id = docIdOf(ed);
    if (!id) return null;
    if (id !== draftId) {
      // The draft was discarded (New photo → Discard edit, then the picker was
      // cancelled) but this photo is still being edited: keep it after all.
      if (source && source.id === id) startDraft(source.id, source.file);
      return null;
    }
    const saved = ed.isSaved === true;
    if (written && written.history === ed.history && written.pools === ed.pools && written.saved === saved) return null;
    let record;
    try {
      // A record naming a tile that is not stored would make the whole draft
      // unrestorable; keep the last good record until the tile is stored.
      const missing = [...referencedIds(ed.history).patches].filter((pid) => !stored.has(tileKey(pid)));
      if (missing.length) {
        storeAgain(ed, id, missing);
        return null;
      }
      record = draftRecord({ id, info: ed.sourceInfo, serialized: ed.serialize(), maxPixels: draftCap, now: now() });
    } catch (err) {
      report(err);
      return null;
    }
    // Until the original is stored the record cannot be restored: it is written,
    // but 'current' is left alone (startDraft writes it again once it can).
    const point = stored.has(sourceKey(id));
    const mark = { history: ed.history, pools: ed.pools, saved };
    written = mark;
    let p;
    try {
      p = Promise.resolve(store.putDoc(id, record, { current: point }));
    } catch (err) {
      p = Promise.reject(err);
    }
    p = p.then(() => {
      if (point && draftId === id) pointed = id;
    }, (err) => {
      if (written === mark) written = null; // retry on the next schedule or flush
      throw err;
    });
    track(p.catch(report));
    return p;
  }

  // Store tiles again from the editor's copies (a write that failed, or a sweep
  // after Discard), then write the record that names them.
  function storeAgain(ed, id, ids) {
    if (healing) return;
    healing = (async () => {
      for (const pid of ids) {
        const rgba = ed.tiles?.get?.(pid);
        const meta = ed.pools?.patches?.[pid];
        if (!rgba || !meta) return false; // nothing to store: wait for that step to go
        if (!(await saveTile(pid, rgba, meta))) return false;
      }
      return true;
    })().then((ok) => {
      healing = null;
      if (ok && draftId === id) write();
    });
  }

  function capFor(info, first) {
    let stored = null;
    try { stored = Number(globalThis.localStorage?.getItem(WORK_CAP_KEY)) || null; } catch { /* no storage */ }
    const candidates = [stored ?? WORK_MAX_PIXELS, WORK_MAX_PIXELS, WORK_FALLBACK_PIXELS];
    if (!first?.source) return candidates[0];
    return workingCapFor(info?.natW ?? first.source.natW, info?.natH ?? first.source.natH, first.source.w, first.source.h, candidates);
  }

  // Blob keys to keep while sweeping: this photo's original, the tiles any of its
  // history entries name, and tiles stored since it opened (a fill whose step is
  // about to be committed).
  function keeper(id) {
    const ed = editor();
    const refs = docIdOf(ed) === id ? referencedIds(ed.history).patches : new Set();
    const keep = draftKeys(id, refs);
    const a = kept, b = stored;
    return (k) => keep.has(k) || a.has(k) || b.has(k);
  }

  async function dropOtherDocs(id) {
    for (const k of await store.docKeys()) if (k !== id) await store.deleteDoc(k);
  }

  function startDraft(id, file) {
    clearTimeout(timer);
    timer = 0;
    epoch++;
    if (source?.id !== id) {
      stored = new Set();
      kept = new Set();
    }
    draftId = id;
    source = { id, file };
    written = null;
    const ed = editor();
    draftCap = capFor(ed?.sourceInfo, docIdOf(ed) === id ? ed.history.entries[0].state : null);
    const keys = { stored, kept };
    const p = queue(async () => {
      try {
        // Until this photo can come back, nothing should: not the previous photo,
        // which the user has moved on from.
        if (pointed !== null) {
          await store.setCurrent(null);
          pointed = null;
        }
        if (draftId !== id) return; // another photo or a discard got here first
        const sk = sourceKey(id);
        if (!keys.stored.has(sk)) {
          keys.kept.add(sk);
          await store.putBlob(sk, file);
          keys.stored.add(sk);
        }
        if (draftId !== id) return;
        // Write the record again even if a debounced write already did, this time
        // with 'current'.
        written = null;
        const w = write(); // null: the editor is not showing this photo (yet)
        if (w) await w;
      } catch (err) {
        report(err);
      }
      if (draftId !== id) return; // superseded: the task queued behind this one takes over
      // Sweep the previous photo's draft.
      try {
        await dropOtherDocs(id);
        await store.gc(keeper(id));
      } catch (err) {
        report(err);
      }
    });
    return track(p);
  }

  async function saveTile(id, rgba, meta) {
    const key = tileKey(id);
    const keys = { stored, kept }; // this photo's, even if another one opens meanwhile
    keys.kept.add(key);
    try {
      const rect = { x: meta.x, y: meta.y, w: meta.w, h: meta.h };
      const blob = new Blob([encodeTileHeader(rect, rgba.byteLength), rgba]);
      await track(store.putBlob(key, blob));
      keys.stored.add(key);
      return true;
    } catch (err) {
      report(err);
      return false;
    }
  }

  function loadDraft() {
    const started = epoch;
    return queue(async () => {
      // A photo opened while this waited (the picker beat the restore): it wins.
      if (epoch !== started) return null;
      let d, file, tiles, id;
      try {
        id = await store.getCurrent();
        if (epoch !== started) return null;
        if (!id) {
          pointed = null;
          // No draft: anything left over (a photo whose first write never finished)
          // is garbage.
          try {
            await dropOtherDocs(null);
            const a = kept, b = stored;
            await store.gc((k) => a.has(k) || b.has(k));
          } catch (err) {
            report(err);
          }
          return null;
        }
        const raw = await store.getDoc(id);
        if (!raw) throw new Error('draft: the record is missing');
        d = reviveDraft(raw, id);
        const blob = await store.getBlob(sourceKey(id));
        if (!blob || !blob.size) throw new Error('draft: the original photo is missing');
        // WebKit can hand back a Blob whose file has gone; find out here, not mid-decode.
        await blob.slice(0, 16).arrayBuffer();
        tiles = new Map();
        // One at a time: a long rub can be tens of MB, and they all end up resident anyway.
        for (const pid of d.tileIds) {
          const t = await store.getBlob(tileKey(pid));
          if (!t) throw new Error(`draft: fill ${pid} is missing`);
          const rect = decodeTileHeader(new Uint8Array(await t.slice(0, TILE_HEADER_BYTES).arrayBuffer()), t.size);
          const m = d.pools.patches[pid];
          if (rect.x !== m.x || rect.y !== m.y || rect.w !== m.w || rect.h !== m.h) throw new Error(`draft: fill ${pid} does not match its tile`);
          tiles.set(pid, new Uint8ClampedArray(await t.slice(TILE_HEADER_BYTES).arrayBuffer()));
        }
        file = asFile(blob, d.info);
      } catch (err) {
        if (epoch !== started) return null; // superseded: not ours to report or discard
        throw err;
      }
      if (epoch !== started) return null;
      const first = d.history.entries[0].state;
      draftId = id;
      // Records from before maxPixels was kept: work it out from the sizes.
      draftCap = d.maxPixels ?? capFor(d.info, first);
      source = { id, file };
      stored = draftKeys(id, d.tileIds);
      kept = new Set(stored);
      pointed = id;
      // editor.resume() adopts these very objects, so its first schedule() finds
      // nothing new to write.
      written = { history: d.history, pools: d.pools, saved: d.savedRevision };
      try {
        await dropOtherDocs(id);
        await store.gc(keeper(id));
      } catch (err) {
        report(err);
      }
      return { file, info: d.info, history: d.history, pools: d.pools, tiles, savedRevision: d.savedRevision, maxPixels: draftCap };
    });
  }

  function discard() {
    clearTimeout(timer);
    timer = 0;
    epoch++;
    // A photo still on screen keeps its blobs (the picker may be cancelled, and
    // then the draft comes back, see write()); WebKit can also make a Blob read
    // from IndexedDB unreadable once its record is deleted, and that Blob is the
    // one being edited. The next photo's startDraft sweeps them.
    const onScreen = !!source && docIdOf(editor()) === source.id;
    if (!onScreen) {
      source = null;
      stored = new Set();
      kept = new Set();
      draftCap = null;
    }
    const keep = onScreen ? keeper(source.id) : () => false;
    draftId = null;
    written = null;
    return track(queue(async () => {
      try {
        await store.setCurrent(null);
        pointed = null;
        await dropOtherDocs(null);
        await store.gc(keep);
      } catch (err) {
        report(err);
      }
    }));
  }

  // Everything in flight, including writes that start because others finished
  // (a tile stored again, then its record).
  async function settle() {
    for (let i = 0; i < 8; i++) {
      const pending = [...inflight, ops];
      if (healing) pending.push(healing);
      await Promise.all(pending);
      if (!inflight.size && !healing) return;
    }
  }

  return {
    schedule() {
      clearTimeout(timer);
      timer = setTimeout(write, debounceMs);
    },
    flush() {
      try { write(); } catch (err) { report(err); }
      return settle();
    },
    startDraft,
    saveTile,
    loadDraft,
    discard,
    get available() { return store.available === true; },
    get persistent() { return store.persistent === true; },
    // The decode cap that reproduces the working size of the photo being edited
    // (for re-decoding it after a lost WebGL context).
    get maxPixels() { return draftCap; },
  };
}

function asFile(blob, info) {
  if (typeof File === 'undefined' || blob instanceof File) return blob;
  try {
    return new File([blob], info?.name || 'photo', { type: blob.type });
  } catch {
    return blob;
  }
}
