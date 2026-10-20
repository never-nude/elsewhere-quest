// Text: words on the photo. Opening Text from the dock adds "Your words" with the
// keyboard already up and the words selected, so typing replaces them; Done in the
// edit bar makes the caption one undo step. After Done the panel offers six styles
// (Quick), Size · Angle · Color · Add · Delete (Dials), and on the photo: tap a
// caption to select it, tap it again to edit its words, drag to move it (snapping
// to the centre and thirds), drag its corner handle or pinch it to size and turn.
//
// Captions are plain data in doc.text (lib/doc.js), normalized to the output;
// ui/captions.js draws and hit-tests them (ed.captions), lib/text-layout.js does
// the caption maths and lib/caption-edit.js the document edits.
//
// iOS raises the keyboard only for a focus() made inside a user gesture, so every
// path into editing (the dock tap via open(), Add, a tap on the selected caption)
// focuses the textarea synchronously in that gesture's handler.

import { STYLES, SWATCHES, newCaption, applyHandleDrag, applyPinch, captionBounds } from '../../lib/text-layout.js';
import { RULERS, clampValue, formatValue } from '../../lib/ruler.js';
import {
  MAX_CAPTION_CHARS, clipCaptionText, findCaption, withCaption, withoutCaption, updateCaption, freeSpot,
  moveCaption, snapThreshold, editSelection, editBarTop, isKeyboardUp, stageShift, captionId, handleWins,
} from '../../lib/caption-edit.js';

const HANDLE_HIT = 22; // pt: a 44pt target around the 12pt handle
const SNAP_PT = 6;
const GUIDE_COLOR = '#ff7a2f';
const DEFAULT_COLOR = SWATCHES[0].hex;

let edRef = null;
let selectedId = null;
let dial = 'size'; // 'size' | 'angle' | 'color'
let editing = null; // { id, isNew, draft } while the keyboard is up
let drag = null; // { kind: 'move'|'handle', id, base, lay, from, out, threshold, cap }
let pinch = null; // { id, base, cap }
let guides = [];
let bar = null; // { el, input, done }
let shift = 0;
let thumbsQueued = false;

const selected = (ed) => findCaption(ed.doc, selectedId);
const colorLabel = (hex) => SWATCHES.find((s) => s.hex === String(hex).toLowerCase())?.label ?? 'Custom';

function select(ed, id) {
  selectedId = id ?? null;
  ed.captions?.select?.(selectedId);
}

