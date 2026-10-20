// Turn a picked file into an ImageBitmap at the working size.
//
// WebKit applies EXIF orientation and resizes during createImageBitmap, so we read
// the header first to know the oriented size, ask for exactly the working size in
// one decode (no 48 MP intermediate), and never rotate pixels ourselves.

import { sniffImageType, importProblem, fitWorkingSize, readImageInfo, orientedDims } from '../lib/image-io.js';

export class ImportError extends Error {}

const HEADER_BYTES = 256 * 1024;

export async function decodeForEditing(file, { maxPixels } = {}) {
  const head = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
  const type = sniffImageType(head);
  const problem = importProblem(type);
  if (problem) throw new ImportError(problem);

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
    bitmap = await createImageBitmap(full, { resizeWidth: fit.width, resizeHeight: fit.height, resizeQuality: 'high' });
    const natW = full.width, natH = full.height;
    full.close();
    return { bitmap, type, natW, natH, downscaled: true };
  } catch (err) {
    if (err instanceof ImportError) throw err;
    throw new ImportError("This photo couldn't be opened.");
  }
}

function decodeAt(file, width, height) {
  return createImageBitmap(file, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
}
