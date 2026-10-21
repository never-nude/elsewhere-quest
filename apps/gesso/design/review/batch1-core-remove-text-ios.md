## [critical] core/cancel-after-undo-destroys-history — confirmed
**Cancel after Undo or the rewind tape inside a tool permanently deletes steps made before the tool was opened (up to the whole edit)**
files: /home/user/elsewhere-quest/apps/gesso/lib/history.js, /home/user/elsewhere-quest/apps/gesso/ui/editor.js

patch: scratchpad/review/fixes/core--cancel-after-undo-destroys-history.patch

verified: I applied the patch to a scratch copy served on 127.0.0.1:4551 and ran v1-mark.mjs: A, B, C and D all pass. After the fix, Cancel returns to [Original | Auto-enhance | Crop Square | *Look: Film], or [.. | *Look: Film] after the tape round trip, and the reloaded draft matches. On the repo clone at HEAD 5930a5c, npm test passes 556/556 with this patch alone (baseline 555). git apply --check passes from /home/user/elsewhere-quest. All 10 patches together: npm test 557/557 and acceptance 16/17 strict, including check 16 (Cancel) and check 10. The one failure was check 8's timing: [data-ready] at 4

notes: The fix is the reporter's rule: Undo, Redo and the tape never move the mark, and only a new step made below the mark lowers it. It is restated from my own tests. revertToMark is unchanged. The proposed 'clearMark in editor.resume' is not needed: lib/draft.js reviveDraft already calls clearMark(reviveHistory(...)), so a restored draft never carries a mark. SPEC §5.5 still says 'Undo past the mark moves the mark down'. That sentence should be updated to match; I left it out of the diff because it 

