// The application exchanges only Whiterun handles and WebRTC descriptions.
export type Signal = (
  op: string,
  request: Record<string, unknown>,
) => Promise<{ handle: string; sdp: string }>

async function localSDP(pc: RTCPeerConnection, description: RTCSessionDescriptionInit) {
  await pc.setLocalDescription(description)
  if (pc.iceGatheringState !== 'complete') {
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        if (pc.iceGatheringState === 'complete') done()
      }
      const done = (error?: Error) => {
        clearTimeout(timer)
        pc.removeEventListener('icegatheringstatechange', finish)
        error ? reject(error) : resolve()
      }
      const timer = setTimeout(() => done(new Error('ICE gathering timed out')), 8000)
      pc.addEventListener('icegatheringstatechange', finish)
      finish()
    })
  }
  return pc.localDescription!.sdp
}
export async function publish(
  pc: RTCPeerConnection,
  track: MediaStreamTrack,
  send: Signal,
  encoding?: RTCRtpEncodingParameters,
) {
  const tx = pc.addTransceiver(track, {
    direction: 'sendonly',
    ...(encoding && { sendEncodings: [encoding] }),
  })
  const sdp = await localSDP(pc, await pc.createOffer())
  const result = await send('publish', { mid: tx.mid, sdp })
  await pc.setRemoteDescription({ type: 'answer', sdp: result.sdp })
  return result.handle
}
export async function subscribe(
  pc: RTCPeerConnection,
  publication: string,
  onTrack: (track: MediaStreamTrack) => void,
  send: Signal,
) {
  pc.ontrack = ({ track }) => onTrack(track)
  const result = await send('subscribe', { publication })
  await pc.setRemoteDescription({ type: 'offer', sdp: result.sdp })
  const receiver = pc.getTransceivers().find((t) => t.receiver.track.kind === 'audio')
  if (receiver) {
    const opus = RTCRtpReceiver.getCapabilities('audio')?.codecs.filter(
      (c) => c.mimeType.toLowerCase() === 'audio/opus',
    )
    if (!opus?.length) throw new Error('Opus playback unavailable')
    receiver.setCodecPreferences(opus)
  }
  const answer = await pc.createAnswer()
  if (receiver && answer.sdp) {
    // Opus defaults to a mono receiver unless the answer advertises stereo.
    // Each SFU peer negotiates exactly one track.
    const payload = /^a=rtpmap:(\d+) opus\/48000\/2\r?$/im.exec(answer.sdp)?.[1]
    if (!payload) throw new Error('Stereo Opus unavailable')
    const lines = answer.sdp.split('\r\n')
    const prefix = 'a=fmtp:' + payload + ' '
    const index = lines.findIndex((line) => line.startsWith(prefix))
    const params =
      index < 0
        ? []
        : lines[index]
            .slice(prefix.length)
            .split(';')
            .filter((p) => !/^stereo=/i.test(p.trim()))
    const fmtp = prefix + [...params, 'stereo=1'].join(';')
    if (index < 0)
      lines.splice(lines.findIndex((line) => line.startsWith('a=rtpmap:' + payload + ' ')) + 1, 0, fmtp)
    else lines[index] = fmtp
    answer.sdp = lines.join('\r\n')
  }
  const sdp = await localSDP(pc, answer)
  await send('answer', { handle: result.handle, sdp })
  return result.handle
}
