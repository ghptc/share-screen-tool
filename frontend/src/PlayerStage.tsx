import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { TrackPublication } from 'livekit-client'
import { ScreenTile, type Screen } from './ScreenTile'
import DesktopAudio from './DesktopAudio'
import { readAudioPreference, writeAudioPreference } from './gameAudioSession'
import RemoteScreenAudio from './RemoteScreenAudio'

function Icon({ name }: { name: 'share' | 'audio' | 'expand' | 'grid' | 'stop' }) {
  const paths = {
    share: 'M3 4.5h18v13H3z M8 21h8 M12 16V8m-3 3 3-3 3 3',
    audio: 'M4 10v4m4-8v12m4-15v18m4-15v12m4-8v4',
    expand: 'M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5',
    grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
    stop: 'M6 6h12v12H6z',
  }
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  )
}
type Peer = { identity: string; owner: string; publication?: TrackPublication; publisherIdentity?: string }
type Props = {
  screens: Screen[]
  peers: Peer[]
  connected: boolean
  sharing: boolean
  busy: string
  screen?: string
  control?: string
  canPublish: boolean
  error: string
  start: () => void
  stop: () => void
}
export default function PlayerStage({
  screens,
  peers,
  connected,
  sharing,
  busy,
  screen,
  control,
  canPublish,
  error,
  start,
  stop,
}: Props) {
  const [focus, setFocus] = useState('')
  const [menu, setMenu] = useState(false)
  const [audioState, setAudioState] = useState('')
  const [audioEnabled, setAudioEnabled] = useState(
    () => readAudioPreference('whiterun.gameAudio.enabled') !== 'off',
  )
  const reportAudio = useCallback((status: string) => {
    setAudioState(status)
    if (status === 'Choose audio source') setMenu(true)
  }, [])
  const audioToggle = control && canPublish && (
    <label className="share-audio-toggle">
      <input
        type="checkbox"
        checked={audioEnabled}
        disabled={!!busy}
        onChange={(e) => {
          setAudioEnabled(e.target.checked)
          writeAudioPreference('whiterun.gameAudio.enabled', e.target.checked ? 'on' : 'off')
        }}
      />{' '}
      Share audio
    </label>
  )
  const [blocked, setBlocked] = useState<Set<string>>(new Set())
  const [fullscreenError, setFullscreenError] = useState('')
  const panel = useRef<HTMLDivElement>(null)
  const menuButton = useRef<HTMLButtonElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const focused = screens.length > 1 && screens.some((s) => s.key === focus)
  useEffect(() => {
    if (focus && !focused) setFocus('')
  }, [focus, focused])
  const reportBlocked = useCallback(
    (id: string, value: boolean) =>
      setBlocked((old) => {
        if (old.has(id) === value) return old
        const next = new Set(old)
        if (value) next.add(id)
        else next.delete(id)
        return next
      }),
    [],
  )
  useEffect(() => {
    if (!menu && !focused) return
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (menu) {
          setMenu(false)
          menuButton.current?.focus()
        } else setFocus('')
      }
    }
    const outside = (e: PointerEvent) => {
      if (!panel.current?.contains(e.target as Node) && !menuButton.current?.contains(e.target as Node))
        setMenu(false)
    }
    document.addEventListener('keydown', escape)
    document.addEventListener('pointerdown', outside)
    return () => {
      document.removeEventListener('keydown', escape)
      document.removeEventListener('pointerdown', outside)
    }
  }, [menu, focused])
  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await stage.current?.closest('main')?.requestFullscreen()
      setFullscreenError('')
    } catch {
      setFullscreenError('Fullscreen is unavailable in this window.')
    }
  }
  function enableAudio() {
    for (const audio of stage.current?.querySelectorAll('audio') || []) {
      if (!audio.muted) void audio.play().catch(() => {})
    }
  }
  return (
    <div ref={stage} className="player-stage">
      {screens.length ? (
        <div
          className="player-grid"
          aria-label="Screen streams"
          data-count={screens.length}
          data-focused={focused}
          style={{ '--columns': Math.ceil(Math.sqrt(screens.length)) } as CSSProperties}
        >
          {screens.map((s) => (
            <ScreenTile
              key={s.key}
              screen={s}
              connected={connected}
              hidden={focused && s.key !== focus}
              onFocus={() =>
                screens.length === 1 ? void fullscreen() : setFocus(s.key === focus ? '' : s.key)
              }
            />
          ))}
        </div>
      ) : (
        <div className="player-empty">
          <span className="standby-screen" aria-hidden="true">
            <i />
          </span>
          <h2>Waiting for a screen</h2>
          <p>Share your screen to start the stream.</p>
        </div>
      )}
      {(error || fullscreenError) && (
        <p className="player-message" role="alert">
          {error || fullscreenError}
        </p>
      )}
      <div className="player-dock">
        {focused && (
          <button onClick={() => setFocus('')}>
            <Icon name="grid" />
            Back to grid
          </button>
        )}
        {canPublish && (
          <button
            className={'share-action' + (sharing ? ' active' : '')}
            disabled={!!busy || (!sharing && !connected)}
            onClick={sharing ? stop : start}
          >
            <Icon name={sharing ? 'stop' : 'share'} />
            {busy === 'starting'
              ? 'Opening picker…'
              : busy === 'stopping'
                ? 'Stopping…'
                : sharing
                  ? 'Stop sharing'
                  : 'Start sharing'}
          </button>
        )}
        {!sharing && !menu && audioToggle}
        <button
          ref={menuButton}
          aria-expanded={menu}
          aria-controls="player-audio"
          className="audio-action"
          onClick={() => setMenu((v) => !v)}
        >
          <Icon name="audio" />
          {(sharing && audioEnabled && audioState) || 'Audio'}
        </button>
        {blocked.size > 0 && <button onClick={enableAudio}>Enable audio</button>}
        <button
          className="icon-action"
          aria-label="Toggle fullscreen"
          title="Fullscreen"
          onClick={() => void fullscreen()}
        >
          <Icon name="expand" />
        </button>
        <div
          id="player-audio"
          className="player-popover"
          role="region"
          aria-label="Audio controls"
          hidden={!menu}
          ref={panel}
        >
          {menu && audioToggle}
          {control && (
            <DesktopAudio
              key={sharing ? 'share' : 'idle'}
              open={menu}
              control={control}
              screen={audioEnabled && connected && sharing ? screen : undefined}
              onStatus={reportAudio}
            />
          )}
          {peers.map((p) => (
            <RemoteScreenAudio
              player
              key={p.identity}
              connected={connected}
              owner={p.owner}
              ownerIdentity={p.identity}
              publication={p.publication}
              reportBlocked={reportBlocked}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
