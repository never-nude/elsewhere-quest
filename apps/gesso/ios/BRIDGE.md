# Gesso JS ↔ Swift bridge, API 1

Normative contract for `ui/platform.js` and `apps/gesso-ios/`. The origin is
`gesso://localhost`, bundle ID `quest.elsewhere.gesso`. Changing the origin or app
identifier requires a migration. The legacy entry remains `gesso://localhost/gesso/`.
The production app launches `/gesso/studio/index.html`; `/gesso/` remains the legacy editor
and DEBUG smoke entry. Both share the pinned origin without deleting or migrating
the legacy draft database.

## Transport and versioning

At document start, page world, main frame only:

```js
Object.defineProperty(window, '__gessoNative', { value: Object.freeze({
  api: 1, bridge: 'gesso', origin: 'gesso://localhost',
  app: '1.0', build: '1', web: '<bundled revision>',
  capabilities: ['photos', 'decode', 'subject', 'subject-matte', 'haptic', 'transfer-post']
}), writable: false, configurable: false });
```

Native detection requires API 1, the exact origin/bridge and a callable
`window.webkit.messageHandlers.gesso.postMessage`. An absent flag is ordinary
web mode. No eager DOM access is allowed in the transport module.

```js
const reply = await window.webkit.messageHandlers.gesso.postMessage({op, args});
// exactly one of:
({ok: true, result: /* JSON-compatible value; null allowed */});
({ok: false, error: {code: 'badArgs', message: 'Readable explanation'}});
```

All arguments are objects (default `{}`). Native validates the main frame and
fixed scheme/host before dispatch. Unknown op → `unsupported`. Swift calls each
reply handler exactly once on the main actor. No IDs or extra callback channel
exist. Existing op names/shapes stay compatible throughout API 1; breaking
changes require a new API. `heal` is reserved and returns `unsupported`.

Codes: `badArgs`, `badUrl`, `unsupported`, `busy`, `cancelled`, `denied`,
`restricted`, `unreadable`, `memory`, `size`, `transfer`, `failed`. JS also uses
`web`, `protocol`, `timeout`, `transport`. Errors are not successes and unknown
or malformed envelopes are `protocol` errors. Messages contain no image bytes.

## Operations

`FileRef` is `{url, name, type, size}`: an issued absolute `/xfer/<UUID>.<ext>`
URL, display filename, MIME and positive byte length (1…128 MiB). No filesystem URL,
arbitrary path, query, fragment, credential, port or alternate origin is accepted.

| op | args | result | JS timeout |
|---|---|---|---|
| `ping` | `{}` | `{api:1, app, build, web, origin, capabilities, os}` | 2 s |
| `photo.pick` | `{}` | `FileRef` or `null` on user cancel | 300 s |
| `image.info` | `{url}` | `{natW,natH,raw}` (oriented positive integer dimensions) | 15 s |
| `image.decode` | `{url,w,h}` | `FileRef` plus `{w,h}`; exact upright sRGB PNG | 60 s |
| `xfer.create` | `{name,type,size}` | `FileRef` (reserved, not readable before POST) | 5 s |
| `xfer.release` | `{url}` | `{}`; idempotent for a valid issued-format URL | 5 s |
| `photos.save` | `{url,name}` | `{saved:true}` or `{saved:false,reason:'denied'\|'restricted'\|'failed',message?}` | 300 s |
| `share` | `{url,name}` | `{completed:boolean,activity:string\|null}` | 300 s |
| `subject.mask` | `{url,x,y,radius}` | `{found:false}` or `{found:true,w,h,polygons:number[][]}` | 25 s |
| `subject.matte` | `{url,x,y,radius}` | `{found:false}` or `FileRef` plus `{found:true,w,h}`; grayscale coverage PNG | 25 s |
| `haptic` | `{kind}` | `{}` | 1 s |
| `settings.open` | `{}` | `{}` | 5 s |
| `clipboard.write` | `{text}` | `{}` | 2 s |

Decode target dimensions are integer 1…8192, area ≤24,500,000. Original dimensions
from `image.info` may exceed those limits (JS accepts up to 100,000 per side).
JS computes exact decode targets using `fitWorkingSize`; Swift validates rather
than reimplementing fit.
`image.info.raw` uses image type/RAW support, not just `.tiff` extension.
`photo.pick` owns a global presentation guard until dismissal and the provider
copy finishes; `share` has the same presentation exclusion. A second request
gets `busy`. Photos writes also prevent duplicate concurrent submissions.

`subject.mask` input is the current output analysis image, ≤1024 per side, upright,
with x/y/radius in analysis pixels from the top left (radius default 12, bounded
0…128). Output rings are flat `[x,y,...]`, finite bounded coordinates, ≥3 points,
no duplicate closing point required, exterior rings only, largest area first.
`w,h` must match the supplied image. No object near the tap returns found:false.
Unsupported Vision returns an error, including on unsupported Simulator hardware.

`subject.matte` is an optional API 1 extension, advertised by `subject-matte`.
The input uses the same upright ≤1024px analysis image and top-left x/y/radius
coordinates. Output `w,h` match that input. The issued PNG contains opaque sRGB
pixels whose equal red/green/blue bytes represent coverage: 0 hides, 255 keeps,
and values between retain soft coverage. Its PNG alpha channel is opaque; callers
read a color channel as the layer mask. Interior holes and disconnected parts of
the selected instance remain intact. Vision's `generateScaledMaskForImage` supplies
the matte; no threshold, contour simplification or largest-ring filtering applies.
Float coverage is quantized to eight bits, and the result is bounded to 8 MiB.
The existing `subject.mask` polygon operation remains unchanged. Both operations
share the native busy guard and input-file lease until their work finishes.

