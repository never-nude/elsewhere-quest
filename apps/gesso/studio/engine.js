// The editor owns interaction and view transforms; this engine owns project
// recipes, immutable source/mask files and one reusable compositing surface.
import { readImageInfo, orientedDims, fitWorkingSize, sniffImageType } from '../lib/image-io.js';
import { isNative, decodeNative } from '../ui/platform.js';
import {
  MAX_SIDE, MAX_LAYERS, newId, createProject, createImageLayer, freezeProject,
  addLayer, patchLayer, selectLayer, reorderLayer, duplicateLayer, removeLayer,
  createHistory, historyState, recordHistory, travelHistory, reviveProject,
  combineAlpha, adjustPixels,
} from './model.js';

const DB_NAME = 'gesso-studio';
const canvas = (width = 1, height = 1) => {
  const value = document.createElement('canvas'); value.width = width; value.height = height;
  return value;
};
const releaseCanvas = (value) => { if (value) value.width = value.height = 0; };
const png = (value, type = 'image/png') => new Promise((resolve, reject) => {
  value.toBlob((blob) => blob ? resolve(blob) : reject(new Error('The image could not be prepared. Try a smaller photo.')), type, 0.94);
});
const cancelled = () => Object.assign(new Error('The project changed before this image was ready.'), { code: 'cancelled' });

async function pngNeedsManagedDecode(blob, header) {
  // iCCP precedes IDAT. Walk headers rather than reading whole metadata chunks;
  // a large text chunk must not conceal the profile or force a large allocation.
  let offset = 8, chunks = 0;
  while (offset + 12 <= blob.size && chunks++ < 4096) {
    const chunk = offset + 8 <= header.length ? header.subarray(offset, offset + 8) :
      new Uint8Array(await blob.slice(offset, offset + 8).arrayBuffer());
    if (chunk.length < 8) return true;
    const length = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength).getUint32(0);
    if (length > 0x7fffffff || offset + length + 12 > blob.size) return true;
    const name = String.fromCharCode(...chunk.subarray(4, 8));
    if (name === 'iCCP') return true;
    if (name === 'IDAT' || name === 'IEND') return false;
    offset += length + 12;
  }
  // If metadata is malformed or excessive, let the managed decoder validate it.
  return true;
}

async function decodeProxy(blob, target = null, { isMask = false } = {}) {
  let bitmap = null, image = null, url = null;
  try {
    let sourceBlob = blob;
    let header = new Uint8Array(await sourceBlob.slice(0, 256 * 1024).arrayBuffer());
    let type = sniffImageType(header);
    let profilePng = !isMask && type === 'png' && await pngNeedsManagedDecode(sourceBlob, header);
    if (!isMask && isNative && (type === 'jpeg' || type === 'heic' || profilePng)) {
      // ImageIO applies the source profile while decoding a bounded sRGB PNG.
      // The asset store still receives the untouched original Blob from addPhoto.
      sourceBlob = (await decodeNative(blob, { maxPixels: MAX_SIDE ** 2, maxSide: MAX_SIDE })).file;
      header = new Uint8Array(await sourceBlob.slice(0, 256 * 1024).arrayBuffer());
      type = sniffImageType(header);
      if (type !== 'png') throw new Error('This photo could not be prepared. Try another photo.');
      profilePng = await pngNeedsManagedDecode(sourceBlob, header);
    }
    let size = target;
    if (!size) {
      const info = readImageInfo(header);
      if (info) { const dims = orientedDims(info); size = fitWorkingSize(dims.w, dims.h, MAX_SIDE ** 2, MAX_SIDE); }
    }
    // WebKit's resized ImageBitmap path can corrupt profiled JPEG/PNG colors or
    // return a transparent image. HTMLImage applies those profiles correctly;
    // draw directly into the bounded working canvas, keeping source alpha.
    if ((isMask || (type !== 'jpeg' && !profilePng)) && typeof createImageBitmap === 'function') {
      try {
        bitmap = await createImageBitmap(sourceBlob, size ? { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'high' } : undefined);
        if (size && size.width !== size.height && Math.sign(bitmap.width - bitmap.height) !== Math.sign(size.width - size.height)) {
          bitmap.close(); bitmap = null;
          bitmap = await createImageBitmap(sourceBlob, { resizeWidth: size.height, resizeHeight: size.width, resizeQuality: 'high' });
        }
      } catch { bitmap?.close(); bitmap = null; }
    }
    if (!bitmap) {
      url = URL.createObjectURL(sourceBlob); image = new Image(); image.src = url;
      await image.decode();
    }
    const source = bitmap ?? image;
    const width = bitmap?.width ?? image.naturalWidth, height = bitmap?.height ?? image.naturalHeight;
    const fit = fitWorkingSize(width, height, MAX_SIDE ** 2, MAX_SIDE);
    const value = canvas(fit.width, fit.height);
    // No opaque strip or paper fill: a PNG cutout keeps its original alpha.
    value.getContext('2d').drawImage(source, 0, 0, fit.width, fit.height);
    return value;
  } finally { bitmap?.close(); if (image) image.src = ''; if (url) URL.revokeObjectURL(url); }
}

