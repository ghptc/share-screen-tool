# Milestone 3 validation

Executed on 2026-11-05 against this repository's local stack. This record explicitly separates mocked capture, real browser media transport, and unvalidated desktop/Wayland behavior.

## Implemented scope

Explicit start/stop screen-video capture, multiple simultaneous publishers, separate viewer/publisher invitation capabilities, source-restricted five-minute JWTs, a responsive stream grid, owner/state labels, fullscreen, native track-ended handling, and cleanup on stop/leave/disconnect/reconnect. No system audio, microphone capture, native capture agent, recording, Discord integration, or AWS change was added. Compose, SFU config/ports, API health checks, and dependency manifests remain unchanged from Milestone 2.

## Backend

From `backend`:

```sh
LIVEKIT_INTEGRATION_URL=http://127.0.0.1:7880 go test -race -count=1 ./...
go vet ./...
```

Race tests and vet passed. The final uncached race/integration output was:

```text
?    github.com/ghptc/whiterun-live/backend/cmd/server [no test files]
ok   github.com/ghptc/whiterun-live/backend/internal/config 1.003s
ok   github.com/ghptc/whiterun-live/backend/internal/httpapi 1.006s
ok   github.com/ghptc/whiterun-live/backend/internal/rooms 1.038s
```
 The real-SFU integration test creates/lists/deletes only its own randomly named room. All prior room, configuration, health, authorization, expiry, limits, and concurrency tests remain in the suite. New token tests verify:

- Viewer invitations continue to return `canPublish:false` without allowed sources.
- A wrong publisher key, a key from another room, or the viewer invitation used as a publisher key is rejected with 403.
- Client-provided `canPublish:true` is rejected with 400 as unknown input.
- Valid publisher grants permit exactly `screen_share`, retain a five-minute TTL and room scope, and do not allow camera, microphone, screen audio, data, metadata updates, or room administration.
- Join responses do not disclose the publisher capability.

## Component tests and builds

From `frontend`, `npm test` and `npm run build` exited 0. They also passed inside the final Node 24 frontend container:

```text
src/App.test.tsx           3 tests passed
src/Rooms.test.tsx         8 tests passed
src/ScreenSharing.test.tsx 14 tests passed
Test Files 3 passed (3)
Tests      25 passed (25)
```

The build includes strict TypeScript checking:

```text
vite v8.3.6 building client environment for production...
✓ 19 modules transformed.
dist/index.html                   0.44 kB
dist/assets/index-N5keemUl.css    2.30 kB
dist/assets/index-BiHjiDN4.js   768.83 kB (gzip 211.63 kB)
✓ built in 174ms
```

Vite continues to report a nonfatal bundle-size warning. No warning was hidden. The SDK/application split remains future frontend optimization work.

Component tests mock native capture and the SDK to cover click-only capture, ideal settings/audio exclusion, start/stop, permission rejection and retry, viewer restrictions, multiple independent publications, duplicate events/clicks, native-ended tracks, subscription/mute/unpublish/departure, detach/reattach on track replacement, fullscreen, signaling reconnect state, full SDK temporary-unpublish/republish semantics, cancellation, and late capture/publication after leaving. SDK initialization and publication failures both stop capture. Full reconnect preserving live capture is a regression test based on the installed SDK's republish path, not a real full-network failure measurement.

## Real Chromium / real SFU with generated input

With the final stack running:

```sh
cd frontend
npm run test:e2e
```

Five sandboxed Chromium tests exercise the app, including all three preserved Milestone 2 tests. The two added tests are:

1. Generated video through real SFU: two publishers, reconnect, fullscreen, stop, and departure.
2. Mocked capture permission rejection in a real browser leaves no stream.

The media test replaces **only** `getDisplayMedia` with an animated `canvas.captureStream(15)` source at 640×360. Browser video tracks, VP8 encoding, PeerConnections, SFU routing, LiveKit publication/subscription, actual DOM video attachment/decoding, and fullscreen are real. SDK/transport are not mocked. No browser desktop picker is approved, and no user screen is captured by this test.

The test verifies no capture on join, then both browsers simultaneously display and decode both generated streams. It checks increasing decoded-frame counts after Bob's real signaling socket is interrupted and resumed, without another capture request. It then simulates a browser-native `ended` event on a stopped generated track, republishes with a fresh click, leaves while publishing, rejoins as a viewer, verifies no sharing button, stops the last publisher, and confirms every local generated track has ended.

