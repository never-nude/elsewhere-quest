import { createStudio } from './engine.js';
import { buildCostMap, createLasso, polygonArea } from '../lib/lasso.js';
import * as platform from '../ui/platform.js';

const $ = (selector) => document.querySelector(selector);
const canvas = $('#artwork'), stage = $('#stage'), context = $('#context');
const ctx = canvas.getContext('2d');
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const MIN_SCALE = 1 / 4096, MAX_SCALE = 4096;
const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
const copyCanvas = (source, width = source.width, height = source.height) => {
  const target = document.createElement('canvas'); target.width = width; target.height = height;
  target.getContext('2d').drawImage(source, 0, 0, width, height); return target;
};
let engine, mode = 'move', selectMode = 'outline', target = 'image';
let view = { x: 0, y: 0, zoom: 1 }, size = { width: 1, height: 1 }, fittedProject = null;
let trace = null, selection = null, brushPreview = null, gesture = null;
let previewSelection = false, feather = 0, brushSize = 38, brushKind = 'hide';
let busy = false, drawFrame = 0, toastTimer = 0, subjectGeneration = 0;
let behind = false, startNew = false, exportFormat = 'jpeg', exportBlobs = null, exportSession = 0;
let exportBusy = false, exportActionToken = 0, exportSnapshot = null;
const pointers = new Map();
let propertyGesture = null, deletingProject = null;
let lastEngineError = null;
const locked = () => busy || exportBusy || !!engine?.busy;

function notify(message, milliseconds = 2800) {
  const el = $('#toast'); el.textContent = message; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, milliseconds);
}
async function work(label, operation) {
  if (locked()) return;
  finishProperty('Adjust layer');
  busy = true; $('#busy-label').textContent = label; $('#busy').hidden = false;
  refresh();
  try { return await operation(); }
  catch (error) { if (error?.code !== 'cancelled') { console.warn('Studio:', error); notify(error?.message || 'That didn’t work. Please try again.', 4500); } }
  finally { busy = false; $('#busy').hidden = true; refresh(); }
}
function requestDraw() { if (!drawFrame) drawFrame = requestAnimationFrame(draw); }
function sourcePoint(layer, point) {
  const dx = point.x - layer.x, dy = point.y - layer.y, c = Math.cos(layer.rotation), s = Math.sin(layer.rotation);
  return { x: (c * dx + s * dy) / layer.scale + layer.width / 2, y: (-s * dx + c * dy) / layer.scale + layer.height / 2 };
}
function canvasPoint(layer, point) {
  const x = (point.x - layer.width / 2) * layer.scale, y = (point.y - layer.height / 2) * layer.scale;
  const c = Math.cos(layer.rotation), s = Math.sin(layer.rotation);
  return { x: layer.x + c * x - s * y, y: layer.y + s * x + c * y };
}
const screenPoint = (point) => ({ x: view.x + point.x * view.zoom, y: view.y + point.y * view.zoom });
const documentPoint = (point) => ({ x: (point.x - view.x) / view.zoom, y: (point.y - view.y) / view.zoom });
function eventPoint(event) { const r = canvas.getBoundingClientRect(); return { x: event.clientX - r.left, y: event.clientY - r.top }; }
function inLayer(layer, point) { const p = sourcePoint(layer, point); return p.x >= 0 && p.y >= 0 && p.x < layer.width && p.y < layer.height; }
function visibleAt(layer, point) {
  if (!layer.visible || layer.opacity <= 0 || !inLayer(layer, point)) return false;
  const local = sourcePoint(layer, point), x = Math.floor(local.x), y = Math.floor(local.y);
  const image = engine.getLayerImage(layer.id), mask = engine.getMask(layer.id);
  if (!image || (layer.maskId && !mask)) return false;
  const sourceAlpha = image.getContext('2d').getImageData(x, y, 1, 1).data[3];
  const maskAlpha = mask ? mask.getContext('2d').getImageData(x, y, 1, 1).data[3] : 255;
  return sourceAlpha * maskAlpha / 255 * layer.opacity >= 8;
}
function hitLayer(point) { return engine.project.layers.slice().reverse().find((layer) => visibleAt(layer, point)); }
const layerCorners = (layer) => [{ x: 0, y: 0 }, { x: layer.width, y: 0 }, { x: layer.width, y: layer.height }, { x: 0, y: layer.height }].map((point) => canvasPoint(layer, point));
function cornerAt(layer, point) {
  if (!layer?.visible || layer.opacity <= 0) return null;
  let nearest = null, distance = 23;
  for (const corner of layerCorners(layer)) {
    const screen = screenPoint(corner), d = Math.hypot(screen.x - point.x, screen.y - point.y);
    if (d < distance) { distance = d; nearest = corner; }
  }
  return nearest;
}

function fit() {
  const project = engine?.project; if (!project) return;
  const zoom = Math.min((size.width - 32) / project.width, (size.height - (project.layers.length ? 115 : 30)) / project.height);
  view = { zoom: Math.max(.025, zoom), x: (size.width - project.width * zoom) / 2, y: Math.max(38, (size.height - project.height * zoom - 85) / 2) };
  requestDraw();
}
function resize() {
  const r = stage.getBoundingClientRect(); size = { width: r.width, height: r.height };
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
  if (engine) fit(); else requestDraw();
}
new ResizeObserver(resize).observe(stage);

