# Shared project handoff — elsewhere-quest

Setup date: 2026-09-19. This section records repository setup, not a full application audit.

## Repository identity

- Repository: https://github.com/never-nude/elsewhere-quest
- Default branch observed: `main`.
- Scope: this repository only. Related versions are not automatically interchangeable.

## Evidence and current state

README describes a frontend prototype; the remote person and network connection are simulated. Production backend work remains a documented seam, not verified completed work.

README.md was inspected for project context (observed blob `ecb942d2c9c70ad471b583b82012a23580d5e553`). Its existing statements are not new runtime verification.

## Handoff setup

- Task: shared Codex context across this chat and two computer checkouts.
- Owner of this documentation task: ChatGPT Codex session.
- Setup branch: `codex/shared-handoff-20260919`.
- Changes: AGENTS.md session-start/session-finish rules plus this status record; application code unchanged.
- Validation: checked availability of root instructions and status; preserved existing documents/history. No application runtime tests were performed for this documentation-only task.
- Delivery: check the setup pull request in GitHub for merge status. If these changes are on the remote default branch, they are integrated there; this does not establish deployment success or local computer synchronization.

## Unverified local work

Neither computer's checkout, uncommitted changes, unpushed commits, local paths, running tasks, nor separate Codex conversations has been inspected. Do not mark either machine synchronized based on these files alone.

## Next session

1. Read AGENTS.md and existing project instructions.
2. Inspect the local remote/branch and preserve pending work; fetch and safely integrate the shared default branch.
3. Record discovered unfinished work, its branch, actual validation, and next step here. Reconcile it with remote history before implementation.
4. At task completion, update this handoff and publish it through the existing repository workflow when authorized.

## AR flowers page — 2026-09-20

Task / owner / branch: AR flowers for Omaris at `/Omaris/` / Claude Code session / `claude/ar-flower-bouquet-omaris-p6x7vd`.
Completed: procedural three.js garden arrangement in a fluted stoneware vase with the name in gold (`src/bouquet/`, textures in `src/bouquet/textures.ts`), second Vite page (`Omaris/index.html`, `/omaris/` redirect), pre-baked `public/Omaris/omaris.{usdz,glb}` with horizontal-plane anchoring and content scaling disabled, bake/repack/font tooling under `tools/bouquet/`, README section. Revisions: mixed hand-tied bouquet → dozen roses → vase arrangement with textured PBR materials and a tap-to-drop-petals effect, per request.
Validation actually performed: `npm run build` (tsc + vite) passes; page rendered in headless Chromium at phone and desktop sizes with no console errors, including accented and junk `?to=` names; `omaris.usdz` (binary crate repack) opens in Pixar USD 0.26 with all 12 referenced textures present in the package, 64-byte aligned, plane/horizontal anchoring, 0.39 m tall on y=0; `omaris.glb` passes the Khronos glTF validator.
Open issues / blockers: AR launch itself (Safari Quick Look, Android WebXR/Scene Viewer) was not exercised on a real device from this sandbox. The Google Fonts stylesheet is blocked by `public/_headers` CSP if that file is ever honored; the main page has the same dependency. No "Mike-Kushman" GitHub account is connected to this session; the work lives on `never-nude/elsewhere-quest`.
Latest revision (2026-09-20, later): arrangement made mostly pink (roses in three pinks, pink peonies, ranunculus, lisianthus, four pink tulips, pink hypericum); page tint blush. Standalone copy for the custom domain added at `sites/foromaris.gift/` (own package.json, Pages workflow, `public/CNAME`); builds clean. Creating the GitHub repo from this session was refused (403), so it has not been pushed anywhere yet. PR #4 held as draft on purpose ("pause"): the intended home is `foromaris.gift` via Porkbun DNS → GitHub Pages.
Next step: (1) create an empty public repo, push `sites/foromaris.gift/` contents to its `main`, set custom domain `foromaris.gift` in Settings → Pages; (2) at Porkbun replace the parked records with the four GitHub Pages A records (185.199.108–111.153) and `www` CNAME → `<account>.github.io`; (3) open the site on an iPhone (6s+/iOS 15+) and tap "See it in your room"; (4) decide whether to also merge PR #4 for `elsewhere.quest/Omaris/`.
Delivery (local, pushed, merged, deployment verified): pushed to the branch above; PR open; not merged or deployment-verified.

