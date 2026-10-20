// STUB — owned by the hints agent. Contract:
// createHints(getEditor) -> { event(name, data) }
// Maps editor/tool events to lib/hints.js triggers, shows each earned hint once ever
// (localStorage 'gesso:hints') via editor.panel.showTip(text), at most one at a time.
// Events emitted today: 'ruler-drag' {tool}, 'first-ruler-drag', 'pinch', 'hold-photo' {tool},
// 'before-tap', 'before-hold', 'undo', 'auto-enhance', 'paint-select', 'ratio-chip',
// 'heal', 'rub-fill', 'try-another', 'caption-done', 'home-with-caption'.
export function createHints() {
  return { event() {} };
}
