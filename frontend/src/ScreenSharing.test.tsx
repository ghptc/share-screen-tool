import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ConnectionState, LocalVideoTrack, RoomEvent, Track, type Room } from 'livekit-client'
import ScreenSharing, { captureOptions } from './ScreenSharing'

class Raw extends EventTarget {
  readyState = 'live'
  kind = 'video'
  stop = vi.fn(() => { this.readyState = 'ended' })
  getSettings = () => ({ width: 1280, height: 720, frameRate: 30 })
  end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')) }
}
type VideoDouble = { mediaStreamTrack: Raw; source: Track.Source; streamState: Track.StreamState; stop: ReturnType<typeof vi.fn<() => void>>; attach: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn> }
type Publication = { trackSid: string; source: Track.Source; track?: VideoDouble; videoTrack?: VideoDouble; isMuted: boolean }
type Participant = { identity: string; name: string; videoTrackPublications: Map<string, Publication> }
const sdk = vi.hoisted(() => ({ failWrap: false }))
vi.mock('livekit-client', async importOriginal => {
  const actual = await importOriginal<typeof import('livekit-client')>()
  return { ...actual, LocalVideoTrack: class {
    source = actual.Track.Source.ScreenShare
    streamState = actual.Track.StreamState.Active
    mediaStreamTrack: Raw
    stop: ReturnType<typeof vi.fn<() => void>>
    attach = vi.fn()
    detach = vi.fn()
    constructor(raw: Raw) { if (sdk.failWrap) throw new Error('Video track initialization failed'); this.mediaStreamTrack = raw; this.stop = vi.fn(() => raw.stop()) }
  } }
})
class RoomDouble {
  state = ConnectionState.Connected
  remoteParticipants = new Map<string, Participant>()
  listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  localParticipant = {
    identity: 'alice', name: 'Alice', videoTrackPublications: new Map<string, Publication>(),
    publishTrack: vi.fn<(track: VideoDouble, options: unknown) => Promise<Publication>>(),
    unpublishTrack: vi.fn<(track: VideoDouble, stop?: boolean) => Promise<void>>(),
  }
  constructor() {
    this.localParticipant.publishTrack.mockImplementation(async track => {
      const pub = { trackSid: 'local-screen', source: Track.Source.ScreenShare, track, videoTrack: track, isMuted: false }
      this.localParticipant.videoTrackPublications.set(pub.trackSid, pub)
      track.mediaStreamTrack.addEventListener('ended', () => { void this.localParticipant.unpublishTrack(track, true) })
      this.emit(RoomEvent.LocalTrackPublished, pub)
      return pub
    })
    this.localParticipant.unpublishTrack.mockImplementation(async (track, stop) => {
      if (stop) track.stop()
      for (const pub of this.localParticipant.videoTrackPublications.values()) {
        if (pub.track !== track) continue
        this.localParticipant.videoTrackPublications.delete(pub.trackSid)
        this.emit(RoomEvent.LocalTrackUnpublished, pub)
        pub.track = undefined; pub.videoTrack = undefined
      }
    })
  }
  on(event: string, fn: (...args: never[]) => void) { if (!this.listeners.has(event)) this.listeners.set(event, new Set()); this.listeners.get(event)!.add(fn as (...args: unknown[]) => void); return this }
  off(event: string, fn: (...args: never[]) => void) { this.listeners.get(event)?.delete(fn as (...args: unknown[]) => void); return this }
  emit(event: string, ...args: unknown[]) { this.listeners.get(event)?.forEach(fn => fn(...args)) }
  addRemote(identity: string, sid: string) {
    const track = new LocalVideoTrack(new Raw() as unknown as MediaStreamTrack) as unknown as VideoDouble
    const publication = { trackSid: sid, source: Track.Source.ScreenShare, videoTrack: track, track, isMuted: false }
    const participant = { identity, name: identity, videoTrackPublications: new Map([[sid, publication]]) }
    this.remoteParticipants.set(identity, participant)
    return { participant, publication, track }
  }
}
let room: RoomDouble
let raw: Raw
let capture: ReturnType<typeof vi.fn>
function stream(track = raw) { return { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream }
function mount(canPublish = true) { return render(<ScreenSharing room={room as unknown as Room} canPublish={canPublish} />) }
async function start() { fireEvent.click(screen.getByRole('button', { name: 'Start sharing' })); await waitFor(() => expect(screen.getByRole('button', { name: 'Stop sharing' })).toBeEnabled()) }
beforeEach(() => {
  sdk.failWrap = false; room = new RoomDouble(); raw = new Raw()
  capture = vi.fn().mockResolvedValue(stream())
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia: capture } })
  vi.stubGlobal('isSecureContext', true)
})
afterEach(() => vi.unstubAllGlobals())