export default {
  id: 'text',
  label: 'Text',
  viewMode: 'output',

  open(ed, opts = {}) {
    // close() always settles an edit, so one still here outlived its photo (the
    // editor began a new one without closing the tool): drop it, never commit it.
    if (editing) {
      editing = null;
      hideBar();
    }
    edRef = ed;
    drag = null;
    pinch = null;
    guides = [];
    dial = 'size';
    if (opts.select !== undefined) {
      select(ed, findCaption(ed.committed, opts.select) ? opts.select : null);
      return;
    }
    startNew(ed);
  },

  close(ed, { cancel = false } = {}) {
    if (editing) {
      if (cancel) {
        editing = null;
        hideBar();
      } else {
        finishEditing(ed);
      }
    }
    drag = null;
    pinch = null;
    guides = [];
    ed.panel.fade(false);
    select(ed, null);
  },

  // Undo, Redo: whatever was being typed belonged to the state that is gone.
  onHistory(ed) {
    if (editing) {
      editing = null;
      hideBar();
    }
    drag = null;
    pinch = null;
    guides = [];
    if (selectedId && !findCaption(ed.committed, selectedId)) select(ed, null);
  },

  panel(ed) {
    const cap = selected(ed);
    const count = ed.doc.text.length;
    queueThumbs(ed);
    let hint = 'Drag to move. Tap it to edit.';
    if (editing) hint = 'Type your words, then tap Done.';
    else if (!cap) hint = count ? 'Tap a caption to change it.' : 'Tap Add to write on the photo.';
    const off = !cap;
    let slot;
    if (!cap) {
      slot = { kind: 'message', text: 'Add a caption', action: 'add' };
    } else if (dial === 'color') {
      // Swatch hexes are lowercase; a revived '#FFD60A' must still show as picked.
      slot = { kind: 'swatches', colors: SWATCHES, selected: String(cap.color).toLowerCase() };
    } else if (dial === 'angle') {
      slot = { kind: 'ruler', id: 'angle', spec: RULERS.textAngle, value: cap.angle };
    } else {
      slot = { kind: 'ruler', id: 'size', spec: RULERS.textSize, value: cap.size };
    }
    return {
      title: 'Text',
      hint,
      cancel: true,
      done: true,
      quick: STYLES.map((s) => ({ id: `style:${s.id}`, label: s.label, kind: 'thumb', selected: cap?.style === s.id, disabled: off })),
      dials: [
        {
          id: 'size', label: 'Size', kind: 'dial', disabled: off, selected: !off && dial === 'size',
          value: cap ? formatValue(RULERS.textSize, cap.size) : '–',
          changed: !!cap && Math.abs(cap.size - RULERS.textSize.def) > 1e-9,
        },
        {
          id: 'angle', label: 'Angle', kind: 'dial', disabled: off, selected: !off && dial === 'angle',
          value: cap ? formatValue(RULERS.textAngle, cap.angle) : '–',
          changed: !!cap && cap.angle !== 0,
        },
        {
          id: 'color', label: 'Color', kind: 'mode', disabled: off, selected: !off && dial === 'color',
          value: cap ? colorLabel(cap.color) : '–',
          changed: !!cap && String(cap.color).toLowerCase() !== DEFAULT_COLOR,
        },
        { id: 'add', label: 'Add', value: '+', kind: 'action' },
        // `danger` asks the panel for the destructive colour (see the integrator patch).
        { id: 'delete', label: 'Delete', value: '×', kind: 'action', disabled: off, danger: true },
      ],
      slot,
    };
  },

  onQuick(ed, id) {
    if (!id.startsWith('style:')) return;
    if (editing) finishEditing(ed);
    const cap = findCaption(ed.committed, selectedId);
    if (!cap) return;
    const next = updateCaption(ed.committed, cap.id, { style: id.slice(6) });
    if (next !== ed.committed) ed.commit(next);
  },

  onDial(ed, id) {
    if (id === 'add') {
      startNew(ed);
      return;
    }
    if (id === 'delete') {
      deleteSelected(ed);
      return;
    }
    if (id === 'size' || id === 'angle' || id === 'color') {
      if (editing) finishEditing(ed);
      dial = id;
    }
  },

  onSwatch(ed, hex) {
    if (editing) finishEditing(ed);
    const cap = findCaption(ed.committed, selectedId);
    if (!cap || String(cap.color).toLowerCase() === hex) return;
    const next = updateCaption(ed.committed, cap.id, { color: hex });
    if (next !== ed.committed) ed.commit(next);
  },

  onMessage(ed, action) {
    if (action === 'add') startNew(ed);
  },

  onRuler(ed, phase, value) {
    if (editing) finishEditing(ed);
    const cap = findCaption(ed.committed, selectedId);
    if (!cap || phase === 'start') return;
    const field = dial === 'angle' ? 'angle' : 'size';
    const spec = field === 'angle' ? RULERS.textAngle : RULERS.textSize;
    const v = phase === 'reset' ? spec.def : clampValue(spec, value);
    const next = updateCaption(ed.committed, cap.id, { [field]: v });
    if (phase === 'move') ed.live(next);
    else ed.commit(next);
  },

  dragAxis() {
    return 'free';
  },

  // What is under the finger wins: the selected caption's handle, then any caption.
  hitTarget(ed, x, y) {
    const cap = selectedId ? selected(ed) : null;
    const h = cap ? ed.captions?.handleAt?.(cap.id) : null;
    if (h) {
      const { width: W, height: H } = ed.outputSize();
      if (handleWins([x, y], h, ed.docToStage(cap.cx * W, cap.cy * H), HANDLE_HIT)) return `handle:${cap.id}`;
    }
    return ed.hitCaption?.(x, y) ?? null;
  },

  onGesture(ed, g) {
    const target = typeof g.target === 'string' ? g.target : 'photo';
    switch (g.type) {
      case 'tap': return tap(ed, target);
      case 'drag-start': return dragStart(ed, g, target);
      case 'drag': return dragMove(ed, g);
      case 'drag-end':
      case 'drag-cancel': return dragEnd(ed, g.type === 'drag-end');
      case 'pinch-start': return pinchStart(ed, g, target);
      case 'pinch': return pinchMove(ed, g);
      case 'pinch-end': return pinchEnd(ed);
      default: return false;
    }
  },

  // Snapping guides across the photo while a drag sits on the centre or a third.
  drawOverlay(ed, ctx) {
    if (!guides.length || !ed.view) return;
    const { width: W, height: H } = ed.outputSize();
    const [x0, y0] = ed.docToStage(0, 0);
    const [x1, y1] = ed.docToStage(W, H);
    ctx.save();
    ctx.strokeStyle = GUIDE_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const gd of guides) {
      if (gd.axis === 'x') {
        const x = Math.round(x0 + (x1 - x0) * gd.at) + 0.5;
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y1);
      } else {
        const y = Math.round(y0 + (y1 - y0) * gd.at) + 0.5;
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
      }
    }
    ctx.stroke();
    ctx.restore();
  },
};

