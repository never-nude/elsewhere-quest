// STUB — owned by the persistence agent. Contract:
// createAutosave(store, getEditor, { debounceMs = 300 }) -> {
//   schedule()                    called by the editor after every committed step: debounce a draft write
//   flush()                       write now (visibility hidden / pagehide), best effort
//   startDraft(id, file)          a new photo: store the original File/Blob as 'source:<id>', set current
//   saveTile(id, rgba, meta)      a Remove fill tile: write 'tile:<id>' BEFORE the history entry that references it
//   loadDraft() -> null | { file, info, history, pools, tiles: Map<id, Uint8ClampedArray>, savedRevision: boolean, maxPixels }
//   discard()                     forget the current draft and its blobs
// }
// The editor exposes ed.serialize() -> { history, pools, savedRevision } and ed.sourceInfo.
export function createAutosave() {
  return {
    schedule() {},
    flush() {},
    async startDraft() {},
    async saveTile() {},
    async loadDraft() { return null; },
    discard() {},
  };
}
