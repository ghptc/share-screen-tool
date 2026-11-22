import { applyVideoTarget, nativeTarget, type VideoTarget } from './videoQuality'
import NativeAudio from './NativeAudio'
import RemoteScreenAudio from './RemoteScreenAudio'
import {ScreenTile, type Screen} from './ScreenTile'
import PlayerStage from './PlayerStage'
import { useEffect, useRef, useState } from 'react'
import { ConnectionState, LocalAudioTrack, LocalVideoTrack, RoomEvent, Track, type LocalTrackPublication, type Room, type TrackPublication } from 'livekit-client'

type Owned = { track: LocalVideoTrack; stream: MediaStream; ended: () => void; audio?: LocalAudioTrack; audioEnded?: () => void }
export const captureOptions: DisplayMediaStreamOptions = {
  audio: false,
  video: { frameRate: { ideal: 60, max: 60 } },
}

function captureError(cause: unknown): string {
  const name = typeof cause === 'object' && cause !== null && 'name' in cause && typeof cause.name === 'string' ? cause.name : ''
  if (name === 'NotAllowedError') return 'Screen sharing was denied or cancelled. Choose Start sharing to request permission again.'
  if (name === 'NotReadableError') return 'The browser could not read the selected screen. Check PipeWire and the desktop portal, then try again.'
  if (name === 'NotFoundError') return 'No screen capture source is available.'
  if (name === 'InvalidStateError') return 'Focus this tab and click Start sharing again.'
  if (name === 'OverconstrainedError') return 'The selected source could not satisfy the capture request. Try another screen or window.'
  return cause instanceof Error ? cause.message : 'Screen sharing failed. You can try again.'
}

function stopCapture(owned: Owned) {
  owned.track.mediaStreamTrack.removeEventListener('ended', owned.ended)
  if (owned.audioEnded) owned.audio?.mediaStreamTrack.removeEventListener('ended', owned.audioEnded)
  owned.audio?.stop()
  owned.track.stop()
  owned.stream.getTracks().forEach(track => track.stop())
}

