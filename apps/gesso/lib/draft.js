// The autosaved draft (SPEC §5.6, F16) as data: what goes into IndexedDB and how
// it is checked on the way back out. Pure: no IndexedDB, no DOM, no clock.
//
// Keys in the 'blobs' store:
//   source:<docId>   the original file, never re-encoded
//   tile:<patchId>   a Remove fill: a 20-byte header (magic 'GTL1', then x, y, w, h
//                    as little-endian uint32) followed by w*h*4 bytes of RGBA. The
//                    rect travels with the pixels so a tile can be checked against
//                    the record that names it.
// The 'docs' record for a draft:
//   { v, id, savedAt, info, history (lib/history serialize), pools, savedRevision, maxPixels }

import { revive as reviveHistory, referencedIds, clearMark } from './history.js';
import { fitWorkingSize } from './image-io.js';

export const DRAFT_VERSION = 1;
export const TILE_HEADER_BYTES = 20;
const TILE_MAGIC = [0x47, 0x54, 0x4c, 0x31]; // 'GTL1'
// Matches the canvas area limit: no real tile is near it, so anything bigger is a
// damaged header, not a photo.
const MAX_TILE_PIXELS = 67_108_864;
const PAINT_MODES = new Set(['brighten', 'darken', 'erase']);
const MAX_NAME = 255;
const MAX_TYPE = 32;

export const sourceKey = (docId) => `source:${docId}`;
export const tileKey = (patchId) => `tile:${patchId}`;

// ------------------------------------------------------------------ tiles

export function encodeTileHeader(rect, byteLength) {
  if (!isTileRect(rect)) throw new RangeError('tile: bad rect');
  if (byteLength !== rect.w * rect.h * 4) {
    throw new RangeError(`tile: ${byteLength} bytes for a ${rect.w}x${rect.h} rect`);
  }
  const out = new Uint8Array(TILE_HEADER_BYTES);
  out.set(TILE_MAGIC, 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(4, rect.x, true);
  dv.setUint32(8, rect.y, true);
  dv.setUint32(12, rect.w, true);
  dv.setUint32(16, rect.h, true);
  return out;
}

// The rect from a stored tile's first bytes. `totalBytes` (the Blob's size) is
// checked against it, so a truncated write is caught before any pixels are read.
export function decodeTileHeader(bytes, totalBytes = null) {
  if (!bytes || bytes.length < TILE_HEADER_BYTES) throw new Error('tile: header too short');
  for (let i = 0; i < TILE_MAGIC.length; i++) if (bytes[i] !== TILE_MAGIC[i]) throw new Error('tile: not a tile');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, TILE_HEADER_BYTES);
  const rect = { x: dv.getUint32(4, true), y: dv.getUint32(8, true), w: dv.getUint32(12, true), h: dv.getUint32(16, true) };
  if (!isTileRect(rect)) throw new Error('tile: bad rect');
  if (totalBytes !== null && totalBytes !== TILE_HEADER_BYTES + rect.w * rect.h * 4) {
    throw new Error('tile: size does not match its rect');
  }
  return rect;
}

function isTileRect(r) {
  return isObj(r) && isUint(r.x) && isUint(r.y) && isUint(r.w) && isUint(r.h) &&
    r.w >= 1 && r.h >= 1 && r.w * r.h <= MAX_TILE_PIXELS;
}

// ------------------------------------------------------------------ record

// The record for docs/<id>. `serialized` is the editor's serialize():
// { history: lib/history serialize(H), pools, savedRevision }. Pools are trimmed
// to what the history refers to: strokes and fills that were cancelled or undone
// and then overwritten can never come back, so they are not carried forward.
export function draftRecord({ id, info, serialized, maxPixels = null, now = 0 }) {
  if (!isId(id)) throw new Error('draft: missing id');
  if (!isObj(serialized) || !isObj(serialized.history) || !Array.isArray(serialized.history.entries)) {
    throw new Error('draft: nothing to save');
  }
  const refs = referencedIds(serialized.history);
  const pools = isObj(serialized.pools) ? serialized.pools : {};
  return {
    v: DRAFT_VERSION,
    id,
    savedAt: Number.isFinite(now) ? now : 0,
    info: isObj(info) ? { ...info } : null,
    history: serialized.history,
    pools: { strokes: pick(pools.strokes, refs.strokes), patches: pick(pools.patches, refs.patches) },
    savedRevision: serialized.savedRevision === true,
    maxPixels: cleanCap(maxPixels),
  };
}

