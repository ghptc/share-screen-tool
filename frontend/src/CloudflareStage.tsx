import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { publish, ScreenIceGatheringError, subscribe, type Signal } from './cloudflarePeer'
import DesktopAudio from './DesktopAudio'
import NativeAudio from './NativeAudio'
import { readAudioPreference, writeAudioPreference } from './gameAudioSession'
import { applyVideoTarget, nativeTarget, type VideoTarget } from './videoQuality'
import PublishQuality from './PublishQuality'

type Flow = {
  audioFor?: string
  displayAudio?: MediaStreamTrack
  ready?: boolean
  pc: RTCPeerConnection
  handle?: string
  stream?: MediaStream
  cancelPublication?: AbortController
  timeout?: ReturnType<typeof setTimeout>
}
type Participant = { key: string; name: string; avatar?: string; sharing: boolean }
type Tile = { key: string; stream: MediaStream; audioFor?: string }
const local = 'local'
const localAudio = 'local-audio'

function missingAudio(surface?: string) {
  if (surface === 'browser') return 'Video only. Share again and enable tab audio in the browser picker.'
  if (surface === 'monitor') return 'Video only. Share again and enable system audio for Entire Screen if offered. System audio includes other apps.'
  if (surface === 'window') return 'Video only. The browser returned no window audio. Try a Chrome tab with tab audio, or choose Entire Screen if you want to share system audio.'
  return 'Video only. The browser returned no audio track. Share again and enable audio in the picker if offered.'
}

function ParticipantStrip({ participants }: { participants: Participant[] }) {
  return (
    <ul className="participant-strip" aria-label="Room participants">
      {participants.map(person => <li key={person.key}>
        {person.avatar
          ? <img src={person.avatar} alt="" width="24" height="24" />
          : <span className="participant-initial" aria-hidden="true">{Array.from(person.name)[0]}</span>}
        <span dir="auto">{person.name}</span>
        <small>{person.sharing ? 'Sharing' : 'Watching'}</small>
      </li>)}
    </ul>
  )
}

function Video({ stream }: { stream: MediaStream }) {
  const element = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = element.current!
    video.srcObject = stream
    return () => {
      video.srcObject = null
    }
  }, [stream])
  return <video ref={element} autoPlay muted playsInline />
}

function RemoteAudio({
  stream,
  label,
  screen,
  onBlocked,
}: {
  stream?: MediaStream
  label: string
  screen: string
  onBlocked: (screen: string, blocked: boolean) => void
}) {
  const element = useRef<HTMLAudioElement>(null)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  useEffect(() => {
    const audio = element.current
    if (!audio || !stream) return
    let active = true
    audio.srcObject = stream
    if (!audio.muted)
      void audio.play().catch(() => {
        if (active) onBlocked(screen, true)
      })
    return () => {
      active = false
      audio.pause()
      audio.srcObject = null
      onBlocked(screen, false)
    }
  }, [stream, screen, onBlocked])
  useEffect(() => {
    if (element.current) element.current.volume = volume
  }, [volume, stream])
  if (!stream) return null
  function toggle() {
    const audio = element.current
    if (!audio) return
    audio.muted = !muted
    setMuted(!muted)
    if (audio.muted) onBlocked(screen, false)
    else void audio.play().catch(() => onBlocked(screen, true))
  }
  return (
    <div className="listener-mix">
      <audio
        ref={element}
        aria-label={label + ' playback'}
        muted={muted}
        onPlaying={() => onBlocked(screen, false)}
      />
      <label>
        {label}
        <input
          type="range"
          aria-label={label + ' volume'}
          min="0"
          max="1"
          step="0.01"
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
        />
      </label>
      <button aria-label={(muted ? 'Unmute ' : 'Mute ') + label} aria-pressed={muted} onClick={toggle}>
        {muted ? 'Unmute' : 'Mute'}
      </button>
    </div>
  )
}

