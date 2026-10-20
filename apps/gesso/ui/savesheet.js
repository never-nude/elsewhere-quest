// Save to Photos (§F15): the sheet that rises on Save.
//
//   openSaveSheet(ed, { captions })
//
// The JPEG starts encoding the moment the sheet opens, and the result is kept per
// document state (ed.doc at that revision; states are immutable, so the same
// object means the same pixels): reopening without an edit is instant. The button
// reads "Preparing…" over a progress fill, then "Save to Photos" with [data-ready].
//
// The tap calls navigator.share({ files: [jpeg] }) synchronously inside the click
// handler with an already-encoded File: iOS refuses a share that comes after an
// await. AbortError (the share sheet was closed) leaves the sheet as it was. No
// share support, or any other failure, opens the long-press fallback (#fallback).
// Success: "Done. It's the newest photo in Photos.", ed.markSaved(), and the
// coaching line ("Next, tap Save Image.") is retired for good.
//
// Closing: Keep editing, the scrim, Escape, or a swipe down on the sheet. Closing
// before the JPEG is ready cancels the export so editing stays smooth.

import { exportJpeg, isAbort } from './exporter.js';
import { createCaptions } from './captions.js';
import { exportFileName } from '../lib/image-io.js';
import {
  JPEG_TYPE, RENDER_SHARE, ENCODE_CEILING, encodeEstimateMs, previewFit,
  shareRoute, shareOutcome, swipeCloses, sheetOffset,
} from '../lib/export-plan.js';

const SAVED_ONCE_KEY = 'gesso:savedOnce';

let ui = null; // DOM and listeners, wired on first open
let session = null; // { ed, captions } while the sheet is open
let job = null; // the export of one document state
let sharing = false;
let fallbackUrl = '';
let fillTarget = '';

export function openSaveSheet(ed, { captions = null } = {}) {
  if (!ed?.doc) return;
  ui ??= install(document);
  const reopening = session !== null;
  session = { ed, captions: captions ?? ed.captions ?? null };
  sharing = false;
  if (!reopening) ui.returnFocus = document.activeElement;
  ui.sheet.hidden = false;
  resetCard();
  ui.main.hidden = false;
  ui.done.hidden = true;
  ui.coach.hidden = savedOnce();
  try {
    drawPreview(ed);
  } catch (err) {
    console.warn('save: no preview', err); // the save itself can still work
  }
  showJob(ensureJob(ed, session.captions));
  ui.card.focus({ preventScroll: true });
}

// ------------------------------------------------------------------ the export

function ensureJob(ed, captions) {
  if (job && job.doc === ed.doc && !job.error) return job;
  dropUnfinished();
  const j = { doc: ed.doc, size: ed.outputSize(), blob: null, error: null, progress: 0, controller: new AbortController() };
  job = j;
  setFill(0, 0);
  exportJpeg(ed, {
    captions,
    signal: j.controller.signal,
    onProgress: (f) => {
      j.progress = f;
      if (job === j && session) showJob(j);
    },
  }).then(
    (blob) => { j.blob = blob; },
    (err) => {
      j.error = err;
      if (!isAbort(err)) console.error('save: export failed', err);
    },
  ).finally(() => {
    if (job === j && session) showJob(j);
  });
  return j;
}

function dropUnfinished() {
  if (job && !job.blob && !job.error) {
    job.controller.abort();
    job = null;
  }
}

function showJob(j) {
  const { share, label } = ui;
  if (j.blob) {
    share.disabled = sharing;
    share.setAttribute('data-ready', '');
    share.removeAttribute('aria-busy');
    label.textContent = 'Save to Photos';
    setFill(1, 150);
  } else if (j.error) {
    share.disabled = false;
    share.removeAttribute('data-ready');
    share.removeAttribute('aria-busy');
    label.textContent = "Couldn't prepare. Try again";
    setFill(0, 0);
  } else {
    share.disabled = true;
    share.removeAttribute('data-ready');
    share.setAttribute('aria-busy', 'true');
    label.textContent = 'Preparing…';
    // The encoder is silent: pace the fill on an estimate, short of the end.
    if (j.progress >= RENDER_SHARE) setFill(ENCODE_CEILING, encodeEstimateMs(j.size.width, j.size.height));
    else setFill(j.progress, 200);
  }
}

