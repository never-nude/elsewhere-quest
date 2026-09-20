# foromaris.gift

A garden arrangement in a stoneware vase, with Omaris's name in gold, that she can set down on her own table in AR.

Built with three.js. The page lives at the site root; `public/omaris.usdz` (iOS Quick Look) and `public/omaris.glb` (Android) are pre-baked from the same procedural model.

```bash
npm install
npm run dev        # local preview
npm run build      # dist/
npm run assets     # re-bake the AR files after changing the model (needs Chromium + the usd-core Python package)
```

URL options: `?to=Name`, `?from=`, `?note=`.

Deploys to GitHub Pages on every push to `main` (see `.github/workflows/deploy.yml`). The custom domain is set by `public/CNAME` plus the Pages settings.

Font on the vase: a subset of Liberation Serif Bold Italic (SIL OFL).
