// The application exchanges only room-scoped handles and WebRTC descriptions.
export type Signal = (
  op: string,
  request: Record<string, unknown>,
) => Promise<{ handle: string; sdp: string }>

export class ScreenIceGatheringTimeout extends Error {}

async function localSDP(
  pc: RTCPeerConnection,
  description: RTCSessionDescriptionInit,
  timeoutError?: () => Error,
) {
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
      const timer = setTimeout(() => {
        done(timeoutError?.() ?? new Error('ICE gathering timed out'))
      }, 8000)
      pc.addEventListener('icegatheringstatechange', finish)
      finish()
    })
  }
  return pc.localDescription!.sdp
}

async function screenOfferSDP(pc: RTCPeerConnection) {
  const offer = await pc.createOffer()
  const started = performance.now()
  let completeEvent = false
  let endOfCandidates = false
  const onState = () => {
    if (pc.iceGatheringState === 'complete') completeEvent = true
  }
  const onCandidate = (event: RTCPeerConnectionIceEvent) => {
    if (event.candidate === null) endOfCandidates = true
  }
  function report() {
    // Project the current offer onto a fixed vocabulary. Never log the peer, SDP or ICE events.
    const types = new Set<string>()
    for (const line of pc.localDescription?.sdp.split(/\r?\n/) ?? []) {
      if (!line.startsWith('a=candidate:')) continue
      const fields = line.split(/\s+/)
      if (fields[6] === 'typ' && ['host', 'srflx', 'prflx', 'relay'].includes(fields[7]))
        types.add(fields[7])
    }
    const state = pc.iceGatheringState
    const stateLabel = ['new', 'gathering', 'complete'].includes(state) ? state : 'unknown'
    const summary = `Gathering state: ${stateLabel}. Elapsed: ${Math.round(performance.now() - started)} ms. ` +
      `Candidate types: ${[...types].join(', ') || 'none'}. ` +
      `Complete event: ${completeEvent}. Null candidate event: ${endOfCandidates}.`
    console.debug('Screen ICE. ' + summary)
    return summary
  }
  pc.addEventListener('icegatheringstatechange', onState)
  pc.addEventListener('icecandidate', onCandidate)
  try {
    const sdp = await localSDP(pc, offer, () => new ScreenIceGatheringTimeout(
      'Screen sharing timed out waiting for ICE. ' + report(),
    ))
    report()
    return sdp
  } finally {
    pc.removeEventListener('icegatheringstatechange', onState)
    pc.removeEventListener('icecandidate', onCandidate)
  }
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
  const sdp = await screenOfferSDP(pc)
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
