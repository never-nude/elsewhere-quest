// Import/export decisions that don't need a DOM: how big to edit at, what a file
// really is and how big it says it is, how to slice an export, and what to call it.

// iOS Safari caps a canvas at 8192 px per side and 67,108,864 px of area. Those are
// hard limits: past them a canvas or texture silently comes back blank.
export const MAX_SIDE = 8192;
export const MAX_AREA = 67_108_864;

// The working-image budget (§5.4) is about memory, not the canvas limit: the page
// is killed somewhere around 1.5-2 GB, and the image lives on the GPU twice
// (pristine and base, mipmapped) plus export buffers. 24.5 MP keeps native 24 MP
// iPhone frames (5712 x 4284) whole and brings 48 MP ones down to about 24 MP.
// If an allocation fails on a device, the editor steps down to the fallback.
export const WORK_MAX_PIXELS = 24_500_000;
export const WORK_FALLBACK_PIXELS = 12_000_000;

/** @deprecated use WORK_MAX_PIXELS. */
export const MAX_WORKING_PIXELS = WORK_MAX_PIXELS;

// Largest size, keeping the aspect, within `maxPixels` (never above MAX_AREA) and
// `maxSide` (never above MAX_SIDE). Takes the limits positionally or as
// { maxPixels, maxSide }; a missing or unusable limit means the default.
export function fitWorkingSize(width, height, maxPixels = WORK_MAX_PIXELS, maxSide = MAX_SIDE) {
  if (maxPixels !== null && typeof maxPixels === 'object') ({ maxPixels, maxSide } = maxPixels);
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) {
    throw new Error('image has no pixels');
  }
  const usable = (v) => typeof v === 'number' && v > 0; // NaN fails too
  const area = Math.min(usable(maxPixels) ? maxPixels : WORK_MAX_PIXELS, MAX_AREA);
  const side = Math.min(usable(maxSide) ? maxSide : MAX_SIDE, MAX_SIDE);
  let scale = Math.min(1, Math.sqrt(area / (width * height)), side / width, side / height);
  if (!(scale > 0)) scale = 0;
  let w = Math.max(1, Math.floor(width * scale));
  let h = Math.max(1, Math.floor(height * scale));
  // Float rounding (or the 1 px floor on a sliver) can leave the product over the
  // budget; trim the longer side to fit.
  if (w * h > area) {
    if (w >= h) w = Math.max(1, Math.floor(area / h));
    else h = Math.max(1, Math.floor(area / w));
  }
  return { width: w, height: h, scale: w / width, downscaled: w < width || h < height };
}

// Whether a canvas / texture of this size can exist on iOS at all.
export function canvasSizeOk(width, height) {
  return Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 &&
    width <= MAX_SIDE && height <= MAX_SIDE && width * height <= MAX_AREA;
}

export function megapixels(width, height) {
  return Math.round((width * height) / 1e5) / 10;
}

// Identify by magic bytes, never by name: the iOS picker hands over JPEG, HEIC,
// PNG and occasionally RAW (DNG), which WebKit cannot decode.
export function sniffImageType(bytes) {
  const b = bytes;
  const ascii = (from, to) => String.fromCharCode(...b.slice(from, to));
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (b.length >= 6 && ascii(0, 4) === 'GIF8') return 'gif';
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (b.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'heic';
    if (brand === 'avif' || brand === 'avis') return 'avif';
    return 'unknown';
  }
  // TIFF-based: DNG / ProRAW and most camera RAW.
  if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) ||
                        (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a))) return 'raw';
  return 'unknown';
}

const FRIENDLY = {
  raw: "That's a RAW photo, which Safari can't open. In Photos, pick the regular version.",
  unknown: "That file doesn't look like a photo Gesso can open. Try a JPEG, HEIC or PNG.",
};

export function importProblem(type) {
  return FRIENDLY[type] ?? null;
}

// ------------------------------------------------------------------ header info

