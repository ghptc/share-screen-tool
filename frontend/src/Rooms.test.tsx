import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ConnectionState, RoomEvent } from 'livekit-client'
import Rooms, { RoomSession, parseInvitation, type JoinResult } from './Rooms'

type Double = {
  localParticipant: { identity: string; name: string }
  remoteParticipants: Map<string, { identity: string; name: string }>
  state: string
  emit: (event: string, ...args: unknown[]) => void
  disconnect: ReturnType<typeof vi.fn>
}
vi.mock('./ScreenSharing', () => ({ default: () => null }))
const sdk = vi.hoisted(() => ({ rooms: [] as Double[], fail: false, defer: false, resolve: null as (() => void) | null }))
vi.mock('livekit-client', async importOriginal => {
  const original = await importOriginal<typeof import('livekit-client')>()
  return { ...original, Room: class {
    localParticipant = { identity: 'participant-test', name: 'Alice' }
    remoteParticipants = new Map([['existing', { identity: 'existing', name: 'Existing guest' }]])
    state = 'connecting'
    listeners = new Map<string, ((...args: unknown[]) => void)[]>()
    disconnect = vi.fn(async () => { this.state = 'disconnected' })
    constructor() { sdk.rooms.push(this) }
    on(event: string, fn: (...args: unknown[]) => void) { this.listeners.set(event, [...(this.listeners.get(event) || []), fn]); return this }
    removeAllListeners() { this.listeners.clear() }
    emit(event: string, ...args: unknown[]) { this.listeners.get(event)?.forEach(fn => fn(...args)) }
    async connect() {
      if (sdk.fail) throw new Error('connection failure')
      if (sdk.defer) await new Promise<void>(resolve => { sdk.resolve = resolve })
      this.state = 'connected'; this.emit('connectionStateChanged', this.state)
    }
  } }
})
const credentials: JoinResult = { token: 'signed-token', serverUrl: 'ws://127.0.0.1:7880', identity: 'participant-test', displayName: 'Alice', roomId: 'A'.repeat(24), title: 'Local room', canPublish: false }
const invite = 'B'.repeat(43)
const link = `${window.location.origin}/#room=${credentials.roomId}&invite=${invite}`

beforeEach(() => { sdk.rooms.length = 0; sdk.fail = false; sdk.defer = false; sdk.resolve = null; window.history.replaceState(null, '', '/') })
afterEach(() => vi.unstubAllGlobals())

test('shows existing participants, presence changes, reconnection, and disconnect', async () => {
  render(<RoomSession credentials={credentials} link={link} onLeave={vi.fn()} />)
  expect(await screen.findByText('Alice (you)')).toBeInTheDocument()
  expect(screen.getByText('Existing guest')).toBeInTheDocument()
  const room = sdk.rooms[0]
  act(() => { room.remoteParticipants.set('bob', { identity: 'bob', name: 'Bob' }); room.emit(RoomEvent.ParticipantConnected) })
  expect(screen.getByText('Bob')).toBeInTheDocument()
  act(() => { room.emit(RoomEvent.ConnectionStateChanged, ConnectionState.Reconnecting) })
  expect(screen.getByText(/Reconnecting automatically/)).toBeInTheDocument()
  act(() => { room.remoteParticipants.delete('existing'); room.emit(RoomEvent.ConnectionStateChanged, ConnectionState.Connected); room.emit(RoomEvent.Reconnected) })
  expect(screen.queryByText('Existing guest')).not.toBeInTheDocument()
  act(() => { room.remoteParticipants.delete('bob'); room.emit(RoomEvent.ParticipantDisconnected) })
  expect(screen.queryByText('Bob')).not.toBeInTheDocument()
  act(() => room.emit(RoomEvent.Disconnected))
  expect(screen.getByRole('alert')).toHaveTextContent('Disconnected')
  expect(screen.getByRole('heading', { name: 'Participants (0)' })).toBeInTheDocument()
})

test('disconnects on leave/unmount and cleans up a late connection', async () => {
  sdk.defer = true
  const leave = vi.fn()
  const { unmount } = render(<RoomSession credentials={credentials} link={link} onLeave={leave} />)
  fireEvent.click(screen.getByRole('button', { name: 'Leave room' }))
  expect(leave).toHaveBeenCalledOnce()
  const room = sdk.rooms[0]
  unmount()
  expect(room.disconnect).toHaveBeenCalledOnce()
  await act(async () => sdk.resolve?.())
  expect(room.disconnect).toHaveBeenCalledTimes(2)
})

