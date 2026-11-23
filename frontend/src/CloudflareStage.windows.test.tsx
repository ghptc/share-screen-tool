import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import CloudflareStage from './CloudflareStage'

const opus = { mimeType: 'audio/opus', clockRate: 48000, channels: 2 }

function publisher(surface: string, returnsAudio: boolean, audioStatus = 200) {
  const video = { kind: 'video', readyState: 'live', getSettings: () => ({ displaySurface: surface }), stop: vi.fn() }
  const audio = { kind: 'audio', readyState: 'live', stop: vi.fn(), onended: () => {} }
  const capture = vi.fn().mockResolvedValue({
    getVideoTracks: () => [video], getAudioTracks: () => returnsAudio ? [audio] : [],
    getTracks: () => returnsAudio ? [video, audio] : [video],
  })
  const microphone = vi.fn()
  vi.stubGlobal('navigator', Object.create(navigator, {
    platform: { value: 'Win32' }, mediaDevices: { value: { getDisplayMedia: capture, getUserMedia: microphone } },
  }))
  vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs: [opus, { mimeType: 'audio/PCMU' }] }) })
  const peers: Peer[] = []
  class Peer extends EventTarget {
    track?: MediaStreamTrack
    mid = '0'
    connectionState = 'new'
    iceGatheringState = 'complete'
    localDescription?: RTCSessionDescriptionInit
    onconnectionstatechange = () => {}
    setCodecPreferences = vi.fn()
    constructor() { super(); peers.push(this) }
    addTransceiver(track: MediaStreamTrack) { this.track = track; return this }
    getSenders() { return [] }
    async createOffer() {
      return { type: 'offer', sdp: 'm=' + this.track!.kind + ' 9 UDP/TLS/RTP/SAVPF 111\r\na=candidate:test 1 UDP 1 local.test 5000 typ host\r\n' }
    }
    async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description }
    async setRemoteDescription() {}
    close = vi.fn()
    connect() { this.connectionState = 'connected'; this.onconnectionstatechange() }
  }
  vi.stubGlobal('RTCPeerConnection', Peer)
  let replyToState!: (snapshot: Response) => void
  const requests: { op: string; screen?: string; handle?: string; sdp?: string }[] = []
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    const op = path.split('/').pop()!
    const input = JSON.parse(String(init.body))
    requests.push({ op, ...input })
    switch (op) {
      case 'state': return new Promise<Response>(resolve => { replyToState = resolve })
      case 'publish':
        if (input.screen && audioStatus !== 200) return new Response(null, { status: audioStatus })
        return Response.json({ handle: input.screen ? 'display-sound' : 'video', sdp: 'answer' })
      case 'ready':
      case 'close': return Response.json({})
      default: throw new Error('Unexpected request: ' + path)
    }
  })
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  render(<CloudflareStage channel="room" canPublish identity="publisher" control="" onDenied={vi.fn()} onExpired={vi.fn()} />)
  const consent = screen.getByRole('checkbox', { name: 'Share audio' })
  expect(consent).not.toBeChecked()
  expect(capture).not.toHaveBeenCalled()
  const start = async (withAudio: boolean) => {
    if (withAudio) {
      fireEvent.click(consent)
      expect(screen.getByText(/system audio can include other apps/i)).toBeVisible()
    }
    fireEvent.click(screen.getByRole('button', { name: 'Share my screen' }))
    await screen.findByRole('button', { name: 'Stop sharing' })
    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture).toHaveBeenCalledWith(expect.objectContaining(withAudio
      ? { audio: true, systemAudio: 'include', windowAudio: 'window' } : { audio: false }))
    expect(microphone).not.toHaveBeenCalled()
  }
  const finishInitialPoll = () => act(async () => {
    replyToState(Response.json({ publications: [], audio: {}, owned: [] }))
  })
  return { start, peers, audio, video, consent, requests, finishInitialPoll }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it.each([
  ['browser', /enable tab audio/i], ['window', /no window audio/i], ['monitor', /enable system audio for Entire Screen/i],
])('explains a video-only %s selection', async (surface, explanation) => {
  const p = publisher(String(surface), false)
  await p.start(true)
  await act(async () => p.peers[0].connect())
  expect(screen.getByRole('status')).toHaveTextContent(explanation)
  expect(p.peers).toHaveLength(1)
  expect(p.requests.filter(r => r.op === 'publish')).toHaveLength(1)
})

it('stops an unexpected audio track when consent was off', async () => {
  const p = publisher('monitor', true)
  await p.start(false)
  await act(async () => p.peers[0].connect())
  expect(p.audio.stop).toHaveBeenCalled()
  expect(p.peers).toHaveLength(1)
})

it.each([
  ['browser', 'Sharing tab audio.'], ['monitor', 'Sharing system audio, including sounds from other apps.'],
  ['window', 'Sharing picker audio. If you selected system audio, other apps are included.'],
])('publishes consented %s audio once the owned video is ready', async (surface, status) => {
  const p = publisher(surface, true)
  await p.start(true)
  expect(p.peers).toHaveLength(1)
  await act(async () => p.peers[0].connect())
  expect(p.peers[1].track).toBe(p.audio)
  expect(p.peers[1].setCodecPreferences).toHaveBeenCalledWith([opus])
  expect(p.requests.filter(r => r.op === 'publish').map(r => r.screen)).toEqual([undefined, 'video'])
  expect(p.requests.filter(r => r.op === 'ready').map(r => r.handle)).toEqual(['video'])
  await act(async () => p.peers[1].connect())
  expect(p.requests.filter(r => r.op === 'ready').map(r => r.handle)).toEqual(['video', 'display-sound'])
  await p.finishInitialPoll() // This state request started before either sender had a handle.
  expect(p.peers[1].close).not.toHaveBeenCalled()
  expect(screen.getByRole('status')).toHaveTextContent(status)
  fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }))
  expect(p.audio.stop).toHaveBeenCalled()
  expect(p.video.stop).toHaveBeenCalled()
  expect(p.requests.filter(r => r.op === 'close').map(r => r.handle).sort()).toEqual(['display-sound', 'video'])
  expect(p.consent).not.toBeChecked()
})

it('continues sharing video when audio negotiation fails', async () => {
  const p = publisher('window', true, 502)
  await p.start(true)
  await act(async () => p.peers[0].connect())
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/video only.*could not connect/i))
  expect(p.audio.stop).toHaveBeenCalled()
  expect(p.video.stop).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Stop sharing' })).toBeEnabled()
})

it('releases pending picker audio when the screen stops before becoming ready', async () => {
  const p = publisher('browser', true)
  await p.start(true)
  fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }))
  await act(async () => p.peers[0].connect())
  expect(p.audio.stop).toHaveBeenCalled()
  expect(p.peers).toHaveLength(1)
})

it('withdraws only audio when Chrome ends its audio track', async () => {
  const p = publisher('browser', true)
  await p.start(true)
  await act(async () => p.peers[0].connect())
  await act(async () => p.peers[1].connect())
  act(() => { p.audio.readyState = 'ended'; p.audio.onended() })
  expect(p.requests.filter(r => r.op === 'close').map(r => r.handle)).toEqual(['display-sound'])
  expect(screen.getByRole('status')).toHaveTextContent(/browser stopped sharing audio/i)
  expect(p.video.stop).not.toHaveBeenCalled()
})
