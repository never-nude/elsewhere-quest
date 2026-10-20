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
// The editor exposes ed.serialize() -> { history, pools, savedRevision } and ed.sourceInfo.
//
// v1 keeps one draft. Nothing here ever throws into the editor: storage trouble is
// logged, and only a full disk is worth telling the user about.

import {
  draftRecord, reviveDraft, draftKeys, encodeTileHeader, decodeTileHeader, TILE_HEADER_BYTES,
  sourceKey, tileKey, workingCapFor,
} from '../lib/draft.js';
import { referencedIds } from '../lib/history.js';
import { WORK_MAX_PIXELS, WORK_FALLBACK_PIXELS } from '../lib/image-io.js';

const WORK_CAP_KEY = 'gesso:workCap'; // app.js records a memory step-down here

export function createAutosave(store, getEditor, { debounceMs = 300, now = () => Date.now() } = {}) {
  let timer = 0;
  let draftId = null; // the draft that writes go to
  let draftCap = null; // the decode cap that reproduces its working size
  let source = null; // { id, file } of the photo being edited, kept to re-create a discarded draft
  let written = null; // { history, pools, saved } as last handed to the store
  let toldFull = false;
  const sessionTiles = new Set(); // tile keys stored since this draft started: never swept
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
      record = draftRecord({ id, info: ed.sourceInfo, serialized: ed.serialize(), maxPixels: draftCap, now: now() });
    } catch (err) {
      report(err);
      return null;
    }
    const mark = { history: ed.history, pools: ed.pools, saved };
    written = mark;
    let p;
    try {
      p = Promise.resolve(store.putDoc(id, record));
    } catch (err) {
      p = Promise.reject(err);
    }
    p = p.catch((err) => {
      if (written === mark) written = null; // retry on the next schedule or flush
      throw err;
    });
    track(p.catch(report));
    return p;
  }

  function capFor(ed, id) {
    let stored = null;
    try { stored = Number(globalThis.localStorage?.getItem(WORK_CAP_KEY)) || null; } catch { /* no storage */ }
    const candidates = [stored ?? WORK_MAX_PIXELS, WORK_MAX_PIXELS, WORK_FALLBACK_PIXELS];
    const info = ed?.sourceInfo;
    const st = docIdOf(ed) === id ? ed.history.entries[0].state : null;
    if (!info || !st) return candidates[0];
    return workingCapFor(info.natW ?? st.source.natW, info.natH ?? st.source.natH, st.source.w, st.source.h, candidates);
  }

  // Blob keys to keep while sweeping: this draft's original, the tiles any of its
  // history entries name, and tiles stored since it started (a fill whose step is
  // about to be committed).
  function keeper(id) {
    const ed = editor();
    const refs = docIdOf(ed) === id ? referencedIds(ed.history).patches : new Set();
    const keep = draftKeys(id, refs);
    return (k) => keep.has(k) || sessionTiles.has(k);
  }

  async function dropOtherDocs(id) {
    for (const k of await store.docKeys()) if (k !== id) await store.deleteDoc(k);
  }

  function startDraft(id, file) {
    clearTimeout(timer);
    timer = 0;
    draftId = id;
    source = { id, file };
    written = null;
    sessionTiles.clear();
    draftCap = capFor(editor(), id);
    const p = queue(async () => {
      let stored = false;
      try {
        await store.putBlob(sourceKey(id), file);
        if (draftId !== id) return; // another photo or a discard got here first
        // Write the record again even if a debounced write already did: 'current'
        // must only ever point at a record that is known to be stored.
        written = null;
        const w = write(); // null: the editor is not showing this photo
        if (w) {
          await w;
          if (draftId !== id) return;
          await store.setCurrent(id);
          stored = true;
        }
      } catch (err) {
        report(err);
      }
      // Superseded: the task queued behind this one takes over.
      if (draftId !== id) return;
      // A draft that cannot come back must not leave the previous photo's draft to
      // be restored in its place.
      if (!stored) {
        try { await store.setCurrent(null); } catch (err) { report(err); }
      }
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
    sessionTiles.add(key);
    try {
      const rect = { x: meta.x, y: meta.y, w: meta.w, h: meta.h };
      const blob = new Blob([encodeTileHeader(rect, rgba.byteLength), rgba]);
      await track(store.putBlob(key, blob));
      return true;
    } catch (err) {
      report(err);
      return false;
    }
  }

  function loadDraft() {
    return queue(async () => {
      const id = await store.getCurrent();
      if (!id) {
        // No draft: anything left over (a photo whose first write never finished)
        // is garbage.
        try {
          await dropOtherDocs(null);
          await store.gc((k) => sessionTiles.has(k));
        } catch (err) {
          report(err);
        }
        return null;
      }
      const raw = await store.getDoc(id);
      if (!raw) throw new Error('draft: the record is missing');
      const d = reviveDraft(raw, id);
      const blob = await store.getBlob(sourceKey(id));
      if (!blob || !blob.size) throw new Error('draft: the original photo is missing');
      // WebKit can hand back a Blob whose file has gone; find out here, not mid-decode.
      await blob.slice(0, 16).arrayBuffer();
      const tiles = new Map();
      // One at a time: a long rub can be tens of MB, and they all end up resident anyway.
      for (const pid of d.tileIds) {
        const t = await store.getBlob(tileKey(pid));
        if (!t) throw new Error(`draft: fill ${pid} is missing`);
        const rect = decodeTileHeader(new Uint8Array(await t.slice(0, TILE_HEADER_BYTES).arrayBuffer()), t.size);
        const m = d.pools.patches[pid];
        if (rect.x !== m.x || rect.y !== m.y || rect.w !== m.w || rect.h !== m.h) throw new Error(`draft: fill ${pid} does not match its tile`);
        tiles.set(pid, new Uint8ClampedArray(await t.slice(TILE_HEADER_BYTES).arrayBuffer()));
      }
      const file = asFile(blob, d.info);
      draftId = id;
      draftCap = d.maxPixels;
      source = { id, file };
      sessionTiles.clear();
      // editor.resume() adopts these very objects, so its first schedule() finds
      // nothing new to write.
      written = { history: d.history, pools: d.pools, saved: d.savedRevision };
      try {
        await dropOtherDocs(id);
        await store.gc(draftKeys(id, d.tileIds));
      } catch (err) {
        report(err);
      }
      return { file, info: d.info, history: d.history, pools: d.pools, tiles, savedRevision: d.savedRevision, maxPixels: d.maxPixels };
    });
  }

  function discard() {
    clearTimeout(timer);
    timer = 0;
    // Keep the photo in mind only while it is still on screen (see write()).
    if (!source || docIdOf(editor()) !== source.id) source = null;
    draftId = null;
    draftCap = null;
    written = null;
    sessionTiles.clear();
    return track(queue(async () => {
      try {
        await store.setCurrent(null);
        await dropOtherDocs(null);
        await store.gc((k) => sessionTiles.has(k));
      } catch (err) {
        report(err);
      }
    }));
  }

  return {
    schedule() {
      clearTimeout(timer);
      timer = setTimeout(write, debounceMs);
    },
    flush() {
      try { write(); } catch (err) { report(err); }
      return Promise.all([...inflight, ops]).then(() => {});
    },
    startDraft,
    saveTile,
    loadDraft,
    discard,
    get available() { return store.available === true; },
    get persistent() { return store.persistent === true; },
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