// ------------------------------------------------------------------ photo gestures

function tap(ed, target) {
  // The handle is part of the selected caption: tapping it edits the words too, so
  // no tap on the selection box is dead.
  if (target.startsWith('handle:')) target = `caption:${target.slice(7)}`;
  if (target.startsWith('caption:')) {
    const id = target.slice(8);
    if (editing?.id === id) return true; // already typing into it
    if (editing) finishEditing(ed, { fromBar: true });
    if (id === selectedId && findCaption(ed.committed, id)) startEditing(ed, id);
    else select(ed, id);
  } else {
    // Empty photo: put the keyboard away (keeping the words) and deselect.
    if (editing) finishEditing(ed, { fromBar: true });
    select(ed, null);
  }
  ed.refresh();
  ed.requestRender();
  return true;
}

function dragStart(ed, g, target) {
  const kind = target.startsWith('handle:') ? 'handle' : target.startsWith('caption:') ? 'move' : null;
  if (!kind) return false;
  if (editing) finishEditing(ed, { fromBar: true });
  const id = target.slice(target.indexOf(':') + 1);
  const base = findCaption(ed.committed, id);
  if (!base) return true; // an empty new caption that Done just dropped
  select(ed, id);
  const out = ed.outputSize();
  const v = ed.view;
  drag = {
    kind,
    id,
    base,
    lay: ed.captions?.layout?.(base, out.width, out.height) ?? null,
    from: ed.stageToDoc(g.x, g.y),
    out,
    threshold: snapThreshold(out.width * v.scale, out.height * v.scale, SNAP_PT),
    cap: base,
  };
  ed.panel.fade(true);
  ed.refresh();
  ed.requestRender();
  return true;
}

function dragMove(ed, g) {
  if (!drag) return false;
  const to = ed.stageToDoc(g.x, g.y);
  const { width: W, height: H } = drag.out;
  if (drag.kind === 'move') {
    const r = moveCaption(drag.base, (to[0] - drag.from[0]) / W, (to[1] - drag.from[1]) / H, drag.threshold);
    drag.cap = r.caption;
    guides = r.guides;
  } else if (drag.lay) {
    drag.cap = applyHandleDrag(drag.base, drag.lay, W, H, drag.from, to);
  }
  ed.live(withCaption(ed.committed, drag.cap));
  return true;
}

function dragEnd(ed, keep) {
  if (!drag) return false;
  const d = drag;
  drag = null;
  guides = [];
  ed.panel.fade(false);
  if (keep && d.cap !== d.base) ed.commit(withCaption(ed.committed, d.cap));
  else ed.live(null);
  ed.refresh();
  ed.requestRender();
  return true;
}

// SPEC §4 rule 1: a two-finger gesture whose first finger landed on the selected
// caption sizes and turns it; any other pinch is left to the view.
function pinchStart(ed, g, target) {
  if (!g.onCaption || target !== `caption:${selectedId}`) return false;
  if (editing) finishEditing(ed, { fromBar: true });
  const base = findCaption(ed.committed, selectedId);
  if (!base) return false;
  pinch = { id: base.id, base, cap: base };
  ed.panel.fade(true);
  return true;
}

