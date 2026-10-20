// The document: everything the user has done to one photo, as small plain data.
// Pure: no DOM, no clocks (callers pass `now` and ids in).
//
// A DocState is immutable and cheap: dials are numbers, Paint and Remove are
// ordered id lists (stroke bodies and tile pixels live in pools / IndexedDB), and
// captions are a few fields each. Undo keeps whole snapshots, so every edit makes
// a new object that shares every untouched branch with the previous one.
//
// DocState = {
//   v: 1, id, createdAt,
//   source: { type, natW, natH, w, h },          w,h = working size (decode target)
//   light:  { brightness, contrast, highlights, shadows },          ints -100..100
//   color:  { warmth, tint, vividness, look, strength },  look in LOOK_IDS, 0..100
//   paint:  [strokeId, ...],
//   crop:   { quarter, flip, angle, aspect, rect },     exactly lib/geometry.js's
//   remove: [patchId, ...],
//   text:   [{ id, text, style, color, cx, cy, size, angle }],
// }

import {
  ASPECTS, MAX_STRAIGHTEN, aspectValue, initialCrop, isIdentityCrop, maxCenteredRect,
  orientedSize, rectFits, setAngle,
} from './geometry.js';
import { defaultAdjust, lookById } from './develop.js';

export { ASPECTS };

export const LOOK_IDS = Object.freeze(['none', 'vivid', 'warm', 'cool', 'film', 'mono']);

// Caption styles, in Quick-row order. lib/text-layout.js owns how they look; the
// document only needs to know which ids are legal.
export const TEXT_STYLES = Object.freeze(['classic', 'bold', 'box', 'serif', 'mono', 'round']);
const STYLE_LABELS = { classic: 'Classic', bold: 'Bold', box: 'Box', serif: 'Serif', mono: 'Mono', round: 'Round' };

// Sanity bounds for revived data. No real working image is anywhere near this
// (the editor caps at 8192 px a side); a bigger number means a corrupt record.
const MAX_DIM = 32768;
// The original file's size is only informational and a long panorama can be wide,
// so it gets a far looser bound than the working size.
const MAX_NATURAL_DIM = 1_000_000;
const MAX_ID = 128;
const MAX_CAPTION_CHARS = 2000;
// Relative slack when checking that a locked-aspect rect still has that aspect.
// Geometry keeps it to ~1e-15; anything visibly off means the record is damaged.
const ASPECT_SLACK = 1e-4;
const MINUS = '−';

const dial = (id, label, group, path, min, max, def, unit = '', field = null) =>
  Object.freeze({ id, label, group, path: path && Object.freeze(path), field, min, max, def, unit });

// Every user-facing dial, in dial-row order per tool. Ids, ranges and defaults are
// the same as lib/ruler.js's RULERS (a test keeps them in step); this table adds
// where each value lives.
//   path   where the value lives in a DocState, or null when it does not live at a
//          fixed place: Remove's brush size is tool state, and caption dials apply
//          to the selected caption's `field`.
//   unit   stored units: caption size is a fraction of the output's short side.
// Straighten is stored at crop.angle, but moving it must go through geometry's
// setAngle so the frame shrinks to fit; never setIn the angle alone.
export const DIALS = Object.freeze([
  dial('brightness', 'Brightness', 'light', ['light', 'brightness'], -100, 100, 0),
  dial('contrast', 'Contrast', 'light', ['light', 'contrast'], -100, 100, 0),
  dial('highlights', 'Highlights', 'light', ['light', 'highlights'], -100, 100, 0),
  dial('shadows', 'Shadows', 'light', ['light', 'shadows'], -100, 100, 0),
  dial('warmth', 'Warmth', 'color', ['color', 'warmth'], -100, 100, 0),
  dial('tint', 'Tint', 'color', ['color', 'tint'], -100, 100, 0),
  dial('vividness', 'Vividness', 'color', ['color', 'vividness'], -100, 100, 0),
  dial('strength', 'Strength', 'color', ['color', 'strength'], 0, 100, 100),
  dial('straighten', 'Straighten', 'crop', ['crop', 'angle'], -MAX_STRAIGHTEN, MAX_STRAIGHTEN, 0, '°'),
  dial('removeSize', 'Size', 'remove', null, 8, 120, 36, 'pt'),
  dial('textSize', 'Size', 'text', null, 0.03, 0.3, 0.08, 'short side', 'size'),
  dial('textAngle', 'Angle', 'text', null, -180, 180, 0, '°', 'angle'),
]);

