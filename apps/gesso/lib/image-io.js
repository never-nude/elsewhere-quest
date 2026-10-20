// Import/export decisions that don't need a DOM: how big to edit at, what a file
// really is, and what to call the export.

// iOS Safari caps a canvas at 8192 px per side (IOSurface) and the page is killed
// somewhere around 1-1.5 GB. The working image is uploaded once, plus a retouch
// layer, a draw layer and a couple of render targets, so 12.6 MP (4096 x 3072,
// the native size of a 12 MP iPhone frame) keeps the whole editor well inside that.
export const MAX_WORKING_PIXELS = 4096 * 3072;
export const MAX_SIDE = 8192;

export function fitWorkingSize(width, height, maxPixels = MAX_WORKING_PIXELS, maxSide = MAX_SIDE) {
  if (!(width > 0 && height > 0)) throw new Error('image has no pixels');
  let scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
  scale = Math.min(scale, maxSide / width, maxSide / height);
  const w = Math.max(1, Math.floor(width * scale));
  const h = Math.max(1, Math.floor(height * scale));
  return { width: w, height: h, scale: w / width, downscaled: w < width || h < height };
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
  raw: "That's a RAW photo, which Safari can't open. In Photos, pick the regular version (or turn off RAW for this shot) and try again.",
  unknown: "That file doesn't look like a photo Gesso can open. Try a JPEG, HEIC or PNG.",
};

export function importProblem(type) {
  return FRIENDLY[type] ?? null;
}

// gesso-2026-10-20-0941.jpg — local time, sortable, no characters iOS dislikes.
export function exportFileName(date, ext = 'jpg') {
  const p = (n) => String(n).padStart(2, '0');
  return `gesso-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}.${ext}`;
}
