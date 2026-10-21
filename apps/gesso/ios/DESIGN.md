# Gesso for iOS — bundled editor, native where it matters

## 1. Goals and decisions

Gesso remains the existing vanilla ES-module editor. A small SwiftUI/UIKit host
loads it in one WKWebView, fully offline, and supplies Photos import/save, RAW
development, sharing, Vision subject lift and haptics. The Safari build retains
its current picker, share gesture, long-press fallback and service worker.

The owner confirmed these permanent choices on 2026-10-20:

| Choice | Value |
|---|---|
| Bundle identifier | `quest.elsewhere.gesso` |
| Project | `apps/gesso-ios/` in this repository |
| Origin | `gesso://localhost` |
| Entry page | `gesso://localhost/gesso/` |

The origin keys IndexedDB and localStorage; it must stay fixed across updates.
Safari and app drafts are separate. There is one draft, in the existing `gesso`
database, with the existing history and pixel tiles. No native parallel draft
store or decoder marker is added.

This synthesizes Design 2's native behavior, Design 1's single scheme handler and
operation table, and Design 3's localhost host, picker interceptor and review
notes. BRIDGE.md is the normative wire contract.

## 2. Non-goals

No native editor rewrite, remote code, account, analytics, network service, Metal
healing engine, new dock tool, background replacement, multi-draft library, iPad
release, share extension or App Store submission in this change. `lib/lasso.js`
is unchanged. The owner authorized signed device installation during this
continuation; provisioning is blocked until an Apple Developer account is signed
into Xcode. Unsigned Simulator builds are part of scaffold validation.

## 3. Architecture and bundle updates

`GessoApp` presents an edge-to-edge `EditorViewController`. Its persistent
`WKWebsiteDataStore.default()` belongs to the app container. The web view uses
mobile content, dark ground, no scroll bounce, no native page pinch or history
swipes, and no link previews. WebKit's keyboard accessory bar stays intact.
CSS safe-area and visualViewport handling remain the primary layout mechanism.

One WKURLSchemeHandler serves `/gesso/` from `Bundle/web/`, and `/xfer/` from a
temporary transfer registry. Paths are decoded and checked component by
component, symlinks cannot escape the bundle, directories and missing files are
real 404s, and there is no SPA fallback. JavaScript has a JavaScript MIME type;
responses use `Cache-Control: no-store` and `Accept-Ranges: none`. File reads use
mapped Data off the UI thread. Every scheme-task callback checks liveness on the
main thread immediately before delivering; stopped tasks receive no callbacks.

The always-run Xcode build phase copies `../gesso/`, excluding `e2e/`, `test/`,
`design/`, `ios/`, `node_modules/`, development package files and dotfiles. It
checks every `sw.js` SHELL entry exists in the bundle and stamps a web revision.
It never declares `sw.js` as the only build input: editing any module must reach
an incremental build. The checked-in XcodeGen spec and generated project make
the scaffold buildable without fetching dependencies.

The bundle is the native offline shell. Native mode skips service-worker
registration. Web mode keeps its existing cache behavior and SHELL includes all
new runtime modules. App updates deliver the web tree with the executable;
there is no over-the-air web update. Local navigation stays on the fixed origin;
a CSP restricts subresource connections to it plus local blob/data resources.

## 4. Bridge and transfers

A document-start, main-frame user script injects frozen `window.__gessoNative`
API 1 metadata. One `WKScriptMessageHandlerWithReply`, named `gesso`, dispatches
`{op,args}` using one operation table. Each postMessage already has its own
Promise: there are no request IDs, sequence collisions or global reply map.
All replies and WebKit interactions run on the main actor; ImageIO, Vision and
file work run off it. The JS timeout clears its timer on all settlement paths,
handles late rejection and never retries side-effecting operations automatically.

`ui/platform.js` is the DOM-facing seam; pure transport/validation logic lives in
`lib/native-bridge.js` with node tests. Absence of a valid flag and handler means
web behavior. A native failure stays visible as an actionable error.

