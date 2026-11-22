# Screen Share private pilot migration and rollback

The replacement Worker is `screen-share-player`. Steve builds each `/live` link from the bot's configured `APP_ORIGIN` and the existing channel reference. The controller uses the same origin for OAuth. The checked-in replacement units load a non-secret origin file **after** their existing protected role files. Building the player, generating a config or installing an inactive unit does not change Steve's current links.

| | Existing deployment | Replacement |
| --- | --- | --- |
| Origin | `https://whiterun-private-player.gabrielhpittacosta.workers.dev` | `https://screen-share-player.gabrielhpittacosta.workers.dev` |
| Discord redirect | Existing origin plus `/api/discord/callback` | `https://screen-share-player.gabrielhpittacosta.workers.dev/api/discord/callback` |
| Generated Worker config | `deploy/worker/wrangler.private.json` | `deploy/worker/wrangler.screen-share.json` |
| User services | `whiterun-pilot-controller`, `whiterun-pilot-bot` | `screen-share-controller`, `screen-share-bot` |

Run each stage manually after approval. Use one shell at the repository root. Before a future push, check Git-connected Workers Builds branch triggers, root directory and Wrangler target. A push to an attached branch can deploy independently of these commands. Retain the previous deployed revision, the legacy generated config, both installed binaries and the old units for rollback.

## 1. Prepare locally

```sh
account=gabrielhpittacosta.workers.dev
worker_config=deploy/worker/wrangler.screen-share.json
wrangler=deploy/worker/node_modules/.bin/wrangler
(cd frontend && npm ci && VITE_NATIVE_AUDIO_MODE=pair npm run build)
(cd deploy/worker && npm ci && npm test)
node deploy/worker/configure.mjs --prepare "$account"
node deploy/worker/configure.mjs --callback "$account"
"$wrangler" deploy --config "$worker_config" --dry-run
```

On the origin host, stage the new binaries under their own names. These commands are for the first migration, before either new service is running. The legacy service files, tunnel, role credentials and live SFU journal stay in place.

```sh
umask 077
install -d -m 700 ~/.local/lib/screen-share ~/.config/screen-share ~/.config/systemd/user
(cd backend && go build -trimpath -o ~/.local/lib/screen-share/screen-share-controller ./cmd/server)
(cd backend && go build -trimpath -o ~/.local/lib/screen-share/screen-share-bot ./cmd/discord-bot)
install -m 600 deploy/worker/origin/player.env ~/.config/screen-share/player.env
install -m 600 deploy/worker/origin/screen-share-{controller,bot}.service ~/.config/systemd/user/
systemd-analyze --user verify ~/.config/systemd/user/screen-share-{controller,bot}.service
systemctl --user daemon-reload
```

In Discord Developer Portal → Steve → OAuth2 → Redirects, **add** the exact replacement redirect above and save. Retain both the active redirect and any localhost redirect. Steve's application ID, bot token, scopes, install, Gateway intents, channel map and room mapping key stay the same.

## 2. Stage the new Worker and its Access policy

In the account dashboard, confirm the account subdomain, Workers Free, ownership of the existing private VPC Service, and availability or expected ownership of the new Worker name. Do not claim another team's Worker or change an existing Git build target. Set `VPC_SERVICE_UUID` in the operator shell to the **existing production** VPC Service ID from the dashboard. The production binding remains restricted to the existing tunnel and controller on port 18492. No new public tunnel hostname is needed.

For the existing install, the following reads the production binding ID into the shell without printing it. Compare its destination with the account dashboard before handover.

```sh
VPC_SERVICE_UUID=$(node -e 'const c=require("./deploy/worker/wrangler.private.json"); const v=c.vpc_services?.find(x=>x.binding==="CONTROLLER"); if (!v?.service_id) process.exit(1); process.stdout.write(v.service_id)')
```

After separate approval for hosting, upload the route-disabled target first. Then serve a shell that has no controller binding.

```sh
node deploy/worker/configure.mjs --prepare "$account" &&
  "$wrangler" deploy --config "$worker_config" &&
  node deploy/worker/configure.mjs --access-setup "$account" &&
  "$wrangler" deploy --config "$worker_config"
```

Prepare a separate Cloudflare Access application for the new workers.dev hostname in Workers & Pages → screen-share-player → Settings → Domains & Routes → Cloudflare Access. Apply the following policy before permitting any controller binding.