### Desktop session, 2026-09-20 (Claude Code) — steps 1 and 2 of the handoff are done

Completed: created the public repo `never-nude/foromaris-gift` and pushed the contents of `sites/foromaris.gift/` to its `main` as one commit (`a7a6875`); enabled GitHub Pages with `build_type=workflow`; set the custom domain to `foromaris.gift` via `PUT /repos/never-nude/foromaris-gift/pages`. The Pages Actions workflow succeeded on the first push (run 35533840593). A durable local clone now lives at `~/Projects/_active/foromaris-gift` (the earlier work was in a throwaway worktree).

Validation actually performed this session: `npm ci && npm run build` in the standalone site passes (tsc + vite, 745 kB JS / 198 kB gzip); because the domain does not resolve yet, the deployment was checked by hitting the Pages edge with a Host override — `curl --resolve foromaris.gift:80:185.199.108.153` returns 200 for `/`, `/omaris.usdz` (4,600,330 bytes) and `/omaris.glb` (5,189,952 bytes), and the served HTML is the right page. HTTPS on that override fails, as expected, because no certificate exists yet. `src/bouquet/` at the repo root and under `sites/foromaris.gift/` are still byte-identical, and so are the two copies of each baked asset.

Open issues / blockers: DNS is untouched — `foromaris.gift` still answers with Porkbun parking (`207.207.210.229`, `207.207.210.107`) and `www` is a CNAME to `pixie.porkbun.com`. No Porkbun API key is stored on the machine and no browser extension is connected, so the registrar change needs Michael. `https_enforced` is `false` and cannot be turned on until the certificate issues. Real-device AR launch is still unvalidated.

Next step: owner is now a Codex session — see the roundtable `foromaris.gift` (`room_17d5e80247c8`, project path `~/Projects/_active/foromaris-gift`) for the full handoff, four open tasks and the recorded decision. Order: Porkbun DNS → wait for cert → `https_enforced=true` → iPhone AR check → ask Michael about merging PR #4.

Delivery (local, pushed, merged, deployment verified): `foromaris-gift` pushed and deployed to GitHub Pages, reachable only by Host override until DNS moves; PR #4 on this repo still an unmerged draft, held deliberately.

## Future handoff fields

Task / owner / branch:
Completed:
Validation actually performed:
Open issues / blockers:
Next step:
Delivery (local, pushed, merged, deployment verified):

### Bouquet clearance and AR handoff repair — 2026-09-20 (Codex desktop)

Task / owner / branch: prevent flowers and stems crossing the vase, and address the reported iPhone Safari AR view closing / Codex desktop session / `claude/ar-flower-bouquet-omaris-p6x7vd`. The production source is `never-nude/foromaris-gift`; both bouquet copies in this branch were synchronized from that repository. This work used an isolated worktree, preserving the existing main checkout and its untracked work.

Completed: stems now rise through the opening before fanning out; vines route around the exterior. The real-size vase remains 25 cm tall and the arrangement measures about 44 cm. Both static model pairs were replaced from the final production bake. The main page releases its WebGL context before navigating to a separate lightweight AR document; iOS uses a visible, directly tapped `rel="ar"` image link, and default Android uses Scene Viewer. Personalized iOS exports expose the link after preparation and offer retry on failure; personalized Android retains WebXR. The USDZ uses simpler materials with one 1024² color atlas. Added the AR poster/button, bake-time side/back previews, full-triangle clearance validation, and browser flow checks. All three `src/bouquet/` trees and shared static assets are byte-identical.

Root build integration: added `Omaris/ar.html` as an entry and retained entry signatures in the root Vite build. Browser tests exposed a generated-helper import that previously ran the React startup on the flower page, causing React error #299 because that page has no `#root`. Preserving entry signatures separates startup behavior; the final checks confirm the flowers at `/Omaris/` and the existing React application at `/` both render.

