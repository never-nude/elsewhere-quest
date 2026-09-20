# foromaris.gift

A garden arrangement in a stoneware vase, with Omaris's name in gold, that she can set down on her own table in AR.

Built with three.js. The page lives at the site root; `public/omaris.usdz` (iOS Quick Look) and `public/omaris.glb` (Android) are pre-baked from the same procedural model.

“See it in your room” releases the live WebGL preview and opens `ar.html`. On iPhone/iPad, its visible image link opens Quick Look directly from a tap; the default launch page loads no three.js or WebGL. The USDZ uses one 1024² color atlas and simpler PBR materials to leave more memory available for the camera. It retains horizontal placement and real-world scale (the vase is 25 cm tall; the full arrangement is about 44 cm). Default Android bouquets use Scene Viewer. Personalized iOS bouquets prepare a file first and expose the same directly tapped link; personalized Android bouquets retain WebXR.

```bash
npm install
npm run dev        # local preview
npm run build      # dist/
npm run assets     # re-bake the AR files after changing the model (needs Chromium + the usd-core Python package)
npm run build      # include the newly baked files in dist/
node tools/validate-vase-clearance.mjs public/omaris.glb
node tools/test-ar-flow.mjs
```

The clearance check tests complete botanical triangles against the ceramic walls and gold rim. The launch tests verify browser routing, direct link markup, personalization/retry, and lightweight loading; browser emulation does not verify iPhone camera placement. Asset baking also writes the AR-page poster and ignored front/side/back previews.

URL options: `?to=Name`, `?from=`, `?note=`.

Deploys to GitHub Pages on every push to `main` (see `.github/workflows/deploy.yml`). The custom domain is set by `public/CNAME` plus the Pages settings.

Font on the vase: a subset of Liberation Serif Bold Italic (SIL OFL).
