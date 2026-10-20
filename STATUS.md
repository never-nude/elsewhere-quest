# Shared project handoff — elsewhere-quest

Setup date: 2026-09-19. This section records repository setup, not a full application audit.

## Repository identity

- Repository: https://github.com/never-nude/elsewhere-quest
- Default branch observed: `main`.
- Scope: this repository only. Related versions are not automatically interchangeable.

## Evidence and current state

README describes a frontend prototype; the remote person and network connection are simulated. Production backend work remains a documented seam, not verified completed work.

README.md was inspected for project context (observed blob `ecb942d2c9c70ad471b583b82012a23580d5e553`). Its existing statements are not new runtime verification.

## Handoff setup

- Task: shared Codex context across this chat and two computer checkouts.
- Owner of this documentation task: ChatGPT Codex session.
- Setup branch: `codex/shared-handoff-20260919`.
- Changes: AGENTS.md session-start/session-finish rules plus this status record; application code unchanged.
- Validation: checked availability of root instructions and status; preserved existing documents/history. No application runtime tests were performed for this documentation-only task.
- Delivery: check the setup pull request in GitHub for merge status. If these changes are on the remote default branch, they are integrated there; this does not establish deployment success or local computer synchronization.

## Unverified local work

Neither computer's checkout, uncommitted changes, unpushed commits, local paths, running tasks, nor separate Codex conversations has been inspected. Do not mark either machine synchronized based on these files alone.

## Next session

1. Read AGENTS.md and existing project instructions.
2. Inspect the local remote/branch and preserve pending work; fetch and safely integrate the shared default branch.
3. Record discovered unfinished work, its branch, actual validation, and next step here. Reconcile it with remote history before implementation.
4. At task completion, update this handoff and publish it through the existing repository workflow when authorized.

## Future handoff fields

Task / owner / branch:
Completed:
Validation actually performed:
Open issues / blockers:
Next step:
Delivery (local, pushed, merged, deployment verified):

## 2026-09-29 — Corpora privacy policy page

- Task: host a public privacy policy URL for the Corpora iPhone app (bundle `com.atrium.scanner`, separate project) so external TestFlight testing can be enabled.
- Owner: Claude Code cloud session. Branch: `claude/corpora-privacy-policy`.
- Change: static page `public/corpora/privacy/index.html`, served at `https://elsewhere.quest/corpora/privacy/` once merged to `main` and the Pages deploy runs. No app code changed.
- Validation: `npm run build` succeeds locally and `dist/corpora/privacy/index.html` is emitted. Live URL not yet verified (not merged).
- Next: merge, confirm the URL loads, paste it into App Store Connect → App Information → Privacy Policy URL.

## 2026-10-20 — Gesso: simple Photoshop-style photo editor PWA (ready for review)

