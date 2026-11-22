import { useCallback, useEffect, useRef, useState } from 'react'
import { TrackEvent, VideoQuality, type RemoteTrackPublication, type TrackPublication } from 'livekit-client'
import MediaDiagnostics from './MediaDiagnostics'

export type Screen = {
  key: string
  owner: string
  local: boolean
  track: TrackPublication['videoTrack']
  muted: boolean
  paused: boolean
  ended: boolean
  publication: TrackPublication
}

export function ScreenTile({
  screen,
  connected,
  onFocus,
  hidden,
  highest,
}: {
  screen: Screen
  connected: boolean
  onFocus?: () => void
  hidden?: boolean
  highest?: boolean
}) {
  const container = useRef<HTMLElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState('')
  const enabled = useCallback(() => screen.publication.isEnabled, [screen.publication])
  const [subscriptionEnabled, setSubscriptionEnabled] = useState<boolean | undefined>(
    screen.publication.isEnabled,
  )
  useEffect(() => {
    const publication = screen.publication
    const sync = () => setSubscriptionEnabled(publication.isEnabled)
    sync()
    if (typeof publication.on !== 'function') return
    publication.on(TrackEvent.UpdateSettings, sync)
    return () => {
      publication.off(TrackEvent.UpdateSettings, sync)
    }
  }, [screen.publication])
  useEffect(() => {
    const element = video.current
    if (!element || !screen.track) return
    screen.track.attach(element)
    return () => {
      screen.track?.detach(element)
      element.srcObject = null
    }
  }, [screen.track])
  useEffect(() => {
    if (highest === undefined || screen.local || !screen.track || !video.current) return
    const publication = screen.publication as RemoteTrackPublication
    const element = video.current
    function update() {
      const visible = !hidden && document.visibilityState === 'visible'
      publication.setEnabled(visible)
      if (!visible) return
      if (highest) publication.setVideoQuality(VideoQuality.HIGH)
      else {
        const rect = element.getBoundingClientRect()
        publication.setVideoDimensions({ width: Math.max(1, Math.round(rect.width * devicePixelRatio)),
          height: Math.max(1, Math.round(rect.height * devicePixelRatio)) })
      }
    }
    const observer = new ResizeObserver(update)
    observer.observe(element)
    document.addEventListener('visibilitychange', update)
    update()
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', update) }
  }, [highest, hidden, screen.track, screen.publication, screen.local])
  const state = !connected
    ? 'Reconnecting'
    : !screen.track
      ? 'Waiting for video'
      : screen.ended
        ? 'Ended'
        : screen.muted
          ? 'Muted'
          : !screen.local && subscriptionEnabled === false
            ? 'Adaptive pause'
            : screen.paused
              ? 'Paused by SFU'
              : 'Streaming'
  async function fullscreen() {
    try {
      if (!container.current?.requestFullscreen)
        throw new Error('Fullscreen is not supported by this browser.')
      await container.current.requestFullscreen()
      setError('')
    } catch {
      setError('Fullscreen is unavailable or was denied. Try the browser fullscreen control.')
    }
  }
  return (
    <article
      ref={container}
      hidden={hidden}
      className={onFocus ? 'player-tile' : 'stream-tile'}
      aria-label={`${screen.owner} screen${screen.local ? ' (you)' : ''}`}
    >
      <header>
        <strong>
          {screen.owner}
          {screen.local ? ' (you)' : ''}
        </strong>
        <span>{onFocus && state === 'Streaming' ? '' : state}</span>
      </header>
      <video ref={video} autoPlay playsInline muted aria-label={`${screen.owner} screen video`} />
      {onFocus ? (
        <button className="focus-surface" aria-label={`Focus ${screen.owner} screen`} onClick={onFocus} />
      ) : (
        <MediaDiagnostics
          track={screen.track}
          local={screen.local}
          video={video}
          enabled={enabled}
          connected={connected}
        />
      )}
      {!screen.track && <p>Waiting for the screen subscription…</p>}
      {!onFocus && <button onClick={() => void fullscreen()}>Fullscreen {screen.owner}</button>}
      {error && <p role="alert">{error}</p>}
    </article>
  )
}
