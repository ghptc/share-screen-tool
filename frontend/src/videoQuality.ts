export type VideoTarget = { fps: number; height: number }
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
  layers.forEach((layer, index) => {
    layer.scaleResolutionDownBy = Math.max(1, (ratios[index] ?? 1) * scale)
    layer.maxFramerate = target.fps
  })
  await sender.setParameters(parameters)
}
