# Milestone 3 stabilization — 2026-11-05 (local time)

## Result and boundary

Firefox ICE connectivity was corrected on this Linux Docker host, and runtime video diagnostics are now available per tile. Two simultaneous publishers, cross-browser generated-media transport, signaling recovery, fullscreen playback, and visible/offscreen subscription transitions were exercised in real browsers against the actual SFU.

**Actual desktop capture remains NOT RUN.** No automated test approved the browser/Wayland source picker or captured a user's monitor. The [manual procedure and result worksheet](desktop-validation.md) cover Chrome → Chrome and Chrome ↔ Firefox with real `getDisplayMedia`, native Stop sharing controls, and a signaling-only interruption. Those checks still need a person to approve capture and observe actual desktop content. Nothing here establishes 1440p60, NVENC/hardware encoding, or glass-to-glass latency.

## Firefox connectivity correction without weaker transport policy

The old configuration forced `rtc.node_ip: 127.0.0.1`. Firefox's default profile reached LiveKit signaling but did not establish ICE. Mozilla documents [loopback ICE restrictions](https://bugzilla.mozilla.org/show_bug.cgi?id=1973521).

Removed only that node-IP override from the existing SFU configuration. LiveKit selected its existing private container interface, observed as `172.30.0.2`. Native Linux Docker host browsers can route to it through the already-existing bridge. This does not create a network, bind a new public port, or require a static subnet/IP. `use_external_ip:false` remains in place. Compose still publishes all five existing host ports on `127.0.0.1` (backend 18080, frontend 5173, SFU 7880/7881 TCP and 7882 UDP).

Only this project's SFU was restarted to apply the setting. No browser privacy preference, certificate validation, DTLS/SRTP configuration, sandbox, origin checks, token scope, publisher capability, host firewall, unrelated Docker service, AWS resource, or user capture service was changed. Tests observed ICE `succeeded` and DTLS `connected`. Signaling remains the existing local development HTTP/WebSocket arrangement; this is not an internet-ready HTTPS/WSS deployment.

The container's private interface was already reachable by the Linux host and other containers on the same project bridge. Changing the advertised candidate makes that existing media route usable; it is not an assertion that a Docker bridge provides production authentication. Room and publisher JWT authorization remain required. Docker Desktop/VM and rootless networking are not validated by this host-specific result.

## Runtime diagnostics

Each stream has a Runtime diagnostics panel and a copy button. No media is recorded and no diagnostics are sent to a server. Copied summaries exclude access tokens, invitation keys, SDP, candidate addresses, and browser device IDs.

- Encoded/decoded resolution is separate from requested capture settings. Received video dimensions use the decoded video element when available.
- Encoded FPS uses a frame-counter delta for the largest active sending layer. Decoded FPS uses receiver `framesDecoded` deltas. Local-preview presented frames are not called decoded network FPS.
- Video RTP bitrate uses byte-counter deltas. Primary simulcast rates are aggregated, with identified RTX/FEC codecs excluded. Layer FPS is never summed.
- Inbound packet loss uses interval received/lost counters, clamping late-packet loss corrections to nonnegative percentages. Outbound loss is the latest SFU RTCP feedback for the selected layer and is labeled separately.
- RTT is to the SFU, not end-to-end display latency. ICE/DTLS state, viewport/tab visibility, and subscription-enabled state help distinguish transport issues from adaptation.
- Sampling is every two seconds, without overlapping requests. First/missing/reset reports, repeated timestamps and gaps over ten seconds do not produce invented rates. Sampling is stopped on unmount and baselines reset on track/connection changes.

Example measured inbound snapshots, using generated 640×360 canvas input:

| Session pair | Received resolution | Decoded FPS | RTP bitrate | Codec | Sampled packet loss | ICE / DTLS |
| --- | --- | --- | --- | --- | --- | --- |
| Chromium ↔ Chromium | 640×360 | 15.0 | 224.0 kb/s | VP8 | 0.0% | succeeded / connected |
| Firefox ↔ Firefox | 320×180 | 8.5 | 59.1 kb/s | VP8 | 0.0% | succeeded / connected |
| Chromium ↔ Firefox | 320×180 | 9.0 | 71.0 kb/s | VP8 | 0.0% | succeeded / connected |

These are real RTP-report samples for generated input, not desktop measurements, sustained averages, configured targets, or results to generalize to the user's GPU. Lower adaptive receive resolution is explicitly displayed rather than reporting source settings as achieved output.

## Adaptive streaming and fullscreen

The SDK's adaptive streaming and dynacast remain enabled. The grid still attaches actual video elements through the SDK. No forced subscription, blanket disabling of adaptation, privacy switch, or native capture workaround was introduced.

The browser test moves the receiving video into view, confirms increasing native presented-frame callbacks, and verifies positive measured decoded FPS. It then enters fullscreen and verifies additional presented frames while fullscreen. After leaving fullscreen it scrolls the streams fully offscreen, observes **Adaptive pause**, restores visibility, and verifies playback/streaming resumes. Ordinary signaling reconnection preserves the original capture request count and independent streams.

