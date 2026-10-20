// The rewind tape (SPEC F13). Hold Undo for HOLD_MS and a tape of every named step,
// Original first, rises over the panel. Sliding the finger, still on Undo, scrubs
// the photo through history live (one ed.jumpTo per frame at most); lifting lands
// there. lib/tape.js has the scrub maths.
//
// A plain tap still undoes exactly once: the editor's click handler does that. A
// press that raised the tape has its click stopped here, in the capture phase on
// the window, before the editor's listener on the button can see it.
//
// The tape covers the fixed-height panel (absolute, inset 0) and never resizes
// anything. While it is up #panel carries TAPED, so ui/hints-ui.js holds an earned
// hint back until it can be read. Styles: ui/tape.css, linked here if index.html
// does not link it.

import { labels } from '../lib/history.js';
import { HOLD_MS, startScrub, moveScrub, scrubStatus, landingText } from '../lib/tape.js';

const ICONS = { crop: 'crop', light: 'light', color: 'color', remove: 'remove', text: 'text', home: 'wand' };
const CLICK_GRACE_MS = 400; // a click this long after the lift still belongs to the press
export const TAPED = 'has-tape';

export function attachTape(ed, undoButton) {
  if (!ed || !undoButton) return null;
  const doc = undoButton.ownerDocument;
  const win = doc.defaultView;
  const panel = doc.getElementById('panel');
  if (!panel) return null;
  linkStyles(doc);

  // A slide must stay ours: if the browser took it as a pan it would cancel the
  // pointer halfway through a scrub.
  undoButton.style.touchAction = 'none';

  let press = null; // { id, x, timer }
  let scrub = null;
  let rows = [];
  let seen = null; // the history the tape was built from, its own jumps included
  let tape = null;
  let swallow = false;
  let swallowTimer = 0;
  let raf = 0;

  undoButton.addEventListener('pointerdown', (e) => {
    swallow = false;
    if (e.button > 0) return;
    if (press) end(); // its lift went missing; never leave a tape up without a finger
    const h = ed.history;
    if (!h || h.entries.length < 2) return;
    try { undoButton.setPointerCapture(e.pointerId); } catch { /* already gone */ }
    press = { id: e.pointerId, x: e.clientX, timer: win.setTimeout(open, HOLD_MS) };
  });

  // The press is followed on the window, in the capture phase, so its moves and its
  // lift arrive wherever the finger goes and whoever holds the capture: a lift on
  // another element (capture lost, a disabled Undo) would otherwise leave the
  // tape up over the panel for good.
  win.addEventListener('pointermove', (e) => {
    if (!press || e.pointerId !== press.id) return;
    press.x = e.clientX;
    if (!scrub || !current()) return;
    const next = moveScrub(scrub, e.clientX, e.timeStamp);
    const changed = next.index !== scrub.index;
    scrub = next;
    if (!changed) return;
    render(true);
    if (!raf) raf = win.requestAnimationFrame(applyJump);
  }, true);
  const lift = (e) => {
    if (press && e.pointerId === press.id) end();
  };
  win.addEventListener('pointerup', lift, true);
  win.addEventListener('pointercancel', lift, true);
  doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden' && press) end(); });
  // A long press must not open a context menu over the tape.
  undoButton.addEventListener('contextmenu', (e) => { if (press || scrub) e.preventDefault(); });

  win.addEventListener('click', (e) => {
    if (!swallow || !(e.target instanceof win.Node) || !undoButton.contains(e.target)) return;
    swallow = false;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);

  function open() {
    const h = ed.history;
    if (!press || !h || h.entries.length < 2) return;
    swallow = true;
    load(h);
    tape.hidden = false;
    panel.classList.add(TAPED);
    render(false);
    // Scrubbing to the Original disables Undo, and a disabled button may stop
    // getting pointer events (WebKit); the tape never is disabled, so it takes the
    // pointer for the rest of the press.
    try {
      tape.setPointerCapture(press.id);
    } catch {
      /* the pointer already went away: its lift lands the tape */
    }
  }

  // The press ended (lifted, cancelled, or lost): land if the tape is up. A plain
  // tap has no tape, and the click that follows it undoes once.
  function end() {
    win.clearTimeout(press.timer);
    press = null;
    if (scrub) land();
  }

  function load(h) {
    seen = h;
    rows = labels(h);
    scrub = startScrub(h.index, rows.length, press.x, performance.now());
    build();
  }

  // Is the tape still in step with the history? Something else may have changed it
  // while the tape is up (a Remove fill landing, a keyboard Undo); jumping by a row
  // of the old list would then land on the wrong step, so the tape starts again
  // from where the history is now.
  function current() {
    const h = ed.history;
    if (h === seen) return true;
    if (h && h.entries === seen.entries && h.index === seen.index) {
      seen = h; // only the open tool's mark moved
      return true;
    }
    win.cancelAnimationFrame(raf);
    raf = 0;
    if (!h || h.entries.length < 2 || !press) {
      close();
      return false;
    }
    load(h);
    render(false);
    return false;
  }

  function applyJump() {
    raf = 0;
    if (!scrub || !current()) return;
    if (ed.history.index !== scrub.index) {
      ed.jumpTo(scrub.index);
      seen = ed.history;
    }
  }

  function land() {
    win.cancelAnimationFrame(raf);
    raf = 0;
    applyJump();
    const text = scrub ? landingText(rows, scrub.start, scrub.index) : null;
    close();
    if (text) ed.toast(text, 1600);
    // The click for this press may never come (the finger moved off); don't let a
    // later keyboard Undo be eaten in its place.
    win.clearTimeout(swallowTimer);
    swallowTimer = win.setTimeout(() => { swallow = false; }, CLICK_GRACE_MS);
  }

  function close() {
    scrub = null;
    if (tape) tape.hidden = true;
    if (!panel.classList.contains(TAPED)) return;
    panel.classList.remove(TAPED);
    ed.refresh?.(); // the editor left the panel alone while the tape covered it
  }

  function build() {
    if (!tape) {
      tape = doc.createElement('div');
      tape.id = 'tape';
      tape.className = 'tape';
      tape.hidden = true;
      tape.setAttribute('role', 'slider');
      tape.setAttribute('aria-label', 'Rewind');
      tape.innerHTML = '<div class="tape__head"><p class="tape__title">Rewind</p><p class="tape__hint"></p></div>'
        + '<div class="tape__window"><div class="tape__strip"></div></div>';
      panel.append(tape);
      // Capture can be taken away (the system, a hidden element) and the lift then
      // may never be seen; never leave the tape up without a finger on it.
      tape.addEventListener('lostpointercapture', (e) => { if (scrub && press && e.pointerId === press.id) end(); });
      // A touch on a tape that has no finger of its own puts it away.
      tape.addEventListener('pointerdown', (e) => { if (press && e.pointerId !== press.id) end(); });
    }
    const strip = tape.querySelector('.tape__strip');
    strip.textContent = '';
    rows.forEach((r, i) => {
      const step = doc.createElement('div');
      step.className = 'tape__step';
      const icon = i === 0 ? 'photo' : ICONS[r.tool];
      if (icon) step.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#i-${icon}"/></svg>`;
      const label = doc.createElement('span');
      label.textContent = r.label;
      step.append(label);
      strip.append(step);
    });
    tape.setAttribute('aria-valuemin', '0');
    tape.setAttribute('aria-valuemax', String(rows.length - 1));
  }

  function render(animate) {
    const strip = tape.querySelector('.tape__strip');
    const steps = strip.children;
    for (let i = 0; i < steps.length; i++) {
      steps[i].classList.toggle('is-on', i === scrub.index);
      steps[i].classList.toggle('is-ahead', i > scrub.index);
    }
    const on = steps[scrub.index];
    const view = tape.querySelector('.tape__window');
    const tx = view.clientWidth / 2 - (on.offsetLeft + on.offsetWidth / 2);
    strip.style.transition = animate ? '' : 'none';
    strip.style.transform = `translateX(${tx}px)`;
    tape.querySelector('.tape__hint').textContent = scrubStatus(scrub);
    tape.setAttribute('aria-valuenow', String(scrub.index));
    tape.setAttribute('aria-valuetext', rows[scrub.index].label);
  }

  return {
    get open() { return !!scrub; },
  };
}

function linkStyles(doc) {
  if (!doc.head || doc.querySelector('link[href$="tape.css"]')) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./tape.css', import.meta.url).href;
  doc.head.append(link);
}
