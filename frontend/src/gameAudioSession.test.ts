import { afterEach, expect, test, vi } from 'vitest'
import { publishGameAudio } from './gameAudioSession'

afterEach(() => vi.unstubAllGlobals())

test('late authorization is revoked when sharing stops while a session is being issued', async () => {
  let finishPair!: (response: Response) => void
  const pair = new Promise<Response>((resolve) => {
    finishPair = resolve
  })
  const fetch = vi
    .fn()
    .mockReturnValueOnce(pair)
    .mockResolvedValue(Response.json({ stopped: true }))
  vi.stubGlobal('fetch', fetch)
  const owner = new AbortController()
  const ready = vi.fn()
  const done = publishGameAudio('screen', 'core:serial', 'owner', owner.signal, ready)
  owner.abort()
  finishPair(Response.json({ session: 'native-one', code: 'one-time' }))
  await expect(done).rejects.toThrow()
  expect(fetch.mock.calls.map(([path]) => path)).toEqual([
    '/api/native-audio/sessions',
    '/api/native-audio/native-one/stop',
  ])
  expect(ready).not.toHaveBeenCalled()
})

test('helper cannot start after losing the authenticated screen owner watch', async () => {
  const emptyWatch = new ReadableStream({
    start(controller) {
      controller.close()
    },
  })
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ session: 'native-two', code: 'one-time' }))
    .mockResolvedValueOnce(new Response(emptyWatch))
    .mockResolvedValueOnce(Response.json({ stopped: true }))
  vi.stubGlobal('fetch', fetch)
  const ready = vi.fn()
  await expect(
    publishGameAudio('screen', 'core:serial', 'owner', new AbortController().signal, ready),
  ).rejects.toThrow()
  expect(fetch.mock.calls.map(([path]) => path)).toEqual([
    '/api/native-audio/sessions',
    '/api/native-audio/native-two/watch',
    '/api/native-audio/native-two/stop',
  ])
  expect(ready).not.toHaveBeenCalled()
})