function memoryStore() {
  const tables = { projects: new Map(), assets: new Map(), masks: new Map() };
  return {
    persistent: false,
    async get(table, id) { return tables[table].get(id) ?? null; },
    async all(table) { return [...tables[table].values()]; },
    async put(table, value) { tables[table].set(value.id, structuredClone(value)); },
    async delete(table, id) { tables[table].delete(id); },
    async removeProject(id) {
      tables.projects.delete(id);
      for (const table of [tables.assets, tables.masks]) for (const [key, item] of table) if (item.projectId === id) table.delete(key);
    },
    close() {},
  };
}

async function openDatabase() {
  if (!globalThis.indexedDB) return memoryStore();
  let db;
  try {
    db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      let expired = false;
      const timer = setTimeout(() => { expired = true; reject(new Error('Project storage is unavailable.')); }, 3000);
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore('projects', { keyPath: 'id' });
        for (const name of ['assets', 'masks']) database.createObjectStore(name, { keyPath: 'id' }).createIndex('projectId', 'projectId');
      };
      request.onsuccess = () => { clearTimeout(timer); if (expired) request.result.close(); else resolve(request.result); };
      request.onerror = () => { clearTimeout(timer); reject(request.error); };
    });
  } catch { return memoryStore(); }
  db.onversionchange = () => db.close();
  let blobsAsBytes = false;
  function transaction(names, mode, work) {
    return new Promise((resolve, reject) => {
      let value, requestError = null;
      const tx = db.transaction(names, mode);
      tx.oncomplete = () => resolve(value && 'result' in value ? value.result ?? null : value ?? null);
      tx.onerror = tx.onabort = (event) => reject(event.target?.error ?? requestError ?? tx.error ?? new Error('This project could not be saved.'));
      try {
        value = work(tx);
        value?.addEventListener?.('error', () => { requestError = value.error; });
      } catch (err) { tx.abort(); reject(err); }
    });
  }
  return {
    persistent: true,
    async get(name, id) {
      const record = await transaction([name], 'readonly', (tx) => tx.objectStore(name).get(id));
      if (record?.blobBytes instanceof ArrayBuffer) {
        record.blob = new Blob([record.blobBytes], { type: record.blobType || 'application/octet-stream' });
        delete record.blobBytes; delete record.blobType;
      }
      return record;
    },
    all: (name) => transaction([name], 'readonly', (tx) => tx.objectStore(name).getAll()),
    async put(name, value) {
      if (!blobsAsBytes || !(value.blob instanceof Blob)) {
        try { return await transaction([name], 'readwrite', (tx) => tx.objectStore(name).put(value)); }
        catch (err) {
        // Some WebKit data stores reject Blob backing files while accepting the
        // same bytes. Keep the original byte-for-byte, without a base64 copy.
          if (!(value.blob instanceof Blob) || !['UnknownError', 'DataCloneError'].includes(err?.name)) throw err;
          blobsAsBytes = true;
        }
      }
      const { blob, ...metadata } = value;
      const fallback = { ...metadata, blobBytes: await blob.arrayBuffer(), blobType: blob.type };
      return transaction([name], 'readwrite', (tx) => tx.objectStore(name).put(fallback));
    },
    delete: (name, id) => transaction([name], 'readwrite', (tx) => tx.objectStore(name).delete(id)),
    removeProject: (id) => transaction(['projects', 'assets', 'masks'], 'readwrite', (tx) => {
      tx.objectStore('projects').delete(id);
      for (const name of ['assets', 'masks']) {
        const request = tx.objectStore(name).index('projectId').openCursor(id);
        request.onsuccess = () => { const cursor = request.result; if (cursor) { cursor.delete(); cursor.continue(); } };
      }
    }),
    close: () => db.close(),
  };
}

