// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://screen-share-player.gabrielhpittacosta.workers.dev/"}
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import CloudflareStage from './CloudflareStage'
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
  vi.clearAllMocks()
})

it.each([
  { mode: 'pair', end: 'watch loss' },
  { mode: 'pair', end: 'audio disabled' },
  { mode: '', end: 'screen stopped' },
])('pairs without desktop discovery and handles $end (mode "$mode")', async ({ mode, end }) => {
  vi.stubEnv('VITE_NATIVE_AUDIO_MODE', mode)
  vi.stubGlobal('RTCPeerConnection', FakePeer)
  const track = { kind: 'video', stop: vi.fn() }
  const getDisplayMedia = vi.fn().mockResolvedValue({ getVideoTracks: () => [track], getTracks: () => [track] })
  vi.stubGlobal('navigator', Object.create(navigator, { mediaDevices: { value: { getDisplayMedia } } }))
  vi.mocked(publish).mockImplementation(async (peer, _track, signal) => {
    const publication = await signal('publish', {})
    Object.assign(peer, { connectionState: 'connected' })
    peer.onconnectionstatechange?.call(peer, new Event('connectionstatechange'))
    return publication.handle
  })
  let watch!: ReadableStreamDefaultController<Uint8Array>
  const paths: string[] = []
  const fetch = vi.fn(async (path: string) => {
    paths.push(path)
    switch (path) {
      case '/api/discord/test/media/state': return new Promise<Response>(() => {})
      case '/api/discord/test/media/publish': return Response.json({ handle: 'owned-screen' })
      case '/api/native-audio/sessions': return Response.json({ session: 'helper', code: 'fixture' })
      case '/api/native-audio/helper/watch':
        return new Response(new ReadableStream<Uint8Array>({ start(controller) { watch = controller } }))
      case '/api/discord/test/media/ready':
      case '/api/discord/test/media/close':
      case '/api/native-audio/helper/stop': return Response.json({})
      default: return new Response(null, { status: 404 })
    }
  })
  vi.stubGlobal('fetch', fetch)
  render(<CloudflareStage channel="test" identity="publisher" control="owner" onExpired={vi.fn()} onDenied={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Audio' }))
  expect(screen.queryByText('Pair native audio helper')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Start sharing' }))
  const pair = await screen.findByRole('button', { name: 'Pair native audio helper' })
  expect(paths).not.toContain('/api/native-audio/sessions')
  fireEvent.click(pair)
  await waitFor(() => expect(watch).toBeDefined())
  expect(fetch).toHaveBeenCalledWith('/api/native-audio/sessions', expect.objectContaining({
    headers: expect.objectContaining({ Authorization: 'Bearer owner' }), body: JSON.stringify({ screen: 'owned-screen' }),
  }))
  expect(screen.queryByLabelText('One-time native audio pairing JSON')).toBeNull()
  await act(async () => watch.enqueue(new TextEncoder().encode('active\n')))
  const input = screen.getByLabelText<HTMLInputElement>('One-time native audio pairing JSON')
  expect(JSON.parse(input.value).apiUrl).toBe(location.origin + '/api')
  fireEvent.click(screen.getByRole('button', { name: 'Audio' }))
  expect(paths).not.toContain('/api/native-audio/helper/stop')
  if (end === 'audio disabled') fireEvent.click(screen.getByRole('checkbox', { name: 'Share audio' }))
  if (end === 'screen stopped') fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }))
  if (end !== 'watch loss') {
    expect(fetch).toHaveBeenCalledWith('/api/native-audio/helper/stop', expect.objectContaining({ keepalive: true }))
  }
  await act(async () => watch.close())
  fireEvent.click(screen.getByRole('button', { name: 'Audio' }))
  expect(screen.queryByLabelText('One-time native audio pairing JSON')).toBeNull()
  if (end === 'watch loss') expect(screen.getByRole('alert')).toHaveTextContent('Native audio session ended')
  expect(paths.filter(path => path.startsWith('/player/'))).toEqual([])
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
  render(<CloudflareStage channel="test" identity="viewer" control="viewer" onExpired={vi.fn()} onDenied={vi.fn()} />)
  const enable = await screen.findByRole('button', { name: 'Enable audio' })
  expect(play).toHaveBeenCalledTimes(1)
  fireEvent.click(enable)
  expect(play).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole('button', { name: 'Audio' }))
  expect(screen.queryByRole('button', { name: 'Pair native audio helper' })).toBeNull()
  expect(paths).toEqual(['/api/discord/test/media/state'])
})
