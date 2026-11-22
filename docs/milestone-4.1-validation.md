# Milestone 4.1 validation — 2026-11-05

## Scope and environment

Implemented opt-in browser screen audio, independent remote playback controls, source-scoped publisher grants, lifecycle cleanup and audio capture/playback statuses. No native capture software, audio routing changes, recording, additional persistent infrastructure, cloud changes, or video optimization were introduced.

The existing local LiveKit SFU was used. Candidate backend/frontend processes on loopback ports 18081/5174 isolated initial tests from the running app; both were stopped after updating only the existing Compose backend/frontend. The existing LiveKit container remained running. The updated app is at `http://localhost:5173`, with backend host port 18080 and LiveKit 7880/7881/7882. Backend restart cleared its in-memory invitation store; create a fresh room.

Installed host tools (for subsequent manual tests): Chromium 156.0.8078.47 Arch Linux, Firefox 158.0.1, PipeWire 1.6.10. Automated Playwright engines were Chromium 158.0.8127.18 and Firefox 159.0, **not the installed browser binaries**. No browser policy/security flags were disabled for capture, ICE, or autoplay.

Read-only `wpctl status -n` confirmed PipeWire, WirePlumber, and xdg-desktop-portal-hyprland, with an existing default USB headset output, hardware microphone, HDMI/ALSA outputs, and existing ALSA loopback devices. This was an inventory only: no source was captured, selected, or rerouted. The presence of a native output monitor does not make it available to `getDisplayMedia`.

## Commands and observed results

From `backend/`:

```text
LIVEKIT_INTEGRATION_URL=http://127.0.0.1:7880 go test -race -count=1 ./...
?   github.com/ghptc/whiterun-live/backend/cmd/server [no test files]
ok  github.com/ghptc/whiterun-live/backend/internal/config  1.003s
ok  github.com/ghptc/whiterun-live/backend/internal/httpapi 1.006s
ok  github.com/ghptc/whiterun-live/backend/internal/rooms   1.040s

go vet ./...
# exit 0, no diagnostics
```

Authorization tests check the exact publisher source list `[screen_share, screen_share_audio]`, no viewer publishing, unchanged five-minute initial JWT lifetime, valid room/publisher capabilities, cross-room rejection and input validation. Live-SFU room integration was enabled by the environment variable above.

From `frontend/`:

```text
npm test
Test Files  6 passed (6)
     Tests  56 passed (56)

npm run build
✓ 22 modules transformed.
dist/assets/index-COsirdnT.js  781.55 kB │ gzip: 215.79 kB
✓ built in 138ms
```

Build/typecheck succeeded. Vite retains the nonfatal warning about a chunk larger than 500 kB; no new dependencies were introduced.

Candidate full suites:

```text
E2E_BASE_URL=http://localhost:5174 npm run test:e2e
9 passed (43.7s)

E2E_BASE_URL=http://localhost:5174 E2E_BROWSER=firefox npm run test:e2e
9 passed (47.3s)

E2E_BASE_URL=http://localhost:5174 E2E_REMOTE_BROWSER=firefox npm run test:e2e -- audio.spec.ts
1 passed (6.5s)
```

The final stale-audio-publication guard was added after the candidate full browser suites and covered by the final 56-test unit run/build. The updated Compose app was then tested again directly at port 5173 (results below).

## What the automated media results prove

`e2e/audio.spec.ts` substitutes only the capture boundary with a canvas video track plus a Web Audio oscillator/destination audio track, returned when the explicit audio option is selected. No microphone API is used. SDK encoding/publication/subscription, Opus RTP, ICE/DTLS, SFU transport, browser decoding, audio element attachment, and explicit click-to-play are real. Three independent contexts exercise two simultaneous publishers and a separate listener; the mixed run uses Chromium and Firefox publishers together.

Observed real inbound audio examples:

| Publishers | Listener | Received tracks / codec | Packet/energy sample |
| --- | --- | --- | --- |
| Chromium + Chromium | Chromium | 2 / audio/opus | 23 and 14 packets, both with positive totalAudioEnergy |
| Chromium + Firefox | Chromium | 2 / audio/opus | 30 and 12 packets, both with positive totalAudioEnergy |
| Firefox + Firefox | Firefox | 2 / audio/opus | 21 and 12 packets, both with positive totalAudioEnergy |

The audio E2E checks real playback elements are ready and playing after unmute, separate volume (.24 versus 1), independent mute state, continued packets and one capture call after signaling interruption, both native tracks ended on stop, re-publication, departure cleanup, and removal of audio elements. Generated audio energy/packets prove transport and decoding, **not that a person heard physical speakers or that PipeWire desktop audio was captured**.

Existing room/invitation/video suites also pass in both engines: operator-free guest join, malformed/unauthorized invitation rejection, raw/full URLs, no publisher escalation, presence/departure, two video publishers, native-ended delivery mock, fullscreen, adaptive visibility, and reconnect. Graceful participant departure does not measure server timeout after a crashed browser. Signaling interruption is not a full-network/ICE-restart test.

Unit tests cover opt-in/no implicit capture, no returned audio, permission denial, unexpected audio without opt-in, screen-audio publication, audio failure with video retained, independent audio ending, video ending, stop/unmount cleanup, cancellation during pending audio publication, stale audio publication blocking duplicate capture, temporary SDK unpublication/republication, remote attachment deduplication and departure, independent mute/volume, preference preservation across replacement, missing/delayed audio, and playback rejection with an explicit retry. Autoplay rejection itself is **mocked** in unit tests; browser E2Es validate normal explicit user-gesture playback without disabling autoplay protections.

## Actual desktop audio status and next decision

The user reported real desktop **video** sharing/playback in two Chrome sessions before this milestone. Actual desktop/system audio has **not** been manually validated here. Browser-native tab audio has also not been manually captured here; generated audio tests do not replace either test.

Follow [the manual desktop/tab audio procedure and current browser references](system-audio.md). Record selected source, offered audio checkbox, returned track/status and sound from a separate native application. Current Mozilla compatibility guidance lists Linux Chromium tab audio only and Firefox display audio unsupported; this is guidance, not a measurement of the installed build.

Browser-native support is implemented as far as returned tracks permit. If that manual test cannot capture required desktop application audio, a separate native PipeWire helper milestone is recommended. The [proposal](system-audio.md#native-helper-proposal--decision-required-not-implemented) covers permission handoff, identity binding, native dependencies, packaging, feedback risks and maintenance. No helper implementation or video optimization milestone has been started.

## Updated running application validation

After rebuilding/recreating only the existing backend and frontend:

```text
npm run test:e2e
9 passed (44.0s)

E2E_BROWSER=firefox npm run test:e2e -- audio.spec.ts
1 passed (6.5s)

curl -fsS http://127.0.0.1:18080/readyz
{"livekit":"reachable","status":"ok"}
```

The final Firefox check was rerun after an agent/server interruption left its earlier process result unavailable. Both app services were healthy after recovery; LiveKit remained running. The rerun received two Opus streams with positive audio energy (20 and 12 packets at the logged sample). Temporary validation ports 5174 and 18081 were confirmed closed. `git diff --check` passed.
