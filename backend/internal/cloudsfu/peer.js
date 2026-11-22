// The application exchanges only Whiterun handles and WebRTC descriptions.
export async function localSDP(pc, description) {
  await pc.setLocalDescription(description)
  if (pc.iceGatheringState !== 'complete') {
    await new Promise((resolve, reject) => {
      const finish = () => {
        if (pc.iceGatheringState === 'complete') done()
      }
      const done = (error) => {
        clearTimeout(timer)
        pc.removeEventListener('icegatheringstatechange', finish)
        error ? reject(error) : resolve()
      }
      const timer = setTimeout(() => done(new Error('ICE gathering timed out')), 8000)
      pc.addEventListener('icegatheringstatechange', finish)
      finish()
    })
  }
  return pc.localDescription.sdp
}
export async function publish(pc, track, send, encoding) {
  const tx = pc.addTransceiver(track, {direction: 'sendonly', ...(encoding && {sendEncodings:[encoding]})})
  const sdp = await localSDP(pc, await pc.createOffer())
  const result = await send('publish', {mid: tx.mid, sdp})
  await pc.setRemoteDescription({type: 'answer', sdp: result.sdp})
  return result.handle
}
export async function subscribe(pc, publication, element, send) {
  pc.ontrack = ({track}) => { element.srcObject = new MediaStream([track]) }
  const result = await send('subscribe', {publication})
  await pc.setRemoteDescription({type: 'offer', sdp: result.sdp})
  const sdp = await localSDP(pc, await pc.createAnswer())
  await send('answer', {handle: result.handle, sdp})
  return result.handle
}
