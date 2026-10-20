// Captions: how a caption is laid out, where it sits on the photo, and how a
// finger moves, scales and turns it. Pure: text measurement is injected as
// measure(text, fontCss) -> width px (canvas measureText in the app, a fake in
// tests), so nothing here touches the DOM.
//
// Units. A caption stores normalized numbers so it survives crops and exports at
// any size:
//   cx, cy  centre, 0..1 of the OUTPUT width / height (the cropped result)
//   size    font px / the output's short side
//   angle   degrees, clockwise on screen (the same sense as canvas rotate)
// Everything this module returns is in output px, origin top-left. Lay out at the
// full output size and let the preview draw that same layout scaled down: wrapping
// then breaks at the same words on screen and in the exported JPEG.
//
// Box px: a caption's own rectangle, origin top-left, boxW x boxH. Line i is drawn
// centred at (boxW / 2, pad + (i + 0.5) * lineHeight) with textAlign 'center' and
// textBaseline 'middle'; captionMatrix places the box on the output.
//
// Matrices are 2D affine [a, b, c, d, e, f] (x' = a*x + c*y + e, y' = b*x + d*y + f),
// the same order as lib/geometry.js and CanvasRenderingContext2D.setTransform.

// Same range and default as lib/doc.js's textSize dial (a test keeps them in step).
export const SIZE_MIN = 0.03;
export const SIZE_MAX = 0.3;
export const SIZE_DEFAULT = 0.08;

// Lines wrap so the whole box, padding included, stays within 85% of the output
// width: a centred caption keeps a visible margin on both sides.
export const WRAP_FRACTION = 0.85;
export const LINE_HEIGHT = 1.2; // em
export const PAD = 0.3; // em, room for the Box fill and the shadow's blur
export const BOX_RADIUS = 0.25; // em
// An empty caption still needs a box to see, select and hit; this is its width.
export const EMPTY_WIDTH = 2; // em

export const ANGLE_DETENTS = Object.freeze([-90, 0, 90]);
export const ANGLE_DETENT_DEG = 3;
export const SNAP_TARGETS = Object.freeze([1 / 3, 1 / 2, 2 / 3]);

// Below this many px from the caption's centre a drag has no usable direction or
// scale, so it changes nothing rather than spinning wildly.
const MIN_RADIUS = 1;

// §8 type: system stacks only. The generic fallbacks matter because a canvas may
// not resolve ui-serif / ui-rounded (risk table): Georgia and system-ui then step in.
const SANS = 'system-ui, -apple-system, "Helvetica Neue", sans-serif';
const SERIF = 'ui-serif, "New York", Georgia, serif';
const ROUNDED = 'ui-rounded, system-ui, -apple-system, sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';

const style = (id, label, family, weight, { box = false, shadow = true } = {}) =>
  Object.freeze({ id, label, family, weight, box, shadow });

// Quick-row order. Every style but Box casts a soft shadow so light words stay
// readable on a bright photo; Box puts the words on a filled rounded box instead.
export const STYLES = Object.freeze([
  style('classic', 'Classic', SANS, 600),
  style('bold', 'Bold', SANS, 800),
  style('box', 'Box', SANS, 700, { box: true, shadow: false }),
  style('serif', 'Serif', SERIF, 600),
  style('mono', 'Mono', MONO, 500),
  style('round', 'Round', ROUNDED, 700),
]);

const STYLE_BY_ID = new Map(STYLES.map((s) => [s.id, s]));

// Unknown ids fall back to Classic: a caption always draws.
export function styleById(id) {
  return STYLE_BY_ID.get(id) ?? STYLES[0];
}

// §F11's eight swatches, white first (the default caption colour). iOS system
// colours, which stay vivid on top of a photo.
export const SWATCHES = Object.freeze([
  Object.freeze({ id: 'white', label: 'White', hex: '#ffffff' }),
  Object.freeze({ id: 'black', label: 'Black', hex: '#000000' }),
  Object.freeze({ id: 'yellow', label: 'Yellow', hex: '#ffd60a' }),
  Object.freeze({ id: 'orange', label: 'Orange', hex: '#ff9f0a' }),
  Object.freeze({ id: 'red', label: 'Red', hex: '#ff453a' }),
  Object.freeze({ id: 'pink', label: 'Pink', hex: '#ff375f' }),
  Object.freeze({ id: 'blue', label: 'Blue', hex: '#0a84ff' }),
  Object.freeze({ id: 'green', label: 'Green', hex: '#30d158' }),
]);