const DIAL_BY_ID = new Map(DIALS.map((d) => [d.id, d]));

export function dialById(id) {
  return DIAL_BY_ID.get(id) ?? null;
}

const CAPTION_SIZE = dialById('textSize');

export const DEFAULTS = Object.freeze({
  light: Object.freeze({ brightness: 0, contrast: 0, highlights: 0, shadows: 0 }),
  color: Object.freeze({ warmth: 0, tint: 0, vividness: 0, look: 'none', strength: 100 }),
  // The caption the Text tool creates (§F11): centred, 78% down the frame.
  caption: Object.freeze({
    text: 'Your words', style: 'classic', color: '#ffffff', cx: 0.5, cy: 0.78,
    size: CAPTION_SIZE.def, angle: 0,
  }),
});

// ------------------------------------------------------------------ create / revive

export function createDoc({ id, sourceType = 'unknown', natW, natH, w, h, now = 0 } = {}) {
  if (!isId(id)) throw new Error('createDoc: id must be a non-empty string');
  if (!isDim(w) || !isDim(h)) throw new Error('createDoc: working size must be positive integers');
  if (natW != null && !isDim(natW, MAX_NATURAL_DIM)) throw new Error('createDoc: natW must be a positive integer');
  if (natH != null && !isDim(natH, MAX_NATURAL_DIM)) throw new Error('createDoc: natH must be a positive integer');
  return {
    v: 1,
    id,
    // The same bounds reviveDoc applies, so a new doc survives autosave unchanged
    // whatever clock the caller passed (a negative or absurd `now` becomes 0 / max).
    createdAt: num(now, 0, Number.MAX_SAFE_INTEGER, 0),
    source: { type: cleanType(sourceType), natW: natW ?? w, natH: natH ?? h, w, h },
    light: { ...DEFAULTS.light },
    color: { ...DEFAULTS.color },
    paint: [],
    crop: initialCrop(w, h),
    remove: [],
    text: [],
  };
}

// Rebuild a DocState from untrusted data (IndexedDB, a JSON string). Every field
// is validated and clamped, unknown fields are dropped, and a crop that no longer
// fits is refitted. A record that cannot describe a photo (no id, no usable source
// size, wrong version) throws: there is nothing sensible to edit.
// A valid DocState revives to a deep-equal copy, so autosave round-trips exactly.
export function reviveDoc(json) {
  const raw = typeof json === 'string' ? JSON.parse(json) : json;
  if (!isObj(raw)) throw new Error('doc: not an object');
  if (raw.v !== 1) throw new Error(`doc: unsupported version ${String(raw.v)}`);
  if (!isId(raw.id)) throw new Error('doc: missing id');
  const s = raw.source;
  if (!isObj(s)) throw new Error('doc: missing source');
  const w = dimOrZero(s.w), h = dimOrZero(s.h);
  if (!w || !h) throw new Error('doc: source size is unusable');
  const light = isObj(raw.light) ? raw.light : {};
  const color = isObj(raw.color) ? raw.color : {};
  return {
    v: 1,
    id: raw.id,
    createdAt: num(raw.createdAt, 0, Number.MAX_SAFE_INTEGER, 0),
    source: {
      type: cleanType(s.type),
      natW: dimOrZero(s.natW, MAX_NATURAL_DIM) || w,
      natH: dimOrZero(s.natH, MAX_NATURAL_DIM) || h,
      w,
      h,
    },
    light: {
      brightness: dialValue('brightness', light.brightness),
      contrast: dialValue('contrast', light.contrast),
      highlights: dialValue('highlights', light.highlights),
      shadows: dialValue('shadows', light.shadows),
    },
    color: {
      warmth: dialValue('warmth', color.warmth),
      tint: dialValue('tint', color.tint),
      vividness: dialValue('vividness', color.vividness),
      look: LOOK_IDS.includes(color.look) ? color.look : 'none',
      strength: dialValue('strength', color.strength),
    },
    paint: reviveIds(raw.paint),
    crop: reviveCrop(raw.crop, w, h),
    remove: reviveIds(raw.remove),
    text: reviveCaptions(raw.text),
  };
}

