# Local player

The workstation joins `whiterun-local` when you open [Whiterun Live](http://localhost:5173). Each tab gets a separate identity. A refresh returns to the room as a listener. Available space goes to the screens, with a small control bar over the picture. The audio popover and screen focus respond to Escape, and the controls support Tab, Enter, and Space.

## Desktop startup and permissions

Run `./scripts/start-local` once from the checkout in your desktop login. It builds the helper with libopus, starts the project's existing Compose stack, and registers a transient systemd user socket. The frontend talks to the launcher over that mode-0600 socket inside a private directory. PipeWire runs with the desktop user's existing permissions.

| Action | What happens |
| --- | --- |
| Open the player | Join and subscribe. Screen and audio capture are off. |
| Share audio | The checkbox beside Start sharing defaults on. The browser remembers changes to this preference. Capture starts only after a screen is approved and published. |
| Start sharing | Choose a window or monitor in the browser/Wayland picker. Cancellation leaves capture off. With Share audio enabled, the player now discovers eligible applications. |
| One eligible application | The helper connects automatically. An eligible stream is a running application playback node with separate left and right output ports. |
| Several applications | The last successfully shared stream wins if it still exists. Otherwise the source chooser opens. Choosing a name starts its share immediately. |
| Waiting for audio source | Video continues while the player checks for an application every two seconds. A game that starts later can join the same authorized share. |
| Change source | Open the audio control and choose a different application. The old session is revoked before the next pairing attempt. Remote volume and mute remain independent. |
| Enable audio | Shown if browser autoplay policy blocks audible remote playback. One click retries unmuted participants. |
| Turn off Share audio | Revoke this audio share. Local playback and screen video continue. |
| Stop sharing, close the tab, or use the browser's stop control | Release screen capture and end its helper session. A new share needs fresh consent. |

Selection uses the running PipeWire applications. The video picker identifies a display surface and cannot reliably identify the game process. A sole eligible music player can therefore be the selected application. Use the audio control to see the selected source or turn audio off.

The player requests neither camera nor microphone permission. Desktop audio uses an application tap. It does not need a browser microphone permission, OS audio-device chooser, second headset, virtual output, or change to the default sink.

## Authorization and lifetime

The local MVP trusts a single workstation and processes with access to its loopback services. Compose publishes its ports on loopback. The Vite development server issues a signed eight-hour HttpOnly, SameSite=Strict browser session on document navigation at the configured localhost origin. The player gateway requires that session, the configured host and origin, same-origin fetch metadata and JSON POSTs. It checks the TCP peer against loopback or the host-facing Linux Docker gateway and rejects forwarded requests. Its server-only credential permits the backend to issue a five-minute LiveKit token for the fixed room, with screen video, screen audio and subscription grants. Closing or refreshing the page discards the in-memory participant grant. An interrupted connection first uses SDK recovery. A terminal disconnect requests a fresh identity and returns to listening.

When starting an audio-enabled share or enabling audio during a share, the backend verifies the owning browser's published screen in LiveKit. The browser opens an authenticated session watch. The desktop launcher passes a single-use code into the helper's stdin and supplies the selected application's serial internally. The local launcher claims codes only for the fixed local room. The helper receives a short-lived audio-only grant and renews a screen-bound lease. Stopping or losing the owner watch revokes it. A crashed helper loses its lease and the child capture process exits with its parent.

The helper attaches a temporary capture node to the game's two output ports and verifies both links. The game's existing path to the headset and remote playback's path to that same headset stay intact. The saved preference contains the PipeWire core cookie and stream object serial. The native helper verifies that instance and the actual stereo links before encoding. A running share stays pinned to its selected stream. A helper or signaling interruption can recover on that stream while the same consented screen is live. If the application exits, another stream, even one with the same name, needs selection. The player shows the current application in the audio menu and checks for new choices while it is open. Desktop output changes follow normal playback policy. [PipeWire core instance identifier](https://docs.pipewire.org/devel/core_8h_source.html)

The local player supports native stereo applications at 48 kHz. Its source list excludes known browser and communications mixes, device monitors, and ambiguous channel layouts. This also excludes a game mixed inside the room's browser.

The launcher can stay idle between sessions. It has no PipeWire capture stream while idle and starts no helper at login. Its transient socket belongs to the desktop user manager. To take this project offline, stop its socket and service (if active), then its containers:

```sh
systemctl --user stop whiterun-live-launcher.socket
systemctl --user stop whiterun-live-launcher.service
docker compose down
```

The local gateway is a development-server feature. Existing secured invitation links and the operator flow remain available at `/rooms`. The bundled SFU advertises workstation-local connectivity. A second physical workstation needs separately authorized, reachable room infrastructure.

## Automated checks

For the desktop integration, use a separate local test SFU and frontend. The runner builds the player and helper, starts an isolated Compose project on localhost ports 15173 and 17880–17882, runs the Chromium and Firefox suites, measures both browser renderers on the named physical headset, and tears down its own services. It uses the same application tap, credentials protocol and private socket as the player. Run from the repository with frontend dependencies and both Playwright browsers installed.

```sh
PLAYER_AUDIO_TEST_SINK=alsa_output.usb-HP__Inc_HyperX_Cloud_II_Wireless_0-00.analog-stereo \
  ./scripts/test-game-audio
```

The integration generates quiet audio in real PipeWire application streams and substitutes canvas video at the screen-picker boundary. On a shared workstation, the tests filter the **returned discovery list** to their own running fixtures so they can exercise zero, one and multiple candidate states. The previous-source test also uses the full workstation list. The helper validates real object identities and links, and audio travels through the real SFU. Render-level measurements use the tagged browser outputs. Real-game listening remains a separate release gate.

## Automatic sharing measurements

The frontend passed 75 unit and component tests. The backend and native helper passed the Go race detector and vet. The backend's LiveKit integration test ran against a local SFU, and all five native measurement and graph tests passed. Chromium and Firefox each passed 14 end-to-end scenarios, including late source discovery, remembered selection, same-name replacement, helper cleanup and signaling reconnection. Each browser skipped the separately enabled whole-output-monitor diagnostic.

In a 60-second simultaneous share through the private launcher and one HyperX output, Chromium and Firefox each rendered one remote Opus stream. Each renderer supplied 2,644,800 stereo frames in the steady interval. Chromium reported 1,008 concealed samples during startup. After the first five seconds, both receivers added zero lost packets and zero concealed samples. The strongest measured own tone relative to the intended remote tone was −76.3 dB for Alice and −80.3 dB for Bob.

Changing Alice’s remote volume from 30% to 60% changed her measured amplitude by a factor of 2.006 and Bob’s by 1.000. After a forced helper exit, the old tap disappeared, a new helper attached to the same game, remote playback resumed, and stopping the screen removed the replacement tap. The original headset playback links and default output were preserved. The fixture used generated screens and test applications. Real-game listening confirmation is pending. [Measurements and example PipeWire links](automatic-game-audio-results.json)

## Previous manual-selection milestone

On 22 November 2026, the player ran against the local Go API and LiveKit SFU with Chromium 158 and Firefox 159. The frontend production build, 73 component tests, backend and native Go race tests, Go vet, and five native audio measurement/graph tests passed. Each browser passed 13 end-to-end scenarios. They exercised automatic entry, access rejection, initial join retry, screen consent and denial, one- to three-stream layouts, keyboard focus, fullscreen, refresh, real signaling reconnection, removal and invitation compatibility. The separately opt-in whole-output-monitor diagnostic was skipped. A direct bridge request received no player session. A clean local browser visit displayed **Connected** with zero media elements before anyone published.

| Player-driven hardware exercise | Result |
| --- | --- |
| Two publishers and two subscribers, one physical HyperX on one host, 60 seconds | One playing remote Opus stream per listener. Across the steady measurement interval, each browser rendered 2,668,800 stereo frames with zero additional lost packets or concealed samples. |
| Own signal in the browser render path | At most −77.0 dB relative to the remote tone for Alice and −82.7 dB for Bob in the 60-second run. The local game's original headset links stayed active throughout. |
| Alice changes Bob's slider from 30% to 60% | Alice's measured playback amplitude increased by 2.006×. Bob's remained at 1.000×. |
| Stop only the audio, then stop the screen | Audio-only stop removed the capture tap and preserved the published screen. Stopping Alice's screen removed her tap while Bob's audio continued playing for Alice. |
| Source exit, forced capture-helper exit, owner browser closed | Both taps were gone by the end of each run. The final tap cleanup checks completed in 144 ms, 39 ms, and 3.96 s respectively, including browser shutdown in the last case. The headset remained the default output. |

The measurements are from the digital paths into the headset. The screen picker was substituted in automation, and the game audio came from test applications. Real-game listening confirmation through the user's HyperX remains pending. [Run summaries and example PipeWire links](local-player-audio-results.json)