test('reports failed LiveKit connection and releases the client', async () => {
  sdk.fail = true
  render(<RoomSession credentials={credentials} link={link} onLeave={vi.fn()} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not connect')
  expect(sdk.rooms[0].disconnect).toHaveBeenCalled()
})

test('creates room with operator auth, joins with invitation, and leaves', async () => {
  const fetchMock = vi.fn().mockImplementation((path: string) => Promise.resolve({ ok: true, json: async () => path === '/api/rooms' ? { id: credentials.roomId, invite } : credentials }))
  vi.stubGlobal('fetch', fetchMock)
  render(<Rooms />)
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Alice' } })
  fireEvent.change(screen.getByLabelText('Room title'), { target: { value: 'Local room' } })
  fireEvent.change(screen.getByLabelText('Local operator key'), { target: { value: 'operator-key' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create and join room' }))
  expect(await screen.findByRole('heading', { name: 'Local room' })).toBeInTheDocument()
  expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer operator-key')
  expect(fetchMock.mock.calls[1][1].headers.Authorization).toBeUndefined()
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ invite, displayName: 'Alice' })
  fireEvent.click(screen.getByRole('button', { name: 'Leave room' }))
  expect(screen.getByRole('status')).toHaveTextContent('You left')
  expect(screen.getByLabelText('Local operator key')).toHaveValue('')
  await waitFor(() => expect(sdk.rooms[0].disconnect).toHaveBeenCalled())
})

test('loads invitation fragment and reports authorization errors', async () => {
  window.history.replaceState(null, '', link)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'Room invitation is invalid or expired' }) }))
  render(<Rooms />)
  expect(screen.getByLabelText('Invitation link')).toHaveValue(link)
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Guest' } })
  fireEvent.click(screen.getByRole('button', { name: 'Join room' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('invalid or expired')
  expect(sdk.rooms).toHaveLength(0)
})

test('cancels pending authorization without connecting a room', async () => {
  vi.stubGlobal('fetch', vi.fn((_path: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('abort'))))))
  render(<Rooms />)
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Alice' } })
  fireEvent.change(screen.getByLabelText('Invitation link'), { target: { value: link } })
  fireEvent.click(screen.getByRole('button', { name: 'Join room' }))
  expect(screen.getByText('Authorizing room access…')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('cancelled or timed out')
  expect(sdk.rooms).toHaveLength(0)
})

test('rejects external, malformed, and incomplete invitation links', () => {
  expect(parseInvitation(link)).toEqual({ id: credentials.roomId, invite })
  for (const invalid of ['invalid', link.replace(window.location.origin, 'http://evil.example'), `${window.location.origin}/#room=guess`, `${window.location.origin}/#room=${credentials.roomId}&invite=short`]) expect(parseInvitation(invalid)).toBeNull()
})


test('creator keeps separate viewer and publisher invitations', async () => {
  const publishKey = 'P'.repeat(43)
  const fetchMock = vi.fn().mockImplementation((path: string) => Promise.resolve({ ok: true, json: async () => path === '/api/rooms' ? { id: credentials.roomId, invite, publishKey } : { ...credentials, canPublish: true } }))
  vi.stubGlobal('fetch', fetchMock)
  render(<Rooms />)
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Alice' } })
  fireEvent.change(screen.getByLabelText('Room title'), { target: { value: 'Local room' } })
  fireEvent.change(screen.getByLabelText('Local operator key'), { target: { value: 'operator-key' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create and join room' }))
  const publisher = await screen.findByLabelText('Screen publisher invitation')
  expect(publisher).toHaveValue(`${link}&publish=${publishKey}`)
  expect(screen.getByLabelText('Share invitation')).toHaveValue(link)
  expect(JSON.parse(fetchMock.mock.calls[1][1].body).publishKey).toBe(publishKey)
})


test('a populated valid invitation enables a guest with no operator key or display name', async () => {
  window.history.replaceState(null, '', link)
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => credentials })
  vi.stubGlobal('fetch', fetchMock)
  render(<Rooms />)
  expect(screen.getByLabelText('Invitation link')).toHaveValue(link)
  expect(screen.getByLabelText('Display name')).toHaveValue('')
  expect(screen.getByLabelText('Local operator key')).toHaveValue('')
  expect(screen.getByRole('button', { name: 'Join room' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'Join room' }))
  await screen.findByRole('heading', { name: 'Local room' })
  expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined()
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ invite, displayName: 'Guest' })
})