function reviveCrop(raw, w, h) {
  if (!isObj(raw)) return initialCrop(w, h);
  const quarter = Number.isInteger(raw.quarter) ? ((raw.quarter % 4) + 4) % 4 : 0;
  const flip = raw.flip === true;
  const angle = num(raw.angle, -MAX_STRAIGHTEN, MAX_STRAIGHTEN, 0);
  let aspect = typeof raw.aspect === 'string' && Object.hasOwn(ASPECTS, raw.aspect) ? raw.aspect : 'free';
  const o = orientedSize(w, h, quarter);
  const largest = (key, fallback) =>
    maxCenteredRect(o.width, o.height, angle, aspectValue(key, o.width, o.height) ?? fallback);
  const r = raw.rect;
  if (!isRectShape(r)) return { quarter, flip, angle, aspect, rect: largest(aspect, o.width / o.height) };

  const rect = { x: r.x + 0, y: r.y + 0, width: r.width, height: r.height };
  // A locked aspect whose rect has another shape is self-contradictory. Keep what
  // the user framed (the pixels they see) and call it free.
  const locked = aspectValue(aspect, o.width, o.height);
  if (locked !== null && Math.abs(rect.width / rect.height - locked) > ASPECT_SLACK * locked) aspect = 'free';
  const crop = { quarter, flip, angle, aspect, rect };
  if (rectFits(rect, o.width, o.height, angle)) return crop;
  // Too big or off the image (a clamped angle, a damaged record): shrink about its
  // centre and slide inside, exactly as straightening does.
  const fixed = setAngle(crop, w, h, angle);
  if (isRectShape(fixed.rect) && rectFits(fixed.rect, o.width, o.height, angle)) return fixed;
  return { ...crop, rect: largest(crop.aspect, o.width / o.height) };
}

function reviveCaptions(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (!isObj(raw) || !isId(raw.id) || seen.has(raw.id)) continue;
    seen.add(raw.id);
    const d = DEFAULTS.caption;
    out.push({
      id: raw.id,
      text: typeof raw.text === 'string' ? clipText(raw.text, MAX_CAPTION_CHARS) : '',
      style: TEXT_STYLES.includes(raw.style) ? raw.style : d.style,
      color: isColor(raw.color) ? raw.color : d.color,
      cx: num(raw.cx, 0, 1, d.cx),
      cy: num(raw.cy, 0, 1, d.cy),
      size: num(raw.size, CAPTION_SIZE.min, CAPTION_SIZE.max, d.size),
      angle: captionAngle(raw.angle),
    });
  }
  return out;
}

function reviveIds(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  // An id appearing twice would paint or patch twice; keep the first.
  for (const id of list) if (isId(id) && !seen.has(id)) { seen.add(id); out.push(id); }
  return out;
}

// ------------------------------------------------------------------ paths

// Immutable update with structural sharing: only the objects along `path` are
// copied. Setting a value that is already there returns `state` itself, so callers
// can tell a no-op from an edit by identity.
export function setIn(state, path, value) {
  if (!Array.isArray(path)) throw new TypeError('setIn: path must be an array');
  if (path.length === 0) return value;
  const [key, ...rest] = path;
  checkKey(key);
  let node = state;
  if (node === undefined || node === null) node = typeof key === 'number' ? [] : {};
  if (Array.isArray(node)) {
    if (typeof key !== 'number') throw new TypeError(`setIn: array index must be a number, got ${String(key)}`);
    if (key > node.length) throw new RangeError(`setIn: index ${key} would leave a hole`);
  } else if (!isPlain(node)) {
    throw new TypeError(`setIn: cannot set ${String(key)} on ${node === null ? 'null' : typeof node}`);
  }
  const has = Object.hasOwn(node, key);
  const child = setIn(has ? node[key] : undefined, rest, value);
  if (has && Object.is(node[key], child)) return node;
  if (Array.isArray(node)) {
    const copy = node.slice();
    copy[key] = child;
    return copy;
  }
  return { ...node, [key]: child };
}

export function getIn(state, path) {
  let node = state;
  for (const key of path) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

function checkKey(key) {
  if (typeof key === 'number') {
    if (!Number.isInteger(key) || key < 0) throw new RangeError(`setIn: bad index ${key}`);
    return;
  }
  if (typeof key !== 'string' || key === '') throw new TypeError('setIn: keys must be non-empty strings or indices');
  // Never let a path reach an object's prototype machinery.
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error(`setIn: refusing key ${key}`);
}

// ------------------------------------------------------------------ reading a doc

// Structural equality for plain data (DocState values). -0 equals 0, as JSON has it.
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!Object.hasOwn(b, k) || !deepEqual(a[k], b[k])) return false;
  return true;
}

