<!-- Draft produced by apps/gesso/design/workflows/gesso-ios-design.js on 2026-10-20 (run stopped after the Judge phase); raw agent output, exported verbatim. -->

# Design (product): Gesso for iOS, option A: a SwiftUI shell around the bundled web editor, designed from the "ship it" angle

A small SwiftUI app (XcodeGen project at apps/gesso-ios) hosts the unchanged Gesso web app in one edge-to-edge WKWebView, served from the app bundle by a WKURLSchemeHandler at the pinned origin gesso://localhost with explicit MIME types, a no-network CSP and no service worker. One new web module, ui/platform.js, is the only seam: it detects an injected document-start flag, wraps a WKScriptMessageHandlerWithReply bridge (pickPhoto, probeImage/decodeImage for ProRAW/DNG, saveToPhotos with a real PHPhotoLibrary result, share, subjectMask from VNGenerateForegroundInstanceMaskRequest feeding the existing Outline polygon path, haptics, lifecycle flush) and falls back to today's web behaviour everywhere else, so elsewhere.quest keeps working byte-for-byte in behaviour. Nine existing files change by small diffs (one click interceptor on #file covers all four picker call sites). Storage is WKWebsiteDataStore.default() under a fixed origin (no 7-day rule). App Store readiness is designed in: web assets ship inside the bundle with a build-time manifest check mirroring deploy.yml, a privacy manifest with no collected data, NSPhotoLibraryAddUsageDescription only, no ATS, offline-only as a feature, Pigment Wheel icon and a ground-colour launch screen, a debug probe route, TestFlight loop and a day-one Xcode checklist. Build order is ~7–8 working days in six phases, web seam first so the web app is never broken.

# Gesso for iOS — option A design ("ship it" angle)

Scope: a native iOS app that hosts the existing Gesso web editor (apps/gesso, branch claude/gesso-ios at 9b46f42 + Outline) in a WKWebView served from the app bundle, with native bridges for Photos in/out, ProRAW/DNG decode, Vision subject lift, haptics, durable storage and lifecycle. Not a rewrite. The web app on https://elsewhere.quest/gesso/ keeps working unchanged (every native path has a web fallback and the web path is the default).

Confidence legend used below: **[H]** high, **[MH]** medium-high, **[M]** medium, **[ML]** medium-low — each **[M]** or lower item names its fallback.

---

## 0. The ship-it summary (what has to be true on day one of review)

| Item | Decision |
|---|---|
| Update story | Web assets ship inside the .ipa; there is no over-the-air update, no service worker, no remote code (App Review 2.5.2 is satisfied by construction). A Gesso release = an App Store release. Version string = app `MARKETING_VERSION`; the web tree's git hash is stamped into `web/version.json` and shown in the probe. |
| Caching model | Gone. The scheme handler answers every request from the bundle with `Cache-Control: no-store`; the bundle is the shell. The sw.js `SHELL` list is reused as the bundle manifest check at build time. |
| Network | None. No `fetch()` exists in the app (grep-verified). The scheme handler injects a CSP on index.html that forbids every origin but `gesso:`, `blob:` and `data:`. No ATS exceptions, no `NSAppTransportSecurity` key at all. "Everything stays on this iPhone" is literally enforced by the content security policy, and the privacy manifest says so. |
| Privacy manifest | `PrivacyInfo.xcprivacy`: tracking **no**, collected data types **none**, accessed-API reasons: `UserDefaults` (CA92.1) only — the scheme handler is written to never read file timestamps or disk space so no other required-reason category applies. |
| Permissions | `NSPhotoLibraryAddUsageDescription` only. PHPicker needs no permission; Vision and ImageIO run on data the user handed over. |
| Review 4.2 ("minimum functionality / web wrapper") | The app is fully offline, bundles all code, and does four things a web view cannot: PhotoKit picker + add-to-Photos with a real result, ImageIO ProRAW/DNG decode, on-device Vision subject lift, haptics. The App Review notes say exactly that, with a 30 s demo of each. No URL is ever loaded from the network, so it is not a "website in a frame". |
| First run on native | Start screen without the "Share → Add to Home Screen" line, no install hint rows in the probe, "Choose a photo" opens PHPicker straight away. No onboarding. |
| iPad / Stage Manager | Later. The app ships iPhone-only (`TARGETED_DEVICE_FAMILY = 1`) so review does not test an iPad layout the web app has not been designed for; iPad adds a device family and the window-resize path the web already handles (window `resize` + `ResizeObserver`). |
| Diagnostics without network | OSLog (subsystem `quest.elsewhere.gesso`), Xcode Organizer crash logs (opt-in), TestFlight crash + screenshot feedback, the existing `?probe=1` page reachable via a Settings-bundle toggle and a DEBUG shake gesture, a WebContent-termination counter in UserDefaults surfaced as a probe row, and "Copy report" through the native share sheet. |
| TestFlight loop | `xcodegen generate` → Archive → App Store Connect → internal testers (no review) in ~15 min per build; `CURRENT_PROJECT_VERSION` bumped by a script; Xcode Cloud later if wanted. |

---

## 1. App structure

### 1.1 Repository layout

```
apps/gesso/                        # the web app, unchanged in shape (+ ui/platform.js)
apps/gesso-ios/
  project.yml                      # XcodeGen spec; Gesso.xcodeproj is generated and git-ignored
  Gesso/
    GessoApp.swift                 # @main App, scenePhase → flush
    EditorScreen.swift             # SwiftUI screen: the web view, edge to edge
    Web/
      WebViewHost.swift            # UIViewRepresentable; WKWebView config; delegates
      GessoSchemeHandler.swift     # WKURLSchemeHandler: bundle + temp + drafts
      MIME.swift                   # extension → content type
      Bridge.swift                 # WKScriptMessageHandlerWithReply dispatch
      BridgeMethods.swift          # one func per method, Codable arg/reply structs
      NativeFlagScript.swift       # the WKUserScript injected at document start
    Native/
      PhotoPicker.swift            # PHPickerViewController
      FilePicker.swift             # UIDocumentPickerViewController (secondary)
      PhotoSaver.swift             # PHPhotoLibrary add-only
      ShareSheet.swift             # UIActivityViewController
      ImageDecoder.swift           # CGImageSource / ImageIO
      SubjectLift.swift            # Vision foreground mask → polygons
      Haptics.swift                # prepared generators
      TempStore.swift              # Caches/gesso-tmp and Library/Application Support/drafts
      Diagnostics.swift            # OSLog, termination counter, probe toggle
    Resources/
      Assets.xcassets              # AppIcon (1024 PNG from icon.svg), Ground color #0d0c0b
      PrivacyInfo.xcprivacy
      Settings.bundle              # "Open device probe on next launch", "Reset working size"
    Info.plist
  Scripts/
    sync-web.sh                    # build phase: copy ../gesso → web/, drop test/e2e/design/SPEC/package.json, stamp version.json
    check-bundle.sh                # build phase: every sw.js SHELL entry exists in web/, fail otherwise
    bump-build.sh                  # CURRENT_PROJECT_VERSION += 1
    export-options.plist           # method app-store-connect
  GessoTests/                      # XCTest (scheme handler, MIME, path safety, bridge decoding, decoder, subject lift)
  GessoUITests/                    # XCUITest (launch, start screen, stubbed picker → save)
```

Minimum deployment target: **iOS 17.0** (VNGenerateForegroundInstanceMaskRequest, `webView.isInspectable`, `WKWebpagePreferences.isLockdownModeEnabled`). Build with Xcode 27.1 / iOS 26 SDK (present on this Mac).

### 1.2 XcodeGen `project.yml` (outline)

