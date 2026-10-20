export const meta = {
  name: 'gesso-ios-design',
  description: 'Design the dedicated iOS app for Gesso (option A: SwiftUI/WKWebView shell with native bridges), write the design + bridge contract into the repo, and build + verify the web side of the bridge',
  phases: [
    { title: 'Understand', detail: 'map every touchpoint a native shell must bridge' },
    { title: 'Design', detail: 'three independent designs from different angles' },
    { title: 'Judge', detail: 'two judges score, synthesis writes the docs' },
    { title: 'Build', detail: 'web-side platform bridge, verified' },
  ],
}

// args: { fixtures: '/abs/dir of real photos', scratch: '/abs/scratch dir' }
const SP = (args && args.scratch) || '/tmp/gesso-scratch'
const APP = 'apps/gesso'

const CONTEXT = `
Gesso is a simple Photoshop-style photo editor PWA (vanilla ES modules, no build step, WebGL2, IndexedDB autosave, PatchMatch fills in a worker, JPEG export in a worker, service-worker shell) at ${APP} (paths relative to the repo root), live at https://elsewhere.quest/gesso/. Read ${APP}/SPEC.md (§5 architecture, §5.6 autosave, §5.7 import/export, §6 iOS constraints), ${APP}/README.md, ${APP}/design/README.md (decisions already made), app.js, ui/importer.js, lib/image-io.js, ui/savesheet.js, ui/exporter.js, ui/store.js, ui/autosave.js, sw.js, ui/probe.js, index.html (install line, #file input), ui/hints-ui.js / lib/hints.js (the install hint).
The owner (an artist who writes Swift/SwiftUI, JS/TS; GitHub never-nude) has chosen OPTION A for a dedicated iOS app: a small SwiftUI app hosting the existing web editor in a WKWebView, served from the app bundle (fully offline), with native bridges for what the web can't do well. NOT a rewrite. The web app must keep working unchanged on elsewhere.quest (web fallbacks for everything).
Facts from the real device (iPhone 17 Pro, iOS 26 Safari, probe run on 2026-10-20): WebGL2 on Apple GPU, MAX_TEXTURE_SIZE 16384, RGBA16F/RG8 framebuffers OK, HEIC decode via createImageBitmap OK, EXIF orientation applied, navigator.share with files OK, IndexedDB Blob OK, module worker + OffscreenCanvas JPEG OK, coalesced pointer events OK, 48.8 MP canvas OK, screen 402x874 @3x, storage persist NOT granted in a Safari tab (7-day eviction risk for non-installed sites).
Goals for the native app, in order: (1) Photos in and out without the share-sheet dance: PHPicker (no photo-library permission needed) for import, PHPhotoLibrary add for "Save to Photos" with a real success/failure result, and the Files app / share sheet as secondary; (2) Vision subject lift (VNGenerateForegroundInstanceMaskRequest, iOS 17+) to give Outline a "tap the subject" mode, feeding the same mask path as the lasso (Outline lives on branch claude/gesso-outline: lib/lasso.js polygon masks; Remove fills through a polygon mask; Light paints through renderer.paintMask with a raster mask, so a raster mask from Vision can plug into both); (3) durable storage (WKWebView's default data store, no 7-day eviction; migration from Safari-tab drafts not required); (4) haptics on commit/Done/snap; (5) HEIC/ProRAW/DNG decode natively when createImageBitmap can't; (6) App Store readiness: offline, no network at all, privacy manifest, "everything stays on this iPhone" as the product story, Pigment Wheel icon (icon.svg), launch screen, iPad later. Non-goals now: a native rewrite of any editing code, accounts, cloud.
WKWebView facts to design around (verify against your own knowledge and state your confidence): a custom URL scheme via WKURLSchemeHandler is the standard way to serve a bundled app with correct MIME types and a stable origin (file:// breaks IndexedDB/workers/modules in places); service workers are unavailable under a custom scheme, so the web app must skip SW registration when native; WKScriptMessageHandlerWithReply gives promise-based JS→Swift calls (iOS 14+); large binary transfer options: base64 through the message bridge (fine up to a few MB), or files written by Swift into a temp dir and served by the scheme handler (better for photos; Range requests possible); navigator.share availability inside WKWebView is uncertain, so the bridge provides native share regardless; the web app detects native via an injected flag (WKUserScript at document start), not UA sniffing; viewport-fit=cover and safe-area env() come from the web view's insets; keyboard via visualViewport; hide the Safari install line and the ?probe=1 install rows when native.
Tooling on this machine: node tests (cd ${APP} && npm test); Playwright from the global install (run \`npm root -g\` and import \`<that>/playwright/index.mjs\`); the app served from the working tree at http://127.0.0.1:4174/gesso/ (if down: cd apps && nohup python3 -m http.server 4174 --bind 127.0.0.1 >/dev/null 2>&1 &). Xcode may be present: if \`xcodebuild -version\` works, the Build phase may also scaffold and compile the Xcode project (see the Build task). Scratch dir for throwaway files: ${SP}/ios/.
`