// Dial ids whose value is not the default: the dots on the dial chips. Strength
// only counts while a look is on, since its chip is disabled otherwise.
export function changedDials(state) {
  const out = new Set();
  for (const d of DIALS) {
    if (!d.path) continue;
    if (d.id === 'strength' && state.color.look === 'none') continue;
    if (getIn(state, d.path) !== d.def) out.add(d.id);
  }
  return out;
}

// True when the output would look exactly like the photo: what decides "Edited" in
// the top bar and whether New photo needs to ask first.
export function isUnedited(state) {
  const { light, color } = state;
  return Object.keys(DEFAULTS.light).every((k) => light[k] === 0) &&
    color.warmth === 0 && color.tint === 0 && color.vividness === 0 &&
    (color.look === 'none' || color.strength === 0) &&
    state.paint.length === 0 && state.remove.length === 0 && state.text.length === 0 &&
    isIdentityCrop(state.crop, state.source.w, state.source.h);
}

// The develop pipeline's input: `resolve(adjust, look)` in lib/develop.js. The doc
// shows Vividness; the pipeline calls it vibrance. Every other pipeline param stays
// at zero here and is only ever moved by a look.
export function developInput(state) {
  const { light, color } = state;
  return {
    adjust: {
      ...defaultAdjust(),
      brightness: light.brightness,
      contrast: light.contrast,
      highlights: light.highlights,
      shadows: light.shadows,
      warmth: color.warmth,
      tint: color.tint,
      vibrance: color.vividness,
    },
    look: { id: color.look, amount: color.strength },
  };
}

// ------------------------------------------------------------------ labels

const GROUPS = ['light', 'color', 'crop', 'paint', 'remove', 'text'];

// A short name for one step, for the undo toast ("Undid: Shadows +24") and the
// rewind tape. Only one part of the photo normally changes per step; if several
// did, there is no honest short name, so it is just "Edit". Steps that change many
// things on purpose (Auto-enhance) pass their own label instead.
export function describeChange(prev, next) {
  if (!isObj(prev) || !isObj(next)) return 'Edit';
  const changed = GROUPS.filter((g) => !deepEqual(prev[g], next[g]));
  if (changed.length !== 1) return 'Edit';
  try {
    switch (changed[0]) {
      case 'light': return describeDials('light', prev, next);
      case 'color': return describeColor(prev, next);
      case 'crop': return describeCrop(prev.crop, next.crop);
      case 'paint': return describePaint(prev.paint ?? [], next.paint ?? []);
      case 'remove': return describeRemove(prev.remove ?? [], next.remove ?? []);
      default: return describeText(prev.text ?? [], next.text ?? []);
    }
  } catch {
    return 'Edit'; // a malformed state should never break the toast
  }
}

// Several dials in one group (Softer moves contrast and shadows): name the one
// that moved most, which is what the user will notice.
function describeDials(group, prev, next) {
  let best = null, bestDelta = -1;
  for (const d of DIALS) {
    if (d.group !== group || !d.path) continue;
    const a = getIn(prev, d.path), b = getIn(next, d.path);
    if (a === b) continue;
    const delta = Math.abs(b - a);
    if (delta > bestDelta) { best = d; bestDelta = delta; }
  }
  if (!best) return group === 'light' ? 'Light' : 'Color';
  const v = getIn(next, best.path);
  if (best.id === 'strength') {
    const look = next.color.look;
    return look === 'none' ? `Strength ${v}` : `${lookLabel(look)} strength ${v}`;
  }
  return `${best.label} ${signed(v)}`;
}

function describeColor(prev, next) {
  if (prev.color?.look !== next.color.look) return `Look: ${lookLabel(next.color.look)}`;
  return describeDials('color', prev, next);
}

// Order matters: a turn also swaps the aspect and moves the rect, a flip negates
// the angle, and straightening shrinks the rect; name the cause, not the effects.
function describeCrop(a, b) {
  if (a.quarter !== b.quarter) return 'Rotated';
  if (a.flip !== b.flip) return 'Flipped';
  if (a.aspect !== b.aspect) return `Crop ${aspectLabel(b.aspect)}`;
  if (a.angle !== b.angle) return b.angle === 0 ? 'Straighten 0°' : `Straightened ${degrees(Math.abs(b.angle))}`;
  return 'Crop';
}

function describePaint(a, b) {
  if (b.length === 0) return 'Cleared paint';
  if (b.length < a.length && isPrefix(b, a)) return 'Removed paint';
  return 'Painted light';
}

