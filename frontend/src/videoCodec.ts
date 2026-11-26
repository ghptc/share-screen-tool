// Only prefer formats already advertised by this sender. Keep all negotiated
// fallback and repair formats, including the browser's original profile order.
const videoCodecs = ['H264', 'VP8', 'VP9', 'AV1'] as const
export type VideoCodec = typeof videoCodecs[number]
export function supportedVideoCodecs() {
  const codecs = globalThis.RTCRtpSender?.getCapabilities?.('video')?.codecs ?? []
  return videoCodecs.filter(name => codecs.some(c => c.mimeType.toLowerCase() === 'video/' + name.toLowerCase()))
}

export type CodecPreference = VideoCodec | 'auto' | 'browser'

async function automaticCodec(codecs: RTCRtpCodec[], settings: MediaTrackSettings, fps?: number): Promise<VideoCodec | undefined> {
  // The tested concurrency cliff was Chromium software VP8 at native 1080p60.
  // Outside that workload retain the browser's ordering.
  if (settings.width !== 1920 || settings.height !== 1080 ||
      fps !== 60 || (settings.frameRate !== undefined && settings.frameRate < 59) ||
      codecs[0]?.mimeType.toLowerCase() !== 'video/vp8' || !codecs.some(c => c.mimeType.toLowerCase() === 'video/h264') ||
      !/Chrom(?:e|ium)\//.test(navigator.userAgent) || !navigator.mediaCapabilities?.encodingInfo) return
  const query = (contentType: string) => navigator.mediaCapabilities.encodingInfo({ type: 'webrtc',
    // Reference workload for querying capabilities only. This sets no sender bitrate.
    video: { contentType, width: 1920, height: 1080, framerate: 60, bitrate: 8_000_000 } })
  let timer: number | undefined
  try {
    const result = await Promise.race([
      Promise.all([query('video/VP8'), query('video/H264')]),
      new Promise<undefined>(resolve => { timer = window.setTimeout(() => resolve(undefined), 250) }),
    ])
    if (result) {
      const [vp8, h264] = result
      if (vp8.supported && vp8.powerEfficient === false && h264.supported && h264.smooth) return 'H264'
    }
  } catch { /* The WebRTC capability query is optional. */ }
  finally { clearTimeout(timer) }
}

export async function configureVideoCodec(tx: RTCRtpTransceiver, preference: CodecPreference, settings: MediaTrackSettings, fps?: number) {
  if (preference === 'browser' || !tx.setCodecPreferences) return
  const codecs = globalThis.RTCRtpSender?.getCapabilities?.('video')?.codecs ?? []
  const name = preference === 'auto' ? await automaticCodec(codecs, settings, fps) : preference
  if (!name) return
  const matches = (codec: RTCRtpCodec) => codec.mimeType.toLowerCase() === 'video/' + name.toLowerCase()
  const preferred = codecs.filter(matches)
  if (preferred.length) {
    try { tx.setCodecPreferences([...preferred, ...codecs.filter(c => !matches(c))]) }
    catch { /* Some browsers reject reordering profiles. Use their default offer. */ }
  }
}
