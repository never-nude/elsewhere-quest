// Remove's heavy lifting, off the main thread so the shimmer keeps animating.
// A module worker: new Worker(new URL('../workers/heal-worker.js', import.meta.url), { type: 'module' }).
//
//   { type: 'find', job, img, mask, maxResults }    -> { type: 'found', job, sources }
//   { type: 'correct', job, img, mask, dx, dy }     -> { type: 'corrected', job, tile, dx, dy }
//   { type: 'inpaint', job, img, mask, scale, seed } -> { type: 'inpainted', job, tile }
//   any failure                                     -> { type: 'error', job, message }
//
// All the logic lives in lib/heal.js (handleHealMessage) where node tests reach
// it; result pixels are transferred, not copied.

import { handleHealMessage } from '../lib/heal.js';

self.addEventListener('message', (event) => {
  const { message, transfer } = handleHealMessage(event.data);
  self.postMessage(message, transfer);
});
