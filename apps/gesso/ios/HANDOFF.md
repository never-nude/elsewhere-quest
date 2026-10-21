# Gesso iOS app — handoff (2026-10-20)

## Continuation by Codex (2026-10-20)

The owner confirmed `quest.elsewhere.gesso`, project `apps/gesso-ios/`, and
permanent origin `gesso://localhost`. The synthesized [DESIGN.md](DESIGN.md),
exact [BRIDGE.md](BRIDGE.md), web integration and buildable native app now exist.
See the latest `STATUS.md` entry for actual validation and delivery. The original
handoff below is preserved as history; its “what is left” and unanswered-identity
sections describe the state before this continuation.

Device signing currently needs an Apple Developer account signed into Xcode
Settings → Accounts. The certificate exists, but Xcode reported “No Accounts”
when asked to create the new bundle's development profile. Simulator validation
passes; device installation and real photo/RAW/Vision checks remain pending.

Written by Claude Code (Fable 5.1) on the owner's Mac mini so another agent or model can finish
this from a clean clone. Branch: `claude/gesso-ios`, cut from `claude/gesso-outline` after PR #7
(Outline) merged to `main` and deployed to https://elsewhere.quest/gesso/.

## Decision already made by the owner

Option A: a small SwiftUI app hosting the existing web editor (`apps/gesso/`) in a WKWebView,
served from the app bundle (fully offline), with native bridges for what the web can't do well
(PHPicker import incl. RAW, Save to Photos, share sheet, Vision subject lift, haptics). NOT a
rewrite. The web app on elsewhere.quest must keep working unchanged (web fallbacks for everything).

## What exists

- `apps/gesso/` — the web app, live, with Outline (SPEC F19) merged. `npm test` 608/608,
  `node e2e/acceptance.mjs` 17/17 (Chromium, strict timings). Read `SPEC.md` §5–§6 first.
