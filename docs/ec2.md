# Manual EC2 release

Target the existing Ubuntu x86-64 host `aws-prod`, service directory `/opt/services/whiterun-live`, and Compose project `whiterun-live-prod`. Build on the workstation and rsync a checksummed release containing three tagged images. The server runs the bot and API as separate containers from the same backend image. The patched SFU and HTTPS player each have their own image.

**Public access is pending security sign-off.** Rotate the previously shared bot token and the OAuth secret used by the simulator. Complete the real private-guild admission and revocation checks below before opening player or media ports to a general audience. Use tester IPs for the first deployment.

## 1. Check the shared host

From the workstation, inspect port ownership, disk, memory and current load. Docker with Compose v2.23.1+ (or Compose v5), rsync, Python 3 and iproute2 are required on Ubuntu. Use the existing SSH host key and Docker-authorized account.

```sh
ssh aws-prod 'uname -m; docker compose version; df -h /opt /var/lib/docker; free -h; uptime; docker ps --format "{{.Names}}  {{.Ports}}"; sudo ss -lntup'
```

| Existing security group / host firewall | Source | Use |
| --- | --- | --- |
| TCP 80 | Internet | Let’s Encrypt HTTP-01 issuance and automatic renewal. Ordinary HTTP paths return 404. |
| TCP 8443 | Testers | HTTPS player, Discord callback, WebSocket signaling and helper API |
| UDP 17892 | Testers | WebRTC multiplexed media |
| TCP 17891 | Testers | ICE/TCP fallback |