test('capture starts only on a click, requests video without audio, and stops', async () => {
  mount()
  expect(capture).not.toHaveBeenCalled()
  expect(screen.getByText(/No active screen streams/)).toBeInTheDocument()
  await start()
  expect(capture).toHaveBeenCalledExactlyOnceWith(captureOptions)
  expect(captureOptions.audio).toBe(false)
  expect(room.localParticipant.publishTrack.mock.calls[0][1]).toMatchObject({ source: Track.Source.ScreenShare })
  expect(screen.getByText(/1280 × 720, 30 FPS/)).toBeInTheDocument()
  expect(screen.getByRole('article', { name: 'Alice screen (you)' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }))
  await waitFor(() => expect(screen.getByText(/No active screen streams/)).toBeInTheDocument())
  expect(raw.stop).toHaveBeenCalled()
  expect(room.localParticipant.unpublishTrack).toHaveBeenCalled()
})

test('viewers cannot start capture and permission rejection is recoverable', async () => {
  const { unmount } = mount(false)
  expect(screen.queryByRole('button', { name: 'Start sharing' })).not.toBeInTheDocument()
  expect(capture).not.toHaveBeenCalled(); unmount()
  capture.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'))
  mount(); fireEvent.click(screen.getByRole('button', { name: 'Start sharing' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('denied or cancelled')
  expect(room.localParticipant.publishTrack).not.toHaveBeenCalled()
  await start()
})

test('renders simultaneous publishers without replacing or duplicating video elements', async () => {
  const bob = room.addRemote('Bob', 'bob-screen')
  room.addRemote('Carol', 'carol-screen')
  const { unmount } = mount()
  expect(screen.getAllByRole('article')).toHaveLength(2)
  await start()
  expect(screen.getAllByRole('article')).toHaveLength(3)
  act(() => { room.emit(RoomEvent.TrackPublished); room.emit(RoomEvent.TrackSubscribed); room.emit(RoomEvent.TrackSubscribed) })
  expect(screen.getAllByRole('article')).toHaveLength(3)
  expect(bob.track.attach).toHaveBeenCalledTimes(1)
  const element = bob.track.attach.mock.calls[0][0]
  act(() => { room.remoteParticipants.delete('Bob'); room.emit(RoomEvent.ParticipantDisconnected) })
  expect(screen.getAllByRole('article')).toHaveLength(2)
  expect(bob.track.detach).toHaveBeenCalledWith(element)
  expect(bob.track.stop).not.toHaveBeenCalled()
  unmount()
  expect(raw.stop).toHaveBeenCalled()
})

test('handles remote subscription changes, mute, and unpublication', () => {
  const bob = room.addRemote('Bob', 'bob-screen'); mount()
  act(() => { bob.publication.isMuted = true; room.emit(RoomEvent.TrackMuted) })
  expect(screen.getByText('Muted')).toBeInTheDocument()
  act(() => { bob.publication.videoTrack = undefined as unknown as VideoDouble; room.emit(RoomEvent.TrackUnsubscribed) })
  expect(bob.track.detach).toHaveBeenCalledTimes(1)
  expect(screen.getByText('Waiting for video')).toBeInTheDocument()
  act(() => { bob.participant.videoTrackPublications.clear(); room.emit(RoomEvent.TrackUnpublished) })
  expect(screen.queryByRole('article')).not.toBeInTheDocument()
})

test('browser native ending clears the local stream and permits a new share', async () => {
  mount(); await start()
  act(() => raw.end())
  await waitFor(() => expect(screen.queryByRole('article')).not.toBeInTheDocument())
  expect(screen.getByRole('button', { name: 'Start sharing' })).toBeEnabled()
  raw = new Raw(); capture.mockResolvedValue(stream()); await start()
  expect(screen.getAllByRole('article')).toHaveLength(1)
})

test('reconnection resynchronizes streams without requesting capture again', async () => {
  room.addRemote('Bob', 'bob-screen'); mount(); await start()
  act(() => { room.state = ConnectionState.Reconnecting; room.emit(RoomEvent.ConnectionStateChanged, room.state) })
  expect(screen.getAllByText('Reconnecting')).toHaveLength(2)
  expect(screen.getByRole('button', { name: 'Start sharing' })).toBeDisabled()
  act(() => { room.state = ConnectionState.Connected; room.emit(RoomEvent.ConnectionStateChanged, room.state); room.emit(RoomEvent.Reconnected) })
  expect(screen.getAllByText('Streaming')).toHaveLength(2)
  expect(capture).toHaveBeenCalledTimes(1)
  expect(raw.stop).not.toHaveBeenCalled()
})

test('late browser permission result after unmount is stopped without publication', async () => {
  let resolve!: (stream: MediaStream) => void
  capture.mockImplementation(() => new Promise<MediaStream>(r => { resolve = r }))
  const { unmount } = mount()
  fireEvent.click(screen.getByRole('button', { name: 'Start sharing' })); unmount()
  await act(async () => resolve(stream()))
  expect(raw.stop).toHaveBeenCalled()
  expect(room.localParticipant.publishTrack).not.toHaveBeenCalled()
})

test('duplicate clicks and cancellation do not leave a pending capture', async () => {
  let resolve!: (stream: MediaStream) => void
  capture.mockImplementation(() => new Promise<MediaStream>(r => { resolve = r }))
  mount()
  const button = screen.getByRole('button', { name: 'Start sharing' })
  fireEvent.click(button); fireEvent.click(button)
  expect(capture).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel sharing request' }))
  await act(async () => resolve(stream()))
  expect(raw.stop).toHaveBeenCalled()
  expect(room.localParticipant.publishTrack).not.toHaveBeenCalled()
})

test('publish failure stops capture and fullscreen uses the selected tile', async () => {
  room.localParticipant.publishTrack.mockRejectedValueOnce(new Error('SFU rejected screen publication'))
  const bob = room.addRemote('Bob', 'bob-screen')
  const { unmount } = mount()
  const tile = screen.getByRole('article', { name: 'Bob screen' })
  const fullscreen = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(tile, 'requestFullscreen', { value: fullscreen })
  fireEvent.click(screen.getByRole('button', { name: 'Fullscreen Bob' }))
  await waitFor(() => expect(fullscreen).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button', { name: 'Start sharing' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('SFU rejected')
  expect(raw.stop).toHaveBeenCalled()
  unmount(); expect(bob.track.detach).toHaveBeenCalledTimes(1)
})

test('late publication after leaving is unpublished and stopped', async () => {
  let resolve!: () => void
  const original = room.localParticipant.publishTrack.getMockImplementation()!
  room.localParticipant.publishTrack.mockImplementation(async (track, options) => {
    await new Promise<void>(r => { resolve = r })
    return original(track, options)
  })
  const { unmount } = mount()
  fireEvent.click(screen.getByRole('button', { name: 'Start sharing' }))
  await waitFor(() => expect(room.localParticipant.publishTrack).toHaveBeenCalledOnce())
  unmount()
  await act(async () => resolve())
  expect(raw.stop).toHaveBeenCalled()
  expect(room.localParticipant.videoTrackPublications.size).toBe(0)
})


test('cancelling a pending publication immediately stops local capture', async () => {
  let resolve!: () => void
  const original = room.localParticipant.publishTrack.getMockImplementation()!
  room.localParticipant.publishTrack.mockImplementation(async (track, options) => {
    await new Promise<void>(r => { resolve = r })
    return original(track, options)
  })
  mount(); fireEvent.click(screen.getByRole('button', { name: 'Start sharing' }))
  await waitFor(() => expect(room.localParticipant.publishTrack).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button', { name: 'Cancel sharing request' }))
  expect(raw.stop).toHaveBeenCalled()
  await act(async () => resolve())
  expect(room.localParticipant.videoTrackPublications.size).toBe(0)
})

test('replaces a recovered remote track without keeping the previous element attached', () => {
  const bob = room.addRemote('Bob', 'bob-screen'); mount()
  const replacement = new LocalVideoTrack(new Raw() as unknown as MediaStreamTrack) as unknown as VideoDouble
  act(() => { bob.publication.videoTrack = replacement; room.emit(RoomEvent.TrackSubscribed) })
  expect(bob.track.detach).toHaveBeenCalledOnce()
  expect(replacement.attach).toHaveBeenCalledOnce()
  expect(screen.getAllByRole('article')).toHaveLength(1)
})


test('full SDK republishing preserves the existing capture across temporary unpublication', async () => {
  mount(); await start()
  const track = room.localParticipant.publishTrack.mock.calls[0][0]
  await act(async () => {
    room.state = ConnectionState.Reconnecting
    room.emit(RoomEvent.ConnectionStateChanged, room.state)
    await room.localParticipant.unpublishTrack(track, false)
  })
  expect(raw.stop).not.toHaveBeenCalled()
  expect(screen.queryByRole('article')).not.toBeInTheDocument()
  await act(async () => {
    await room.localParticipant.publishTrack(track, {})
    room.state = ConnectionState.Connected
    room.emit(RoomEvent.ConnectionStateChanged, room.state)
    room.emit(RoomEvent.Reconnected)
  })
  expect(screen.getAllByRole('article')).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Stop sharing' })).toBeEnabled()
  expect(capture).toHaveBeenCalledTimes(1)
  expect(raw.stop).not.toHaveBeenCalled()
})


test('a capture is released even if SDK track initialization fails', async () => {
  sdk.failWrap = true
  mount(); fireEvent.click(screen.getByRole('button', { name: 'Start sharing' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('initialization failed')
  expect(raw.stop).toHaveBeenCalled()
  expect(room.localParticipant.publishTrack).not.toHaveBeenCalled()
})


test('distinguishes visibility adaptation from SFU congestion pauses', () => {
  const bob = room.addRemote('Bob', 'bob-screen')
  let update!: () => void
  const publication = Object.assign(bob.publication, { isEnabled: false, on: (_name: string, fn: () => void) => { update = fn }, off: vi.fn() })
  mount()
  expect(screen.getByText('Adaptive pause')).toBeInTheDocument()
  act(() => { publication.isEnabled = true; update() })
  expect(screen.getByText('Streaming')).toBeInTheDocument()
})


test('native capture end cleans up even if the SDK does not forward its ended event', async () => {
  room.localParticipant.publishTrack.mockImplementation(async track => {
    const pub = { trackSid: 'screen', source: Track.Source.ScreenShare, track, videoTrack: track, isMuted: false }
    room.localParticipant.videoTrackPublications.set(pub.trackSid, pub)
    room.emit(RoomEvent.LocalTrackPublished, pub)
    return pub
  })
  mount(); await start()
  await act(async () => raw.end())
  await waitFor(() => expect(screen.queryByRole('article')).not.toBeInTheDocument())
  expect(raw.stop).toHaveBeenCalled()
  expect(room.localParticipant.unpublishTrack).toHaveBeenCalled()
})