function draw() {
  drawFrame = 0;
  const dpr = canvas.width / Math.max(1, size.width);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, size.width, size.height);
  if (!engine?.project?.layers.length) return;
  const project = engine.project;
  ctx.save(); ctx.translate(view.x, view.y); ctx.scale(view.zoom, view.zoom);
  ctx.fillStyle = '#e7e3da'; ctx.fillRect(0, 0, project.width, project.height);
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, project.width, project.height); ctx.clip();
  const tile = 12 / view.zoom;
  ctx.fillStyle = '#d7d3cb';
  const startX = Math.max(0, Math.floor(-view.x / view.zoom / tile) * tile), endX = Math.min(project.width, (size.width - view.x) / view.zoom);
  const startY = Math.max(0, Math.floor(-view.y / view.zoom / tile) * tile), endY = Math.min(project.height, (size.height - view.y) / view.zoom);
  for (let y = startY; y < endY; y += tile) for (let x = startX; x < endX; x += tile) if ((Math.round(x / tile) + Math.round(y / tile)) % 2 === 0) ctx.fillRect(x, y, tile, tile);
  const selecting = mode === 'select' && selectMode !== 'brush';
  let override = mode === 'select' && selectMode === 'brush' ? brushPreview : null;
  if (!override && selecting && previewSelection && selection) override = { layerId: selection.layerId, canvas: featheredSelection() };
  engine.render(ctx, override ? { maskOverride: override } : {});
  ctx.restore();
  ctx.lineWidth = 1 / view.zoom; ctx.strokeStyle = '#ffffff17'; ctx.strokeRect(0, 0, project.width, project.height);
  const layer = engine.selected;
  if (layer?.visible) {
    if (selecting && selection && !previewSelection && selection.layerId === layer.id) drawSelection(layer);
    if (mode === 'select' && selectMode === 'outline' && trace && trace.layerId === layer.id) drawOutline(layer);
    if (mode === 'move') drawBounds(layer);
  }
  ctx.restore();
}
function withLayer(layer, paint) {
  ctx.save(); ctx.translate(layer.x, layer.y); ctx.rotate(layer.rotation); ctx.scale(layer.scale, layer.scale); ctx.translate(-layer.width / 2, -layer.height / 2);
  paint(); ctx.restore();
}
function drawSelection(layer) {
  const mask = featheredSelection();
  let tint = selection.tint;
  if (!tint) {
    tint = selection.tint = copyCanvas(mask); const tctx = tint.getContext('2d');
    tctx.globalCompositeOperation = 'source-in'; tctx.fillStyle = '#e4b994'; tctx.fillRect(0, 0, tint.width, tint.height);
  }
  withLayer(layer, () => { ctx.globalAlpha = .4; ctx.drawImage(tint, 0, 0, layer.width, layer.height); });
}
function drawOutline(layer) {
  const path = trace.lasso.path(); if (!path.length) return;
  const points = [];
  for (let i = 0; i < path.length; i += 2) points.push(canvasPoint(layer, { x: path[i] / trace.kx, y: path[i + 1] / trace.ky }));
  ctx.save(); ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y); for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
  ctx.lineWidth = 4 / view.zoom; ctx.strokeStyle = '#171614a6'; ctx.stroke();
  ctx.lineWidth = 1.7 / view.zoom; ctx.strokeStyle = '#f5dfbf'; ctx.stroke();
  for (const point of [points[0], points.at(-1)]) { ctx.beginPath(); ctx.arc(point.x, point.y, 4 / view.zoom, 0, Math.PI * 2); ctx.fillStyle = '#e4c7a2'; ctx.fill(); ctx.strokeStyle = '#29231b'; ctx.lineWidth = 1 / view.zoom; ctx.stroke(); }
  ctx.restore();
}
function drawBounds(layer) {
  const corners = layerCorners(layer);
  ctx.save(); ctx.strokeStyle = '#e4c7a2a6'; ctx.lineWidth = 1 / view.zoom; ctx.setLineDash([4 / view.zoom, 4 / view.zoom]);
  ctx.beginPath(); ctx.moveTo(corners[0].x, corners[0].y); for (const p of corners.slice(1)) ctx.lineTo(p.x, p.y); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
  for (const p of corners) { ctx.fillStyle = '#e4c7a2'; ctx.fillRect(p.x - 3 / view.zoom, p.y - 3 / view.zoom, 6 / view.zoom, 6 / view.zoom); }
  ctx.restore();
}

function clearDraft({ redraw = true } = {}) {
  if (gesture?.kind === 'move' || gesture?.kind === 'resize') engine?.cancel();
  gesture = null;
  subjectGeneration++; trace?.lasso.cancel(); trace = null; selection = null; brushPreview = null; previewSelection = false;
  $('#magnifier').hidden = true;
  if (redraw) { renderContext(); requestDraw(); }
}
function pauseInteraction() {
  if (gesture?.kind === 'move' || gesture?.kind === 'resize') engine.cancel();
  cancelOutlineStroke(gesture); gesture = null; brushPreview = null;
  if (trace) { trace.paused = true; trace.awaiting = false; }
  $('#magnifier').hidden = true;
}
function setMode(next, { mask = false } = {}) {
  if (locked() || !engine?.project?.layers.length) return;
  finishProperty('Adjust layer');
  if (next !== mode) { subjectGeneration++; pauseInteraction(); }
  mode = next;
  if (mask) { selectMode = 'brush'; target = 'mask'; }
  else if (next === 'move') target = 'image';
  else if (next === 'select') target = selectMode === 'brush' ? 'mask' : 'image';
  renderContext(); refresh();
}
function selectLayer(id, which = 'image') {
  if (locked()) return;
  finishProperty('Adjust layer');
  if (engine.selected?.id !== id) clearDraft({ redraw: false });
  else if (target !== which || (which === 'image' && mode !== 'move')) { subjectGeneration++; pauseInteraction(); }
  engine.select(id); target = which;
  if (which === 'mask') { mode = 'select'; selectMode = 'brush'; }
  else mode = 'move';
  renderContext(); renderLayers(); refresh();
}

function smallButton(text, className, action) {
  const button = node('button', className, text); button.type = 'button'; button.disabled = locked();
  button.addEventListener('click', (event) => { if (!locked()) return action(event); }); return button;
}
function control(parent, { id, label, min, max, step = 1, value, format = (v) => `${Math.round(v)}`, change, finish }) {
  const row = node('div', 'control'), title = node('label', '', label), input = node('input'), output = node('output');
  title.htmlFor = id; input.type = 'range'; input.id = id; input.min = min; input.max = max; input.step = step; input.value = value;
  output.htmlFor = id; output.textContent = format(Number(value));
  input.disabled = locked();
  input.addEventListener('input', () => { if (!locked()) { output.textContent = format(Number(input.value)); change?.(Number(input.value)); } });
  input.addEventListener('change', () => { if (!locked()) finish?.(); }); row.append(title, input, output); parent.append(row); return input;
}
function propertyPreview(key, patch, label) {
  if (locked()) return;
  const layer = engine.selected; if (!layer) return;
  if (propertyGesture !== key) { if (propertyGesture) engine.commit('Adjust layer'); engine.begin(); propertyGesture = key; }
  engine.updateLayer(layer.id, patch, { commit: false, label }); requestDraw();
}
function finishProperty(label) { if (!propertyGesture) return; propertyGesture = null; engine.commit(label); refresh(); }

