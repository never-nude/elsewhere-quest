## [medium] a11ySw/sw-offline-version-mix — confirmed
**An offline start runs a mix of old and new modules after a deploy, and can fail to boot at all**
files: apps/gesso/sw.js, .github/workflows/deploy.yml (the Pages deploy step that copies apps/gesso)

patch: scratchpad/review/fixes/a11ySw--sw-offline-version-mix.patch

verified: Patched sw.js in fx-swmix, with deploys stamped gesso-aaa and gesso-bbb, re-run on the current base:
- Scenario 1: gesso-bbb holds 52 v2 entries and nothing else. The offline start runs v2 throughout, workers and lib/heal.js included.
- Scenario 2 (dropped panel.js): gesso-aaa keeps a complete v1 shell. The offline start boots v1 with v1 workers, and the next online launch runs v2.
- Without a stamp (sw.js identical across deploys), the offline shell stays one complete deploy (v1).
- I ran the workflow's three-line stamp step under bash on a dist copy: sw.js became const CACHE = 'gesso-a778892

notes: Re-rated from high to medium:
- Nothing is lost, and the app recovers after one complete online launch.
- The hard failure needs a request lost during the first launch after a deploy, or a deploy that changes an import or protocol used by a lazily loaded worker.
- The version mix itself happens on every deploy that does not bump CACHE, and nothing bumps it today.

I chose a smaller fix than the reporter's cache-first rewrite: keep network-first, never write responses into the shell, and stamp CA

## [medium] a11ySw/ruler-keyboard-text-size-stuck — confirmed
**Keyboard and VoiceOver adjustment of the ruler rounds to 0.1, so Text Size jumps to 125% and can never go back down**
files: apps/gesso/ui/ruler-view.js

patch: scratchpad/review/fixes/a11ySw--ruler-keyboard-text-size-stuck.patch

verified: kbd-ruler.mjs on fx-ruler:
- Text Size steps 0.076, 0.072, 0.068, 0.072, 0.076, 0.08 (95%, 90%, 85%, 90%, 95%, 100%).
- Brightness steps ±5, Straighten ±0.5°, Remove Size ±4 pt (40, 44, 40), Angle ±5°.
- npm test: 555/555.
- Acceptance: 17/17 on the combined copy.
- git apply --check passes.

notes: Rebased on f2ad749: stopAnim() runs before nudge reads value, so a key pressed during an Auto sweep steps from the value Auto chose. This diff touches the keydown block of ruler-view.js, and the slider-reset-presentational diff touches other hunks of the same file; they apply cleanly in sequence (checked).

## [medium] a11ySw/panel-rebuild-drops-focus — confirmed
**Tapping a dial, a state chip, Done or Cancel with keyboard or VoiceOver moves focus to <body>**
files: apps/gesso/ui/panel.js, apps/gesso/ui/editor.js

patch: scratchpad/review/fixes/a11ySw--panel-rebuild-drops-focus.patch

verified: focus.mjs on fx-focus:
- Focus stays on the Contrast dial, the Tint dial (Space) and the Square chip.
- Light Done goes to the Light dock button, and Crop Cancel goes to the Crop dock button.
- The edit bar's Done, from Tab or from the VoiceOver-style focus+click, goes to the Size dial.
- A touch tap on the bar's Done leaves focus where it was (BODY, :focus-visible false), so touch users get no new focus ring.
- npm test: 555/555.
- Acceptance: 17/17 on the combined copy.
- git apply --check passes.

notes: This also covers the edit bar's Done, which the reporter listed as evidence but did not fix. Every refocus happens only when focus was already on the affected button. iOS touch taps never focus buttons, so the touch UI is unchanged.

This diff, tips-not-announced and glyph-values-spoken all edit ui/panel.js in separate hunks. They apply in any order (checked by sequential git apply, and the result equals applying all the edits at once).

## [medium] a11ySw/tips-not-announced — confirmed
**Tool results and earned hints only change the hint line, which is not a live region, so VoiceOver never hears them**
files: apps/gesso/ui/panel.js, apps/gesso/index.html

patch: scratchpad/review/fixes/a11ySw--tips-not-announced.patch

