// The Outline magnifier (SPEC F19): a 140 pt rounded window in a top corner of
// the stage showing the photo around the finger at 3x, with the snapped path and
// its anchors drawn magnified, a crosshair where the finger is and a faint dotted
// ring for the snap reach. It is a corner window, not a loupe under the finger,
// so the hand never covers it. Drawn on the overlay canvas from the tool's
// drawOverlay (no DOM). Pixels come from ed.readOutput (the loupe's path), read
// at most once per frame and only when the finger has moved more than 2 pt or
// the photo changed (ed.revision). Placement is lib/magnifier.js: top-left,
// jumping to the top-right when the finger comes within 40 pt of it, with a dead
// band so it never flickers.
//
// API — from a tool while Outline is on (ui/tools/*.js import ../magnifier.js):
//
//   const mag = createMagnifier(ed);              // keep one per tool
//
//   drag-start:   mag.begin({ x: g.x, y: g.y });  // stage pt: the window appears
//   drag:         mag.move({ x: g.x, y: g.y });   // then ed.requestRender() as usual
//   drag-end:     mag.end();                      // freezes, fades out over 300 ms, then costs nothing
//   drag-cancel:  mag.cancel();                   // gone at once (a second finger landed)
//   close(ed):    mag.dispose();                  // frees the pixel cache
//
//   drawOverlay(ed, ctx) {
//     drawTrace(ctx, { path, anchors });          // optional: the loop on the stage at 1x, same look
//     mag.draw(ctx, { path, anchors, snapRadius }); // the window; call it last so it sits on top
//   }
//
// `path` and `anchors` are flat [x0, y0, x1, y1, …] arrays in STAGE pt (map the
// lasso's analysis px through ed.docToStage first); `closed: true` closes the
// path. `snapRadius` is the snap reach on screen in stage pt (18). `paint(ctx)`
// may be given instead of, or as well as, path+anchors: it is called under the
// 3x transform to draw anything else in stage pt. `now` (performance.now()) may
// be handed in for a deterministic fade. `mag.active` is true from begin() until
// the fade ends; draw() returns at once when it is false. While fading, draw()
// asks the editor for the next frame itself and shows the last frame it drew, so
// the tool needs no timer and may pass nothing. Nothing runs per frame when idle.

import {
  SIZE, RADIUS, MAG, windowRect, initialCorner, pickCorner, sourceRect, readSide, magnifyTransform, fadeAlpha, movedFar,
} from '../lib/magnifier.js';

const ACCENT = '#ff7a2f'; // the line, as approved in the mock
const LINE_SHADOW = 'rgba(0, 0, 0, 0.55)';
const ANCHOR = '#ffffff';
const ANCHOR_EDGE = 'rgba(0, 0, 0, 0.6)';
const GROUND = '#0d0c0b'; // --ground: what shows past the photo's edge
const BORDER = 'rgba(255, 255, 255, 0.92)';
const CROSS = 'rgba(255, 255, 255, 0.9)';
const REACH = 'rgba(255, 255, 255, 0.55)';
const LABEL = 'rgba(255, 255, 255, 0.85)';
const SHADOW = 'rgba(0, 0, 0, 0.65)';
const SHADOW_BLUR = 18;
const SHADOW_DY = 4;
const SHADOW_PAD = SHADOW_BLUR + SHADOW_DY + 6; // room for the blur around the pre-rendered shadow
const CROSS_ARM = 9;
const TAU = Math.PI * 2;

