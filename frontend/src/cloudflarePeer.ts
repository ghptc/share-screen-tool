// The application exchanges only room-scoped handles and WebRTC descriptions.
export type Signal = (
  op: string,
  request: Record<string, unknown>,
) => Promise<{ handle: string; sdp: string }>

export class ScreenIceGatheringError extends Error {}

async function waitForGathering(pc: RTCPeerConnection, cancel?: AbortSignal) {
  cancel?.throwIfAborted()
  if (pc.iceGatheringState === 'complete') return true
  return new Promise<boolean>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', onState)
      cancel?.removeEventListener('abort', onAbort)
    }
    const onState = () => {
      if (pc.iceGatheringState === 'complete') {
        cleanup()
        resolve(true)
      }
    }
    const onAbort = () => {
      cleanup()
      reject(cancel?.reason)
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve(false)
    }, 8000)
    pc.addEventListener('icegatheringstatechange', onState)
    cancel?.addEventListener('abort', onAbort)
    onState()
  })
}

async function localSDP(pc: RTCPeerConnection, description: RTCSessionDescriptionInit) {
  await pc.setLocalDescription(description)
  if (!await waitForGathering(pc)) throw new Error('ICE gathering timed out')
  return pc.localDescription!.sdp
}

// The screen peer has one send-only video transceiver. Count RTP candidates from
// its browser-generated offer, including host candidates represented by mDNS.
function candidateTypes(sdp: string) {
  const types = new Set<string>()
  for (const line of sdp.split(/\r?\n/)) {
    const candidate = /^a=candidate:\S+\s+1\s+(?:udp|tcp)\s+\d+\s+\S+\s+(\d+)\s+typ\s+(host|srflx|prflx|relay)(?:\s|$)/i.exec(line)
    if (candidate && Number(candidate[1]) > 0 && Number(candidate[1]) <= 65535)
      types.add(candidate[2].toLowerCase())
  }
  return types
}

async function screenOfferSDP(pc: RTCPeerConnection, cancel?: AbortSignal) {
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
  pc.addEventListener('icegatheringstatechange', onState)
  pc.addEventListener('icecandidate', onCandidate)
  try {
    await pc.setLocalDescription(offer)
    const complete = await waitForGathering(pc, cancel)
    cancel?.throwIfAborted()
    // The SFU gets this single offer snapshot. Later candidates are never signaled.
    const local = pc.localDescription
    const types = candidateTypes(local?.sdp ?? '')
    const state = pc.iceGatheringState
    const stateLabel = ['new', 'gathering', 'complete'].includes(state) ? state : 'unknown'
    const summary = `Gathering state: ${stateLabel}. Elapsed: ${Math.round(performance.now() - started)} ms. ` +
      `Candidate types: ${[...types].join(', ') || 'none'}. ` +
      `Complete event: ${completeEvent}. Null candidate event: ${endOfCandidates}.`
    console.debug('Screen ICE. ' + summary)
    if (local?.type !== 'offer' || types.size === 0) {
      const message = complete
        ? 'Screen sharing found no usable ICE candidate.'
        : 'Screen sharing timed out waiting for ICE.'
      throw new ScreenIceGatheringError(message + ' ' + summary)
    }
    return local.sdp
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
  cancel?: AbortSignal,
) {
  const tx = pc.addTransceiver(track, {
    direction: 'sendonly',
    ...(encoding && { sendEncodings: [encoding] }),
  })
  const sdp = await screenOfferSDP(pc, cancel)
  cancel?.throwIfAborted()
  if (track.readyState !== 'live' || pc.connectionState === 'closed' || pc.connectionState === 'failed')
    throw new DOMException('Screen sharing ended.', 'AbortError')
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