verified: live.mjs on fx-tips recorded 'announce: No clear horizon. Drag the ruler.' and then the toast.
- npm test: 555/555.
- Acceptance: 17/17 on the combined copy (checks 2, 4 and 5 count no new control).
- git apply --check passes.

notes: It stays medium because, for a VoiceOver user, Crop › Auto's three outcomes (straightened, already level, nothing changed) are otherwise silent. The spoken effect in WebKit is reasoned: role=status with aria-live=polite is the same mechanism #toast already relies on. The diff is compatible with the other two panel.js diffs and with the fallback and choose diffs in index.html (checked).

## [medium] a11ySw/choose-photo-not-operable — confirmed
**'Choose a photo' is not a control: it has no button role, is not focusable, and the file input is aria-hidden with tabindex=-1**
files: apps/gesso/index.html, apps/gesso/styles.css

patch: scratchpad/review/fixes/a11ySw--choose-photo-not-operable.patch

verified: choose.mjs on fx-choose:
- The AX tree shows button 'Choose a photo'.
- Tab order is new-photo > LABEL#choose > install-hide > dock…
- Enter and Space on the label each open the file chooser (Playwright filechooser event), and a tap still opens it.
- After a photo is open, nothing named 'Choose a photo' is left in the AX tree, because .start is display:none.
- npm test: 555/555.
- Acceptance: 17/17, including 1, 2, 4, 5, 6 and 13.
- git apply --check passes.

notes: I did not use the reporter's fix (removing tabindex and aria-hidden from #file): it causes a regression. choosealt.mjs shows the 1px input stays in the tab order while editing (Tab after the dock lands on INPUT#file). Space there opens the picker with no 'Start a new photo? This edit isn't in Photos yet' prompt, so unsaved edits can be replaced.

My fix uses the visible label as the button. It vanishes with the start screen, and VoiceOver's press on a role=button label goes through HTMLLabelElem

## [medium] a11ySw/save-offscreen-page-zoom — confirmed
**At 140% Safari page zoom or more, Save is pushed off the right edge of the screen**
files: apps/gesso/styles.css

patch: scratchpad/review/fixes/a11ySw--save-offscreen-page-zoom.patch

verified: zoomfit.mjs on fx-savefit:
- 440, 383 and 352 are pixel-identical to the original (Save 328-432 at 104 px when 440 wide).
- 314: Save 226-306. 293: Save 211-285, all words whole (zoom-fix-293.png). 251: 181-243. 220: 158-212, with the words ellipsized and the Save icon kept (zoom-fix-220.png).
- scrollWidth equals clientWidth at every width.
- npm test: 555/555.
- Acceptance: 17/17. Checks 1 and 3 still pass at 402x874, 430x932, 440x956 and both landscape sizes.
- git apply --check passes.

notes: The finding said 'off the right edge from 140%'. At 140-150% Save is only partly clipped and still tappable; it becomes unreachable from Safari's 175% step up. This applies only in a Safari tab, since a Home Screen app has no aA menu (reasoned). It is medium because Save is the only exit at a zoom WCAG 1.4.4 expects to work.

This diff, contrast and reset all edit styles.css in separate hunks and apply cleanly in sequence (checked).

## [medium] perf/unreachable-tiles-leak — confirmed
**Remove tiles that no history entry can reach are never freed, in memory or in IndexedDB, until the next photo**
files: apps/gesso/ui/editor.js, apps/gesso/ui/autosave.js, apps/gesso/ui/tools/remove.js

patch: (none given)

verified: No diff needed: the current tree (94e00c4, which includes f2ad749) already has an equivalent fix. Verified in the browser with v1-tiles.mjs on http://127.0.0.1:4174/gesso/: 0 tiles / 0 MB and 0 tile blobs after each Cancel and after the redo branch is replaced. npm test on the current tree: 557/557.

notes: ALREADY FIXED in the current tree. The reviewer's claim was correct and reproduced on 5930a5c. Severity re-rated high to medium: the leak grows only through repeated Cancel or overwrite cycles, by about 9 MB per round in my 12 MP test and up to about 80 MB per round at the 24.5 MP / 20% cap, and autosave recovers after a jetsam kill. Small remaining gaps in the landed fix, not worth a separate finding: pools.strokes of cancelled strokes are not dropped (a few KB, and draftRecord trims them on sa

