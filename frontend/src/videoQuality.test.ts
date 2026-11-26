import { expect, test, vi } from 'vitest'
import { applyVideoTarget, nativeTarget, observeScreenActivity, resolutions } from './videoQuality'

test('native defaults and sender changes preserve original layers without upscaling', async () => {
  const layers = [{ scaleResolutionDownBy: 4 }, {scaleResolutionDownBy: 1}]
  const sender = { getParameters: () => ({encodings: layers}), setParameters: vi.fn().mockResolvedValue(undefined) }
  const dimensions = { width: 2560, height: 1440 }
  expect(nativeTarget).toEqual({height:0, fps:60})
  expect(resolutions(dimensions)).toEqual([1080,720])
  await applyVideoTarget(sender as unknown as RTCRtpSender,dimensions,{height:720,fps:30})
  expect(layers).toEqual([{scaleResolutionDownBy:8,maxFramerate:30},{scaleResolutionDownBy:2,maxFramerate:30}])
  await applyVideoTarget(sender as unknown as RTCRtpSender,dimensions,nativeTarget)
  expect(layers[1]).toEqual({scaleResolutionDownBy:1,maxFramerate:60})
  await expect(applyVideoTarget(sender as unknown as RTCRtpSender,{width:640,height:360},{height:720,fps:15})).rejects.toThrow()
})

test('switches the live content preference without replacing the track or changing bitrate', async () => {
  const track = { contentHint: '' }
  const encodings = [{ maxBitrate: 4400000, scaleResolutionDownBy: 1 }]
  const sender = { track, getParameters: () => ({ encodings }), setParameters: vi.fn().mockResolvedValue(undefined) }
  for (const content of ['detail', 'motion', ''] as const) {
    await applyVideoTarget(sender as unknown as RTCRtpSender, { width: 1920, height: 1080 }, { ...nativeTarget, content })
    expect(track.contentHint).toBe(content)
    expect(encodings[0]).toEqual({ maxBitrate: 4400000, scaleResolutionDownBy: 1, maxFramerate: 60 })
  }
})

test('automatic content detection uses sustained sparse input and releases detail on motion or congestion', async () => {
  vi.useFakeTimers()
  const track = { contentHint: '' }
  let frames = 0, timestamp = 0, increment = 2, limitation = 'none'
  const sender = { track, getStats: vi.fn(async () => {
    frames += increment
    timestamp += 2000
    return new Map([
      ['source', { id: 'source', type: 'media-source', frames, timestamp }],
      ['rtp', { id: 'rtp', type: 'outbound-rtp', kind: 'video', mediaSourceId: 'source', qualityLimitationReason: limitation, timestamp }],
    ])
  }) }
  const stop = observeScreenActivity(sender as unknown as RTCRtpSender)!
  try {
    await vi.advanceTimersByTimeAsync(2000)
    expect(track.contentHint).toBe('')
    await vi.advanceTimersByTimeAsync(2000)
    expect(track.contentHint).toBe('detail')
    increment = 120
    await vi.advanceTimersByTimeAsync(2000)
    expect(track.contentHint).toBe('')
    increment = 2
    limitation = 'cpu'
    await vi.advanceTimersByTimeAsync(6000)
    expect(track.contentHint).toBe('')
  } finally { stop(); vi.useRealTimers() }
})
