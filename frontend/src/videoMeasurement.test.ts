import { expect, it } from 'vitest'
import { summarizeVideo, type VideoEndpoint } from './videoMeasurement'
import type { MediaStat } from './mediaStats'

const endpoint = { local: true, pc: { connectionState: 'connected', getSenders: () => [] } } as unknown as VideoEndpoint
function series(local: boolean) {
  const element = document.createElement('video')
  return Array.from({ length: 16 }, (_, i) => {
    const at = 1000 + 2000 * i
    const frames = 100 + 80 * i
    const rows: MediaStat[] = [
      { id: 'video', type: local ? 'outbound-rtp' : 'inbound-rtp', kind: 'video', mediaSourceId: 'source', codecId: 'c',
        timestamp: at, framesEncoded: frames, framesSent: frames, framesReceived: 100 + i * 100, framesDecoded: frames,
        frameWidth: 1920, frameHeight: 1080, totalEncodeTime: i * .4 + (i === 15 ? .8 : 0),
        targetBitrate: i === 5 ? 1000000 : 8000000, keyFramesEncoded: 10 + i, powerEfficientEncoder: false, framesDropped: 12 + i, freezeCount: 3,
        qualityLimitationReason: i === 5 ? 'bandwidth' : 'none', bytesSent: i * 2_000_000, qpSum: frames * 12 },
      { id: 'source', type: 'media-source', timestamp: at, frames: i * 120 },
      { id: 'c', type: 'codec', timestamp: at, mimeType: 'video/H264' },
    ]
    return { at, stats: new Map(rows.map(r => [r.id, r])), element, presenting: true, fullscreen: true,
      playback: { creationTime: at, totalVideoFrames: frames, droppedVideoFrames: 2 * i } as VideoPlaybackQuality }
  })
}

it('summarizes all 30 seconds by frame counts and distinguishes interval peak from mean', () => {
  expect(summarizeVideo(series(true), endpoint)).toMatchObject({ status: 'Measured', seconds: 30, captureFps: 60,
    encodedFps: 40, sentFps: 40, bitrateBps: 8000000, meanCodecQp: 12, keyframes: 15, meanEncodeMs: expect.closeTo(5.6667, 3),
    peakTwoSecondMeanEncodeMs: expect.closeTo(15), powerEfficientEncoder: false, targetBps: { min: 1000000, max: 8000000, samples: 15 }, limitationsObserved: ['none', 'bandwidth'] })
})

it('measures displayed frames separately and invalidates element counters across a remount', () => {
  const samples = series(false)
  const peer = { ...endpoint, local: false }
  expect(summarizeVideo(samples, peer)).toMatchObject({ receivedFps: 50, decodedFps: 40, displayedFps: 39,
    freezes: 0, receiverDrops: 15, elementDrops: 30, fullscreenThroughout: true })
  samples[7].element = document.createElement('video')
  expect(summarizeVideo(samples, peer)).toMatchObject({ displayedFps: undefined, sameElement: false, elementDrops: undefined })
})

it('rejects partial, throttled and reset intervals even if the endpoint recovered', () => {
  const samples = series(true)
  expect(summarizeVideo(samples.slice(1), endpoint).status).toBe('Incomplete interval')
  samples[4].at += 1100
  expect(summarizeVideo(samples, endpoint).status).toBe('Sampling delayed')
  samples[4].at -= 1100
  samples[4].stats.get('video')!.framesEncoded = 0
  expect(summarizeVideo(samples, endpoint).status).toMatch(/counters unavailable/)
})
