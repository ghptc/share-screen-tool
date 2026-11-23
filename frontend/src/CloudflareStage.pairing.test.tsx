// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://screen-share-player.gabrielhpittacosta.workers.dev/"}
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import CloudflareStage from './CloudflareStage'
import PlayerStage from './PlayerStage'
import { publish, subscribe } from './cloudflarePeer'

vi.mock('./cloudflarePeer', async (original) => ({
  ...await original<typeof import('./cloudflarePeer')>(), publish: vi.fn(), subscribe: vi.fn(),
}))

class FakePeer {
  connectionState = 'new'
  close() {}
  getSenders() { return [] }
}

afterEach(() => {
  cleanup()
  localStorage.removeItem('whiterun.gameAudio.enabled')
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  vi.clearAllMocks()
})

const desktop = 'https://127.0.0.1:18495'

it('offers the same Linux chooser in a hosted LiveKit room with an owned screen', async () => {
  vi.stubEnv('VITE_NATIVE_AUDIO_MODE', 'pair')
  vi.stubGlobal('navigator', { platform: 'Linux x86_64', userAgent: 'Firefox' })
  const fetch = vi.fn().mockResolvedValue(Response.json([{ id: '9:103', name: 'Game', detail: '' }]))
  vi.stubGlobal('fetch', fetch)
  render(<PlayerStage screens={[]} peers={[]} connected sharing busy="" screen="owned-screen" control="owner"
    canPublish error="" quality={{ height: 0, fps: 60 }} qualityBusy={false} changeQuality={vi.fn()}
    start={vi.fn()} stop={vi.fn()} />)
  expect(fetch).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Audio' }))
  await screen.findByRole('option', { name: 'Game' })
  expect(screen.getByRole('button', { name: 'Share application audio' })).toBeDisabled()
  expect(fetch.mock.calls.map(([path]) => path)).toEqual([desktop + '/sources'])
})

function publisher(mode: string, available: boolean) {
  vi.stubEnv('VITE_NATIVE_AUDIO_MODE', mode)
  vi.stubGlobal('RTCPeerConnection', FakePeer)
  const track = { kind: 'video', stop: vi.fn() }
  const getDisplayMedia = vi.fn().mockResolvedValue({ getVideoTracks: () => [track], getTracks: () => [track] })
  vi.stubGlobal('navigator', { platform: 'Linux x86_64', mediaDevices: { getDisplayMedia } })
  vi.mocked(publish).mockImplementation(async (peer, _track, signal) => {
    const publication = await signal('publish', {})
    Object.assign(peer, { connectionState: 'connected' })
    peer.onconnectionstatechange?.call(peer, new Event('connectionstatechange'))
    return publication.handle
  })
  let watch!: ReadableStreamDefaultController<Uint8Array>
  let acknowledge!: (response: Response) => void
  const paths: string[] = []
  const fetch = vi.fn(async (path: string, options: RequestInit) => {
    paths.push(path)
    switch (path) {
      case desktop + '/sources': return available
        ? Response.json([{ id: '9:103', name: 'Game', detail: '', idle: true }])
        : new Response(null, { status: 403 })
      case desktop + '/start': return new Promise<Response>(resolve => { acknowledge = resolve })
      case '/api/discord/test/media/state': return new Promise<Response>(() => {})
      case '/api/discord/test/media/publish': return Response.json({ handle: 'owned-screen' })
      case '/api/native-audio/sessions': return Response.json({ session: 'helper', code: 'fixture' })
      case '/api/native-audio/helper/watch':
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          watch = controller
          options.signal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true })
        } }))
      case '/api/discord/test/media/ready':
      case '/api/discord/test/media/close':
      case '/api/native-audio/helper/stop': return Response.json({})
      default: return new Response(null, { status: 404 })
    }
  })
  vi.stubGlobal('fetch', fetch)
  render(<CloudflareStage canPublish channel="test" identity="publisher" control="owner" onExpired={vi.fn()} onDenied={vi.fn()} />)
  return { fetch, paths, getDisplayMedia, watch: () => watch, started: (started = true) => acknowledge(Response.json({ started })) }
}

