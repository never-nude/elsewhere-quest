export const meta = {
  name: 'gesso-outline',
  description: 'Build the Outline (magnetic lasso) mode for Gesso: verify the shared corner magnifier, then Remove and Light integrations in parallel, each adversarially verified in the browser',
  phases: [
    { title: 'Magnifier', detail: 'verify the existing corner magnifier module' },
    { title: 'Build', detail: 'Remove › Outline and Light › Outline in parallel' },
    { title: 'Verify', detail: 'independent adversarial verifier per tool' },
  ],
}

// args: { fixtures: '/abs/dir of real photos', scratch: '/abs/scratch dir' }
const FIX = (args && args.fixtures) || '/tmp/gesso-fixtures'
const SP = (args && args.scratch) || '/tmp/gesso-scratch'
const APP = 'apps/gesso'
const DESIGN = `${APP}/design`

const CONTEXT = `
You are building the "Outline" feature for Gesso, a simple Photoshop-style photo editor PWA for an iPhone 17 Pro (iOS Safari / Home Screen app), owned by an artist. Its learnability goals (know where everything is in ~2 s, finish a first edit in ~1 min, moderately proficient by ~10 min) are design targets, not hard pass/fail limits. Branch: claude/gesso-outline (fresh from main; node tests pass; 17/17 acceptance checks pass). Paths below are relative to the repo root.

Code: ${APP} (vanilla ES modules, no build step; pure logic in lib/ under node --test; UI in ui/). READ FIRST: ${APP}/SPEC.md (architecture §5, gestures §4, panel contract §3, iOS constraints §6, acceptance checks §1b), ${APP}/README.md, ${APP}/e2e/README.md, ${DESIGN}/README.md (decisions already made) and the lasso integration note ${DESIGN}/lasso-integration.md (written by the author of lib/lasso.js; it says exactly which coordinate spaces, which existing functions and which new renderer entry point to use — follow it unless you find it wrong, and say so if you do). lib/lasso.js and test/lasso.test.mjs exist and are not to be edited (buildCostMap, createLasso, polygonMask, polygonBounds, polygonArea, transformPolygon, scalePolygon, polygonRecord, revivePolygon). The corner magnifier module ALREADY EXISTS: ui/magnifier.js (read its header for the API) and lib/magnifier.js with tests. Remove › Outline was partly started by an earlier, interrupted attempt: ui/tools/remove.js and lib/remove-plan.js may contain partial edits (git log -- those files); keep what is sound and finish.

The intended look and behaviour, mocked over the real app and approved by the owner: ${DESIGN}/mockups/outline-remove-and-light.jpg (Remove flow, then Light), ${DESIGN}/mockups/outline-corner-magnifier.jpg (the corner magnifier), ${DESIGN}/mockups/story-coffee-12-steps.jpg (steps 2, 5, 6). Look at them with the Read tool. Decisions already made:
- Outline is a MODE CHIP in the dial row of Remove and of Light (kind 'mode', id 'outline', label 'Outline', value 'On'/'Off'), not a new dock tool. While it is on, dragging on the photo traces a loop; the line snaps to the nearest strong edge within ~18 pt of the finger (lib/lasso live wire); anchors drop as you go; lifting closes the loop along edges. The hint while on: 'Loop around it. The line snaps to edges.'
- Fill/apply happens ON LIFT, like tap and rub do today (no Done needed). Remove: the inside is filled by the existing engine (polygon mask through rubTile, per the note), labelled 'Removed outline'; Try another and Source work as for a rub. Light: the inside gets painted light/shade via a new renderer.paintMask entry point (per the note), one history step 'Brightened inside outline' / 'Darkened inside outline', with the existing Brighten/Darken/Erase segment choosing the mode and an 'Amount' ruler (−100…100 → ∓1.5 EV, default +67 ≈ +1 EV) that live-recommits the entry.
- The CORNER MAGNIFIER (ui/magnifier.js): 140 pt rounded square at the stage's top-left, 3× magnification around the finger, crosshair, the snapped path and anchors drawn inside at 3×, a faint dotted ring for the snap reach; it jumps to the top-right when the finger comes within 40 pt of it, appears on drag start and fades ~300 ms after lift; drawn on the overlay canvas in drawOverlay, reading pixels via ed.readOutput({ rect, maxSide }) at most once per frame.
- Hints: earned hints live in lib/hints.js (GESTURES rows + HINTS with H-ids); acceptance check 12 compares GESTURES rows against the live DOM (dial ids etc.), so every new row must point at real controls. Add 'outline-on' (first time Outline is switched on: 'Loop loosely around it. The line snaps to the edges.') and 'outline-done' (after the first lift: Remove: 'Filled inside the outline. Try another gives a different fill.'; Light: 'Drag the ruler to change how much.'). Keep ids and copy consistent between the two tools.
- SPEC.md gets a new feature section F15 Outline (existing style) and §4 gesture rows; e2e/acceptance.mjs's UI-state list (checks 2, 3, 4, 13) gets 'Remove › Outline' and 'Light › Outline' states; the harness must still pass 17/17 with your work applied.
- Undo/redo must be pixel-exact and the polygon is stored in SOURCE px (a later crop/rotate/flip must not move it) — note §1 and §6. Autosave/restore brings it back (pool entries use plain numbers: polygonRecord/revivePolygon).
- SPEC §6 (iOS): no ctx.filter, inputs ≥ 16 px, memory (drop the cost map on close), no per-frame work when idle; gestures come through the editor's reducer (lib/gestures.js: SLOP 8, HOLD_MS 500; tool.onGesture receives drag-start/drag/drag-end/drag-cancel/tap/hold; a tool that needs hold off while tracing sets claimsHold).
- Style: match the surrounding code (terse comments explaining why, small pure helpers in lib/ with node tests, no dependencies, no build step). Panel specs come from tool.panel(ed) (ui/panel.js header has the PanelSpec shape).

Tooling: unit tests: cd ${APP} && npm test. Acceptance: node e2e/acceptance.mjs (--only N; see e2e/README.md). Browser: Playwright — import { chromium, webkit } from the global install: run \`npm root -g\` and import \`<that>/playwright/index.mjs\`; iPhone 17 Pro: viewport 402x874, deviceScaleFactor 3, isMobile, hasTouch; drive touches through a CDP session on Chromium (Input.dispatchTouchEvent) — worked examples in ${DESIGN}/scripts/*.mjs (they reference an old scratch dir; use the ideas, not the paths). If WebKit is installed (\`playwright install webkit\`), also run your main checks in webkit (no CDP there: use page.touchscreen.tap and page.mouse for drags). The live app is served from the working tree at http://127.0.0.1:4174/gesso/ (if down: cd apps && nohup python3 -m http.server 4174 --bind 127.0.0.1 >/dev/null 2>&1 &). Photo fixtures: ${FIX}/ (real photos; pick a subject with clear edges). window.gesso = { editor, renderer, importFile } is exposed for scripts.

OWNERSHIP (hard rule): edit ONLY the files assigned to you below, plus new files you create under your assignment. Other agents edit other files in the same working tree at the same time. Changes you need in any other file (ui/editor.js, ui/renderer.js except where assigned, lib/hints.js, SPEC.md, e2e/acceptance.mjs, lib/ruler.js, styles.css, index.html, sw.js) go in your report as exact unified diffs against the current file (paths a/apps/gesso/...), each checked with git apply --check from the repo root, and tested by you on a scratch copy of the app (copy ${APP} to your scratch dir, apply, serve on your assigned port bound to 127.0.0.1, run your browser checks there; stop the server when done). Do not commit, do not touch git state, do not modify lib/lasso.js. Scratch dir and port are given below.

Before you report, run npm test (must pass except a sw-shell SHELL entry for any new module, listed under newModulesForSwShell) and the acceptance checks 2, 3, 4, 10, 12, 16 on your patched scratch copy (node e2e/acceptance.mjs --base http://127.0.0.1:<port>/gesso/ --only 2,3,4,10,12,16). Report honestly: what you verified in the browser (with measured numbers), what you could not, and known gaps.
`

