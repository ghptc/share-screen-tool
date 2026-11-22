# Screen sharing — Milestone 3

## Use

1. Open `http://localhost:5173` and create a room with your local operator key. Joining never captures anything.
2. Share the separate **Screen publisher invitation** with other intended publishers. **Share invitation** continues to grant viewing only.
3. Each publisher clicks **Start sharing** and approves their browser's source picker. Capture requests video only; microphone and system audio are excluded both by capture options and source-scoped server grants.
4. Each published screen appears independently in the responsive grid, labeled with its owner and stream state. Local preview is labeled `(you)`. Fullscreen applies to the selected tile; Escape exits.
5. Stop with **Stop sharing**, the browser's sharing controls, or **Leave room**. Cancelling while a source picker is open cannot close that browser-owned picker; a later selection is discarded and stopped.

A viewer who needs to publish must receive the publisher invitation and leave/rejoin with it. There is no client-controlled permission escalation endpoint. A publisher can share its bearer link; selective revocation/accounts remain outside this local milestone.

## Capture and transport

`navigator.mediaDevices.getDisplayMedia` is called directly from the start button before any await. Constraints are `audio:false` and video width/height/frameRate with ideal values 2560/1440/60. No `min` or `exact` constraints, automatic recapture, X11 assumptions, or host socket/GPU mounts are added. Unexpected non-selected tracks are stopped immediately.

The selected native video track is wrapped in LiveKit's `LocalVideoTrack` and published as `Track.Source.ScreenShare`. VP8 is the initial compatibility choice, with simulcast requested, an 8 Mbps maximum encoding bitrate and a 60 FPS maximum encoding rate, and balanced degradation. These are limits/requests, not measured throughput or a sustainable 1440p60 guarantee. The installed SDK disables screen simulcast on Firefox because of its known layer issue. Codec comparisons remain future work. The stabilization pass adds read-only measured RTP diagnostics, without audio or new quality controls.

The existing `adaptiveStream`/`dynacast` room settings remain enabled. Offscreen subscriptions may pause by design; scroll a tile into view before checking its playback. Each actual video element is attached through the SDK, allowing subscription adaptation to its visible size. The Go backend issues grants and creates rooms; it never receives/transcodes raw frames. SFU infrastructure, ports, credentials, and health checks were retained.

Browser-reported capture settings at start remain explicitly labeled as distinct from transmission. Each tile now has Runtime diagnostics with counter-derived encoded/decoded FPS, resolution, video RTP bitrate, codec, packet loss, RTT, ICE/DTLS, and visibility/subscription state. `getSettings().frameRate` is a capture setting, not a counted frame rate. Encoding, remote rendering, and bandwidth adaptation may reduce resolution/FPS. No 1440p60 claim has been established.

## Lifecycle and cleanup

The grid is rebuilt from each participant's screen video publications, including pre-existing publications for later joiners. Keys combine participant identity and track SID. Publication/subscription, mute, stream state, participant departure, name changes, and reconnect events refresh the snapshot. Repeated events do not add duplicate elements. A track replacement detaches the old SDK track before attaching its replacement. Cleanup always clears `srcObject`; remote tracks are detached without stopping someone else's capture.

A single local capture operation is allowed at a time. Generation checks discard late chooser or publish results after cancellation, leave, disconnect, or unmount. Cancellation during publication stops local capture immediately and unpublishes when the pending publication settles. An unresolved native picker cannot be dismissed by JavaScript; its eventual track is still stopped. A lingering publication blocks a new capture rather than creating duplicate local screens.

LiveKit automatically unpublishes a screen when its native track ends. The application observes that event and clears the local state. During full SDK reconnection, a temporary unpublish of a still-live screen is preserved for the SDK's republish operation; it is not treated as user cancellation. A terminal disconnect unmounts the media view and stops local tracks. New capture after that requires a fresh button click and browser consent. Signaling-interruption recovery has been exercised with real media transport; full-network failure recovery has only component coverage so far.

## Manual Wayland check still required

Use the installed Chromium and Firefox under Hyprland. Do not change Wayland permissions or browser sandbox/privacy policies to make capture pass.

- Create a fresh room; use two independent browser sessions with publisher invitations. Confirm neither prompts for capture on join.
- Start from each browser's button. Approve the normal portal picker, then test the offered window/display/tab sources individually. Record browser version, source type, portal version, and browser-reported capture settings. A browser may not offer every source type.
- Verify both screens appear concurrently, fullscreen each remote screen, and observe actual decoded playback. Test native browser **Stop sharing**, explicit stop, leaving while publishing, and late joining.
- Deny/cancel permission and confirm no screen remains live. Leave with a picker open, then select a source and verify it is discarded.
- Test a controlled network interruption and ensure capture does not restart without consent after a terminal disconnect. Do not interpret successful signaling recovery as proof of full ICE restart recovery.

The original forced loopback candidate prevented Firefox ICE connectivity. The stabilization pass removed that override; the SFU now auto-selects its existing private Docker bridge interface while host port bindings stay on loopback. Firefox generated-media tests now connect and play without preference changes. Actual desktop capture remains unverified. Follow [the detailed native-capture procedure](desktop-validation.md). See [Linux findings](linux-capture.md) and [test evidence](milestone-3-validation.md).

## References

- [LiveKit screen sharing](https://docs.livekit.io/transport/media/screenshare/)
- [LiveKit source-scoped grants](https://docs.livekit.io/home/server/generating-tokens)
- [MDN getDisplayMedia: constraints, activation, and consent](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)
- [Hyprland screen sharing](https://wiki.hypr.land/Useful-Utilities/Screen-Sharing/)

## Runtime diagnostic interpretation

Diagnostics sample native sender/receiver reports every two seconds without overlapping requests. Stream IDs reset baselines after replacement/reconnection; counters that reset, repeat timestamps, or span gaps over ten seconds do not produce fabricated rates. Outbound bitrate sums primary simulcast layers, excluding RTX/FEC; outbound FPS/resolution describe the largest currently active layer. Inbound FPS uses `framesDecoded` deltas, while the displayed received resolution uses the video element's actual decoded dimensions when available.

Inbound packet loss is the interval's nonnegative lost delta divided by received-plus-lost. Late-packet corrections cannot produce a negative loss percentage. Outbound loss is the latest SFU RTCP feedback for the selected layer, labeled separately; it is not receiver end-to-end loss. RTT is to the SFU, not a display-latency measurement. Unsupported fields are unavailable, and zero is shown only when counter samples actually establish zero.

The main tile differentiates **Adaptive pause** (subscription disabled by visibility) from **Paused by SFU** (stream-state pause). Viewport visibility, tab visibility, subscription-enabled status and sampled FPS can distinguish an expected offscreen pause from a visible-video stall. Fullscreen retains the same video element and SDK attachment. No blanket disabling of adaptation or manual forced subscription was added.
