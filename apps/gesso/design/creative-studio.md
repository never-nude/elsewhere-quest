# Gesso — a creative studio for photographs

Owner direction, 2026-10-23. The owner tried the iPhone app and found its creative
capabilities disappointing beside Photos. The reference is the freedom of classic
Photoshop: magnetic selection, layers, masks, painting and scene construction,
combined with useful modern assistance. The concrete task is putting Ricky into
a dinosaur scene and continuing to make artwork from that composition.

This direction supersedes the old v1 prohibitions on layers, masks, reusable
selections, painting and background replacement, and its fixed five-tool dock.
The existing correction editor remains available. The app identity and permanent
storage origin remain `quest.elsewhere.gesso` and `gesso://localhost`.

## Research: what deserves depth

Research performed 2026-10-23. This is a qualitative review of public discussions,
checked against Adobe's documented workflows. Search terms included “most used
tools”, “tools you use the most”, “most important skills”, “essential tools”,
“underrated tool”, and “which filters do you use regularly”. Sources were chosen
for direct descriptions of personal practice, with both older foundational
discussions and recent mobile/filter discussions. Search-selected forum replies
are not a representative sample. Votes and a user's claims about their own work
are not population usage percentages. No universal Photoshop tool ranking is
established here.

The strongest recurring pattern is the relationship between **selections, masks,
layers, adjustments and brushes**. Retouching tools recur alongside it. Users
describe very different working sets for illustration, photography and design;
Gesso should prioritize creative photo compositing. The table records discussion
themes rather than an invented count of all comments or users.