```yaml
name: Gesso
options:
  bundleIdPrefix: quest.elsewhere          # owner to confirm
  deploymentTarget: { iOS: "17.0" }
  xcodeVersion: "27.1"
  createIntermediateGroups: true
settings:
  base:
    MARKETING_VERSION: "1.0"
    CURRENT_PROJECT_VERSION: "1"
    SWIFT_VERSION: "6.0"
    SWIFT_STRICT_CONCURRENCY: complete
    TARGETED_DEVICE_FAMILY: "1"            # iPhone only for 1.0; "1,2" when iPad lands
    ENABLE_USER_SCRIPT_SANDBOXING: NO      # the sync script reads ../gesso
    CODE_SIGN_STYLE: Automatic
    DEVELOPMENT_TEAM: "XXXXXXXXXX"        # owner's team
targets:
  Gesso:
    type: application
    platform: iOS
    sources:
      - path: Gesso
        excludes: ["**/.DS_Store"]
    info:
      path: Gesso/Info.plist
      properties: { }                      # the real keys live in the file (see §7)
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: quest.elsewhere.gesso
        INFOPLIST_KEY_UILaunchScreen_Generation: NO   # we ship an explicit UILaunchScreen dict
        ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon
        GENERATE_INFOPLIST_FILE: NO
    preBuildScripts:
      - name: Sync web app into bundle
        script: "\"$SRCROOT/Scripts/sync-web.sh\""
        inputFiles: ["$(SRCROOT)/../gesso/sw.js"]     # Xcode only re-runs when inputs change; sw.js changes with every shell edit
        outputFiles: ["$(DERIVED_FILE_DIR)/web/version.json"]
      - name: Check bundle against sw.js SHELL
        script: "\"$SRCROOT/Scripts/check-bundle.sh\""
    dependencies: []                       # no SPM, no third-party SDKs (nothing to add to the privacy manifest)
  GessoTests:
    type: bundle.unit-test
    platform: iOS
    sources: [GessoTests]
    dependencies: [{ target: Gesso }]
  GessoUITests:
    type: bundle.ui-testing
    platform: iOS
    sources: [GessoUITests]
    dependencies: [{ target: Gesso }]
schemes:
  Gesso:
    build: { targets: { Gesso: all, GessoTests: [test], GessoUITests: [test] } }
    run: { config: Debug }
    test: { config: Debug, targets: [GessoTests, GessoUITests] }
    archive: { config: Release }
```

`sync-web.sh` (mirrors `.github/workflows/deploy.yml:35-37`):

```sh
#!/bin/sh
set -eu
SRC="$SRCROOT/../gesso"; OUT="$DERIVED_FILE_DIR/web"
rm -rf "$OUT"; mkdir -p "$OUT"
rsync -a --delete --exclude test --exclude e2e --exclude design --exclude SPEC.md --exclude package.json --exclude '.*' "$SRC/" "$OUT/"
HASH=$(cd "$OUT" && find . -type f ! -name sw.js -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-12)
printf '{"web":"%s","app":"%s","build":"%s"}\n' "$HASH" "$MARKETING_VERSION" "$CURRENT_PROJECT_VERSION" > "$OUT/version.json"
# copy into the product's resources as a folder (keeps paths exactly as the page references them)
DEST="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/web"
rm -rf "$DEST"; cp -R "$OUT" "$DEST"
```

`check-bundle.sh` reads the `SHELL` literal from `web/sw.js` (same regex as `test/sw-shell.test.mjs:140`) and fails the build if any listed path is missing from `web/`, or if `web/ui/platform.js` is absent. sw.js itself is kept in the bundle (never registered; it is the manifest) — harmless, 4 KB.

---

## 2. Bundling and serving

### 2.1 Why a custom scheme, and which origin