function renderContext() {
  context.replaceChildren();
  const layer = engine?.selected;
  context.hidden = !layer;
  if (!layer) return;
  const head = node('div', 'context-heading');
  head.append(node('span', 'context-title', mode === 'move' ? 'Move your layer' : selectMode === 'brush' ? 'Refine the mask' : 'Select what stays'));
  const pendingSelection = mode === 'select' && selectMode !== 'brush' && (trace || selection);
  const finish = smallButton(pendingSelection ? 'Discard' : 'Finish', 'subtle-button', () => {
    finishProperty('Adjust layer');
    if (pendingSelection) clearDraft(); else { subjectGeneration++; pauseInteraction(); }
    context.hidden = true; mode = 'view'; refresh();
  });
  head.append(finish); context.append(head);
  if (mode === 'view') { context.hidden = true; return; }
  if (mode === 'move') {
    const fitScale = Math.min(engine.project.width / layer.width, engine.project.height / layer.height), relativeSize = layer.scale / fitScale * 100;
    const minimum = Math.min(relativeSize, Math.max(1, MIN_SCALE / fitScale * 100)), maximum = Math.max(relativeSize, Math.min(300, MAX_SCALE / fitScale * 100));
    control(context, { id: 'move-size', label: 'Size', min: minimum, max: maximum, step: .1, value: relativeSize, format: (v) => `${Number(v.toFixed(v < 10 ? 1 : 0))}% fit`, change: (v) => propertyPreview('scale', { scale: fitScale * v / 100 }, 'Resize layer'), finish: () => finishProperty('Resize layer') });
    control(context, { id: 'move-rotation', label: 'Rotate', min: -180, max: 180, value: layer.rotation * 180 / Math.PI, format: (v) => `${Math.round(v)}°`, change: (v) => propertyPreview('rotate', { rotation: v * Math.PI / 180 }, 'Rotate layer'), finish: () => finishProperty('Rotate layer') });
    context.append(node('p', 'context-note', '100% fits the canvas. Drag a corner to resize and rotate. Two fingers move the canvas.'));
    return;
  }
  const tabs = node('div', 'mode-tabs');
  for (const [id, label] of [['outline', 'Outline'], ...(platform.subjectMatteAvailable?.() ? [['subject', 'Subject']] : []), ['brush', 'Mask brush']]) {
    const button = smallButton(label, '', () => { if (id !== selectMode) { subjectGeneration++; pauseInteraction(); } selectMode = id; target = id === 'brush' ? 'mask' : 'image'; renderContext(); refresh(); });
    button.setAttribute('aria-pressed', selectMode === id ? 'true' : 'false'); tabs.append(button);
  }
  context.append(tabs);
  if (selectMode === 'brush') {
    const brushTabs = node('div', 'actions');
    for (const [id, label] of [['hide', 'Hide'], ['reveal', 'Reveal']]) {
      const button = smallButton(label, brushKind === id ? 'keep' : 'quiet', () => { brushKind = id; renderContext(); }); button.setAttribute('aria-pressed', brushKind === id ? 'true' : 'false'); brushTabs.append(button);
    }
    context.append(brushTabs);
    control(context, { id: 'brush-size', label: 'Brush', min: 8, max: 100, value: brushSize, format: (v) => `${Math.round(v)} pt`, change: (v) => { brushSize = v; } });
    context.append(node('p', 'context-note', 'Paint softly to hide or restore. Your original is always underneath.'));
    return;
  }
  if (trace) {
    const actions = node('div', 'actions');
    if (trace.paused) actions.append(smallButton('Resume', 'quiet', () => { trace.paused = false; trace.awaiting = true; renderContext(); notify('Touch the outline’s end and keep tracing.'); }));
    actions.append(smallButton('Close outline', 'keep', closeOutline), smallButton('Clear', 'quiet', () => clearDraft())); context.append(actions);
    context.append(node('p', 'context-note', trace.paused ? 'Paused. Lift your thumb, move the canvas, then continue. Close it when you’re ready.' : trace.awaiting ? 'Touch to continue from the last point. Two fingers move the canvas.' : 'Follow the edge. Lift your thumb to pause; the outline stays.'));
  } else if (selection) {
    const actions = node('div', 'actions');
    actions.append(smallButton('Keep selected', 'keep', () => applySelection('replace')), smallButton('Hide selected', 'quiet', () => applySelection('subtract')), smallButton('Clear', 'quiet', () => clearDraft())); context.append(actions);
    const preview = node('div', 'context-heading'); preview.style.marginTop = '8px'; preview.style.marginBottom = '0';
    preview.append(node('span', 'context-note', 'Selection is a preview until you choose Keep or Hide.'));
    preview.append(smallButton(previewSelection ? 'Show selection' : 'Preview cutout', 'subtle-button', () => { previewSelection = !previewSelection; renderContext(); requestDraw(); })); context.append(preview);
    control(context, { id: 'edge-feather', label: 'Soften edge', min: 0, max: 8, step: .25, value: feather, format: (v) => `${v.toFixed(1)} px`, change: (v) => { feather = v; selection.feathered = null; selection.tint = null; requestDraw(); } });
  } else {
    context.append(node('p', 'context-note', selectMode === 'subject' ? 'Tap the person or object to make a soft selection. You can repair its mask afterward.' : 'Trace an edge. Lift to pause and reposition. Close the outline yourself; nothing is cut yet.'));
  }
}