// Stored pixel size and EXIF-style orientation (1..8) from the start of a file
// (the first 64 KB or more), so the importer can ask createImageBitmap for exactly
// the working size in one decode. JPEG: SOFn size and the APP1 Exif IFD0
// Orientation. PNG: IHDR. HEIC/AVIF: the primary item's 'ispe', with its 'irot' /
// 'imir' as an orientation. Anything else, or a header cut off before the size,
// gives null and the importer decodes once at full size instead.
// Every read is bounds-checked: these bytes come from an arbitrary file.
export function readImageInfo(bytes) {
  if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
  if (!bytes || typeof bytes.length !== 'number') return null;
  const type = sniffImageType(bytes);
  let info = null;
  if (type === 'jpeg') info = jpegInfo(bytes);
  else if (type === 'png') info = pngInfo(bytes);
  else if (type === 'heic' || type === 'avif') info = heifInfo(bytes);
  if (!info || !(info.width > 0 && info.height > 0)) return null;
  return { type, width: info.width, height: info.height, orientation: info.orientation };
}

// Displayed size: EXIF orientations 5-8 turn the picture a quarter, so width and
// height trade places.
export function orientedDims(info) {
  const o = info?.orientation;
  const swap = Number.isInteger(o) && o >= 5 && o <= 8;
  return swap ? { w: info.height, h: info.width } : { w: info.width, h: info.height };
}

const u8 = (b, o) => b[o];
const u16 = (b, o, le = false) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
const u32 = (b, o, le = false) => (le
  ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000
  : b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]));
const tag = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

// SOF0-3, 5-7, 9-11, 13-15. C4 (DHT), C8 (JPG) and CC (DAC) share the range but
// carry no frame size.
const isSOF = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

function jpegInfo(b) {
  let orientation = 1;
  let seenExif = false;
  let off = 2;
  while (off + 4 <= b.length) {
    if (b[off] !== 0xff) return null; // lost sync: not a marker where one must be
    const marker = b[off + 1];
    if (marker === 0xff) { off++; continue; } // fill byte
    if (marker === 0x00) return null; // a stuffed byte belongs inside scan data, not here
    // Standalone markers have no length.
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / scan data before any frame size
    const len = u16(b, off + 2);
    if (len < 2) return null;
    const start = off + 4, end = off + 2 + len;
    if (isSOF(marker)) {
      // Precision, height and width must sit inside both the segment and our bytes;
      // a frame header too short to hold them would have us read the next segment.
      if (start + 5 > end || start + 5 > b.length) return null;
      return { height: u16(b, start + 1), width: u16(b, start + 3), orientation };
    }
    // The first Exif APP1 wins; an XMP APP1 or a second Exif block is ignored.
    // Only IFD0 is read, so an APP1 whose thumbnail runs past our bytes still counts.
    if (marker === 0xe1 && !seenExif && isExifHeader(b, start, end)) {
      seenExif = true;
      orientation = exifOrientation(b, start + 6, Math.min(end, b.length)) ?? 1;
    }
    off = end;
  }
  return null;
}

function isExifHeader(b, start, end) {
  return end - start >= 6 + 8 && tag(b, start) === 'Exif' && b[start + 4] === 0;
}

// TIFF header at `t`, offsets relative to it. Reads IFD0's Orientation (0x0112).
function exifOrientation(b, t, end) {
  if (t + 8 > end) return null;
  let le;
  if (b[t] === 0x49 && b[t + 1] === 0x49) le = true;
  else if (b[t] === 0x4d && b[t + 1] === 0x4d) le = false;
  else return null;
  if (u16(b, t + 2, le) !== 42) return null;
  const ifd = t + u32(b, t + 4, le);
  if (ifd + 2 > end) return null;
  const count = u16(b, ifd, le);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end) return null;
    if (u16(b, e, le) !== 0x0112) continue;
    const type = u16(b, e + 2, le);
    // SHORT is the standard; a few writers use LONG. The value sits left-justified
    // in the 4-byte field either way.
    const v = type === 3 ? u16(b, e + 8, le) : type === 4 ? u32(b, e + 8, le) : 0;
    return v >= 1 && v <= 8 ? v : null;
  }
  return null;
}

function pngInfo(b) {
  // Signature (8), then IHDR must be the first chunk: length 13, width, height.
  // Apple's 'crushed' PNGs put a 4-byte CgBI chunk in front of it.
  let off = 8;
  if (b.length >= off + 8 && tag(b, off + 4) === 'CgBI' && u32(b, off) === 4) off += 16;
  if (b.length < off + 16 || u32(b, off) !== 13 || tag(b, off + 4) !== 'IHDR') return null;
  const width = u32(b, off + 8), height = u32(b, off + 12);
  if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) return null;
  return { width, height, orientation: 1 };
}

