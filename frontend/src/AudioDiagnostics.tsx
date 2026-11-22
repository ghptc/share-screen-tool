import { useEffect, useState, type RefObject } from 'react'
import type { TrackPublication } from 'livekit-client'

type Metrics = { codec?: string; packets?: number; bytes?: number; lost?: number; energy?: number; energyDelta?: number; bitrate?: number; jitterMs?: number; bufferMs?: number; concealed?: number }
type Counter = { id: string; bytes: number; timestamp: number; energy?: number; delay?: number; emitted?: number }
type Playback = { attached: boolean; muted: boolean; volume: number; paused: boolean; ready: number; time: number; sink: string; rawEnabled?: boolean; rawMuted?: boolean; state?: string; error?: string }
export default function AudioDiagnostics({ track, connected, publication, audio, ownerIdentity, publisherIdentity }: {
  track: TrackPublication['audioTrack']; connected: boolean; publication?: TrackPublication; audio?: RefObject<HTMLAudioElement | null>; ownerIdentity?: string; publisherIdentity?: string
}) {
  const [metrics, setMetrics] = useState<Metrics>({})
  const [playback, setPlayback] = useState<Playback>()
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let previous: Counter | undefined
    const element = audio?.current
    function snapshot() {
      if (!element || disposed) return
      const stream = typeof MediaStream !== 'undefined' && element.srcObject instanceof MediaStream ? element.srcObject : undefined
      setPlayback({ attached: !!track && !!stream?.getAudioTracks().some(raw => raw === track.mediaStreamTrack), muted: element.muted, volume: element.volume,
        paused: element.paused, ready: element.readyState, time: element.currentTime, sink: element.sinkId || 'Browser default',
        rawEnabled: track?.mediaStreamTrack.enabled, rawMuted: track?.mediaStreamTrack.muted, state: track?.mediaStreamTrack.readyState, error: element.error?.message })
    }
    const events = ['play', 'playing', 'pause', 'waiting', 'volumechange', 'loadedmetadata', 'error'] as const
    for (const event of events) element?.addEventListener(event, snapshot)
    async function poll() {
      try {
        const report = connected && track?.getRTCStatsReport ? await track.getRTCStatsReport() : undefined
        if (disposed) return
        let next: Metrics = {}
        let current: Counter | undefined
        report?.forEach(row => {
          if (row.type !== 'inbound-rtp' || (row.kind !== 'audio' && row.mediaType !== 'audio')) return
          const elapsed = previous ? row.timestamp - previous.timestamp : 0
          const interval = previous?.id === row.id && elapsed > 0 && elapsed <= 10000
          const emitted = interval && previous?.emitted !== undefined ? row.jitterBufferEmittedCount - previous.emitted : 0
          next = { codec: report.get(row.codecId)?.mimeType, packets: row.packetsReceived, bytes: row.bytesReceived, lost: row.packetsLost, energy: row.totalAudioEnergy,
            jitterMs: typeof row.jitter === 'number' ? row.jitter * 1000 : undefined, concealed: row.concealedSamples,
            bitrate: interval && previous && row.bytesReceived >= previous.bytes ? (row.bytesReceived - previous.bytes) * 8 / elapsed : undefined,
            energyDelta: interval && previous?.energy !== undefined && row.totalAudioEnergy >= previous.energy ? row.totalAudioEnergy - previous.energy : undefined,
            bufferMs: emitted > 0 && previous?.delay !== undefined && row.jitterBufferDelay >= previous.delay ? (row.jitterBufferDelay - previous.delay) * 1000 / emitted : undefined }
          current = { id: row.id, bytes: row.bytesReceived, timestamp: row.timestamp, energy: row.totalAudioEnergy, delay: row.jitterBufferDelay, emitted: row.jitterBufferEmittedCount }
        })
        previous = current
        setMetrics(next)
      } catch { previous = undefined; if (!disposed) setMetrics({}) }
      snapshot()
      if (!disposed) timer = setTimeout(() => void poll(), 2000)
    }
    void poll()
    return () => { disposed = true; if (timer) clearTimeout(timer); for (const event of events) element?.removeEventListener(event, snapshot) }
  }, [track, connected, audio])
  const unavailable = 'Unavailable'
  const flag = (value?: boolean) => value === undefined ? unavailable : value ? 'yes' : 'no'
  return <details><summary>Audio diagnostics</summary><dl>
    {ownerIdentity && <><dt>Screen owner identity</dt><dd>{ownerIdentity}</dd><dt>Audio publisher identity</dt><dd>{publisherIdentity || ownerIdentity}</dd></>}
    {publication && <><dt>Audio subscription</dt><dd>{flag(publication.isSubscribed)}</dd><dt>Publisher muted audio</dt><dd>{flag(publication.isMuted)}</dd><dt>Publication enabled</dt><dd>{flag(publication.isEnabled)}</dd></>}
    <dt>Negotiated audio codec</dt><dd>{metrics.codec ?? unavailable}</dd>
    <dt>Audio RTP bitrate</dt><dd>{metrics.bitrate === undefined ? unavailable : `${metrics.bitrate.toFixed(1)} kb/s`}</dd>
    <dt>Audio packets received</dt><dd>{metrics.packets ?? unavailable}</dd>
    <dt>Audio bytes received</dt><dd>{metrics.bytes ?? unavailable}</dd>
    <dt>Audio packets lost (total)</dt><dd>{metrics.lost ?? unavailable}</dd>
    <dt>RTP jitter</dt><dd>{metrics.jitterMs === undefined ? unavailable : `${metrics.jitterMs.toFixed(1)} ms`}</dd>
    <dt>Receiver jitter buffer (sample interval)</dt><dd>{metrics.bufferMs === undefined ? unavailable : `${metrics.bufferMs.toFixed(1)} ms`}</dd>
    <dt>Concealed audio samples (total)</dt><dd>{metrics.concealed ?? unavailable}</dd>
    <dt>Decoded audio energy (total)</dt><dd>{metrics.energy ?? unavailable}</dd>
    <dt>Decoded audio energy (sample interval)</dt><dd>{metrics.energyDelta ?? unavailable}</dd>
    {playback && <><dt>Audio element attached to this track</dt><dd>{flag(playback.attached)}</dd>
      <dt>Element muted / volume</dt><dd>{flag(playback.muted)} / {Math.round(playback.volume * 100)}%</dd>
      <dt>Element paused / ready state</dt><dd>{flag(playback.paused)} / {playback.ready}</dd>
      <dt>Playback time</dt><dd>{playback.time.toFixed(2)} s</dd>
      <dt>Native track enabled / muted / state</dt><dd>{flag(playback.rawEnabled)} / {flag(playback.rawMuted)} / {playback.state ?? unavailable}</dd>
      <dt>Output device</dt><dd>{playback.sink}</dd>
      <dt>Playback path</dt><dd>HTML audio element; no AudioContext required</dd>
      {playback.error && <><dt>Media element error</dt><dd>{playback.error}</dd></>}
    </>}
  </dl><p>Receiver measurements distinguish reception from playback. Energy totals can stay positive after sound stops. Jitter-buffer delay is one component, not end-to-end or acoustic latency. Tab mute, OS routing, and physical hearing need a separate check.</p></details>
}