Photo bytes use issued-name files, never photo-sized base64 script messages.
Swift issues UUID names under `/xfer/`; callers cannot pass a filesystem path.
Picked files are fetched locally. JS uploads use `xfer.create` followed by a
single `fetch(url, {method:'POST', body: await blob.arrayBuffer()})`; the handler
checks the declared length before atomically completing the file. Blob,
FormData and streaming request bodies are not assumed reliable. A missing POST
body is an explicit transfer error and a probe failure, not silent truncation.
Transfers are released in finally blocks and purged by name at launch; there
is no file-timestamp polling. User-presented sheets retain their transfer until
the native operation finishes even if the page stops waiting.

## 5. Import, RAW and draft integrity

One capture-phase click handler on `#file` prevents the default chooser only in
native mode. This covers label taps, keyboard activation, New photo, Discard and
start-screen dock taps. A result arriving before storage/editor initialization
is kept in the existing early-file queue; a picked photo still wins over restore.

PHPicker uses `PHPickerConfiguration()` (no library read authorization), images,
one selection and `.current` representation. The provider URL is copied during
its callback. Native `image.info` identifies oriented dimensions and RAW; JS
computes `fitWorkingSize` and asks Swift for exactly that size. Common formats
use WebKit; RAW and otherwise unsupported formats use ImageIO/CIRAWFilter.

Default RAW development is Apple's normal CIRAWFilter rendition into an
oriented, exact-size, 8-bit sRGB PNG. The PNG becomes the draft source Blob.
This costs roughly 40–70 MB for a 24 MP draft but avoids an extra JPEG generation
and makes restore independent of Swift and decoder-version drift. The original
library asset is never changed. Rendering remains SDR/sRGB, at the existing
24.5 MP budget, with the existing 12 MP fallback.

Importer results carry `sourceFile` when normalized; app.js stores and restores
that file. A normalized PNG's allocation failure remains a memory failure and
can step down; it is never mislabeled unsupported merely because its original
transfer has already been released. Ordinary web import behavior stays intact.

## 6. Save, share and feedback

The native primary Save to Photos writes a new JPEG through PhotoKit add-only
authorization. Only confirmed success marks the revision saved. Denial offers
Open Settings and Share; restricted access offers Share. Other errors preserve
the prepared export and allow retry. A secondary Share presents
UIActivityViewController. A completed SaveToCameraRoll activity counts as saved;
AirDrop, Files or Messages says “Shared.” and leaves the revision unsaved.
Native mode never shows the web long-press image fallback or “tap Save Image”.

Async sheet results capture both export job and exact sheet session, so a
closed/reopened sheet cannot be changed by an old result. Buttons prevent
concurrent actions. Native UI operations hold their busy guard until dismissed,
including when JS times out. Web `navigator.share` is still invoked synchronously
inside the original click handler with the prepared File.

Haptics use a fixed small vocabulary (prepare, tick, light, medium, success,
warning, error), with no v1 toggle. Ruler ticks are throttled; commits and saves
have restrained feedback. Web haptics are a no-op. Visual feedback remains.

## 7. Subject lift in Outline

Native Outline's hint reads “Tap it, or loop around it.” A drag still traces the
lasso. A real `tap` case in Remove, guarded by Outline/native availability, and
a new `tap` case in Light's trace gesture invoke subject lift. This corrects the
drafts' false premise: a web tap in Remove Outline currently heals a spot, while
Light Outline has no tap action. Both web behaviors are preserved.

JS sends the current 1024px output frame (`readOutput({tone:false})`), with crop,
flip, rotation and previous fills applied. Swift holds no original-image cache,
so subject lift also works after draft restore. Vision foreground instances are
sampled under/near the finger from `instanceMask` (there is no `instance(at:)`
API). The chosen instance becomes a thresholded mask; VNDetectContoursRequest
returns exterior rings, flipped from Vision's bottom-left coordinates and sorted
by area. The largest ring is used as one ordinary Outline step. Holes and other
rings are deferred.

