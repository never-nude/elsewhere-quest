<!-- Draft produced by apps/gesso/design/workflows/gesso-ios-design.js on 2026-10-20 (run stopped after the Judge phase); raw agent output, exported verbatim. -->

# Design (native-first): Gesso for iOS (option A): SwiftUI shell + WKWebView + native bridges, "native where it matters"

A small UIKit/SwiftUI host (apps/gesso-ios, XcodeGen) serves the unchanged web editor from the bundle over a pinned custom origin gesso://app via WKURLSchemeHandler (correct MIME, explicit 404s, no service worker, default persistent WKWebsiteDataStore), injects window.__gessoNative at document start, and exposes one promise bridge (WKScriptMessageHandlerWithReply "gesso") plus one fire-and-forget channel ("gessoFx" for haptics). The web app gains one seam, ui/platform.js (isNative + pickPhoto/saveToPhotos/share/decode/subjectAt/haptic with web fallbacks) and one helper ui/subject.js; app.js, editor.js, importer.js, savesheet.js, remove.js, light.js, ruler-view.js, probe.js, index.html and sw.js get small diffs. Photos come in through PHPickerViewController (no permission), RAW/DNG are developed natively (ImageIO/CIRAWFilter) into an exact working-size sRGB PNG that replaces the original in the draft (so restores stay bit-exact without a new decoder invariant), Save to Photos is a real PHPhotoLibrary add with a truthful result and a native share sheet behind it, Vision foreground masks become polygons that enter Remove and Light through the same code path as a lasso loop, haptics follow a six-word vocabulary, and scene phases/memory warnings/content-process termination flush and restore the draft. Build order is nine steps, roughly 7-8 working days, with node tests, a Playwright "native mode" stub, XCTest for the scheme handler/contour tracer/decoder, and on-device probe rows for the facts that only the device can settle (isSecureContext, env() insets, visualViewport with the keyboard, scheme-served module workers, POST bodies to the scheme handler).

# Gesso for iOS — option A design ("native where it matters")

Everything below was checked against the working tree on branch `claude/gesso-ios` (apps/gesso: app.js, ui/importer.js, lib/image-io.js, ui/savesheet.js, ui/exporter.js, ui/heal-client.js, ui/store.js, ui/autosave.js, lib/draft.js, sw.js, test/sw-shell.test.mjs, ui/probe.js, ui/tools/remove.js, ui/tools/light.js, ui/editor.js, ui/renderer.js, index.html, .github/workflows/deploy.yml). Line references are to that tree. Nothing in the repo was modified. Confidence on WKWebView/iOS facts is stated inline as **[high]**, **[medium-high]**, **[medium]**, **[low]**; every medium-or-lower fact has a fallback and a probe row.

## 0. Shape in one paragraph

