# Workers Free deployment plan

The prepared private pilot uses Workers Static Assets and one HTTP Worker with a VPC Service binding to the existing Go controller. The controller and Discord Gateway authority run on one Linux host. It retains the fixed ten-hour admission, track journal and four-publisher limit. The account's Free plan supports this split during the Workers VPC beta. [Private deployment, acceptance and rollback](cloudflare-private-player.md) · [Workers VPC](https://developers.cloudflare.com/workers-vpc/get-started/)

## First deployment step

Open **Workers & Pages** in the Cloudflare account that owns the Realtime SFU app. Copy **Your subdomain** and check the Workers plan in that account. From the repository root, the following read-only command prints the exact Discord redirect URI using the checked-in Worker name. Supply the account hostname shown in the dashboard. This step requires no tunnel or VPC Service ID. [Find the account subdomain](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)

```sh
read -r ACCOUNT_SUBDOMAIN
node deploy/worker/configure.mjs --callback "$ACCOUNT_SUBDOMAIN"
```

Use the printed URI in **Discord Developer Portal → OAuth2 → Redirects**. Keep hosted pilot activation pending until the signed-out copied-link and approved-tester checks pass on the Access-protected shell. [Manual stages and protected variable names](cloudflare-private-player.md)

## Future multi-host recovery

Moving room state into a SQLite-backed Durable Object is an option if multiple controllers are needed. It would require atomic slot allocation, pre-attachment ownership records, an independent process that retries closure, and tests across a whole-host outage and provider partition. The pilot uses no Durable Objects. A hibernating WebSocket could reduce requests further for larger audiences. Exhaustion of the edge quota must leave the origin watchdog able to reach the SFU control API. [Revocation limits](cloudflare-sfu.md)

## Published allowances

Checked 2026-11-22. These are account/plan allowances. Remaining capacity and the account's SFU billing settings require verification by the account owner.

| Component | Free allowance | Design consequence |
| --- | --- | --- |
| Workers | 100,000 dynamic requests/day, 10 ms CPU per request, 128 MB memory, 50 subrequests/request, six simultaneous outgoing connections/request | Measure OAuth cryptography, SDP processing and signaling under load. Keep media off the Worker. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Static Assets | Free unlimited asset requests and 20,000 files per Free Worker version | Use direct asset matching. A route that always invokes a Worker consumes the dynamic quota. [Asset billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) · [Limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Durable Objects Free | SQLite backend, 100,000 requests/day, 13,000 GB-s/day, 5 million rows read/day, 100,000 rows written/day, 5 GB total SQL storage | Include alarms, row writes for deletes and alarm scheduling, concurrent rooms, and active duration. Budget these separately from the calling Worker. [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Realtime SFU + TURN | First 1,000 GB/month of combined egress, then USD 0.05/GB | Each additional viewer or subscribed screen adds egress. Free Workers allowances do not cap SFU charges. [Realtime pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/) |

The idle room check returned after 60.003 seconds. That implies about 600 timed waits per ten-hour visit with no owned tracks. Active peers keep their 12-second track presence interval, about 3,000 waits per ten-hour visit. Four continuously occupied tabs would contribute about 5,760 to 28,800 timed waits per day across successive visits. State changes, admissions, signaling, errors and other traffic add requests. The backend performs the Discord monitor checks locally. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

One 4 Mb/s stream delivered to one viewer consumes about 1.8 GB/hour in decimal units before overhead and audio. Four such publishers each watching the other three generate twelve deliveries, about 21.6 GB/hour. One thousand GB would cover about 46 hours at that rate if the account had no other usage. Four incoming publishers alone do not determine the bill.

The Worker bundle and route contract run locally in workerd. A live private deployment still needs an account-authorized upload, a working tunnel, Discord callback registration for the hosted origin and private acceptance.
