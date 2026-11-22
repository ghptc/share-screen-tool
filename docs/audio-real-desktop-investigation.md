# Persistent real-world audio lag — 2026-11-06

**Requirement correction:** a separate output is only a diagnostic control, never a production requirement. The implemented same-headset application tap and current release gate are documented in [native audio](native-audio.md). The procedures below describe earlier whole-monitor investigations.

## Real-desktop listening procedure — prepared 2026-11-10

**Status remains unresolved. This procedure has not yet completed a real listening run.** The host exposes HyperX and one other physical sink: HDMI/DisplayPort `alsa_output.pci-0000_01_00.1.hdmi-stereo`, described as LG ULTRAGEAR+. Its port reports available; audibility through connected speakers/headphones is unconfirmed. The ALSA loopback sink is not acceptable for this test. The user must operate the normal screen picker and physically listen. No picker consent or browser security checks are bypassed.

The listening harness now uses real `getDisplayMedia`, requires a full monitor selection, keeps desktop video enabled throughout, and records outbound video frame/encode counters. It plays an existing local file and tests Chromium for the first half, Firefox for the second half, with only one receiver audible at a time. Both browser streams start at volume zero until their actual stereo PipeWire links are verified. A repeated check every two seconds aborts if playback leaves the requested output or capture is not linked exclusively to the HyperX monitor. This is periodic verification, not a guarantee against sub-second routing changes. A second active `pw-cat` capture also aborts the test rather than being stopped automatically.

Minimal procedure, from the repository root:

1. Confirm HDMI is physically audible through speakers/headphones outside the HyperX mix. If it is not, stop and connect/select a different existing physical output deliberately; do not substitute loopback. Pause unrelated music/call audio yourself so the whole HyperX monitor contains only the fixture. Keep the helper stopped for the local baseline.
2. Generate the original, deterministic 30-second signal and listen locally once on HyperX:

   ```sh
   python3 native-audio/scripts/generate-listening-signal.py /tmp/whiterun-listening-source.wav
   pw-play --target=alsa_output.usb-HP__Inc_HyperX_Cloud_II_Wireless_0-00.analog-stereo /tmp/whiterun-listening-source.wav
   ```

   The file contains quiet continuous stereo carriers, changing notes once a second, and smooth markers every five seconds. Gaps and crackles are not intentional. It loops smoothly and contains no imported/copyrighted content. Record whether the local baseline is clean; a local defect must not be attributed solely to LiveKit. The generator refuses to overwrite an existing file; reuse it or choose a new filename.
3. Start the three-minute run, select the **entire desktop monitor** in the normal picker, and perform the desktop activity that previously triggered stuttering:

   ```sh
   QUALITY_LISTENING=1 QUALITY_REAL_SCREEN=1 QUALITY_SECONDS=180 \
   QUALITY_MEDIA_FILE=/tmp/whiterun-listening-source.wav \
   QUALITY_CAPTURE_SINK=alsa_output.usb-HP__Inc_HyperX_Cloud_II_Wireless_0-00.analog-stereo \
   QUALITY_PLAYBACK_SINK=alsa_output.pci-0000_01_00.1.hdmi-stereo \
   QUALITY_RESULT_DIR=/tmp/whiterun-listening-run-01 \
   node native-audio/scripts/quality-run.mjs
   ```

   Use a new result directory for each run. Chromium is brought forward first, Firefox at 90 seconds. Listen through HDMI, not HyperX. Click **Confirm source audible**, then **Mark audible glitch** immediately for each heard gap, crackle or repetition. At the end of each browser's interval, click **Mark listening pass** or **Mark listening failure**. These buttons are in the test browser page, below the normal controls. They record observations; metrics never manufacture a listening verdict. Browser volume starts at 50% of the deliberately quiet fixture and can be adjusted with the existing slider. If the source cannot be heard, record failure rather than a clean pass. Closing/stopping sharing retains the existing native helper revocation behavior.
4. Correlate the human markers after the run:

   ```sh
   python3 native-audio/scripts/correlate-listening.py /tmp/whiterun-listening-run-01 > /tmp/whiterun-listening-run-01/correlation.json
   ```

