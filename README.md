# Whiterun Live

Open-source, self-hosted screen and audio streaming for shared rooms. **Milestone 3: simultaneous screen sharing.** Create authorized rooms, invite viewers or screen publishers, and view simultaneous screens in a responsive grid. Video runtime diagnostics are available per stream. Audio capture is not implemented. 2560×1440 at 60 FPS is a future performance target, not a measured capability.

## Quick start on Arch Linux

Install Docker and Compose (review package changes before running on an existing workstation):

```sh
sudo pacman -Syu --needed docker docker-compose git
sudo systemctl enable --now docker
```

Run Docker commands with `sudo` if your account does not already have Docker access. Membership in the `docker` group grants root-equivalent privileges; do not change membership just to suppress an error.

From this repository:

```sh
test -f .env || cp .env.example .env
openssl rand -hex 32
# Set LOCAL_ADMIN_KEY in .env to the generated value before continuing.
# Keep an existing key when upgrading an already configured checkout.
docker compose config --quiet
docker compose up -d --build --wait --wait-timeout 120
docker compose ps
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/readyz
curl -fsS http://127.0.0.1:5173/api/readyz
```

Open **http://localhost:5173**. Enter a display name, room title, and the `LOCAL_ADMIN_KEY` from your local `.env`, then choose **Create and join room**. The creator can publish screen video. Share **Share invitation** for view-only access or the separate **Screen publisher invitation** with participants who should also share. Links work with another browser profile, private window, or tab on this same workstation. Guests need an invitation; an optional display name defaults to Guest. They do not need the operator key. Query and fragment invitation URLs are accepted. A raw invitation token needs its explicit Room ID. Use **Leave room** to disconnect. After a terminal connection failure, leave the view and join again for fresh access.

The page still checks backend liveness and LiveKit HTTP reachability separately. Click **Check services again** after restarting a service. Joining never requests capture permissions. An authorized publisher must click **Start sharing** and approve the browser picker. **Stop sharing**, the browser sharing controls, or leaving stops capture. Each screen has its own owner label and fullscreen button. A viewer invitation alone never grants publishing. No audio is requested.

Expected JSON: `/healthz` returns `{"status":"ok"}`; `/readyz` returns `{"livekit":"reachable","status":"ok"}`. `/readyz` returns HTTP 503 if LiveKit cannot be reached. These are HTTP checks, not proof of working WebRTC, audio, or encoding.

```sh
docker compose logs --tail=100
docker compose down
```

Compose starts all three services. The frontend is Vite's development server, not a production host. Source is copied into images; rerun `docker compose up -d --build --wait` after edits. LiveKit logs startup but its upstream image has no configured container healthcheck here; the backend's readiness check probes it continuously. No database, Redis, recording, persistent media volume, or cloud resources are created.

## Native development with hot reload

Install Go 1.26+ and Node.js 24.15+ LTS (or 22.22.2+ in the Node 22 line) with npm. Node 24 LTS is used in the frontend container. The test environment has a higher Node minimum than Vite itself. Arch's current `go`, `nodejs`, and `npm` packages can be installed with pacman; check `go version` and `node --version` afterward.

Run only LiveKit in Docker:

```sh
docker compose up -d livekit
```

In one terminal:

```sh
cd backend
export LOCAL_ADMIN_KEY='paste-the-generated-local-key-here'
go run ./cmd/server
```

In another:

```sh
cd frontend
npm ci
npm run dev
```

