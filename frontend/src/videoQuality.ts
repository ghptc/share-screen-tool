import { measureMedia, sampleReport, type StatsSample } from './mediaStats'

export type VideoTarget = { fps: number; height: number; content?: '' | 'detail' | 'motion' }
export const nativeTarget: VideoTarget = { fps: 60, height: 0 }

export function resolutions(settings?: MediaTrackSettings) {
  const shortEdge = Math.min(settings?.height ?? 0, settings?.width ?? 0)
  return [1440, 1080, 720].filter(height => height < shortEdge)
}

// Keep the consented native input throughout the share. Scale each original
// simulcast layer from its own baseline, including when the user returns to Native.
const original = new WeakMap<RTCRtpSender, number[]>()
export async function applyVideoTarget(sender: RTCRtpSender, settings: MediaTrackSettings, target: VideoTarget) {
  const parameters = sender.getParameters()
  const layers = parameters.encodings
  if (!layers?.length) throw new Error('This browser has no configurable video sender.')
  if (target.height && !resolutions(settings).includes(target.height)) throw new Error('This source is too small for that resolution.')
  const scale = target.height ? Math.min(settings.width!, settings.height!) / target.height : 1
  const ratios = original.get(sender) ?? layers.map(layer => layer.scaleResolutionDownBy ?? 1)
  original.set(sender, ratios)
  let changed = false
  layers.forEach((layer, index) => {
    const ratio = Math.max(1, (ratios[index] ?? 1) * scale)
    if ((layer.scaleResolutionDownBy ?? 1) !== ratio || layer.maxFramerate !== target.fps) {
      layer.scaleResolutionDownBy = ratio
      layer.maxFramerate = target.fps
      changed = true
    }
  })
  if (changed) await sender.setParameters(parameters)
  if (target.content !== undefined && sender.track && 'contentHint' in sender.track)
    sender.track.contentHint = target.content
}

// Reuse the Quality panel's source counters. A slow encoder or congested
// network can also lower output FPS, so never infer an idle desktop from it.
export function observeScreenActivity(sender: RTCRtpSender) {
  const track = sender.track
  if (!track || !('contentHint' in track) || !sender.getStats) return
  let active = true
  let timer: ReturnType<typeof setTimeout>
  let previous: StatsSample | undefined
  let quietSamples = 0
  let movingSamples = 0
  async function poll() {
    try {
      const sample = sampleReport(await sender.getStats())
      if (!active || !track || sender.track !== track) return
      const { captureFps, limitation } = measureMedia(sample, previous, true)
      previous = sample
      // Classify measured input, even when the encoder cannot keep up. Separate
      // entry and exit thresholds keep a borderline cadence from flipping profiles.
      const quiet = captureFps !== undefined && captureFps <= 3 && limitation === 'none'
      quietSamples = quiet ? quietSamples + 1 : 0
      movingSamples = captureFps !== undefined && captureFps >= 24 ? movingSamples + 1 : 0
      let hint = track.contentHint
      if (quietSamples >= 2) hint = 'detail'
      else if (movingSamples >= 3) hint = 'motion'
      else if (captureFps === undefined ||
        (hint === 'detail' && (captureFps > 6 || limitation !== 'none')) ||
        (hint === 'motion' && captureFps < 15)) hint = ''
      if (track.contentHint !== hint) track.contentHint = hint
    } catch {
      previous = undefined
      movingSamples = 0
      quietSamples = 0
      if (active && track) track.contentHint = ''
    } finally {
      if (active) timer = setTimeout(() => void poll(), 2000)
    }
  }
  void poll()
  return () => { active = false; clearTimeout(timer) }
}
