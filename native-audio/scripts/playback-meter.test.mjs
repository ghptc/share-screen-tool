import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { playbackMeter, measurePlayback, measureRTP } from './playback-meter.mjs'

function fixture(local, remote, silentFrames = 0) {
  const stdout = new PassThrough()
  const meter = playbackMeter(() => ({ stdout }), '123', 'fixture', [440, 997])
  const pcm = Buffer.alloc(4800 * 8)
  for (let i = silentFrames; i < 4800; i++) {
    const sample =
      local * Math.sin((2 * Math.PI * 440 * i) / 48000) + remote * Math.sin((2 * Math.PI * 997 * i) / 48000)
    for (const offset of [0, 4]) pcm.writeFloatLE(sample, i * 8 + offset)
  }
  stdout.write(pcm.subarray(0, 333))
  stdout.end(pcm.subarray(333))
  meter.blocks[0].unixMs = 0
  return meter
}

test('accepts one audible remote stereo renderer and a suspended silent stream', () => {
  const report = measurePlayback([fixture(0, 0.2), { blocks: [] }], 0, 0, 100)
  assert.equal(report.stereoFrames, 4800)
  assert.ok(Math.abs(report.meanLevel - 0.2) < 0.001)
})

test('rejects relay, silence, a 20 ms dropout and duplicate audible renderers', () => {
  assert.throws(() => measurePlayback([fixture(0.01, 0.2)], 0, 0, 100), /Own tone/)
  assert.throws(() => measurePlayback([fixture(0, 0)], 0, 0, 100), /one audible/)
  assert.throws(() => measurePlayback([fixture(0, 0.2, 960)], 0, 0, 100), /Dropout/)
  assert.throws(() => measurePlayback([fixture(0, 0.2), fixture(0, 0.2)], 0, 0, 100), /one audible/)
})

test('checks sequence and sample time across RTP wrap and a truncated final log record', () => {
  const packet = (ms, sequence, timestamp) =>
    JSON.stringify({ stage: 'rtp_write', unixMs: ms, elapsedMs: ms, sequence, timestamp }) + '\n'
  const a = packet(0, 65535, 2 ** 32 - 960)
  assert.equal(measureRTP(a + packet(20, 0, 0) + '{"incomplete', 0, 40).packets, 2)
  assert.throws(() => measureRTP(a + packet(20, 0, 960), 0, 40), /Discontinuous/)
  assert.throws(() => measureRTP(a + packet(20, 1, 0), 0, 40), /Discontinuous/)
})
