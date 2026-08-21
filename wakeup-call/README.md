# Wake-Up Call

A tiny, zero-dependency Node app that actually rings your phone at wake-up
time. It places a real voice call through the
[Twilio Voice API](https://www.twilio.com/docs/voice), speaks a message when
you answer, and retries a few minutes later if you sleep through the ring.

## What you need

1. A [Twilio account](https://www.twilio.com/try-twilio). The free trial works,
   with two caveats: you must **verify the destination number** in the Twilio
   Console (Phone Numbers → Verified Caller IDs) before Twilio will call it,
   and trial calls start with a short "trial account" notice.
2. A voice-capable Twilio phone number (the trial includes one).
3. Node 18 or newer.

## Setup

```bash
cd wakeup-call
cp .env.example .env
# edit .env: Twilio credentials, your Twilio number, the number to wake up,
# the time, timezone, and days
```

The `.env` file is gitignored on purpose — it holds your auth token and your
personal phone number, and neither belongs in the repository.

## Use it

```bash
npm run call:now   # test call immediately (with retries if unanswered)
npm run next       # print when the next scheduled wake-up would fire
npm start          # run the scheduler; rings you every configured morning
```

The scheduler is a long-running process, so it needs to be alive at wake-up
time: keep it running on any always-on machine (a Raspberry Pi, a cheap VPS,
a home server) under something like `systemd`, `pm2`, or `tmux`. If the
machine is asleep at the alarm time, no call is placed — the app skips to the
next scheduled morning rather than firing late.

## Settings (all via `.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `TWILIO_ACCOUNT_SID` | — | From the Twilio Console dashboard |
| `TWILIO_AUTH_TOKEN` | — | From the Twilio Console dashboard |
| `TWILIO_FROM_NUMBER` | — | Your Twilio number, E.164 (`+1…`) |
| `WAKEUP_TO_NUMBER` | — | The phone to ring, E.164 (`+1…`) |
| `WAKEUP_TIME` | `07:00` | 24-hour local wall-clock time |
| `WAKEUP_TIMEZONE` | `America/New_York` | IANA timezone for `WAKEUP_TIME` |
| `WAKEUP_DAYS` | `mon,tue,wed,thu,fri` | Days to call, or `all` |
| `WAKEUP_MESSAGE` | a friendly greeting | What the call says |
| `WAKEUP_SAY_LOOP` | `2` | Times the message repeats per call |
| `WAKEUP_RETRIES` | `2` | Extra attempts if busy/unanswered/failed |
| `WAKEUP_RETRY_DELAY_MINUTES` | `3` | Wait between attempts |

## How it works

- `src/schedule.js` computes the next wake-up instant in your timezone
  (DST-aware via `Intl`, no date libraries).
- `src/twilio.js` places the call with inline TwiML (`<Say>`), then polls the
  call status to learn whether you answered.
- `src/index.js` sleeps until the alarm, rings, retries on `busy`,
  `no-answer`, or `failed`, and then waits for the next scheduled day.

Calls cost Twilio's standard outbound voice rate (about a cent per minute to
US numbers; the trial credit covers months of wake-ups).