Reserve these four ports on the instance’s **private interface**. If any belongs to Minecraft, COD4, Bardao or another service, stop this rollout and resolve the conflict with its owner. Keep existing SSH and game firewall rules. Backend 8080, bot 8091, SFU signaling 7880 and Caddy admin stay unpublished. The host needs outbound HTTPS to Discord and Let’s Encrypt. On this T3, the SFU has a 2-vCPU/2-GiB ceiling. Monitor host memory, game latency, network throughput and CPU credits during the trial. These limits have not been load-tested alongside the games. [LiveKit port requirements](https://docs.livekit.io/transport/self-hosting/ports-firewall/)

## 2. Transfer a release

Run this block in a workstation Bash shell. `dist/ec2` holds local release packages. The packager uses committed source and omits the workstation environment, helper executable and test outputs. The destination is a new staging directory beneath this service.

To repeat the local production smoke test after packaging, run `./scripts/test-ec2 "$(git rev-parse HEAD)"` on Linux with Docker. It verifies HTTP-01 with Pebble, IP certificate trust across edge replacement, the OAuth redirect, copied-link denial and the patched SFU callback. It starts neither the real bot nor an EC2 service.

```bash
set -e
rev=$(git rev-parse HEAD)
bundle="$PWD/dist/ec2/$rev"
test -d "$bundle" || ./scripts/package-ec2 "$PWD/dist/ec2"
(cd "$bundle" && sha256sum -c SHA256SUMS)
ssh aws-prod 'set -e; base=/opt/services/whiterun-live
  sudo install -d -m 0750 -o "$(id -un)" -g "$(id -gn)" "$base"
  mkdir -p "$base/releases"; install -d -m 0700 "$base/shared"'
ssh aws-prod "test ! -e /opt/services/whiterun-live/releases/$rev && mkdir -p /opt/services/whiterun-live/releases/$rev.incoming"
rsync -a --partial --no-owner --no-group "$bundle/" "aws-prod:/opt/services/whiterun-live/releases/$rev.incoming/"
ssh aws-prod "set -e; cd /opt/services/whiterun-live/releases/$rev.incoming
  sha256sum -c SHA256SUMS; test \"\$(cat RELEASE)\" = '$rev'
  docker image load -i images.tar.gz; cd ..; mv -T '$rev.incoming' '$rev'"
ssh -t aws-prod "cd /opt/services/whiterun-live/releases/$rev && exec bash"
```

## 3. Configure and start on Ubuntu

From the release shell, create the protected file **on EC2**. Preserve it across releases. Populate the blank fields in the editor. Public and private IPv4 addresses are in the existing instance’s EC2 networking details.

```bash
base=/opt/services/whiterun-live
cfg="$base/shared/production.env"
umask 077
if [ ! -e "$cfg" ]; then
  printf '%s\n' PUBLIC_IPV4= BIND_IPV4= DISCORD_CLIENT_ID= DISCORD_PUBLIC_KEY= \
    DISCORD_CLIENT_SECRET= DISCORD_BOT_TOKEN= DISCORD_CHANNELS= > "$cfg"
fi
chmod 600 "$cfg"
nano "$cfg"
./prepare-discord-private --check-ec2 "$cfg"
```

Set `PUBLIC_IPV4` to the **current public IP** used by viewers and advertised by LiveKit. Set `BIND_IPV4` to the **assigned private IPv4** on Ubuntu. Set `DISCORD_CHANNELS` to comma-separated `guild-id/voice-channel-id` pairs. In Discord Developer Portal → **OAuth2 → Redirects**, save exactly `https://PUBLIC_IPV4:8443/api/discord/callback`, substituting the numeric public address. Configure Guild Install with `bot` and `applications.commands`, install in the target guild and leave the Interactions Endpoint URL empty. The preflight creates independent media and service keys on EC2 and checks the real callback, identity and channels. Repeat it after saving Portal changes. Continue only on success. Docker administrators can read container credentials. Keep expanded Compose configuration and container environment dumps out of support logs. [Discord setup](discord.md) · [EC2 address translation](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Internet_Gateway.html)

```bash
set -e
rev=$(cat RELEASE)
./compose config --quiet
if [ -L "$base/current" ]; then
  old=$(readlink "$base/current")
  if [ "$old" != "releases/$rev" ]; then ln -sfnT "$old" "$base/previous"; fi
fi
./compose up -d --no-build --wait
./compose ps
./compose exec -T backend /server healthcheck http://127.0.0.1:8080/readyz
./prepare-discord-private --check-ec2 "$cfg"
```

The readiness check requires the SFU to call back with the current admission key and deny a fresh protected-room probe. Verify that the preflight reports **Guild /live registration verified**. Run one real bot for this guild and application so each command receives a single response. Caddy requests a publicly trusted **IP SAN** certificate and renews it using its project-specific Docker volume and port 80. Issuance is asynchronous. From a tester’s workstation, enter the numeric address and run the following commands.

```bash
read -rp 'EC2 public IPv4: ' ip
curl -sS -o /dev/null -w '%{http_code}\n' "https://$ip:8443/"
openssl s_client -connect "$ip:8443" -noservername -verify_ip "$ip" -verify_return_error </dev/null 2>/dev/null | openssl x509 -noout -dates
```

Expect **404** for the bare player root with successful system TLS verification. Check certificate expiry regularly. These certificates last roughly six days. Keep TCP 80 available for renewal. If the instance public IP changes, update the server environment, registered redirect and tester URL, rerun preflight, and recreate this project's containers. [Let’s Encrypt IP certificates](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability) · [Caddy ACME profiles](https://caddyserver.com/docs/caddyfile/directives/tls)

## 4. Verify media and access before promotion

1. Join an allowed voice channel, invoke **/live**, complete OAuth and share a screen. From a second computer, verify video and audio and inspect the selected ICE candidate pair in the browser’s WebRTC diagnostics. Test UDP, then ICE/TCP on a client network that blocks UDP. This package has no TURN relay. Restrictive networks need a separate connectivity decision.
2. On each **publishing Linux desktop**, build the matching helper from the same Git revision with Go, libopus, pkgconf, a C compiler and PipeWire tools. Enable **Share audio**, approve the screen picker, then use **Audio → Pair native audio helper → Copy pairing code**. Run the commands below in a workstation Bash terminal. The hidden prompt sends the one-use JSON directly to helper stdin. Pair within one minute. Select only the intended game. Stopping the screen or losing the authorized voice session must tear down the helper. Hosted pairing is manual. The automatic desktop launcher remains local to the workstation profile. [Native audio and isolation](native-audio.md)

   ```bash
   (cd native-audio && go build -o whiterun-audio .)
   native-audio/whiterun-audio --list-applications
   read -rp 'Game application serial: ' serial
   systemd-ask-password 'Paste Whiterun pairing JSON' | native-audio/whiterun-audio --start --application "$serial"
   ```

3. Open a copied link signed out and again with an account in the wrong channel. Verify sign-in and denial respectively. Move or disconnect an authorized member during playback, verify media and the native tap stop, and verify reconnect denial with existing credentials. Repeat across Gateway and backend restarts. Pending gates are real-guild authorization and original/refreshed token review on the deployed path. The SFU checks established sessions every two seconds. A silent Gateway outage can take up to the 65-second freshness interval to detect. Physical HyperX real-game listening remains a separate release gate. [Authorization tests and detection window](discord.md)

After acceptance, in the Ubuntu release directory mark this release current:

```bash
ln -sfnT "releases/$(cat RELEASE)" /opt/services/whiterun-live/current
```

**Rollback.** From the Ubuntu shell choose the last known-good release. During a failed upgrade `current` still points to the accepted release. After promotion use `previous`. On a first installation with no accepted release, run `./compose down` in the failed release. This keeps the TLS volume. A version change interrupts Whiterun sessions and requires fresh room authorization.

```bash
set -e
base=/opt/services/whiterun-live
read -rp 'Rollback pointer (current or previous): ' pointer
[[ "$pointer" == current || "$pointer" == previous ]]
cd "$(realpath -e "$base/$pointer")"
sha256sum -c SHA256SUMS
docker image load -i images.tar.gz
./compose up -d --no-build --force-recreate --wait
./compose exec -T backend /server healthcheck http://127.0.0.1:8080/readyz
ln -sfnT "releases/$(cat RELEASE)" "$base/current"
```

Keep the previous release, the protected server configuration and the TLS volume. The commands target only Whiterun. No global Docker cleanup or stack-wide host restart is part of the rollout.

## Transfer estimate

The configured SSH alias matched an EC2 address in São Paulo (`sa-east-1`) in AWS’s public address list. Confirm the instance region before budgeting. Internet ingress, including the release upload and publishers' media, is **$0/GB**. First-tier internet egress is **$0.15/GB** after the account’s remaining shared 100 GB monthly allowance. Minecraft and other services can consume that allowance. [São Paulo transfer rates](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/sa-east-1/index.json) · [EC2 data transfer pricing](https://aws.amazon.com/ec2/pricing/on-demand/)

Budget from the sum of **delivered** audio/video bitrates. Each 1 Mb/s sustained for an hour is 0.45 decimal GB. At an assumed 8 Mb/s per delivered subscription, the following are approximate USD estimates for 30 streaming hours in one month, before taxes. The two cost columns assume all or none of the shared allowance is available.

| Viewing pattern | Deliveries | Egress/hour | 30 hours | 100 GB available | Allowance used |
| --- | ---: | ---: | ---: | ---: | ---: |
| Two publishers watching each other | 2 | 7.2 GB | 216 GB | $17.40 | $32.40 |
| Four publishers each watching the other three | 12 | 43.2 GB | 1,296 GB | $179.40 | $194.40 |

Extra viewers add deliveries. Use measured outbound bytes including audio, retransmissions and protocol overhead for billing forecasts. Existing instance, storage, public IP, and possible T3 Unlimited surplus CPU charges are separate from these transfer estimates.
