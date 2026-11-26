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

test('a profile-only change leaves native sender layers and rate control alone', async () => {
  const sender = { track: { contentHint: '' }, getParameters: () => ({ encodings: [{ maxFramerate: 60 }] }),
    setParameters: vi.fn() }
  await applyVideoTarget(sender as unknown as RTCRtpSender, {}, { ...nativeTarget, content: 'motion' })
  expect(sender.track.contentHint).toBe('motion')
  expect(sender.setParameters).not.toHaveBeenCalled()
})

test('sustained moving input selects motion despite CPU pressure and holds across borderline samples', async () => {
  vi.useFakeTimers()
  let frames = 0, time = 0, rate = 26
  const track = { contentHint: '' }
  const sender = { track, getStats: vi.fn(async () => {
    frames += rate * 2
    time += 2000
    return new Map([
      ['src', { id: 'src', type: 'media-source', frames, timestamp: time }],
      ['out', { id: 'out', type: 'outbound-rtp', kind: 'video', mediaSourceId: 'src', timestamp: time,
        framesEncoded: time / 200, qualityLimitationReason: 'cpu' }],
    ])
  }) }
  const stop = observeScreenActivity(sender as unknown as RTCRtpSender)!
  try {
    await vi.advanceTimersByTimeAsync(4000)
    expect(track.contentHint).toBe('')
    await vi.advanceTimersByTimeAsync(2000)
    expect(track.contentHint).toBe('motion')
    rate = 19
    await vi.advanceTimersByTimeAsync(6000)
    expect(track.contentHint).toBe('motion')
    rate = 2
    await vi.advanceTimersByTimeAsync(6000)
    expect(track.contentHint).toBe('')
  } finally { stop(); vi.useRealTimers() }
})
