import { useEffect, useState, type RefObject } from 'react'
import type { TrackPublication } from 'livekit-client'
import { measureMedia, sampleReport, type MediaMetrics, type StatsSample } from './mediaStats'

type View = { metrics?: MediaMetrics; width?: number; height?: number; visible: boolean; background: boolean; enabled?: boolean; sampledAt?: string }
export default function MediaDiagnostics({ track, local, video, enabled, connected }: {
  track: TrackPublication['videoTrack']; local: boolean; video: RefObject<HTMLVideoElement | null>; enabled?: () => boolean; connected: boolean
}) {
  const [view, setView] = useState<View>({ visible: false, background: false })
  const [copyStatus, setCopyStatus] = useState('')
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let previous: StatsSample | undefined
    let visible = false
    const element = video.current
    const observer = element && typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0)
    }) : undefined
    if (element) observer?.observe(element)
    async function poll() {
      try {
        const report = connected && track?.getRTCStatsReport ? await track.getRTCStatsReport() : undefined
        if (disposed) return
        const current = report ? sampleReport(report) : undefined
        const metrics = current ? measureMedia(current, previous, local) : undefined
        previous = current
        const rect = element?.getBoundingClientRect()
        const inViewport = observer ? visible : !!rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth
        setView({ metrics, width: !local && element?.videoWidth ? element.videoWidth : metrics?.width,
          height: !local && element?.videoHeight ? element.videoHeight : metrics?.height,
          visible: inViewport, background: document.visibilityState !== 'visible', enabled: enabled?.(), sampledAt: new Date().toISOString() })
      } catch {
        previous = undefined
        if (!disposed) setView({ visible, background: document.visibilityState !== 'visible' })
      } finally { if (!disposed) timer = setTimeout(() => void poll(), 2000) }
    }
    void poll()
    return () => { disposed = true; if (timer) clearTimeout(timer); observer?.disconnect() }
  }, [track, local, video, connected, enabled])
  const format = (value: number | undefined, digits = 1) => value !== undefined && Number.isFinite(value) ? value.toFixed(digits) : 'unavailable'
  const m = view.metrics
  async function copy() {
    try { await navigator.clipboard.writeText(JSON.stringify({ ...view, connection: connected ? 'connected' : 'not connected', local }, null, 2)); setCopyStatus('Diagnostics copied') }
    catch { setCopyStatus('Clipboard unavailable') }
  }
  return <details className="media-diagnostics">
    <summary>Runtime diagnostics</summary>
    <dl>
      <div><dt>{local ? 'Encoded resolution' : 'Decoded resolution'}</dt><dd>{view.width && view.height ? `${view.width} × ${view.height}` : 'unavailable'}</dd></div>
      <div><dt>{local ? 'Encoded FPS (largest active layer)' : 'Decoded FPS'}</dt><dd>{format(m?.fps)}</dd></div>
      <div><dt>Video RTP bitrate</dt><dd>{m?.bitrateBps === undefined ? 'unavailable' : `${format(m.bitrateBps / 1000)} kb/s`}</dd></div>
      <div><dt>Negotiated codec</dt><dd>{m?.codec ?? 'unavailable'}</dd></div>
      <div><dt>{local ? 'SFU-reported loss (latest RTCP)' : 'Packet loss (sample interval)'}</dt><dd>{m?.lossPercent === undefined ? 'unavailable' : `${format(m.lossPercent)}%`}</dd></div>
      <div><dt>{local ? 'SFU-reported packets lost (layer total)' : 'Packets lost (total)'}</dt><dd>{format(m?.packetsLost, 0)}</dd></div>
      <div><dt>RTT to SFU</dt><dd>{m?.rttMs === undefined ? 'unavailable' : `${format(m.rttMs)} ms`}</dd></div>
      <div><dt>ICE / DTLS</dt><dd>{m?.iceState ?? 'unavailable'} / {m?.dtlsState ?? 'unavailable'}</dd></div>
      <div><dt>Video in viewport / tab visible</dt><dd>{view.visible ? 'yes' : 'no'} / {view.background ? 'no' : 'yes'}</dd></div>
      {!local && <div><dt>Subscription enabled</dt><dd>{view.enabled === undefined ? 'unavailable' : view.enabled ? 'yes' : 'no (adaptive pause)'}</dd></div>}
    </dl>
    <p className="note">Two-second samples. FPS and bitrate use counter deltas; missing/reset reports show unavailable. Outbound bitrate sums primary simulcast layers; outbound FPS describes one layer. RTT is not end-to-end latency.</p>
    <button onClick={() => void copy()}>Copy diagnostics</button>
    {copyStatus && <p role="status">{copyStatus}</p>}
  </details>
}