function pinchMove(ed, g) {
  if (!pinch) return false;
  pinch.cap = applyPinch(pinch.base, g.scale, g.rotation);
  ed.live(withCaption(ed.committed, pinch.cap));
  return true;
}

function pinchEnd(ed) {
  if (!pinch) return false;
  const p = pinch;
  pinch = null;
  ed.panel.fade(false);
  if (p.cap !== p.base) ed.commit(withCaption(ed.committed, p.cap));
  else ed.live(null);
  ed.refresh();
  return true;
}

// ------------------------------------------------------------------ captions

function startNew(ed) {
  // Settle words still being typed without putting the keyboard away: the new
  // caption takes the same textarea at once.
  if (editing) settle(ed, takeEdit());
  const doc = ed.committed;
  const cap = { ...newCaption(captionId(doc.text)), cy: freeSpot(doc.text) };
  editing = { id: cap.id, isNew: true, draft: cap };
  select(ed, cap.id);
  ed.live(withCaption(doc, cap));
  keepInView(ed, cap);
  showBar(ed, cap.text);
}

// Add while zoomed in can put the new caption off screen, and typing into words
// you cannot see is no use: show the whole photo again.
function keepInView(ed, cap) {
  const v = ed.view;
  if (!v || !(v.scale > v.fit * 1.001)) return;
  const { width: W, height: H } = ed.outputSize();
  const lay = ed.captions?.layout?.(cap, W, H);
  if (!lay) return;
  const b = captionBounds(cap, lay, W, H);
  const [x0, y0] = ed.docToStage(b.x, b.y);
  const [x1, y1] = ed.docToStage(b.x + b.width, b.y + b.height);
  const s = ed.stageSize();
  if (x0 < 0 || y0 < 0 || x1 > s.width || y1 > s.height) ed.resetView();
}

function startEditing(ed, id) {
  const cap = findCaption(ed.committed, id);
  if (!cap) return;
  editing = { id, isNew: false, draft: cap };
  showBar(ed, cap.text);
}

// Done (bar, blur, or leaving the tool): the words become one step. Words cleared
// to nothing mean no caption: a new one is dropped, an existing one deleted.
function finishEditing(ed, { fromBar = false } = {}) {
  if (!editing) return;
  if (dropIfStale(ed)) return;
  const e = takeEdit();
  hideBar();
  settle(ed, e);
  if (fromBar && findCaption(ed.committed, e.id)) ed.hint('caption-done');
  ed.refresh();
  ed.requestRender();
}

function takeEdit() {
  const e = editing;
  editing = null;
  return e;
}

// The bar can outlive the Text tool when the editor starts another photo without
// closing it; its words belong to the old photo and must never reach the new one.
function dropIfStale(ed) {
  if (!editing || ed.toolId === 'text') return false;
  editing = null;
  hideBar();
  return true;
}

function settle(ed, e) {
  const committed = ed.committed;
  let next;
  if (e.draft.text.trim() === '') {
    next = e.isNew ? committed : withoutCaption(committed, e.id);
    if (selectedId === e.id) select(ed, null);
  } else {
    next = withCaption(committed, e.draft);
  }
  if (next === committed) ed.live(null);
  else ed.commit(next);
}

function deleteSelected(ed) {
  if (editing) {
    takeEdit();
    hideBar();
    ed.live(null);
  }
  if (findCaption(ed.committed, selectedId)) ed.commit(withoutCaption(ed.committed, selectedId));
  select(ed, null);
  ed.requestRender();
}

// ------------------------------------------------------------------ edit bar

