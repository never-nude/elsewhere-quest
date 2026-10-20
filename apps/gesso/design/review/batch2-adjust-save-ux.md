## [high] adjust/stale-tilt-and-suggestion-across-photos — confirmed
**Crop Auto and the home 'Looks tilted' line reuse the previous photo's tilt (the cache key is the pixel size, and revision restarts at 0 for each photo)**
files: apps/gesso/ui/tools/home.js

patch: scratchpad/review/fixes/adjust--stale-tilt-and-suggestion-across-photos.patch

verified: Patched copy served on 127.0.0.1:4552. v1-tilt.mjs gives: A 'Looks tilted 3.9°' and Auto 3.9; B 'Looks tilted 5.9°' and Auto -5.9; C empty line and 'Already level' (angle 0). v1b-rev.mjs gives '', 'Looks tilted 5.9°', 'Looks tilted 3.9°'. npm test 539/539 in the patched copy. Acceptance 17/17 against the patched copy. git apply --check passes from /home/user/elsewhere-quest.

notes: Severity stays high: every photo from one iPhone has the same working size, so the second photo's one-tap straighten uses the first photo's angle. Doc ids are `d${Date.now().toString(36)}` and unique per import; revision only increases within a doc. Using remove ids instead of remove.length also catches undo-then-fill at the same count. This touches home.js next to finding 5's hunk. Both diffs use 1 line of context and apply alone or together in either order (checked).

## [high] adjust/crop-corner-frozen-on-photo-edge — confirmed
**A free-aspect crop corner stops responding when one of its edges is on the photo's edge and the drag has any outward component on that axis**
files: apps/gesso/lib/geometry.js

patch: scratchpad/review/fixes/adjust--crop-corner-frozen-on-photo-edge.patch

verified: Node with the patched geometry: corner.mjs gives NW (-1,-600) top -600; NE (600,-1) and (600,-12) width 3288. fuzz2.mjs: frozen 0 (was 17,631), never further from the finger than the old code, every result fits with MIN_CROP, no per-step jumps over 200px. UI v2-corner.mjs on the patched server: full frame NE (-80,-4)pt gives width 3192 and +1 step; Square, Free, NE (80,-4)pt gives width 3360 and +1 step. npm test 539/539 (includes the geometry and doc fuzz tests). Acceptance 17/17. git apply --check passes.

notes: Kept high, and it is worse than reported: the opening full-photo frame has every corner on the photo edge, so any corner drag whose net drift is outward on one axis does nothing. This is essentially the reporter's fix, with an L1 miss measure. A locked aspect still uses the proportional bisect. Same file as finding 3, but separate hunks: they apply independently and together in either order (checked).

## [high] savePersist/ctxloss-black-jpeg — confirmed
**Saving while the app shows "Recovering…" after a WebGL context loss writes a black (or half-black) JPEG to Photos, and the bad JPEG stays cached for later saves**
files: ui/renderer.js, ui/exporter.js, ui/savesheet.js, app.js

patch: scratchpad/review/fixes/savePersist--ctxloss-black-jpeg.patch

verified: Patched copy served on 127.0.0.1:4554, script v-ctxloss-fixed.mjs:
- (a) Save tapped in the gap: #app.inert is true and the sheet does not open.
- (b) In the gap, ed.readOutput throws and exportJpeg rejects with ExportError 'gpu'.
- (c) The export started after recovery shares a 4032x2688, 1.2 MB JPEG with 0 black rows.
- (d) A fresh Save after recovery shares a JPEG with 0 black rows.

npm test in the patched copy: 539/539. Full acceptance run on the copy with all seven fixes: 16 PASS, 1 FAIL. The failure was check 7's Remove timing (1068 ms against a 1000 ms budget at load ~8 on 4 cores). Ch

notes: My fix is smaller than the proposed epoch scheme and leaves exporter.js and savesheet.js unchanged. The only window in which renderPixels can produce garbage is pristine===null while lost===false, because onRestored runs loadSource and resync synchronously. With the `!pristine` guard, a black export can never complete, so a black job can never be cached. A loss in the middle of an export already fails through `lost`/bandRendered: in v-ctxloss-straddle.mjs both builds reject.

The inert flag also

## [high] ux/stale-tilt-and-suggestion-across-photos — confirmed
**A new photo reuses the previous photo's horizon tilt and suggestion line: Crop › Auto straightens a level photo by the old photo's angle**
files: apps/gesso/ui/tools/home.js, apps/gesso/ui/tools/crop.js

