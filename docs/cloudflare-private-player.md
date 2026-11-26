# Screen Share private player and Discord OAuth

The Worker serves the compiled player and sends allowed OAuth and signaling requests over one host-and-port VPC Service binding. The single Linux controller owns the ten-hour sessions, four screen slots, SFU credential and durable track journal. Its separate bot holds the Gateway credential. Discord OAuth identifies the viewer and the bot verifies membership in the mapped voice channel. The pilot list grants screen publishing permission. The default Worker config has no public route, preview URL or backend binding.

**Public release is blocked.** The two-hour proposal has been superseded by fixed 36,000-second admissions with manual re-entry. Voice departures are checked during signaling and reconciliation. A total controller/watchdog outage or a persistent SFU control API outage can leave live media flowing beyond the authorization deadline. The private pilot does not resolve that limitation. Complete real-guild and hosted-route acceptance before considering wider access. [Established-media measurements](cloudflare-sfu.md)

The running Screen Share hostname uses Discord admission without a Cloudflare Access login. The [original migration procedure](screen-share-migration.md) describes the earlier Access-protected handover. For a player-only update, use the versioned rollout below.

The participant strip includes signed-in viewers in this room. Multiple tabs for one Discord identity appear once. The strip uses the name and static avatar verified at login. An abruptly disconnected browser ages out after 75 seconds without a state request. A temporary voice-authority outage suspends media. The same tab can resume watching when the bot proves the original voice membership again, up to the original ten-hour deadline. A confirmed departure or changed membership epoch ends that admission.

## 1. Build and check locally

Use the existing Go toolchain, Linux user systemd and a supported Node installation. Start at the repository root. All Wrangler commands in this section run locally.

```sh
(cd frontend && npm ci && npm run build:player)
(cd deploy/worker && npm ci && npm test && npm run bundle)
node frontend/smoke/private-guild.mjs --check-setup
```

The last command checks the existing private Compose profile with Firefox, the project's public CA and a temporary browser profile. It expects a 401 on anonymous join and a 303 into Discord. For the human check, run the same command without `--check-setup`, sign in as the member currently in the first configured test channel, then move as instructed. It uses Firefox and `certutil`, omits request URLs and headers from its reports, and deletes its temporary profile on completion. [Local private profile](discord.md)

## 2. Prepare the one origin host

Choose a continuously available Linux host with outbound network access. Keep the bot, controller and tunnel connector on that host. Use a separate private Discord application or arrange an explicit handover of the existing bot. Running two Gateway clients for the same application and guild can produce conflicting command replies. Dedicate an SFU application to this single controller, or transfer its existing ownership journal after its previous controller and watchdog finish cleanup. Two controllers with independent journals cannot coordinate reservations or revocation.

