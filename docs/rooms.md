# Rooms and local authorization (Milestones 2–3)

## Flow and API

The browser uses the existing `/api` Vite proxy. Go routes below omit that prefix. Bodies must be one JSON object (at most 4096 bytes); unknown fields are rejected. Responses carrying credentials use `Cache-Control: no-store`. Browser origins must match `APP_ORIGIN`; non-browser requests may omit Origin but still require the relevant credential. No CORS exception is added.

| Route | Credential | Body | Result |
| --- | --- | --- | --- |
| `POST /rooms` | `Authorization: Bearer <LOCAL_ADMIN_KEY>` | `{"title":"Evening room"}` | 201: server-generated ID, title, viewer invitation capability, separate publisher capability, invitation expiry |
| `POST /rooms/{id}/join` | Invitation in JSON body | `{"invite":"<capability>","displayName":"Alice","publishKey":"<optional publisher capability>"}` | 200: room-scoped token, server URL, identity, name, room ID/title, token expiry, `canPublish` derived from server-validated capability |

Room creation calls the official LiveKit protocol package's generated `CreateRoom` client with a server-only admin JWT. The backend stores authorization only after reserving capacity and removes it on SFU failure. Initial SFU creation uses a five-minute empty timeout, 20-second departure timeout, and maximum 64 participants. LiveKit may delete an empty room; joining with an otherwise valid invitation can recreate that same logical room through LiveKit's room-join semantics; an implicitly recreated SFU room uses LiveKit's server defaults. The backend's invitation expiry and capacity remain enforced independently.

The room ID has 144 random bits. The viewer invitation and publisher capability are independent 256-bit random bearer capabilities. Only their SHA-256 hashes are stored; comparison is constant-time. Room names supplied by clients cannot become arbitrary SFU room names. Missing, incorrect, expired, and unknown-room invitations all return the same 403 message. Creation requires a separately generated operator key; that credential is not placed in links or retained in browser storage. It is cleared from the form when creation starts.

Store capacity is 100 logical rooms, with expired entries pruned during creation. Invitations last eight hours, and the store is in memory. Restarting Go invalidates existing invitations, though already connected LiveKit participants may remain connected. Rooms and invitations have no persistence or selective revocation endpoint in this milestone. Global room API rate limit: 5 requests/second, burst 20; each authorized room permits 1 join/second, burst 10. This is a local abuse bound, not an internet-ready account/rate-limit system.

## Invitation versus publication

Generated viewer links use `/#room=<id>&invite=<capability>`. Joining also accepts same-origin `?room=<id>&invite=<capability>` URLs. A raw invitation token needs its explicit Room ID, and never inherits publisher authority from page state. Guest display names are optional in the UI and default to the signed label `Guest`; the backend still requires a valid nonempty name. Publisher links additionally carry `&publish=<publisher capability>`. The creator receives both capabilities once and joins with screen publishing enabled; normal join responses never return either capability. A publisher can intentionally delegate its publisher link, while a viewer has no way to derive that capability. Fragments do not reach HTTP page-request logs. Pasting the link loads a join form; it does not automatically join or request capture. The fragment is removed from the address bar after successful authorization, while the invitation remains available in the current view for copying. The application accepts invitation links only for the current frontend origin. Invitations work only on this workstation because the existing infrastructure publishes loopback host ports and advertises its private Docker bridge media address reachable from this Linux host. No remote-device access is configured.

Every join assigns an independent cryptographically random participant identity, including repeated joins and duplicate display names. Display names are labels, not verified account identities. Titles and names are trimmed, length-limited Unicode strings with control characters rejected, and rendered as text by React.

Participant JWTs expire in five minutes and grant `roomJoin` only for the authorized room, plus subscription permission. Without a publisher capability, `canPublish` remains false and no sources are granted. A valid publisher capability sets `canPublish:true` and restricts `canPublishSources` to exactly `["screen_share", "screen_share_audio"]`. Camera and microphone sources remain excluded. Data publishing, metadata changes, metrics subscription, and agent-session management remain false; room creation/list/admin/record grants remain absent. Invalid or cross-room publisher capabilities return 403. Supplying a `canPublish` field is rejected as unknown input. There is no arbitrary room-name token endpoint.

Publisher authority expires with the logical room invitation after eight hours and is lost on backend restart. It is a room-wide bearer capability, not an account role or a revocable per-person permission. The viewer and publisher fields/copy controls are separate, and the viewer link is constructed without the publisher secret. The browser capture prompt is still mandatory after authorization.

Token expiry limits initial/replayed admission credentials. It does not forcibly terminate a connected participant at five minutes. LiveKit can refresh reconnect tokens during an active session. Invitation expiry likewise blocks new backend authorizations; it does not revoke already issued JWTs or evict participants. Leave/disconnect uses the SDK, not a custom signaling service.

## Connection lifecycle

Handlers are installed before SDK connection. Initial presence reads both the local participant and the current remote participant map because connection events alone do not enumerate pre-existing guests. Participant connection, departure, and display-name changes refresh the view. Connection-state events distinguish connecting, connected, signal reconnecting, full reconnecting, and disconnected. Presence is labeled potentially stale during reconnection and resynchronized after recovery.

A terminal disconnect clears visible presence and provides an explicit leave/rejoin path that requests fresh authorization and a new identity. Unmounting or leaving removes listeners and disconnects, including a late-resolving connection. Pending HTTP requests have bounded timeouts, cancellation, and protection against updates after unmount. The existing health checks remain independent of room state.

## Boundaries and dependencies

Backend imports `github.com/livekit/protocol` auth and generated room API packages, Twirp request headers, and `golang.org/x/time/rate`; JWT/protobuf libraries also support tests. Exact versions and checksums are in `go.mod`/`go.sum`. The protocol module has media-related transitive dependencies, but the backend does not instantiate a realtime media client, receive tracks, or transcode. The full Go realtime server SDK is unnecessary for these two control-plane operations. The frontend uses `livekit-client` 2.23.0.

This remains isolated local development with documented SFU development credentials. A local process that can read `.env` or use those development SFU credentials is trusted. Internet exposure still requires real user authentication/authorization, HTTPS/WSS, secret management, invitation revocation, operational limits, and validated media connectivity. Screen video transport is implemented in the browser/LiveKit only. Optional browser screen audio is implemented; see [audio scope and limitations](system-audio.md). No microphone capture, native capture agent, or recording is implemented.

Official references reviewed during implementation:

- [LiveKit Go token and room API examples](https://github.com/livekit/server-sdk-go)
- [Official protocol room client](https://github.com/livekit/protocol)
- [Client connection/reconnection lifecycle](https://docs.livekit.io/intro/basics/connect/)
- [JavaScript RoomEvent reference](https://docs.livekit.io/reference/client-sdk-js/enums/RoomEvent.html)