Validation actually performed: `npm ci` and `npm run build` succeeded at the root and under `sites/foromaris.gift/`. Root browser-flow suite passed 8 checks, including the existing React entry; standalone suite passed 9 checks, including a prefixed mount for `/Omaris/` URL regression coverage. The tests verify WebGL release, no three.js/WebGL/model prefetch on the default AR document, directly tapped one-image links, query preservation, cache version and scaling lock, native Android intent/fallback, a real personalized USDZ export with deliberately injected URL-allocation failure and successful retry, and unsupported-device fallbacks. The final GLB in both copies passes the clearance validator: 50,484 botanical triangles and 6,288 vase/lip triangles; zero contacts or intersections at 0.2 mm clearance. No additional bake was performed in this worktree. `git diff --check` passed. Root installation reports an existing critical `maplibre-gl` advisory; dependencies/lockfiles were not changed by this task. The standalone dependency audit reports no vulnerabilities.

Production delivery verified by the coordinating Codex session: commit `f0079709be1e80652277e0dc5a15063385d55384`, Pages run `35535783767` succeeded. HTTP checks against the GitHub Pages edge returned 200 for `/` and `/ar.html`, byte-identical to the final build. The served USDZ is 3,114,371 bytes, SHA-256 `585ebad2760874ef661789af282d92f72fdd06675e78b1f67d8c8a01af1a5ec4`; GLB is 5,309,236 bytes, SHA-256 `35560d1e8cb7ca781ff7d845ee648c77a56e185a769c7b3bda2208d6fbdb2dc5`. Both copied pairs match those hashes.

Open issues / blockers: the custom domain still serves a certificate that does not cover it, and the local resolver has a negative DNS cache. HTTPS is not yet verified. Chromium capability emulation proves browser routing and DOM behavior only; it does not establish that native Quick Look stays open or anchors to a surface on an iPhone. Michael's actual iPhone Safari retest is still required. Do not describe AR camera placement as working until that test passes.

Delivery / next step: production changes are pushed and deployed as recorded above. This commit synchronizes both Elsewhere copies on the existing draft PR #4 branch; it does not merge or deploy that branch. The coordinating session reviewed the sync and final validation results. PR #4 remains deliberately unmerged; do not merge without Michael's explicit instruction. Continue the existing certificate monitor without removing/re-adding the domain, then validate HTTPS and obtain the real-iPhone result.

### Prominent AR invitation — 2026-09-20 (Codex desktop)

Task / owner / branch: make the AR experience obvious on first opening the gift / coordinating Codex desktop session with independent visual QA / `claude/ar-flower-bouquet-omaris-p6x7vd`. The landing page now places a bordered invitation directly under Omaris's name: “Put these flowers on your table,” an explanation of the phone-camera view at real size, the AR button, and platform-specific next steps. The bouquet occupies a separate middle grid row, with the personal note below. Short phones can scroll vertically without the instructions, bouquet, and note overlapping. Synced only `index.html`, `src/bouquet/main.ts`, and `src/bouquet/styles.css` from production into both Elsewhere copies; baked models and other assets are unchanged.

Validation actually performed: inspected Chromium screenshots with iOS Quick Look capability emulation at 320×568, 390×664, and 430×860. The button and all AR instructions are visible without scrolling at every size, with no horizontal overflow, overlapping grid rows, or page errors. All three real button clicks preserve the full personalization query. At 320×568, a wheel scroll moved the body by 122 px and exposed the complete personal-note footer. The existing production browser-flow suite passed all 9 checks. After synchronization, `npm run build` passed at the root and in `sites/foromaris.gift/`; no additional tests were written or models rebaked. All three source copies match, and `git diff --check` passes.

Delivery / next step: production commit `ecbd862285c4a46c66afc413f83101605c637e14` was pushed and deployed successfully in Pages run `35536162227`; the served landing HTML matches the build. This commit synchronizes the reviewed changes to the existing PR #4 branch. PR #4 remains draft and unmerged. Prior HTTPS and real-iPhone Quick Look verification limitations still apply; responsive browser screenshots do not validate native camera placement.
