# Arch / Hyprland / Wayland capture notes

**Stabilization update:** the earlier Firefox failure described below was resolved by removing the forced `rtc.node_ip: 127.0.0.1`. LiveKit now auto-selects its existing private Docker bridge address (observed `172.30.0.2`); all published host ports remain loopback-bound. Default Firefox now joins and plays generated video without privacy or capture-policy changes. These results do not validate real portal capture. See [current stabilization evidence](milestone-3-stabilization.md) and [manual desktop procedure](desktop-validation.md). The table below is the original Milestone 3 record.

Initial documentation review: 2026-11-05. Milestone 3 now implements browser-native video capture. The findings below distinguish generated-media transport checks from interactive portal validation. Never bypass Wayland permissions, force X11 capture, or disable the browser sandbox to make capture work.

## Four distinct paths

| Path | What it provides | Limitation / next validation |
| --- | --- | --- |
| Browser `getDisplayMedia` | User-selected screen/window/tab video with a browser permission prompt and, on Wayland, desktop portal integration | Requires a secure context and explicit user action; requested constraints do not prove delivered resolution/FPS |
| Browser screen audio | Optional audio tracks returned alongside display video | Browser, OS, and selected surface determine support; requesting `audio` or `systemAudio: include` does not guarantee an audio track |
| Native PipeWire audio | A native process can work with audio sources/monitor nodes through PipeWire and session policy | Browser JavaScript cannot open arbitrary PipeWire nodes. Native audio capture is distinct from the screen portal's video stream and requires an explicit consent/routing design |
| Future native Linux agent | Could capture permitted desktop/audio sources and publish through LiveKit | Deferred. Consider only after an actual browser proof of concept establishes a required capability is unavailable; define permissions, credentials, packaging, and lifecycle first |

Browser tab audio is not the same as desktop system audio. Check `getAudioTracks()` after capture rather than displaying an audio success state solely because audio was requested. Do not silently substitute microphone audio. Test the installed Chromium and Firefox versions independently with tab, window, and entire-display sources; record the browser version, portal version, selected source, returned tracks, and any unsupported options.

For the target Hyprland session, verify PipeWire, WirePlumber, `xdg-desktop-portal`, and `xdg-desktop-portal-hyprland` are installed and working. These run on the host; do not mount host capture sockets or GPU devices into the application containers. The browser on the host handles capture. Check the existing environment before changing packages or user services:

```sh
pacman -Q pipewire wireplumber xdg-desktop-portal xdg-desktop-portal-hyprland
systemctl --user status pipewire wireplumber xdg-desktop-portal xdg-desktop-portal-hyprland
```

Follow the current compositor documentation when diagnosing portal activation. Do not install competing portal backends indiscriminately or restart a user's desktop session automatically. Localhost is suitable for later secure-context browser development; cross-device testing needs a separately designed HTTPS/media configuration.

## Quality validation deferred to media milestones

Compare H.264, VP9, and AV1 using actual browser capabilities, negotiated codec statistics, and the pinned server's release notes. Capability advertisement is not evidence of hardware acceleration. In particular, an RTX 5070 does not ensure browser NVENC selection; LiveKit v1.13.11 release notes also include disabling AV1 for Firefox, so browser/server combinations must be tested.

Use measured capture settings and WebRTC reports to distinguish requested 2560×1440/60 from actual capture, outbound encoding, and inbound rendering. Calculate bitrate and packet-loss rates from report deltas, identify codec through the relevant codec report, and label missing fields as unavailable. RTT is not glass-to-glass latency; validate end-to-end delay separately. Adaptive subscription/dynacast and sustainable quality selection are future work, with stability taking priority over target quality.

The user subsequently reported real desktop video capture and playback in two Chrome sessions. Milestone 4.1 adds optional browser-returned screen audio and validates generated Opus transport in Chromium and Firefox; actual desktop audio, GPU encoding, latency, and 1440p60 remain unvalidated. No native PipeWire agent or audio routing workaround is implemented. See [audio findings and the manual capture procedure](system-audio.md).

## Milestone 3 browser findings

The host reports `XDG_SESSION_TYPE=wayland` and `WAYLAND_DISPLAY=wayland-1`. Installed versions: Chromium 156.0.8078.47, Firefox 158.0.1, PipeWire 1.6.10, WirePlumber 0.5.18, xdg-desktop-portal 1.22.1, and xdg-desktop-portal-hyprland 1.4.1. All four user services reported `active`. These checks did not capture the desktop or change session services.

| Browser/check | Observed result | What remains unverified |
| --- | --- | --- |
| Playwright Chromium 158, sandbox enabled | Two generated screen-video publishers connected to real LiveKit; both browsers decoded both streams; fullscreen, stop, signaling recovery, and departure passed | Interactive source picker/portal; real screen content; hardware encoding; requested 1440p60 |
| Playwright Firefox 159, default profile | Signaling reached LiveKit but ICE failed to complete against its loopback candidate; both media tests timed out at initial room connection before capture | Screen publication/playback and portal behavior in Firefox |
| Installed Chromium 156 / Firefox 158 under the user's Wayland session | Binaries and active host capture services confirmed | No interactive capture permissions were approved during automated validation |

Mozilla's [loopback ICE restriction report](https://bugzilla.mozilla.org/show_bug.cgi?id=1973521) supports loopback policy as the likely cause of the Firefox result. SFU logs show a loopback local candidate with no successful ICE responses. This is an inference from the logs and browser policy; it is not proof that Firefox screen capture or PipeWire is broken. Browser privacy preferences, host networking, TURN, public addresses, and SFU bindings were not changed to force a pass. Use the currently validated Chromium transport path for local testing; a separate connectivity investigation is needed for Firefox.

The app uses the normal MediaDevices permission flow and ideal constraints in both browsers. Audio is always false. The installed LiveKit SDK requests VP8 and disables screen-share simulcast on Firefox automatically; no application workaround is added. Browser/GPU codec and acceleration testing remains deferred. Follow the [manual checks](screen-sharing.md) before reporting desktop capture compatibility.

## References

- [MDN: getDisplayMedia constraints, consent, and audio limitations](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)
- [ArchWiki: XDG Desktop Portal](https://wiki.archlinux.org/title/XDG_Desktop_Portal)
- [Hyprland screen sharing](https://wiki.hypr.land/Useful-Utilities/Screen-Sharing/)
- [LiveKit client SDK: adaptiveStream and dynacast](https://docs.livekit.io/reference/client-sdk-js/)
- [LiveKit v1.13.11 release notes](https://github.com/livekit/livekit/releases/tag/v1.13.11)
