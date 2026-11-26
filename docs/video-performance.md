# Screen Share video performance review

Measured locally on 2026-11-26 against player revision `18178c2` and the working tree. The two-publisher slowdown is reproducible in Chromium’s **software VP8 encode path**. A change of codec alone recovered nearly all input frames on this host. Production SFU and receiver throughput still require endpoint measurements.

## Pipeline findings

- The Cloudflare player passes the browser’s display track directly to one send-only transceiver with one encoding. It has no application canvas, resizer, WebCodecs queue, bitrate ceiling, second video encoder or simulcast ladder. The same captured stream feeds the muted local preview. The controller excludes the publisher’s own video from subscriptions. Each remote publication has one receiving peer, stream and keyed video element. The separate LiveKit player has different sender settings and was outside this investigation.
- Before the change Chromium’s first offered video codec here was VP8. Two capture-only sources each delivered 58.87 FPS. Adding two VP8 encoders reduced delivery to 48.37 and 47.67 FPS. The two renderers spent a combined 7.09 CPU-seconds per second, and the test harness discarded 1,088 and 1,048 inputs at its encoder queue. With exactly the same source, frame size, scheduling flags and bitrate target, H.264 relieved both the encode backlog and capture slowdown. Codec-specific CPU contention explains this local failure. The precise scheduling behavior inside the codec and its prevalence on viewers’ machines are unverified.
- The publisher previously requested 60 FPS from capture even when a user chose 15 or 30 for the sender. Changing only the content preference also called `setParameters` on an otherwise identical encoding. Auto could identify quiet text but never selected the motion hint on sustained high input cadence.
- Focus used CSS to hide other tiles while their video elements continued to request autoplay. Roster and control updates re-entered every video component. The existing keys and stream effects already preserved element identity. Keeping subscriptions during focus changes avoids new SFU requests and keyframe acquisition. Whether pausing hidden presentation reduces decoder or transport load depends on the browser.

## Same-host measurements

One Linux host, Ryzen 7 9800X3D, eight logical CPUs available to the process, headless Chromium 158.0.8127.18, 1920 × 1080, one disposable browser and one tab and encoder per publisher. These were two independent captured browser tabs on the same host. Each tab rendered four columns of 16 px text with a moving translucent overlay, or a stationary desktop with one field changing each second. The harness requested 60 FPS, allowed three seconds to warm up, then counted input frames and encoded outputs against a common 30-second clock. The WebCodecs target was 8 Mb/s with realtime latency and at most two waiting input frames. Output for admitted inputs was drained after the window. All encoded dimensions were 1920 × 1080. The reported kb/s are elementary video bytes.

