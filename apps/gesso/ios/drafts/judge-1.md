<!-- Draft produced by apps/gesso/design/workflows/gesso-ios-design.js on 2026-10-20 (run stopped after the Judge phase); raw agent output, exported verbatim. -->

# Judge 1 (an iOS platform engineer who has shipped WKWebView-hosted apps through App Review)

## winner

Design 2: native where it matters

## scores

### 1

#### title

Design 1: thinnest shell (gesso-app://app, one {op,args} bridge)

#### total

46

#### breakdown

##### fitsGoals

8

##### technicalSoundness

6

##### appStoreRisk

8

##### webAppUnchangedOnWeb

9

##### buildEffort

8

##### extensibilityToNative

7


#### strongest

The smallest correct surface: one scheme handler with issued-name xfer files (never base64 for photos), one op table where a new op is a dictionary entry, the decoded JPEG becomes the draft original so restore needs no Swift, an honest empty required-reason privacy manifest (no UserDefaults, no attributesOfItem), basedOnDependencyAnalysis:false so the web bundle is always fresh, and the least intrusive web diff (editor.js only gains an optional onChoosePhoto).

#### weakest

Its subject-lift hook is in the wrong place: it claims a tap in Outline is 'today a no-op dropped by TINY_PT2' and hooks finishTrace, but remove.js:211 routes 'tap' to tap() (spot heal) before the dial check and Light's traceGesture has no 'tap' case, so the hook never fires for a tap; and the Bridge sketch calls replyHandler from GCD/PhotoKit/Vision background queues, which WebKit completion handlers do not permit.

#### factualErrors

- Claims a tap in Remove > Outline is a no-op dropped by TINY_PT2 in finishTrace. Verified: remove.js:211-212 `case 'tap': return g.target === 'ring' ? true : tap(ed, g.x, g.y)` runs regardless of dial, so a tap heals a spot and never reaches startTrace/finishTrace; Light's traceGesture (light.js:305) has no 'tap' case. The hook must be a new 'tap' case in both onGesture paths (as Design 2 describes), not finishTrace.
- DecodeOps/SubjectOps/PhotosOps invoke the WKScriptMessageHandlerWithReply replyHandler from DispatchQueue.global, PHPhotoLibrary.performChanges and requestAuthorization completion queues. WebKit API completion handlers must be called on the main thread (its CompletionHandler is main-thread bound and the reply is marshalled to the web process from the UI process run loop); off-main calls are an assertion/crash risk. Fix: hop to main in Bridge before calling replyHandler (or use the async overload as Designs 2/3 do). Confidence: medium-high.
- States 'WebKit does not hand the request body to a scheme handler, so there is no POST path' at medium-high. Overstated: since iOS 11.3 (WebKit bug 179077) WKURLSchemeTask.request.httpBody is populated for fetch/XHR bodies that are strings or ArrayBuffers; what remains unreliable is httpBodyStream-backed bodies (Blob/FormData/file). A `fetch(url,{method:'POST', body: await blob.arrayBuffer()})` is a viable upload path that avoids the 16 MB base64 copy; it should be a probe row rather than ruled out. Confidence: medium.
- The `scrollView.delegate = self` line requires UIScrollViewDelegate conformance the class sketch does not declare (minor sketch omission).
- Expected cost of the stored original: the RAW import is stored as a q0.98 JPEG, so the exported JPEG is a second lossy generation; flagged as an open question but presented as the default for an artist's app.


### 2

#### title

Design 2: native where it matters (gesso://app, reply bridge + gessoFx channel)

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

The most accurate reading of the codebase and of WKWebView: it correctly identifies that a tap in Remove > Outline currently heals a spot and that Light has no tap case, hooks subject lift as a new 'tap' case through a shared ui/subject.js with the identical toSource matrix, sends the current analysis frame (stateless, crop-correct), stores the working-size PNG as the draft original so restore is bit-exact with no Swift and no draft.js change, marks saved only on PHPhotoLibrary success or a completed SaveToCameraRoll activity, offers Open Settings on denial, uses the async reply handler (main-actor safe), and plans the Metal heal engine and POST-body probe without committing to them.

#### weakest

It carries the most JS surface and refactoring of shipped code (commitOutline factoring in both tools, a hand-rolled marching-squares tracer with its own tests when VNDetectContoursRequest would do, three-call chunked uploads, templated copy in lib/image-io.js), and the XcodeGen build phase declares only sw.js as an input so edits to any other web file will not re-copy the bundle in incremental builds.

#### factualErrors

- States WKWebpagePreferences.isLockdownModeEnabled is 'iOS 16.3+'. It is iOS 17.0+ (WWDC23 API). Harmless here because the deployment target is 17.0.
- copy-web.sh build phase has inputFiles: [sw.js] / outputFiles: [web/index.html]; Xcode skips a script phase whose declared inputs and outputs are unchanged, and sw.js does not change when app.js or a tool changes (CACHE is stamped only by deploy.yml), so incremental Debug builds can ship a stale web bundle. Use basedOnDependencyAnalysis: false (as Design 1 does) or list the whole gesso tree as inputs.
- Declares NSPrivacyAccessedAPICategoryFileTimestamp C617.1 for the tmp purge; this is correct only if the purge reads modification dates. Enumerating and deleting by name needs no required-reason API, so the entry can be dropped for an honest empty list (as Design 1).
- `obs.instance(at:in:searchRadius:)` is written as if it were a VNInstanceMaskObservation method; it is not an API (the comment describes implementing it by sampling instanceMask). Not wrong, but the sketch reads as an API claim.


### 3

#### title

Design 3: ship-it angle (gesso://localhost, staging, drafts store, Settings bundle)

#### total

45

#### breakdown

##### fitsGoals

7

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

Best App Review preparation (review notes, 4.2 answer, name-availability check, TestFlight loop, ITSAppUsesNonExemptEncryption, no-SPA-fallback 404s, Accept-Ranges) and two sharp platform calls: hosting at `gesso://localhost` so WebKit treats the origin as potentially trustworthy (isSecureContext true, restoring navigator.clipboard/storage; the Capacitor precedent) and intercepting the click on #file itself, which covers all four picker call sites including editor.js:694 without touching editor.js.

#### weakest

Subject lift as written has no image to run on for ordinary photos: pickPhoto releases the _tmp copy after startDraft settles and only RAW originals are kept under drafts/, yet subjectMask runs Vision 'on the kept CGImage' or re-decodes from _tmp/drafts; for a JPEG/HEIC pick (the common case) the file is gone, and the mask is computed on the original rather than the current cropped/filled output. It also adds the most moving parts (drafts store with pruning, decoder marker in draft.js, Settings.bundle, Files picker, staging protocol, diagnostics counter) for 1.0.

#### factualErrors

- subjectMask depends on a Swift-side copy of the photo, but platform.pickPhoto/app.js release the _tmp file after autosave.startDraft settles and keepAs only applies to RAW; for web-decoded JPEG/HEIC picks no source remains for Vision. Needs either re-staging the blob from the draft or sending the analysis frame from JS as Designs 1/2 do.
- nativeSave marks the edit saved (showDone) when any share activity completes ('only a completed activity counts'), so an AirDrop or Messages share sets isSaved and suppresses the New-photo confirm although nothing is in Photos; Design 2's SaveToCameraRoll check is the truthful version.
- preBuildScripts declare inputFiles: [../gesso/sw.js] only, so Xcode's dependency analysis skips the sync when app.js or any tool changes without a sw.js edit; the comment 'sw.js changes with every shell edit' is false (only SHELL additions change it). Same fix as Design 2.
- Lists webView.isInspectable among reasons the floor must be iOS 17; it is iOS 16.4+. Over-conservative, not harmful.
- Secure-context claim for a localhost host under a custom scheme is marked [M]; WebKit's shouldTreatAsPotentiallyTrustworthy returns true for localhost/loopback hosts independent of scheme and Capacitor's capacitor://localhost relies on it, so [MH] is the fairer rating; it still should be a probe row.



## graftFromOthers

- From Design 3: host the origin at gesso://localhost (not gesso://app) so WebKit treats it as potentially trustworthy and isSecureContext is true, restoring navigator.clipboard and navigator.storage; keep it as a probe row and pin the constant before the first device run, since the origin can never change afterwards.
- From Design 3: replace the four-site openPicker rewiring with the single capture-phase click interceptor on #file (preventDefault cancels the chooser; the label-for path, the #choose keydown, askNewPhoto, Discard and editor.js:694 all end in a click on #file), which removes the editor.js onChoosePhoto option and the label 'for' removal.
- From Design 1: run the web-bundle copy phase with basedOnDependencyAnalysis: false instead of inputFiles: [sw.js], so incremental Debug builds never ship a stale web tree.
- From Design 1: keep the required-reason API list empty by deleting tmp files by name (no attributesOfItem/modification dates) and by not using UserDefaults in 1.0 (probe via a launch argument or DEBUG shake), so PrivacyInfo.xcprivacy declares nothing and App Privacy is 'Data Not Collected' without caveats.
- From Design 1 (and 3): use VNDetectContoursRequest on the thresholded mask (contrastAdjustment 1, detectsDarkOnLight false, maximumImageDimension 1024, flip y from Vision's bottom-left origin) instead of a hand-rolled marching-squares tracer; it removes ~80 lines and a test suite from step 8.
- From Design 1: serve xfer files via memory-mapped Data (.mappedIfSafe) with a Set of issued names as the only map from URL to path, and add a cheap clipboard.write op for the probe's Copy report.
- From Design 3: the review-notes paragraph, the day-one Xcode checklist, the App Store name-availability check, Accept-Ranges: none, and ITSAppUsesNonExemptEncryption false as the standing TestFlight hygiene.
- From Design 1: offer the owner a JPEG (q0.98, ~10-15 MB) or PNG (~40-70 MB) choice for the stored working-size original behind the same decode op; Design 2's PNG default is the lossless, artist-safe choice but the draft-size cost should be a stated decision.
- For all three: correct the POST-body fact before building the upload path. WKURLSchemeTask.request.httpBody has been delivered for string/ArrayBuffer bodies since iOS 11.3 (WebKit bug 179077); only Blob/FormData/stream bodies are unreliable. Probe with fetch(url,{method:'POST', body: await blob.arrayBuffer()}); if it arrives, the beginFile/appendFile/finishFile chunking collapses to one fetch.
