# Interactive desktop validation — action still required

**Status: NOT RUN.** Automated generated-video tests do not validate the desktop picker, PipeWire screen content, the monitor, or native browser sharing controls. This procedure deliberately leaves source selection and approval to you. Do not add auto-select capture flags, disable browser sandboxes, or change Firefox privacy preferences.

## Prepare the existing local stack

From the repository root:

```sh
docker compose up -d --build --wait --wait-timeout 120
curl -fsS http://127.0.0.1:18080/readyz
systemctl --user is-active pipewire wireplumber xdg-desktop-portal xdg-desktop-portal-hyprland
```

This checkout uses backend host port 18080; fresh configurations default to 8080. The frontend stays at `http://localhost:5173`. Read the local operator key from your ignored `.env`; do not put it in a report. The SFU uses its existing private Docker bridge interface for media, with all published host ports still bound to loopback. This arrangement is for browsers on this Linux Docker host, not another device or Docker Desktop VM.

Open **two independent Chrome/Chromium profiles or a normal and private window**. Place both windows side by side, with the incoming video tiles visible. Then repeat with Chrome/Chromium plus Firefox. Record actual installed versions (Chrome/Chromium are distinct distributions). Check `chrome://version` and `about:support`; confirm the browser is using the Wayland session rather than assuming headless test results establish that.

## Join without capture, then approve real sources

1. In window A, open `http://localhost:5173`. Enter name `Desktop A`, a room title, and the operator key, then choose **Create and join room**. Confirm no capture picker appeared merely from joining.
2. Copy **Screen publisher invitation** into window B. Enter `Desktop B` and join. Both participant lists should show two identities; neither should have captured yet. The ordinary **Share invitation** field remains view-only.
3. Click **Start sharing** in A. In the normal browser and Hyprland portal picker, select and approve the **monitor/display** at least once to test real desktop capture. Record the source type offered/selected. A denied or cancelled picker should show a useful error and leave no active stream.
4. Click **Start sharing** in B and approve a separate permitted window/display source. No microphone, tab audio, or system audio is requested. Do not substitute generated canvas/video as a source in this check.
5. Confirm each browser shows both the local preview and the other participant's actual desktop/window stream simultaneously. Move a window or show moving content to prove the remote stream updates. A static desktop can legitimately produce low encoded FPS. Screen feedback from capturing the viewer itself can increase load; a separate application window is useful for the second source.

## Measure actual playback and adaptation

For each **remote** tile, expand **Runtime diagnostics**. Allow at least two two-second sampling intervals with the tile visible, then **Copy diagnostics**. Record local encoded and remote decoded results separately.

- **Decoded resolution** is the received/decoded video size; **Decoded FPS** comes from `framesDecoded` deltas. The sender's requested 2560×1440/60 and browser-reported capture settings are separate facts.
- **Video RTP bitrate** is a measured primary-stream byte-counter delta, not the configured 8 Mbps cap or total link bandwidth. Local bitrate sums primary simulcast layers; local encoded FPS describes the largest active layer rather than summing layer rates.
- Record negotiated codec, packet loss, RTT to SFU, ICE/DTLS state, video viewport/tab visibility, and subscription-enabled state. Missing fields remain `unavailable`; do not convert them to zero. RTT is not glass-to-glass latency.
- Move/animate the shared source for ten seconds. While a remote tile and browser tab are visible, confirm decoded frames continue, the subscription is enabled, and there is no unexplained adaptive pause.
- Fullscreen one remote tile using its button. Keep it fullscreen for ten seconds while the source moves. Confirm playback progresses and record diagnostics. Escape should return to the grid with both streams still present and playback recovering in visible tiles without a new capture prompt.
- Scroll a remote tile fully offscreen or background its tab. Adaptive pause is expected there. Bring the tab/tile back into view and wait up to ten seconds. Subscription and decoded playback should resume. A tile that remains paused while both viewport/tab visibility say `yes` is a failure to record, not something to hide by disabling adaptation.

## Signaling-only interruption with real capture

This optional DevTools procedure affects only that page's SFU WebSocket. It does not modify application permissions, media, or browser policy. Install it **before joining** in one validation window (reload that window first if already connected). Leave the other participant connected.

```js
window.screenShareValidationSockets = [];
const NativeWebSocket = window.WebSocket;
window.WebSocket = class extends NativeWebSocket {
  constructor(url, protocols) {
    super(url, ...(protocols === undefined ? [] : [protocols]));
    if (new URL(url, location.href).port === '7880') {
      window.screenShareValidationSockets.push(this);
    }
  }
};
```

Join, start sharing, and approve the normal picker. After both streams are playing, run:

```js
window.screenShareValidationSockets.at(-1)?.close(4000, 'Manual signaling interruption');
```

Observe a reconnecting state followed by connected, with the existing capture still live and no new picker. Verify new decoded frames after recovery. This tests signaling interruption; it does not establish behavior after prolonged network loss or SFU process failure. Reloading the page removes the instrumentation. Do not save socket URLs or tokens in the results.

## End capture and verify cleanup

- Use the browser's native **Stop sharing** control in A. Its tile should disappear from both views. B's independent stream must continue.
- Restart A only through another **Start sharing** click and picker approval. Stop A with the app's **Stop sharing** button and confirm both views remove only A's tile.
- Leave B while it is publishing. Its capture indicator and remote tile should disappear; A's participant list should update.
- Rejoin with an ordinary viewer invitation. Confirm playback works, the sharing button is absent, and joining does not prompt for capture.
- Leave with a source picker open, then complete/dismiss that picker. No late capture should remain live or be published to the old room.

## Result worksheet (fill only after performing the checks)

| Field | Chrome → Chrome | Chrome ↔ Firefox |
| --- | --- | --- |
| Status | NOT RUN | NOT RUN |
| Date, browser builds, Wayland backend | | |
| Source types and explicit picker approval | | |
| Two simultaneous real desktop publishers | | |
| Browser-reported capture settings | | |
| Actual local encoded resolution/FPS | | |
| Remote decoded resolution/FPS, bitrate, codec | | |
| Packet loss, RTT, ICE/DTLS | | |
| Visible/offscreen/fullscreen recovery | | |
| Signaling recovery without another picker | | |
| Native stop/app stop/leave cleanup | | |
| Errors/blockers | | |

Attach only the summarized diagnostics, not desktop recordings, screenshots, invitation links, operator keys, or access tokens. A measured sustained result is required before claiming 1440p60.
