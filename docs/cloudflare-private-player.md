# Private Workers player and Discord OAuth

The Worker serves the compiled player and sends allowed OAuth and signaling requests over one host-and-port VPC Service binding. The single Linux controller owns the ten-hour sessions, four screen slots, SFU credential and durable track journal. Its separate bot holds the Gateway credential. Private admission requires both a listed tester identity and current membership of the mapped voice channel. The default Worker config has no public route, preview URL or backend binding.

**Public release is blocked.** The two-hour proposal has been superseded by fixed 36,000-second admissions with manual re-entry. Voice departures are checked during signaling and reconciliation. A total controller/watchdog outage or a persistent SFU control API outage can leave live media flowing beyond the authorization deadline. The private pilot does not resolve that limitation. Complete real-guild and hosted-route acceptance before considering wider access. [Established-media measurements](cloudflare-sfu.md)

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

```sh
umask 077
install -d -m 700 ~/.local/lib/whiterun-pilot ~/.config/whiterun-pilot ~/.local/state/whiterun-pilot ~/.config/systemd/user
(cd backend && go build -trimpath -o ~/.local/lib/whiterun-pilot/server ./cmd/server)
(cd backend && go build -trimpath -o ~/.local/lib/whiterun-pilot/discord-bot ./cmd/discord-bot)
install -m 600 deploy/worker/origin/*.service ~/.config/systemd/user/
touch ~/.config/whiterun-pilot/{controller.env,bot.env,tunnel.token}
chmod 600 ~/.config/whiterun-pilot/{controller.env,bot.env,tunnel.token}
systemctl --user daemon-reload
```

Use a protected editor for the two systemd environment files. Enter one assignment per line. Keep the project's workstation `.env` out of the build and transfer. Use distinct role credentials. Rotate any previously disclosed bot or SFU secret before private-stream use.

| File | Variables |
| --- | --- |
| Both environment files | `APP_ORIGIN=https://whiterun-private-player.<ACCOUNT_SUBDOMAIN>.workers.dev`, `DISCORD_CHANNELS` (guild/voice pairs), `DISCORD_ROOM_KEY`, `DISCORD_VOICE_KEY`. Use the same mapping and voice key on both sides. Each key must contain at least 32 characters. |
| `controller.env` only | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_PILOT_USERS` (comma-separated Discord user IDs, no wildcards), `CLOUDFLARE_SFU_APP_ID`, `CLOUDFLARE_SFU_APP_SECRET`. Optional `DISCORD_DENIED_USERS` takes precedence. |
| `bot.env` only | `DISCORD_BOT_TOKEN`. |
| `tunnel.token` only | Plain connector token for the dedicated remotely managed tunnel. |

Use the callback printed by `configure.mjs --callback`. Remove the final `/api/discord/callback` and enter the remaining literal HTTPS origin as `APP_ORIGIN` in **both** protected files. The generator sets the same value as `PLAYER_ORIGIN` in the Worker. The systemd units read their own environment files on start. The Cloudflare controller uses no LiveKit admission key. For the localhost profile's separate credential rotation, see [private Compose recovery](discord.md#diagnose-the-origin-and-rotate-exposed-credentials).

After editing these files on an installed pilot host, apply the new origin to the controller and bot together. First confirm that the pilot has a dedicated bot application if the localhost bot is running concurrently. The tunnel configuration is independent of this change.

```sh
systemctl --user restart whiterun-pilot-controller.service whiterun-pilot-bot.service
systemctl --user is-active whiterun-pilot-controller.service whiterun-pilot-bot.service
curl -fsS http://127.0.0.1:18492/healthz
```

The controller listens on 127.0.0.1:18492 and the voice authority on 127.0.0.1:18491. No inbound host ports need opening. The user service manager must remain active for the duration of the pilot. The controller unit uses `KillMode=process` so its detached watchdog can finish provider cleanup after a stop or crash. Preserve the owner-only state directory through updates and rollback.

## 3. Connect the private route

1. Select Workers **Free**, configure the account's workers.dev subdomain, and check current SFU egress usage. Workers VPC is free on all Workers plans during its beta. Recheck availability and pricing before creating anything. No Durable Object, KV namespace, cron trigger or paid domain is needed. [VPC availability](https://developers.cloudflare.com/workers-vpc/get-started/) · [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
2. In Cloudflare One, create a dedicated remotely managed **Cloudflared** tunnel. Leave public hostnames and published applications empty. Install `cloudflared` 2025.4.0 or newer on the origin and place its connector token in `tunnel.token`. Permit outbound UDP/TCP 7844. The Go host also needs outbound HTTPS for Discord and the SFU and WSS for the Discord Gateway. [Tunnel parameters](https://developers.cloudflare.com/tunnel/reference/run-parameters/) · [Private tunnel](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/)
3. From the repository root, start only the pilot services and verify the private listener. Configure Discord Guild Install with `bot` and `applications.commands`, leave the Interactions Endpoint URL empty, and register the **exact** callback `https://whiterun-private-player.<ACCOUNT_SUBDOMAIN>.workers.dev/api/discord/callback`. The backend uses the identify scope and code flow with S256 PKCE. Keep the localhost redirect registered for the existing private stack. [Discord setup](discord.md)

   ```sh
   systemctl --user start whiterun-pilot-controller whiterun-pilot-bot whiterun-pilot-tunnel
   systemctl --user is-active whiterun-pilot-controller whiterun-pilot-bot whiterun-pilot-tunnel
   curl -fsS http://127.0.0.1:18492/healthz
   ```

