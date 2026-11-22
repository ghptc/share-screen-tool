# Native audio quality stabilization — 2026-11-06

**Follow-up: real-world listening remains unresolved.** The user reported persistent severe stuttering after this change. The synthetic results below do not establish a listening fix. See [the real desktop investigation](audio-real-desktop-investigation.md) for current evidence, limitations and reproduction instructions.

## Root cause and scope

The earlier feedback explanation was incomplete. A separate, reproducible **sender-cadence defect** existed in the native helper, even with capture and playback on different devices.

1. `pw-cat` delivered regular PCM chunks at about 21.33 ms (1024 frames at 48 kHz).
2. FFmpeg's raw-PCM demuxer grouped input into **4096-frame packets**: `4096 / 48000 = 85.333 ms`. It then produced several valid 20 ms Opus packets together. Input-probe and AVIO read-ahead adjustments did not remove that demuxer batching.
3. The file-oriented LiveKit reader worker started its wall-clock schedule before the first live encoded packet was ready. Late samples could be sent without waiting to catch up to that old schedule. The actual writer trace showed many sub-5 ms sends and 35–58 ms gaps, although every RTP timestamp increment was correctly 960.

Thus, a correct codec, positive energy, normal average bitrate, and zero lost packets did **not** establish smooth publication. Source batching and live publication pacing were the confirmed implementation defects. This is independent of browser getDisplayMedia audio support. Same-output recirculation remains a separate possible problem, but was explicitly excluded from these measurements.

References:

- [FFmpeg PCM demuxer packet sizing](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/pcm.c), `PCM_DEMUX_TARGET_FPS` and `ff_pcm_default_packet_size`: at 48 kHz, the power-of-two packet size is 4096 frames.
- [Pinned LiveKit Go SDK writer](https://github.com/livekit/server-sdk-go/blob/v2.19.0/localtrack.go), `writeWorker`: wall-clock initialization, sample read, and catch-up scheduling.
- [Opus RTP format, RFC 7587](https://www.rfc-editor.org/rfc/rfc7587.html): the RTP clock is 48 kHz, including stereo.

## Fix

The helper now uses the installed **libopus 1.6.1** through a small cgo binding. FFmpeg and Ogg buffering are removed from the production pipeline; FFmpeg remains an optional diagnostic/reference-decoder tool.

```text
Explicit selected PipeWire sink monitor
 → signed little-endian PCM at 48 kHz, stereo
 → ReadFull of 3840 bytes = 960 frames × 2 channels × 2 bytes
 → one libopus OPUS_APPLICATION_AUDIO packet, 128000 bps target
 → verify actual packet duration from its Opus TOC
 → live monotonic 20 ms pacer
 → official LiveKit sample track, 48 kHz / 2 channels
 → existing SFU and existing browser renderer
```

The pacer anchors to actual first-frame readiness, spaces queued frames, and rebases a late live source instead of replaying it in a catch-up burst. It does not add an unbounded queue or drop samples to mask a delay. Frame duration drives the SDK's media clock: **960 RTP ticks per 20 ms packet**, not 1920 stereo sample values, 3840 bytes, or noisy wall-clock differences. Unit tests reject unexpected Opus durations and preserve error propagation. There is no application-side resampling/channel remixing and no browser jitter-buffer or tolerance increase. PipeWire may perform its normal device-to-requested-format conversion where necessary.

Capture now starts only once the SDK has bound the publication. This prevents an unread pipe from queuing old desktop audio during negotiation and avoids writing frames before the track can send them. A single capture/encoder pump survives ordinary binding changes; startup timeouts and capture/encoding errors are explicit. Existing short-lived helper credentials, one-time pairing, exact owner/screen metadata, sink-only selection, consent, lease and teardown behavior remain in place.

Arch builds now need `opus`, `pkgconf`, a C compiler and cgo-enabled Go in addition to the existing PipeWire tools. These dependencies were already available on the host; no packages or system configuration were installed/changed. See [setup instructions](native-audio.md).

## Actual capture and output separation

The sustained test did **not** record or capture arbitrary desktop applications. A continuous native generated 997 Hz tone was explicitly played into the existing ALSA-loopback output using `pw-cat --playback --target <serial>`. The native helper captured that output's real PipeWire monitor. Both browsers played through the **HyperX USB output**, a different ALSA device/node.

Actual route evidence was collected using `pw-dump` and `pactl`:

| Role | Sink | Node / serial |
| --- | --- | --- |
| Generated source and captured monitor | `alsa_output.platform-snd_aloop.0.analog-stereo` | 60 / 65 |
| Chromium and Firefox playback | `alsa_output.usb-HP__Inc_HyperX_Cloud_II_Wireless_0-00.analog-stereo` | 46 / 63 |

New browser output streams were verified on sink 63, unmuted and uncorked. This checks actual routing rather than assuming an incognito context or an environment variable provides separation. It does not establish what output a user's earlier, uninspectable manual session selected; it does exclude feedback from the controlled comparison.

The test video is generated solely to authorize an isolated screen session without disturbing the user's actual screen. The **audio is genuine PipeWire monitor capture** through the compiled native helper and the real local LiveKit v1.13.11 server. Browser capture mocks are not used as the audio source in this test.

## Measurements

Three-minute baseline and fixed runs used simultaneous Chromium and Firefox listeners, the same local SFU, source format, selected devices, encoder application and bitrate target. Default LiveKit RTP interceptors were preserved. Steady-state send statistics exclude the first five seconds. The machine-readable [results](audio-quality-results.json) preserve run summaries and waveform checks; raw metadata remains in the documented local result directories.

| Metric | Original pipeline, 180 s | Fixed validated pipeline, 180 s |
| --- | ---: | ---: |
| Outgoing RTP packets | 9082 | 9094 |
| Send interval mean | 19.997 ms | 20.000 ms |
| Send interval p95 | 53.203 ms | 20.391 ms |
| Send interval p99 | 57.085 ms | 20.526 ms |
| Worst steady send gap | 58.281 ms | 22.123 ms |
| Steady gaps below 5 ms | 2367 | 0 |
| Steady gaps above 35 ms | 2071 | 0 |
| RTP timestamp deltas | all 960 | all 960 |
| RTP sequence deltas | all 1 | all 1 |
| RTP write errors | 0 | 0 |
| Chromium reported RTP jitter mean | 12.98 ms | 0.033 ms |
| Firefox reported RTP jitter mean | 13.00 ms | 0.044 ms |
| Chromium mean interval jitter-buffer residence | 61.39 ms | 33.83 ms |
| Firefox mean interval jitter-buffer residence | 59.30 ms | 34.99 ms |
| Lost packets | 0 | 0 |
| Additional concealed samples during sampled run | 0 / 0 | 0 / 0 |

“Reported 0 ms” is browser precision, not zero network delay. Receiver buffering is one component, not end-to-end/acoustic latency. The baseline had irregular send cadence but no ongoing PLC growth under the isolated tone. These measurements identify and fix a real defect without claiming the tone reproduced every severe subjective symptom from game/music listening.

A previous fixed three-minute run had p99 20.527 ms, max 20.959 ms, zero burst/long-gap counts and about 36/33 ms receiver residence. The final validated run included decoded-waveform checks and startup/binding safeguards. Small run-to-run buffering differences are left visible; no buffer setting was tuned to force a result.

The first fixed run encoded a frame in 0.121 ms on average (0.239 ms p99); the final validated run averaged 0.122 ms (0.247 ms p99, 0.716 ms max). Every checked packet contained 20 ms of audio. The final run's media-clock versus send-wall-clock difference was -2.26 ms over about 177 seconds, approximately -12.8 ppm, without growing publication backlog. Exact source-rate and receiver clock-adjustment counters are included in the JSON summaries.

Startup concealment is **not** reported as zero: the final run had initial totals of 960 Chromium and 241 Firefox concealed samples, unchanged during sampled playback. Both receivers inserted another 576 samples and removed 144 over the run (12 ms / 3 ms at 48 kHz), while reported jitter remained 0–1 ms and tone continuity checks passed. These clock/buffer adjustments are recorded, not hidden.

The optional Pion `GetStats()` report did not provide outbound RTP stream rows in this configuration. Publisher measurements therefore use the SDK's supported outgoing RTP interceptor plus its RTCP callback, rather than inventing unavailable counters. A final feedback check collected 31 actual SFU receiver reports: no reported loss, with the final report's jitter 19 ticks, about .396 ms at 48 kHz. The later sustained validated trace also contains actual RTCP reports.

## Signal and decoding checks

Generated stereo reference samples (997 Hz left / 1499 Hz right) were encoded in exact 960-frame blocks and decoded locally in memory. The test verifies packet duration, decoded sample count, channel-specific tone coherence >.95, partial-frame rejection and resource cleanup. No private samples or audio files were stored.

Both live browser receivers were also analysed through a separate diagnostic AudioContext branch, with their actual HTML audio elements still used for playback. Sample rate was 48 kHz, decoded RMS stayed positive and the tone projection ratio stayed near 1 (a 30-second final check had minimum about .9991). This detects silent/corrupt decoding independently of positive historic RTP energy. The finite-window ratio is approximate and can slightly exceed 1; it is not a subjective listening score. The subsequent 180-second validation asserted non-silent, coherent waveform and ready, unpaused, unmuted playback throughout its samples.

Physical sound was not evaluated by a human during automation. Manual game/music listening on the target outputs remains necessary to confirm subjective quality, absolute latency and A/V alignment. Separate browser/helper clocks and long WAN/CPU/device-interruption scenarios are not proven by a local three-minute tone run.

## Reproduce safely

From the repository root, after building the helper and with the normal local app running:

```sh
cd native-audio
go test -race ./...
go vet ./...
go build -o whiterun-audio .
cd ..

QUALITY_CAPTURE_SINK=alsa_output.platform-snd_aloop.0.analog-stereo \
QUALITY_PLAYBACK_SINK=alsa_output.usb-HP__Inc_HyperX_Cloud_II_Wireless_0-00.analog-stereo \
QUALITY_SECONDS=180 QUALITY_ASSERT_STABLE=1 \
QUALITY_RESULT_DIR=/tmp/whiterun-quality-NEW \
node native-audio/scripts/quality-run.mjs

python3 native-audio/scripts/summarize-quality.py /tmp/whiterun-quality-NEW
```

Use exact existing sink names appropriate to your machine and a capture sink containing only the generated source. The script requires distinct sinks, normal local operator authorization, explicit helper `--start`, and a valid live screen pairing. It never changes default/global routing. A new output directory/log is required; existing timing logs are not overwritten. Output contains only JSON timing/receiver metadata, not media or credentials. Local unit reference decoding and the legacy demux cadence probe require FFmpeg; the production helper does not.

The optional `native-audio/cmd/timing-probe` separately reproduces the legacy PCM-to-FFmpeg burst boundary without publishing or recording media. It requires an explicit output serial and supports baseline/probe/AVIO comparisons. Its measured 20-second baseline had PCM gaps p99 21.39 ms and Opus read gaps p95 85.05 ms; 760 of 992 Opus gaps were below 5 ms. Probe-size and direct-AVIO variants retained the same batching and were rejected as fixes.

The sustained stability gate checks RTP timestamp increments/cadence, receiver loss/concealment growth, decoded tone continuity and playback state. It deliberately does not override jitter buffers, conceal errors or automatically accept failed runs.

## Validation and errors retained

- Native helper: 10 tests with race detection, vet and build passed, including frame format, live-clock drift/stall behavior, write/capture error propagation, closed encoder behavior and timing-file errors.
- Frontend: 67 unit tests and production build passed; the existing bundle-size warning remains.
- Backend: race tests with live-SFU integration and vet passed. Authorization/pairing was not changed.
- Full Chromium suite: 11 passed (51.7s), including actual monitor capture with the corrected explicit generated source.
- Full Firefox suite: 11 passed (55.4s), including actual monitor capture.
- Sustained baseline: 180 seconds with both browsers; fixed runs: 180 seconds plus final 180-second assertion-enabled validation, and a 30-second RTCP/waveform check.

An earlier hardware E2E failed with zero received energy while relying on FFplay/SDL honoring `PULSE_SINK` when targeting the isolated sink. The old fixture did not establish the SDL output target, so it was not accepted as codec success; its exact SDL routing/failure branch was not captured. The fixture now generates PCM in memory and plays it through `pw-cat --target <actual serial>`. The long-run quality script already used explicit targets and verified browser routes. An initial instrumentation attempt also omitted default SDK interceptors; it was excluded from the final comparison, which explicitly preserves them. Incomplete runs are not included as passing evidence.

## Using the fix

The rebuilt binary is `native-audio/whiterun-audio`. An already-running helper keeps its old executable; stop it, create a fresh native pairing for the active screen, and start the rebuilt helper with the same explicit output selection. No Docker/backend/frontend restart is required. Existing room authorization and invitations remain intact.

No global PipeWire routing, unrelated containers, AWS, Discord, recording of private application audio, or video optimization was changed. This milestone stops at audio quality stabilization.


### Final startup check

After the sustained pacing validation, a final small refinement deferred starting `pw-cat` itself until publication binding (the earlier validated version already deferred its PCM pump). A separate 30-second quality-gated check passed in Chromium and Firefox. The trace confirms capture began after binding, and contains 31 actual SFU RTCP reports. This startup-only refinement was not misreported as an additional three-minute run. The reproducible quality gate now also enforces capture-after-bind ordering. The final binary checksum and startup-check summary are included in the JSON results.

### Completion state

The final capture-after-bind check passed all quality gates for 30 seconds: p99 send gap 20.488 ms, max 20.875 ms, 31 SFU RTCP reports with zero loss and maximum reported jitter .5 ms, plus non-silent waveform projection ratios above .9990 in both browsers. Its source started after publication binding. The final helper was rebuilt at its documented path; existing helper processes must be stopped/re-paired to use the new executable.

All native race tests/vet/builds passed after this startup refinement. Full Chromium and Firefox suites passed before the startup-only refinement; the final real-SFU quality run separately verified the changed startup path. Backend/frontend services and LiveKit remained healthy without any container recreation, and no diagnostic `pw-cat` or FFmpeg processes remained at completion. No private media recordings were created.