CDP identified SwiftShader, disabled hardware video encoding and zero hardware encode profiles. All four 1080p60 `prefer-hardware` configurations were rejected. All four `prefer-software` configurations were supported. The timed runs used the browser’s default acceleration preference in that same environment. The GPU-process CPU measurement includes software graphics work. It does not measure a physical GPU’s utilization. The probe also built real send-only browser offers for all four codecs, without starting ICE or sending media. Every offer had one encoding. Cloudflare lists all four formats and requires explicitly offered RIDs for simulcast. [SFU codec limits](https://developers.cloudflare.com/realtime/sfu/platform/limits/) · [SFU simulcast](https://developers.cloudflare.com/realtime/sfu/features/simulcast/)

### Moving sources

Pairs are in publisher order. The time columns below measure enqueue to encoded output callback, including waiting and callback scheduling. P95 gap is the inter-output callback gap. CPU columns give combined renderer and GPU-process **CPU cores used** across the whole browser. Each row uses a separate 30-second run.

| Codec / preference | Sources | Capture FPS | Encoded FPS | Actual kb/s | Queue skips | Mean / maximum enqueue to output, ms | P95 output gap, ms | CPU renderer / GPU process |
| --- | ---: | --- | --- | --- | --- | --- | --- | --- |
| Capture only | 1 | 58.80 | — | — | — | — | — | 0.02 / 0.21 |
| Capture only | 2 | 58.87 / 58.87 | — | — | — | — | — | 0.04 / 0.58 |
| VP8, baseline | 1 | 58.90 | 58.90 | 6507 | 0 | 3.63 / 94.5 | 21.2 | 0.93 / 0.22 |
| VP8, baseline | 2 | 48.37 / 47.67 | 12.10 / 12.73 | 1483 / 1598 | 1088 / 1048 | 564.54 / 823.2 and 537.41 / 840.2 | 133.4 / 126.8 | 7.09 / 0.49 |
| H.264 | 1 | 58.83 | 58.83 | 6541 | 0 | 1.08 / 3.2 | 17.4 | 0.17 / 0.22 |
| H.264 | 2 | 58.87 / 58.87 | 58.87 / 58.87 | 6511 / 6554 | 0 / 0 | 1.37 / 2.8 and 1.31 / 5.2 | 17.5 / 17.5 | 0.38 / 0.63 |
| VP9 | 1 | 58.80 | 58.80 | 6952 | 0 | 2.19 / 6.6 | 18.8 | 0.42 / 0.22 |
| VP9 | 2 | 58.83 / 58.83 | 58.83 / 58.83 | 6726 / 7020 | 0 / 0 | 2.89 / 12.6 and 3.03 / 14.1 | 18.8 / 19.1 | 0.91 / 0.64 |
| AV1 | 1 | 58.83 | 58.83 | 5156 | 0 | 1.82 / 5.5 | 17.5 | 0.43 / 0.23 |
| AV1 | 2 | 58.90 / 58.87 | 58.90 / 58.87 | 4768 / 5195 | 0 / 0 | 2.86 / 12.3 and 3.07 / 9.3 | 17.7 / 17.7 | 0.99 / 0.66 |
| H.264, Motion | 1 | 58.87 | 58.87 | 6548 | 0 | 1.14 / 6.8 | 17.4 | 0.18 / 0.23 |
| H.264, Motion | 2 | 58.87 / 58.80 | 58.87 / 58.80 | 6484 / 6529 | 0 / 0 | 1.50 / 6.1 and 1.42 / 6.4 | 17.6 / 17.7 | 0.40 / 0.65 |

The unmodified baseline script separately reproduced 58.80 FPS singly and 12.50 / 12.80 FPS concurrently. A control using VP8 with the Motion hint still produced 12.33 / 12.87 FPS concurrently, with 1,074 / 1,060 queue skips. In the instrumented baseline the two-source P95 capture gaps were 31.5 / 35.5 ms, versus 16.8 / 16.8 ms with H.264 Motion. Every input admitted by the instrumented moving-source harness produced an output. All moving runs above had zero additional keyframes after warm-up.

To measure codec service time separately from JavaScript queueing, a second series enabled Chromium media tracing and attributed each named codec call to the publishing renderer. With one VP8 publisher, `vpx_codec_encode` averaged 3.80 ms and peaked at 66.67 ms over 1,750 calls. With two, it averaged **96.57 / 93.23 ms** and peaked at **253.86 / 225.71 ms** over 309 / 321 calls. The 60 FPS frame budget is 16.67 ms. With H.264 Motion the trace identified `OpenH264::EncodeFrame`. One publisher averaged 1.15 ms with a 4.97 ms peak. With two, it averaged **1.58 / 1.45 ms** with **8.43 / 7.75 ms** peaks over 1,766 / 1,764 calls. These are elapsed times inside Chromium’s native encoder trace scopes. Tracing itself reduced concurrent VP8 throughput to 10.30 / 10.70 FPS in this repetition. Use the untraced table for throughput comparisons. [Chromium VP8 encoder](https://chromium.googlesource.com/chromium/src/+/HEAD/media/video/vpx_video_encoder.cc) · [Chromium OpenH264 encoder](https://chromium.googlesource.com/chromium/src/+/HEAD/media/video/openh264_video_encoder.cc)

A separate 30-second trace repetition attributed renderer CPU to each tab by its Chromium trace marker. The shared GPU process cannot be attributed to individual tabs. The columns below show publisher A / publisher B. These runs left the content hint at browser default for every codec. [Per-publisher trace results](video-performance-traces.jsonl)

| Codec | Renderer CPU cores | Mean native encode, ms | Peak native encode, ms |
| --- | --- | --- | --- |
| VP8 | 3.38 / 3.44 | 92.64 / 92.39 | 345.10 / 232.51 |
| H264 | 0.20 / 0.21 | 1.51 / 1.40 | 4.66 / 7.92 |
| VP9 | 0.46 / 0.48 | 2.81 / 3.12 | 13.35 / 15.88 |
| AV1 | 0.52 / 0.50 | 2.69 / 3.11 | 14.93 / 11.96 |

### Static text and fullscreen

The 1 Hz desktop delivered one native-resolution frame per update under both the earlier and candidate settings. VP8 with no hint used 129 kb/s with zero queue skips. VP8 detail used 109 kb/s with zero skips. In separate fidelity runs the harness stored eight frames starting at a requested keyframe, then compared a 512 × 256 text crop in the eighth encoded image against the matching captured frame. FFmpeg computed grayscale PSNR and SSIM offline with a null output. The reference conversion and the single crop limit interpretation. A high score here describes this text sample. Game imagery, color fidelity and subjective legibility at the viewer remain unmeasured.

| Native static text, one publisher | Capture / encoded FPS | kb/s | Queue skips | Text crop PSNR | Text crop SSIM |
| --- | --- | ---: | ---: | ---: | ---: |
| VP8, browser hint | 1 / 1 | 130 | 0 | 23.25 dB | 0.806853 |
| VP8, Clarity | 1 / 1 | 135 | 0 | 22.91 dB | 0.797713 |
| H.264, Clarity | 1 / 1 | 79 | 0 | 29.41 dB | 0.965778 |

Fullscreen **source capture** with motion produced 58.80 encoded FPS, 6383 kb/s and zero queue skips on VP8. H.264 Motion produced 58.87 encoded FPS, 6550 kb/s and zero skips. Both captured native resolution, with a 16.8 ms P95 input gap. The separate fullscreen **player** test used the built player with substitute media elements and signaling. It exercised actual Chromium fullscreen transitions without playing media.

| 30-second built-player fixture, two remote screens | Deployed baseline | Candidate |
| --- | ---: | ---: |
| Video component renders with a test-only counter | 38 | 8 |
| Peer allocations / subscriptions / non-null stream assignments | 2 / 2 / 2 | 2 / 2 / 2 |
| Video element replacements | 0 | 0 |
| Video elements requesting autoplay during focus / grid | 2 / 2 | 1 / 2 |
| Explicit video pauses / resumes over three focus cycles | 0 / 0 | 3 / 3 |

The browser entered fullscreen at 10 s and exited at 20 s in both runs. A second run against uninstrumented builds confirmed the same element and subscription counts. Mock sinks keep this test about player behavior. It cannot establish decoded FPS, GPU savings, display smoothness or freeze rate.

## Player changes

**Codec choice.** Auto uses the measured workload as its boundary. On Chromium at 1920 × 1080 with a 60 FPS target, a VP8-first sender and H.264 available, it asks the browser about both WebRTC configurations. If VP8 reports no power-efficient path and H.264 reports supported and smooth, it prefers H.264 on the initial offer. Other sizes, lower FPS, an efficient VP8 path, unavailable or slow capability queries and other browser engines retain the browser order. The 8 Mb/s value is a capability-query input only. Both local capability queries reported smooth even though two VP8 encoders stalled. The browser and SFU still negotiate the actual codec. Quality shows the observed implementation and power-efficiency flag when exposed. There is also a browser-default override and a pre-share preference for each supported codec. Profile and recovery formats remain in the offer. [WebRTC Media Capabilities](https://www.w3.org/TR/media-capabilities/)

**Content and cadence.** Native resolution and a 60 FPS ceiling remain the initial target. Clarity favors resolution when resources are tight. Motion favors frame rate and allows spatial adaptation. Auto enters Clarity after two 2-second intervals at ≤3 measured source FPS without a reported limitation, and Motion after three intervals at ≥24 source FPS. Separate exit thresholds of 6 and 15 FPS limit switching at a boundary. Sparse input under CPU or bandwidth pressure cannot enter Clarity. These thresholds classify source cadence, which is a proxy for motion. A browser delivering repeated static frames can misclassify the content. Manual profiles take precedence. Changes reuse the capture track and sender. Manual 15/30 FPS selections also limit source cadence where the picker supports updating constraints. [W3C content hints and degradation preferences](https://www.w3.org/TR/mst-content-hint/#behavior-of-an-rtcpeerconnection)

**Presentation.** Hidden focused-out tiles and a backgrounded document suspend video presentation. Returning to the grid or foreground resumes the same elements. A video visible in picture-in-picture continues presenting. Fullscreen targets the stage and keeps the controls available. Network subscriptions remain ready for immediate focus changes. The fixed grid fits the stage. No per-frame React state, canvas processing, new capture or extra encoding layer is involved. System-level occlusion and browser-specific decoder suspension remain browser decisions.

## Reproduction

From the repository root use the locked frontend dependencies, full Playwright Chromium and a writable disposable browser cache/config directory. The fidelity option also requires FFmpeg on the path. Run workloads serially. Each command prints aggregate numbers locally. Use `--count=1` or `--count=2` to select a single scenario.

```sh
node frontend/smoke/capture-quality.mjs --probe
node frontend/smoke/capture-quality.mjs --codec=capture
for codec in vp8 h264 vp9 av1; do node frontend/smoke/capture-quality.mjs --codec="$codec"; done
node frontend/smoke/capture-quality.mjs --codec=vp8 --hint=motion
node frontend/smoke/capture-quality.mjs --codec=h264 --hint=motion
node frontend/smoke/capture-quality.mjs --codec=vp8 --trace
node frontend/smoke/capture-quality.mjs --codec=h264 --hint=motion --trace
node frontend/smoke/capture-quality.mjs --count=1 --text --hint=detail --fidelity
node frontend/smoke/capture-quality.mjs --codec=h264 --count=1 --text --hint=detail --fidelity
node frontend/smoke/capture-quality.mjs --codec=vp8 --count=1 --fullscreen
node frontend/smoke/capture-quality.mjs --codec=h264 --count=1 --fullscreen --hint=motion
node frontend/smoke/player-presentation.mjs --profile-source frontend
```

For the UI comparison, point `--profile-source` at the frontend directory of revision `18178c2` with the same dependencies, then at the candidate. It builds a temporary player with a counter in the video component. Passing a build directory without this flag tests uninstrumented assets. The player fixture supplies only in-process media and room-state objects. It alternates grid and focus every five seconds and enters and exits fullscreen during the same 30 seconds.

## Verification on real endpoints and proposed rollout

1. Review and build the player assets with `npm --prefix frontend run build:player`. The only deployable change is the player bundle served by the existing Worker. Record its previous version with matching assets. The controller, Worker code, bot, SFU and native helper require no release.
2. When an isolated, authorized SFU environment and separate hosts are available, compare baseline and candidate using the same two test scenes, browser versions, hardware settings, window sizes and network. Use one publisher, two on the same host, then two on different hosts. Repeat in grid and focused fullscreen with the same receiver. Let negotiation and congestion control settle first. Use **Quality → Measure all screens for 30 s** on the candidate publishers and viewer at the same UTC start. On the earlier player collect the existing 2-second counters for the same interval. Keep the Quality panel open. A screen joining midway can be measured in the next window. Record the initial tile order and intended focus. Compare only complete windows and separate the browser-default, Auto, Clarity and Motion runs.
3. Compare capture to encoded/sent FPS and resolution, implementation, power-efficiency, encode cost and limitation. Compare sent to received FPS with payload rate, available uplink, RTCP loss, jitter and RTT to each SFU hop. Use decoded and displayed rates, decode cost, buffer residence, frame pacing, freezes, element drops and presentation state to locate receiver losses. A sender/viewer discrepancy warrants SFU-side forwarding or transport evidence before assigning it to the SFU. RTT is per hop. True application-to-display latency is unmeasured.
4. Promote the same reviewed assets only after verifying 1080p60 capture, encoding **and display** on capable hardware, two-stream stability, text clarity, focus changes, and the existing room and volume controls. Confirm the actual negotiated codec across Chromium and Firefox. Inspect the active encoder implementation in browser diagnostics. Hardware capability predictions alone cannot establish that acceleration ran.
5. For a codec-specific regression select **Browser default** before the next share. For a player regression restore the recorded Worker version with its matched HTML and hashed assets. Active tabs adopt restored code on reload. This review performed local builds and tests only.

Standard WebRTC stats expose accumulated encode time and frame counts. The 30-second report shows a frame-weighted mean and the worst observed two-second mean. Exact per-frame peaks and encoder input-queue drops are unavailable through portable RTP stats. The local harness measures its own queue and can optionally trace Chromium encoder calls. Displayed FPS uses the video element’s total-frame delta minus dropped frames. Target bitrate, available uplink, jitter and RTT include the observed two-second minima and maxima. Average QP is codec-specific. Missing browser counters are omitted, and delayed windows, replacement peers and reset frame counters are flagged. Physical GPU load, hardware encode capacity, real separate-host, SFU, and displayed-FPS results are outstanding. [WebRTC stats definitions](https://www.w3.org/TR/webrtc-stats/)

## Local validation

Frontend type checking, 168 Vitest regressions across 19 files, the production player build and the backend Go suite passed. The earlier build already emitted Vite’s large-chunk advisory. Real media integration tests were left disabled. The receiver benchmark used intercepted local files and mock signaling. No external room, audio output, routing, service or deployment was used.

## Files for review

| Area | Files |
| --- | --- |
| Publisher policy and controls | `frontend/src/videoCodec.ts`, `cloudflarePeer.ts`, `videoQuality.ts`, `PublishQuality.tsx` |
| Stage, focus and fullscreen | `frontend/src/CloudflareStage.tsx`, `player.css` |
| On-demand measurements | `frontend/src/RoomVideoBenchmark.tsx`, `videoMeasurement.ts`, `mediaStats.ts`, `CloudflareDiagnostics.tsx` |
| Regression tests | `frontend/src/videoCodec.test.ts`, `cloudflarePeer.test.ts`, `videoQuality.test.ts`, `videoMeasurement.test.ts`, `CloudflareDiagnostics.test.tsx`, `CloudflareStage.live.test.tsx`, `CloudflareStage.windows.test.tsx` |
| Local benchmarks | `frontend/smoke/capture-quality.mjs`, `frame-fidelity.mjs`, `player-presentation.mjs` |
| Findings and release plan | `docs/video-performance.md`, `video-performance-traces.jsonl` |
