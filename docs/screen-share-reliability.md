# Screen Share reliability review, 26 November 2026

This review covers the Discord room player served by the Worker. The baseline is commit `5b5141a`. The evidence consists of source history, controller and browser regression tests, and the local Chromium measurements below. A production incident trace, Windows workstation and authorized remote test SFU were unavailable during the local investigation.

## P0 · Authentication and continuity

| Proven behavior in the baseline | Consequence and fix |
| --- | --- |
| Any failed room-state request ran `removeAll()`, closed peers, sent track-close requests and stopped capture. Even one Worker 503 reproduced it. The previous retry ceiling of 60 seconds exceeded the controller's 20-second media heartbeat. | Keep healthy peers, subscriptions, focus and listener mixes across unsuccessful polls. Reconcile ownership against the next authorized snapshot. Active-media polling backs off from 2.5 to 5 to 6 seconds. A successful long-poll reply also acknowledges the listed live handles. An idle room can back off to 60 seconds. |
| The browser treated every media 401 and 403 as final voice denial. A lost ready acknowledgement discarded an otherwise connected publisher. | A 401 triggers one shared, same-entry join for the existing peer. Only a successful matching response permits replay of the refused request. A new login cannot be consumed by this recovery operation. Publication readiness can retry after transient failures at 1, 2 and 4 seconds. Ambiguous allocation failures still use the existing allocation cleanup. |
| The bot constructed a fresh Gateway client and generated fresh voice epochs after disconnect. A fresh snapshot of a member in the same channel was sufficient to invalidate the previous admission. | Attempt Gateway Resume with the existing sequence. While replaying, the voice authority reports unavailable. Return to service only after contiguous dispatches and RESUMED. An observed leave and return changes the epoch. A sequence gap or fresh Identify requires a new snapshot and invalidates the old membership. [Discord Gateway lifecycle](https://docs.discord.com/developers/events/gateway#resuming) |
| The controller exchanged the OAuth code using PKCE, called the user endpoint once and discarded both provider credentials and their expiry. The player's ten-hour expiry ran independently. Provider token expiry alone could not have caused the old player to log out. | Keep the provider credentials in controller memory and renew the identity proof automatically. Recheck the same Discord subject at most 15 minutes after a successful check, subject to the access-token expiry. Renew early, use the refresh grant when due or on an access-token 401, and serialize token rotation per login. A rejected grant, forbidden identity or subject change ends that admission. [Discord OAuth2](https://docs.discord.com/developers/topics/oauth2) |

Identity and voice are separate proofs. An early identity check can retry against its remaining verified lifetime. A rejected access token immediately loses that allowance. Identity retry delay doubles from one second up to 30 seconds. Expired identity proof or unavailable voice proof fails closed and the controller retires provider tracks. Recovery with the original voice epoch can rebuild viewer subscriptions to available publications. If a publisher's capture has ended, sharing again requires the picker. If Discord rotates a refresh token but its response is lost, a subsequent invalid_grant requires fresh sign-in. A known voice departure or block revokes the affected voice admissions immediately upon observation.

The pinned discordgo 0.29 client sends its stored Discord session ID and sequence on Resume using its cached Gateway URL. Discord recommends the dedicated resume URL to improve reconnect reliability. A real-guild reconnect remains a field check, and a failed replay requires fresh admission. [Discord Resume guidance](https://docs.discord.com/developers/events/gateway#preparing-to-resume)

The five-minute login handoff and the entry-specific room credential are opaque random references to controller memory. The room cookie is Secure, HttpOnly, host-only, SameSite=Strict and bound to the tab's entry key. The OAuth transaction cookie uses Lax for the redirect. The player and signaling API share an origin. The Worker checks the exact Origin, forwards an allowlist of headers and cookies, and preserves separate Set-Cookie headers. Reload reuses the history entry and rechecks admission. Starting another visit requires a fresh login. The HMAC-derived native control credential is separate from the browser login. The 45-second LiveKit JWT belongs to a different transport.

The absolute room deadline remains ten hours after first admission. Refreshes, retries, reloads and state polls cannot move it. The expiry screen offers **Sign in with Discord** for a fresh admission on the current page. A controller process replacement loses its in-memory sessions. The provider ownership journal supports forced media cleanup. Login recovery requires a fresh authorization after process loss. No production evidence established cookie eviction, controller restart, a Cloudflare outage or a specific token expiry as the cause of a reported incident.

| Result | Interpretation |
| --- | --- |
| 401 · session_missing | The presented cookie does not identify an eligible admission. One peer-bound rejoin is allowed. Continued 401 requires sign-in. |
| 403 · voice_absent, voice_channel_changed, voice_epoch_changed, room_denied or identity_revoked | Stop access. A publish_forbidden response rejects publishing while an independently authorized viewer may keep watching. |
| 410 · session_expired | The controller observed the room deadline during an authorized operation. An already discarded cookie can yield 401. The player's deadline also ends the room locally. |
| 409 on a state wait, 429, network interruption or 5xx | Retry the read with bounded backoff. Worker binding failures report controller_unavailable. A voice_unavailable response means fresh membership could not be established. |

Authenticated controller responses carry a server-generated `X-Session-Correlation` value. The corresponding structured `room_access` and `room_identity` events include `session_correlation`, `reason` and `status`. The Worker emits a fixed transport reason if it cannot reach the controller. The supplied Worker configuration disables hosted observability. Correlation uses an independent random value. The new logging fields exclude cookies, session credentials, Discord identifiers, tokens, room references, URLs, SDP, track labels and provider payloads.

Cloudflare media uses controller-owned provider sessions per track. The controller assigns the publisher deadline to its allocation and bounds subscriptions by both admissions. A healthy WebRTC connection can continue while browser HTTP signaling retries. The provider has its own 30-second media inactivity and reconnection conditions. A persistent failure of all provider closure paths remains the pilot's existing enforcement limitation. [Cloudflare limits](https://developers.cloudflare.com/realtime/sfu/platform/limits/) · [Existing watchdog evidence](cloudflare-sfu.md#public-release-blockers)

## P1 · Windows browser audio

The Windows checkbox started off on every share, so the normal path passed `audio: false`. Even when enabled, the player trusted the first live audio track from a window. Chromium's picker can fall back to system audio for a window when application capture is unavailable. Its capture-device implementation identifies that fallback and process-scoped audio with different track labels. The new player requests audio by default, remembers an explicit opt-out and still requires the browser picker on every share. [Chromium window picker](https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/ui/views/desktop_capture/desktop_media_picker_views.cc) · [Chromium capture-device names](https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/media/webrtc/desktop_capture_devices_util.cc)

The player requests system audio for a monitor and application audio for a window using Chromium's picker hints. It reads the selected video track's `displaySurface` after consent, checks for a live audio track matching the known scope and stops every other audio track before publishing. Tab, monitor and window are matched against Chromium's respective tab, system and application capture labels. These implementation-specific labels can change. An unknown scope yields a visible video-only state. A browser upgrade that changes the label requires revalidation. [Chrome capture options](https://developer.chrome.com/release-notes/141#windowaudio_for_getdisplaymedia)

### Windows acceptance record

Real Windows execution is **pending**. The tests run here use mocked picker tracks and WebRTC signaling. They verify full monitor, application window, browser tab, missing audio, system fallback on a window, unknown labels, explicit opt-out, audio ending, readiness and independent video continuation. The remote tests exercise subscription recovery, blocked autoplay and per-publisher volume with mocked media elements. Physical audibility remains unverified.

For a Windows 11 Chrome field check, record the OS build, browser version, chosen surface and results below. Use an approved existing share with the receiver's output muted before joining. Record aggregate counters and picker wording only. The review did not create or play test audio.

| Picker case | Expected publication | Evidence to record |
| --- | --- | --- |
| Entire Screen with system audio selected | Screen plus one Opus child track | System-audio status and parent/child readiness |
| Window with application audio selected | Screen plus one application-scoped Opus track | Application-audio status, receiver sees the matching screen |
| Window offering only system sound, or no audio | Video only | Visible limitation, zero audio publications |
| Browser tab with tab audio selected | Screen plus selected-tab Opus | Tab-audio status and matching receiver |
| Player opt-out, picker opt-out, stop sharing | Video only or publication withdrawal | No live audio sender after opt-out or stop |

In **Quality**, verify an acknowledged publication and increasing sender packets first. On the viewer, verify the matching subscription, negotiated Opus, increasing received packets and received samples, concealed samples and audio-energy delta. Finally inspect the element's playing/paused state, mute and volume. A playing element and received packets alone cannot establish audibility or program identity. A silent source can have zero energy. Audible listening and the isolation of unrelated applications remain unverified.

If a browser cannot return verifiable process-scoped audio, a separately approved Windows helper could reuse the owner's single-use pairing claim and existing screen-bound lease. A foreground native picker would show the window and owning application, identify the process and creation time, and request inclusion of that process tree only. WASAPI process capture can include other windows owned by that application. Show that scope before consent. Publish Opus only for the owned ready screen and stop on process exit, screen stop, lease loss or departure. Keep activation user-initiated. This is a design proposal. [Microsoft process capture sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/)

## P2 · Video quality

Commit `5265fa9` set `contentHint = 'motion'` on every hosted screen. That asks the browser to favor cadence during congestion, even on text-heavy windows. The code requested native dimensions up to 60 FPS and already used a single encoding with no application bitrate ceiling. No evidence tied the reported production blur to a specific bitrate, network hop or codec.

**Quality → Content preference** now defaults to **Automatic**. It uses the Quality diagnostics' measured source FPS and encoder limitation reason. After two consecutive two-second samples at three FPS or less with no reported resource limitation, it requests detail. Movement, resource pressure or missing measurements restore browser adaptation at the next sample. This conservative cutoff accommodates the one-update-per-second desktop in the benchmark. An encoder slowdown alone cannot select text mode. **Desktop and text** requests detail and resolution-first degradation. **Games and motion** requests cadence and framerate-first degradation. The publisher can switch on the existing track and retain the selected FPS and size. The browser's congestion controller can adapt and recover throughout a share. The production path uses the captured track directly. Focus, diagnostics and roster updates reuse keyed video elements. [W3C content hints and degradation preferences](https://www.w3.org/TR/mst-content-hint/#behavior-of-an-rtcpeerconnection)

Cloudflare supports simulcast when publishers advertise RIDs and subscribers select layers. This controller requests one remote track by publication name and the browser offers a single encoding. Adding layers would add publisher work and require a subscription policy. Focus currently keeps other decoders running. Two-stream receiver load and WAN congestion remain plausible contributors. [Cloudflare simulcast](https://developers.cloudflare.com/realtime/sfu/features/simulcast/)

### 30-second measurements

The offline benchmark uses real Chromium tab capture at 1920 × 1080 and a real, low-latency VP8 WebCodecs encoder per tab. The test source is generated text with either a moving overlay or a one-second text update. Each measurement follows three seconds of warm-up. It discards encoded output and skips input when two frames are already queued. The benchmark's 8 Mb/s target is a repeatable test setting. The production WebRTC sender has no corresponding cap. The two-source case shares one Linux host, an AMD Ryzen 7 9800X3D with eight logical CPUs visible to the process. Browser version was 158.0.8127.18.

| Workload | Concurrent inputs | Capture FPS | Encoded FPS | Encoded kb/s | P95 capture gap, ms | Frames skipped at encoder queue |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Moving overlay | One | 58.80 | 58.63 | 6,513 | 16.9 | 5 |
| Moving overlay | Two, A | 48.86 | 12.23 | 1,520 | 30.6 | 1,099 |
| Moving overlay | Two, B | 48.93 | 12.60 | 1,633 | 33.1 | 1,090 |
| Desktop text | One | 1.00 | 1.00 | 120 | 1,000.2 | 0 |
| Desktop text | Two, A | 1.00 | 1.00 | 116 | 1,000.2 | 0 |
| Desktop text | Two, B | 1.00 | 1.00 | 120 | 1,000.1 | 0 |

The text source changed once per second and delivered every update. In the two-motion run, capture cadence fell and the encoder queues discarded about three quarters of the captured frames. A network or receiver could not account for that local loss. The result establishes contention in this particular benchmark. The extent of CPU, GPU or bandwidth limitation in the reported production sessions still needs endpoint measurements. All six measured intervals contained zero additional keyframes after warm-up.

Reproduce from the checkout with `node frontend/smoke/capture-quality.mjs` and `node frontend/smoke/capture-quality.mjs --text`, using the full Playwright Chromium installation. The script confines capture to generated tabs in a disposable browser and disables audio. The figures measure the local input and encoder stages. SFU throughput, Windows hardware encoding, remote decode, perceived clarity and displayed FPS remain unmeasured.

For the outstanding end-to-end measurement, open the existing **Quality** diagnostics on both publishers and the viewer. After warm-up collect 15 consecutive two-second intervals for a single screen and for both visible screens, then repeat in focused view. Record the content preference, source and encoded dimensions, capture/encode/send/receive/decode/display FPS, bitrate and uplink estimate, limitation reason, encode ms/frame, keyframes, RTT, loss, jitter buffer, drops, freezes and element replacements. Use overlapping UTC intervals and count deltas divided by elapsed time. Missing counters remain unavailable. Inspect the first stage whose rate or dimensions fall. Expanded entries sample each inspected peer. Automatic content selection separately samples only the local video sender and ends when the share stops or the user selects a preference. [WebRTC statistics](https://www.w3.org/TR/webrtc-stats/)

## Delivery and rollback

The changed deployable components are Steve's Go voice-authority binary, the Go controller, and the Worker with its compiled player assets. The Linux native helper, SFU service, tunnel, routing, service files, API secrets and database schema require no deployment. The local regression coverage includes the Discord simulator, room lifecycle, Worker proxy, mocked Windows picker, sender/receiver stats and one- and two-publisher player behavior.

For an approved later rollout, retain the currently deployed binaries and the Worker version ID with its matching assets. Update the controller before the player that sends the optional `resumePeer` field. For rollback, restore the previous Worker version and assets together, then restore the matching prior controller and bot binaries during a maintenance window. Let the controller's existing journal/watchdog drain or reclaim owned media. Preserve the journal, configuration, helper pairing policy and service enablement. Replacing the controller requires fresh OAuth for in-memory admissions. A fresh bot Identify resets the membership epochs. The deployment operator can verify an authorized join and a denied voice departure using the existing pilot procedure. [Versioned rollout and rollback](cloudflare-private-player.md)

### Local checks and changed files

Frontend TypeScript checking, all 156 Vitest cases, both Vite production builds, all seven Worker tests, the backend Go suite under the race detector and `go vet ./...` passed. Vite reported a JavaScript chunk above its 500 kB warning threshold. The opt-in hosted, media-loopback and hardware-audio suites were excluded. The benchmark used an isolated configuration/cache directory for full Chromium. No production deployment, service restart, boot setting, PipeWire link or output routing change was performed.

| Directory | Files |
| --- | --- |
| `backend/cmd/discord-bot` | `main.go` |
| `backend/internal/discord` | `gateway.go`, `gateway_test.go`, `oauth.go`, `oauth_test.go`, `simulator.go` |
| `backend/internal/rooms` | `cloudflare.go`, `cloudflare_state.go`, `cloudflare_lifetime_test.go`, `discord.go`, `discord_test.go` |
| `deploy/worker` | `worker.mjs`, `worker.test.mjs` |
| `frontend/src` | `App.tsx`, `CloudflareStage.tsx`, `CloudflareDiagnostics.tsx`, `PublishQuality.tsx`, `mediaStats.ts`, `videoQuality.ts` |
| `frontend/src` tests | `CloudflareStage.test.tsx`, `CloudflareStage.live.test.tsx`, `CloudflareStage.windows.test.tsx`, `roomExpiry.test.tsx`, `mediaStats.test.ts`, `videoQuality.test.ts` |
| `frontend/smoke` | `capture-quality.mjs`, `sfu-media.mjs` |
| `docs` | `screen-share-reliability.md`, `cloudflare-private-player.md`, `cloudflare-sfu.md` |
