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

A standalone page at [elsewhere.quest/Omaris/](https://elsewhere.quest/Omaris/): a procedural pink garden arrangement in a fluted stoneware vase with the recipient's name in raised gold. The vase is 25 cm tall and the arrangement about 44 cm. It shares the Vite build through `Omaris/index.html`, `Omaris/ar.html`, and `src/bouquet/`; `/omaris/` redirects to it.

- `?to=Name` changes the vase name and seeds the arrangement; `?from=` and `?note=` change the card. The default recipient is Omaris.
- Tap the flowers on the main page and petals fall. This decoration is never exported.
- “See it in your room” releases the preview's WebGL context and opens `/Omaris/ar.html` with the original query. The default AR document loads no three.js or WebGL.
- iPhone/iPad Safari uses a visible, directly tapped `rel="ar"` image link. The default USDZ is pre-baked; personalized files are prepared before showing the same native link, with a retry if preparation fails.
- The USDZ uses one 1024² color atlas and simpler PBR materials, preserving horizontal anchoring and a fixed real-world scale. Default Android bouquets use Scene Viewer; personalized Android bouquets retain WebXR.
- Stems rise through the opening before spreading, and trailing vines remain outside the vase. The clearance validator tests complete botanical triangles against the ceramic walls and gold rim.

Re-bake after changing the model (requires Chromium and Python `usd-core`), then rebuild to include the new files:

```bash
npm run build
npm run bouquet:assets
npm run build
node tools/bouquet/validate-vase-clearance.mjs public/Omaris/omaris.glb
node tools/bouquet/test-ar-flow.mjs
```

Baking writes `public/Omaris/omaris.{usdz,glb}`, the AR-page poster, and ignored front/side/back previews under `tools/bouquet/`. `compact-usdz.py` repacks the USDZ as a binary crate and checks packaging/anchoring. The browser tests cover routing, native-link markup, query preservation, custom-file retry, and lightweight loading; they do not verify iPhone camera placement. The vase font is a subset of Liberation Serif Bold Italic (SIL OFL), converted by `tools/bouquet/make-font.mjs`.

## Production seams

A real release still needs authenticated accounts, age/identity checks, WebSocket signaling, WebRTC with TURN, a matching service, abuse-rate limits, moderation/report review, and carefully written privacy and retention policies. Video is intentionally out of scope.

## foromaris.gift (`sites/foromaris.gift/`)

A standalone copy of the flowers page, built to live at the root of its own GitHub Pages site on the custom domain `foromaris.gift`. It has its own `package.json`, Vite config, and deploy workflow, and carries `public/CNAME`. To publish it: create an empty public repo, push that folder's contents to its `main`, set the custom domain under Settings → Pages, and point the domain's DNS at GitHub Pages. The model source under `src/bouquet/` is a copy of this repo's; keep the two in sync by hand when the arrangement changes.
