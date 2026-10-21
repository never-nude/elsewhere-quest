<!-- Draft produced by apps/gesso/design/workflows/gesso-ios-design.js on 2026-10-20 (run stopped after the Judge phase); raw agent output, exported verbatim. -->

# Judge 2 (the owner of the web app, who wants the web version unchanged and the native one to feel native)

## winner

Design 2: native where it matters (49/60), by a hair over Design 1 (48/60). As the owner: Design 1 is the web-side footprint I want and Design 2 is the native behaviour I want; Design 2 wins because its subject-lift hook, Vision input (the current output frame), lossless PNG replacement of a RAW, Open Settings on denial and truthful Save are what make the app feel native, and its one real build-script flaw is a one-line fix. The recommended build is Design 2's contract and web wiring on Design 1's skeleton, with the grafts below.

## scores

### 1

#### title

Design 1: thinnest shell (one WKWebView, one scheme handler, one {op,args} bridge)

#### total

48

#### breakdown

##### fitsGoals

8

##### technicalSoundness

7

##### appStoreRisk

8

##### webAppUnchangedOnWeb

9

##### buildEffort

9

##### extensibilityToNative

7


#### strongest

Smallest surface on both sides: 9 ops in one dispatch table, ~700 lines of Swift, ui/platform.js inert without the flag, nothing in lib/ touched; the scheme handler is the most correct of the three (live-task guard checked on main right before didReceive, mmap read, explicit 404, no SPA fallback, always-run bundle script); RAW import becomes a rendered working-size file stored as the draft original so restore needs no Swift and no draft-schema change; Swift is stateless for Vision (JS sends the current output frame, so it works after a restore and sees crops/fills).

#### weakest

The subject-lift hook is in the wrong place for Remove: remove.js:211-212 sends a tap to tap() (spot heal) before the dial is consulted, so the TINY_PT2 branch in finishTrace only fires for a tiny drag/hold loop, never a tap; the design claims a tap is 'today a no-op'. No Open Settings on a Photos denial. JPEG q0.98 as the stored original of a RAW is lossy (flagged as open question but PNG should be the default for an artist). The Swift fitWorkingSize port and JSON table are unnecessary work when JS can compute the fit and request exact w×h.

#### factualErrors

- remove.js: a quick tap in Outline mode is not a no-op; onGesture's case 'tap' runs tap(ed,x,y) (spot heal) regardless of dial, so the proposed hook under `if (areaPt < TINY_PT2)` in finishTrace never sees a tap (only drag-start/hold-start reach startTrace). The hook must be a `case 'tap'` guarded by `dial === 'outline'` in Remove and a `case 'tap'` in Light's traceGesture (as Design 2 has it).
- Claim that the fitWorkingSize port must be byte-identical for restore safety is overstated: fitWorkingSize returns scale 1 for any w*h ≤ cap and sides ≤ maxSide, so any decode at or under the cap restores exactly; computing the fit in JS (lib/image-io.js) and asking Swift for exact w×h removes the port and the JSON table test entirely.
- Importer edge: a native-rendered JPEG that createImageBitmap then rejects for memory goes back into decodeNatively, which throws NativeError('unsupported') because the JPEG File has no xferOf entry, so app.js's importFile sees err.unsupported and skips the 12 MP step-down (mislabels an OOM as an unsupported file).
- PHPickerConfiguration(photoLibrary: .shared()) is unnecessary for a no-permission picker; the plain PHPickerConfiguration() form is the one that guarantees no asset-identifier path and no prompt (not wrong, just a needless surface).


### 2

#### title

Design 2: native where it matters (SwiftUI shell + WKWebView + one promise bridge + gessoFx)

#### total

49

#### breakdown

##### fitsGoals

9

##### technicalSoundness

8

##### appStoreRisk

8

##### webAppUnchangedOnWeb

8

##### buildEffort

7

##### extensibilityToNative

9


#### strongest

Gets the native feel right where the owner will notice: the subject-lift hook is placed where the code actually routes a tap (remove.js case 'tap' when dial==='outline', light.js traceGesture gains case 'tap'), Vision runs on the same 1024 px analysis frame the lasso uses (so it sees the current crop/fills and works after a restore), the RAW original is replaced by an exact-size lossless sRGB PNG so restore is bit-exact on the plain web path with no draft-schema change, Photos denial gets Open Settings plus Share, Save marks saved only on a real PHPhotoLibrary result or a completed SaveToCameraRoll activity, and the haptic vocabulary is tied to specific code sites. It also leaves the clearest door open (reserved heal op, engines in ping, chunked putFile, P7 POST probe, insets/keyboard Swift→JS calls) and raises the iCloud-backup question nobody else did.

#### weakest

Carries more than the goals need: a hand-written marching-squares tracer (VNDetectContoursRequest does the job), a {v,id,method} envelope with late-reply-by-id handling that WKScriptMessageHandlerWithReply already makes redundant, a 3-call chunked upload for a 3-12 MB JPEG, and a larger web diff (lib/image-io.js signature change, lib/export-plan.js addition, new ui/subject.js, commitOutline refactors in both tools, SPEC edit). The copy-web build phase keyed on inputFiles:[sw.js] will not re-run when app.js alone changes, so incremental Simulator builds can run a stale bundle.

#### factualErrors

- project.yml 'Copy web app' phase uses inputFiles: [sw.js] / outputFiles: [web/index.html]; sw.js in the tree is not stamped per edit (deploy.yml stamps CACHE at deploy), so editing app.js or any ui/ file does not re-run the copy and the Simulator runs a stale bundle until a clean build. Needs basedOnDependencyAnalysis: false (or no input/output files).
- isLockdownModeEnabled set on cfg.defaultWebpagePreferences is likely a no-op; the documented place is the WKWebpagePreferences passed to decidePolicyFor(navigationAction:preferences:decisionHandler:), which the design also does, so the duplicate is harmless but misleading.
- The request envelope's id/late-reply logic is redundant: WKScriptMessageHandlerWithReply returns one promise per postMessage, so a late reply cannot be confused with another call; the JS timeout alone is enough.


