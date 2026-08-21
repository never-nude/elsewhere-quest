# Elsewhere

A safety-first, audio-only prototype for having one real conversation with someone elsewhere in the world—and, only when both people choose it, keeping the line open as voice pen pals.

**Home:** [elsewhere.quest](https://elsewhere.quest)  
**Longwave:** the in-product name for Elsewhere’s globe receiver and audio-signal ritual.

The visual direction combines late-1990s/early-2000s internet optimism, shortwave-radio ritual, and an interactive MapLibre globe inspired by the Worldbook globe. The globe is a direction picker, not a catalog of people.

## Run it

```bash
npm install
npm run dev
```

Build verification:

```bash
npm run build
```

## Prototype flow

1. Read the human-conversation promise.
2. Spin the globe and choose a country with an open porch light—or choose “Surprise me.”
3. Transmit a short conversation intention.
4. Mutually accept one language-and-mood-compatible match; the receiver stays quiet rather than substituting an incompatible person.
5. Test the local microphone (never the camera).
6. Enter a timed, audio-only conversation room.
7. Check in privately afterward and optionally request a double-opt-in voice pen pal.

The local microphone meter is real. The remote person and network connection are simulated in this frontend prototype; audio never leaves the device.

Blocking or reporting removes that demo signal from the receiver for the rest of the browser session. Production moderation and cross-session block persistence still require a backend.

## Production seams

A real release still needs authenticated accounts, age/identity checks, WebSocket signaling, WebRTC with TURN, a matching service, abuse-rate limits, moderation/report review, and carefully written privacy and retention policies. Video is intentionally out of scope.