Keep the entire result directory plus the local-baseline verdict and a short description of the screen workload. The script creates its own diagnostic room and short-lived helpers using the existing application pairing flow. It selects the output only for its browser processes; it does not change default sinks, existing application routes, device profiles, security permissions, or containers.

Synchronized evidence uses host Unix milliseconds in helper events, browser polls/media events, listening markers, host CPU/GPU samples, and route snapshots. Browser native RTC timestamps and helper monotonic elapsed time are also preserved. `correlation.json` reports a ±2-second window around each glitch/failure, including pipe backlog, encode time, RTP send gaps, pacing lateness, SDK write time, SFU RTCP receiver reports, browser stats, desktop-video stats, CPU/GPU, and observed `pw-top` output. Markers include human reaction time; counter polls and `pw-top` receipt timestamps do not locate an underrun to an exact audio sample. Clock adjustments can affect Unix time alignment.

`host.json` records process CPU/scheduler wait, system CPU ticks, NVIDIA GPU/memory/encoder/decoder utilization and available DRM GPU-busy counters, plus timestamped PipeWire ERR output. `receivers.json` records audio jitter-buffer/concealment counters, selected ICE-pair RTT/traffic, supported `media-playout` statistics, element state, and sampled decoded waveform energy. Empty playout data means unsupported, not zero glitches. SFU feedback is in `publisher.jsonl`; this is transport feedback, not a complete server-internals trace. No individual network packet-arrival timestamps or microphone/acoustic recording are collected. Physical playback continuity is established by the listener's observations, not waveform energy or an advancing element clock.

Preparation checks passed: generated WAV format/level/loop-boundary checks; positive/negative PipeWire route tests; correlation window and missing-data checks; a two-second host collector check with accessible GPU counters; native race tests, vet, build, and script syntax checks. The new real-screen/listening harness has **not** been validated end-to-end because screen selection and audible HDMI confirmation are still outstanding. No speculative audio transport fix was applied.

## Follow-up on 2026-11-10 — still unresolved

The new investigation did **not** reproduce the reported listening failure. No helper or `pw-cat` was running at initial inspection, so the executable used during that failure cannot be verified retrospectively. The initial disk hash was `52bc039afd7e86fb2194b1a7fae7b97f4b4f0708e6537ac0dc31c9c5eb6f20ce`. Firefox and Spotify were routed to HyperX. Those Firefox streams cannot be identified as Whiterun receivers from PipeWire alone; a feedback-capable route is not proof of active feedback.

Diagnostics were extended and the helper rebuilt. In a new 40-second live-desktop run, `/proc/3146133/exe` matched the new disk hash `ce7ae38441750810d16e0776e3fcf7d7d7e97b5a08958d866faeba51f33f9b30`. Three graph snapshots during capture showed one `pw-cat` node, with stereo monitor links. Chromium 158.0.8127.18 and Firefox 159.0 each had one inbound audio stream and one stream audio element. Their new playback streams were verified on the existing ALSA loopback sink, outside HyperX capture. This checks the controlled sessions, not the user's pre-existing tabs or all SFU publications.

Evidence is saved in [audio-followup-results-20261110.json](audio-followup-results-20261110.json). Raw logs remain in `/tmp/whiterun-desktop-followup-20261110` and the simultaneous host trace in `/tmp/whiterun-followup-active-20261110.json`.

| Measurement | New observation |
| --- | --- |
| Kernel PCM pipe backlog, measured before reads | Mean 5.33 ms; maximum 20 ms |
| RTP send intervals after startup | Mean 20.002 ms; maximum 21.419 ms; timestamp increments 960 |
| Chromium receiver buffer | Mean 34.74 ms; 642 concealed samples already at first poll, no subsequent growth |
| Firefox receiver buffer | Mean 32.22 ms; zero concealed samples |
| Receiver loss / sample insertion / removal | No growth between first and last samples |
| Poll interval | Mean 254 ms; maximum 258 ms; no captured waiting/stalled events after measurement setup |
| Helper / pw-cat / PipeWire CPU | 1.63% / 0.065% / 0.59% of one core during the 15-second host sample |
| Helper / pw-cat scheduler wait | 84.14 / 78.75 ms accumulated; these are not longest individual stalls |
| Capture and output ERR counters | Zero throughout sampled active `pw-top` frames |
| Encoder / SDK write maximum | 0.431 / 0.598 ms |
| Pacer wait / scheduling lateness maximum | 20.733 / 1.753 ms |

