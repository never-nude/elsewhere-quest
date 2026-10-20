// STUB — owned by the persistence agent. Contract:
// openStore() -> Promise<Store>
// Store = {
//   available: boolean,          // false when IndexedDB is unavailable (Private Browsing, Lockdown): memory only
//   persistent: boolean,         // result of navigator.storage.persist()
//   putBlob(key, blob), getBlob(key) -> Blob|null, deleteBlob(key),
//   putDoc(id, record), getDoc(id) -> record|null, deleteDoc(id),
//   getCurrent() -> id|null, setCurrent(id|null),
//   blobKeys() -> string[], gc(keepKeys: Set<string>)
// }
// IndexedDB database 'gesso', stores 'blobs', 'docs', 'meta'; every read by primary key only (never an index).
export async function openStore() {
  const blobs = new Map(), docs = new Map();
  let current = null;
  return {
    available: false,
    persistent: false,
    async putBlob(k, b) { blobs.set(k, b); },
    async getBlob(k) { return blobs.get(k) ?? null; },
    async deleteBlob(k) { blobs.delete(k); },
    async putDoc(id, r) { docs.set(id, r); },
    async getDoc(id) { return docs.get(id) ?? null; },
    async deleteDoc(id) { docs.delete(id); },
    async getCurrent() { return current; },
    async setCurrent(id) { current = id; },
    async blobKeys() { return [...blobs.keys()]; },
    async gc(keep) { for (const k of [...blobs.keys()]) if (!keep.has(k)) blobs.delete(k); },
  };
}
