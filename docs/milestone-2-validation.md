# Milestone 2 validation

Executed on 2026-11-05 against this repository's isolated local Docker stack. Milestone 1 health behavior and infrastructure were retained. No unrelated services, AWS resources, screen/audio capture, or recording were changed.

## Backend

Executed from `backend`:

```sh
LIVEKIT_INTEGRATION_URL=http://127.0.0.1:7880 go test -race ./...
go vet ./...
```

Both exited 0. Race-test output excerpt:

```text
?    github.com/ghptc/whiterun-live/backend/cmd/server [no test files]
ok   github.com/ghptc/whiterun-live/backend/internal/config (cached)
ok   github.com/ghptc/whiterun-live/backend/internal/httpapi (cached)
ok   github.com/ghptc/whiterun-live/backend/internal/rooms 1.036s
```

Tests use a real HTTP application server and a protobuf-speaking test SFU endpoint. They verify operator authentication, invitation rejection (missing/wrong/cross-room/unknown/expired), input/body/origin restrictions, cache headers, SFU error rollback, capacity and request limits, 20 concurrent independent identities, JWT signature validation, exact five-minute TTL, future-clock token expiry, and room-scoped grants with publishing denied. The opt-in integration test additionally creates a room on the actual local LiveKit server, confirms it via `ListRooms`, requests participant authorization, and deletes only its own room.

An initial real-SFU cleanup failed because Go cancels `t.Context()` before test cleanup. Cleanup now uses its own five-second context; the rerun passed. This was a test cleanup issue, not a room-creation failure.

## Frontend

Executed from `frontend`:

```sh
npm test
npm run build
```

Both exited 0:

```text
Test Files  2 passed (2)
Tests       10 passed (10)
vite v8.3.6 building client environment for production...
✓ 18 modules transformed.
dist/index.html                   0.44 kB
dist/assets/index-CszVLGXZ.css    1.55 kB
dist/assets/index-Bhb1Gv33.js   760.27 kB (gzip 209.16 kB)
✓ built in 193ms
```

Component tests cover the preserved service checks plus room creation/join credentials, invitation parsing, authorization errors, cancellation/loading, pre-existing participants, joins/departures, reconnection/resynchronization, terminal disconnect, failed connection, leave/unmount, and a late-resolving connection after cleanup. These tests mock the SDK; actual SDK connectivity is validated separately below.

The build reports a nonfatal bundle-size warning because the client bundle includes LiveKit. No warning was suppressed. Splitting the room UI/SDK can be considered when the frontend grows.

## Actual Chromium sessions and LiveKit

Installed Playwright 1.65.0 Chromium (Chrome for Testing 158.0.8127.18). Arch is not an officially supported Playwright host, so its installer selected the Ubuntu 24.04 browser build. It launched successfully with `chromiumSandbox: true`; no browser sandbox bypass or capture flags were used.

With the local stack running, executed:

```sh
cd frontend
npm run test:e2e
```

Actual result:

```text
✓ two independent sessions: authorized joins, presence, departure, and rejoin (12.4s)
✓ an invalid invitation is rejected in the browser (180ms)
✓ real signaling interruption reconnects automatically (3.5s)
3 passed (16.4s)
```

Two independent browser contexts connected through the real `livekit-client` SDK to the existing LiveKit service. Alice created and joined a room. Bob joined through its invitation, saw Alice as an existing participant, and appeared in Alice's live list. Both displayed two participants. Bob left, Alice's count dropped to one, Bob rejoined, and both counts returned to two. Closing Bob's unproxied tab removed his presence; Alice then left. Neither page reported an uncaught browser error.

The running backend returned 401 for creation without an operator key and 403 for joins with missing/wrong invitations or an arbitrary room ID. An invalid but well-formed invitation also displayed the backend rejection in the browser without creating a room connection.

The separate reconnect test forwards every WebSocket message to/from the real SFU. It deliberately closes that client's signaling socket with code 1012, confirms a new signaling connection, and waits for the UI to return to `connected` with the participant list restored. It does not replace LiveKit messages or fabricate presence. Keeping this test separate matters: Playwright's socket forwarding changes abrupt tab-close propagation, so tab departure is checked on a normal, unproxied connection.

## Environment and final stack

Host: Go 1.27.3, Node 26.2.0, npm 11.13.0, Docker Engine 29.9.2, Compose 5.6.1. Application Docker builds use Go 1.26 and Node 24; the existing SFU stays pinned to LiveKit 1.13.11. Local backend port remains 18080 because 8080 belongs to an existing service; frontend remains 5173. All published ports remain loopback-only. Final `docker compose up -d --build --wait --wait-timeout 120` and `docker compose config --quiet` exited 0. Go/frontend container healthchecks were healthy and LiveKit remained running. Final direct/proxied health probes returned:

```text
GET http://127.0.0.1:18080/healthz  {"status":"ok"}
GET http://127.0.0.1:18080/readyz   {"livekit":"reachable","status":"ok"}
GET http://127.0.0.1:5173/api/readyz {"livekit":"reachable","status":"ok"}
```

The final browser suite was rerun against the rebuilt frontend and passed all three tests in 16.4 seconds. Source inspection found no capture/publish API calls. Git whitespace checks passed, and `.env` remains ignored and untracked.

A random `LOCAL_ADMIN_KEY` was generated in the ignored root `.env` (mode 0600), without printing it. The key is required at startup and never included in frontend build variables. Test traces/videos/screenshots are disabled; ignored failure snapshots can contain short-lived invitation capabilities and should remain local.

Host `go mod tidy` could not resolve the module proxy through the workstation's Tailscale DNS. Tidying ultimately exited 0 in a temporary non-root Go container with container-local DNS `1.1.1.1`, writing this project's module files. The workstation DNS configuration was not changed. Subsequent host race/integration tests and vet passed with the tidied module files.

## Remaining limitations

- Local development authorization only: a shared operator key and bearer invitations, without accounts, invite revocation, persistent room storage, or internet exposure.
- Invitations expire after eight hours and are invalidated by backend restart. Token expiry is five minutes for admission; it is not a forced session lifetime. LiveKit may refresh tokens during active connections.
- A successful transient signaling reconnect is demonstrated; extended network loss, SFU restarts, cross-device/TURN connectivity, and Firefox still need dedicated validation.
- No media tracks were captured/published, and no media quality, audio, GPU encoding, bitrate, latency, or 1440p60 claim follows from presence tests.
- The production build has a documented bundle-size warning. No public deployment, Discord work, or Milestone 3 implementation was started.