## [medium] perf/tape-scrub-hidden-panel-work — confirmed
**Every rewind-tape frame rebuilds the hidden panel: Home re-reads the photo for its suggestion (and re-runs horizon detection), Color re-renders all six look thumbnails**
files: apps/gesso/ui/editor.js, apps/gesso/ui/tape.js, apps/gesso/ui/tools/home.js, apps/gesso/ui/tools/color.js

patch: scratchpad/review/fixes/perf--tape-scrub-hidden-panel-work.patch

verified: Ran git apply --check from /home/user/elsewhere-quest against the current tree (94e00c4): OK, both on its own and in the series 3,4,5,6 in a scratch git copy, whose result is byte-identical to the patched app. On the patched copy (scratch server :4558): Home had 1 panel() call (15 ms, on landing) and 1 readOutput instead of 24, and per-jump time dropped from tens to hundreds of ms to under 1.2 ms except at jumps that reconcile fills. Color had 0 readOutput during the scrub with fixes 3+4, and 6 at landing with fix 3 alone. v3b-land.mjs, landing 3 steps back on fix3-only, all-fixes and tree: th

notes: Only the panel is skipped. The Undo/Redo disabled state still updates on every jump, and tool.onHistory still runs. close() only refreshes if the tape was actually up. The reviewer's extra idea (detect tilt from pristine once per photo) is left out on purpose: it changes behaviour, and the tree has since keyed photoTilt on the full remove list. Shares ui/editor.js with fix 5 in separate hunks; checked to apply both ways and in series. Scripts: /tmp/claude-0/-home-user-elsewhere-quest/4ce67d9c-b4

## [medium] quality/paint-dodge-hard-clip — confirmed
**Paint Brighten (and Warmth/Tint) clip each channel hard with no shoulder, so a dodged face turns into a flat yellow-white blotch after 1-2 passes**
files: /home/user/elsewhere-quest/apps/gesso/lib/develop.js, /home/user/elsewhere-quest/apps/gesso/ui/renderer.js

patch: scratchpad/review/fixes/quality--paint-dodge-hard-clip.patch

verified: I applied the diff to a git copy at quality-verify/work, served it on 127.0.0.1:4557, and reran t-dodge.mjs.

Left cheek after 1 / 2 / 3 strokes: (228,193,162) / (240,217,190) / (244,226,204). R>=254 on 0% / 0% / 0% of the cheek (nose 0 / 3 / 4%), and the stroke band is 0 / 1 / 2% clipped. Skin texture is kept (out/dodge-compare.png, bottom row).

Maths:
- Skin at +1.5 EV gives (251,239,226).
- Warmth +60 greys 0.9-0.96 are graded (239 / 244 / 249) instead of clipping at 255.
- Neutral stays an exact identity.

Monotonicity sweep (js/mono.mjs): every slider extreme plus combinations, × look no

notes: This is the same diff as highlights-plus-greys-whites; apply it once (file: quality-verify/fixA-shoulder.diff).

It removes `rolloff` / `uRolloff` (uniforms(), GLSL, UNIFORM_NAMES, bindDevelop, IDENTITY). `shoulder` keeps its name and export but gains a `gain` argument, so two lines of develop.test.mjs are updated to match.

The Whites push is no longer softened by a shoulder. Whites is not reachable from the UI, and it moves the white point, so clipping there is expected.

Apply order with the 

## [medium] quality/local-tone-halos — confirmed
**Shadows/Highlights use a plain 512-px blurred luminance, so backlit subjects get a dark rim and bright skies get a glow (halos), including at Auto's Shadows +45**
files: /home/user/elsewhere-quest/apps/gesso/ui/renderer.js, /home/user/elsewhere-quest/apps/gesso/lib/develop.js

patch: scratchpad/review/fixes/quality--local-tone-halos.patch

verified: Patched copy on port 4557, same scripts:
- Shadows +100 lift: ×2.63 at 1 px, ×2.76 at 8 px, ×2.83 at 15 px, ×3.01 in the interior.
- Shadows +45: ×1.55 at the edge vs ×1.64.
- Highlights −100 sky: 185 at 1 px vs 181 far.
The halos are gone (out/halo-compare.png, bottom row).

