// The ruler: the one amount control in every tool. Ticks slide under a fixed
// needle; the drag is relative (touching never makes the value jump), right always
// means more, and it sticks briefly at the default with a needle flash instead of
// a haptic tick. Double-tap or "Reset" returns to the default.

import { stepValue, formatValue, valueText } from '../lib/ruler.js';

const DOUBLE_TAP_MS = 320;
const TAP_SLOP = 6;

export function createRulerView(container, { onStart, onChange, onEnd, onReset, onDoubleTap } = {}) {
  const el = document.createElement('div');
  el.className = 'ruler';
  el.id = 'ruler';
  el.tabIndex = 0;
  el.setAttribute('role', 'slider');
  const canvas = document.createElement('canvas');
  const needle = document.createElement('div');
  needle.className = 'ruler__needle';
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'ruler__reset';
  reset.textContent = 'Reset';
  reset.hidden = true;
  el.append(canvas, needle, reset);
  container.append(el);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.style.position = 'fixed';
  bubble.style.zIndex = '15';
  bubble.hidden = true;
  document.body.append(bubble);

  let spec = null;
  let value = 0;
  let detent = null;
  let drag = null;
  let lastTap = 0;
  let tickTimer = 0;
  let raf = 0;

  reset.addEventListener('pointerdown', (e) => e.stopPropagation());
  reset.addEventListener('click', (e) => {
    e.stopPropagation();
    onReset?.();
  });

  el.addEventListener('pointerdown', (e) => {
    if (!spec || drag) return;
    el.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, x: e.clientX, x0: e.clientX, y: e.clientY, t: e.timeStamp, moved: false, started: false };
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const total = e.clientX - drag.x0;
    if (!drag.moved && Math.abs(total) < TAP_SLOP) return;
    if (!drag.started) {
      drag.started = true;
      drag.moved = true;
      detent = null;
      onStart?.();
    }
    const dx = e.clientX - drag.x;
    const dt = Math.max(1, e.timeStamp - drag.t);
    const r = stepValue(spec, value, dx, Math.abs(dx) / dt, detent);
    drag.x = e.clientX;
    drag.t = e.timeStamp;
    detent = r.detentState;
    if (r.ticked) flash();
    if (r.value !== value) {
      value = r.value;
      draw();
      onChange?.(value);
    }
    showBubble(e.clientX, e.clientY);
  });
  const finish = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    bubble.hidden = true;
    if (d.started) {
      onEnd?.(value);
      return;
    }
    // A tap: two of them quickly is a reset.
    if (e.type === 'pointerup') {
      if (e.timeStamp - lastTap < DOUBLE_TAP_MS) {
        lastTap = 0;
        onDoubleTap?.();
      } else {
        lastTap = e.timeStamp;
      }
    }
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);

  // Keyboard and VoiceOver adjust (swipe up/down maps to arrow keys).
  el.addEventListener('keydown', (e) => {
    if (!spec) return;
    const step = (spec.max - spec.min) / 100;
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = value + step;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = value - step;
    if (next === null) return;
    e.preventDefault();
    onStart?.();
    value = Math.max(spec.min, Math.min(spec.max, Math.round(next * 10) / 10));
    draw();
    onChange?.(value);
    onEnd?.(value);
  });

  const ro = new ResizeObserver(() => draw());
  ro.observe(el);

  function flash() {
    el.classList.add('is-ticked');
    clearTimeout(tickTimer);
    tickTimer = setTimeout(() => el.classList.remove('is-ticked'), 160);
  }

  function showBubble(x, y) {
    bubble.textContent = formatValue(spec, value);
    bubble.style.left = `${x}px`;
    bubble.style.top = `${y - 70}px`;
    bubble.hidden = false;
  }

  function draw() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(paint);
    if (spec) {
      el.setAttribute('aria-label', spec.label ?? spec.id ?? 'Amount');
      el.setAttribute('aria-valuemin', String(spec.min));
      el.setAttribute('aria-valuemax', String(spec.max));
      el.setAttribute('aria-valuenow', String(value));
      el.setAttribute('aria-valuetext', valueText(spec, value));
      reset.hidden = Math.abs(value - spec.def) < 1e-9;
    }
  }

  function paint() {
    if (!spec) return;
    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const ppu = 1 / spec.unitsPerPt; // px per unit
    const tickUnits = niceStep(10 / ppu); // a tick every ~10 px at least
    const majorEvery = 5;
    const cx = w / 2;
    const first = Math.ceil((value - cx / ppu) / tickUnits) * tickUnits;
    const ink = getComputedStyle(document.documentElement);
    const c2 = ink.getPropertyValue('--ink-2').trim() || '#a8a097';
    const c3 = ink.getPropertyValue('--ink-3').trim() || '#6b645d';
    for (let u = first; u <= value + cx / ppu; u += tickUnits) {
      const x = cx + (u - value) * ppu;
      const inRange = u >= spec.min - 1e-9 && u <= spec.max + 1e-9;
      const major = Math.abs(Math.round(u / tickUnits) % majorEvery) === 0;
      ctx.strokeStyle = inRange ? (major ? c2 : c3) : 'rgba(107,100,93,0.25)';
      ctx.lineWidth = major ? 1.5 : 1;
      const len = major ? 14 : 8;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, h / 2 - len / 2);
      ctx.lineTo(Math.round(x) + 0.5, h / 2 + len / 2);
      ctx.stroke();
    }
    // the default, marked with a dot so "back to zero" is visible
    const dx = cx + (spec.def - value) * ppu;
    if (dx > -4 && dx < w + 4) {
      ctx.fillStyle = '#f3eee6';
      ctx.beginPath();
      ctx.arc(dx, h - 7, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return {
    el,
    set(nextSpec, nextValue) {
      const changedSpec = !spec || nextSpec.id !== spec.id;
      spec = nextSpec;
      if (drag && !changedSpec) return; // the finger owns the value mid-drag
      value = nextValue;
      if (changedSpec) detent = null;
      draw();
    },
    // Auto animates the needle to the value it chose.
    animateTo(target, ms = 400) {
      const from = value, t0 = performance.now();
      const step = (now) => {
        const k = Math.min(1, (now - t0) / ms);
        const e = 1 - Math.pow(1 - k, 3);
        value = from + (target - from) * e;
        paint();
        if (k < 1) requestAnimationFrame(step);
        else { value = target; draw(); }
      };
      requestAnimationFrame(step);
    },
    get value() { return value; },
    get dragging() { return !!drag; },
    destroy() {
      ro.disconnect();
      bubble.remove();
      el.remove();
      cancelAnimationFrame(raf);
    },
  };
}

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}