export default function CloudflareStage({
  channel,
  identity,
  control,
  canPublish,
  onDenied,
  onExpired,
}: {
  channel: string
  identity: string
  control: string
  canPublish: boolean
  onExpired: () => void
  onDenied: () => void
}) {
  const [media, setMedia] = useState<Tile[]>([])
  const [participants, setParticipants] = useState<Participant[]>([])
  const tiles = media.filter((t) => !t.audioFor)
  const [screen, setScreen] = useState('')
  const windows = /^Win/i.test(navigator.platform)
  const [browserAudioStatus, setBrowserAudioStatus] = useState('')
  const [audioEnabled, setAudioEnabled] = useState(
    () => !windows && readAudioPreference('whiterun.gameAudio.enabled') !== 'off',
  )
  const [audioOpen, setAudioOpen] = useState(false)
  const pairNativeAudio = import.meta.env.VITE_NATIVE_AUDIO_MODE === 'pair' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
  const [audioStatus, setAudioStatus] = useState('')
  const audioControls = useRef<HTMLDivElement>(null)
  const [blocked, setBlocked] = useState<Set<string>>(() => new Set())
  const reportBlocked = useCallback((screen: string, value: boolean) => {
    setBlocked((previous) => {
      if (previous.has(screen) === value) return previous
      const next = new Set(previous)
      if (value) next.add(screen)
      else next.delete(screen)
      return next
    })
  }, [])
  function enableAudio() {
    for (const audio of audioControls.current?.querySelectorAll('audio') ?? []) {
      if (!audio.muted) void audio.play().catch(() => {})
    }
  }
  const [offer, setOffer] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [focus, setFocus] = useState('')
  const [qualityOpen, setQualityOpen] = useState(false)
  const [quality, setQuality] = useState(nativeTarget)
  const [qualityBusy, setQualityBusy] = useState(false)
  const sender = useRef<RTCRtpSender | undefined>(undefined)
  const selectedQuality = useRef(nativeTarget)
  function selectQuality(value: VideoTarget) {
    selectedQuality.current = value
    setQuality(value)
  }
  async function changeQuality(value: VideoTarget) {
    const current = sender.current
    if (!current?.track) {
      selectQuality(value)
      return
    }
    setQualityBusy(true)
    try {
      await applyVideoTarget(current, current.track.getSettings(), value)
      if (current === sender.current) selectQuality(value)
    } catch {
      if (current === sender.current) setMessage('This browser could not apply the quality change.')
    } finally {
      setQualityBusy(false)
    }
  }
  const start = useRef<(withAudio: boolean) => void>(() => {})
  const stop = useRef<() => void>(() => {})
  const denied = useRef(onDenied)
  denied.current = onDenied
  const expired = useRef(onExpired)
  expired.current = onExpired

  useEffect(() => {
    let active = true
    const stateRequest = new AbortController()
    let stateVersion: string | undefined
    let retryDelay = 2500
    let timer: ReturnType<typeof setTimeout>
    const flows = new Map<string, Flow>()
    const endpoint = '/api/discord/' + channel + '/media/'
    async function request(op: string, input: Record<string, unknown>) {
      const response = await fetch(endpoint + op, {
        method: 'POST',
        cache: 'no-store',
        signal: op === 'state'
          ? AbortSignal.any([stateRequest.signal, AbortSignal.timeout(70000)])
          : AbortSignal.timeout(25000),
        keepalive: op === 'close',
        headers: { 'Content-Type': 'application/json', 'X-Whiterun-Peer': identity },
        body: JSON.stringify(input),
      })
      if (active && response.status === 410) {
        dispose()
        expired.current()
      }
      if (active && (response.status === 401 || response.status === 403)) {
        dispose()
        denied.current()
      }
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? 'Screen unavailable. All slots may be in use.'
            : 'Media connection unavailable.',
        )
      return response.json()
    }
    function refresh() {
      if (!active) return
      setMedia(
        Array.from(flows).flatMap(([key, flow]) =>
          flow.stream ? [{ key, stream: flow.stream, audioFor: flow.audioFor }] : [],
        ),
      )
      const own = flows.get(local)
      setScreen(own?.ready ? (own.handle ?? '') : '')
    }
    function remove(key: string) {
      const flow = flows.get(key)
      if (!flow) return
      flows.delete(key)
      flow.cancelPublication?.abort()
      if (key === localAudio) {
        const parent = flows.get(local)
        if (parent) {
          parent.displayAudio?.stop()
          setBrowserAudioStatus('Video only. Screen audio ended. Share again to include audio.')
        }
      }
      if (key === local) {
        if (windows) {
          remove(localAudio)
          setBrowserAudioStatus('')
          setAudioEnabled(false)
        }
        sender.current = undefined
        selectQuality({ fps: selectedQuality.current.fps, height: 0 })
      }
      clearTimeout(flow.timeout)
      flow.pc.close()
      flow.stream?.getTracks().forEach((t) => t.stop())
      if (flow.handle) void request('close', { handle: flow.handle }).catch(() => {})
      refresh()
    }
    function waitForConnection(key: string, flow: Flow) {
      clearTimeout(flow.timeout)
      flow.timeout = setTimeout(() => {
        if (flows.get(key) === flow) {
          remove(key)
          if (key !== localAudio) setMessage('Media connection timed out.')
        }
      }, 12000)
    }
    function dispose() {
      if (!active) return
      active = false
      setParticipants([])
      stateRequest.abort()
      clearTimeout(timer)
      for (const key of flows.keys()) remove(key)
    }
    function attach(key: string, audioFor?: string) {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] })
      const flow: Flow = { pc, audioFor }
      flows.set(key, flow)
      const signal: Signal = async (op, input) => {
        const result = await request(op, key === localAudio && op === 'publish' ? { ...input, screen: audioFor } : input)
        if (result.handle) flow.handle = result.handle
        if (!active || flows.get(key) !== flow) {
          if (result.handle) void request('close', { handle: result.handle }).catch(() => {})
          throw new Error('Sharing ended.')
        }
        return result
      }
      pc.onconnectionstatechange = () => {
        if (flows.get(key) !== flow) return
        if (pc.connectionState === 'failed') {
          remove(key)
          if (key === local) setMessage('Media connection failed.')
          return
        }
        if (pc.connectionState === 'connecting' || pc.connectionState === 'disconnected')
          waitForConnection(key, flow)
        else clearTimeout(flow.timeout)
        if ((key === local || key === localAudio) && flow.handle && pc.connectionState === 'connected')
          void signal('ready', { handle: flow.handle })
            .then(() => {
              const firstReady = !flow.ready
              flow.ready = true
              refresh()
              if (firstReady && key === local && flow.displayAudio) void publishDisplayAudio(flow)
              if (key === localAudio) {
                const surface = flows.get(local)?.stream?.getVideoTracks()[0]?.getSettings().displaySurface
                setBrowserAudioStatus(surface === 'browser' ? 'Sharing tab audio.' :
                  surface === 'monitor' ? 'Sharing system audio, including sounds from other apps.' : 'Sharing picker audio. If you selected system audio, other apps are included.')
              }
            })
            .catch(() => {
              if (flows.get(key) === flow) remove(key)
            })
      }
      return { flow, signal }
    }
    async function publishDisplayAudio(parent: Flow) {
      const track = parent.displayAudio
      if (flows.get(local) !== parent || !track || track.readyState !== 'live' || !parent.handle || flows.has(localAudio)) return
      try {
        const { flow, signal } = attach(localAudio, parent.handle)
        flow.cancelPublication = new AbortController()
        await publish(flow.pc, track, signal, undefined, flow.cancelPublication.signal)
        if (flows.get(localAudio) === flow && flow.pc.connectionState === 'new') waitForConnection(localAudio, flow)
      } catch {
        if (flows.get(local) !== parent || parent.displayAudio?.readyState === 'ended') return
        if (flows.has(localAudio)) remove(localAudio)
        else track.stop()
        setBrowserAudioStatus('Video only. Screen audio could not connect. Stop sharing and try again.')
      }
    }
    start.current = async (withAudio) => {
      if (!active || !canPublish || flows.has(local)) return
      setBusy(true)
      setMessage('')
      const { flow, signal } = attach(local)
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: nativeTarget.fps, max: nativeTarget.fps } },
          audio: withAudio,
          ...(withAudio && { systemAudio: 'include', windowAudio: 'window', selfBrowserSurface: 'exclude' }),
        })
        if (flows.get(local) !== flow) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        flow.stream = stream
        const [track] = stream.getVideoTracks()
        if (windows) {
          const audioTracks = stream.getAudioTracks()
          const audio = withAudio ? audioTracks.find(t => t.readyState === 'live') : undefined
          for (const extra of audioTracks) if (extra !== audio) extra.stop()
          flow.displayAudio = audio
          if (audio) {
            setBrowserAudioStatus('Connecting screen audio…')
            audio.onended = () => {
              if (flows.get(local) !== flow) return
              remove(localAudio)
              setBrowserAudioStatus('Video only. The browser stopped sharing audio.')
            }
          } else if (withAudio) {
            setBrowserAudioStatus(missingAudio(track.getSettings().displaySurface))
          }
        }
        track.onended = () => {
          if (flows.get(local) === flow) remove(local)
        }
        flow.cancelPublication = new AbortController()
        await publish(flow.pc, track, signal, undefined, flow.cancelPublication.signal)
        if (!active || flows.get(local) !== flow) return
        if (flow.pc.connectionState === 'new') waitForConnection(local, flow)
        sender.current = flow.pc.getSenders().find(s => s.track === track)
        if (sender.current && selectedQuality.current.fps !== nativeTarget.fps) {
          try {
            await applyVideoTarget(sender.current, track.getSettings(), selectedQuality.current)
          } catch {
            if (flows.get(local) === flow) {
              selectQuality(nativeTarget)
              setMessage('This browser could not apply the selected frame rate.')
            }
          }
        }
        refresh()
      } catch (e) {
        if (flows.get(local) === flow) {
          remove(local)
          if (active) {
            if (e instanceof ScreenIceGatheringError) setMessage(e.message)
            else if (e instanceof DOMException && e.name === 'NotAllowedError') setMessage('Screen sharing was declined.')
            else setMessage('Screen sharing could not start.')
          }
        }
      } finally {
        if (active) setBusy(false)
      }
    }
    stop.current = () => remove(local)
    async function watch(publication: string, audioFor?: string) {
      const { flow, signal } = attach(publication, audioFor)
      try {
        await subscribe(
          flow.pc,
          publication,
          (track) => {
            if (flows.get(publication) !== flow) return
            flow.stream = new MediaStream([track])
            refresh()
          },
          signal,
        )
      } catch {
        if (flows.get(publication) === flow) remove(publication)
      }
    }
    async function poll() {
      let delay = 2500
      try {
        const handles = Array.from(flows.values())
          .map((f) => f.handle)
          .filter(Boolean)
        const state = await request('state', { handles, version: stateVersion, idleWait: true })
        stateVersion = state.version
        retryDelay = 2500
        if (stateVersion) delay = 0
        if (!active) return
        setParticipants(state.participants ?? [])
        setMessage(value => value === 'Media connection interrupted.' ? '' : value)
        const audio = Object.entries(state.audio ?? {}) as [string, string][]
        const list: string[] = [...state.publications, ...audio.map(([, handle]) => handle)]
        for (const [key, flow] of flows) {
          if (
            (key !== local && key !== localAudio && !list.includes(key)) ||
            (flow.handle && handles.includes(flow.handle) && !state.owned.includes(flow.handle))
          )
            remove(key)
        }
        for (const key of list)
          if (!flows.has(key)) void watch(key, audio.find(([, handle]) => handle === key)?.[0])
      } catch {
        if (active) {
          setParticipants([])
          stateVersion = undefined
          delay = retryDelay
          retryDelay = Math.min(60000, retryDelay * 2)
          for (const key of flows.keys()) remove(key)
          setMessage('Media connection interrupted.')
        }
      } finally {
        if (active) timer = setTimeout(() => void poll(), delay)
      }
    }
    window.addEventListener('pagehide', dispose)
    void poll()
    return () => {
      window.removeEventListener('pagehide', dispose)
      dispose()
    }
  }, [channel, identity, canPublish, windows])

  const focused = tiles.length > 1 && tiles.some((t) => t.key === focus)
  const sharing = tiles.some((t) => t.key === local)
  const audioNotice = browserAudioStatus || (windows && audioEnabled && !sharing
    ? 'Choose audio in the browser picker. System audio can include other apps and notifications.' : '')
  return (<>
    <div className="player-stage">
      {tiles.length ? (
        <div
          className="player-grid"
          data-focused={focused}
          data-count={tiles.length}
          style={{ '--columns': Math.ceil(Math.sqrt(tiles.length)) } as CSSProperties}
        >
          {tiles.map(({ key, stream }, i) => (
            <article
              key={key}
              className="player-tile"
              hidden={focused && key !== focus}
              aria-label={key === local ? 'Your screen' : 'Remote screen'}
            >
              <Video stream={stream} />
              <button
                className="focus-surface"
                aria-label={'Focus screen ' + (i + 1)}
                onClick={() => setFocus(key)}
              />
            </article>
          ))}
        </div>
      ) : (
        <div className="player-empty">
          <h2>No active screens</h2>
        </div>
      )}
      {(message || audioNotice) && (
        <p className="player-message" role={message ? 'alert' : 'status'}>
          {[message, audioNotice].filter(Boolean).join(' ')}
        </p>
      )}
      <div className="player-dock">
        {focused && <button onClick={() => setFocus('')}>Back to grid</button>}
        <button aria-expanded={qualityOpen} onClick={() => setQualityOpen(!qualityOpen)}>Quality</button>
        {qualityOpen && <div className="player-popover quality-menu" role="region" aria-label="Quality controls">
          <PublishQuality value={quality} settings={sender.current?.track?.getSettings()}
            busy={busy || qualityBusy} sharing={sharing} onChange={target => void changeQuality(target)} />
        </div>}
        {canPublish && <button
          className="share-action"
          disabled={busy}
          onClick={() => (sharing ? stop.current() : start.current(windows && audioEnabled))}
        >
          {busy ? 'Opening picker…' : sharing ? 'Stop sharing' : 'Share my screen'}
        </button>}
        {canPublish && <label className="share-audio-toggle">
          <input
            type="checkbox"
            checked={audioEnabled}
            disabled={windows && (busy || sharing)}
            onChange={(e) => {
              setAudioEnabled(e.target.checked)
              if (!windows) writeAudioPreference('whiterun.gameAudio.enabled', e.target.checked ? 'on' : 'off')
            }}
          />
          Share audio
        </label>}
        <button aria-expanded={audioOpen} onClick={() => setAudioOpen(!audioOpen)}>
          {screen && audioEnabled && offer && !audioOpen ? 'Allow audio' : 'Audio'}
        </button>
        {blocked.size > 0 && <button onClick={enableAudio}>Enable audio</button>}
        <div
          ref={audioControls}
          className="player-popover"
          hidden={!audioOpen}
          role="region"
          aria-label="Audio controls"
        >
          {!windows && screen && audioEnabled && (pairNativeAudio ? (
            <NativeAudio key={screen} screen={screen} control={control} />
          ) : (
            <DesktopAudio
              key={screen}
              open={audioOpen}
              screen={screen}
              control={control}
              onStatus={setAudioStatus}
              onOffer={setOffer}
            />
          ))}
          {screen && audioEnabled && audioStatus && <small role="status">{audioStatus}</small>}
          {tiles.map(
            (tile, i) =>
              tile.key !== local && (
                <RemoteAudio
                  key={tile.key}
                  screen={tile.key}
                  label={'Screen ' + (i + 1) + ' audio'}
                  stream={media.find((t) => t.audioFor === tile.key)?.stream}
                  onBlocked={reportBlocked}
                />
              ),
          )}
        </div>
        <button
          onClick={() => {
            void (
              document.fullscreenElement
                ? document.exitFullscreen()
                : document.documentElement.requestFullscreen()
            ).catch(() => setMessage('Fullscreen unavailable.'))
          }}
        >
          Fullscreen
        </button>
      </div>
    </div>
    {participants.length > 0 && <ParticipantStrip participants={participants} />}
  </>)
}