Real photos (js/t-real.mjs, js/real_stats.py):
- Motorcycle: the tyre glow is gone (out/real-moto-compare.png, right panel) and the overall character is unchanged; mean luma 121.7 → 121.3.
- Preview/export parity is no worse: stage vs box-downscaled export MAE 3.93 → 3.11 on the motorcycle, 0.86 → 0.77 on coffee-12mp.

np

notes: File: quality-verify/fixB-halo.diff.

Monotonicity: with a ∈ [0,1] and b ≥ 0 (both survive the RG8 quantisation and bilinear filtering), a·x ≤ L. So the existing guarantee proven for L = own luma carries over. The JS developPixel takes L directly and no app code passes `blur` to developImage, so the JS side needs no change.

Trade-off: in strongly textured shadows, local contrast drops slightly. Dark-area high-pass std on the motorcycle at S+100/H−100 goes 22.5 → 19.5, because a > 0 in high-vari

## [medium] quality/film-cool-ashy-dark-skin — confirmed
**Film and Cool looks turn the deepest skin tones teal/grey: their shadow split-tone flips Monk 9-10 skin hue by 90-190°**
files: /home/user/elsewhere-quest/apps/gesso/lib/develop.js

patch: scratchpad/review/fixes/quality--film-cool-ashy-dark-skin.patch

verified: Maths on the patched copy:
- Film: MST 9 → 27/4.1/68° rgb(69,63,58); MST 10 → 22/1.3/78° rgb(54,52,51); MST 8 keeps 72% of its chroma.
- Cool: MST 9 → 21/4.5/67°; MST 10 → 77°.
- MST 1-5 and neutral or cool shadows are unchanged, because the guard is 0 when r ≤ b.
- The Warm look is untouched: its shadow tint is not cool, so the guard does not apply.

Real app on port 4557, deep9 cheek: Film (72,63,57), Cool (59,49,42). Both still read as brown (out/skin-compare.png, bottom row).

The new test fails on the current code and passes with the fix. npm test in the patched copy: 540/540. git apply -

notes: File: quality-verify/fixD-skin.diff.

Warmth is judged on the input colour (c in GLSL, r/b in JS), so a look's own Warmth −15 (Cool) does not switch the guard off.

The guard applies only to cool shadow tints (b > r). Its denominator floor of 0.1 keeps near-black chroma noise from fully disabling the teal in deep blacks; a warm-black suit still gets a little.

Teal shadows are in the SPEC's Film/Cool recipe, so this is a look-design defect rather than a coding slip. It is still a real, visible r

## [medium] quality/transparent-png-hard-edges — confirmed
**PNGs with transparency get a hard, colour-fringed edge on black: the strip upload un-premultiplies, and the develop pass ignores alpha**
files: /home/user/elsewhere-quest/apps/gesso/ui/renderer.js

patch: scratchpad/review/fixes/quality--transparent-png-hard-edges.patch

verified: Patched copy on port 4557. Export vs a correct white flatten:
- MAE 0.2 in the feather band, 0.0 in the transparent area, 0.0 in the opaque area.
- Row 400 now ramps smoothly: alpha 32 → (252,238,234), alpha 6 → (255,252,251).
See out/alpha-fixE-side.png.

Opaque photos are bit-identical: an opaque drawImage over the fill replaces it, and opaque-area MAE is 0.0.

npm test in the patched copy: 539/539. Combined copy: e2e acceptance 17/17. git apply --check from /home/user/elsewhere-quest: OK.

notes: File: quality-verify/fixE-alpha.diff.

The matte colour is a judgement call. White suits artwork and line art, keeps dark ink on a transparent background legible, and matches 'gesso'. Black would match today's look for the transparent area, but would hide dark line art. Either colour fixes the actual bug, the un-premultiplied hard edge.

Residual, not fixed: Auto still reacts to the matte. With white it now proposes Highlights −40 / Contrast +28 for a 70%-transparent image, where before it propo

## [medium] quality/auto-backlit-darkens-subject — confirmed
**Auto-enhance makes backlit photos worse: a bright-sky median gives Brightness −35, and the Shadows rule is gated off unless shadows are near-black**
files: /home/user/elsewhere-quest/apps/gesso/lib/autofix.js