function setFill(f, ms) {
  const width = `${(Math.max(0, Math.min(1, f)) * 100).toFixed(1)}%`;
  if (fillTarget === width) return; // keep a running transition going
  fillTarget = width;
  ui.fill.style.transition = ms > 0 ? `width ${ms}ms ${ms > 400 ? 'linear' : 'ease-out'}` : 'none';
  ui.fill.style.width = width;
}

// ------------------------------------------------------------------ sharing

function onShareClick() {
  if (!session || sharing) return;
  const j = job;
  if (!j?.blob) {
    if (!j || j.error) showJob(ensureJob(session.ed, session.captions)); // Try again
    return;
  }
  // Everything up to navigator.share stays synchronous: iOS only shares from
  // inside the tap.
  const file = new File([j.blob], exportFileName(new Date()), { type: JPEG_TYPE });
  const data = { files: [file] };
  if (shareRoute(navigator, data) === 'fallback') {
    showFallback(j.blob);
    return;
  }
  let pending;
  try {
    pending = navigator.share(data);
  } catch (err) {
    pending = Promise.reject(err);
  }
  sharing = true;
  ui.share.disabled = true;
  Promise.resolve(pending).then(() => settleShare(j, null), (err) => settleShare(j, err ?? new Error('share failed')));
}

function settleShare(j, err) {
  sharing = false;
  if (!session || job !== j) return; // closed, or a different photo by now
  const outcome = shareOutcome(err);
  if (outcome === 'saved') {
    showDone(j);
    return;
  }
  if (outcome === 'failed') {
    console.warn('save: share failed, offering the long-press fallback', err);
    showFallback(j.blob);
  }
  showJob(j);
}

function showDone(j) {
  try { localStorage.setItem(SAVED_ONCE_KEY, '1'); } catch { /* private mode: coach again next time */ }
  ui.coach.hidden = true;
  ui.main.hidden = true;
  ui.done.hidden = false;
  if (session.ed.doc === j.doc) session.ed.markSaved();
  ui.card.focus({ preventScroll: true });
}

function savedOnce() {
  try { return localStorage.getItem(SAVED_ONCE_KEY) === '1'; } catch { return false; }
}

// The long-press route: a full-screen <img> of the JPEG. iOS offers Save to Photos
// from its touch-and-hold menu, which the body's touch-callout: none would block.
function showFallback(blob) {
  hideFallback();
  fallbackUrl = URL.createObjectURL(blob);
  ui.fallbackImg.style.setProperty('-webkit-touch-callout', 'default');
  ui.fallbackImg.src = fallbackUrl;
  ui.fallback.hidden = false;
  ui.fallbackClose.focus({ preventScroll: true });
}

function hideFallback() {
  if (!ui) return;
  ui.fallback.hidden = true;
  if (fallbackUrl) {
    ui.fallbackImg.removeAttribute('src');
    URL.revokeObjectURL(fallbackUrl);
    fallbackUrl = '';
  }
}

// ------------------------------------------------------------------ the sheet

