# Gesso design notes

Artefacts from the design and review sessions, kept here so a new machine or a
new session starts with the same picture. Nothing in this folder ships: the
deploy step strips `design/`.

## Current product direction — 2026-10-23

The owner's hands-on feedback changes Gesso from quick photo correction to
creative photo compositing. [Creative Studio](creative-studio.md) records the
forum research, nine capability priorities, interaction decisions and acceptance
workflow. It supersedes the old restrictions on layers, masks, reusable selections
and the fixed dock. The decisions below describe the original correction editor.

## Decisions already made (don't relitigate without the owner)
- Learnability bar: know where everything is in ~2 s, finish a first edit in
  ~1 min, moderately proficient by ~10 min. Targets to design toward, not
  pass/fail limits (owner's words).
- Five dock tools (Crop, Light, Color, Remove, Text) and four actions, fixed
  places; every panel has the same anatomy (SPEC §3). New capabilities go in
  as modes/chips inside a tool, not as new dock tools.
- App icon: "Pigment Wheel" iris (`mockups/icon-iris-variants.jpg`, #10), the
  owner's pick. Earlier directions in `mockups/icons-all.jpg`.
- Outline (magnetic lasso): a mode chip in the dial row of Remove and Light.
  Loop loosely; the line snaps to edges; lift = fill (Remove) or paint light
  inside (Light). A 140 pt, 3x corner magnifier (top-left, jumps to top-right
  when the finger nears it) instead of a loupe under the finger. Mockups:
  `mockups/outline-remove-and-light.jpg`, `mockups/outline-corner-magnifier.jpg`.
  Library: `lib/lasso.js`; wiring guide: `lasso-integration.md`.
- Replace background (after Outline): same loop, then "Replace background" in
  the quick row with a backdrop segment (Studio, Dusk/Charcoal, Blur, Photo…),
  subject cut along the outline with a soft edge and a contact shadow. Steps
  7–8 in `mockups/story-coffee-12-steps.jpg`.
- Dedicated iOS app: owner chose option A, the SwiftUI/WKWebView shell around
  the bundled web editor with PhotoKit import/save, RAW decode, sharing,
  haptics and Vision subject lift through Outline. Bundle ID
  `quest.elsewhere.gesso`, project at `apps/gesso-ios/`, permanent origin
  `gesso://localhost` (confirmed 2026-10-20). The synthesized design and exact
  bridge contract are in `../ios/DESIGN.md` and `../ios/BRIDGE.md`.

## Review record
`review/` holds the three verdict summaries from the final adversarial review
(82 findings, 70 fixed; see the PR #6 description). Each entry names the
finding, the verdict, and what was verified.

## Scripts
`scripts/` are the Playwright scripts that produced the mockups and the story
screenshots. They were written for a scratch directory and reference absolute
paths from that session; treat them as worked examples of driving the app
(touch via CDP, `window.gesso`, overlay drawing), not as tooling.
