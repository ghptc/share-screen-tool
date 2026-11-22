# Cloudflare Realtime SFU prototype

Use the prototype to test the existing SFU application's Connection API from a local Discord simulator. The release player uses LiveKit with its patched admission check, quality controls and PipeWire helper. The Cloudflare player supports screen video, automatic subscription, grid, focus and fullscreen. Browser capture still requires a click and the browser's screen chooser. Its default requests the captured source at up to 60 FPS.

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
./scripts/cloudflare-sfu player
```

Each hosted test uses real SFU traffic for two moving, generated 320×180 videos. Each sender targets at most 160 kb/s and 10 FPS. The driver has a 55-second deadline. Success requires both browsers to decode at least 12 frames, show the other publisher's color, release capture on stop and respond to voice-channel departure. The Go driver checks for pending provider closures. Session creation through the real provider authenticates the App Secret. A local run or a successful syntax check cannot establish that the provider accepts the credential.

The manual player starts a separate loopback frontend on port 5191, backend on 18492 and Discord fixture on 18491. Open the printed room link in a **private browser window** so the simulator's localhost OAuth cookie is isolated from the regular player. Ctrl-C stops those processes. Simulator credentials and room references are created for that run. Opening the room starts discovery. Clicking **Start sharing** authorizes video capture.

## Media and admission

1. The existing OAuth code exchanges the authorization code with PKCE. Joining requires the room directory mapping, a valid HttpOnly session, a fresh voice-channel epoch and the existing user restrictions. The server binds an opaque peer handle to the session and room.
2. Each control request checks the origin, session, peer, room and membership. The browser can request one sending video transceiver or subscribe to an available publication handle. The backend owns all SFU session IDs and chooses the upstream operations. It checks partial track errors and refuses redirects.
3. A lock reserves one of four publisher slots before allocating the upstream session. Pending publications and failed closures occupy slots. The sender announces readiness after ICE/DTLS connects. Additional authorized users can subscribe. A user does not subscribe to their own publications.
4. Each subscription gets a separate receiving PeerConnection. The SFU supplies its offer and the browser returns an answer. This trades extra peer connections for simple independent closure. The prototype uses Cloudflare's public STUN endpoint. Restrictive networks requiring TURN still need validation. [Browser connection recipes](https://developers.cloudflare.com/realtime/sfu/get-started/connection-patterns/)
5. A voice-state monitor rechecks active sessions every three seconds. A detected departure withdraws the publication and queues forced provider-side closure of its sending and receiving flows. A viewer departure closes that viewer's subscriptions. Unrenewed media leases expire after 20 seconds plus monitor scheduling. Provider failures retain the closure for retry. Previously received frames may remain buffered. [Track closure](https://developers.cloudflare.com/realtime/sfu/api/)

## Public-release blockers

The backend accepts `WHITERUN_MEDIA_TRANSPORT=cloudflare-prototype` only on a loopback listener in the explicit development Discord simulator profile. Each backend instance selects one media transport. Production Discord continues to require the patched LiveKit admission path.

The prototype tracks pending mutations, closures and slot ownership in memory. A backend crash can lose the identifiers needed to revoke continuously flowing media. A prolonged outage can delay closure. Cloudflare's 30-second inactivity timeout applies to tracks receiving no media. It does not terminate a live flow because an application heartbeat stopped. Before public admission, persist ownership and pending closures, reconcile them on restart, test actual provider-side cessation during partitions, and coordinate slots across backend instances. [Resource limits and timeouts](https://developers.cloudflare.com/realtime/sfu/platform/limits/)

Hosted two-way video, private-guild OAuth/Gateway sign-off, restrictive-network connectivity, real desktop FPS, native audio publication through Cloudflare and physical HyperX listening remain separate acceptance checks. Keep the release player on LiveKit until these pass.

## Native PipeWire audio

The existing helper selects authorized PipeWire application streams and mixes their PCM locally. Its libopus encoder produces 48 kHz stereo frames at 20 ms intervals. The existing `pumpOpus` accepts a sample writer. A direct Pion `TrackLocalStaticSample.WriteSample` can consume those frames using a send-only Opus transceiver. The prototype test exercises the existing encoder and pacer over a local DTLS/SRTP connection, checking payload identity and 960-tick RTP timestamp increments. [Cloudflare supported media codecs](https://developers.cloudflare.com/realtime/sfu/platform/limits/)

For a Cloudflare helper implementation, exchange the existing short-lived helper pairing grant for one backend-owned audio publication tied to an active, authorized screen. The helper should receive only signaling for that track. Keep the existing capture consent, source serial checks, local mix, lease and teardown on screen stop or voice departure. Count the owning screen once. The audio test uses generated stereo PCM and makes no physical listening or headset-isolation claim.

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
| Hosted Cloudflare media | Pending. Neither required SFU variable was present in the checkout's protected environment during this run. |