## [high] core/late-remove-fill-dropped-by-other-tools-cancel — confirmed
**A Remove fill that finishes after leaving Remove lands inside the next tool's session, and that tool's Cancel (or the New-photo panel's 'Keep editing') throws it away**
files: /home/user/elsewhere-quest/apps/gesso/ui/tools/remove.js, /home/user/elsewhere-quest/apps/gesso/ui/editor.js, /home/user/elsewhere-quest/apps/gesso/app.js

patch: scratchpad/review/fixes/core--late-remove-fill-dropped-by-other-tools-cancel.patch

verified: On the patched copy (port 4551), v2-latefill.mjs passes all 6 scenarios: a, b, c and d keep the fill. Control e: rub then Cancel in Remove still drops its own fill. Control f: a session-1 fill is kept while a session-2 fill is dropped by session 2's Cancel. v2b-pixels.mjs checks that the GPU stays in step with the history after a late fill is inserted under Light with Brighter on top. It reads renderer.readRect against the tile at each step: landed, Undo Brighter, Undo fill, Cancel, Undo again. Every step is bit-exact (302895/302895 pixels equal the tile when filled, pristine when not), the re

notes: This is my own implementation of the reporter's design. A fill remembers the tool session that asked for it. When it lands under a different open session, history.insertBelowMark puts it just above that session's mark and replays the session's steps on top, so Cancel keeps it and Undo walks through it. Remove's Cancel drops only its own session's jobs (dropSession). dropPending stays for a new photo. Compatible with cancel-after-undo-destroys-history: same two files, separate hunks, and they app

## [high] core/context-loss-at-launch-discards-draft — confirmed
**A WebGL context loss or upload failure while the saved draft is restored at launch discards the user's whole edit permanently**
files: /home/user/elsewhere-quest/apps/gesso/app.js, /home/user/elsewhere-quest/apps/gesso/ui/renderer.js

patch: scratchpad/review/fixes/core--context-loss-at-launch-discards-draft.patch

verified: On the patched copy, v3-launchloss.mjs passes in both modes. lose: the restore fails with 37442, the context comes back, the page reloads by itself, and the editor reopens with [Original, Auto-enhance, Crop Square, Look: Film] and no page errors. oom: the start screen says 'Your last edit couldn't be opened. Reload to try again.', and a reload restores the full history. On the live app, both modes lose the draft for good. npm test passes 555/555 with this patch alone and 557/557 with all patches. git apply --check passes.

notes: This is simpler than the proposed openDraft refactor and avoids its TDZ concerns. Only a GPU failure in loadSource keeps the draft. Damaged records (loadDraft/reviveDraft throwing), decode failures and the size mismatch still discard as before. On a lost context, a once-listener on #gl reloads the page when the context is restored, so the existing launch restore runs again. If the context is never restored, the existing 3 s location.reload() in onLost does the same. The listener stands down if a

## [high] ios/sw-network-first-no-timeout — confirmed
**Network-first service worker has no timeout, so on a connection that never answers (one bar of signal, a captive portal) the installed app stays blank instead of starting from its cache**
files: apps/gesso/sw.js

patch: scratchpad/review/fixes/ios--sw-network-first-no-timeout.patch

verified: I applied the diff to a copy of HEAD f2ad749 (/tmp/claude-0/-home-user-elsewhere-quest/4ce67d9c-b416-53ac-b16b-6e1e77e49bb3/scratchpad/review/ios-verify/final/gesso) and served it on 127.0.0.1:4555.
- t-sw.mjs, hang mode: chrome painted at 2573 ms, editor ready at 2814 ms, start screen usable. Refuse and normal modes were unchanged (about 130/250 ms and 80/260 ms).
- t-sw2.mjs, mid-session hang: Save ready in 6.3 s (was 34.6 s), and a Remove tap gave "Removed spot" in 1.3 s (was the 20 s failure).
- t-sw3.mjs: a file changed on the server reaches both the page and the SW cache, so network resp

notes: Still present in HEAD f2ad749. The approach is the reporter's (a race against a 2.5 s timer, plus a 30 s 'slow' memory so the deep module graph does not pay one timeout per level). Note that the reporter's prose snippet calls response.clone() inside caches.open().then(), which can run after respondWith has consumed the body. Their diff file clones synchronously, and so does mine; I also guard waitUntil, which throws once the event has already been answered from the cache.

Known trade-off: on a 

## [high] ios/ctx-restore-decode-fail-black-jpeg — confirmed
**After a WebGL context loss, if re-decoding the photo fails, the app stays on an empty texture and Save writes an all-black JPEG to Photos, reports success and marks the edit Saved**
files: apps/gesso/app.js, apps/gesso/ui/renderer.js

patch: (none given)

verified: Already fixed in HEAD f2ad749, the integrator's commit made during this review. HEAD makes #app inert while the context is lost, adds catch → location.reload() in onRestored, and adds `!pristine` to renderPixels' guard. I verified it with the same t-ctx.mjs on a snapshot of HEAD:
- The page reloads and shows the toast 'Restored your last edit'; the labels are ['Original','Brightness +15'].
- The saved JPEG is 1,179,279 bytes with a maximum channel of 255.

I also checked the renderer guard on its own (a copy of 5930a5c with only renderer.js changed): Save then shows "Couldn't prepare. Try agai

notes: The fix field is empty because the current tree already contains an equivalent fix; a diff against it would be a no-op. HEAD reloads without an explicit flush. That is fine: the pagehide flush builds the record and opens its IndexedDB transaction synchronously, and the reload restored the edit in my run. Severity stays high: the output is silently wrong, success is announced, and New photo stops warning. The trigger needs a context loss followed by a failed re-decode, which is rare but correlate

## [high] ios/restore-failure-deletes-draft — confirmed
**One transient decode or GPU failure while restoring at launch permanently deletes the saved draft (the original and the whole history)**
files: apps/gesso/app.js

patch: (none given)

verified: Already fixed in HEAD f2ad749. HEAD has a `damaged` flag that is true until loadDraft resolves and true again on a size mismatch, and it discards only when damaged; my fix of 5930a5c was the same. Checked on a snapshot of HEAD:
- t-restore.mjs: relaunch 1 shows "Your last edit couldn't be opened just now. Close Gesso and open it again." Relaunch 2 restores ['Original','Brightness +15'] with the toast 'Restored your last edit'.
- t-damaged.mjs: after deleting source:<id> from IndexedDB, relaunch 1 says "couldn't be restored", relaunch 2 shows the start screen, and meta.current is null. A damage

notes: The fix field is empty because the current tree already has the fix; my reference diff against 5930a5c is in diffs/reference-against-5930a5c-all-findings.diff. A kept draft whose decode fails on every launch shows the hint each time until the user picks a new photo, and startDraft then sweeps it. That is acceptable. Severity: data loss on a single transient failure.

## [high] removeText/late-fill-cancelled — confirmed
**A Remove fill that lands after the user has moved to another tool is wiped by that tool's Cancel, and Redo can't bring it back**
files: /home/user/elsewhere-quest/apps/gesso/ui/tools/remove.js, /home/user/elsewhere-quest/apps/gesso/ui/editor.js

patch: scratchpad/review/fixes/removeText--late-fill-cancelled.patch

verified: I applied the fix to a scratch copy served on :4553. r1.mjs now ends with labels [Original, Removed spot/remove] and 1 remove id. In r1b.mjs, after fill → Brighter → Cancel, history is [Original, Removed spot], brightness is 0 and the fill pixels are still on the GPU. Undo then restores the original pixels bit-exactly (hash equal), and Redo brings the fill back bit-exactly. In the patched copy, npm test passes 539/539 and node e2e/acceptance.mjs passes 17/17 at strict timings, including 7, 10 and 16 (Remove's own Cancel is unchanged). git apply --check against /home/user/elsewhere-quest passes

notes: The fix replays each late Remove step separately, keeping its label, on top of the mark state. It does not merge them into one step as the reporter's diff did, so Undo still removes them one at a time. A step the user undid in that session is not replayed, because only entries up to the current index are taken. The reporter's extra H.setMark is dropped: clearMark runs right after, so it had no effect. Only editor.js closeTool changes. F4 also edits editor.js, in different hunks, and the two diff

## [medium] core/context-loss-at-import — confirmed
**A context loss while a picked photo uploads permanently halves the working size to 12 MP, and can leave the old photo's pixels under the new photo's document**
files: /home/user/elsewhere-quest/apps/gesso/app.js

patch: scratchpad/review/fixes/core--context-loss-at-import.patch

verified: On the patched copy, v4-importloss.mjs passes both parts. cap: gesso:workCap stays unset, and coffee-48mp then opens at 5715x4286 ('Editing at 24.5 MP'). race: doc and GPU are both 5715x4286. v4b-restore-race.mjs passes too: doc and GPU are both 640x427, rocket.jpg. npm test passes 555/555 with this patch alone and 557/557 with all patches. git apply --check passes.

notes: This is smaller than the proposal. A context loss during an import upload no longer steps the cap down for good. renderer.lost now reads gl.isContextLost(), which is true at once, while the event comes a task later. The import then fails with the existing 'This photo couldn't be opened.' message, and the user picks it again once the context is back. I did not add the proposed pendingImport auto-retry. onRestored now stands down if a newer photo got there first or an import is running. `importing

## [medium] core/save-first-skips-pending-fill — confirmed
**New photo, then 'Save first', saves a copy without a Remove fill that is still computing, then still reports the photo as unsaved**
files: /home/user/elsewhere-quest/apps/gesso/app.js

patch: scratchpad/review/fixes/core--save-first-skips-pending-fill.patch

verified: On the patched copy, v5-savefirst.mjs passes. 'Finishing…' shows, and the sheet opens only after the fill lands. The first and second JPEGs are identical (mean difference 0 inside the fill), the status becomes 'Saved', and there are no page errors. npm test passes 555/555 alone and 557/557 combined. git apply --check passes.

notes: This is the reporter's first option. The Save button handler collects every tool's settle(), shows 'Finishing…', and then calls onSave, which is openSaveSheet. Sharing still needs its own tap on the sheet, so no user activation is lost. The openSaveSheet import stays in use through onSave. No other patch touches these lines. Severity stays medium: the path is narrow (New photo, then Save first, while a fill is still computing), but the saved copy is wrong and the sheet reports success.

## [medium] core/saved-status-by-revision-counter — confirmed
**'Saved' status and the New-photo question go wrong after a no-op Cancel, or Undo then Redo, because 'saved' compares a revision counter**
files: /home/user/elsewhere-quest/apps/gesso/ui/editor.js

patch: scratchpad/review/fixes/core--saved-status-by-revision-counter.patch

verified: On the patched copy, v6-saved.mjs passes A, B and C. A: 'Saved' survives Crop then Cancel, New photo opens the file picker, and the status is still 'Saved' after a reload. B: after Undo then Redo it reads 'Saved'. C: a real change still reads 'Edited' and New photo asks. npm test passes 555/555 alone and 557/557 combined. Acceptance check 17 (Resume) passes combined. git apply --check passes.

notes: Saved now compares the current immutable history state with the one that was saved. The revision counter stays, because the exporter, navigator, colour thumbnails and home tips use it as a cache key. The draft field keeps its name `savedRevision`, a boolean, so stored drafts stay compatible. This patch shares ui/editor.js with the late-fill, hold-before and paint-cancel patches, in non-overlapping hunks; all apply in either order. Severity stays medium: the status word is wrong, and a false 'Thi

## [medium] core/hold-before-turns-into-wipe-on-drift — confirmed
**Holding the photo for Before switches to a split wipe at the finger as soon as the held finger drifts 1-2 pt**
files: /home/user/elsewhere-quest/apps/gesso/ui/editor.js, /home/user/elsewhere-quest/apps/gesso/lib/gestures.js

patch: scratchpad/review/fixes/core--hold-before-turns-into-wipe-on-drift.patch

verified: On the patched copy, v7-hold.mjs passes with real CDP touches. With drift it stays 'before' through all three moves and is 'off' after lift. A slide is 'before' for the first 6 pt and then 'wipe' through the rest of the slide, and 'off' after lift. No page errors. Acceptance check 11 (Before) passes combined. npm test passes 555/555 alone and 557/557 combined. git apply --check passes.

notes: The fix belongs in the editor, not in lib/gestures.js. Color › Pick white claims holds and needs every hold-move for its loupe (ui/tools/color.js:108), so a threshold in the recognizer would break it. The threshold applies only while Before is showing. Once the wipe starts, `from` is dropped and the line follows the finger freely. It uses the existing SLOP (8 pt), the same as the tap and hold slop. Severity stays medium: on a real phone, 'Hold the photo to compare' would usually show half Before

## [medium] ios/no-stepdown-on-decode-failure — confirmed
**The 24.5 MP → 12 MP memory step-down (SPEC §5.4/§9) never runs when the decode itself fails, and the 900 MB memory ledger the spec relies on does not exist**
files: apps/gesso/ui/importer.js, apps/gesso/app.js

patch: scratchpad/review/fixes/ios--no-stepdown-on-decode-failure.patch

verified: Tested on the HEAD copy with all three diffs (/tmp/claude-0/-home-user-elsewhere-quest/4ce67d9c-b416-53ac-b16b-6e1e77e49bb3/scratchpad/review/ios-verify/final/gesso), using t-stepdown.mjs:
- coffee-48mp.jpg: decodes ['5715x4286','4000x3000'], opens at 4000x3000 with the tip 'Editing at 12 MP', and workCap is 12000000.
- fx/corrupt.jpg (a JPEG header followed by junk): "This photo couldn't be opened." after decodes ['4032x2688','4032x2688'], and workCap stays null, so a broken file is not taken for low memory.
- RAW and unknown types keep their sniff-time messages without a retry.

npm test: 55

notes: Instead of a decodeFailed flag on importer.js line 44, as the reporter proposed, the flag goes on the sniff-time error at line 17 (`unsupported`). That keeps this diff and the sniff-rejects-webkit-formats diff in separate hunks of importer.js. I checked that the two diffs apply in sequence (sw, then stepdown, then formats) to a git copy of HEAD, and the result equals the tested tree. A corrupt file now costs one extra decode attempt; once the cap is already 12 MP there is no retry.

The 900 MB l

## [medium] ios/alpha-flattened-to-black — confirmed
**Transparent PNG/HEIC (e.g. iOS 'lift subject' cut-outs) import with black backgrounds and their soft edges become hard full-colour fringes in the editor and the saved JPEG**
files: apps/gesso/ui/renderer.js

patch: (none given)

verified: Already fixed in HEAD f2ad749 (fillStyle '#ffffff' plus fillRect in place of clearRect in loadSource), the same as my fix.
- t-alpha.mjs on HEAD: 220,30,30 | 225,61,60 | 239,145,145 | 250,230,231 | 255,255,255 | 255,255,255, which matches the analytic composite over white (for example a=0.875 → 224,58,58).
- t-opaque.mjs: the pristine-texture hash is identical before and after the fix for coffee-12mp (4032x2688) and cat-portrait-12mp (3024x4032, which uses the partial last-strip getImageData path), so opaque photos are unchanged.

notes: The fix field is empty because the current tree already has the fix. White versus black ground is a product choice; the real defect was the hard fringe, which any correct composite removes.

## [medium] ios/share-success-any-activity — confirmed
**'Done. It's the newest photo in Photos.' and the Saved state are shown after any share-sheet action (Copy, Save to Files, Messages, AirDrop), not only Save Image**
files: apps/gesso/ui/savesheet.js, apps/gesso/lib/export-plan.js, apps/gesso/index.html

patch: (none given)

verified: Already fixed in HEAD f2ad749, where the copy is "Done. If you tapped Save Image, it's the newest photo in Photos." (my fix used the same wording with 'chose'). t-share.mjs on HEAD: the text is on two lines inside the card, and the card fits without overflow at 440x956, 402x874 and 874x402 (screenshot share-patched-874x402.png). npm test: 555/555.

notes: The fix field is empty because the current tree already has the fix. One residual remains, and I think it is acceptable: after Copy or Messages, markSaved still marks the edit as saved and the coaching line is retired, so New photo skips 'This edit isn't in Photos yet'. The hedged success line now tells the user that only Save Image puts the photo in Photos.

## [medium] ios/tile-memory-unbounded — confirmed
**Remove tiles stay resident in JS memory for every history step (about 17 MB per large rub or Try another at 24 MP) and are all reloaded at launch; nothing bounds them**
files: apps/gesso/ui/editor.js, apps/gesso/ui/autosave.js, apps/gesso/ui/tools/remove.js

patch: (none given)

verified: Already fixed in HEAD f2ad749. HEAD's dropDeadFills runs after commit and after Cancel, and frees unreachable tiles from memory, from pools.patches and, through autosave.forgetTiles, from IndexedDB. Checked on a snapshot of HEAD:
- t-tiles.mjs: 0 MB after Cancel. After rub, Undo and tap: 3.1 MB with 0 MB unreachable.
- t-tiles2.mjs: Undo and Redo through overlapping fills, a Try another and a dropped branch are pixel-exact (base hash equal at every index).
- t-tiles3.mjs: after dropping, IndexedDB holds the 2 reachable tiles, and a reload restores the same labels with identical pixels.
My narr

notes: The fix field is empty because the current tree already has the fix. What remains is the reported growth of reachable tiles, about 19 MB per large rub or Try another at 24 MP, kept for Undo. That is inherent to the tile design; bounding it needs lazily loaded IndexedDB tiles, which is not a minimal change. I rate this medium for the measured leak; that it leads to jetsam is reasoned, not shown.

## [medium] removeText/rub-fill-soft — confirmed
**Rub fills lose most of the photo's fine texture: PatchMatch runs on a shrunk window and the result is scaled back up bilinearly**
files: /home/user/elsewhere-quest/apps/gesso/ui/tools/remove.js, /home/user/elsewhere-quest/apps/gesso/lib/remove-plan.js, /home/user/elsewhere-quest/apps/gesso/lib/inpaint.js

patch: scratchpad/review/fixes/removeText--rub-fill-soft.patch

verified: Patched copy on :4553, same scripts. Texture rub: fill HF 44.20 against clean 43.68 (ratio 1.01, was 0.15). The fill cannot be seen in wide-rub-tex.png (right side) or sbs-rub-tex-patched.png. Coffee wood rub: 1.61 against 1.58 (1.02, was 0.71). Land time did not change measurably (3.07 s patched, 3.11 s live). With the matched copy, matchSeam still meets the edge without a halo, and the horizon run (rub-hz2-patched) shows sharp texture. In the patched copy, npm test passes 539/539, including the heal.test inpaint message tests, and acceptance passes 17/17. git apply --check passes.

notes: Medium is fair. On fine textures (gravel, grass, sand) the result is an obvious smudge. On softer photos the loss is smaller but still visible when zoomed. The fix follows the reporter's design. The full-size readback is capped at an 8 MP window (32 MB). Larger windows, such as a capped 20% rub on a 24 MP photo, keep the old bilinear fill; reading in bands would lift that cap. The full-scale (scale >= 1) branch already copied real pixels and is unchanged. F2 also edits remove.js (import line, co

## [medium] removeText/rub-structure-sinks — confirmed
**Rubbing out something that stands on a horizon pushes the sky 110-190 px down into the ground in a staircase; Try another repeats it and Source is not offered for rubs**
files: /home/user/elsewhere-quest/apps/gesso/ui/tools/remove.js, /home/user/elsewhere-quest/apps/gesso/lib/inpaint.js

patch: scratchpad/review/fixes/removeText--rub-structure-sinks.patch

verified: Patched copy on :4553, same zigzag rub (q-rub.mjs; q-src.mjs for Source). The first fill is still PatchMatch: median 1784, now with sharp texture from F2. Try another now heals from one offset over the rubbed shape. Lowest sky is median 1699 / max 1712, with 3 sky pixels below the horizon and RMSE 18.4. A second Try another (the next offset) gives 0 pixels below. The fill is invisible in cmp-hz2-patched.png. The offset Try another landed in 1.8 s. After it, the Source dial is enabled ('Auto'). Dragging the ring re-fills as 'Moved source' in 2.4 s with kind 'tap', the pts kept and a clean horiz

notes: Medium stands. This is a common case (someone in front of a horizon), and before the fix none of the in-app escapes repaired it. My fix is deliberately smaller than the reporter's. The first rub still uses PatchMatch, which handles cluttered scenes better. Try another now offers the spec's own single-offset heal (SPEC §7) over the rubbed shape, then cycles its other offsets, with Source enabled. That is the SPEC §9 mitigation (Try another, Source), now working for rubs. If no offset fits, Try an

## [medium] removeText/rub-loupe-missing — confirmed
**Remove's rub has no 2x loupe (SPEC F10), so the finger hides what is being rubbed**
files: /home/user/elsewhere-quest/apps/gesso/ui/tools/remove.js, /home/user/elsewhere-quest/apps/gesso/ui/renderer.js, /home/user/elsewhere-quest/apps/gesso/ui/editor.js

patch: scratchpad/review/fixes/removeText--rub-loupe-missing.patch

verified: Patched copy on :4553, q-loupe.mjs. Mid-rub at 440x956, a 96 pt square loupe sits above-left of the finger. It shows the photo at 2x through the same develop pass (fills and tone included), with the coral and brush ring at 2x (cmp-loupe.png panel 2). With the finger in the stage's top-left corner, the loupe flips below-right and stays on the stage (panel 3). It disappears on lift, and the fill lands normally (panel 4). Landscape 956x440 also works (q-loupe-patched-956.png). The loupe is drawn only while a rub stroke is live and only in compare 'off'. Remove taps, ring drags and other tools are

notes: This is a real gap against SPEC F10, §5.9 and §6. I would rate it medium, though it is close to low. Rubbing still works, the coral trail stays visible behind the finger, and pinch-zoom (hinted by H6) gives precision. But with Small or Medium brushes, the spot being rubbed is fully hidden, so precise work on wires and thin objects is guesswork. The loupe is square (scissor), not round. Following SPEC §6, it is drawn inside the single GL canvas with no extra context or readback. F4 shares editor.

## [low] core/recovering-does-not-block-input — confirmed
**While 'Recovering…' after a context loss, the UI stays live: taps throw page errors and Undo is half-applied**
files: /home/user/elsewhere-quest/apps/gesso/app.js, /home/user/elsewhere-quest/styles.css

patch: scratchpad/review/fixes/core--recovering-does-not-block-input.patch

verified: On the patched copy, v8-recovering.mjs passes: no page errors from the Light, Auto, Color or Undo taps during recovery. Those taps do nothing, the history is unchanged, and after the restore the Redo button matches the history. npm test passes 555/555 alone and 557/557 combined. Full acceptance passes combined, except the check-8 timing noted above, which passed on reruns. git apply --check passes.

notes: I left out the proposed `await autosave.flush()` before the 3 s reload. location.reload() fires pagehide, and app.js already flushes autosave on pagehide, opening the IndexedDB transaction synchronously. With input blocked, no new step can be made during recovery anyway. inert is supported in iOS Safari 15.5 and later. #sheet and #editbar sit outside #app and are unaffected. An export during a loss already fails cleanly through renderer.lost. This patch shares onRestored with context-loss-at-imp

## [low] core/paint-cancel-rebuilds-every-fill — confirmed
**Cancelling a paint stroke (a second finger landing to zoom) rebuilds every Remove fill and the blur map**
files: /home/user/elsewhere-quest/apps/gesso/ui/tools/light.js, /home/user/elsewhere-quest/apps/gesso/ui/editor.js

patch: scratchpad/review/fixes/core--paint-cancel-rebuilds-every-fill.patch

verified: On the patched copy, v9-paintcancel.mjs with 8 fills shows the cancel calls ed.replayPaint, which takes 0 ms with 0 tile pastes and leaves the mask cleared. v9b-paintmask.mjs commits one stroke, then cuts a second short with a second finger. The toned readOutput hash after the cancel is identical to the hash after the committed stroke (603978190), and it differed mid-stroke, so the half stroke is fully removed and the committed one kept. npm test passes 555/555 alone and 557/557 combined. git apply --check passes.

notes: ed.replayPaint replays the paint mask from `applied`, the state the GPU reflects, and does nothing else. Paint strokes never use liveState, so applied is the committed state during a stroke. ed.resync is kept for its real job, context restore. Severity stays low: it is a one-off hitch at the start of a pinch that cuts a stroke. On an A19 GPU it will be far smaller than the 2.6 s seen on SwiftShader, but it still grows with the number of fills.

## [low] core/crop-auto-ruler-does-not-animate — confirmed
**Crop › Auto: the Straighten ruler jumps instead of animating (animateTo is a no-op)**
files: /home/user/elsewhere-quest/apps/gesso/ui/tools/crop.js, /home/user/elsewhere-quest/apps/gesso/ui/ruler-view.js

patch: scratchpad/review/fixes/core--crop-auto-ruler-does-not-animate.patch

verified: On the patched copy, v10-cropauto.mjs shows the ruler easing from 0 to -3 over about 400 ms: -0.27, -0.6, -0.91 … -2.99, -3. Acceptance checks 7 (Crop Auto at -3°±0.5) and 10 pass combined. npm test passes 555/555 alone and 557/557 combined. git apply --check passes.

notes: panel.render reuses the same ruler view while the slot spec stays 'straighten' (ui/panel.js:111), so the captured `ruler` is the one on screen after the commit. Under prefers-reduced-motion the animation is skipped and the ruler already shows the new value (SPEC §8). Passing ms = 0 instead would paint a NaN or -Infinity frame when the rAF timestamp precedes t0. Severity stays low: polish only.

## [low] ios/sniff-rejects-webkit-formats — confirmed
**Plain TIFF is reported as 'a RAW photo', and BMP and JPEG XL are rejected, although Safari 26 decodes all three**
files: apps/gesso/lib/image-io.js, apps/gesso/ui/importer.js

patch: scratchpad/review/fixes/ios--sniff-rejects-webkit-formats.patch

verified: Tested on the HEAD copy with all three diffs (/tmp/claude-0/-home-user-elsewhere-quest/4ce67d9c-b416-53ac-b16b-6e1e77e49bb3/scratchpad/review/ios-verify/final/gesso):
- Node: TIFF → 'tiff', BMP → 'bmp', both JXL forms → 'jxl', each with importProblem null.
- Browser (t-formats.mjs): the BMP opens at 300x200. The TIFF, which Chromium cannot decode and so stands in for a DNG, gets the RAW message, and workCap stays null.
- npm test: 555/555 with the updated sniff tests.
- Acceptance: 17/17.
- git apply --check exits 0 against HEAD f2ad749.
The diff file is /tmp/claude-0/-home-user-elsewhere-ques

notes: Still present in HEAD. This diff and the no-stepdown-on-decode-failure diff both edit ui/importer.js, but in separate hunks (line 44 here, line 17 there), and they apply in either order; I checked them in sequence. With both applied, an undecodable TIFF (DNG) is retried once at 12 MP before the RAW message, and nothing is persisted.

BMP sniffing on 'BM' alone is loose. A false positive only changes the message to "couldn't be opened". That TIFF and JXL actually decode on iOS is reasoned from We

## [low] ios/install-line-ios26 — uncertain
**Install line 'Share → Add to Home Screen' skips the ⋯ step needed in iOS 26 Safari's default compact layout**
files: apps/gesso/index.html

notes: If it is confirmed on a device during the ?probe=1 pass, a wording that is right in every layout is 'To use offline: Share (in ⋯) → Add to Home Screen'. Check that it still fits on one line at 402 px and in the 384 pt landscape column, together with the Hide button.

General notes on this verification:
- The repo changed during the review: the integrator committed f2ad749, 'review fixes, batch 2'. That commit already fixes ctx-restore-decode-fail-black-jpeg, restore-failure-deletes-draft, alpha-

reproduction: This cannot be run here: there is no WebKit build or iOS device, and the question is about Safari's own UI, not WebKit engine behaviour. The copy is unchanged in HEAD (index.html line 83: 'To use offline: Share → Add to Home Screen'). My understanding of iOS 26 Safari is that the default Compact tab layout puts Share inside the ⋯ (More) menu, while the Bottom and Top layouts still show Share on the toolbar. The finding is plausible, but I cannot verify it.

## [low] removeText/rtl-caption-direction — confirmed
**Hebrew and Arabic captions render with a left-to-right base direction: end punctuation and numbers land on the wrong side, in the photo, the export and the edit field**
files: /home/user/elsewhere-quest/apps/gesso/ui/captions.js, /home/user/elsewhere-quest/apps/gesso/lib/text-layout.js, /home/user/elsewhere-quest/apps/gesso/index.html

patch: scratchpad/review/fixes/removeText--rtl-caption-direction.patch

verified: Same script on the patched copy (:4553). The Hebrew caption now ends with '!' on the left, on the stage and in the field (cmp-rtl-stage.png, cmp-rtl-typing.png). The Arabic export raster reads '!2026 بالعالم مرحبا' left to right, which is correct RTL order (zoom-ar-patched.png). English captions are unchanged. Centred alignment means the box position does not move. In the patched copy, npm test passes 539/539 and acceptance passes 17/17. git apply --check passes.

notes: Low. Behaviour of ctx.direction and dir=auto is the same in WebKit, which has supported ctx.direction and \p{Script=} regex escapes since Safari 11.1. I kept the helper local to captions.js rather than adding a lib export, which keeps the diff to two files. F6 also edits captions.js, in a different hunk (draw()); the two apply in either order.

## [low] removeText/caption-preview-unclipped — confirmed
**The stage draws captions past the photo's edge onto the dark margin, but the saved JPEG cuts them off; a crop change makes this common**
files: /home/user/elsewhere-quest/apps/gesso/ui/captions.js

patch: scratchpad/review/fixes/removeText--caption-preview-unclipped.patch

verified: Patched copy (:4553), same script. The stage now cuts the caption at the photo edge, exactly where the export does ('Summer'). The dashed selection box and handle still extend past the edge, so the caption can still be grabbed (cmp-edge-stage.png: live on the left, patched on the right). In the patched copy, npm test passes 539/539 and acceptance passes 17/17. git apply --check passes.

notes: Low: a what-you-see mismatch at the edges. Within draw(), the clip sits inside the existing save/restore. The editor's wipe clip is applied outside draw(), so the two intersect correctly. I did not test the reporter's Crop > Square variant separately; it is the same draw path. Nudging captions back inside on Crop commit is optional and not included. F6 shares captions.js with F5, in separate hunks.

## [low] removeText/heal-worker-inprocess-latch — refuted
**One failure of a respawned heal worker switches every later fill to the main thread for the rest of the session, with no timeout**
files: /home/user/elsewhere-quest/apps/gesso/ui/heal-client.js

notes: The flag semantics are loose. workerOk is per worker and is reset by drop(), which disagrees with the comment 'a worker that never answered couldn't load'. But the condition cannot be reached without injecting a fault. In the one realistic trigger (a worker script that will not load), falling back to in-process is the intended degradation: Remove keeps working, only with jank. The proposed fix would instead fail every fill with a toast for as long as workers keep failing to load. That is arguabl

reproduction: This rests on code-level analysis; I did not reproduce it. To hit the latch, a respawned worker must fire an 'error' or 'messageerror' event before it answers. workers/heal-worker.js runs all its work inside lib/heal.js handleHealMessage, which wraps every message in try/catch and returns {type:'error'} on any exception, including allocation RangeErrors and bad input (covered by the heal.test.mjs error cases). The client treats an 'error' message as an answer: the message listener sets workerOk 
