// Turn a picked file into an ImageBitmap at the working size.
//
// WebKit applies EXIF orientation and resizes during createImageBitmap, so we read
// the header first to know the oriented size, ask for exactly the working size in
// one decode (no 48 MP intermediate), and never rotate pixels ourselves.

import { sniffImageType, importProblem, fitWorkingSize, readImageInfo, orientedDims } from '../lib/image-io.js';
import * as platform from './platform.js';

export class ImportError extends Error {}

const HEADER_BYTES = 256 * 1024;

export async function decodeForEditing(file, { maxPixels, nativeAdapter = platform } = {}) {
  const head = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
  const type = sniffImageType(head);
  const problem = importProblem(type);
  const native = nativeAdapter.isNative;
  const meta = native ? nativeAdapter.nativeInfo(file) : null;
  try {
    if (problem) throw Object.assign(new ImportError(problem), { unsupported: true });
    const decoded = await decodeWeb(file, head, type, maxPixels);
    return meta ? { ...decoded, natW: meta.natW, natH: meta.natH, downscaled: meta.downscaled || decoded.downscaled, sourceFile: file } : decoded;
  } catch (err) {
    // A rendered PNG failing again is an allocation problem, not an unsupported
    // original. Keep the app's 12 MP retry available without another bridge trip.
    if (native && !meta?.rendered) {
      let normalized;
      try {
        normalized = await nativeAdapter.decodeNative(file, { maxPixels });
      } catch (nativeErr) {
        throw importFailure(type, nativeErr, true, !!problem);
      }
      try {
        const pngHead = new Uint8Array(await normalized.file.slice(0, HEADER_BYTES).arrayBuffer());
        const decoded = await decodeWeb(normalized.file, pngHead, sniffImageType(pngHead), maxPixels);
        return { ...decoded, sourceFile: normalized.file, natW: normalized.natW, natH: normalized.natH, downscaled: normalized.downscaled || decoded.downscaled };
      } catch (decodeErr) {
        throw importFailure('png', decodeErr, true);
      }
    }
    if (!native && err instanceof ImportError) throw err;
    throw importFailure(type, err, native, !meta?.rendered && !!problem);
  }
}

async function decodeWeb(file, head, type, maxPixels) {
  const info = readImageInfo?.(head) ?? null;
  let bitmap;
  try {
    if (info && info.width && info.height) {
      const o = orientedDims(info);
      const fit = fitWorkingSize(o.w, o.h, maxPixels);
      bitmap = await decodeAt(file, fit.width, fit.height);
      // WebKit can disagree about whether the resize applies before or after the
      // EXIF rotation; if the aspect came out turned, ask again the other way.
      if (Math.sign(bitmap.width - bitmap.height) !== Math.sign(fit.width - fit.height) && fit.width !== fit.height) {
        bitmap.close();
        bitmap = await decodeAt(file, fit.height, fit.width);
      }
      return { bitmap, type, natW: o.w, natH: o.h, downscaled: fit.downscaled };
    }
    // No readable header: decode once at full size, then shrink if needed.
    const full = await createImageBitmap(file);
    const fit = fitWorkingSize(full.width, full.height, maxPixels);
    if (!fit.downscaled) return { bitmap: full, type, natW: full.width, natH: full.height, downscaled: false };
    const natW = full.width, natH = full.height;
    try {
      bitmap = await createImageBitmap(full, { resizeWidth: fit.width, resizeHeight: fit.height, resizeQuality: 'high' });
    } finally { full.close(); }
    return { bitmap, type, natW, natH, downscaled: true };
  } catch (err) {
    if (err instanceof ImportError) throw err;
    // Safari opens a plain TIFF; one it can't open is DNG (ProRAW) or camera RAW.
    throw new ImportError(type === 'tiff' ? importProblem('raw') : "This photo couldn't be opened.");
  }
}

function importFailure(type, err, native, unsupported = false) {
  if (!native) return err instanceof ImportError ? err : new ImportError(type === 'tiff' ? importProblem('raw') : "This photo couldn't be opened.");
  if (['memory', 'size', 'timeout', 'transport'].includes(err?.code)) unsupported = false;
  const message = unsupported ? 'Gesso could not read this photo. Try a JPEG, HEIC or PNG.' : "This photo couldn't be opened. Close Gesso and try again.";
  return Object.assign(new ImportError(message), { unsupported });
}

function decodeAt(file, width, height) {
  return createImageBitmap(file, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
}
