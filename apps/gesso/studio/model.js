// Project snapshots contain recipes and immutable pixel ids, never image bytes.
export const MAX_LAYERS = 8;
export const MAX_SIDE = 2048;
export const MIN_SCALE = 1 / 4096;
export const MAX_SCALE = 4096;
export const BLENDS = Object.freeze(['source-over', 'multiply', 'screen', 'overlay']);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
export const newId = (prefix = 's') => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;

export function freezeProject(project) {
  for (const layer of project.layers) {
    Object.freeze(layer.adjustments); Object.freeze(layer.shadow); Object.freeze(layer);
  }
  Object.freeze(project.layers);
  return Object.freeze(project);
}

export function createProject(name = 'Untitled', { id = newId('project'), width = 1200, height = 900 } = {}) {
  if (typeof id !== 'string' || !id || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) throw new Error('The canvas has invalid working dimensions.');
  return freezeProject({ version: 1, id, name: String(name || 'Untitled').slice(0, 100), width, height, layers: [], selectedId: null });
}

export function createImageLayer({ assetId, width, height, name = 'Photo', id = newId('layer'), x = width / 2, y = height / 2, scale = 1 } = {}) {
  if (typeof assetId !== 'string' || !assetId || typeof id !== 'string' || !id || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) throw new Error('The image has invalid working dimensions.');
  if (![x, y, scale].every(Number.isFinite) || scale <= 0) throw new Error('The image has an invalid transform.');
  return {
    id, name: String(name).slice(0, 100), kind: 'image', assetId, width, height, x, y, scale: clamp(scale, MIN_SCALE, MAX_SCALE),
    rotation: 0, opacity: 1, blend: 'source-over', visible: true,
    adjustments: { brightness: 1, contrast: 1, saturation: 1 },
    shadow: { blur: 0, opacity: 0, offsetX: 0, offsetY: 0 },
  };
}

export function patchLayer(project, id, patch) {
  const index = project.layers.findIndex((layer) => layer.id === id);
  if (index < 0) return project;
  const old = project.layers[index], next = { ...old };
  if (typeof patch.name === 'string') next.name = patch.name.slice(0, 100);
  for (const key of ['x', 'y', 'rotation']) if (Number.isFinite(patch[key])) next[key] = patch[key];
  if (Number.isFinite(patch.scale)) next.scale = clamp(patch.scale, MIN_SCALE, MAX_SCALE);
  if (Number.isFinite(patch.opacity)) next.opacity = clamp(patch.opacity, 0, 1);
  if (BLENDS.includes(patch.blend)) next.blend = patch.blend;
  if (typeof patch.visible === 'boolean') next.visible = patch.visible;
  if (Object.hasOwn(patch, 'maskId')) {
    if (typeof patch.maskId === 'string' && patch.maskId) next.maskId = patch.maskId;
    else if (patch.maskId == null) delete next.maskId;
  }
  if (patch.adjustments) {
    next.adjustments = { ...old.adjustments };
    for (const key of ['brightness', 'contrast', 'saturation']) {
      if (Number.isFinite(patch.adjustments[key])) next.adjustments[key] = clamp(patch.adjustments[key], 0, 3);
    }
  }
  if (patch.shadow) {
    next.shadow = { ...old.shadow };
    for (const key of ['blur', 'opacity', 'offsetX', 'offsetY']) {
      if (Number.isFinite(patch.shadow[key])) next.shadow[key] = clamp(patch.shadow[key], key === 'offsetX' || key === 'offsetY' ? -300 : 0, key === 'opacity' ? 1 : 300);
    }
  }
  if (JSON.stringify(old) === JSON.stringify(next)) return project;
  const layers = project.layers.slice(); layers[index] = next;
  return freezeProject({ ...project, layers });
}

export function addLayer(project, layer, { behind = false } = {}) {
  if (project.layers.length >= MAX_LAYERS) throw new Error('This project has 8 layers. Remove a layer before adding another photo.');
  if (project.layers.some((item) => item.id === layer.id)) throw new Error('This layer already exists.');
  const layers = behind ? [layer, ...project.layers] : [...project.layers, layer];
  return freezeProject({ ...project, layers, selectedId: layer.id });
}

export function selectLayer(project, id) {
  if (id !== null && !project.layers.some((layer) => layer.id === id)) return project;
  return project.selectedId === id ? project : freezeProject({ ...project, selectedId: id });
}

export function reorderLayer(project, id, direction) {
  const index = project.layers.findIndex((layer) => layer.id === id);
  const target = index + Math.sign(direction);
  if (index < 0 || target < 0 || target >= project.layers.length || target === index) return project;
  const layers = project.layers.slice();
  [layers[index], layers[target]] = [layers[target], layers[index]];
  return freezeProject({ ...project, layers });
}

