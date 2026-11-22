# Native audio validation — 2026-11-06

This record covers the historical monitor diagnostic. For current use, select the game with the application helper and listen through your normal headset. [Same-headset workflow and release gate](native-audio.md)

## Tested implementation

The optional Go helper uses actual PipeWire sink-monitor PCM, FFmpeg/libopus, and official LiveKit Go SDK v2.19.0, through the existing LiveKit v1.13.11 SFU. Authorization remains in the Go backend; browser playback uses the existing per-owner renderer. Tests used an isolated candidate backend/frontend on localhost ports 18081/5174 to preserve the running app at 5173 and its active real desktop share. Docker services were not restarted for these candidate checks.

## Automated checks

Backend, from `backend/`:

```text
LIVEKIT_INTEGRATION_URL=http://127.0.0.1:7880 go test -race -count=1 ./...
?   github.com/ghptc/whiterun-live/backend/cmd/server [no test files]
ok  github.com/ghptc/whiterun-live/backend/internal/config  1.005s
ok  github.com/ghptc/whiterun-live/backend/internal/httpapi 1.007s
ok  github.com/ghptc/whiterun-live/backend/internal/rooms   1.050s

go vet ./...
# exit 0
```

Native helper, from `native-audio/`:

```text
go test -race ./...
ok github.com/ghptc/whiterun-live/native-audio 1.014s

go build -o whiterun-audio .
# exit 0

go vet ./...
# exit 0
```

`--list` successfully listed only the existing HDMI, USB headset, and ALSA-loopback output sinks. `--start --sink whiterun-validation-missing-output` exited 1 with a clear unavailable-sink error before credentials or capture. Sink tests reject microphone/default/missing inputs; URL tests reject plaintext non-loopback endpoints and embedded/query credentials.

Frontend, from `frontend/`:

```text
npm test
Test Files 8 passed (8)
     Tests 63 passed (63)

npm run build
✓ 24 modules transformed.
dist/assets/index-DZ4yBLiC.js 786.90 kB │ gzip: 217.33 kB
✓ built in 214ms
```

Typecheck/build succeeded, with the existing nonfatal bundle-size warning.

Backend native-session tests cover unauthorized/viewer/missing control rejection, real screen SID validation through a mocked RoomService, single-use pairing, separate identities, server-established owner/screen metadata, exact screen-audio-only source permission, no subscription/data/metadata/admin permissions, wrong lease credentials, expiry and revocation. Existing room authorization tests remain intact.

Frontend native tests cover explicit pairing consent, unavailable pairing without a screen, no viewer controls, errors, screen-stop cleanup, late response revocation, owner association, and preference for native audio over simultaneous browser audio without duplicate playback. Existing consent, audio/video lifecycle, autoplay retry, independent volume/mute, and reconnection tests remain intact. Audio diagnostics use actual receiver reports and distinguish unavailable values from zero or first-sample rates.

## Browser tests using generated capture

Before final refinements, complete suites passed:

```text
E2E_BASE_URL=http://localhost:5174 npm run test:e2e
10 passed (45.0s)

E2E_BASE_URL=http://localhost:5174 E2E_BROWSER=firefox npm run test:e2e
1 skipped
10 passed (48.7s)
```

The skipped case requires an explicit hardware sink environment variable and is run separately below. An earlier Firefox video run was invalidated by editing the Vite source while tests were active; the subsequent stable-source full run passed. It is not reported as an unexplained media failure.

The native pairing E2E uses a browser-generated stand-in for the Go helper to exercise real-SFU association, audio-only grants, code replay rejection, unauthorized session rejection, and screen-stop disconnection. A strengthened run also explicitly attempted microphone and camera publication with the helper token; both were rejected, while screen audio succeeded (`1 passed (1.4s)`). These tests are **not** evidence of PipeWire capture.

## Actual local PipeWire capture

A read-only inventory confirmed real monitor ports on the selected sink:

```text
alsa_output.usb-HP__Inc_HyperX_Cloud_II_Wireless_0-00.analog-stereo:monitor_FL
alsa_output.usb-HP__Inc_HyperX_Cloud_II_Wireless_0-00.analog-stereo:monitor_FR
```

A short explicit monitor probe captured 480,000 bytes of actual sink PCM in memory while a native FFplay process played a quiet 523 Hz test tone. The measured tone-frequency magnitude increased from 28.522 to 77.618. No PCM was saved, and no devices/default routes were changed. Background desktop sound was present, so these values are not an isolated acoustic measurement.

The hardware E2E then ran **two compiled Go helper processes**, two authorized screen publishers, and a third listener context. Each helper selected the actual USB headset sink monitor. A native FFplay process emitted a test tone to that sink. This was not a synthetic MediaStream substituted at the capture API. Only the video capture used a generated canvas to preserve the existing real desktop share.

Explicit hardware command, from `frontend/`:

```sh
NATIVE_AUDIO_SINK=alsa_output.usb-HP__Inc_HyperX_Cloud_II_Wireless_0-00.analog-stereo \
PULSE_SINK=alsa_output.platform-snd_aloop.0.analog-stereo \
E2E_BASE_URL=http://localhost:5174 \
npm run test:e2e -- audio.spec.ts -g 'actual PipeWire'
```

`PULSE_SINK` isolates playback of the test browser process to this machine's pre-existing loopback sink, avoiding recapture/feedback. The native test player explicitly overrides that process-local choice to target the monitored headset. This does not create a sink or modify global routing. The test is opt-in because it captures real desktop output and plays a quiet sound.

Observed successful native runs:

| Listener | Actual monitor/helper result |
| --- | --- |
| Chromium | Two Opus receiver streams, 33/20 packets and positive decoded energy in the first run; startup, screen-stop cleanup passed (`1 passed`, 2.2s). |
| Chromium + signaling recovery | Both helpers remained alive and packets progressed after an owner's signaling interruption without re-pairing (`1 passed`, 5.0s). |
| Firefox + signaling recovery | Two Opus streams, 21/11 packets, positive energy .0052999/.0031892; playback ready/unpaused, reconnection and cleanup passed (`1 passed`, 6.2s). |
| Final Chromium diagnostics/interrupt check | Two Opus streams, 109/122 packets and positive energy .0184913/.0200740; receiver diagnostics showed Opus, owner screen stop ended its helper, and SIGINT stopped the other helper's audio while its video remained (`1 passed`, 7.1s). |

These checks establish native application output → actual selected PipeWire monitor → compiled Go helper/Opus → existing SFU → remote browser audio decode and playing elements. No person confirmed physical hearing during automation; they do not establish subjective fidelity, game/music compatibility, A/V synchronization, latency or 1440p60. A real desktop screen's video was previously user-validated, but was intentionally not recaptured automatically here.

## Manual final listening

After applying the update, create a fresh room (backend recreation clears in-memory invitations), explicitly start your real desktop share, pair the helper, select the output used by a native game/music application, and unmute that publisher in an independent browser. Verify actual heard audio, independent volume/mute, no microphone input, explicit helper stop, and screen-stop cleanup. Avoid listening through the same monitored output while publishing unless you deliberately arrange a separate playback path. No automatic routing workaround is provided.

## Limits and deployment boundary

See [setup and security details](native-audio.md), especially self-hosted JWT refresh/revocation and feedback. Native audio is a separate participant/clock and consumes a LiveKit participant slot. A full screen republish with a new SID, output hotplug, device serial replacement, capture/encoder interruption, authorization probe failure or terminal disconnect requires explicit restart/re-pairing. Ordinary signaling recovery is tested; arbitrary long network outages and A/V drift are not validated.

Dependency download initially failed only in the agent's Go networking path while host/curl HTTPS succeeded. The user ran `go mod tidy` from the correct module directory to populate the shared cache; subsequent tidy/build/tests succeeded. Go checksum verification remained enabled; Tailscale, NetworkManager, resolver files and global networking settings were unchanged. A temporary loopback HTTPS-download adapter attempt completed without downloads after the cache became available and was stopped; no persistent proxy was installed.

No AWS, Discord, native microphone fallback, recording, unrelated Docker changes, or video optimization work was performed.

## Final candidate validation

After the final pairing-race fix, measured receiver diagnostics, helper stall/startup safeguards, and restarting only the isolated candidate backend with the final grants:

```text
E2E_BASE_URL=http://localhost:5174 npm run test:e2e
1 skipped
10 passed (44.9s)

NATIVE_AUDIO_SINK=alsa_output.usb-HP__Inc_HyperX_Cloud_II_Wireless_0-00.analog-stereo \
PULSE_SINK=alsa_output.platform-snd_aloop.0.analog-stereo \
E2E_BASE_URL=http://localhost:5174 E2E_BROWSER=firefox npm run test:e2e
11 passed (56.5s)

docker compose build backend frontend
Image whiterun-live-backend Built
Image whiterun-live-frontend Built
```

The final Firefox suite included actual PipeWire capture: both native helpers delivered Opus to the listener (124/114 packets and positive decoded energy at the logged sample). It verified receiver codec diagnostics, signaling recovery, screen-stop teardown, and explicit SIGINT teardown while the other browser video remained active. The Chromium hardware test was separately passed; default suites do not silently capture a real output without the explicit sink variable.

Backend race/live-integration tests, native-helper race tests/build/vet, 63 frontend tests, production build, and patch whitespace validation passed. Only local app images were built; the existing Docker services and active real desktop share were left running pending permission to apply the app update.

## Approved application update and post-update evidence

After explicit user approval, applied only the already-built backend/frontend images:

```text
docker compose up -d --no-deps --wait --wait-timeout 120 backend frontend
Container whiterun-live-backend-1 Healthy
Container whiterun-live-frontend-1 Healthy

curl -fsS http://127.0.0.1:18080/readyz
{"livekit":"reachable","status":"ok"}
```

Against the normal app at `http://localhost:5173`, with the explicit native sink and process-local playback isolation:

```text
NATIVE_AUDIO_SINK=alsa_output.usb-HP__Inc_HyperX_Cloud_II_Wireless_0-00.analog-stereo \
PULSE_SINK=alsa_output.platform-snd_aloop.0.analog-stereo \
npm run test:e2e -- audio.spec.ts
3 passed (13.0s)
```

This included generated-audio regression coverage, native pairing/source permission rejection, and actual monitor capture through two compiled helpers. Final receiver sample: two Opus streams, 109/122 packets and positive decoded energy .0021372/.0020236; browser playback, signaling recovery, owner-stop cleanup, and explicit helper interrupt passed. The actual monitor test's video remained generated; physical hearing and game/music fidelity remain manual checks.

Only backend/frontend were recreated; the original LiveKit container remained running. Temporary processes on 18081/5174 were stopped and their ports confirmed closed. Patch whitespace checks passed. The app now contains the native pairing interface; old in-memory invitations were cleared, so create a fresh room and explicitly start desktop sharing again. The helper binary is at `native-audio/whiterun-audio` and is ignored by Git/Docker build context.
