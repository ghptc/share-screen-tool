import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import CloudflareStage from './CloudflareStage'

const candidate = 'a=candidate:fixture 1 udp 1 workstation.local 12345 typ host\r\n'

function startScreen(sdp: string, publishResponse = async () => Response.json({ handle: 'screen', sdp: 'answer' })) {
  vi.useFakeTimers()
  localStorage.setItem('whiterun.gameAudio.enabled', 'off')
  const track = { kind: 'video', readyState: 'live', stop: vi.fn(), onended: () => {} }
  const getDisplayMedia = vi.fn().mockResolvedValue({
    getTracks: () => [track], getVideoTracks: () => [track],
  })
  class Peer extends EventTarget {
    close = vi.fn()
    iceGatheringState = 'gathering'
    connectionState = 'new'
    onconnectionstatechange = () => {}
    localDescription = { type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\na=sendonly\r\n' + sdp }
    addTransceiver() { return { mid: '0' } }
    async createOffer() { return this.localDescription }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    getSenders() { return [] }
  }
  const peer = new Peer()
  const operations: string[] = []
  vi.stubGlobal('RTCPeerConnection', class { constructor() { return peer } })
  const fetch = vi.fn(async (path: string) => {
    const op = path.split('/').pop()!
    operations.push(op)
    switch (op) {
      case 'state': return new Promise<Response>(() => {})
      case 'publish': return publishResponse()
      case 'ready':
      case 'close': return Response.json({})
      default: throw new Error('Unexpected request')
    }
  })
  vi.stubGlobal('fetch', fetch)
  vi.stubGlobal('navigator', { platform: 'Linux x86_64', mediaDevices: { getDisplayMedia } })
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  const onDenied = vi.fn()
  render(<CloudflareStage canPublish channel="test" identity="tester" control="" onExpired={vi.fn()} onDenied={onDenied} />)
  expect(getDisplayMedia).not.toHaveBeenCalled()
  expect(operations).toEqual(['state'])
  fireEvent.click(screen.getByRole('button', { name: 'Share my screen' }))
  expect(getDisplayMedia).toHaveBeenCalledTimes(1)
  const changeConnection = (state: RTCPeerConnectionState) => act(async () => {
    peer.connectionState = state
    peer.onconnectionstatechange()
  })
  return { peer, track, fetch, operations, changeConnection, onDenied }
}

afterEach(() => {
  cleanup()
  localStorage.removeItem('whiterun.gameAudio.enabled')
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('releases the screen and peer after an empty gather before publish', async () => {
  const { peer, track, operations } = startScreen('')
  await act(() => vi.advanceTimersByTimeAsync(8000))
  expect(screen.getByRole('alert')).toHaveTextContent('Gathering state: gathering.')
  expect(screen.getByRole('button', { name: 'Share my screen' })).toBeEnabled()
  expect(peer.close).toHaveBeenCalledTimes(1)
  expect(track.stop).toHaveBeenCalledTimes(1)
  expect(operations).toEqual(['state'])
})

it('announces the bounded offer only after the answered peer connects', async () => {
  const { operations, changeConnection, fetch } = startScreen(candidate)
  await act(() => vi.advanceTimersByTimeAsync(8000))
  await changeConnection('connecting')
  expect(operations).toEqual(['state', 'publish'])
  await changeConnection('connected')
  await act(() => vi.advanceTimersByTimeAsync(12000))
  expect(operations).toEqual(['state', 'publish', 'ready'])
  expect(fetch).toHaveBeenCalledWith('/api/discord/test/media/ready', expect.objectContaining({
    body: JSON.stringify({ handle: 'screen' }),
  }))
})

it.each(['failed', 'connecting', 'new'] as const)('releases an unconnected publication (%s) without announcing or retrying', async state => {
  const { peer, track, fetch, operations, changeConnection } = startScreen(candidate)
  await act(() => vi.advanceTimersByTimeAsync(8000))
  if (state !== 'new') await changeConnection(state)
  await act(() => vi.advanceTimersByTimeAsync(12000))
  expect(screen.getByRole('alert')).toHaveTextContent(state === 'failed' ? 'Media connection failed.' : 'Media connection timed out.')
  expect(operations).toEqual(['state', 'publish', 'close'])
  expect(fetch).toHaveBeenCalledWith('/api/discord/test/media/close', expect.objectContaining({
    body: JSON.stringify({ handle: 'screen' }),
  }))
  expect(peer.close).toHaveBeenCalledTimes(1)
  expect(track.stop).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Share my screen' })).toBeEnabled()
})

it('honors capture ending before the deadline', async () => {
  const { peer, track, operations } = startScreen(candidate)
  await act(() => vi.advanceTimersByTimeAsync(7999))
  await act(async () => { track.readyState = 'ended'; track.onended() })
  await act(() => vi.advanceTimersByTimeAsync(1))
  expect(operations).toEqual(['state'])
  expect(peer.close).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Share my screen' })).toBeEnabled()
})

it('closes a late publish response when capture ended in flight', async () => {
  let respond!: (response: Response) => void
  const { track, operations } = startScreen(candidate, () => new Promise(resolve => { respond = resolve }))
  await act(() => vi.advanceTimersByTimeAsync(8000))
  expect(operations).toEqual(['state', 'publish'])
  await act(async () => { track.onended() })
  await act(async () => { respond(Response.json({ handle: 'screen', sdp: 'answer' })) })
  expect(operations).toEqual(['state', 'publish', 'close'])
})

it('honors authorization denial on the single deadline attempt', async () => {
  const { peer, track, operations, onDenied } = startScreen(candidate, async () => new Response(null, { status: 403 }))
  await act(() => vi.advanceTimersByTimeAsync(8000))
  expect(onDenied).toHaveBeenCalledTimes(1)
  expect(track.stop).toHaveBeenCalledTimes(1)
  expect(peer.close).toHaveBeenCalledTimes(1)
  expect(operations).toEqual(['state', 'publish'])
})

it('stops the chosen screen and stays in the room watching', async () => {
  const { operations, changeConnection, track, onDenied } = startScreen(candidate)
  await act(() => vi.advanceTimersByTimeAsync(8000))
  await changeConnection('connected')
  fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }))
  expect(operations).toEqual(['state', 'publish', 'ready', 'close'])
  expect(track.stop).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Share my screen' })).toBeEnabled()
  expect(onDenied).not.toHaveBeenCalled()
})

