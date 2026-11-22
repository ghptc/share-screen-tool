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
  vi.stubGlobal('navigator', Object.create(navigator, { mediaDevices: { value: { getDisplayMedia } } }))
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  const onDenied = vi.fn()
  render(<CloudflareStage channel="test" identity="tester" control="" onExpired={vi.fn()} onDenied={onDenied} />)
  fireEvent.click(screen.getByRole('button', { name: 'Start sharing' }))
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
  expect(screen.getByRole('button', { name: 'Start sharing' })).toBeEnabled()
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
  expect(screen.getByRole('button', { name: 'Start sharing' })).toBeEnabled()
})

it('honors capture ending before the deadline', async () => {
  const { peer, track, operations } = startScreen(candidate)
  await act(() => vi.advanceTimersByTimeAsync(7999))
  await act(async () => { track.readyState = 'ended'; track.onended() })
  await act(() => vi.advanceTimersByTimeAsync(1))
  expect(operations).toEqual(['state'])
  expect(peer.close).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Start sharing' })).toBeEnabled()
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