export const PLACEHOLDER_TEXT = 'Your words';

// The caption the Text tool creates (§F11): "Your words", centred, 78% down.
export function newCaption(id) {
  return {
    id,
    text: PLACEHOLDER_TEXT,
    style: 'classic',
    color: SWATCHES[0].hex,
    cx: 0.5,
    cy: 0.78,
    size: SIZE_DEFAULT,
    angle: 0,
  };
}

// ------------------------------------------------------------------ layout

// Grapheme clusters, so a forced break inside a long word never splits an emoji,
// a flag or an accented letter. Array.from (code points) is the fallback.
const SEGMENTER = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('en', { granularity: 'grapheme' })
  : null;

function graphemes(s) {
  return SEGMENTER ? Array.from(SEGMENTER.segment(s), (g) => g.segment) : Array.from(s);
}

// Words are laid out like CSS `white-space: pre-line`: typed newlines are kept,
// runs of spaces collapse and spaces at line ends vanish, so a centred line is
// centred on its ink and a trailing space never nudges it.
export function layoutCaption(caption, outW, outH, measure) {
  checkSize(outW, outH, 'layoutCaption');
  const st = styleById(caption?.style);
  const fontPx = Math.max(1, round(sizeOf(caption) * Math.min(outW, outH), 100));
  const font = `${st.weight} ${fontPx}px ${st.family}`;
  const pad = fontPx * PAD;
  const lineHeight = fontPx * LINE_HEIGHT;

  // Without a measurer, estimate: good enough for tests and for a first frame
  // before fonts load, never used for the final raster.
  const raw = typeof measure === 'function' ? measure : (t) => graphemes(t).length * fontPx * 0.6;
  const cache = new Map();
  const width = (t) => {
    if (t === '') return 0;
    let w = cache.get(t);
    if (w === undefined) {
      w = Number(raw(t, font));
      if (!(Number.isFinite(w) && w > 0)) w = 0;
      cache.set(t, w);
    }
    return w;
  };

  // Never narrower than one em. Unreachable while size <= 0.3 of the short side,
  // but it keeps a future size range from wrapping every glyph onto its own line.
  const limit = Math.max(fontPx, outW * WRAP_FRACTION - 2 * pad);
  const text = typeof caption?.text === 'string' ? caption.text : '';
  const lines = [];
  for (const para of text.split(/\r\n|\r|\n/)) {
    // No-break spaces are not split on: they exist to hold words together.
    const words = para.split(/[ \t\f\v]+/).filter(Boolean);
    if (words.length === 0) lines.push({ text: '', w: 0 });
    else for (const l of wrapWords(words, limit, width)) lines.push(l);
  }

  // Loops, not spreads: a pasted wall of text must not overflow the argument stack.
  let widest = 0, empty = true;
  for (const l of lines) {
    if (l.w > widest) widest = l.w;
    if (l.text !== '') empty = false;
  }
  // `empty` is about the words, not their measured width: a measurer that fails
  // (or ink-less text like a lone zero-width space) still gets a box to grab, but
  // a caption with words is never drawn as the placeholder.
  const contentW = widest > 0 ? widest : EMPTY_WIDTH * fontPx;
  return {
    lines: lines.map((l) => l.text),
    lineWidths: lines.map((l) => l.w),
    fontPx,
    lineHeight,
    boxW: contentW + 2 * pad,
    boxH: lines.length * lineHeight + 2 * pad,
    pad,
    radius: fontPx * BOX_RADIUS,
    font,
    style: st.id,
    empty,
  };
}

