import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import App from './App'

class Track {
  readonly kind: string
  readyState = 'live'
  onended?: () => void
  constructor(readonly id: string) { this.kind = id.startsWith('audio-') ? 'audio' : 'video' }
  stop() { this.readyState = 'ended' }
  end() { this.stop(); this.onended?.() }
}

class Peer {
  iceGatheringState = 'complete'
  connectionState = 'new'
  localDescription?: RTCSessionDescriptionInit
  track!: Track
  ontrack?: (event: { track: Track }) => void
  onconnectionstatechange?: () => void
  async setRemoteDescription(offer: RTCSessionDescriptionInit) {
    this.track = new Track(offer.sdp!)
    this.ontrack?.({ track: this.track })
  }
  getTransceivers() { return [{ receiver: { track: this.track }, setCodecPreferences() {} }] }
  async createAnswer() {
    return { type: 'answer', sdp: this.track.kind === 'audio' ? 'a=rtpmap:111 opus/48000/2\r\n' : 'video answer' }
  }
  async setLocalDescription(answer: RTCSessionDescriptionInit) {
    this.localDescription = answer
    this.connectionState = 'connected'
    this.onconnectionstatechange?.()
  }
  close() { this.connectionState = 'closed' }
}

class Stream {
  constructor(private tracks: Track[]) {}
  getTracks() { return this.tracks }
}

type Member = { name: string; screen?: string; audio?: string }
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
const videos = () => [...document.querySelectorAll('video')].map(el => (el.srcObject as unknown as Stream).getTracks()[0])

async function enterRoom() {
  vi.useFakeTimers()
  vi.stubGlobal('RTCPeerConnection', Peer)
  vi.stubGlobal('MediaStream', Stream)
  vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => ({ codecs: [{ mimeType: 'audio/opus' }] }) })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  const join = vi.fn(() => Response.json({ transport: 'cloudflare-prototype', identity: 'viewer',
    canPublish: false, serverTime: new Date(), expiresAt: new Date(Date.now() + 36_000_000) }))
  const owned = new Set<string>()
  let allocation = 0
  const subscribe = vi.fn(async (publication: string) => {
    const handle = 'receiver-' + ++allocation
    owned.add(handle)
    return Response.json({ handle, sdp: publication })
  })
  const answer = vi.fn((handle: string) => {
    expect(owned.has(handle)).toBe(true)
    return Response.json({})
  })
  let pending: ((response: Response) => void) | undefined
  let version: string | undefined
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    const input = JSON.parse(String(init.body))
    switch (path.split('/').pop()) {
      case 'join': return join()
      case 'state':
        expect(input.version).toBe(version)
        expect(input.idleWait).toBe(true)
        expect(pending).toBeUndefined()
        return new Promise<Response>(resolve => { pending = resolve })
      case 'subscribe': return subscribe(input.publication)
      case 'answer': return answer(input.handle)
      case 'close': owned.delete(input.handle); return Response.json({})
      default: throw new Error('Unexpected request: ' + path)
    }
  })
  history.replaceState(null, '', '/r/' + 'a'.repeat(32))
  render(<App />)
  await advance(0)
  async function state(nextVersion: string, ...members: Member[]) {
    expect(pending).toBeDefined()
    version = nextVersion
    const screens = members.filter(m => m.screen)
    await act(async () => {
      pending!(Response.json({ version, owned: [...owned],
        participants: members.map(m => ({ key: m.name, name: m.name, sharing: !!m.screen })),
        publications: screens.map(m => m.screen),
        publishers: Object.fromEntries(screens.map(m => [m.screen, m.name])),
        audio: Object.fromEntries(screens.filter(m => m.audio).map(m => [m.screen, m.audio])),
      }))
      pending = undefined
    })
    await advance(1)
    expect(pending).toBeDefined()
    expect(join).toHaveBeenCalledTimes(1)
  }
  return { state, subscribe, answer, owned, join }
}