| Access setting | Required configuration |
| --- | --- |
| Public hostname | `screen-share-player.gabrielhpittacosta.workers.dev`, entire hostname including `/r/*`, `/api/*` and assets |
| Allow | Attach the existing named-tester policy if reusable. Otherwise reproduce the exact permitted tester identities, identity providers, Require and Exclude rules, precedence and session settings from the legacy application. |
| Other identities | Default deny. Remove any automatically added, broader Allow policy from the **new** application. Preserve Block policies in their original order. Stop if a Bypass, Service Auth or broad Allow could admit someone outside the pilot. |
| Other routes | Preview URLs disabled. Keep the old hostname and its Access policies intact. |

In a fresh signed-out browser profile, a copied room URL and its API URL must hit Access. An unlisted Access identity must be denied. A permitted tester should see the Screen Share shell with its neutral tab icon. Behind Access, OAuth and a same-origin room join still return 503 while the binding is absent. Check outcomes without exporting cookies, query strings or HAR files. [Protect workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/) · [Manage or reuse Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/policy-management/)

## 3. Validate the replacement while Steve still serves the old URL

A controller serves exactly one origin. Binding the new shell straight to the live controller cannot validate the new OAuth exchange. For a non-disruptive hosted rehearsal use an approved, independent test SFU application and journal, and a private rehearsal VPC Service through the same connector to a spare loopback port. Keep the existing production VPC Service unchanged. If this isolated rehearsal is unavailable, leave the old site running and the new shell unbound.

If a rehearsal service already exists, verify its tunnel and destination and use its ID. Otherwise, the following command is for an operator-approved rehearsal only. Set `TUNNEL_UUID` to the existing connector's tunnel ID and `REHEARSAL_VPC_SERVICE_UUID` to the service ID returned. Leave the production service and tunnel settings intact.

```sh
"$wrangler" vpc service create screen-share-rehearsal --type http \
  --tunnel-id "$TUNNEL_UUID" --ipv4 127.0.0.1 --http-port 18493
```

On the controller host, prepare owner-only `~/.config/screen-share/rehearsal.env` using a protected editor. Include the same authorized Discord settings and pilot restrictions as the controller, the independent test SFU credentials, and the following settings. Set `SCREEN_SHARE_SFU_STATE_DIR` to an **absolute** dedicated directory under the user's state directory. The existing bot can answer voice lookups for both controllers. Start no second Steve Gateway client.

```dotenv
APP_ORIGIN=https://screen-share-player.gabrielhpittacosta.workers.dev
SCREEN_SHARE_ENV=production
SCREEN_SHARE_MEDIA_TRANSPORT=cloudflare-private
DISCORD_MODE=discord
BACKEND_ADDR=127.0.0.1:18493
DISCORD_VOICE_URL=http://127.0.0.1:18491
```

```sh
install -d -m 700 ~/.local/state/screen-share-rehearsal
systemd-run --user --unit=screen-share-rehearsal --collect \
  --property="EnvironmentFile=$HOME/.config/screen-share/rehearsal.env" \
  --property=UMask=0077 --property=NoNewPrivileges=yes --property=KillMode=process \
  "$HOME/.local/lib/screen-share/screen-share-controller"
curl -fsS --retry 10 --retry-connrefused http://127.0.0.1:18493/healthz &&
  test -n "$VPC_SERVICE_UUID" && test "$REHEARSAL_VPC_SERVICE_UUID" != "$VPC_SERVICE_UUID" &&
  node deploy/worker/configure.mjs "$account" "$REHEARSAL_VPC_SERVICE_UUID" --private-pilot &&
  "$wrangler" deploy --config "$worker_config"
```

Take the path from an authorized legacy `/live` response and open it on the new hostname. Verify Access, Discord consent, the exact callback, a successful join in the allowed voice channel, denial of a copied link outside voice, and loss of access after leaving the channel. The old tab's cookie must not sign into the new host. Never copy browser credentials between origins. Use the existing Firefox recorder for this step if desired. Record outcomes only. [Hosted acceptance procedure](cloudflare-private-player.md#4-verify-the-hosted-pilot)

After the checks, restore the candidate to shell-only and stop the rehearsal controller. Let its watchdog finish cleanup. Leave production in place if any check fails.

```sh
node deploy/worker/configure.mjs --access-setup "$account" &&
  "$wrangler" deploy --config "$worker_config" &&
  systemctl --user stop screen-share-rehearsal.service
```

## 4. Approved production handover

Agree a maintenance window. Ask participants to finish sharing and close the old player. Restarting the controller ends its in-memory sessions and reservations, and switching hostname requires fresh Access and Discord authentication. Confirm zero outstanding track records and completed provider cleanup. Check that the localhost Compose bot using Steve's token and any other Steve Gateway clients are stopped, apart from the current pilot bot. Leave the tunnel running throughout.

