# Elsewhere

A safety-first, audio-only prototype for having one real conversation with someone elsewhere in the world—and, only when both people choose it, keeping the line open as voice pen pals.

**Home:** [elsewhere.quest](https://elsewhere.quest)  
**Longwave:** the in-product name for Elsewhere’s globe receiver and audio-signal ritual.

The visual direction combines late-1990s/early-2000s internet optimism, shortwave-radio ritual, and an interactive MapLibre globe inspired by the Worldbook globe. The globe is a direction picker, not a catalog of people.

## Run it

```bash
npm install
npm run dev
```

Build verification:

```bash
npm run build
```

## Prototype flow

1. Read the human-conversation promise.
2. Spin the globe and choose a country with an open porch light—or choose “Surprise me.”
3. Transmit a short conversation intention.
4. Mutually accept one language-and-mood-compatible match; the receiver stays quiet rather than substituting an incompatible person.
5. Test the local microphone (never the camera).
6. Enter a timed, audio-only conversation room.
7. Check in privately afterward and optionally request a double-opt-in voice pen pal.

The local microphone meter is real. The remote person and network connection are simulated in this frontend prototype; audio never leaves the device.

Blocking or reporting removes that demo signal from the receiver for the rest of the browser session. Production moderation and cross-session block persistence still require a backend.

## Flowers for Omaris (`/Omaris/`)

A standalone page at [elsewhere.quest/Omaris/](https://elsewhere.quest/Omaris/): a procedurally built garden arrangement (roses in three tones, peonies, ranunculus, lisianthus, hypericum berries, eucalyptus, trailing vines) in a fluted stoneware vase with the recipient's name in raised gold lettering. Real-world scale (about 45 cm tall), placeable on a table or floor in AR. It shares the Vite build (`Omaris/index.html` + `src/bouquet/`) and ships as a second page in `dist/`; `/omaris/` redirects to it.

- Default recipient is Omaris. `?to=Name` changes the name on the vase, `?from=` the sign-off, `?note=` the line under the flowers. The name seeds the arrangement, so each name gets its own.
- Petals, leaves and the glaze use procedural canvas textures plus normal maps (`src/bouquet/textures.ts`), which export into the AR files as PNGs.
- Tap the flowers on the page and a few petals fall. That effect is page-only and never exported.
- iPhone/iPad (Safari): the button opens AR Quick Look anchored to a horizontal surface with pinch-scaling disabled, so it stays true size. The default arrangement uses the pre-baked `public/Omaris/omaris.usdz`; other names generate a USDZ in the browser.
- Android (Chrome): WebXR hit-test placement, with Google Scene Viewer (`omaris.glb`, non-resizable) as the fallback.
- Desktop: orbit the model, no AR button.

Re-bake the static AR files after changing the model (needs the pre-installed Chromium and the `usd-core` Python package):

```bash
npm run build && npm run bouquet:assets
```

The bake renders the page headless, exports GLB and USDZ, then `tools/bouquet/compact-usdz.py` repacks the USDZ as a binary crate (roughly 60% smaller) and checks it. The vase font is a subset of Liberation Serif Bold Italic (SIL OFL), converted with `tools/bouquet/make-font.mjs`.

## Production seams

A real release still needs authenticated accounts, age/identity checks, WebSocket signaling, WebRTC with TURN, a matching service, abuse-rate limits, moderation/report review, and carefully written privacy and retention policies. Video is intentionally out of scope.

## foromaris.gift (`sites/foromaris.gift/`)

A standalone copy of the flowers page, built to live at the root of its own GitHub Pages site on the custom domain `foromaris.gift`. It has its own `package.json`, Vite config, and deploy workflow, and carries `public/CNAME`. To publish it: create an empty public repo, push that folder's contents to its `main`, set the custom domain under Settings → Pages, and point the domain's DNS at GitHub Pages. The model source under `src/bouquet/` is a copy of this repo's; keep the two in sync by hand when the arrangement changes.
