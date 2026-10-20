// The editor: one integration point between the document, history, renderer,
// panel, stage gestures and the tools. Tools never touch the DOM chrome or the GPU
// directly except through `ed`.
//
// Tool shape (ui/tools/*.js):
//   { id, label, viewMode: 'output'|'frame',
//     open(ed, opts), close(ed, { cancel }), panel(ed) -> PanelSpec,
//     onQuick(ed, id), onDial(ed, id), onSegment(ed, id), onSwatch(ed, hex), onMessage(ed, action),
//     onRuler(ed, phase, value), onGesture(ed, g) -> handled,
//     hitTarget(ed, x, y) -> target | null, dragAxis(ed) -> 'free'|'x'|'none',
//     drawOverlay(ed, ctx), wantsCaptions: bool,
//     settle() -> Promise | null   (work still landing as a step; Save waits for it) }

import * as H from '../lib/history.js';
import { createDoc, describeChange, developInput } from '../lib/doc.js';
import { resolve, uniforms as developUniforms } from '../lib/develop.js';
import { outputSize, outputToSource, apply as applyMatrix, multiply } from '../lib/geometry.js';
import { fitView, viewMatrix, zoomAt, panBy, clampView, stageToContent, outputQuad, frameQuad, frameBounds, isZoomed, navigatorFrame } from '../lib/view.js';
import { initialGestures, reduceGesture, SLOP } from '../lib/gestures.js';
import { planReconcile, repaintPlan } from '../lib/patches.js';
import { dabs } from '../lib/stroke.js';
import { createPanel } from './panel.js';
import { blurLuminance } from './renderer.js';

const STAGE_MARGIN = 12;
const BEFORE_TAP_MS = 1200;
const LOUPE_R = 48; // SPEC F10: a 2x loupe above-left of the finger
const LOUPE_OFF = 70;