function wireBar() {
  if (bar) return bar;
  const el = document.getElementById('editbar');
  const input = document.getElementById('caption-input');
  const done = document.getElementById('caption-done');
  if (!el || !input || !done) return null;
  input.maxLength = MAX_CAPTION_CHARS;
  input.addEventListener('input', onInput);
  // The keyboard's own dismiss (or the app going to the background) blurs: treat
  // it as Done. Deferred so a tap that blurs on its way to a button (Done, a dial)
  // lands first and finds the edit already settled.
  input.addEventListener('blur', () => setTimeout(() => {
    if (editing && document.activeElement !== input && edRef) finishEditing(edRef, { fromBar: true });
  }, 0));
  // Keep focus in the textarea until Done acts: no blur race, no keyboard flicker.
  done.addEventListener('pointerdown', (e) => e.preventDefault());
  done.addEventListener('click', () => { if (edRef) finishEditing(edRef, { fromBar: true }); });
  window.visualViewport?.addEventListener('resize', place);
  window.visualViewport?.addEventListener('scroll', place);
  window.addEventListener('resize', place);
  bar = { el, input, done };
  return bar;
}

function showBar(ed, text) {
  const b = wireBar();
  if (!b) return;
  b.el.hidden = false;
  b.input.value = text;
  place();
  b.input.focus({ preventScroll: true });
  const [start, end] = editSelection(text);
  b.input.setSelectionRange(start, end);
  // The view refits on the next frame after a tool opens; centre on that.
  requestAnimationFrame(place);
}

function hideBar() {
  if (!bar) return;
  bar.el.hidden = true;
  if (document.activeElement === bar.input) bar.input.blur();
  setShift(0);
  // iOS may have scrolled the page to reveal the field; the app never scrolls.
  if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
}

function onInput() {
  if (!editing || !edRef || dropIfStale(edRef)) return;
  const raw = bar.input.value;
  const text = clipCaptionText(raw);
  if (text !== raw) bar.input.value = text;
  editing.draft = { ...editing.draft, text };
  edRef.live(withCaption(edRef.committed, editing.draft));
  place();
}

// Pin the bar above the keyboard and slide the stage so the caption stays in view.
function place() {
  if (!editing || !bar || !edRef) return;
  const vv = window.visualViewport;
  const vvTop = vv ? vv.offsetTop : 0;
  const vvH = vv ? vv.height : window.innerHeight;
  const barTop = editBarTop(vvTop, vvH);
  bar.el.style.top = `${barTop}px`;
  const stage = document.getElementById('stage');
  const ed = edRef;
  if (!stage || !ed.view) return;
  const { width: W, height: H } = ed.outputSize();
  const c = editing.draft;
  const [, sy] = ed.docToStage(c.cx * W, c.cy * H);
  // Untransformed stage top: #app is fixed at the top and never moves.
  const appTop = stage.offsetParent ? stage.offsetParent.getBoundingClientRect().top : 0;
  const captionY = appTop + stage.offsetTop + sy;
  // The layout viewport's height is the baseline the keyboard shrinks the visual
  // one from; take the larger reading in case a WebKit reports innerHeight shrunk too.
  const fullH = Math.max(window.innerHeight, document.documentElement.clientHeight);
  setShift(stageShift({ captionY, visibleTop: vvTop, barTop, keyboardUp: isKeyboardUp(fullH, vvH) }));
}

function setShift(px) {
  if (px === shift) return;
  shift = px;
  const stage = document.getElementById('stage');
  if (!stage) return;
  stage.style.transition = 'transform 0.25s cubic-bezier(0.2, 0.7, 0.2, 1)';
  stage.style.transform = px ? `translateY(${px}px)` : '';
}

// ------------------------------------------------------------------ Quick row

// Each style chip shows "Aa" in that style and the selected caption's colour,
// painted by the same routine as the captions themselves.
function queueThumbs(ed) {
  if (thumbsQueued) return;
  thumbsQueued = true;
  requestAnimationFrame(() => {
    thumbsQueued = false;
    if (ed.toolId !== 'text' || !ed.captions?.sample) return;
    const cap = selected(ed);
    const color = cap?.color ?? DEFAULT_COLOR;
    const alpha = cap ? 1 : 0.35; // dimmed with the disabled chip
    const dpr = window.devicePixelRatio || 1;
    for (const s of STYLES) {
      const canvas = ed.panel.thumbCanvas(`style:${s.id}`);
      if (!canvas) continue;
      const r = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
      const key = `${color}|${alpha}|${w}x${h}`;
      if (canvas.dataset.painted === key) continue;
      canvas.width = w;
      canvas.height = h;
      ed.captions.sample(canvas, s.id, color, alpha);
      canvas.dataset.painted = key;
    }
  });
}