function analysis(layer) {
  const image = engine.getLayerImage(layer.id);
  if (!image) throw new Error('This layer’s photo is not available.');
  const scale = Math.min(1, 1024 / Math.max(layer.width, layer.height));
  const imageCanvas = copyCanvas(image, Math.max(3, Math.round(layer.width * scale)), Math.max(3, Math.round(layer.height * scale)));
  return { imageCanvas, kx: imageCanvas.width / layer.width, ky: imageCanvas.height / layer.height };
}
function beginOutline(layer, point) {
  if (selection) selection = null;
  if (!trace || trace.layerId !== layer.id) {
    const { imageCanvas, kx, ky } = analysis(layer);
    const map = buildCostMap(imageCanvas.getContext('2d').getImageData(0, 0, imageCanvas.width, imageCanvas.height));
    const radius = clamp(15 / (view.zoom * layer.scale) * kx, 4, 35);
    trace = { layerId: layer.id, lasso: createLasso(map, { snapRadius: radius, anchorSpacing: 18 }), map, kx, ky, radius, segments: [], paused: false, awaiting: false, imageCanvas };
    const p = { x: point.x * kx, y: point.y * ky };
    trace.lasso.begin(p); trace.segments.push([p]);
  } else {
    trace.paused = false; trace.awaiting = false; trace.segments.push([]);
    extendOutline(point);
  }
  renderContext(); requestDraw();
}
function extendOutline(point) {
  if (!trace) return;
  const p = { x: point.x * trace.kx, y: point.y * trace.ky }, path = trace.lasso.path();
  const previous = path.length ? { x: path.at(-2), y: path.at(-1) } : p;
  const count = Math.max(1, Math.ceil(Math.hypot(p.x - previous.x, p.y - previous.y) / 10));
  const segment = trace.segments.at(-1);
  // Small increments keep a resumed thumb from asking for one huge search corridor.
  for (let i = 1; i <= count; i++) {
    const next = { x: previous.x + (p.x - previous.x) * i / count, y: previous.y + (p.y - previous.y) * i / count };
    trace.lasso.move(next); segment.push(next);
  }
  requestDraw();
}
function pauseOutline() { if (trace) { trace.paused = true; trace.awaiting = false; renderContext(); requestDraw(); } $('#magnifier').hidden = true; }
function closeOutline() {
  if (locked() || mode !== 'select' || selectMode !== 'outline' || !trace) return;
  const layer = engine.selected;
  if (!layer || layer.id !== trace.layerId) { clearDraft(); return; }
  const old = trace, poly = old.lasso.end(); trace = null; $('#magnifier').hidden = true;
  if (!poly || polygonArea(poly) < 12) { notify('That outline is too small. Try a little wider.'); renderContext(); requestDraw(); return; }
  const mask = document.createElement('canvas'); mask.width = layer.width; mask.height = layer.height;
  const mctx = mask.getContext('2d'); mctx.fillStyle = '#fff'; mctx.beginPath();
  mctx.moveTo(poly[0] / old.kx, poly[1] / old.ky);
  for (let i = 2; i < poly.length; i += 2) mctx.lineTo(poly[i] / old.kx, poly[i + 1] / old.ky);
  mctx.closePath(); mctx.fill('evenodd');
  selection = { layerId: layer.id, canvas: mask, feathered: null }; previewSelection = false;
  platform.haptic('light'); renderContext(); refresh();
}
function undoOutlineSegment() {
  if (!trace) return false;
  if (trace.segments.length <= 1) { clearDraft(); return true; }
  trace.segments.pop(); rebuildOutline(trace);
  pauseOutline(); refresh(); return true;
}
function rebuildOutline(value) {
  value.lasso = createLasso(value.map, { snapRadius: value.radius, anchorSpacing: 18 });
  value.lasso.begin(value.segments[0][0]);
  for (const segment of value.segments) for (const point of segment) value.lasso.move(point);
}
function cancelOutlineStroke(action) {
  if (action?.kind !== 'outline') return;
  trace?.lasso.cancel();
  if (action.traceBefore) {
    trace = action.traceBefore.value;
    trace.segments = action.traceBefore.segments;
    rebuildOutline(trace); trace.paused = true; trace.awaiting = false;
  } else {
    if (trace?.imageCanvas) trace.imageCanvas.width = trace.imageCanvas.height = 0;
    trace = null;
  }
  selection = action.selectionBefore; previewSelection = action.previewBefore;
}
function featheredSelection() {
  if (!selection) return null;
  if (!feather) return selection.canvas;
  if (!selection.feathered) {
    const softened = document.createElement('canvas'); softened.width = selection.canvas.width; softened.height = selection.canvas.height;
    const c = softened.getContext('2d'); c.filter = `blur(${feather}px)`; c.drawImage(selection.canvas, 0, 0); selection.feathered = softened;
  }
  return selection.feathered;
}
async function applySelection(combine) {
  if (locked() || !selection || selection.layerId !== engine.selected?.id) return;
  const id = selection.layerId, mask = copyCanvas(featheredSelection());
  await work('Keeping your selection…', async () => { await engine.setMask(id, mask, { combine }); clearDraft({ redraw: false }); target = 'mask'; selectMode = 'brush'; mode = 'select'; renderContext(); platform.haptic('medium'); });
}
async function selectSubject(layer, point) {
  if (locked()) return;
  if (typeof platform.subjectMatte !== 'function') { notify('Trace an outline to make your selection.'); return; }
  const token = ++subjectGeneration, projectId = engine.project.id, layerId = layer.id;
  const fresh = () => token === subjectGeneration && engine.project?.id === projectId && engine.selected?.id === layerId && mode === 'select' && selectMode === 'subject';
  await work('Finding the subject…', async () => {
    const { imageCanvas, kx, ky } = analysis(layer), image = imageCanvas.getContext('2d').getImageData(0, 0, imageCanvas.width, imageCanvas.height);
    const result = await platform.subjectMatte(image, point.x * kx, point.y * ky, { radius: 12 });
    if (!fresh()) return;
    if (!result?.found) { notify('No subject there. Trace an outline instead.'); return; }
    const bitmap = await createImageBitmap(result.blob);
    try {
      if (!fresh()) return;
      const mask = document.createElement('canvas'); mask.width = layer.width; mask.height = layer.height;
      const mctx = mask.getContext('2d'); mctx.drawImage(bitmap, 0, 0, mask.width, mask.height);
      const pixels = mctx.getImageData(0, 0, mask.width, mask.height), data = pixels.data;
      for (let i = 0; i < data.length; i += 4) { const alpha = Math.round((.2126 * data[i] + .7152 * data[i + 1] + .0722 * data[i + 2]) * data[i + 3] / 255); data[i] = data[i + 1] = data[i + 2] = 255; data[i + 3] = alpha; }
      mctx.putImageData(pixels, 0, 0);
      selection = { layerId, canvas: mask, feathered: null }; feather = 0; previewSelection = true; renderContext(); requestDraw(); platform.haptic('light');
    } finally { bitmap.close(); }
  });
}

