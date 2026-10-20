// Home: no tool open. One big Auto-enhance, then the chips that say exactly what
// it moved — each opens that dial — and one suggestion read from the photo.

import { analyze, autoEnhance, suggestion } from '../../lib/autofix.js';
import { toGray, detectTilt } from '../../lib/level.js';
import { RULERS, formatValue } from '../../lib/ruler.js';

let changes = [];
let changesFor = -1; // history length the chips belong to
let tip = null; // { text, action }
let tipFor = -1;
let tiltCache = null;

export function readAnalysis(ed, maxSide = 512) {
  return ed.readOutput({ maxSide });
}

export function photoTilt(ed) {
  const st = ed.committed;
  const key = `${st.source.w}x${st.source.h}:${st.remove.length}`;
  if (tiltCache && tiltCache.key === key) return tiltCache.tilt;
  const img = ed.renderer.readSource({ maxSide: 512 });
  const t = detectTilt(toGray(img.data, img.width, img.height), img.width, img.height);
  tiltCache = { key, tilt: t };
  return t;
}

// The tilt as seen in the current orientation: quarter turns keep line angles
// (horizontal and vertical fold together), a mirror negates them.
export function orientedTilt(ed) {
  const t = photoTilt(ed);
  return { ...t, angleDeg: ed.committed.crop.flip ? -t.angleDeg : t.angleDeg };
}

function updateSuggestion(ed) {
  if (tipFor === ed.revision) return;
  tipFor = ed.revision;
  try {
    const stats = analyze(readAnalysis(ed, 256));
    const tilt = orientedTilt(ed);
    const st = ed.committed;
    // Already straightened by hand? Don't nag.
    tip = suggestion(stats, st.crop.angle !== 0 ? { ...tilt, confidence: 0 } : tilt, st);
  } catch {
    tip = null;
  }
}

export default {
  id: 'home',
  label: '',
  viewMode: 'output',

  open(ed) {
    if (changesFor !== ed.history?.entries?.length) {
      // chips only describe the most recent Auto-enhance
      if (changesFor >= 0 && ed.history.entries?.length !== changesFor) changes = [];
    }
    updateSuggestion(ed);
  },

  panel(ed) {
    updateSuggestion(ed);
    const dials = changes.map((c) => ({ id: `chip:${c.dial}`, label: RULERS[c.dial]?.label ?? c.dial, value: RULERS[c.dial] ? formatValue(RULERS[c.dial], c.value) : String(c.value), kind: 'action' }));
    return {
      title: '',
      hint: 'Pick a tool below. Hold the photo to compare.',
      cancel: false,
      done: false,
      quick: [{ id: 'auto', label: 'Auto-enhance', kind: 'wide', icon: 'wand', isDefault: true }],
      dials,
      slot: tip ? { kind: 'message', text: tip.text, action: tip.action } : null,
    };
  },

  onQuick(ed, id) {
    if (id !== 'auto') return;
    const stats = analyze(readAnalysis(ed));
    const { next, changes: ch } = autoEnhance(stats, ed.committed);
    if (next === ed.committed || ch.length === 0) {
      ed.toast('Looks good already');
      return;
    }
    ed.commit(next, 'Auto-enhance');
    changes = ch;
    changesFor = ed.history.entries?.length ?? -1;
    ed.hint('auto-enhance');
  },

  onDial(ed, id) {
    const dial = id.replace(/^chip:/, '');
    const tool = ['warmth', 'tint', 'vividness'].includes(dial) ? 'color' : 'light';
    ed.openTool(tool, { dial });
  },

  onMessage(ed, action) {
    if (action === 'straighten') ed.openTool('crop', { auto: true });
    else if (action === 'enhance') this.onQuick(ed, 'auto');
  },

  onHistory() {
    changes = [];
  },

  onGesture(ed, g) {
    if (g.type === 'tap' && typeof g.target === 'string' && g.target.startsWith('caption:')) {
      ed.openTool('text', { select: g.target.slice(8) });
      return true;
    }
    return false;
  },

  hitTarget(ed, x, y) {
    return ed.hitCaption?.(x, y) ?? null;
  },
};