// Greedy fill: each word joins the current line if the whole line still measures
// within `limit` (measured whole, so kerning and ligatures count), else starts the
// next one. A word wider than a line on its own is broken between graphemes.
function wrapWords(words, limit, width) {
  const fits = (w) => w <= limit * (1 + 1e-9);
  const out = [];
  let line = '', lineW = 0;
  const start = (word) => {
    const w = width(word);
    if (fits(w)) { line = word; lineW = w; return; }
    const pieces = breakWord(word, fits, width);
    for (let i = 0; i < pieces.length - 1; i++) out.push(pieces[i]);
    ({ text: line, w: lineW } = pieces[pieces.length - 1]);
  };
  for (const word of words) {
    if (line === '') { start(word); continue; }
    const candidate = `${line} ${word}`;
    const w = width(candidate);
    if (fits(w)) { line = candidate; lineW = w; continue; }
    out.push({ text: line, w: lineW });
    start(word);
  }
  out.push({ text: line, w: lineW });
  return out;
}

// Every piece holds at least one grapheme, so a single glyph wider than the line
// still makes progress (it overflows rather than looping).
function breakWord(word, fits, width) {
  const pieces = [];
  let cur = '', curW = 0;
  for (const g of graphemes(word)) {
    const candidate = cur + g;
    const w = width(candidate);
    if (cur === '' || fits(w)) { cur = candidate; curW = w; continue; }
    pieces.push({ text: cur, w: curW });
    cur = g;
    curW = width(g);
  }
  pieces.push({ text: cur, w: curW });
  return pieces;
}

// What to paint: the words' colour, the Box fill (null for other styles) and the
// shadow (null for Box). Box words take black or white, whichever reads on the
// fill; a dark caption gets a light halo instead of a shadow it would vanish into.
//
// `scale` is device px per output px of the context the caption is drawn into
// (1 for the export raster; view.scale * devicePixelRatio on the stage). Canvas
// shadowBlur and shadowOffset ignore the current transform, so without it a
// preview drawn scaled down would carry the export's full-size shadow.
export function captionPaint(caption, layout, scale = 1) {
  const st = styleById(caption?.style);
  const color = typeof caption?.color === 'string' ? caption.color : SWATCHES[0].hex;
  const lum = luminance(color);
  const k = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const fontPx = (layout?.fontPx > 0 && Number.isFinite(layout.fontPx) ? layout.fontPx : 0) * k;
  if (st.box) return { ink: lum > 0.35 ? '#000000' : '#ffffff', box: color, shadow: null };
  return {
    ink: color,
    box: null,
    shadow: st.shadow
      ? {
        color: lum < 0.1 ? 'rgba(255, 255, 255, 0.45)' : 'rgba(0, 0, 0, 0.5)',
        blur: fontPx * 0.12,
        offsetX: 0,
        offsetY: fontPx * 0.04,
      }
      : null,
  };
}

// WCAG relative luminance of a hex colour (#rgb, #rgba, #rrggbb, #rrggbbaa) or the
// two colour names that matter; anything else counts as a light colour.
const NAMED = new Map([['white', '#ffffff'], ['black', '#000000']]);