patch: scratchpad/review/fixes/quality--auto-backlit-darkens-subject.patch

verified: Patched copy on port 4557:
- Silhouette → Shadows +24, no Brightness; subject 33.3 → 38.4, sky 216.7 → 216.5.
- bl3 → Shadows +45, Brightness −26; face 65.8 → 69.1, subject square 40.9 → 41.6.
- bl2 is unchanged from today: its 'dark' pixels are mostly crushed suit.

Regression sweep (js/cmp-auto.mjs): real analyze() stats of 16 images (astronaut, chelsea, coffee, motorcycle, rocket × orig/+1.3 EV/−1.5 EV, plus a snow-and-trees scene) through the old and new autoLight. Only two changed:
- astronaut over: Brightness −34 → −32.
- snow and trees: −35 → −25.

The new backlit test fails on the curr

notes: File: quality-verify/fixF-auto.diff.

This differs from the reviewer's proposal in two ways:
- The backlit share is dark − clipLow. Crushed pixels are not darkened by the midtone gamma, so they shouldn't block Brightness −; this keeps an overexposed photo with a black object (astronaut +1.3 EV) almost unchanged at −32, where the raw dark share would give 0.
- The fade is applied to the −35 floor, not to the raw value. Scaling the raw value still hit the clamp, so bl2 stayed at −35.

Evidence is 

## [low] a11ySw/sw-open-page-gets-new-workers — confirmed
**A page left open across a deploy loads the new version's workers into the old page**
files: apps/gesso/sw.js, apps/gesso/app.js

patch: scratchpad/review/fixes/a11ySw--sw-open-page-gets-new-workers.patch

verified: Patched sw.js in fx-swopen, with stamped deploys, on the current base:
- Open-page scenario: the new worker waits (registration shows waiting: installed). The open v1 page gets export-worker, heal-worker and lib/heal.js all at v1. The next launch runs v2 throughout.
- Scenario 2 (dropped panel.js): v1 boots online, offline and on the next launch, and v2 arrives once a clean install has happened.
- Scenario 1: the offline start runs v2 throughout.
- npm test: 555/555.
- Acceptance: 17/17 on the combined copy with every UI fix plus this diff. Check 14 passes; its probe fetch now reads 'failed' b

notes: This is real version skew, but it does no harm until a deploy changes the worker message protocol or lib/heal.js's exports while a page stays open. A website with no service worker would load the new worker scripts the same way, so I rate it low.

This diff is a superset of the sw-offline-version-mix diff (the same deploy.yml stamp and the same sw.js lines). Apply this one instead of that one if you accept the trade-offs:
- An update applies one launch later: after all Gesso pages close. A reloa

## [low] a11ySw/fallback-outside-modal — confirmed
**The touch-and-hold fallback sits outside the aria-modal Save sheet, and the sheet does not contain keyboard focus**
files: apps/gesso/index.html, apps/gesso/ui/savesheet.js

patch: scratchpad/review/fixes/a11ySw--fallback-outside-modal.patch

verified: On fx-fallback:
- With the sheet open, Tab cycles share > sheet-keep > BODY > share… and never reaches the chrome.
- With the fallback open, Tab cycles fallback-close > BODY > fallback-close.
- Close hands focus back to the card and clears card.inert. Keep editing returns focus to #save. The editor works afterwards (opening Light succeeded), and #app.inert is never touched.
- npm test: 555/555.
- Acceptance: 17/17, including check 9 (Save fallback) and check 8 (share in the click).
- git apply --check passes.

notes: I deliberately did not set #app.inert, as the reporter proposed. Batch 2 (f2ad749) now makes #app inert while a lost WebGL context recovers, so that Save cannot export black. If closing the sheet cleared #app.inert, closing it during 'Recovering…' would re-enable Save early. Making #app's children inert keeps the two mechanisms independent.

inert needs Safari 15.5 or later. The fallback appears only when share is missing or fails with something other than AbortError, which is why this is low.

## [low] a11ySw/contrast-start-and-tape — confirmed
**Text below WCAG AA contrast: 'Your photo goes here', the dimmed but usable start-screen dock, and the rewind tape's later steps**
files: apps/gesso/styles.css, apps/gesso/ui/tape.css

