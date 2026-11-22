import { useEffect, useState } from 'react'
import { ConnectionState, Room, RoomEvent } from 'livekit-client'
import InvitationRooms from './InvitationRooms'
import ScreenSharing from './ScreenSharing'
import type { JoinResult } from './Rooms'
import './player.css'

function Player({ channel }: {channel?: string}) {
  const [session, setSession] = useState<{ room: Room; credentials: JoinResult } | null>(null)
  const [state, setState] = useState('Connecting')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
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
    }
    function retry() {
      disposeRoom()
      if (controller.signal.aborted) return
      window.clearTimeout(timer)
      setState('Reconnecting')
      timer = window.setTimeout(join, Math.min(15000, 800 * 2 ** Math.min(failures++, 5)))
    }
    async function join() {
      if (controller.signal.aborted || joining) return
      joining = true
      setError('')
      try {
        const response = await fetch(channel ? '/api/discord/'+channel+'/join' : '/player/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
        })
        if (controller.signal.aborted) return
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
        const credentials: JoinResult = await response.json()
        if (controller.signal.aborted) return
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
    void Promise.resolve().then(join)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
      disposeRoom()
    }
  }, [attempt, channel])
  return (
    <main className="player" aria-label="Whiterun Live player">
      <header className="player-header">
        <h1>
          <span className="brand-symbol" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          Whiterun <span className="brand-live">Live</span>
        </h1>
        <span className="connection" role="status" data-connected={state === 'Connected'}>
          <i />
          {state}
        </span>
      </header>
      {session ? (
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
          <h2>{error ? 'Player unavailable' : state === 'Reconnecting' ? 'Reconnecting…' : 'Connecting…'}</h2>
          {error && <p role="alert">{error}</p>}
          {(error || state === 'Reconnecting') && (
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