// ISO-BMFF box at `off` within [off, limit): { type, body, end }, or null if it is
// malformed or its header runs past the data. A box may extend past the bytes we
// have; callers read only what is there.
function box(b, off, limit) {
  if (off + 8 > limit) return null;
  let size = u32(b, off);
  const type = tag(b, off + 4);
  let body = off + 8;
  if (size === 1) {
    if (off + 16 > limit) return null;
    size = u32(b, off + 8) * 2 ** 32 + u32(b, off + 12);
    body = off + 16;
  } else if (size === 0) {
    size = limit - off; // runs to the end of the file
  }
  if (type === 'uuid') body += 16;
  if (size < body - off) return null;
  return { type, body, end: off + size };
}

function* children(b, from, to) {
  const limit = Math.min(to, b.length);
  let off = from;
  while (off < limit) {
    const bx = box(b, off, limit);
    if (!bx) return;
    yield bx;
    off = bx.end;
  }
}

function heifInfo(b) {
  for (const top of children(b, 0, b.length)) {
    if (top.type === 'meta') return heifMeta(b, top.body + 4, top.end); // full box: skip version/flags
  }
  return null;
}

function heifMeta(b, from, to) {
  let primary = null;
  let props = [];
  const assoc = new Map(); // item id -> [1-based property index, ...] in order
  for (const bx of children(b, from, to)) {
    const end = Math.min(bx.end, b.length);
    if (bx.type === 'pitm' && bx.body + 6 <= end) {
      primary = b[bx.body] === 0 ? u16(b, bx.body + 4) : bx.body + 8 <= end ? u32(b, bx.body + 4) : null;
    } else if (bx.type === 'iprp') {
      for (const p of children(b, bx.body, bx.end)) {
        if (p.type === 'ipco') props = [...children(b, p.body, p.end)];
        else if (p.type === 'ipma') readIpma(b, p.body, Math.min(p.end, b.length), assoc);
      }
    }
  }
  const prop = (i) => props[i - 1] ?? null;
  // Property payloads are read only inside their own box (and our bytes): a short,
  // malformed property must not borrow the next box's header as its value.
  const within = (p, n) => p.body + n <= Math.min(p.end, b.length);
  const ispe = (p) => (within(p, 12) ? { width: u32(b, p.body + 4), height: u32(b, p.body + 8) } : null);
  const linked = primary !== null ? assoc.get(primary) : null;
  if (linked) {
    let size = null;
    const transforms = [];
    for (const i of linked) {
      const p = prop(i);
      if (!p) continue;
      if (p.type === 'ispe' && !size) size = ispe(p);
      else if ((p.type === 'irot' || p.type === 'imir') && within(p, 1)) transforms.push({ type: p.type, v: b[p.body] });
    }
    if (size) return { ...size, orientation: heifOrientation(transforms) };
  }
  // No usable association (an odd writer, or a header cut short): the largest
  // 'ispe' is the main image; tiles and thumbnails are smaller.
  let best = null;
  for (const p of props) {
    if (p.type !== 'ispe') continue;
    const s = ispe(p);
    if (s && (!best || s.width * s.height > best.width * best.height)) best = s;
  }
  return best ? { ...best, orientation: 1 } : null;
}

function readIpma(b, body, end, assoc) {
  if (body + 8 > end) return;
  const version = b[body], flags = u32(b, body) & 0xffffff;
  const wide = (flags & 1) === 1;
  let off = body + 4;
  const n = u32(b, off);
  off += 4;
  for (let e = 0; e < n; e++) {
    const idBytes = version < 1 ? 2 : 4;
    if (off + idBytes + 1 > end) return;
    const id = version < 1 ? u16(b, off) : u32(b, off);
    off += idBytes;
    const count = u8(b, off++);
    const list = [];
    for (let k = 0; k < count; k++) {
      if (off + (wide ? 2 : 1) > end) return;
      // Top bit is the 'essential' flag; the rest is the 1-based ipco index (0 = none).
      const index = wide ? u16(b, off) & 0x7fff : b[off] & 0x7f;
      off += wide ? 2 : 1;
      if (index > 0) list.push(index);
    }
    if (!assoc.has(id)) assoc.set(id, list);
  }
}