function closeSheet() {
  if (!ui || ui.sheet.hidden) return;
  dropUnfinished();
  hideFallback();
  ui.sheet.hidden = true;
  resetCard();
  session = null;
  sharing = false;
  const back = ui.returnFocus;
  ui.returnFocus = null;
  if (back && back.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
}

// The preview is the export, small: same render pass, same caption layout
// (laid out at the full output size and drawn scaled, as on the stage).
function drawPreview(ed) {
  const canvas = ui.preview;
  const o = ed.outputSize();
  const maxH = parseFloat(getComputedStyle(canvas).maxHeight) || 280;
  const boxW = ui.previewBox.clientWidth || ui.card.clientWidth - 32;
  const fit = previewFit(o.width, o.height, boxW, maxH, window.devicePixelRatio || 1);
  const img = ed.readOutput({ maxSide: fit.maxSide, tone: true });
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.style.width = `${fit.cssW}px`;
  canvas.style.height = `${fit.cssH}px`;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  const doc = ed.doc;
  if (Array.isArray(doc.text) && doc.text.length > 0) {
    const scale = img.width / o.width;
    const view = { scale, x: 0, y: 0, fit: scale };
    createCaptions({ doc, view, outputSize: () => o, toolId: 'save' }).draw(ctx, 1);
  }
}

function resetCard() {
  ui.card.style.transition = '';
  ui.card.style.translate = '';
  ui.scrim.style.transition = '';
  ui.scrim.style.opacity = '';
}

function slideOutAndClose() {
  ui.card.style.transition = 'translate 0.18s ease-in';
  ui.card.style.translate = '0 100%';
  ui.scrim.style.transition = 'opacity 0.18s ease-in';
  ui.scrim.style.opacity = '0';
  setTimeout(closeSheet, 180);
}

function install(root) {
  const $ = (s) => root.querySelector(s);
  const els = {
    sheet: $('#sheet'),
    scrim: $('#sheet .sheet__scrim'),
    card: $('#sheet .sheet__card'),
    preview: $('#sheet-preview'),
    previewBox: $('#sheet .sheet__preview'),
    main: $('#sheet-main'),
    share: $('#share'),
    fill: $('#share .sheet__progress'),
    label: $('#share-label'),
    coach: $('#sheet-coach'),
    done: $('#sheet-done'),
    newPhoto: $('#sheet-new'),
    fallback: $('#fallback'),
    fallbackImg: $('#fallback-img'),
    fallbackClose: $('#fallback-close'),
    returnFocus: null,
  };
  els.card.tabIndex = -1; // focus lands in the dialog, not behind it

  els.share.addEventListener('click', onShareClick);
  els.sheet.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeSheet();
  });
  els.newPhoto.addEventListener('click', () => {
    const ed = session?.ed;
    closeSheet();
    job = null; // that photo is in Photos; let its JPEG go
    ed?.newPhoto();
  });
  els.fallbackClose.addEventListener('click', hideFallback);
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || els.sheet.hidden) return;
    if (!els.fallback.hidden) hideFallback();
    else closeSheet();
  });

  // Swipe down to close, from the grabber or anywhere on the card that isn't a
  // button. The card follows the finger; `translate` composes with the landscape
  // centring transform.
  els.card.style.touchAction = 'none';
  let drag = null;
  els.card.addEventListener('pointerdown', (e) => {
    if (drag || (e.pointerType === 'mouse' && e.button !== 0) || e.target.closest('button')) return;
    drag = { id: e.pointerId, y0: e.clientY, dy: 0, t: e.timeStamp, v: 0 };
    els.card.setPointerCapture?.(e.pointerId);
    els.card.style.transition = 'none';
  });
  els.card.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y0;
    const dt = Math.max(1, e.timeStamp - drag.t);
    drag.v = (dy - drag.dy) / dt;
    drag.dy = dy;
    drag.t = e.timeStamp;
    els.card.style.translate = `0 ${sheetOffset(dy)}px`;
    const h = els.card.offsetHeight || 1;
    els.scrim.style.opacity = String(1 - Math.min(1, Math.max(0, dy) / h) * 0.8);
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { dy, v } = drag;
    drag = null;
    if (e.type === 'pointerup' && swipeCloses(dy, v)) {
      slideOutAndClose();
      return;
    }
    els.card.style.transition = 'translate 0.2s cubic-bezier(0.2, 0.7, 0.2, 1)';
    els.card.style.translate = '';
    els.scrim.style.opacity = '';
  };
  els.card.addEventListener('pointerup', end);
  els.card.addEventListener('pointercancel', end);
  return els;
}