The pacer still waits on the same goroutine that reads and encodes capture. The new queue metric shows no sustained backlog in this run, but only measures bytes currently in the kernel pipe, not all upstream buffers. Synchronous timing logging can also delay that goroutine. No pacing rewrite is justified by this sample. The encoder duration measurement was corrected to exclude RMS calculation and diagnostic logging.

The full observed pipeline remains PipeWire → 48 kHz stereo PCM → in-process libopus → SDK RTP → LiveKit → browser jitter buffer → audio element → loopback output. FFmpeg is not part of helper encoding. Spotify's 44.1 kHz source is resampled into the 48 kHz graph; capture and receiver analysis ran at 48 kHz. Delivered PCM averaged 47,988.9 frames/s over the short measured window; buffering and window boundaries prevent interpreting that as hardware clock drift.

Video was a synthetic 160×90 canvas, disabled halfway through while retaining its publication and screen SID. Chromium buffer means were 35.58 → 33.87 ms; Firefox 33.07 → 31.36 ms. This does **not** test contention under real desktop video publishing. Screen-bound authorization and stop-on-screen-end remained intact.

The new diagnostics sample CPU/scheduler counters every second, record graph snapshots every five seconds and collect `pw-top` concurrently throughout the interval. Receiver polling now targets 250 ms and includes bounded media-event history. Summary output preserves unavailable/reset counters instead of reporting them as zero. No audio samples are saved.

Still required: a fixed replayable speech/music file, real portal-selected desktop capture under the failing workload, local capture versus remote listening in both browsers on a physical output outside the captured mix, and timestamps of audible defects. Individual network packet arrival timestamps, aligned waveform comparison and acoustic output continuity were **not** measured. No root cause for the reported severe stutter has been established. The asynchronous request for the clip path, failing receiver route and listening comparison remains unanswered at the time of this report.

For the next listening reproduction, use the real-file/real-screen command below with a fresh result directory and an explicitly selected **physical** receiver output outside HyperX capture. Loopback provides metrics only. Concurrently run:

```sh
python3 native-audio/scripts/inspect-host.py --seconds 60 > /tmp/whiterun-listening-host-NEW.json
```

`observedHelpers[].matchesDiskBinary` must be true. Compare the same clip position locally and remotely in Chromium and Firefox, marking audible gap/repetition times in each half of the video comparison. Preserve `publisher.jsonl`, `receivers.json`, `routing.json`, `run.json`, `summary.json`, and the host trace even if metrics appear healthy. Do not treat a clean report as a listening pass.

Validation of the diagnostic changes: `go test -race ./...`, `go vet ./...`, helper build, JavaScript syntax check, Python compilation, missing/reset/empty-stats summary checks, and the live-desktop diagnostic in both browsers passed. This validates instrumentation, not listening quality. No global routes, security permissions, containers, video optimization or deployment were changed.

**Status: unresolved listening quality.** The earlier synthetic-tone result did not resolve the reported stuttering. This investigation confirms a feedback-capable physical route and adds diagnostics; it does not claim a transport fix or acoustic validation. Aggregate evidence: [audio-real-desktop-results.json](audio-real-desktop-results.json).

## What was actually observed

At the first host inspection there was no running `whiterun-audio` or `pw-cat`, so the executable used for the earlier failure cannot be identified retrospectively. The user confirmed listening on the same machine/headset to music and a friend's audio. PipeWire linked Spotify, Firefox, and WEBRTC VoiceEngine outputs to the HyperX sink. Capturing that sink's monitor includes those outputs. A receiver playing the captured stream there returns its own delayed playback to capture. Silent publisher preview does not prevent another browser session or another participant's audio from entering the mix.

This explains delayed duplication/recirculation in that configuration. Whether it explains all reported stuttering still requires an audible A/B comparison. Do not intentionally enable a loud feedback loop to test it.