// HEIF transforms apply in association order. 'irot' turns anticlockwise by
// (v & 3) quarters; 'imir' mirrors about a vertical axis (v & 1 = 0, left-right)
// or a horizontal one (1, top-bottom), per ISO/IEC 23008-12 (writers have
// disagreed on the mirror axis; the importer only relies on whether w and h swap,
// which a mirror never changes). Composed as a 2x2 matrix on centred y-down
// coordinates, then named by its EXIF orientation.
const EXIF_MATRICES = [
  [1, [1, 0, 0, 1]], [2, [-1, 0, 0, 1]], [3, [-1, 0, 0, -1]], [4, [1, 0, 0, -1]],
  [5, [0, 1, 1, 0]], [6, [0, -1, 1, 0]], [7, [0, -1, -1, 0]], [8, [0, 1, -1, 0]],
];

function heifOrientation(transforms) {
  let m = [1, 0, 0, 1]; // [a, b, c, d]: x' = a x + b y, y' = c x + d y
  const then = (n) => [n[0] * m[0] + n[1] * m[2], n[0] * m[1] + n[1] * m[3], n[2] * m[0] + n[3] * m[2], n[2] * m[1] + n[3] * m[3]];
  for (const t of transforms) {
    if (t.type === 'irot') {
      // One anticlockwise quarter on screen (y down): (x, y) -> (y, -x).
      for (let q = 0; q < (t.v & 3); q++) m = then([0, 1, -1, 0]);
    } else {
      m = then((t.v & 1) === 0 ? [-1, 0, 0, 1] : [1, 0, 0, -1]);
    }
  }
  const hit = EXIF_MATRICES.find(([, e]) => e.every((v, i) => v === m[i]));
  return hit ? hit[0] : 1;
}

// ------------------------------------------------------------------ export

// Rows per export band: as many as fit in `maxBandBytes` of RGBA, never more than
// a framebuffer can be tall, and evened out so the last band isn't a sliver.
// Every row 0..outH-1 is in exactly one band, in order.
export function bandPlan(outW, outH, maxBandBytes = 32 * 2 ** 20) {
  const rows = bandRows(outW, outH, maxBandBytes);
  const plan = [];
  for (let y = 0; y < outH; y += rows) plan.push({ y, h: Math.min(rows, outH - y) });
  return plan;
}

function bandRows(outW, outH, maxBandBytes) {
  if (!(Number.isInteger(outW) && Number.isInteger(outH) && outW > 0 && outH > 0)) {
    throw new RangeError(`bandPlan: output size must be positive integers, got ${outW} x ${outH}`);
  }
  const budget = maxBandBytes > 0 ? maxBandBytes : 32 * 2 ** 20;
  const maxRows = Math.max(1, Math.min(MAX_SIDE, Math.floor(budget / (outW * 4))));
  const bands = Math.ceil(outH / maxRows);
  return Math.ceil(outH / bands);
}

// Bytes of an approximate JPEG at quality 0.92: photos land around 0.3-0.6 bytes
// per pixel, so 1 is a safe ceiling for the ledger.
const JPEG_BYTES_PER_PIXEL = 1;

// Peak bytes export needs on top of what is already resident: one band
// framebuffer, the full RGBA readback (transferred, not copied, to the worker),
// the worker's OffscreenCanvas and the encoded JPEG. Pass the working size too to
// include the two mipmapped working textures (pristine and base) and get the
// whole-app peak, which §5.4 budgets at about 560 MB for 24.5 MP.
export function exportPeakBytes(outW, outH, workW = 0, workH = 0) {
  const rows = bandRows(outW, outH, 32 * 2 ** 20);
  const frame = outW * outH * 4;
  let bytes = outW * rows * 4 + frame + frame + outW * outH * JPEG_BYTES_PER_PIXEL;
  if (workW > 0 && workH > 0) bytes += 2 * Math.ceil((workW * workH * 4 * 4) / 3);
  return bytes;
}

// gesso-20261020-094105.jpg (§5.7) — local time, sortable, no characters iOS
// dislikes. Seconds are in the name so two saves in the same minute don't collide
// in Files. A missing or invalid date (the clock is injected) still names a file.
export function exportFileName(date, ext = 'jpg') {
  if (typeof date?.getTime !== 'function' || Number.isNaN(date.getTime())) return `gesso.${ext}`;
  const p = (n) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
  return `gesso-${day}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.${ext}`;
}