patch: scratchpad/review/fixes/a11ySw--contrast-start-and-tape.patch

verified: contrast-px.mjs on fx-contrast measures 6.80:1, 7.12:1 for the dock labels and 7.12:1 for the tape's is-ahead labels. Screenshots start-fix.png and tape-fix.png: the ahead steps are outlined rather than faded, and the start-state action row keeps the panel colour so it matches the dock.
- npm test: 555/555.
- Acceptance: 17/17.
- git apply --check passes.

notes: I dim .action rather than .actions. Otherwise the whole action row's background darkens while the dock's no longer does, which shows as a band. SPEC §3's 'action row and dock are visible and dimmed to 35%' needs rewording to 'dock icons and actions dimmed'.

## [low] a11ySw/slider-reset-presentational — confirmed
**The ruler's Reset button sits inside role=slider, whose children are presentational, so VoiceOver cannot reach it**
files: apps/gesso/ui/ruler-view.js

patch: scratchpad/review/fixes/a11ySw--slider-reset-presentational.patch

verified: reset2.mjs on fx-reset:
- Reset is no longer a child of the slider in the AX tree or the DOM, and its rect is unchanged (373-426 x 797-833).
- A touch tap on Reset still resets (Brightness 0).
- A drag that starts on Reset still slides the ruler: +15 becomes −6, the same result as the original, run twice.
- Enter on Reset (keyboard or VoiceOver path, click with detail 0) resets.
- One .ruler and one .ruler__reset remain after switching dials and tools.
- npm test: 555/555.
- Acceptance: 17/17 (check 4 still reads role=slider and aria-valuetext on .ruler).
- git apply --check passes.

notes: This is rebased on f2ad749. That commit removed Reset's dead zone by letting a touch that lands on Reset start a ruler drag (pointerdown on the ruler checks reset.contains(e.target)), with click handling only keyboard and VoiceOver. Moving Reset out of the slider therefore needs two more things:
- The pointerdown listener moves to the wrapper, while capture stays on the ruler.
- touch-action:none goes on the wrapper. Without it, a horizontal drag that starts on Reset is taken by the browser as a

## [low] a11ySw/glyph-values-spoken — confirmed
**Dial chips announce their decorative glyphs, for example 'Delete ×', 'Pick white ◎', 'Add +', 'Paint –'**
files: apps/gesso/ui/panel.js

patch: scratchpad/review/fixes/a11ySw--glyph-values-spoken.patch

verified: glyph.mjs on fx-glyph:
- Names become 'Flip', 'Tall/Wide', 'Paint', 'Pick white', 'Add', 'Delete'.
- Home's Auto-enhance change chips keep their amounts ('Brightness +19', 'Shadows +16'), and 'Rotate ⟲ 90°' keeps its number.
- npm test: 555/555.
- Acceptance: 17/17. Check 4 reads innerText, which is unchanged.
- git apply --check passes.

notes: I did not use the reporter's condition (d.kind === 'action' || …) because it is wrong. Home's change chips and Crop's Tall/Wide are kind 'action', so it would hide '+19' and 'Tall'/'Wide' from VoiceOver, which is real information. Hiding only values that have no letter or digit keeps those.

## [low] perf/paint-cancel-repastes-fills — confirmed
**A second finger during a Paint stroke (pinch to zoom) re-uploads every Remove fill and regenerates the full-size mipmaps once per fill**
files: apps/gesso/ui/tools/light.js, apps/gesso/ui/editor.js

patch: (none given)

verified: No diff needed: the current tree already contains the equivalent fix (editor ed.replayPaint() plus light.js drag-cancel calling it, committed in 94e00c4). Verified with v2-pinch.mjs on :4174: replayPaint 0 ms, GL counts during the pinch start were 0 generateMipmap, 0 texSubImage2D, and 1 readPixels (the zoom navigator thumbnail). The render sum after the cancel equals a full resync (6958725 = 6958725).

notes: ALREADY FIXED in the current tree (94e00c4); it reproduced on f2ad749. Severity re-rated medium to low: the path only runs when one finger has already moved more than 8 pt as a paint drag before the second lands (a normal pinch lands both fingers inside the slop and never takes it), and on a device the cost is about one tile readback, merge, upload and full mip rebuild per fill. That is reasoned, not measured: tens of ms with a handful of spot fills, more with large rubs. Fix 5 below works with 