| Discussion reviewed | Relevant recurring recommendations / experience |
|---|---|
| [r/photoshop: tools used the most](https://www.reddit.com/r/photoshop/comments/okuoz4/) | Masks and adjustment layers; Curves and Hue/Saturation; Pen for compositing; brushes; healing/clone; blur and noise matching. Explicitly says working sets vary by task. |
| [r/photoshop: most important skills](https://www.reddit.com/r/photoshop/comments/bpps5z/most_important_skills_to_learn/) | Layers, masks, selections, Curves, blending, healing and clone; disagreement about how early to learn Pen. Several personal estimates of work covered by these tools, which must not be generalized. |
| [r/AskPhotography: useful Photoshop skills](https://www.reddit.com/r/AskPhotography/comments/vwgz4j/) | Clone, masks, selections, local dodge/burn, adjustments and nondestructive work. A beginner asks for explanations of why masking works. |
| [r/graphic_design: five things to focus on](https://www.reddit.com/r/graphic_design/comments/10wfz2w/professional_designers_what_would_you_suggest_as/) | Selections, soft masks, light/color/perspective understanding, content-aware/healing, layer organization and reusable objects. |
| [r/photoshop: improve Photoshop skills](https://www.reddit.com/r/photoshop/comments/k4yoo1/i_want_to_improve_my_photoshop_skills/) | Mask painting, Quick Select, Curves, blending and choosing a real project. |
| [r/photoshop: essential shortcuts](https://www.reddit.com/r/photoshop/comments/1hagsxq/what_do_you_think_are_the_top_10_most_important/) | Move, Transform, Brush/brush size, selection/inversion, duplicate layer, Type and Remove appear in users' working lists. Supports short interaction paths rather than a phone keyboard requirement. |
| [r/photoshop: underrated tools](https://www.reddit.com/r/photoshop/comments/1ra0ivs/underrated_tool_in_ps/) | Polygonal lasso, masks, feathering and brush repair for animal cutouts; Pen versus lasso depends on edge geometry. |
| [r/photoshop: regular filter use](https://www.reddit.com/r/photoshop/comments/1v9wujy/lets_talk_filters/) | Blur, grain/noise, Camera Raw, Liquify and keeping effects revisable. This is a filter-specific discussion and cannot rank all tools. |
| [Adobe developer forum: favorite filters](https://forums.creativeclouddeveloper.com/t/what-are-the-pixel-filters-in-uxp-dom-that-you-are-missing-the-most/4985) | Gaussian/motion blur, noise, sharpening and Camera Raw. A small developer sample concerned with API access. |
| [r/photoshop: Android mobile launch discussion](https://www.reddit.com/r/photoshop/comments/1l2dxch/photoshop_on_android_beta_is_here/) | Layered editing, mask brushing, selection, generation and mobile feature limitations. The opening post is Adobe promotion; separate it from user replies. |

Adobe's [four basic concepts](https://pages.adobe.com/photoshop/en/basic-concepts/)
are layers, retouching, selections and adjustments. Its
[photo editing curriculum](https://www.adobe.com/learn/photoshop/paths/photo-editing)
also emphasizes masks, light/color, crop and resizing. The
[certification objectives](https://certifiedprofessional.adobe.com/photoshop)
cover image transforms, painting, type, nondestructive adjustments and masking.
These support importance, not measured tool frequency.

Modern assistance belongs in the product direction. Adobe reported in
[October 2023](https://blog.adobe.com/en/publish/2023/10/10/next-gen-of-creativity-powered-by-ai)
that Generative Fill and Expand were already among Photoshop's most used
features. An [AWS case study quoting Adobe's VP](https://aws.amazon.com/solutions/case-studies/adobe-case-study/)
calls Generative Fill the most used feature, without publishing the underlying
measurement or a full ranking. Treat that as a dated vendor claim, not an
independently measured 2026 league table. Generation must complement direct
editing and remain optional.

## PsBattles: study what people make

The research also visually inspected seven results from public PsBattles threads.
These illustrate creative operations; they do not establish frequency or prove
which Photoshop command was used. Where a creator supplied a recipe or process,
that stronger evidence is identified below.

| Result | Creative operation | Evidence and consequence for Gesso |
|---|---|---|
| Bird, “Not forgotten” | Remove a bird while preserving its shadow; one omission changes the story | [Thread](https://www.reddit.com/r/photoshopbattles/comments/t11ovv/), [result](https://i.imgur.com/26BExz5.jpeg). Independent shadow/foreground control. Discussion also describes opacity failing to match blacks: tone control matters. |
| Baby, “Prince Kong” | Change scale, place the baby on a building, overlap architecture and add planes | [Thread](https://www.reddit.com/r/photoshopbattles/comments/q8o4vd/), [result](https://imgur.com/a/t97SvYb). Visible scale and occlusion are inferred techniques; exact tools are unconfirmed. |
| Baby, tracksuit remix | Assemble clothing/shoes from several sources while preserving other parts | [Thread](https://www.reddit.com/r/photoshopbattles/comments/q8o4vd/), [result](https://i.imgur.com/HrsCmb7.jpg), [creator's marked sources](https://imgur.com/a/5i4YBHF). Selections must work on sleeves, hands and shadows, as well as whole subjects. |
| Cardboard Gundam | Paint worn cardboard armor around existing robot parts | [Thread/process](https://www.reddit.com/r/photoshopbattles/comments/hy5cno/), [result](https://i.imgur.com/mCtnRZN.jpg). Creator reports Procreate painting and supplies a timelapse; creative photo editing includes painting, texture and perspective. |
| Detergent bottle as Easter Island stone figure | Recognize a face in packaging and change its material/context | [Thread](https://www.reddit.com/r/photoshopbattles/comments/uy0gwx/), [result](https://i.redd.it/10jfzr1udt191.jpg). Creator explicitly mentions contrast correction; other tool choices are visual inference. |
| Nicolas Cage, “Fire!!” | Combine flames, clothing masks and reflected orange glow on a phone | [Creator process](https://www.reddit.com/r/photoshopbattles/comments/hjwibn/), [result](https://i.imgur.com/WrJR59v.jpg). Explicit RGB Curves, smudge, Screen/Lighten blends and masks; creator identifies missing layers in Toolwiz as a fine-tuning obstacle. |
| Type becomes vinyl grooves | Warp text, duplicate/blur it, add texture/shine, lift the record needle to foreground | [Creator recipe](https://www.reddit.com/r/photoshopbattles/comments/hjwibn/), [result](https://i.imgur.com/Umdnzrx.gif). Tools become materials for experimentation. This is a later depth target, not a first-build checkbox. |

The relevant loop is **notice a possibility → extract a useful part → create the
spatial idea → integrate it → try a variation**. Background replacement is one
case. Removing a subject but keeping its shadow, borrowing a sleeve, and painting
reflected light require more expressive control. Prioritize reusable selections,
selection-to-new-layer, flip/perspective, foreground masks, local tone/color and
painted/contact shadows after the basic compositor. These examples support AI
as an ingredient inside an authored composition; a generated whole-image result
does not cover the same creative choices.

## Nine capabilities to make excellent

Order below is Gesso's product priority for photo artwork, inferred from the
research and the owner's example. It is not a descending usage-frequency list.
The first six carry most of the creative workflow; the last three round it out.

| Capability | Useful Photoshop depth | Gesso's phone advantage to build and measure |
|---|---|---|
| **1. Select** | Subject/object seeds, magnetic/freehand/polygon selection, add/subtract, invert, precise paths | Trace in segments. Lifting a thumb pauses; retouching resumes the same outline. Two fingers navigate between segments. Explicit Close outline; review before applying. Magnifier and adjustable anchors make precision recoverable. |
| **2. Mask and refine** | Grayscale alpha, interior holes, soft edges, reveal/hide brush, feather/choke and fringe correction | Repair the cutout directly against its destination. Clearly labelled Reveal/Hide and image/mask target. Inspect against black, white or checkerboard. Never discard original pixels. |
| **3. Layers and transform** | Independent objects, order, duplicate, visibility, opacity, blending; scale/rotate/flip, perspective | Place behind/in front as direct actions. Manipulate objects on canvas; show selected object and target. Preserve source resolution and transform values. Keep a compact layer tray. |
| **4. Light and color** | Per-layer and masked adjustments, Curves, Hue/Saturation, color balance and gradient maps | Start with intelligible controls; reveal Curves and targeted color when needed. Adjust Ricky independently of the dinosaurs. Scene matching proposes editable parameters. |
| **5. Brush** | Paint, mask paint, dodge/burn, gradients, sampled color | One consistent brush for the chosen task, immediate size/softness/strength, offset precision view. Every stroke undoable. A small expressive brush set before a brush marketplace. |
| **6. Retouch** | Heal, Clone, content-aware removal and deliberate source selection | Tap for small fixes, brush for regions, visible source and preview for structured repairs. Preserve a separate patch/effect so later scene changes remain possible. |
| **7. Crop and canvas** | Reframe the artwork, canvas extension, alignment/perspective | Distinguish cropping the composition from masking a layer. Fit/Fill, useful aspect ratios, recoverable crop; retain off-canvas source. |
| **8. Text** | Editable type layers, readable styles, alignment and blending | Type directly in the artwork, move it as a layer, retain text content. Controls should suit posters and photo art without desktop typography panels. |
| **9. Generate and integrate** | Generative fill/expand, reference-guided assets and harmonization | Generate a background or selected region while preserving Ricky's identity and original pixels. Store alternatives independently; expose strength, shadow, color and grain. Explicit cloud use and cost before sending a photo. |

Blur, grain and contact shadows support integration across these tools. Foreground
occlusion matters: Ricky must be able to stand behind a branch and in front of
another object. A pasted silhouette with a uniform drop shadow is only a start.

## Current competitive baseline

Photos already supports subject lifting/stickers and simple combinations through
Markup ([Apple guide](https://support.apple.com/en-ie/guide/iphone/iphfe4809658/ios)).
On supported devices the September 2026 iOS 27 release adds upgraded Clean Up,
Extend and Spatial Reframing ([Apple announcement](https://www.apple.com/ie/newsroom/2026/09/next-generation-of-apple-intelligence-available-today/)).
The owner's current phone was last checked on iOS 26.6.2; newest Photos capability
and installed software are different comparisons.

Photoshop on iPhone already has layers, masks, selection tools, adjustments,
transforms, clone/retouch and generative editing
([Adobe mobile comparison](https://helpx.adobe.com/photoshop/mobile/get-set-up/learn-the-basics/compare-photoshop-iphone-and-android-features.html)).
It also has [Harmonize](https://helpx.adobe.com/photoshop/mobile/edit-images/retouch-images/blend-subjects-with-harmonize.html).
Gesso cannot claim mobile compositing or automatic scene matching is unique.
Adobe documents Magnetic Lasso on desktop; absence from the checked iPhone
documentation is not proof no comparable mobile feature exists.

The opportunity is fewer interruptions while selecting, arranging and integrating
objects, plus understandable correction when assistance fails. “Stronger” must
mean better results and less friction on these tasks, verified against the same
images in Photoshop iPhone. Universal Photoshop superiority is not an achieved
or useful acceptance claim.

## Engagement through control

- The artwork occupies the screen. Persistent actions stay small; temporary
  contextual controls replace the fixed 204-point adjustment panel.
- A clear loop: choose a piece, separate it, move it, make it belong, experiment.
  Immediate visual feedback and precise corrections reward increasing skill.
- One finger performs the active tool. Two fingers always navigate the canvas.
  Transform handles/controls avoid giving pinch two conflicting meanings.
- Selected layer and image-versus-mask target remain visible. Essential actions
  have tappable controls; gestures and long presses may accelerate them.
- Pause work without penalty. Persistent projects keep layers and masks;
  Undo/Redo works at the level of a gesture or stroke. Try alternatives without
  losing an earlier composition.
- Assistance is inspectable and correctable. A subject seed enters the same
  mask workflow as manual selection. A quick result must lead naturally to
  refinement instead of a dead end.
- No engagement mechanics unrelated to making artwork: streaks, rewards,
  compulsory feeds, or tutorial interruptions do not belong in this workflow.

## First implementation and honest limits

The first Studio slice is a new `/gesso/studio/` experience alongside the old
correction editor. Native normal launch opens Studio under the same origin;
legacy drafts remain intact in their existing storage. This is a foundation for
the nine capabilities, not a claim that all nine have been implemented.

First gate: import Ricky, make a repairable mask with magnetic selection or a
native matte seed, add the dinosaur photo behind, position/scale/rotate both,
correct a missed edge and an interior hole, adjust a layer, undo a stroke,
reopen with every layer and mask intact, and export the composed image.
Thumb lift must pause the outline; it must never close/apply it implicitly.

The initial renderer uses a maximum 2048-pixel working long edge and eight image
layers. Export uses those working dimensions, visibly disclosed in the UI.
Original imported files are retained. Repeated transformations use the source
proxy rather than resampling a previously transformed image. Saved masks are
immutable alpha assets; history refers to assets rather than copying pixels into
every state. Multiple projects live in a separate `gesso-studio` database.

Native subject lift now uses a grayscale matte path: the legacy exterior
polygon drops holes and fractional coverage. Preserving those values enables
mask repair but does not by itself solve color contamination or recover missing
hair detail. Measure cutout quality on difficult real images.

After the complete first workflow: improve edge refinement, reusable selections
and lasso anchors; add Curves/HSL, local effects, paint/type layers, contact
shadows and useful blending; then optional generation/reference workflows.
Tiled rendering/export with bounded caches is a separate requirement for
full-resolution multi-layer work. Raising current pixel limits is insufficient.

## Acceptance and next measurement

1. A new user can identify what is selected, choose image or mask, and find Undo
   and export without a tutorial. Labels remain legible in safe areas.
2. The owner can build the Ricky scene, pause/resume tracing, zoom while paused,
   repair edges/holes, reorder layers and restore the untouched original.
3. Transform, opacity, mask and adjustment operations remain independently
   editable after autosave and reopening. Failed storage must be visible.
4. PNG retains alpha; JPEG has an explicit white ground. Export matches the
   canvas. Photos save is only reported after actual Photos success.
5. Measure task completion, correction count, mistaken edit targets, lost work,
   edge quality at high zoom, frame time and peak memory on the paired iPhone.
   A five-minute first composite is a design target, not a measured result.
6. Repeat the same photo tasks in current Photoshop iPhone. Claim an improvement
   only on dimensions actually compared.

Defer prepress/CMYK/spot colors, 3D/video/timeline, desktop plugins, scientific
tools, batch automation infrastructure and exhaustive filter/brush catalogs.
Detailed vector Pen editing, advanced warp, groups and PSD interchange should
follow demonstrated need; strong Pen recommendations in the forums justify a
precision-path direction, not a large desktop paths panel in the first slice.