patch: scratchpad/review/fixes/ux--stale-tilt-and-suggestion-across-photos.patch

verified: Patch file: .../review/ux-verify/patches/stale-tilt-and-suggestion-across-photos.diff. All 13 diffs were applied to a fresh copy at .../review/ux-verify/combined/apps/gesso and served on 127.0.0.1:4556. Re-ran f1-tilt.mjs there. Sequence tilt4 then level now gives level 'Looks flat…' and 'Already level', with history [Original]. Sequence level then tilt4 gives tilt4 'Looks tilted 4.0°' and 'Straightened 4.0°'. Sequence dark then coffee gives coffee an empty line. npm test in that copy: 555/555. git apply --check from /home/user/elsewhere-quest: OK.

notes: Kept at high. Crop › Auto is a one-tap step of the 1-minute 'brighten, straighten, save' task, and it tilts a level photo whenever two photos of the same working size are opened in one session. That covers every 12 MP iPhone photo, and 48 MP photos too, since they are downscaled to the same working size. The result is visible and can be undone, but it is wrong output in ordinary use. Crop imports orientedTilt from home.js, so this one diff fixes both places. The diff is the same as the reviewer'

## [medium] adjust/crop-frame-move-jumps-after-straighten — confirmed
**Moving the crop frame on a straightened photo makes it snap back on one axis while the finger keeps going**
files: apps/gesso/lib/geometry.js

patch: scratchpad/review/fixes/adjust--crop-frame-move-jumps-after-straighten.patch

verified: wedge.mjs with the patched geometry slides smoothly to (-996,-809) and stays there, with no snap back. fuzz.mjs: 0 jumps over 200px (largest per-step move 37.6px for about 30px finger steps), 0 results that fail rectFits, and never further from the finger (4 of 203,663 samples are 1.3e-6px 'worse', which is float slack). UI v3-move.mjs on the patched server: the frame reaches the corner at (-54.6,-44.7)pt, largest per-step move 8.5pt, no jumps. npm test 539/539, including 'moveRect slides along edges'. Acceptance 17/17. git apply --check passes.

notes: Medium stands. I did not use the reporter's candidate-picking fix (they report it still leaves 4 jumps up to 477px). My fix is exact: each corner constraint in rectFits is a slab along the photo's own axes u=(cos,sin) and v=(-sin,cos), so the translations that fit form a rectangle in (u,v). Clamping in that rectangle is the Euclidean nearest fit and is 1-Lipschitz, so it can never jump. At angle 0 it equals the old per-axis slide. Same file as finding 2, separate hunks, compatible (checked).

## [medium] adjust/pick-white-loupe-under-finger — confirmed
**Pick white has no loupe: it draws a 28pt ring under the fingertip, so the spot being sampled is hidden**
files: apps/gesso/ui/tools/color.js, apps/gesso/ui/editor.js

patch: scratchpad/review/fixes/adjust--pick-white-loupe-under-finger.patch

verified: v4-loupe.mjs on the patched server: 63,699 painted pixels above-left of the finger, and v4-patched-hold.png shows a 96pt circle magnifying the spoon under the finger 2×, with a crosshair. The pick result is unchanged (warmth -100, tint -46, 'Picked white'), identical to the original. v4b-edge.mjs: at 440x956 and at 956x440 (landscape), on a photo that has been rotated and flipped, the loupe follows the output orientation. Near the stage's top-left it moves to the right of and below the finger (v4b-landscape-top-left.png). npm test 539/539. Acceptance 17/17. git apply --check passes.

notes: Medium stands: SPEC F8 behaviour is missing and the sampled spot is hidden under the finger. readOutput's default (rect=null) path is mathematically unchanged, and acceptance checks 7, 8 and 10, which use it, pass. The loupe shows the edited photo (tone: true) as the user sees it; the sample is still the 9×9 source patch, as before. On SwiftShader each hold-move renders 288x288; on an iPhone GPU this is cheap, but I did not measure it on a device. Same file (color.js) as findings 6, 7 and 8, in 

## [medium] adjust/home-change-chips-stale — confirmed
**Auto-enhance change chips stay on Home after the step is undone inside a tool (or replaced by an edit of the same history length)**
files: apps/gesso/ui/tools/home.js

patch: scratchpad/review/fixes/adjust--home-change-chips-stale.patch

