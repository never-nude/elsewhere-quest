// Captions on the stage and in the export, painted by one routine so the preview
// is the export: lib/text-layout.js lays each caption out at the full output size
// (so lines wrap at the same words everywhere) and the stage draws that same layout
// scaled by the view.
//
// createCaptions(ed) -> {
//   draw(ctx, alpha)        every caption of ed.doc on the stage overlay (ctx in stage
//                           CSS px with devicePixelRatio applied). While Text is open
//                           the selected caption gets a dashed 1pt box and a 12pt
//                           round handle on its bottom-right corner.
//   hit(x, y)               stage CSS px -> 'caption:<id>' | null, topmost first
//   rasterize(doc, outW, outH, band?, scale?) -> canvas | null
//                           transparent, output px, every caption drawn. `band`
//                           ({ x, y, width, height } in output px) draws only that
//                           part, so an export can work band by band in less memory.
//                           `scale` (default 1) draws it smaller, canvas px per output
//                           px, for a preview: the layout stays at outW x outH, so the
//                           preview wraps at the same words as the export.
//                           null when the doc has no captions: nothing to composite.
//                           Each call makes a new canvas; free it with release()
//                           once composited: iOS holds canvas memory until GC, and
//                           an output-size raster is up to ~100 MB.
//   release(canvas)         frees a raster's pixels now (width = height = 0)
//   layout(caption, outW, outH)    the cached layout (Text's handle drag needs it)
//   select(id), selected           the caption the Text tool has selected
//   handleAt(id) -> [x, y] | null  stage CSS px of that caption's corner handle
//   sample(canvas, styleId, color, alpha?)  an "Aa" in a style, for the Quick row
// }

import { layoutCaption, captionMatrix, captionPaint, captionBounds, hitCaption, cornerHandle } from '../lib/text-layout.js';

const HIT_SLOP_PT = 12;
const HANDLE_R = 6; // a 12pt disc
const LAYOUT_CACHE_MAX = 256;