The final Chromium run against the rebuilt application passed:

```text
✓ generated video through real SFU: two publishers, reconnect, fullscreen, stop, and departure (9.1s)
✓ mocked capture permission rejection in a real browser leaves no stream (459ms)
✓ two independent sessions: authorized joins, presence, departure, and rejoin (12.5s)
✓ an invalid invitation is rejected in the browser (188ms)
✓ real signaling interruption reconnects automatically (4.1s)
5 passed (26.6s)
```

Final generated-media evidence was capture settings 640×360/15 FPS, decoded local video 640×360 with 88 frames, and decoded remote video 640×360 with 55 frames. An earlier successful run reported:

```text
Generated capture settings: width 640, height 360, frameRate 15
Decoded local video:  width 640, height 360, frames 76
Decoded remote video: width 640, height 360, frames 55
5 passed (26.9s)
```

A later full-suite run timed out checking the first remote video's decoded frames. The assertion had not established that the grid was visible, a necessary precondition with adaptive stream subscription. It now brings the receiving page forward and scrolls the grid into view before checking decoded playback. No adaptive setting, publication logic, timeout, or transport response was weakened. The targeted rerun passed both media tests in 9.9 seconds and reported 89 local/55 remote decoded frames at 640×360.

Those frame counts are snapshots proving playback/progression, not an FPS calculation. The generated input's 15 FPS setting is not measured desktop capture or transmitted frame rate. No 1440p60 claim is made. The permission-rejection test injects `NotAllowedError`; the browser's actual permission UI remains a manual check.

## Firefox investigation (did not pass)

Installed Playwright Firefox 159 and ran:

```sh
E2E_BROWSER=firefox npx playwright test e2e/media.spec.ts
```

Both tests failed at the initial `Participants (1)` assertion after 15 seconds, before capture. The page remained `connecting`. SFU logs confirmed Firefox signaling but no successful ICE pair; the SFU advertises `127.0.0.1` and Firefox did not establish that path. Mozilla's [loopback ICE restriction report](https://bugzilla.mozilla.org/show_bug.cgi?id=1973521) supports loopback policy as the likely explanation. This is a connectivity inference, not a finding that Firefox desktop capture is broken.

No privacy preferences, capture-consent settings, sandbox settings, host routing, TURN configuration, or SFU port exposure were changed to force success. The preserved loopback-only infrastructure remains suitable for the tested Chromium path. Firefox is an explicitly unresolved compatibility limitation for this local setup. Its default-profile failures are not counted as passing media tests.

## Host and service checks

The session reports Wayland. Installed host binaries: Chromium 156.0.8078.47 and Firefox 158.0.1. Automated Chromium uses Playwright's Chrome for Testing 158.0.8127.18, with the browser sandbox enabled. Playwright reports Arch as unsupported and uses its Ubuntu fallback builds.

Actual package checks:

```text
pipewire 1:1.6.10-1
wireplumber 0.5.18-1
xdg-desktop-portal 1.22.1-2
xdg-desktop-portal-hyprland 1.4.1-2
```

`systemctl --user is-active` reported `active` for all four services. No service was reconfigured or restarted. These are environment checks, not proof of working portal capture.

Final Compose builds/startup and direct/proxied HTTP probes passed. Backend and frontend healthchecks are healthy; the same LiveKit 1.13.11 container remains running. Compose configuration and Git whitespace checks passed. Credentials and browser test artifacts remain ignored. Changes were staged for review without a commit or push. Existing loopback ports remain backend 18080, frontend 5173, SFU HTTP/TCP 7880/7881, UDP 7882.

```text
GET :18080/healthz  {"status":"ok"}
GET :18080/readyz   {"livekit":"reachable","status":"ok"}
GET :5173/api/readyz {"livekit":"reachable","status":"ok"}
```

## Remaining validation

Interactive Wayland desktop/window/tab selection and real browser Stop sharing controls require the [manual checklist](screen-sharing.md). Firefox default loopback ICE, full network/ICE restart, prolonged outages, hardware acceleration/NVENC, audio, 1440p60, detailed bitrate/loss/RTT, and glass-to-glass latency remain unvalidated. Requested capture settings and encoding limits must not be presented as achieved performance. Milestone 4 has not started.
