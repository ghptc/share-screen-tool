import { afterEach, expect, it, vi } from 'vitest'
import { publish, ScreenIceGatheringTimeout } from './cloudflarePeer'

function screenPeer() {
  const offer = { type: 'offer' as const, sdp: 'v=0\r\n' }
  const peer = Object.assign(new EventTarget(), {
    iceGatheringState: 'gathering',
    localDescription: { ...offer },
    addTransceiver: () => ({ mid: '0' }),
    createOffer: async () => offer,
    setLocalDescription: vi.fn().mockResolvedValue(undefined),
    setRemoteDescription: vi.fn().mockResolvedValue(undefined),
  })
  const send = vi.fn().mockResolvedValue({ handle: 'screen', sdp: 'answer' })
  const publishScreen = () => publish(
    peer as unknown as RTCPeerConnection, { kind: 'video' } as MediaStreamTrack, send,
  )
  return { peer, send, publishScreen }
}

afterEach(() => vi.useRealTimers())

it.each([
  {
    state: 'gathering',
    lines: [
      'a=ice-pwd:private-fixture',
      'a=candidate:fixture 1 udp 1 192.0.2.1 12345 typ host',
      'a=candidate:fixture 1 udp 1 fixture.local 23456 typ host',
      'a=candidate:fixture 1 udp 1 198.51.100.1 34567 typ srflx raddr 192.0.2.1 rport 12345',
      'a=candidate:fixture 1 udp 1 203.0.113.1 45678 typ unknown-fixture',
    ],
    types: 'host, srflx',
    nullEvent: true,
  },
  { state: 'new', lines: [], types: 'none', nullEvent: false },
])('reports only safe screen ICE details on timeout ($state)', async ({ state, lines, types, nullEvent }) => {
  vi.useFakeTimers()
  const { peer, send, publishScreen } = screenPeer()
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
  const added = vi.spyOn(peer, 'addEventListener')
  const removed = vi.spyOn(peer, 'removeEventListener')
  peer.iceGatheringState = state
  const failure = publishScreen().catch(error => error)
  await vi.advanceTimersByTimeAsync(7999)
  peer.localDescription.sdp += lines.join('\r\n')
  if (nullEvent) peer.dispatchEvent(Object.assign(new Event('icecandidate'), { candidate: null }))
  await vi.advanceTimersByTimeAsync(1)
  const error = await failure
  const summary = `Gathering state: ${state}. Elapsed: 8000 ms. Candidate types: ${types}. ` +
    `Complete event: false. Null candidate event: ${nullEvent}.`
  expect(error).toBeInstanceOf(ScreenIceGatheringTimeout)
  expect(error.message).toBe('Screen sharing timed out waiting for ICE. ' + summary)
  expect(debug).toHaveBeenCalledExactlyOnceWith('Screen ICE. ' + summary)
  for (const [type, listener] of added.mock.calls)
    expect(removed).toHaveBeenCalledWith(type, listener)
  expect(vi.getTimerCount()).toBe(0)
  expect(send).not.toHaveBeenCalled()
})

it('sends the gathered offer once when the browser reports completion', async () => {
  vi.useFakeTimers()
  const { peer, send, publishScreen } = screenPeer()
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
  const result = publishScreen()
  await vi.advanceTimersByTimeAsync(10)
  peer.localDescription.sdp += 'a=candidate:fixture 1 udp 1 192.0.2.1 12345 typ host\r\n'
  peer.iceGatheringState = 'complete'
  peer.dispatchEvent(new Event('icegatheringstatechange'))
  await expect(result).resolves.toBe('screen')
  expect(send).toHaveBeenCalledExactlyOnceWith('publish', { mid: '0', sdp: peer.localDescription.sdp })
  expect(debug).toHaveBeenCalledExactlyOnceWith(
    'Screen ICE. Gathering state: complete. Elapsed: 10 ms. Candidate types: host. ' +
    'Complete event: true. Null candidate event: false.',
  )
  expect(vi.getTimerCount()).toBe(0)
})