The existing output-to-source matrix maps the ring into source pixels. Remove
uses its existing fill, Try another and Source path; Light uses its existing
paint mask and Amount ruler. Tool-session and document guards discard stale
replies after Cancel, Done, Undo, another gesture or New photo. Failure says to
loop around the subject. The 20% Remove bounding-box cap remains: larger
subjects show the existing smaller-pieces tip. Raising it requires quality work.
Vision inference is device validation; unsupported Simulator results are expected.

## 8. Lifecycle, privacy and release choices

Inactive/background and memory-warning callbacks best-effort call
`window.gesso?.flush?.()` (commit typing, flush autosave). A terminated content
process reloads the same entry URL and restores IndexedDB. Native transient
caches are disposable. Transfer purge must not remove files owned by in-flight
picker/save/share work.

Minimum iOS is 17.0 for Vision foreground instances. Installed SDK headers put
`isInspectable` at 16.4 and `isLockdownModeEnabled` at 16.0; the judges disagree
on the latter, and the SDK is authoritative. Preserve system Lockdown settings:
the installed iOS 26.5 Simulator throws an exception if an app without the
restricted web-browser entitlement tries to disable them. App-specific copy
explains unavailable WebGL. No private APIs or restricted entitlements are used.

The WebKit store is excluded from iCloud device backup to honor the existing
“stays on this iPhone” copy. This is best effort and reapplied after launch;
release validation must verify the actual data-store path. Saving to Photos is
the archive; Photos' own user-configured iCloud behavior is outside Gesso.

`PrivacyInfo.xcprivacy` declares tracking false, no collected data and no native
required-reason API use. No UserDefaults, file timestamp or disk-space API is
introduced. The existing web localStorage preferences remain; App Store privacy
validation must confirm WebKit's system implementation covers those calls.
Info.plist has only add-to-Photos usage text, export encryption exemption false,
dark appearance and portrait/landscape iPhone support; no ATS exception.

1.0 defaults: iPhone only, Pigment Wheel 1024 PNG icon, standard keyboard bar,
PHPicker only, DEBUG launch-argument probe, no Settings bundle or Files picker,
no share extension and no “Get the app” banner before a published listing exists.
App Store name availability, real RAW appearance, backup exclusion, keyboard/
insets, module workers, the POST transfer and Vision quality remain release
checks. The signing team is supplied locally, never committed; Xcode account
sign-in/profile creation is currently required. TestFlight/archive work is later.

App Review notes: Gesso is an offline photo editor with all code in the bundle.
Choose a photo, use Light/Outline to tap a subject, edit, then Save to Photos.
Native PhotoKit writes report actual success; RAW is developed locally and Vision
and haptics run on device. No login or network connection is required. Explain
these capabilities for guideline 4.2; bundled releases contain no remote code.

## 9. Validation

Run node tests, isolated existing Chromium acceptance, native-mode browser tests
and unsigned xcodebuild. Adversarial cases cover absent/malformed bridge,
operation/reply mismatch, synchronous throws, timeout/late rejection, concurrent
promises, double settlement, issued-name/path rejection, a byte-exact 5 MB upload,
save denial/cancel/stale completion and subject cancellation/Undo.

The Simulator smoke test loads the real custom origin and verifies startup,
IndexedDB/localStorage across reload, actual module worker and ArrayBuffer POST.
The probe records native metadata, origin/secure context, worker behavior,
safe-area values and an interactive keyboard check. Real iPhone checks are owed:
RAW/ProRAW, Photos, Vision, haptics, background recovery, peak memory and layout.

References: [Apple reply bridge](https://developer.apple.com/documentation/webkit/wkscriptmessagehandlerwithreply),
[Vision foreground instances](https://developer.apple.com/documentation/vision/vngenerateforegroundinstancemaskrequest),
[WebKit HTTPBody fix](https://bugs.webkit.org/show_bug.cgi?id=180220).
