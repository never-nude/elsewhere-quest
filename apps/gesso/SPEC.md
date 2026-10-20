# Gesso v1 — design spec

> Produced by a design pass (iOS Safari platform research, three competing UX
> concepts, a UX judge and an engineering judge, then a synthesis), all held to
> the owner's learnability bar: **know where everything is in 2 seconds, finish a
> real task in 1 minute, be getting proficient by minute 10.**
>
> **Build notes — these supersede the spec below where they differ:**
>
> - **Remove:** taps use §7's single-offset heal + Poisson seam correction
>   (`lib/heal.js`). Rubbed areas use multi-scale PatchMatch (`lib/inpaint.js`) —
>   the spec ruled PatchMatch out on speed grounds, but it was built, tested and
>   measured at 0.4–2 s for realistic selections before the spec landed, and it
>   handles structure that a single offset cannot.
> - **Module names:** `lib/develop.js` = tone + looks + shaders;
>   `lib/autofix.js` = autotone; `lib/image-io.js` = limits + sniff + export naming;
>   `lib/view.js` = viewport; `ui/renderer.js` = `ui/gl.js`.
> - **Tone maths:** `lib/develop.js`'s formulas (tested: neutral is an exact
>   identity and no dial extreme inverts a grey ramp), with the same dials and
>   order as §5.3.
> - **Crop state:** `{ quarter, flip, angle, aspect, tall, rect }` as in
>   `lib/geometry.js` (rect in T-space, centred).


**Basis.** The base is Thumbwork: five labelled tools, one fixed action row and the photo surface. Grafted from Seven Verbs: Auto that shows its work, Save coaching, the fixed-height panel anatomy and named undo. Grafted from What/Where/How Much: the heal algorithm (best-offset search plus Poisson blend, Try another, a draggable source), the panel fade while dragging and the cached-base render. Both judges' cuts are applied: no layers or masks UI, no Fix or Draw verbs, no three-finger gestures, no haptics, no P3, no portrait lock, no continuous pre-render, no sideways-scrolling chip rows, no double-tap zoom, no invisible vertical-swipe menus.

---

## 1. Product principles

- **One screen, one map.** Five tools and four actions are always visible, each an icon with a word, and they never move. Nothing is hidden, nested or scrolled.
- **Every tool answers in one tap.** Each tool has an Auto, a preset, a brush that is ready to use, or a caption that is ready to type into. More depth is always one tap deeper, in the same place in every tool.
- **One grammar everywhere.**
  - One finger does the tool's job. Two fingers move the view.
  - Holding shows Before.
  - The ruler sets every amount.
  - Cancel is top-left of the panel and Done is top-right.
  - Undo is always one tap away.
- **Show the work and teach by doing.** Auto animates the dials it moved. Undo names what it undid. A hint appears once, and only when the user's behaviour earns it. There is never a tutorial.
- **Nothing is lost and nothing leaves the phone.** Editing is non-destructive and autosaved after every step. Everything stays on the device. Saving to Photos produces a new copy in two taps.

## 1b. Learnability

### 2-second test (orientation)
The first frame of the editor shows four fixed bands:
- the top bar: "New photo" plus a status word;
- the photo;
- the panel;
- the action row (**Undo · Redo · Before · Save**) and the dock (**Crop · Light · Color · Remove · Text**).

In the home state that is 11 labelled controls: New photo, Auto-enhance, 4 actions and 5 tools. Save is the only filled accent button, so the way out is obvious. The home panel's hint says what to do: "Pick a tool below. Hold the photo to compare."

The start screen, before any photo is loaded, already draws this layout with the dock dimmed. The map is learned before a photo appears. All chrome is static HTML, so it paints before any JS runs.

### 1-minute test (first task)
Each tool's first Quick chip is its one-tap default. Save commits any open tool, so Done is never required. Times start once the editor is showing.

| Task | Taps (in app + iOS) | Expected time |
|---|---|---|
| Brighten, straighten, save | Auto-enhance, Crop, Auto, Save, Save to Photos, then **Save Image** in iOS | about 20s |
| Remove a blemish | Remove, tap the spot, Save, Save to Photos, then **Save Image** | about 12s |
| Add a caption | Text (keyboard is already up, "Your words" selected), type, Done, Save, Save to Photos, then **Save Image** | about 20s |
| Apply a look | Color, Film, Save, Save to Photos, then **Save Image** | about 10s |

The Save sheet tells the user about the iOS step in advance ("Next, tap Save Image") and afterwards says where the photo went.

### 10-minute test (moderate proficiency)
Depth is found through use:
- **Same anatomy everywhere.** All five panels share it (header, Quick row, Dial row, ruler) and the same ruler, so learning Light teaches Color, Crop's straighten, Remove's size and Text's size and angle.
- **Auto-enhance lists its changes.** It leaves chips such as "Brightness +18" and "Shadows +24", and each chip opens that exact dial.
- **Hints arrive when earned.** The faster paths each appear once, at the moment the user's behaviour shows they would help:
  - drag on the photo instead of the ruler;
  - double-tap the ruler to reset;
  - hold the photo and slide to wipe;
  - hold Undo to rewind;
  - pinch to zoom in Remove;
  - Try another, then Source;
  - Tall/Wide;
  - tap a caption from any tool.
- **Dials show their state.** Changed dials carry a dot. The undo toast names each step.
- **No dead ends.** Cancel always reverts the tool. Undo always works, and the rewind tape always reaches "Original".

### Automated acceptance checks
These run in a browser harness (Playwright or equivalent; dev-only, never a runtime dependency) with touch emulation at DPR 3. Portrait viewports are 402×874, 430×932 and 440×956; landscape viewports are 874×402 and 956×440. A fixture photo is loaded first: 4000×3000, horizon tilted +3°, one dark 30px speck, median luma about 0.30.

1. **Map visible.** In the home state, at every viewport:
   - exactly five dock buttons with the visible text Crop, Light, Color, Remove, Text, in that order;
   - action buttons Undo, Redo, Before, Save;
   - each fully inside the viewport and inside safe-area padding, with no two overlapping;
   - each hit box at least 44×44 CSS px with visible text of at least 12px.
2. **Nothing hidden.**
   - No element has an accessible name matching `/menu|more|options|settings|overflow/i`.
   - There is no `aria-haspopup` in the chrome.
   - In every state (home, crop, light, color, remove, text), `#panel`, `#dock`, `#actions` and every chip row have `scrollWidth <= clientWidth + 1` and `scrollHeight <= clientHeight + 1`.
3. **Fixed places.** For each tool state, the rects of Undo, Redo, Before, Save, each dock button, `#panel` and `#stage` equal the home-state rects within 1px. `#panel` height is 204±1.
4. **No unlabelled controls.** Every `button`, `[role=button]`, `[role=radio]` and `[role=slider]` in `#chrome` and `#panel` has visible text. A thumbnail chip's caption counts as its text. A colour swatch, whose colour is its content, needs an `aria-label` naming the colour instead; the chosen colour's name shows in the dial row. Each ruler has `role=slider` and a non-empty `aria-valuetext`.
5. **Glanceable count.** The home state has at most 12 enabled interactive controls outside `#stage`.
6. **Static paint.** With JavaScript disabled, `index.html` renders the five dock labels and the four action labels.
7. **One-tap defaults.**
   - In Crop, Light and Color, the first Quick chip carries `[data-default]`. Clicking it adds exactly one history entry with a non-empty label and changes the document state. For Crop, Auto sets the angle to −3°±0.5°.
   - In home, Auto-enhance adds the entry "Auto-enhance" and shows at least one change chip.
   - Remove opens with Medium selected. A synthesized tap (down and up within 150ms, no movement) on the speck adds "Removed spot" within 1000ms.
   - On the Text dock tap, `document.activeElement` is the caption textarea, with value "Your words" and selection 0–10.
8. **One-minute flow.**
   - Steps: import the fixture, then Auto-enhance, Crop, Auto, Save. The Save to Photos button gains `[data-ready]` within 4s.
   - On click, a stubbed `navigator.share` is called exactly once, synchronously in the click handler.
   - The call carries `{files:[File]}` and no `title` or `text`.
   - The file has `type === 'image/jpeg'`, a size above 0, and decoded dimensions equal to `outputSize(doc)`.
   - The whole flow uses at most 6 synthesized taps.
9. **Save fallback.** With `navigator.share` deleted, Save to Photos shows a full-screen `<img src="blob:…">` whose computed `-webkit-touch-callout` is not `none`, with the text "Touch and hold the picture".
10. **Undo integrity.** After each action in check 7, Undo restores a document state deep-equal to the previous one and shows a toast beginning "Undid:".
11. **Before.**
    - Pointerdown on Before sets `#stage[data-compare=before]` and pointerup clears it.
    - A 600ms motionless press on the photo does the same in every tool state.
    - A tap on Before keeps it for 1.2s and shows "Hold to compare".
12. **Gesture coverage** (node test). Every entry in `lib/hints.js` `GESTURES` has either a `visibleEquivalent` selector that exists in `index.html` or a `hint` id that exists in `HINTS`. In the browser, no hint shows twice across reloads (`localStorage['gesso:hints']`), and at most one hint is visible at a time.
13. **No zoom-on-focus.** Every `input` and `textarea` has a computed font-size of at least 16px.
14. **Offline.**
    - Node test: `sw.js` `SHELL` lists every file under `lib/`, `ui/` and `workers/`, plus the root shell files, and the activate handler deletes only keys starting with `gesso-`.
    - Browser: after the first load, going offline and reloading renders the editor.
15. **No network.** During check 8, every request is same-origin under `/gesso/`.
16. **Cancel.** In each tool, one change followed by Cancel gives a state deep-equal to the state when the tool opened, and the tool's history entries are gone.
17. **Resume.** After check 8, a reload reopens the editor with the same state and the same undo labels.

---

## 2. v1 feature set