function pick(obj, ids) {
  const out = {};
  if (!isObj(obj)) return out;
  for (const id of ids) if (Object.hasOwn(obj, id)) out[id] = obj[id];
  return out;
}

// Rebuild a draft from storage. Every DocState goes through lib/history revive
// (which validates each one); every stroke and fill the history refers to must be
// present and sane. Anything missing or malformed throws: resuming half a draft
// would show the user an edit that is not the one they left.
export function reviveDraft(raw, expectedId = null) {
  if (!isObj(raw)) throw new Error('draft: not an object');
  if (raw.v !== DRAFT_VERSION) throw new Error(`draft: unsupported version ${String(raw.v)}`);
  if (!isId(raw.id)) throw new Error('draft: missing id');
  if (expectedId !== null && raw.id !== expectedId) throw new Error('draft: stored under another id');
  // The app reopens in the home state, so no tool session is open to cancel back to.
  const history = clearMark(reviveHistory(raw.history));
  const first = history.entries[0].state;
  for (const { state } of history.entries) {
    if (state.id !== raw.id) throw new Error('draft: history mixes photos');
    if (state.source.w !== first.source.w || state.source.h !== first.source.h) throw new Error('draft: history mixes sizes');
  }
  const refs = referencedIds(history);
  const pools = revivePools(raw.pools, refs, first.source);
  return {
    id: raw.id,
    info: reviveInfo(raw.info, first.source),
    history,
    pools,
    tileIds: [...refs.patches],
    savedRevision: raw.savedRevision === true,
    maxPixels: cleanCap(raw.maxPixels),
  };
}

function revivePools(raw, refs, source) {
  const pools = isObj(raw) ? raw : {};
  const strokesIn = isObj(pools.strokes) ? pools.strokes : {};
  const patchesIn = isObj(pools.patches) ? pools.patches : {};
  const strokes = {}, patches = {};
  for (const id of refs.strokes) {
    const s = Object.hasOwn(strokesIn, id) ? strokesIn[id] : null;
    if (!isObj(s) || !PAINT_MODES.has(s.mode) || !(Number.isFinite(s.r) && s.r > 0) || !isPoints(s.pts)) {
      throw new Error(`draft: stroke ${id} is missing or damaged`);
    }
    strokes[id] = { ...s, pts: Array.from(s.pts) };
  }
  for (const id of refs.patches) {
    const p = Object.hasOwn(patchesIn, id) ? patchesIn[id] : null;
    if (!isTileRect(p) || p.x + p.w > source.w || p.y + p.h > source.h) {
      throw new Error(`draft: fill ${id} is missing or damaged`);
    }
    patches[id] = { ...p };
  }
  return { strokes, patches };
}

function isPoints(pts) {
  if (!Array.isArray(pts) && !(ArrayBuffer.isView(pts) && !(pts instanceof DataView))) return false;
  for (let i = 0; i < pts.length; i++) if (typeof pts[i] !== 'number' || !Number.isFinite(pts[i])) return false;
  return true;
}

function reviveInfo(raw, source) {
  const r = isObj(raw) ? raw : {};
  return {
    type: typeof r.type === 'string' && r.type.length <= MAX_TYPE ? r.type : source.type,
    natW: isUint(r.natW) && r.natW > 0 ? r.natW : source.natW,
    natH: isUint(r.natH) && r.natH > 0 ? r.natH : source.natH,
    name: typeof r.name === 'string' ? r.name.slice(0, MAX_NAME) : '',
  };
}

// Every blob key a draft needs: its original and the tiles its history names.
export function draftKeys(docId, tileIds) {
  const keys = new Set([sourceKey(docId)]);
  for (const id of tileIds) keys.add(tileKey(id));
  return keys;
}

// ------------------------------------------------------------------ working size

// The pixel cap that decodes this photo to exactly the working size it was edited
// at, so a restore lands every fill tile on the same pixels. Tries the caps the
// importer could have used, in order; WebKit sometimes resizes after its EXIF turn,
// so a swapped size counts too. Falls back to the first candidate.
export function workingCapFor(natW, natH, w, h, candidates = []) {
  const caps = candidates.filter((c) => typeof c === 'number' && c > 0);
  for (const cap of caps) {
    try {
      const f = fitWorkingSize(natW, natH, cap);
      if ((f.width === w && f.height === h) || (f.width === h && f.height === w)) return cap;
    } catch {
      return caps[0] ?? null;
    }
  }
  return caps[0] ?? null;
}

// ------------------------------------------------------------------ helpers

function cleanCap(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isId(v) {
  return typeof v === 'string' && v !== '';
}

function isUint(v) {
  return Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
}
