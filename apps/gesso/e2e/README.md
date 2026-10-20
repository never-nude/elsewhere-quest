# Gesso acceptance checks

`e2e/acceptance.mjs` runs SPEC §1b "Automated acceptance checks" 1–17 against the
running app in Chromium through Playwright: touch emulation, DPR 3, iPhone safe
areas, and a generated fixture photo. It is a dev tool. The app never imports it,
and it lives outside `test/` so `npm test` (`node --test`) does not pick it up.

## Running it

```sh
# serve apps/ (any static server works)
cd apps && python3 -m http.server 4174 --bind 127.0.0.1 &

cd apps/gesso
node e2e/acceptance.mjs                         # all 17 checks
node e2e/acceptance.mjs --only 7,8,10           # some of them
node e2e/acceptance.mjs --base http://127.0.0.1:4174/gesso/ --out /tmp/gesso-e2e
```

| Option | Default | |
|---|---|---|
| `--base URL` | `http://127.0.0.1:4174/gesso/` | where the app is served |
| `--only 1,2,8` | every check | comma-separated check numbers |
| `--out DIR` | `$GESSO_E2E_OUT`, else the session scratchpad path in the script | fixture, failure screenshots, console logs, `results.json` |
| `--time-scale N` | `1` (the spec) | stretches the two time budgets (Remove 1 s, Save ready 4 s) on slow hosts |

Playwright is found as `$PLAYWRIGHT_MODULE`, then `playwright`, then the global npm
install. WebGL2 comes from SwiftShader (`--use-angle=swiftshader`), so no GPU is
needed.

The output is a table with one row per check (PASS, FAIL or SKIP and a one-line
reason), then every failure in full with its screenshots. The exit code is 0 when
nothing failed, 1 when a check failed, and 2 when the harness could not run (for
example, the server is down).

## Fixture

