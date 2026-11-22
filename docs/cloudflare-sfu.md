# Cloudflare Realtime SFU prototype

Use the prototype to test the existing SFU application's Connection API from a local Discord simulator. The release player uses LiveKit with its patched admission check, quality controls and PipeWire helper. The Cloudflare player supports screen video, opt-in native application audio, automatic subscription, per-screen volume/mute, grid, focus and fullscreen. Browser capture still requires a click and the browser's screen chooser. Its default requests the captured source at up to 60 FPS.

## Run locally

Use the repository's Go and Node versions, installed frontend dependencies and installed Playwright browsers. From the checkout, run the offline test first.

```sh
./scripts/cloudflare-sfu test-local --browser chromium
./scripts/cloudflare-sfu test-local --browser firefox
```

The hosted test needs the **App ID and App Secret belonging to the same Realtime SFU application**. The Go backend sends the App Secret as a Bearer credential to the Connection API at `https://rtc.live.cloudflare.com/v1/apps/{appId}`. Account-management API credentials serve a different purpose. Replace a secret shared in chat before relying on it for private streams. [Connection API](https://developers.cloudflare.com/realtime/sfu/api/)

Use the backend environment or the Git-ignored, owner-only project `.env`. The expected names are `CLOUDFLARE_SFU_APP_ID` and `CLOUDFLARE_SFU_APP_SECRET`. An alternative protected file can be selected with `--env-file /path/to/file`. The launcher reads only those two assignments and validates their format without evaluating shell code. Browser builds and browser processes receive a separate environment.

```sh
./scripts/cloudflare-sfu test-hosted --browser chromium
./scripts/cloudflare-sfu test-hosted --browser firefox
./scripts/cloudflare-sfu test-hosted-audio --browser chromium
./scripts/cloudflare-sfu test-hosted-audio --browser firefox
./scripts/cloudflare-sfu test-crash
./scripts/cloudflare-sfu player
```

Each hosted test uses real SFU traffic for two moving, generated 320×180 videos. Each sender targets at most 160 kb/s and 10 FPS. The driver has a 90-second deadline. Success requires both browsers to decode at least 12 frames, show the other publisher's color, release capture on stop and respond to voice-channel departure. The Go driver checks for pending provider closures. Session creation through the real provider authenticates the App Secret. A local run or a successful syntax check cannot establish that the provider accepts the credential.

The manual player starts a separate loopback frontend on port 5191, backend on 18492 and Discord fixture on 18491. Open the printed room link in a **private browser window** so the simulator's localhost OAuth cookie is isolated from the regular player. Ctrl-C stops those processes. Simulator credentials and room references are created for that run. Opening the room subscribes to authorized remote tracks. Clicking **Start sharing** opens the browser or portal picker. With **Share audio** selected, an approved screen starts application discovery. The launcher requires PipeWire, its command-line utilities, a running user audio session and the native Go/libopus build dependencies. The test also uses pactl and the current default sink for quiet stereo fixture playback.

## Media and admission

1. The OAuth code exchanges the authorization code with PKCE. A fresh room visit requires a Discord identity, the mapped channel, a current voice-channel epoch and the existing user restrictions. A successful Cloudflare admission starts exactly **36,000 seconds** of authorization. A retry in the same browser history entry returns the same peer and deadline. The room credential lives in a Secure, HttpOnly, SameSite=Strict cookie. Only the navigation identifier and local expiry marker live in browser history.
2. Each control request checks the origin, session, peer, room and membership. The browser can request one sending video transceiver or subscribe to an available publication handle. The backend owns all SFU session IDs and chooses the upstream operations. It checks partial track errors and refuses redirects.
3. A lock reserves one of four publisher slots before allocating the upstream session. Pending publications and failed closures occupy slots. The sender announces readiness after ICE/DTLS connects. Additional authorized users can subscribe. A user does not subscribe to their own publications.
4. Each subscription gets a separate receiving PeerConnection. The SFU supplies its offer and the browser returns an answer. This trades extra peer connections for simple independent closure. The prototype uses Cloudflare's public STUN endpoint. Restrictive networks requiring TURN still need validation. [Browser connection recipes](https://developers.cloudflare.com/realtime/sfu/get-started/connection-patterns/)
5. A voice-state monitor rechecks active sessions every three seconds. A detected departure withdraws the publication and queues forced provider-side closure of its sending and receiving flows. A viewer departure closes that viewer's subscriptions. After a browser disconnect, 20 seconds of missing track presence plus monitor scheduling triggers cleanup. The backend releases the slot when Cloudflare confirms closure of the requested track or reports that its session has ended (HTTP 410 with `session_error`). Ambiguous responses keep the slot reserved for retry. Previously received frames may remain buffered. [Track closure](https://developers.cloudflare.com/realtime/sfu/api/) · [Provider error codes](https://developers.cloudflare.com/realtime/sfu/observability/error-codes/)
6. The deadline is fixed at admission. State requests report track presence and return room changes without extending it. At expiry the player releases capture, closes peer connections and displays **Session expired — reopen the link**. Reloading that history entry keeps it expired. Close the tab and open the original Discord link again for a fresh OAuth flow and membership check. The server can verify a new authorization and voice epoch. Physical tab closure is a browser action.

### Screen publication stops before the publish request

After the desktop picker returns, the browser adds the approved video track, creates an offer and sets its local description. The current player waits up to eight seconds for ICE gathering to reach `complete` before sending the offer to the controller. Its peer configuration uses `stun:stun.cloudflare.com:3478` and has no TURN relay configured.

With this build, Firefox Web Console's **Debug** level shows one **Screen ICE** summary on gathering completion or timeout. The player also shows the summary on timeout. It contains the gathering state, milliseconds since setting the local description began, candidate types in the offer and two observations up to that instant. **Complete event** means the browser reported a state change to `complete`. **Null candidate event** means the browser delivered the final null candidate. A browser can deliver that event after the summary. Only the summary is needed for a report.

An offer containing `srflx` has a server-reflexive candidate. An offer containing only `host` has local-interface candidates. Either result requires an actual connection check against the SFU to establish reachability. The Connection API accepts an SDP offer on `tracks/new` and returns an answer. It documents no endpoint for trickling additional candidates. Cloudflare’s example permits its bounded wait to finish with candidates already present in the local SDP. The current player still rejects an incomplete gather at its deadline. [Connection API](https://developers.cloudflare.com/realtime/sfu/api/) · [Cloudflare’s bounded ICE example](https://github.com/cloudflare/realtime-examples/blob/main/cloud-gaming/src/client/webrtc.ts#L38-L62)

## Public-release blockers

The backend accepts `SCREEN_SHARE_MEDIA_TRANSPORT=cloudflare-prototype` only on a loopback listener in the explicit development Discord simulator profile. Each backend instance selects one media transport. A separate loopback-only `cloudflare-private` profile requires real Discord OAuth, an explicit pilot user list and voice-channel membership. The regular private Discord profile uses patched LiveKit. [Workers pilot deployment](cloudflare-private-player.md)

### Durable ownership and failure recovery

The controller writes each track allocation to an owner-only, app-specific Linux directory before sending the attachment request to Cloudflare. The journal records the provider session, direction, opaque publication name, known MID and absolute authorization deadline. A subscription uses the earlier of the publisher and viewer deadlines. The journal stores no bearer credentials or OAuth cookies. File and directory syncs make the record durable across restart. A session without an attached track carries no media. The local launcher keeps the journal under `.local-player/cloudflare-ownership`. Preserve this directory across process restarts.

A detached watchdog holds the exclusive directory lock and checks for due records once per second, including while the controller is suspended. Controller death interrupts this sweep and triggers forced closure of every recorded track. The watchdog retries unconfirmed closures with backoff during crash recovery. It is armed before startup recovery. If startup recovery times out, admission fails and the watchdog continues retrying. An ambiguous track-close error triggers a separate provider query. A matching inactive track or a terminal session response acknowledges recovery. Fresh controllers require new OAuth/room grants. One journal path permits one active controller for this SFU app on the workstation. [SFU Connection API](https://developers.cloudflare.com/realtime/sfu/api/)

**Public exposure remains blocked.** Cloudflare documents a forced track-close operation and inactivity timeouts. Its published session creation schema exposes no application-selectable absolute media expiry. The ten-hour cutoff for new application requests is exact. Stopping an existing WebRTC flow requires a functioning watchdog or controller, an intact journal, valid provider credentials and a reachable control API. Scheduler delay, outstanding operations, buffered packets and provider response time can extend delivery past the deadline. Under total host loss or sustained control API failure, there is no demonstrated upper bound. Rotate credentials previously shared in chat before private-stream use. [Connection API schema](https://developers.cloudflare.com/realtime/static/realtime-api-2024-05-21.yaml) · [Provider timeouts](https://developers.cloudflare.com/realtime/sfu/platform/limits/)

An off-host recovery option would commit the provider session, track direction and immutable deadline to a separate durable store **before** attachment, deny new media when that write fails, and independently schedule forced closure. The recovery process would need its own network path, access to the provider credential, and authenticated service access to the journal. It would retain pending records until provider confirmation and resume them after outages. This design could cover loss of the controller host. Loss of every path to the provider control API would still leave a continuously sending connection without a hard deadline. Multi-host admission would also require a shared atomic four-publisher limit. [Workers plan and quotas](cloudflare-workers.md)

### Reproduce the session checks

These commands use the configured SFU app, two generated videos and a simulated Discord authority. The browser tests advance the clocks by ten hours during active playback. The watchdog test gives actual hosted tracks a short test deadline and keeps their WebRTC endpoints running independently.

```sh
./scripts/cloudflare-sfu test-video-expiry --browser chromium
./scripts/cloudflare-sfu test-video-expiry --browser firefox
./scripts/cloudflare-sfu test-video-deadline
```

| Scenario | Observed on 2026-11-22 |
| --- | --- |
| Fixed admission | Eight concurrent retries returned one peer. One nanosecond before expiry its deadline was unchanged. At the boundary the cached room credential and peer lost access. A fresh eligible login received 36,000 seconds. A wrong-channel login was denied. |
| Chromium and Firefox | Both participants decoded 12 remote frames at 320×180 in each engine. Advancing the clocks ended both captures and peer connections. Reloading the expired tabs made zero authorization requests. After closing a tab and reopening the link, each engine completed a fresh simulated Discord OAuth callback and joined without starting capture. Explicit stop and simulated voice departure also passed in separate hosted runs. |
| Only controller suspended | Cloudflare confirmed the publisher closed 980 ms after its deadline and the subscriber closed 1.484 s after its deadline in separate runs. Following a 350 ms drain, neither receiver received another packet during the next second. |
| Controller and watchdog suspended | The receiver counted 10 video RTP packets in a one-second interval entirely after expiry. After resuming only the watchdog, closure was confirmed 2.133 s after expiry. |
| Controller killed | Cloudflare confirmed closure after 566 ms. The replacement controller acquired ownership, and the receiver observed zero packets in the final one-second observation window. |

The private-guild stack runs the patched LiveKit transport. Its copied room link returned HTTP 401 at the join endpoint. The real bot, configured guild/channel, registered slash command, callback and OAuth client passed private preflight. Discord REST returned 404 for the installed bot’s own voice state, and the real private Gateway authority returned 403 for that guild member with no voice connection. A real Firefox user completed OAuth on the localhost private LiveKit stack and connected in the correct channel. Following a move, the old session returned 401 and a fresh OAuth admission and a reopened link both returned 403. The public-hostname pilot still needs a separate acceptance run. The hosted Cloudflare media tests below use a simulated Discord authority. Restrictive-network/TURN, real native-display FPS and physical HyperX listening remain separate acceptance checks.

## Native PipeWire audio

The player reuses its existing `Share audio` preference, application picker and screen-bound owner watch. A one-use pairing code reaches the helper over a private desktop socket. Claiming it requires a current voice membership and an active screen. The claimed helper receives a short-lived lease scoped to one Opus sender on that screen. Only the backend knows the provider credential. It rejects video, extra media sections, foreign screens and duplicate audio publications on this path. The helper consumes zero additional screen slots.

The helper negotiates a send-only Pion track, then taps the selected application outputs with the existing PipeWire serial and link checks. It retains the stereo mixer, libopus encoder and 20 ms pacing. Local application and remote browser streams continue to play through the selected physical output. Each receiver negotiates stereo Opus explicitly. The player has one renderer per remote screen, independent volume/mute and a single autoplay activation control. A user never subscribes to their own audio. Ending the watch, revoking audio or losing voice authorization withdraws the helper lease. Screen closure also retires its audio and associated subscriptions.

The hosted audio command starts two independent browsers and launchers on one workstation. Each simulated Discord user can select only their own test-owned stereo source. Each source plays different tones on the current default sink. The test checks for zero capture links before consent, exactly two authorized PipeWire links per game during simultaneous publishing and reception, separate local and browser stereo playback into the same headset, and zero capture links after departure. It toggles audio off and back on while keeping video live. Web Audio measures the four tone frequencies in each decoded channel and checks for local audio returning through the other publisher. Human listening with a real game is still pending.

## Usage and validation evidence

Cloudflare currently includes 1,000 GB of shared SFU and TURN egress per month and charges USD 0.05/GB above it. SFU ingress is free. A 4 Mb/s screen uses approximately 1.8 GB of egress per viewer-hour before overhead. Each additional subscriber adds traffic. The App Secret authenticates media signaling and does not establish remaining account allowance. The launcher provisions no Cloudflare resources. [Realtime pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/)

The Connection API allows 50 requests per second per session and up to 64 tracks per request. This implementation negotiates one track per session and serializes its mutations. [Platform limits](https://developers.cloudflare.com/realtime/sfu/platform/limits/)

| Check | Result on this workstation |
| --- | --- |
| Two independent Chromium contexts, local RTP forwarder | Both decoded 12 remote frames at 320×180. Stop and simulated voice departure released capture. |
| Two independent Firefox contexts, local RTP forwarder | Both decoded 12 remote frames at 320×180 with the same stop and departure checks. |
| Backend authorization and SFU contract | Race-tested copied-link denial, wrong channel, other session's peer, self-subscription, extra media sections, channel switch, cached session denial, four of eight concurrent reservations and closure retries. |
| Native Opus feasibility | 25 generated stereo Opus frames traversed a local Pion connection with byte-identical payloads and consecutive 960-tick RTP steps. |
| Existing LiveKit quality regression | Generated receiver sample at 1280×720, 29.7 decoded FPS, VP8, zero dropped frames and zero measured packet loss. |
| Hosted Cloudflare SFU, Chromium | Two simultaneous publishers decoded 12 and 13 remote frames at 320×180. Explicit stop and simulated voice departure passed. Zero pending provider closures at teardown. |
| Hosted Cloudflare SFU, Firefox | Both publishers decoded 12 remote frames at 320×180. Explicit stop and simulated voice departure passed. Zero pending provider closures at teardown. |
| Continuously sending hosted peer after signaling-controller SIGKILL | The final run confirmed the publication inactive in 432 ms and an independent subscription closed in 495 ms while its publisher stayed active. After allowing 400 ms for in-flight packets, neither receiver got another packet in the next 1.2 seconds. For both directions a timed-out restart denied admission, the watchdog recovered the outstanding record and a fresh controller acquired ownership. |
| Chromium, two screen and stereo audio publishers | Across 2.12-second windows the two receivers counted 96 and 97 additional Opus packets, one and zero lost, and 2,592 and 1,152 concealed samples. Both decoded 12 remote video frames. At the reported sample the strongest own-game tone in either receiver was at least 56 dB below its wanted tone. |
| Firefox, two screen and stereo audio publishers | Across 2.13-second windows the two receivers counted 95 and 94 additional Opus packets, five lost each, and 4,944 and 4,864 concealed samples. They decoded 12 and 13 remote video frames. The strongest own-game tone was at least 57 dB below its wanted tone at the reported sample. |
| Both hosted audio runs | Each receiver had one audio renderer. Revoking and reauthorizing one game while video stayed live, explicit screen stop, voice-departure revocation, headset graph inspection, capture removal and provider closure passed. |
| Local prototype launcher | The actual Vite player completed simulated Discord login, served native source inventory through the protected desktop bridge and made zero display-capture requests at entry. |

The tone levels come from each browser's Web Audio FFT. Loss and concealment come from its WebRTC receiver counters. Firefox concealed about 101–103 ms of samples per receiver over 2.13 seconds at 48 kHz. Sustained native-game playback, two physical endpoints and subjective HyperX listening still need validation.

For the existing LiveKit fallback, `scripts/test-game-audio` ran 16 browser cases per engine with five explicitly gated cases skipped per engine. The first 60-second physical routing run exceeded its 0.01 own-tone ratio threshold in one 100 ms block (0.0216). In an isolated 60-second repeat on the same headset, the worst own-tone levels were −77.6 dB and −49.1 dB relative to the remote signal. Both receivers rendered 2,654,400 measured stereo frames. The volume change measured 2.006× for the adjusted receiver and 1.000× for the other, and helper-interruption cleanup passed. Reproduce the isolated check with `PLAYER_AUDIO_TEST_SINK="$(pactl get-default-sink)" ./scripts/test-game-audio --headset-only` after verifying the current default is the intended headset.
