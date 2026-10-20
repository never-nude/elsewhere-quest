// The zoom navigator (SPEC F14): while zoomed, an 88x66 thumbnail of the whole edit
// sits bottom-right of the stage with a frame around the part on screen (the editor
// places the frame; lib/view.js navigatorFrame). This draws the thumbnail and lets
// one thumb drag the frame: the view pans so the frame follows the finger, and a
// touch outside the frame first centres it there (lib/navpan.js). "Fit" on the pill
// beside it is the editor's.
//
// The thumbnail is redrawn only while the navigator is showing and the history
// state has changed, so a commit costs one 176 px readback and a pinch costs none.
// Nothing runs every frame: the editor rewrites the status word after every step,
// which is the cue to look, with a slow check behind it in case a step ever comes
// without one.

import { navigatorFrame } from '../lib/view.js';
import { insideFrame, centerOn, dragBy } from '../lib/navpan.js';

const THUMB_SIDE = 176; // 2x the navigator's long side: sharp enough at DPR 3, cheap to read back
const SETTLE_MS = 120; // a tape scrub jumps every frame; one readback per this, not per jump
const BACKSTOP_MS = 1000;

export function attachNavigator(ed, root = document) {
  const zoom = root.querySelector('#zoom');
  const nav = root.querySelector('#navigator');
  const canvas = root.querySelector('#navigator-canvas');
  if (!ed || !zoom || !nav || !canvas) return null;
  const win = root.defaultView ?? window;

  // Touches on the zoom controls are theirs, not the photo's: the stage would
  // otherwise start a tool gesture under them (a Remove tap would heal there), and
  // its touchstart preventDefault would swallow the pill's click on iOS.
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'touchstart']) {
    zoom.addEventListener(type, (e) => e.stopPropagation());
  }

  // ------------------------------------------------------------------ thumbnail

  let drawnState = null;
  let drawnRevision = -1;
  let settle = 0;
  let backstop = 0;
  let scratch = null; // one small canvas, reused: iOS counts every live canvas

  function paint() {
    const out = ed.readOutput({ maxSide: THUMB_SIDE, tone: true });
    const w = nav.clientWidth || 88, h = nav.clientHeight || 66;
    const dpr = Math.min(3, win.devicePixelRatio || 1);
    const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    scratch ??= root.createElement('canvas');
    if (scratch.width !== out.width || scratch.height !== out.height) {
      scratch.width = out.width;
      scratch.height = out.height;
    }
    scratch.getContext('2d').putImageData(new ImageData(out.data, out.width, out.height), 0, 0);
    // Fitted and centred exactly as navigatorFrame assumes, so the frame lines up.
    const k = Math.min(w / out.width, h / out.height);
    const dw = out.width * k, dh = out.height * k;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(scratch, ((w - dw) / 2) * dpr, ((h - dh) / 2) * dpr, dw * dpr, dh * dpr);
  }

  function check() {
    win.clearTimeout(settle);
    settle = 0;
    if (zoom.hidden || !ed.committed) return;
    if (ed.committed === drawnState && ed.revision === drawnRevision) return;
    drawnState = ed.committed;
    drawnRevision = ed.revision;
    try {
      paint();
    } catch (err) {
      console.warn('navigator thumbnail', err); // a lost GL context: the frame still works
    }
  }

  function soon() {
    if (!zoom.hidden && !settle) settle = win.setTimeout(check, SETTLE_MS);
  }

  // The editor shows #zoom from inside its draw: paint now, so the thumbnail is
  // never blank for a frame, and keep a slow check going only while it shows.
  function shownChanged() {
    if (zoom.hidden) {
      win.clearInterval(backstop);
      backstop = 0;
      win.clearTimeout(settle);
      settle = 0;
      return;
    }
    check();
    if (!backstop) backstop = win.setInterval(check, BACKSTOP_MS);
  }
  new win.MutationObserver(shownChanged).observe(zoom, { attributes: true, attributeFilter: ['hidden'] });
  const status = root.querySelector('#status');
  if (status) new win.MutationObserver(soon).observe(status, { childList: true, characterData: true, subtree: true });

  // ------------------------------------------------------------------ dragging

  let drag = null;

  function geometry() {
    const v = ed.view;
    if (!v || !ed.committed) return null;
    const s = ed.stageSize();
    const o = ed.outputSize();
    const frame = navigatorFrame(v, s.width, s.height, o.width, o.height, nav.clientWidth || 88, nav.clientHeight || 66);
    return { v, s, frame };
  }

  function local(e) {
    const b = nav.getBoundingClientRect();
    return [e.clientX - b.left, e.clientY - b.top];
  }

  // A new touch always takes the navigator: the last one's lift may never have
  // come (capture lost), and a drag waiting for it would leave the navigator dead.
  nav.addEventListener('pointerdown', (e) => {
    drag = null;
    if (zoom.hidden) return;
    const g = geometry();
    if (!g) return;
    e.preventDefault();
    try { nav.setPointerCapture(e.pointerId); } catch { /* already gone */ }
    const [x, y] = local(e);
    let start = g.v;
    if (!insideFrame(g.frame, x, y)) {
      ed.setView(centerOn(g.v, g.frame, x, y, g.s.width, g.s.height));
      start = ed.view;
    }
    drag = { id: e.pointerId, x, y, start, frame: g.frame };
  });

  nav.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    // The view was refitted under the finger (an Undo changed the crop, Fit was
    // tapped): the drag's starting view belongs to another picture now.
    if (zoom.hidden || ed.view?.fit !== drag.start.fit) {
      drag = null;
      return;
    }
    const [x, y] = local(e);
    ed.setView(dragBy(drag.start, drag.frame, x - drag.x, y - drag.y));
  });

  const end = (e) => {
    if (drag && e.pointerId === drag.id) drag = null;
  };
  nav.addEventListener('pointerup', end);
  nav.addEventListener('pointercancel', end);
  nav.addEventListener('lostpointercapture', end);

  return {
    get dragging() { return !!drag; },
    redraw() { drawnState = null; check(); },
  };
}