const TOUCHPOINTS = {
  type: 'object',
  properties: {
    touchpoints: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, where: { type: 'string', description: 'file:line(s)' }, what: { type: 'string' }, todayOnWeb: { type: 'string' }, nativeOpportunity: { type: 'string' }, risk: { type: 'string' },
    }, required: ['id', 'where', 'what', 'todayOnWeb', 'nativeOpportunity', 'risk'] } },
    outlineMaskPath: { type: 'string', description: 'how a raster mask from Vision enters Remove and Light given the Outline code on this branch' },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['touchpoints', 'outlineMaskPath', 'notes'],
}

const DESIGN = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    design: { type: 'string', description: 'the full design in markdown: app structure (targets, folders, XcodeGen project.yml outline), how the web app is bundled and served (scheme, origin, MIME, caching, versioning), the JS<->Swift bridge contract (every method: name, args, reply, errors, binary transfer, timeouts), how each goal 1–6 is met, the web-side platform module and exactly which existing files change and how (with code sketches), persistence/migration, App Store items (Info.plist keys, privacy manifest, entitlements, icon/launch), testing strategy on the Mac (XCTest/UI tests, Playwright, simulator), risks with mitigations, and a build order with time estimates' },
    bridgeMethods: { type: 'array', items: { type: 'string' } },
    filesChangedInWebApp: { type: 'array', items: { type: 'string' } },
    openQuestionsForOwner: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'summary', 'design', 'bridgeMethods', 'filesChangedInWebApp', 'openQuestionsForOwner'],
}

const SCORE = {
  type: 'object',
  properties: {
    scores: { type: 'array', items: { type: 'object', properties: {
      title: { type: 'string' }, total: { type: 'number' },
      breakdown: { type: 'object', properties: { fitsGoals: { type: 'number' }, technicalSoundness: { type: 'number' }, appStoreRisk: { type: 'number' }, webAppUnchangedOnWeb: { type: 'number' }, buildEffort: { type: 'number' }, extensibilityToNative: { type: 'number' } }, required: ['fitsGoals', 'technicalSoundness', 'appStoreRisk', 'webAppUnchangedOnWeb', 'buildEffort', 'extensibilityToNative'] },
      strongest: { type: 'string' }, weakest: { type: 'string' }, factualErrors: { type: 'array', items: { type: 'string' } },
    }, required: ['title', 'total', 'breakdown', 'strongest', 'weakest', 'factualErrors'] } },
    winner: { type: 'string' },
    graftFromOthers: { type: 'array', items: { type: 'string' } },
  },
  required: ['scores', 'winner', 'graftFromOthers'],
}

const REPORT = {
  type: 'object',
  properties: {
    filesWritten: { type: 'array', items: { type: 'string' } },
    testsPassing: { type: 'boolean' },
    verified: { type: 'array', items: { type: 'string' } },
    patchesForIntegrator: { type: 'array', items: { type: 'string' } },
    knownGaps: { type: 'array', items: { type: 'string' } },
  },
  required: ['filesWritten', 'testsPassing', 'verified', 'patchesForIntegrator', 'knownGaps'],
}

phase('Understand')
const map = await agent(`${CONTEXT}\n\nTASK: produce the touchpoint map: every place the web app touches the outside world or the platform (photo import incl. the #file input and Choose a photo, decode paths and their failure modes, export + share + fallback, autosave/IndexedDB/persist, service worker registration and the install line/hints, probe page, the New photo/confirm flow, window.gesso, any UA/standalone sniffing, viewport/safe-area/keyboard handling, web-only APIs), each with exact file:line, what happens today on the web, the native opportunity, and the risk if bridged wrongly. Also read the Outline code on this branch (ui/tools/remove.js, ui/tools/light.js, ui/renderer.js, lib/lasso.js, ui/magnifier.js) and describe precisely how a raster subject mask from Vision would enter the Remove fill and the Light paint paths (which function takes what). Read-only: do not modify the repo.`, { label: 'map:touchpoints', phase: 'Understand', schema: TOUCHPOINTS })
log(`touchpoints: ${map?.touchpoints?.length ?? 0}`)

