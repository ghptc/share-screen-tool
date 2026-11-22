# Screen Share private player and Discord OAuth

The Worker serves the compiled player and sends allowed OAuth and signaling requests over one host-and-port VPC Service binding. The single Linux controller owns the ten-hour sessions, four screen slots, SFU credential and durable track journal. Its separate bot holds the Gateway credential. Private admission requires both a listed tester identity and current membership of the mapped voice channel. The default Worker config has no public route, preview URL or backend binding.

**Public release is blocked.** The two-hour proposal has been superseded by fixed 36,000-second admissions with manual re-entry. Voice departures are checked during signaling and reconciliation. A total controller/watchdog outage or a persistent SFU control API outage can leave live media flowing beyond the authorization deadline. The private pilot does not resolve that limitation. Complete real-guild and hosted-route acceptance before considering wider access. [Established-media measurements](cloudflare-sfu.md)

For the running pilot, use the [Screen Share migration and rollback procedure](screen-share-migration.md). It stages the new Access-protected Worker, checks the replacement while Steve still serves the old link, and switches one controller and one bot during an approved handover.

## 1. Build and check locally

Use the existing Go toolchain, Linux user systemd and a supported Node installation. Start at the repository root. All Wrangler commands in this section run locally.

```sh
(cd frontend && npm ci && VITE_NATIVE_AUDIO_MODE=pair npm run build)
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
| `controller.env` only | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_PILOT_USERS` (comma-separated Discord user IDs, no wildcards), `CLOUDFLARE_SFU_APP_ID`, `CLOUDFLARE_SFU_APP_SECRET`. Optional `DISCORD_DENIED_USERS` takes precedence. |
| `bot.env` only | `DISCORD_BOT_TOKEN`. |
| `tunnel.token` only | Plain connector token for the dedicated remotely managed tunnel. |

The Worker uses the same value as `PLAYER_ORIGIN`. The controller listens on 127.0.0.1:18492 and the voice authority on 127.0.0.1:18491. Preserve the owner-only state and the unit's detached cleanup watchdog. [Local LiveKit credential recovery](discord.md#diagnose-the-origin-and-rotate-exposed-credentials)

## 3. Connect the private route

The [deployment procedure](screen-share-migration.md#2-stage-the-new-worker-and-its-access-policy) covers the exact target, Access rules, OAuth redirect registration, isolated rehearsal, health checks and rollback. For the working pilot, reuse its existing private tunnel and single-destination VPC Service. For a first installation, provision a dedicated Cloudflared tunnel with no public hostname, permit outbound UDP/TCP 7844, and bind a private HTTP VPC Service to 127.0.0.1:18492. The controller and bot require outbound HTTPS to the SFU and Discord and WebSocket access to the Discord Gateway. Workers VPC availability and SFU billing are separate account checks. [Private tunnel](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/) · [VPC Service configuration](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/)

## 4. Verify the hosted pilot

Use the deployed hostname for this check. A localhost client-authentication preflight and a mock Gateway run exercise different paths.

To use the outcome-only Firefox recorder for the deployed site, supply its private `/live` link as `SCREEN_SHARE_TEST_ROOM_URL` and run `node frontend/smoke/private-guild.mjs` from the repository root. This uses the browser's normal HTTPS trust store. Complete Access in the new window. The recorder checks the callback, admission, departure and wrong-channel re-entry.

1. Give a named tester in the configured voice channel the link from the real `/live` command. Complete Access and Discord OAuth. Expect a successful callback, a 200 room join and a connected player. With zero publishers the expected heading is **No active screens**.
2. Copy the link into a separate profile. Confirm a signed-out visitor encounters Access and Discord authentication. With a signed-in pilot tester in the wrong channel, expect a 403 on the room join. A member outside the tester list also receives a denial.
3. Leave or switch voice channels with the admitted player open. Verify the player loses access and the old session cannot obtain state. Reopen the same link while outside the channel and verify denial again. Record the time and outcome only. Avoid HAR exports and OAuth callback URLs.
4. For a separate video-only check, use two eligible testers, disable sharing audio, publish an approved screen and verify remote playback stops on departure. Keep hosted native pairing unapproved. The Cloudflare player still uses the workstation source bridge, which the Worker does not expose. Access also requires a browser identity on protected routes. The existing workstation audio implementation remains the reference.

The Worker incurs one dynamic request for a room page; matching JS and CSS are static asset requests. Idle room state waits up to 60 seconds and returns early on a change. A track-owning peer checks in at most 12 seconds apart under normal idle signaling to preserve the existing disconnect timeout. Per ten-hour visit, budget about **600** timed state requests without tracks or **3,000** with tracks, plus join, changes and other application traffic. Four continuously occupied tabs across successive visits imply 5,760 or 28,800 timed state requests/day respectively. The 100,000/day Free quota is shared with other dynamic requests. Failures back off to one attempt per minute. The Go monitor continues to reconcile locally. Workers and SFU egress have separate quotas. [Static asset billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) · [Realtime pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/)

## Shut down or roll back

Follow the [origin and edge rollback commands](screen-share-migration.md#rollback). Keep both Access protections, the existing tunnel, the production journal and Discord redirects through acceptance.
