// In-memory measurements of a tagged test browser's PipeWire output. Only
// short-lived sample blocks are kept; reports contain levels and frame counts.
const rate = 48000
const blockFrames = rate / 10
const blockBytes = blockFrames * 2 * Float32Array.BYTES_PER_ELEMENT

function toneWeights(frequency) {
  return Array.from({ length: blockFrames }, (_, i) => {
    const window = 1 - Math.cos((2 * Math.PI * i) / blockFrames)
    const phase = (2 * Math.PI * frequency * i) / rate
    return [window * Math.cos(phase), window * Math.sin(phase)]
  })
}

export function playbackMeter(child, serial, name, frequencies) {
  const weights = frequencies.map(toneWeights)
  const process = child(
    'pw-cat',
    [
      '--record',
      '--raw',
      '--rate',
      String(rate),
      '--channels',
      '2',
      '--format',
      'f32',
      '--target',
      serial,
      '--properties',
      `node.name=${name} node.passive=true node.dont-fallback=true node.dont-reconnect=true node.dont-move=true`,
      '-',
    ],
    ['ignore', 'pipe', 'inherit'],
  )
  const blocks = []
  let pending = Buffer.alloc(0)
  process.stdout.on('data', (data) => {
    pending = Buffer.concat([pending, data])
    while (pending.length >= blockBytes) {
      const channels = [0, 1].map((channel) => {
        const sums = weights.map(() => [0, 0])
        let power = 0,
          min20msRms = Infinity
        for (let i = 0; i < blockFrames; i++) {
          const sample = pending.readFloatLE((2 * i + channel) * 4)
          power += sample * sample
          if ((i + 1) % 960 === 0) {
            min20msRms = Math.min(min20msRms, Math.sqrt(power / 960))
            power = 0
          }
          for (let f = 0; f < weights.length; f++) {
            sums[f][0] += sample * weights[f][i][0]
            sums[f][1] += sample * weights[f][i][1]
          }
        }
        return { min20msRms, amplitude: sums.map(([re, im]) => (2 * Math.hypot(re, im)) / blockFrames) }
      })
      blocks.push({ unixMs: Date.now(), channels })
      pending = pending.subarray(blockBytes)
    }
  })
  return { serial, name, blocks }
}

// The browser can open additional silent output streams. Exactly one stream
// per listener must carry the remote tone across all steady-state blocks.
export function measurePlayback(meters, own, start, end) {
  const remote = 1 - own
  let worstForeign = 0
  const audible = []
  for (const meter of meters) {
    const blocks = meter.blocks.filter((b) => b.unixMs >= start && b.unixMs < end)
    const channels = blocks.flatMap((b) => b.channels)
    const maxRemote = Math.max(...channels.map((c) => c.amplitude[remote]))
    worstForeign = Math.max(worstForeign, ...channels.map((c) => c.amplitude[own]))
    if (maxRemote < 0.00005) continue
    if (blocks.length < ((end - start) / 100) * 0.95)
      throw new Error(`Missing rendered PCM from ${meter.name}`)
    const minLevel = Math.min(...channels.map((c) => c.amplitude[remote]))
    const min20msRms = Math.min(...channels.map((c) => c.min20msRms))
    if (
      ![maxRemote, minLevel, min20msRms].every(Number.isFinite) ||
      minLevel < maxRemote * 0.5 ||
      min20msRms < maxRemote * 0.25
    ) {
      throw new Error(
        `Dropout or unstable rendered tone on ${meter.name}: minimum amplitude ${minLevel}, peak ${maxRemote}, minimum 20 ms RMS ${min20msRms}`,
      )
    }
    const meanLevel = channels.reduce((sum, c) => sum + c.amplitude[remote], 0) / channels.length
    audible.push({
      streamSerial: meter.serial,
      stereoFrames: blocks.length * blockFrames,
      meanLevel,
      minLevel,
      min20msRms,
    })
  }
  if (audible.length !== 1)
    throw new Error(`Expected one audible browser output for listener ${own}, measured ${audible.length}`)
  const foreignRatio = worstForeign / audible[0].minLevel
  if (!(foreignRatio <= 0.01))
    throw new Error(`Own tone in listener ${own}'s browser output: ratio ${foreignRatio}`)
  return { ...audible[0], worstOwnRelativeToRemoteDb: 20 * Math.log10(Math.max(1e-12, foreignRatio)) }
}

// A crash may truncate the very last buffered JSONL record. Only complete
// records are considered, and their RTP sequence must span the test interval.
export function measureRTP(log, start, end) {
  const events = log
    .slice(0, log.lastIndexOf('\n'))
    .split('\n')
    .map((line) => JSON.parse(line))
  const packets = events.filter((r) => r.stage === 'rtp_write' && r.unixMs >= start && r.unixMs < end)
  if (packets.length < ((end - start) / 20) * 0.98 || packets.some((p) => p.error))
    throw new Error('Missing RTP writes in steady state')
  let maxGapMs = 0
  for (let i = 1; i < packets.length; i++) {
    const prev = packets[i - 1],
      next = packets[i]
    if (((next.sequence - prev.sequence) & 65535) !== 1 || (next.timestamp - prev.timestamp) >>> 0 !== 960) {
      throw new Error('Discontinuous Opus RTP sequence or sample clock')
    }
    maxGapMs = Math.max(maxGapMs, next.elapsedMs - prev.elapsedMs)
  }
  return { packets: packets.length, timestampStep: 960, sequenceStep: 1, maxGapMs }
}
