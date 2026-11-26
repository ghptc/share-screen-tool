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

test('separates a 60 FPS source, encoder throughput and transmitted frames under bandwidth adaptation', () => {
  const source: Partial<MediaStat> = { type: 'media-source', id: 'capture', frames: 200 }
  const outgoing: Partial<MediaStat> = { type: 'outbound-rtp', id: 'out', kind: 'video', mediaSourceId: 'capture',
    framesEncoded: 110, framesSent: 100, bytesSent: 10000 }
  const previous = sample(source, outgoing)
  const now = sample({ ...source, timestamp: 3000, frames: 320 },
    { ...outgoing, timestamp: 3000, framesEncoded: 170, framesSent: 150, bytesSent: 260000,
      targetBitrate: 1100000, qualityLimitationReason: 'bandwidth' },
    { id: 'feedback', type: 'remote-inbound-rtp', localId: 'out', jitter: .021 },
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' },
    { id: 'pair', type: 'candidate-pair', availableOutgoingBitrate: 1200000 })
  expect(measureMedia(now, previous, true)).toMatchObject({ captureFps: 60, fps: 30, transportFps: 25,
    jitterMs: 21, bitrateBps: 1000000, targetBps: 1100000, availableBps: 1200000, limitation: 'bandwidth' })
})

test.each([true, false])('measures audio RTP and energy independently of video or playback (sender %s)', local => {
  const rtp: Partial<MediaStat> = local
    ? { type: 'outbound-rtp', packetsSent: 5, bytesSent: 100, mediaSourceId: 'source' }
    : { type: 'inbound-rtp', packetsReceived: 5, bytesReceived: 100, totalAudioEnergy: 0 }
  const previous = sample({ ...rtp, kind: 'audio', id: 'sound' }, { id: 'source', type: 'media-source', totalAudioEnergy: 0 })
  const current = sample({ ...rtp, kind: 'audio', id: 'sound', timestamp: 3000, codecId: 'opus',
    packetsReceived: 105, packetsSent: 105, bytesReceived: 1100, bytesSent: 1100, totalAudioEnergy: .125 },
    { id: 'source', type: 'media-source', timestamp: 3000, totalAudioEnergy: .25 },
    { id: 'opus', type: 'codec', mimeType: 'audio/opus' })
  expect(measureMedia(current, previous, local, 'audio')).toMatchObject({
    packetsPerSecond: 50, bitrateBps: 4000, audioEnergyDelta: local ? .25 : .125, codec: 'audio/opus' })
  expect(measureMedia(current, undefined, local, 'audio').packetsPerSecond).toBeUndefined()
})

test('separates encoded frame cost, receiver buffering and concealed audio', () => {
  const out: Partial<MediaStat> = { id: 'o', kind: 'video', type: 'outbound-rtp', framesEncoded: 10, totalEncodeTime: .1 }
  const sent = measureMedia(sample({ ...out, timestamp: 2000, framesEncoded: 60, totalEncodeTime: .35,
    keyFramesEncoded: 2 }), sample(out), true)
  expect(sent.encodeMs).toBeCloseTo(5)
  expect(sent.keyFrames).toBe(2)
  const inbound: Partial<MediaStat> = { id: 'a', type: 'inbound-rtp', kind: 'audio', jitterBufferDelay: 1,
    jitterBufferEmittedCount: 100, totalSamplesReceived: 100, concealedSamples: 10 }
  const received = measureMedia(sample({ ...inbound, timestamp: 2000, jitterBufferDelay: 4,
    jitterBufferEmittedCount: 200, totalSamplesReceived: 220, concealedSamples: 30 }), sample(inbound), false, 'audio')
  expect(received).toMatchObject({ jitterBufferMs: 30, receivedSamples: 120, concealedSamples: 20 })
  expect(measureMedia(sample(inbound), undefined, false, 'audio').jitterBufferMs).toBeUndefined()
})
