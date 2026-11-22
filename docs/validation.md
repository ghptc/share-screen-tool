# Milestone 1 validation

Executed on 2026-11-05 on the provided Linux workstation. Commands below are actual results or excerpts, not expected/mock media outcomes.

## Environment

```text
go version go1.27.3-X:nodwarf5 linux/amd64
node v26.2.0
npm 11.13.0
Docker Compose version 5.6.1
Docker Engine 29.9.2
```

Container builds also succeeded with `golang:1.26-alpine` and `node:24-alpine`. LiveKit startup logs report version `1.13.11`, single-node routing, HTTP 7880, TCP 7881, UDP 7882, and explicit node IP `127.0.0.1`.

## Automated checks

From `backend`, `go test -race ./...` and `go vet ./...` exited 0:

```text
?    github.com/ghptc/whiterun-live/backend/cmd/server [no test files]
ok   github.com/ghptc/whiterun-live/backend/internal/config 1.004s
ok   github.com/ghptc/whiterun-live/backend/internal/httpapi 1.007s
```

From `frontend`, `npm test` exited 0:

```text
RUN v5.1.0
Test Files  1 passed (1)
Tests       3 passed (3)
```

The final frontend image was also checked with `docker compose exec -T frontend npm test` (3 tests passed) and `docker compose exec -T frontend npm run build` (exit 0, build in 134 ms), confirming the documented Node 24 runtime. The final Compose rebuild and wait exited 0.

`npm run build` on the host exited 0, including strict TypeScript checking:

```text
vite v8.3.6 building client environment for production...
✓ 16 modules transformed.
dist/index.html                   0.44 kB
 dist/assets/index-KNpejYpw.css    1.10 kB
 dist/assets/index-C59XpHqX.js   221.38 kB
✓ built in 208ms
```

`npm install`/container `npm ci` reported 0 audit vulnerabilities at execution time. The lockfile fixes exact dependencies. Node engine requirements reflect jsdom's `^22.22.2 || ^24.15.0 || >=26.0.0` requirement, which is stricter than Vite's minimum.

## Running services and HTTP smoke checks

`docker compose up -d --build --wait --wait-timeout 120` exited 0 after resolving the issues below. `docker compose ps` showed:

```text
backend  Up (healthy)  127.0.0.1:18080->8080/tcp
frontend Up (healthy)  127.0.0.1:5173->5173/tcp
livekit  Up            127.0.0.1:7880-7881->7880-7881/tcp, 127.0.0.1:7882->7882/udp
```

The ignored local `.env` sets `BACKEND_PORT=18080` because another service already occupies 8080. The tracked example retains 8080. Existing services were left running.

```text
curl -fsS http://127.0.0.1:18080/healthz
{"status":"ok"}
curl -fsS http://127.0.0.1:18080/readyz
{"livekit":"reachable","status":"ok"}
curl -fsS http://127.0.0.1:5173/api/healthz
{"status":"ok"}
curl -fsS http://127.0.0.1:5173/api/readyz
{"livekit":"reachable","status":"ok"}
```

Frontend logs: `VITE v8.3.6 ready in 114 ms`. Fetching `/` returned HTTP 200 with the player document, React refresh bootstrap, and `/src/main.tsx` entrypoint. React behavior is covered by jsdom component tests; no interactive graphical browser session or media test was performed.

Stopped **only this project's LiveKit** container, probed Go, and restarted LiveKit using a `finally` cleanup:

```text
GET /healthz: HTTP 200 {"status":"ok"}
GET /readyz: HTTP 503 {"livekit":"unreachable","status":"unavailable"}
GET /readyz: HTTP 200 {"livekit":"reachable","status":"ok"}
SFU failure and recovery checks passed
```

## Issues discovered and resolved

- The first Go test invocation ran from the repository root, which has no Go module. Re-running from `backend` passed.
- Backend host port 8080 was occupied. The local override uses 18080 without changing other services.
- Vite initially failed to write its bundled config cache in `/app` as a non-root user. The frontend Dockerfile now gives `/app` and copied files to `node` and installs dependencies as that user. Rebuilt frontend starts and passes its healthcheck.

## Limits

HTTP health confirms service availability, not authenticated LiveKit SDK compatibility, ICE connectivity, participant lifecycle, screen capture, audio, codec negotiation, GPU encoding, or latency. No 1440p60 performance has been measured. No native agent, Discord integration, AWS deployment, or Milestone 2 endpoints were implemented. Git was initialized locally; no repository push or pull request was performed.
