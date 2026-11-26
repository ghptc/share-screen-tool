import { memo, useCallback, useMemo, useEffect, useRef, useState, type CSSProperties } from 'react'
import { publish, ScreenIceGatheringError, subscribe, type Signal } from './cloudflarePeer'
import { roomEntry } from './roomEntry'
import DesktopAudio from './DesktopAudio'
import HostedAudio from './HostedAudio'
import { readAudioPreference, writeAudioPreference } from './gameAudioSession'
import { applyVideoTarget, nativeTarget, observeScreenActivity, type VideoTarget } from './videoQuality'
import { supportedVideoCodecs, type CodecPreference } from './videoCodec'
import PublishQuality from './PublishQuality'
import RoomVideoBenchmark from './RoomVideoBenchmark'
import CloudflareDiagnostics from './CloudflareDiagnostics'

class TemporaryControlError extends Error {}

type Flow = {
  audioFor?: string
  displayAudio?: MediaStreamTrack
  ready?: boolean
  announcing?: boolean
  readyRetries?: number
  negotiated?: boolean
  pc: RTCPeerConnection
  handle?: string
  stream?: MediaStream
  cancelPublication?: AbortController
  timeout?: ReturnType<typeof setTimeout>
}
type Participant = { key: string; name: string; avatar?: string; sharing: boolean }
type MediaFlow = { key: string; stream?: MediaStream; audioFor?: string; pc?: RTCPeerConnection; retrying?: boolean }
type Subscription = { audioFor?: string; retryDelay: number; timer?: ReturnType<typeof setTimeout> }
type Mix = { volume: number; muted: boolean }
const defaultMix: Mix = { volume: 100, muted: false }
const local = 'local'
const localAudio = 'local-audio'
const initialSubscriptionRetry = 1000
// Chromium's capture-device names distinguish process capture from the system
// fallback. Unknown scope stays video-only. Never log a returned track label.
const chromiumAudioLabels: Record<string, string | undefined> = {
  window: 'Application Audio', monitor: 'System Audio', browser: 'Tab audio',
}

function missingAudio(surface?: string) {
  if (surface === 'browser') return 'Video only. Share again and enable tab audio in the browser picker.'
  if (surface === 'monitor') return 'Video only. Share again and enable system audio for Entire Screen if offered. System audio includes other apps.'
  if (surface === 'window') return 'Video only. The browser returned no window audio. Share again if the picker offers application audio.'
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

const Video = memo(function Video({ stream, presenting }: { stream: MediaStream; presenting: boolean }) {
  const element = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = element.current!
    video.srcObject = stream
    return () => {
      video.srcObject = null
    }
  }, [stream])
  const suspended = useRef(false)
  useEffect(() => {
    const video = element.current!
    function update() {
      if (!presenting && document.pictureInPictureElement !== video) {
        if (!suspended.current) video.pause()
        suspended.current = true
      } else if (suspended.current) {
        suspended.current = false
        void video.play().catch(() => {}) // A later focus change can interrupt play().
      }
    }
    update()
    if (!presenting) {
      video.addEventListener('enterpictureinpicture', update)
      video.addEventListener('leavepictureinpicture', update)
      return () => {
        video.removeEventListener('enterpictureinpicture', update)
        video.removeEventListener('leavepictureinpicture', update)
      }
    }
  }, [presenting, stream])
  return <video ref={element} autoPlay={presenting} muted playsInline />
})

