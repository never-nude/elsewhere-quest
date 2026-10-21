# Outline (magnetic lasso): wiring `lib/lasso.js` into Remove and Light

`lib/lasso.js` is pure and synchronous. Nothing below edits it; this is what
`ui/tools/remove.js`, `ui/tools/light.js`, `ui/editor.js` and `ui/renderer.js`
need to do. Exports used: `buildCostMap`, `createLasso`, `transformPolygon`,
`polygonBounds`, `polygonMask`, `polygonArea`, `polygonRecord`, `revivePolygon`.

## 0. First: `sw.js`

Add `'./lib/lasso.js'` to `SHELL` in `sw.js` (alphabetically, after
`'./lib/inpaint.js'`). Until then `test/sw-shell.test.mjs` fails with exactly
that message ("add to SHELL in sw.js: './lib/lasso.js'") and the installed app
would not have the module offline. It is the only failing test in the suite.

## 1. Spaces: which pixels the lasso sees, and where the polygon is stored

The lasso runs on the **cropped output at analysis size**, the polygon is
**stored in source px**.

- Analysis image: `const a = ed.readOutput({ maxSide: 1024, tone: false })` →
  `{ width, height, data }`, the current pixels (fills included, no tone)
  through the crop, long side ≤ 1024. Its scale against output px is
  `kx = a.width / ed.outputSize().width`, `ky = a.height / ed.outputSize().height`
  (`readOutput` rounds each side, so keep both; they differ only in the 4th
  decimal). Build once: `cm = buildCostMap(a)` (40–90 ms at 1024×768 in node;
  see §5 for when).
