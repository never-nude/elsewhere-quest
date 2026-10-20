// Renders a tool's PanelSpec into the fixed 204pt panel. Every tool has the same
// anatomy — header (Cancel · name over hint · Done), Quick row, Dial row, one
// slot — so learning one tool teaches all of them.
//
// PanelSpec = {
//   title, hint, cancel: bool, done: bool,
//   quick: [{ id, label, kind: 'action'|'state'|'thumb'|'wide'|'note', selected, disabled, isDefault, icon, thumb }],
//   dials: [{ id, label, value, changed, selected, disabled, danger, kind: 'dial'|'action'|'mode' }],
//   slot:  { kind: 'ruler', id, spec, value } | { kind: 'segment', id, options: [{ id, label }], selected }
//        | { kind: 'swatches', colors, selected } | { kind: 'message', text, action } | null,
// }

import { createRulerView } from './ruler-view.js';

export function createPanel(root, handlers) {
  const els = {
    panel: root.querySelector('#panel'),
    name: root.querySelector('#tool-name'),
    hint: root.querySelector('#hint'),
    cancel: root.querySelector('#cancel'),
    done: root.querySelector('#done'),
    quick: root.querySelector('#quick'),
    dials: root.querySelector('#dials'),
    slot: root.querySelector('#slot'),
  };
  let hintTimer = 0;
  let baseHint = '';
  let tipShowing = false;
  let lastQuick = '';
  let lastDials = '';
  let lastSlotKey = '';
  let ruler = null;

  els.cancel.addEventListener('click', () => handlers.onCancel?.());
  els.done.addEventListener('click', () => handlers.onDone?.());
  els.quick.addEventListener('click', (e) => {
    const b = e.target.closest('[data-quick]');
    if (b && !b.disabled) handlers.onQuick?.(b.dataset.quick);
  });
  els.dials.addEventListener('click', (e) => {
    const b = e.target.closest('[data-dial]');
    if (b && !b.disabled) handlers.onDial?.(b.dataset.dial);
  });
  els.slot.addEventListener('click', (e) => {
    const seg = e.target.closest('[data-segment]');
    if (seg) return handlers.onSegment?.(seg.dataset.segment);
    const sw = e.target.closest('[data-swatch]');
    if (sw) return handlers.onSwatch?.(sw.dataset.swatch);
    const msg = e.target.closest('[data-message-action]');
    if (msg) return handlers.onMessage?.(msg.dataset.messageAction);
    return undefined;
  });

  function icon(id) {
    return id ? `<svg class="icon" aria-hidden="true"><use href="#i-${id}"/></svg>` : '';
  }

  function renderQuick(items) {
    const key = JSON.stringify(items.map(({ thumb, ...rest }) => rest));
    if (key === lastQuick) return;
    lastQuick = key;
    els.quick.textContent = '';
    for (const q of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (q.kind === 'wide' ? ' chip--wide' : '') + (q.kind === 'thumb' ? ' chip--thumb' : '') + (q.kind === 'note' ? ' chip--note' : '');
      b.dataset.quick = q.id;
      if (q.isDefault) b.dataset.default = '';
      if (q.kind === 'state' || q.kind === 'thumb') b.setAttribute('aria-pressed', q.selected ? 'true' : 'false');
      b.disabled = !!q.disabled;
      if (q.kind === 'thumb') {
        const c = document.createElement('canvas');
        c.dataset.thumb = q.id;
        b.append(c);
        const s = document.createElement('span');
        s.textContent = q.label;
        b.append(s);
      } else {
        b.innerHTML = `${icon(q.icon ?? (q.isDefault ? 'wand' : null))}<span></span>`;
        b.querySelector('span').textContent = q.label;
      }
      els.quick.append(b);
    }
  }

  function renderDials(items) {
    const key = JSON.stringify(items);
    if (key === lastDials) return;
    lastDials = key;
    els.dials.textContent = '';
    for (const d of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `dial dial--${d.kind ?? 'dial'}` + (d.selected ? ' is-selected' : '') + (d.changed ? ' is-changed' : '') + (d.danger ? ' dial--danger' : '');
      b.dataset.dial = d.id;
      b.disabled = !!d.disabled;
      if (d.kind !== 'action') b.setAttribute('aria-pressed', d.selected ? 'true' : 'false');
      const n = document.createElement('span');
      n.className = 'dial__name';
      n.textContent = d.label;
      const v = document.createElement('span');
      v.className = 'dial__value';
      v.textContent = d.value ?? '';
      b.append(n, v);
      els.dials.append(b);
    }
  }

  function renderSlot(slot) {
    const key = slot ? `${slot.kind}:${slot.id ?? ''}:${slot.kind === 'ruler' ? slot.spec?.id ?? '' : JSON.stringify(slot)}` : 'none';
    if (slot?.kind === 'ruler' && key === lastSlotKey && ruler) {
      ruler.set(slot.spec, slot.value);
      return;
    }
    if (key === lastSlotKey) return;
    lastSlotKey = key;
    ruler?.destroy();
    ruler = null;
    els.slot.textContent = '';
    if (!slot) return;
    if (slot.kind === 'ruler') {
      ruler = createRulerView(els.slot, {
        onStart: () => { els.panel.classList.add('is-faded'); handlers.onRuler?.('start'); },
        onChange: (v) => handlers.onRuler?.('move', v),
        onEnd: (v) => { els.panel.classList.remove('is-faded'); handlers.onRuler?.('end', v); },
        onReset: () => handlers.onRuler?.('reset'),
        onDoubleTap: () => handlers.onRuler?.('reset'),
      });
      ruler.set(slot.spec, slot.value);
    } else if (slot.kind === 'segment') {
      const wrap = document.createElement('div');
      wrap.className = 'segment';
      wrap.setAttribute('role', 'radiogroup');
      for (const o of slot.options) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.segment = o.id;
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-pressed', o.id === slot.selected ? 'true' : 'false');
        b.setAttribute('aria-checked', o.id === slot.selected ? 'true' : 'false');
        b.textContent = o.label;
        wrap.append(b);
      }
      els.slot.append(wrap);
    } else if (slot.kind === 'swatches') {
      const wrap = document.createElement('div');
      wrap.className = 'swatches';
      for (const c of slot.colors) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'swatch';
        b.dataset.swatch = c.hex ?? c;
        b.style.background = c.hex ?? c;
        b.setAttribute('aria-label', c.label ?? c);
        b.setAttribute('aria-pressed', (c.hex ?? c) === slot.selected ? 'true' : 'false');
        wrap.append(b);
      }
      els.slot.append(wrap);
    } else if (slot.kind === 'message') {
      if (slot.action) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'message message--action';
        b.dataset.messageAction = slot.action;
        b.style.width = '100%';
        b.textContent = slot.text;
        els.slot.append(b);
      } else {
        const p = document.createElement('p');
        p.className = 'message';
        p.textContent = slot.text;
        els.slot.append(p);
      }
    }
  }

  return {
    render(spec) {
      els.name.textContent = spec.title ?? '';
      baseHint = spec.hint ?? '';
      if (!tipShowing) els.hint.textContent = baseHint;
      els.cancel.hidden = !spec.cancel;
      els.done.hidden = !spec.done;
      renderQuick(spec.quick ?? []);
      renderDials(spec.dials ?? []);
      renderSlot(spec.slot ?? null);
    },
    // A one-time tip takes the hint line for a few seconds, then hands it back.
    showTip(text, ms = 4000) {
      clearTimeout(hintTimer);
      tipShowing = true;
      els.hint.textContent = text;
      els.hint.classList.add('is-tip');
      hintTimer = setTimeout(() => {
        tipShowing = false;
        els.hint.classList.remove('is-tip');
        els.hint.textContent = baseHint;
      }, ms);
    },
    get tipShowing() { return tipShowing; },
    fade(on) { els.panel.classList.toggle('is-faded', !!on); },
    ruler: () => ruler,
    thumbCanvas(id) { return els.quick.querySelector(`canvas[data-thumb="${CSS.escape(id)}"]`); },
    forceRedraw() { lastQuick = lastDials = lastSlotKey = ''; },
  };
}