export function duplicateLayer(project, id, { newLayerId = newId('layer') } = {}) {
  const layer = project.layers.find((item) => item.id === id);
  if (!layer) return project;
  if (project.layers.length >= MAX_LAYERS) throw new Error('This project has 8 layers. Remove a layer before duplicating.');
  const copy = { ...layer, id: newLayerId, name: `${layer.name} copy`.slice(0, 100), x: layer.x + 24, y: layer.y + 24 };
  const index = project.layers.indexOf(layer), layers = project.layers.slice();
  layers.splice(index + 1, 0, copy);
  return freezeProject({ ...project, layers, selectedId: copy.id });
}

export function removeLayer(project, id) {
  const index = project.layers.findIndex((layer) => layer.id === id);
  if (index < 0) return project;
  const layers = project.layers.filter((layer) => layer.id !== id);
  const selectedId = project.selectedId === id ? layers[Math.min(index, layers.length - 1)]?.id ?? null : project.selectedId;
  return freezeProject({ ...project, layers, selectedId });
}

// Image-local pixels (top left origin) -> project pixels, about the layer centre.
export function layerMatrix(layer) {
  const c = Math.cos(layer.rotation) * layer.scale, s = Math.sin(layer.rotation) * layer.scale;
  return [c, s, -s, c, layer.x - c * layer.width / 2 + s * layer.height / 2, layer.y - s * layer.width / 2 - c * layer.height / 2];
}
export function layerToCanvas(layer, x, y) {
  const [a, b, c, d, e, f] = layerMatrix(layer);
  return [a * x + c * y + e, b * x + d * y + f];
}
export function canvasToLayer(layer, x, y) {
  const dx = x - layer.x, dy = y - layer.y, c = Math.cos(layer.rotation), s = Math.sin(layer.rotation);
  return [(dx * c + dy * s) / layer.scale + layer.width / 2, (-dx * s + dy * c) / layer.scale + layer.height / 2];
}
export function hitLayer(layer, x, y) {
  const [sx, sy] = canvasToLayer(layer, x, y);
  return layer.visible && layer.opacity > 0 && sx >= 0 && sy >= 0 && sx <= layer.width && sy <= layer.height;
}

export function createHistory(project) { return { entries: [{ state: project, label: 'New project' }], index: 0 }; }
export function historyState(history) { return history.entries[history.index].state; }
export function recordHistory(history, project, label = 'Edit layer') {
  if (JSON.stringify(historyState(history)) === JSON.stringify(project)) return history;
  const entries = [...history.entries.slice(0, history.index + 1), { state: project, label: String(label).slice(0, 120) }].slice(-120);
  return { entries, index: entries.length - 1 };
}
export function travelHistory(history, direction) {
  const index = clamp(history.index + Math.sign(direction), 0, history.entries.length - 1);
  return index === history.index ? history : { ...history, index };
}

export function reviveProject(value) {
  if (!value || value.version !== 1 || typeof value.id !== 'string' || typeof value.name !== 'string' || !Array.isArray(value.layers) || value.layers.length > MAX_LAYERS ||
      !Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width < 1 || value.height < 1 || value.width > MAX_SIDE || value.height > MAX_SIDE) throw new Error('This project could not be opened.');
  let project = createProject(value.name, value);
  const ids = new Set();
  for (const raw of value.layers) {
    if (!raw || typeof raw.id !== 'string' || ids.has(raw.id) || typeof raw.assetId !== 'string' || raw.kind !== 'image' ||
        ![raw.x, raw.y, raw.scale, raw.rotation, raw.opacity].every(Number.isFinite) || raw.scale <= 0 || !BLENDS.includes(raw.blend)) throw new Error('A layer in this project is damaged.');
    ids.add(raw.id);
    project = addLayer(project, createImageLayer(raw));
    project = patchLayer(project, raw.id, { ...raw, adjustments: raw.adjustments, shadow: raw.shadow });
  }
  return selectLayer(project, ids.has(value.selectedId) ? value.selectedId : project.layers.at(-1)?.id ?? null);
}

export function combineAlpha(oldAlpha, selectedAlpha, combine = 'replace') {
  if (combine === 'replace') return selectedAlpha;
  if (combine === 'add') return Math.max(oldAlpha, selectedAlpha);
  if (combine === 'subtract') return Math.round(oldAlpha * (255 - selectedAlpha) / 255);
  throw new Error('Choose replace, add or subtract for the mask.');
}

// Fallback for engines without Canvas2D filters; alpha is never adjusted.
export function adjustPixels(data, { brightness = 1, contrast = 1, saturation = 1 } = {}) {
  if (brightness === 1 && contrast === 1 && saturation === 1) return data;
  for (let i = 0; i < data.length; i += 4) {
    const r = (data[i] * brightness - 127.5) * contrast + 127.5;
    const g = (data[i + 1] * brightness - 127.5) * contrast + 127.5;
    const b = (data[i + 2] * brightness - 127.5) * contrast + 127.5;
    const luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
    data[i] = clamp(Math.round(luma + (r - luma) * saturation), 0, 255);
    data[i + 1] = clamp(Math.round(luma + (g - luma) * saturation), 0, 255);
    data[i + 2] = clamp(Math.round(luma + (b - luma) * saturation), 0, 255);
  }
  return data;
}