function visibleMask(layer) {
  const current = engine.getMask(layer.id);
  if (current) return copyCanvas(current, layer.width, layer.height);
  const mask = document.createElement('canvas'); mask.width = layer.width; mask.height = layer.height;
  const mctx = mask.getContext('2d'); mctx.fillStyle = '#fff'; mctx.fillRect(0, 0, mask.width, mask.height); return mask;
}
function brushAt(layer, from, to) {
  const mctx = brushPreview.canvas.getContext('2d'), radius = brushSize / (view.zoom * layer.scale) / 2;
  const distance = Math.hypot(to.x - from.x, to.y - from.y), steps = Math.max(1, Math.ceil(distance / Math.max(1, radius * .18)));
  mctx.globalCompositeOperation = brushKind === 'hide' ? 'destination-out' : 'source-over';
  for (let i = 0; i <= steps; i++) {
    const x = from.x + (to.x - from.x) * i / steps, y = from.y + (to.y - from.y) * i / steps;
    const gradient = mctx.createRadialGradient(x, y, radius * .35, x, y, radius);
    gradient.addColorStop(0, 'rgba(255,255,255,1)'); gradient.addColorStop(1, 'rgba(255,255,255,0)');
    mctx.fillStyle = gradient; mctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
  requestDraw();
}
function showMagnifier(layer, point, finger) {
  const mag = $('#magnifier'), image = engine.getLayerImage(layer.id); if (!image) return;
  const dpr = Math.min(2, devicePixelRatio || 1); mag.width = mag.height = 124 * dpr;
  const c = mag.getContext('2d'), zoom = 3 * view.zoom * layer.scale;
  c.scale(dpr, dpr); c.fillStyle = '#292621'; c.fillRect(0, 0, 124, 124);
  c.save(); c.translate(62, 62); c.scale(zoom, zoom); c.translate(-point.x, -point.y); c.drawImage(image, 0, 0);
  if (trace) { const path = trace.lasso.path(); c.beginPath(); for (let i = 0; i < path.length; i += 2) { const x = path[i] / trace.kx, y = path[i + 1] / trace.ky; if (i) c.lineTo(x, y); else c.moveTo(x, y); } c.strokeStyle = '#f3d4aa'; c.lineWidth = 1.5 / zoom; c.stroke(); }
  c.restore(); c.strokeStyle = '#fff9'; c.lineWidth = .7; c.beginPath(); c.moveTo(53, 62); c.lineTo(71, 62); c.moveTo(62, 53); c.lineTo(62, 71); c.stroke();
  mag.style.left = finger.x < 160 && finger.y < 195 ? `${Math.max(12, size.width - 136)}px` : '12px'; mag.hidden = false;
}

canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 && event.pointerType === 'mouse') return;
  event.preventDefault(); canvas.setPointerCapture(event.pointerId);
  const point = eventPoint(event); pointers.set(event.pointerId, point);
  if (pointers.size >= 2) { beginNavigation(); return; }
  if (locked() || !engine?.selected) return;
  const doc = documentPoint(point);
  if (mode === 'view') { gesture = { kind: 'pan', pointer: event.pointerId, start: point, view: { ...view } }; return; }
  if (mode === 'move') {
    const corner = cornerAt(engine.selected, point);
    if (corner) {
      const layer = engine.selected;
      engine.begin();
      gesture = { kind: 'resize', pointer: event.pointerId, layer: { ...layer },
        vector: { x: corner.x - layer.x, y: corner.y - layer.y },
        offset: { x: doc.x - corner.x, y: doc.y - corner.y } };
      return;
    }
    const hit = hitLayer(doc);
    if (!hit) return;
    if (hit.id !== engine.selected.id) selectLayer(hit.id);
    const layer = engine.selected;
    if (!layer) return;
    engine.begin(); gesture = { kind: 'move', pointer: event.pointerId, start: doc, layer: { ...layer } }; return;
  }
  const layer = engine.selected, local = sourcePoint(layer, doc);
  if (!inLayer(layer, doc)) return;
  if (selectMode === 'outline') {
    // Wait for a real stroke: the first finger of a canvas-navigation gesture
    // must not join a paused outline to an unrelated point on the picture.
    gesture = { kind: 'outline-pending', pointer: event.pointerId, start: point, local, layerId: layer.id,
      traceBefore: trace ? { value: trace, segments: trace.segments.map((segment) => segment.slice()) } : null,
      selectionBefore: selection, previewBefore: previewSelection };
  } else if (selectMode === 'subject') gesture = { kind: 'subject', pointer: event.pointerId, local, start: point, layerId: layer.id };
  else {
    brushPreview = { layerId: layer.id, canvas: visibleMask(layer) };
    gesture = { kind: 'brush', pointer: event.pointerId, previous: local, layerId: layer.id };
    brushAt(layer, local, local); showMagnifier(layer, local, point);
  }
});
function beginNavigation() {
  if (gesture?.kind === 'move' || gesture?.kind === 'resize') engine.cancel();
  if (gesture?.kind === 'brush') brushPreview = null;
  cancelOutlineStroke(gesture);
  if (trace) pauseOutline();
  $('#magnifier').hidden = true;
  const [a, b] = [...pointers.values()], center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  gesture = { kind: 'navigate', distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), anchor: documentPoint(center), view: { ...view } };
  requestDraw();
}
canvas.addEventListener('pointermove', (event) => {
  if (!pointers.has(event.pointerId)) return;
  const point = eventPoint(event); pointers.set(event.pointerId, point);
  if (!gesture) return;
  if (gesture.kind === 'navigate') {
    if (pointers.size < 2) return;
    const [a, b] = [...pointers.values()], center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const zoom = clamp(gesture.view.zoom * Math.hypot(a.x - b.x, a.y - b.y) / gesture.distance, .025, 15);
    view = { zoom, x: center.x - gesture.anchor.x * zoom, y: center.y - gesture.anchor.y * zoom }; requestDraw(); return;
  }
  if (locked()) { pauseInteraction(); return; }
  if (gesture.pointer !== event.pointerId) return;
  const layer = engine.selected, doc = documentPoint(point);
  if (gesture.kind === 'outline-pending') {
    if (!layer || layer.id !== gesture.layerId || Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) < 4) return;
    try {
      beginOutline(layer, gesture.local); gesture.kind = 'outline';
      const local = sourcePoint(layer, doc); extendOutline(local); showMagnifier(layer, local, point);
    } catch (error) { notify(error.message || 'The outline could not start.'); gesture = null; }
    return;
  }
  if (gesture.kind === 'pan') { view.x = gesture.view.x + point.x - gesture.start.x; view.y = gesture.view.y + point.y - gesture.start.y; requestDraw(); }
  else if (gesture.kind === 'move') engine.updateLayer(gesture.layer.id, { x: gesture.layer.x + doc.x - gesture.start.x, y: gesture.layer.y + doc.y - gesture.start.y }, { commit: false });
  else if (gesture.kind === 'resize') {
    const initial = gesture.layer, vector = { x: doc.x - gesture.offset.x - initial.x, y: doc.y - gesture.offset.y - initial.y };
    const ratio = Math.hypot(vector.x, vector.y) / Math.max(.001, Math.hypot(gesture.vector.x, gesture.vector.y));
    const delta = Math.atan2(vector.y, vector.x) - Math.atan2(gesture.vector.y, gesture.vector.x);
    engine.updateLayer(initial.id, { scale: clamp(initial.scale * ratio, MIN_SCALE, MAX_SCALE), rotation: Math.atan2(Math.sin(initial.rotation + delta), Math.cos(initial.rotation + delta)) }, { commit: false });
  }
  else if (gesture.kind === 'outline' && trace && layer) { const local = sourcePoint(layer, doc); extendOutline(local); showMagnifier(layer, local, point); }
  else if (gesture.kind === 'brush' && layer && brushPreview) { const local = sourcePoint(layer, doc); brushAt(layer, gesture.previous, local); gesture.previous = local; showMagnifier(layer, local, point); }
});
function pointerEnd(event) {
  if (!pointers.has(event.pointerId)) return;
  pointers.delete(event.pointerId);
  if (!gesture) return;
  if (gesture.kind === 'navigate') { if (!pointers.size) gesture = null; return; }
  if (locked()) { pauseInteraction(); return; }
  if (gesture.pointer !== event.pointerId) return;
  const action = gesture; gesture = null; $('#magnifier').hidden = true;
  if (action.kind === 'outline' || action.kind === 'outline-pending') {
    if (event.type === 'pointercancel') cancelOutlineStroke(action);
    else if (action.kind === 'outline-pending' && engine.selected?.id === action.layerId) {
      try { beginOutline(engine.selected, action.local); } catch (error) { notify(error.message || 'The outline could not start.'); }
    }
    pauseOutline(); refresh(); return;
  }
  if (event.type === 'pointercancel') {
    if (action.kind === 'move' || action.kind === 'resize') engine.cancel();
    if (action.kind === 'brush') brushPreview = null;
    refresh(); return;
  }
  if (action.kind === 'move') { engine.commit('Move layer'); platform.haptic('light'); }
  else if (action.kind === 'resize') { engine.commit('Resize and rotate layer'); renderContext(); platform.haptic('light'); }
  else if (action.kind === 'subject' && engine.selected?.id === action.layerId) {
    const point = eventPoint(event); if (Math.hypot(point.x - action.start.x, point.y - action.start.y) < 14) void selectSubject(engine.selected, action.local);
  } else if (action.kind === 'brush' && brushPreview) {
    const draft = brushPreview; brushPreview = null;
    void work('Saving your mask…', async () => { await engine.setMask(draft.layerId, draft.canvas, { combine: 'replace' }); platform.haptic('light'); });
  }
  refresh();
}
canvas.addEventListener('pointerup', pointerEnd); canvas.addEventListener('pointercancel', pointerEnd);
canvas.addEventListener('lostpointercapture', (event) => { if (pointers.has(event.pointerId)) pointerEnd({ ...event, pointerId: event.pointerId, type: 'pointercancel' }); });
canvas.addEventListener('wheel', (event) => {
  event.preventDefault(); const point = eventPoint(event), anchor = documentPoint(point), zoom = clamp(view.zoom * Math.exp(-event.deltaY * .002), .025, 15);
  view = { zoom, x: point.x - anchor.x * zoom, y: point.y - anchor.y * zoom }; requestDraw();
}, { passive: false });