The main label now distinguishes visibility-driven **Adaptive pause** from **Paused by SFU**, instead of blaming all pauses on bandwidth. Diagnostics expose subscription-enabled state alongside actual viewport/tab visibility. No persistent visible-track or fullscreen pause was reproduced in the passing generated-media scenarios. This does not rule out compositor/browser-specific problems with real desktop sources; the native checklist remains necessary.

## Cleanup and test-fixture findings

Added an idempotent application cleanup fallback after native capture end so removal is not dependent solely on SDK event ordering. Live capture remains preserved through the SDK's temporary unpublish/republish during a full reconnect; capture still stops on terminal disconnect, leave, explicit stop, cancellation, or initialization/publication failure.

Firefox's local MediaStream preview did not provide a useful decoded-video quality counter. Playback assertions now use native `requestVideoFrameCallback` callbacks, which describe presented frames and are not mislabeled as network decoded FPS. Runtime remote FPS is independently derived from actual RTP reports.

A separate Firefox-only probe found that untrusted `MediaStreamTrack` `ended` dispatch did not invoke listeners, even though `dispatchEvent` returned true. The generated-capture fixture now explicitly mocks ended-listener delivery rather than pretending that synthetic dispatch tested Firefox's native browser Stop sharing control. Both capture acquisition and that end-event injection remain clearly mocked; RTP/encoding/SFU/decoding, visibility changes, and fullscreen are real.

## Automated validation

Backend, from `backend`:

```sh
LIVEKIT_INTEGRATION_URL=http://127.0.0.1:7880 go test -race -count=1 ./...
go vet ./...
```

Both passed. Actual uncached output:

```text
?    github.com/ghptc/whiterun-live/backend/cmd/server [no test files]
ok   github.com/ghptc/whiterun-live/backend/internal/config 1.005s
ok   github.com/ghptc/whiterun-live/backend/internal/httpapi 1.007s
ok   github.com/ghptc/whiterun-live/backend/internal/rooms 1.042s
```

Frontend host and final Node 24 container checks passed:

```text
src/App.test.tsx               3 tests
src/Rooms.test.tsx             8 tests
src/ScreenSharing.test.tsx    16 tests
src/mediaStats.test.ts         5 tests
src/MediaDiagnostics.test.tsx  2 tests
Test Files 5 passed (5)
Tests      34 passed (34)
```

The build includes strict TypeScript checking and passed on both host and container:

```text
vite v8.3.6
✓ 21 modules transformed.
dist/assets/index-Ck2n5Ha9.js 774.77 kB (gzip 213.84 kB)
```

The existing nonfatal bundle-size warning is retained and not suppressed.

Browser commands against the running SFU:

```sh
npm run test:e2e
E2E_BROWSER=firefox npm run test:e2e
E2E_REMOTE_BROWSER=firefox npx playwright test e2e/media.spec.ts -g 'generated video'
```

Chromium's final clean five-test suite passed in 27.8 seconds (an earlier run also passed in 30.3 seconds). The isolated Firefox media/permission suite passed two tests in 13.2 seconds. Chromium → Firefox's two-publisher media test passed in 12.4 seconds. The clean full Firefox suite passed all five tests in 29.3 seconds, including preserved authorization/presence/departure/reconnection cases. One intermediate Firefox full-suite run was invalidated by an overlapping frontend container rebuild and is not counted as a validation pass.

The shared departure test now uses `page.close({runBeforeUnload:true})`, which allows the SDK's normal `pagehide`/`beforeunload` cleanup to execute and models an interactive tab close. Playwright's default forced close bypassed those lifecycle events and Firefox departure did not meet the original 15-second assertion. That forced-loss result is not hidden as a passing graceful-close result: abrupt process loss still needs explicit SFU reconnect-grace validation. No application authorization or test timeout was relaxed.

The generated-media tests use sandboxed browser profiles and no automatic desktop-picker selection. They check two publishers, independent stream retention, decoded/presented playback, runtime diagnostics, full-screen frame progression, offscreen/visible adaptation, actual signaling socket close/resume without capture reacquisition, mocked end cleanup, departure, and viewer rejoin. Preserved room tests check authorization rejection, participant presence, departure, and signaling recovery.

Final browser result summary:

```text
Chromium full suite: 5 passed (27.8s)
Firefox full suite:  5 passed (29.3s)
Chromium ↔ Firefox:  1 passed (12.4s)
```

These are generated-capture transport/UI tests, not native desktop captures.

Compose validation, final application/container health checks and direct/proxied health endpoints passed. No new service or dependency was introduced.

## Remaining blockers

1. A person must run the [real desktop procedure](desktop-validation.md) in the installed Chrome/Chromium and Firefox on Hyprland, approve native capture, and record both simultaneous desktop streams and native sharing-control behavior.
2. Actual resolution/FPS under sustained moving desktop content, NVIDIA acceleration, and end-to-end latency remain unmeasured. Generated video cannot certify 1440p60.
3. Full network loss, suspend/resume, SFU restart recovery, and rootless/VM Docker need separate validation. Ordinary signaling interruption is covered; it is not the same as those failures.

Milestone 4 has not started. No audio, recording, native capture agent, Discord integration, new infrastructure, public exposure, or AWS deployment was added.