A new 60-second diagnostic captured the actual HyperX monitor, with non-silent, varying desktop audio. It generated **no test tone**, saved no audio, and did not change existing application routes. Two isolated Playwright browsers used the existing ALSA loopback output, verified through Pulse sink-inputs. This prevents those diagnostic receivers from feeding the HyperX capture. This was Chromium 158.0.8127.18 and Firefox 159.0, not the user's already-open browser tabs.

The screen was a synthetic 160×90 canvas at 10 fps. At 30 seconds its video track was disabled without unpublishing it or replacing its screen SID; the native screen-bound authorization remained active. This is a low-load comparison, **not** a reproduction of real desktop video load, and it cannot rule out video contention.

| Measurement | Observation |
| --- | --- |
| Running helper | PID 2092744, SHA256 `52bc039afd7e86fb2194b1a7fae7b97f4b4f0708e6537ac0dc31c9c5eb6f20ce`, matched disk executable through `/proc/PID/exe` |
| Capture | One helper and one `pw-cat`; selected HyperX monitor, stereo 48 kHz |
| LiveKit inventory during run | One screen publisher, one native screen-audio publisher, two subscribers |
| Browser duplicates | One inbound audio RTP stream and one stream audio element per test receiver throughout |
| RTP send spacing after 5 s | Mean 20.001 ms, p99 20.570 ms, maximum 21.068 ms; no interval >35 ms; timestamps advance 960 ticks |
| SFU RTCP feedback | Zero reported lost packets; maximum jitter 0.458 ms |
| Receiver jitter buffer, video enabled | Chromium mean 28.98 ms; Firefox 36.45 ms |
| Receiver jitter buffer, video minimized | Chromium mean 27.69 ms; Firefox 35.17 ms |
| Concealment | Chromium already had 2,176 concealed samples at first poll (~1.25 s); no subsequent increase. Firefox zero. Startup is not concealment-free. |
| Receiver loss / insertion / removal | No counter increase between first and last polls in either receiver |
| Playback | Advancing media clocks, elements playing/ready, non-silent sampled decoded waveforms |
| 20 s host CPU sample, percent of one core | Helper 1.65%; pw-cat 0.05%; PipeWire 0.60% |
| Scheduler wait accumulated over 20 s | Helper 84.83 ms across surviving threads (max thread total 46.20 ms); pw-cat 92.09 ms. These are totals, not longest individual stalls. |
| Encoder / SDK publication | Encode p99 0.322 ms, maximum 1.540 ms; SDK write maximum 0.284 ms |
| Pacer / scheduling | Mean pacer wait 10.51 ms; maximum scheduling lateness 1.52 ms |
| Delivered PCM rate | Approximately 47,999.59 frames/s over the observed window; not a hardware drift measurement |

The pacer runs synchronously with capture reads and encoding. A wait or logging write can therefore delay the next read. This short run did not show starvation or sustained queue growth; it does not rule out stalls under real screen capture. Metadata logging is opt-in and itself has overhead. Nothing here justifies claiming the scheduling design solved the user's failure.

The pipeline now is PipeWire → raw stereo PCM → **in-process libopus** → SDK RTP → LiveKit → browser jitter buffer → HTML audio element → output. FFmpeg is not running in the helper; the optional file fixture uses FFmpeg only to play a source. Spotify's 44.1 kHz stream enters a 48 kHz graph, so PipeWire resampling is present. Capture, Opus, and the observed receiver AudioContexts are 48 kHz. Additional hardware drift/resampling is not established. `pw-top` reported zero ERR on the test capture/output nodes in its sampled active frame; that snapshot is not a continuous underrun trace. Prior idle inventory had cumulative Spotify/Firefox ERR counters, which cannot be attributed to this failure.

Browser `getStats` jitter and SFU receiver reports measure arrival variation indirectly. This run did not collect individual packet arrival timestamps or acoustic output continuity. Two-second waveform samples and advancing media clocks cannot establish gap-free listening. Local RMS and remote RMS are not a waveform fidelity comparison, especially with unsynchronized sample windows and receiver volume. The live desktop source was not a fixed replayable clip, so the required reproducible source/listening comparison remains outstanding.