function showSheet(id) { for (const sheet of document.querySelectorAll('dialog[open]')) sheet.close(); $(`#${id}`).showModal(); }
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => button.closest('dialog').close());
for (const sheet of document.querySelectorAll('dialog')) sheet.addEventListener('click', (event) => { if (event.target !== sheet) return; const r = sheet.getBoundingClientRect(); if (event.clientY < r.top || event.clientX < r.left || event.clientX > r.right) sheet.close(); });
for (const button of document.querySelectorAll('[data-tool]')) button.addEventListener('click', () => {
  if (locked()) return;
  const tool = button.dataset.tool;
  if (tool === 'add') { if (engine?.project?.layers.length) showSheet('add-sheet'); else void choosePhoto(false); }
  else if (tool === 'layers') { renderLayers(); showSheet('layers-sheet'); }
  else setMode(tool);
});

async function choosePhoto(addBehind = false, fresh = false) {
  if (locked()) return;
  behind = addBehind; startNew = fresh;
  $('#add-sheet').close(); $('#projects-sheet').close();
  if (platform.isNative) {
    await work('Opening Photos…', async () => {
      const file = await platform.pickPhoto({ input: $('#photo-input'), maxPixels: 2048 ** 2 });
      if (file) await importPhoto(file);
    });
  } else $('#photo-input').click();
}
async function importPhoto(file) {
  clearDraft({ redraw: false });
  if (startNew || !engine.project) { await engine.newProject(file.name.replace(/\.[^.]+$/, '') || 'Untitled'); fittedProject = null; }
  await engine.addPhoto(file, { behind });
  mode = 'move'; target = 'image'; fit(); renderContext(); refresh(); platform.haptic('medium');
}
$('#photo-input').addEventListener('change', (event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void work('Opening your photo…', () => importPhoto(file)); });
$('#start').addEventListener('click', () => choosePhoto(false));
$('#add-above').addEventListener('click', () => choosePhoto(false));
$('#add-behind').addEventListener('click', () => choosePhoto(true));
$('#new-project').addEventListener('click', () => choosePhoto(false, true));
$('#fit').addEventListener('click', fit);