const REPORT = {
  type: 'object',
  properties: {
    filesOwnedAndWritten: { type: 'array', items: { type: 'string' } },
    newModulesForSwShell: { type: 'array', items: { type: 'string' } },
    browserVerified: { type: 'array', items: { type: 'string' } },
    testsPassing: { type: 'boolean' },
    patchesForIntegrator: { type: 'array', items: { type: 'string' }, description: 'unified diffs for files you do not own, each with a one-line why' },
    knownGaps: { type: 'array', items: { type: 'string' } },
  },
  required: ['filesOwnedAndWritten', 'newModulesForSwShell', 'browserVerified', 'testsPassing', 'patchesForIntegrator', 'knownGaps'],
}

const VERDICT = {
  type: 'object',
  properties: {
    bugsFixed: { type: 'array', items: { type: 'string' } },
    additionalPatchesForIntegrator: { type: 'array', items: { type: 'string' } },
    remainingConcerns: { type: 'array', items: { type: 'string' } },
    testsPassing: { type: 'boolean' },
  },
  required: ['bugsFixed', 'additionalPatchesForIntegrator', 'remainingConcerns', 'testsPassing'],
}

const TASKS = {
  magnifier: `ASSIGNMENT "magnifier" — scratch ${SP}/outline/magnifier/, port 4601. You own lib/magnifier.js, ui/magnifier.js and test/magnifier.test.mjs, which an earlier agent wrote. Read them against the magnifier spec in CONTEXT; attach the magnifier to the live app's Remove tool temporarily from a Playwright script (monkey-patch drawOverlay through window.gesso) and screenshot it at 402x874 and 874x402, in both corners, mid-drag; look at the screenshots and compare with ${DESIGN}/mockups/outline-corner-magnifier.jpg. Fix what is wrong or missing (fade-out, corner hysteresis, per-frame cost, clamping at the photo edge), keep the API documented at the top of ui/magnifier.js stable or document the change, run npm test. Report the API summary (so the tool builders can use it without reading the body) and where the screenshots are.`,
  remove: `ASSIGNMENT "remove" — scratch ${SP}/outline/remove/, port 4602. You own: ui/tools/remove.js, lib/remove-plan.js (the 'outline' recipe case in recipeRecord/reviveRecipe plus any pure helper you need), and their tests. Build Remove › Outline per the CONTEXT and the integration note §1–§3, §5, §6: the Outline mode chip, tracing with the live wire and the corner magnifier (import { createMagnifier } from '../magnifier.js'), fill on lift through rubTile with a polygon mask, shimmer as a filled polygon path, 'Removed outline' label, Try another and Source, the area cap with CAP_TIP, cost-map build off the finger keyed on crop+remove, drop on close, claimsHold while Outline is on, drag-cancel → lasso.cancel(). Hint events 'outline-on' / 'outline-done'. Verify in the browser on real photos from ${FIX}: the fill lands inside the loop only, undo/redo pixel-exact (renderer.readRect before/after), a relaunch restores the fill and Try another still works, a crop after the fill doesn't move it, a tiny loop does nothing, a loop off the photo edge is clamped, per-move cost < 4 ms at 1024-px analysis (measure), magnifier flips corners. patchesForIntegrator must include lib/hints.js rows + HINTS, the SPEC F15 section + §4 rows, and the e2e state additions (shared with the light builder: use the ids in CONTEXT exactly so both apply together).`,
  light: `ASSIGNMENT "light" — scratch ${SP}/outline/light/, port 4603. You own: ui/tools/light.js and its tests, and the NEW renderer entry point renderer.paintMask(mode, mask, rect, amount) + maskProgram/MASK_FRAGMENT in ui/renderer.js (only that addition, next to paintDabs, without reordering or reformatting anything else, so the remove builder's diffs still apply; also expose renderer.paintScale()). Build Light › Outline per the CONTEXT and the integration note §1, §2, §4–§6: the Outline mode chip, tracing with the live wire and the corner magnifier, on lift one paint entry { kind: 'outline', mode, poly: polygonRecord(polyS), amount } in pools.strokes with its id in doc.paint, committed as one step; the Amount ruler (the RULERS entry in lib/ruler.js is NOT yours: give the integrator the diff) that live-recommits the entry; Erase inside outline. The editor's replayPaint (ui/editor.js, not yours) must dispatch on kind === 'outline' → polygonBounds/polygonMask at renderer.paintScale() with feather 6 → renderer.paintMask: give that diff to the integrator and test it on your scratch copy. Verify in the browser on real photos: the light stays inside the loop with a soft edge (measure luma inside vs a 30 px band outside), the Amount ruler live-updates and commits once, undo/redo pixel-exact, a relaunch restores it, a rub fill or crop after it doesn't move it, Save shows it in the JPEG, per-move cost < 4 ms. patchesForIntegrator: editor.js replayPaint dispatch, lib/ruler.js RULERS entry, lib/hints.js rows + HINTS (same ids as the remove builder), SPEC F15 (Light half) + §4 rows, e2e state 'Light › Outline'.`,
}

