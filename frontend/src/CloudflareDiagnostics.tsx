import { Fragment, useEffect, useState, type RefObject } from 'react'
import { measureMedia, sampleReport, type StatsSample } from './mediaStats'

type Props = {
  pc: RTCPeerConnection
  local: boolean
  audio: boolean
  label: string
  stream?: MediaStream
  root: RefObject<HTMLDivElement | null>
}
type Row = [string, string]
const unknown = 'Unavailable'
function number(n?: number, digits = 1) {
  return n !== undefined && Number.isFinite(n) ? n.toFixed(digits) : unknown
}
function kbps(n?: number) { return n === undefined ? unknown : number(n / 1000, 0) }
function size(width?: number, height?: number) { return width && height ? `${width} × ${height}` : unknown }

// Playback quality counts displayed and discarded frames since element creation.
function displayedFps(now?: VideoPlaybackQuality, before?: VideoPlaybackQuality) {
  if (!now || !before) return
  const ms = now.creationTime - before.creationTime
  const total = now.totalVideoFrames - before.totalVideoFrames
  const dropped = now.droppedVideoFrames - before.droppedVideoFrames
  if (ms > 0 && ms <= 10000 && dropped >= 0 && total >= dropped) return (total - dropped) * 1000 / ms
}

export default function CloudflareDiagnostics({ pc, local, audio, label, stream, root }: Props) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<Row[]>([])
  useEffect(() => {
    setRows([])
    if (!open) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    let previous: StatsSample | undefined
    let playback: VideoPlaybackQuality | undefined
    let lastVideo: HTMLVideoElement | undefined
    let replacements = 0
    async function poll() {
      try {
        const current = sampleReport(await pc.getStats())
        if (!active) return
        const m = measureMedia(current, previous, local, audio ? 'audio' : 'video')
        previous = current
        const sender = local ? pc.getSenders().find(s => s.track?.kind === (audio ? 'audio' : 'video')) : undefined
        const element = stream && Array.from(root.current?.querySelectorAll<HTMLMediaElement>(audio ? 'audio' : 'video') ?? [])
          .find(el => el.srcObject === stream)
        const next: Row[] = [
          ['Sample time (UTC)', new Date().toISOString()],
          ['Peer / codec', `${pc.connectionState} / ${m.codec ?? unknown}`],
          ['RTP bitrate (kb/s)', kbps(m.bitrateBps)],
          [local ? 'SFU-reported loss (%)' : 'Packet loss (%)', number(m.lossPercent)],
          [local ? 'SFU-reported jitter (ms)' : 'Receiver jitter (ms)', number(m.jitterMs)],
          ['RTT to SFU (ms)', number(m.rttMs)],
        ]
        if (audio) {
          const track = local ? sender?.track : pc.getReceivers().find(r => r.track.kind === 'audio')?.track
          if (track) next.push([local ? 'Source track' : 'Receiver track',
            `${track.readyState} · ${track.enabled ? 'enabled' : 'disabled'} · ${track.muted ? 'muted' : 'unmuted'}`])
          next.push([local ? 'Packets sent/s' : 'Packets received/s', number(m.packetsPerSecond)],
            [local ? 'Source energy Δ' : 'Received audio energy Δ', number(m.audioEnergyDelta, 6)])
          if (element) next.push(['Local playback', `${element.paused ? 'Paused' : 'Playing'} · ${element.muted ? 'muted' : Math.round(element.volume * 100) + '%'}`])
        } else if (local) {
          const settings = sender?.track?.getSettings()
          const encoding = sender?.getParameters().encodings[0]
          next.push(['Capture size / configured FPS', `${size(settings?.width, settings?.height)} / ${number(settings?.frameRate)}`],
            ['Measured capture / encoded / sent FPS', [m.captureFps, m.fps, m.transportFps].map(n => number(n)).join(' / ')],
            ['Encoded size / sender FPS limit', `${size(m.width, m.height)} / ${number(encoding?.maxFramerate)}`],
            ['Bitrate cap (kb/s)', encoding && encoding.maxBitrate === undefined ? 'No explicit cap' : kbps(encoding?.maxBitrate)],
            ['Encoder target / estimated uplink (kb/s)', `${kbps(m.targetBps)} / ${kbps(m.availableBps)}`],
            ['Encoder / quality limitation', `${m.encoder ?? unknown} / ${m.limitation ?? unknown}`])
        } else {
          const video = element as HTMLVideoElement | undefined
          const quality = video?.getVideoPlaybackQuality?.()
          const fps = video === lastVideo ? displayedFps(quality, playback) : undefined
          if (video && lastVideo && video !== lastVideo) replacements++
          if (video) lastVideo = video
          playback = quality
          next.push(['Received / decoded / displayed FPS', [m.transportFps, m.fps, fps].map(n => number(n)).join(' / ')],
            ['Decoded size', size(m.width, m.height)],
            ['Receiver frame interval SD (ms)', number(m.frameIntervalDeviationMs)],
            ['Receiver drops / freezes (totals)', `${number(m.dropped, 0)} / ${number(m.freezes, 0)}`],
            ['Player dropped frames (total)', number(quality?.droppedVideoFrames, 0)],
            ['Video element replacements observed', number(replacements, 0)])
        }
        if (!audio) {
          const rect = element?.getBoundingClientRect()
          const visible = rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth
          next.push(['Tab / tile', `${document.visibilityState} / ${!rect ? unknown : visible ? 'in viewport' : 'offscreen'}`])
        }
        setRows(next)
      } catch {
        previous = undefined
        playback = undefined
        if (active) setRows([['WebRTC statistics', unknown]])
      } finally {
        if (active) timer = setTimeout(() => void poll(), 2000)
      }
    }
    void poll()
    return () => { active = false; clearTimeout(timer) }
  }, [pc, local, audio, stream, open, root])

  return <details onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>{label} {audio ? 'audio' : 'video'} diagnostics</summary>
    <dl>{rows.map(([name, value]) => <Fragment key={name}><dt>{name}</dt><dd>{value}</dd></Fragment>)}</dl>
  </details>
}