function thumbnail(source, mask = false) {
  const thumb = document.createElement('canvas'); thumb.width = thumb.height = 88; const c = thumb.getContext('2d');
  if (mask) { c.fillStyle = '#111'; c.fillRect(0, 0, 88, 88); }
  if (source) {
    const scale = Math.min(88 / source.width, 88 / source.height), w = source.width * scale, h = source.height * scale;
    c.drawImage(source, (88 - w) / 2, (88 - h) / 2, w, h);
  } else if (mask) { c.fillStyle = '#eee8dd'; c.fillRect(11, 11, 66, 66); }
  return thumb;
}
function renderLayers() {
  const list = $('#layer-list'), properties = $('#layer-properties'); list.replaceChildren(); properties.replaceChildren();
  if (!engine?.project?.layers.length) { list.append(node('p', 'project-empty', 'Add a photo to start your first layer.')); return; }
  for (const layer of engine.project.layers.slice().reverse()) {
    const active = engine.selected?.id === layer.id;
    const row = node('div', `layer-row${active ? ' active' : ''}${layer.visible ? '' : ' off'}`); row.dataset.layerId = layer.id;
    const image = smallButton('', `thumbnail-button${active && target === 'image' ? ' selected' : ''}`, () => selectLayer(layer.id, 'image'));
    image.setAttribute('aria-label', `Select ${layer.name} image`); image.append(thumbnail(engine.getLayerImage(layer.id)));
    const mask = smallButton('', `thumbnail-button mask-thumbnail${active && target === 'mask' ? ' selected' : ''}`, () => selectLayer(layer.id, 'mask'));
    mask.setAttribute('aria-label', `Edit ${layer.name} mask`); mask.append(thumbnail(engine.getMask(layer.id), true));
    const name = smallButton('', 'layer-name', () => selectLayer(layer.id)); name.append(document.createTextNode(layer.name), node('small', '', `${layer.maskId ? 'Masked · ' : ''}${Math.round(layer.opacity * 100)}%`));
    const visible = smallButton(layer.visible ? '◉' : '○', 'visibility-button', () => { engine.updateLayer(layer.id, { visible: !layer.visible }, { label: layer.visible ? 'Hide layer' : 'Show layer' }); renderLayers(); });
    visible.setAttribute('aria-label', `${layer.visible ? 'Hide' : 'Show'} ${layer.name}`);
    row.append(image, mask, name, visible); list.append(row);
  }
  const layer = engine.selected; if (!layer) return;
  properties.append(node('p', 'property-heading', target === 'mask' ? 'Mask selected · original pixels are safe' : 'Image selected'));
  const name = node('input'); name.type = 'text'; name.value = layer.name; name.maxLength = 100; name.setAttribute('aria-label', 'Layer name');
  name.addEventListener('change', () => { if (!locked()) { engine.updateLayer(layer.id, { name: name.value.trim() || 'Photo' }, { label: 'Rename layer' }); renderLayers(); } }); properties.append(name);
  const actions = node('div', 'property-actions');
  actions.append(smallButton('↑ Forward', '', () => { engine.reorder(layer.id, 1); renderLayers(); }), smallButton('↓ Back', '', () => { engine.reorder(layer.id, -1); renderLayers(); }), smallButton('Duplicate', '', () => { void work('Duplicating layer…', async () => { await engine.duplicate(layer.id); renderLayers(); }); }));
  properties.append(actions);
  control(properties, { id: 'layer-opacity', label: 'Opacity', min: 0, max: 100, value: layer.opacity * 100, format: (v) => `${Math.round(v)}%`, change: (v) => propertyPreview('opacity', { opacity: v / 100 }, 'Layer opacity'), finish: () => finishProperty('Layer opacity') });
  const blend = node('div', 'blend-control'), label = node('label', '', 'Blend'), select = node('select'); label.htmlFor = 'layer-blend'; select.id = 'layer-blend';
  for (const [value, text] of [['source-over', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay']]) { const option = node('option', '', text); option.value = value; option.selected = layer.blend === value; select.append(option); }
  select.addEventListener('change', () => { if (!locked()) engine.updateLayer(layer.id, { blend: select.value }, { label: 'Blend layer' }); }); blend.append(label, select); properties.append(blend);
  properties.append(node('p', 'section-caption', 'LIGHT & COLOR · THIS LAYER'));
  for (const [key, text] of [['brightness', 'Light'], ['contrast', 'Contrast'], ['saturation', 'Color']]) {
    control(properties, { id: `layer-${key}`, label: text, min: 0, max: 200, value: (layer.adjustments?.[key] ?? 1) * 100, format: (v) => `${Math.round(v)}%`, change: (v) => propertyPreview(key, { adjustments: { [key]: v / 100 } }, `Adjust ${text.toLowerCase()}`), finish: () => finishProperty(`Adjust ${text.toLowerCase()}`) });
  }
  properties.append(node('p', 'section-caption', 'SHADOW · UNDER THIS LAYER'));
  control(properties, { id: 'shadow-opacity', label: 'Strength', min: 0, max: 80, value: (layer.shadow?.opacity ?? 0) * 100, format: (v) => `${Math.round(v)}%`, change: (v) => propertyPreview('shadow-opacity', { shadow: { opacity: v / 100 } }, 'Shadow strength'), finish: () => finishProperty('Shadow strength') });
  control(properties, { id: 'shadow-softness', label: 'Softness', min: 0, max: 100, value: layer.shadow?.blur || 0, format: (v) => `${Math.round(v)} px`, change: (v) => propertyPreview('shadow-blur', { shadow: { blur: v } }, 'Shadow softness'), finish: () => finishProperty('Shadow softness') });
  control(properties, { id: 'shadow-distance', label: 'Distance', min: -100, max: 100, value: layer.shadow?.offsetY || 0, format: (v) => `${Math.round(v)} px`, change: (v) => propertyPreview('shadow-distance', { shadow: { offsetY: v } }, 'Shadow distance'), finish: () => finishProperty('Shadow distance') });
  const footer = node('div', 'property-actions');
  footer.append(smallButton('Refine mask', '', () => { $('#layers-sheet').close(); setMode('select', { mask: true }); }), smallButton('Restore mask', '', () => { void work('Restoring the original…', async () => { await engine.clearMask(layer.id); renderLayers(); }); }), smallButton('Delete layer', 'destructive', () => { engine.remove(layer.id); clearDraft({ redraw: false }); renderLayers(); renderContext(); refresh(); }));
  properties.append(footer);
}

async function showProjects(internal = false) {
  if (locked() && !internal) return;
  await engine.flush(); const projects = await engine.projects(), list = $('#project-list'); list.replaceChildren(); deletingProject = null;
  if (!projects.length) list.append(node('p', 'project-empty', 'Your next idea starts with a photo.'));
  for (const project of projects) {
    const row = node('div', 'project-row');
    const open = smallButton('', 'project-open', () => { $('#projects-sheet').close(); void work('Opening your project…', async () => { clearDraft({ redraw: false }); await engine.open(project.id); fittedProject = null; fit(); mode = 'move'; target = 'image'; renderContext(); }); });
    open.append(document.createTextNode(project.name || 'Untitled'), node('small', '', `${project.width} × ${project.height} · ${project.layerCount ?? '?'} ${(project.layerCount ?? 0) === 1 ? 'layer' : 'layers'}`));
    const remove = smallButton('Delete', 'project-delete', async () => {
      if (deletingProject !== project.id) { deletingProject = project.id; remove.textContent = 'Sure?'; remove.style.color = '#e9b0a2'; return; }
      await work('Deleting project…', async () => { clearDraft({ redraw: false }); await engine.removeProject(project.id); await showProjects(true); });
    });
    row.append(open, remove); list.append(row);
  }
  showSheet('projects-sheet');
}
$('#projects').addEventListener('click', () => { void showProjects(); }); $('#open-projects').addEventListener('click', () => { void showProjects(); });

function historyAction(direction) {
  if (locked() || document.querySelector('dialog[open]')) return;
  if (direction < 0 && mode === 'select' && selectMode === 'outline' && undoOutlineSegment()) return;
  subjectGeneration++; propertyGesture = null; pauseInteraction();
  const projectId = engine.project?.id, layerId = engine.selected?.id;
  const pending = direction < 0 ? engine.undo() : engine.redo();
  refresh();
  void Promise.resolve(pending).then(() => {
    if (engine.project?.id !== projectId || engine.selected?.id !== layerId) clearDraft({ redraw: false });
    renderContext(); if ($('#layers-sheet').open) renderLayers(); refresh();
  }).catch((error) => { notify(error.message); refresh(); });
}
$('#undo').addEventListener('click', () => historyAction(-1));
$('#redo').addEventListener('click', () => historyAction(1));

async function openExport() {
  if (locked() || document.querySelector('dialog[open]') || !engine.project?.layers.length) return;
  finishProperty('Adjust layer');
  const token = ++exportSession; exportActionToken++; exportBusy = true; exportSnapshot = null; exportBlobs = null;
  $('#export-info').textContent = 'Preparing your picture…'; $('#export-info').classList.remove('success');
  $('#save-export').disabled = $('#share-export').disabled = true; $('#save-export').textContent = platform.isNative ? 'Save to Photos' : 'Download JPEG'; showSheet('export-sheet');
  syncExportControls(); refresh();
  try {
    await engine.flush();
    const snapshot = engine.project;
    const [jpeg, png] = await Promise.all([engine.exportImage({ type: 'image/jpeg' }), engine.exportImage({ type: 'image/png' })]);
    if (token !== exportSession || !$('#export-sheet').open) return;
    if (engine.project !== snapshot) { $('#export-info').textContent = 'The picture changed. Close this sheet and export again.'; return; }
    exportSnapshot = snapshot; exportBlobs = { jpeg, png }; exportBusy = false; updateExport();
  } catch (error) { if (token === exportSession) $('#export-info').textContent = error.message || 'Could not prepare this export.'; }
  finally { if (token === exportSession) { exportBusy = false; syncExportControls(); refresh(); } }
}
function syncExportControls() {
  const ready = !!exportBlobs?.[exportFormat] && engine?.project === exportSnapshot;
  for (const button of document.querySelectorAll('[data-format]')) button.disabled = exportBusy;
  $('#save-export').disabled = $('#share-export').disabled = busy || exportBusy || !!engine?.busy || !ready;
}
function updateExport() {
  if (exportBusy) { syncExportControls(); return; }
  const blob = exportBlobs?.[exportFormat];
  for (const button of document.querySelectorAll('[data-format]')) button.setAttribute('aria-pressed', button.dataset.format === exportFormat ? 'true' : 'false');
  $('#save-export').textContent = platform.isNative ? 'Save to Photos' : `Download ${exportFormat.toUpperCase()}`;
  syncExportControls();
  $('#export-info').textContent = blob && exportSnapshot ? `${exportSnapshot.width} × ${exportSnapshot.height} · ${(blob.size / 1024 ** 2).toFixed(1)} MB` : 'Preparing your picture…';
}
function projectSaveCopy() { return engine.persistent && !engine.error ? 'Your editable project stays in Gesso.' : 'Keep this window open; export is your saved copy.'; }
function download(blob, name) {
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function exportAction(action) {
  if (locked() || !$('#export-sheet').open || engine.project !== exportSnapshot) return;
  const blob = exportBlobs?.[exportFormat]; if (!blob) return;
  const session = exportSession, actionToken = ++exportActionToken, snapshot = exportSnapshot;
  const name = `Gesso-${Date.now()}.${exportFormat === 'jpeg' ? 'jpg' : 'png'}`;
  const current = () => session === exportSession && actionToken === exportActionToken && $('#export-sheet').open;
  const info = $('#export-info'); info.classList.remove('success');
  if (action === 'save' && !platform.isNative) { download(blob, name); info.textContent = `Downloaded. ${projectSaveCopy()}`; return; }
  exportBusy = true; syncExportControls(); refresh();
  info.textContent = action === 'save' ? 'Saving to Photos…' : 'Opening Share…';
  let result;
  // Prepared blobs reach Web Share in the original click, preserving activation.
  try { result = action === 'save' ? platform.saveToPhotos(blob, name) : platform.share(blob, name); }
  catch (error) { result = Promise.reject(error); }
  Promise.resolve(result).then((value) => {
    if (!current()) return;
    if (engine.project !== snapshot) { info.textContent = 'The picture changed. Close this sheet and export again.'; return; }
    const saved = value?.saved === true || (value?.completed === true && value.activity === 'com.apple.UIKit.activity.SaveToCameraRoll');
    if (saved) { info.textContent = 'Saved to Photos.'; info.classList.add('success'); platform.haptic('success'); }
    else if (value?.reason === 'denied') { info.textContent = 'Photos access is off. Use Share, or allow access in Settings.'; }
    else if (value?.reason === 'restricted') info.textContent = 'Photos access is restricted. Use Share instead.';
    else if (value?.reason === 'failed') info.textContent = 'Photos could not save this copy. Try again, or use Share.';
    else if (value?.completed) { info.textContent = 'Shared.'; info.classList.add('success'); }
    else if (value?.fallback) { download(blob, name); info.textContent = 'Downloaded. Sharing is unavailable here.'; }
    else info.textContent = 'Share cancelled. Your canvas is still open.';
  }, (error) => {
    if (!current()) return;
    info.textContent = error?.name === 'AbortError' || error?.code === 'cancelled' ? 'Cancelled. Your canvas is still open.' : error.message || 'The export could not finish. Try again.';
  }).finally(() => { if (current()) { exportBusy = false; syncExportControls(); refresh(); } });
}
$('#export').addEventListener('click', openExport);
for (const button of document.querySelectorAll('[data-format]')) button.addEventListener('click', () => { if (!locked()) { exportFormat = button.dataset.format; updateExport(); } });
$('#save-export').addEventListener('click', () => exportAction('save')); $('#share-export').addEventListener('click', () => exportAction('share'));
$('#export-sheet').addEventListener('close', () => { exportSession++; exportActionToken++; exportBusy = false; exportSnapshot = null; exportBlobs = null; syncExportControls(); refresh(); });

const mutatingControls = '.topbar button, #tools button, #context button, #context input, #context select, #layers-sheet button:not([data-close]), #layers-sheet input, #layers-sheet select, #projects-sheet button:not([data-close]), #add-sheet button:not([data-close]), #start, #open-projects, #photo-input';
for (const type of ['click', 'input', 'change']) document.addEventListener(type, (event) => {
  if (locked() && event.target.closest?.(`${mutatingControls}, .photo-adjustments`)) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);

function refresh() {
  if (!engine) return;
  const project = engine.project, hasLayers = !!project?.layers.length;
  const blocked = locked(), outlineUndo = mode === 'select' && selectMode === 'outline' && !!trace;
  for (const element of document.querySelectorAll(mutatingControls)) element.disabled = blocked;
  $('.photo-adjustments').inert = blocked;
  if (exportSnapshot && exportBlobs && project !== exportSnapshot) {
    exportBlobs = null;
    if ($('#export-sheet').open) $('#export-info').textContent = 'The picture changed. Close this sheet and export again.';
  }
  syncExportControls();
  if (!hasLayers) context.hidden = true;
  if (engine.error && engine.error !== lastEngineError) { lastEngineError = engine.error; notify(engine.error, 9000); }
  const warning = engine.error || (!engine.persistent ? 'Project storage is unavailable. Keep this window open and export your work.' : '');
  $('#storage-warning').textContent = warning; $('#storage-warning').hidden = !warning;
  $('#project-storage-note').textContent = warning ? 'Keep this window open. Export a copy before leaving; project storage is unavailable.' : 'Projects save on this device, with layers and masks intact.';
  $('#export-storage-note').textContent = warning ? 'Export makes a saved copy. Keep this window open to continue editing.' : 'Your editable project stays here. Export makes a copy.';
  $('#empty').hidden = hasLayers; $('#export').disabled = blocked || !hasLayers;
  $('#project-name').textContent = project?.name || 'Studio';
  $('#undo').disabled = blocked || (!outlineUndo && !engine.canUndo); $('#redo').disabled = blocked || outlineUndo || !engine.canRedo;
  $('#undo').setAttribute('aria-label', outlineUndo ? 'Undo outline segment' : 'Undo');
  $('#layer-count').hidden = !hasLayers; $('#layer-count').textContent = project?.layers.length || 0;
  $('#selection-label').hidden = !hasLayers;
  const targetLabel = mode === 'select' ? selectMode === 'brush' ? 'Mask' : 'Selection' : target === 'mask' ? 'Mask' : 'Image';
  $('#target-name').textContent = engine.selected ? `${engine.selected.name} · ${targetLabel}` : 'Choose a layer';
  for (const button of document.querySelectorAll('[data-tool]')) button.setAttribute('aria-pressed', (button.dataset.tool === mode || (button.dataset.tool === 'select' && mode === 'select')) ? 'true' : 'false');
  if (project && fittedProject !== project.id) { fittedProject = project.id; fit(); }
  requestDraw();
}
document.addEventListener('keydown', (event) => {
  if (event.target.matches('input,textarea,select')) return;
  const unavailable = locked() || !!document.querySelector('dialog[open]');
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); if (!unavailable) $(event.shiftKey ? '#redo' : '#undo').click(); }
  if (unavailable) return;
  if (event.key === 'Escape') { clearDraft(); setMode('move'); }
  if (event.key === 'Enter' && mode === 'select' && selectMode === 'outline' && trace) { event.preventDefault(); closeOutline(); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) void engine?.flush(); });
window.addEventListener('pagehide', () => { void engine?.flush(); });
if (!platform.isNative && globalThis.isSecureContext && /^https?:$/.test(location.protocol) && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('../sw.js', { scope: '../' }).then((registration) => {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) registration.update().catch(() => {});
    });
  }).catch(() => {});
}

