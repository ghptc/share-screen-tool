// Counter samples are per RTP stream ID. Never add simulcast FPS values.
export type MediaStat = RTCStats & {
  kind?: string; mediaType?: string; codecId?: string; mimeType?: string; active?: boolean
  bytesSent?: number; bytesReceived?: number; packetsSent?: number; packetsReceived?: number; packetsLost?: number
  frames?: number; framesDropped?: number; encoderImplementation?: string; qualityLimitationReason?: string; mediaSourceId?: string
  framesEncoded?: number; framesDecoded?: number; frameWidth?: number; frameHeight?: number
  localId?: string; remoteId?: string; fractionLost?: number; roundTripTime?: number
  selectedCandidatePairId?: string; currentRoundTripTime?: number; state?: string; dtlsState?: string
}
export type StatsSample = Map<string, MediaStat>
export type MediaMetrics = {
  direction: 'outbound' | 'inbound'; width?: number; height?: number; fps?: number; bitrateBps?: number
  codec?: string; packetsLost?: number; lossPercent?: number; rttMs?: number; iceState?: string; dtlsState?: string
  captureFps?: number; dropped?: number; encoder?: string; limitation?: string
  layers: number
}
export function sampleReport(report: RTCStatsReport): StatsSample {
  const result: StatsSample = new Map()
  report.forEach(value => result.set(value.id, value as MediaStat))
  return result
}
function finite(value: number | undefined): value is number { return typeof value === 'number' && Number.isFinite(value) }
function delta(row: MediaStat, previous: StatsSample | undefined, field: keyof MediaStat): number | undefined {
  const before = previous?.get(row.id)
  const value = row[field]; const old = before?.[field]
  if (!before || typeof value !== 'number' || typeof old !== 'number' || !Number.isFinite(value) || !Number.isFinite(old)) return
  const elapsed = row.timestamp - before.timestamp
  if (elapsed <= 0 || elapsed > 10000 || value < old) return
  return value - old
}
function perSecond(row: MediaStat, previous: StatsSample | undefined, field: keyof MediaStat): number | undefined {
  const change = delta(row, previous, field)
  const before = previous?.get(row.id)
  return change === undefined || !before ? undefined : change * 1000 / (row.timestamp - before.timestamp)
}
export function measureMedia(current: StatsSample, previous: StatsSample | undefined, local: boolean): MediaMetrics {
  const direction = local ? 'outbound' : 'inbound'
  const streams = [...current.values()].filter(row => {
    if (row.type !== `${direction}-rtp` || (row.kind || row.mediaType) !== 'video' || row.active === false) return false
    const mime = current.get(row.codecId || '')?.mimeType?.toLowerCase()
    return !mime || !/\/(rtx|red|ulpfec|flexfec)/.test(mime)
  })
  const bytes = local ? 'bytesSent' : 'bytesReceived'
  const frames = local ? 'framesEncoded' : 'framesDecoded'
  const active = streams.filter(row => (perSecond(row, previous, bytes) ?? 0) > 0 || (perSecond(row, previous, frames) ?? 0) > 0)
  const best = [...(active.length ? active : streams)].sort((a,b) => (b.frameWidth ?? 0)*(b.frameHeight ?? 0) - (a.frameWidth ?? 0)*(a.frameHeight ?? 0))[0]
  const rates = streams.map(row => perSecond(row, previous, bytes))
  const bitrateBps = rates.length && rates.every(finite) ? rates.reduce((sum, rate) => sum + rate, 0) * 8 : undefined
  const remote = best && [...current.values()].find(row => row.type === 'remote-inbound-rtp' && (row.localId === best.id || best.remoteId === row.id))
  let lossPercent: number | undefined
  let packetsLost: number | undefined
  if (local) {
    packetsLost = remote?.packetsLost
    if (finite(remote?.fractionLost)) lossPercent = Math.max(0, Math.min(1, remote.fractionLost)) * 100
  } else if (best) {
    packetsLost = best.packetsLost
    const received = delta(best, previous, 'packetsReceived')
    const before = previous?.get(best.id)
    // Late packets can reduce the cumulative lost counter; do not report negative loss.
    if (finite(received) && finite(best.packetsLost) && finite(before?.packetsLost)) {
      const lost = Math.max(0, best.packetsLost - before.packetsLost)
      if (received + lost > 0) lossPercent = lost * 100 / (received + lost)
    }
  }
  const transport = [...current.values()].find(row => row.type === 'transport' && row.selectedCandidatePairId)
  const pair = current.get(transport?.selectedCandidatePairId || '')
  const rtt = remote?.roundTripTime ?? pair?.currentRoundTripTime
  const source = current.get(best?.mediaSourceId || '')
  return { direction, captureFps: source ? perSecond(source, previous, 'frames') : undefined, dropped: best?.framesDropped, encoder: best?.encoderImplementation, limitation: best?.qualityLimitationReason, width: best?.frameWidth, height: best?.frameHeight,
    fps: best ? perSecond(best, previous, frames) : undefined, bitrateBps,
    codec: current.get(best?.codecId || '')?.mimeType, packetsLost, lossPercent,
    rttMs: finite(rtt) && rtt >= 0 ? rtt * 1000 : undefined,
    iceState: pair?.state, dtlsState: transport?.dtlsState, layers: streams.length }
}