## [low] perf/color-thumbs-rerender — confirmed
**Color re-renders all six look thumbnails (6 GPU readbacks) after every commit, including look taps and Strength changes that cannot change them**
files: apps/gesso/ui/tools/color.js

patch: scratchpad/review/fixes/perf--color-thumbs-rerender.patch

verified: git apply --check against the current tree: OK, alone and in the series. v4-looks.mjs on fix4-only and on all fixes: look taps 0 readbacks (was 36), Strength drags 0 (was 30), Warmth drags 18 (unchanged, as it should be). After the Warmth drags the per-chip mean RGB strings are identical to the current tree's on-screen and fresh-render values ('132x68:158.09,85.97,52.83', ... '107.02'). Also checked at 956x440 landscape (118x78 chips): 0/0/18. npm test 557/557; acceptance 17/17 on the combined copy.

notes: Cache entries are kept per look, keyed by identity on the immutable state branches the thumbnail actually depends on (photo id, crop, light, paint, remove, warmth/tint/vividness) plus the chip's device-pixel size, so a crop, Undo, fill or paint change still re-renders. A rebuilt Quick row (look tap) is re-blitted from the cache. GPU-side inputs that are not in the state (the blur map rebuilt 60 ms after a fill change) are exactly as stale as before; this is not a regression. The reviewer's furth

## [low] perf/paint-replay-and-points — confirmed
**Paint light: every stroke commit replays all strokes, each finger sample recomputes the whole stroke's dabs, and raw samples are kept and rewritten to IndexedDB on every step**
files: apps/gesso/ui/tools/light.js, apps/gesso/ui/editor.js, apps/gesso/lib/stroke.js, apps/gesso/ui/autosave.js

patch: scratchpad/review/fixes/perf--paint-replay-and-points.patch