function luminance(color) {
  const hex = (NAMED.get(color.toLowerCase()) ?? color).replace(/^#/, '');
  if (!/^[0-9a-f]+$/i.test(hex) || ![3, 4, 6, 8].includes(hex.length)) return 1;
  const full = hex.length <= 4 ? [...hex.slice(0, 3)].map((c) => c + c).join('') : hex.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// ------------------------------------------------------------------ placement

// Box px -> output px: the box's centre lands on (cx * outW, cy * outH), turned
// by `angle` about that centre.
export function captionMatrix(caption, layout, outW, outH) {
  checkSize(outW, outH, 'captionMatrix');
  const [X, Y] = centreOf(caption, outW, outH);
  const [c, s] = cosSin(angleOf(caption));
  const hw = layout.boxW / 2, hh = layout.boxH / 2;
  return [c, s, -s, c, X - c * hw + s * hh, Y - s * hw - c * hh];
}

// Axis-aligned output-px bounds of the turned box: what the stage must keep in
// view above the keyboard, and the dirty rect when a caption moves.
export function captionBounds(caption, layout, outW, outH) {
  const m = captionMatrix(caption, layout, outW, outH);
  const pts = [[0, 0], [layout.boxW, 0], [0, layout.boxH], [layout.boxW, layout.boxH]]
    .map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

// The topmost caption under (x, y) in output px, or null. Topmost is last in the
// list (drawn last). A touch squarely inside a caption beats a near-miss on one
// above it, so slop only decides when no box is hit outright. `slop` is in output
// px: from the stage, pass slopPt / view.scale.
// `layouts` runs parallel to `captions`, or is a Map / object keyed by caption id.
export function hitCaption(captions, layouts, x, y, outW, outH, slop = 12) {
  if (!Array.isArray(captions) || captions.length === 0) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  checkSize(outW, outH, 'hitCaption');
  const margin = Number.isFinite(slop) && slop > 0 ? slop : 0;
  const local = [];
  for (let i = 0; i < captions.length; i++) {
    const cap = captions[i];
    const lay = layoutFor(layouts, cap, i);
    if (!cap || !lay) { local.push(null); continue; }
    const [X, Y] = centreOf(cap, outW, outH);
    const [c, s] = cosSin(angleOf(cap));
    const dx = x - X, dy = y - Y;
    // Turn the touch back by -angle into the box's own axes.
    local.push({ id: cap.id, lx: Math.abs(dx * c + dy * s) - lay.boxW / 2, ly: Math.abs(-dx * s + dy * c) - lay.boxH / 2 });
  }
  for (const reach of margin > 0 ? [0, margin] : [0]) {
    for (let i = local.length - 1; i >= 0; i--) {
      const h = local[i];
      if (h && h.lx <= reach && h.ly <= reach) return h.id;
    }
  }
  return null;
}

function layoutFor(layouts, cap, i) {
  if (!layouts || !cap) return null;
  let lay;
  if (Array.isArray(layouts)) lay = layouts[i];
  else if (layouts instanceof Map) lay = layouts.get(cap.id);
  else if (typeof layouts === 'object' && Object.hasOwn(layouts, cap.id)) lay = layouts[cap.id];
  return lay && Number.isFinite(lay.boxW) && Number.isFinite(lay.boxH) ? lay : null;
}

// Snap a dragged centre (normalized) to the middle and the thirds on each axis
// independently. `guides` lists the lines to draw: axis 'x' is a vertical line at
// x = at (normalized), axis 'y' a horizontal one. The centre is kept on the photo.
export function snapPosition(cx, cy, threshold = 0.02) {
  const t = Number.isFinite(threshold) && threshold > 0 ? threshold : 0;
  const guides = [];
  const snap = (v, axis) => {
    const p = typeof v === 'number' && !Number.isNaN(v) ? Math.min(1, Math.max(0, v)) : 0.5;
    let best = null;
    for (const at of SNAP_TARGETS) {
      const d = Math.abs(p - at);
      // Inclusive, with room for float noise: 0.52 is "0.02 from 0.5".
      if (d <= t + 1e-12 && (best === null || d < Math.abs(p - best))) best = at;
    }
    if (best === null) return p;
    guides.push({ axis, at: best });
    return best;
  };
  return { cx: snap(cx, 'x'), cy: snap(cy, 'y'), guides };
}

// The scale/rotate handle: the box's bottom-right corner, in output px. Bottom
// right so a thumb coming up from below grabs it without covering the words.
export function cornerHandle(caption, layout, outW, outH) {
  const m = captionMatrix(caption, layout, outW, outH);
  return { x: m[0] * layout.boxW + m[2] * layout.boxH + m[4], y: m[1] * layout.boxW + m[3] * layout.boxH + m[5] };
}

// Drag on the handle: the finger's distance from the caption's centre scales the
// size, and its turn about the centre turns the caption, landing on 0° / ±90°
// within 3°. Pass the caption and layout as they were when the drag began and the
// finger's start point (`fromXY`, or null for the handle itself): the result is
// absolute, so it never drifts however many moves arrive. Points are {x, y} or
// [x, y] in output px. Returns `caption` itself when nothing changes.
export function applyHandleDrag(caption, layout, outW, outH, fromXY, toXY) {
  checkSize(outW, outH, 'applyHandleDrag');
  const to = point(toXY);
  const from = point(fromXY) ?? (layout ? point(cornerHandle(caption, layout, outW, outH)) : null);
  if (!to || !from) return caption;
  const [X, Y] = centreOf(caption, outW, outH);
  const r0 = Math.hypot(from[0] - X, from[1] - Y);
  const r1 = Math.hypot(to[0] - X, to[1] - Y);
  if (!(r0 >= MIN_RADIUS)) return caption;
  const size = clampSize(sizeOf(caption) * r1 / r0);
  // At the centre the direction is meaningless: keep the angle, still scale down.
  const turn = r1 >= MIN_RADIUS
    ? (Math.atan2(to[1] - Y, to[0] - X) - Math.atan2(from[1] - Y, from[0] - X)) * 180 / Math.PI
    : 0;
  return withSizeAngle(caption, size, turn);
}

// Pinch or twist that started on the selected caption: `scale` and `rotation`
// (radians, cumulative) are lib/gestures.js's pinch intent, measured from the
// caption as it was at pinch start.
export function applyPinch(caption, scale, rotation) {
  const size = Number.isFinite(scale) && scale > 0 ? clampSize(sizeOf(caption) * scale) : sizeOf(caption);
  const turn = Number.isFinite(rotation) ? rotation * 180 / Math.PI : 0;
  return withSizeAngle(caption, size, turn);
}

// Sizes keep 4 decimals and angles 0.1°, rounded before the detent so float noise
// never decides whether exactly 3° snaps. An angle already within 3° of a detent
// snaps on any handle drag or pinch, which is what a detent is for.
// A size or angle the gesture did not move (at that precision) keeps its stored
// value: -180 stays -180 rather than 180, and an off-grid 0.123456 is not rounded,
// so a pure twist never reads as "Resized caption" nor a pure resize as "Rotated".
// A stored size or angle that is not a usable number, or an angle outside
// [-180, 180], is always rewritten.
function withSizeAngle(caption, size, turn) {
  const s0 = sizeOf(caption);
  const s = round(size, 1e4) === round(s0, 1e4) ? s0 : round(size, 1e4);
  const a0 = angleOf(caption);
  const turned = round(a0 + turn, 10);
  const a = detent(turned === round(a0, 10) ? a0 : turned);
  const sameSize = s === caption.size;
  const stored = caption.angle;
  const sameAngle = Number.isFinite(stored) && stored >= -180 && stored <= 180 &&
    (a === stored || a === normalizeAngle(stored));
  if (sameSize && sameAngle) return caption;
  return { ...caption, size: s, angle: sameAngle ? caption.angle : a };
}

function detent(angle) {
  const a = normalizeAngle(angle);
  for (const d of ANGLE_DETENTS) if (Math.abs(a - d) <= ANGLE_DETENT_DEG + 1e-9) return d;
  return a;
}

// ------------------------------------------------------------------ helpers

// Into (-180, 180], like lib/doc.js does for out-of-range angles.
function normalizeAngle(a) {
  if (!Number.isFinite(a)) return 0;
  const r = a - 360 * Math.ceil((a - 180) / 360);
  return r === 0 ? 0 : r; // no -0
}

// Exact for quarter turns, so 90° boxes land on whole pixels.
function cosSin(deg) {
  const q = deg / 90;
  if (Number.isInteger(q)) return [[1, 0], [0, 1], [-1, 0], [0, -1]][((q % 4) + 4) % 4];
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r)];
}

function centreOf(caption, outW, outH) {
  const cx = Number.isFinite(caption?.cx) ? caption.cx : 0.5;
  const cy = Number.isFinite(caption?.cy) ? caption.cy : 0.5;
  return [cx * outW, cy * outH];
}

function angleOf(caption) {
  return Number.isFinite(caption?.angle) ? caption.angle : 0;
}

function sizeOf(caption) {
  return clampSize(Number.isFinite(caption?.size) && caption.size > 0 ? caption.size : SIZE_DEFAULT);
}

function clampSize(s) {
  return Math.min(SIZE_MAX, Math.max(SIZE_MIN, Number.isFinite(s) ? s : SIZE_DEFAULT));
}

function point(p) {
  if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) return [p[0], p[1]];
  if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return [p.x, p.y];
  return null;
}

function round(v, k) {
  return Math.round(v * k) / k + 0;
}

function checkSize(outW, outH, fn) {
  if (!(Number.isFinite(outW) && Number.isFinite(outH) && outW > 0 && outH > 0)) {
    throw new RangeError(`${fn}: output size must be positive, got ${outW} x ${outH}`);
  }
}
