import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { publish, subscribe, type Signal } from './cloudflarePeer'
import { nativeTarget } from './videoQuality'

type Flow = { pc: RTCPeerConnection; handle?: string; stream?: MediaStream; timeout?: ReturnType<typeof setTimeout> }
type Tile = { key: string; stream: MediaStream }
const local = 'local'

function Video({ stream }: { stream: MediaStream }) {
  const element = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = element.current!
    video.srcObject = stream
    return () => { video.srcObject = null }
  }, [stream])
  return <video ref={element} autoPlay muted playsInline />
}

export default function CloudflareStage({channel, identity, onDenied}: {
  channel: string; identity: string; onDenied: () => void
}) {
  const [tiles, setTiles] = useState<Tile[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [focus, setFocus] = useState('')
  const start = useRef<() => void>(() => {})
  const stop = useRef<() => void>(() => {})
  const denied = useRef(onDenied)
  denied.current = onDenied

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const flows = new Map<string, Flow>()
    const endpoint = '/api/discord/' + channel + '/media/'
    async function request(op: string, input: Record<string, unknown>) {
      const response = await fetch(endpoint + op, {method: 'POST', cache: 'no-store',
        signal: AbortSignal.timeout(25000), keepalive: op === 'close',
        headers: {'Content-Type':'application/json','X-Whiterun-Peer':identity}, body:JSON.stringify(input)})
      if (active && (response.status === 401 || response.status === 403)) {
        dispose()
        denied.current()
      }
      if (!response.ok) throw new Error(response.status === 409 ? 'Screen unavailable. All slots may be in use.' : 'Media connection unavailable.')
      return response.json()
    }
    function refresh() {
      if (active) setTiles(Array.from(flows, ([key, flow]) => ({key, stream:flow.stream})).filter((t): t is Tile => !!t.stream))
    }
    function remove(key: string) {
      const flow = flows.get(key)
      if (!flow) return
      flows.delete(key)
      clearTimeout(flow.timeout)
      flow.pc.close()
      flow.stream?.getTracks().forEach(t => t.stop())
      if (flow.handle) void request('close', {handle:flow.handle}).catch(() => {})
      refresh()
    }
    function dispose() {
      if (!active) return
      active = false
      clearTimeout(timer)
      for (const key of flows.keys()) remove(key)
    }
    function attach(key: string) {
      const pc = new RTCPeerConnection({iceServers:[{urls:'stun:stun.cloudflare.com:3478'}]})
      const flow: Flow = {pc}
      flows.set(key, flow)
      const signal: Signal = async (op, input) => {
        const result = await request(op, input)
        if (result.handle) flow.handle = result.handle
        if (!active || flows.get(key) !== flow) {
          if (result.handle) void request('close', {handle:result.handle}).catch(() => {})
          throw new Error('Sharing ended.')
        }
        return result
      }
      pc.onconnectionstatechange = () => {
        if (flows.get(key) !== flow) return
        if (pc.connectionState === 'failed') remove(key)
        clearTimeout(flow.timeout)
        if (pc.connectionState === 'connecting' || pc.connectionState === 'disconnected')
          flow.timeout = setTimeout(() => {
            if (flows.get(key) === flow) { remove(key); setMessage('Media connection timed out.') }
          }, 12000)
        if (key === local && pc.connectionState === 'connected')
          void signal('ready', {handle:flow.handle}).catch(() => remove(key))
      }
      return {flow, signal}
    }
    start.current = async () => {
      if (!active || flows.has(local)) return
      setBusy(true)
      setMessage('')
      const {flow, signal} = attach(local)
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:nativeTarget.fps,max:nativeTarget.fps}}, audio:false})
        if (flows.get(local) !== flow) { stream.getTracks().forEach(t => t.stop()); return }
        flow.stream = stream
        const [track] = stream.getVideoTracks()
        track.onended = () => remove(local)
        await publish(flow.pc, track, signal)
        refresh()
      } catch (e) {
        if (flows.get(local) === flow) {
          remove(local)
          if (active) setMessage(e instanceof DOMException && e.name === 'NotAllowedError' ? 'Screen sharing was declined.' : 'Screen sharing could not start.')
        }
      } finally { if (active) setBusy(false) }
    }
    stop.current = () => remove(local)
    async function watch(publication: string) {
      const {flow, signal} = attach(publication)
      try {
        await subscribe(flow.pc, publication, track => {
          if (flows.get(publication) !== flow) return
          flow.stream = new MediaStream([track])
          refresh()
        }, signal)
      } catch {
        if (flows.get(publication) === flow) remove(publication)
      }
    }
    async function poll() {
      try {
        const handles = Array.from(flows.values()).map(f => f.handle).filter(Boolean)
        const state = await request('state', {handles})
        if (!active) return
        const list: string[] = state.publications
        for (const [key, flow] of flows) {
          if ((key !== local && !list.includes(key)) || (flow.handle && handles.includes(flow.handle) && !state.owned.includes(flow.handle))) remove(key)
        }
        for (const key of list) if (!flows.has(key)) void watch(key)
      } catch {
        if (active) {
          for (const key of flows.keys()) remove(key)
          setMessage('Media connection interrupted.')
        }
      } finally { if (active) timer = setTimeout(() => void poll(), 2500) }
    }
    window.addEventListener('pagehide', dispose)
    void poll()
    return () => { window.removeEventListener('pagehide',dispose); dispose() }
  }, [channel, identity])

  const focused = tiles.length > 1 && tiles.some(t => t.key === focus)
  const sharing = tiles.some(t => t.key === local)
  return <div className="player-stage">
    {tiles.length ? <div className="player-grid" data-focused={focused} data-count={tiles.length}
      style={{'--columns': Math.ceil(Math.sqrt(tiles.length))} as CSSProperties}>
      {tiles.map(({key, stream}, i) => <article key={key} className="player-tile" hidden={focused && key !== focus}
        aria-label={key === local ? 'Your screen' : 'Remote screen'}>
        <Video stream={stream} />
        <button className="focus-surface" aria-label={'Focus screen '+(i+1)} onClick={() => setFocus(key)} />
      </article>)}
    </div> : <div className="player-empty"><h2>No active screens</h2></div>}
    {message && <p className="player-message" role="alert">{message}</p>}
    <div className="player-dock">
      {focused && <button onClick={() => setFocus('')}>Back to grid</button>}
      <button className="share-action" disabled={busy} onClick={() => sharing ? stop.current() : start.current()}>
        {busy ? 'Opening picker…' : sharing ? 'Stop sharing' : 'Start sharing'}
      </button>
      <button onClick={() => { void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => setMessage('Fullscreen unavailable.')) }}>Fullscreen</button>
    </div>
  </div>
}