export async function createStudio({ onChange = () => {} } = {}) {
  const store = await openDatabase();
  const assets = new Map(), masks = new Map(), maskJobs = new Map();
  const scratch = canvas();
  const scratchContext = scratch.getContext('2d', { willReadFrequently: true });
  let project = null, history = null, gesture = null;
  let pendingHistory = null, restoration = null;
  let createdAt = 0, epoch = 0, disposed = false, saveTimer = 0;
  let writes = Promise.resolve(), imports = Promise.resolve();
  let error = store.persistent ? null : 'Project storage is unavailable. Keep this window open and export your work.';

  function changed() { if (!disposed) onChange(); }
  function report(err) { error = err?.message ?? 'This project could not be saved.'; changed(); }
  function write(work) {
    const pending = writes.then(work);
    writes = pending.catch(report);
    return pending;
  }
  function schedule() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = 0; void persist().catch(report); }, 250);
  }
  async function persist() {
    if (!project || disposed) return;
    // A timer from the preceding edit can fire during a drag. Only flush() may
    // commit a live preview; ordinary background writes keep the last snapshot.
    const snapshot = gesture ?? project;
    const record = { id: snapshot.id, project: snapshot, history, createdAt, updatedAt: Date.now() };
    await write(() => store.put('projects', record));
  }
  function clearCaches() {
    for (const value of assets.values()) releaseCanvas(value);
    for (const value of masks.values()) releaseCanvas(value);
    assets.clear(); masks.clear();
  }
  function prune() {
    const assetIds = new Set(project?.layers.map((layer) => layer.assetId));
    const maskIds = new Set(project?.layers.map((layer) => layer.maskId).filter(Boolean));
    for (const [id, value] of assets) if (!assetIds.has(id)) { releaseCanvas(value); assets.delete(id); }
    for (const [id, value] of masks) if (!maskIds.has(id)) { releaseCanvas(value); masks.delete(id); }
  }
  function discardResources(resources) {
    for (const [id, value] of resources.assets) if (assets.get(id) !== value) releaseCanvas(value);
    for (const [id, value] of resources.masks) if (masks.get(id) !== value) releaseCanvas(value);
  }
  async function stageResources(state, token) {
    const staged = { assets: new Map(), masks: new Map() };
    try {
      for (const layer of state.layers) {
        if (!staged.assets.has(layer.assetId)) {
          let value = assets.get(layer.assetId);
          if (!value) {
            const record = await store.get('assets', layer.assetId);
            if (!record?.blob || record.projectId !== state.id) throw new Error(`The original for “${layer.name}” is missing.`);
            value = await decodeProxy(record.blob, { width: layer.width, height: layer.height });
          }
          staged.assets.set(layer.assetId, value);
        }
        if (layer.maskId && !staged.masks.has(layer.maskId)) {
          let value = masks.get(layer.maskId);
          if (!value) {
            const record = await store.get('masks', layer.maskId);
            if (!record?.blob || record.projectId !== state.id) throw new Error(`The mask for “${layer.name}” is missing.`);
            value = await decodeProxy(record.blob, { width: layer.width, height: layer.height }, { isMask: true });
          }
          staged.masks.set(layer.maskId, value);
        }
        if (disposed || token !== epoch) throw cancelled();
      }
      if (disposed || token !== epoch) throw cancelled();
      return staged;
    } catch (err) { discardResources(staged); throw err; }
  }
  function acceptResources(staged) {
    for (const [id, value] of assets) if (staged.assets.get(id) !== value) releaseCanvas(value);
    for (const [id, value] of masks) if (staged.masks.get(id) !== value) releaseCanvas(value);
    assets.clear(); masks.clear();
    for (const [id, value] of staged.assets) assets.set(id, value);
    for (const [id, value] of staged.masks) masks.set(id, value);
  }
  function stopTravel() {
    if (pendingHistory) { epoch++; pendingHistory = null; }
  }
  function apply(next, { commit = true, label = 'Edit layer' } = {}) {
    if (!project || next === project) return;
    stopTravel();
    if (!commit && !gesture) gesture = project;
    project = next;
    if (commit) { history = recordHistory(history, project, label); gesture = null; prune(); schedule(); }
    changed();
  }
  function selected() { return project?.layers.find((layer) => layer.id === project.selectedId) ?? null; }

  function render(context, { maskOverride = null } = {}) {
    if (!project || disposed) return;
    context.save();
    context.beginPath(); context.rect(0, 0, project.width, project.height); context.clip();
    for (const layer of project.layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      const image = assets.get(layer.assetId);
      if (!image) continue;
      const mask = maskOverride?.layerId === layer.id ? maskOverride.canvas : layer.maskId ? masks.get(layer.maskId) : null;
      // A missing mask must never accidentally reveal the complete source.
      if (layer.maskId && !mask) continue;
      if (scratch.width !== layer.width || scratch.height !== layer.height) { scratch.width = layer.width; scratch.height = layer.height; }
      scratchContext.save();
      scratchContext.setTransform(1, 0, 0, 1, 0, 0);
      scratchContext.globalAlpha = 1; scratchContext.globalCompositeOperation = 'source-over';
      scratchContext.clearRect(0, 0, scratch.width, scratch.height);
      const a = layer.adjustments;
      const adjusted = a.brightness !== 1 || a.contrast !== 1 || a.saturation !== 1;
      const filters = typeof scratchContext.filter === 'string';
      if (filters) scratchContext.filter = adjusted ? `brightness(${a.brightness}) contrast(${a.contrast}) saturate(${a.saturation})` : 'none';
      scratchContext.drawImage(image, 0, 0, layer.width, layer.height);
      if (filters) scratchContext.filter = 'none';
      else if (adjusted) {
        const pixels = scratchContext.getImageData(0, 0, scratch.width, scratch.height);
        adjustPixels(pixels.data, a); scratchContext.putImageData(pixels, 0, 0);
      }
      if (mask) {
        scratchContext.globalCompositeOperation = 'destination-in';
        scratchContext.drawImage(mask, 0, 0, layer.width, layer.height);
      }
      scratchContext.restore();
      context.save();
      context.translate(layer.x, layer.y); context.rotate(layer.rotation); context.scale(layer.scale, layer.scale);
      context.globalAlpha *= layer.opacity; context.globalCompositeOperation = layer.blend;
      context.shadowColor = 'transparent'; context.shadowBlur = context.shadowOffsetX = context.shadowOffsetY = 0;
      if (layer.shadow.opacity > 0) {
        const matrix = context.getTransform(), shadow = layer.shadow;
        context.shadowColor = `rgba(0,0,0,${shadow.opacity})`;
        context.shadowBlur = shadow.blur * Math.hypot(matrix.a, matrix.b);
        context.shadowOffsetX = matrix.a * shadow.offsetX + matrix.c * shadow.offsetY;
        context.shadowOffsetY = matrix.b * shadow.offsetX + matrix.d * shadow.offsetY;
      }
      context.drawImage(scratch, -layer.width / 2, -layer.height / 2);
      context.restore();
    }
    context.restore();
  }

  async function travel(direction) {
    if (!history || disposed) return;
    if (gesture) { project = gesture; gesture = null; }
    const base = pendingHistory ?? history;
    const next = travelHistory(base, direction);
    if (next === base) {
      changed();
      // A boundary tap must keep flush/export waiting for the active restore.
      // undo/redo assigns this call's promise only after travel() returns it.
      if (pendingHistory && restoration) await restoration;
      return;
    }
    pendingHistory = next;
    const target = historyState(next), token = ++epoch;
    try {
      const resources = await stageResources(target, token);
      if (disposed || token !== epoch) { discardResources(resources); return; }
      acceptResources(resources);
      project = target; history = next; pendingHistory = null; schedule(); changed();
    } catch (err) {
      if (token === epoch) pendingHistory = null;
      if (err.code !== 'cancelled') report(err);
    }
  }

  const engine = {
    get project() { return project; },
    get selected() { return selected(); },
    get canUndo() { const h = pendingHistory ?? history; return !!h && h.index > 0; },
    get canRedo() { const h = pendingHistory ?? history; return !!h && h.index < h.entries.length - 1; },
    get busy() { return pendingHistory !== null; },
    get persistent() { return store.persistent; },
    get error() { return error; },
    async newProject(name = 'Untitled') {
      await engine.flush(); epoch++; clearCaches();
      project = createProject(name); history = createHistory(project); gesture = null; createdAt = Date.now();
      schedule(); changed(); return project;
    },
    addPhoto(file, { behind = false } = {}) {
      const requestedId = project?.id, requestedEpoch = epoch;
      const pending = imports.catch(() => {}).then(async () => {
        if (disposed || (requestedId && (project?.id !== requestedId || epoch !== requestedEpoch))) throw cancelled();
        if (!project) await engine.newProject(file.name?.replace(/\.[^.]+$/, '') || 'Untitled');
        if (project.layers.length >= MAX_LAYERS) throw new Error('This project has 8 layers. Remove a layer before adding another photo.');
        const owner = project.id, token = epoch;
        const image = await decodeProxy(file);
        if (disposed || token !== epoch || project?.id !== owner) { releaseCanvas(image); throw cancelled(); }
        if (project.layers.length >= MAX_LAYERS) { releaseCanvas(image); throw new Error('This project has 8 layers. Remove a layer before adding another photo.'); }
        const assetId = newId('asset');
        try { await write(() => store.put('assets', { id: assetId, projectId: owner, blob: file, width: image.width, height: image.height })); }
        catch (err) { releaseCanvas(image); throw err; }
        if (disposed || token !== epoch || project?.id !== owner) { releaseCanvas(image); await write(() => store.delete('assets', assetId)); throw cancelled(); }
        assets.set(assetId, image);
        let base = project;
        if (!base.layers.length) base = freezeProject({ ...base, width: image.width, height: image.height });
        const fit = (behind ? Math.max : Math.min)(base.width / image.width, base.height / image.height);
        const layer = createImageLayer({ assetId, width: image.width, height: image.height, name: file.name?.replace(/\.[^.]+$/, '') || 'Photo', x: base.width / 2, y: base.height / 2, scale: fit });
        try { apply(addLayer(base, layer, { behind }), { label: behind ? 'Add background photo' : 'Add photo' }); }
        catch (err) { assets.delete(assetId); releaseCanvas(image); await write(() => store.delete('assets', assetId)); throw err; }
        return layer;
      });
      imports = pending.catch(() => {});
      return pending;
    },
    async projects() {
      await engine.flush();
      return (await store.all('projects')).map((record) => ({ id: record.id, name: record.project.name, width: record.project.width, height: record.project.height, layerCount: record.project.layers.length, createdAt: record.createdAt, updatedAt: record.updatedAt })).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async open(id) {
      await engine.flush();
      const token = ++epoch;
      const record = await store.get('projects', id);
      if (!record) throw new Error('This project no longer exists.');
      const target = reviveProject(record.project);
      let restored = createHistory(target);
      if (Array.isArray(record.history?.entries) && Number.isInteger(record.history.index) && record.history.index >= 0 && record.history.index < record.history.entries.length && record.history.entries.length <= 120) {
        restored = { entries: record.history.entries.map((entry) => ({ state: reviveProject(entry.state), label: String(entry.label).slice(0, 120) })), index: record.history.index };
        if (restored.entries.some((entry) => entry.state.id !== target.id)) throw new Error('This project history is damaged.');
      }
      const resources = await stageResources(target, token);
      if (disposed || token !== epoch) { discardResources(resources); return; }
      acceptResources(resources);
      project = target; history = restored; gesture = null; createdAt = record.createdAt || Date.now();
      changed(); return project;
    },
    async removeProject(id) {
      await engine.flush();
      epoch++; // a pending open must not resurrect the project being removed
      if (project?.id === id) { project = null; history = null; gesture = null; clearCaches(); changed(); }
      await write(() => store.removeProject(id));
    },
    select(id) {
      if (!project) return;
      stopTravel();
      const next = selectLayer(project, id);
      if (next === project) return;
      project = next;
      if (!gesture) {
        const entries = history.entries.slice(); entries[history.index] = { ...entries[history.index], state: project };
        history = { ...history, entries };
      }
      schedule(); changed();
    },
    updateLayer(id, patch, options) { if (project) apply(patchLayer(project, id, patch), options); },
    begin() { stopTravel(); if (project && !gesture) gesture = project; },
    commit(label = 'Edit layer') {
      if (!gesture) return;
      gesture = null; history = recordHistory(history, project, label); prune(); schedule(); changed();
    },
    cancel() {
      if (!gesture) return;
      project = gesture; gesture = null; prune(); changed();
    },
    undo: () => (restoration = travel(-1)), redo: () => (restoration = travel(1)),
    reorder(id, direction) { if (project) apply(reorderLayer(project, id, direction), { label: direction > 0 ? 'Bring forward' : 'Send backward' }); },
    duplicate(id) { if (project) apply(duplicateLayer(project, id), { label: 'Duplicate layer' }); },
    remove(id) { if (project) { maskJobs.delete(id); apply(removeLayer(project, id), { label: 'Remove layer' }); } },
    getLayerImage(id) { const layer = project?.layers.find((item) => item.id === id); return layer ? assets.get(layer.assetId) ?? null : null; },
    getMask(id) { const layer = project?.layers.find((item) => item.id === id); return layer?.maskId ? masks.get(layer.maskId) ?? null : null; },
    async setMask(id, source, { combine = 'replace' } = {}) {
      if (!['replace', 'add', 'subtract'].includes(combine)) throw new Error('Choose replace, add or subtract for the mask.');
      const layer = project?.layers.find((item) => item.id === id);
      if (!layer) return;
      const owner = project.id, token = epoch, job = Symbol('mask'); maskJobs.set(id, job);
      const result = canvas(layer.width, layer.height), ctx = result.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(source, 0, 0, result.width, result.height);
      if (combine !== 'replace') {
        const old = layer.maskId ? masks.get(layer.maskId) : null;
        if (layer.maskId && !old) { releaseCanvas(result); throw new Error('Wait for this mask to finish opening.'); }
        const before = old?.getContext('2d').getImageData(0, 0, old.width, old.height).data;
        const pixels = ctx.getImageData(0, 0, result.width, result.height);
        for (let i = 0; i < pixels.data.length; i += 4) {
          pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 255;
          pixels.data[i + 3] = combineAlpha(before ? before[i + 3] : 255, pixels.data[i + 3], combine);
        }
        ctx.putImageData(pixels, 0, 0);
      } else {
        ctx.globalCompositeOperation = 'source-in'; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, result.width, result.height);
      }
      let retained = false;
      const maskId = newId('mask');
      const fresh = () => !disposed && epoch === token && project?.id === owner && maskJobs.get(id) === job && project.layers.some((item) => item.id === id && item.assetId === layer.assetId && item.maskId === layer.maskId);
      try {
        const blob = await png(result);
        if (!fresh()) throw cancelled();
        await write(() => store.put('masks', { id: maskId, projectId: owner, blob, width: result.width, height: result.height }));
        if (!fresh()) { await write(() => store.delete('masks', maskId)); throw cancelled(); }
        masks.set(maskId, result); retained = true;
        apply(patchLayer(project, id, { maskId }), { label: combine === 'subtract' ? 'Hide selected area' : combine === 'add' ? 'Reveal selected area' : 'Mask layer' });
      } finally { if (!retained) releaseCanvas(result); if (maskJobs.get(id) === job) maskJobs.delete(id); }
    },
    clearMask(id) { if (project) { maskJobs.delete(id); apply(patchLayer(project, id, { maskId: null }), { label: 'Restore full image' }); } },
    render,
    async exportImage({ type = 'image/png' } = {}) {
      if (restoration) await restoration;
      if (!project?.layers.length) throw new Error('Add a photo before exporting this canvas.');
      if (!['image/png', 'image/jpeg'].includes(type)) throw new Error('Choose PNG or JPEG for this export.');
      const output = canvas(project.width, project.height), ctx = output.getContext('2d');
      try {
        if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, output.width, output.height); }
        render(ctx); return await png(output, type);
      } finally { releaseCanvas(output); }
    },
    async flush() {
      if (restoration) await restoration;
      clearTimeout(saveTimer); saveTimer = 0;
      if (gesture) engine.commit('Edit layer');
      clearTimeout(saveTimer); saveTimer = 0;
      await persist(); await writes;
    },
    dispose() {
      if (disposed) return;
      clearTimeout(saveTimer); saveTimer = 0;
      // Flush before dispose when the caller needs a durability guarantee.
      void persist().catch(() => {}).finally(() => store.close());
      disposed = true; epoch++; clearCaches(); releaseCanvas(scratch);
    },
  };
  return engine;
}