A UIKit `EditorViewController` whose view is a single edge-to-edge `WKWebView`, wrapped for SwiftUI (`UIViewControllerRepresentable`) so the `App` gets `scenePhase`. The web app is copied verbatim from `apps/gesso` into the bundle (`web/`, minus test/e2e/design/SPEC/package.json, exactly deploy.yml's exclusions) and served by a `WKURLSchemeHandler` at the origin **`gesso://app`** (pinned forever: the origin is the key to IndexedDB `gesso` and `localStorage gesso:*`). A `WKUserScript` at document start sets `window.__gessoNative`. JS calls Swift through `window.webkit.messageHandlers.gesso.postMessage({...})` (reply-capable, promise per call) and `gessoFx` (no reply, haptics). Swift calls JS only through `evaluateJavaScript("window.gesso?.x?.()")`. The web app on elsewhere.quest is unchanged in behaviour: every native call lives behind `ui/platform.js`, which is a no-op/fallback module when the flag is absent.

## 1. App structure

```
apps/gesso-ios/                      # sibling of apps/gesso; deploy.yml never copies it
  project.yml                        # XcodeGen
  Gesso/
    App/GessoApp.swift               # @main App, scenePhase -> Lifecycle
    App/EditorScreen.swift           # UIViewControllerRepresentable(EditorViewController), .ignoresSafeArea()
    App/EditorViewController.swift   # owns WKWebView, presents pickers/sheets, status bar, keyboard notifs
    Web/WebHost.swift                # WKWebViewConfiguration factory (data store, scheme, scripts, prefs)
    Web/SchemeHandler.swift          # WKURLSchemeHandler: bundle web/ + _tmp/, MIME, 404, CSP
    Web/Mime.swift                   # extension -> Content-Type
    Web/BundleWeb.swift              # path resolution with traversal rejection
    Web/TempFiles.swift              # tmp/gesso-bridge/<uuid>.<ext>, purge on launch
    Bridge/Bridge.swift              # WKScriptMessageHandlerWithReply dispatcher (async)
    Bridge/BridgeMessage.swift       # Codable request/reply, error codes
    Bridge/PhotoPicker.swift         # PHPickerViewController
    Bridge/PhotosSaver.swift         # PHPhotoLibrary add-only
    Bridge/ShareSheet.swift          # UIActivityViewController
    Bridge/NativeDecoder.swift       # ImageIO + CIRAWFilter -> exact-size sRGB PNG
    Bridge/SubjectLift.swift         # VNGenerateForegroundInstanceMaskRequest -> polygons
    Bridge/ContourTracer.swift       # marching squares on a binary mask
    Bridge/Haptics.swift             # prepared generators, vocabulary
    Bridge/Lifecycle.swift           # flush on inactive/background, memory warning, process termination
    Resources/Assets.xcassets        # AppIcon (1024, dark variant), LaunchBackground (#0d0c0b)
    Resources/PrivacyInfo.xcprivacy
    Scripts/copy-web.sh              # rsync apps/gesso -> $TARGET_BUILD_DIR/.../web (deploy.yml exclusions)
    Scripts/check-bundle.sh          # sw.js SHELL vs bundle (mirrors test/sw-shell.test.mjs)
    Scripts/render-icon.mjs          # Playwright renders icon.svg (clip removed) at 1024
  GessoTests/                        # XCTest: SchemeHandler, Mime, BundleWeb, Bridge codec, ContourTracer, NativeDecoder, BundleManifest
  GessoUITests/                      # XCUITest: launch+start screen, probe via launch argument, save flow in Simulator
```

### XcodeGen `project.yml` outline

```yaml
name: Gesso
options:
  bundleIdPrefix: quest.elsewhere          # owner to confirm
  deploymentTarget: { iOS: "17.0" }        # Vision foreground mask needs 17
  createIntermediateGroups: true
settings:
  base:
    SWIFT_VERSION: "6.0"
    TARGETED_DEVICE_FAMILY: "1"            # iPhone now; "1,2" when iPad lands
    MARKETING_VERSION: "1.0"
    CURRENT_PROJECT_VERSION: "1"
    ENABLE_USER_SCRIPT_SANDBOXING: "NO"    # copy-web.sh reads ../gesso
    ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon
    INFOPLIST_KEY_UIUserInterfaceStyle: Dark
targets:
  Gesso:
    type: application
    platform: iOS
    sources: [Gesso]
    info:
      path: Gesso/Info.plist
      properties:
        CFBundleDisplayName: Gesso
        UILaunchScreen: { UIColorName: LaunchBackground }
        UISupportedInterfaceOrientations: [UIInterfaceOrientationPortrait, UIInterfaceOrientationLandscapeLeft, UIInterfaceOrientationLandscapeRight]
        UIViewControllerBasedStatusBarAppearance: true
        UIUserInterfaceStyle: Dark
        NSPhotoLibraryAddUsageDescription: "Gesso saves your edited copy as a new photo. Your original isn't changed."
        ITSAppUsesNonExemptEncryption: false
        LSRequiresIPhoneOS: true
        UIApplicationSceneManifest: { UIApplicationSupportsMultipleScenes: false }
    postBuildScripts:
      - name: Copy web app
        script: "\"$SRCROOT/Gesso/Scripts/copy-web.sh\""
        inputFiles: ["$(SRCROOT)/../gesso/sw.js"]
        outputFiles: ["$(TARGET_BUILD_DIR)/$(UNLOCALIZED_RESOURCES_FOLDER_PATH)/web/index.html"]
      - name: Check web bundle against sw.js SHELL
        script: "\"$SRCROOT/Gesso/Scripts/check-bundle.sh\""
    scheme:
      testTargets: [GessoTests, GessoUITests]
      commandLineArguments: { "-GessoProbe": false }   # toggle to open ?probe=1
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
```

`copy-web.sh`: `rsync -a --delete --exclude test/ --exclude e2e/ --exclude design/ --exclude SPEC.md --exclude package.json --exclude node_modules/ --exclude '.*' "$SRCROOT/../gesso/" "$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/web/"` then writes `web/VERSION` from `git -C "$SRCROOT/../gesso" rev-parse --short HEAD` (the probe and `ping` show it). sw.js is copied too (harmless: never registered natively; `check-bundle.sh` parses its `SHELL`). `check-bundle.sh`: extracts every `'./…'` literal from `const SHELL = [...]`, fails the build if any is missing from `web/` — the same contract as `test/sw-shell.test.mjs`, so a forgotten module fails on the Mac, never as a scheme 404 on the phone.

## 2. Serving the web app

### Origin and URL
- Scheme `gesso`, host `app`, page URL `gesso://app/` (served as `index.html`); `gesso://app/?probe=1` for the probe. The query string is ignored by the handler and reaches `app.js:23` unchanged.
- **Never** `file://` **[high]**: opaque origin, IndexedDB unreliable, `new URL(import.meta.url)` worker fetches and the dynamic `import('../lib/heal.js')` at heal-client.js:82 fail.
- The origin never changes. Changing scheme or host silently orphans IndexedDB `gesso` and `localStorage gesso:*` (`store.js:30`, `app.js:25`, `savesheet.js:30`, `hints.js:31-32`) **[high]**. A unit test asserts the constants.

### `SchemeHandler.swift` (sketch)

```swift
final class GessoSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "gesso", host = "app"
    private var live: [ObjectIdentifier: WKURLSchemeTask] = [:]   // stop() before finish() must not crash
    func webView(_ wv: WKWebView, start task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task); live[id] = task
        guard let url = task.request.url, url.host == Self.host else { return respond(id, 404) }
        let path = url.path.isEmpty || url.path == "/" ? "/index.html" : url.path     // query ignored
        let file: URL? = path.hasPrefix("/_tmp/") ? TempFiles.resolve(String(path.dropFirst(6)))   // ^[A-Za-z0-9-]+\.[a-z0-9]+$ only
                                                   : BundleWeb.resolve(path)               // standardized, must stay under web/, no dirs, no symlinks
        guard let file else { return respond(id, 404) }
        DispatchQueue.global(qos: .userInitiated).async {
            // bundle files: Data(contentsOf:); _tmp files: FileHandle in 1 MB chunks
            DispatchQueue.main.async { guard self.live[id] != nil else { return } /* didReceive(response), didReceive(data)..., didFinish() */ }
        }
    }
    func webView(_ wv: WKWebView, stop task: WKURLSchemeTask) { live[ObjectIdentifier(task)] = nil }
}
```

- Response: `HTTPURLResponse(url:, statusCode: 200, httpVersion: "HTTP/1.1", headerFields:)` with `Content-Type` (+ `; charset=utf-8` for text), `Content-Length`, `Cache-Control: no-store` (bundle reads are local; this makes an app update take effect at the next launch with no stale module). 404 is a real 404 with a one-line body; **no SPA fallback** to index.html (it would mask bundle omissions).
- MIME table (`Mime.swift`): `.html text/html`, `.js/.mjs text/javascript` (module scripts and module workers are MIME-strict), `.css text/css`, `.json application/json`, `.webmanifest application/manifest+json`, `.svg image/svg+xml`, `.png image/png`, `.jpg/.jpeg image/jpeg`, `.webp image/webp`, `.dng image/x-adobe-dng`, `.heic image/heic`, `.txt text/plain`, default `application/octet-stream`.
- `index.html` only gets a belt-and-braces CSP header: `default-src 'none'; script-src gesso://app; style-src gesso://app 'unsafe-inline'; img-src gesso://app blob: data:; worker-src gesso://app blob:; connect-src gesso://app; font-src gesso://app; manifest-src gesso://app; frame-src 'none'`. `blob:`/`data:` are needed by the long-press `<img>` (object URL), the shimmer's SVG `mask-image` data URL (remove.js), and the probe's blob worker. Whether WebKit honours CSP from a scheme-handler response is **[medium-high]**; the `decidePolicyFor` guard below is the hard stop anyway.
- Dedicated and module workers (`exporter.js:157`, `heal-client.js:53`) load through the handler **[medium-high]**; both have main-thread fallbacks (`encodeOnMainThread`, `runHere`) so a failure degrades rather than breaks; probe row P4 proves it.
- Service workers: unavailable under a custom scheme (only App-Bound Domains over https) **[high]**; the app skips registration (section 6).
- Secure context: whether `gesso://app` is `isSecureContext` is **[medium]** (WebKit may treat scheme-handler schemes as potentially trustworthy). It decides whether `navigator.share`, `navigator.clipboard` and `navigator.storage` exist. The design does not depend on the answer: the platform seam routes share/save natively whenever `isNative`, the probe's Copy has an `execCommand` fallback, and `store.js:60` already returns `false` when `persist` is missing. Probe row P2 reports it.

### `WebHost.swift` (configuration)

```swift
let cfg = WKWebViewConfiguration()
cfg.websiteDataStore = .default()                       // persistent, app-owned (never .nonPersistent())
cfg.setURLSchemeHandler(GessoSchemeHandler(), forURLScheme: "gesso")
cfg.defaultWebpagePreferences.preferredContentMode = .mobile
cfg.defaultWebpagePreferences.allowsContentJavaScript = true
cfg.defaultWebpagePreferences.isLockdownModeEnabled = false   // iOS 16.3+ [medium]; also set in decidePolicyFor(…, preferences:)
let ucc = cfg.userContentController
ucc.addUserScript(WKUserScript(source: NativeFlag.script(), injectionTime: .atDocumentStart, forMainFrameOnly: true)) // page world
ucc.addScriptMessageHandler(bridge, contentWorld: .page, name: "gesso")   // WKScriptMessageHandlerWithReply
ucc.add(haptics, contentWorld: .page, name: "gessoFx")                    // WKScriptMessageHandler
let web = WKWebView(frame: .zero, configuration: cfg)
web.isOpaque = false; web.backgroundColor = .ground; web.underPageBackgroundColor = .ground   // #0d0c0b, never a white flash
web.scrollView.isScrollEnabled = false; web.scrollView.bounces = false
web.scrollView.contentInsetAdjustmentBehavior = .never
web.scrollView.pinchGestureRecognizer?.isEnabled = false  // the page's gesturestart preventDefault (app.js:34) covers the rest
web.scrollView.keyboardDismissMode = .none
web.allowsLinkPreview = false; web.allowsBackForwardNavigationGestures = false
#if DEBUG
web.isInspectable = true                                  // Safari Web Inspector from the Mac
#endif
web.load(URLRequest(url: URL(string: launchedWithProbe ? "gesso://app/?probe=1" : "gesso://app/")!))
```

`WKNavigationDelegate.decidePolicyFor navigationAction`: `.allow` only for `gesso://app`; everything else `.cancel` (there are no links in the app; this is the "no network" hard stop). `WKUIDelegate.createWebViewWith` returns nil.

### Injected flag (`NativeFlag.script()`)

```js
window.__gessoNative = Object.freeze({
  api: 1, bridge: 'gesso', fx: 'gessoFx',
  app: '1.0', build: '1', web: '<web/VERSION>', os: '26.0.1', device: 'iPhone18,1',
  memoryBytes: 8589934592, lockdown: false,
  insets: { top: 59, right: 0, bottom: 34, left: 0 }   // the host view's safeAreaInsets at creation; refreshed via window.gesso.insets()
});
```
Injected at document start in the page world, before the module script `app.js` evaluates **[high]**.

## 3. The bridge contract

Transport: `window.webkit.messageHandlers.gesso.postMessage(body)` → Promise (WKScriptMessageHandlerWithReply, iOS 14+ **[high]**). Bodies are plist-serialisable only (strings, numbers, booleans, null, arrays, dictionaries): no ArrayBuffer, so binary goes as base64 (small) or through tmp files served at `gesso://app/_tmp/<uuid>.<ext>` (large).

Request body: `{ v: 1, id: "c17", method: "pickPhoto", args: {...} }`. Reply (always via `replyHandler(dict, nil)` so codes survive): `{ ok: true, result: {...} }` or `{ ok: false, code: "denied", message: "..." }`. Swift implements `userContentController(_:didReceive:) async -> (Any?, String?)` and dispatches on `method`. Unknown method → `code: "unknown"`. The JS side times out per method and ignores a late reply by `id`.

| Method (args) | Reply `result` | Error codes | JS timeout | Transfer |
|---|---|---|---|---|
| `ping()` | `{ app, build, web, api, os, device, memoryBytes, insets, lockdown, engines: [] , postBody: bool }` | – | 2 s | – |
| `pickPhoto()` | `{ url, name, type, size } \| null` (null = cancelled) | `busy`, `unavailable` | none (user-driven) | Swift copies the picked file to `_tmp` |
| `imageInfo({ url })` | `{ natW, natH, uti, raw: bool, webkitCanDecode: bool }` (oriented dims) | `unreadable` | 10 s | – |
| `decodeImage({ url, w, h })` | `{ url, w, h }` (PNG, 8-bit sRGB, oriented, exactly w×h) | `unreadable`, `memory`, `size` | 60 s | `_tmp` PNG |
| `release({ url })` | `{}` (idempotent) | – | 5 s | – |
| `beginFile({ name, type, size })` | `{ token }` | `space` | 10 s | – |
| `appendFile({ token, base64 })` | `{ received }` | `badToken` | 10 s each | ≤ 4 MB base64 per call |
| `finishFile({ token })` | `{ url, size }` | `badToken`, `short` | 10 s | file complete in `_tmp` |
| `saveToPhotos({ url })` | `{ saved: true, assetId }` or `{ saved: false, reason: 'denied'\|'restricted'\|'failed', message }` | `badUrl` | none (permission prompt) | reads `_tmp` |
| `share({ url, name })` | `{ completed: bool, activity: string \| null }` | `badUrl` | none | reads `_tmp` |
| `openSettings()` | `{}` | – | 2 s | – |
| `subjectAt({ image: base64 JPEG, x, y, radius })` | `{ found: bool, polygons: number[][], w, h, instances }` (polygons = flat `[x,y,...]` in the analysed image's px; largest first; holes dropped) | `unsupported`, `timeout`, `badImage` | 20 s | ≤ ~500 KB base64 |
| `heal(...)` (reserved) | – | `unsupported` | – | future Metal engine (section 11) |

Fire-and-forget channel `gessoFx`: `{ kind: 'prepare'|'tick'|'light'|'medium'|'success'|'warning'|'error' }`.

Swift → JS (all optional-chained so a call before `main()` finishes is a no-op, never a thrown completion):
- `window.gesso?.flush?.()` — on `scenePhase` `.inactive` and `.background`, on `UIApplication.didReceiveMemoryWarningNotification`.
- `window.gesso?.insets?.({top,right,bottom,left})` — on `viewSafeAreaInsetsDidChange` (used only if env() turns out wrong, section 7).
- `window.gesso?.keyboard?.({ height, duration })` — from `UIResponder.keyboardWillChangeFrameNotification` (used only if visualViewport does not shrink, section 7).

## 4. Web-side seam: `ui/platform.js`

Rules: imported by app.js, editor.js (via option), importer.js, savesheet.js, remove.js, light.js, ruler-view.js, probe.js; touches no DOM at module top level (so node can import it); `isNative` is true only when both the flag and the handler exist; every export has the web behaviour as its fallback.

```js
// ui/platform.js — the one seam between Gesso and the iOS app (apps/gesso-ios).
const flag = globalThis.__gessoNative ?? null;
const handlers = globalThis.webkit?.messageHandlers ?? null;
export const isNative = !!(flag && flag.api === 1 && handlers?.[flag.bridge]);
export const native = isNative ? flag : null;

let seq = 0;
const TIMEOUT = { ping: 2000, imageInfo: 10000, decodeImage: 60000, release: 5000, beginFile: 10000, appendFile: 10000, finishFile: 10000, openSettings: 2000, subjectAt: 20000 };
export function call(method, args = {}) {
  if (!isNative) return Promise.reject(Object.assign(new Error('not native'), { code: 'web' }));
  const id = `c${++seq}`;
  let timer = 0;
  const p = Promise.resolve(handlers[flag.bridge].postMessage({ v: 1, id, method, args })).then((r) => {
    if (r?.ok) return r.result;
    throw Object.assign(new Error(r?.message ?? 'bridge error'), { code: r?.code ?? 'failed' });
  }, (err) => { throw Object.assign(new Error(String(err?.message ?? err)), { code: 'failed' }); });
  const ms = TIMEOUT[method];
  if (!ms) return p;
  return Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`${method} timed out`), { code: 'timeout' })), ms); })])
    .finally(() => clearTimeout(timer));
}

export function haptic(kind) { if (!isNative) return; try { handlers[flag.fx].postMessage({ kind }); } catch { /* never throws into a stroke */ } }
let lastTick = 0;
export function tick() { const t = performance.now(); if (t - lastTick < 50) return; lastTick = t; haptic('tick'); }

// Picked photos: Swift hands over a tmp URL; the bytes enter the page only when WebKit will decode them.
const NATIVE_INFO = Symbol('gesso:native');
export async function pickPhoto({ maxPixels } = {}) {
  const picked = await call('pickPhoto');
  if (!picked) return null;                                   // cancelled: the caller does nothing (T17)
  const info = await call('imageInfo', { url: picked.url });
  let file;
  if (info.raw || !info.webkitCanDecode) {                    // DNG / ProRAW / camera RAW / anything WebKit refuses
    const fit = fitWorkingSize(info.natW, info.natH, maxPixels);
    const png = await call('decodeImage', { url: picked.url, w: fit.width, h: fit.height });
    file = await fetchFile(png.url, picked.name, 'image/png');
    file[NATIVE_INFO] = { natW: info.natW, natH: info.natH, downscaled: fit.downscaled, decoder: 'native', srcType: info.uti };
    call('release', { url: png.url }).catch(() => {});
  } else {
    file = await fetchFile(picked.url, picked.name, picked.type);
    file[NATIVE_INFO] = { url: picked.url };                  // kept until the importer is done, for a native rescue
  }
  call('release', { url: picked.url }).catch(() => {});
  return file;
}
export const nativeInfo = (file) => file?.[NATIVE_INFO] ?? null;
async function fetchFile(url, name, type) { const blob = await (await fetch(url)).blob(); return new File([blob], name, { type }); }

// Blob -> tmp file on the Swift side, in ≤4 MB base64 chunks (no ArrayBuffer crosses the bridge).
export async function putFile(blob, name, type = blob.type) {
  const { token } = await call('beginFile', { name, type, size: blob.size });
  const CHUNK = 3 * 1024 * 1024;
  for (let at = 0; at < blob.size; at += CHUNK) await call('appendFile', { token, base64: await toBase64(blob.slice(at, at + CHUNK)) });
  return call('finishFile', { token });                        // { url, size }
}
export async function saveToPhotos(blob, name) { const f = await putFile(blob, name, 'image/jpeg'); try { return await call('saveToPhotos', { url: f.url }); } finally { call('release', { url: f.url }).catch(() => {}); } }
export async function share(blob, name)        { const f = await putFile(blob, name, 'image/jpeg'); try { return await call('share', { url: f.url, name }); } finally { call('release', { url: f.url }).catch(() => {}); } }
export const openSettings = () => call('openSettings').catch(() => {});

// Vision subject lift on the analysis image the lasso already uses (section 5.2).
export async function subjectAt(img, x, y, { radius = 12 } = {}) {   // img: { data, width, height } from ed.readOutput
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  c.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  const jpeg = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  c.width = c.height = 0;
  return call('subjectAt', { image: await toBase64(jpeg), x, y, radius });
}
export const subjectLiftAvailable = () => isNative && (native.os?.split('.')[0] | 0) >= 17;

export function decodeNativeFrom(file, { maxPixels }) { /* importer's rescue path: nativeInfo(file).url or putFile(file), then imageInfo + decodeImage + fetchFile; returns the PNG File with NATIVE_INFO set */ }
export function insets() { return native?.insets ?? null; }
```
(`fitWorkingSize` imported from `../lib/image-io.js`; `toBase64` = `FileReader.readAsDataURL` minus the prefix.)

## 5. How each goal is met

### 5.1 Goal 1 — Photos in and out without the share-sheet dance

**Import (`PhotoPicker.swift`).** `PHPickerConfiguration()` (no `photoLibrary:` → no identifiers, no permission **[high]**), `filter = .images`, `selectionLimit = 1`, `preferredAssetRepresentationMode = .current` (HEIC stays HEIC, which this device decodes — probe PASS; ProRAW arrives as DNG and goes to the native decoder, section 5.5). Presented from `EditorViewController` (`present(picker, animated: true)`); a second `pickPhoto` while one is up replies `busy`. In the delegate: `provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier)`; the URL is only valid inside the completion, so Swift **moves** it to `tmp/gesso-bridge/<uuid>.<ext>` before returning (`ext` from the provider's UTI), then replies `{ url: "gesso://app/_tmp/<uuid>.heic", name: provider.suggestedName ?? "photo", type, size }`. Cancel replies `null`. A 75 MB ProRAW is never base64'd and, because of `imageInfo` + `decodeImage` in `pickPhoto` (section 4), its bytes never enter the WebContent process at all: only the working-size PNG does.

**JS wiring (app.js).** One function owns "open the picker" and replaces the four `fileInput.click()` sites:

```js
// app.js — top of main(), before `await openStore()` so the start screen works from first paint
import { isNative, pickPhoto, haptic } from './ui/platform.js';
let onFile = null;                       // importFile once the editor exists; earlyFile before
const choose = $('#choose');
if (isNative) { choose.removeAttribute('for'); choose.addEventListener('click', (e) => { e.preventDefault(); openPicker(); }); }
function openPicker() {
  if (!isNative) { fileInput.click(); return; }
  pickPhoto({ maxPixels: workCap() }).then((file) => {
    if (!file) return;                   // cancelled: same as a dismissed file dialog (confirm's Discard already ran autosave.discard)
    if (onFile) onFile(file); else earlyFile = file;
  }).catch((err) => { console.warn('pick', err); $('#hint').textContent = "Couldn't open the photo picker."; });
}
// keydown on #choose (app.js:104): openPicker() instead of fileInput.click()
// askNewPhoto (app.js:190) and confirm 'discard' (app.js:214): openPicker()
// after importFile is defined: onFile = importFile;
// createEditor({ ..., onChoosePhoto: openPicker })   and editor.js:694: `if (!current()) { onChoosePhoto?.() ?? root.querySelector('#file').click(); return; }`
```
The `earlyFile` and "picked beats restore" semantics (app.js:93-98, 222-232) are preserved: a native pick that lands before `onFile` is set is parked exactly like an early `<input>` change. Removing `for` on the label when native stops the no-JS path from opening the web picker underneath the native one (T01 risk).

**Save to Photos (`PhotosSaver.swift`).**
```swift
func save(fileURL: URL, name: String) async -> Reply {
    let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
    guard status == .authorized else { return .init(saved: false, reason: status == .restricted ? "restricted" : "denied") }
    do {
        try await PHPhotoLibrary.shared().performChanges {
            let req = PHAssetCreationRequest.forAsset()
            let opts = PHAssetResourceCreationOptions(); opts.originalFilename = name
            req.addResource(with: .photo, fileURL: fileURL, options: opts)
        }
        return .init(saved: true)
    } catch { return .init(saved: false, reason: "failed", message: error.localizedDescription) }
}
```
The permission prompt appears on the first save (`NSPhotoLibraryAddUsageDescription`); add-only never grants read access, so the "everything stays on this iPhone" story is intact.

**Sheet changes (`ui/savesheet.js`).** `onShareClick` grows one branch at the top of the share section; nothing else in the sheet (job lifecycle, abort on close, swipe, preview) changes:
```js
if (isNative) {
  sharing = true; ui.share.disabled = true; ui.share.removeAttribute('data-ready'); ui.label.textContent = 'Saving…';
  saveToPhotos(j.blob, exportFileName(new Date())).then((r) => settleNative(j, r), (err) => settleNative(j, { saved: false, reason: 'failed', message: err.message }));
  return;
}
function settleNative(j, r) {
  sharing = false;
  if (!session || job !== j) return;                            // closed, or a different photo by now (T17 ordering kept)
  const o = nativeSaveOutcome(r);                                // lib/export-plan.js, pure, tested
  if (o === 'saved') { haptic('success'); ui.success.textContent = 'Saved to Photos.'; showDone(j); return; }
  haptic('warning');
  if (o === 'denied') { ui.coach.hidden = false; ui.coach.textContent = 'Photos access is off for Gesso. Allow it in Settings, or share the copy instead.'; ui.settings.hidden = false; }
  else editorToast("Couldn't save to Photos. Try Share instead.");
  showJob(j);
}
```
- `#share-more` ("Share…", `UIActivityViewController`) is a second button in `#sheet-main`, unhidden when `isNative`; its result `{completed, activity}` marks saved only when `activity === 'com.apple.UIKit.activity.SaveToCameraRoll' && completed` (a real Photos write), otherwise just closes nothing and keeps the sheet. `#sheet-settings` ("Open Settings") calls `openSettings()`. The coach line "Next, tap Save Image." is hidden when native (`ui.coach.hidden = savedOnce() || isNative`); `#sheet-done`'s copy is set from JS (give the `<p>` an id `sheet-success`).
- `markSaved()` fires only on a confirmed `saved: true` (or the SaveToCameraRoll activity), so `editor.isSaved` and the New-photo confirm ("This edit isn't in Photos yet.", app.js:198) become truthful (T03/T17).
- `showFallback` and the `shareOutcome === 'failed'` branch: when `isNative` they call `share()` instead of showing `#fallback` (T04); the DOM and CSS stay for the web.
- `lib/export-plan.js` gains `export function nativeSaveOutcome(r) { if (r?.saved === true) return 'saved'; if (r?.reason === 'denied' || r?.reason === 'restricted') return 'denied'; return 'failed'; }` with node tests.
- The 3–12 MB JPEG crosses the bridge in ≤ 4 MB base64 chunks (`putFile`), ~100–300 ms; the button shows "Saving…" and stays disabled under the existing `sharing` guard until the reply.

### 5.2 Goal 2 — Vision subject lift ("tap the subject") through the Outline mask path

**Choice: polygon entry (option A of the outline map).** Everything below `finishTrace` in remove.js (`outlineBox`, `outlineMask`, `rubTile`, `land`, `recipeRecord`, shimmer, overlay, Try another) and in light.js/editor.js (`replayPaint` → `outlinePaint` → `renderer.paintMask`, the Amount ruler, `revivePools`) is untouched because the stored recipe is a polygon in source px. Raster masks (option B) are deferred; the design keeps the door open (section 11).

**UX.** While Outline is on (Remove or Light) and the app is native: a **tap** on the photo lifts the subject under the finger; a **drag** still traces a loop. Hint copy when native: "Tap it, or loop around it. The line snaps to edges." Today a tap in Remove › Outline heals a spot (remove.js:213 `tap(ed, g.x, g.y)` runs regardless of `dial`) and in Light › Outline does nothing (`traceGesture` has no `tap` case), so the hook is one `case` each. Progress state: the hint line reads "Finding the subject…" (module flag `lifting` + `ed.refresh()`), `haptic('light')` on the tap, `haptic('medium')` when the outline lands (Remove then shimmers and fills as a traced loop would), `haptic('warning')` + toast "No subject there. Loop around it instead." on `found: false`. Multi-component results submit the largest polygon only (one undo step); the rest are offered later if wanted.

**Analysis image.** JS sends the same image the lasso analyses: `ed.readOutput({ maxSide: ANALYSIS_PX (1024), tone: false })` encoded as a JPEG q0.85 (≈ 150–400 KB, one message). Vision then sees the *current* photo (crop, fills, flips applied) and Swift keeps no image state; the polygon comes back in analysis px, so the conversion to source px is exactly finishTrace's `toSource` matrix (`multiply(outputToSource(st.crop, st.source.w, st.source.h), [1/kx, 0, 0, 1/ky, 0, 0])`, remove.js:412 / light.js:402). Vision's foreground model works at its own internal resolution, so 1024 px costs nothing in mask quality that the S/4 paint mask (renderer.js:434) or the 2 px dilation would keep anyway.

**Swift (`SubjectLift.swift`).**
```swift
func subject(at p: CGPoint, radius: Double, jpeg: Data) throws -> SubjectReply {
    let handler = VNImageRequestHandler(data: jpeg, orientation: .up)
    let req = VNGenerateForegroundInstanceMaskRequest()            // iOS 17+, on-device
    try handler.perform([req])
    guard let obs = req.results?.first else { return .none }
    let idx = obs.instance(at: p, in: imageSize, searchRadius: radius)   // read obs.instanceMask (OneComponent8) at the tap scaled to the mask; 0 = background → nearest instance within radius; none → found:false
    guard idx != 0 else { return .none }
    let mask = try obs.generateScaledMaskForImage(forInstances: IndexSet(integer: idx), from: handler)  // float mask at image size
    let binary = Binary(mask, threshold: 0.5)                       // [UInt8] w*h
    let rings = ContourTracer.trace(binary)                          // marching squares; exterior rings only; drop rings < 0.5% of the image
        .sorted { $0.area > $1.area }
    return SubjectReply(found: true, polygons: rings.map(\.flat), w: w, h: h, instances: obs.allInstances.count)
}
```
Marching squares is ~80 lines and unit-testable on synthetic masks (a disc, two blobs, a ring with a hole); `VNDetectContoursRequest` is the alternative if the owner prefers not to own the tracer. Vision on this device runs the mask in roughly 100–300 ms at 1024 px **[medium]**. `VNGenerateForegroundInstanceMaskRequest` may be unsupported in the Simulator **[medium-low]**; the bridge replies `unsupported` and the web path (loop) remains.

**JS (`ui/subject.js`, new, shared by both tools).**
```js
export async function liftSubject(ed, x, y, { analysisPx, tiny, haptics = true }) {
  const st = ed.committed;
  const a = ed.readOutput({ maxSide: analysisPx, tone: false });
  const o = ed.outputSize();
  const kx = a.width / o.width, ky = a.height / o.height;
  const [ox, oy] = ed.stageToDoc(x, y);
  if (!(ox >= 0 && oy >= 0 && ox < o.width && oy < o.height)) return null;     // the ground, not the photo
  const r = await subjectAt(a, ox * kx, oy * ky, { radius: 12 });
  if (ed.committed !== st) return null;                                        // Undo under the other hand while Vision ran
  if (!r.found || !r.polygons.length) return { found: false };
  const toSource = multiply(outputToSource(st.crop, st.source.w, st.source.h), [1 / kx, 0, 0, 1 / ky, 0, 0]);
  const poly = simplifyPolygon(Float32Array.from(r.polygons[0]), 0.75);
  if ((polygonArea(poly) / (kx * ky)) * ed.view.scale ** 2 < tiny) return { found: false };
  return { found: true, polyS: polygonRecord(transformPolygon(poly, toSource)) };     // source px, 0.1 px, as a traced loop
}
```
remove.js: factor the tail of `finishTrace` (from `const polyS = …` to `enqueue`) into `commitOutline(ed, polyS)`; `onGesture` `case 'tap': if (dial === 'outline' && subjectLiftAvailable()) return subjectTap(ed, g.x, g.y);` where `subjectTap` awaits `liftSubject`, then `commitOutline` (same `outlineBox`, `exceedsAreaCap` → `CAP_TIP`, same `{ kind: 'outline', poly, seed: 1, attempt: 0 }` job). light.js: the same factoring of finishTrace's tail into `commitOutline(ed, polyS)` (amount defaulting, `entryFromRuler`, pool entry, `adjusting = entry.poly`, `ed.commit`), and `traceGesture` gains `case 'tap': return subjectLiftAvailable() ? subjectTap(ed, g) : false;`. Autosave, undo, `revivePools`, Try another, the Amount ruler and the shimmer all see an ordinary outline.

Known limit inherited from the web: `AREA_CAP = 0.2` (lib/heal.js:20) refuses a fill whose box exceeds 20% of the photo, which most whole-subject removals will; the native mode shows the same `CAP_TIP`. Raising the cap for subject jobs is a quality decision (owner question), not plumbing.

### 5.3 Goal 3 — durable storage
- `WKWebViewConfiguration.websiteDataStore = .default()`: persistent, inside the app container, removed only with the app **[high]**; not subject to Safari's 7-day script-storage cap, which is tied to Safari/ITP browsing, not an app's own web view **[medium-high]**.
- The origin `gesso://app` is pinned (section 2); IndexedDB `gesso` v1 and the `store.js`/`autosave.js` code stay byte-for-byte, including the "Connection to Indexed Database server lost" reconnect (store.js:18-20, 195-205), which WKWebView also triggers after backgrounding.
- `navigator.storage.persist()` may be absent (secure-context question); `store.js:60` already answers `false`. The probe row text changes to "n/a in the app (app-owned store)" when native. The honesty clause "deleting the app deletes them" holds.
- No migration from Safari-tab drafts (accepted). iCloud backup: WebKit's data lives under `Library/WebKit/` and is included in device backups by default; whether to mark it `isExcludedFromBackup` is an owner question (section 13).

### 5.4 Goal 4 — haptics
`Haptics.swift` keeps one prepared generator per kind on the main thread: `UISelectionFeedbackGenerator` (tick), `UIImpactFeedbackGenerator(style: .light)` and `.medium`, `UINotificationFeedbackGenerator` (success/warning/error); `prepare` on `{kind:'prepare'}` (sent when a tool opens) and after each use.

| Moment | Where | Kind |
|---|---|---|
| Ruler detent reached | ui/ruler-view.js:87 `if (r.ticked) { flash(); tick(); }` | tick (JS-throttled ≥ 50 ms, never awaited) |
| Caption snaps to a guide | ui/tools/text.js (where snapPosition reports a guide) | tick |
| Outline lands (Remove fill landed, Light loop committed), subject found | remove.js `land()` label 'Removed outline'/'Removed spot', light.js `commitOutline` | medium |
| Tap to lift the subject | ui/subject.js | light |
| Done closes a tool with a change | editor.js `closeTool({cancel:false})` when `hist !== toolMark` | light |
| Saved to Photos | savesheet.js `settleNative` | success |
| "Couldn't remove that" / no subject / Photos denied | remove.js `enqueue` catch, subject.js, savesheet.js | warning |

Undo/Redo, chip taps and every other confirmation stay visual (SPEC §6). Web build: `haptic()` is a no-op. An in-app haptics switch is a later Settings item.

### 5.5 Goal 5 — native decode for HEIC/ProRAW/DNG when createImageBitmap can't
**Key simplification: the decoded working image replaces the original in the draft.** `decodeImage` returns a PNG (8-bit, sRGB-tagged, orientation applied) at *exactly* the `{w,h}` JS asked for; `pickPhoto` wraps it as `File` (type `image/png`, the original's name) and `importFile` proceeds as today: `decodeForEditing` sniffs `png`, `readImageInfo` gives w×h, `fitWorkingSize(w,h,cap)` returns scale 1 (w·h ≤ cap), `createImageBitmap` decodes without resizing, `autosave.startDraft(id, file)` stores **the PNG**. Restore (app.js:231) and the GL-loss re-decode (app.js:71) therefore run the ordinary web path and reproduce `{source.w, source.h}` exactly; no new decoder invariant and no `lib/draft.js` change are needed (the touchpoint map's `decoder` marker in `reviveInfo` becomes optional metadata; `importer.js` reads `nativeInfo(file)` for `natW/natH/downscaled` so the "Editing at 24.5 MP" tip and `info.natW/natH` are the RAW's, not the PNG's). The 12 MP step-down (app.js:148-163) still works: `decodeForEditing(pngFile, { maxPixels: 12e6 })` resizes the PNG on the web path.

**When native decode runs.** (a) In `pickPhoto`, when `imageInfo` says `raw` or `!webkitCanDecode` (UTI in `{public.dng, com.adobe.raw-image, public.camera-raw-image, public.tiff}` or anything outside WebKit's set); (b) as a rescue in `importer.js`'s catch (createImageBitmap rejected a type WebKit should decode): `if (isNative && decoder !== 'web') { try { return decodeViaNative(file, { maxPixels }); } catch {} }` using `nativeInfo(file).url` when the tmp file is still there, else `putFile`. The message when both fail: "This RAW photo couldn't be opened." (`importProblem(type, { where: isNative ? 'this app' : 'Safari' })`, a one-arg addition to lib/image-io.js:79-86 with tests).

**Swift (`NativeDecoder.swift`).**
```swift
func info(url: URL) throws -> ImageInfo {            // kCGImageSourceShouldCache: false
    let src = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary)!
    let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as! [CFString: Any]
    let (w, h, o) = (props[kCGImagePropertyPixelWidth], props[kCGImagePropertyPixelHeight], props[kCGImagePropertyOrientation] ?? 1)
    // oriented dims: swap for EXIF 5-8, matching lib/image-io.js orientedDims
}
func decode(url: URL, w: Int, h: Int) throws -> URL {
    let img: CGImage
    if isRaw(uti) {                                   // ProRAW / DNG / camera RAW: Apple's RAW pipeline, display-referred, not flat
        let f = CIRAWFilter(imageURL: url)!; f.scaleFactor = min(1, Double(max(w, h)) / Double(max(natW, natH))); f.isDraftModeEnabled = false
        img = ciContext.createCGImage(f.outputImage!, from: f.outputImage!.extent, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)!
    } else {                                          // TIFF and the rest: ImageIO thumbnail, oriented, from the full image
        img = CGImageSourceCreateThumbnailAtIndex(src, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: max(w, h), kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary)!
    }
    // Exact size and colour: draw into an sRGB CGContext of w x h (interpolationQuality .high), then PNG via CGImageDestination (UTType.png)
}
```
Drawing into an explicit w×h sRGB context is what guarantees the pixel-exact size (ImageIO's thumbnail rounding can differ from `fitWorkingSize`'s floor by a pixel) and the colour conversion from ProRAW's wide gamut; the strip canvas in `renderer.loadSource` then does the same no-op sRGB→sRGB it does for a JPEG. `CIRAWFilter` default development gives Apple's look **[medium-high]**; `boostAmount` stays at its default. Cost on this device for a 48 MP DNG: ~0.5–2 s and 200–400 MB in the *app* process (outside the WebContent budget — a plus), PNG 40–70 MB on disk, deleted by `release` once fetched. The PNG draft in IndexedDB is of the same order as the DNG it replaces.

### 5.6 Goal 6 — App Store readiness
- **Offline, no network:** no `fetch`/XHR/external URL exists in the app; natively the only requests are the scheme handler's, `decidePolicyFor` cancels any other origin, the CSP forbids `connect-src` beyond the app, and no ATS exception is declared. The web-only `fetch` added in `platform.js` is same-origin `_tmp` only.
- **Privacy manifest** `PrivacyInfo.xcprivacy`: `NSPrivacyTracking` false; `NSPrivacyTrackingDomains` []; `NSPrivacyCollectedDataTypes` []; `NSPrivacyAccessedAPITypes`: `NSPrivacyAccessedAPICategoryFileTimestamp` reason `C617.1` (the tmp purge reads modification dates inside the container) and `NSPrivacyAccessedAPICategoryUserDefaults` reason `CA92.1` (only if the "reset working size" switch lands; otherwise omit). No disk-space or boot-time APIs.
- **Info.plist keys:** `NSPhotoLibraryAddUsageDescription` (above); no `NSPhotoLibraryUsageDescription` (PHPicker needs none); `UILaunchScreen` = `{ UIColorName: LaunchBackground }` (solid #0d0c0b, same as `<body>`, so launch → first paint has no flash and no logo to mismatch the start screen); `UIUserInterfaceStyle: Dark`; `UIViewControllerBasedStatusBarAppearance: true` with `preferredStatusBarStyle = .lightContent`; orientations portrait + both landscapes (SPEC: no lock); `ITSAppUsesNonExemptEncryption: false`; **no** `CFBundleURLTypes` (the `gesso://` scheme is internal to the web view and must not be registered as a URL type).
- **Entitlements:** none (no iCloud, groups, push). Signing automatic under the owner's team.
- **Icon:** Asset catalog `AppIcon` single 1024 PNG (no alpha, square: iOS masks it) rendered from `icon.svg` with the `clip-path="url(#tile)"` removed so the Pigment Wheel fills the tile (`Scripts/render-icon.mjs`, Playwright, global install), plus a dark variant on #0d0c0b; tinted variant optional.
- **Product story copy:** index.html:71 "Everything stays on this iPhone." already true; the install line hidden (section 6); App Store description and the review note state "fully offline, no accounts, no network".
- **Review posture:** a bundled, offline, native-integrated app is not a "web wrapper" in the 4.2 sense; the reviewer note explains PHPicker/Photos/Vision/haptics. Lockdown Mode: `isLockdownModeEnabled = false` keeps WebGL **[medium]**; the copy at app.js:89 becomes "Gesso needs WebGL, which Lockdown Mode has turned off." when native.
- **iPad later:** `TARGETED_DEVICE_FAMILY` 1 now; `ShareSheet.swift` already sets `popoverPresentationController.sourceView/sourceRect` so adding 2 is a layout job, not a bridge job.

## 6. Exact changes to existing web files

| File | Change |
|---|---|
| `ui/platform.js` (new) | section 4; add to `sw.js` SHELL |
| `ui/subject.js` (new) | section 5.2; add to `sw.js` SHELL |
| `sw.js` | SHELL += `'./ui/platform.js'`, `'./ui/subject.js'` (test/sw-shell.test.mjs enforces) |
| `app.js` | import platform; `openPicker()` + `onFile` queue; `#choose` `for` removal + click when native; keydown/askNewPhoto/discard call `openPicker()`; `createEditor({ onChoosePhoto: openPicker })`; `:89` copy when native; `:269` `if (!standalone && !hideInstall && !isNative)`; `:275` `if (!isNative && 'serviceWorker' in navigator …)`; `window.gesso = { editor, renderer, importFile, openPicker, flush, insets, keyboard }` where `flush = () => { editor.commitTyping(); return autosave.flush(); }`; optional cap seed `if (isNative && native.memoryBytes < 5 * 2**30 && !stored) cap = WORK_FALLBACK_PIXELS` |
| `ui/editor.js` | `createEditor` accepts `onChoosePhoto`; `:694` uses it; `closeTool` non-cancel with a change → `haptic('light')` |
| `ui/importer.js` | read `nativeInfo(file)` for natW/natH/downscaled; native rescue in the catch; `importProblem(type, { where })` |
| `lib/image-io.js` | `importProblem(type, { where = 'Safari' })` (FRIENDLY.raw templated); tests updated |
| `lib/export-plan.js` | `nativeSaveOutcome(r)` + tests |
| `ui/savesheet.js` | native branch in `onShareClick`, `settleNative`, `#share-more`/`#sheet-settings` wiring, coach hidden when native, success copy, fallback → `share()` when native |
| `index.html` | `#share-more` and `#sheet-settings` secondary buttons (hidden), `id="sheet-success"` on the done `<p>`; nothing else (metas/manifest harmless in the bundle) |
| `ui/tools/remove.js` | `commitOutline` factored out of `finishTrace`; `case 'tap'` subject hook; hint copy when native; haptics on land/fail |
| `ui/tools/light.js` | same factoring; `traceGesture` `case 'tap'`; haptic on commit |
| `ui/ruler-view.js` | `tick()` on detent |
| `ui/tools/text.js` | `tick()` on snap guide (optional); `platform.keyboard` fallback only if the probe says visualViewport does not shrink |
| `ui/probe.js` | rows P1–P7 (section 9); relabel Display mode / Storage persist when native |
| `test/platform.test.mjs` (new), `test/export-plan.test.mjs`, `test/image-io.test.mjs` | node tests |
| `e2e/native.mjs` + `e2e/native-stub.mjs` (new) | Playwright native-mode run (section 9) |
| `README.md`, `SPEC.md §6` (haptics line), `design/README.md` | record the decision |

## 7. Viewport, safe area, keyboard, status bar
- `EditorViewController.loadView` sets the web view as the root view; SwiftUI wrapper uses `.ignoresSafeArea()`; `contentInsetAdjustmentBehavior = .never`. With `viewport-fit=cover` already shipped, WebKit populates `env(safe-area-inset-*)` from the web view's own `safeAreaInsets` **[medium-high]**. Double insets (SwiftUI padding + env) are the thing to watch; probe row P5 prints env() beside the flag's `insets`. Fallback: `window.gesso.insets()` sets `--safe-top/bottom/left/right` on `:root` (styles.css:22-25 are custom properties, so the override is one `style.setProperty` per side).
- Keyboard: text.js:491-551 drives the edit bar from `visualViewport`. WKWebView adjusts the visual viewport for the keyboard on modern iOS **[medium]**; probe row P6 is an interactive textarea that reports `visualViewport.height` before/after focus. Fallback: `keyboardWillChangeFrameNotification` → `window.gesso.keyboard({height})`, and `caption-edit.js`'s `editBarTop/isKeyboardUp` get the height from `platform.keyboardInset()` when non-zero. WebKit's form accessory bar (up/down/Done) appears above the keyboard as it does in Safari; it is left alone (removing it needs private API).
- `isScrollEnabled = false` stops WKWebView from scrolling the page to reveal the focused textarea; text.js:516's `scrollTo(0,0)` remains harmless.
- Status bar light content; `UIUserInterfaceStyle Dark`; the web view and `underPageBackgroundColor` are #0d0c0b.

## 8. Lifecycle, memory, process termination (`Lifecycle.swift`)
- `scenePhase` `.inactive`/`.background` → `evaluateJavaScript("window.gesso?.flush?.()")`. `visibilitychange` (app.js:284) still fires inside WKWebView, so this is a second bet on the same flush, not the only one; `pagehide` may never fire before the content process dies **[medium]**.
- `UIApplication.didReceiveMemoryWarningNotification` → flush; Swift drops its own caches (the `CIContext`, Vision request objects, prepared generators are recreated lazily) and purges `_tmp` files not referenced by an in-flight call.
- `webViewWebContentProcessDidTerminate(_:)` → `webView.load(pageURL)`; the app's own restore path then runs (autosave → "Restored your last edit"). Without this the user returns to a blank view.
- `TempFiles.purge()` at launch removes everything under `tmp/gesso-bridge/`.
- The WebContent process behind a WKWebView has memory limits of the same order as Safari's on the same device **[medium]**; the 24.5 MP policy stays, probe row 48 MP canvas + a real 48 MP import on device confirm before TestFlight. The web view is a plain UIKit view in a plain controller (no SwiftUI `Material`/transition snapshots over it).

## 9. Testing on the Mac
- **Node (`npm test`)**: `platform.test.mjs` imports `ui/platform.js` with no flag (every export falls back, `isNative === false`, `haptic()` no-op) and, in a second process via `node --test --import` of a shim that sets `globalThis.__gessoNative` and a fake `globalThis.webkit.messageHandlers.gesso.postMessage` recording bodies, asserts request shapes, chunking at 3 MB, timeout codes, reply unwrapping and late-reply ignoring; `export-plan.test.mjs` covers `nativeSaveOutcome`; `image-io.test.mjs` covers the templated copy; `sw-shell` enforces SHELL.
- **Playwright native mode** (`node e2e/native.mjs --base http://127.0.0.1:4174/gesso/`): an `addInitScript` installs the flag and a stub `webkit.messageHandlers` whose `pickPhoto` returns a fixture URL served by the python server (`e2e/fixture.mjs` JPEG written to a tmp path under apps/), `imageInfo` says not raw, `saveToPhotos` returns `{saved:true}` (or `denied` with `--denied`), `subjectAt` returns a rectangle polygon, and `gessoFx` records kinds. Checks: install line hidden; no `serviceWorker.register` call; Choose → `pickPhoto` called, fixture imported, `editor.committed` set; Save → `beginFile/appendFile/finishFile/saveToPhotos` called in order with the right sizes, "Saved to Photos." visible, `editor.isSaved === true`, success haptic recorded; denied → coach copy + Settings button + `share` route; Remove › Outline tap → `subjectAt` called with a JPEG of the analysis size and a 'Removed outline' step lands; Light › Outline tap → an outline paint entry. Playwright's `webkit` project runs the same for a WebKit engine.
- **XCTest (`GessoTests`)**: `SchemeHandlerTests` with a fake `WKURLSchemeTask` (it is a protocol): MIME by extension, `/` → index.html, query ignored, `..` and absolute paths → 404, directories → 404, `_tmp` name validation, stop-before-finish does not crash, CSP header only on index.html; `BundleManifestTests`: every `sw.js` SHELL entry exists in the built `web/`; `BridgeCodecTests`: request/reply round trips and error codes; `ContourTracerTests`: disc, two blobs, ring-with-hole, 1-px specks dropped, polygon closed and area-sorted; `NativeDecoderTests`: a bundled 7×5 TIFF with EXIF orientation 6 decodes to exactly the requested w×h, oriented, sRGB, and a PNG round trip reproduces the pixels; `TempFilesTests`: purge and release.
- **XCUITest (`GessoUITests`)**: launch and find "Choose a photo" inside `app.webViews`; `-GessoProbe 1` launches the probe and a debug-only bridge method `probeReport` writes the report to a path from the launch environment that the test asserts (no FAIL rows except those expected in the Simulator); Save flow in the Simulator with `addUIInterruptionMonitor` for the Photos add-only alert and a PHPicker tap on the first sample image (PHPicker's remote UI is reachable to XCUITest **[medium]**).
- **Simulator caveats**: WebGL2 works (MAX_TEXTURE_SIZE 8192, SPEC §6); PHPicker and PHPhotoLibrary work with the sample library; Vision foreground masks may be unsupported (`unsupported` reply exercised); haptics are silent.
- **On-device probe rows (new in `ui/probe.js`)**: P1 Native app (`ping()` → app/build/web version, api); P2 Origin (`location.origin`, `isSecureContext`); P3 Service worker (`'serviceWorker' in navigator`; relabelled "not used in the app"); P4 Scheme-served module worker (`new Worker(new URL('../workers/export-worker.js', import.meta.url), {type:'module'})` encodes a 64×48 JPEG — a different path from the existing blob: URL row); P5 Insets (env() values beside `native.insets`); P6 Keyboard (interactive textarea; reports visualViewport height change); P7 POST body (`fetch('gesso://app/_echo', {method:'POST', body: 1 MB})` → whether the handler saw the bytes **[low]**; unlocks binary uploads without base64, section 11). Existing rows: "Display mode" says "native app", "Storage persist()" says "n/a in the app (app-owned store)", 48 MP canvas stays last.

## 10. Persistence and migration
- No schema change: IndexedDB `gesso` v1, same stores, same keys, `localStorage gesso:*` unchanged. A native-decoded photo's draft stores the working-size PNG as `source:<docId>` (section 5.5); `info.type` records the PNG's sniffed type with `info.name` the RAW's name; nothing reads `info.type` for behaviour.
- App updates keep the data store (same container, same origin). App deletion removes it. Safari-tab drafts do not migrate (accepted, as in SPEC §6).
- `gesso:workCap` step-downs persist as on the web; a "Reset working size" switch (UserDefaults → `evaluateJavaScript("localStorage.removeItem('gesso:workCap')")`) is a cheap later item.

## 11. Path to a Metal fill engine (not now)
The heal client already has two backends (`worker`, `inProcess`, heal-client.js:33-88). A third, `native`, is selected when `ping().engines` includes `'metal'`: `heal({ image: <tmp url or base64>, mask, w, h, seed, params }) → { url }` returns a PNG/raw tile that `rubTile` consumes exactly as a worker reply. Recipes stay valid because tiles are stored pixels (`ed.saveTile`), so restore never recomputes; only Try another/offset retries recompute, and `recipeRecord` would gain `engine` so a retry replays with the engine that produced the step. Transfer is the one open cost: windows are ≤ 8 MP RGBA (MATCH_MAX_PX), typically 1–2 MP, so chunked base64 costs ~100 ms; if probe row P7 shows the scheme handler receives POST bodies, uploads become a plain `fetch(…, {method:'POST'})` and the Metal path (and a native JPEG encoder for export) become cheap. The JS engine remains the reference and the web build.

## 12. Risks and mitigations
| Risk | Mitigation |
|---|---|
| Scheme handler `didFinish` after `stop` crashes | live-task table; XCTest covers it |
| Wrong `.js` MIME → blank page | MIME table test; module workers probe row P4 |
| Origin drift orphans the draft | constants pinned + unit test; never two origins (no `file://` splash) |
| `file://` anywhere | not used; `decidePolicyFor` cancels it |
| Missed bundle file → runtime 404 | `check-bundle.sh` mirrors sw-shell test; explicit 404s, no SPA fallback |
| Flag missing → install line shows, web picker/share dance run | flag injected at document start; Playwright native run asserts; `isNative` requires both flag and handler |
| `navigator.share` exists in WKWebView and the old dance runs | savesheet branches on `isNative` before `shareRoute` |
| False "Saved" | `markSaved` only on `saved:true` or SaveToCameraRoll activity |
| Photos denied → dead button | denied copy + Open Settings + Share…; `openSettings()` |
| env() double insets / visualViewport not shrinking | probe rows P5/P6; `insets()`/`keyboard()` fallbacks already in the bridge |
| Content process killed in background | `webViewWebContentProcessDidTerminate` reload → autosave restore; flush on scenePhase and memory warning |
| ProRAW looks flat or off-colour | CIRAWFilter default development + sRGB CGContext; PNG keeps 8-bit sRGB tag |
| Restore size mismatch for native-decoded photos | the PNG is the stored original; web path reproduces w×h exactly; existing `app.js:241` guard remains |
| 48 MP DNG memory in the app process | `kCGImageSourceShouldCache false`, `scaleFactor` ≤ working size, CIContext recreated after memory warnings |
| Big tmp files left behind | `release` after every fetch; purge at launch; memory-warning purge |
| Vision unsupported (Simulator, < iOS 17) | `unsupported` reply; tap falls back to today's behaviour; loop always works |
| Whole-subject removal hits AREA_CAP | inherited; owner decides on a subject-specific cap |
| Long-press `<img>` fallback has no Save natively | never shown when native (routes to `share()`) |
| Lockdown Mode disables WebGL | `isLockdownModeEnabled = false` [medium]; app-specific copy otherwise |
| App Review "web wrapper" | offline bundle + native Photos/Vision/haptics; reviewer note |
| CSP blocks blob:/data: | allowed for img/worker; probe + e2e fallback check |
| Ruler ticks flood the bridge | 50 ms JS throttle; fire-and-forget channel |

## 13. Build order and estimates (owner or the Build phase; ~7–8 working days)
1. **Scaffold** `apps/gesso-ios` with XcodeGen, copy/check scripts, assets, launch colour — 0.5 d.
2. **Serve + host**: SchemeHandler, WebHost, flag injection, EditorViewController, decidePolicy guard, probe via launch argument; the editor boots offline in the Simulator; XCTest for handler/MIME/manifest — 1 d.
3. **Web seam**: `ui/platform.js`, app.js/editor.js/sw.js diffs, probe rows, node tests, Playwright native stub; `npm test` and the existing e2e stay green in web mode — 0.5 d.
4. **Picker**: PhotoPicker + `pickPhoto`/`imageInfo`/`release`, earlyFile queue, label `for` removal — 0.5 d.
5. **Save/Share**: `beginFile/appendFile/finishFile`, PhotosSaver, ShareSheet, sheet changes, denied flow, `nativeSaveOutcome` — 1 d.
6. **Lifecycle + haptics**: flush hooks, memory warning, process termination, tmp purge; Haptics vocabulary + JS call sites — 0.5 d.
7. **Native decode**: NativeDecoder (ImageIO + CIRAWFilter), `decodeImage`, importer rescue, copy change, decoder tests with a TIFF fixture; on-device ProRAW check — 1 d.
8. **Subject lift**: SubjectLift + ContourTracer + tests, `ui/subject.js`, remove/light `commitOutline` factoring and tap hooks, hint copy — 1.5 d.
9. **App Store pass**: icon render, privacy manifest, Info.plist, TestFlight build, on-device probe (P1–P7, 48 MP), keyboard/insets fixes if P5/P6 say so, reviewer note — 1 d.
Later: iPad family, Settings bundle (probe toggle, reset working size, haptics switch), Metal engine behind `heal`.

## bridgeMethods

- ping() -> { app, build, web, api, os, device, memoryBytes, insets, lockdown, engines, postBody }
- pickPhoto() -> { url, name, type, size } | null (cancelled); errors: busy, unavailable; no timeout
- imageInfo({ url }) -> { natW, natH (oriented), uti, raw, webkitCanDecode }; errors: unreadable; 10 s
- decodeImage({ url, w, h }) -> { url, w, h } (8-bit sRGB PNG, oriented, exactly w x h, served at gesso://app/_tmp/); errors: unreadable, memory, size; 60 s
- release({ url }) -> {} (deletes a _tmp file, idempotent); 5 s
- beginFile({ name, type, size }) -> { token }; errors: space; 10 s
- appendFile({ token, base64 }) -> { received } (<= 4 MB base64 per call); errors: badToken; 10 s
- finishFile({ token }) -> { url, size }; errors: badToken, short; 10 s
- saveToPhotos({ url }) -> { saved: true, assetId } | { saved: false, reason: 'denied'|'restricted'|'failed', message } (PHPhotoLibrary add-only); errors: badUrl; no timeout
- share({ url, name }) -> { completed, activity } (UIActivityViewController; SaveToCameraRoll + completed counts as saved); errors: badUrl; no timeout
- openSettings() -> {} (UIApplication.openSettingsURLString); 2 s
- subjectAt({ image: base64 JPEG, x, y, radius }) -> { found, polygons: number[][] (flat x,y in the analysed image's px, largest first, holes dropped), w, h, instances } (VNGenerateForegroundInstanceMaskRequest + marching squares); errors: unsupported, timeout, badImage; 20 s
- heal(...) -> reserved for the Metal fill engine; replies unsupported until it exists
- gessoFx (no reply): { kind: 'prepare'|'tick'|'light'|'medium'|'success'|'warning'|'error' } (UISelectionFeedbackGenerator / UIImpactFeedbackGenerator / UINotificationFeedbackGenerator)
- Swift -> JS: window.gesso?.flush?.() on scenePhase inactive/background and memory warning
- Swift -> JS: window.gesso?.insets?.({ top, right, bottom, left }) on safe-area change (fallback only)
- Swift -> JS: window.gesso?.keyboard?.({ height, duration }) from keyboardWillChangeFrame (fallback only)
- Transport: window.webkit.messageHandlers.gesso.postMessage({ v: 1, id, method, args }) -> Promise of { ok: true, result } | { ok: false, code, message } (WKScriptMessageHandlerWithReply, page world, main frame)

## filesChangedInWebApp

- apps/gesso/ui/platform.js (new: isNative, call, haptic/tick, pickPhoto, nativeInfo, putFile, saveToPhotos, share, openSettings, subjectAt, subjectLiftAvailable, decodeNativeFrom, insets)
- apps/gesso/ui/subject.js (new: liftSubject shared by Remove and Light)
- apps/gesso/sw.js (SHELL += ./ui/platform.js, ./ui/subject.js)
- apps/gesso/app.js (openPicker + onFile queue; #choose for-removal when native; keydown/askNewPhoto/discard use openPicker; createEditor onChoosePhoto; WebGL copy when native; install line and SW registration skipped when native; window.gesso gains openPicker/flush/insets/keyboard; optional cap seed from memoryBytes)
- apps/gesso/ui/editor.js (onChoosePhoto option used at the dock tap on the start screen; light haptic on Done with a change)
- apps/gesso/ui/importer.js (nativeInfo for natW/natH/downscaled; native rescue in the catch; importProblem where-argument)
- apps/gesso/lib/image-io.js (importProblem(type, { where }) templated RAW copy)
- apps/gesso/lib/export-plan.js (nativeSaveOutcome)
- apps/gesso/ui/savesheet.js (native branch in onShareClick, settleNative, Share…/Open Settings buttons, coach hidden when native, 'Saved to Photos.' copy, fallback routes to native share)
- apps/gesso/index.html (#share-more and #sheet-settings secondary buttons hidden by default; id=sheet-success on the done line)
- apps/gesso/ui/tools/remove.js (commitOutline factored from finishTrace; tap in Outline lifts the subject when native; native hint copy; haptics on land/fail)
- apps/gesso/ui/tools/light.js (commitOutline factored from finishTrace; traceGesture tap case; haptic on commit)
- apps/gesso/ui/ruler-view.js (tick() on detent)
- apps/gesso/ui/tools/text.js (tick() on snap guide; keyboard fallback only if the probe requires it)
- apps/gesso/ui/probe.js (rows P1–P7; relabel Display mode and Storage persist when native)
- apps/gesso/test/platform.test.mjs (new), apps/gesso/test/export-plan.test.mjs, apps/gesso/test/image-io.test.mjs (updated)
- apps/gesso/e2e/native.mjs and apps/gesso/e2e/native-stub.mjs (new Playwright native-mode run)
- apps/gesso/README.md, apps/gesso/SPEC.md §6 (haptics line), apps/gesso/design/README.md (decision record)
- apps/gesso-ios/** (new sibling directory: XcodeGen project, Swift sources, scripts, tests; never deployed to Pages)

## openQuestionsForOwner

- Bundle identifier and team (design assumes quest.elsewhere.gesso); App Store name 'Gesso' availability.
- Confirm the pinned origin gesso://app (it can never change afterwards without orphaning IndexedDB and localStorage).
- Subject lift UX: a tap inside Outline mode (recommended, one gesture case per tool) versus a visible 'Subject' chip; and whether multi-part subjects should land as several undo steps or the largest only.
- Remove's 20% AREA_CAP refuses most whole-subject fills: keep the cap for subject jobs, raise it for them, or add a 'tile it' strategy later?
- Native-decoded photos store the working-size PNG (40–70 MB at 24 MP) as the draft's original instead of the DNG: acceptable, or prefer JPEG q0.97 (~10 MB) at the cost of a lossy pristine?
- ProRAW look: Apple's default CIRAWFilter development (recommended) or a flatter, more editable starting point?
- iCloud backup: leave WebKit's data store in device backups (default) or exclude Library/WebKit from backup to make 'stays on this iPhone' literal?
- Minimum iOS: 17.0 (Vision foreground mask) or 18 to reduce test surface; and whether the ?probe=1 page stays reachable in release builds (Settings bundle toggle) or debug only.
- Haptics: ship the vocabulary as designed, or add an in-app switch in v1?
- Should the web build on elsewhere.quest show a 'Get the app' line in place of the install line once the app is live?