phase('Magnifier')
const mag = await agent(`${CONTEXT}\n\n${TASKS.magnifier}`, { label: 'verify:magnifier', phase: 'Magnifier', schema: REPORT })
log(`magnifier: ${mag?.filesOwnedAndWritten?.length ?? 0} files, tests ${mag?.testsPassing}`)

const results = await pipeline(
  ['remove', 'light'],
  (key) => agent(`${CONTEXT}\n\nMagnifier report: ${JSON.stringify(mag)}\n\n${TASKS[key]}`, { label: `build:${key}`, phase: 'Build', schema: REPORT }),
  (built, key) => agent(`${CONTEXT}\n\nYou are the ADVERSARIAL VERIFIER for this assignment, which another agent just finished:\n${TASKS[key]}\n\nIts report:\n${JSON.stringify(built)}\n\nYou now own its files (same scratch dir, port ${key === 'remove' ? 4612 : 4613}). Read them, then try to BREAK the feature in the real browser (iPhone emulation, CDP touch on Chromium; WebKit too if installed) and by reading the code: contract mismatches with SPEC.md and the integration note, coordinate-space mistakes (zoomed-in view, cropped/rotated/flipped doc, landscape), the gesture reducer (second finger during a trace, hold, slop, drag-cancel), undo/redo and Cancel exactness, autosave/restore of the new pool entries, Try another, the area cap, memory (cost map dropped on close, no per-frame work idle), the magnifier at edges and corners, iOS pitfalls (§6), the 2-second/1-minute/10-minute bar (is the chip findable, is the hint right, does it feel like tap/rub). Fix every real bug in the owned files, re-verify in the browser, run npm test, re-run acceptance checks 2,3,4,10,12,16 on the patched scratch copy. Patches needed elsewhere go in additionalPatchesForIntegrator as exact diffs (git apply --check; compatible with the builder's diffs). Be honest about what remains.`, { label: `verify:${key}`, phase: 'Verify', schema: VERDICT }).then((v) => ({ key, built, verified: v })),
)
return { magnifier: mag, tools: results.filter(Boolean) }