- `apps/gesso/design/workflows/gesso-ios-design.js` — the plan this handoff follows. Its run was
  stopped after the Judge phase (6 of 9 agents) to save model budget. The six finished results
  are exported verbatim under `apps/gesso/ios/drafts/`:
  - `touchpoint-map.md` — every place the web app touches the platform (import, decode, export,
    share, IndexedDB, service worker, install line, probe page, window.gesso, …).
  - `design-thin.md`, `design-native-first.md`, `design-product.md` — three complete designs
    from different angles, each with bridge methods, web files to change, open questions.
  - `judge-1.md` (iOS platform engineer), `judge-2.md` (the owner's lens) — scores, factual
    corrections, and what to graft from the other designs.
- Both judges picked **Design 2 "native where it matters"**, by a hair over Design 1 (thin
  shell). Judge 2's recommendation: Design 2's contract and web wiring on Design 1's skeleton
  (one scheme handler, one `{op,args}` dispatch table, issued-name transfer files instead of
  base64 for photos), with the grafts listed in both judge files. Both judges found the same
  factual error in all three designs: a TAP in Outline mode is NOT a no-op (`ui/tools/remove.js`
  routes `tap` to the spot heal before the dial is consulted; Light's trace gesture has no tap
  case), so the proposed "tap the subject" hook needs its own gesture case, not `finishTrace`.
  Judge 1 also flagged bridge replies sent from background queues (WebKit reply handlers must
  be called on the main thread).

## What is left (the three unfinished workflow steps)

The exact prompts are in `design/workflows/gesso-ios-design.js` lines 96–101; in short:

1. **Synthesize** `apps/gesso/ios/DESIGN.md` (the chosen design with grafts and every judge
   correction applied, in SPEC.md's style: goals, non-goals, architecture, each bridge, update
   story, privacy manifest, App Review notes, open questions) and `apps/gesso/ios/BRIDGE.md`
   (the exact JS↔Swift contract: injected global, op names, args/reply shapes, errors,
   timeouts, transfer-file naming, versioning).
2. **Build the web side**: `apps/gesso/ui/platform.js` (feature detection via the injected
   global; promise-based ops with timeouts; web fallbacks: the `#file` input for pickPhoto,
   `navigator.share` / touch-and-hold for save, no-op haptics), wired into `app.js`,
   `ui/importer.js`, `ui/savesheet.js`, hints (no install line in the native build), with node
   tests; keep `npm test` and the acceptance harness green. Then the Xcode project: the
   earlier plan scaffolds it (XcodeGen `project.yml` or a checked-in `.xcodeproj`) at
   `apps/gesso-ios/` (judges' recommendation; the bundle script copies `../gesso` minus
   `e2e/`, `test/`, `design/`, `node_modules/`).
3. **Verify adversarially**: contract mismatches with BRIDGE.md, promise leaks/timeouts, double
   resolution, id collisions, large photos through the bridge, the web app unchanged with no
   bridge present, and `xcodebuild` of the scaffold.

## Putting it on the owner's iPhone from this Mac

Everything needed is present on the Mac mini (checked 2026-10-20): Xcode 27.1 at
`/Applications/Xcode.app`, the iPhone 17 Pro paired and listed by
`xcrun devicectl list devices`, and one "Apple Development" signing identity in the keychain
(`security find-identity -v -p codesigning` shows it with the Team ID in parentheses). The
owner has a paid Apple Developer Program membership.

```sh
# build for the device (set the team once in the project or pass it here)
xcodebuild -project apps/gesso-ios/Gesso.xcodeproj -scheme Gesso -configuration Debug \
  -destination 'platform=iOS,id=<UDID from devicectl>' -allowProvisioningUpdates \
  DEVELOPMENT_TEAM=<TEAMID> build
# install + launch
xcrun devicectl device install app --device <UDID> <path to Gesso.app from the build log>
xcrun devicectl device process launch --device <UDID> <bundle id>
```

The first `-allowProvisioningUpdates` build may need one sign-in in Xcode (Settings →
Accounts) so it can create the provisioning profile. TestFlight: Product → Archive in Xcode (or
`xcodebuild archive` + `-exportArchive` with an App Store Connect API key), then upload through
Organizer. Open the app on the phone and run `?probe=1` from the web app first (device probe
passed every capability row on 2026-10-20 in Safari; the WKWebView result is not yet known).

## Open questions for the owner (consolidated from the three designs)

Decide these before the first device build writes a draft; the first two cannot change later.

1. Bundle id and team: `quest.elsewhere.gesso` under the owner's account? Is the App Store name
   "Gesso" available, or "Gesso Photo"? Project in this repo at `apps/gesso-ios/` (recommended)
   or its own repo?
2. The pinned custom-scheme origin (`gesso-app://app` vs `gesso://app` vs `gesso://localhost`):
   it keys IndexedDB and localStorage forever; changing it later orphans every draft.
3. RAW/ProRAW imports: store the working-size original as JPEG q0.97–0.98 (~10–15 MB, fast)
   or PNG (lossless, ~40–70 MB, ~3 s decode)? Default CIRAWFilter development or flatter?
4. Subject lift UX: a tap inside Outline mode (needs a new gesture case, see above) or a visible
   "Subject" chip; multi-part subjects as several steps or the largest only.
5. Remove's 20% area cap refuses most whole-subject fills: keep (honest tip), raise it for
   subject jobs, tile large fills later, or position subject lift as a Light feature first?
6. Minimum iOS: 17.0 (Vision foreground masks, isInspectable) or 18.
7. Share sheet after AirDrop/Save to Files: leave "not saved" (truthful) or show "Shared."
8. Lockdown Mode: opt our own content out (`isLockdownModeEnabled = false`) or reword the error.
9. iCloud backup of the WebKit data store: default (backed up) or excluded so "stays on this
   iPhone" is literal.
10. Haptics: fixed set with no switch in v1 (keeps the privacy manifest empty) or a toggle.
11. Ship extras in 1.0? Files app as a second import source; the `?probe=1` page behind a
    Settings bundle or DEBUG-only; keyboard accessory bar kept or removed; "Open in Gesso"
    share target later; iPhone-only for 1.0; Pigment Wheel icon as one 1024 PNG or an Icon
    Composer layered icon; a "Get the app" line on the web build once the app is live.

## Practical notes

- Scratch artefacts from today's runs (browser scripts, screenshots, logs) are under
  `/tmp/gesso-scratch/` on the Mac mini only; they are not needed to continue.
- The Claude Code session that did this work is `fa6262d4-7c02-4d49-9528-d3f31d3df15b`
  (`claude --resume` on the Mac mini). Re-invoking the workflow script with the same args
  replays the six finished agents from cache and runs only the three remaining ones.
- Follow AGENTS.md: update STATUS.md with real validation when you finish; stage only
  intended files; the owner authorises commits and pushes.