export function createEditor({ root, renderer, tools, hints, store, onSave, onNewPhoto }) {
  const $ = (s) => root.querySelector(s);
  const app = $('#app');
  const stage = $('#stage');
  const overlay = $('#overlay');
  const toastEl = $('#toast');
  const badge = $('#badge');
  const wipeBadges = $('#wipe-badges');
  const undoBtn = $('#undo');
  const redoBtn = $('#redo');
  const beforeBtn = $('#before');
  const saveBtn = $('#save');
  const statusEl = $('#status');
  const zoomEl = $('#zoom');
  const zoomPill = $('#zoom-pill');
  const navFrame = $('#navigator-frame');
  const navCanvas = $('#navigator-canvas');
  const dockButtons = [...root.querySelectorAll('#dock [data-tool]')];

  let hist = null;
  let pools = { strokes: {}, patches: {} };
  const tiles = new Map(); // patchId -> Uint8ClampedArray (RGBA of its bbox)
  let liveState = null;
  let applied = null; // the state the GPU currently reflects (remove/paint)
  let toolId = 'home';
  let tool = tools.home;
  let toolMark = null; // history mark when the tool opened
  let session = 0; // counts tool sessions, so late work knows whether it is still in its own
  let view = null;
  let viewKey = '';
  let keptView = null; // the photo's view while Crop shows its own frame: { key, view }
  let compare = { mode: 'off', x: 0 };
  let gesture = initialGestures();
  let wakeTimer = 0;
  let renderQueued = false;
  let blurTimer = 0;
  let toastTimer = 0;
  let savedState = null; // the state last put in Photos (states are immutable: same object, same pixels)
  let revision = 0;
  let sourceInfo = null;
  let pinch = null;
  let loupe = null; // { x, y (finger), cx, cy, r, view } while a tool asks for one

  const panel = createPanel(root, {
    onCancel: () => closeTool({ cancel: true }),
    onDone: () => closeTool({ cancel: false }),
    onQuick: (id) => { tool.onQuick?.(ed, id); refresh(); },
    onDial: (id) => { tool.onDial?.(ed, id); refresh(); },
    onSegment: (id) => { tool.onSegment?.(ed, id); refresh(); },
    onSwatch: (hex) => { tool.onSwatch?.(ed, hex); refresh(); },
    onMessage: (a) => { tool.onMessage?.(ed, a); refresh(); },
    onRuler: (phase, value) => {
      if (phase === 'start') ed.hint('ruler-drag', { tool: toolId });
      tool.onRuler?.(ed, phase, value);
      if (phase !== 'move') refresh();
    },
  });

  // ------------------------------------------------------------------ state

  const current = () => (hist ? H.current(hist) : null);
  const shown = () => liveState ?? current();
  // By state, not by revision: a Cancel with no change, or Undo then Redo, is still saved.
  const inPhotos = () => savedState !== null && current() === savedState;

  function setLive(next) {
    liveState = next;
    syncGpu(next);
    requestRender();
  }

  function commit(next, label, { tool: t = toolId } = {}) {
    const prev = current();
    if (next === prev) { liveState = null; requestRender(); return; }
    const text = label ?? describeChange(prev, next);
    const pushed = H.push(hist, next, text, t);
    liveState = null;
    if (pushed === hist) { syncGpu(current()); requestRender(); refresh(); return null; }
    const before = H.referencedIds(hist).patches;
    hist = pushed;
    revision++;
    syncGpu(next);
    dropDeadFills(before);
    afterChange();
    return text;
  }

  // Fills that no history step names any more (a redo branch a new step replaced, a
  // cancelled Remove session) can never come back: let their pixels go, here and in
  // the store. `before`: the fills the history named before the change.
  function dropDeadFills(before) {
    const now = H.referencedIds(hist).patches;
    const gone = [...before].filter((id) => !now.has(id));
    if (!gone.length) return;
    const patches = { ...pools.patches };
    for (const id of gone) {
      tiles.delete(id);
      delete patches[id];
    }
    pools = { ...pools, patches };
    store?.forgetTiles?.(gone);
  }

  // A step asked for in an earlier tool session (a Remove fill still computing when
  // its tool was left) goes in under the open session, so that tool's Cancel keeps
  // it. `fn` applies the step to a state.
  function commitBelow(fn, label, { tool: t = toolId, session: asked = session } = {}) {
    if (asked !== session && hist.mark !== null) {
      const base = hist.entries[hist.mark].state;
      const next = H.insertBelowMark(hist, fn, label ?? describeChange(base, fn(base)), t);
      if (next) {
        hist = next;
        if (liveState) liveState = fn(liveState);
        revision++;
        syncGpu(shown());
        afterChange();
        return true;
      }
    }
    return commit(fn(current()), label, { tool: t });
  }

  function afterChange() {
    requestRender();
    refresh();
    store?.schedule?.();
    statusEl.textContent = inPhotos() ? 'Saved' : (H.canUndo(hist) ? 'Edited' : '');
  }

  // Keep the GPU's fills and painted light in step with whatever state is shown.
  function syncGpu(state) {
    if (!state || !renderer.size) return;
    const prev = applied;
    if (!prev || prev.remove !== state.remove) {
      const from = prev ? prev.remove : [];
      const plan = planReconcile(from, state.remove);
      if (state.remove.length === 0 && renderer.hasBase) {
        renderer.resetBase();
      } else {
        // Revert newest-first: put pristine back under each undone fill, then
        // replay the fills that stay (the common prefix) clipped to that area.
        const kept = state.remove.slice(0, plan.keep);
        if (plan.revert.some((id) => !pools.patches[id])) {
          // A fill we know nothing about: rebuild base from scratch rather than
          // leave stale pixels behind.
          renderer.resetBase();
          for (const pid of kept) {
            const pm = pools.patches[pid];
            const tile = tiles.get(pid);
            if (pm && tile) renderer.pasteTile({ x: pm.x, y: pm.y, w: pm.w, h: pm.h }, tile);
          }
          plan.revert.length = 0;
        }
        for (const id of plan.revert) {
          const meta = pools.patches[id];
          const rect = { x: meta.x, y: meta.y, w: meta.w, h: meta.h };
          renderer.restoreRect(rect);
          for (const pid of repaintPlan(rect, kept, pools.patches)) {
            const pm = pools.patches[pid];
            const tile = tiles.get(pid);
            if (pm && tile) renderer.pasteTile({ x: pm.x, y: pm.y, w: pm.w, h: pm.h }, tile, rect);
          }
        }
        for (const id of plan.apply) {
          const meta = pools.patches[id];
          const tile = tiles.get(id);
          if (meta && tile) renderer.pasteTile({ x: meta.x, y: meta.y, w: meta.w, h: meta.h }, tile);
        }
      }
      if (plan.revert.length || plan.apply.length) scheduleBlur();
    }
    if (!prev || prev.paint !== state.paint) replayPaint(state.paint);
    applied = state;
  }

  function replayPaint(ids) {
    if (!ids.length) {
      if (renderer.hasPaint()) renderer.dropPaint();
      return;
    }
    renderer.clearPaint();
    for (const id of ids) {
      const s = pools.strokes[id];
      if (s) renderer.paintDabs(s.mode, dabs(s.pts, s.r), s.r);
    }
  }

  function scheduleBlur() {
    clearTimeout(blurTimer);
    blurTimer = setTimeout(rebuildBlur, 60);
  }

  function rebuildBlur() {
    if (!renderer.size) return;
    renderer.setBlur(blurLuminance(renderer.readSource({ maxSide: 512 })));
    requestRender();
  }

  // ------------------------------------------------------------------ tools

  function openTool(id, opts = {}) {
    if (!current()) return;
    if (id === toolId && id !== 'home') { closeTool({ cancel: false }); return; }
    if (toolId !== 'home') closeTool({ cancel: false, quiet: true });
    toolId = id;
    tool = tools[id];
    toolMark = hist;
    hist = H.setMark(hist);
    session++;
    app.dataset.tool = id;
    for (const b of dockButtons) b.setAttribute('aria-pressed', b.dataset.tool === id ? 'true' : 'false');
    tool.open?.(ed, opts);
    // The zoom is kept across tools (Crop fits its own frame; see ensureView).
    refresh();
    requestRender();
  }

  // quiet: another tool opens next, so Home is never really shown. hint: false when
  // something covers the panel next (Save's sheet), so no hint is burned unseen.
  function closeTool({ cancel = false, quiet = false, hint = !quiet } = {}) {
    if (toolId === 'home') return;
    if (liveState) liveState = null;
    if (cancel) {
      const before = H.referencedIds(hist).patches;
      hist = H.revertToMark(hist);
      revision++;
      syncGpu(current());
      dropDeadFills(before);
    }
    tool.close?.(ed, { cancel });
    hist = H.clearMark(hist);
    toolMark = null;
    toolId = 'home';
    tool = tools.home;
    app.dataset.tool = 'home';
    for (const b of dockButtons) b.setAttribute('aria-pressed', 'false');
    tool.open?.(ed, {});
    if (hint && current()?.text?.length) ed.hint('home-with-caption');
    if (!quiet) afterChange();
  }

  // A new photo or a restored draft replaces everything. New photo can be tapped
  // with a tool open, so that tool lets go of its state first (words being typed,
  // a heal still computing) and none of it reaches the new document.
  function dropTool() {
    if (toolId === 'home') return;
    liveState = null;
    tool.close?.(ed, { cancel: true });
    toolMark = null;
    app.dataset.tool = 'home';
    for (const b of dockButtons) b.setAttribute('aria-pressed', 'false');
  }

  function refresh() {
    if (!current()) return;
    panel.render(tool.panel(ed));
    undoBtn.disabled = !H.canUndo(hist);
    redoBtn.disabled = !H.canRedo(hist);
  }

  // ------------------------------------------------------------------ view

  function stageRect() {
    return { width: stage.clientWidth, height: stage.clientHeight };
  }

  function content() {
    const st = shown();
    if (tool.viewMode === 'frame') {
      const b = frameBounds(st.crop, st.source.w, st.source.h);
      return { mode: 'frame', width: b.width, height: b.height, bounds: b };
    }
    const o = outputSize(st.crop);
    return { mode: 'output', width: o.width, height: o.height };
  }

  function ensureView() {
    const s = stageRect();
    const c = content();
    // Crop always refits as the frame changes; elsewhere the view is kept while
    // the output size stays the same.
    const key = c.mode === 'frame' ? `f:${s.width}x${s.height}` : `o:${c.width}x${c.height}:${s.width}x${s.height}`;
    if (key !== viewKey || !view) {
      // Back from Crop with the same output on the same stage, the zoom the user left
      // is theirs again (SPEC F14).
      if (c.mode === 'frame' && view && viewKey.startsWith('o:')) keptView = { key: viewKey, view };
      const back = c.mode === 'output' && viewKey.startsWith('f:') && keptView?.key === key;
      view = back ? keptView.view : fitView(c.width, c.height, s.width, s.height, c.mode === 'frame' ? 28 : STAGE_MARGIN);
      if (c.mode === 'output') keptView = null;
      viewKey = key;
    }
    if (c.mode === 'frame') {
      // keep the whole rotated photo in view as straighten changes its bounds
      const fit = fitView(c.width, c.height, s.width, s.height, 28);
      view = { ...fit };
    }
    return { view, c, s };
  }

  // content px (output or frame-bounds px) <-> stage CSS px
  function contentToStage(x, y) { return [view.x + x * view.scale, view.y + y * view.scale]; }

  // stage CSS px -> output px (output mode) or frame coords (frame mode)
  function stageToDoc(x, y) {
    const [cx, cy] = stageToContent(view, x, y);
    const c = content();
    if (c.mode === 'frame') return [cx + c.bounds.x, cy + c.bounds.y];
    return [cx, cy];
  }

  function docToStage(x, y) {
    const c = content();
    if (c.mode === 'frame') return contentToStage(x - c.bounds.x, y - c.bounds.y);
    return contentToStage(x, y);
  }

  // stage CSS px -> source px (through the crop), for brushes and fills.
  function stageToSource(x, y) {
    const st = shown();
    const [ox, oy] = stageToDoc(x, y);
    if (content().mode === 'frame') {
      const m = outputToSource(st.crop, st.source.w, st.source.h);
      return applyMatrix(m, ox - st.crop.rect.x, oy - st.crop.rect.y);
    }
    return applyMatrix(outputToSource(st.crop, st.source.w, st.source.h), ox, oy);
  }

  // How many source px one stage CSS px covers (for brush radii).
  function sourcePerStagePx() {
    const st = shown();
    const m = outputToSource(st.crop, st.source.w, st.source.h);
    return Math.hypot(m[0], m[1]) / view.scale;
  }

  // ------------------------------------------------------------------ render

  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      draw();
    });
  }

  function draw() {
    const st = shown();
    if (!st || !renderer.size) return;
    const dpr = window.devicePixelRatio || 1;
    const { s, c } = ensureView();
    renderer.resize(s.width, s.height, dpr);
    sizeOverlay(s, dpr);
    const W = st.source.w, Hh = st.source.h;
    const o = outputSize(st.crop);
    let quad;
    if (c.mode === 'frame') {
      const m = multiply([dpr, 0, 0, dpr, 0, 0], multiply(viewMatrix(view), [1, 0, 0, 1, -c.bounds.x, -c.bounds.y]));
      quad = frameQuad(st.crop, W, Hh, m);
    } else {
      const m = multiply([dpr, 0, 0, dpr, 0, 0], viewMatrix(view));
      quad = outputQuad(st.crop, W, Hh, o.width, o.height, m);
    }
    const quads = [quad];
    quads.grainScale = [o.width, o.height];
    const { adjust, look } = developInput(st);
    const u = developUniforms(resolve(adjust, look));
    const at = compare.mode === 'off' && c.mode === 'output' ? tool.loupe?.(ed) : null;
    loupe = at ? placeLoupe(at.x, at.y, s) : null;
    let lq = null;
    if (loupe) {
      lq = [outputQuad(st.crop, W, Hh, o.width, o.height, multiply([dpr, 0, 0, dpr, 0, 0], viewMatrix(loupe.view)))];
      lq.grainScale = quads.grainScale;
    }
    renderer.draw({
      quads,
      uniforms: u,
      before: compare.mode === 'before',
      wipeX: compare.mode === 'wipe' ? compare.x * dpr : null,
      loupe: loupe && { quads: lq, rect: [(loupe.cx - LOUPE_R) * dpr, (s.height - loupe.cy - LOUPE_R) * dpr, 2 * LOUPE_R * dpr, 2 * LOUPE_R * dpr] },
    });
    stage.dataset.compare = compare.mode;
    badge.hidden = compare.mode !== 'before';
    wipeBadges.hidden = compare.mode !== 'wipe';
    drawOverlay(dpr);
    updateZoomUi();
  }

  // Above-left of the finger, or on the other side where that would leave the stage.
  function placeLoupe(x, y, s) {
    const side = (v, max) => Math.max(LOUPE_R, Math.min(max - LOUPE_R, v - LOUPE_OFF - LOUPE_R >= 0 ? v - LOUPE_OFF : v + LOUPE_OFF));
    const cx = side(x, s.width), cy = side(y, s.height);
    return { x, y, cx, cy, r: LOUPE_R, view: { ...view, scale: 2 * view.scale, x: cx - 2 * (x - view.x), y: cy - 2 * (y - view.y) } };
  }

  function sizeOverlay(s, dpr) {
    const w = Math.round(s.width * dpr), h = Math.round(s.height * dpr);
    if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h; }
  }

  // Note which frames actually paint the overlay. A frame that only clears it
  // (brush lifted, tool closed) has been seen to leave the previous frame on
  // screen when it shares the frame with a WebGL draw underneath, so an empty
  // overlay is hidden outright instead of trusted to be transparent.
  const overlayCtx = overlay.getContext('2d');
  let overlayDrew = false;
  for (const name of ['fill', 'stroke', 'fillRect', 'strokeRect', 'fillText', 'strokeText', 'drawImage', 'putImageData']) {
    const fn = overlayCtx[name].bind(overlayCtx);
    overlayCtx[name] = (...args) => { overlayDrew = true; return fn(...args); };
  }

  function drawOverlay(dpr) {
    const ctx = overlayCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath(); // a path never carries over into the next frame
    overlayDrew = false;
    if (compare.mode !== 'before' && tool.wantsCaptions !== false) {
      // Before has no captions: in a wipe they stay on the After side only.
      ctx.save();
      if (compare.mode === 'wipe') {
        ctx.beginPath();
        ctx.rect(compare.x, 0, stage.clientWidth - compare.x, stage.clientHeight);
        ctx.clip();
      }
      ed.drawCaptions?.(ctx, toolId === 'text' ? 1 : toolId === 'remove' ? 0.3 : 1);
      ctx.restore();
      ctx.beginPath(); // the clip rect must not become the tool's path
    }
    tool.drawOverlay?.(ed, ctx);
    if (compare.mode === 'wipe') {
      ctx.strokeStyle = '#f3eee6';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(compare.x, 0);
      ctx.lineTo(compare.x, stage.clientHeight);
      ctx.stroke();
    }
    overlay.style.visibility = overlayDrew ? 'visible' : 'hidden';
  }

  function updateZoomUi() {
    const zoomed = view && content().mode === 'output' && isZoomed(view);
    zoomEl.hidden = !zoomed;
    if (!zoomed) return;
    zoomPill.textContent = `${(view.scale / view.fit).toFixed(1)}× · Fit`;
    const c = content();
    const s = stageRect();
    const f = navigatorFrame(view, s.width, s.height, c.width, c.height, 88, 66);
    navFrame.style.left = `${f.x}px`;
    navFrame.style.top = `${f.y}px`;
    navFrame.style.width = `${f.width}px`;
    navFrame.style.height = `${f.height}px`;
    void navCanvas;
  }

  // ------------------------------------------------------------------ gestures

  function feed(ev) {
    const r = reduceGesture(gesture, ev);
    gesture = r.state;
    clearTimeout(wakeTimer);
    if (r.wakeAt != null) {
      wakeTimer = setTimeout(() => feed({ type: 'tick', t: performance.now() }), Math.max(0, r.wakeAt - performance.now()));
    }
    for (const g of r.gestures) dispatch(g);
  }

  function localXY(e) {
    const b = stage.getBoundingClientRect();
    return [e.clientX - b.left, e.clientY - b.top];
  }

  stage.addEventListener('pointerdown', (e) => {
    if (!current()) return;
    stage.setPointerCapture(e.pointerId);
    const [x, y] = localXY(e);
    const target = tool.hitTarget?.(ed, x, y) ?? 'photo';
    feed({ type: 'down', id: e.pointerId, x, y, t: e.timeStamp, target, axis: tool.dragAxis?.(ed) ?? 'free' });
  });
  stage.addEventListener('pointermove', (e) => {
    if (!current()) return;
    const evs = e.getCoalescedEvents?.() ?? [];
    const list = evs.length ? evs : [e];
    for (const ce of list) {
      const [x, y] = localXY(ce);
      feed({ type: 'move', id: e.pointerId, x, y, t: ce.timeStamp || e.timeStamp });
    }
  });
  const up = (e) => {
    if (!current()) return;
    const [x, y] = localXY(e);
    feed({ type: e.type === 'pointercancel' ? 'cancel' : 'up', id: e.pointerId, x, y, t: e.timeStamp });
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  stage.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });

  function dispatch(g) {
    if (g.type === 'pinch-start') {
      if (tool.onGesture?.(ed, g)) return;
      pinch = { view: { ...view } };
      return;
    }
    if (g.type === 'pinch') {
      if (g.onCaption && tool.onGesture?.(ed, g)) return;
      if (!pinch || content().mode === 'frame') return;
      let v = zoomAt(pinch.view, g.scale, g.originX, g.originY);
      v = panBy(v, g.dx, g.dy);
      view = v;
      requestRender();
      return;
    }
    if (g.type === 'pinch-end') {
      if (tool.onGesture?.(ed, g)) return;
      pinch = null;
      if (view && content().mode === 'output') {
        const s = stageRect();
        const c = content();
        view = clampView(view, c.width, c.height, s.width, s.height);
        if (view.scale < view.fit * 1.02) view = fitView(c.width, c.height, s.width, s.height, STAGE_MARGIN);
        requestRender();
      }
      ed.hint('pinch');
      return;
    }
    if (g.type === 'hold-start' && !tool.claimsHold) {
      compare = { mode: 'before', x: g.x, from: [g.x, g.y] };
      ed.hint('hold-photo', { tool: toolId });
      requestRender();
      return;
    }
    if (g.type === 'hold-move' && compare.mode !== 'off') {
      // A resting finger drifts a point or two: only a real slide starts the wipe.
      if (compare.from && Math.hypot(g.x - compare.from[0], g.y - compare.from[1]) <= SLOP) return;
      compare = { mode: 'wipe', x: g.x };
      requestRender();
      return;
    }
    if (g.type === 'hold-end' && compare.mode !== 'off') {
      compare = { mode: 'off', x: 0 };
      requestRender();
      return;
    }
    // SPEC F11: a caption tapped in any other tool opens Text with it selected.
    if (g.type === 'tap' && toolId !== 'text' && typeof g.target === 'string' && g.target.startsWith('caption:')) {
      if (!tool.onGesture?.(ed, g)) openTool('text', { select: g.target.slice(8) });
      return;
    }
    tool.onGesture?.(ed, g);
  }

  // ------------------------------------------------------------------ chrome

  function toast(text, ms = 1200) {
    toastEl.textContent = text;
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), ms);
  }

  undoBtn.addEventListener('click', () => {
    if (!H.canUndo(hist)) return;
    const label = H.undoLabel(hist);
    liveState = null;
    hist = H.undo(hist);
    revision++;
    syncGpu(current());
    tool.onHistory?.(ed);
    afterChange();
    if (label) toast(`Undid: ${label}`);
    ed.hint('undo');
  });
  redoBtn.addEventListener('click', () => {
    if (!H.canRedo(hist)) return;
    const label = H.redoLabel(hist);
    liveState = null;
    hist = H.redo(hist);
    revision++;
    syncGpu(current());
    tool.onHistory?.(ed);
    afterChange();
    if (label) toast(`Redid: ${label}`);
  });

  // Before: hold to compare; a tap shows it briefly and says how.
  let beforeDown = 0;
  let beforeTimer = 0;
  beforeBtn.addEventListener('pointerdown', (e) => {
    if (!current()) return;
    beforeBtn.setPointerCapture(e.pointerId);
    beforeDown = e.timeStamp;
    clearTimeout(beforeTimer);
    compare = { mode: 'before', x: 0 };
    beforeBtn.setAttribute('aria-pressed', 'true');
    requestRender();
  });
  const beforeUp = (e) => {
    if (!beforeDown) return;
    const held = e.timeStamp - beforeDown;
    beforeDown = 0;
    const off = () => {
      compare = { mode: 'off', x: 0 };
      beforeBtn.setAttribute('aria-pressed', 'false');
      requestRender();
    };
    if (held < 250 && e.type === 'pointerup') {
      ed.hint('before-tap');
      toast('Hold to compare', BEFORE_TAP_MS);
      beforeTimer = setTimeout(off, BEFORE_TAP_MS);
    } else {
      if (held >= 250) ed.hint('before-hold');
      off();
    }
  };
  beforeBtn.addEventListener('pointerup', beforeUp);
  beforeBtn.addEventListener('pointercancel', beforeUp);
  // keyboard / VoiceOver: activate toggles a timed peek
  beforeBtn.addEventListener('click', (e) => {
    if (e.detail !== 0 || !current()) return;
    compare = { mode: 'before', x: 0 };
    requestRender();
    clearTimeout(beforeTimer);
    beforeTimer = setTimeout(() => { compare = { mode: 'off', x: 0 }; requestRender(); }, BEFORE_TAP_MS);
  });

  for (const b of dockButtons) {
    b.addEventListener('click', () => {
      if (!current()) { root.querySelector('#file').click(); return; }
      openTool(b.dataset.tool);
    });
  }

  saveBtn.addEventListener('click', async () => {
    if (!current()) return;
    // A step still computing (a Remove fill, even one left running by Done) lands
    // first, so the saved copy has it. Sharing needs its own tap on the sheet, so
    // waiting here costs no user activation.
    const pending = Object.values(tools).map((t) => t?.settle?.(ed)).filter(Boolean);
    if (toolId !== 'home') closeTool({ cancel: false, hint: false });
    if (pending.length) {
      const busy = root.querySelector('#busy');
      busy.hidden = false;
      busy.querySelector('span').textContent = 'Finishing…';
      try { await Promise.all(pending); } finally { busy.hidden = true; }
    }
    onSave?.(ed);
  });

  zoomPill.addEventListener('click', () => {
    viewKey = '';
    requestRender();
  });

  window.addEventListener('resize', () => { viewKey = ''; requestRender(); });
  new ResizeObserver(() => { viewKey = ''; requestRender(); }).observe(stage);

  // ------------------------------------------------------------------ the api tools use

  const ed = {
    get doc() { return shown(); },
    get committed() { return current(); },
    get toolId() { return toolId; },
    get session() { return session; },
    get history() { return hist; },
    get pools() { return pools; },
    set pools(p) { pools = p; },
    tiles,
    renderer,
    panel,
    get view() { return view; },
    get loupe() { return loupe; },
    get sourceInfo() { return sourceInfo; },
    get revision() { return revision; },
    markSaved() {
      savedState = current();
      statusEl.textContent = 'Saved';
      store?.schedule?.(); // persist "in Photos" so a relaunch doesn't ask to save again
    },
    get isSaved() { return inPhotos(); },
    live: setLive,
    commit,
    refresh,
    toast,
    openTool,
    closeTool,
    commitBelow,
    requestRender,
    stageSize: stageRect,
    stageToDoc,
    docToStage,
    stageToSource,
    sourcePerStagePx,
    outputSize: () => outputSize(shown().crop),

    // The cropped photo, small: { width, height, data }. tone: false for analysis
    // (Auto reads the photo, not its own edits); `state` overrides the shown one
    // (look thumbnails); `rect` (output px) reads just that part, scaled so its
    // long side is maxSide (the loupe).
    readOutput({ maxSide = 512, tone = false, state = null, before = false, rect = null } = {}) {
      const st = state ?? shown();
      const o = outputSize(st.crop);
      const r = rect ?? { x: 0, y: 0, w: o.width, h: o.height };
      const s = rect ? maxSide / Math.max(r.w, r.h) : Math.min(1, maxSide / Math.max(o.width, o.height));
      const w = Math.max(1, Math.round(r.w * s)), h = Math.max(1, Math.round(r.h * s));
      const quad = outputQuad(st.crop, st.source.w, st.source.h, o.width, o.height, [s, 0, 0, s, -r.x * s, -r.y * s]);
      const { adjust, look } = developInput(st);
      const data = renderer.renderPixels({ width: w, height: h, quad, uniforms: developUniforms(resolve(adjust, look)), grainScale: [o.width, o.height], tone, before });
      return { width: w, height: h, data };
    },
    resetView() { viewKey = ''; requestRender(); },
    // Pan/zoom from elsewhere (the zoom navigator), kept inside the content.
    setView(v) {
      if (!view) return;
      const c = content();
      const s = stageRect();
      view = clampView({ ...view, ...v }, c.width, c.height, s.width, s.height);
      requestRender();
    },
    setCompare(mode, x = 0) { compare = { mode, x }; requestRender(); },
    hint(event, data) { hints?.event(event, data); },
    // Persist a Remove fill tile before the history step that references it.
    saveTile(id, rgba, meta) { return store?.saveTile?.(id, rgba, meta); },
    rebuildBlur,

    // Start editing a freshly imported photo.
    begin({ id, info, now }) {
      dropTool();
      sourceInfo = info;
      const doc = createDoc({ id, sourceType: info.type, natW: info.natW, natH: info.natH, w: renderer.size.width, h: renderer.size.height, now });
      hist = H.createHistory(doc);
      pools = { strokes: {}, patches: {} };
      tiles.clear();
      liveState = null;
      applied = null;
      revision = 0;
      savedState = null;
      syncGpu(doc);
      rebuildBlur();
      app.dataset.state = 'editing';
      for (const b of [undoBtn, redoBtn, beforeBtn, saveBtn]) b.disabled = false;
      toolId = 'home';
      tool = tools.home;
      tool.open?.(ed, {});
      viewKey = '';
      afterChange();
    },

    // Resume a stored draft (history + pools + tiles already loaded).
    resume({ info, history, pools: p, tiles: t, savedRevision: sr }) {
      dropTool();
      sourceInfo = info;
      hist = history;
      pools = p;
      tiles.clear();
      for (const [k, v] of t) tiles.set(k, v);
      liveState = null;
      applied = null;
      revision = 0;
      savedState = sr ? current() : null;
      syncGpu(current());
      rebuildBlur();
      app.dataset.state = 'editing';
      for (const b of [undoBtn, redoBtn, beforeBtn, saveBtn]) b.disabled = false;
      toolId = 'home';
      tool = tools.home;
      tool.open?.(ed, {});
      viewKey = '';
      afterChange();
    },

    // After a lost WebGL context is restored and the source re-uploaded.
    resync() {
      applied = null;
      syncGpu(shown());
      rebuildBlur();
      requestRender();
    },

    // Put the paint mask back to the strokes of the state on screen (a stroke cut
    // short leaves dabs behind). Fills and the blur map are untouched.
    replayPaint() {
      if (applied) replayPaint(applied.paint);
      requestRender();
    },

    // Jump to any history step (rewind tape).
    jumpTo(i) {
      const next = H.jumpTo(hist, i);
      if (next === hist) return; // already there: no new revision, no autosave
      liveState = null;
      hist = next;
      revision++;
      syncGpu(current());
      tool.onHistory?.(ed);
      afterChange();
    },

    serialize() {
      return { history: H.serialize(hist), pools, savedRevision: inPhotos() };
    },

    newPhoto() { onNewPhoto?.(ed); },

    // Before a flush (the app is going to the background): words being typed become a step.
    commitTyping() { tool.commitTyping?.(ed); },
  };

  return ed;
}