function describeRemove(a, b) {
  if (b.length > a.length && isPrefix(a, b)) {
    const n = b.length - a.length;
    return n === 1 ? 'Removed spot' : `Removed ${n} spots`;
  }
  // Same length, only the newest fill differs: Try another (or a moved source).
  if (b.length === a.length && b.length > 0 && isPrefix(a.slice(0, -1), b)) return 'Tried another';
  return 'Remove';
}

function describeText(a, b) {
  const before = new Map(a.map((c) => [c.id, c]));
  const after = new Map(b.map((c) => [c.id, c]));
  const added = b.filter((c) => !before.has(c.id));
  const removed = a.filter((c) => !after.has(c.id));
  const edited = b.filter((c) => before.has(c.id) && !deepEqual(before.get(c.id), c));
  if (added.length + removed.length + edited.length !== 1) return 'Edited captions';
  if (added.length) return captionLabel(added[0].text);
  if (removed.length) return 'Deleted caption';
  const p = before.get(edited[0].id), n = edited[0];
  if (p.text !== n.text) return captionLabel(n.text);
  if (p.style !== n.style) return `Style: ${STYLE_LABELS[n.style] ?? n.style}`;
  if (p.color !== n.color) return 'Caption color';
  if (p.size !== n.size) return 'Resized caption';
  if (p.angle !== n.angle) return 'Rotated caption';
  if (p.cx !== n.cx || p.cy !== n.cy) return 'Moved caption';
  return 'Edited caption';
}

// Caption “Hello”: first line's worth of words, cut by grapheme cluster so a flag,
// a skin-toned or ZWJ emoji (several code points each) is never split, the same
// way lib/text-layout.js breaks lines. Code points are the fallback.
const SEGMENTER = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('en', { granularity: 'grapheme' })
  : null;

function graphemes(s) {
  return SEGMENTER ? Array.from(SEGMENTER.segment(s), (g) => g.segment) : Array.from(s);
}

function captionLabel(text) {
  const words = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  if (!words) return 'Caption';
  const chars = graphemes(words);
  const shown = chars.length > 20 ? `${chars.slice(0, 19).join('').trimEnd()}…` : words;
  return `Caption “${shown}”`;
}

function lookLabel(id) {
  return lookById(id).label;
}

function aspectLabel(key) {
  if (key === 'free') return 'Free';
  if (key === 'original') return 'Original';
  if (key === 'square') return 'Square';
  return key;
}

function signed(v) {
  if (v > 0) return `+${v}`;
  if (v < 0) return `${MINUS}${-v}`;
  return '0';
}

function degrees(v) {
  return `${Number(v.toFixed(1))}°`;
}

function isPrefix(a, b) {
  if (a.length > b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ------------------------------------------------------------------ validation helpers

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isPlain(v) {
  if (!isObj(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isId(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID;
}

function isDim(v, max = MAX_DIM) {
  return Number.isInteger(v) && v >= 1 && v <= max;
}

function dimOrZero(v, max = MAX_DIM) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  const r = Math.round(v);
  return r >= 1 && r <= max ? r : 0;
}

function cleanType(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 32 ? v : 'unknown';
}

// Only real numbers count: '12', true and null are not dial values. `+ 0` turns
// -0 into 0 so a revived doc compares equal to its JSON round trip.
function num(v, min, max, def) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return def;
  return Math.max(min, Math.min(max, v)) + 0;
}

function dialValue(id, v) {
  const d = DIAL_BY_ID.get(id);
  if (typeof v !== 'number' || !Number.isFinite(v)) return d.def;
  return Math.max(d.min, Math.min(d.max, Math.round(v))) + 0;
}

// In-range angles are kept as they are (so ±180 both survive a round trip); others
// wrap into (-180, 180].
function captionAngle(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  if (v >= -180 && v <= 180) return v + 0;
  return v - 360 * Math.ceil((v - 180) / 360) + 0;
}

function isRectShape(r) {
  return isObj(r) && [r.x, r.y, r.width, r.height].every(Number.isFinite) &&
    r.width > 0 && r.height > 0 && Number.isFinite(r.width / r.height) && r.width / r.height > 0;
}

// Hex in a length CSS accepts (#rgb, #rgba, #rrggbb, #rrggbbaa: the forms
// lib/text-layout.js parses) or a plain CSS colour name. #rrggb and #rrggbba are
// not colours: a canvas ignores them and keeps whatever fillStyle came before.
// Nothing else reaches the canvas, so a damaged record cannot smuggle in anything odd.
function isColor(v) {
  return typeof v === 'string' &&
    (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) || /^[a-z]{3,20}$/i.test(v));
}

function clipText(s, max) {
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join('');
}