export function createMagnifier(ed) {
  let active = false;
  let corner = 'left';
  let finger = null; // stage pt, where the finger is (or was)
  let endedAt = null; // performance.now() at lift, while fading
  let cache = null; // what the pixels were read for: { finger, revision, view, src } (src null = no photo in reach)
  let pixels = null; // offscreen canvas holding the readback
  let shadow = null; // { canvas, dpr } the drop shadow, rendered once
  let frozen = null; // the last draw() content, shown while fading

  const dpr = () => window.devicePixelRatio || 1;

  function hide() {
    active = false;
    endedAt = null;
    cache = null;
    frozen = null;
    if (pixels) pixels.width = pixels.height = 0; // SPEC §6: free canvas memory outright
  }

  // Read the photo around the finger. The window is then drawn around this
  // finger position until it moves > 2 pt, so pixels, path and crosshair agree.
  function read() {
    const view = ed.view;
    const src = sourceRect(finger, view, ed.outputSize());
    cache = { finger: { ...finger }, revision: ed.revision, view: { scale: view.scale, x: view.x, y: view.y }, src: null };
    if (!src) return;
    let img;
    try {
      img = ed.readOutput({ rect: src.rect, maxSide: readSide(src, dpr()), tone: true });
    } catch {
      return; // the context is lost or the photo not back yet: the window shows its ground
    }
    pixels ??= document.createElement('canvas');
    if (pixels.width !== img.width || pixels.height !== img.height) {
      pixels.width = img.width;
      pixels.height = img.height;
    }
    pixels.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
    cache.src = src;
  }

  function stale() {
    if (!cache) return true;
    if (cache.revision !== ed.revision) return true;
    const v = ed.view;
    if (cache.view.scale !== v.scale || cache.view.x !== v.x || cache.view.y !== v.y) return true;
    return movedFar(cache.finger, finger);
  }

  // The shadow is a blur: rendered once, drawn per frame as a bitmap.
  function shadowBitmap() {
    const d = dpr();
    if (shadow?.dpr === d) return shadow.canvas;
    const side = SIZE + 2 * SHADOW_PAD;
    const c = shadow?.canvas ?? document.createElement('canvas');
    c.width = c.height = Math.round(side * d);
    const g = c.getContext('2d');
    g.setTransform(d, 0, 0, d, 0, 0);
    g.shadowColor = SHADOW;
    g.shadowBlur = SHADOW_BLUR;
    g.shadowOffsetY = SHADOW_DY;
    g.fillStyle = '#000';
    roundRect(g, { x: SHADOW_PAD, y: SHADOW_PAD, w: SIZE, h: SIZE });
    g.fill();
    g.shadowColor = 'transparent';
    g.globalCompositeOperation = 'destination-out';
    roundRect(g, { x: SHADOW_PAD, y: SHADOW_PAD, w: SIZE, h: SIZE });
    g.fill(); // only the halo stays; the window itself is painted opaque on top
    shadow = { canvas: c, dpr: d };
    return c;
  }

  return {
    get active() { return active; },
    get corner() { return corner; },

    begin(p) {
      finger = { x: p.x, y: p.y };
      corner = initialCorner(p.x, p.y, ed.stageSize().width);
      active = true;
      endedAt = null;
      cache = null;
      frozen = null;
    },

    move(p) {
      if (!active || endedAt !== null) return;
      finger = { x: p.x, y: p.y };
      corner = pickCorner(corner, p.x, p.y, ed.stageSize().width);
    },

    end() {
      if (!active || endedAt !== null) return;
      endedAt = performance.now();
      ed.requestRender();
    },

    cancel: hide,

    dispose() {
      hide();
      if (shadow) shadow.canvas.width = shadow.canvas.height = 0;
      shadow = null;
      pixels = null;
    },

    draw(ctx, opts = {}) {
      if (!active || !finger) return;
      const now = opts.now ?? performance.now();
      const alpha = fadeAlpha(now, endedAt);
      if (alpha <= 0) { hide(); return; }
      const fading = endedAt !== null;
      // While fading the content is whatever the tool last showed, unless it hands in more.
      const content = !fading || opts.path || opts.paint ? opts : frozen ?? opts;
      if (!fading) frozen = { path: opts.path, anchors: opts.anchors, closed: opts.closed, snapRadius: opts.snapRadius, paint: opts.paint };
      if (!fading && stale()) read();
      else if (!cache) read();
      const at = cache.finger;
      const r = windowRect(corner, ed.stageSize().width);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.setLineDash([]);
      ctx.drawImage(shadowBitmap(), r.x - SHADOW_PAD, r.y - SHADOW_PAD, SIZE + 2 * SHADOW_PAD, SIZE + 2 * SHADOW_PAD);
      roundRect(ctx, r);
      ctx.fillStyle = GROUND;
      ctx.fill();

      ctx.save();
      roundRect(ctx, r);
      ctx.clip();
      const src = cache.src;
      if (src && pixels?.width) {
        ctx.drawImage(pixels, 0, 0, pixels.width, pixels.height, r.x + src.dest.x, r.y + src.dest.y, src.dest.w, src.dest.h);
      }
      ctx.transform(...magnifyTransform(r, at, MAG));
      if (content.path || content.anchors) drawTrace(ctx, content, 1.1);
      content.paint?.(ctx);
      if (content.snapRadius > 0) {
        ctx.beginPath();
        ctx.arc(at.x, at.y, content.snapRadius, 0, TAU);
        ctx.setLineDash([2, 3]);
        ctx.lineWidth = 0.6;
        ctx.strokeStyle = REACH;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();

      roundRect(ctx, r);
      ctx.lineWidth = 2;
      ctx.strokeStyle = BORDER;
      ctx.stroke();
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      ctx.beginPath();
      ctx.moveTo(cx - CROSS_ARM, cy);
      ctx.lineTo(cx + CROSS_ARM, cy);
      ctx.moveTo(cx, cy - CROSS_ARM);
      ctx.lineTo(cx, cy + CROSS_ARM);
      ctx.lineWidth = 1;
      ctx.strokeStyle = CROSS;
      ctx.stroke();
      ctx.font = '600 11px -apple-system, "SF Pro Text", system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = LABEL;
      ctx.fillText(`${MAG}×`, r.x + r.w - 9, r.y + r.h - 8);
      ctx.restore();

      if (fading) ed.requestRender(); // the next step of the fade; nothing once it ends
    },
  };
}

// The traced loop as the mock shows it: an accent line over a dark halo, with a
// white dot at each anchor. `lw` is the line width in the ctx's units (2 on the
// stage; 1.1 under the magnifier's 3x). Stage pt in, flat [x, y, …]. A live
// path is the lasso's pixel staircase, which 3x makes plain, so an open path is
// drawn through its midpoints (`smooth`, within half a step of the real path);
// a closed polygon is the selection itself and is drawn exactly.
export function drawTrace(ctx, { path = null, anchors = null, closed = false, smooth = !closed } = {}, lw = 2) {
  if (path && path.length >= 4) {
    ctx.beginPath();
    tracePath(ctx, path, closed, smooth);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash([]);
    ctx.lineWidth = lw * 2.5;
    ctx.strokeStyle = LINE_SHADOW;
    ctx.stroke();
    ctx.lineWidth = lw;
    ctx.strokeStyle = ACCENT;
    ctx.stroke();
  }
  if (anchors) {
    for (let i = 0; i + 1 < anchors.length; i += 2) {
      ctx.beginPath();
      ctx.arc(anchors[i], anchors[i + 1], lw * 1.3, 0, TAU);
      ctx.fillStyle = ANCHOR;
      ctx.fill();
      ctx.lineWidth = lw * 0.5;
      ctx.strokeStyle = ANCHOR_EDGE;
      ctx.stroke();
    }
  }
}

function tracePath(ctx, path, closed, smooth) {
  const n = path.length >> 1;
  ctx.moveTo(path[0], path[1]);
  if (smooth && n >= 3) {
    for (let i = 1; i < n - 1; i++) {
      const x = path[2 * i], y = path[2 * i + 1];
      ctx.quadraticCurveTo(x, y, (x + path[2 * i + 2]) / 2, (y + path[2 * i + 3]) / 2);
    }
    ctx.lineTo(path[2 * n - 2], path[2 * n - 1]);
  } else {
    for (let i = 1; i < n; i++) ctx.lineTo(path[2 * i], path[2 * i + 1]);
  }
  if (closed) ctx.closePath();
}

// ctx.roundRect is new enough in Safari that a path by hand is safer.
function roundRect(ctx, r, radius = RADIUS) {
  const { x, y, w, h } = r;
  const k = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}
