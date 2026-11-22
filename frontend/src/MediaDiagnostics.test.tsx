import { act, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { RemoteVideoTrack } from 'livekit-client'
import MediaDiagnostics from './MediaDiagnostics'
import type { MediaStat } from './mediaStats'

function report(timestamp: number, bytes: number, frames: number): RTCStatsReport {
  const rows: MediaStat[] = [
    { id: 'in', type: 'inbound-rtp', timestamp, kind: 'video', codecId: 'codec', bytesReceived: bytes, framesDecoded: frames, frameWidth: 1280, frameHeight: 720, packetsReceived: frames * 10, packetsLost: 0 },
    { id: 'codec', type: 'codec', timestamp, mimeType: 'video/VP8' },
  ]
  return new Map(rows.map(row => [row.id, row])) as unknown as RTCStatsReport
}
afterEach(() => vi.useRealTimers())

test('renders measured inbound diagnostics and stops sampling after unmount', async () => {
  vi.useFakeTimers()
  const getStats = vi.fn().mockResolvedValueOnce(report(1000, 1000, 10)).mockResolvedValue(report(3000, 251000, 40))
  const video = document.createElement('video')
  Object.defineProperty(video, 'videoWidth', { value: 1280 })
  Object.defineProperty(video, 'videoHeight', { value: 720 })
  const track = { getRTCStatsReport: getStats } as unknown as RemoteVideoTrack
  let cleanup!: () => void
  await act(async () => { cleanup = render(<MediaDiagnostics track={track} local={false} video={{ current: video }} connected enabled={() => true} />).unmount })
  expect(screen.getByText('Decoded FPS').parentElement).toHaveTextContent('unavailable')
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(screen.getByText('Decoded FPS').parentElement).toHaveTextContent('15.0')
  expect(screen.getByText('Video RTP bitrate').parentElement).toHaveTextContent('1000.0 kb/s')
  expect(screen.getByText('Negotiated codec').parentElement).toHaveTextContent('video/VP8')
  expect(screen.getByText('Decoded resolution').parentElement).toHaveTextContent('1280 × 720')
  cleanup()
  await vi.advanceTimersByTimeAsync(6000)
  expect(getStats).toHaveBeenCalledTimes(2)
})

test('missing reports remain unavailable rather than turning targets into metrics', async () => {
  const track = { getRTCStatsReport: vi.fn().mockResolvedValue(undefined) } as unknown as RemoteVideoTrack
  await act(async () => { render(<MediaDiagnostics track={track} local video={{ current: null }} connected />) })
  expect(screen.getByText('Encoded FPS (largest active layer)').parentElement).toHaveTextContent('unavailable')
  expect(screen.getByText('Encoded resolution').parentElement).toHaveTextContent('unavailable')
  expect(screen.getByText('Video RTP bitrate').parentElement).toHaveTextContent('unavailable')
})
