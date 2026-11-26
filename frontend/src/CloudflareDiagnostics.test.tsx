import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import CloudflareDiagnostics from './CloudflareDiagnostics'

afterEach(() => vi.useRealTimers())

it('samples the existing receiver and element independently while diagnostics are open', async () => {
  vi.useFakeTimers()
  const report = (timestamp: number, framesReceived: number, framesDecoded: number, delay: number, squared: number) =>
    new Map([['rtp', { id: 'rtp', type: 'inbound-rtp', kind: 'video', timestamp, framesReceived,
      framesRendered: framesDecoded, totalInterFrameDelay: delay, totalSquaredInterFrameDelay: squared,
      framesDecoded, framesDropped: framesReceived - framesDecoded, jitter: .012, freezeCount: 1 }]])
  // Sixty receiver intervals, half at 20 ms and half at 40 ms, have a 10 ms SD.
  const getStats = vi.fn().mockResolvedValueOnce(report(1000, 50, 40, 1, .04))
    .mockResolvedValue(report(3000, 170, 100, 2.8, .10))
  const root = document.createElement('div')
  const video = root.appendChild(document.createElement('video'))
  const stream = {} as MediaStream
  video.srcObject = stream
  video.getVideoPlaybackQuality = vi.fn().mockReturnValueOnce({ creationTime: 1000, totalVideoFrames: 40, droppedVideoFrames: 4 })
    .mockReturnValue({ creationTime: 3000, totalVideoFrames: 100, droppedVideoFrames: 34 })
  const view = render(<CloudflareDiagnostics pc={{ getStats, connectionState: 'connected' } as unknown as RTCPeerConnection}
    audio={false} local={false} stream={stream} label="Screen 1" root={{ current: root }} />)
  expect(getStats).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('Screen 1 video diagnostics'))
  await act(() => vi.advanceTimersByTimeAsync(1))
  expect(screen.getByText('Unavailable / Unavailable / Unavailable')).toBeVisible()
  await act(() => vi.advanceTimersByTimeAsync(2000))
  expect(screen.getByText('60.0 / 30.0 / 15.0')).toBeVisible()
  expect(screen.getByText('Receiver drops / freezes (totals)').nextElementSibling).toHaveTextContent('70 / 1')
  expect(screen.getByText('Receiver jitter (ms)').nextElementSibling).toHaveTextContent('12.0')
  expect(screen.getByText('Receiver frame interval SD (ms)').nextElementSibling).toHaveTextContent('10.0')
  const replacement = document.createElement('video')
  replacement.srcObject = stream
  replacement.getVideoPlaybackQuality = vi.fn().mockReturnValue({ creationTime: 5000, totalVideoFrames: 220, droppedVideoFrames: 34 })
  root.replaceChild(replacement, video)
  await act(() => vi.advanceTimersByTimeAsync(2000))
  expect(screen.getByText('Received / decoded / displayed FPS').nextElementSibling).toHaveTextContent('Unavailable / Unavailable / Unavailable')
  expect(screen.getByText('Video element replacements observed').nextElementSibling).toHaveTextContent('1')
  view.unmount()
  await vi.advanceTimersByTimeAsync(6000)
  expect(getStats).toHaveBeenCalledTimes(3)
})

it('measures two existing peers on one 30-second clock without exposing peer identifiers', async () => {
  const { default: RoomVideoBenchmark } = await import('./RoomVideoBenchmark')
  vi.useFakeTimers()
  const root = document.createElement('div')
  const endpoints = [0, 1].map(n => {
    const stream = {} as MediaStream
    const element = root.appendChild(document.createElement('video'))
    element.srcObject = stream
    const getStats = vi.fn(async () => {
      const timestamp = performance.now()
      return new Map([['unused', { id: 'sensitive-handle-' + n, type: 'inbound-rtp', kind: 'video', timestamp,
        framesReceived: Math.round(timestamp * .06), framesDecoded: Math.round(timestamp * .05) }]])
    })
    return { stream, local: false, pc: { getStats, connectionState: 'connected' } as unknown as RTCPeerConnection }
  })
  render(<RoomVideoBenchmark endpoints={endpoints} root={{ current: root }} />)
  expect(endpoints[0].pc.getStats).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /Measure all/ }))
  await act(() => vi.advanceTimersByTimeAsync(30001))
  const result = screen.getByRole<HTMLTextAreaElement>('textbox').value
  expect(result).not.toMatch(/sensitive-handle/)
  expect(JSON.parse(result).screens).toMatchObject([1, 2].map(tile => ({ tile, seconds: 30, decodedFps: 50, receivedFps: 60 })))
  endpoints.forEach(e => expect(e.pc.getStats).toHaveBeenCalledTimes(16))
})
