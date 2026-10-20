// STUB — owned by the text agent. Contract:
// createCaptions(ed) -> {
//   draw(ctx, alpha)              draw every caption of ed.doc on the stage overlay (2D ctx in stage CSS px), at alpha
//   hit(x, y) -> 'caption:<id>' | null   stage CSS px hit test (topmost first)
//   rasterize(doc, outW, outH) -> HTMLCanvasElement|OffscreenCanvas   transparent, output-size, captions drawn (export)
// }
export function createCaptions() {
  return { draw() {}, hit() { return null; }, rasterize() { return null; } };
}