verified: v5-misc.mjs part 5 on the patched server: Light, Undo, Done gives chips []. Light, Redo, Done brings back ['Brightness+19','Shadows+16'], which is again true. Color, Film, Cancel keeps the chips. Light, Undo, Darker, Done gives []. Acceptance 17/17, including check 2's 'Home after Auto-enhance with its change chips' and check 7's chip list. npm test 539/539. git apply --check passes.

notes: Medium stands. Chips are shown only while the committed state is the exact object Auto-enhance produced. Cancel and revertToMark return that same object; any edit or undo changes it. home.onHistory is left unchanged. This touches home.js beside finding 1; both diffs use 1 line of context and apply alone or together in either order (checked).

## [medium] savePersist/restore-discards-on-transient-failure — confirmed
**One failed decode or GPU upload at launch permanently deletes the draft, including the original photo's only stored copy**
files: app.js, ui/autosave.js

patch: scratchpad/review/fixes/savePersist--restore-discards-on-transient-failure.patch

verified: Patched copy on :4554, v-restorefail.mjs, both modes: launch 1 shows the new hint and IndexedDB keeps source, doc and current. Launch 2 restores ['Original','Look: Film'].

v-restore-damaged.mjs: a draft whose original was deleted from IndexedDB is still discarded, with the old message, and IndexedDB is emptied.

npm test: 539/539.

notes: Re-rated from high to medium. The discard follows SPEC §5.6 step 5 exactly, and it needs a transient decode or GPU failure on a launch (a fresh process starts with its full memory budget), which is uncommon. When it does happen the loss is permanent, and it can include the only copy of a Take Photo original.

Correction to the report: decodeForEditing wraps every decode failure in ImportError, so importFile does NOT retry decode failures at 12 MP. Only loadSource errors are retried.

My fix touc

## [medium] savePersist/transparent-png-black — confirmed
**Transparent PNGs are flattened to black: dark line art disappears and drop shadows vanish, in the editor and in the saved JPEG**
files: ui/renderer.js

patch: scratchpad/review/fixes/savePersist--transparent-png-black.patch

verified: Patched copy on :4554:
- Line art: export mean luma 234.1, mean difference from the white reference 0.3.
- Drawing: mean difference 0.1, and the shadow band is 132.4, equal to the reference (alpha-fix-drawing-alpha-side.png).
- Opaque inputs are unchanged: the coffee.png and rocket.jpg exports are byte-identical (sha256) between the current and patched builds.

npm test: 539/539.

notes: Flattening onto white is a product choice. It matches how iOS shows transparent PNGs in light mode, and because it sits in the single upload path, preview, Before, Remove and export all use the same pixels. Medium rather than high: a transparent PNG is an uncommon input for a photo editor, though plausible for this artist owner.

Overlap: this hunk is disjoint from the ctxloss renderPixels hunk in the same file.

## [medium] savePersist/stepdown-on-lost-context — confirmed
**A photo picked while the GPU context is lost permanently halves the working and export resolution (24.5 MP → 12 MP) for every later photo**
files: app.js

patch: scratchpad/review/fixes/savePersist--stepdown-on-lost-context.patch

verified: Patched copy on :4554, v-stepdown.mjs: workCap stays null, and after the reload the 48 MP photo opens at 5715x4286 with the tip "Editing at 24.5 MP".

v-stepdown-real.mjs (the GPU upload reports OUT_OF_MEMORY):
- A genuine full-size failure followed by success at 12 MP still steps down to 4000x3000 and persists 12000000, in both builds.
- When both attempts fail, the current build persists 12000000 and the patched build leaves it null.

npm test: 539/539.

notes: The fix also closes the full-size ImageBitmap before rethrowing, so ~98 MB is not left waiting for GC.

Only loadSource errors reach this branch, because decode errors are always ImportError.

The message is still "This photo couldn't be opened." when the context is lost. With the ctxloss fix, #app is inert during recovery, so this path is reached only by a photo picker that was already open when the context dropped.

Overlap: this hunk is disjoint from the other app.js hunks.

## [medium] savePersist/typed-caption-lost-on-background — confirmed
**Words typed into a caption are not autosaved when the app goes to the background, so they are lost if iOS ends the app there**
files: ui/tools/text.js, app.js, ui/editor.js

patch: scratchpad/review/fixes/savePersist--typed-caption-lost-on-background.patch

verified: Patched copy on :4554, same sequence plus freeze: the stored labels are ['Original','Caption “Grandma at 90, Lisb…”'], and the relaunch restores the words.