try {
  engine = await createStudio({ onChange: () => refresh() });
  await work('Opening your studio…', async () => {
    const recent = await engine.projects();
    if (recent.length) { await engine.open(recent[0].id); mode = 'move'; target = 'image'; }
  });
  // Diagnostic hooks expose real state/actions and make pointer integration testable.
  window.gessoStudio = {
    engine, fit, setMode, closeOutline, clearSelection: clearDraft, choosePhoto, importPhoto,
    get mode() { return mode; }, get selectMode() { return selectMode; },
    get view() { return { ...view }; },
    get outline() { return trace ? { layerId: trace.layerId, paused: trace.paused, awaiting: trace.awaiting, segments: trace.segments.length, path: Array.from(trace.lasso.path()), kx: trace.kx, ky: trace.ky } : null; },
    get selection() { return selection ? { layerId: selection.layerId, width: selection.canvas.width, height: selection.canvas.height } : null; },
    sourceToScreen(x, y) { const layer = engine.selected; return layer ? screenPoint(canvasPoint(layer, { x, y })) : null; },
  };
  // Existing native lifecycle flush enters here too when Studio is the entry.
  window.gesso = { flush: () => engine.flush() };
  resize(); renderContext(); refresh();
} catch (error) {
  console.error(error); $('#empty h1').textContent = 'Your studio couldn’t open.';
  $('.empty-copy').textContent = error.message || 'Close Gesso and try again.';
  $('#start').disabled = true; notify('Temporary storage could not be opened. Please restart Gesso.', 10000);
}