### 3

#### title

Design 3: ship-it angle (SwiftUI shell, gesso://localhost, #file click interceptor, drafts dir + decoder marker)

#### total

46

#### breakdown

##### fitsGoals

8

##### technicalSoundness

7

##### appStoreRisk

9

##### webAppUnchangedOnWeb

8

##### buildEffort

6

##### extensibilityToNative

8


#### strongest

Two genuinely better technical calls and the best App Store section: gesso://localhost makes WebKit treat the origin as potentially trustworthy (host 'localhost' is secure regardless of scheme), so isSecureContext, navigator.clipboard/storage/share likely return without private API; one preventDefault on the #file input's click cancels the chooser for every call site (label-for, keydown, askNewPhoto, Discard and editor.js:694's programmatic click) with no editor.js API change; XCUITest stubs the picker/saver via launch args instead of hoping PHPicker's remote UI is reachable; and §0/§7.5 (review 4.2 rationale, notes, TestFlight loop, export compliance, name check, no file-timestamp APIs) is what a first submission actually needs.

#### weakest

Subject lift has a real hole: Swift analyses 'the CGImage decoded at pick time or re-decoded from _tmp/drafts', but _tmp is released after startDraft and drafts/ keeps only RAW originals, so after a relaunch of a JPEG/HEIC draft there is no image to analyse; and analysing the original ignores crop, rot90/flip and earlier fills. The RAW path adds a parallel Swift draft store (keepAs/pruneDrafts), a decoder marker in lib/draft.js and an autosave.js change, which Designs 1/2 avoid by storing the rendered working-size file. The streaming scheme handler has a stop/didReceive race, and the Settings.bundle, Files picker, diagnostics counter and OSLog channel are v1.1 scope.

#### factualErrors

- Subject lift image source: after release(file.nativeUrl) post-startDraft and with drafts/ holding only RAW originals, subjectMask({draftId}) has nothing to read for a restored non-RAW draft; the design never re-supplies the pixels (Designs 1/2 send the 1024 px output frame from JS).
- Scheme handler streaming: stillLive is checked on main via DispatchQueue.main.sync, then task.didReceive(chunk) is dispatched async; a stop arriving between the check and the dispatched block calls into a stopped WKURLSchemeTask (ObjC exception). Also fail(task, 404) in the guard runs on the background queue. The liveness check must happen on main immediately before each didReceive (as Design 1 does).
- 'inputFiles: [sw.js] — Xcode only re-runs when inputs change; sw.js changes with every shell edit' is false: sw.js is untouched by edits to app.js/ui/lib (CACHE is stamped by deploy.yml), so incremental builds ship a stale web bundle.
- Deployment-target rationale lists webView.isInspectable and WKWebpagePreferences.isLockdownModeEnabled as iOS 17 requirements; they are iOS 16.4 and 16.0 respectively (only VNGenerateForegroundInstanceMaskRequest needs 17). Harmless to the chosen target.
- SubjectLiftTests asserting a Vision foreground-mask result on the Simulator is unlikely to pass (the request commonly fails to create an inference context there); Designs 1/2 correctly treat it as device-only.



## graftFromOthers

- From Design 1: the single {op,args} -> {ok,...} dispatch table (drop Design 2's v/id envelope and late-reply logic; WKScriptMessageHandlerWithReply already gives one promise per call), the scheme handler shape (mmap read on an io queue, liveness checked on main right before didReceive/didFinish, Cache-Control: no-store, explicit 404, /gesso/ path prefix so relative URLs match elsewhere.quest), and basedOnDependencyAnalysis: false on the bundle-web script so every build re-copies apps/gesso.
- From Design 1: a single-shot base64 photos.save/share for the 3-12 MB export JPEG (one message, ~100 ms) instead of beginFile/appendFile/finishFile; keep Design 2's chunked putFile only as the future large-upload primitive behind the Metal/heal path.
- From Design 1: VNDetectContoursRequest (topLevelContours, normalizedPoints, y-flip) instead of a hand-written marching-squares tracer; keep Design 2's instance-under-finger selection and 'largest ring first'.
- From Design 3: host 'localhost' (gesso://localhost) so WebKit treats the origin as potentially trustworthy and isSecureContext is likely true; keep the pinned-origin unit test. Record the probe answer before relying on navigator.clipboard/share.
- From Design 3: the one capture-phase click interceptor on the #file input (preventDefault cancels the chooser; label-for, keydown, askNewPhoto, Discard and editor.js:694 all end in that click), which removes the onChoosePhoto editor option and the label 'for' removal.
- From Design 3: XCUITest launch-argument stubs for the picker and PhotoSaver (-GessoStubPicker/-GessoStubPhotos) rather than driving PHPicker's remote UI; and the WebAppSmokeTest that loads the real WKWebView + handler in the Simulator and runs ?probe=1 on day one of the shell.
- From Design 3: §0's ship table and §7.5 review notes (4.2 rationale, demo script, offline statement), ITSAppUsesNonExemptEncryption, export-options.plist, the build-number bump script and the App Store name check on day one.
- From Design 2 itself, keep: PNG (not JPEG) as the stored original for a natively decoded RAW; Open Settings on a Photos denial; markSaved only on saved:true or a completed SaveToCameraRoll activity; the iCloud-backup decision for Library/WebKit; probe rows P1-P7 (especially P7 POST-body, which decides whether chunked base64 ever matters).
