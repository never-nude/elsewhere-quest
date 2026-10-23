// Gesso bootstrap: probe WebGL2, open storage, build the editor, restore the last
// edit or wait for a photo, and keep the offline shell fresh.

import { createRenderer } from './ui/renderer.js';
import { createEditor } from './ui/editor.js';
import { decodeForEditing, ImportError } from './ui/importer.js';
import { WORK_MAX_PIXELS, WORK_FALLBACK_PIXELS } from './lib/image-io.js';
import { openStore } from './ui/store.js';
import { createAutosave } from './ui/autosave.js';
import { createHints } from './ui/hints-ui.js';
import { createCaptions } from './ui/captions.js';
import { openSaveSheet } from './ui/savesheet.js';
import { attachTape } from './ui/tape.js';
import { attachNavigator } from './ui/navigator.js';
import home from './ui/tools/home.js';
import crop from './ui/tools/crop.js';
import light from './ui/tools/light.js';
import color from './ui/tools/color.js';
import remove from './ui/tools/remove.js';
import text from './ui/tools/text.js';
import { isNative, pickPhoto } from './ui/platform.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);

const WORK_CAP_KEY = 'gesso:workCap';
function workCap() {
  try { return Number(localStorage.getItem(WORK_CAP_KEY)) || WORK_MAX_PIXELS; } catch { return WORK_MAX_PIXELS; }
}
function stepDownWorkCap() {
  try { localStorage.setItem(WORK_CAP_KEY, String(WORK_FALLBACK_PIXELS)); } catch { /* memory only */ }
}

// iOS: no page pinch-zoom or double-tap zoom over the editor; all gestures are ours.
for (const t of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
}

if (params.get('probe') === '1') {
  import('./ui/probe.js').then((m) => m.runProbe(document.body));
} else {
  main().catch((err) => {
    console.error(err);
    fatal("Something went wrong starting Gesso. Reload to try again.");
  });
}

function fatal(message) {
  const hint = $('#hint');
  if (hint) hint.textContent = message;
  $('#choose')?.setAttribute('hidden', '');
}

