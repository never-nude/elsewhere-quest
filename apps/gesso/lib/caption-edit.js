// The Text tool's pure half: how a caption session changes the document, and the
// bits of keyboard geometry the edit bar needs. lib/text-layout.js owns how a
// caption looks, wraps and turns; this module owns which document a tap, a drag or
// a keystroke produces. No DOM: viewport numbers are passed in.
//
// Every doc helper returns the doc it was given when nothing changes, so the tool
// can tell a no-op from an edit by identity (the same contract as lib/doc.js setIn).

import { snapPosition, PLACEHOLDER_TEXT } from './text-layout.js';

// lib/doc.js reviveDoc clips caption text past this many UTF-16 units. Staying
// within it means a caption survives autosave deep-equal, so a reload never
// changes what the user typed.
export const MAX_CAPTION_CHARS = 2000;

export const EDIT_BAR_H = 52; // pt, the edit bar's height (styles.css .editbar)
// A visual viewport this much shorter than the window means the keyboard is up
// (the iOS address bar alone never takes this much).
export const KEYBOARD_MIN = 120;

// Where a new caption goes: 78% down (SPEC F11) unless a caption already sits
// there, then the next free band, so a second "Your words" never lands exactly on
// top of the first.
const SPOTS = Object.freeze([0.78, 0.5, 0.22, 0.64, 0.36]);
const SPOT_CLEAR = 0.08; // normalized height a spot must keep from other captions
const SPOT_COLUMN = 0.3; // only captions this close to the middle column count

const SEGMENTER = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('en', { granularity: 'grapheme' })
  : null;

function graphemes(s) {
  return SEGMENTER ? Array.from(SEGMENTER.segment(s), (g) => g.segment) : Array.from(s);
}

// At most MAX_CAPTION_CHARS UTF-16 units, cut between graphemes so a paste never
// ends in half an emoji. A single grapheme longer than the whole cap (a letter
// buried under thousands of combining marks) is cut by code point instead.
export function clipCaptionText(text) {
  const s = typeof text === 'string' ? text : '';
  if (s.length <= MAX_CAPTION_CHARS) return s;
  let out = '';
  for (const g of graphemes(s)) {
    if (out.length + g.length > MAX_CAPTION_CHARS) {
      if (out === '') for (const cp of Array.from(g)) {
        if (out.length + cp.length > MAX_CAPTION_CHARS) break;
        out += cp;
      }
      break;
    }
    out += g;
  }
  return out;
}

export function findCaption(doc, id) {
  if (id == null || !Array.isArray(doc?.text)) return null;
  return doc.text.find((c) => c && c.id === id) ?? null;
}

// Put `caption` in place of the one with its id, or on top (last) when it is new.
export function withCaption(doc, caption) {
  const list = Array.isArray(doc.text) ? doc.text : [];
  const i = list.findIndex((c) => c && c.id === caption.id);
  if (i < 0) return { ...doc, text: [...list, caption] };
  if (list[i] === caption) return doc;
  const text = list.slice();
  text[i] = caption;
  return { ...doc, text };
}

export function withoutCaption(doc, id) {
  const list = Array.isArray(doc.text) ? doc.text : [];
  const text = list.filter((c) => !c || c.id !== id);
  return text.length === list.length ? doc : { ...doc, text };
}

// Merge `patch` into one caption; the doc itself when every field already holds
// that value (or the caption is gone).
export function updateCaption(doc, id, patch) {
  const cap = findCaption(doc, id);
  if (!cap) return doc;
  if (Object.entries(patch).every(([k, v]) => Object.is(cap[k], v))) return doc;
  return withCaption(doc, { ...cap, ...patch });
}

// The cy for a new caption centred across the photo.
export function freeSpot(captions) {
  const near = (Array.isArray(captions) ? captions : [])
    .filter((c) => c && Number.isFinite(c.cy) && Math.abs((Number.isFinite(c.cx) ? c.cx : 0.5) - 0.5) < SPOT_COLUMN);
  for (const spot of SPOTS) {
    if (near.every((c) => Math.abs(c.cy - spot) >= SPOT_CLEAR)) return spot;
  }
  return SPOTS[0];
}

