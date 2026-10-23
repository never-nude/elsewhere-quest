# Gesso — laptop continuation

Prepared 2026-10-23 for the owner to move this workflow from the current Mac to
the laptop after this step. Read the latest `STATUS.md` entry for the final commit,
PR, validation and installation state; this document is the enduring context.

## Start here

Repository: `never-nude/elsewhere-quest`. This Mac's actual checkout is
`/Users/michael/elsewhere-quest`. Continue branch **`codex/gesso-creative-studio`**,
which builds on `claude/gesso-ios` (native app draft PR8). Do not work on, merge
or push `main` without the owner's authorization. Preserve laptop changes before
fetching/switching. A fetch cannot recover another computer's uncommitted files.

Read, in order:

1. Repository `AGENTS.md`, latest entries of `STATUS.md`, and existing laptop
   instructions/uncommitted work.
2. `apps/gesso/design/creative-studio.md`: current owner direction, Reddit/forum
   evidence, seven PsBattles examples, nine capability priorities and first gate.
3. `apps/gesso/README.md`, `apps/gesso-ios/README.md`, `apps/gesso/ios/DESIGN.md`
   and `BRIDGE.md`.
4. `apps/gesso/studio/model.js`, `engine.js`, `app.js`, `index.html`, `studio.css`.
   The older `SPEC.md` describes the correction editor; its restrictions on
   layers, masks and dock layout have been superseded by the owner.

The owner granted independent work through device installation and branch
commit/push in this conversation. Do not infer App Store release or a main merge.
**Do not modify `apps/gesso/lib/lasso.js`.** All new tracing behavior wraps it.

## What the owner actually wants

The first app felt weaker than Photos. The desired product is an immersive,
precise photo-art studio: classic Photoshop's layers, selections, masks and
painting with useful modern assistance. Example: extract Ricky, place him in a
dinosaur environment, arrange foreground scenery, match light and add shadows,
then reopen everything independently editable.

Latest refinements:

- Trace an edge, lift the thumb to reposition, put it down and **continue the
  same outline**. Two fingers can pan/zoom between segments. Only explicit
  **Close outline** finishes the selection; then Keep/Hide applies the mask.
- Concentrate on 5–10 crucial capabilities, researched through Reddit and other
  forums. Do not invent a tool-frequency ranking or recite lack of telemetry
  instead of researching actual user accounts.
- Study what people make on PsBattles: recontextualization, scale jokes, borrowed
  parts, precise occlusion, shadows, material/color matching and painted light.
  Documented phone workflows support Curves, masks, blending and painting.
- Nine capability priorities: Select; Mask/Refine; Layers/Transform; Light/Color
  including Curves/HSL; Brush/paint/dodge-burn; Heal/Clone/Remove; Crop/Canvas;
  Text; optional Generate/Expand/Integrate. These are a product synthesis, not
  nine already implemented tools or a measured popularity league table.

## First Studio foundation

Studio lives alongside the existing correction editor at `/gesso/studio/`.
The native app normally opens bundled `/gesso/studio/index.html`. Projects links
to the old correction editor. Its old drafts remain untouched in the old database.
Native probe/smoke launch arguments retain their documented diagnostic routes.

Studio stores a version1 project and immutable asset/mask references in separate
`gesso-studio` IndexedDB tables. Files handed to Studio are retained; native RAW
imports are already developed working PNGs, not original camera RAW files.
Proxies and export use a
**2048px maximum long edge** and **eight image layers**. This is deliberate and
disclosed. Full-resolution tiled multi-layer rendering/export remains future
work. Do not describe 2048px proxy export as original resolution.

First slice: actual image layers, order/visibility/duplicate/opacity/blends;
move/scale/rotate; magnetic outline with pause/resume; alpha mask, Reveal/Hide
brush and feather; basic per-layer brightness/contrast/saturation and shadow;
Undo/Redo; multiple persisted projects; PNG/JPEG export and native Photos/share.
Curves/HSL, paint/text layers, advanced matting, contact-shadow painting,
perspective/warp, selection-to-new-layer and generation are follow-ups.

Native `subject.matte` preserves soft grayscale coverage and interior holes as
an issued PNG transfer; the old `subject.mask` polygon op remains compatible.
Vision output is at most1024px; it is a useful seed, not finished fine-fur matting.
The JS adapter validates dimensions and leases/releases both transfer files.

