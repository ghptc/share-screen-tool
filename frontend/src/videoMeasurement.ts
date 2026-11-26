import { measureMedia, sampleReport, type StatsSample } from './mediaStats'

export function displayedFps(now?: VideoPlaybackQuality, before?: VideoPlaybackQuality, maxGapMs = 10000) {
  if (!now || !before) return
  const ms = now.creationTime - before.creationTime
  const total = now.totalVideoFrames - before.totalVideoFrames
  const dropped = now.droppedVideoFrames - before.droppedVideoFrames
  if (ms > 0 && ms <= maxGapMs && dropped >= 0 && total >= dropped) return (total - dropped) * 1000 / ms
}

export type VideoEndpoint = { pc: RTCPeerConnection; stream: MediaStream; local: boolean }
type Snapshot = {
  stats: StatsSample; playback?: VideoPlaybackQuality; element?: HTMLVideoElement
  presenting: boolean; fullscreen: boolean; at: number
}

export async function snapshot({ pc, stream }: VideoEndpoint, root: HTMLElement): Promise<Snapshot> {
  const stats = sampleReport(await pc.getStats())
  const element = Array.from(root.querySelectorAll('video')).find(v => v.srcObject === stream)
  return { stats, element, playback: element?.getVideoPlaybackQuality?.(), at: performance.now(),
    presenting: !!element && !element.paused && !document.hidden && !element.closest('[hidden]'),
    fullscreen: !!document.fullscreenElement }
}

export function summarizeVideo(samples: Snapshot[], endpoint: VideoEndpoint) {
  if (samples.length !== 16) return { status: 'Incomplete interval' }
  const start = samples[0], end = samples[samples.length - 1]
  const seconds = (end.at - start.at) / 1000
  if (Math.abs(seconds - 30) > 1 || samples.slice(1).some((s, i) => Math.abs(s.at - samples[i].at - 2000) > 1000))
    return { status: 'Sampling delayed', seconds }
  // A replaced stream, codec or reset in any interval invalidates the A/B comparison.
  const intervals = samples.slice(1).map((s, i) => measureMedia(s.stats, samples[i].stats, endpoint.local))
  if (endpoint.pc.connectionState === 'closed' || intervals.some(m => m.layers !== 1 || m.fps === undefined ||
      m.codec !== intervals[0].codec)) return { status: 'RTP stream changed or counters unavailable', seconds }
  const local = endpoint.local
  const m = measureMedia(end.stats, start.stats, local, 'video', 32000)
  const sizes = new Set(intervals.flatMap(m => m.width && m.height ? [m.width + 'x' + m.height] : []))
  const sameElement = !!start.element && samples.every(s => s.element === start.element)
  const displayed = sameElement ? displayedFps(end.playback, start.playback, 32000) : undefined
  const range = (values: (number | undefined)[]) => {
    const observed = values.filter((value): value is number => value !== undefined && Number.isFinite(value))
    return observed.length ? { samples: observed.length, min: Math.min(...observed), max: Math.max(...observed) } : undefined
  }
  const peak = intervals.flatMap(m => m.encodeMs ?? [])
  const first = measureMedia(start.stats, undefined, local)
  const diff = (a?: number, b?: number) => a !== undefined && b !== undefined && a >= b ? a - b : undefined
  const track = local ? endpoint.pc.getSenders().find(s => s.track?.kind === 'video')?.track : undefined
  const settings = track?.getSettings()
  return { status: 'Measured', seconds, direction: m.direction, codec: m.codec, sizesObserved: [...sizes], widthAtEnd: m.width, heightAtEnd: m.height,
    bitrateBps: m.bitrateBps, meanCodecQp: m.meanQp,
    ...(local ? { sfuReportedLossPercent: range(intervals.map(i => i.lossPercent)) } : { lossPercent: m.lossPercent }),
    rttMs: range(intervals.map(i => i.rttMs)), jitterMs: range(intervals.map(i => i.jitterMs)),
    keyframes: diff(m.keyFrames, first.keyFrames),
    ...(local ? { captureWidthAtEnd: settings?.width, captureHeightAtEnd: settings?.height, hintAtEnd: track?.contentHint,
      captureFps: [...end.stats.values()].some(r => r.type === 'media-source' && r.frames !== undefined)
        ? m.captureFps : undefined, encodedFps: m.fps, sentFps: m.transportFps,
      encoder: m.encoder, powerEfficientEncoder: m.powerEfficient, meanEncodeMs: m.encodeMs,
      peakTwoSecondMeanEncodeMs: peak.length ? Math.max(...peak) : undefined,
      limitationsObserved: [...new Set(intervals.flatMap(m => m.limitation ?? []))],
      targetBps: range(intervals.map(i => i.targetBps)), availableBps: range(intervals.map(i => i.availableBps)),
    } : { receivedFps: m.transportFps, decodedFps: m.fps, displayedFps: displayed, decoder: m.decoder,
      powerEfficientDecoder: m.powerEfficient, meanDecodeMs: m.decodeMs, jitterBufferMs: m.jitterBufferMs,
      renderIntervalDeviationMs: m.frameIntervalDeviationMs, receiverDrops: diff(m.dropped, first.dropped),
      freezes: diff(m.freezes, first.freezes), sameElement,
      elementDrops: sameElement ? diff(end.playback?.droppedVideoFrames, start.playback?.droppedVideoFrames) : undefined,
      presentingThroughout: samples.every(s => s.presenting), fullscreenThroughout: samples.every(s => s.fullscreen) }),
  }
}