**F1. Start screen and import.**
- The full editor layout is drawn with the dock and actions dimmed.
- The panel shows a 64pt accent button "Choose a photo". It is a `<label>` for a hidden `<input type=file accept="image/*">`, so it works before JS loads. iOS offers Photo Library, Take Photo and Choose File.
- Below it: "Everything stays on this iPhone." In a Safari tab only, a second line reads "To use offline: Share → Add to Home Screen" with a "Hide" text button.
- Tapping a dimmed dock tool also opens the picker.
- After a pick, the photo appears fitted and the dock lights up.
- Error messages: RAW/DNG gets "RAW photos aren't supported. Pick the regular photo." A decode failure gets "This photo couldn't be opened."
- Photos above the working cap are downscaled without comment, and the hint shows "Editing at 24 MP" once.

**F2. Fixed chrome.**
- Top bar: **New photo** (icon and word) on the left and a status word on the right (blank, "Edited" or "Saved").
- Action row: **Undo**, **Redo** (dimmed when unavailable), **Before** (hold), **Save** (filled accent).
- Dock: **Crop · Light · Color · Remove · Text**.
- Dock taps:
  - tapping a tool opens its panel;
  - tapping the active tool counts as Done;
  - tapping another tool counts as Done and switches.
- No control ever appears in or disappears from these rows.

**F3. Universal panel (fixed 204pt).** Every panel has the same four bands:
- **Header (48pt):** Cancel · tool name over a one-line hint · Done.
- **Quick row (60pt):** one-tap chips. The first chip is the default and is styled as an action with a wand icon.
- **Dial row (48pt):** two-line chips showing name and live value, with a dot when changed.
- **Ruler (48pt):** the universal amount control, or a swatch or segmented strip in the same slot.

Behaviour:
- Cancel reverts everything done since the tool opened.
- While a ruler or photo-drag is in progress, the rest of the panel fades to 15% so the photo is visible.
- The header hint line is the app's only teaching voice.