const ANGLES = [
  { key: 'thin', brief: 'ANGLE "Thinnest shell": the smallest Swift surface that meets goals 1–6; everything that can stay in the web app stays there; the bridge is tiny and generic (one request/reply channel with named ops) so new features need no Swift changes; prefer platform defaults over custom UI.' },
  { key: 'native-first', brief: 'ANGLE "Native where it matters": design the bridges as first-class native experiences: PHPicker presented natively, saving with PHPhotoLibrary and a native success toast/haptic, Vision subject lift with a native progress state and a fallback, native share sheet, native decode for RAW/DNG via ImageIO/CoreImage, a haptics vocabulary, scene phases/background handling (flush autosave), memory warnings (drop caches), and a path to move the fill engine to Metal later behind the same bridge.' },
  { key: 'product', brief: 'ANGLE "Ship it": App Store readiness and product polish first: bundle versioning and the update story (web assets ship with the app; how the service worker/caching model changes), privacy manifest and required-reason APIs, the no-network guarantee as a feature, review guideline 4.2 risk and how the native integrations answer it, first-run on native (no install line), iPad/Stage Manager later, crash/diagnostics without network, the TestFlight loop, what the owner does in Xcode on day one.' },
]

phase('Design')
const designs = await parallel(ANGLES.map((a) => () => agent(`${CONTEXT}\n\nTOUCHPOINT MAP:\n${JSON.stringify(map, null, 1)}\n\n${a.brief}\n\nWrite a complete, concrete design for option A from this angle (full markdown in the 'design' field). Be specific: real API names (PHPickerViewController, PHPhotoLibrary.shared().performChanges, VNGenerateForegroundInstanceMaskRequest, WKURLSchemeHandler, WKScriptMessageHandlerWithReply, WKUserScript, UIImpactFeedbackGenerator, CGImageSource/ImageIO for DNG, etc.), exact bridge method signatures, the web-side module shape (ui/platform.js with web fallbacks) and the minimal diffs to existing files, an XcodeGen project.yml outline, Info.plist keys, a privacy manifest, and the build order. Where unsure of a WKWebView/iOS fact, say so and give the fallback. Do not modify the repo.`, { label: `design:${a.key}`, phase: 'Design', schema: DESIGN })))
const live = designs.filter(Boolean)
log(`designs: ${live.map((d) => d.title).join(' | ')}`)

phase('Judge')
const judges = await parallel([0, 1].map((i) => () => agent(`${CONTEXT}\n\nYou are judge ${i + 1} of 2 (${i === 0 ? 'an iOS platform engineer who has shipped WKWebView-hosted apps through App Review' : 'the owner of the web app, who wants the web version unchanged and the native one to feel native'}). Score each design 0–10 on: fitsGoals, technicalSoundness (call out any API or WKWebView claim that is wrong or unsupported, with the correct fact), appStoreRisk (10 = lowest risk), webAppUnchangedOnWeb, buildEffort (10 = least effort for the value), extensibilityToNative. Name the winner and what to graft from the others.\n\nDESIGNS:\n${live.map((d, k) => `=== DESIGN ${k + 1}: ${d.title}\n${d.summary}\n${d.design}\n`).join('\n')}`, { label: `judge:${i + 1}`, phase: 'Judge', schema: SCORE })))
const verdicts = judges.filter(Boolean)
log(`judges picked: ${verdicts.map((v) => v.winner).join(' / ')}`)

const synth = await agent(`${CONTEXT}\n\nYou are the SYNTHESIZER. Write the final design into the repo as TWO files (create the folder):\n1. ${APP}/ios/DESIGN.md — the chosen design with the best ideas grafted from the others and every factual correction the judges made applied, written for the owner (who builds it in Xcode on this Mac with Claude Code) in the style of SPEC.md: goals, non-goals, app structure, bundling/serving, bridge, how each goal is met, web-side changes (file by file, with code sketches), persistence, App Store checklist, testing, build order with estimates, risks, open questions for the owner.\n2. ${APP}/ios/BRIDGE.md — the JS<->Swift contract as a precise reference: the injected global (name, shape, version), every method with args/reply/error shape, binary transfer rules, timeouts, the Swift→JS event channel (scene phase, memory warning, photo-library changes), and the web fallbacks the platform module must implement when native is absent.\nReturn the touchpoint-to-method mapping and the build order. Do not modify any other file.\n\nTOUCHPOINT MAP:\n${JSON.stringify(map, null, 1)}\n\nDESIGNS:\n${live.map((d, k) => `=== DESIGN ${k + 1}: ${d.title}\n${d.design}\n`).join('\n')}\n\nJUDGES:\n${JSON.stringify(verdicts, null, 1)}`, { label: 'synthesize', phase: 'Judge', schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } }, buildOrder: { type: 'array', items: { type: 'string' } }, bridgeMethods: { type: 'array', items: { type: 'string' } }, openQuestions: { type: 'array', items: { type: 'string' } } }, required: ['files', 'buildOrder', 'bridgeMethods', 'openQuestions'] } })
log(`design written: ${(synth?.files ?? []).join(', ')}`)

