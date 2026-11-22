import { useEffect, useRef, useState } from 'react'
import ScreenSharing from './ScreenSharing'
import { ConnectionState, DisconnectReason, Room, RoomEvent } from 'livekit-client'

export type JoinResult = { nativeAudioControl?: string; token: string; serverUrl: string; identity: string; displayName: string; roomId: string; title: string; canPublish: boolean }
type Invitation = { id: string; invite: string; publishKey?: string }

const roomPattern = /^[A-Za-z0-9_-]{24}$/
const tokenPattern = /^[A-Za-z0-9_-]{43}$/

function invitationParameters(link: string): URLSearchParams | null {
  try {
    const url = new URL(link.trim())
    if (url.origin !== window.location.origin || url.username || url.password) return null
    const params = new URLSearchParams()
    const fragment = new URLSearchParams(url.hash.slice(1))
    for (const key of ['room', 'invite', 'publish']) {
      const values = [...url.searchParams.getAll(key), ...fragment.getAll(key)]
      // Reject ambiguity instead of silently changing the room or permissions.
      if (values.length > 1) return null
      if (values.length === 1) params.set(key, values[0])
    }
    return params
  } catch { return null }
}

function invitationRoom(link: string): string {
  const id = invitationParameters(link)?.get('room') || ''
  return roomPattern.test(id) ? id : ''
}

export function parseInvitation(input: string, roomId = ''): Invitation | null {
  const value = input.trim()
  if (tokenPattern.test(value)) {
    // An opaque invitation cannot identify its room, nor grant publishing.
    return roomPattern.test(roomId.trim()) ? { id: roomId.trim(), invite: value } : null
  }
  const params = invitationParameters(value)
  if (!params) return null
  const id = params.get('room') || ''
  const invite = params.get('invite') || ''
  const publishKey = params.get('publish')
  if (!roomPattern.test(id) || !tokenPattern.test(invite) || (publishKey !== null && !tokenPattern.test(publishKey))) return null
  return { id, invite, ...(publishKey ? { publishKey } : {}) }
}

function invitationLink(invite: Invitation) {
  const url = new URL(window.location.pathname, window.location.origin)
  url.hash = new URLSearchParams({ room: invite.id, invite: invite.invite, ...(invite.publishKey ? { publish: invite.publishKey } : {}) }).toString()
  return url.href
}

async function request<T>(path: string, body: unknown, signal: AbortSignal, key?: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: 'POST', signal, cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  })
  const value = await response.json()
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : 'The request failed')
  return value as T
}

