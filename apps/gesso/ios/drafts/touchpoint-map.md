<!-- Draft produced by apps/gesso/design/workflows/gesso-ios-design.js on 2026-10-20 (run stopped after the Judge phase); raw agent output, exported verbatim. -->

# Touchpoint map

Every place the web app touches the platform, as found by the Understand agent.

## touchpoints

### 1

#### id

T01-photo-picker

#### where

apps/gesso/index.html:80-82 (#choose label for=file), :111 (#file input accept=image/*); apps/gesso/app.js:95-105 (early-file keep + keyboard click), :133-139 (change -> importFile), :189-190 and :214 (fileInput.click() from askNewPhoto / Discard), :222-232 (a picked photo beats the restore); apps/gesso/ui/editor.js:694 (dock tap on the start screen clicks #file)

#### what

The only way a photo enters the app: a hidden <input type=file accept="image/*"> (single file, no capture attribute), opened by a <label for=file> (no JS needed) and by fileInput.click() from three code paths. The File object goes to importFile(file), which decodes it, calls editor.begin({info:{type,natW,natH,name:file.name}}) and autosave.startDraft(id, file) (the original Blob is what autosave stores and restores from).

#### todayOnWeb

iOS shows the Photo Library / Take Photo / Choose File sheet; Library picks are handed over as JPEG for most photos (SPEC §6: 'the picker transcodes'), HEIC originals sometimes, ProRAW as DNG. A photo picked while IndexedDB is still opening (up to 3 s) is parked in earlyFile. No permission prompt.

#### nativeOpportunity

Goal 1. PHPickerViewController (no photo-library permission, current representation, UTType.image) from a bridge call pickPhoto(). Swift writes the picked bytes to <tmp>/import/<uuid>.<ext> and replies with a URL on the app's custom scheme; JS fetches it into a File (keep file.name, the extension and a sensible type) and calls the existing importFile(file) (already exposed as window.gesso.importFile at app.js:289). One shim function should own 'open the picker' and be called from #choose, app.js:104/190/214 and editor.js:694; when not native it falls through to fileInput.click(). Optionally PHPicker in .ordered single-selection with filter .images; later: a Files secondary entry via UIDocumentPickerViewController.

#### risk

Missing one of the four fileInput.click() call sites leaves the web picker reachable under the native one. The label-for=file path opens the picker with no JS at all, so the native build must preventDefault on the label click (or remove the for attribute when native) or both pickers appear. Keep the earlyFile and picked()-beats-restore semantics (app.js:93-98, 222-232): a native pick that arrives before main() finishes has nowhere to go unless the shim queues it. PHPicker returns copies: a 48 MP HEIC is ~10 MB (fine), a ProRAW DNG 25-75 MB; never base64 those through the message bridge, always go through the scheme-served temp file, and delete the temp file after autosave.startDraft has stored the Blob (store.putBlob copies it into IndexedDB). PHPicker's loadFileRepresentation gives HEIC for HEIC originals, which createImageBitmap decodes on this device (probe PASS), so decode need not change for the common case.


### 2

#### id

T02-decode-and-failure-modes

#### where

apps/gesso/ui/importer.js:13-47 (decodeForEditing), :15-17 (sniff -> ImportError{unsupported}), :22-33 (header size -> createImageBitmap at working size, aspect retry), :35-41 (no header: full decode then shrink), :42-46 (TIFF failure -> 'RAW photo, which Safari can't open'); apps/gesso/lib/image-io.js:56-77 (sniffImageType), :79-86 (FRIENDLY messages), :97-107 (readImageInfo JPEG/PNG/HEIF size+orientation), :14-15/:23-42 (WORK_MAX_PIXELS 24.5 MP, fitWorkingSize); apps/gesso/app.js:148-163 (step-down to 12 MP on a failed decode/upload, persisted as localStorage gesso:workCap), :231-245 (restore must decode to exactly the stored {w,h})

#### what

Magic-byte sniff of the first 256 KB, then createImageBitmap(file,{resizeWidth,resizeHeight,resizeQuality:'high'}) at the working size with EXIF applied by WebKit; the bitmap is uploaded in sRGB strips by renderer.loadSource (ui/renderer.js:293-325). Failure modes: type 'raw'/'unknown' rejected up front; TIFF (which is what DNG/ProRAW sniff as) fails in createImageBitmap and becomes the RAW message; any other rejection (WebKit refusing to allocate) triggers one retry at 12 MP and a permanent cap step-down; lost GL context is treated separately.

#### todayOnWeb

JPEG/PNG/HEIC/WebP/GIF/AVIF/BMP/JXL decode; DNG/ProRAW/camera RAW cannot (message tells the user to pick 'the regular version'). 48 MP sources are downscaled to ~24.5 MP at decode (probe: 48.8 MP canvas OK, HEIC OK, EXIF OK).

#### nativeOpportunity

Goal 5. A decode bridge used only when the web path cannot: when sniff says 'tiff'/'unknown', or when createImageBitmap rejects (the catch at importer.js:42). Swift: CGImageSourceCreateWithURL on the temp file, CGImageSourceCreateThumbnailAtIndex with kCGImageSourceCreateThumbnailFromImageAlways, kCGImageSourceThumbnailMaxPixelSize = the long side fitWorkingSize would choose, kCGImageSourceCreateThumbnailWithTransform (applies orientation), then write an 8-bit sRGB PNG (or JPEG q=1) to tmp and reply with its scheme URL plus {natW,natH (oriented), w,h}; JS then createImageBitmap()s that PNG (no resize) and continues as today. ImageIO opens Apple ProRAW/DNG and most camera RAW on iOS 17+. Also lets a future 'full 48 MP' mode use native downscale quality.

#### risk

Restore re-decodes the ORIGINAL Blob (app.js:231) and the draft is unusable if the size differs by a pixel (app.js:241-244), so the native decoder must be chosen deterministically from the same inputs (type + cap) both at import and at restore, and must produce exactly fitWorkingSize(natW,natH,cap) dimensions; store a 'decoder' marker in draft info (lib/draft.js:71-88 keeps info as an opaque object, reviveInfo at :160-170 only keeps type/natW/natH/name, so a new field needs adding there). Colour: hand over an 8-bit sRGB-tagged PNG, not raw RGBA, so the strip canvas's colour management still applies; ProRAW is linear/wide gamut and a naive decode will look flat. The FRIENDLY copy says 'Safari can't open' (image-io.js:80) and app.js:89 says 'this browser' — wrong words in the App Store build. Native decode of a 48 MP DNG costs 0.5-2 s and 200+ MB in the app process, outside the WebContent process's budget (that is a plus), but the temp PNG can be 60+ MB; prefer JPEG q=0.98 or delete promptly.


### 3

#### id

T03-save-to-photos-share

#### where

apps/gesso/ui/savesheet.js:143-167 (onShareClick: File from blob, shareRoute, navigator.share synchronously in the tap), :169-182 (settleShare: resolved => showDone, AbortError => nothing, else fallback), :184-191 (showDone: localStorage gesso:savedOnce, ed.markSaved()), :76-98 (ensureJob: encode starts when the sheet opens); apps/gesso/lib/export-plan.js:124-134 (shareRoute), :139-143 (shareOutcome); apps/gesso/index.html:127-138 (sheet copy: 'Save to Photos' button, 'Next, tap Save Image.', 'Done. If you tapped Save Image, it's the newest photo in Photos.'); apps/gesso/lib/image-io.js:373-378 (exportFileName gesso-YYYYMMDD-HHMMSS.jpg); apps/gesso/ui/editor.js:699-713 (Save waits for pending fills, then onSave), :740-745 (markSaved/isSaved), :104/:167 ('Saved' status)

#### what

Save renders a full-size JPEG (worker), then the sheet's primary button calls navigator.share({files:[File]}) inside the click handler (no await before it). A resolved promise is treated as 'saved' even though iOS resolves for Copy/Save to Files/AirDrop too; the coach line tells the user to tap Save Image in the share sheet.

#### todayOnWeb

Probe: share with files OK on this iPhone. Two-step dance (sheet -> iOS share sheet -> Save Image). 'Saved' status and the New-photo confirm skip rely on an inferred success.

#### nativeOpportunity

Goal 1. Bridge saveToPhotos(jpeg) -> Swift PHPhotoLibrary.requestAuthorization(for: .addOnly) + performChanges { PHAssetCreationRequest.forAsset().addResource(with: .photo, data:, options: originalFilename = exportFileName) } and reply {ok, error}. The sheet's primary becomes a real 'Save to Photos' with a real result (markSaved only on ok, 'Saved to Photos.' copy, no coach line), plus a secondary 'Share…' -> UIActivityViewController with the temp file URL (gives Files, AirDrop, Messages). Transfer: the JPEG is 3-12 MB; base64 through WKScriptMessageHandlerWithReply is acceptable (one copy, ~16 MB string), or write via a second message channel in chunks; keep the sheet's abort/cancel semantics (closing before the blob is ready aborts the export, savesheet.js:101-106, 222-241).

#### risk

If the native flag is missed, shareRoute sees navigator.share (present in recent WKWebView; whether files share works there is unverified) and the old dance runs. markSaved on anything but a confirmed PHPhotoLibrary success recreates today's false 'Saved' (which also makes New photo skip the 'This edit isn't in Photos yet' confirm, app.js:188). The add-only permission prompt appears on first save; a denied state must map to the fallback share sheet, not a dead button. Photos stamps the asset's creation date as now and strips nothing (the JPEG already has no EXIF). PHPhotoLibrary writes are async and can take a second for 24 MP; keep the button disabled (sharing guard, savesheet.js:40/:164) until the reply.


### 4

#### id

T04-longpress-fallback

#### where

apps/gesso/ui/savesheet.js:197-218 (showFallback/hideFallback: object URL into #fallback-img with -webkit-touch-callout default), :152-156 (fallback when shareRoute says so), :177-180 (fallback after a share failure); apps/gesso/index.html:143-147; apps/gesso/styles.css:735-739

#### what

When Web Share is unavailable or fails: a full-screen <img> of the JPEG and the instruction 'Touch and hold the picture, then tap Save to Photos', relying on WebKit's image callout.

#### todayOnWeb

Only reached on browsers without file sharing (desktop, older WebKit).

#### nativeOpportunity

Never show it natively: both branches (shareRoute 'fallback' and shareOutcome 'failed') should route to the native share sheet (UIActivityViewController) when the PHPhotoLibrary path fails. Keep the DOM and code for the web.

#### risk

WKWebView's long-press image menu is not guaranteed to offer Save to Photos (it depends on allowsLinkPreview and the app's context-menu configuration), so a native user who lands here has no way out except Close. Also the <img> path displays the JPEG through WebKit's image decoder at full size (ui memory) — harmless but wasteful.


### 5

#### id

T05-export-worker

#### where

apps/gesso/ui/exporter.js:27 (WORKER_URL = new URL('../workers/export-worker.js', import.meta.url)), :155-157 (workerEncodes: Worker + OffscreenCanvas), :159-199 (encodeInWorker, 30 s timeout, buffer handed back on failure), :201-219 (main-thread canvas.toBlob fallback after a painted frame), :221-225 (assert image/jpeg); apps/gesso/workers/export-worker.js:13-40

#### what

The 100 MB RGBA export buffer is transferred to a module worker that encodes JPEG with OffscreenCanvas.convertToBlob; failures fall back to main-thread toBlob.

#### todayOnWeb

Probe: module worker + OffscreenCanvas JPEG OK. ~1 s per 24 MP encode off the main thread.

#### nativeOpportunity

None required; keep as is. The custom-scheme handler must serve workers/*.js with text/javascript so new Worker(url,{type:'module'}) works from the scheme origin (dedicated and module workers load from WKURLSchemeHandler; service workers do not). A native ImageIO encode is not worth it: the pixel buffer would have to cross the bridge.

#### risk

If worker construction or module loading fails under the scheme, every save silently takes the main-thread path (UI frozen ~1-2 s with 'Preparing…' painted first) — acceptable but should be verified in the probe (workerJpeg uses a blob: URL worker, which is a different code path from a scheme-served module worker; add a probe row that loads ../workers/export-worker.js itself). Memory: the WebContent process holds the 100 MB buffer plus the worker's OffscreenCanvas; same budget as Safari (SPEC §5.4 ~560 MB peak).


### 6

#### id

T06-heal-worker

#### where

apps/gesso/ui/heal-client.js:29 (url = new URL('../workers/heal-worker.js', import.meta.url)), :50-78 (spawn; a worker that never answered => inProcess), :81-88 (runHere: dynamic import('../lib/heal.js') on the main thread), :136-142 (warm() on Remove open, ui/tools/remove.js:105); apps/gesso/workers/heal-worker.js:12-17

#### what

PatchMatch/heal/seam solves run in a module worker with transferred buffers; if the worker cannot start or crashes before its first answer, everything runs in-process on the main thread.

#### todayOnWeb

Works; warm() preloads the worker when Remove opens.

#### nativeOpportunity

None needed. Same scheme-handler MIME requirement as T05. (Vision subject lift is a separate native call, see outlineMaskPath; it does not replace the heal worker.)

#### risk

A slow scheme handler on first load delays the first heal; a load error flips inProcess permanently for the session and a 20 s fill then freezes the UI and the shimmer (remove.js:983-997). The dynamic import at heal-client.js:82 is another scheme-served module fetch.


### 7

#### id

T07-service-worker

#### where

apps/gesso/app.js:275-281 (register('./sw.js') unless file:, update() on visible); apps/gesso/sw.js:6 (CACHE stamped by deploy), :7-70 (SHELL precache list), :74-81 (install), :83-90 (activate: delete only gesso-*), :95-104 (cache-first fetch); apps/gesso/test/sw-shell.test.mjs:28-33 (every file under lib/, ui/, workers/ must be in SHELL), :57-73 (every import of a shell module must be in SHELL); .github/workflows/deploy.yml:33-42 (copies apps/gesso minus test/e2e/design/SPEC and stamps CACHE)

#### what

Offline shell for the PWA. The node test suite fails if a module exists on disk but is not listed in SHELL.

#### todayOnWeb

Required for offline use after Add to Home Screen; register() failures are swallowed.

#### nativeOpportunity

Goal 6 (offline, no network). Skip registration entirely when the native flag is present (and SW is unavailable under a custom scheme anyway: WKWebView only exposes service workers for App-Bound Domains over https). The app bundle IS the shell: the Xcode copy-files phase should mirror deploy.yml:35-37 (copy apps/gesso, drop test/, e2e/, design/, SPEC.md, package.json). No fetch() exists anywhere in the app (grep), so with SW off the only network-shaped requests are the scheme handler's.

#### risk

Any new module added for the bridge (e.g. ui/native.js) must be added to SHELL or npm test fails and the web PWA's offline install breaks (sw-shell test :28-33). A bundle that forgets a file fails at runtime on the device with a scheme 404 — add a bundle-manifest check (same list as SHELL) to the Xcode build. Leaving register() running natively is harmless (rejects) but noisy.


### 8

#### id

T08-install-line-and-standalone-sniff

#### where

apps/gesso/app.js:266-273 (standalone = matchMedia('(display-mode: standalone)') || navigator.standalone; show #install unless standalone or localStorage gesso:hideInstall; Hide button); apps/gesso/index.html:83 (#install 'To use offline: Share → Add to Home Screen'), :8-11 (apple-mobile-web-app-* metas), :14-16 (icons, apple-touch-icon, manifest); apps/gesso/manifest.webmanifest:1-17; apps/gesso/ui/probe.js:417-420 (Display mode row); apps/gesso/lib/hints.js (no install hint exists in the earned-hints table; the install line is static HTML)

#### what

The only platform sniffing in the app: standalone detection to hide the install instruction. No UA sniffing anywhere.

#### todayOnWeb

In a Safari tab the line shows; in the Home Screen app it is hidden.

#### nativeOpportunity

Native detection via an injected flag (WKUserScript, injectionTime .atDocumentStart, forMainFrameOnly) e.g. window.__gessoNative = {version, insets?}; app.js:269 becomes `if (!standalone && !hideInstall && !native)`. The manifest/apple metas are harmless in the bundle. Launch screen + app icon come from the native project (icon.svg 'Pigment Wheel', ground #0d0c0b).

#### risk

In WKWebView display-mode is 'browser' and navigator.standalone is undefined, so without the flag the App Store build shows 'Share → Add to Home Screen' on its start screen — a review-visible defect. The flag must be injected at document start in the page world (not an isolated content world) and before app.js (a module script) evaluates; both hold for .atDocumentStart.


### 9

#### id

T09-probe-page

#### where

apps/gesso/app.js:23 (URLSearchParams), :38-39 (?probe=1 loads ui/probe.js instead of main()); apps/gesso/ui/probe.js:23-44 (CHECKS), :56/:76 (navigator.userAgent), :82-103 (Copy report: navigator.clipboard.writeText with execCommand fallback), :307-315 (Share files), :317-324 (Storage persist()), :326-331 (estimate), :333-355 (IndexedDB Blob), :357-391 (module worker + OffscreenCanvas via a blob: URL), :417-420 (Display mode), :422-435 (screen/visualViewport, safe-area env()), :437-442 (working cap), :444-465 (48 MP canvas); window.gessoProbe at :107

#### what

Device diagnostics page, not linked from the app; writes a plain-text report to the clipboard.

#### todayOnWeb

Run on the 17 Pro 2026-10-20: all platform facts in the task come from it.

#### nativeOpportunity

Keep it reachable natively (Swift loads <scheme>://…/gesso/?probe=1 from a debug gesture or Settings bundle toggle). Add rows: native flag + bridge version, location.origin and isSecureContext, serviceWorker presence, a worker loaded from the scheme (not a blob URL), env() insets as the web view sees them, visualViewport behaviour with the keyboard, navigator.share presence. Hide or relabel the install-specific rows ('Display mode', 'Storage persist()' text about 7-day clearing).

#### risk

navigator.clipboard requires a secure context; a custom scheme is probably not one (medium confidence), so the execCommand fallback path will run — fine, but confirm. The 48 MP canvas check allocates ~190 MB inside the WebContent process; it is the last check for a reason.


### 10

#### id

T10-indexeddb-persist

#### where

apps/gesso/ui/store.js:40-55 (openStore: persist() answer recorded, IDB open with 3 s timeout, memory fallback), :58-66 (navigator.storage.persist with 1 s timeout), :76-111 (openDb), :115-123 (write probe), :140-276 (idbStore: reconnect on 'Connection to Indexed Database server lost', Blob-as-bytes fallback :216-228), :292-318 (memoryStore); apps/gesso/app.js:107-108 ('Edits won't be kept if you leave Gesso.' when unavailable); apps/gesso/ui/autosave.js:184-241 (startDraft stores the original Blob; QuotaExceeded handling :213-218), :243-263 (tiles), :265-329 (loadDraft), :72-78 ('This iPhone is out of space' toast)

#### what

IndexedDB 'gesso' (blobs/docs/meta) holds the original photo, the Remove tiles and the history; everything is primary-key access with reconnect logic; persist() is requested every launch.

#### todayOnWeb

Probe: IndexedDB Blob OK; persist NOT granted in a Safari tab (7-day eviction risk for a site not added to Home Screen); the installed app has separate storage.

#### nativeOpportunity

Goal 3. WKWebViewConfiguration.websiteDataStore = .default() (persistent, app-owned, lives in the app container, removed only with the app) and a fixed custom-scheme origin give durable storage; Safari's 7-day script-storage cap is tied to Safari browsing, not an app's own web view (medium-high confidence). navigator.storage is [SecureContext] so persist() will likely be undefined under the scheme — store.js:60 already returns false then; drop the 'Storage persist' concern from the product story. Optionally expose nothing more; the IDB code stays byte-for-byte.

#### risk

Using .nonPersistent() by mistake (or a different data store per launch) makes every relaunch lose the draft. Changing the scheme name or host later changes the origin and silently orphans the database (and localStorage) — pin 'gesso-app://app' (or whatever) forever and never serve the app from two origins (e.g. file:// for a splash). WKWebView also drops the IDB server connection in the background (the reconnect path at store.js:18-20/:195-205 handles it). iOS can still kill the WebContent process under pressure: the 300 ms debounced write plus the flush hooks (T12) bound the loss.


### 11

#### id

T11-localstorage-keys

#### where

apps/gesso/app.js:25-31 (gesso:workCap), :268-272 (gesso:hideInstall); apps/gesso/ui/savesheet.js:30, :185, :194 (gesso:savedOnce); apps/gesso/lib/hints.js:31-32 and apps/gesso/ui/hints-ui.js:114-136 (gesso:hints, gesso:photoDrag); apps/gesso/ui/tools/dials.js:18-22 (gesso:photoDrag read/write); apps/gesso/ui/autosave.js:161-167 and apps/gesso/ui/probe.js:437-442 (workCap read)

#### what

Small per-device preferences and the memory step-down cap, all behind try/catch.

#### todayOnWeb

Shared with other apps on the elsewhere.quest origin by prefix; survives in the installed app.

#### nativeOpportunity

Works unchanged in the default data store. The working cap could instead be seeded from ProcessInfo.physicalMemory via the injected flag (e.g. 12 MP on 4 GB devices) rather than learned by failing once.

#### risk

Only cosmetic on an origin change (hints replay, coach line returns, cap resets). gesso:workCap persisting a step-down from a one-off pressure event is a pre-existing web behaviour; a native 'reset working size' switch in Settings would be cheap.


### 12

#### id

T12-lifecycle-flush

#### where

apps/gesso/app.js:284-287 (visibilitychange hidden and pagehide => editor.commitTyping() + autosave.flush()); apps/gesso/ui/autosave.js:377-380 (flush: synchronous write() then settle()), :80-141 (write builds the record and opens the IDB transaction synchronously so a freeze does not lose it); apps/gesso/ui/tape.js:73 (tape ends on hidden); apps/gesso/ui/tools/text.js:482-486 (keyboard dismiss/background blur => Done)

#### what

Best-effort flush of the draft and of a caption being typed when the page is hidden.

#### todayOnWeb

Safari fires visibilitychange on background and pagehide on close; the debounced write (300 ms) covers everything else.

#### nativeOpportunity

Expose window.gesso.flush() (= commitTyping + autosave.flush) and have Swift call evaluateJavaScript on scenePhase .inactive/.background (UIApplication.willResignActive) and on the memory-warning notification; also implement webViewWebContentProcessDidTerminate -> webView.reload() so a jetsam'd content process comes back to the restore path (autosave restores, toast 'Restored your last edit').

#### risk

pagehide may never fire in WKWebView before the content process is terminated; visibilitychange does fire when the view is hidden/app backgrounded, but relying on only one of them is the same bet as today. Without the terminate handler the user returns to a blank web view. Calling flush() through the bridge before main() has set window.gesso throws in Swift's completion — guard it.


### 13

#### id

T13-scheme-handler-reload-and-mime

#### where

apps/gesso/app.js:64 and :80 (location.reload() after a lost GL context / failed re-decode); apps/gesso/ui/renderer.js:150-159 (webglcontextlost/restored); apps/gesso/index.html:14-18 and :150 (icon.svg, manifest, styles.css, ui/tape.css, module script app.js); apps/gesso/ui/tape.js:228 (tape.css via new URL(import.meta.url)); every import in lib/ ui/ workers/ (relative module specifiers)

#### what

The whole app is relative ES modules, two module workers, two stylesheets, SVG/PNG icons and a manifest, loaded relative to the page URL; the page reloads itself after an unrecoverable GL loss.

#### todayOnWeb

Served by GitHub Pages / the python server with standard MIME types; SW makes it offline.

#### nativeOpportunity

WKURLSchemeHandler serving the bundled apps/gesso directory at a stable origin: map a directory URL (…/gesso/ and …/gesso/?probe=1) to index.html, set Content-Type by extension (.js text/javascript — module scripts are MIME-strict, .mjs too, .css text/css, .svg image/svg+xml, .webmanifest application/manifest+json, .png image/png, .html text/html; charset=utf-8), ignore the query string, 404 cleanly otherwise, and also serve the temp import/export files (Range support optional; whole-file is fine at 10-70 MB but stream rather than Data(contentsOf:) for RAW). location.reload() then just re-requests index.html.

#### risk

file:// instead of a scheme gives an opaque origin: IndexedDB may be unavailable, module workers and new URL(import.meta.url) fetches fail, localStorage is per-file. A wrong .js MIME blocks every module (blank page, no message). Serving index.html for unknown paths (SPA-style) would mask bundle omissions; prefer explicit 404s plus the manifest check from T07. Keep the scheme host fixed (T10).


### 14

#### id

T14-window-gesso-bridge-surface

#### where

apps/gesso/app.js:289 (window.gesso = { editor, renderer, importFile } set at the END of main()); apps/gesso/ui/probe.js:107 (window.gessoProbe); apps/gesso/design/scripts (Playwright drives the app through window.gesso)

#### what

The only global the app publishes; used by the probe, e2e and the design scripts.

#### todayOnWeb

Set after store open + editor creation; absent on the probe page and until main() completes.

#### nativeOpportunity

Make it the JS side of the bridge: add flush(), pickPhoto()/onPickedFile(url), setInsets?, and a 'native' namespace that wraps window.webkit.messageHandlers.gesso.postMessage (WKScriptMessageHandlerWithReply gives a Promise per call; a second non-reply handler for fire-and-forget haptics). Swift calls into the page only through evaluateJavaScript('window.gesso.…').

#### risk

Any Swift call before main() finishes (store open can take up to 3 s; GL probe can fail) hits undefined; the shim must queue or no-op. window.webkit.messageHandlers is only defined in the main frame page world when handlers are registered — the web build must feature-detect it (never throw) so the elsewhere.quest build is unchanged.


### 15

#### id

T15-native-detection

#### where

apps/gesso/app.js:266 (the only environment sniff: display-mode/standalone); apps/gesso/ui/ruler-view.js:229 (matchMedia prefers-reduced-motion); apps/gesso/ui/probe.js:56,76 (navigator.userAgent displayed only). No userAgent/platform/vendor checks exist in the app.

#### what

Confirms there is nothing UA-based to break; detection is a design decision not a retrofit.

#### todayOnWeb

n/a

#### nativeOpportunity

One injected global at document start (T08) checked in exactly one module (e.g. ui/platform.js exporting isNative, pickPhoto, saveToPhotos, share, decode, haptic, subjectMask with web fallbacks) so app.js, savesheet.js, importer.js and the tools import a seam rather than sniff.

#### risk

Setting WKWebView.customUserAgent to look like Safari is unnecessary (nothing sniffs) and would only confuse the probe report; leave the default UA (it lacks 'Safari/' — irrelevant).


### 16

#### id

T16-viewport-safe-area-keyboard

#### where

apps/gesso/index.html:5 (viewport-fit=cover), :8-10 (black-translucent status bar meta), :117-120 (#editbar); apps/gesso/styles.css:22-25 (--safe-top: max(env(safe-area-inset-top),24px), --safe-bottom/left/right), :36-49 (html/body height 100%, overflow hidden, overscroll-behavior none, user-select none, touch-callout none), :58 (button touch-action manipulation), :124-130 (stage touch-action none), :646-676 (.editbar position:fixed top set from JS; input 17px so iOS won't zoom); apps/gesso/app.js:33-36 (document gesturestart/change/end preventDefault); apps/gesso/ui/editor.js:532-554 (pointer events with setPointerCapture and getCoalescedEvents; touchstart preventDefault), :720-721 (window resize + ResizeObserver re-fit), :403-408 (devicePixelRatio for the GL canvas); apps/gesso/ui/tools/text.js:491-493 (visualViewport resize/scroll + window resize -> place), :503 (focus() inside the tap), :516 (scrollTo(0,0) after the keyboard), :532-551 (place: editBarTop from visualViewport.offsetTop/height, stage slide via stageShift); apps/gesso/lib/caption-edit.js:19 (KEYBOARD_MIN 120), :143-159 (editBarTop, isKeyboardUp, stageShift)

#### what

Full-bleed fixed layout relying on env() insets, document-level pinch suppression, Pointer Events on the stage, and a keyboard-aware caption edit bar driven by visualViewport.

#### todayOnWeb

Probe: screen 402x874 @3x, safe-area insets reported, coalesced events OK. Works in Safari tab and standalone (SPEC §6 notes 100vh and inset-top quirks).

#### nativeOpportunity

Lay the WKWebView edge-to-edge (SwiftUI .ignoresSafeArea(), webView.scrollView.contentInsetAdjustmentBehavior = .never, isScrollEnabled = false, bounces = false) so env(safe-area-inset-*) comes from the web view's own safeAreaInsets (WebKit populates env() in WKWebView when viewport-fit=cover and the view extends under the bars — medium-high confidence); status bar light content; set preferredContentMode .mobile; set the web view's backgroundColor/underPageBackgroundColor to #0d0c0b so insets never flash white. Keyboard: keep the visualViewport code (WKWebView adjusts the visual viewport for the keyboard on modern iOS — medium confidence, must be checked on device with the probe row from T09); if it does not, Swift can observe UIResponder.keyboardWillChangeFrameNotification and call a bridge setKeyboardInset(px) that text.js uses in place of visualViewport.

#### risk

Double insets if SwiftUI also pads the safe area (topbar pushed down ~59 pt twice). If visualViewport does not shrink in WKWebView, isKeyboardUp stays false and the edit bar is placed at the bottom under the keyboard; the caption stays hidden. WKWebView may scroll the page to reveal the focused textarea (text.js:516 resets scroll, but with isScrollEnabled=false it may instead clip). WKWebView's scrollView pinch is separate from the page's gesturestart handling; disable it or the page zooms behind the editor. preserveDrawingBuffer/GL behaviour is identical (same WebKit).


### 17

#### id

T17-new-photo-confirm-flow

#### where

apps/gesso/app.js:187-193 (askNewPhoto: picker directly when nothing to lose, else openTool('confirm')), :194-216 (confirm tool: 'Save first' clicks #save, 'Discard edit' = autosave.discard() + fileInput.click(), 'Keep editing'), :217 (#new-photo click); apps/gesso/ui/savesheet.js:366-371 (sheet 'New photo' after Done: job = null, ed.newPhoto()); apps/gesso/ui/editor.js:745 (isSaved), :104 (inPhotos: current state === state last saved); apps/gesso/ui/autosave.js:331-359 (discard keeps on-screen blobs until the next photo lands)

#### what

Guard against losing an unsaved edit; discard then opens the picker; 'Save first' re-enters the Save sheet.

#### todayOnWeb

'Save first' and the confirm text 'This edit isn't in Photos yet.' depend on the inferred share success.

#### nativeOpportunity

Unchanged, except the picker opens through the shim (T01) and isSaved now reflects a real PHPhotoLibrary result (T03), so the confirm is finally truthful. A native 'Save first' could even chain save -> picker.

#### risk

A cancelled native picker after 'Discard edit' must behave like today's cancelled file dialog: the draft is re-created on the next write (autosave.js:90-94); the shim must not call anything on cancel. If the native save resolves ok but the sheet is already closed (user swiped), showDone's session check (savesheet.js:171) drops the markSaved — keep that ordering.


### 18

#### id

T18-haptics-moments

#### where

SPEC.md §6 'No haptics' line (every confirmation is visual); apps/gesso/ui/ruler-view.js (ruler detents/ticks from lib/ruler.js stepValue `ticked`); apps/gesso/ui/editor.js commit()/openTool()/closeTool() (Done/Cancel) and :699-713 (Save); apps/gesso/ui/tools/remove.js:824-849 (land: a fill lands), :396-428 (Outline lift); apps/gesso/ui/tools/light.js:379-410 (Outline lift), :426-458 (Amount ruler release); apps/gesso/ui/tools/text.js (snapPosition guides from lib/text-layout.js); apps/gesso/ui/savesheet.js:184-191 (showDone)

#### what

The places that currently flash, snap or toast are the natural haptic moments; navigator.vibrate is absent on iOS so nothing exists today.

#### todayOnWeb

Visual only.

#### nativeOpportunity

Goal 4. A fire-and-forget message handler haptic(kind): 'tick' (UISelectionFeedbackGenerator) on ruler detents and chip changes, 'light' impact on snap guides and Outline anchor/lift, 'success' notification on Save to Photos ok and on a fill landing, 'warning' on 'Couldn't remove that'. Generators prepared once in Swift. Web build: no-op.

#### risk

Ruler ticks can fire per coalesced move; posting a message per tick floods the bridge and lands late — throttle in JS (≥50 ms) and never await the call on the stroke path. Haptics on every undo/redo would be noisy; pick the few moments above. Respect UIAccessibility reduce-motion/haptics settings? (iOS has no global haptics-off for apps; keep an in-app switch later).


### 19

#### id

T19-memory-and-working-size

#### where

apps/gesso/lib/image-io.js:14-15 (24.5 MP cap, 12 MP fallback), :23-42; apps/gesso/app.js:25-31, :148-163 (step-down); SPEC.md §5.4 (900 MB ledger, ~560 MB export peak); apps/gesso/ui/renderer.js:293-325 (two mipmapped RGBA8 copies at working size); apps/gesso/ui/exporter.js:80 (100 MB export buffer)

#### what

The memory policy assumes Safari's WebContent jetsam limits.

#### todayOnWeb

Tuned on the 17 Pro (48.8 MP canvas OK).

#### nativeOpportunity

The WebContent process behind a WKWebView has limits of the same order as Safari's (same WebKit), and the host app's own allocations (Vision, ImageIO decode) live in a separate process budget — a plus. Swift can pass physicalMemory so the web picks 12 MP on 4 GB devices up front, and can observe memory warnings to trigger a flush (T12).

#### risk

If the native build ever renders the web view inside a SwiftUI hierarchy that snapshots it (e.g. a Material or a transition), the GL canvas gets copied; keep the web view plain. Medium confidence on parity of the content-process limit: verify with the probe's 48 MP row and a real 48 MP import before shipping.


### 20

#### id

T20-lockdown-webgl-message

#### where

apps/gesso/app.js:88-91 ('Gesso needs WebGL, which this browser (or Lockdown Mode) has turned off.'); apps/gesso/ui/renderer.js:99-109 (webgl2 context request)

#### what

Start-up gate on WebGL2.

#### todayOnWeb

Lockdown Mode disables WebGL in Safari and in in-app web views.

#### nativeOpportunity

WKWebpagePreferences.isLockdownModeEnabled can be set to false by an app for its own content (iOS 16.3+; medium confidence) so the editor keeps working for Lockdown users; otherwise reword the message for the app.

#### risk

Copy says 'this browser'. If lockdown cannot be disabled, the App Store build has a hard failure mode that review may hit.


### 21

#### id

T21-offline-privacy-manifest

#### where

apps/gesso/README.md:78-88 (honesty clauses: nothing uploaded); apps/gesso/index.html:12, :71 ('Everything stays on this iPhone.'); grep: no fetch(), no XMLHttpRequest, no external URLs anywhere in app.js/ui/lib/workers; only sw.js fetches (own origin)

#### what

The product story is already true in code: the only network activity is the SW shell fetch.

#### todayOnWeb

GitHub Pages serves the shell; nothing else leaves the device.

#### nativeOpportunity

Goal 6. PrivacyInfo.xcprivacy with no collected data types and no tracking; declare the required-reason APIs actually used (UserDefaults if any, file timestamp APIs if the scheme handler stats files). NSPhotoLibraryAddUsageDescription for save; no NSPhotoLibraryUsageDescription needed with PHPicker. No ATS exceptions. A 'no network' CSP could even be injected via the scheme handler's index.html response headers (Content-Security-Policy: default-src <scheme>: ; connect-src 'none') as belt-and-braces.

#### risk

A CSP that blocks blob: or data: breaks the long-press fallback (object URL) and the shimmer's SVG data URL mask (remove.js:1022-1026) and the probe's blob: worker — allow blob: and data: for img/worker/style.


### 22

#### id

T22-tests-and-harness

#### where

apps/gesso/package.json (npm test = node --test; e2e Playwright); apps/gesso/test/sw-shell.test.mjs:28-33, :57-73; apps/gesso/e2e/README.md (Chromium + SwiftShader, DPR 3, safe areas emulated); apps/gesso/design/workflows/README.md (serve from apps/ on 4174; global Playwright)

#### what

Pure-lib node tests plus a Playwright acceptance run; nothing native-aware.

#### todayOnWeb

Green on this branch per design notes (sw-shell enforces SHELL).

#### nativeOpportunity

Add a node test for the platform seam (web fallback when window.webkit is absent; message shapes when a fake handler is present) and a Playwright variant that injects the native flag + a stub messageHandlers to run the e2e checks in 'native mode'.

#### risk

Adding ui/native.js without updating sw.js SHELL breaks npm test; adding any import of a browser-only global at module top level breaks the node tests for lib/.



## outlineMaskPath

On this branch (claude/gesso-ios, which already carries the Outline commit 9b46f42) the lasso polygon reaches the GPU through two narrow funnels, and a Vision mask can enter at either the polygon level (no pipeline changes) or the raster level (one new shape kind). Both paths, with exact functions:

REMOVE TODAY (apps/gesso/ui/tools/remove.js). finishTrace(ed, t) (:396-428): poly = lasso.end() (closed polygon, ANALYSIS px of ed.readOutput({maxSide:1024, tone:false})); toSource = multiply(outputToSource(st.crop, st.source.w, st.source.h), [1/kx,0,0,1/ky,0,0]) (:412); polyS = Float32Array.from(polygonRecord(transformPolygon(poly, toSource))) (:415, SOURCE px rounded to 0.1 px so replays rasterise identically); box = outlineBox(polyS, W, H) (lib/remove-plan.js:233-236 = polygonBounds(poly,1,{width:W,height:H,pad:DILATE_PX=2}) as {x,y,w,h}); exceedsAreaCap(box, W, H) (lib/heal.js AREA_CAP 0.20 -> CAP_TIP 'Big area. Do it in smaller pieces.'); job = { kind:'outline', poly: polyS, seed:1, attempt:0 } (:424); enqueue(ed, job, gen => fillOutline(ed, job, gen)) (:425, :852-881). fillOutline (:765-769) -> rubTile(ed, rec) (:774-800), which never looks at pts/poly directly: it calls shapeBox(rec, W, H) (:499-501) and shapeMask(rec, rect, w, h, kx, ky, bleed) (:503-506); for a poly those are outlineBox and outlineMask(poly, rect, w, h, kx, ky, bleed) (lib/remove-plan.js:242-251: transformPolygon into rect-local scaled px, polygonMask(..., {feather:0, grow: DILATE_PX*max(kx,ky)+bleed}) binarised to 0/1; contract: Uint8Array w*h, non-zero = hole). Then rubWindow -> client().inpaint(img, mask, {seed}) -> cutTile / upsampleFill (+ copyByMatches, matchSeam which calls shapeMask(rec, T) again, :806-819) -> { rect: box, rgba } -> land(ed, tile, job, { under, gen, label:'Removed outline' }) (:824-849): ed.tiles.set(id, rgba); ed.pools.patches[id] = { ...rect, how: recipeRecord(rec) } (remove-plan.js:515-541; 'outline' -> {kind, poly: polygonRecord(poly), seed, attempt}); await ed.saveTile(id, rgba, meta) (IndexedDB tile before the step); ed.commitBelow(s => ({...s, remove:[...under, id]}), label). Try another (:610-651) and rubOffsets (:662-678) rebuild from reviveRecipe(how) through the same shapeBox/shapeMask/shapeOf (:508). Overlay/shimmer also key on j.poly: drawOverlay (:258) drawTrace(ctx,{path: stagePoints(map, j.poly), closed:true}); placeShimmer/polyRect/silhouette (:999-1041) -> polygonSvg(stagePoints(map, j.poly), box) as a CSS mask-image data URL.

LIGHT TODAY (apps/gesso/ui/tools/light.js). finishTrace (:379-410): same poly -> toSource (:402); entry = { kind:'outline', mode, poly: polygonRecord(transformPolygon(poly, toSource)), amount: a } (:404, amount 0..1 from entryFromRuler(amount, paintMode), lib/outline-paint.js:26-30; 1.0 = 1.5 EV); ed.pools.strokes[id] = entry (:405); adjusting = entry.poly (:406, the Amount ruler's identity check compares s.poly === adjusting in adjustable(), :262-266); ed.commit({...st, paint:[...st.paint, id]}, outlineLabel(mode)) (:407). The GPU work happens in apps/gesso/ui/editor.js replayPaint(ids) (:224-240), run whenever doc.paint changes (undo, redo, relaunch, ruler live/commit): for s.kind === 'outline' -> p = outlinePaint(s.poly, renderer.size, renderer.paintScale()) (lib/outline-paint.js:67-75: polygonBounds at paint scale s = min(0.25, 2048/max(W,H)) with pad ceil(FEATHER_PX/2)+1, polygonMask(... {scale:s, x:b.x, y:b.y, feather:6}) -> { mask: Uint8Array w*h 0..255, w, h, rect: {x:b.x/s, y:b.y/s, w:b.width/s, h:b.height/s} in SOURCE px }); then renderer.paintMask(s.mode, p.mask, p.rect, s.amount) (apps/gesso/ui/renderer.js:500-529: uploads an R8 texture of round(rect.w*s) x round(rect.h*s) texels — the mask must be at least that long — and draws one quad into the RG8 paint FBO at (rect * s) with uChannel brighten/darken/erase and uAmount clamped 0..1, additive blend or ZERO/ONE_MINUS_SRC_ALPHA for erase). The Amount ruler (:426-458) re-makes the entry {...was, mode, amount} under a new id and calls ed.live / ed.commit, so every amount change is a full replayPaint. isOutlineEntry (lib/outline-paint.js:51-54) validates entries via revivePolygon; lib/draft.js revivePools validates stored strokes on relaunch.

VISION ENTRY, option A (vector; recommended first; zero changes below finishTrace): Swift runs VNGenerateForegroundInstanceMaskRequest (iOS 17+, on-device) on a CGImage of the photo, picks the instance under the tap (tap: stage -> ed.stageToSource(x,y) (editor.js:375-384) -> native px = source px * natW/source.w; instanceMask pixel at that point -> instance index; or union all instances when no instance is under the tap), calls generateScaledMaskForImage(forInstances:from:) for a mask in the analysed image's px, thresholds at 0.5, extracts the outer contour (VNDetectContoursRequest on the binary mask, or a marching-squares trace in Swift), and replies with one or more closed polygons as flat [x,y,...] in the analysed image's px plus its size. JS: transformPolygon(poly, [sx,0,0,sy,0,0]) with sx = source.w/analysedW, sy = source.h/analysedH (if Vision ran on ed.readOutput's cropped analysis image instead, reuse exactly the toSource matrix from finishTrace :412), then simplifyPolygon(poly, 0.75) (lib/lasso.js:450-485) and polygonRecord -> polyS; apply the same guards (TINY_PT2 area via polygonArea, exceedsAreaCap for Remove, st.crop check is unnecessary because the polygon is already in source px) and construct the identical job (Remove :424-426) or entry (Light :403-408). Everything downstream — rubTile, land, Try another, recipeRecord/reviveRecipe, shimmer, overlay drawTrace, replayPaint/outlinePaint/paintMask, Amount ruler, autosave, undo bit-exactness — is untouched because polygons are the stored recipe. Multi-component subjects: submit one job/entry per component (each an undo step) or only the largest; holes are lost (polygonMask is even-odd on a single ring; a cut-joined ring is possible but ugly) — acceptable for 'tap the subject'. Which image to analyse: the cleanest is for Swift to keep the CGImage it decoded at pick time (or decode the original from the temp file again) with orientation applied (createImageBitmap applies EXIF, so the mask space must be the oriented natW x natH, else the mask is rotated against the texture); Vision resizes internally, so pass a ≤2048 px downscale and report that size. Avoid sending readOutput RGBA from JS (3 MB per tap as base64) unless Swift cannot see the pixels (it can). Remove's 20% AREA_CAP (lib/heal.js) will refuse most whole-subject removals; the native mode may need a larger cap or a 'tile it' strategy — a design decision, not a plumbing one.

VISION ENTRY, option B (raster; only if hole/multi-blob fidelity matters): add shape kind 'subject' = { mask: Uint8Array (0/255) at a known scale, rect: {x,y,w,h} source px }. Remove: shapeBox -> clipRect(grow(rect, DILATE_PX)); shapeMask(s, rect, w, h, kx, ky, bleed) -> resample the raster to the rect-local w x h at kx,ky (nearest/bilinear + 0.5 threshold), dilate by DILATE_PX*max(kx,ky)+bleed (separable max filter), return 0/1 — matching outlineMask's contract; shapeOf -> {mask, rect}; recipeRecord/reviveRecipe 'subject' case storing an RLE of the 0/1 raster (tens of KB; lib/draft.js revivePools must accept and bound it); silhouette -> draw the raster to a canvas -> data URL; drawOverlay still wants a contour for the orange line (so a traced polygon is needed anyway, which is why A comes first). Light: entry {kind:'subject', mode, mask (RLE at paint scale), rect, amount}; replayPaint dispatches straight to renderer.paintMask(s.mode, maskUint8, rect, s.amount) — paintMask already accepts any Uint8Array covering round(rect.w*s) x round(rect.h*s) texels over a source-px rect, but it does not feather, so bake a 6-texel ramp (FEATHER_PX) into the raster at paint scale (paintMaskSize/paintScale give the scale, renderer.js:492-495); isOutlineEntry/adjustable must accept the kind for the Amount ruler, and the adjusting identity (s.poly === adjusting) becomes s.mask === adjusting.

In both options the only native-side output needed is 'mask in a stated pixel space', and the only JS-side dependency is a scale into SOURCE px (working size), because every stored recipe (pools.patches[id].how.poly, pools.strokes[id].poly) is in source px and the renderer's paint mask and fill tiles are source-space textures (SPEC §5.2).

## notes

- Confidence on the WKWebView facts used above: WKURLSchemeHandler as the serving mechanism with a stable origin and explicit MIME types — high; file:// breaking IndexedDB/module/worker loading — high; service workers unavailable to a custom-scheme page (only App-Bound Domains over https) — high; WKScriptMessageHandlerWithReply promise bridge, iOS 14+ — high; dedicated and module workers loading from a custom scheme — medium-high (both export and heal paths have main-thread fallbacks regardless); env(safe-area-inset-*) populated in an edge-to-edge WKWebView with viewport-fit=cover — medium-high; visualViewport shrinking for the keyboard inside WKWebView — medium, verify on device (T16 gives the bridge fallback); navigator.share present in WKWebView but file sharing unverified — medium, treat as unavailable natively; custom scheme NOT a secure context (so navigator.clipboard and navigator.storage/persist are absent; IndexedDB, workers, createImageBitmap unaffected) — medium; app-owned default WKWebsiteDataStore not subject to Safari's 7-day script-storage eviction — medium-high; WKWebpagePreferences.isLockdownModeEnabled settable to false for an app's own content — medium; WebContent process memory limits comparable to Safari's on the same device — medium.
- Xcode 27.1 (27A9275) is installed on this machine, so the Build phase can scaffold and compile the project. Node tests: cd apps/gesso && npm test. The working-tree server on 4174 was not exercised for this read-only task.
- There is no network code in the app at all (no fetch/XHR/external URLs; grep over app.js, ui/, lib/, workers/) — only sw.js fetches, and only its own origin. The 'everything stays on this iPhone' story needs no code change, only the privacy manifest and the removal of the install line.
- Recommended single seam: a new module (e.g. apps/gesso/ui/platform.js) exporting isNative, pickPhoto, saveToPhotos, share, decodeNative, haptic, subjectMask, flushHooks, each with the web behaviour as fallback; imported by app.js (picker, install line, SW, lifecycle), savesheet.js (save/share), importer.js (decode fallback), remove.js/light.js (subject lift), ruler-view/editor (haptics). It must be added to sw.js SHELL (test/sw-shell.test.mjs) and must not touch browser globals at module top level (node tests import lib/ only, but keep the habit).
- Draft/restore invariants to preserve when native decode is added: the stored original Blob is re-decoded on every launch (app.js:231) and after a GL context loss (app.js:71), and the result must be exactly {source.w, source.h} (app.js:241-244) — so whichever decoder produced the working image must be the one used again; record it in draft info (lib/draft.js reviveInfo currently keeps only type/natW/natH/name).
- The design notes (apps/gesso/design/README.md:26-30) already recorded the owner's A/B question and the recommended shape; this map assumes option A as stated in the task. Outline's integration guide (design/lasso-integration.md) matches what shipped in 9b46f42, including renderer.paintMask and recipeRecord 'outline'.
- Pre-existing web quirks that the native build inherits unchanged and should not try to fix in Swift: Remove's 20% area cap on fills (lib/heal.js AREA_CAP) will reject most whole-subject removals from a Vision mask; the paint mask is S/4 capped at 2048 px long side (renderer.js:434), so a subject mask finer than ~4 source px per texel gains nothing.