The canonical units are `screen-share-controller.service` and `screen-share-bot.service`. Install the binaries and shared origin file using [local staging](screen-share-migration.md#1-prepare-locally). Existing installs continue to read `~/.config/whiterun-pilot/{controller,bot}.env` and use the same ownership directory. On a first install, create those role files and the tunnel token with mode 0600 in an owner-only directory. The existing tunnel unit is independent of the product name.

Use a protected editor for the two systemd environment files. Enter one assignment per line. Keep the project's workstation `.env` out of the build and transfer. Use distinct role credentials. Rotate any previously disclosed bot or SFU secret before private-stream use.

| File | Variables |
| --- | --- |
| Shared origin file (`~/.config/screen-share/player.env`) | `APP_ORIGIN=https://screen-share-player.gabrielhpittacosta.workers.dev`. Both replacement units load this last. |
| Both protected role files | `DISCORD_CHANNELS` (guild/voice pairs), `DISCORD_ROOM_KEY`, `DISCORD_VOICE_KEY`. Use the same mapping and voice key on both sides. Each key must contain at least 32 characters. |
| `controller.env` only | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_PILOT_USERS` (permitted publishers, comma-separated Discord user IDs, no wildcards), `CLOUDFLARE_SFU_APP_ID`, `CLOUDFLARE_SFU_APP_SECRET`. Optional `DISCORD_DENIED_USERS` takes precedence. |
| `bot.env` only | `DISCORD_BOT_TOKEN`. |
| `tunnel.token` only | Plain connector token for the dedicated remotely managed tunnel. |

The Worker uses the same value as `PLAYER_ORIGIN`. The controller listens on 127.0.0.1:18492 and the voice authority on 127.0.0.1:18491. Preserve the owner-only state and the unit's detached cleanup watchdog. [Local LiveKit credential recovery](discord.md#diagnose-the-origin-and-rotate-exposed-credentials)

## 3. Connect the private route

The [deployment procedure](screen-share-migration.md#2-stage-the-new-worker-and-its-access-policy) covers the exact target, Access rules, OAuth redirect registration, isolated rehearsal, health checks and rollback. For the working pilot, reuse its existing private tunnel and single-destination VPC Service. For a first installation, provision a dedicated Cloudflared tunnel with no public hostname, permit outbound UDP/TCP 7844, and bind a private HTTP VPC Service to 127.0.0.1:18492. The controller and bot require outbound HTTPS to the SFU and Discord and WebSocket access to the Discord Gateway. Workers VPC availability and SFU billing are separate account checks. [Private tunnel](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/) · [VPC Service configuration](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/)

## 4. Verify the hosted pilot

Use the deployed hostname for this check. A localhost client-authentication preflight and a mock Gateway run exercise different paths.

To use the outcome-only Firefox recorder for the deployed site, supply its private `/live` link as `SCREEN_SHARE_TEST_ROOM_URL` and run `node frontend/smoke/private-guild.mjs` from the repository root. This uses the browser's normal HTTPS trust store. The recorder checks the callback, admission, departure and wrong-channel re-entry.

1. Give a named tester in the configured voice channel the link from the real `/live` command. Complete Discord OAuth. Expect a successful callback, a 200 room join and a connected player. With zero publishers the expected heading is **No active screens**.
2. Copy the link into a separate profile. Confirm a signed-out visitor encounters Discord authentication. With a signed-in pilot tester in the wrong channel, expect a 403 on the room join. An authenticated member in the mapped channel who is outside the publisher list can watch.
3. Leave or switch voice channels with the admitted player open. Verify the player loses access and the old session cannot obtain state. Reopen the same link while outside the channel and verify denial again. Record the time and outcome only. Avoid HAR exports and OAuth callback URLs.
4. For a video-only check, use two eligible testers, disable sharing audio, publish an approved screen and verify remote video stops on departure.

### Previous Screen Share incident findings

The following table describes the earlier performance patch. The current player adds content preferences, verifies Windows audio scope and preserves healthy peers across interrupted state requests. [Current findings and measurements](screen-share-reliability.md)

The hosted Go controller exchanges SDP and associates one Cloudflare publication with each sending peer. The browser subscribes separately to video and audio. The available repository measurements include a generated 10 FPS Cloudflare fixture. They do not establish the capture, send or display rate of the reported production session. [Historical fixture settings](cloudflare-sfu.md#run-locally) · [Cloudflare session and track model](https://developers.cloudflare.com/realtime/sfu/concepts/sessions-tracks/)

| Symptom | Evidence from the hosted player path | Change |
| --- | --- | --- |
| Uneven 60 FPS video | The picker requested up to 60 FPS at the selected source dimensions. The default 60 setting skipped sender configuration. There was one video encoding, no application bitrate cap, and no motion preference. The Go subscription selected the published track by name, with no frame-rate or resolution conversion in the controller. The bottleneck in production remains undetermined. | Put the selected FPS ceiling on the initial encoding. Set the video content hint to `motion` so the browser can trade spatial detail for cadence. Keep congestion control active and expose actual sizes, rates and limits. [Content hint behavior](https://www.w3.org/TR/mst-content-hint/#behavior-of-an-rtcpeerconnection) |
| Silent remote audio | Windows screen audio requires opt-in and a live audio track from the picker. The controller accepts the child Opus publication only after its parent screen is ready. A successful subscription could still be silent when its independent video receiver was delayed, because there was no audio element. The old player also treated every `play()` rejection as an autoplay block. | Check readiness after applying the SFU answer and on connection changes, announce each connected publisher once, and attach received audio independently. Show the missing-source, connection, subscription-retry and playback states. **Enable audio** retries policy-blocked elements in the listener's click gesture. [Chrome picker controls](https://developer.chrome.com/docs/web-platform/screen-sharing-controls) |
| Missing publisher volume | The Audio panel iterated rendered video tiles and returned an empty row if the matching audio stream was absent. A mocked audio-first subscription reproduces a missing slider even with a live audio track. Display names were optional. | Build rows from the advertised screens and their audio subscriptions. A live audio receiver gets a local slider and mute button, with a numbered screen label if roster metadata is missing. A screen without an advertised audio publication shows **Video only**. |

Each remote video has its own peer and decoder. Focus hides other tiles with the HTML `hidden` attribute. It leaves their subscriptions active. Mocked focus, roster updates and a second publisher replacing a screen preserve the unaffected video element and its `srcObject`. A withdrawn publication or failed subscription can replace its media, and the earlier build tore down media on a failed room-state request. Browser scheduling, aggregate decode load and hidden-tab throttling still require endpoint measurements.

#### Reading an existing session

Open **Quality** and expand the relevant publisher and viewer diagnostics. Each open entry samples its existing peer about every two seconds. Compare overlapping UTC intervals for the same screen. Record the number of publishers, tile and tab visibility, capture size, encoded size and decoded size. Missing fields, counter resets and long gaps leave the corresponding rates unavailable. [WebRTC stats definitions](https://www.w3.org/TR/webrtc-stats/)

| First rate that falls | Evidence to compare |
| --- | --- |
| Measured capture | Compare the media-source frame count with the capture settings and the source's actual motion. An idle desktop can supply few distinct frames. |
| Encoded or sent | Compare encoder throughput, sender ceiling, encoder target, actual RTP bitrate, estimated uplink and the browser's CPU or bandwidth limitation reason. |
| Received | Compare complete inbound frames with frames sent on the matching publisher. Inspect uplink RTCP loss/jitter separately from downstream receiver loss/jitter. This narrows the gap to the transport or forwarding path. Attributing a drop inside the SFU requires provider-side evidence. |
| Decoded or displayed | Compare decoded FPS, receiver drops/freezes and the video's displayed FPS. The player derives displayed frames from the element's total frames minus dropped frames. High receiver frame-interval standard deviation reveals uneven pacing even when the average FPS looks good. Compare visible grid and focused views with one and multiple publishers. Record hidden intervals separately. |

For Windows audio, follow the picker result → parent screen ready → audio publish and ready → room `audio[screen]` → subscriber answer → inbound Opus packets and energy → element playback. A viewer can see whether the controller advertised audio for a screen. Only the publisher can distinguish declining audio in the picker from audio failing before advertisement. Linux uses its existing native helper for publication and the same remote Opus receiver. Browser sender stats apply to browser-published audio.

#### Acceptance criteria

- **60 FPS.** For a normally active 60 Hz or faster source and visible receiver on a 60 Hz or faster display, evaluate 30 seconds after warm-up at a recorded resolution. Proposed tolerance for 59.94/60 Hz is a 59–61 FPS time-weighted average at capture, encode, send, receive, decode and display, with every two-second displayed sample at least 57 FPS and no new freezes. Check one publisher and then two concurrently, with the target tile visible in grid and focus. Missing measurements leave that stage unverified.
- **Audio.** During ordinary non-silent program audio, require a live source, an acknowledged audio publication for the correct screen, a successful subscription, sustained inbound Opus packets, increasing decoded audio energy, and a playing, unmuted element at nonzero local volume. If Chrome blocks autoplay, a listener gesture must recover that publisher. Listener confirmation of the intended program sound establishes audible output. A quiet source alone cannot establish this.
- **Volume.** With two publishers, adjusting or muting A affects only A's element at that listener. B's playback, the senders and other listeners retain their levels. Closing the panel or focusing video preserves the mix. Audio arriving before video must still have a usable slider. With no audio publication, show **Video only**. With an advertised but failed subscription, show **Audio unavailable** during retry.

### Windows Chrome audio acceptance

1. Join the hosted room with a Windows 11 Chrome publisher and a second viewer. Keep the viewer muted. On the publisher, leave **Share audio** enabled, choose **Share my screen**, select a Chrome tab and enable tab audio in the picker. The publisher should see **Sharing tab audio**. If the viewer shows **Enable audio**, click it with the tab muted. Open **Audio** and check that the shared screen has audio controls. For a source with existing audio activity, verify increasing inbound audio RTP packets in the viewer’s `chrome://webrtc-internals`.
2. Stop sharing and repeat with a **Window**, then **Entire Screen**. For **Window**, select application audio if offered. Window-only publication requires a verified application track. For **Entire Screen**, system audio can include other apps and notifications. [Chrome screen capture controls](https://developer.chrome.com/docs/web-platform/screen-sharing-controls) · [Chrome window audio options](https://developer.chrome.com/release-notes/141#windowaudio_for_getdisplaymedia)
3. Keep **Share audio** enabled in the player and deselect audio in the picker. Video should continue with a visible **Video only** explanation. Stopping the screen should remove its audio controls on the viewer. Starting a new share requires the picker again and preserves the player checkbox preference.

### Linux native application audio

With an owned screen live and **Share audio** enabled, open **Audio**, select an application, then choose **Share application audio**. Opening the chooser reads PipeWire metadata. The share button creates the single-use claim, waits for the authenticated owner watch and delivers the claim to the workstation launcher. The browser may ask for loopback access and the workstation client certificate. **Pair manually** opens the existing terminal pairing flow. [Browser local network permissions](https://developer.chrome.com/blog/local-network-access)

The player shows **Connecting**, **Waiting** for an idle application, **Sharing audio** after the first accepted write, and **Stopped** when the audio session ends. Closing the panel keeps the session active. Stopping audio or the screen, closing the tab, and loss of Discord ownership end authorization through the existing watch and ten-second helper lease. The helper pins one application's PipeWire instance, serial and stereo links. Its idle startup budget is 30 seconds.

The claim expires after one minute. The helper uses that claim and its lease without browser cookies or a Cloudflare Access credential. To verify RTP delivery separately, check for increasing sender and receiver packet counters on the same publication with receiver playback disabled.

Viewers can open **Audio** to mute a remote publisher or adjust their local playback from 0 to 100%. Each publisher starts at 100%. The player remembers each choice for the room visit, including video focus changes, replaced publications and gaps in audio.

The Worker incurs one dynamic request for a room page; matching JS and CSS are static asset requests. Idle room state waits up to 60 seconds and returns early on a change. A track-owning peer checks in at most 12 seconds apart under normal idle signaling to preserve the existing disconnect timeout. Per ten-hour visit, budget about **600** timed state requests without tracks or **3,000** with tracks, plus join, changes and other application traffic. Four continuously occupied tabs across successive visits imply 5,760 or 28,800 timed state requests/day respectively. The 100,000/day Free quota is shared with other dynamic requests. An idle room backs off to one attempt per minute. Active media retries at most six seconds apart after each failed state request. The Go monitor continues to reconcile locally. Workers and SFU egress have separate quotas. [Static asset billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) · [Realtime pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/)

## Roll out the launcher and publisher volume

Run these steps manually from the repository root on the indicated machines. To verify the change before rollout, run the frontend unit suite and the in-memory Go fixtures.

```bash
(cd frontend && npm test && npm run typecheck)
(cd native-audio && go test . -run '^Test(HostedLauncher|IdleStartup|ApplicationLinkDiagnostics|BoundedRecorderStartup|StartupLeaseStopsWhileWaiting|StartupFirst)' -count=1)
(cd backend && go test ./internal/rooms -run '^TestScreenPublisherKeySurvivesReplacement$' -count=1)
```

**1. Enroll each publishing workstation once.** The launcher uses TLS on `127.0.0.1:18495`. The browser verifies the launcher certificate and presents its own workstation-specific client certificate. The launcher accepts JSON POSTs from the exact configured HTTPS player origin. Generate a distinct pair of end-entity certificates per desktop user. These commands are for a first install in Bash with OpenSSL, NSS tools, Go, libopus development headers and the existing PipeWire tools.

```bash
set -euo pipefail
umask 077
certdir="${XDG_CONFIG_HOME:-$HOME/.config}/screen-share/launcher"
install -d -m 700 "$(dirname "$certdir")" "$HOME/.local/lib/screen-share" "$HOME/.config/systemd/user"
mkdir -m 700 "$certdir"  # Stop on an existing enrollment.
(cd native-audio && go build -trimpath -o "$HOME/.local/lib/screen-share/hosted-audio" .)
openssl req -x509 -newkey rsa:2048 -noenc -days 365 -subj '/CN=Screen Share launcher' \
  -addext 'subjectAltName=IP:127.0.0.1' -addext 'basicConstraints=critical,CA:FALSE' \
  -addext 'extendedKeyUsage=serverAuth' -keyout "$certdir/server-key.pem" -out "$certdir/server.pem"
openssl req -x509 -newkey rsa:2048 -noenc -days 365 -subj '/CN=Screen Share browser' \
  -addext 'basicConstraints=critical,CA:FALSE' -addext 'extendedKeyUsage=clientAuth' \
  -addext 'keyUsage=critical,digitalSignature' -keyout "$certdir/browser-key.pem" -out "$certdir/browser.pem"
openssl pkcs12 -export -name 'Screen Share browser' -in "$certdir/browser.pem" \
  -inkey "$certdir/browser-key.pem" -out "$certdir/browser.p12"
```

Choose an export password at the prompt. Import into the publishing user's browser. For Chromium on Linux, use its existing NSS database as shown below. For Firefox, set `nssdb` to the intended profile's root directory shown in `about:profiles` and close that profile before the import. The `P,,` trust flag trusts the individual server certificate. Keep the client private key on the workstation. [Chromium Linux certificate management](https://chromium.googlesource.com/chromium/src/+/main/docs/linux/cert_management.md)

The supplied unit authorizes the production Worker origin. For another deployment, set `--player-origin` in the installed unit to the exact HTTPS origin of that player before enabling the service.

```bash
nssdb="$HOME/.local/share/pki/nssdb"
if [[ -f "$HOME/.pki/nssdb/cert9.db" ]]; then nssdb="$HOME/.pki/nssdb"; fi
# For Firefox, set nssdb to the chosen profile here.
test -f "$nssdb/cert9.db"
certutil -d "sql:$nssdb" -A -t 'P,,' -n 'Screen Share launcher' -i "$certdir/server.pem"
pk12util -d "sql:$nssdb" -i "$certdir/browser.p12"
rm -- "$certdir/browser-key.pem" "$certdir/browser.p12"
install -m 600 native-audio/screen-share-hosted-audio.service "$HOME/.config/systemd/user/"
# For another player origin, edit the installed unit here.
systemctl --user daemon-reload
systemctl --user enable --now screen-share-hosted-audio.service
systemctl --user is-active screen-share-hosted-audio.service
```

The daemon reads `server.pem`, `server-key.pem` and `browser.pem` from its user's configuration directory. Renew the certificates and repeat the browser import before expiry. Restart the launcher after replacing the files.

**2. Update the origin controller.** The room state now includes a screen-to-publisher mapping using the existing public, room-scoped participant key. Schedule the switch between rooms because a controller restart ends in-memory admissions. On the origin host, stage the binary, save the running version and switch it atomically during the maintenance window.

```bash
set -euo pipefail
bin="$HOME/.local/lib/screen-share/screen-share-controller"
backup="$bin.before-audio-$(date +%s)"
(cd backend && go build -trimpath -o "$bin.next" ./cmd/server)
cp -p "$bin" "$backup"
printf 'Controller rollback binary: %s\n' "$backup"
mv -T "$bin.next" "$bin"
systemctl --user restart screen-share-controller.service
systemctl --user is-active screen-share-controller.service
```

**3. Promote the player** using the versioned Worker procedure below. Reopen the room to load its new assets. Older controllers support mixing by current screen handle until the controller update supplies stable publisher keys.

**Rollback.** Restore the previous Worker version using the command below. To retire the new workstation listener, run `systemctl --user disable --now screen-share-hosted-audio.service`. Publishers can continue using manual pairing. To restore the controller during a maintenance window, use the saved path in `cp -p "$backup" "$bin.next" && mv -T "$bin.next" "$bin" && systemctl --user restart screen-share-controller.service`. Retain the existing ownership journal and watchdog.

## Player-only deployment and rollback

Run these commands manually from the repository root in a single Bash session. Use the existing generated config with its private controller binding. Record the currently serving Worker version before uploading. This procedure assumes one version is serving all traffic.

```bash
set -euo pipefail
cfg=deploy/worker/wrangler.screen-share.json
wrangler=deploy/worker/node_modules/.bin/wrangler
jq -e '.name == "screen-share-player" and
  .vars.PLAYER_ORIGIN == "https://screen-share-player.gabrielhpittacosta.workers.dev" and
  .assets.directory == "../../dist/screen-share-player" and
  any(.vpc_services[]?; .binding == "CONTROLLER")' "$cfg" >/dev/null
previous_version=$("$wrangler" deployments status --json --config "$cfg" |
  jq -er 'select((.versions | length) == 1 and .versions[0].percentage == 100) | .versions[0].version_id | strings | select(length > 0)')
printf 'Rollback Worker version: %s\n' "$previous_version"
npm --prefix frontend run build:player
"$wrangler" versions upload --dry-run --config "$cfg"
```

After approval, upload the version and enter the Worker version ID from Wrangler's output to promote it.

```bash
"$wrangler" versions upload --config "$cfg" --message "Hosted native audio pairing"
read -rp 'Uploaded Worker version ID: ' new_version
"$wrangler" versions deploy "${new_version}@100%" --config "$cfg"
```

To restore the recorded version, run the following command and reopen the room link to load its player assets. Existing tabs can retain their loaded JavaScript. [Cloudflare Worker rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)

```bash
"$wrangler" rollback "$previous_version" --config "$cfg" --message "Restore previous player"
```

## Origin rollback

For an origin handover, follow the [origin rollback procedure](screen-share-migration.md#rollback) for the intended target. Preserve the existing tunnel, ownership journal and Discord redirects.