export default function Rooms() {
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [operatorKey, setOperatorKey] = useState('')
  const [link, setLink] = useState(() => parseInvitation(window.location.href) ? window.location.href : '')
  const [roomId, setRoomId] = useState(() => invitationRoom(window.location.href))
  const [joined, setJoined] = useState<JoinResult | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const operation = useRef<AbortController | null>(null)
  useEffect(() => () => {
    const controller = operation.current
    operation.current = null
    controller?.abort()
  }, [])

  const fullInvitation = parseInvitation(link)
  const invitation = parseInvitation(link, roomId)
  useEffect(() => {
    const syncLocation = () => {
      if (joined || operation.current) return
      setLink(parseInvitation(window.location.href) ? window.location.href : '')
      setRoomId(invitationRoom(window.location.href))
      setError('')
    }
    window.addEventListener('popstate', syncLocation)
    window.addEventListener('hashchange', syncLocation)
    return () => {
      window.removeEventListener('popstate', syncLocation)
      window.removeEventListener('hashchange', syncLocation)
    }
  }, [joined])

  function updateInvitation(value: string) {
    setLink(value)
    const complete = parseInvitation(value)
    if (complete) setRoomId(complete.id)
  }

  async function enter(create: boolean) {
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller
    const timer = window.setTimeout(() => controller.abort(), 12000)
    setPending(true); setError(''); setNotice('')
    try {
      let invitation = parseInvitation(link, roomId)
      if (create) {
        const key = operatorKey
        setOperatorKey('')
        const result = await request<Invitation>('/rooms', { title }, controller.signal, key)
        if (controller.signal.aborted || operation.current !== controller) return
        invitation = result
        setLink(invitationLink(result))
      }
      if (!invitation) throw new Error('Enter a valid invitation link from this local application')
      const result = await request<JoinResult>(`/rooms/${encodeURIComponent(invitation.id)}/join`, { invite: invitation.invite, displayName: name.trim() || 'Guest', ...(invitation.publishKey ? { publishKey: invitation.publishKey } : {}) }, controller.signal)
      if (!controller.signal.aborted) {
        setLink(invitationLink(invitation))
        setRoomId(invitation.id)
        setJoined(result)
        // Capability remains in memory and the displayed link, not the address bar/history.
        const clean = new URL(window.location.href)
        for (const key of ['room', 'invite', 'publish']) clean.searchParams.delete(key)
        window.history.replaceState(null, '', clean.pathname + clean.search)
      }
    } catch (cause) {
      if (operation.current === controller) setError(controller.signal.aborted ? 'Request cancelled or timed out. You can try again.' : cause instanceof Error ? cause.message : 'Could not join room')
    } finally {
      window.clearTimeout(timer)
      if (operation.current === controller) { operation.current = null; setPending(false) }
    }
  }

  if (joined) return <RoomSession credentials={joined} link={link} onLeave={() => { setJoined(null); setNotice('You left the room. You can join again below.') }} />
  return <section aria-labelledby="rooms-heading">
    <h2 id="rooms-heading">Rooms and participants</h2>
    <p>Viewer invitations allow viewing. Publisher invitations also allow screen sharing after explicit browser consent. Screen audio is optional and requires explicit consent.</p>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <label>Display name<input value={name} onChange={e => setName(e.target.value)} maxLength={64} disabled={pending} autoComplete="nickname" aria-describedby="display-name-help" /></label>
    <p id="display-name-help" className="note">Required to create a room. Guests may leave this blank to join as Guest.</p>
    <form onSubmit={e => { e.preventDefault(); void enter(true) }}>
      <h3>Create a room</h3>
      <label>Room title<input value={title} onChange={e => setTitle(e.target.value)} maxLength={80} required disabled={pending} /></label>
      <label>Local operator key<input type="password" value={operatorKey} onChange={e => setOperatorKey(e.target.value)} required disabled={pending} autoComplete="off" /></label>
      <button disabled={pending || !name.trim() || !title.trim() || !operatorKey}>Create and join room</button>
    </form>
    <form onSubmit={e => { e.preventDefault(); void enter(false) }}>
      <h3>Join with an invitation</h3>
      <label>Invitation link<input type="text" value={link} onChange={e => updateInvitation(e.target.value)} required disabled={pending} autoComplete="off" spellCheck={false} aria-describedby="invitation-help" aria-invalid={!!link.trim() && !invitation} /></label>
      <p id="invitation-help" className="note">Paste a full invitation URL or a raw invitation token. A raw token needs the Room ID below. Guests never need the local operator key.</p>
      <label>Room ID<input value={fullInvitation?.id ?? roomId} onChange={e => setRoomId(e.target.value)} disabled={pending || !!fullInvitation} autoComplete="off" spellCheck={false} /></label>
      <button disabled={pending || !invitation}>Join room</button>
    </form>
    {pending && <><p role="status">Authorizing room access…</p><button onClick={() => operation.current?.abort()}>Cancel request</button></>}
  </section>
}