v-caption-continue.mjs (patched): after the background trip the edit bar is still up.
- Typing more, then Done, adds exactly one more step.
- Done with no further typing adds no step.
- Cancel removes the caption.

npm test: 539/539.

notes: The fix keeps the edit bar and keyboard, so someone who left to copy a name can paste on return. The trade-off: a caption typed across a background trip can become two undo steps.

I named the editor method commitTyping; the proposal called it settleTyping.

Overlaps: the editor.js hunk (after newPhoto) is disjoint from the tiles fix's commit/closeTool hunks, and the app.js hunk is disjoint from the other app.js fixes.

## [medium] savePersist/dead-fill-tiles-retained — confirmed
**Remove fills that were undone and then replaced stay in memory (ed.tiles) and in IndexedDB for the rest of the session**
files: ui/editor.js, ui/autosave.js, ui/tools/remove.js

patch: scratchpad/review/fixes/savePersist--dead-fill-tiles-retained.patch

verified: Patched copy on :4554, v-tiles.mjs: 1 tile, 5 MB, heap 9.3 MB and 1 IndexedDB tile throughout all five rub/Undo cycles. A relaunch restores ['Original','Removed spot'].

v-tiles2.mjs (patched):
- After Cancel: 1 tile and 1 IndexedDB tile, with fill A's pixels unchanged.
- Undo restores the pristine pixels exactly; Redo restores the fill's pixels exactly.
- Undo, then a replacing fill, then an immediate page close: the relaunch restores the edit with 1 tile, so the stored record never names a deleted tile.

npm test: 539/539, including test/draft.test.mjs, which exercises autosave.

notes: Differences from the proposed fix:
- It also prunes on Cancel (revertToMark), which leaks in the current build too.
- dropDeadFills runs after syncGpu, so the GPU revert keeps its fast path.

In-flight fills are never touched. Such a fill is in ed.tiles before its commit, but only ids the history named before the change are candidates.

Tile blobs are deleted only once a record write that does not name them has succeeded. A kill in between leaves an orphan that the next launch sweeps.

Medium: a

## [medium] savePersist/quota-source-never-retried — confirmed
**On a nearly full phone, a new photo's original fails to store and is never retried, even after the previous draft's sweep frees the space**
files: ui/autosave.js

patch: scratchpad/review/fixes/savePersist--quota-source-never-retried.patch

verified: Patched copy on :4554, same script: no toast, source:<id> (863346 bytes) is stored, current points at it, and the relaunch restores ['Original','Look: Film'].

With a 0.95 MB quota, where photo 1 never fits, the patched build still shows the out-of-space toast once and stores photo 2.

npm test: 539/539.

notes: The window is narrow: free space must lie between the new original's size and that size minus the previous draft. The user is told the edit isn't being kept, which is true in the current build but avoidable, so I rate it a real edge-case bug (medium) rather than polish.

This diff is the same as the proposed one.

Overlap: it touches only startDraft, disjoint from the tiles fix's hunks in autosave.js.

## [medium] ux/color-none-leaves-strength-ruler — confirmed
**After a look then None, the ruler stays on the disabled Strength dial: dragging it adds an invisible "Strength 70" step, and the chip still shows 100**
files: apps/gesso/ui/tools/color.js

patch: scratchpad/review/fixes/ux--color-none-leaves-strength-ruler.patch

verified: Patched copy, f4-strength.mjs: after Film then None, Warmth is selected and the ruler reads 'Warmth 0'. The same drag commits 'Warmth −34' and the pixels change. Mono then Undo also lands on Warmth. npm test: 555/555. git apply --check: OK.

notes: Kept at medium: a common path (try a look, go back to None) leaves a control that looks disabled but reacts, adding invisible, named Undo steps. color.js is also touched by pick-white-no-loupe-no-guard (constants, drawOverlay, new drawLoupe) and truncated-hints-and-dial-dot (the hint line). The hunks do not overlap, and all three apply cleanly in any order.

## [medium] ux/saved-status-lost-on-noop — confirmed
**"Saved" flips to "Edited" after a no-change Cancel (or Undo+Redo), and New photo then warns "This edit isn't in Photos yet"**
files: apps/gesso/ui/editor.js

patch: scratchpad/review/fixes/ux--saved-status-lost-on-noop.patch