export default function ScreenSharing({ room, canPublish, nativeAudioControl, channel, player=false }: { player?: boolean; channel?: string; room: Room; canPublish: boolean; nativeAudioControl?: string }) {
  async function authorizeScreen(enabled: boolean) {
    if (!channel) return
    const response = await fetch('/api/discord/'+channel+(enabled?'/publish':'/stop'), {method:'POST',
      headers:{'Content-Type':'application/json',Authorization:'Bearer '+nativeAudioControl}, body:'{}',keepalive:!enabled, signal:AbortSignal.timeout(6000)})
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Screen publication requires current voice-channel membership.')
  }
  const [audioPeers, setAudioPeers] = useState<{ identity: string; owner: string; publication?: TrackPublication; publisherIdentity?: string }[]>([])
  const [nativeStatus, setNativeStatus] = useState('Native helper not connected.')
  const [shareAudio, setShareAudio] = useState(false)
  const [audioStatus, setAudioStatus] = useState('Audio not requested.')
  const [screens, setScreens] = useState<Screen[]>([])
  const [connected, setConnected] = useState(room.state === ConnectionState.Connected)
  const [sharing, setSharing] = useState(false)
  const [busy, setBusy] = useState<'' | 'starting' | 'stopping'>('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [quality, setQuality] = useState(nativeTarget)
  const [qualityBusy, setQualityBusy] = useState(false)
  async function changeQuality(target: VideoTarget) {
    const active = owned.current
    if (!active) { setQuality(target); return }
    if (!active.track.sender || qualityBusy) return
    setQualityBusy(true)
    try {
      await applyVideoTarget(active.track.sender, active.track.mediaStreamTrack.getSettings(), target)
      if (owned.current === active) { setQuality(target); setError('') }
    } catch { setError('This browser could not apply the live quality change. Your screen is still shared.') }
    finally { setQualityBusy(false) }
  }
  const [settings, setSettings] = useState<MediaTrackSettings | null>(null)
  const owned = useRef<Owned | null>(null)
  const busyRef = useRef(false)
  const mounted = useRef(false)
  const generation = useRef(0)
  const syncRef = useRef(() => {})

  useEffect(() => {
    mounted.current = true
    const audioOwners = new Set<string>()
    const sync = () => {
      if (!mounted.current) return
      const next: Screen[] = []
      for (const participant of [room.localParticipant, ...room.remoteParticipants.values()]) {
        for (const publication of participant.videoTrackPublications.values()) {
          if (publication.source !== Track.Source.ScreenShare) continue
          next.push({ publication, key: `${participant.identity}:${publication.trackSid}`, owner: participant.name || participant.identity,
            local: participant === room.localParticipant, track: publication.videoTrack, muted: publication.isMuted,
            paused: publication.videoTrack?.streamState === Track.StreamState.Paused, ended: publication.videoTrack?.mediaStreamTrack.readyState === 'ended' })
        }
      }
      setScreens(next)
      const remote = [...room.remoteParticipants.values()]
      const native = new Map<string, { publication: TrackPublication; identity: string }>()
      let localNative = 'Native helper not connected.'
      for (const helper of remote) {
        if (!helper.identity.startsWith('native-audio-')) continue
        try {
          const metadata = JSON.parse(helper.metadata || '{}')
          const screen = room.localParticipant.videoTrackPublications.get(metadata.nativeAudioScreen)
          if (metadata.nativeAudioOwner === room.localParticipant.identity) {
            for (const publication of helper.audioTrackPublications.values()) {
              if (publication.source === Track.Source.ScreenShareAudio && publication.isDesired !== false) publication.setSubscribed(false)
            }
            if (screen?.source === Track.Source.ScreenShare) localNative = [...helper.audioTrackPublications.values()].some(p => p.source === Track.Source.ScreenShareAudio) ? 'Native system audio published. Preview is silent only in this publisher session; other participants control their own playback.' : 'Native helper connected; waiting for audio publication.'
          }
        } catch { /* Invalid association. */ }
      }
      setNativeStatus(localNative)
      for (const helper of remote) {
        if (!helper.identity.startsWith('native-audio-')) continue
        try {
          const metadata = JSON.parse(helper.metadata || '{}')
          const owner = remote.find(p => p.identity === metadata.nativeAudioOwner)
          const screen = owner?.videoTrackPublications.get(metadata.nativeAudioScreen)
          if (!owner || screen?.source !== Track.Source.ScreenShare) continue
          const audio = [...helper.audioTrackPublications.values()].find(p => p.source === Track.Source.ScreenShareAudio)
          if (audio) native.set(owner.identity, { publication: audio, identity: helper.identity })
        } catch { /* Only server-issued association metadata is accepted. */ }
      }
      for (const identity of audioOwners) if (!room.remoteParticipants.has(identity)) audioOwners.delete(identity)
      for (const p of remote) {
        if ([...p.videoTrackPublications.values()].some(pub => pub.source === Track.Source.ScreenShare) ||
          [...p.audioTrackPublications.values()].some(pub => pub.source === Track.Source.ScreenShareAudio)) audioOwners.add(p.identity)
      }
      setAudioPeers(remote.filter(p => !p.identity.startsWith('native-audio-') && audioOwners.has(p.identity)).map(p => ({ identity: p.identity, owner: p.name || p.identity,
        publisherIdentity: native.get(p.identity)?.identity ?? p.identity, publication: native.get(p.identity)?.publication ?? [...p.audioTrackPublications.values()].find(pub => pub.source === Track.Source.ScreenShareAudio) })))
    }
    syncRef.current = sync
    const state = (next: ConnectionState) => { if (mounted.current) setConnected(next === ConnectionState.Connected); sync() }
    const unpublished = (publication: LocalTrackPublication) => {
      const active = owned.current
      if (active?.audio && publication.track === active.audio) {
        if (room.state !== ConnectionState.Connected && room.state !== ConnectionState.Disconnected && active.audio.mediaStreamTrack.readyState === 'live') { sync(); return }
        if (active.audioEnded) active.audio.mediaStreamTrack.removeEventListener('ended', active.audioEnded)
        active.audio.stop(); active.audio = undefined
        if (mounted.current) setAudioStatus('Screen audio ended. Video may continue.')
      }
      if (owned.current && publication.track === owned.current.track) {
        // LiveKit temporarily unpublishes live tracks during a full reconnect.
        // Preserve the consented capture so the SDK can republish it without a new prompt.
        if (room.state !== ConnectionState.Connected && room.state !== ConnectionState.Disconnected && owned.current.track.mediaStreamTrack.readyState === 'live') { sync(); return }
        const previous = owned.current; owned.current = null; void authorizeScreen(false).catch(() => {}); stopCapture(previous)
        if (previous.audio) void room.localParticipant.unpublishTrack(previous.audio, true).catch(() => { if (mounted.current) setError('Audio cleanup failed. Leave and rejoin the room.') })
        if (mounted.current) { setSharing(false); setSettings(null) }
      }
      sync()
    }
    const failed = () => { if (mounted.current) setError('A remote screen subscription failed. LiveKit may recover on reconnection; otherwise leave and rejoin.') }
    const events = [RoomEvent.TrackPublished, RoomEvent.TrackUnpublished, RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed,
      RoomEvent.TrackMuted, RoomEvent.TrackUnmuted, RoomEvent.TrackStreamStateChanged, RoomEvent.LocalTrackPublished,
      RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected, RoomEvent.ParticipantNameChanged, RoomEvent.ParticipantMetadataChanged, RoomEvent.Reconnected] as const
    for (const event of events) room.on(event, sync)
    room.on(RoomEvent.LocalTrackUnpublished, unpublished).on(RoomEvent.ConnectionStateChanged, state).on(RoomEvent.TrackSubscriptionFailed, failed)
    sync()
    return () => {
      mounted.current = false; generation.current++
      for (const event of events) room.off(event, sync)
      room.off(RoomEvent.LocalTrackUnpublished, unpublished).off(RoomEvent.ConnectionStateChanged, state).off(RoomEvent.TrackSubscriptionFailed, failed)
      const active = owned.current; owned.current = null
      if (active) { stopCapture(active); void authorizeScreen(false).catch(() => {}); void unpublish(active).catch(() => {}) }
    }
  }, [room])

  async function unpublish(active: Owned) {
    const results = await Promise.allSettled([room.localParticipant.unpublishTrack(active.track, true), ...(active.audio ? [room.localParticipant.unpublishTrack(active.audio, true)] : [])])
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }

  function captureIsCurrent(ticket: number, raw: MediaStreamTrack) {
    return mounted.current && ticket === generation.current && room.state !== ConnectionState.Disconnected && raw.readyState !== 'ended'
  }

  async function start() {
    if (!canPublish || room.state !== ConnectionState.Connected || busyRef.current || owned.current) return
    if ([...room.localParticipant.videoTrackPublications.values(), ...room.localParticipant.audioTrackPublications.values()].some(publication => publication.source === Track.Source.ScreenShare || publication.source === Track.Source.ScreenShareAudio)) {
      setError('A previous screen publication is still being removed. Wait or leave and rejoin before sharing again.'); return
    }
    if (screens.length >= 4) { setError('All four screens are in use. You can keep watching and try again when a screen stops.'); return }
    if (!window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia) { setError('Screen sharing requires a supported browser on localhost or HTTPS.'); return }
    busyRef.current = true; setBusy('starting'); setError(''); setNotice('')
    const ticket = ++generation.current
    let active: Owned | null = null
    let captured: MediaStream | null = null
    let authorized = false
    try {
      // No awaits before this call: capture must retain the button's user activation.
      const stream = await navigator.mediaDevices.getDisplayMedia(shareAudio ? {
        ...captureOptions,
        audio: { restrictOwnAudio: true, suppressLocalAudioPlayback: false },
        systemAudio: 'exclude', windowAudio: 'exclude', selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude',
      } as DisplayMediaStreamOptions : captureOptions)
      captured = stream
      const raw = stream.getVideoTracks()[0]
      const offeredAudio = shareAudio ? stream.getAudioTracks()[0] : undefined
      // Picker hints alone do not establish the scope of a returned audio track.
      const audioSettings = offeredAudio?.getSettings() as (MediaTrackSettings & { restrictOwnAudio?: boolean }) | undefined
      const rawAudio = raw?.getSettings().displaySurface === 'browser' && audioSettings?.restrictOwnAudio === true ? offeredAudio : undefined
      stream.getTracks().filter(track => track !== raw && track !== rawAudio).forEach(track => track.stop())
      if (!raw) { stream.getTracks().forEach(track => track.stop()); throw new Error('The browser returned no screen video track.') }
      const track = new LocalVideoTrack(raw, undefined, false)
      track.source = Track.Source.ScreenShare
      const ended = () => {
        if (mounted.current) { setNotice('Screen sharing ended through the browser controls.'); setSharing(false); setSettings(null) }
        generation.current++
        // Give the SDK's ended listener first chance, then clean up if its native
        // event path did not unpublish. Never depend on browser event ordering.
        queueMicrotask(() => {
          if (owned.current?.track !== track) return
          const endedCapture = owned.current
          owned.current = null
          stopCapture(endedCapture); void authorizeScreen(false).catch(() => {})
          void unpublish(endedCapture).catch(() => {
            if (mounted.current) setError('Capture ended, but cleanup failed. Leave and rejoin the room.')
          })
        })
      }
      active = { track, stream, ended }
      raw.addEventListener('ended', ended, { once: true })
      if (!captureIsCurrent(ticket, raw) || room.state !== ConnectionState.Connected) { stopCapture(active); return }
      if (channel) {
        await authorizeScreen(true)
        authorized = true
        if (!captureIsCurrent(ticket,raw)) { stopCapture(active); await authorizeScreen(false); return }
      }
      owned.current = active
      await room.localParticipant.publishTrack(track, { source: Track.Source.ScreenShare, videoCodec: 'vp8', simulcast: true,
        screenShareEncoding: { maxBitrate: 8_000_000, maxFramerate: 60 }, degradationPreference: 'balanced' })
      if (!captureIsCurrent(ticket, raw)) {
        stopCapture(active); await unpublish(active); return
      }
      const initialTarget = {fps: quality.fps, height: 0}
      if (quality.fps !== 60 && track.sender) {
        try {
          await applyVideoTarget(track.sender, raw.getSettings(), initialTarget)
        } catch {
          initialTarget.fps = nativeTarget.fps
          setError('Your screen is live. This browser could not apply the selected frame-rate limit.')
        }
      }
      setQuality(initialTarget); setSettings(raw.getSettings()); setSharing(true)
      setAudioStatus(!shareAudio ? 'Audio not requested.' : rawAudio ? 'Screen audio ended before publication. Video continues.' : offeredAudio
        ? 'Audio skipped because the browser could not confirm a tab with room audio excluded. On Linux, pair the native helper and select your game.'
        : 'Browser returned no screen audio. On Linux, pair the native helper and select your game.')
      if (rawAudio && rawAudio.readyState !== 'ended') {
        try {
          const audio = new LocalAudioTrack(rawAudio, undefined, false)
          audio.source = Track.Source.ScreenShareAudio
          active.audio = audio
          const audioCapture = active
          const audioEnded = () => {
            if (mounted.current) setAudioStatus('Screen audio ended. Video continues.')
            queueMicrotask(() => {
              if (audioCapture.audio !== audio) return
              audioCapture.audio = undefined
              rawAudio.removeEventListener('ended', audioEnded); audio.stop()
              void room.localParticipant.unpublishTrack(audio, true).catch(() => { if (mounted.current) setError('Audio cleanup failed. Leave and rejoin the room.') })
            })
          }
          active.audioEnded = audioEnded
          rawAudio.addEventListener('ended', audioEnded, { once: true })
          await room.localParticipant.publishTrack(audio, { source: Track.Source.ScreenShareAudio, dtx: false })
          if (!captureIsCurrent(ticket, raw) || audio.mediaStreamTrack.readyState === 'ended' || owned.current !== active) {
            rawAudio.removeEventListener('ended', audioEnded); audio.stop()
            await room.localParticipant.unpublishTrack(audio, true)
            if (!captureIsCurrent(ticket, raw)) { stopCapture(active); await unpublish(active); return }
          } else setAudioStatus(`Screen-capture audio published. Selected video surface: ${raw.getSettings().displaySurface ?? 'unknown'}. Audio settings: ${rawAudio.getSettings().sampleRate ?? 'unknown'} Hz, ${rawAudio.getSettings().channelCount ?? 'unknown'} channels. This does not prove desktop-wide audio capture.`)
        } catch {
          rawAudio.stop()
          if (active.audio) {
            if (active.audioEnded) rawAudio.removeEventListener('ended', active.audioEnded)
            const audio = active.audio; active.audio = undefined
            await room.localParticipant.unpublishTrack(audio, true).catch(() => { if (mounted.current) setError('Audio cleanup failed. Leave and rejoin the room.') })
          }
          if (mounted.current && ticket === generation.current) setAudioStatus('Screen audio publication failed. Video continues. Rejoin with a current publisher invitation if your token predates audio support.')
        }
      }
      syncRef.current()
    } catch (cause) {
      if (authorized) await authorizeScreen(false).catch(() => {})
      if (active) {
        stopCapture(active)
        await unpublish(active).catch(() => {})
      } else { captured?.getTracks().forEach(track => track.stop()) }
      if (mounted.current && ticket === generation.current) {
        const full = [...room.remoteParticipants.values()].flatMap(p => [...p.videoTrackPublications.values()]).filter(p => p.source === Track.Source.ScreenShare).length >= 4
        setError(full ? 'All four screens are in use. You can keep watching and try again when a screen stops.' : captureError(cause))
      }
    } finally {
      if (active && active.track.mediaStreamTrack.readyState === 'ended' && owned.current === active) owned.current = null
      busyRef.current = false
      if (mounted.current) setBusy('')
    }
  }

  async function stop() {
    if (busyRef.current) return
    const active = owned.current
    if (!active) return
    generation.current++; busyRef.current = true; setBusy('stopping'); setError('')
    owned.current = null; stopCapture(active); setSharing(false); setSettings(null)
    try { await Promise.all([unpublish(active), authorizeScreen(false)]); setAudioStatus('Audio stopped.'); setNotice('Screen sharing stopped.') }
    catch { if (mounted.current) setError('Local capture stopped, but unpublishing failed. Leave the room to finish cleanup.') }
    finally { busyRef.current = false; if (mounted.current) { setBusy(''); syncRef.current() } }
  }

  const screenSid = screens.find(screen => screen.local)?.publication.trackSid
  if (player) return <PlayerStage screens={screens} peers={audioPeers} connected={connected} sharing={sharing} busy={busy}
    screen={sharing ? screenSid : undefined} control={nativeAudioControl} canPublish={canPublish} error={error}
    quality={quality} nativeSettings={settings ?? undefined} qualityBusy={qualityBusy || !!busy}
    changeQuality={target => void changeQuality(target)} start={() => void start()} stop={() => void stop()} />
  return <div className="screen-sharing">
    <h3>Screens</h3>
    {canPublish ? <div className="share-controls">
      <label><input type="checkbox" checked={shareAudio} disabled={sharing || !!busy} onChange={event => setShareAudio(event.target.checked)} />Share audio from a browser tab</label>
      <button onClick={() => void start()} disabled={!connected || sharing || !!busy}>Start sharing</button>
      <button className="secondary" onClick={() => void stop()} disabled={!sharing || !!busy}>Stop sharing</button>
      {busy === 'stopping' && <p role="status">Stopping screen sharing…</p>}
      {busy === 'starting' && <><p role="status">Requesting or publishing your screen…</p><button onClick={() => { generation.current++; if (owned.current) stopCapture(owned.current); setNotice('Sharing request cancelled. Close any browser picker; pending selections will be discarded.') }}>Cancel sharing request</button></>}
    </div> : <p>Viewer mode. A separate publisher invitation is required to share a screen.</p>}
    <p className="note">Requested capture target: native display dimensions at 60 FPS. Actual capture and transmission may be lower. Audio is opt-in; only audio returned by the screen picker is used. Microphone capture is never requested.</p>
    {canPublish && <p role="status" aria-label="Audio capture status">{audioStatus}</p>}
    {settings && <p className="note">Browser-reported capture settings at start: {settings.width ?? 'unknown'} × {settings.height ?? 'unknown'}, {settings.frameRate ?? 'unknown'} FPS. These are not measured transmission rates.</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    {screens.length === 0 ? <p>No active screen streams. Authorized participants can choose Start sharing.</p> :
      <div className="stream-grid" aria-label="Screen streams">{screens.map(screen => <ScreenTile key={screen.key} screen={screen} connected={connected} />)}</div>}
    {canPublish && !owned.current?.audio && <NativeAudio key={screenSid} status={nativeStatus} control={nativeAudioControl} screen={sharing && !busy ? screenSid : undefined} />}
    <div className="audio-controls" aria-label="Remote screen audio">{audioPeers.map(peer => <RemoteScreenAudio key={peer.identity} owner={peer.owner} ownerIdentity={peer.identity} publisherIdentity={peer.publisherIdentity} publication={peer.publication} connected={connected} />)}</div>
  </div>
}