```sh
systemctl --user is-active whiterun-pilot-{controller,bot,tunnel}.service
systemctl --user is-enabled whiterun-pilot-{controller,bot,tunnel}.service
find "$HOME/.local/state/whiterun-pilot" -type f -name '*.track' -printf '.\n' | wc -l
docker ps --filter label=com.docker.compose.project=whiterun-discord-private \
  --filter label=com.docker.compose.service=discord-bot --format '{{.Status}}'
```

Record the boot settings. The journal count must be zero and the Docker check must return no container. The replacement uses the same production journal and lock. Never delete journal files, kill a cleaning watchdog or choose an empty journal to get past a failed start.

```sh
systemctl --user stop whiterun-pilot-controller.service &&
  systemctl --user start screen-share-controller.service &&
  curl -fsS --retry 20 --retry-delay 1 --retry-connrefused http://127.0.0.1:18492/healthz &&
  node deploy/worker/configure.mjs "$account" "$VPC_SERVICE_UUID" --private-pilot &&
  "$wrangler" deploy --config "$worker_config"
```

While the original bot still provides authoritative voice state, repeat correct-channel admission, copied-link denial and departure on the **production** binding using the new hostname and saved room path. Only after these pass, switch Steve's public links.

```sh
systemctl --user stop whiterun-pilot-bot.service &&
  systemctl --user start screen-share-bot.service
systemctl --user is-active screen-share-{controller,bot}.service whiterun-pilot-tunnel.service
curl -sS -o /dev/null -w 'Voice authority HTTP %{http_code}\n' -X POST http://127.0.0.1:18491/voice
```

The unauthenticated voice probe should return 403. Invoke the real `/live` command while in the configured voice channel. Expect `https://screen-share-player.gabrielhpittacosta.workers.dev/r/<opaque-reference>`. Repeat departure and re-entry. Bot handover resets Gateway membership generations, so testers may need to reopen the link. Preserve previously recorded boot enablement during the trial. Promote the new units to start at boot only after acceptance and separate approval, disabling any previously enabled corresponding legacy unit.

## Rollback

Before handover, returning the replacement Worker to `--prepare` removes its routes and binding upon approved deployment. The existing services can continue serving users. After handover, stop the replacement bot and controller, allow journal recovery to finish, and start the untouched legacy services. Keep Access active throughout. Run origin recovery even if the Cloudflare control API is unavailable.

```sh
systemctl --user stop screen-share-bot.service screen-share-controller.service &&
  systemctl --user start whiterun-pilot-controller.service &&
  curl -fsS --retry 20 --retry-delay 1 --retry-connrefused http://127.0.0.1:18492/healthz &&
  systemctl --user start whiterun-pilot-bot.service
systemctl --user is-active whiterun-pilot-{bot,controller,tunnel}.service
node deploy/worker/configure.mjs --prepare "$account" &&
  "$wrangler" deploy --config "$worker_config"
```

Restore the recorded boot enablement if promotion had already occurred. Verify Steve returns the **old hostname**, then check Access, Discord admission and departure there. Keep the old Worker, OAuth redirect and VPC Service available through rollback. A prolonged controller/watchdog outage or SFU control API partition can still allow established media past its ten-hour authorization. [Media expiration and recovery limits](cloudflare-sfu.md)

## Compatibility inventory

The audit covered tracked source, package manifests and locks, tests, launchers, Compose, systemd, Worker templates, docs, and filenames using `git grep -inEi 'whiterun|whiuterun|(^|[^a-z])wl([^a-z]|$)'`. Product copy, document metadata, tab icon and active deployment instructions now use Screen Share. Steve's existing command and generic response copy require no Discord application rename.

| Retained identifier | Reason |
| --- | --- |
| `__Host-wl-*`, `whiterun_player`, `X-Whiterun-Entry`, `X-Whiterun-Peer` | Secure cookies and Worker/controller protocol shared with already distributed clients. Cookies remain host-scoped. |
| `whiterun:discord:voice:v1/`, `whiterun-local`, `whiterunEntry`, `whiterun.gameAudio.*` | Existing keyed room references, LiveKit room, browser visit/deadline state and saved preferences. |
| `WHITERUN_ENV`, `WHITERUN_MEDIA_TRANSPORT`, `WHITERUN_SFU_STATE_DIR` | Startup accepts old settings. Matching aliases work. Conflicting old and new values fail before service admission. |
| EC2 tags, Compose projects and volumes, installed paths, helper CLI/socket/graph names, selected test harness flags | Bind existing installs, TLS state, rollback releases and tooling. The EC2 wrapper uses `SCREEN_SHARE_RELEASE`; Compose accepts the old release name too. Desktop capture and isolation retain their identifiers. |
| Go module paths, original license attribution, historical output | Preserve import compatibility, original authorship and reproducible historical evidence. |