export function RoomSession({ credentials, link, onLeave }: { credentials: JoinResult; link: string; onLeave: () => void }) {
  const [connection, setConnection] = useState<ConnectionState>(ConnectionState.Connecting)
  const [participants, setParticipants] = useState<{ identity: string; name: string }[]>([])
  const [error, setError] = useState('')
  const [copyStatus, setCopyStatus] = useState('')
  const [mediaRoom, setMediaRoom] = useState<Room | null>(null)
  const invitation = parseInvitation(link)
  const viewerLink = invitation ? invitationLink({ id: invitation.id, invite: invitation.invite }) : link
  useEffect(() => {
    const room = new Room({ adaptiveStream: true, dynacast: true })
    let disposed = false
    const sync = () => {
      if (disposed) return
      setParticipants([room.localParticipant, ...room.remoteParticipants.values()].map(p => ({ identity: p.identity, name: p.name || p.identity })))
    }
    const state = (next: ConnectionState) => { if (!disposed) setConnection(next) }
    const disconnected = (reason?: DisconnectReason) => {
      if (disposed) return
      setConnection(ConnectionState.Disconnected); setParticipants([]); setMediaRoom(null)
      setError(`Disconnected${reason === undefined ? '' : ` (${DisconnectReason[reason] || reason})`}. Leave this view and join again to request fresh access.`)
    }
    room.on(RoomEvent.ParticipantConnected, sync).on(RoomEvent.ParticipantDisconnected, sync)
      .on(RoomEvent.ParticipantNameChanged, sync).on(RoomEvent.ConnectionStateChanged, state)
      .on(RoomEvent.Reconnected, sync).on(RoomEvent.Disconnected, disconnected)
    void room.connect(credentials.serverUrl, credentials.token, { autoSubscribe: true }).then(() => {
      if (disposed) { void room.disconnect(); return }
      setConnection(room.state); setMediaRoom(room); sync()
    }).catch(() => {
      if (!disposed) { setConnection(ConnectionState.Disconnected); setParticipants([]); setMediaRoom(null); setError('Could not connect to LiveKit. Leave this view and join again to retry.'); void room.disconnect() }
    })
    return () => { disposed = true; room.removeAllListeners(); void room.disconnect() }
  }, [credentials])

  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setCopyStatus('Invitation copied') }
    catch { setCopyStatus('Clipboard unavailable. Select and copy the invitation field.') }
  }
  return <section aria-labelledby="session-heading">
    <h2 id="session-heading">{credentials.title}</h2>
    <p role="status">Connection: <strong>{connection}</strong></p>
    {error && <p role="alert">{error}</p>}
    {(connection === ConnectionState.Reconnecting || connection === ConnectionState.SignalReconnecting) && <p>Reconnecting automatically. Participant presence may be out of date.</p>}
    <p>Publishing permission: {credentials.canPublish ? 'screen video and optional screen audio' : 'viewer only'}. Microphone and camera publishing are disabled. Screen audio availability depends on the browser and selected source.</p>
    {mediaRoom && <ScreenSharing room={mediaRoom} canPublish={credentials.canPublish} nativeAudioControl={credentials.nativeAudioControl} />}
    <h3>Participants ({participants.length})</h3>
    <ul aria-label="Participants">{participants.map(p => <li key={p.identity}>{p.name}{p.identity === credentials.identity ? ' (you)' : ''}</li>)}</ul>
    <label>Share invitation<input readOnly value={viewerLink} onFocus={e => e.currentTarget.select()} /></label>
    <p className="note">Anyone with this link can join until its expiry, eight hours after creation. Share it only with intended guests.</p>
    <button onClick={() => void copy(viewerLink)}>Copy invitation</button>
    {credentials.canPublish && invitation?.publishKey && <>
      <label>Screen publisher invitation<input readOnly value={link} onFocus={e => e.currentTarget.select()} /></label>
      <p className="note">This separate link grants screen publishing. Share it only with intended publishers. The viewer link above does not grant it.</p>
      <button onClick={() => void copy(link)}>Copy publisher invitation</button>
    </>}
    {copyStatus && <p role="status">{copyStatus}</p>}
    <button className="secondary" onClick={onLeave}>Leave room</button>
  </section>
}
