import MediaDiagnostics from './MediaDiagnostics'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ConnectionState, LocalVideoTrack, RoomEvent, Track, TrackEvent, type LocalTrackPublication, type Room, type TrackPublication } from 'livekit-client'

type Screen = { key: string; owner: string; local: boolean; track: TrackPublication['videoTrack']; muted: boolean; paused: boolean; ended: boolean; publication: TrackPublication }
type Owned = { track: LocalVideoTrack; stream: MediaStream; ended: () => void }
export const captureOptions: DisplayMediaStreamOptions = {
  audio: false,
  video: { width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 60 } },
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
  owned.track.stop()
  owned.stream.getTracks().forEach(track => track.stop())
}

export default function ScreenSharing({ room, canPublish }: { room: Room; canPublish: boolean }) {
  const [screens, setScreens] = useState<Screen[]>([])
  const [connected, setConnected] = useState(room.state === ConnectionState.Connected)
  const [sharing, setSharing] = useState(false)
  const [busy, setBusy] = useState<'' | 'starting' | 'stopping'>('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [settings, setSettings] = useState<MediaTrackSettings | null>(null)
  const owned = useRef<Owned | null>(null)
  const busyRef = useRef(false)
  const mounted = useRef(false)
  const generation = useRef(0)
  const syncRef = useRef(() => {})

  useEffect(() => {
    mounted.current = true
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
    }
    syncRef.current = sync
    const state = (next: ConnectionState) => { if (mounted.current) setConnected(next === ConnectionState.Connected); sync() }
    const unpublished = (publication: LocalTrackPublication) => {
      if (owned.current && publication.track === owned.current.track) {
        // LiveKit temporarily unpublishes live tracks during a full reconnect.
        // Preserve the consented capture so the SDK can republish it without a new prompt.
        if (room.state !== ConnectionState.Connected && room.state !== ConnectionState.Disconnected && owned.current.track.mediaStreamTrack.readyState === 'live') { sync(); return }
        stopCapture(owned.current); owned.current = null
        if (mounted.current) { setSharing(false); setSettings(null) }
      }
      sync()
    }
    const failed = () => { if (mounted.current) setError('A remote screen subscription failed. LiveKit may recover on reconnection; otherwise leave and rejoin.') }
    const events = [RoomEvent.TrackPublished, RoomEvent.TrackUnpublished, RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed,
      RoomEvent.TrackMuted, RoomEvent.TrackUnmuted, RoomEvent.TrackStreamStateChanged, RoomEvent.LocalTrackPublished,
      RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected, RoomEvent.ParticipantNameChanged, RoomEvent.Reconnected] as const
    for (const event of events) room.on(event, sync)
    room.on(RoomEvent.LocalTrackUnpublished, unpublished).on(RoomEvent.ConnectionStateChanged, state).on(RoomEvent.TrackSubscriptionFailed, failed)
    sync()
    return () => {
      mounted.current = false; generation.current++
      for (const event of events) room.off(event, sync)
      room.off(RoomEvent.LocalTrackUnpublished, unpublished).off(RoomEvent.ConnectionStateChanged, state).off(RoomEvent.TrackSubscriptionFailed, failed)
      const active = owned.current; owned.current = null
      if (active) { stopCapture(active); void room.localParticipant.unpublishTrack(active.track, true).catch(() => {}) }
    }
  }, [room])

  function captureIsCurrent(ticket: number, raw: MediaStreamTrack) {
    return mounted.current && ticket === generation.current && room.state !== ConnectionState.Disconnected && raw.readyState !== 'ended'
  }

  async function start() {
    if (!canPublish || room.state !== ConnectionState.Connected || busyRef.current || owned.current) return
    if ([...room.localParticipant.videoTrackPublications.values()].some(publication => publication.source === Track.Source.ScreenShare)) {
      setError('A previous screen publication is still being removed. Wait or leave and rejoin before sharing again.'); return
    }
    if (!window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia) { setError('Screen sharing requires a supported browser on localhost or HTTPS.'); return }
    busyRef.current = true; setBusy('starting'); setError(''); setNotice('')
    const ticket = ++generation.current
    let active: Owned | null = null
    let captured: MediaStream | null = null
    try {
      // No awaits before this call: capture must retain the button's user activation.
      const stream = await navigator.mediaDevices.getDisplayMedia(captureOptions)
      captured = stream
      const raw = stream.getVideoTracks()[0]
      stream.getTracks().filter(track => track !== raw).forEach(track => track.stop())
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
          stopCapture(endedCapture)
          void room.localParticipant.unpublishTrack(track, true).catch(() => {
            if (mounted.current) setError('Capture ended, but cleanup failed. Leave and rejoin the room.')
          })
        })
      }
      active = { track, stream, ended }
      raw.addEventListener('ended', ended, { once: true })
      if (!captureIsCurrent(ticket, raw) || room.state !== ConnectionState.Connected) { stopCapture(active); return }
      owned.current = active
      await room.localParticipant.publishTrack(track, { source: Track.Source.ScreenShare, videoCodec: 'vp8', simulcast: true,
        screenShareEncoding: { maxBitrate: 8_000_000, maxFramerate: 60 }, degradationPreference: 'balanced' })
      if (!captureIsCurrent(ticket, raw)) {
        stopCapture(active); await room.localParticipant.unpublishTrack(track, true); return
      }
      setSettings(raw.getSettings()); setSharing(true); syncRef.current()
    } catch (cause) {
      if (active) {
        stopCapture(active)
        await room.localParticipant.unpublishTrack(active.track, true).catch(() => {})
      } else { captured?.getTracks().forEach(track => track.stop()) }
      if (mounted.current && ticket === generation.current) setError(captureError(cause))
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
    try { await room.localParticipant.unpublishTrack(active.track, true); setNotice('Screen sharing stopped.') }
    catch { if (mounted.current) setError('Local capture stopped, but unpublishing failed. Leave the room to finish cleanup.') }
    finally { busyRef.current = false; if (mounted.current) { setBusy(''); syncRef.current() } }
  }

  return <div className="screen-sharing">
    <h3>Screens</h3>
    {canPublish ? <div className="share-controls">
      <button onClick={() => void start()} disabled={!connected || sharing || !!busy}>Start sharing</button>
      <button className="secondary" onClick={() => void stop()} disabled={!sharing || !!busy}>Stop sharing</button>
      {busy === 'stopping' && <p role="status">Stopping screen sharing…</p>}
      {busy === 'starting' && <><p role="status">Requesting or publishing your screen…</p><button onClick={() => { generation.current++; if (owned.current) stopCapture(owned.current); setNotice('Sharing request cancelled. Close any browser picker; pending selections will be discarded.') }}>Cancel sharing request</button></>}
    </div> : <p>Viewer mode. A separate publisher invitation is required to share a screen.</p>}
    <p className="note">Requested capture target: 2560 × 1440 at 60 FPS. Actual capture and transmission may be lower. Audio is never requested.</p>
    {settings && <p className="note">Browser-reported capture settings at start: {settings.width ?? 'unknown'} × {settings.height ?? 'unknown'}, {settings.frameRate ?? 'unknown'} FPS. These are not measured transmission rates.</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    {screens.length === 0 ? <p>No active screen streams. Authorized participants can choose Start sharing.</p> :
      <div className="stream-grid" aria-label="Screen streams">{screens.map(screen => <ScreenTile key={screen.key} screen={screen} connected={connected} />)}</div>}
  </div>
}

