import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import CloudflareStage from './CloudflareStage'

it('releases the screen and peer after a gathering timeout before publish', async () => {
  vi.useFakeTimers()
  const stop = vi.fn()
  const track = { kind: 'video', stop }
  const getDisplayMedia = vi.fn().mockResolvedValue({
    getTracks: () => [track], getVideoTracks: () => [track],
  })
  const close = vi.fn()
  class Peer extends EventTarget {
    close = close
    iceGatheringState = 'gathering'
    localDescription = { type: 'offer', sdp: 'v=0\r\n' }
    addTransceiver() { return { mid: '0' } }
    async createOffer() { return this.localDescription }
    async setLocalDescription() {}
  }
  const fetch = vi.fn(() => new Promise<Response>(() => {}))
  vi.stubGlobal('RTCPeerConnection', Peer)
  vi.stubGlobal('fetch', fetch)
  vi.stubGlobal('navigator', Object.create(navigator, { mediaDevices: { value: { getDisplayMedia } } }))
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  try {
    render(<CloudflareStage channel="test" identity="tester" control="" onExpired={vi.fn()} onDenied={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start sharing' }))
    expect(getDisplayMedia).toHaveBeenCalledTimes(1)
    await act(() => vi.advanceTimersByTimeAsync(8000))
    expect(screen.getByRole('alert')).toHaveTextContent('Gathering state: gathering.')
    expect(screen.getByRole('button', { name: 'Start sharing' })).toBeEnabled()
    expect(close).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/discord/test/media/state', expect.anything())
  } finally {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  }
})