phase('Build')
const built = await agent(`${CONTEXT}\n\nThe design is in ${APP}/ios/DESIGN.md and the bridge contract in ${APP}/ios/BRIDGE.md: read both. TASK: implement the WEB SIDE of the bridge (node-testable). You own: ${APP}/ui/platform.js (new: feature detection via the injected global per BRIDGE.md; promise-based methods with timeouts; web fallbacks: file input for pickPhoto, navigator.share / the touch-and-hold fallback for savePhoto, null for subjectMask, no-op haptics; an event emitter for Swift→JS events), ${APP}/lib/bridge.js (new, pure: message framing/ids/timeouts/binary encoding helpers, with node tests in test/bridge.test.mjs), test/platform.test.mjs (jsdom-free tests with a fake window.webkit.messageHandlers), and the minimal integration diffs to app.js (Choose a photo → platform.pickPhoto; skip SW registration and the install line when native; flush autosave on the 'background' event; memory-warning → drop caches via existing editor APIs), ui/savesheet.js (Save to Photos → platform.savePhoto with a real result; keep the web path identical when not native), ui/probe.js (a 'Native bridge' row), index.html only if the design requires a meta/viewport change. Do NOT touch ui/tools/remove.js, ui/tools/light.js, ui/renderer.js, lib/hints.js, SPEC.md or e2e/acceptance.mjs (another workflow may be editing them); diffs for those go in patchesForIntegrator. Keep the web app byte-for-byte equivalent in behaviour when the native global is absent: prove it with npm test and acceptance checks 8, 9, 15, 17 against the live app, and, for the native path, a Playwright run that injects a fake window.webkit.messageHandlers + the injected global via addInitScript and asserts that pickPhoto/savePhoto/subjectMask go through the bridge (scripts in ${SP}/ios/build/). If xcodebuild works on this machine, ALSO scaffold the Xcode project per DESIGN.md under ${APP}/ios/ (XcodeGen project.yml, SwiftUI app, scheme handler, bridge handlers, a build phase that copies the web app into the bundle), run xcodegen and xcodebuild for the iOS Simulator, and report the result; if it does not build, leave it compiling-clean as far as you got and say exactly what fails. Match the surrounding code style. Do not commit.`, { label: 'build:web-bridge', phase: 'Build', schema: REPORT })
const verified = await agent(`${CONTEXT}\n\nYou are the ADVERSARIAL VERIFIER for the web side of the bridge (and the Xcode scaffold if it was built), just finished by another agent. Its report:\n${JSON.stringify(built)}\nRead ${APP}/ios/BRIDGE.md and the files it wrote. Try to break it: contract mismatches with BRIDGE.md, promise leaks/timeouts, double resolution, id collisions, base64 of a 5 MB blob (measure), behaviour when the native side throws or never replies, when native is absent (the web app must be unchanged: diff the DOM and the network requests of the start screen and the Save flow against HEAD's behaviour), when the injected global appears late, the Save result states (saved / denied / cancelled / failed) and what the sheet shows for each, autosave flush on background, memory warning. If an Xcode project exists and xcodebuild works, build it for the simulator and run it (xcrun simctl), load a photo through the bridge, and report. Fix real bugs in the files it owns, re-run npm test and acceptance checks 8, 9, 15, 17, and report. Scripts in ${SP}/ios/verify/. Do not touch files the other workflow owns (remove.js, light.js, renderer.js, hints.js, SPEC.md, acceptance.mjs); extra diffs go in patchesForIntegrator. Do not commit.`, { label: 'verify:web-bridge', phase: 'Build', schema: REPORT })
return { map, designs: live.map((d) => ({ title: d.title, summary: d.summary, openQuestionsForOwner: d.openQuestionsForOwner })), verdicts, synth, built, verified }