function ScreenTile({ screen, connected }: { screen: Screen; connected: boolean }) {
  const container = useRef<HTMLElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState('')
  const enabled = useCallback(() => screen.publication.isEnabled, [screen.publication])
  const [subscriptionEnabled, setSubscriptionEnabled] = useState<boolean | undefined>(screen.publication.isEnabled)
  useEffect(() => {
    const publication = screen.publication
    const sync = () => setSubscriptionEnabled(publication.isEnabled)
    sync()
    if (typeof publication.on !== 'function') return
    publication.on(TrackEvent.UpdateSettings, sync)
    return () => { publication.off(TrackEvent.UpdateSettings, sync) }
  }, [screen.publication])
  useEffect(() => {
    const element = video.current
    if (!element || !screen.track) return
    screen.track.attach(element)
    return () => { screen.track?.detach(element); element.srcObject = null }
  }, [screen.track])
  const state = !connected ? 'Reconnecting' : !screen.track ? 'Waiting for video' : screen.ended ? 'Ended' : screen.muted ? 'Muted' : !screen.local && subscriptionEnabled === false ? 'Adaptive pause' : screen.paused ? 'Paused by SFU' : 'Streaming'
  async function fullscreen() {
    try {
      if (!container.current?.requestFullscreen) throw new Error('Fullscreen is not supported by this browser.')
      await container.current.requestFullscreen(); setError('')
    } catch { setError('Fullscreen is unavailable or was denied. Try the browser fullscreen control.') }
  }
  return <article ref={container} className="stream-tile" aria-label={`${screen.owner} screen${screen.local ? ' (you)' : ''}`}>
    <header><strong>{screen.owner}{screen.local ? ' (you)' : ''}</strong><span>{state}</span></header>
    <video ref={video} autoPlay playsInline muted aria-label={`${screen.owner} screen video`} />
    <MediaDiagnostics track={screen.track} local={screen.local} video={video} enabled={enabled} connected={connected} />
    {!screen.track && <p>Waiting for the screen subscription…</p>}
    <button onClick={() => void fullscreen()}>Fullscreen {screen.owner}</button>
    {error && <p role="alert">{error}</p>}
  </article>
}