it('replaces the participant list and clears stale presence on an interrupted watch-only connection', async () => {
  vi.useFakeTimers()
  const state = (participants: unknown[]) => Response.json({ publications: [], owned: [], participants })
  const alice = { key: 'a', name: 'Alice', sharing: true, avatar: 'data:image/png;base64,AA==' }
  const bob = { key: 'b', name: 'Bob', sharing: true }
  const fetch = vi.fn()
    .mockResolvedValueOnce(state([alice, bob]))
    .mockResolvedValueOnce(state([{ ...alice, sharing: false }]))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(state([bob]))
  vi.stubGlobal('fetch', fetch)
  const onDenied = vi.fn()
  const props = { channel: 'test', identity: 'watcher', control: '', onExpired: vi.fn(), onDenied }
  render(<CloudflareStage {...props} canPublish={false} />)
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(screen.getAllByText('Sharing')).toHaveLength(2)
  expect(screen.getByText('Alice').closest('li')?.querySelector('img')).toHaveAttribute('alt', '')
  expect(screen.queryByRole('button', { name: 'Share my screen' })).toBeNull()
  await act(() => vi.advanceTimersByTimeAsync(2500))
  expect(screen.getByText('Watching')).toBeInTheDocument()
  expect(screen.queryByText('Bob')).toBeNull()
  await act(() => vi.advanceTimersByTimeAsync(2500))
  expect(screen.queryByRole('list', { name: 'Room participants' })).toBeNull()
  await act(() => vi.advanceTimersByTimeAsync(2500))
  expect(screen.getByText('Bob')).toBeInTheDocument()
  expect(onDenied).not.toHaveBeenCalled()
  expect(fetch.mock.calls.every(([path]) => path.endsWith('/media/state'))).toBe(true)
})

it('ignores a late participant update from the previous room', async () => {
  let oldReply!: (value: Response) => void
  const fetch = vi.fn()
    .mockImplementationOnce(() => new Promise<Response>(resolve => { oldReply = resolve }))
    .mockResolvedValueOnce(Response.json({ publications: [], owned: [], participants: [{ key: 'b', name: 'Bob', sharing: false }] }))
  vi.stubGlobal('fetch', fetch)
  const props = { identity: 'viewer', control: '', canPublish: false, onDenied: vi.fn(), onExpired: vi.fn() }
  const player = render(<CloudflareStage {...props} channel="one" />)
  player.rerender(<CloudflareStage {...props} channel="two" />)
  expect(await screen.findByText('Bob')).toBeInTheDocument()
  await act(async () => oldReply(Response.json({ publications: [], owned: [], participants: [{ key: 'a', name: 'Alice', sharing: true }] })))
  expect(screen.queryByText('Alice')).toBeNull()
  expect(screen.getByText('Bob')).toBeInTheDocument()
})