`file://` gives an opaque/per-file origin: IndexedDB may be unavailable, `new URL(..., import.meta.url)` fetches for the two module workers fail, localStorage is per-file **[H]**. `WKURLSchemeHandler` serving the bundle at one fixed origin is the standard answer (Capacitor's `capacitor://localhost` is the production precedent) **[H]**.

Origin: **`gesso://localhost/`**, pinned forever.
- Host `localhost` rather than `app`: WebKit treats a `localhost` host as potentially trustworthy regardless of scheme, so the page is likely a **secure context** (`isSecureContext === true`), which brings back `navigator.clipboard` (probe Copy), `navigator.storage` and `navigator.share` **[M]**. If it turns out not to be secure, nothing the editor needs breaks: IndexedDB, module workers, OffscreenCanvas and createImageBitmap are not `[SecureContext]`; store.js already returns `persistent:false` when `navigator.storage` is missing; the probe already has the execCommand copy fallback. Either way the probe row "Origin / secure context" (§9) records it.
- Changing the scheme or host later changes the origin and silently orphans the IndexedDB database and localStorage (T10). The string is a single constant `GessoOrigin.base` referenced from the handler, the user script and the tests.
- The page URL is `gesso://localhost/index.html` (and `gesso://localhost/?probe=1`); every asset is relative to it, exactly as on elsewhere.quest/gesso/.

The scheme name `gesso` is not one WebKit handles itself (http, https, file, data, blob, about, javascript, ws, wss, ftp), so `WKWebViewConfiguration.setURLSchemeHandler(_:forURLScheme:)` accepts it **[H]**.

### 2.2 The handler

```swift
final class GessoSchemeHandler: NSObject, WKURLSchemeHandler {
  private let webRoot: URL      // Bundle.main.resourceURL/web
  private let temp: TempStore   // Caches/gesso-tmp (import/export files) + Application Support/drafts
  private var live = Set<ObjectIdentifier>()   // tasks not yet stopped

  func webView(_ w: WKWebView, start task: WKURLSchemeTask) {
    let id = ObjectIdentifier(task); live.insert(id)
    guard let url = task.request.url, url.host == "localhost" else { return fail(task, 404) }
    var path = url.path.isEmpty || url.path == "/" ? "/index.html" : url.path   // query string ignored
    // Path safety: resolve inside webRoot; any ".." or symlink escape is a 404, never a read.
    if path.hasPrefix("/_tmp/")    { return serveFile(task, temp.tempURL(forName: String(path.dropFirst(6))), nil) }
    if path.hasPrefix("/_draft/")  { return serveFile(task, temp.draftURL(id: String(path.dropFirst(8))), nil) }
    let file = webRoot.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
    guard file.path.hasPrefix(webRoot.standardizedFileURL.path) else { return fail(task, 404) }
    serveFile(task, file, path == "/index.html" ? Self.csp : nil)
  }

  func webView(_ w: WKWebView, stop task: WKURLSchemeTask) { live.remove(ObjectIdentifier(task)) }

  private func serveFile(_ task: WKURLSchemeTask, _ file: URL, _ csp: String?) {
    guard FileManager.default.isReadableFile(atPath: file.path) else { return fail(task, 404) }
    var headers = ["Content-Type": MIME.type(for: file.pathExtension), "Cache-Control": "no-store", "Accept-Ranges": "none"]
    if let csp { headers["Content-Security-Policy"] = csp }
    // Stream in 4 MB chunks: a ProRAW temp file is 25–75 MB and must not be Data(contentsOf:).
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      guard let self, let fh = try? FileHandle(forReadingFrom: file) else { return self?.fail(task, 404) ?? () }
      defer { try? fh.close() }
      let size = (try? fh.seekToEnd()) ?? 0; try? fh.seek(toOffset: 0)
      headers["Content-Length"] = String(size)
      let resp = HTTPURLResponse(url: task.request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
      DispatchQueue.main.async { guard self.live.contains(ObjectIdentifier(task)) else { return }; task.didReceive(resp) }
      while let chunk = try? fh.read(upToCount: 4 << 20), !chunk.isEmpty {
        let stillLive = DispatchQueue.main.sync { self.live.contains(ObjectIdentifier(task)) }
        guard stillLive else { return }                     // calling into a stopped task throws (ObjC exception)
        DispatchQueue.main.async { task.didReceive(chunk) }
      }
      DispatchQueue.main.async { if self.live.remove(ObjectIdentifier(task)) != nil { task.didFinish() } }
    }
  }
}
```

MIME map (module scripts are MIME-strict; a wrong `.js` type is a blank page with no message, T13):

| ext | type |
|---|---|
| html | text/html; charset=utf-8 |
| js, mjs | text/javascript; charset=utf-8 |
| css | text/css; charset=utf-8 |
| json, webmanifest | application/json / application/manifest+json |
| svg | image/svg+xml |
| png / jpg,jpeg / heic / dng / tif | image/png / image/jpeg / image/heic / image/x-adobe-dng / image/tiff |
| txt | text/plain; charset=utf-8 |
| anything else | application/octet-stream |

Explicit **404** for unknown paths (never SPA-style index fallback, so a bundle omission fails loudly on device and in the simulator test, T13). Reading file **attributes** (timestamps, sizes via `attributesOfItem`) is deliberately avoided — size comes from `FileHandle.seekToEnd()` — so the privacy manifest needs no file-timestamp reason **[MH]** (Apple lists `attributesOfItem`'s modification date among the required-reason APIs; `FileHandle` seeking is not listed).

`Content-Length` and `Accept-Ranges: none`: whole-file responses. Range support is not needed: `fetch()` of a 70 MB temp file into a `File` is one sequential read. `HTTPURLResponse` headers (including CSP) are honoured by WebKit for scheme-handler responses **[MH]**; if CSP turned out to be ignored it costs nothing (there is no network to block anyway) — belt and braces only.

CSP on `index.html` (T21 risks honoured — `blob:` for the long-press `<img>` and the probe worker, `data:` for the shimmer's SVG mask, `'unsafe-inline'` because `probe.js` inserts a `<style>` element and CSSOM writes are not governed anyway):

```
default-src 'none'; script-src gesso:; worker-src gesso: blob:; style-src gesso: 'unsafe-inline';
img-src gesso: blob: data:; connect-src gesso: blob:; font-src gesso:; manifest-src gesso:;
frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'
```

### 2.3 Temp and draft files served by the scheme

| URL | backing file | lifetime |
|---|---|---|
| `gesso://localhost/_tmp/<uuid>.<ext>` | `Caches/gesso-tmp/<uuid>.<ext>` | import copies from PHPicker/Files, decoded PNGs, staged export JPEGs; deleted by `release` or on next launch (`TempStore.sweep()` at app start) |
| `gesso://localhost/_draft/<docId>` | `Library/Application Support/gesso/drafts/<docId>.<ext>` | the original of a natively decoded photo (RAW only), needed to re-decode at restore; pruned by `pruneDrafts` |

`Caches` is excluded from backup automatically; `Application Support/gesso/drafts` gets `isExcludedFromBackup = true` (the IndexedDB copy is the source of truth; the draft copy exists only so ImageIO can read it again).

### 2.4 Versioning

`web/version.json` = `{web: <12-hex sha of the web tree>, app, build}`; `hello()` returns it; the probe prints it; the About row in Settings.bundle shows `MARKETING_VERSION (CURRENT_PROJECT_VERSION)`. Drafts are validated by `lib/draft.js` (`DRAFT_VERSION`) exactly as on the web: a draft written by an older build either revives or lands on "Your last edit couldn't be restored." — no native-side migration logic.

---

## 3. WKWebView configuration

```swift
let cfg = WKWebViewConfiguration()
cfg.setURLSchemeHandler(schemeHandler, forURLScheme: "gesso")
cfg.websiteDataStore = .default()                       // persistent, app-owned (never .nonPersistent())
cfg.defaultWebpagePreferences.preferredContentMode = .mobile
cfg.defaultWebpagePreferences.allowsContentJavaScript = true
cfg.allowsInlineMediaPlayback = true
cfg.dataDetectorTypes = []
cfg.userContentController.addUserScript(NativeFlagScript.make())   // .atDocumentStart, forMainFrameOnly: true, world .page
cfg.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "gesso")     // reply handler
cfg.userContentController.add(bridge, contentWorld: .page, name: "gessoFx")                       // fire-and-forget
let web = WKWebView(frame: .zero, configuration: cfg)
web.isOpaque = false
web.backgroundColor = UIColor(named: "Ground")           // #0d0c0b, never a white flash
web.underPageBackgroundColor = UIColor(named: "Ground")
web.scrollView.isScrollEnabled = false
web.scrollView.bounces = false
web.scrollView.contentInsetAdjustmentBehavior = .never
web.scrollView.pinchGestureRecognizer?.isEnabled = false  // also set again in didFinish: the recognizer is recreated per process
web.allowsBackForwardNavigationGestures = false
web.allowsLinkPreview = false
#if DEBUG
web.isInspectable = true                                 // Safari ▸ Develop ▸ iPhone ▸ Gesso
#endif
web.load(URLRequest(url: URL(string: "gesso://localhost/index.html")!))
```

SwiftUI: `WebViewHost().ignoresSafeArea(.all)` with `.statusBarHidden(false)` and `.preferredColorScheme(.dark)`; no `Material`, no transition, no `.overlay` that snapshots the view (T19). With the view extending under the bars and the page's `viewport-fit=cover`, WebKit populates `env(safe-area-inset-*)` from the web view's own `safeAreaInsets` **[MH]**. Fallback if the probe row shows 0: `getInsets()` bridge method returns `view.safeAreaInsets` and `platform.js` writes them to `--safe-top/--safe-bottom/...` on `:root` (styles.css:22-25 already read those tokens).

Navigation delegate: allow only `gesso://localhost` navigations (`decidePolicyFor` → `.cancel` for anything else; there is nothing else, but a `<a href>` in a future hint must not open Safari silently). `webViewWebContentProcessDidTerminate` → `Diagnostics.countTermination(); web.reload()` (the restore path brings the draft back with "Restored your last edit", T12).

Lockdown Mode: in `webView(_:decidePolicyFor:preferences:decisionHandler:)` set `preferences.isLockdownModeEnabled = false` for our own content **[M]** — Apple's documented intent is that apps may opt their own non-remote content out. If it has no effect, the page shows the reworded message "Gesso needs WebGL, which Lockdown Mode has turned off." (§5.6) and that is the hard failure mode; review rarely runs in Lockdown.

Keyboard: the caption bar relies on `visualViewport` shrinking (text.js:532-551). In WKWebView the visual viewport does reflect the keyboard **[M]**. Fallback wired from day one: Swift observes `UIResponder.keyboardWillChangeFrameNotification` and calls `window.gessoNative.onKeyboard(heightInCSSPx)`; `platform.keyboardInset()` returns it and `caption-edit.js`'s `editBarTop` consumer in text.js prefers it when non-null. Known polish item: WKWebView shows the form accessory bar (‹ › Done) above the keyboard; the edit bar sits above it correctly, it just costs 44 pt. Removing it needs the widely used `inputAccessoryView` override on the WKContentView subclass — defer, decide after seeing it.

---

## 4. The JS ↔ Swift bridge contract

### 4.1 Transport

- JS → Swift with reply: `window.webkit.messageHandlers.gesso.postMessage({ method, args })` returns a Promise (WKScriptMessageHandlerWithReply, iOS 14+) **[H]**. The body is a JSON-shaped object (NSDictionary/NSArray/NSString/NSNumber/NSNull only); binary never goes inline except base64 ≤ 16 MB.
- JS → Swift fire-and-forget: `window.webkit.messageHandlers.gessoFx.postMessage({ method, args })` (haptics, logs).
- Swift → JS: only `webView.evaluateJavaScript("window.gessoNative?.<fn>?.(…)")`; every call is optional-chained because `main()` may not have run (store open up to 3 s, GL gate).
- Errors: Swift replies `(nil, "code: message")`; the Promise rejects with an `Error` whose message starts with the code. Codes: `cancelled`, `denied`, `restricted`, `unsupported`, `notfound`, `failed`, `busy`, `timeout`.
- Timeouts: JS wraps every reply call in `withTimeout` (default 30 s; `decodeImage` 60 s; `pickPhoto`/`share` none — they wait on the user). Swift serialises `pickPhoto`/`share` (a second call while one UI is up replies `busy`).
- Large binary: files written by Swift and served by the scheme (§2.3) in the Swift→JS direction; in the JS→Swift direction base64 in ≤ 8 MB chunks appended to a temp file (`stageBegin/stageChunk/stageEnd`), because `WKURLSchemeHandler` does not reliably receive POST bodies **[ML]** — if an on-device test shows `fetch(url, {method:'POST', body})` bodies arrive, `stage*` collapses to one `fetch`; the JS API shape does not change.

The injected flag (document start, page world, main frame only — before `app.js`, a module script, evaluates **[H]**):

```js
window.__gessoNative = { bridge: 1, app: "1.0", build: "12", web: "0a1b2c3d4e5f", ios: "26.0",
  device: "iPhone18,1", memoryGB: 12, subjectLift: true, probe: false, reduceMotion: false };
```

### 4.2 Methods

| Method (JS name) | Args | Reply | Errors / notes |
|---|---|---|---|
| `hello()` | — | the flag object + `{ photosAdd: 'notDetermined'|'authorized'|'denied'|'restricted' }` | sanity + probe row |
| `pickPhoto({ source })` | `source: 'photos'|'files'` | `{ url, name, type, size, uti }` or `{ cancelled: true }` | PHPicker (`filter: .images`, `selectionLimit: 1`, `preferredAssetRepresentationMode: .current`), copy via `loadFileRepresentation` into `_tmp`; Files: `UIDocumentPickerViewController(forOpeningContentTypes: [.image])`, `asCopy: true`. `busy` if a picker is up. |
| `release({ url })` | temp url | `{ ok }` | delete a `_tmp` file (after `autosave.startDraft` settled, or after share) |
| `probeImage({ url })` | temp/draft url | `{ natW, natH, orientation, uti, bits, isRaw }` | `CGImageSourceCopyPropertiesAtIndex` with `kCGImageSourceShouldCache=false`; natW/natH are **oriented**. `unsupported` if ImageIO cannot open it. |
| `decodeImage({ url?, draftId?, keepAs?, w, h })` | source (temp url, or a kept draft) and exact target size | `{ url (PNG in _tmp), w, h, decoder: 'imageio-1' }` | ImageIO thumbnail with transform, drawn into a w×h sRGB `CGContext` (exact size, deterministic), PNG written to `_tmp`. `keepAs: docId` moves the source into `drafts/`. `notfound` if `draftId` is gone. |
| `pruneDrafts({ keep })` | `keep: [docId]` | `{ removed: n }` | mirrors autosave's sweep |
| `stageBegin({ name, type })` → `stageChunk({ id, b64 })` → `stageEnd({ id })` | | `{ id }` / `{ ok }` / `{ url, size }` | JS→Swift bytes (export JPEG) into `_tmp` |
| `saveToPhotos({ url, name })` | staged JPEG | `{ ok: true, id: localIdentifier }` or `{ ok: false, reason: 'denied'|'restricted'|'failed', message }` | `PHPhotoLibrary.requestAuthorization(for: .addOnly)` then `performChanges { PHAssetCreationRequest.forAsset().addResource(with: .photo, fileURL:, options: { originalFilename = name }) }`. Replies only after `performChanges` completes. |
| `share({ url, name })` | staged file | `{ ok: true, completed: Bool, activity: String? }` or `{ cancelled: true }` | `UIActivityViewController(activityItems: [fileURL])`; presented from the root VC; `completionWithItemsHandler` → reply |
| `openSettings()` | — | `{ ok }` | `UIApplication.openSettingsURLString` (for a denied Photos add) |
| `subjectMask({ x, y, maxSide, draftId? })` | tap in **oriented native px** of the current photo; `maxSide` default 1536 | `{ polys: [[x0,y0,x1,y1,…], …], w, h, instances, picked: idx|null }` | Vision on the kept CGImage (§5.2). `unsupported` below iOS 17 or no subject found → `{ polys: [], … }`. 10 s timeout. |
| `getInsets()` | — | `{ top, right, bottom, left }` in pt | fallback for env() |
| `log({ level, message })` (fx) | | — | `os.Logger` |
| `haptic({ kind })` (fx) | `'tick'|'light'|'medium'|'success'|'warning'|'error'` | — | prepared generators; JS throttles `tick` ≥ 50 ms |
| `prepareHaptics()` (fx) | | — | called on tool open so the first tick is not late |

Swift → JS (all optional-chained):
- `window.gessoNative.flush()` — on `scenePhase` → `.inactive`/`.background`, on `UIApplication.didReceiveMemoryWarningNotification`, before `reload()`.
- `window.gessoNative.onKeyboard(px)` — keyboard frame changes (0 when hidden).
- `window.gessoNative.onInsets({top,…})` — if the app ever changes insets (rotation with the fallback path).

Swift side dispatch sketch:

```swift
final class Bridge: NSObject, WKScriptMessageHandlerWithReply, WKScriptMessageHandler {
  func userContentController(_ ucc: WKUserContentController, didReceive m: WKScriptMessage) async -> (Any?, String?) {
    guard let body = m.body as? [String: Any], let method = body["method"] as? String else { return (nil, "failed: bad message") }
    let args = body["args"] as? [String: Any] ?? [:]
    do { return (try await methods.call(method, args), nil) }
    catch let e as BridgeError { return (nil, "\(e.code): \(e.message)") }
    catch { return (nil, "failed: \(error.localizedDescription)") }
  }
  func userContentController(_ ucc: WKUserContentController, didReceive m: WKScriptMessage) { /* gessoFx: haptic/log */ }
}
```

---

## 5. How each goal is met

### 5.1 Goal 1 — Photos in and out

**In.** One interceptor covers all four picker call sites (label-for, `#choose` keydown, `askNewPhoto`, Discard, and editor.js's dock tap on the start screen) because every one of them ends in a `click` on `#file`, and `preventDefault()` on a file input's click cancels the chooser **[H]**:

```js
// app.js, right after `const fileInput = $('#file');` (before openStore(), so it is live from first paint)
fileInput.addEventListener('click', (e) => {
  if (!platform.isNative) return;           // the web picker, exactly as today
  e.preventDefault();
  platform.pickPhoto().then((file) => {
    if (!file) return;                        // cancelled: like a dismissed file dialog (T17: nothing is called)
    if (typeof importFile === 'function') importFile(file); else earlyFile = file;   // keeps the earlyFile / picked() semantics
  }).catch((err) => console.warn('pick', err));
});
```

`platform.pickPhoto()` → `pickPhoto({source:'photos'})` → `fetch(url)` → `new File([blob], name, { type })` → attaches `file.nativeUrl = url` (so a native decode can use the file on disk without a second transfer) → returns the File. After `autosave.startDraft(id, file)` settles (it returns a tracked promise), app.js calls `platform.release(file.nativeUrl)`; a RAW keeps its copy via `keepAs` (§5.5). A Files entry is a quick chip on the start screen later ("Or from Files") — the bridge already supports `source:'files'`.

**Out.** savesheet.js branches before `shareRoute`:

```js
function onShareClick() {
  if (!session || sharing) return;
  const j = job;
  if (!j?.blob) { /* unchanged */ }
  if (platform.isNative) { nativeSave(j); return; }
  /* unchanged web path */
}
async function nativeSave(j) {
  sharing = true; ui.share.disabled = true;
  const name = exportFileName(new Date());
  const r = await platform.saveToPhotos(j.blob, name);     // stages the JPEG, then PHPhotoLibrary; never throws
  sharing = false;
  if (!session || job !== j) return;                        // closed meanwhile: keep today's ordering (T17)
  if (r.ok) { platform.haptic('success'); showDone(j); return; }
  if (r.reason === 'denied' || r.reason === 'restricted') {
    session.ed.toast("Gesso isn't allowed to add to Photos. Allow it in Settings, or share instead.", 4000);
    ui.shareOther.hidden = false;                           // 'Share…' → platform.share
  } else {
    const s = await platform.share(j.blob, name);           // UIActivityViewController: Files, AirDrop, Messages
    if (s.ok && s.completed) showDone(j);                   // only a completed activity counts
  }
  showJob(j);
}
```

Copy when native (set once in `install()`): button "Save to Photos" (same), `#sheet-coach` hidden, success line "Saved to Photos." — `markSaved()` only on a real `ok`, so `isSaved`, the "Saved" status and the New-photo confirm are finally truthful (T03/T17). The add-only permission prompt appears on the first save; a denial maps to the share sheet, never a dead button. The long-press fallback (`#fallback`) is never shown natively: both of its triggers are above the branch.

### 5.2 Goal 2 — Vision subject lift ("tap the subject") into Outline

Option A from the touchpoint map (vector polygons, zero changes below `finishTrace`):

Swift `SubjectLift`:
1. Keep the `CGImage` of the photo Swift decoded at pick time (or re-decode from `_tmp`/`drafts` on demand), orientation applied, downscaled to `maxSide` (1536) — the mask space is the oriented photo, which is the space `createImageBitmap` produced the texture in.
2. `VNGenerateForegroundInstanceMaskRequest` on a `VNImageRequestHandler(cgImage:)`; result `VNInstanceMaskObservation`.
3. Instance under the tap: scale the tap into `instanceMask` (a `CVPixelBuffer` of UInt8 labels) and read the label; 0 → use `allInstances` union (the whole subject).
4. `generateScaledMaskForImage(forInstances:from:)` → `CVPixelBuffer` float mask at the analysed size; threshold 0.5 into a binary `CIImage`.
5. Contours: `VNDetectContoursRequest` (`contrastAdjustment: 1`, `detectsDarkOnLight: false`, `maximumImageDimension: 1024`) on the binary mask; take `topLevelContours`, keep those with area ≥ 1 % of the largest, convert `normalizedPoints` to analysed px (flip y), reply flat arrays.
6. Reply `{ polys, w, h, instances, picked }`.

JS (`ui/tools/remove.js` and `ui/tools/light.js`): Outline mode gets a quick chip **Subject** (shown only when `platform.native?.subjectLift`). With it on, a stage tap → `ed.stageToSource(x,y)` → native px `× natW/W` → `platform.subjectMask({x,y})` → for each polygon (largest first, at most 3): `transformPolygon(poly, [W/aw, 0, 0, H/ah, 0, 0])` → `simplifyPolygon(poly, 0.75)` → `polygonRecord` → `polyS`; then exactly the tail of `finishTrace` (area guard, `outlineBox`, `exceedsAreaCap` for Remove, the `{kind:'outline', poly, seed:1, attempt:0}` job / the `{kind:'outline', mode, poly, amount}` entry). The tail is extracted into `submitOutline(ed, polyS)` in each tool (a pure move of existing lines). Everything downstream (rubTile, land, Try another, recipeRecord/reviveRecipe, shimmer, overlay, replayPaint/outlinePaint/paintMask, Amount ruler, autosave, undo) is untouched because polygons are the stored recipe. Haptic `light` on the lift. Shimmer shows during the ~0.3–1 s Vision call via the existing busy affordance in the tool.

Known product decision (not plumbing): Remove's `AREA_CAP` 0.20 (lib/heal.js) rejects most whole-subject removals with "Big area. Do it in smaller pieces." For 1.0 the Subject chip in Remove keeps that cap (honest), and in Light it has no cap (paint through a mask has none). Raising the cap for native-sized memory budgets is an open question (§11).

### 5.3 Goal 3 — Durable storage

`WKWebsiteDataStore.default()` under the fixed origin: app-owned, in the app container, removed only with the app; Safari's 7-day script-storage cap applies to Safari browsing, not an app's own data store **[MH]**. IndexedDB and localStorage work under a registered custom scheme (Capacitor precedent) **[MH]**; the simulator XCTest in §9 proves it on the Mac before any device run. No migration from Safari-tab drafts (accepted, as SPEC §6). store.js/autosave.js are byte-for-byte unchanged. The README honesty clause becomes "deleting the app deletes them" for the native build.

### 5.4 Goal 4 — Haptics

`Haptics.swift` keeps one prepared `UISelectionFeedbackGenerator`, `UIImpactFeedbackGenerator(style: .light)` and `.medium`, and `UINotificationFeedbackGenerator`. Moments (and only these):

| kind | where |
|---|---|
| tick | `ruler-view.js flash()` (detent/zero stick), chip changes in `panel.js` |
| light | snap guides in text.js, Outline anchor/lift, tool Done |
| success | Save to Photos ok (`showDone`), a Remove fill landing (`remove.js land`) |
| warning | "Couldn't remove that", CAP_TIP |

`platform.haptic()` throttles `tick` to ≥ 50 ms and never awaits on a stroke path; web build: no-op. No haptic on undo/redo.

### 5.5 Goal 5 — HEIC / ProRAW / DNG decode natively when the web can't

`decodeForEditing` (ui/importer.js) stays the decoder of record; native is a fallback chosen **deterministically** so restore reproduces import (T02):

```js
export async function decodeForEditing(file, { maxPixels, decoder = null, draftId = null } = {}) {
  const head = …; const type = sniffImageType(head);
  if (decoder === 'native' || (platform.isNative && platform.canDecodeNatively(type)))   // tiff/unknown go straight to ImageIO
    return decodeNative(file, { maxPixels, draftId });
  const problem = importProblem(type); if (problem) throw …;   // unchanged
  try { … unchanged … }
  catch (err) {
    if (err instanceof ImportError) throw err;
    if (platform.isNative) return decodeNative(file, { maxPixels, draftId });   // WebKit refused (memory or codec)
    throw new ImportError(type === 'tiff' ? importProblem('raw') : "This photo couldn't be opened.");
  }
}
async function decodeNative(file, { maxPixels, draftId }) {
  const src = file.nativeUrl ? { url: file.nativeUrl } : { draftId };
  const info = await platform.probeImage(src);                         // oriented natW/natH
  const fit = fitWorkingSize(info.natW, info.natH, maxPixels);         // the same function restore will use
  const out = await platform.decodeImage({ ...src, keepAs: draftId && file.nativeUrl ? draftId : undefined, w: fit.width, h: fit.height });
  const blob = await (await fetch(out.url)).blob();
  const bitmap = await createImageBitmap(blob);                        // no resize: already exact
  platform.release(out.url);
  if (bitmap.width !== fit.width || bitmap.height !== fit.height) { bitmap.close(); throw new ImportError("This photo couldn't be opened."); }
  return { bitmap, type: info.isRaw ? 'raw' : sniffed, natW: info.natW, natH: info.natH, downscaled: fit.downscaled, decoder: 'native' };
}
```

Swift `ImageDecoder`: `CGImageSourceCreateWithURL` (`kCGImageSourceShouldCache: false`), `CGImageSourceCreateThumbnailAtIndex` with `kCGImageSourceCreateThumbnailFromImageAlways`, `kCGImageSourceCreateThumbnailWithTransform`, `kCGImageSourceThumbnailMaxPixelSize = max(w,h)`, then draw into a `CGContext(width: w, height: h, bitsPerComponent: 8, space: .sRGB, bitmapInfo: noneSkipLast)` with `interpolationQuality = .high` — exact w×h, sRGB-tagged 8-bit PNG via `CGImageDestination` (`kUTTypePNG`), so the web strip canvas's colour management still applies and ProRAW (linear, wide-gamut) does not come out flat. ImageIO opens Apple ProRAW/DNG and most camera RAW on iOS 17+ **[H]**. Cost: 0.5–2 s and ~200 MB in the **app** process (not WebContent — a plus); the temp PNG (≤ 100 MB at 24.5 MP) is released right after `createImageBitmap`.

Restore determinism: app.js records `decoder: decoded.decoder ?? 'web'` in `editor.begin({info})`; `lib/draft.js reviveInfo` keeps `decoder` (string ≤ 16); restore calls `decodeForEditing(draft.file, { maxPixels, decoder: draft.info.decoder, draftId: id })`. Swift keeps the RAW original under `drafts/<id>` (`keepAs`) and app.js calls `platform.pruneDrafts({ keep: [id] })` after `startDraft` settles and `pruneDrafts({keep: []})` on `discard`. Copy: `importProblem(type, { native })` returns "That RAW photo couldn't be opened." natively instead of "…which Safari can't open".

### 5.6 Goal 6 — App Store readiness

See §0 for the table; §7 for the plist/manifest; §5.1–5.5 are the 4.2 answer. Copy fixes: app.js:89 → when native "Gesso needs WebGL, which Lockdown Mode has turned off."; README honesty clauses get a native paragraph; `index.html` description meta untouched (not shown natively).

---

## 6. The web-side platform module and the exact diffs

### 6.1 `apps/gesso/ui/platform.js` (new; must be in sw.js SHELL; no top-level DOM access so node can import it)

```js
// The one seam between Gesso and the host it runs in. Web is the default; the
// native app (apps/gesso-ios) injects window.__gessoNative at document start and
// registers two WebKit message handlers. Nothing here throws on the web.
const flag = globalThis.__gessoNative ?? null;
const handlers = globalThis.webkit?.messageHandlers ?? null;
export const isNative = !!flag && typeof handlers?.gesso?.postMessage === 'function';
export const native = isNative ? Object.freeze({ ...flag }) : null;

const DEFAULT_TIMEOUT = 30_000;
function call(method, args = {}, { timeout = DEFAULT_TIMEOUT } = {}) {
  if (!isNative) return Promise.reject(Object.assign(new Error('unavailable: not native'), { code: 'unavailable' }));
  const p = handlers.gesso.postMessage({ method, args }).catch((e) => { throw tagged(e); });
  return timeout ? withTimeout(p, timeout, method) : p;
}
function fire(method, args = {}) { try { handlers?.gessoFx?.postMessage({ method, args }); } catch { /* web */ } }
function tagged(e) { const m = String(e?.message ?? e); const code = m.split(':')[0].trim(); return Object.assign(new Error(m), { code }); }

export async function hello() { return call('hello'); }

// ---- photos in
export async function pickPhoto({ source = 'photos' } = {}) {
  if (!isNative) return null;
  const r = await call('pickPhoto', { source }, { timeout: 0 });
  if (r.cancelled) return null;
  return fileFromUrl(r.url, { name: r.name, type: r.type });
}
export async function fileFromUrl(url, { name, type }) {
  const blob = await (await fetch(url)).blob();
  const file = new File([blob], name || 'photo', { type: type || blob.type });
  file.nativeUrl = url;                     // consumed by decodeNative; never stored (IndexedDB clones the bytes only)
  return file;
}
export function release(url) { if (isNative && url) call('release', { url }).catch(() => {}); }

// ---- decode
const NATIVE_FIRST = new Set(['tiff', 'unknown']);   // DNG/ProRAW/camera RAW sniff as tiff; ImageIO decides
export const canDecodeNatively = (type) => isNative && NATIVE_FIRST.has(type);
export const probeImage = (src) => call('probeImage', src);
export const decodeImage = (args) => call('decodeImage', args, { timeout: 60_000 });
export const pruneDrafts = (keep) => (isNative ? call('pruneDrafts', { keep }).catch(() => {}) : Promise.resolve());

// ---- photos out
export async function saveToPhotos(blob, name) {
  if (!isNative) return { ok: false, reason: 'unavailable' };
  try { const { url } = await stage(blob, name, 'image/jpeg'); const r = await call('saveToPhotos', { url, name }, { timeout: 120_000 }); release(url); return r; }
  catch (e) { return { ok: false, reason: e.code === 'denied' || e.code === 'restricted' ? e.code : 'failed', message: e.message }; }
}
export async function share(blob, name) {
  if (!isNative) return { ok: false, cancelled: false };
  const { url } = await stage(blob, name, blob.type);
  try { const r = await call('share', { url, name }, { timeout: 0 }); return r.cancelled ? { ok: false, cancelled: true } : { ok: true, completed: !!r.completed }; }
  finally { release(url); }
}
const CHUNK = 6 * 1024 * 1024;              // ~8 MB of base64 per message
async function stage(blob, name, type) {
  const { id } = await call('stageBegin', { name, type });
  for (let off = 0; off < blob.size; off += CHUNK) await call('stageChunk', { id, b64: await toBase64(blob.slice(off, off + CHUNK)) });
  return call('stageEnd', { id });
}

// ---- subject lift, haptics, lifecycle
export const subjectMask = (args) => (native?.subjectLift ? call('subjectMask', args, { timeout: 10_000 }) : Promise.resolve(null));
let lastTick = 0;
export function haptic(kind) {
  if (!isNative) return;
  if (kind === 'tick') { const t = performance.now(); if (t - lastTick < 50) return; lastTick = t; }
  fire('haptic', { kind });
}
export const log = (level, message) => fire('log', { level, message: String(message).slice(0, 2000) });

// window.gessoNative is what Swift calls into. It exists from this module's first
// import so a flush before main() finishes is a no-op, not a ReferenceError.
let keyboardPx = null;
const listeners = new Set();
if (isNative) {
  globalThis.gessoNative = {
    flush() {}, onKeyboard(px) { keyboardPx = px > 0 ? px : 0; for (const f of listeners) f(keyboardPx); }, onInsets() {},
  };
}
export function onFlush(fn) { if (globalThis.gessoNative) globalThis.gessoNative.flush = () => { try { fn(); } catch (e) { log('error', e); } }; }
export const keyboardInset = () => keyboardPx;
export function onKeyboard(fn) { listeners.add(fn); return () => listeners.delete(fn); }
```

### 6.2 Diffs to existing files (minimal; web behaviour unchanged when `isNative` is false)

**`app.js`**
- `import * as platform from './ui/platform.js';`
- line 95 area: the `#file` click interceptor from §5.1, placed before `openStore()`; `earlyFile` already exists.
- line 89: `fatal(platform.isNative ? 'Gesso needs WebGL, which Lockdown Mode has turned off.' : 'Gesso needs WebGL, which this browser (or Lockdown Mode) has turned off.')`.
- line 167: `info: { type: decoded.type, natW, natH, name: file.name, decoder: decoded.decoder ?? 'web' }`.
- line 168: `autosave.startDraft(id, file).then(() => { platform.release(file.nativeUrl); platform.pruneDrafts([id]); });`
- line 214 (Discard): add `platform.pruneDrafts([]);` next to `autosave.discard?.()` (the picker still opens through `fileInput.click()` → interceptor).
- line 231: `decodeForEditing(draft.file, { maxPixels: draft.maxPixels ?? workCap(), decoder: draft.info?.decoder, draftId: draft.id })` (loadDraft already knows the id; expose it on the returned record — one-line addition in autosave.js `loadDraft` return: `id`).
- line 269: `if (!standalone && !hideInstall && !platform.isNative) $('#install').hidden = false;`
- line 275: `if (!platform.isNative && 'serviceWorker' in navigator && location.protocol !== 'file:')`.
- after line 287: `platform.onFlush(() => { editor.commitTyping(); autosave.flush(); });`
- line 289 unchanged (`window.gesso` stays the test/probe surface; `window.gessoNative` is the bridge surface).

**`ui/importer.js`** — the decoder branch from §5.5 (`decoder`, `draftId` options; `decodeNative`; native fallback in the catch).

**`lib/image-io.js`** — `importProblem(type, { native = false } = {})`: native copy for `raw`: "That RAW photo couldn't be opened." (lib stays pure; `test/image-io.test.mjs` gets two cases).

**`lib/draft.js`** — `reviveInfo` keeps `decoder: typeof r.decoder === 'string' && r.decoder.length <= 16 ? r.decoder : 'web'`; `test/draft.test.mjs` gets a case.

**`ui/autosave.js`** — `loadDraft` returns `id` alongside `file, info, …` (one key).

**`ui/savesheet.js`** — `nativeSave` from §5.1; `install()` wires `#share-other` (`els.shareOther`) → `platform.share(job.blob, exportFileName(new Date()))`; when `platform.isNative`: `ui.coach.hidden = true` always, `ui.done.querySelector('.sheet__success').textContent = 'Saved to Photos.'`.

**`index.html`** — one hidden button inside `#sheet-main`: `<button id="share-other" class="sheet__secondary" type="button" hidden>Share…</button>`. Nothing else (the install line is hidden by JS; the metas/manifest are harmless in the bundle).

**`sw.js`** — add `'./ui/platform.js'` to `SHELL` (otherwise `npm test` fails and the web PWA's offline install breaks, T07/T22).

**`ui/probe.js`** — rows added (§9): Native bridge, Origin/secure context, Service worker, Scheme-served module worker, Keyboard inset source; `displayMode` says "native app (Gesso for iOS x.y)" when `platform.isNative`; `storagePersist` says "app data store (no 7-day rule)" when native. Copy report: if `navigator.clipboard` is missing natively, `platform.share(new Blob([text]), 'gesso-probe.txt')`.

**`ui/ruler-view.js`** (`flash()` → `haptic('tick')`), **`ui/editor.js`** (Done → `haptic('light')`), **`ui/tools/remove.js`** (`land` → `haptic('success')`; Subject chip + `submitOutline` extraction), **`ui/tools/light.js`** (Subject chip + `submitOutline` extraction), **`ui/tools/text.js`** (`place()` prefers `platform.keyboardInset()` when not null; snap → `haptic('light')`).

**`test/platform.test.mjs`** (new) — imports `ui/platform.js` in node: `isNative === false` with no globals; with a fake `globalThis.__gessoNative` + `globalThis.webkit.messageHandlers.{gesso,gessoFx}` it checks message shapes (`{method,args}`), error tagging (`"denied: …"` → `code 'denied'`), the `tick` throttle, `onFlush` wiring, and that `pickPhoto()` resolves `null` on `{cancelled:true}`.

**`e2e/acceptance.mjs`** — optional `--native` flag: `addInitScript` injects the flag and a `messageHandlers` stub backed by the fixture JPEG (pickPhoto → serves it via a blob URL; saveToPhotos → `{ok:true}`); checks 8 and 9 read the stub instead of `navigator.share`; everything else runs unchanged in "native mode".

---

## 7. App Store items

### 7.1 `Info.plist` (the keys that matter)

```xml
<key>CFBundleDisplayName</key><string>Gesso</string>
<key>CFBundleName</key><string>Gesso</string>
<key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string>
<key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string>
<key>LSRequiresIPhoneOS</key><true/>
<key>UIApplicationSceneManifest</key><dict><key>UIApplicationSupportsMultipleScenes</key><false/></dict>
<key>UILaunchScreen</key><dict><key>UIColorName</key><string>Ground</string></dict>   <!-- #0d0c0b, no image: the web view paints the same colour -->
<key>UISupportedInterfaceOrientations</key><array>
  <string>UIInterfaceOrientationPortrait</string>
  <string>UIInterfaceOrientationLandscapeLeft</string>
  <string>UIInterfaceOrientationLandscapeRight</string>
</array>   <!-- SPEC §6: no orientation lock; the landscape side column ships -->
<key>UIViewControllerBasedStatusBarAppearance</key><true/>   <!-- SwiftUI sets light content via .preferredColorScheme(.dark) -->
<key>UIUserInterfaceStyle</key><string>Dark</string>
<key>UIRequiresFullScreen</key><false/>
<key>NSPhotoLibraryAddUsageDescription</key>
<string>Gesso adds the edited copy to your Photos. Your original is never changed.</string>
<key>ITSAppUsesNonExemptEncryption</key><false/>   <!-- skips the export-compliance question on every TestFlight build -->
<key>UIApplicationSupportsIndirectInputEvents</key><true/>
<!-- deliberately absent: NSPhotoLibraryUsageDescription (PHPicker needs none), NSAppTransportSecurity (no network), NSCameraUsageDescription (no capture in 1.0) -->
```

### 7.2 `PrivacyInfo.xcprivacy`

```xml
<plist version="1.0"><dict>
  <key>NSPrivacyTracking</key><false/>
  <key>NSPrivacyTrackingDomains</key><array/>
  <key>NSPrivacyCollectedDataTypes</key><array/>
  <key>NSPrivacyAccessedAPITypes</key><array>
    <dict>
      <key>NSPrivacyAccessedAPIType</key><string>NSPrivacyAccessedAPICategoryUserDefaults</string>
      <key>NSPrivacyAccessedAPITypeReasons</key><array><string>CA92.1</string></array>   <!-- Settings.bundle toggles, termination counter -->
    </dict>
  </array>
</dict></plist>
```

Kept out by construction: file-timestamp APIs (handler never reads attributes), disk-space APIs (no free-space UI; the web's `navigator.storage.estimate` is WebKit's, not ours), system boot time, active keyboards. No third-party SDKs, so no SDK manifests or signatures. App Store Connect "App Privacy" answer: **Data Not Collected**.

### 7.3 Entitlements

None. (No iCloud, App Groups, push, or background modes. Add-only Photos access needs no entitlement.) `Gesso.entitlements` is omitted from project.yml; automatic signing generates the minimal one.

### 7.4 Icon and launch

- `AppIcon`: a 1024×1024 PNG rendered from `apps/gesso/icon.svg` (Pigment Wheel, ground #0d0c0b), single-size asset (Xcode generates the rest). Optional later: an Icon Composer `.icon` layered version for iOS 26's rendering modes; a flat PNG renders fine under the new glass treatment.
- Launch: `UILaunchScreen` with only the `Ground` named colour — the web view's `backgroundColor` is the same colour and the page's `<body>` paints it, so launch → start screen is one continuous dark field with no flash and no fake screenshot to keep in sync with the web UI.
- `Settings.bundle`: About (version/build/web hash), "Open device probe on next launch", "Reset working size" (clears `gesso:workCap` via `evaluateJavaScript` on next launch), all driven by UserDefaults (the CA92.1 reason).

### 7.5 Review notes (paste into App Store Connect)

"Gesso is a fully offline photo editor. It makes no network requests (the app contains no networking code and enforces a content security policy that blocks all origins). Native features: PHPickerViewController import (no library permission), add-only Photos save with PHPhotoLibrary (prompt on first save), ProRAW/DNG decoding with ImageIO, Vision subject selection (Remove/Light → Outline → Subject), haptics. Demo: Choose a photo → Light → Auto → Save → Save to Photos (prompt) → the copy appears in Photos. Lockdown Mode disables WebGL, which the app reports and requires."

---

## 8. Persistence and migration

- IndexedDB `gesso` (blobs/docs/meta) and `localStorage gesso:*` live in `WKWebsiteDataStore.default()` for origin `gesso://localhost`, survive app updates (same container, same origin) and are deleted with the app. No Safari-tab migration (accepted). `persist()` is irrelevant natively (no eviction policy applies) and the probe says so.
- The 300 ms debounced write plus `flush()` on scene inactive/background and on memory warning bound the loss when iOS kills the WebContent process; `webViewWebContentProcessDidTerminate` → reload → restore path.
- Swift-owned state: `Caches/gesso-tmp` (swept at launch), `Application Support/gesso/drafts/<docId>` (RAW originals only; pruned by `pruneDrafts`), UserDefaults (settings, termination counter). Nothing else.
- Draft format changes stay governed by `lib/draft.js` `DRAFT_VERSION`; a native build never writes a draft the web could not read (the only new field, `info.decoder`, is optional and ignored by the web path).

---

## 9. Testing on the Mac

1. **Node** (`cd apps/gesso && npm test`): existing suites + `platform.test.mjs` + draft/image-io cases; `sw-shell.test.mjs` enforces `ui/platform.js` in SHELL.
2. **Playwright web mode** (unchanged, port 4174): proves the web app is unaffected; run before every push.
3. **Playwright native mode** (`node e2e/acceptance.mjs --native`): the flag + stub handlers; proves the seam's JS side end to end (picker interception on all four call sites, truthful Save, no install line, no SW registration).
4. **XCTest, simulator (iPhone 17 Pro, iOS 26)**:
   - `SchemeHandlerTests`: MIME for every extension in the bundle; `/` → index.html with CSP; query ignored; `..` and encoded traversal → 404; unknown path → 404; stop-before-finish does not crash; a 70 MB temp file streams in chunks.
   - `BridgeTests`: message decoding, error code formatting, `busy` serialisation.
   - `ImageDecoderTests`: a bundled test DNG (small, from the owner's phone) decodes to exactly `fitWorkingSize` dims twice (determinism), PNG is sRGB-tagged 8-bit; a HEIC with orientation 6 comes out oriented.
   - `SubjectLiftTests`: a bundled photo with an obvious subject yields ≥ 1 polygon with area in a plausible range; tap outside → union; runs on the simulator (CPU Vision, slower).
   - `WebAppSmokeTest` (the important one): hosts the real `WKWebView` with the real handler, loads `gesso://localhost/index.html`, waits for `window.gesso` (store open + editor), then loads `?probe=1`, awaits `window.gessoProbe.done` and asserts no FAIL rows among: WebGL2, IndexedDB Blob, scheme-served module worker, Origin/secure context (recorded, not asserted), Service worker (absent, asserted), Native bridge (hello round trip). This proves module MIME, workers under the scheme and IDB on the Mac before the first device run. Simulator caveats: MAX_TEXTURE_SIZE 8192, no 48 MP canvas assertion.
5. **XCUITest**: launch args `-GessoStubPicker fixture.jpg -GessoStubPhotos ok` make `PhotoPicker`/`PhotoSaver` return canned results; test: start screen has no install text, tap "Choose a photo", photo appears (query `window.gesso.editor.committed` via a hidden accessibility label the host updates), Save → Save to Photos → "Saved to Photos." visible.
6. **Device** (the only place for): PHPicker UI, the add-only prompt, haptics, `env()` insets, keyboard/visualViewport, 48 MP import, ProRAW from the camera, Lockdown opt-out, memory parity. Checklist = the probe rows + the SPEC §1b flow by hand.

New probe rows (ui/probe.js): **Native bridge** (`hello()` round trip: app/build/web hash, photosAdd status); **Origin / secure context** (`location.origin`, `isSecureContext`); **Service worker** (absent natively = PASS); **Scheme-served module worker** (constructs `new Worker(new URL('../workers/export-worker.js', import.meta.url), {type:'module'})` and encodes a 64×48 JPEG — a different code path from the blob-URL probe); **Keyboard inset** (info: `visualViewport` vs `platform.keyboardInset()`); **WebContent terminations** (from `hello()`).

---

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Custom scheme origin breaks IndexedDB or workers **[MH it works]** | `WebAppSmokeTest` in the simulator on day one of the shell; Capacitor precedent; if IDB were unavailable the app falls to the memory store and says so — not acceptable to ship, so this is the first thing checked. |
| Wrong MIME → blank page | MIME table tested; 404 instead of index fallback; `check-bundle.sh`. |
| `env()` insets are 0 in WKWebView | `getInsets()` fallback writes the CSS tokens (styles.css already uses `--safe-*`). Probe row. |
| `visualViewport` does not shrink for the keyboard | `onKeyboard` bridge from day one; text.js prefers it when present. |
| Base64 staging of a 12 MB JPEG is slow (~100–200 ms) or large | Chunked; measured in the probe; POST-body path if the scheme handler receives bodies (**[ML]**, verify once). |
| False "Saved" | Only a `performChanges` success or a completed activity calls `showDone`. |
| Photos add denied | Toast + Share… + `openSettings()`. |
| Restore mismatch after native decode | Decoder recorded in draft info; Swift produces exact w×h; XCTest determinism; existing app.js:241 guard still discards on mismatch. |
| RAW original duplicated (IDB + drafts/) | Only for natively decoded photos, one draft at a time, pruned with the draft, excluded from backup. |
| Vision mask vs texture orientation | Mask space is the oriented photo Swift decoded with transform; tap mapping uses natW/natH from the same decode. |
| Subject removal hits AREA_CAP | Honest tip in 1.0; cap decision deferred (§11). |
| WebContent jetsam under 48 MP + Vision | Vision/ImageIO run in the app process; `flush()` on memory warning; terminate → reload → restore. `physicalMemory` seeds a 12 MP default on < 6 GB devices via the flag. |
| Lockdown Mode | `isLockdownModeEnabled = false` **[M]**; reworded message as the floor. |
| Keyboard accessory bar | Accept for 1.0; `inputAccessoryView` override later if it bothers. |
| App name "Gesso" taken on the App Store | Check in App Store Connect on day one; fallback "Gesso Photo". |
| Review 4.2 | Native integrations + offline + notes (§7.5); screenshots of real editing. |
| Forgetting SHELL / bundle drift | `npm test` + `check-bundle.sh` both read the same list. |

---

## 11. Build order and estimates (owner's time; Swift/JS fluent)

| Phase | Work | Est. |
|---|---|---|
| 0 Web seam | `ui/platform.js`, app.js/importer/savesheet/draft/image-io/sw/probe diffs, node tests, Playwright web + `--native` smoke. Mergeable on its own; elsewhere.quest behaviour unchanged. | 1 day |
| 1 Shell | `project.yml`, sync/check scripts, scheme handler + MIME + CSP, WebViewHost config, flag script, icon, launch colour, `WebAppSmokeTest`; first run on the 17 Pro; probe rows green. **Day-one Xcode checklist:** `brew`'d xcodegen present → `cd apps/gesso-ios && xcodegen generate` → open → Signing & Capabilities: pick Team, confirm bundle id → plug in iPhone (Developer Mode on) → Run → start screen, no install line → Settings.bundle "Open probe" → copy report. | 1 day |
| 2 Photos in/out + haptics | PhotoPicker, TempStore, stage*, PhotoSaver, ShareSheet, openSettings; Haptics; sheet copy. | 1 day |
| 3 Lifecycle & durability | scenePhase/memory-warning flush, terminate → reload, insets/keyboard fallbacks; kill/background/relaunch tests. | 0.5 day |
| 4 RAW decode | ImageDecoder, drafts/ keep/prune, `decoder` marker, determinism XCTest, device test with a ProRAW. | 1 day |
| 5 Subject lift | SubjectLift.swift (mask → contours), Subject chip in Remove/Light, `submitOutline` extraction, haptic; device tuning of `maxSide`. | 1.5–2 days |
| 6 Store readiness | PrivacyInfo, Info.plist, App Store Connect record, screenshots (402×874 @3x from the device), review notes, `ITSAppUsesNonExemptEncryption`, TestFlight internal build, one external tester round. | 1 day |

Total ≈ 7–8 working days to a TestFlight build with everything in goals 1–6; iPad is a later phase (device family + a landscape/large-width pass on the web layout, already partially covered by the landscape side column).

## bridgeMethods

- hello() -> {bridge, app, build, web, ios, device, memoryGB, subjectLift, photosAdd}
- pickPhoto({source:'photos'|'files'}) -> {url,name,type,size,uti} | {cancelled:true}  [errors: busy]
- release({url}) -> {ok}
- probeImage({url}|{draftId}) -> {natW,natH,orientation,uti,bits,isRaw}  [errors: unsupported, notfound]
- decodeImage({url?|draftId?, keepAs?, w, h}) -> {url (PNG in _tmp), w, h, decoder:'imageio-1'}  [errors: unsupported, notfound, failed; 60 s timeout]
- pruneDrafts({keep:[docId]}) -> {removed}
- stageBegin({name,type}) -> {id}; stageChunk({id,b64}) -> {ok}; stageEnd({id}) -> {url,size}
- saveToPhotos({url,name}) -> {ok:true,id} | {ok:false, reason:'denied'|'restricted'|'failed', message}
- share({url,name}) -> {ok:true, completed, activity} | {cancelled:true}
- openSettings() -> {ok}
- subjectMask({x,y,maxSide?,draftId?}) -> {polys:[[x,y,...]], w, h, instances, picked}  [errors: unsupported, timeout 10 s]
- getInsets() -> {top,right,bottom,left}
- haptic({kind:'tick'|'light'|'medium'|'success'|'warning'|'error'})  (fire-and-forget, gessoFx)
- prepareHaptics()  (fire-and-forget, gessoFx)
- log({level,message})  (fire-and-forget, gessoFx)
- Swift -> JS: window.gessoNative.flush(); window.gessoNative.onKeyboard(px); window.gessoNative.onInsets({top,right,bottom,left})
- Injected flag (WKUserScript, .atDocumentStart, page world, main frame): window.__gessoNative = {bridge, app, build, web, ios, device, memoryGB, subjectLift, probe, reduceMotion}

## filesChangedInWebApp

- apps/gesso/ui/platform.js (new: the seam; web fallbacks; window.gessoNative)
- apps/gesso/app.js (import platform; #file click interceptor; install line, SW skip, onFlush, decoder in info, release/pruneDrafts, restore passes decoder+draftId, Lockdown copy)
- apps/gesso/ui/importer.js (decoder/draftId options; decodeNative via probeImage/decodeImage; native fallback in catch)
- apps/gesso/lib/image-io.js (importProblem(type,{native}) copy)
- apps/gesso/lib/draft.js (reviveInfo keeps info.decoder)
- apps/gesso/ui/autosave.js (loadDraft returns id)
- apps/gesso/ui/savesheet.js (nativeSave branch before shareRoute; #share-other; native copy; markSaved only on real ok)
- apps/gesso/index.html (hidden #share-other button in the sheet)
- apps/gesso/sw.js (SHELL += ./ui/platform.js)
- apps/gesso/ui/probe.js (native rows: bridge, origin/secure context, service worker, scheme-served module worker, keyboard inset; relabelled display-mode/persist rows; share-based Copy fallback)
- apps/gesso/ui/ruler-view.js (haptic tick in flash())
- apps/gesso/ui/editor.js (haptic light on Done)
- apps/gesso/ui/tools/remove.js (Subject chip in Outline; submitOutline extraction; haptic success on land)
- apps/gesso/ui/tools/light.js (Subject chip in Outline; submitOutline extraction)
- apps/gesso/ui/tools/text.js (keyboardInset fallback in place(); haptic light on snap)
- apps/gesso/test/platform.test.mjs (new) + cases in test/draft.test.mjs and test/image-io.test.mjs
- apps/gesso/e2e/acceptance.mjs (optional --native flag with flag + messageHandlers stub)
- apps/gesso/README.md (native honesty paragraph)

## openQuestionsForOwner

- Bundle id and team: quest.elsewhere.gesso under your Apple Developer account? (A paid Developer Program membership is required for TestFlight/App Store; free provisioning only gives 7-day device builds.) Is the App Store name 'Gesso' available, or do we need 'Gesso Photo'?
- Origin: gesso://localhost (likely a secure context, Capacitor precedent) vs gesso://app — pinned forever either way; confirm before the first device build writes a draft.
- Minimum iOS: 17.0 (needed for Vision foreground masks and isInspectable) — acceptable, or do you want 18 to simplify?
- Remove's 20% AREA_CAP for Subject removal: keep the honest tip in 1.0, raise the cap natively, or add a tile-it strategy later?
- Lockdown Mode: attempt the in-app opt-out (isLockdownModeEnabled=false) or just reword the message?
- Files app as a second import source in 1.0 ('Or from Files' on the start screen), or later?
- Keyboard accessory bar (‹ › Done) above the caption bar: accept for 1.0 or remove via the inputAccessoryView override?
- Settings.bundle (About, Open probe, Reset working size) — fine to ship, or keep the probe DEBUG-only (shake gesture)?
- Should the native build also register as an 'Open in Gesso' target from the Photos share sheet (CFBundleDocumentTypes / a share extension) in a later release?
- iPad timing: ship iPhone-only for 1.0 as proposed?
