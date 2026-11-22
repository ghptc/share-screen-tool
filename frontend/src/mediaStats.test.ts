import { expect, test } from 'vitest'
import { measureMedia, type MediaStat, type StatsSample } from './mediaStats'
function sample(...rows: Partial<MediaStat>[]): StatsSample {
  return new Map(rows.map(row => [row.id!, { timestamp: 1000, type: 'codec', ...row } as MediaStat]))
}
const codec: Partial<MediaStat> = { id: 'codec', type: 'codec', mimeType: 'video/VP8' }
test('computes inbound bitrate, decoded FPS, codec, packet loss and RTT from measured reports', () => {
  const before = sample({ id: 'in', type: 'inbound-rtp', kind: 'video', bytesReceived: 1000, framesDecoded: 10, packetsReceived: 100, packetsLost: 2 })
  const now = sample(codec, { id: 'in', type: 'inbound-rtp', kind: 'video', timestamp: 3000, codecId: 'codec', bytesReceived: 251000, framesDecoded: 70, packetsReceived: 198, packetsLost: 4, frameWidth: 1280, frameHeight: 720 },
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair', dtlsState: 'connected' }, { id: 'pair', type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: .025 })
  expect(measureMedia(now, before, false)).toMatchObject({ width: 1280, height: 720, fps: 30, bitrateBps: 1000000, codec: 'video/VP8', packetsLost: 4, lossPercent: 2, rttMs: 25, iceState: 'succeeded', dtlsState: 'connected' })
})
test('sums primary simulcast bitrates, excludes RTX, and never adds layer FPS', () => {
  const before = sample({ id: 'small', type: 'outbound-rtp', kind: 'video', bytesSent: 1000, framesEncoded: 1 }, { id: 'large', type: 'outbound-rtp', kind: 'video', bytesSent: 2000, framesEncoded: 1 })
  const now = sample(codec, { id: 'rtxcodec', type: 'codec', mimeType: 'video/rtx' },
    { id: 'small', type: 'outbound-rtp', kind: 'video', timestamp: 2000, codecId: 'codec', bytesSent: 11000, framesEncoded: 16, frameWidth: 320, frameHeight: 180 },
    { id: 'large', type: 'outbound-rtp', kind: 'video', timestamp: 2000, codecId: 'codec', bytesSent: 102000, framesEncoded: 61, frameWidth: 2560, frameHeight: 1440 },
    { id: 'rtx', type: 'outbound-rtp', kind: 'video', timestamp: 2000, codecId: 'rtxcodec', bytesSent: 900000 },
    { id: 'feedback', type: 'remote-inbound-rtp', localId: 'large', packetsLost: 5, fractionLost: .01, roundTripTime: .04 })
  expect(measureMedia(now, before, true)).toMatchObject({ layers: 2, bitrateBps: 880000, fps: 60, width: 2560, codec: 'video/VP8', packetsLost: 5, lossPercent: 1, rttMs: 40 })
})
test('first samples, reset counters and stale gaps do not fabricate rates', () => {
  const row: Partial<MediaStat> = { id: 'video', type: 'inbound-rtp', kind: 'video', bytesReceived: 1000, framesDecoded: 10 }
  const now = sample(row)
  expect(measureMedia(now, undefined, false).fps).toBeUndefined()
  expect(measureMedia(now, undefined, false).bitrateBps).toBeUndefined()
  for (const timestamp of [1000, 500, 20000]) {
    const before = sample({ ...row, timestamp, bytesReceived: 2000, framesDecoded: 20 })
    expect(measureMedia(now, before, false).bitrateBps).toBeUndefined()
    expect(measureMedia(now, before, false).fps).toBeUndefined()
  }
  const stale = sample({ ...row, timestamp: 20000, bytesReceived: 3000, framesDecoded: 30 })
  expect(measureMedia(stale, now, false).bitrateBps).toBeUndefined()
  expect(measureMedia(stale, now, false).fps).toBeUndefined()
  expect(measureMedia(new Map(), now, false)).toMatchObject({ layers: 0 })
})
test('selects a sending layer over a disabled/high-resolution stale layer', () => {
  const before = sample({ id: 'high', type: 'outbound-rtp', kind: 'video', bytesSent: 1000, framesEncoded: 100 }, { id: 'low', type: 'outbound-rtp', kind: 'video', bytesSent: 1000, framesEncoded: 100 })
  const now = sample({ id: 'high', type: 'outbound-rtp', kind: 'video', timestamp: 3000, frameWidth: 2560, frameHeight: 1440, bytesSent: 1000, framesEncoded: 100 }, { id: 'low', type: 'outbound-rtp', kind: 'video', timestamp: 3000, frameWidth: 640, frameHeight: 360, bytesSent: 2000, framesEncoded: 130 })
  expect(measureMedia(now, before, true)).toMatchObject({ width: 640, height: 360, fps: 15, bitrateBps: 4000 })
})
test('clamps late-packet corrections and preserves genuinely zero rates', () => {
  const before = sample({ id: 'in', type: 'inbound-rtp', mediaType: 'video', bytesReceived: 1000, framesDecoded: 10, packetsReceived: 100, packetsLost: 4 })
  const now = sample({ id: 'in', type: 'inbound-rtp', mediaType: 'video', timestamp: 3000, bytesReceived: 1000, framesDecoded: 10, packetsReceived: 102, packetsLost: 2 })
  expect(measureMedia(now, before, false)).toMatchObject({ fps: 0, bitrateBps: 0, lossPercent: 0 })
})