export function createCaptions(ed) {
  let selectedId = null;
  const cache = new Map();
  let mctx = null;
  let mfont = '';

  function measure(text, font) {
    if (!mctx) mctx = makeCanvas(1, 1).getContext('2d');
    if (font !== mfont) {
      mctx.font = font;
      mfont = font;
    }
    return mctx.measureText(text).width;
  }

  // Layout depends only on these, so drags (which move cx/cy/angle) hit the cache.
  function layoutOf(cap, outW, outH) {
    const key = `${outW}x${outH}\u0000${cap.style}\u0000${cap.size}\u0000${cap.text}`;
    let lay = cache.get(key);
    if (!lay) {
      if (cache.size >= LAYOUT_CACHE_MAX) cache.clear();
      lay = layoutCaption(cap, outW, outH, measure);
      cache.set(key, lay);
    }
    return lay;
  }

  // Output px -> stage CSS px for the current view (Text and the tools that show
  // captions all use the output view).
  function toStage(x, y) {
    const v = ed.view;
    return [v.x + x * v.scale, v.y + y * v.scale];
  }

  function draw(ctx, alpha = 1) {
    const doc = ed.doc;
    const v = ed.view;
    if (!v || !Array.isArray(doc?.text) || doc.text.length === 0) return;
    const { width: W, height: H } = ed.outputSize();
    const t = ctx.getTransform();
    const device = Math.hypot(t.a, t.b) || 1; // device px per stage px
    ctx.save();
    ctx.globalAlpha = alpha;
    for (const cap of doc.text) {
      const lay = layoutOf(cap, W, H);
      const m = captionMatrix(cap, lay, W, H);
      ctx.save();
      ctx.transform(v.scale, 0, 0, v.scale, v.x, v.y);
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
      paintCaption(ctx, cap, lay, device * v.scale);
      ctx.restore();
    }
    ctx.restore();
    if (ed.toolId === 'text' && selectedId) {
      const cap = doc.text.find((c) => c.id === selectedId);
      if (cap) drawSelection(ctx, cap, layoutOf(cap, W, H), W, H, device);
    }
  }

  function drawSelection(ctx, cap, lay, W, H, device) {
    const m = captionMatrix(cap, lay, W, H);
    const corners = [[0, 0], [lay.boxW, 0], [lay.boxW, lay.boxH], [0, lay.boxH]]
      .map(([x, y]) => toStage(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]));
    ctx.save();
    ctx.beginPath();
    corners.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    // A dark underlay keeps the white dashes visible on a white wall or sky.
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
    const [hx, hy] = corners[2];
    ctx.beginPath();
    ctx.arc(hx, hy, HANDLE_R, 0, Math.PI * 2);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = 4 * device;
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  function hit(x, y) {
    const doc = ed.doc;
    const v = ed.view;
    if (!v || !Array.isArray(doc?.text) || doc.text.length === 0) return null;
    const { width: W, height: H } = ed.outputSize();
    const [ox, oy] = ed.stageToDoc(x, y);
    const layouts = doc.text.map((c) => layoutOf(c, W, H));
    const id = hitCaption(doc.text, layouts, ox, oy, W, H, HIT_SLOP_PT / v.scale);
    return id === null ? null : `caption:${id}`;
  }

  function rasterize(doc, outW, outH, band = null, scale = 1) {
    const list = doc?.text;
    if (!Array.isArray(list) || list.length === 0) return null;
    const b = band ?? { x: 0, y: 0, width: outW, height: outH };
    const k = Number.isFinite(scale) && scale > 0 ? scale : 1;
    const canvas = makeCanvas(Math.max(1, Math.round(b.width * k)), Math.max(1, Math.round(b.height * k)));
    // Read back once with getImageData: a CPU-backed canvas skips a GPU readback,
    // and every band's strip then rasterizes the same way (no step at a seam).
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // Saving without the words would be a silent loss; fail the export instead.
    if (!ctx) throw new Error('captions: no 2D context for the export raster');
    for (const cap of list) {
      const lay = layoutOf(cap, outW, outH);
      // Skip captions that cannot reach this band, their shadow included.
      const bb = captionBounds(cap, lay, outW, outH);
      const m = lay.fontPx * 0.5;
      if (bb.x - m > b.x + b.width || bb.x + bb.width + m < b.x || bb.y - m > b.y + b.height || bb.y + bb.height + m < b.y) continue;
      const mm = captionMatrix(cap, lay, outW, outH);
      ctx.save();
      ctx.setTransform(k, 0, 0, k, -b.x * k, -b.y * k);
      ctx.transform(mm[0], mm[1], mm[2], mm[3], mm[4], mm[5]);
      paintCaption(ctx, cap, lay, k);
      ctx.restore();
    }
    return canvas;
  }

  function handleAt(id) {
    const doc = ed.doc;
    if (!ed.view || !Array.isArray(doc?.text)) return null;
    const cap = doc.text.find((c) => c.id === id);
    if (!cap) return null;
    const { width: W, height: H } = ed.outputSize();
    const p = cornerHandle(cap, layoutOf(cap, W, H), W, H);
    return toStage(p.x, p.y);
  }

  // "Aa" centred in the chip's canvas (its own pixels, already sized by the caller).
  // `alpha` dims it with the chip when no caption is selected.
  function sample(canvas, styleId, color, alpha = 1) {
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = alpha;
    const size = 0.1;
    const side = Math.max(10, (h * 0.6) / size); // font px = 60% of the chip's height
    const cap = { id: 'sample', text: 'Aa', style: styleId, color, cx: 0.5, cy: 0.5, size, angle: 0 };
    const lay = layoutOf(cap, side, side);
    const k = Math.min(1, (w - 2) / lay.boxW, (h - 2) / lay.boxH);
    ctx.setTransform(k, 0, 0, k, (w - lay.boxW * k) / 2, (h - lay.boxH * k) / 2);
    paintCaption(ctx, cap, lay, k);
  }

  function release(canvas) {
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
  }

  return {
    draw,
    hit,
    rasterize,
    release,
    layout: layoutOf,
    select(id) { selectedId = id ?? null; },
    get selected() { return selectedId; },
    handleAt,
    sample,
  };
}

// Draw one caption in its own box px (the context already maps box px to the
// target). `scale` is device px per box px, for the shadow, which canvas applies
// untransformed.
function paintCaption(ctx, cap, lay, scale) {
  const p = captionPaint(cap, lay, scale);
  if (p.box) {
    ctx.fillStyle = p.box;
    roundRect(ctx, 0, 0, lay.boxW, lay.boxH, lay.radius);
    ctx.fill();
  }
  if (lay.empty) return;
  ctx.font = lay.font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = p.ink;
  if (p.shadow) {
    ctx.shadowColor = p.shadow.color;
    ctx.shadowBlur = p.shadow.blur;
    ctx.shadowOffsetX = p.shadow.offsetX;
    ctx.shadowOffsetY = p.shadow.offsetY;
  }
  for (let i = 0; i < lay.lines.length; i++) {
    if (lay.lines[i]) ctx.fillText(lay.lines[i], lay.boxW / 2, lay.pad + (i + 0.5) * lay.lineHeight);
  }
  if (p.shadow) ctx.shadowColor = 'transparent';
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// A DOM canvas where there is a document (WebGL uploads and drawImage take it
// everywhere), an OffscreenCanvas in a worker.
function makeCanvas(w, h) {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
}