**F4. Ruler and dial chips (one control everywhere).**
- A ruler of ticks slides under a fixed centre needle.
- The drag is relative: touch anywhere on the ruler and slide, and the value never jumps. Right always means more.
- A slow drag moves 1 unit per 4pt (0.1° per pt for Straighten). Above 0.6pt/ms the gain is 3×.
- The ruler sticks at the default value for 12pt of travel, and the needle flashes as a visual tick.
- The ends rubber-band.
- A value bubble floats 70pt above the finger.
- Double-tapping the ruler, or tapping "Reset" (shown at the ruler's right end when the value is not the default), resets the dial.
- Each release is one undo step.
- Tapping a dial chip points the ruler at that dial.

**F5. Home panel: Auto-enhance that shows its work.**
- With no tool open, the panel shows a full-width **Auto-enhance** button.
- Auto-enhance runs Light Auto and Color Auto as one undo step, "Auto-enhance".
- The dial-row band then shows up to 5 change chips sorted by size ("Brightness +18", "Shadows +24", "Warmth −6"). Tapping a chip opens Light or Color with that dial selected.
- One suggestion line, read from the photo, sits in the ruler band. Examples: "Looks tilted 2.8° — Straighten it", which opens Crop and runs Auto, or "A bit dark — try Auto-enhance". If there is nothing to suggest, the line is empty.

**F6. Light.**
- **Quick row:** **Auto · Brighter · Darker · Punchier · Softer**.
  - Auto sets all four dials from the histogram, and the dials animate to their new values over 400ms.
  - Brighter and Darker are ±15 brightness and stack on repeated taps.
  - Punchier is contrast +15. Softer is contrast −15 with shadows +10.
- **Dial row:** **Brightness · Contrast · Highlights · Shadows · Paint**. Brightness is selected on open.
- **Ruler:** the selected dial, −100 to +100.
- **Drag on the photo:** after the user's first ruler drag, a one-finger horizontal drag on the photo also adjusts the selected dial (hint H1). Before that, one-finger drags on the photo do nothing.

**F7. Paint light (dodge and burn).**
- Tap the **Paint** dial chip. The ruler slot becomes a segmented control **[Brighten | Darken | Erase]**, with Brighten selected.
- A one-finger drag paints with a soft 48pt on-screen brush ring that follows the finger.
- Each pass adds ±0.5 EV, building up to ±1.5 EV. Zooming in gives finer strokes.
- Each stroke is one undo step.
- While Paint is selected, drag-on-photo paints and does not scrub.

**F8. Color.**
- **Quick row:**
  - **Auto** (neutralizes the colour cast and adds gentle vividness);
  - six 44pt live thumbnails of the user's own photo: **None · Vivid · Warm · Cool · Film · Mono**.
- Tapping a look applies it at Strength 100 and selects the Strength dial.
- **Dial row:** **Warmth · Tint · Vividness · Strength · Pick white**. Strength is disabled when the look is None.
- **Pick white:** the ruler slot shows "Tap something that should be white or grey." Pressing the photo shows a 2× loupe with a crosshair above-left of the finger. Lifting sets Warmth and Tint (the dials animate), adds the step "Picked white", and returns the ruler to Warmth.
- Drag-on-photo follows the same rule as Light.

**F9. Crop and Straighten.**
- On open, the stage shows the whole photo with any rotation applied, a frame, 24pt L-shaped corner handles with 48pt hit areas, and edge bars. Outside the frame is dimmed. Captions are hidden while Crop is open.
- **Quick row:** **Auto · Free · Original · Square · 4:5 · 16:9**, with Free selected on open.
  - Auto: detect tilt, then straighten (the ruler animates), then fit the largest clean rectangle at the current aspect. The hint reports "Straightened 2.8°", "Already level", or "No clear horizon. Drag the ruler." In the last case nothing changes.
  - An aspect chip animates the frame to the largest centred rectangle of that ratio.
- **Dial row:** **Straighten** (dial) · **Rotate** (action, 90° counter-clockwise) · **Flip** (action, horizontal) · **Tall/Wide** (action, labelled with the current orientation and enabled only for 4:5 and 16:9).
- **Ruler:** Straighten, ±45°. The frame shrinks around its centre so blank corners are never visible. Shrinking is computed from the frame at drag start, so returning to the same angle in the same drag restores it.
- **Frame gestures:** drag a corner or edge to resize, keeping the aspect if one is locked; drag inside the frame to move it. A thirds grid shows only while touching.

**F10. Remove.**
- The hint reads "Tap a spot, or rub over something."
- **Quick row:** **Small · Medium · Large** brush (20, 36 and 64pt on screen; Medium on open) and **Try another**, which is disabled until a fill exists.
- **Dial row:** **Size** (8–120pt) · **Source**.
- **Tap a spot:** on lift, a ring at brush size appears at once, and the spot is healed in under 300ms with a 0.4s shimmer.
- **Rub:** a one-finger drag paints a translucent coral area. A 2× loupe sits above-left of the finger. On lift, the area shimmers while the fill computes.
- **Size cap:** a single area is capped at 20% of the photo, measured by bounding box. Past that, the stroke stops growing and the hint reads "Big area. Do it in smaller pieces."
- **Try another:** cycles through the next 3 best sources.
- **Source:** shows a dashed ring where the last fill copied from. Dragging the ring re-fills from the new place; this is cloning.
- Each fill, retry or source move is one step. Captions are shown at 30% and ignore touches while Remove is open.

**F11. Text.**
- **Opening Text:** tapping the Text dock button, when no caption is selected, creates the caption "Your words" centred at 78% of the frame height. The keyboard rises with the text selected (focus is called inside the tap handler).
- **Edit bar:** pinned above the keyboard, it holds a 17px textarea and **Done**. The caption updates live on the photo, and the stage shifts so the caption stays visible.
- **Panel after Done:**
  - Quick row: six styles, each previewed as "Aa": **Classic · Bold · Box · Serif · Mono · Round**.
  - Dial row: **Size · Angle · Color · Add · Delete**.
  - Ruler: Size or Angle (Angle detents at 0° and ±90°). Color swaps the ruler slot for 8 swatches: white, black, yellow, orange, red, pink, blue, green.
- **Photo gestures:**
  - tap a caption to select it; tap the selected caption to edit its words;
  - drag to move it, snapping to the centre and the thirds with guide lines;
  - drag the visible corner handle to scale and rotate;
  - pinch or twist starting on the selected caption to resize or rotate;
  - tap empty photo to deselect.
- Captions stay editable objects for good. Tapping a caption in Home, Light or Color opens Text with that caption selected.

**F12. Before.**
- **Hold the Before button:** shows Before until release. **Tap Before:** shows it for 1.2s and the hint "Hold to compare".
- **Hold the photo still for 0.5s,** in any tool, with the finger not on a handle, caption or ring: shows Before. Keep holding and slide, and a vertical wipe line follows the finger, with Before on the left and After on the right.
- Before has one meaning everywhere: all tone, colour, Remove and Text edits are off, and the current framing is kept, so the two sides line up.

**F13. Undo, Redo and the rewind tape.**
- One step is one ruler release, chip tap, crop drag, fill, stroke, or text commit.
- Each undo shows a toast for 1.2s, for example "Undid: Shadows +24".
- **Rewind tape:** holding Undo for 0.4s raises a tape over the panel listing the named steps, from "Original" to now. Sliding scrubs the photo through history live, and lifting lands on that step. A new edit after landing discards the redo branch.

**F14. Zoom and navigator.**
- A two-finger pinch zooms from 1× to 8× around the fingers, and a two-finger drag pans. Releasing below 1× springs back to fit.
- While zoomed, the stage's bottom-right shows a pill ("2.4× · Fit"; tapping it fits) and an 88×66pt navigator thumbnail. Dragging its frame pans the view with one thumb.
- The view is kept when switching tools. Crop has its own fitted view.

**F15. Save to Photos.**
- Tap Save. Any open tool is committed and a sheet rises with:
  - the title "Save a copy";
  - a preview;
  - a full-width 56pt accent **Save to Photos** button showing "Preparing…" with a progress fill until the JPEG is ready;
  - under the button: "Next, tap **Save Image**." This line is shown until the first successful save;
  - a footnote: "Saves a new copy. Your original isn't changed.";
  - **Keep editing**.
- Encoding starts when the sheet opens, and the result is cached by document revision.
- Tapping Save to Photos calls `navigator.share({files:[jpeg]})` synchronously in the tap handler.
- **Success:** the sheet reads "Done. It's the newest photo in Photos." with **Keep editing** and **New photo**, and the status word becomes "Saved".
- **Cancel or failure:** AbortError leaves the sheet as it was. Any other failure, or no share support, opens the long-press fallback: a full-screen image with "Touch and hold the picture, then tap Save to Photos."

**F16. Autosave and resume.**
- Saving is automatic: the original file, the document, the full history and the Remove tiles are written to IndexedDB after every step.
- Relaunching, including after iOS kills the app, reopens the editor in the home state with the toast "Restored your last edit". Undo history is intact.
- **New photo with unsaved edits:** the panel asks inline, "Start a new photo? This edit isn't in Photos yet." **[Save first] [Discard edit] [Keep editing]**.

**F17. Earned hints.** Each hint shows at most once, in the header hint slot, for 4s with a dot. Only one shows at a time. Hints are never modal and never triggered by a timer. The full list is in §4.

**F18. Installable offline shell and landscape.**
- The app installs via Safari's Share → Add to Home Screen and then works in airplane mode.
- Landscape reflows to a side column (see §3).
- `?probe=1` opens a device diagnostics page. It is not linked anywhere in the UI.

### Not in v1
- Layers, layer cards, blend modes, masks or selections UI, and the Where chip.
- Curves, levels, HSL, histograms, clarity, sharpen, noise reduction, and vignette as a control (looks may include one).
- Draw or markup, shapes, stickers, frames and collage.
- Perspective/keystone correction (planned for v1.1 as Crop → [Straighten | Vertical | Horizontal]).
- PatchMatch or ML object removal, subject or sky selection, generative fill, and background blur.
- A separate clone-stamp tool (Remove's Source covers it).
- RAW/DNG, 16-bit, HDR gain maps, Display P3 output, PNG/HEIC/WebP export, and size/format/quality choices.
- Export above the working cap (24.5 MP).
- Copying EXIF date or GPS into exports. All metadata is stripped so the copy lands as the newest photo.
- Multiple drafts, presets, copy/paste of edits, batch editing, and Live Photo or video.
- Haptics of any kind.
- Three-finger gestures, two-finger-tap undo, edge swipes, double-tap zoom, vertical-swipe dial menus, holding a dock tool to peek, and circle-to-erase.
- Tutorials, onboarding carousels, a help page, settings, and any hamburger, More or overflow menu.
- A Canvas2D/JS rendering fallback for Lockdown Mode (v1 shows a clear message instead).
- Accounts, sync, and any network call.

---

## 3. Screen layout and navigation

All units are CSS px, which equal iOS pt. Figures are for the iPhone 17 Pro Max (440×956) and, in brackets, the 17 Pro (402×874). The app root is `position:fixed; inset:0`. Bands are padded with `env(safe-area-inset-*)`, and the top uses `max(env(safe-area-inset-top), 24px)`.

### Portrait, top to bottom
| Band | Height | Contents |
|---|---|---|
| Safe area | about 62 | nothing |
| Top bar | 44 | **New photo** (left) · status word (right, 13pt, ink-2) |
| Stage | flex: 496 (414) | photo fitted with 12pt margins on `--ground`. Overlays: "Before" badge top-centre; toasts bottom-centre; zoom pill and navigator bottom-right; value bubble; loupe |
| Panel | 204 fixed | Header 48 · Quick 60 · Dial 48 · Ruler 48 |
| Action row | 52 | **Undo** · **Redo** (left), **Before** (centre), **Save** (right, filled pill 104×44) |
| Dock | 64 | five equal cells, 24pt icon over a 12pt word; the active tool gets an accent pill |
| Home indicator | 34 | nothing; no bottom-edge gestures |

**Thumb zones.**
- Every control used during an edit sits at y ≥ 602 (≥ 520 on the 17 Pro), which is the bottom 37–41% of the screen and within a one-thumb arc.
- Save sits on the right thumb's natural arc at the bottom right. Undo sits bottom left, where either thumb reaches it.
- The only control in the top 60% of the screen is New photo, which is used once per photo.
- Nothing critical sits near the top edge. This guards against the iOS 26.x top-inset bugs.

### Start (empty) state
- The same frame is used. The stage shows a faint gesso-textured rectangle with the line "Your photo goes here".
- The panel header shows "Everything stays on this iPhone."
- The Quick and Dial bands together hold the 64pt **Choose a photo** button.
- The ruler band holds the Safari-only install line.
- The action row and dock are visible and dimmed to 35%. Tapping a dimmed tool opens the picker.

### Editor home state (no tool open)
- Header: the hint only, centred: "Pick a tool below. Hold the photo to compare."
- Quick band: **Auto-enhance**, full width, 52pt.
- Dial band: the change chips after Auto-enhance; otherwise empty.
- Ruler band: the single suggestion line, as tappable text.

### Panel contract (every tool)
- **Header:** Cancel (left, 16pt) · tool name (16pt semibold) over the hint (13pt) · **Done** (right, 16pt semibold, accent text, not filled).
- **Quick row:** at most 7 items.
  - The first item is the default action and carries a wand icon and `data-default`.
  - State chips show selection with an accent ring.
  - Chips share the row's width (flex) and never truncate or scroll. A container query drops labels from 13pt to 12pt if needed.
- **Dial row:** at most 5 chips, each at least 44pt tall, showing an 11pt name over a 14pt tabular value. Changed chips get a 4pt accent dot. The selected chip gets a 2pt accent underline.
- **Ruler slot:** one of: ruler, segmented control, swatches, or a message line.

### Tool panels
| Tool | Hint on open | Quick row (first = default) | Dial row | Ruler slot |
|---|---|---|---|---|
| Crop | "Tap Auto, pick a shape, or drag the corners." | Auto · Free · Original · Square · 4:5 · 16:9 | Straighten · Rotate · Flip · Tall/Wide | Straighten ±45° |
| Light | "Tap Auto, or pick a dial and drag the ruler." | Auto · Brighter · Darker · Punchier · Softer | Brightness · Contrast · Highlights · Shadows · Paint | selected dial, or [Brighten \| Darken \| Erase] for Paint |
| Color | "Tap Auto or a look." | Auto · None · Vivid · Warm · Cool · Film · Mono | Warmth · Tint · Vividness · Strength · Pick white | selected dial, or the Pick white message |
| Remove | "Tap a spot, or rub over something." | Small · **Medium** (selected) · Large · Try another | Size · Source | Size, or "Drag the circle to copy from somewhere else." |
| Text | (edit bar first) "Drag to move. Tap it to edit." | Classic · Bold · Box · Serif · Mono · Round | Size · Angle · Color · Add · Delete | Size / Angle / 8 swatches |

In Remove, the default is the ready brush, so a tap on the photo is the default action.

### Text editing state (keyboard up)
- The edit bar (52pt: textarea with 17px text, plus Done) is positioned at `visualViewport.offsetTop + visualViewport.height − 52`.
- The keyboard covers the panel, action row and dock. This is the one sanctioned exception to "Save always visible".
- The stage translates so the caption's centre sits in the middle of the visible area above the edit bar.

### Save sheet
- A modal bottom sheet with a grabber and "Save a copy". It is 62% of the height in portrait and centred at a maximum width of 520pt in landscape.
- It contains the preview (at most 280pt tall), the primary button, the coaching line, the footnote and Keep editing.
- A swipe down on the grabber, or Keep editing, closes it.
- The long-press fallback is a full-screen black view with the image, the instruction, and Close.

### Landscape (width > height, height ≤ 500)
- The stage is on the left and a right column is a fixed 384pt wide.
- The column holds, top to bottom, the same bands in the same order: top bar, panel (204), action row, dock.
- Left and right safe-area insets are padded, and the column fits in 381pt on the 17 Pro.
- iOS ignores orientation lock, so the `orientation` member is removed from the manifest.

### Navigation model
- There is one screen with no pages, menus or drawers. A tool is a state of the panel.
- The only modal surfaces are the Save sheet, the iOS picker and share sheet, and the keyboard.
- Leaving a tool by switching tools or tapping Save commits it. Cancel reverts it. There are no "save changes?" prompts.

---

## 4. Gestures

**Arbitration rules** (implemented in `lib/gestures.js` and covered by tests):
1. **One finger** does the open tool's action. **Two fingers** move the view (zoom and pan) in every tool. The single exception is a two-finger gesture whose first finger landed on the selected caption in Text, which resizes and rotates that caption.
2. A **second finger landing** during a one-finger action (paint, rub, crop drag, caption drag, ruler) cancels that action with no history step, and the gesture becomes a pinch. This is how pan and zoom coexist with brushes.
3. **One-finger classification:** movement over 8pt before 500ms is a drag. Release before 500ms with less than 8pt of movement is a tap, recognised on lift with no double-tap wait. Still for 500ms is a hold, which means Before.
4. **What is under the finger wins:** crop handle, then caption or its handle, then the source ring, then the photo.
5. In Light and Color, a photo drag is axis-locked within the first 10pt. Only horizontal drags (|dx| > 1.5·|dy|) adjust. Vertical drags do nothing.

| Gesture | Context | Effect | Visible equivalent / hint |
|---|---|---|---|
| Tap dock tool | always | open; tap the active tool = Done; tap another = Done and switch | itself |
| Tap Undo / Redo | always | one step; toast "Undid: …" | itself |
| Hold Undo 0.4s, slide | always | rewind tape through named steps; lift lands | hint H5 |
| Hold / tap Before | always | Before until release / for 1.2s | itself; H3 |
| Hold photo still 0.5s, slide | every tool | Before; sliding moves a wipe line | Before button; H4 |
| Two-finger pinch / drag | photo, every tool | zoom 1–8× about the fingers / pan; below 1× springs to fit | zoom pill and navigator; H6 in Remove |
| Drag navigator frame / tap "Fit" | while zoomed | pan / fit | itself |
| Drag ruler | any ruler | relative adjust; slow is fine, fast is coarse; sticks at the default | itself |
| Double-tap ruler | any ruler | reset dial | "Reset" text at the ruler end; H2 |
| One-finger horizontal drag on photo | Light, Color (after the first ruler drag; Paint not selected) | adjust the selected dial, with a value bubble | ruler; H1 |
| One-finger drag on photo | Light with Paint selected | paint brighten / darken / erase | segmented control; H13 |
| Tap caption | Home, Light, Color | open Text with that caption selected | H11 |
| Press, then lift on photo | Color with Pick white | loupe; lift sets the white point | dial chip and its message |
| Drag corner / edge | Crop | resize (aspect kept if locked); thirds grid while touching | handles |
| Drag inside frame | Crop | move the frame | Crop hint |
| Tap photo | Remove | heal the spot at brush size | Remove hint |
| One-finger drag on photo | Remove | paint the area; lift fills it | Remove hint |
| Drag dashed ring | Remove, Source selected | choose the copy source; lift re-fills | Source chip; H8 |
| Tap caption / tap the selected caption | Text | select / edit words (keyboard) | H10 |
| Drag caption | Text | move with centre and thirds snapping, with guide lines | H10 |
| Drag corner handle | Text, selected caption | scale and rotate | visible handle |
| Pinch / twist starting on the selected caption | Text | size / angle | Size and Angle dials; H10 |
| Tap empty photo | Text | deselect | none |
| Swipe down on grabber | Save sheet | close | Keep editing |

**Hints** (`lib/hints.js`; each shown once, triggered only by behaviour):

| ID | Trigger | Text | Side effect |
|---|---|---|---|
| H1 | first ruler drag in Light or Color | "Tip: you can also drag sideways on the photo." | enables photo-drag (`gesso:photoDrag`) |
| H2 | second ruler drag | "Double-tap the ruler to reset." | none |
| H3 | each of the first 2 taps on Before | "Hold to compare." | none |
| H4 | first Before-button hold | "You can also hold the photo. Slide to wipe." | none |
| H5 | third Undo tap in a session | "Hold Undo to rewind through every step." | none |
| H6 | first heal | "Pinch to zoom in on small things." | none |
| H7 | first rub fill | "Not quite right? Tap Try another." | none |
| H8 | second Try another | "Tap Source to choose where to copy from." | none |
| H9 | a Before-hold while in Remove | "Quick tap to remove. Holding shows the original." | none |
| H10 | first caption Done | "Drag to move · pinch to resize · tap it to edit." | none |
| H11 | first return to Home with a caption present | "Tap a caption anytime to edit it." | none |
| H12 | first 4:5 or 16:9 tap | "Tap Tall/Wide to turn the frame." | none |
| H13 | first Paint selection | "Paint with one finger. Paint again to build it up." | none |
| H14 | first Auto-enhance | "Tap a change to fine-tune it." | none |

---

## 5. Edit model and architecture

### 5.1 Document model (non-destructive, fixed order, no layers)
```js
DocState = {
  v: 1, id, createdAt,
  source:   { key: 'source:<id>', type, natW, natH, w, h },          // w,h = working size (exact decode target)
  light:    { brightness: 0, contrast: 0, highlights: 0, shadows: 0 },   // −100..100
  color:    { warmth: 0, tint: 0, vividness: 0, look: 'none', strength: 100 },
  paint:    [strokeId, ...],             // ordered; stroke bodies live in pools.strokes
  geometry: { rot90: 0, flipH: false, angle: 0 /*deg*/, crop: null | {x,y,w,h} /*T-space px*/,
              aspect: 'free'|'original'|'1:1'|'4:5'|'16:9', tall: true },
  remove:   [patchId, ...],              // ordered; tile meta in pools.patches, pixels in IDB
  text:     [{ id, text, style, color, cx, cy, size, angle }],   // cx,cy normalized to output frame
}
Pools = {
  strokes: { [id]: { mode: 'brighten'|'darken'|'erase', r /*source px*/, pts: number[] /*source px, 0.5 rounded*/ } },
  patches: { [id]: { x, y, w, h /*source px bbox*/, blobKey: 'tile:<id>' } },
}
```
- **Stored on device:** the original file Blob (never re-encoded), the DocState snapshots inside the history, the Pools, and the Remove tiles. A tile is raw RGBA of the bbox at working resolution. Alpha is 255 where the fill wrote pixels and 0 elsewhere, and RGB holds the exact final values.
- **Tone, colour, paint and text** are parameters or vectors, so they cost a few KB.
- **Remove tiles are pixels** because a fill depends on the data underneath.

### 5.2 Coordinate spaces
- **S (source):** working pixels of the upright decoded image, origin top-left. Paint strokes, Remove tiles, the blur map and the paint mask live here.
- **O (oriented):** S after `rot90` and `flipH`. Size W′×H′.
- **T (straightened):** O rotated by `angle` about its centre, with coordinates relative to that centre. The crop rect lives here.
- **Out (output):** crop pixels, origin top-left, size `outputSize(doc)`. Captions use normalized Out coordinates, with size relative to the short side.
- **View:** stage CSS px. `View = {scale, tx, ty, fitScale}` maps Out to the stage (Crop uses a T-to-stage view). Device px = CSS px × DPR.
- `geometry.outputToSource(doc)` is the single 3×3 matrix the shader uses to map an Out pixel to an S UV. `sourceToOutput` is its inverse.

### 5.3 Render pipeline
GPU state:
- one WebGL2 context: `{alpha:false, antialias:false, preserveDrawingBuffer:false}`;
- **pristine** texture: S, RGBA8, mipmapped;
- **base** texture: pristine plus Remove tiles, RGBA8, mipmapped;
- **blur map**: 512px long edge, RGBA8, R = blurred luma, S-space;
- **paint mask**: RG8, S/4 capped at 2048px long edge;
- **look LUT**: 256×1 RGBA8;
- **caption textures**.

One fragment pass per output pixel, in this order:
1. `uvS = outputToSource · outPx` (outside the image is transparent, which cannot happen after a fitted crop). Sample **base**, or **pristine** for Before.
2. sRGB to linear.
3. White balance gains (warmth, tint), in linear.
4. Paint light: `lin *= exp2(1.5·(mask.r − mask.g))`, sampled at `uvS`.
5. Linear to sRGB-encoded `p`.
6. Shadows and highlights, using the blur map at `uvS`.
7. Brightness (midtone gamma).
8. Contrast (pivoted S-curve).
9. Vividness.
10. Look: LUT curves, saturation, split tone and fade, mixed by strength.
11. Look vignette, in Out UV.
12. Dither (±0.5/255, hash of `outPx`), clamp, write RGBA8.
13. Caption quads drawn after the pass with premultiplied alpha blending. Captions are not affected by tone.

Before: the same pass with pristine, identity parameters, no paint, no look and no captions, using the same geometry. Wipe: draw After, then Before with a scissor to the left of the wipe x.

Resolution independence (preview equals export):
- Every spatial term is defined in normalized S or Out UV: the blur map, the mask, the vignette and the captions.
- Brush radii are stored in S px.
- No spatial filter depends on output pixel size.

### 5.4 Working-resolution and memory policy
- **Working image:** at most **24.5 MP** (`WORK_MAX_PIXELS = 24_500_000`, which keeps native 24 MP 5712×4284 captures) and at most 8192 px per side.
  - 48 MP sources are downscaled at decode to about 5774×4330.
  - The cap is a **memory budget, not the canvas limit**. The canvas limit (67,108,864 px area, 8192 px per side) is also enforced by `fitWorkingSize`.
- **Step-down:** if any allocation check fails (GL error, `drawingBufferWidth` mismatch, blank sample, null blob), drop to `WORK_FALLBACK_PIXELS = 12_000_000`, persist `gesso:workCap`, and re-import.
- **Preview:** stage size × DPR (about 1.5–1.9 MP), rendered on demand in rAF when dirty.
- **Analysis** (auto, level, thumbnails): renders at 512px long edge, read back with `readPixels`.
- **Memory ledger** (`lib/memory.js`), budget **900 MB**.

| Item | Size at 24.5 MP |
|---|---|
| pristine (mipmapped) | 130 MB |
| base (mipmapped) | 130 MB |
| import transient (bitmap) | 98 MB |
| import strip canvas | 12 MB |
| export band FBO | ≤ 32 MB |
| export output buffer | 98 MB, transferred to the worker |
| worker OffscreenCanvas | 98 MB |

  Expected peak is about 560 MB, during export.
- **Freeing:** `bitmap.close()`, `canvas.width = canvas.height = 0`, `gl.deleteTexture` and `deleteFramebuffer`, and `URL.revokeObjectURL`.

### 5.5 Undo and redo
- History is a list of `{state, label, tool}` snapshots of DocState. Snapshots are immutable and share structure, and only ids reference strokes and patches. Cap: 300 entries.
- `commit(next, label)` pushes. `live(next)` renders without pushing, for drags. The commit comes on release.
- **Tool sessions:** opening a tool calls `setMark`. Cancel calls `revertToMark`, which truncates the entries and clears redo. Undo past the mark moves the mark down.
- **Applying a target state:**
  - Uniforms, LUT and captions update directly.
  - The paint mask is rebuilt by replaying stroke dabs when `paint` differs.
  - Remove changes use `patches.planReconcile(currentIds, targetIds)`:
    - **Revert** each suffix patch in reverse order: copy its bbox from pristine to base, then paste every earlier tile that intersects that bbox (`repaintPlan`).
    - **Apply** the new suffix tiles in order.
  - Tiles are exact final pixels, so replay is bit-exact.
- **Labels** come from `doc.describeChange(prev, next)`, for example "Brightness +18", "Crop 4:5", "Straightened 2.8°", "Removed spot", "Caption 'Hello'". The rewind tape uses `jumpTo(i)` and is throttled to one reconcile per frame.

### 5.6 Autosave and restore (IndexedDB `gesso`)
- **Stores**, all accessed **by primary key only** (never through an index):
  - `blobs`: `source:<docId>` and `tile:<patchId>`;
  - `docs`: `<docId>` → `{doc meta, pools, history:{entries, index, mark}, savedRevision}`;
  - `meta`: `current` → `{docId}`.
- **Writes:**
  - A tile is written as soon as it is created, before the history entry that references it.
  - The `docs` record is written 300ms after each commit (debounced).
  - On `visibilitychange` to hidden and on `pagehide`, a best-effort flush.
- **Each launch:**
  1. Call `navigator.storage.persist()` and record the result.
  2. Open the store.
  3. If `meta.current` exists:
     - decode the source Blob to exactly `{w, h}`;
     - upload pristine and base;
     - paste the tiles listed in the current state;
     - rebuild the paint mask and blur map;
     - render, and show the toast "Restored your last edit".
  4. Garbage-collect blobs that no history entry references.
  5. If restore fails, discard the draft and show the start screen with "Your last edit couldn't be restored."
- **If IndexedDB is unavailable** (Private Browsing or Lockdown), use the in-memory store. The start screen line becomes "Edits won't be kept if you leave Gesso."
- **v1 keeps one draft.**

### 5.7 Import and export paths
**Import:**
1. Sniff the first 64 KB (`sniff.readImageInfo`) for type, dimensions and EXIF orientation, then compute the oriented working size.
2. `createImageBitmap(file, {resizeWidth, resizeHeight, resizeQuality:'high'})`. EXIF is applied by WebKit; never rotate manually.
3. Check the bitmap's aspect against the expected oriented aspect. On mismatch, retry with the dimensions swapped.
4. Draw into a W×512 **sRGB 2D strip canvas** and upload each strip with `texSubImage2D`. This forces colour-managed conversion to sRGB.
5. Close the bitmap.
6. Verify by reading back a 1-px sample.

**Export:**
1. Rasterize captions at export scale with a 2D canvas, then upload.
2. For each band from `bandPlan(outW, outH)`, at most 32 MB per band: bind the band FBO, run the same pass plus the caption quads with a band offset and y-flip, and `readPixels` into one `Uint8ClampedArray` within the same task.
3. Transfer the buffer to `workers/export-worker.js`: `new ImageData(...)`, then an OffscreenCanvas 2D `putImageData`, then `convertToBlob({type:'image/jpeg', quality:0.92})`.
4. Assert `blob.type === 'image/jpeg'`.
5. If the worker path is unavailable, use main-thread `canvas.toBlob` after painting "Preparing…" and yielding a frame.
6. The file is named `gesso-YYYYMMDD-HHMMSS.jpg`. It carries no metadata and is sRGB.

### 5.8 WebGL context loss
- `webglcontextlost`: call `preventDefault()`, pause rendering, and show "Recovering…".
- `webglcontextrestored`: recompile, re-decode the source Blob, paste tiles, and rebuild the mask, blur map and LUT.
- If the context is not restored within 3s, call `location.reload()`. Autosave restores the work.
- GPU memory is never the only copy of the user's work.

### 5.9 File tree and module interfaces
```
apps/gesso/
  index.html            static chrome (dock, actions, panel skeleton, SVG sprite), metas, <input type=file>
  styles.css            tokens, layout (portrait/landscape), components
  app.js                bootstrap: probe GL2 → createRenderer → openStore → createEditor → restore/start; SW register
  sw.js                 CACHE='gesso-v1'; precache SHELL; network-first fetch(req,{cache:'no-cache'}); delete only 'gesso-*'
  manifest.webmanifest  remove "orientation"
  lib/   (pure ES modules, no DOM; each has test/<name>.test.mjs)
  ui/    (DOM + WebGL)
  ui/tools/
  workers/
  test/  node tests + gl-parity.html (browser harness page)
```

**lib/ (pure)**
```js
// limits.js
export const MAX_SIDE = 8192, MAX_AREA = 67_108_864, WORK_MAX_PIXELS = 24_500_000,
             WORK_FALLBACK_PIXELS = 12_000_000, MEMORY_BUDGET = 900 * 2**20;
export function fitWorkingSize(w, h, { maxPixels, maxSide } = {})   // → { w, h, scale }
export function canvasSizeOk(w, h)                                  // → boolean
export function previewSize(cssW, cssH, dpr)                        // → { w, h } (≤ MAX_SIDE)
export function exportPeakBytes(outW, outH, workW, workH)           // → number

// memory.js
export function createLedger(budget)   // → { alloc(key, bytes), free(key), total(), canAfford(bytes), entries() }
export function textureBytes(w, h, { mips = false, bpp = 4 } = {})

// sniff.js
export function sniffType(bytes)        // → 'jpeg'|'png'|'heic'|'avif'|'gif'|'webp'|'raw'|'unknown'
export function readImageInfo(bytes)    // → { type, width, height, orientation } | null  (JPEG SOF+EXIF, PNG IHDR)
export function orientedSize(info)      // → { w, h }
export function importMessage(type)     // → string | null

// doc.js
export const DEFAULTS, LOOK_IDS, ASPECTS, DIALS;
export function createDoc({ id, sourceKey, sourceType, natW, natH, w, h, now })   // → DocState
export function reviveDoc(json)                       // → DocState (validate/clamp; throws on unusable)
export function setIn(state, path, value)             // → DocState (structural sharing)
export function describeChange(prev, next)            // → string label
export function changedDials(state)                   // → Set<string>
export function isUnedited(state)                     // → boolean

// history.js
export function createHistory(state, { cap = 300 } = {})   // → H
export function push(H, state, label, tool)                // → H
export function undo(H), redo(H), jumpTo(H, i)             // → H
export function canUndo(H), canRedo(H), current(H), labels(H)
export function setMark(H), revertToMark(H)                // → H
export function serialize(H), revive(json)
export function referencedIds(H)                           // → { strokes: Set, patches: Set }

// patches.js
export function planReconcile(currentIds, targetIds)       // → { revert: id[] (reverse order), apply: id[] }
export function repaintPlan(rect, priorIds, patchMeta)     // → id[] intersecting rect, in order
export function rectIntersect(a, b), rectUnion(a, b), rectArea(r)

// geometry.js
export function orientedSize(w, h, rot90)
export function maxInscribedRect(W, H, angleRad, aspect /* w/h | null */, center /* T-space | null */)  // → {x,y,w,h}
export function fitCropToImage(crop, W, H, angleRad)      // shrink about centre to fit
export function cropForAspect(doc, aspectId, tall)        // → crop
export function resizeCrop(crop, handle, dx, dy, aspect, doc), moveCrop(crop, dx, dy, doc)
export function outputSize(doc)                           // → { w, h }
export function outputToSource(doc), sourceToOutput(doc)  // → Float32Array(9), column-major
export const mat3 = { mul, invert, apply }

// viewport.js
export function fitView(stageW, stageH, contentW, contentH, margin)   // → View
export function zoomAbout(view, factor, cx, cy, { min = 1, max = 8 })
export function panBy(view, dx, dy, stage, content), settle(view)
export function screenToContent(view, x, y), contentToScreen(view, x, y)
export function navigatorFrame(view, stage, content, navW, navH)       // → { x, y, w, h }

// gestures.js
export const DEFAULT_CONFIG = { slopPt: 8, holdMs: 500, axisLockPt: 10, axisRatio: 1.5 };
export function createRecognizer(config)                 // → state
export function step(state, event, ctx)                  // → { state, intents: Intent[], wakeAt: number | null }
//  event: { type:'down'|'move'|'up'|'cancel'|'timer', id, x, y, t, target: 'photo'|'handle:*'|'caption:*'|'ring' }
//  ctx:   { dragAxis: 'free'|'x'|'none', captionPinch: boolean }
//  Intent: tap | holdStart | holdMove{x} | holdEnd | dragStart{target,x,y} | dragMove{x,y,dx,dy}
//        | dragEnd | dragCancel | pinchStart | pinchMove{scale,rotation,cx,cy,dx,dy,onCaption} | pinchEnd

// ruler.js
export const RULERS   // { brightness:{min:-100,max:100,def:0,unitsPerPt:0.25}, straighten:{min:-45,max:45,def:0,unitsPerPt:0.1}, ... }
export function stepValue(spec, value, dxPt, speedPtPerMs, detent)   // → { value, detent, ticked }
export function formatValue(spec, v)                                 // → '+18' | '−2.8°' | '36 pt'

// tone.js   (JS reference of the shader; also the future no-GL fallback)
export const LUMA = [0.2126, 0.7152, 0.0722];
export function srgbToLinear(x), linearToSrgb(x)
export function wbGains(warmth, tint)            // → [r, g, b], luminance-normalized
export function wbFromGains(gains)               // → { warmth, tint } (inverse of wbGains)
export function uniformsFor(state)               // → { uWB, uBright, uContrast, uShadows, uHighlights, uVivid, uLook*, uStrength }
export function shadeRef(rgb, u, { blurLuma, paintEV, outUV, lut })   // → rgb (mirrors FRAG_FINISH exactly)

// looks.js
export const LOOKS     // { none, vivid, warm, cool, film, mono } parameter table
export function lookLUT(id)          // → Uint8Array(256 * 4)
export function lookUniforms(id)     // → { sat, splitS, splitH, fade, vignette, mono }

// shaders.js
export const VERT_FULLSCREEN, FRAG_FINISH, FRAG_DOWNSAMPLE, FRAG_BLUR, FRAG_DAB, FRAG_FILL, VERT_QUAD, FRAG_QUAD;
export const UNIFORMS   // names; test asserts parity with tone.uniformsFor keys

// autotone.js
export function analyze(rgba, w, h)              // → Stats { p1, p5, p50, p95, p99, clipLow, clipHigh, meanSat, neutral:[r,g,b] }
export function autoLight(stats)                 // → { brightness, contrast, highlights, shadows }
export function autoColor(stats)                 // → { warmth, tint, vividness }
export function autoEnhance(stats, state)        // → { next: DocState, changes: [{ dial, label, delta }] }
export function whiteFromSample(rgbLinear)       // → { warmth, tint }
export function suggestion(stats, tilt)          // → { text, action: 'straighten'|'enhance' } | null

// level.js
export function toGray(rgba, w, h)               // → Float32Array
export function detectTilt(gray, w, h, { maxDeg = 12 } = {})   // → { angleDeg, confidence, kind: 'horizon'|'verticals'|'none' }

// heal.js
export const AREA_CAP = 0.20;
export function diskMask(cx, cy, r, w, h)               // → Uint8Array
export function strokeMask(points, r, w, h)             // → Uint8Array
export function maskBounds(mask, w, h)                  // → { x, y, w, h, area }
export function findSources(img, w, h, mask, { maxResults = 4 } = {})    // → [{ dx, dy, score }]
export function solveCorrection(img, w, h, mask, dx, dy, { iters = 120 } = {})  // → Float32Array (rgb)
export function composeRef(img, w, h, mask, dx, dy, corr, corrScale, featherPx) // → Uint8ClampedArray (tile)

// stroke.js
export function resample(points, spacing), smooth(points, amount), dabs(points, radius, spacingRatio = 0.25)

// text-layout.js
export const STYLES, SWATCHES;
export function newCaption(id)                                    // 'Your words', classic, white, cx .5, cy .78
export function layoutCaption(caption, outW, outH, measure)       // measure(text, font) → px; → { lines, fontPx, boxW, boxH, pad }
export function captionMatrix(caption, layout, outW, outH)        // → mat3 (box → Out px)
export function hitCaption(captions, layouts, x, y, outW, outH)   // → id | null
export function snapPosition(cx, cy, thresholdNorm)               // → { cx, cy, guides }

// hints.js
export const HINTS, GESTURES;
export function countEvent(counters, event)                       // → counters
export function nextHint(event, counters, shown)                  // → hintId | null

// export.js
export const JPEG_QUALITY = 0.92;
export function exportName(date)                                  // → 'gesso-20261020-143005.jpg'
export function bandPlan(outW, outH, maxBandBytes = 32 * 2**20)   // → [{ y, h }]
```

**ui/ (DOM, WebGL), workers/**
```js
// ui/gl.js
export function createRenderer(canvas, { ledger, onLost, onRestored })   // → R
R.loadSource(file, { w, h })            // strip upload → pristine + base; → Promise<void>
R.setState(state, pools)                // lazy: uniforms, LUT, paint mask, captions
R.draw({ view, compare: 'off'|'before'|'wipe', wipeX, loupe })
R.drawCropView({ view, doc, compare })
R.readAnalysis(maxSide = 512)           // → { data, w, h } (geometry applied, identity tone)
R.readRegion(rectS, scale)              // → { data, w, h } (downsampled base)
R.composeFill({ rectS, maskStroke, dx, dy, corr, corrW, corrH, corrScale })  // writes base; → tile Uint8Array
R.pasteTile(meta, rgba), R.restoreRect(rectS)
R.rebuildPaintMask(strokes), R.paintDabs(stroke, fromIndex)
R.renderThumbs(state, lookIds, px)      // → ImageData[]
R.exportPixels(state, pools, { onProgress })  // → Promise<{ buffer, w, h }>
R.rebuildBlurMap(), R.dispose()

// ui/editor.js  (single integration point)
export function createEditor({ root, renderer, store, heal })   // → Ed
Ed.state(), Ed.pools(), Ed.commit(next, label), Ed.live(next), Ed.undo(), Ed.redo(), Ed.jumpTo(i)
Ed.openTool(id, opts), Ed.closeTool({ cancel }), Ed.activeTool()
Ed.view(), Ed.setView(v), Ed.fit(), Ed.requestRender(), Ed.setPanel()
Ed.toast(text), Ed.hintEvent(name, data), Ed.renderer, Ed.heal, Ed.store

// ui/tools/{home,crop,light,color,remove,text}.js — every tool exports this shape
export default {
  id, label,
  open(ed, opts), close(ed, { cancel }),
  panel(ed),                      // → PanelSpec
  onPanel(ed, { type: 'quick'|'dial'|'swatch'|'segment', id }),
  onRuler(ed, phase /* 'start'|'move'|'end' */, value),
  onIntent(ed, intent),           // → boolean handled
  dragAxis(ed),                   // → 'free'|'x'|'none'
  hitTarget(ed, x, y),            // → 'handle:nw'|'caption:<id>'|'ring'|null
  drawOverlay(ed, ctx2d),
}
// PanelSpec = { title, hint, quick: [{ id, label, kind:'action'|'state'|'thumb', selected, disabled, isDefault, thumb }],
//               dials: [{ id, label, value, changed, selected, kind:'dial'|'action'|'mode' }],
//               slot: { kind:'ruler', spec, value } | { kind:'segment', options, selected }
//                   | { kind:'swatches', colors, selected } | { kind:'message', text } | null }