function RemoteAudio({
  stream,
  label,
  screen,
  mix,
  unavailable,
  onMix,
  onBlocked,
}: {
  stream?: MediaStream
  label: string
  screen: string
  mix: Mix
  unavailable: string
  onMix: (mix: Mix) => void
  onBlocked: (screen: string, retry?: () => void) => void
}) {
  const element = useRef<HTMLAudioElement>(null)
  const { volume, muted } = mix
  const [failure, setFailure] = useState('')
  const play = useCallback(function playStream() {
    const audio = element.current
    if (!audio || !stream || audio.srcObject !== stream || audio.muted) return
    void audio.play().then(() => {
      if (audio.srcObject === stream) {
        setFailure('')
        onBlocked(screen)
      }
    }).catch(error => {
      if (audio.srcObject !== stream || audio.muted) return
      const blocked = error?.name === 'NotAllowedError'
      setFailure(blocked ? 'Playback blocked. Choose Enable audio.' : 'Audio unavailable. Playback failed.')
      onBlocked(screen, blocked ? playStream : undefined)
    })
  }, [stream, screen, onBlocked])
  useEffect(() => {
    if (element.current) element.current.volume = volume / 100
  }, [volume, stream])
  useEffect(() => {
    const audio = element.current
    if (!audio || !stream) return
    audio.srcObject = stream
    setFailure('')
    play()
    return () => {
      audio.pause()
      audio.srcObject = null
      onBlocked(screen)
    }
  }, [stream, screen, onBlocked, play])
  if (!stream) return <p>{label} · {unavailable}</p>
  function toggle() {
    const audio = element.current
    if (!audio) return
    audio.muted = !muted
    onMix({ volume, muted: !muted })
    if (audio.muted) {
      onBlocked(screen)
      setFailure('')
    } else play()
  }
  return (
    <div className="listener-mix">
      <audio
        ref={element}
        aria-label={label + ' playback'}
        muted={muted}
        onPlaying={() => { setFailure(''); onBlocked(screen) }}
        onError={() => { setFailure('Audio unavailable. Playback failed.'); onBlocked(screen) }}
      />
      <label>
        {label} <small aria-hidden="true">{volume}%</small>
        {failure && <small role="status">{failure}</small>}
        <input
          type="range"
          aria-label={label + ' volume'}
          min="0"
          max="100"
          aria-valuetext={volume + '%'}
          value={volume}
          onChange={(e) => onMix({ muted, volume: Number(e.target.value) })}
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
  onDenied: (reason: string) => void
}) {
  const [publishDenied, setPublishDenied] = useState(false)
  const [media, setMedia] = useState<MediaFlow[]>([])
  const [participants, setParticipants] = useState<Participant[]>([])
  const [publishers, setPublishers] = useState<Record<string, string>>({})
  const [mixes, setMixes] = useState<Record<string, Mix>>({})
  const tiles = media.filter((t): t is MediaFlow & { stream: MediaStream } => !t.audioFor && !!t.stream)
  const stage = useRef<HTMLDivElement>(null)
  const [screen, setScreen] = useState('')
  const windows = /^Win/i.test(navigator.platform)
  const [browserAudioStatus, setBrowserAudioStatus] = useState('')
  const [audioEnabled, setAudioEnabled] = useState(
    () => readAudioPreference(windows ? 'screenShare.displayAudio' : 'whiterun.gameAudio.enabled') !== 'off',
  )
  const [audioOpen, setAudioOpen] = useState(false)
  const pairNativeAudio = import.meta.env.VITE_NATIVE_AUDIO_MODE === 'pair' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
  const [audioStatus, setAudioStatus] = useState('')
  const [blocked, setBlocked] = useState<Map<string, () => void>>(() => new Map())
  const reportBlocked = useCallback((screen: string, retry?: () => void) => {
    setBlocked((previous) => {
      if (previous.get(screen) === retry) return previous
      const next = new Map(previous)
      if (retry) next.set(screen, retry)
      else next.delete(screen)
      return next
    })
  }, [])
  function enableAudio() {
    for (const retry of blocked.values()) retry()
  }
  const [offer, setOffer] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [focus, setFocus] = useState('')
  const [pageVisible, setPageVisible] = useState(() => !document.hidden)
  useEffect(() => {
    const update = () => setPageVisible(!document.hidden)
    document.addEventListener('visibilitychange', update)
    update()
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  const [qualityOpen, setQualityOpen] = useState(false)
  const [quality, setQuality] = useState(nativeTarget)
  const [qualityBusy, setQualityBusy] = useState(false)
  const codecs = useMemo(() => canPublish ? supportedVideoCodecs() : [], [canPublish])
  const [preferredCodec, setPreferredCodec] = useState<CodecPreference>('auto')
  const nextCodec = useRef(preferredCodec)
  const sender = useRef<RTCRtpSender | undefined>(undefined)
  useEffect(() => {
    const current = sender.current
    if (!screen || !current?.track) return
    if (!quality.content) return observeScreenActivity(current)
    if ('contentHint' in current.track) current.track.contentHint = quality.content
  }, [screen, quality.content])
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
      if (current !== sender.current) return
      if (value.fps !== selectedQuality.current.fps && current.track.applyConstraints) {
        // The sender cap still applies if a picker cannot update capture cadence.
        await current.track.applyConstraints({ ...current.track.getConstraints(),
          frameRate: { ideal: value.fps, max: value.fps } }).catch(() => {})
      }
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
    // An advertised publication can outlive a failed receiving peer.
    const subscriptions = new Map<string, Subscription>()
    const endpoint = '/api/discord/' + channel + '/media/'
    let renewal: Promise<void> | undefined
    let generation = 0
    async function renew() {
      const response = await fetch('/api/discord/' + channel + '/join', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', body: JSON.stringify({ resumePeer: identity }),
        headers: { 'Content-Type': 'application/json', 'X-Whiterun-Entry': roomEntry(channel).key },
        signal: AbortSignal.any([stateRequest.signal, AbortSignal.timeout(10000)]),
      })
      const result = await response.json().catch(() => ({}))
      if (!active) throw new Error('Sharing ended.')
      if (response.ok && result?.identity === identity) {
        generation++
        return
      }
      if (response.ok || [401, 403, 410].includes(response.status)) {
        dispose()
        if (response.status === 410) expired.current()
        else denied.current(response.ok || response.status === 401 ? 'session_missing' : result?.reason ?? 'authorization_denied')
      }
      throw new TemporaryControlError('Room authorization unavailable.')
    }
    async function request(op: string, input: Record<string, unknown>) {
      const requestedGeneration = generation
      const send = () => fetch(endpoint + op, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        signal: op === 'state'
          ? AbortSignal.any([stateRequest.signal, AbortSignal.timeout(70000)])
          : AbortSignal.timeout(25000),
        keepalive: op === 'close',
        headers: { 'Content-Type': 'application/json', 'X-Whiterun-Peer': identity },
        body: JSON.stringify(input),
      })
      let response = await send()
      if (active && response.status === 401) {
        if (requestedGeneration === generation) {
          renewal ??= renew().finally(() => { renewal = undefined })
          await renewal
        }
        if (!active) throw new Error('Sharing ended.')
        response = await send()
      }
      if (active && response.status === 410) {
        dispose()
        expired.current()
      }
      if (active && (response.status === 401 || response.status === 403)) {
        const failure = await response.json().catch(() => ({}))
        if (active && op === 'publish' && failure?.reason === 'publish_forbidden') {
          setPublishDenied(true)
          remove(local)
          setMessage('Your screen publishing permission ended. You can keep watching.')
        } else if (active) {
          dispose()
          denied.current(response.status === 401 ? 'session_missing' : failure?.reason ?? 'authorization_denied')
        }
      }
      if (response.status >= 500 || response.status === 429 || response.status === 408)
        throw new TemporaryControlError('Media connection unavailable.')
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
      const records: MediaFlow[] = []
      for (const key of [local, localAudio, ...subscriptions.keys()]) {
        const flow = flows.get(key)
        const subscription = subscriptions.get(key)
        if (flow || subscription) records.push({ key, pc: flow?.pc, stream: flow?.stream,
          audioFor: flow?.audioFor ?? subscription?.audioFor, retrying: !flow })
      }
      setMedia(records)
      const own = flows.get(local)
      setScreen(own?.ready ? (own.handle ?? '') : '')
    }
    function remove(key: string, retry = false) {
      const subscription = subscriptions.get(key)
      if (subscription) {
        clearTimeout(subscription.timer)
        if (retry) {
          subscription.timer = setTimeout(() => void watch(key, subscription), subscription.retryDelay)
          subscription.retryDelay = Math.min(12000, subscription.retryDelay * 2)
        } else subscriptions.delete(key)
      }
      const flow = flows.get(key)
      if (!flow) { refresh(); return }
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
        }
        sender.current = undefined
        selectQuality({ ...selectedQuality.current, height: 0 })
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
          remove(key, true)
          if (key === local) setMessage('Media connection timed out.')
          if (key === localAudio) setBrowserAudioStatus('Video only. Screen audio connection timed out.')
        }
      }, 12000)
    }
    function removeAll() {
      for (const key of subscriptions.keys()) remove(key)
      for (const key of flows.keys()) remove(key)
    }
    function dispose() {
      if (!active) return
      active = false
      setParticipants([])
      setPublishers({})
      setMixes({})
      setMedia([])
      setScreen('')
      stateRequest.abort()
      clearTimeout(timer)
      removeAll()
    }
    function attach(key: string, audioFor?: string) {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] })
      const flow: Flow = { pc, audioFor }
      flows.set(key, flow)
      const signal: Signal = async (op, input) => {
        if (flows.get(key) !== flow) throw new Error('Sharing ended.')
        const result = await request(op, key === localAudio && op === 'publish' ? { ...input, screen: audioFor } : input)
        if (result.handle) flow.handle = result.handle
        if (!active || flows.get(key) !== flow) {
          if (result.handle) void request('close', { handle: result.handle }).catch(() => {})
          throw new Error('Sharing ended.')
        }
        return result
      }
      function connectionChanged() {
        if (flows.get(key) !== flow) return
        if (pc.connectionState === 'failed') {
          remove(key, true)
          if (key === local) setMessage('Media connection failed.')
          if (key === localAudio) setBrowserAudioStatus('Video only. Screen audio connection failed.')
          return
        }
        if (pc.connectionState === 'connecting' || pc.connectionState === 'disconnected')
          waitForConnection(key, flow)
        else clearTimeout(flow.timeout)
        const subscription = subscriptions.get(key)
        if (subscription && pc.connectionState === 'connected') subscription.retryDelay = initialSubscriptionRetry
        if (flow.negotiated && !flow.ready && !flow.announcing && flow.handle && pc.connectionState === 'connected') {
          flow.announcing = true
          void signal('ready', { handle: flow.handle })
            .then(() => {
              if (flows.get(key) !== flow) return
              flow.ready = true
              refresh()
              if (key === local && flow.displayAudio) void publishDisplayAudio(flow)
              if (key === localAudio) {
                const surface = flows.get(local)?.stream?.getVideoTracks()[0]?.getSettings().displaySurface
                setBrowserAudioStatus(surface === 'browser' ? 'Sharing tab audio.' :
                  surface === 'monitor' ? 'Sharing system audio, including sounds from other apps.' : 'Sharing selected application audio.')
              }
            })
            .catch(error => {
              if (flows.get(key) !== flow) return
              const retries = flow.readyRetries ?? 0
              const temporary = error instanceof TemporaryControlError || error instanceof TypeError || error?.name === 'TimeoutError'
              if (temporary && retries < 3) {
                flow.announcing = false
                flow.readyRetries = retries + 1
                if (pc.connectionState === 'connected') flow.timeout = setTimeout(connectionChanged, 1000 * 2 ** retries)
                return
              }
              remove(key)
              if (key === localAudio) setBrowserAudioStatus('Video only. The controller could not mark screen audio ready.')
              if (key === local) setMessage('The controller could not mark the screen ready.')
            })
        }
      }
      pc.onconnectionstatechange = connectionChanged
      function publicationAnswered() {
        if (flows.get(key) !== flow) return
        flow.negotiated = true
        if (pc.connectionState === 'new') waitForConnection(key, flow)
        else connectionChanged()
      }
      return { flow, signal, publicationAnswered }
    }
    async function publishDisplayAudio(parent: Flow) {
      const track = parent.displayAudio
      if (flows.get(local) !== parent || !track || track.readyState !== 'live' || !parent.handle || flows.has(localAudio)) return
      try {
        const { flow, signal, publicationAnswered } = attach(localAudio, parent.handle)
        flow.cancelPublication = new AbortController()
        refresh()
        await publish(flow.pc, track, signal, undefined, flow.cancelPublication.signal)
        publicationAnswered()
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
      const { flow, signal, publicationAnswered } = attach(local)
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: selectedQuality.current.fps, max: selectedQuality.current.fps } },
          audio: withAudio,
          ...(withAudio && { systemAudio: 'include', windowAudio: 'window', selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude' }),
        })
        if (flows.get(local) !== flow) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        flow.stream = stream
        const [track] = stream.getVideoTracks()
        if (windows) {
          const audioTracks = stream.getAudioTracks()
          const surface = track.getSettings().displaySurface
          const requiredLabel = chromiumAudioLabels[surface ?? '']
          const audio = withAudio && requiredLabel
            ? audioTracks.find(t => t.readyState === 'live' && t.label === requiredLabel) : undefined
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
            const unavailable = surface === 'window' ? 'The browser did not identify application-only audio for this window.'
              : 'The browser did not identify a live audio track for the selected surface.'
            setBrowserAudioStatus(audioTracks.length ? 'Video only. ' + unavailable : missingAudio(surface))
          } else setBrowserAudioStatus('Video only. Share audio was off.')
        }
        track.onended = () => {
          if (flows.get(local) === flow) remove(local)
        }
        flow.cancelPublication = new AbortController()
        if ('contentHint' in track) track.contentHint = selectedQuality.current.content ?? ''
        await publish(flow.pc, track, signal, { maxFramerate: selectedQuality.current.fps }, flow.cancelPublication.signal, nextCodec.current)
        if (!active || flows.get(local) !== flow) return
        publicationAnswered()
        sender.current = flow.pc.getSenders().find(s => s.track === track)
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
    async function watch(publication: string, subscription: Subscription) {
      const { audioFor } = subscription
      let attempt: Flow | undefined
      try {
        const { flow, signal } = attach(publication, audioFor)
        attempt = flow
        refresh()
        await subscribe(
          flow.pc,
          publication,
          (track) => {
            if (flows.get(publication) !== flow) return
            if (track.kind !== (audioFor ? 'audio' : 'video') || track.readyState === 'ended') {
              remove(publication, true)
              return
            }
            const stream = new MediaStream([track])
            flow.stream = stream
            track.onended = () => {
              if (flows.get(publication)?.stream === stream) remove(publication, true)
            }
            refresh()
          },
          signal,
        )
        if (flows.get(publication) === flow && flow.pc.connectionState === 'new') waitForConnection(publication, flow)
      } catch {
        if (subscriptions.get(publication) === subscription && flows.get(publication) === attempt)
          remove(publication, true)
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
        const owners: Record<string, string> = state.publishers ?? {}
        const screens = [...new Set<string>([...state.publications, ...Object.keys(state.audio ?? {})])]
        setPublishers(previous => Object.fromEntries(screens.map(key => [key, owners[key] || previous[key] || key])))
        // A listener may have adjusted the screen before its owner was identified.
        setMixes(previous => {
          const resolved = Object.entries(owners).filter(([key, owner]) => owner && key !== owner && previous[key])
          if (!resolved.length) return previous
          const next = { ...previous }
          for (const [key, owner] of resolved) {
            next[owner] = previous[key]
            delete next[key]
          }
          return next
        })
        setMessage(value => value === 'Media connection interrupted.' ? '' : value)
        const advertised = new Map<string, string | undefined>()
        for (const key of state.publications) advertised.set(key, undefined)
        for (const [screen, handle] of Object.entries<string>(state.audio ?? {})) advertised.set(handle, screen)
        for (const key of subscriptions.keys())
          if (!advertised.has(key)) remove(key)
        for (const [key, flow] of flows) {
          if (flow.handle && handles.includes(flow.handle) && !state.owned.includes(flow.handle)) remove(key)
        }
        for (const [key, audioFor] of advertised) {
          if (subscriptions.has(key)) continue
          const subscription = { audioFor, retryDelay: initialSubscriptionRetry }
          subscriptions.set(key, subscription)
          void watch(key, subscription)
        }
      } catch {
        if (active) {
          setParticipants([])
          stateVersion = undefined
          delay = retryDelay
          retryDelay = Math.min(flows.size ? 6000 : 60000, retryDelay * 2)
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
  const remoteScreens = [...new Set(media.filter(m => m.key !== local && m.key !== localAudio).map(m => m.audioFor ?? m.key))]
  function publisherLabel(key: string) {
    const owner = publishers[key] || key
    const name = participants.find(person => person.key === owner)?.name
    const fallback = 'Screen ' + (remoteScreens.indexOf(key) + 1)
    if (name && participants.some(person => person.key !== owner && person.name === name)) return `${name} (${fallback})`
    return name || fallback
  }
  const audioNotice = browserAudioStatus || (windows && audioEnabled && !sharing
    ? 'Choose audio in the browser picker. For a window, choose application audio. Entire Screen system audio can include other apps and notifications.' : '')
  return (<>
    <div className="player-stage" ref={stage}>
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
              <Video stream={stream} presenting={pageVisible && (!focused || key === focus)} />
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
          <h2>{remoteScreens.length ? 'Waiting for screen video' : 'No active screens'}</h2>
        </div>
      )}
      {(message || audioNotice) && (
        <p className="player-message" role={message ? 'alert' : 'status'}>
          {[message, audioNotice].filter(Boolean).join(' ')}
        </p>
      )}
      <div className="player-dock">
        {focused && <button onClick={() => setFocus('')}>Back to grid</button>}
        <button aria-expanded={qualityOpen} onClick={() => { setAudioOpen(false); setQualityOpen(!qualityOpen) }}>Quality</button>
        {qualityOpen && <div className="player-popover quality-menu" role="region" aria-label="Quality controls">
          {canPublish && !publishDenied && <PublishQuality contentControl value={quality} settings={sender.current?.track?.getSettings?.()}
            busy={busy || qualityBusy} sharing={sharing} onChange={target => void changeQuality(target)} />}
          {canPublish && !publishDenied && codecs.length > 0 && <label>Video codec
            <select value={preferredCodec} disabled={sharing || busy} onChange={e => {
              nextCodec.current = e.target.value as CodecPreference
              setPreferredCodec(nextCodec.current)
            }}>
              <option value="auto">Auto</option><option value="browser">Browser default</option>
              {codecs.map(codec => <option key={codec} value={codec}>Prefer {codec === 'H264' ? 'H.264' : codec}</option>)}
            </select>
          </label>}
          {tiles.length > 0 && <RoomVideoBenchmark root={stage} endpoints={tiles.flatMap(t =>
            t.pc ? [{ pc: t.pc, stream: t.stream, local: t.key === local }] : [])} />}
          {media.map(m => {
            if (!m.pc) return null
            const own = m.key === local || m.key === localAudio
            return <CloudflareDiagnostics key={m.key} pc={m.pc} local={own} audio={!!m.audioFor}
              label={own ? 'Your screen' : publisherLabel(m.audioFor ?? m.key)}
              stream={m.stream} root={stage} />
          })}
          {media.length > 0 && <small>{tiles.length} video tiles · {remoteScreens.length} remote screens</small>}
        </div>}
        {canPublish && !publishDenied && <button
          className="share-action"
          disabled={busy}
          onClick={() => (sharing ? stop.current() : start.current(windows && audioEnabled))}
        >
          {busy ? 'Opening picker…' : sharing ? 'Stop sharing' : 'Share my screen'}
        </button>}
        {canPublish && !publishDenied && <label className="share-audio-toggle">
          <input
            type="checkbox"
            checked={audioEnabled}
            disabled={windows && (busy || sharing)}
            onChange={(e) => {
              setAudioEnabled(e.target.checked)
              writeAudioPreference(windows ? 'screenShare.displayAudio' : 'whiterun.gameAudio.enabled', e.target.checked ? 'on' : 'off')
            }}
          />
          Share audio
        </label>}
        <button aria-expanded={audioOpen} onClick={() => { setQualityOpen(false); setAudioOpen(!audioOpen) }}>
          {screen && audioEnabled && offer && !audioOpen ? 'Allow audio' : 'Audio'}
        </button>
        {blocked.size > 0 && <button onClick={enableAudio}>Enable audio</button>}
        <div
          className="player-popover"
          hidden={!audioOpen}
          role="region"
          aria-label="Audio controls"
        >
          {!windows && screen && audioEnabled && (pairNativeAudio ? (
            <HostedAudio key={screen} screen={screen} control={control} open={audioOpen} />
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
          {remoteScreens.map(key => {
            const audio = media.find(m => m.audioFor === key && m.key !== localAudio)
            const owner = publishers[key] || key
            return (
              <RemoteAudio
                key={key}
                screen={key}
                label={publisherLabel(key) + ' audio'}
                mix={mixes[owner] ?? defaultMix}
                onMix={mix => setMixes(current => ({ ...current, [owner]: mix }))}
                stream={audio?.stream}
                unavailable={audio ? (audio.retrying ? 'Audio unavailable. Retrying subscription.' : 'Waiting for audio subscription.') : 'Video only. No audio published.'}
                onBlocked={reportBlocked}
              />
            )
          })}
        </div>
        <button
          onClick={async () => {
            try {
              if (document.fullscreenElement) await document.exitFullscreen()
              else await stage.current!.requestFullscreen()
            } catch { setMessage('Fullscreen unavailable.') }
          }}
        >
          Fullscreen
        </button>
      </div>
    </div>
    {participants.length > 0 && <ParticipantStrip participants={participants} />}
  </>)
}
