import { useEffect, useRef, useState } from 'react'
import { ConnectionState, Room, RoomEvent } from 'livekit-client'
import CloudflareStage from './CloudflareStage'
import InvitationRooms from './InvitationRooms'
import ScreenSharing from './ScreenSharing'
import type { JoinResult } from './Rooms'
import { endRoomEntry, rememberDeadline, roomEntry } from './roomEntry'
import './player.css'

function Player({ channel }: {channel?: string}) {
  const [session, setSession] = useState<{ room: Room; credentials: JoinResult } | null>(null)
  const [prototypePeer, setPrototypePeer] = useState<{identity: string; control: string} | null>(null)
  const [state, setState] = useState('Connecting')
  const [error, setError] = useState('')
  const expireCurrent = useRef<() => void>(() => {})
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let entry = channel ? roomEntry(channel) : undefined
    let ended = false
    let expiryTimer: number | undefined
    function expire() {
      if (ended) return
      ended = true
      if (entry) endRoomEntry(entry)
      controller.abort()
      window.clearTimeout(timer)
      disposeRoom()
      setState('Expired')
      setError('')
    }
    expireCurrent.current = expire
    function checkDeadline() {
      if (entry?.ended || (entry?.deadline !== undefined && Date.now() >= entry.deadline)) expire()
      return ended
    }
    let room: Room | undefined
    let timer: number | undefined
    let failures = 0
    let joining = false
    function connectionChanged(next: ConnectionState) {
      if (controller.signal.aborted) return
      if (next === ConnectionState.Connected) setState('Connected')
      else if (next === ConnectionState.Connecting) setState('Connecting')
      else setState('Reconnecting')
    }
    function disposeRoom() {
      if (room) {
        room.off(RoomEvent.ConnectionStateChanged, connectionChanged)
        room.off(RoomEvent.Disconnected, retry)
        void room.disconnect()
        room = undefined
      }
      setSession(null)
      setPrototypePeer(null)
    }
    function retry() {
      disposeRoom()
      if (controller.signal.aborted) return
      window.clearTimeout(timer)
      setState('Reconnecting')
      timer = window.setTimeout(join, Math.min(15000, 800 * 2 ** Math.min(failures++, 5)))
    }
    async function join() {
      if (controller.signal.aborted || joining || checkDeadline()) return
      joining = true
      setError('')
      try {
        const requestedAt = Date.now()
        const response = await fetch(channel ? '/api/discord/'+channel+'/join' : '/player/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(entry && { 'X-Whiterun-Entry': entry.key }) },
          body: '{}',
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
        })
        if (controller.signal.aborted || checkDeadline()) return
        if (entry?.deadline && response.status === 401) {
          setState('Unavailable')
          setError('Room authorization ended. Reopen the Discord link.')
          return
        }
        if (channel && response.status === 401) {
          window.location.replace('/api/discord/auth/'+channel)
          return
        }
        if (response.status === 403 || response.status === 404) {
          setState('Unavailable')
          setError(channel ? 'Connect to the associated Discord voice channel to watch.' : 'Local access is unavailable. Open the player from its localhost address.')
          return
        }
        if (!response.ok) throw new Error()
        const credentials: JoinResult & { transport?: string; expiresAt: string; serverTime: string } = await response.json()
        if (controller.signal.aborted) return
        if (entry && credentials.transport === 'cloudflare-prototype') {
          const granted = rememberDeadline(entry, credentials.expiresAt, credentials.serverTime, requestedAt)
          entry = granted
          if (checkDeadline()) return
          expiryTimer = window.setTimeout(expire, granted.deadline - Date.now())
          setPrototypePeer({identity:credentials.identity,control:credentials.nativeAudioControl ?? ''})
          setState('Connected')
          return
        }
        const current = new Room({ adaptiveStream: false, dynacast: true })
        room = current
        current.on(RoomEvent.ConnectionStateChanged, connectionChanged)
        await current.connect(credentials.serverUrl, credentials.token, { autoSubscribe: true })
        if (controller.signal.aborted || room !== current) {
          void current.disconnect()
          return
        }
        current.on(RoomEvent.Disconnected, retry)
        failures = 0
        setState('Connected')
        setSession({ room: current, credentials })
      } catch {
        if (!controller.signal.aborted) retry()
      } finally {
        joining = false
      }
    }
    setState('Connecting')
    window.addEventListener('pageshow', checkDeadline)
    document.addEventListener('visibilitychange', checkDeadline)
    void Promise.resolve().then(join)
    return () => {
      controller.abort()
      window.removeEventListener('pageshow', checkDeadline)
      document.removeEventListener('visibilitychange', checkDeadline)
      window.clearTimeout(timer)
      window.clearTimeout(expiryTimer)
      disposeRoom()
    }
  }, [attempt, channel])
  return (
    <main className="player" aria-label="Screen Share player">
      <header className="player-header">
        <span className="connection" role="status" data-connected={state === 'Connected'}>
          <i />
          {state}
        </span>
      </header>
      {prototypePeer && channel ? (
        <CloudflareStage
          key={prototypePeer.identity}
          channel={channel}
          identity={prototypePeer.identity}
          control={prototypePeer.control}
          onExpired={() => expireCurrent.current()}
          onDenied={() => {
            setPrototypePeer(null)
            setState('Unavailable')
            setError('Connect to the associated Discord voice channel to watch.')
          }}
        />
      ) : session ? (
        <ScreenSharing
          player
          channel={channel}
          room={session.room}
          canPublish={session.credentials.canPublish}
          nativeAudioControl={session.credentials.nativeAudioControl}
        />
      ) : (
        <div className="player-empty">
          <span className="standby-screen" aria-hidden="true" />
          <h2>{state === 'Expired' ? 'Session expired — reopen the link' : error ? 'Player unavailable' : state === 'Reconnecting' ? 'Reconnecting…' : 'Connecting…'}</h2>
          {error && state !== 'Expired' && <p role="alert">{error}</p>}
          {state !== 'Expired' && (error || state === 'Reconnecting') && (
            <button onClick={() => (error ? location.reload() : setAttempt((n) => n + 1))}>
              Retry connection
            </button>
          )}
        </div>
      )}
    </main>
  )
}

export default function App() {
  const url = new URL(window.location.href)
  const channel = /^\/r\/([A-Za-z0-9_-]{32})$/.exec(url.pathname)
  if(channel) return <Player channel={channel[1]} />
  if(url.pathname.startsWith('/r/')) return <main className="player"><div className="player-empty" role="alert">Room link unavailable.</div></main>
  const invitation = ['room', 'invite', 'publish'].some(
    (k) => url.searchParams.has(k) || new URLSearchParams(url.hash.slice(1)).has(k),
  )
  return url.pathname === '/' && !invitation ? <Player /> : <InvitationRooms />
}