async function main() {
  const glCanvas = $('#gl');
  let restoring = null;
  let currentFile = null; // the original Blob, the source of truth for restores
  const renderer = createRenderer(glCanvas, {
    onLost: () => {
      // Nothing reads or edits the photo until it is back on the GPU (Save would
      // otherwise export a black picture).
      $('#app').inert = true;
      $('#busy').hidden = false;
      $('#busy span').textContent = 'Recovering…';
      restoring = setTimeout(() => location.reload(), 3000); // autosave brings the work back
    },
    onRestored: async () => {
      clearTimeout(restoring);
      try {
        const file = currentFile;
        if (file) {
          const { bitmap } = await decodeForEditing(file, { maxPixels: autosave.maxPixels ?? workCap() });
          // A photo picked meanwhile uploads itself; this one must not land under it.
          if (file !== currentFile || importing) { bitmap.close(); return; }
          renderer.loadSource(bitmap);
          bitmap.close();
          editor.resync();
        }
      } catch (err) {
        console.error(err);
        location.reload(); // autosave brings the work back
      } finally {
        $('#app').inert = false;
        $('#busy').hidden = true;
      }
    },
  });

  if (!renderer.ok) {
    fatal(isNative ? 'Gesso needs WebGL, which Lockdown Mode may have turned off.' : 'Gesso needs WebGL, which this browser (or Lockdown Mode) has turned off.');
    return;
  }

  // "Choose a photo" works from the first paint: a photo picked while the store is
  // still opening (up to 3 s if IndexedDB hangs) is kept for when the editor is ready.
  const fileInput = $('#file');
  let earlyFile = null;
  let editor = null;
  let receiveFile = (file) => { earlyFile = file; };
  let picking = false;
  // Labels and every programmatic chooser route through this input. Cancelling
  // its click suppresses WebKit's picker without changing the Safari paths.
  fileInput.addEventListener('click', (e) => {
    if (!isNative) return;
    e.preventDefault();
    if (picking) return;
    picking = true;
    pickPhoto({ maxPixels: workCap(), input: fileInput }).then((file) => {
      if (file) receiveFile(file);
    }).catch((err) => {
      console.warn('photo picker failed', err);
      if (err?.code === 'cancelled') return;
      const message = err?.code === 'busy' ? 'Finish the open sheet, then choose a photo.' : "This photo couldn't be opened. Please choose it again.";
      if (editor?.committed) editor.toast(message, 4000);
      else $('#hint').textContent = message;
    }).finally(() => { picking = false; });
  }, true);
  const keepEarly = () => { earlyFile = fileInput.files?.[0] ?? earlyFile; fileInput.value = ''; };
  fileInput.addEventListener('change', keepEarly);
  // The label needs no JS to open the picker from a tap; as a button (index.html) it
  // also takes keyboard focus, and Enter or Space opens the picker.
  $('#choose').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    fileInput.click();
  });

  const store = await openStore();
  if (!store.available) $('#hint').textContent = "Edits won't be kept if you leave Gesso.";

  const tools = { home, crop, light, color, remove, text };
  const autosave = createAutosave(store, () => editor, { debounceMs: 300 });
  const hints = createHints(() => editor);

  editor = createEditor({
    root: document,
    renderer,
    tools,
    hints,
    store: autosave,
    onSave: (ed) => openSaveSheet(ed, { captions }),
    onNewPhoto: () => askNewPhoto(),
  });
  const captions = createCaptions(editor);
  editor.drawCaptions = (ctx, alpha) => captions.draw(ctx, alpha);
  editor.hitCaption = (x, y) => captions.hit(x, y);
  editor.captions = captions;
  attachTape(editor, $('#undo'));
  attachNavigator(editor);
  installBubble(editor);

  // ---- import ------------------------------------------------------------------
  fileInput.removeEventListener('change', keepEarly);
  receiveFile = importFile;
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    await importFile(file);
  });

  let importing = false;
  async function importFile(file) {
    const busy = $('#busy');
    importing = true;
    busy.hidden = false;
    $('#busy span').textContent = 'Opening…';
    try {
      let decoded;
      let sourceFile = file;
      try {
        decoded = await decodeForEditing(file, { maxPixels: workCap() });
        sourceFile = decoded.sourceFile ?? file;
        renderer.loadSource(decoded.bitmap);
      } catch (err) {
        decoded?.bitmap?.close?.();
        // A lost context is not a memory problem: it says nothing about the size. A
        // failed decode can be (WebKit rejects createImageBitmap when it can't
        // allocate the bitmap); a file no size can open, or a cap already down, not.
        if (err?.unsupported || renderer.lost || workCap() <= WORK_FALLBACK_PIXELS) throw err;
        // Out of memory or GPU trouble at full size: step down for good, once the
        // smaller size has worked.
        decoded = await decodeForEditing(sourceFile, { maxPixels: WORK_FALLBACK_PIXELS });
        renderer.loadSource(decoded.bitmap);
        stepDownWorkCap();
      }
      decoded.bitmap.close();
      currentFile = decoded.sourceFile ?? sourceFile;
      const id = `d${Date.now().toString(36)}`;
      editor.begin({ id, info: { type: decoded.type, natW: decoded.natW, natH: decoded.natH, name: file.name }, now: Date.now() });
      autosave.startDraft(id, currentFile); // normalized RAW pixels are the restorable source
      if (decoded.downscaled) {
        const mp = Math.round((renderer.size.width * renderer.size.height) / 1e5) / 10;
        editor.panel.showTip(`Editing at ${mp} MP`);
      }
    } catch (err) {
      console.error(err);
      const msg = err instanceof ImportError ? err.message : "This photo couldn't be opened.";
      // While editing, a toast: the open tool keeps its hint. On the start screen
      // the hint line says it, and nothing else does.
      if (editor.committed) editor.toast(msg, 4000);
      else $('#hint').textContent = msg;
    } finally {
      importing = false;
      busy.hidden = true;
    }
  }

  // ---- new photo ---------------------------------------------------------------
  function askNewPhoto() {
    if (!editor.committed || editor.isSaved || !editor.history || !hasEdits(editor)) {
      fileInput.click();
      return;
    }
    editor.openTool('confirm');
  }
  tools.confirm = {
    id: 'confirm',
    viewMode: 'output',
    panel: () => ({
      title: 'Start a new photo?',
      hint: "This edit isn't in Photos yet.",
      cancel: false,
      done: false,
      quick: [
        { id: 'save', label: 'Save first', kind: 'action' },
        { id: 'discard', label: 'Discard edit', kind: 'action' },
        { id: 'keep', label: 'Keep editing', kind: 'action' },
      ],
      dials: [],
      slot: null,
    }),
    onQuick(ed, id) {
      ed.closeTool({ cancel: true });
      // The Save button's own path: a fill still computing lands in the copy first.
      if (id === 'save') $('#save').click();
      else if (id === 'discard') { autosave.discard?.(); fileInput.click(); }
    },
  };
  $('#new-photo').addEventListener('click', () => askNewPhoto());

  // ---- restore -----------------------------------------------------------------
  // "Choose a photo" stays live meanwhile: a photo picked before the restore lands
  // wins, and the restore stands down.
  const picked = () => importing || !!editor.committed;
  if (earlyFile) importFile(earlyFile);
  let damaged = true; // until the stored draft has been read and checked
  try {
    const draft = picked() ? null : await autosave.loadDraft();
    damaged = false; // past here a failure is the decoder or the GPU, which can pass
    if (draft && !picked()) {
      $('#busy').hidden = false;
      $('#busy span').textContent = 'Opening…';
      const { bitmap } = await decodeForEditing(draft.file, { maxPixels: draft.maxPixels ?? workCap() });
      if (picked()) {
        bitmap.close();
      } else {
        renderer.loadSource(bitmap);
        bitmap.close();
        // Fills are pixels at the working size: a photo that decodes at any other
        // size would put every one of them in the wrong place.
        const src = draft.history.entries[0].state.source;
        const got = renderer.size;
        if (got.width !== src.w || got.height !== src.h) {
          renderer.unloadSource();
          damaged = true;
          throw new Error(`restore: decoded ${got.width}x${got.height}, edited at ${src.w}x${src.h}`);
        }
        currentFile = draft.file;
        editor.resume(draft);
        editor.toast('Restored your last edit', 1800);
      }
    }
  } catch (err) {
    console.warn('restore failed', err);
    if (!picked() && damaged) {
      autosave.discard?.();
      $('#hint').textContent = "Your last edit couldn't be restored.";
    } else if (!picked()) {
      // Out of memory or a GPU reset at launch: keep the draft (its original may be
      // the only copy, from Take Photo) for the next launch.
      $('#hint').textContent = "Your last edit couldn't be opened just now. Close Gesso and open it again.";
    }
  } finally {
    if (!importing) $('#busy').hidden = true;
  }

  // ---- install line, offline shell ------------------------------------------------
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let hideInstall = false;
  try { hideInstall = localStorage.getItem('gesso:hideInstall') === '1'; } catch { /* ignore */ }
  if (!isNative && !standalone && !hideInstall) $('#install').hidden = false;
  $('#install-hide').addEventListener('click', () => {
    $('#install').hidden = true;
    try { localStorage.setItem('gesso:hideInstall', '1'); } catch { /* ignore */ }
  });

  if (!isNative && 'serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch(() => {});
  }
  // openStore() asks for persistent storage (store.persistent).

  const flush = () => { editor.commitTyping(); return autosave.flush(); };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);

  window.gesso = { editor, renderer, importFile, flush }; // native lifecycle, probe and tests
}

function hasEdits(ed) {
  return ed.history && ed.history.entries ? ed.history.entries.length > 1 : true;
}

// The value bubble over the photo while scrubbing a dial.
function installBubble(ed) {
  const el = $('#bubble');
  ed.bubble = (text, x, y) => {
    if (!text) { el.hidden = true; return; }
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y - 70}px`;
    el.hidden = false;
  };
}