## Diagnostics added

- `whiterun-audio --version` works without PipeWire or pairing. Startup and timing logs identify the running executable by SHA256 and PID. Hashing `/proc/self/exe` avoids mistaking a replaced path for the running inode.
- Timing JSONL includes per-frame local RMS (no samples), read duration, delivered-media versus wall time, pacer wait, scheduler lateness and SDK write duration. Existing RTP/RTCP instrumentation remains.
- `scripts/inspect-host.py` takes read-only PipeWire topology/format snapshots, hashes active helpers, samples CPU and thread scheduler wait, and captures `pw-top` counters. It does not inspect command arguments/environment, record media, or change routes.
- The quality harness accepts a real media file or existing desktop audio, supports real portal-selected screen capture, and compares enabled/minimized video while retaining the screen publication. Reports label source, screen type and `listeningValidated:false`. Real media cannot use the synthetic-tone stability assertion.

No frontend/backend permissions, global PipeWire routing, containers, deployment or video optimization were changed. The new helper was built and its native race tests passed. The controlled run stopped its helper when the screen stopped and closed its test browsers. The real-screen portal and real-file branches are prepared but have not been exercised in this investigation.

## Verify with listening, not only metrics

1. Use the rebuilt helper. Run `./native-audio/whiterun-audio --version`, then pair normally with an active real screen and start with a fresh `--timing-json /tmp/whiterun-listening-NEW.jsonl`. Compare its startup hash with `--version`. A rebuild does not replace an already-running process.
2. Keep the receiver of **this captured stream** muted on the captured HyperX output. Listen to the remote stream on a second machine/headset or a deliberately selected different physical output. The ALSA loopback used by automation is not an audible headset. Do not mute an unrelated friend's stream as a substitute for locating the returned copy. Whole-sink capture inherently includes any friend's audio played on that sink.
3. Play the same recognizable 2–3 minute music/speech file from the same start position. First listen locally with the remote return muted; then listen remotely outside the captured mix. Repeat separately in Chromium and Firefox, recording audible gaps/repetition and their timestamps. Keep local capture and remote playback comparisons distinct. No audio recording is enabled by these diagnostics.
4. While the real failure is present, run from the repository root:

   ```sh
   python3 native-audio/scripts/inspect-host.py --seconds 30 > /tmp/whiterun-listening-host.json
   ```

   Compare helper hashes, monitor links and receiver output links; two stereo links are not two captures. Compare successive active `pw-top` ERR counters rather than treating a historical nonzero total as a new underrun. Record receiver Audio diagnostics, especially buffer delay, concealment, element state and playback time.

5. For a repeatable diagnostic fixture in both browsers, use an existing source file and deliberately chosen distinct sinks:

   ```sh
   QUALITY_MEDIA_FILE='/absolute/path/to/music-or-speech.wav' \
   QUALITY_REAL_SCREEN=1 QUALITY_SECONDS=180 \
   QUALITY_CAPTURE_SINK='alsa_output.usb-HP__Inc_HyperX_Cloud_II_Wireless_0-00.analog-stereo' \
   QUALITY_PLAYBACK_SINK='alsa_output.platform-snd_aloop.0.analog-stereo' \
   QUALITY_RESULT_DIR='/tmp/whiterun-real-file-NEW' \
   node native-audio/scripts/quality-run.mjs
   ```

   Choose the real screen in the portal when prompted. The file plays on the selected capture sink and loops if shorter than the test. In the second half, the same screen track sends disabled/black video; authorization is not bypassed. This is a diagnostic load comparison, not a video optimization. The command's loopback output permits safe metrics only; audible validation needs a separate physical listening path. `QUALITY_DESKTOP_AUDIO=1` instead of `QUALITY_MEDIA_FILE` leaves the source applications untouched but is not a reproducible fixture.

If repetition disappears only when receiver playback leaves the captured output, that confirms feedback for that symptom. If stuttering remains, preserve the exact clip position, screen workload, both browser results, timing log and host snapshot. Until that comparison is completed, the real-world problem remains open.
