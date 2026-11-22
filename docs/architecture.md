# Local foundation decisions

Stabilization update: the forced loopback ICE advertisement was removed for Firefox compatibility. LiveKit now detects its existing private Docker bridge interface; published host ports remain on loopback. See [stabilization evidence](milestone-3-stabilization.md) for current behavior.

Reviewed official documentation on 2026-11-05. This records the Milestone 1 foundation. Current room behavior and dependency decisions are documented in [rooms.md](rooms.md); its Milestone 2 implementation supersedes the planned dependency/authorization paragraphs below.

## Components and responsibilities

The React browser application talks to Go through Vite's same-origin development proxy. Go uses `net/http`, `log/slog`, environment configuration, bounded HTTP timeouts, and graceful signal shutdown. LiveKit runs separately as the SFU. Future browser clients connect directly to LiveKit for media; Go will authorize room access and sign tokens, never relay or transcode raw video.

No database or Redis is needed for this single-node foundation. A Docker bridge with loopback-only published ports keeps local service DNS simple and avoids the broad host exposure of host networking. Explicit loopback media advertisement deliberately limits this configuration to one workstation. Media connectivity remains unvalidated until real participant tests.

Liveness (`/healthz`) reports that Go serves requests. Readiness (`/readyz`) checks LiveKit's root HTTP endpoint with a two-second timeout; it does not validate SDK authentication or ICE. Backend Compose health uses readiness so the frontend starts after SFU reachability. The frontend reports liveness independently and supports manual retry.

## Dependencies and compatibility

- Backend foundation: Go 1.26+, standard library only. No third-party modules means no `go.sum` is generated.
- Frontend runtime: React and React DOM. Vite, its React plugin, and TypeScript provide the build. Vitest, jsdom, and Testing Library provide component tests. Exact versions and transitive integrity hashes are in `frontend/package-lock.json`; use `npm ci`.
- Media server: official `livekit/livekit-server:v1.13.11`, the latest stable release observed during review. The Go and Node build images track their chosen release lines; the lockfile pins npm packages. Production image digests and an update policy are future deployment work.
- Planned browser media dependency: `livekit-client` v2 (reference documentation currently v2.23.0). LiveKit's React components are optional; plain React plus the client SDK suffices for a custom screen grid.
- Planned backend dependency: `github.com/livekit/server-sdk-go/v2` for room APIs; token signing uses its documented protocol auth package. Install and pin the then-current compatible versions when room work begins. Avoid the server SDK's realtime media features on the application backend.

The SDK v2 major does not imply that the SFU server must use a matching major. These are independently versioned projects. The documented SDKs support self-hosted LiveKit, but this milestone has **not** tested an SDK/server room connection. That compatibility check belongs to Milestone 2, with token/API integration coverage. No unused media dependencies or token endpoints are added now.

## Security boundaries

Development credentials stay in the isolated SFU setup; no key or secret is embedded in frontend code. The API only provides two read-only health routes. No media capture starts, no recording services are present, and no media is stored. Docker exposure is restricted to loopback; this is not a production authorization model. Backend container runs as a non-root user with read-only root filesystem and dropped capabilities; frontend also runs as non-root. Go configuration errors fail startup instead of silently ignoring invalid origins.

Before internet access: define participant authentication, invite access and revocation, room ownership/lifecycle, token TTL and grants, creation/rate limits, HTTPS/WSS, and ICE/TURN reachability. No AWS services are provisioned.

## Official references

- [LiveKit local setup and development credentials](https://docs.livekit.io/transport/self-hosting/local/)
- [LiveKit ports and single-port UDP mux](https://docs.livekit.io/transport/self-hosting/ports-firewall/)
- [LiveKit server releases](https://github.com/livekit/livekit/releases/tag/v1.13.11)
- [JavaScript client SDK v2](https://docs.livekit.io/reference/client-sdk-js/)
- [React quickstart and optional component packages](https://docs.livekit.io/transport/sdk-platforms/react/)
- [Go server SDK installation and auth examples](https://github.com/livekit/server-sdk-go)
- [Vite runtime prerequisites](https://vite.dev/guide/)
