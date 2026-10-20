// Dragging the zoom navigator (SPEC F14), pure. The navigator shows the whole output
// fitted inside it, with a frame around the part on screen (view.js navigatorFrame).
// The frame follows the finger, so the photo pans the other way by the finger's
// travel scaled up from thumbnail to stage. A touch outside the frame first centres
// the frame there. The caller keeps the result inside the content (clampView).
//
// `frame` is a navigatorFrame() result: { x, y, width, height, scale, offsetX, offsetY }
// in navigator px, where scale is navigator px per content px.

export const FRAME_SLOP = 8; // px around the frame that still grabs it (it can be tiny)

export function insideFrame(frame, x, y, slop = FRAME_SLOP) {
  return x >= frame.x - slop && x <= frame.x + frame.width + slop
    && y >= frame.y - slop && y <= frame.y + frame.height + slop;
}

// The view with the content point under navigator (x, y) in the middle of the stage.
export function centerOn(view, frame, x, y, stageW, stageH) {
  const cx = (x - frame.offsetX) / frame.scale;
  const cy = (y - frame.offsetY) / frame.scale;
  return { ...view, x: stageW / 2 - cx * view.scale, y: stageH / 2 - cy * view.scale };
}

// The view after the finger has moved (dx, dy) navigator px since the drag began on
// `start` (always measured from the start, so the frame never drifts from the finger).
export function dragBy(start, frame, dx, dy) {
  const k = start.scale / frame.scale; // stage px per navigator px
  return { ...start, x: start.x - dx * k, y: start.y - dy * k };
}
