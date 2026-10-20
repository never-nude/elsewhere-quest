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

## Future handoff fields

Task / owner / branch:
Completed:
Validation actually performed:
Open issues / blockers:
Next step:
Delivery (local, pushed, merged, deployment verified):

## 2026-09-29 — Corpora privacy policy page

- Task: host a public privacy policy URL for the Corpora iPhone app (bundle `com.atrium.scanner`, separate project) so external TestFlight testing can be enabled.
- Owner: Claude Code cloud session. Branch: `claude/corpora-privacy-policy`.
- Change: static page `public/corpora/privacy/index.html`, served at `https://elsewhere.quest/corpora/privacy/` once merged to `main` and the Pages deploy runs. No app code changed.
- Validation: `npm run build` succeeds locally and `dist/corpora/privacy/index.html` is emitted. Live URL not yet verified (not merged).
- Next: merge, confirm the URL loads, paste it into App Store Connect → App Information → Privacy Policy URL.

## 2026-10-20 — Gesso: simple Photoshop-style photo editor PWA (in progress)

- Task: build Gesso, an on-device photo editor for iPhone, at `apps/gesso/` → `https://elsewhere.quest/gesso/` (same pattern as TextLock: vanilla ES modules, no build step, pure logic in `lib/` under `node --test`).
- Owner: Claude Code cloud session. Branch: `claude/gesso-photo-editor`. Draft PR #6.
- Design: `apps/gesso/SPEC.md` (iOS Safari research + three UX concepts + two judges, held to the owner's bar: know where everything is in 2 s, finish a real task in 1 min, proficient by minute 10). Build notes at its top record deliberate deviations.
- Done so far: static shell (5 labelled tools + 4 actions paint before JS), WebGL2 renderer, editor core (history, live preview, tool sessions, Before/wipe, zoom), Home/Light/Color/Crop tools, the full `lib/` layer (develop pipeline, geometry, gestures, ruler, hints, level, autofix, heal, PatchMatch inpaint, text layout, image I/O, history, patches). TextLock's service worker now only deletes `textlock-*` caches (it used to wipe other apps' caches on the shared origin).
- In progress: Remove, Text, Save/export, persistence (IndexedDB autosave/restore), hints/rewind tape/zoom navigator/probe, and a Playwright acceptance harness (`apps/gesso/e2e/`, excluded from deploy).
- Validation so far: `cd apps/gesso && npm test` — 413 node tests pass; manual Playwright runs on an emulated iPhone 17 Pro Max (Chromium/SwiftShader — not WebKit) import a 12 MP photo and exercise Light/Color/Crop/Undo without errors. Not yet tested on a real iPhone or in WebKit.
- Next: integrate wave-2 features, run the acceptance harness, adversarial review, then mark PR #6 ready. Device check with `?probe=1` on a real iPhone before relying on it.
- Delivery: pushed to the branch only; not merged, not deployed.