WebKit can open IndexedDB but reject Blob/File storage with UnknownError. Studio
retries the same bytes as ArrayBuffer plus MIME and rebuilds a Blob when reading.
No base64 photos. Do not remove this fallback because Chromium works without it.

The final real-photo check caught a WebKit color-management defect in resized
ImageBitmap decoding: Ricky's Apple-profiled JPEG acquired a green cast. Studio
now uses bounded native ImageIO-to-sRGB decoding for JPEG/HEIC and ICC-profiled
PNG sources; browsers use color-managed HTMLImage for profiled PNG/JPEG. Mask
PNGs retain the fast path and exact alpha. Format detection uses file bytes,
including after reopening a Blob without a MIME type. Synthetic self-authored
profiled JPEG/PNG fixtures cover source, rendered and reopened colors plus
transparent holes and partial alpha; no private photo/profile is in those tests.

## Checkpoint on the current Mac

Final application bundle revision: **`ff7396606b9a0171`**. Signed Debug build and
**11/11 native XCTest cases** passed on the paired iPhone; explicit installation
and normal launch succeeded. The app was left open normally. Native ImageIO
checks preserved Ricky's gold/tan colors and profiled PNG alpha values 0/128/255.

The final Studio suite passed **58 grouped browser checks** across Chromium and
WebKit: 16 engine, 2 color-profile, 10 interaction and 1 offline entry per browser.
Node tests passed **673/673**. Legacy strict acceptance passed **17/17**; the
native browser compatibility suite passed **12/12**. Real-photo browser checks
confirmed a repairable two-layer cutout, transform, Undo, reopening and no page
errors. These verify behavior, not the owner's satisfaction with phone gestures
or a finished dinosaur composition. See STATUS.md for publication state.

## Verification on the laptop

Use Node22 or a working newer runtime and the existing global/bundled Playwright.
On this Mac `/opt/homebrew/bin/node` was broken; Node22 under
`/opt/homebrew/opt/node@22/bin` worked. Do not assume that failure on the laptop.
Browser binaries must match the installed Playwright. `PLAYWRIGHT_MODULE` can
point at its `index.mjs`. No application npm dependencies or build step are needed.

Serve `apps/`, not just the repo root:

```sh
cd <checkout>/apps
python3 -m http.server 4174 --bind 127.0.0.1
```

From `apps/gesso`, run `npm test`; then `node e2e/acceptance.mjs` with **no other
browser work at the same time** (strict timing); then `node e2e/native.mjs` and
`node e2e/studio.mjs`. Studio checks exercise real Canvas2D/IndexedDB, alpha/holes,
history restoration, rapid redo boundary, paused multi-stroke tracing, navigation,
reopening and export locks. Desktop WebKit multi-touch is a pointer-handler
simulation; Chromium uses actual CDP touch delivery. Real iPhone gesture quality
still needs the owner's hands-on judgment.

Xcode build/test/device commands are in `apps/gesso-ios/README.md`. The generated
project is checked in; XcodeGen is only needed after project.yml changes. Each
build bundles the exact current web files and stamps `web/revision.txt`.

## Things Git does not transfer

- Signing certificates/private keys, Xcode account/provisioning state, paired
  device trust and local build caches. Determine the team from the signing
  certificate's **subject OU**, not the person identifier in its label.
- The phone's existing WebKit projects/drafts and Safari's separate projects.
  Preserve bundle `quest.elsewhere.gesso` and origin `gesso://localhost` forever.
- This Mac's private fixture `/Users/michael/gesso-fixtures/ricky.jpg` and scratch
  screenshots/test reports under `/tmp/gesso-scratch/`. Do not commit personal
  photos or device identifiers. Use a local fixture or have the owner import it.
- Separate chats, unpublished local modifications and generated runtime packages.

The laptop checkout itself remains unverified until inspected directly. Use the
latest pushed branch and this handoff; do not mark both computers synchronized
from Git history alone.

## Next useful work

First try the installed Studio on the real phone with Ricky and a background.
Observe precise tracing, pauses, edge repair, layer placement, occlusion and
whether each correction remains understandable. Record user-facing friction
before enlarging the toolbar. Then prioritize reusable selection/copy-to-layer,
better edge refinement, per-layer Curves/HSL, flip/perspective and paintable
contact/cast shadows. Add generation only through an explicit provider/privacy/
cost design, while the core stays usable offline. Avoid a collection of inert
tool buttons or a universal “better than Photoshop” claim.