verified: git apply --check against the current tree: OK, alone and in the series. v5-paint.mjs on fix5-only and on all fixes: a stroke commit now draws 417 dabs (the live ones only) instead of 834, 1251, 1668, 2085, with 0 extra clears. Undo and Redo still replay, as they must. The live mask without replay renders identically to a full resync after every stroke. v5b-mask-exact.mjs compares hashes of a full-resolution (4032x2688) toned readOutput of the live mask against a full replay: IDENTICAL for brighten, darken over it, erase over both, and a stroke with an Undo clicked midway (that replay clears m

notes: The fix covers only (b), the measurable redundant full replay on every stroke commit, which grows with the total number of dabs. (a) is negligible per my bench, and (c) is a format change, so neither is included. Skipping the replay is exact: live painting and replay draw the same dabs() in the same order with the same blend state, and RG8 blending is per fragment in primitive order, so batching does not change the result (shown bit-identical above). maskStroke only matches a step whose paint li

## [low] perf/fill-reconcile-cost — confirmed
**Undo, Redo and tape jumps over Remove fills read back and CPU-merge each tile, rebuild mipmaps for the whole base texture per tile, and delete and re-create the 130 MB base when crossing zero fills**
files: apps/gesso/ui/renderer.js, apps/gesso/ui/editor.js

patch: scratchpad/review/fixes/perf--fill-reconcile-cost.patch

verified: git apply --check against the current tree: OK, alone and in the series. v6-reconcile.mjs on fix6-only and on all fixes: every operation now does at most 1 mip rebuild. Jump 0 to 6 went from 7 mips / 912 ms to 1 / 224-243 ms; jump 6 to 2 from 4 / 472 ms to 1 / 198-221 ms; overlapping Undo from 2 to 1; resync from 2 to 1. Base level 0 stays bit-identical to a from-scratch rebuild after all 16 steps. v6b-mips.mjs compares minified renders, which sample the mip chain (readOutput at 512 and 97 px), plus exact tile readbacks after 3 fills, Undo, jump 0 and jump end: hashes are identical between the

notes: This is a renderer-only change: the chain is rebuilt lazily in bindDevelop, the single place base is sampled with mip filtering (stage draw including the tree's new loupe pass, renderPixels/export, readSource for analysis and Remove's search). readRect reads level 0 through an FBO, so it never needs mips. Not addressed, and kept low: the per-tile sync readback + JS merge + re-upload (a GPU paste shader is a larger change; it matters only for large rub tiles, on a device an estimated 20-50 ms per

## [low] quality/grain-preview-export-mismatch — confirmed
**Film grain is per output pixel: the fitted preview (and the Save-sheet preview) shows it at full strength, but the saved photo at the same viewing size shows about a fifth of it**
files: /home/user/elsewhere-quest/apps/gesso/lib/develop.js, /home/user/elsewhere-quest/apps/gesso/ui/editor.js, /home/user/elsewhere-quest/apps/gesso/ui/renderer.js

patch: scratchpad/review/fixes/quality--grain-preview-export-mismatch.patch

verified: Patched copy on port 4557:
- Stage preview 0.91 vs export at preview size 0.94.
- Sheet readOutput 0.78 vs export at sheet size 0.79.
- The full-resolution export is unchanged (2.76).
- Zoomed to 1:1 device px (js/t-grainzoom.mjs), the preview keeps full grain: 2.8, same as before the fix.

npm test in the patched copy: 539/539. Combined copy: e2e acceptance 17/17. git apply --check from /home/user/elsewhere-quest: OK.

notes: File: quality-verify/fixC-grain.diff.

This is a smaller fix than the reviewer proposed. It prefilters the per-output-pixel white-noise grain by the render's footprint: std/k when one target pixel covers k×k output pixels, which is exactly what box-downsampling the export gives. It does not redesign the grain onto a ~1500-cell value-noise grid. Making Film's grain coarser so it survives downsampling is a design choice, not this bug. The export is untouched, and look thumbnails, the navigator and

## [low] quality/highlights-plus-greys-whites — confirmed
**Highlights + and Shadows + dim the brightest pixels: the global roll-off compresses whites that nothing pushed**
files: /home/user/elsewhere-quest/lib/develop.js, /home/user/elsewhere-quest/apps/gesso/lib/develop.js

patch: scratchpad/review/fixes/quality--highlights-plus-greys-whites.patch

verified: Patched copy on port 4557, same three photos × H+100 / S+100 / S+45: 0.00% of pixels darker by more than 2 levels, and the image max is 255 in all nine cases.

Maths:
- A white pixel at Highlights +100 stays 255 for every neighbourhood L.
- Shadows +100 / +45 white sky → 255.
- 0.9 grey at H+100 with L=0.02 → 230 (identity; it was 224).

The monotonicity sweep gives 0 inversions over 2976 cases. npm test in the patched copy: 539/539. git apply --check from /home/user/elsewhere-quest: OK.

notes: This is the same diff as paint-dodge-hard-clip (quality-verify/fixA-shoulder.diff); apply it once.

The finding's 'files' entry /home/user/elsewhere-quest/lib/develop.js does not exist. The code is in apps/gesso/lib/develop.js.

The rating stays low: it costs at most about 19 levels on a small share of the brightest pixels, mostly at extreme dial values. At Auto's Shadows +45 it is about 5 levels.

See paint-dodge-hard-clip for the apply order with B and C (`git apply -C1` after A).

## [low] quality/paint-dab-square-edge — confirmed
**Paint dabs are Gaussians cut off by a square quad, leaving a hard rectangular border step around every Brighten/Darken stroke**
files: /home/user/elsewhere-quest/apps/gesso/ui/renderer.js

patch: scratchpad/review/fixes/quality--paint-dab-square-edge.patch

verified: Patched copy on port 4557, same stroke. The profile is 118.00 out to −113 px, then rises smoothly: 118.03 / 118.14 / 118.22 / 118.29 / 118.38. There is no step, the ends are rounded (out/dab-compare.png, bottom), and the start of the stroke ramps without a jump.

The stroke centre is 147.05 vs 148.79 before, about 6% less lift per pass.

npm test in the patched copy: 539/539. Combined copy: e2e acceptance 17/17. git apply --check from /home/user/elsewhere-quest: OK.

notes: File: quality-verify/fixG-dab.diff.

The erase mode uses the same w as its alpha, so its edges soften the same way. If the per-pass strength matters, DAB_AMOUNT could go from 0.12 to about 0.127; I left it alone to keep the fix minimal.

This hunk is clear of every other diff.
