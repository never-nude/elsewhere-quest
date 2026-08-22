# TextLock

Lock yourself out of texting for a set number of hours.

Built for a specific moment: a prescribed ketamine (or similar medicine)
session, where for a few hours you are not the person who should be sending
texts. You lock before you dose, park any "I just need to say one thing"
messages in the vault, and the line opens again after the afterglow — with a
one-tap **call** button for your sitter, partner, or clinic the whole time,
because when you're under the influence a voice is safer than a keyboard.
It works just as well for any other stretch of hours you'd rather not text
through.

TextLock is a small, self-contained web app that lives in this repo but is
independent of the Elsewhere prototype — no shared code, no dependencies, no
build step, no server. Everything stays in your browser's local storage.

## What it actually does

A web page cannot reach into your phone's messaging app, so TextLock doesn't
pretend to. It's a **commitment device**:

- **Set a lock** for 0.25–72 hours (presets or custom), with an optional
  reason that stays on screen while you're locked.
- **A persistent countdown** — reload, close the tab, come back later: the
  lock is still running, because it's anchored to the end time, not the page.
- **A message vault** — when the itch hits, type the text *here* instead.
  It stays sealed until the lock opens, then you reread it with fresh eyes
  and either copy it out or let it go.
- **A short-term memory gate to break early** — ketamine's signature
  cognitive effect is on working memory, so early unlock tests exactly
  that. Hold a button for five seconds, then pass two memory rounds: six
  digits shown briefly, hidden through a fifteen-second retention delay,
  then recalled — and a second round recalled *in reverse order*. Fail a
  round and the gate closes for ten minutes (it survives reloads). Pass,
  and a sixty-second cool-down still stands between you and the open line.
  Sober-you clears it easily; session-you doesn't — which is the point.
- **An emergency entrance** — one tap and one confirm opens the line
  immediately, no holding and no waiting. It's logged as an emergency in
  your record and doesn't break your streak; only a deliberate break does.
  (Calls are never blocked by anything here — this is a texting lock.)
- **A trusted contact** — set your person once (sitter, partner, clinic
  line) and the emergency card leads with a one-tap call button for them,
  ahead of any text option.
- **A pre-session checklist** — text people *before* you dose, Do Not
  Disturb on, and lock a couple of hours past when you expect to feel
  normal, because judgment returns after the body does.
- **A record** — kept vs. broken locks and your current streak.
- **Add one more hour** while locked, any time.
- Optional notification when the lock opens (only while the page is open).

For hard, OS-level enforcement of the same hours, the app links you to
iPhone Screen Time / Android Digital Wellbeing — set an app limit on
Messages there once, and use TextLock for the timer, the vault, and the
record.

## Run it

Any static file server works. From this directory:

```bash
npm start          # serves on http://127.0.0.1:4173
# or: python3 -m http.server 4173
# or: npx serve .
```

Then open the URL on your phone or desktop. It's a PWA — served over HTTPS
(or localhost) you can "Add to Home Screen" and it works offline.

> Opening `index.html` directly from the filesystem won't work: the app uses
> ES modules, which require an HTTP origin.

## Test it

```bash
npm test           # node --test over the pure lock-state logic
```

The state machine (lock lifecycle, vault, streaks, formatting, storage
revival) lives in `lib/lock.js` with no DOM access, so it runs under plain
`node --test`. `app.js` is the thin DOM layer on top.

## Honesty clauses

- Clearing site data, private windows, or editing local storage defeats it.
  So does setting your phone's clock forward. It's a promise with a timer,
  not a jail.
- The vault and history never leave your device.
- Notifications fire only while the page is open somewhere.