// A drag of (dx, dy) in normalized output units from where the caption started,
// snapped to the centre and thirds within `threshold`. Positions keep 5 decimals
// (a tenth of a pixel on the largest photo) unless a snap put them exactly on a
// line. Returns the caption itself when it did not move.
export function moveCaption(caption, dx, dy, threshold) {
  const cx0 = Number.isFinite(caption.cx) ? caption.cx : 0.5;
  const cy0 = Number.isFinite(caption.cy) ? caption.cy : 0.5;
  const r5 = (v) => Math.round(v * 1e5) / 1e5 + 0;
  const s = snapPosition(cx0 + (Number.isFinite(dx) ? dx : 0), cy0 + (Number.isFinite(dy) ? dy : 0), threshold);
  const snapped = (axis) => s.guides.some((g) => g.axis === axis);
  const cx = snapped('x') ? s.cx : r5(s.cx);
  const cy = snapped('y') ? s.cy : r5(s.cy);
  const moved = cx !== caption.cx || cy !== caption.cy;
  return { caption: moved ? { ...caption, cx, cy } : caption, guides: s.guides };
}

// Snapping reach as a fraction of the photo: `pt` on screen along the photo's
// short side, so it feels the same at any zoom. Kept within sane bounds for a
// photo shown tiny or hugely zoomed.
export function snapThreshold(displayW, displayH, pt = 6) {
  const short = Math.min(displayW, displayH);
  if (!(short > 0) || !Number.isFinite(short)) return 0.02;
  return Math.min(0.05, Math.max(0.004, pt / short));
}

// Whether a touch at `p` takes the selected caption's corner handle (scale and
// turn) rather than the caption itself (move, tap to edit). Points are [x, y] in
// one space (stage px). Within `reach` of the handle is not enough: on a small
// caption a 44pt target covers the words, and a drag meant to move them would
// blow the caption up instead, so the handle only wins nearer to it than to the
// caption's centre.
export function handleWins(p, handle, centre, reach) {
  if (![p, handle, centre].every((q) => Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1]))) return false;
  const toHandle = Math.hypot(p[0] - handle[0], p[1] - handle[1]);
  return toHandle <= reach && toHandle < Math.hypot(p[0] - centre[0], p[1] - centre[1]);
}

// What the textarea selects when editing starts: the placeholder whole, so the
// first keystroke replaces it (SPEC 1-minute task); real words get the caret at
// the end, so a typo fix does not wipe them.
export function editSelection(text) {
  const s = typeof text === 'string' ? text : '';
  return s === PLACEHOLDER_TEXT ? [0, s.length] : [s.length, s.length];
}

// SPEC §3: the bar sits at visualViewport.offsetTop + height - 52.
export function editBarTop(offsetTop, height) {
  const top = (Number.isFinite(offsetTop) ? offsetTop : 0) + (Number.isFinite(height) ? height : 0) - EDIT_BAR_H;
  return Math.max(0, top);
}

export function isKeyboardUp(innerHeight, viewportHeight) {
  return Number.isFinite(innerHeight) && Number.isFinite(viewportHeight) && innerHeight - viewportHeight > KEYBOARD_MIN;
}

// How far to slide the stage (px, never down) so the caption's centre sits in the
// middle of what the keyboard leaves visible above the edit bar. captionY is where
// the centre would be with no slide, in the same coordinates as the viewport.
export function stageShift({ captionY, visibleTop, barTop, keyboardUp }) {
  if (!keyboardUp || ![captionY, visibleTop, barTop].every(Number.isFinite)) return 0;
  const target = (visibleTop + barTop) / 2;
  return Math.min(0, Math.round(target - captionY));
}

// A fresh caption id that no caption in `captions` uses.
export function captionId(captions = [], now = Date.now(), random = Math.random) {
  const taken = new Set((Array.isArray(captions) ? captions : []).map((c) => c?.id));
  for (;;) {
    const id = `t${Math.max(0, Math.floor(now)).toString(36)}${Math.floor(random() * 1e6).toString(36)}`;
    if (!taken.has(id)) return id;
    now += 1;
  }
}