it.each([
  { mode: 'pair', end: 'watch loss' },
  { mode: 'pair', end: 'audio disabled' },
  { mode: '', end: 'screen stopped' },
])('supports manual fallback and handles $end (mode "$mode")', async ({ mode, end }) => {
  const { fetch, paths, getDisplayMedia, watch } = publisher(mode, false)
  fireEvent.click(screen.getByRole('button', { name: 'Audio' }))
  expect(screen.queryByText('Pair native audio helper')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Share my screen' }))
  await screen.findByText(/Desktop launcher unavailable/)
  fireEvent.click(screen.getByRole('button', { name: 'Pair manually' }))
  const pair = await screen.findByRole('button', { name: 'Pair native audio helper' })
  expect(getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: false }))
  expect(paths).not.toContain('/api/native-audio/sessions')
  fireEvent.click(pair)
  await waitFor(() => expect(watch()).toBeDefined())
  expect(fetch).toHaveBeenCalledWith('/api/native-audio/sessions', expect.objectContaining({
    headers: expect.objectContaining({ Authorization: 'Bearer owner' }), body: JSON.stringify({ screen: 'owned-screen' }),
  }))
  expect(screen.queryByLabelText('One-time native audio pairing JSON')).toBeNull()
  await act(async () => watch().enqueue(new TextEncoder().encode('active\n')))
  const input = screen.getByLabelText<HTMLInputElement>('One-time native audio pairing JSON')
  expect(JSON.parse(input.value).apiUrl).toBe(location.origin + '/api')
  fireEvent.click(screen.getByRole('button', { name: 'Audio' }))
  expect(paths).not.toContain('/api/native-audio/helper/stop')
  if (end === 'audio disabled') fireEvent.click(screen.getByRole('checkbox', { name: 'Share audio' }))
  if (end === 'screen stopped') fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }))
  if (end !== 'watch loss') {
    expect(fetch).toHaveBeenCalledWith('/api/native-audio/helper/stop', expect.objectContaining({ keepalive: true }))
  }
  if (end === 'watch loss') await act(async () => watch().close())
  fireEvent.click(screen.getByRole('button', { name: 'Audio' }))
  expect(screen.queryByLabelText('One-time native audio pairing JSON')).toBeNull()
  if (end === 'watch loss') expect(screen.getByRole('alert')).toHaveTextContent('Native audio session ended')
  expect(paths.filter(path => path.startsWith('/player/'))).toEqual([])
  expect(paths).not.toContain(desktop + '/start')
})

it.each(['user stop', 'screen ended', 'audio disabled', 'authorization lost', 'page hidden', 'stop during startup', 'missing acknowledgement'])('automatically pairs only the consented app and revokes on %s', async end => {
  const p = publisher('pair', true)
  fireEvent.click(screen.getByRole('button', { name: 'Share my screen' }))
  fireEvent.click(screen.getByRole('button', { name: 'Audio' }))
  await screen.findByRole('option', { name: 'Game (idle)' })
  const start = screen.getByRole('button', { name: 'Share application audio' })
  expect(start).toBeDisabled()
  fireEvent.change(screen.getByRole('combobox', { name: 'Application audio' }), { target: { value: '9:103' } })
  expect(p.paths).not.toContain('/api/native-audio/sessions')
  fireEvent.click(start)
  expect(screen.getByText('Connecting…')).toBeVisible()
  await waitFor(() => expect(p.watch()).toBeDefined())
  expect(p.paths).not.toContain(desktop + '/start')
  const phase = (value: string) => act(async () => p.watch().enqueue(new TextEncoder().encode(value)))
  await phase('act')
  expect(p.paths).not.toContain(desktop + '/start')
  await phase('ive\nwai')
  await waitFor(() => expect(p.fetch).toHaveBeenCalledWith(desktop + '/start', expect.objectContaining({
    body: JSON.stringify({ source: '9:103', code: 'fixture' }),
    headers: { 'Content-Type': 'application/json' }, credentials: 'include', redirect: 'error',
  })))
  await phase('ting\n')
  expect(screen.getByText(/30-second startup limit/)).toBeVisible()
  await phase('sharing\n')
  expect(screen.queryByText('Sharing audio')).toBeNull()
  expect(screen.queryByLabelText('One-time native audio pairing JSON')).toBeNull()
  if (end === 'stop during startup') fireEvent.click(screen.getByRole('button', { name: 'Stop sharing audio' }))
  await act(async () => p.started(end !== 'missing acknowledgement'))
  if (end === 'stop during startup' || end === 'missing acknowledgement') {
    expect(await screen.findByText(/^Stopped/)).toBeVisible()
    expect(screen.queryByText('Sharing audio')).toBeNull()
  } else {
    expect(screen.getByText('Sharing audio')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Audio' }))
    expect(p.paths).not.toContain('/api/native-audio/helper/stop')
    fireEvent.click(screen.getByRole('button', { name: 'Audio' }))
  }
  if (end === 'page hidden') {
    act(() => { window.dispatchEvent(new Event('pagehide')) })
    expect(screen.queryByRole('button', { name: 'Share application audio' })).toBeNull()
  }
  if (end === 'authorization lost') await act(async () => p.watch().close())
  if (end === 'user stop') fireEvent.click(screen.getByRole('button', { name: 'Stop sharing audio' }))
  if (end === 'screen ended') fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }))
  if (end === 'audio disabled') fireEvent.click(screen.getByRole('checkbox', { name: 'Share audio' }))
  await waitFor(() => expect(p.fetch).toHaveBeenCalledWith('/api/native-audio/helper/stop', expect.objectContaining({
    keepalive: true, headers: expect.objectContaining({ Authorization: 'Bearer owner' }),
  })))
  if (end === 'authorization lost' || end === 'user stop') expect(await screen.findByText(/^Stopped/)).toBeVisible()
  expect(p.paths.filter(path => path === desktop + '/start')).toHaveLength(1)
})