Native services use the defaults in `.env.example`; Go does not automatically load `.env`, and `LOCAL_ADMIN_KEY` must be exported explicitly. Keep `APP_ORIGIN` equal to the frontend origin used in the browser (default `http://localhost:5173`). To override a value, export it before starting the process, for example `BACKEND_ADDR=127.0.0.1:9090 go run ./cmd/server`, and set `API_PROXY_TARGET=http://127.0.0.1:9090 npm run dev` in the frontend terminal. Vite reads environment values from the shell for its server-side proxy. Do not run native and Compose application services on the same ports; first stop Compose's `frontend` and `backend` if needed.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `BACKEND_PORT` | `8080` | Compose backend host port |
| `FRONTEND_PORT` | `5173` | Compose frontend host port |
| `BACKEND_ADDR` | `127.0.0.1:8080` | Native backend listener; Compose fixes the internal listener to `0.0.0.0:8080` |
| `LIVEKIT_HTTP_URL` | `http://127.0.0.1:7880` | Native backend's SFU HTTP probe origin; Compose uses `http://livekit:7880` |
| `LOCAL_ADMIN_KEY` | required, at least 32 characters | Server-side local operator credential for creation; generate randomly, keep in ignored `.env`, enter only when creating |
| `APP_ORIGIN` | `http://localhost:5173` | Allowed browser request origin; set explicitly when changing frontend host/port |
| `LIVEKIT_WS_URL` | `ws://127.0.0.1:7880` | Native backend's browser-facing SFU origin; Compose uses this workstation-only value |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | `devkey` / `secret` | Native backend's isolated development SFU credentials; Compose fixes these to match `--dev` |
| `API_PROXY_TARGET` | `http://127.0.0.1:8080` | Native Vite proxy destination; Compose uses `http://backend:8080` |

The frontend sends `/api/healthz` and `/api/readyz` to Vite, which forwards them to `/healthz` and `/readyz` on Go. This avoids permissive CORS and exposes no secrets through browser environment variables. Compose automatically reads root `.env` for interpolation; it does not pass every variable into containers.

Local LiveKit settings are in [infrastructure/livekit/livekit.yaml](infrastructure/livekit/livekit.yaml). Ports are `7880/tcp` (HTTP/WebSocket), `7881/tcp` (ICE fallback), and `7882/udp` (ICE mux). All published ports bind `127.0.0.1`. LiveKit automatically advertises its existing private Docker bridge interface for media. Linux host browsers can route to that interface; Firefox blocks loopback ICE candidates by default. Published host ports remain loopback-only. This is for native Linux Docker; Docker Desktop/rootless networking may need separate validation. This configuration does not support other devices or internet access. Containers on the Compose network can also reach LiveKit.

LiveKit `--dev` uses the documented **development-only** key `devkey` and secret `secret`. Go uses those SFU credentials server-side for room creation and signing five-minute participant tokens; it never returns the secret to the browser. The local operator key is a separate randomly generated credential. Invitations expire eight hours after creation, and remain shareable bearer capabilities until then. Do not expose this stack through port forwarding, tunnels, public interfaces, or a reverse proxy. Future public deployment requires authentication, room authorization, short-lived scoped tokens, private secrets, HTTPS/WSS, and tested ICE/TURN configuration.

## Checks

```sh
cd backend
go test -race ./...
go vet ./...
cd ../frontend
npm ci
npm test
npm run build
cd ..
docker compose config --quiet
git diff --check
```

Backend tests cover configuration, health, readiness, room authorization, signed grants/expiry, invalid requests, limits, upstream failures, concurrent identities, and rejection of viewer publishing escalation. Frontend component tests cover service status, authorization, presence, connection states, cancellation, and cleanup. Browser tests exercise two isolated sessions, signaling reconnection, and generated video through the actual SFU. Generated-video tests replace only `getDisplayMedia` with a canvas stream; they do not validate desktop capture or Wayland portal consent. No target performance claim derives from these tests.

To run the real local integration and Chromium tests (keep the isolated stack running):

```sh
cd backend
LIVEKIT_INTEGRATION_URL=http://127.0.0.1:7880 go test -race ./...
cd ../frontend
npx playwright install chromium
npm run test:e2e
```

Playwright uses sandboxed headless Chromium, five tests, and the running `http://localhost:5173` app. It reads the operator key from root `.env` unless `E2E_OPERATOR_KEY` is exported; `E2E_BASE_URL` can override the frontend URL. Tracing/video/screenshots are off. Failure snapshots and test output may contain invitations; reports are ignored and should stay local. The Go real-SFU integration test creates and deletes only its own randomly named room.