test('query invitations populate the field and enable joining without an operator key', () => {
  const query = `${window.location.origin}/?room=${credentials.roomId}&invite=${invite}`
  window.history.replaceState(null, '', query)
  render(<Rooms />)
  expect(screen.getByLabelText('Invitation link')).toHaveValue(query)
  expect(screen.getByRole('button', { name: 'Join room' })).toBeEnabled()
})

test('a raw token uses an explicit room context and the join field accepts text', async () => {
  window.history.replaceState(null, '', `/?room=${credentials.roomId}`)
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => credentials })
  vi.stubGlobal('fetch', fetchMock)
  render(<Rooms />)
  const input = screen.getByLabelText('Invitation link')
  expect(input).toHaveAttribute('type', 'text')
  fireEvent.change(input, { target: { value: invite } })
  expect(screen.getByRole('button', { name: 'Join room' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'Join room' }))
  await screen.findByRole('heading', { name: 'Local room' })
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ invite, displayName: 'Guest' })
})


test('query and fragment URLs retain only explicit publisher permission', () => {
  const publisher = `${window.location.origin}/?room=${credentials.roomId}&invite=${invite}&publish=${'P'.repeat(43)}`
  expect(parseInvitation(publisher)).toEqual({ id: credentials.roomId, invite, publishKey: 'P'.repeat(43) })
  expect(parseInvitation(invite, credentials.roomId)).toEqual({ id: credentials.roomId, invite })
  expect(parseInvitation(invite)).toBeNull()
  for (const invalid of [
    `${publisher}&room=${credentials.roomId}`,
    `${publisher}#invite=${invite}`,
    `${window.location.origin}/?room=${credentials.roomId}`,
    `${window.location.origin}/?invite=${invite}`,
    `${window.location.origin}/?room=${credentials.roomId}&invite=${invite}&publish=bad`,
    `${publisher.replace(window.location.origin, 'http://external.example')}`,
  ]) expect(parseInvitation(invalid)).toBeNull()
})

test('missing and malformed invitations stay disabled, including tokens without room context', () => {
  render(<Rooms />)
  const join = screen.getByRole('button', { name: 'Join room' })
  expect(join).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Invitation link'), { target: { value: invite } })
  expect(join).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Room ID'), { target: { value: credentials.roomId } })
  expect(join).toBeEnabled()
  fireEvent.change(screen.getByLabelText('Invitation link'), { target: { value: 'bad token' } })
  expect(join).toBeDisabled()
})

test('navigation events and pasted full URLs synchronize the invitation and room context', () => {
  render(<Rooms />)
  const query = `${window.location.origin}/?room=${credentials.roomId}&invite=${invite}`
  act(() => { window.history.pushState(null, '', query); window.dispatchEvent(new PopStateEvent('popstate')) })
  expect(screen.getByLabelText('Invitation link')).toHaveValue(query)
  expect(screen.getByLabelText('Room ID')).toHaveValue(credentials.roomId)
  expect(screen.getByRole('button', { name: 'Join room' })).toBeEnabled()
  const other = 'D'.repeat(24)
  fireEvent.change(screen.getByLabelText('Invitation link'), { target: { value: `${window.location.origin}/#room=${other}&invite=${invite}` } })
  expect(screen.getByLabelText('Room ID')).toHaveValue(other)
  act(() => { window.history.replaceState(null, '', '/'); window.dispatchEvent(new HashChangeEvent('hashchange')) })
  expect(screen.getByLabelText('Invitation link')).toHaveValue('')
  expect(screen.getByLabelText('Room ID')).toHaveValue('')
  expect(screen.getByRole('button', { name: 'Join room' })).toBeDisabled()
})

test('raw input never inherits publisher authority and query credentials are removed on join', async () => {
  const query = `${window.location.origin}/?room=${credentials.roomId}&invite=${invite}&publish=${'P'.repeat(43)}&theme=dark`
  window.history.replaceState(null, '', query)
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => credentials })
  vi.stubGlobal('fetch', fetchMock)
  render(<Rooms />)
  fireEvent.change(screen.getByLabelText('Invitation link'), { target: { value: invite } })
  fireEvent.click(screen.getByRole('button', { name: 'Join room' }))
  await screen.findByRole('heading', { name: 'Local room' })
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ invite, displayName: 'Guest' })
  expect(window.location.search).toBe('?theme=dark')
  expect(window.location.hash).toBe('')
  expect(screen.queryByLabelText('Screen publisher invitation')).not.toBeInTheDocument()
})
