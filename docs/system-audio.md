> Current native architecture: [explicit application capture with same-headset playback](native-audio.md). Historical whole-monitor proposals below are not the production isolation model.

# Milestone 4.1 — screen audio and Linux feasibility

## Browser findings (2026-11-05)

Screen video capture, tab audio, microphone input, and whole-desktop audio are different capabilities. A working Wayland screen picker does not imply audio support. `audio:true` and `systemAudio:'include'` request/hint audio; only a returned, live `getAudioTracks()` entry establishes availability. No user-agent detection is used to invent a supported/unsupported result.

| Capture path | Finding and implication |
| --- | --- |
| Chromium tab audio | LiveKit documents selecting a browser tab and the browser's Share tab audio checkbox. This captures that tab, not other desktop applications. Test the installed browser build. |
| Chromium Linux desktop/window audio | Mozilla's current browser compatibility data describes Linux support as tab audio only. Chromium's evolving window-audio work is not evidence that desktop loopback is shipped/enabled in this installation. The app accepts a track if offered but does not promise one. |
| Firefox display audio | Mozilla's compatibility data lists display audio capture as unsupported. Video-only fallback remains usable. Firefox can still receive remote screen audio and transport explicitly supplied generated audio. |
| Microphone | `getUserMedia` is never called. There is no microphone fallback, source selector, or microphone grant. Routing a monitor into a nominal microphone source is not this feature. |
| Native PipeWire monitor | PipeWire exposes sink capture (`stream.capture.sink`) for native clients. A sink monitor represents an output mix; it is distinct from a physical microphone and may include this application's playback. Native access is subject to session policy. No routing changes were made. |
| Portal/browser boundary | The ScreenCast portal's PipeWire remote exposes only the granted screencast nodes. Browser JavaScript cannot open arbitrary host PipeWire sockets/monitor nodes. Video consent is not blanket audio authorization. |

Primary references, checked for this milestone:

- [MDN getDisplayMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia): optional audio, hints, secure context, transient activation, and per-request consent.
- [Mozilla browser compatibility source](https://github.com/mdn/browser-compat-data/blob/main/api/MediaDevices.json), `getDisplayMedia.audio_capture_support`: Chromium OS differences and Firefox unsupported audio. This is compatibility guidance, not a measurement of the installed browser.
- [Chrome screen sharing controls](https://developer.chrome.com/docs/web-platform/screen-sharing-controls): audio-picker controls and `systemAudio` hint.
- [Chromium window audio issue](https://issues.chromium.org/issues/40947205): evolving implementation; do not infer general Linux desktop capture from a window-audio hint or a code change.
- [LiveKit screen sharing](https://docs.livekit.io/transport/media/screenshare/): separate screen video/audio publications, tab audio consent, and receiving `screen_share_audio`.
- [XDG ScreenCast portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html), `OpenPipeWireRemote`: only granted screencast nodes are exposed.
- [PipeWire stream keys](https://pipewire.pages.freedesktop.org/pipewire/group__pw__keys.html): native sink capture property.

## Using browser audio

Create a room or join with a **Screen publisher invitation**. Before starting, explicitly check **Share audio from a browser tab**, then click **Start sharing** and approve the normal browser picker. If the picker offers an audio checkbox, choose it deliberately. Audio defaults off and the option applies to the next capture; stop and start to change it. A viewer invitation cannot publish.

The UI reports audio not requested, no audio returned, ended, publication failure, or published with the selected video surface and browser-reported audio sample rate/channel count (unknown fields stay unknown). A monitor video surface alone does not prove the accompanying audio is a whole-desktop mix. Settings are not measured bitrate or quality claims. A failed audio publication stops/releases its audio while video continues; retry by stopping and sharing again. Capture denial requires a new explicit click.

Each remote publisher has a named audio control row below the stream grid. There is one audio element per remote identity, regardless of video publication replacements. All begin muted locally; choose **Unmute** for each desired source, adjust its volume, and use **Mute** independently. Browser playback rejection shows an explicit **Enable audio** retry. Remote videos always remain muted, and local screen audio is never rendered. Preferences survive temporary track removal/replacement while the participant remains present, and are discarded on departure. Fullscreen contains the selected video; audio controls remain below the grid after exiting fullscreen, and audio playback continues independently.

The current picker requests exclusion of system, window and self-tab audio and leaves local playback enabled. The client publishes tab audio only when the video surface is a browser tab and the audio track reports `restrictOwnAudio: true`. Other selections continue with video and can pair the Linux application helper. The browser defines the scope of its own-document restriction. [Screen Capture specification](https://www.w3.org/TR/screen-capture/)

## Authorization and lifecycle

Only authorized publishers gain the exact LiveKit sources `screen_share` and `screen_share_audio`. Viewer grants, five-minute initial JWT lifetime, invitation/publisher capabilities, room scoping, and operator-only room creation are unchanged. Camera, microphone, data, and room administration permissions remain absent. These source grants constrain LiveKit publication labels; LiveKit cannot attest which physical input a malicious client labels as screen audio. The shipped client uses only tracks returned by the consented screen picker.

No frontend API secret or new token endpoint is introduced. Existing connected publisher grants from before this milestone do not include screen audio: leave/rejoin with a current publisher invitation. Recreating the local backend clears its in-memory invitations; create a fresh room after that update.

Stopping screen capture, the native video-ended event, leaving, cancellation, and unmount stop all owned native tracks and unpublish both sources. Ending audio alone removes only audio. Late results are discarded using the existing capture generation checks. Temporary SDK unpublication during reconnect preserves live consented video/audio for republishing without another picker. Terminal disconnect requires a fresh join and explicit capture. Remote tracks are detached, paused, and cleared on replacement/departure; they are never stopped by another listener. There is no server audio mixing, recording, or storage.

## Manual desktop audio validation — still required

The user previously reported successful real desktop **video** capture/playback in two Chrome sessions. No actual system-audio result has been supplied or automatically established for this milestone.

1. After applying the update, create a fresh room at `http://localhost:5173`; use two independent sessions. Record browser versions, selected source, PipeWire/portal versions, and headphone/output device. Keep the normal Wayland permission flow and sandbox settings.
2. In Chromium, opt in, start sharing a browser tab playing an identifiable sound, and explicitly choose Share tab audio if offered. On the second session, unmute only that publisher and check sound, volume, mute, and status. This proves tab audio only.
3. Stop, then opt in and select the entire display/window. Play identifiable audio from a **separate native desktop application**, with the shared browser tab silent. Record the offered picker audio choices, returned/published status, and whether the listener hears that application. A missing track must show a video-only fallback. Do not describe a tab-only result as desktop audio.
4. Speak near the microphone while the native app is silent. The listener should hear no microphone input. Check browser device indicators for unexpected microphone access; this client never requests it.
5. Repeat with Firefox as publisher, and cross-browser listeners. An unsupported screen-audio result is expected from current compatibility data; remote playback is a separate test.
6. Publish from both sessions, choose each source independently on a third listener if available, and verify no doubled audio. Change one volume without changing the other. Stop audio via browser controls if offered, stop screen share, leave/rejoin, and test a brief signaling interruption. Confirm no new capture prompt during ordinary reconnection and cleanup after departure.
7. Record actual heard output and any playback blocked status. Positive synthetic RTP energy alone is not proof of speakers, PipeWire monitor capture, latency, or desktop-wide audio. Do not change global audio routing to make this browser test pass.

## Native helper proposal — decision required, not implemented

Recommendation: browser-native audio is sufficient for supported tab sharing. If reliable audio from arbitrary Linux desktop applications remains required and the manual desktop test returns no usable audio, approve a separate native-helper milestone. Current documentation makes that the likely path for true desktop audio on this target; it is not needed just to play remote audio. No helper, device routing, new service, package, or helper authorization endpoint was added here.

A minimal proposed flow is an unprivileged, user-launched Linux process: explicitly select a PipeWire output monitor → capture PCM with PipeWire/session policy → encode Opus locally → publish to the same LiveKit SFU. The Go application server continues to issue authorization, never receive PCM or transcode. The helper should use a separate random participant identity to avoid evicting the browser's existing identity. Binding it to the browser's publisher and rendering its associated audio requires an authenticated server-side association, not a user-supplied display name.

A future narrowly scoped handoff would require the existing room's publisher capability and issue a short-lived, room-scoped, **screen-audio-only** helper token with a server-established owner association. Viewer invitations must not authorize it. Use a one-time local pairing/handoff or protected stdin; do not put bearer credentials in process arguments, URLs, logs, or persisted config. Define replay prevention, expiry, explicit start/stop, cancellation, disconnection, and browser/helper ownership teardown before implementing. A native process can retain OS audio access independently of the browser, so its consent and shutdown indicators must be explicit. No root privileges or host sockets mounted into Docker are appropriate.

Candidate dependencies: PipeWire client library plus session manager policy, libopus encoding, and a maintained LiveKit/Pion publishing SDK. A Go publisher with native PipeWire/Opus bindings introduces cgo packaging and callback/realtime-thread complexity; a Rust/C capture layer introduces another toolchain. Validate SDK RTP/Opus pacing, reconnect behavior, A/V synchronization and identity association in a prototype before choosing. Prefer an optional Arch PKGBUILD/user executable first, with signed releases/version compatibility documentation; defer AppImage/Flatpak until PipeWire permission and native library compatibility are understood. No background autostart by default.

Maintenance is material: distribution ABI/library changes, source hotplug and renaming, audio clock drift, sample conversion, Opus pacing, SDK upgrades, token handoff security, reconnect ownership, packaging, and integration tests on real Wayland/PipeWire hardware. Whole-sink monitoring can feed listeners' remote audio back into the room; evaluate an explicitly selected app/dedicated output route in that future milestone rather than silently rerouting the user's desktop. Estimate and accept this ongoing cost separately; no new native software is authorized by this proposal.
