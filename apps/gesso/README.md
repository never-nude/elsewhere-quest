# Gesso

A simple, Photoshop-style photo editor for iPhone. Everything stays on your
device.

Gesso is the white primer an artist lays down before painting. The app is
built around one promise, held as an acceptance test rather than a slogan:
**you know where everything is within two seconds, you finish a real edit
within a minute, and by minute ten you're getting good at it.**

It lives in this repo as a standalone web app (no shared code with the
Elsewhere prototype, no dependencies, no build step, no server) and installs
to the Home Screen like a native app.

## What it does

One screen. Five tools and four actions, always visible, always labelled, never
moving:

- **Crop** — Auto straightens from the horizon and fits the frame; Free,
  Original, Square, 4:5 and 16:9 shapes; drag corners and edges; Straighten
  ruler; Rotate, Flip, Tall/Wide.
- **Light** — Auto, Brighter, Darker, Punchier, Softer; Brightness, Contrast,
  Highlights, Shadows; and **Paint** — dodge and burn with a finger.
- **Color** — Auto, then six looks shown as live thumbnails of *your* photo
  (None, Vivid, Warm, Cool, Film, Mono); Warmth, Tint, Vividness, look
  Strength; **Pick white** to neutralise a cast.
- **Remove** — tap a spot to heal it; rub over something to fill it from its
  surroundings (multi-scale PatchMatch, the same family of technique as
  Photoshop's Content-Aware Fill); Try another; Source to clone from a place
  you choose.
- **Text** — captions in six styles, eight colours; drag, pinch, twist.
- **Undo · Redo · Before · Save** — Undo names what it undid, and holding it
  rewinds through every step. Hold **Before** (or hold the photo) to see the
  original; slide to wipe between them. **Save** hands a full-resolution JPEG
  to the iOS share sheet — tap **Save Image** and it's in Photos.

The same grammar runs everywhere: one finger does the tool's job, two fingers
move the view, a still press shows Before, and every amount is set with the
same ruler (relative drag, sticks at zero, double-tap to reset). Auto-enhance
shows exactly which dials it moved, and each of those chips opens that dial —
so the one-tap fix is also the lesson.

Edits are non-destructive and autosaved after every step; if iOS closes the
app, it reopens where you left off.

## Run it

Once merged to `main`, the Pages deploy publishes it at
[elsewhere.quest/gesso](https://elsewhere.quest/gesso/). Open it in Safari on
your iPhone, then **Share → Add to Home Screen**. After the first launch it
works offline.

Locally, any static server works. From this directory:

```bash
npm start          # serves on http://127.0.0.1:4174
```

(ES modules need an HTTP origin; opening `index.html` from the filesystem
won't work.)

## Test it

```bash
npm test           # node --test over every lib/ module (pure, no DOM)
npm run e2e        # Playwright acceptance checks (SPEC.md §1b) against a running server
node e2e/native.mjs # native-bridge UI checks in Chromium + WebKit; run after acceptance
```

`lib/` holds everything that can be tested without a browser: the develop
pipeline (with tests that neutral is an exact identity and no slider extreme
inverts a tone ramp), crop geometry, gestures, history, the ruler, Auto,
horizon detection, healing and PatchMatch inpainting, text layout, and image
I/O. `ui/` is the DOM and WebGL layer on top. `SPEC.md` is the design.

Diagnostics for a real device: open `/gesso/?probe=1`.

## iOS app

`../gesso-ios/` hosts this same editor from its app bundle in a WKWebView. The
native build adds PHPicker import (including RAW development), direct Save to
Photos, Share, subject taps in Outline, and haptics. Native RAW imports store a
working-size lossless sRGB PNG as the draft source. The web picker and sharing
behavior remain available when no native bridge is injected.

The permanent app origin is `gesso://localhost`; its drafts are separate from
Safari's. The native bundle is offline from first launch and updates with the
app, so it does not register a service worker. Design and wire contract:
[`ios/DESIGN.md`](ios/DESIGN.md), [`ios/BRIDGE.md`](ios/BRIDGE.md).

Build and native test instructions live in [`../gesso-ios/README.md`](../gesso-ios/README.md).

## Honesty clauses

- Nothing is uploaded. Photos, drafts and history stay in this browser's
  storage on your phone; deleting the Home Screen app deletes them.
- Saved copies carry no location or camera metadata, and land in Photos as a
  new photo. Your original is never changed.
- Very large photos (48 MP) are edited and saved at up to about 24 MP to stay
  within iPhone memory limits.
- Remove works best on small things. Large or structured areas may need a
  second pass, Try another, or Source.
- Lockdown Mode turns off WebGL, which Gesso needs.
