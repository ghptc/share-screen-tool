import { afterEach, expect, it, vi } from 'vitest'
import { publish, subscribe, ScreenIceGatheringError } from './cloudflarePeer'

function screenPeer() {
  const offer = { type: 'offer' as const, sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\na=sendonly\r\n' }
  const peer = Object.assign(new EventTarget(), {
    iceGatheringState: 'gathering',
    localDescription: { ...offer },
    addTransceiver: () => ({ mid: '0' }),
    createOffer: async () => offer,
    setLocalDescription: vi.fn().mockResolvedValue(undefined),
    setRemoteDescription: vi.fn().mockResolvedValue(undefined),
  })
  const send = vi.fn().mockResolvedValue({ handle: 'screen', sdp: 'answer' })
  const track = { kind: 'video', readyState: 'live' }
  const publishScreen = (cancel?: AbortSignal) => publish(
    peer as unknown as RTCPeerConnection, track as MediaStreamTrack, send, undefined, cancel,
  )
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
  return { peer, track, send, publishScreen, debug }
}

const host = 'a=candidate:fixture 1 UDP 1 workstation.local 12345 typ host\r\n'
const reflexive = 'a=candidate:fixture 1 udp 1 198.51.100.1 34567 typ srflx raddr 192.0.2.1 rport 12345\r\n'

afterEach(() => vi.useRealTimers())

it('sends one current screen offer at the deadline with host and srflx and no completion events', async () => {
  vi.useFakeTimers()
  const { peer, send, publishScreen, debug } = screenPeer()
  const result = publishScreen()
  await vi.advanceTimersByTimeAsync(7999)
  peer.localDescription.sdp += host + reflexive + 'a=ice-pwd:private-fixture\r\n'
  expect(send).not.toHaveBeenCalled()
  const snapshot = peer.localDescription.sdp
  await vi.advanceTimersByTimeAsync(1)
  await expect(result).resolves.toBe('screen')
  expect(debug).toHaveBeenCalledExactlyOnceWith(
    'Screen ICE. Gathering state: gathering. Elapsed: 8000 ms. Candidate types: host, srflx. ' +
    'Complete event: false. Null candidate event: false.',
  )
  peer.localDescription.sdp += 'a=end-of-candidates\r\n'
  peer.iceGatheringState = 'complete'
  peer.dispatchEvent(new Event('icegatheringstatechange'))
  expect(send).toHaveBeenCalledExactlyOnceWith('publish', { mid: '0', sdp: snapshot })
  expect(peer.setRemoteDescription).toHaveBeenCalledExactlyOnceWith({ type: 'answer', sdp: 'answer' })
  expect(vi.getTimerCount()).toBe(0)
})

it.each([
  ['empty offer', ''],
  ['unusable candidates', 'a=candidate:fixture 2 udp 1 workstation.local 12345 typ host\r\n' +
    'a=candidate:fixture 1 udp 1 workstation.local 0 typ host\r\n' +
    'a=candidate:fixture 1 udp 1 workstation.local 12345 typ unknown\r\n'],
])('fails closed with %s even after a final null candidate event', async (_label, lines) => {
  vi.useFakeTimers()
  const { peer, send, publishScreen, debug } = screenPeer()
  const added = vi.spyOn(peer, 'addEventListener')
  const removed = vi.spyOn(peer, 'removeEventListener')
  const failure = publishScreen().catch(error => error)
  await vi.advanceTimersByTimeAsync(7999)
  peer.localDescription.sdp += lines
  peer.dispatchEvent(Object.assign(new Event('icecandidate'), { candidate: null }))
  await vi.advanceTimersByTimeAsync(1)
  const error = await failure
  const summary = 'Gathering state: gathering. Elapsed: 8000 ms. Candidate types: none. ' +
    'Complete event: false. Null candidate event: true.'
  expect(error).toBeInstanceOf(ScreenIceGatheringError)
  expect(error.message).toBe('Screen sharing timed out waiting for ICE. ' + summary)
  expect(debug).toHaveBeenCalledExactlyOnceWith('Screen ICE. ' + summary)
  for (const [type, listener] of added.mock.calls)
    expect(removed).toHaveBeenCalledWith(type, listener)
  expect(vi.getTimerCount()).toBe(0)
  expect(send).not.toHaveBeenCalled()
})

it('stops immediately if gathering completes without an RTP candidate', async () => {
  vi.useFakeTimers()
  const { peer, send, publishScreen } = screenPeer()
  peer.iceGatheringState = 'complete'
  await expect(publishScreen()).rejects.toThrow('Screen sharing found no usable ICE candidate.')
  expect(send).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('sends the gathered offer once when the browser reports completion', async () => {
  vi.useFakeTimers()
  const { peer, send, publishScreen, debug } = screenPeer()
  const result = publishScreen()
  await vi.advanceTimersByTimeAsync(10)
  peer.localDescription.sdp += host
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

it('checks track liveness at the deadline even if the browser has not dispatched ended', async () => {
  vi.useFakeTimers()
  const { peer, track, send, publishScreen } = screenPeer()
  peer.localDescription.sdp += host
  const failure = expect(publishScreen()).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(7999)
  track.readyState = 'ended'
  await vi.advanceTimersByTimeAsync(1)
  await failure
  expect(send).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('removes the wait and all peer listeners immediately when the publication is cancelled', async () => {
  vi.useFakeTimers()
  const { peer, send, publishScreen } = screenPeer()
  const cancel = new AbortController()
  const added = vi.spyOn(peer, 'addEventListener')
  const removed = vi.spyOn(peer, 'removeEventListener')
  const failure = expect(publishScreen(cancel.signal)).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(1)
  peer.localDescription.sdp += host
  cancel.abort()
  await failure
  for (const [type, listener] of added.mock.calls)
    expect(removed).toHaveBeenCalledWith(type, listener)
  expect(send).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it.each([
  { name: 'a usable RTP candidate', candidates: host },
  { name: 'no candidates', candidates: '' },
])('checks the current receiver answer at the ICE deadline with $name', async ({ candidates }) => {
  vi.useFakeTimers()
  const peer = Object.assign(new EventTarget(), {
    iceGatheringState: 'gathering', localDescription: { type: 'answer', sdp: 'a=recvonly\r\n' },
    setRemoteDescription: vi.fn(), getTransceivers: () => [],
    createAnswer() { return this.localDescription }, setLocalDescription: vi.fn(),
  })
  const send = vi.fn().mockResolvedValueOnce({ handle: 'receiver', sdp: 'offer' }).mockResolvedValueOnce({})
  const result = subscribe(peer as unknown as RTCPeerConnection, 'screen', vi.fn(), send).catch(error => error)
  await vi.advanceTimersByTimeAsync(7999)
  expect(send).toHaveBeenCalledTimes(1)
  peer.localDescription.sdp += candidates
  await vi.advanceTimersByTimeAsync(1)
  if (candidates) {
    expect(await result).toBe('receiver')
    expect(send).toHaveBeenNthCalledWith(2, 'answer', { handle: 'receiver', sdp: peer.localDescription.sdp })
  } else {
    expect(await result).toBeInstanceOf(Error)
    expect(send).toHaveBeenCalledTimes(1)
  }
})

it('subscribes to the advertised audio handle and answers with stereo Opus', async () => {
  const opus = { mimeType: 'audio/opus', clockRate: 48000, channels: 2 }
  vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => ({ codecs: [opus] }) })
  try {
    const track = { kind: 'audio' } as MediaStreamTrack
    const receiver = { receiver: { track }, setCodecPreferences: vi.fn() }
    const peer = {
      iceGatheringState: 'complete', localDescription: null as RTCSessionDescriptionInit | null,
      getTransceivers: () => [receiver], setRemoteDescription: vi.fn(),
      createAnswer: () => ({ type: 'answer', sdp: 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=recvonly\r\n' }),
      async setLocalDescription(answer: RTCSessionDescriptionInit) { this.localDescription = answer },
    }
    const signal = vi.fn().mockResolvedValueOnce({ handle: 'my-subscription', sdp: 'audio-offer' }).mockResolvedValueOnce({})
    const onTrack = vi.fn()
    const pc = peer as unknown as RTCPeerConnection
    await subscribe(pc, 'screen-audio', onTrack, signal)
    pc.ontrack!.call(pc, { track } as RTCTrackEvent)
    expect(signal).toHaveBeenNthCalledWith(1, 'subscribe', { publication: 'screen-audio' })
    expect(peer.setRemoteDescription).toHaveBeenCalledWith({ type: 'offer', sdp: 'audio-offer' })
    expect(receiver.setCodecPreferences).toHaveBeenCalledWith([opus])
    expect(signal).toHaveBeenNthCalledWith(2, 'answer', { handle: 'my-subscription', sdp: expect.stringContaining('a=fmtp:111 stereo=1') })
    expect(onTrack).toHaveBeenCalledWith(track)
  } finally {
    vi.unstubAllGlobals()
  }
})