verified: Patched copy, f5-saved.mjs: after the no-op Cancel the status stays 'Saved' and New photo goes straight to the picker with no confirm panel. Undo then Redo also stays 'Saved'. A real change (Brighter) shows 'Edited', and undoing it back to the saved state shows 'Saved' again. f5-resume.mjs: after a reload the restored draft reads 'Saved' and isSaved is true (the original reads 'Edited'). Acceptance check 17 (Resume) passes. npm test: 555/555. git apply --check: OK.

notes: Kept at medium: a wrong status word, and a needless 'not in Photos yet' nag that invites a duplicate save. The revision counter stays, because the exporter's stale check and the navigator use it. editor.js is also touched by zoom-lost-after-crop (keptView declaration and ensureView) and pick-white-no-loupe-no-guard (readOutput). The hunks are disjoint and all apply in either order.

## [medium] ux/share-success-claims-photos — confirmed
**Any completed share is announced as "Done. It's the newest photo in Photos." and marked Saved, even when the user picked Copy, Messages, AirDrop or Save to Files**
files: apps/gesso/ui/savesheet.js, apps/gesso/lib/export-plan.js

patch: scratchpad/review/fixes/ux--share-success-claims-photos.patch

verified: Patched copy, f6-8-look.mjs at 402x874 and 956x440: the done state reads 'Done. If you tapped Save Image, it's the newest photo in Photos.' It wraps to two centred lines and does not overflow the sheet (screenshot .../review/ux-verify/shots/f6-8-fix-402.png). Acceptance checks 8, 9 and 17 pass. npm test: 555/555. git apply --check: OK.

notes: Confirmed on the code path, with the iOS part argued from Web Share and WebKit semantics as described. Kept at medium. SPEC §9 lists 'success copy says where the photo went' as a mitigation; this shows that mitigation can state something false, which is worse than the spec assumes. The fix is deliberately copy-only. markSaved() and retiring the coach line are kept, because Save Image is the coached and likely target, and not marking it saved would nag every correct save. If the integrator wants 

## [low] adjust/strength-ruler-live-when-no-look — confirmed
**After None (or Undo of a look) the disabled Strength dial stays selected and its ruler still edits, adding invisible 'Strength N' undo steps**
files: apps/gesso/ui/tools/color.js

patch: scratchpad/review/fixes/adjust--strength-ruler-live-when-no-look.patch

verified: v5-misc.mjs part 6 on the patched server: after Film, None the selection is warmth and the ruler is 'Warmth'. The -80pt drag gives 'Warmth −20', with no invisible Strength step. Mono, Undo also returns to Warmth. npm test 539/539. Acceptance 17/17 (check 16 Cancel in Color). git apply --check passes.

notes: Low stands. One line in panel() covers None, Undo and Redo, because the editor calls refresh() after onQuick and after history moves; the reporter's extra onQuick line is not needed. Compatible with the other color.js hunks (checked).

## [low] adjust/photo-scrub-first-step-fast-gain — confirmed
**The photo-drag scrub applies the 3× fast gain to its first step and times moves with performance.now() instead of the event timestamps**
files: apps/gesso/ui/tools/dials.js, apps/gesso/ui/tools/light.js, apps/gesso/ui/tools/color.js

patch: scratchpad/review/fixes/adjust--photo-scrub-first-step-fast-gain.patch

verified: v5-misc.mjs part 7 on the patched server: +80pt gives 14 -> 34 (+20 exactly) and a first live step of 14 -> 17; +40pt gives 34 -> 44 (+10 exactly). npm test 539/539. Acceptance 17/17. git apply --check passes.