Haptic kind: `prepare|tick|light|medium|success|warning|error`; JS throttles tick
to at least 50 ms and ignores haptic failures. Web haptics resolve without work.
`clipboard.write` only writes explicitly requested diagnostic text, ≤256 KiB.

## Binary transfer lifecycle

1. JS calls `xfer.create` with MIME, display filename and exact Blob size
   (1…128 MiB); native issues an unpredictable UUID filename with safe extension.
2. JS POSTs the Blob's **ArrayBuffer**, with `Content-Type`, to that issued URL.
   No Blob/FormData/stream body and no base64. Only one POST is allowed per
   reservation, including failed attempts. Native verifies the actual byte count,
   then writes atomically.
3. Success: HTTP 200, JSON `{size}`. Missing/wrong body: HTTP 400 with a transfer
   error; never a partial readable file. Unknown/released name: 404. Wrong verb:
   405. Duplicate upload: 409. Upload timeout: 60 s via AbortController.
4. GET of a completed issued file returns exact bytes and MIME, no-store,
   Accept-Ranges:none. GET before upload is 404. No directory listing/range mode.
5. `photos.save`, `share`, `image.decode`, `subject.mask` and `subject.matte` read issued complete
   files only. They retain their own file lease until work finishes. JS calls
   `xfer.release` in finally; release hides the URL immediately but defers physical
   deletion while a native lease exists. Startup purges all prior-session files.

Native picker/decode results start at step 4. JS fetches into a File and releases
the native URL. For RAW, `image.info`/`image.decode` run before fetching, so DNG
bytes do not enter WebContent. The exact PNG File is the autosave source. A native
rescue of a web-decoding failure uploads the source through the same lifecycle.
Transfer fetches check response status and size; file content is never injected
as JavaScript. Transfers use a registry of issued names and memory-mapped reads.

All operations have bounded JS waits. Timeout stops waiting, clears local timers,
and consumes late rejection; it cannot undo a PhotoKit write or dismiss another
operation. Never auto-retry save/share/pick after timeout. A late reply cannot
settle another call. Native presentation guards/leases last until actual finish.

## Web adapter and UI semantics

`ui/platform.js` exports `isNative`, `native`, `call`, `pickPhoto`, `nativeInfo`,
`decodeNative`, `saveToPhotos`, `share`, `subjectAt`, `subjectLiftAvailable`,
`subjectMatte`, `subjectMatteAvailable`,
`haptic`, `openSettings`, `clipboardWrite`, and transfer helpers for diagnostics.
`pickPhoto({maxPixels,input})` clicks `input` and resolves null on web; native
returns File|null. `nativeInfo(file)` holds original oriented dimensions and
whether the File is already a native-rendered PNG. `decodeNative(file,{maxPixels})`
returns `{file,natW,natH,downscaled}`. Importer returns `sourceFile` for the
normalized draft source; restored PNGs decode through the plain web path.

Native save/share helpers accept `(blob,name)` and own transfer cleanup.
`subjectAt(image,x,y,{radius})` accepts `{data,width,height}`, creates a local
analysis PNG transfer, validates the reply and releases it. Web returns no subject.
`subjectMatte(image,x,y,{radius=12})` accepts the same RGBA image, with x/y defaulting
to its center, and resolves `{found:false}` or `{found:true,blob,width,height}`.
The returned Blob is the grayscale coverage PNG. The adapter keeps the input
transfer live while fetching and decoding the output, checks PNG dimensions and
the 8 MiB bound, closes its validation bitmap, and releases both issued files on
success and failure. A missing capability returns found:false without work.
Save web fallbacks use prepared File/navigator.share synchronously in the caller;
no async adapter may consume transient activation before invoking share.

Only `saved:true`, or `completed:true` with activity exactly
`com.apple.UIKit.activity.SaveToCameraRoll`, calls `markSaved`. Other completed
shares say “Shared.” without retiring the unsaved-edit guard. Old sheet/tool
sessions cannot apply an async result. Native install hints are hidden.

## Swift → JS and probes

`window.gessoStudio?.engine?.flush?.() ?? window.gesso?.flush?.()` best-effort flushes the active editor during
inactive/background/memory-warning transitions. Content-process termination
reloads the same entry URL. No untrusted text is interpolated into evaluated JS.

DEBUG `-GessoProbe` loads `/gesso/?probe=1`. Probe rows report metadata, actual
origin/isSecureContext, safe-area values, module-worker JPEG encoding, storage
and an actual ArrayBuffer POST round trip. Keyboard visualViewport is inspected
interactively. `-GessoStubPicker` / `-GessoStubPhotos` are DEBUG-only Simulator
test fixtures; production builds cannot enable them. The existing public web
probe remains available exactly as before.
DEBUG `-GessoSmoke` continues to load `/gesso/` for legacy diagnostic compatibility.
The shared smoke script accepts either `window.gessoStudio` or `window.gesso` and
reports whether Studio initialized, so native host tests cover the production route.