- Finger → analysis px: `const [ox, oy] = ed.stageToDoc(g.x, g.y)` is output px
  (Remove's `viewMode: 'output'`), so `lasso.move({ x: ox * kx, y: oy * ky })`.
  Off-photo touches are fine: the lasso clamps onto the map.
- `snapRadius` / `anchorSpacing` are analysis px. They should be constant on
  screen, like brush sizes: `R = clamp(18 / ed.view.scale * kx, 6, 40)`,
  `spacing = clamp(24 / ed.view.scale * kx, 8, 48)` (`view.scale` is stage px
  per output px). Make the lasso once per drag-start with the current zoom.
- Polygon → **source px** on lift. A fill tile and a paint mask live in S space
  (SPEC §5.2), so a later crop/rotate/flip must not move the selection. The
  output→source matrix is the shader's own:

  ```js
  import { outputToSource, multiply } from '../../lib/geometry.js';
  const st = ed.doc;
  const toSource = multiply(outputToSource(st.crop, st.source.w, st.source.h), [1 / kx, 0, 0, 1 / ky, 0, 0]);
  const polyS = transformPolygon(lasso.end(), toSource);   // Float32Array, source px
  ```

  Store `polygonRecord(polyS)` (plain numbers, 0.1 px) in the pool entry; bring
  it back with `revivePolygon()`. `polygonArea(polyS)` of 0 (a tap, or a loop
  that never left a pixel) means "do nothing".
- Source → stage for drawing anything stored: `remove.js` already has
  `toStage(ed)` (`sourceToOutput` then `ed.docToStage`).

## 2. Drawing the live snapped path on the overlay

`lasso.path()` is the committed path plus the live tail, in analysis px (a few
hundred to a few thousand points). In `drawOverlay(ed, ctx)`:

```js
const p = lasso.path();
if (p.length >= 4) {
  ctx.beginPath();
  for (let i = 0; i < p.length; i += 2) {
    const [sx, sy] = ed.docToStage(p[i] / kx, p[i + 1] / ky);
    i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
  }
  ctx.lineJoin = ctx.lineCap = 'round';
  ctx.lineWidth = 3; ctx.strokeStyle = SHADOW; ctx.stroke();   // same pair as ring()
  ctx.lineWidth = 1.5; ctx.strokeStyle = INK; ctx.stroke();
  // Optional: the closing chord as a dashed line from the live end back to p[0..1].
}
```

Call `lasso.move()` at most once per frame: the editor feeds every coalesced
pointer event (`getCoalescedEvents`) through `onGesture`, and a move costs
0.5–3 ms depending on `snapRadius`. Keep `finger = { x, y }` in the drag
handler, set a flag, and move+`requestRender()` from a `requestAnimationFrame`
callback (or at the top of `drawOverlay`). `drag-cancel` → `lasso.cancel()`.

## 3. Remove: a polygon fill through the existing rub pipeline

Add a job/recipe kind `'outline'`: `{ kind: 'outline', poly: polygonRecord(polyS), seed, attempt }`.
`rubTile(ed, rec)` already does everything a polygon needs if its three
`strokeMaskFast(...)` calls and its box become polygon ones:

```js
import { polygonBounds, polygonMask, transformPolygon, revivePolygon } from '../../lib/lasso.js';

const poly = revivePolygon(rec.poly);                       // Float32Array source px
const b = polygonBounds(poly, 1, { width: W, height: H, pad: DILATE_PX });   // planRemoval's shape
if (!b) return null;
const box = { x: b.x, y: b.y, w: b.width, h: b.height };   // remove-plan's rect shape
const boxMask = polygonMask(poly, { width: box.w, height: box.h, x: box.x, y: box.y, feather: 0, grow: DILATE_PX });
if (!maskBounds(boxMask, box.w, box.h)) return null;
const { rect: win, scale } = rubWindow(box, W, H, rec.attempt);
if (scale >= 1) {
  const img = { width: win.w, height: win.h, data: ed.renderer.readRect(win) };
  const mask = polygonMask(poly, { width: win.w, height: win.h, x: win.x, y: win.y, feather: 0, grow: DILATE_PX });
  const filled = await client().inpaint(img, mask, { seed: rec.seed });
  rgba = cutTile(filled.data, win.w, { x: 0, y: 0, w: box.w, h: box.h }, box.x - win.x, box.y - win.y, boxMask, box.w);
} else {
  const small = pick(ed.renderer.readSource({ rect: win, scale }));
  const kx = small.width / win.w, ky = small.height / win.h;
  const polyW = transformPolygon(poly, [kx, 0, 0, ky, -win.x * kx, -win.y * ky]);   // window px, shrunk
  const mask = polygonMask(polyW, { width: small.width, height: small.height, feather: 0, grow: DILATE_PX * kx + FILTER_BLEED });
  const filled = await client().inpaint(small, mask, { seed: rec.seed });
  rgba = upsampleFill(filled, win, box, boxMask);
  await matchSeam(...)   // with holeMask = polygonMask(poly, { width: T.w, height: T.h, x: T.x, y: T.y, feather: 0, grow: DILATE_PX })
}
return { rect: box, rgba };
```

Notes:
- `polygonMask` at `feather: 0` is 0/255, which is what `inpaint` (non-zero =
  hole), `cutTile` and `maskBounds` key on. `grow: DILATE_PX` plays the part of
  `rr = r + DILATE_PX`, so the object's soft fringe goes too.
- The size cap: `exceedsAreaCap(box, W, H)` on the polygon's box, checked on
  lift (the finger can't be stopped mid-loop like a rub). Show `CAP_TIP` and
  drop the loop if it fails.
- `lib/remove-plan.js` `recipeRecord`/`reviveRecipe` return null for an unknown
  kind, so Try another after a relaunch needs a 4-line `'outline'` case there
  (`poly` via `revivePolygon`, `seed`, `attempt`), mirroring `'rub'`. Until
  then `fills` (the in-session map) still makes Try another work.
- Shimmer: `silhouetteSvg` draws a stroke; for a polygon give `#shimmer` a
  `<path d="M…Z" fill="#fff"/>` of the polygon in stage px instead (same data
  URL trick), and `placeShimmer`'s box from `polygonBounds(poly, 1)` mapped
  through `toStage`.

## 4. Light: brighten/darken inside the outline

The paint mask is an RG8 texture at S/4 (`renderer.clearPaint()`:
`s = min(0.25, 2048 / max(W, H))`), and `paintDabs(mode, centres, r)` splats
Gaussian dabs into it. A polygon is not a stroke, and dab-approximating it
(a dab at every mask pixel) gives lumpy coverage at the edge and ten thousand
quads, so **yes, one new renderer entry point** that splats a mask texture:

```js
// renderer.js, next to paintDabs: add `mask` (Uint8Array, w x h over `rect` in
// source px, 0..255) × amount into the paint mask. mode as paintDabs.
paintMask(mode, mask, rect, amount) {
  if (!paintTex) api.clearPaint();
  const s = paintSize.scale, W = paintSize.width, H = paintSize.height;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, rect.w, rect.h, 0, gl.RED, gl.UNSIGNED_BYTE, mask);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  setSampling(gl, false);
  gl.bindFramebuffer(gl.FRAMEBUFFER, paintFbo);
  gl.viewport(0, 0, W, H);
  gl.useProgram(maskProgram);                       // VERTEX + MASK_FRAGMENT below
  gl.uniform1i(maskLoc.uMask, 0);
  gl.uniform3fv(maskLoc.uChannel, mode === 'brighten' ? [1, 0, 0] : mode === 'darken' ? [0, 1, 0] : [0, 0, 1]);
  gl.uniform1f(maskLoc.uAmount, amount);
  gl.enable(gl.BLEND);
  if (mode === 'erase') gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA); else gl.blendFunc(gl.ONE, gl.ONE);
  gl.bindVertexArray(vao);
  // the develop quad layout (aPos, aUv, aOut): rect in paint-mask px → clip space, uv 0..1
  writeQuad([[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => ({ x: (rect.x + u * rect.w) * s, y: (rect.y + v * rect.h) * s, u, v, ox: u, oy: v })), W, H, false);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
  gl.disable(gl.BLEND);
  gl.deleteTexture(tex);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
},
```

```glsl
// MASK_FRAGMENT: the dab shader with the Gaussian replaced by the mask sample
#version 300 es
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform sampler2D uMask; uniform vec3 uChannel; uniform float uAmount;
void main() {
  float w = texture(uMask, vUv).r * uAmount;
  if (uChannel.b > 0.5) outColor = vec4(0.0, 0.0, 0.0, w);
  else outColor = vec4(uChannel.rg * w, 0.0, 0.0);
}
```

Linked in `init()` like `dabProgram` (`maskProgram = link(gl, VERTEX, MASK_FRAGMENT)`;
`maskLoc = { uMask, uChannel, uAmount }`). The paint-mask texture is `1.0 = 1.5 EV`,
so `amount` is EV / 1.5, from the ruler (e.g. ±100 → ±1 EV → 0.67).

The mask to hand it is the polygon rasterised **at the paint texture's
resolution** with a soft edge, so the light doesn't have a hard rim:

```js
const s = Math.min(0.25, 2048 / Math.max(W, H));          // paintSize.scale; expose renderer.paintScale() rather than repeat it
const b = polygonBounds(poly, s, { width: Math.round(W * s), height: Math.round(H * s), pad: 4 });
const mask = polygonMask(poly, { ...b, scale: s, x: b.x, y: b.y, feather: 6 });   // 6 mask px ≈ 24 source px of fall-off
renderer.paintMask(mode, mask, { x: b.x / s, y: b.y / s, w: b.width / s, h: b.height / s }, amount);
```

Light stores it as a stroke entry: `pools.strokes[id] = { kind: 'outline', mode,
poly: polygonRecord(polyS), amount }` and `doc.paint` gets the id, so undo,
autosave and `editor.js replayPaint` work unchanged except that `replayPaint`
dispatches on `s.kind === 'outline'` → the three lines above instead of
`paintDabs`. The amount ruler re-commits the entry; `replayPaint` runs on every
`paint` change, so dragging the ruler is `ed.live(next)` with the whole paint
mask replayed (a few ms) — same as today's Undo.

## 5. When to build the cost map

`buildCostMap` on a 1024-px analysis image is ~40 ms warm in node here, more on
a phone; don't do it under the finger. Build it when Outline is selected
(`onDial`/`onQuick`) in a `setTimeout(0)`, keyed on what it was built from
(`ed.committed.crop`, `ed.committed.remove`): rebuild when either changes (a fill
landed, a crop moved). If a drag starts before it is ready, build synchronously
then. It is pure and all typed arrays, so it can also go through a module
worker (`workers/lasso-worker.js`, same shape as `heal-worker.js`) and transfer
back; the live wire itself must stay on the main thread, where moves are
synchronous.

Memory: ~13 bytes/px (cost Float32 + two Int8 tangents, plus luma/magnitude
transients during the build), so 10 MB at 1024×768. Drop it on `close()`.

## 6. Determinism and history

Same analysis pixels + same finger points → bit-identical polygon (tested). The
polygon in the pool is the whole recipe; a replay rasterises it again with
`polygonMask`, which is exact (even-odd at pixel centres, distance-based
feather), so tiles and paint come back the same after a relaunch.