// ui/stage.js       createStage(el, ed)            → { resize(), overlayDirty() }  // pointer → gestures.step → tool / view / Before
// ui/chrome.js      createChrome(root, handlers)   → { setTool(id), setEnabled(map), setStatus(text), toast(text) }
// ui/panel.js       createPanel(el, handlers)      → { render(spec), showHint(text, ms), fade(on) }
// ui/ruler-view.js  createRulerView(el, handlers)  → { set(spec, value), animateTo(value, ms) }
// ui/tape.js        openTape(ed, anchorEl)         // rewind tape
// ui/hints-ui.js    createHints(panel, storage)    → { event(name, data) }
// ui/text-raster.js rasterizeCaption(caption, layout, scale) → HTMLCanvasElement
// ui/importer.js    decodeForEditing(file, { maxPixels }) → Promise<{ info, w, h }>  (throws ImportError(message))
// ui/exporter.js    exportJpeg(renderer, state, pools, { onProgress }) → Promise<Blob>
// ui/savesheet.js   openSaveSheet(ed)
// ui/store.js       openStore() → Promise<{ persistent, putBlob, getBlob, deleteBlob, putDoc, getDoc, getCurrent, setCurrent, gc }>
// ui/autosave.js    createAutosave(store, snapshotFn, { debounceMs: 300 }) → { schedule(), flush() }
// ui/heal-client.js createHealClient() → { find(regionImg, w, h, mask), correct(jobId, sourceIndex | {dx,dy}) }
// ui/probe.js       runProbe(root)  // ?probe=1
// workers/heal-worker.js    {type:'find'|'correct'} ↔ {type:'found'|'corrected'}; imports ../lib/heal.js
// workers/export-worker.js  {type:'encode', buffer, w, h, quality} → {type:'blob', blob} | {type:'error', message}
```

### 5.10 Parallel ownership and build order
| Track | Owns |
|---|---|
| A. Core | `index.html`, `app.js`, `ui/editor.js`, `lib/{doc,history,patches}.js`, `ui/{store,autosave}.js`, `sw.js`, manifest, and the separate TextLock `sw.js` prefix patch |
| B. Render | `lib/{tone,looks,shaders,limits,memory,export}.js`, `ui/{gl,exporter,probe}.js`, `workers/export-worker.js`, `test/gl-parity.html` |
| C. Interaction kit | `lib/{gestures,ruler,viewport,hints}.js`, `ui/{stage,chrome,panel,ruler-view,tape,hints-ui}.js`, `styles.css` |
| D. Geometry and tone tools | `lib/{geometry,level,autotone}.js`, `ui/tools/{home,crop,light,color}.js` |
| E. Remove and Paint | `lib/{heal,stroke}.js`, `workers/heal-worker.js`, `ui/heal-client.js`, `ui/tools/remove.js`, the Paint part of `light.js` (through a `paint` sub-module that D imports) |
| F. Text, import and save | `lib/{text-layout,sniff}.js`, `ui/{text-raster,importer,savesheet}.js`, `ui/tools/text.js` |

Milestones:
1. Shell, import, identity render, Save sheet with share, Undo, autosave.
2. Home Auto-enhance, Light, Color, Crop with Auto. The brighten/straighten/save task passes.
3. Remove tap and Text. All 1-minute tasks pass.
4. Remove rub and Try another, hints, wipe, zoom navigator, landscape, rewind tape.
5. Paint light, Source, Pick white, and the on-device probe and tuning pass.

Cut order if the schedule slips: Paint light, then Source, then rewind tape, then Pick white, then wipe (hold-compare stays). Nothing named in the §1b checks is cut.

### 5.11 Tests
- `node --test` runs over `test/*.test.mjs`, one file per lib module, plus `sw-shell.test.mjs` and `hints-coverage.test.mjs`.
- Notable assertions:
  - `fitWorkingSize` never exceeds the area or side limits.
  - geometry round-trips through `outputToSource` and `sourceToOutput`.
  - `maxInscribedRect` has no corner outside the rotated image.
  - `wbGains` and `wbFromGains` round-trip.
  - `shadeRef` with identity parameters is within 1/255 of the input.
  - tone curves are monotonic.
  - `planReconcile` and `repaintPlan` replay is exact on synthetic tiles.
  - gesture sequences classify correctly: tap, hold, drag, a second finger cancelling a drag, and caption pinch.
  - `detectTilt` finds synthetic lines at ±3° within 0.3°.
  - `findSources` finds the planted texture offset.
  - `solveCorrection` gives a seamless boundary on a gradient.
  - history serialize and revive round-trips.
- `test/gl-parity.html` renders a 16×16 fixture under 50 random parameter sets and compares against `shadeRef` within 2/255. The browser harness runs it.

---

## 6. iOS Safari constraints we honour

- **Canvas area 67.1 MP and 8192 px per side; WebGL buffer clamped to 8192.** `lib/limits.fitWorkingSize` enforces both. After every allocation, check `drawingBufferWidth === canvas.width`, a 1-px sample, and a non-null blob. The 24.5 MP cap is presented as a memory budget, never as a canvas limit.
- **No canvas memory cap; jetsam is around 1.5–2 GB.** This drives the 900 MB ledger, explicit freeing, strip import, band export, tiles instead of full-frame undo snapshots, and autosave after every step.
- **16 WebGL contexts per page, 4 per worker.** Exactly one WebGL2 context. Thumbnails, loupe and analysis all use it. Workers do not use WebGL.
- **MAX_TEXTURE_SIZE 16384 (8192 in the Simulator).** The working image is a single texture, and the size is clamped to `min(8192, MAX_TEXTURE_SIZE)`.
- **fp32 at every precision qualifier.** Shaders write `precision highp float`. Correctness comes from `shadeRef` tests and the parity page.
- **EXT_float_blend gone; 32F filtering unreliable.** The pipeline is a single RGBA8 pass with no float render targets. The only float texture is the small heal correction, uploaded as RGBA16F and sampled LINEAR, with an RGBA8 offset-encoded fallback if it is incomplete.
- **preserveDrawingBuffer false.** The visible canvas is never read back. Export and analysis render to an FBO and call `readPixels` in the same task. The loupe is drawn inside the GL canvas.
- **Context loss on background or pressure.** Handled as described in §5.8, with IndexedDB as the source of truth.
- **OffscreenCanvas and module workers available; `toBlob` blocks the main thread.** JPEG encoding happens in `export-worker` through `convertToBlob`, and healing in `heal-worker`. Main-thread `toBlob` is a fallback only, after a painted "Preparing…".
- **Only JPEG and PNG encode; unsupported types silently become PNG.** Export is JPEG at 0.92, with `blob.type` asserted.
- **`ctx.filter` is disabled.** Every adjustment is GLSL with a JS reference.
- **No `unpackColorSpace`; P3 sources.** The pipeline is sRGB everywhere. Import goes through an sRGB 2D strip canvas for colour-managed conversion. Before and After use the same texture path.
- **HDR `<img>` would look brighter than the canvas.** The original is never shown as an `<img>`. Before is drawn by the pipeline. SDR export is accepted.
- **`createImageBitmap` applies EXIF and resizes at decode.** No manual rotation. The aspect check catches any resize-before-orient ambiguity. The bitmap is closed after upload.
- **Large `<img>` decodes subsampled when scaled.** Import never goes through `<img>`.
- **HEIC decodes; RAW does not; Lockdown decodes only JPEG/PNG/GIF/WebP.** `lib/sniff` gives the specific messages.
- **The picker transcodes Library photos to JPEG.** No `capture` attribute, a single file, and the byte sniff is trusted over the file name.
- **Metadata is dropped on export.** Gesso strips it deliberately, so the copy is the newest photo, and the Save sheet's success copy says so.
- **Web Share needs transient activation (5s) and rejects concurrent calls.** Encode when the sheet opens. Call `share` with nothing awaited before it in the handler. Share files only. AbortError is a no-op. The button is disabled while a share is pending.
- **`<a download>` is broken in standalone mode.** It is not used. The fallback is a long-press `<img>` with the callout enabled.
- **iOS 26 Add to Home Screen.** The install line says "Share → Add to Home Screen". Keep `icon-180.png` as the apple-touch-icon.
- **Safe area needs `viewport-fit=cover`; `100vh` is buggy in standalone; inset-top regressions in 26.x.** Ship `viewport-fit=cover` and `apple-mobile-web-app-status-bar-style=black-translucent` from the first deploy. Use a `position:fixed; inset:0` root and `max(env(safe-area-inset-top), 24px)`. Keep critical controls at the bottom.
- **No orientation lock.** The landscape side column ships, and the manifest's `orientation` is removed.
- **Page pinch and double-tap zoom.** `touch-action:none` on the stage and `manipulation` on controls. Document-level non-passive `gesturestart` and `gesturechange` with `preventDefault`. All editing gestures come from Pointer Events through `lib/gestures`.
- **Selection, callout and loupe.** `body {user-select:none; -webkit-user-select:none; -webkit-touch-callout:none}`. Non-passive `touchstart` with `preventDefault` on the stage. The callout is re-enabled on the fallback `<img>`.
- **Rubber-banding.** `html, body {height:100%; overflow:hidden; overscroll-behavior:none}`.
- **Focus auto-zoom under 16px.** The caption textarea is 17px, and there are no other text inputs.
- **Pressure is 0 on iPhone.** Brushes have constant size and dabs are placed by distance. `setPointerCapture` and `pointercancel` are handled everywhere.
- **Coalesced events since 18.2.** Paint and Remove strokes read `e.getCoalescedEvents?.()` (only `clientX`, `clientY` and `timeStamp`) and fall back to `[e]`.
- **No haptics** (`vibrate` is absent and the switch trick is closed). Every confirmation is visual: needle flash, snap guides, toasts.
- **IndexedDB Blob bugs; Lockdown disables IndexedDB.** Primary-key gets only, everything in try/catch, and a memory-only fallback with a notice.
- **Quota is large; ITP eviction; `persist()` succeeds in standalone.** Call `persist()` at every launch and record the result. One draft, tile GC. Saving to Photos is the archive.
- **Safari-tab storage is separate from the installed app.** The install line appears only in Safari. Drafts do not migrate, which is accepted.
- **One origin shared with TextLock.** Cache `gesso-v1`, and the activate handler deletes only `gesso-*`. IndexedDB `gesso`, localStorage `gesso:*`. Ship the TextLock `sw.js` patch to filter on `textlock-` as a separate small change.
- **GitHub Pages: no headers, no COOP/COEP.** No SharedArrayBuffer or WASM threads. The service worker fetches with `{cache:'no-cache'}`.
- **Service worker update semantics.** Precache every module, call `registration.update()` when the page becomes visible, and bump `CACHE` on every shell change.
- **Lifecycle freezes and jetsam.** Debounced autosave plus best-effort flushes on hidden and pagehide. Restore on launch.
- **Lockdown Mode: no WebGL2.** Show "Gesso needs WebGL, which Lockdown Mode turns off." There is no crash and no hang.
- **Readback noise in Private Browsing.** Masks are generated from vectors in lib and never read back. Source search uses SSD, which tolerates noise. Bit-exact checks stay in node tests.
- **Device sizes.** 44pt minimum targets. Layout figures are computed for 402×874 and 440×956. The DPR 3 preview is about 1.5–1.9 MP.
- **Research is unverified on a device.** `?probe=1` must pass on a 17 Pro before release; see Risks.

---

## 7. Algorithm notes

### Adjustment math (identical in `FRAG_FINISH` and `tone.shadeRef`)
- `p` is the sRGB-encoded value, `lin` is linear, and `Y(p) = dot(p, LUMA)`.
- **White balance:** with `w = warmth/100` and `t = tint/100`, gains are `g = [1+0.30w, 1−0.25t, 1−0.30w] / dot([...], LUMA)`, applied as `lin *= g`. `wbFromGains` inverts this exactly.
- **Paint light:** `lin *= exp2(1.5·(m.r − m.g))`.
- **Shadows and highlights:** take `L = mix(blurLuma, Y(p), 0.25)`, `ws = 1 − smoothstep(0.0, 0.6, L)` and `wh = smoothstep(0.4, 1.0, L)`. Then:
  - `p = pow(p, exp2(−1.2·S·ws))`, where S = shadows/100;
  - `p = 1 − pow(1 − p, exp2(1.2·H·wh))`, where H = highlights/100.
  - Negative H recovers highlights.
- **Blur map:** downsample base to 512px long edge, take Y, apply a separable Gaussian with σ = 8px, and store in R. It is rebuilt on load and after every Remove change.
- **Brightness:** `p = pow(p, exp2(−0.9·B))`. This is a midtone gamma, so it never clips highlights.
- **Contrast:** with `k = exp2(1.1·C)`, `p = p < .5 ? .5·pow(2p, k) : 1 − .5·pow(2(1−p), k)`. Black and white stay fixed.
- **Vividness:** with `s = max(p) − min(p)`:
  - for V ≥ 0, `p = Y + (p − Y)·(1 + 1.2·V·(1 − s))`, which boosts muted colours most;
  - for V < 0, `p = mix(vec3(Y), p, 1 + V)`.
- **Looks:**
  - `q = LUT(p)` per channel;
  - then saturation (`q = Y + (q − Y)·sat`);
  - then split tone (`q += tS·(1 − Y)² + tH·Y²`);
  - then fade (`q = fade + q·(1 − fade)`);
  - for Mono, `q = vec3(dot(q, mix))` before the LUT;
  - vignette: `q *= 1 − vig·smoothstep(.45, 1.0, r)`, where `r` is the aspect-corrected normalized radius;
  - `out = mix(p, q, strength/100)`.

  | Look | Parameters |
  |---|---|
  | Vivid | sat 1.15, mild S-curve, no vignette |
  | Warm | highlights amber tint .08, sat 1.05 |
  | Cool | shadows teal tint .06, highlights blue .04 |
  | Film | fade .05, highlight roll-off to .95, sat .88, teal shadows .08, amber highlights .10, vignette .25 |
  | Mono | mix (.40, .45, .15), S-curve, vignette .15 |

- **Dither:** `p += (hash(outPx) − .5)/255` before quantization, to avoid banding in skies.

### Auto (`autotone.js`, 512px readback with geometry applied)
- **Brightness:** solve `p50^g = 0.46`, giving `B = −log2(ln .46 / ln p50)/0.9`, clamped to ±60.
- **Contrast:** `(0.80 − (p95 − p5))·150`, clamped to [−30, 40].
- **Shadows:** +min(50, 2000·clipLow) when `clipLow` (fraction with Y < .02) exceeds 1%.
- **Highlights:** −min(60, 3000·clipHigh) when `clipHigh` (fraction with Y > .98) exceeds 0.5%.
- **Colour:** grey-world mean in linear over near-neutral pixels (.15 < Y < .85 and s < .25), converted to `wbFromGains`, damped to 70%, clamped to ±40. Vividness +12 when `meanSat` < .25.
- **Change chips:** deltas of at least 3, sorted by size, at most 5.
- **Pick white:** a 9×9 mean of base in linear at the press point, gains `Ymean/rgb`, then `wbFromGains`.

### Level (`level.js`)
1. Take 512px gray of O. Apply Sobel and keep the top 10% of gradient magnitudes.
2. Each edge's line angle is `atan2(gy, gx) + 90°`. Fold it into ±12° of horizontal, or ±12° of vertical mapped to the same rotation.
3. Build a magnitude-weighted histogram in 0.1° bins and smooth it with σ = 0.3°.
4. Accept the peak, refined by parabolic interpolation, only if it is at least 2.5× the median bin and holds at least 3% of the strong-edge weight. Otherwise return `confidence 0`, giving "No clear horizon".
5. If |angle| < 0.3°, report "Already level".

### Remove (`heal.js` in the worker, compositing on the GPU)
1. **Region:** the mask bbox expanded by a search radius `R = 3·r_mask`, clamped to the image. `R.readRegion` returns it downscaled by `s` so that the mask's long side is at most 128px (region at most about 1024px).
2. **Search (`findSources`):**
   - The ring is the band of width `max(3, 0.25·r)` px around the mask.
   - Score each offset as ring SSD (RGB) + 0.5·ring gradient SSD + 0.002·|offset|².
   - Candidate offsets must place the dilated mask fully in bounds and not overlapping itself.
   - Coarse-to-fine: exhaustive search with stride 2 at the level where the mask is about 16px; keep the top 8; refine ±2px at each finer level.
   - Non-maximum suppression at 0.5·r, so the alternatives differ. Return the top 4.
   - Spot heals cost well under 50ms.
3. **Seam correction (`solveCorrection`):** solve Laplace's equation for `c` inside the mask at scale `s`, with boundary `c = target − source(offset)`. Neighbours outside the image use Neumann conditions. Use SOR (ω = 1.8, at most 120 iterations), initialized from a half-resolution solve. The result is mathematically a Poisson blend of the copied patch, and solving at low resolution works because `c` is smooth.
4. **Compose at full resolution** (`R.composeFill`, `FRAG_FILL`):
   - `out = base(p + offset) + bilinear(c)(p)`;
   - blend into base with the full-resolution stroke mask, feathered 2px;
   - read back the bbox as the tile, with alpha 255 where alpha > 0.
   - Texture detail comes from full-resolution source pixels and only the smooth correction is upsampled, so fills are never soft.
5. **Try another** re-runs step 3 with the next source in the cached list. **Source** runs refinement and step 3 at the ring's dragged offset.

Limits and timing:
- Areas are capped at 20% by bbox.
- Targets on an A19: a spot fill under 300ms; a rub covering 5% of the image under 1.5s.

v1.1 path: PatchMatch on WebGPU for large objects.

### Brush masking at working resolution
- **Stroke capture:** in screen space, using coalesced events, then converted to S px via `screenToContent` and `outputToSource`.
- **Brush size:** the on-screen size is constant (pt), so the S-px radius is `pt × DPR / (view.scale × outputToSource scale)`. Zooming in gives proportionally finer strokes.
- **Paint light:** `stroke.dabs` places dabs every 0.25r by distance, never per event, so speed does not change density. Each dab is a Gaussian quad into the RG8 mask at S/4 with additive blending (amount 0.12 per dab, saturating at RG8 = 1.0, which is ±1.5 EV). Erase uses `blendFunc(ZERO, ONE_MINUS_SRC_ALPHA)`. Undo clears the mask and replays the strokes, which takes a few ms for hundreds of strokes.
- **Remove masks:** never stored as rasters.
  - The worker rasterizes the stroke at search scale (`strokeMask`).
  - The GPU rasterizes it again at full resolution inside `composeFill` (dabs into a temporary R8 FBO the size of the bbox, thresholded at 0.5 with a 2px feather).
  - Masks are therefore always sharp at working resolution and come from vectors, so they are immune to readback noise.

---

## 8. Visual design direction

- **Mood.** A primed canvas in a dark studio. The chrome is warm near-black and quiet, and the photo is always the brightest and most saturated thing on screen. There is one confident accent. The app is dark only (`color-scheme: dark`).
- **Tokens** (`:root`):

  | Token | Value | Use |
  |---|---|---|
  | `--ground` | `#0d0c0b` | stage around the photo; matches the manifest |
  | `--panel` | `#161413` | panel, action row, dock |
  | `--raised` | `#221f1d` | chips |
  | `--raised-2` | `#2c2826` | selected dial |
  | `--line` | `#34302c` | hairlines |
  | `--ink` | `#f3eee6` | gesso white |
  | `--ink-2` | `#a8a097` | secondary |
  | `--ink-3` | `#6b645d` | disabled |
  | `--accent` | `#ff7a2f` | cadmium orange: Save fill, Done text, selected rings, ruler needle, changed-dial dots |
  | `--on-accent` | `#1b0f07` | text on accent |
  | `--danger` | `#ff6b5e` | "Discard edit" and "Delete" text |
  | `--mask` | `rgba(255, 77, 109, .45)` | Remove rub, coral |
  | `--scrim` | `rgba(13, 12, 11, .6)` | crop outside the frame, badges |

- **Accent discipline.** Filled accent appears only on Save, Save to Photos, and Choose a photo. Everything else that is selected gets an accent ring, underline or text, never a fill.
- **Type.** System stack only: `-apple-system, "SF Pro Text", system-ui, sans-serif`. Numbers use `font-variant-numeric: tabular-nums`. Caption styles use `system-ui`, `ui-serif, "New York", Georgia, serif`, `ui-rounded, system-ui` and `ui-monospace, "SF Mono", Menlo, monospace`.
- **Text sizes.**

  | Element | Size |
  |---|---|
  | Tool name | 16/600 |
  | Hint | 13/400 `--ink-2` |
  | Chip labels | 13/600 |
  | Dial name / value | 11/500 / 14/600 tabular |
  | Dock labels | 12/600, +0.01em |
  | Save sheet primary | 17/700 |

- **Iconography.** An inline SVG `<symbol>` sprite in `index.html` (no icon font), on a 24×24 grid with a 1.75 stroke, round caps and joins, and `currentColor`. Every icon is paired with a word.

  | Control | Icon |
  |---|---|
  | Crop | two L-brackets |
  | Light | sun with a half-filled disc |
  | Color | three overlapping circles |
  | Remove | a circle being wiped by a soft brush |
  | Text | "Aa" |
  | Undo / Redo | hooked arrows |
  | Before | split square |
  | Save | arrow into tray |
  | New photo | stacked frames with "+" |
  | Auto | wand |

- **Overlays.**
  - Crop frame: 1.5pt `--ink`, with 3pt L-handles 24pt long. The thirds grid is `--ink` at 35%, shown only while touching.
  - Caption selection: a dashed 1pt box with a 12pt round corner handle (44pt hit area).
  - Value bubble: `--ink` on `rgba(0,0,0,.65)`, 15pt tabular.
  - "Before" and "After" badges: 12/600 on the scrim.
  - Shimmer: a soft diagonal light sweep, 0.8s.
- **Motion.**
  - Panel content cross-fades in 180ms ease-out. The panel height never changes.
  - Auto animates dials and the straighten ruler over 400ms.
  - Toasts rise 8pt and fade.
  - `prefers-reduced-motion` makes everything instant.
- **Accessibility.**
  - Every control is a real `<button>` with its word.
  - Rulers are `role=slider` with `aria-valuetext` (for example "Brightness plus 18") and step with VoiceOver swipe up and down.
  - Toasts go through an `aria-live=polite` region.
  - Text contrast is at least 4.5:1 against `--panel`.

---

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Remove quality.** A single-offset heal smears or repeats on large objects and on structured backgrounds, and users compare it with Photos' Clean Up. | Honest hint copy. The 20% area cap. Try another (top 4 diverse sources). Source for manual cloning. Zoom hint. Undo. PatchMatch on WebGPU is planned for v1.1. |
| **First save is lost in the iOS share sheet.** | Pre-encode when the sheet opens. The coaching line "Next, tap Save Image" until the first success. Success copy says where the photo went. Long-press fallback. Five-person first-timer test before launch. |
| **Jetsam at 24 MP.** | 900 MB ledger, strip import, band export, worker encode, and explicit frees. Automatic step-down to 12 MP, persisted. Autosave makes any crash recoverable. Measure the real peak on a 17 Pro in milestone 1. |
| **`createImageBitmap` resize versus EXIF orientation ordering, and whether P3 is converted on upload.** | Aspect check and retry. The sRGB strip canvas forces conversion. The probe verifies both with an EXIF-6 JPEG and a P3 test image. |
| **Gesture thresholds collide** (hold-Before versus tap-heal versus paint start; second-finger cancel). | Pure, tested arbiter written before any tool. Thresholds are constants in one place. Hint H9. The Before button as the conflict-free path. Tune on a device in milestone 5. |
| **Keyboard and visualViewport in standalone iOS 26.** | The edit bar is pinned from `visualViewport`. If visualViewport is missing, the edit bar docks at the top of the stage. Device test in milestone 3. |
| **Canvas does not resolve `ui-serif` or `ui-rounded`.** | Fallback stacks (Georgia, system-ui). The probe measures glyph widths to confirm that distinct fonts load. |
| **Preview and export differ.** | All spatial terms are normalized or in S px. The blur map is shared. Same shader. Automated GL parity page. Visual diff of an export downscaled against the preview in milestone 2. |
| **2-second density** (11–12 labelled controls plus the suggestion line). | The suggestion is one line and only appears when there is something to say. If first-timers stall, the suggestion line is removed before anything else. |
| **Auto overwrites manual dial values.** | It is a single named undo step ("Undid: Auto-enhance"). Change chips show exactly what moved. |
| **Context loss on return from background.** | Restore handlers, then reload after 3s. IndexedDB holds everything needed. |
| **Stale shell after deploy; TextLock's service worker wipes Gesso's cache.** | Versioned `gesso-` caches, `no-cache` network-first fetches, update on visibility. Ship the TextLock prefix patch together with Gesso's first deploy. |
| **Landscape cramped on the 17 Pro** (381pt column). | Fixed 384pt column. Chip rows drop to 12pt through a container query. Acceptance check 1 runs at 874×402. |
| **Private Browsing or Lockdown** (no IndexedDB or WebGL). | Memory-only mode with a notice. A clear WebGL message. Never a blank screen. |
| **Platform research not verified on a device.** | `?probe=1` runs before release in both Safari and standalone. It checks: MAX_TEXTURE_SIZE, an 8064×6048 canvas, RGBA16F completeness, HEIC and EXIF-6 decode, P3 upload, share with a JPEG, `persist()` and `estimate()`, `ui-*` fonts, and coalesced events. |
| **Schedule.** | The milestone order puts every 1-minute task in milestones 1–3. Cut list, in order: Paint light, Source, rewind tape, Pick white, wipe. |