`e2e/fixture.mjs` paints the photo in the browser at run time, so there is no binary
in the repo. It is 4000×3000, with a horizon tilted +3° (falling to the right, so
Crop's Auto must answer about −3°), one dark 30 px speck in the sky at (1150, 700)
and a median luma of about 0.30 (it measures 0.302). The noise is deterministic, so
every run gets the same JPEG (quality 0.92, about 1.7 MB). The sky is bluish and the
ground brownish, with zero-luma chroma, so Color's Auto has a cast to correct.

## Viewports and safe areas

The portrait viewports are 402×874, 430×932 and 440×956, and the landscape ones are
874×402 and 956×440, all at DPR 3 with touch. Safe areas are emulated through CDP
`Emulation.setSafeAreaInsetsOverride`: 62/34 pt top/bottom in portrait and 62 pt
sides plus 21 pt bottom in landscape. Without that, `env()` would be 0 in Chromium.

The layout checks (1, 2, 3, 4, 5, 13) and static paint (6) run at all five
viewports. The behaviour checks run at 440×956, the iPhone 17 Pro Max.

## How each check is read

1. **Map visible.** In Home with the fixture loaded, `#dock` and `#actions` hold
   exactly the listed buttons in order. Each sits inside the viewport minus the
   measured `env(safe-area-inset-*)`, is at least 44×44, overlaps no other control,
   and every visible text piece is at least 12px.
2. **Nothing hidden.** In ten states (Home; Crop; Light and Light › Paint; Color and
   Color › Pick white; Remove; Text with the edit bar up, Text after Done, and Text ›
   Color), it checks the following:
   - No element anywhere has an accessible name matching the regex. The name is
     approximately the browser's: labelledby, aria-label, alt or label, content for
     roles that are named from content, then title.
   - No `aria-haspopup` appears in `#app`.
   - `#panel`, `#dock`, `#actions`, `#quick`, `#dials` and any segment or swatch row
     in the slot do not scroll in either axis.

   Chips whose label is genuinely clipped are noted, not failed.
3. **Fixed places.** In the same states, every action button, every dock button,
   `#panel` and `#stage` stay within 1px of their Home rects, and `#panel` is 204±1
   tall.
4. **No unlabelled controls.** `#chrome` does not exist in `index.html`, so the
   chrome is read as `#topbar`, `#actions` and `#dock`, plus `#panel`. Every
   rendered `button`, `[role=button]` and `[role=radio]` must have visible text
   (`innerText`). A ruler shows its value as ticks, so a `[role=slider]` passes on
   the check's second sentence: role `slider`, a non-empty `aria-valuetext` and a
   name. Swatches with only an `aria-label` fail: the check's one exception is a
   thumbnail chip's caption.
5. **Glanceable count.** This counts the enabled, visible (opacity > 0.05) and
   larger-than-1px interactive elements outside `#stage` in a fresh Home.
6. **Static paint.** In a context with `javaScriptEnabled: false`, the dock and
   action labels are rendered inside the viewport, legible and in order.
7. **One-tap defaults.** It runs Crop, Light and Color Auto (the first Quick chip,
   which must carry `[data-default]`), Home Auto-enhance, a tap on the speck in
   Remove, and the Text dock tap.
   - "Exactly one history entry" means the history up to the old position is
     unchanged, the redo branch is dropped and one step is added.
   - The Remove tap is a pointer down and up 40 ms apart with no movement. Its time
     is measured in the page, from the `pointerup` to the history step.
   - Each action starts from the photo as opened: Undo runs after each one.
8. **One-minute flow.** The flow is import, Auto-enhance, Crop, Auto, Save, Save to
   Photos. The import counts as one tap (the "Choose a photo" tap a person makes),
   so the flow uses 6 taps.
   - `navigator.share` is a stub. Every event listener in the page is wrapped so the
     stub knows whether it was called inside a click listener's synchronous extent.
     `window.event` cannot tell this, because it stays set while the microtasks
     that the listener queued run.
   - The shared JPEG is decoded in the page and compared with
     `editor.outputSize()`.
9. **Save fallback.** With `navigator.share` deleted, Save to Photos must show a
   visible `<img src="blob:…">` inside a full-screen element, with visible text
   "Touch and hold the picture". Chromium has no `-webkit-touch-callout`, so the
   callout value comes from the loaded stylesheets: matching rules by specificity
   and source order, inline style, then inheritance. In WebKit the computed style
   is used.
10. **Undo integrity.** After each check-7 action that added a step, Undo must
    restore a stable-JSON-equal document and show a toast beginning "Undid:". For
    Text, the step is the caption's Done.
11. **Before.**
    - Before is tapped with a 60 ms press; `data-compare` is sampled every 25 ms and
      must stay on for 1.0–1.5 s, and "Hold to compare" must be visible.
    - Then Before is held for 620 ms.
    - Then the photo centre gets a still 600 ms press in Home, Crop, Light, Color,
      Remove and Text.
12. **Gesture coverage.**
    - Live DOM: for each `GESTURES` row (lib/hints.js as served), every part of its
      `visibleEquivalent` must exist in at least one of the ten states, or its `hint`
      must exist in `HINTS`. Selectors that are missing but covered by a hint are
      noted.
    - Browser: earn H14 (Auto-enhance) and H3 (two Before taps), tracking every
      on-screen hint text every 40 ms. A hint must not show twice, must not be
      visible at the same time as another, must be stored in
      `localStorage['gesso:hints']`, and must not come back after a reload and a
      fresh import.
13. **No zoom-on-focus.** Every text-entry `input` and every `textarea` must be at
    least 16px in every state. `input[type=file]` is listed but skipped, because it
    takes no typing and so cannot trigger iOS focus zoom.
14. **Offline.**
    - Node: the served `sw.js` `SHELL` must list every file under this checkout's
      `lib/`, `ui/` and `workers/`, the root files and what `index.html` and the
      manifest link to. Every entry must exist on the server, and the activate
      handler must filter on `startsWith('gesso-')` before `caches.delete`.
    - Browser: a `textlock-v1` cache, created before Gesso's worker activates, must
      survive. Chromium's `setOffline` does not reach a service worker's own
      fetches (a network-first worker stays online), so the page is served through a
      small proxy that the harness disconnects together with `setOffline(true)`. A
      probe confirms the network is gone. The editor must then reload, start and
      open the fixture.
15. **No network.** During check 8, every request that Playwright sees from the page
    and its workers must be under `--base`. `data:` and `blob:` are not network
    requests. Chromium does not report a service worker's own fetches, but that
    worker only fetches its `SHELL`, which check 14 reads.
16. **Cancel.** It starts from an Auto-enhanced photo. In each tool it makes one
    change and taps Cancel; the document must equal the state when the tool opened,
    the history labels must equal the ones from then, and no live preview may
    remain. The changes are:
    - Crop: Square.
    - Light: Brighter.
    - Color: Film.
    - Remove: a speck tap.
    - Text: the dock tap, then Done.
17. **Resume.** After check 8, it closes the sheet, waits for autosave, reloads,
    and compares the document, the undo labels and the history position.

A page error during a check fails that check.

## Caveats

- Timing budgets run on SwiftShader. Measured so far:
  - "Removed spot": 0.67–1.1 s, against a 1 s budget.
  - Save to Photos `[data-ready]`: about 3.4 s, against a 4 s budget.

  On a loaded machine these can fail. Check the reported ms before treating such a
  failure as a regression, or rerun with `--time-scale 1.5`. The default stays
  strict.
- The harness was checked against deliberately broken copies of the app, with one
  injected fault per check. Every check failed for the injected reason.
- Taps are touch taps (`locator.tap`), and each is dispatched exactly once, after
  the harness has checked that the target is present, enabled, visible and on top.
  Photo gestures (the speck tap, holds, Before) use pointer events through
  `page.mouse`.
