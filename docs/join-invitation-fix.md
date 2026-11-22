# Join invitation regression fix — 2026-11-05

## Exact causes

The old Join button used `disabled={pending || !name.trim() || !link}`. With a populated invitation field and no pending HTTP request, an empty shared display-name field was the remaining disabling condition. That field sits above both forms and looked like creation setup. The operator key was never part of the guest button condition or guest request headers.

Two additional defects affected the reported URL workflow: the parser read only the URL fragment (`#room=...&invite=...`) and ignored query parameters; the input used `type=url`, so native form validation rejected an opaque raw token even if the JavaScript button was enabled. Input/location state was initialized once, without handling later history/hash navigation. There was no hidden publish-permission or operator-key check preventing guest authorization.

## Behavior after the fix

- A structurally valid invitation enables guest joining unless a request is pending. An omitted/whitespace-only display name uses the explicitly documented label `Guest`. Room creation still requires its display name, title, and operator key.
- Same-origin full URLs support query parameters, fragments, or unambiguous parameters split between them. Duplicate/ambiguous room/invite/publish parameters, malformed values, URLs containing credentials, and external origins are rejected.
- Raw invitation tokens are accepted as text with an explicit Room ID, prefilled from the page URL when available. An opaque token cannot identify its room and never inherits a publisher capability from the page URL or a previously entered publisher link.
- Pasting a full link updates its room context. Browser history/hash navigation updates the form while it is not joined or authorizing. Active room sessions are not replaced merely by address changes.
- Guest requests contain only the room invitation, display name, and an explicitly supplied publisher capability where present. They never include the local operator key.
- Successful joins normalize retained share links to the existing fragment format and remove credential query/hash parameters from the address bar while retaining unrelated query parameters.

The backend and infrastructure were not modified. The server remains authoritative for capability validity, expiration, participant identity, room scope and publication grants. Structurally valid but incorrect/expired secrets still return 403. Viewer links remain subscription-only; a valid explicit publisher key permits only `screen_share`; token lifetime stays five minutes.

## Test evidence

Before the fix, three new regressions failed on the old code: populated invitation/empty name stayed disabled, query URL failed to populate, and the token input was still `type=url`.

After the fix:

```text
npm --prefix frontend test
Test Files 5 passed (5)
Tests      41 passed (41)

npm --prefix frontend run build
TypeScript checking passed
vite v8.3.6: 21 modules transformed
built in 137ms
```

The existing nonfatal bundle-size warning remains. Backend checks were uncached and used only their own test room:

```text
LIVEKIT_INTEGRATION_URL=http://127.0.0.1:7880 go test -race -count=1 ./...
ok internal/config 1.003s
ok internal/httpapi 1.005s
ok internal/rooms 1.038s
go vet ./...   # exit 0
```

Browser command from `frontend`:

```sh
E2E_BUILT_FRONTEND=1 npx playwright test e2e/join-invitation.spec.ts
```

Actual result:

```text
✓ query invitation enables an unnamed guest and joins a second independent context without an operator key (6.7s)
✓ raw tokens require room context; malformed and unauthorized invitations are rejected (3.4s)
✓ query publisher keys remain explicit and raw tokens cannot inherit them (711ms)
3 passed (11.1s)
```

Each test uses two independent Chromium contexts and the real running backend/SFU. It verifies actual participant presence, guest request headers, viewer/publisher JWT claims and their 300-second TTL. Neither backend authorization nor the SDK is mocked. These are join/connectivity checks; they do not capture a desktop or claim new media-performance validation.

## Non-disruptive verification and rollout

A real publisher was active during this fix. No running service was restarted and no shared frontend file was hot-reloaded. In `E2E_BUILT_FRONTEND=1` mode, only the isolated test contexts load the fixed production entry/CSS; they keep the actual localhost document response, API requests, Origin, WebSocket and WebRTC transport. Replacing the whole HTML response initially caused Chromium local-network classification to reject the SFU; limiting substitution to JavaScript/CSS resolved that test-fixture issue without granting permissions or weakening browser security.

Without this environment flag, the new tests validate the ordinarily served frontend after deployment. Build first when using artifact mode. Do not count a built-artifact pass as proof that the currently served frontend has been updated.

After all artifact regressions passed, the user explicitly approved applying the live frontend update and rejoining/restarting sharing if needed. Applied only:

```sh
docker compose up -d --build --no-deps --wait --wait-timeout 120 frontend
```

The frontend is healthy. The backend and LiveKit were not restarted by this update, so room authorization state/invitations were preserved. The final updated Node 24 container passed all 41 frontend tests and the production build (140ms, same retained bundle-size warning).

Then ran `npm run test:e2e` with **no asset substitution/environment flag** against the normally served updated app:

```text
✓ query invitation enables an unnamed guest and joins a second independent context without an operator key (6.3s)
✓ raw tokens require room context; malformed and unauthorized invitations are rejected (3.5s)
✓ query publisher keys remain explicit and raw tokens cannot inherit them (839ms)
✓ generated video through real SFU: two publishers, reconnect, fullscreen, stop, and departure (10.5s)
✓ mocked capture permission rejection in a real browser leaves no stream (382ms)
✓ two independent sessions: authorized joins, presence, departure, and rejoin (12.4s)
✓ an invalid invitation is rejected in the browser (182ms)
✓ real signaling interruption reconnects automatically (3.5s)
8 passed (37.9s)
```

Refresh an existing guest/incognito page to receive the fix. No unrelated service/infrastructure or backend code changed. Changes are staged without a commit or push. Milestone 4 was not started.
