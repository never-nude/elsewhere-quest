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
import home from './ui/tools/home.js';
import crop from './ui/tools/crop.js';
import light from './ui/tools/light.js';
import color from './ui/tools/color.js';
import remove from './ui/tools/remove.js';
import text from './ui/tools/text.js';

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
      $('#busy').hidden = false;
      $('#busy span').textContent = 'Recovering…';
      restoring = setTimeout(() => location.reload(), 3000); // autosave brings the work back
    },
    onRestored: async () => {
      clearTimeout(restoring);
      try {
        if (currentFile) {
          const { bitmap } = await decodeForEditing(currentFile, { maxPixels: workCap() });
          renderer.loadSource(bitmap);
          bitmap.close();
          editor.resync();
        }
      } finally {
        $('#busy').hidden = true;
      }
    },
  });

  if (!renderer.ok) {
    fatal('Gesso needs WebGL, which this browser (or Lockdown Mode) has turned off.');
    return;
  }

  const store = await openStore();
  if (!store.available) $('#hint').textContent = "Edits won't be kept if you leave Gesso.";

  const tools = { home, crop, light, color, remove, text };
  let editor = null;
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
  installBubble(editor);

  // ---- import ------------------------------------------------------------------
  const fileInput = $('#file');
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    await importFile(file);
  });

  async function importFile(file) {
    const busy = $('#busy');
    busy.hidden = false;
    $('#busy span').textContent = 'Opening…';
    try {
      let decoded;
      try {
        decoded = await decodeForEditing(file, { maxPixels: workCap() });
        renderer.loadSource(decoded.bitmap);
      } catch (err) {
        if (err instanceof ImportError) throw err;
        // Out of memory or GPU trouble at full size: step down once, for good.
        decoded?.bitmap?.close?.();
        stepDownWorkCap();
        decoded = await decodeForEditing(file, { maxPixels: WORK_FALLBACK_PIXELS });
        renderer.loadSource(decoded.bitmap);
      }
      decoded.bitmap.close();
      currentFile = file;
      const id = `d${Date.now().toString(36)}`;
      editor.begin({ id, info: { type: decoded.type, natW: decoded.natW, natH: decoded.natH, name: file.name }, now: Date.now() });
      await autosave.startDraft(id, file);
      if (decoded.downscaled) {
        const mp = Math.round((renderer.size.width * renderer.size.height) / 1e5) / 10;
        editor.panel.showTip(`Editing at ${mp} MP`);
      }
    } catch (err) {
      console.error(err);
      const msg = err instanceof ImportError ? err.message : "This photo couldn't be opened.";
      $('#hint').textContent = msg;
      editor.toast?.(msg, 2600);
    } finally {
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
      if (id === 'save') openSaveSheet(ed, { captions });
      else if (id === 'discard') { autosave.discard?.(); fileInput.click(); }
    },
  };
  $('#new-photo').addEventListener('click', () => askNewPhoto());

  // ---- restore -----------------------------------------------------------------
  try {
    const draft = await autosave.loadDraft();
    if (draft) {
      const { bitmap } = await decodeForEditing(draft.file, { maxPixels: draft.maxPixels ?? workCap() });
      renderer.loadSource(bitmap);
      bitmap.close();
      currentFile = draft.file;
      editor.resume(draft);
      editor.toast('Restored your last edit', 1800);
    }
  } catch (err) {
    console.warn('restore failed', err);
    autosave.discard?.();
    $('#hint').textContent = "Your last edit couldn't be restored.";
  }

  // ---- install line, offline shell ------------------------------------------------
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let hideInstall = false;
  try { hideInstall = localStorage.getItem('gesso:hideInstall') === '1'; } catch { /* ignore */ }
  if (!standalone && !hideInstall) $('#install').hidden = false;
  $('#install-hide').addEventListener('click', () => {
    $('#install').hidden = true;
    try { localStorage.setItem('gesso:hideInstall', '1'); } catch { /* ignore */ }
  });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch(() => {});
  }
  navigator.storage?.persist?.().catch(() => {});

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') autosave.flush();
  });
  window.addEventListener('pagehide', () => autosave.flush());

  window.gesso = { editor, renderer, importFile }; // handy for the on-device probe and tests
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