4. From `deploy/worker`, authenticate Wrangler for the intended Free account. The operator needs permission to manage the Worker and the VPC Service. Set the shell variables `ACCOUNT_SUBDOMAIN` and `TUNNEL_UUID` from the dashboard. Set `VPC_SERVICE_UUID` to the service ID returned by the create command before running `configure.mjs`. The service permits a single destination through that connector. [VPC Service configuration](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/)

   ```sh
   cd deploy/worker
   npx --no-install wrangler login
   npx --no-install wrangler whoami
   npx --no-install wrangler vpc service create whiterun-controller --type http --tunnel-id "$TUNNEL_UUID" --ipv4 127.0.0.1 --http-port 18492
   node configure.mjs "$ACCOUNT_SUBDOMAIN" "$VPC_SERVICE_UUID"
   npx --no-install wrangler deploy --config wrangler.private.json --dry-run
   npx --no-install wrangler deploy --config wrangler.private.json
   ```

   This first upload leaves workers.dev and preview URLs disabled. No provider, bot or user secrets belong in Wrangler variables or the static bundle.

5. Enable the workers.dev shell **without a controller binding**, so no private session or media is reachable during Access setup.

   ```sh
   node configure.mjs "$ACCOUNT_SUBDOMAIN" "$VPC_SERVICE_UUID" --access-setup
   npx --no-install wrangler deploy --config wrangler.private.json
   ```

   In **Workers & Pages → whiterun-private-player → Settings → Domains & Routes**, enable Cloudflare Access for the workers.dev URL. Configure its Allow policy for the individual tester identities on the Zero Trust Free plan. Keep preview URLs disabled. Before connecting the controller, verify a signed-out private window is stopped by Access and an approved tester can reach the shell. Only then attach the private binding. Discord OAuth, the server-side tester list and the voice check still apply after Access. [Protect workers.dev with Access](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)

   ```sh
   node configure.mjs "$ACCOUNT_SUBDOMAIN" "$VPC_SERVICE_UUID" --private-pilot
   npx --no-install wrangler deploy --config wrangler.private.json
   ```

## 4. Verify the hosted pilot

Use the deployed hostname for this check. A localhost client-authentication preflight and a mock Gateway run exercise different paths.

To use the outcome-only Firefox recorder for the deployed site, supply its private `/live` link as `WHITERUN_TEST_ROOM_URL` and run `node frontend/smoke/private-guild.mjs` from the repository root. This uses the browser's normal HTTPS trust store. Complete Access in the new window. The recorder checks the callback, admission, departure and wrong-channel re-entry.

1. Give a named tester in the configured voice channel the link from the real `/live` command. Complete Access and Discord OAuth. Expect a successful callback, a 200 room join and a connected player. With zero publishers the expected heading is **No active screens**.
2. Copy the link into a separate profile. Confirm a signed-out visitor encounters Access and Discord authentication. With a signed-in pilot tester in the wrong channel, expect a 403 on the room join. A member outside the tester list also receives a denial.
3. Leave or switch voice channels with the admitted player open. Verify the player loses access and the old session cannot obtain state. Reopen the same link while outside the channel and verify denial again. Record the time and outcome only. Avoid HAR exports and OAuth callback URLs.
4. For a separate video-only check, use two eligible testers, disable sharing audio, publish an approved screen and verify remote playback stops on departure. Keep hosted native pairing unapproved. The Cloudflare player still uses the workstation source bridge, which the Worker does not expose. Access also requires a browser identity on protected routes. The existing workstation audio implementation remains the reference.

The Worker incurs one dynamic request for a room page; matching JS and CSS are static asset requests. Idle room state waits up to 60 seconds and returns early on a change. A track-owning peer checks in at most 12 seconds apart under normal idle signaling to preserve the existing disconnect timeout. Per ten-hour visit, budget about **600** timed state requests without tracks or **3,000** with tracks, plus join, changes and other application traffic. Four continuously occupied tabs across successive visits imply 5,760 or 28,800 timed state requests/day respectively. The 100,000/day Free quota is shared with other dynamic requests. Failures back off to one attempt per minute. The Go monitor continues to reconcile locally. Workers and SFU egress have separate quotas. [Static asset billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) · [Realtime pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/)

## Shut down or roll back

From `deploy/worker`, regenerate the no-route config and deploy it. Keep Access enforcement in place. Stop ingress before the controller and leave the watchdog and its journal available for retries. If the edge is unavailable, stopping the tunnel immediately cuts that path.

```sh
node configure.mjs "$ACCOUNT_SUBDOMAIN" "$VPC_SERVICE_UUID"
npx --no-install wrangler deploy --config wrangler.private.json
systemctl --user stop whiterun-pilot-tunnel whiterun-pilot-controller whiterun-pilot-bot
```

Confirm provider closures before removing the connector, credentials or state. The existing private LiveKit profile is independent and retains its patched admission enforcement. If its bot was handed over, restore the original bot origin and service after the pilot bot stops.