- Task: build Gesso, an on-device photo editor for iPhone, at `apps/gesso/` → `https://elsewhere.quest/gesso/` (same pattern as TextLock: vanilla ES modules, no build step, pure logic in `lib/` under `node --test`).
- Owner: Claude Code cloud session. Branch: `claude/gesso-photo-editor`. Draft PR #6.
- Design: `apps/gesso/SPEC.md` (iOS Safari research + three UX concepts + two judges, held to the owner's bar: know where everything is in 2 s, finish a real task in 1 min, proficient by minute 10). Build notes at its top record deliberate deviations.
- Done: static shell (5 labelled tools + 4 actions paint before JS), WebGL2 renderer, editor core (history, live preview, tool sessions, Before/wipe, zoom + navigator), all six panels (Home with Auto-enhance, Crop, Light incl. paint light, Color incl. looks and Pick white, Remove with tap heal and rub-to-fill in a worker, Text captions), Save to Photos (banded GPU export + worker JPEG encode, share sheet with a touch-and-hold fallback), IndexedDB autosave/restore, earned hints, rewind tape (hold Undo), `?probe=1` device probe, Playwright acceptance harness (`apps/gesso/e2e/`, excluded from deploy). App icon: "Pigment Wheel" iris (owner's pick). TextLock's service worker now only deletes `textlock-*` caches (it used to wipe other apps' caches on the shared origin).
- Validation: `cd apps/gesso && npm test` — 539 node tests pass. `node e2e/acceptance.mjs` — 17/17 checks pass at strict timings on an emulated iPhone 17 Pro Max (Chromium + SwiftShader; Remove spot 542 ms, Save ready 1.7 s). Feature agents' browser suites (Remove, Text, Save, autosave/restore incl. broken-IndexedDB and lost-connection cases) pass on the integrated app. Not yet tested on a real iPhone or in WebKit.
- Final review (done): 9 dimensions (editor core, Remove/Text, iOS Safari, adjustment tools, Save/autosave, first-run walkthrough, image quality, performance, accessibility/offline), 82 findings, each independently re-verified in the browser with a tested diff; 70 confirmed and fixed in three batches (f2ad749, 94e00c4, 199e500 + 52e52c2), the rest duplicates, refuted, or iOS-only (install-line wording) to check on the device. Highlights: Cancel after Undo could delete earlier steps (critical); a Remove fill landing after Done was thrown away by the next tool's Cancel; Crop Auto reused the previous photo's tilt; service worker now cache-first with a deploy-stamped cache name (no mixed deploys offline); gain-aware highlight shoulder, edge-aware local tone, transparent PNGs on white; VoiceOver/keyboard fixes. After all three batches: `npm test` 559 pass, `node e2e/acceptance.mjs` 17/17 at strict timings, and the feature agents' and verifiers' browser scripts re-run green on the integrated app.
- Also on the branch, not yet wired in: `lib/lasso.js` (magnetic lasso / "Outline" selection, 16 tests) for the next PR: Outline mode in Remove and Light with a corner magnifier, then Replace background. Mockups in the session's scratchpad.
- Done: PR #6 merged (5d3e2b9) and deployed to https://elsewhere.quest/gesso/ (Pages run 10, success). Device check still owed: open `?probe=1` on the iPhone.
- In progress: Outline (magnetic lasso) on branch `claude/gesso-outline`. Done and committed: `lib/magnifier.js` + `ui/magnifier.js` (corner magnifier, 13 tests) and a partial start on Remove › Outline (`ui/tools/remove.js`, `lib/remove-plan.js`). Not started: Light › Outline, renderer.paintMask, hints/SPEC/harness rows, integration. The cloud container restarted twice on 2026-10-20 (19:34 and 20:53 UTC) and killed the running agent workflows, so the work moves to the owner's Mac mini.
- Handoff to the Mac (2026-10-20 21:00 UTC): from a clean clone, `claude --teleport session_01B3MaVF8eXXzmhV1iLiNcUy` brings this conversation and the branch. Then, with `/effort ultracode`, run the two workflow scripts in `apps/gesso/design/workflows/` (README there): `gesso-outline.js` first (verify magnifier → build Remove + Light → verify), then `gesso-ios-design.js` (touchpoint map → 3 designs → judges → `apps/gesso/ios/DESIGN.md` + `BRIDGE.md` → web-side bridge `ui/platform.js` → verify; scaffolds the Xcode project if xcodebuild is present). The owner chose option A for the iOS app (SwiftUI/WKWebView shell + native bridges). Device probe on the iPhone 17 Pro passed every capability row.
- Next after those: integrate Outline (apply patchesForIntegrator, `npm test`, `node e2e/acceptance.mjs` 17/17, PR), then the Xcode app from DESIGN.md, then Replace background.
- Delivery: pushed to the branch only; not merged, not deployed.

## 2026-10-20 — Gesso: Outline (magnetic lasso) integrated, draft PR open

- Task: Outline mode in Remove and Light (SPEC F19): a mode chip in each tool's dial row; a drag traces a loop that snaps to edges (`lib/lasso.js` live wire), with the 3× corner magnifier; lift fills the inside (Remove, "Removed outline", Try another / Source as for a rub) or paints light/shade through the new `renderer.paintMask` (Light, "Brightened/Darkened/Erased inside outline") with an Amount ruler that live-recommits the loop. Polygons stored in source px; autosave/restore, undo/redo pixel-exact.
- Owner: Claude Code on the Mac mini (session moved from the cloud container, which kept restarting). Branch: `claude/gesso-outline`.
- How it was built: `design/workflows/gesso-outline.js` (magnifier verifier → Remove and Light builders → adversarial verifier each; 5 agents), patches to shared files merged by hand (hints H15–H17, reducer `hold-end { cancelled }`, draft reviver, ruler entry, sw.js shell, SPEC, harness states). Then an integration review (5 reviewers, 3 refuters per finding): 12 findings, 9 confirmed, all fixed and re-verified in the browser — an H2 hint regression from the H1 hook change (fixed with a `scrub` flag on `ruler-drag`), a hold during a Before peek swallowing a claimed trace (editor.js `holdByTool`), Color's Pick white committing on a cancelled hold, Light's Amount re-commit replacing the wrong step after a mid-drag Undo, the ruler vanishing after Undo of a re-commit, an amount-0 loop committing a no-op step, a stale edge map after a fill lands mid-trace (both tools), and SPEC/hints wording for H17 (only a brighten/darken loop earns it).
- Validation actually performed (Mac mini, 2026-10-20): `cd apps/gesso && npm test` — 608 pass, 0 fail. `node e2e/acceptance.mjs` — 17/17 at strict timings (14 UI states, 26 gestures; Remove spot 149 ms, Save ready 702 ms). The builders' and verifiers' feature suites on the integrated tree: Remove › Outline 32/32 Chromium (CDP touch) and 30/30 WebKit, verifier 20/20 Chromium and 17/17 WebKit, pointercancel-on-hold → no step; Light › Outline 36/36 adversarial checks Chromium and the same set in WebKit, builder suite green in both except two script artefacts (a stat with no samples; a headless-WebKit JPEG re-decode that a control reload without Outline reproduces). The harness has no WebKit mode (it needs CDP for touch, safe areas and the network cut), so WebKit coverage is the feature suites only. Not tested on a real iPhone.
- Open issues: a plain tap with Outline on still heals a spot at brush size (pre-existing tap path; SPEC F19 now says so — a two-line guard if the owner prefers nothing); design question — after a brighten/darken lift the ruler slot becomes the Amount ruler for that loop, whereas mockup step 6 shows the segment staying up (what the workflow decisions asked for; confirm on the device); on the first chip-on, H15 holds the hint line 4 s so "Filling inside the outline…" can be hidden (hints-ui priority, pre-existing); dragging the Amount ruler to 0 still commits an amount-0 step; six Light chips are tight at 375 pt (not a target viewport). Device check still owed: `?probe=1` and a real loop on the iPhone 17 Pro (magnifier readback cost, PatchMatch fill time).
- Next: review/merge the draft PR, then `design/workflows/gesso-ios-design.js` (touchpoint map → three designs → judges → `apps/gesso/ios/DESIGN.md` + `BRIDGE.md` → `ui/platform.js`), then Replace background.
- Delivery: committed and pushed to `claude/gesso-outline`; draft PR open (number in the git log / GitHub); not merged, not deployed.