notes: Low stands. The first-step 3× jump (+5 units on a slow drag, against SPEC F4's 'never jumps') reproduces in Chromium. The iOS amplification (coalesced samples, or a main thread busy with a live render, handled back to back with near-equal performance.now(), so dt clamps to 1ms and slow drags flip to 3×) is reasoned from the code and not run on WebKit. Using g.t (the event or coalesced-sample timestamp the recogniser already carries) removes both. The editor and ruler-view already use event times

## [low] adjust/auto-ruler-never-animates — confirmed
**Crop Auto's ruler animation is a no-op, and Light Auto and Pick white never animate**
files: apps/gesso/ui/ruler-view.js, apps/gesso/ui/tools/crop.js

patch: scratchpad/review/fixes/adjust--auto-ruler-never-animates.patch

verified: v5-misc.mjs part 8 on the final patched tree: Crop Auto samples '0 1.03 2.07 2.6 3.18 3.45 3.72 3.82 3.89 3.9 3.9 3.9', ending at angle 3.9. Light Auto samples '-0.5 -1.33 -2.32 -2.82 -3.37 -3.71 -3.85 -3.96 -4 ...', ending at brightness -4. npm test 539/539. Full acceptance 17/17; checks 7, 10 and 16 re-run on the final tree also pass. git apply --check passes.

notes: Low (polish) stands. set() during a sweep only retargets, so the editor's second refresh() and an Undo inside 400ms both land correctly. A pointer or arrow key takes over at the target value. prefers-reduced-motion makes it instant (SPEC §8). While Paint's segment control or the Pick white message fills the slot, ed.panel.ruler() is null, so those calls do nothing. Only the ruler needle animates; dial-chip numbers still update at once. This touches ruler-view.js beside finding 9; both diffs use 

## [low] adjust/ruler-reset-dead-zone — confirmed
**The ruler's in-track Reset button blocks drags over the right 12.5% of the ruler**
files: apps/gesso/ui/ruler-view.js

patch: scratchpad/review/fixes/adjust--ruler-reset-dead-zone.patch

verified: v5-misc.mjs part 9 on the patched server: a drag from Reset gives 15 -> -2. A tap on Reset gives 0 with exactly one 'Brightness 0' step. Enter on the focused Reset gives 0. A double-tap on the ruler gives 0. The history shows one step per action, with no duplicates. npm test 539/539. Acceptance 17/17. git apply --check passes.

notes: Low stands. A touch tap on Reset now resets in finish(): with pointer capture on the ruler, a click would be retargeted to the ruler, not Reset. The click handler is limited to e.detail === 0, the same pattern editor.js already uses for the Before button's keyboard/VoiceOver activation, so a WebKit-synthesised tap click (detail 1) cannot double-reset. I kept that guard rather than relying on history dedupe, because a second Crop reset could rebuild a float-different rect and add a junk 'Straight

## [low] savePersist/share-success-overclaims — uncertain
**Any completed share target is reported as "It's the newest photo in Photos" and marks the edit Saved**
files: ui/savesheet.js, lib/export-plan.js

notes: Low. The coaching line names Save Image before the tap, and any completed share did put the JPEG somewhere outside Gesso, so marking the edit Saved is defensible. The inaccuracy is the copy "It's the newest photo in Photos.", which SPEC F15 mandates word for word, so changing it is a product decision. If it changes, the minimal option is a hedged line such as "Done. If you tapped Save Image, it's the newest photo in Photos.".

All scripts and screenshots for this review are in /tmp/claude-0/-hom

reproduction: Not runnable here: there is no WebKit build and no iOS share sheet.

The code path is certain: shareOutcome(null) returns 'saved', and showDone then sets gesso:savedOnce=1 (the coaching line is hidden for good) and calls markSaved (status Saved). After that, isSaved makes askNewPhoto skip the unsaved-edit prompt.

Platform judgement from WebKit source: WKShareSheet's UIActivityViewController completionWithItemsHandler reports `completed` for any finished activity (Save Image, Copy, Save to Files

## [low] ux/text-dock-adds-duplicate-caption — confirmed
**Tapping Text to fix an existing caption creates a second "Your words" caption instead of editing the first**
files: apps/gesso/ui/tools/text.js

patch: scratchpad/review/fixes/ux--text-dock-adds-duplicate-caption.patch

verified: In the combined patched copy, f23-text.mjs now leaves history [Original, Caption “Helo”] after tapping Helo, with Helo selected and no stray caption. Regression script .../review/ux-verify/scripts/f2-regress.mjs: a new caption that was typed into ('Second') and then tapped away from is still committed. An untouched Add followed by a tap on the empty photo is withdrawn and the edit bar hidden. An untouched Add followed by the edit bar's Done is still kept. Acceptance checks 7, 10, 11 and 16 pass on the patched copy. npm test: 555/555. git apply --check: OK.

notes: Re-rated from medium to low and reframed. The reviewer's fix (select the newest caption instead of creating one) is not adopted: it goes against SPEC F11, and a keyboard-up 'new caption' on the Text tap is the usual convention. This minimal fix keeps the dock tap as specified and stops the untouched offer from being committed when the user taps away to another caption or the empty photo. An explicit Done or a blur still keeps it. Only text.js is touched, and no other diff edits that file.

## [low] ux/text-placeholder-committed — refuted
**Opening Text just to look, then tapping Done, puts the placeholder "Your words" on the photo as a real caption**
files: apps/gesso/ui/tools/text.js

notes: Specified behaviour, visible and reversible in one tap. SPEC F11 creates the caption 'Your words' on the dock tap, and the 1-minute task is 'type, Done'. Here the user explicitly tapped Done, which means keep. The caption is large and selected on the photo, and the panel shows Cancel right next to the Done they just used: Cancel reverts the whole Text session. Undo names the step, and Delete is in the dial row. Apple's Markup Text behaves the same way. The reviewer's proposed fix would remove a 

reproduction: Reproduced the behaviour with .../review/ux-verify/scripts/f23-text.mjs. Text, then the edit bar's Done with nothing typed, then panel Done. History is [Original, Caption “Your words”] and status is Edited. I do not count this as a defect.

## [low] ux/pick-white-no-loupe-no-guard — confirmed
**Pick white has no magnifier (a small ring sits under the fingertip) and accepts any colour, pushing Warmth and Tint to ±100**
files: apps/gesso/ui/tools/color.js, apps/gesso/lib/autofix.js

patch: scratchpad/review/fixes/ux--pick-white-no-loupe-no-guard.patch

verified: Patched copy, f7-pick.mjs: during a press and slide, a 72 pt circle above-left of the finger shows the toned photo around the finger at 2×, with a crosshair (screenshot .../review/ux-verify/shots/f7-fix-holding-crop.png). The hold-pick still lands at the finger: warmth −48, tint +5, step 'Picked white'. The tap-pick values are unchanged from the original. readOutput with no region does the same maths as before (the region defaults to the whole output, translation 0), so look thumbnails, analysis, the Save preview and acceptance 7, 8 and 9 are unaffected; all pass. npm test: 555/555. git apply 

notes: Re-rated from medium to low, and only the loupe half is confirmed. Pick white usually happens on a tap, where the pick is made on lift and no loupe could help. The loupe matters only for press-and-slide precision, and every result is visible and can be undone. Remove's rub loupe (SPEC F10) is also missing and is not covered by this diff. The new readOutput region would let remove.js draw the same loupe if the integrator wants it.

## [low] ux/home-change-chips-look-static — confirmed
**Auto-enhance's change chips ("Brightness +19", "Shadows +16") look like plain read-outs, not buttons**
files: apps/gesso/styles.css, apps/gesso/ui/tools/home.js

patch: scratchpad/review/fixes/ux--home-change-chips-look-static.patch

verified: Patched copy, f6-8-look.mjs at 402x874 and 956x440: Home's change chips and Crop's Rotate and Flip now have the --raised background rgb(34,31,29). Disabled Tall/Wide stays bare, and the selected Straighten keeps --raised-2. Screenshot: .../review/ux-verify/shots/f6-8-fix-402.png. Acceptance checks 1 to 5 (layout, labels, fixed places, count) pass at all five viewports. npm test: 555/555. git apply --check: OK.

notes: Re-rated from medium to low. This is an affordance and polish issue with screenshot evidence, not a broken feature, and the H14 tip points at the chips once. The SPEC §8 token table assigns --raised to 'chips', so this follows the spec. styles.css is also touched by truncated-hints-and-dial-dot, confirm-discard-styling-and-return and start-stage-black-landscape-gap, in disjoint hunks; all apply in any order.

## [low] ux/truncated-hints-and-dial-dot — confirmed
**At 402 pt and in landscape, the Light, Paint and Pick-white hints are cut off with an ellipsis, and the 'Brightness' dial name is truncated with its changed-dot clipped**
files: apps/gesso/ui/tools/light.js, apps/gesso/ui/tools/color.js, apps/gesso/styles.css

patch: scratchpad/review/fixes/ux--truncated-hints-and-dial-dot.patch

verified: Patched copy, f9-clip.mjs at 402x874, 440x956, 874x402 and 956x440: no hint is cut in Light, Paint, Color, Pick white, Crop, Remove or Text. The changed Brightness name is 57/57 at every viewport, with its dot drawn by .dial::before. Screenshot .../review/ux-verify/shots/f9-fix-panels.png shows the full hints and 'Brightness•' at 402 and in landscape. The selected-dial underline (::after) is unaffected. Acceptance checks 1 to 4 and 13 pass. npm test: 555/555. git apply --check: OK.

notes: Kept at low. Compared with the reviewer's fix I dropped `.dial { padding: 0 1px }`: once the dot is moved out of the name, the name already fits. The Light hint is the SPEC §3 table's copy, so the integrator may want to update that row (Crop's hint already departs from the table the same way). The slot keeps the full Pick white sentence. color.js and styles.css are shared with other diffs in disjoint hunks.

## [low] ux/import-error-overwrites-tool-hint — confirmed
**A failed import while editing replaces the open tool's hint with a stale, cut-off error; at start the same long RAW message shows twice**
files: apps/gesso/app.js, apps/gesso/lib/image-io.js

patch: scratchpad/review/fixes/ux--import-error-overwrites-tool-hint.patch

verified: Patched copy, f10-12.mjs: on the start screen the hint reads 'RAW photos aren't supported. Pick the regular photo.' with no toast. In Light, 3.5 s after the failed pick, the header reads 'Light / Tap Auto, or pick a dial and drag.' (not cut), and the error is in the toast. npm test: 555/555, including image-io's /RAW/ assertion. git apply --check: OK.

notes: Kept at low. RAW and DNG are rare from the Photos picker, because iOS hands over a JPEG or HEIC rendition; they come through Choose File. The same path also carries decode failures. The new copy is SPEC F1's exact wording.

## [low] ux/zoom-lost-after-crop — confirmed
**Visiting Crop and tapping Done with no change throws away the user's zoom**
files: apps/gesso/ui/editor.js

patch: scratchpad/review/fixes/ux--zoom-lost-after-crop.patch

verified: Patched copy, f11-zoom.mjs: after Crop, Done with no change, the view is back to 4.67× at the same offset and the pill reads '4.7× · Fit'. Crop › Square (the output changes) still refits to 1×. After a zoomed Crop round trip, the Fit pill still fits, because restoring needs viewKey to start with 'f:' and the pill, resize and begin() all set viewKey to ''. A rotation changes the stage size inside the key, so it still refits. Acceptance checks 3, 11 and 16 pass. npm test: 555/555. git apply --check: OK.

notes: Kept at low. It shares editor.js with saved-status-lost-on-noop and pick-white-no-loupe-no-guard in disjoint hunks.

## [low] ux/confirm-discard-styling-and-return — confirmed
**New-photo prompt: 'Discard edit' isn't in the danger colour, and 'Keep editing' drops the user out of the tool they were in**
files: apps/gesso/app.js, apps/gesso/styles.css

patch: scratchpad/review/fixes/ux--confirm-discard-styling-and-return.patch

verified: Patched copy, f10-12.mjs: 'Discard edit' computes rgb(255,107,94) (--danger), and the other two chips are unchanged. data-quick="discard" is used only by app.js's confirm panel. npm test: 555/555. git apply --check: OK.

notes: Only the styling half is fixed. The 'Keep editing returns to the tool' half is not adopted. By the time the confirm opens, the tool has already been closed with Done (SPEC F2: tapping another surface counts as Done), so its Cancel scope is gone. The reviewer's `ed.openTool(back)` would also run text.open() with no selection, which creates a fresh 'Your words' caption with the keyboard up when the user came from Text. Home is a valid place to keep editing.

## [low] ux/start-stage-black-landscape-gap — confirmed
**Visual seams: the start-screen stage is pure black instead of --ground, and in landscape the tool column floats above a darker strip**
files: apps/gesso/styles.css

patch: scratchpad/review/fixes/ux--start-stage-black-landscape-gap.patch

verified: Patched copy, f13-ground.mjs: the start-screen stage samples (13,12,11) at 440x956, 956x440 and 874x402, matching the top bar. The edit state is unchanged, because begin() and resume() set data-state='editing' before the first draw. Acceptance check 6 (static paint) and check 14 (offline reload renders the editor) pass. npm test: 555/555. git apply --check: OK.

notes: Only the start-screen half is confirmed, as low polish on the first frame a new user sees.

## [low] ux/rub-labelled-spot — confirmed
**A rubbed-area fill is named "Removed spot" in the Undo toast and on the rewind tape**
files: apps/gesso/ui/tools/remove.js, apps/gesso/lib/doc.js

patch: scratchpad/review/fixes/ux--rub-labelled-spot.patch

verified: Patched copy, f14-rub.mjs: labels are [Original, Removed spot, Removed area], Undo toasts 'Undid: Removed area', and Try another on it is still 'Tried another'. A big tap that falls back to a rub-style fill (healSpot) keeps 'Removed spot'. Acceptance check 7 ('Removed spot' on the speck tap) passes. npm test: 555/555. git apply --check: OK.

notes: Kept at low. The labels are saved with the history, so drafts autosaved before the fix keep 'Removed spot' for old rubs.