The generated-media test includes two simultaneous publishers, decoded frame progression, fullscreen, signaling recovery without a second capture, simulated browser-ended capture, explicit stopping, departure cleanup, and a viewer rejoin. Browser permission rejection is injected separately. Real desktop capture still needs the [manual Wayland checklist](docs/screen-sharing.md).

The stabilization pass removed the forced loopback ICE candidate. Firefox now uses the same private Docker bridge media path without browser preference changes. To rerun Firefox or mixed-browser generated-media tests:

```sh
npx playwright install firefox
E2E_BROWSER=firefox npm run test:e2e
E2E_REMOTE_BROWSER=firefox npx playwright test e2e/media.spec.ts -g 'generated video'
```

Open each tile's **Runtime diagnostics** for encoded/decoded resolution and FPS, RTP bitrate, negotiated codec, packet loss, RTT to SFU, ICE/DTLS, viewport/tab visibility, and adaptive subscription state. Rates use measured counter deltas; first/missing/reset reports remain unavailable. These diagnostics do not establish 1440p60, hardware acceleration, or glass-to-glass latency.

**Actual desktop validation is still manual.** Follow [the native consent and cross-browser procedure](docs/desktop-validation.md), whose result worksheet is explicitly NOT RUN. Automated tests mock capture with generated media; no real desktop picker approval is claimed. See [stabilization evidence](docs/milestone-3-stabilization.md) for the separate automated results.

See [screen-sharing implementation](docs/screen-sharing.md), [Milestone 3 validation](docs/milestone-3-validation.md), [room API and authorization](docs/rooms.md), [Milestone 2 validation](docs/milestone-2-validation.md), [validation evidence](docs/validation.md), [architecture and dependency decisions](docs/architecture.md), and [Linux capture investigation](docs/linux-capture.md).

## Troubleshooting

- **Docker permission denied:** use an existing authorized Docker context or `sudo`; verify `docker info` before starting.
- **Port already allocated:** stop the conflicting local service or change `BACKEND_PORT`/`FRONTEND_PORT` in `.env`. LiveKit's three ports are fixed in this milestone; do not stop unrelated containers.
- **Backend healthy, LiveKit unavailable:** inspect `docker compose logs livekit backend`. The backend stays live while readiness returns 503; the frontend waits for readiness on initial Compose startup.
- **Frontend build fails after dependency changes:** use `npm ci` with the committed lockfile and a supported Node release.
- **Creation unavailable:** set a random `LOCAL_ADMIN_KEY` of at least 32 characters in `.env` and rebuild/restart the backend. Use the same value in the creation form. Requests from a different browser origin return 403; use `localhost` or configure `APP_ORIGIN` explicitly.
- **Invitation rejected after restart:** the room authorization store is in memory; create a new room/invitation after a backend restart.
- **No sharing button:** join using the separate screen publisher invitation; a viewer link grants subscription only.
- **Capture denied or unreadable:** focus the browser tab, click Start sharing, and approve the normal browser/portal picker. Check the Linux notes for portal diagnostics. Audio is deliberately disabled.
- **Firefox stays connecting:** apply the current LiveKit config and restart only this project's SFU (`docker compose restart livekit`). Confirm its advertised node IP is the private container address rather than 127.0.0.1. Do not disable Firefox privacy protections or publish the SFU on public interfaces. Rootless/VM Docker requires separate route validation.

## Next milestone

Milestone 3 implementation is complete. Interactive Chrome/Firefox Wayland capture and target performance still need validation; the automated generated-video results are not a substitute. Audio/quality work belongs to Milestone 4 and has not started. Discord and AWS deployment remain deferred until local streaming is validated.

Licensed under [MIT](LICENSE).

Join-button regression details and non-disruptive verification: [invitation fix evidence](docs/join-invitation-fix.md).