afterEach(() => {
  cleanup()
  history.replaceState(null, '', '/')
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it.each(['subscribe', 'answer'])('recovers from a failed %s after a later join while the next state poll waits', async phase => {
  const room = await enterRoom()
  await room.state('empty')
  await room.state('joined', { name: 'Bob' })
  expect(screen.getByText('Bob').closest('li')).toHaveTextContent('Watching')
  expect(room.subscribe).not.toHaveBeenCalled()
  const unavailable = new Response(null, { status: 502 })
  if (phase === 'subscribe') room.subscribe.mockResolvedValueOnce(unavailable)
  else room.answer.mockReturnValueOnce(unavailable)
  await room.state('ready', { name: 'Bob', screen: 'bob' })
  expect(screen.getByText('Bob').closest('li')).toHaveTextContent('Sharing')
  expect(videos()).toHaveLength(0)
  expect(room.owned.size).toBe(0)
  await advance(2500) // No further state reply or user action.
  expect(videos().map(t => t.id)).toEqual(['bob'])
  expect(room.subscribe.mock.calls).toEqual([['bob'], ['bob']])
  expect(room.answer).toHaveBeenCalledTimes(phase === 'answer' ? 2 : 1)
  expect(room.join).toHaveBeenCalledTimes(1)
})

it('keeps one retry per advertised handle across polls and drops it when the room closes', async () => {
  const room = await enterRoom()
  const bob = { name: 'Bob', screen: 'b' }
  room.subscribe.mockImplementation(async () => new Response(null, { status: 502 }))
  await room.state('ready', bob)
  await room.state('new-participant', bob, { name: 'Alice' })
  expect(room.subscribe).toHaveBeenCalledTimes(1)
  await advance(1000)
  expect(room.subscribe).toHaveBeenCalledTimes(2)
  await advance(1500)
  expect(room.subscribe).toHaveBeenCalledTimes(2)
  act(() => window.dispatchEvent(new Event('pagehide')))
  await advance(60000)
  expect(room.subscribe).toHaveBeenCalledTimes(2)
})

it('keeps the first publisher and its audio while a second starts, stops, replaces and rejoins', async () => {
  const room = await enterRoom()
  const alice = { name: 'Alice', screen: 'a1', audio: 'audio-a1' }
  const bob = { name: 'Bob', screen: 'b1', audio: 'audio-b1' }
  await room.state('already-sharing', alice)
  const [first] = videos()
  expect(first.id).toBe('a1')
  fireEvent.click(screen.getByRole('button', { name: 'Audio' }))
  const audio = (name: string) => screen.getByLabelText<HTMLAudioElement>(name + ' audio playback')
  const volume = (name: string, value: string) => fireEvent.change(screen.getByLabelText(name + ' audio volume'), { target: { value } })
  const firstAudio = audio('Alice')
  volume('Alice', '19')
  await room.state('joined', alice, { name: 'Bob' })
  await room.state('both', alice, bob)
  expect(videos().map(t => t.id)).toEqual(['a1', 'b1'])
  volume('Bob', '67')
  const old = videos()[1]
  await room.state('replaced', alice, { ...bob, screen: 'b2', audio: 'audio-b2' })
  expect(old.readyState).toBe('ended')
  expect(videos().map(t => t.id)).toEqual(['a1', 'b2'])
  expect(audio('Bob').volume).toBe(.67)
  await room.state('left', alice)
  expect(videos()).toEqual([first])
  expect(screen.queryByText('Bob')).toBeNull()
  await room.state('rejoined', alice, { ...bob, screen: 'b3', audio: 'audio-b3' })
  expect(videos().map(t => t.id)).toEqual(['a1', 'b3'])
  expect(videos()[0]).toBe(first)
  expect(audio('Alice')).toBe(firstAudio)
  expect(firstAudio.volume).toBe(.19)
  expect(audio('Bob').volume).toBe(.67)
  expect(room.owned.size).toBe(4)
  expect(room.answer).toHaveBeenCalledTimes(8)
  await room.state('stopped', alice, { name: 'Bob' })
  expect(videos()).toEqual([first])
  expect(screen.queryByLabelText('Bob audio playback')).toBeNull()
  expect(room.owned.size).toBe(2)
})

it('recovers an ended receiver with the same advertised handle and cancels recovery on withdrawal', async () => {
  const room = await enterRoom()
  const bob = { name: 'Bob', screen: 'b' }
  await room.state('ready', bob)
  const [old] = videos()
  act(() => old.end())
  await advance(2500)
  const [replacement] = videos()
  expect(replacement).not.toBe(old)
  expect(replacement.id).toBe('b')
  act(() => replacement.end())
  await room.state('stopped', { name: 'Bob' })
  await advance(60000)
  expect(videos()).toHaveLength(0)
  expect(room.owned.size).toBe(0)
  expect(room.subscribe).toHaveBeenCalledTimes(2)
})

it('replaces a receiver that answered but never connected', async () => {
  const room = await enterRoom()
  vi.spyOn(Peer.prototype, 'setLocalDescription').mockImplementationOnce(async function (this: Peer, answer) {
    this.localDescription = answer
  })
  await room.state('ready', { name: 'Bob', screen: 'b' })
  const [stalled] = videos()
  await advance(13000)
  expect(stalled.readyState).toBe('ended')
  expect(videos()[0].id).toBe('b')
  expect(room.owned.size).toBe(1)
  expect(room.answer).toHaveBeenCalledTimes(2)
  expect(room.join).toHaveBeenCalledTimes(1)
})

it('closes a late allocation after replacement without answering it or disturbing the new screen', async () => {
  const room = await enterRoom()
  let finish!: (reply: Response) => void
  room.subscribe.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await room.state('old', { name: 'Bob', screen: 'old' })
  await room.state('new', { name: 'Bob', screen: 'new' })
  room.owned.add('late')
  await act(async () => finish(Response.json({ handle: 'late', sdp: 'old' })))
  expect(room.owned.has('late')).toBe(false)
  expect(room.answer).toHaveBeenCalledTimes(1)
  expect(videos().map(t => t.id)).toEqual(['new'])
})