it('offers a user gesture after remote autoplay denial without pairing a viewer', async () => {
  vi.stubGlobal('RTCPeerConnection', FakePeer)
  vi.stubGlobal('MediaStream', class { getTracks() { return [] } })
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play')
    .mockRejectedValueOnce(new DOMException('Blocked', 'NotAllowedError')).mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.mocked(subscribe).mockImplementation(async (_peer, publication, received) => {
    received({ kind: publication === 'game' ? 'audio' : 'video' } as MediaStreamTrack)
    return publication
  })
  const paths: string[] = []
  vi.stubGlobal('fetch', async (path: string) => {
    paths.push(path)
    return Response.json({ publications: ['screen'], audio: { screen: 'game' }, owned: [] })
  })
  render(<CloudflareStage canPublish={false} channel="test" identity="viewer" control="viewer" onExpired={vi.fn()} onDenied={vi.fn()} />)
  const enable = await screen.findByRole('button', { name: 'Enable audio' })
  expect(play).toHaveBeenCalledTimes(1)
  fireEvent.click(enable)
  expect(play).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole('button', { name: 'Audio' }))
  expect(screen.queryByRole('button', { name: 'Pair native audio helper' })).toBeNull()
  expect(paths).toEqual(['/api/discord/test/media/state'])
})

it('keeps the local mix per publisher through focus, ended audio and a new screen handle', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('RTCPeerConnection', FakePeer)
  vi.stubGlobal('MediaStream', class { getTracks() { return [] } })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  const tracks = new Map<string, MediaStreamTrack>()
  vi.mocked(subscribe).mockImplementation(async (_peer, publication, received) => {
    const track = { kind: publication.startsWith('audio') ? 'audio' : 'video', readyState: 'live' } as MediaStreamTrack
    tracks.set(publication, track)
    received(track)
    return publication
  })
  const participants = [{ key: 'a', name: 'Alice', sharing: true }, { key: 'b', name: 'Bob', sharing: true }]
  function snapshot(alice: string, roster = participants) {
    return Response.json({ participants: roster, owned: [], publications: [alice, 'bob'],
      publishers: { [alice]: 'a', bob: 'b' }, audio: { [alice]: 'audio-' + alice, bob: 'audio-bob' } })
  }
  const fetch = vi.fn().mockResolvedValueOnce(snapshot('first')).mockResolvedValueOnce(Response.json({
    participants, owned: [], publications: ['bob'], publishers: { bob: 'b' }, audio: { bob: 'audio-bob' },
  })).mockResolvedValueOnce(snapshot('replacement'))
    .mockResolvedValueOnce(snapshot('replacement', participants.map(person => ({ ...person, name: 'Alex' }))))
  vi.stubGlobal('fetch', fetch)
  render(<CloudflareStage canPublish={false} channel="test" identity="viewer" control="viewer" onExpired={vi.fn()} onDenied={vi.fn()} />)
  await act(() => vi.advanceTimersByTimeAsync(0))
  fireEvent.click(screen.getByRole('button', { name: 'Audio' }))
  const playback = (name: string) => screen.getByLabelText<HTMLAudioElement>(name + ' audio playback')
  const slider = (name: string) => screen.getByRole('slider', { name: name + ' audio volume' })
  expect(playback('Alice').volume).toBe(1)
  fireEvent.change(slider('Alice'), { target: { value: '24' } })
  fireEvent.click(screen.getByRole('button', { name: 'Mute Alice audio' }))
  fireEvent.change(slider('Bob'), { target: { value: '0' } })
  fireEvent.click(screen.getByRole('button', { name: 'Focus screen 2' }))
  expect(playback('Alice').volume).toBe(.24)
  expect(playback('Alice').muted).toBe(true)
  expect(playback('Bob').volume).toBe(0)
  expect(playback('Bob').muted).toBe(false)
  const ended = tracks.get('audio-first')!
  act(() => ended.onended?.call(ended, new Event('ended')))
  expect(screen.queryByLabelText('Alice audio volume')).toBeNull()
  await act(() => vi.advanceTimersByTimeAsync(2500))
  await act(() => vi.advanceTimersByTimeAsync(2500))
  expect(slider('Alice')).toHaveAttribute('aria-valuetext', '24%')
  expect(playback('Alice').volume).toBe(.24)
  expect(playback('Alice').muted).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Unmute Alice audio' }))
  expect(playback('Alice').muted).toBe(false)
  expect(playback('Bob').volume).toBe(0)
  await act(() => vi.advanceTimersByTimeAsync(2500))
  expect(playback('Alex (Screen 1)').volume).toBe(0)
  expect(playback('Alex (Screen 2)').volume).toBe(.24)
  fireEvent.change(slider('Alex (Screen 1)'), { target: { value: '62' } })
  expect(playback('Alex (Screen 2)').volume).toBe(.24)
  expect(fetch.mock.calls.every(([path]) => path === '/api/discord/test/media/state')).toBe(true)
})
