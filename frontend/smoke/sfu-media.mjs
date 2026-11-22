// TestTwoBrowserMedia starts a TLS loopback origin and passes short-lived app
// sessions over stdin. Only aggregate playback measurements go to stdout.
import { chromium, firefox } from 'playwright'
import { readFileSync } from 'node:fs'

const {origin, ref, cookies, hosted} = JSON.parse(readFileSync(0, 'utf8'))
const engine = process.env.E2E_BROWSER === 'firefox' ? firefox : chromium
let browser
let stage = 'launch'

async function measure(page, i) {
  const deadline = Date.now() + 16000
  while (Date.now() < deadline) {
    const result = await page.evaluate(async i => {
      const video = document.querySelector('[aria-label="Remote screen"] video')
      if (video?.videoWidth !== 320 || video.videoHeight !== 180) return
      const pc = window.testPeers.find(p => p.connectionState === 'connected' && p.getTransceivers().some(t => t.currentDirection === 'recvonly'))
      if (!pc) return
      const v = Array.from((await pc.getStats()).values()).find(s => s.type === 'inbound-rtp' && s.kind === 'video')
      if (!(v?.framesDecoded >= 12) || !v.bytesReceived) return
      const probe = document.createElement('canvas').getContext('2d')
      probe.drawImage(video,0,0,1,1)
      const [r,,b] = probe.getImageData(0,0,1,1).data
      if (i ? r-b < 100 : b-r < 100) return
      return {frames:v.framesDecoded, bytes:v.bytesReceived, width:video.videoWidth, height:video.videoHeight}
    }, i)
    if (result) return result
    await new Promise(resolve => setTimeout(resolve,100))
  }
  throw Error('Remote playback timed out')
}

try {
  browser = await engine.launch({headless:true, chromiumSandbox:true})
  const pages = await Promise.all(cookies.map(async (value, i) => {
    const ctx = await browser.newContext({ignoreHTTPSErrors:true})
    await ctx.addCookies([{name:'__Host-wl-session', value, url:origin, secure:true, httpOnly:true, sameSite:'Strict'}])
    await ctx.addInitScript(({i, hosted}) => {
      window.captureCount = 0
      window.testPeers = []
      const Peer = window.RTCPeerConnection
      window.RTCPeerConnection = class extends Peer {
        constructor(config) {
          super(hosted ? config : {iceServers:[]})
          window.testPeers.push(this)
        }
        addTransceiver(track, options) {
          const t = super.addTransceiver(track, {...options, sendEncodings:[{maxBitrate:160000, maxFramerate:10}]})
          t.setCodecPreferences(RTCRtpSender.getCapabilities('video').codecs.filter(c => c.mimeType.toLowerCase() === 'video/vp8'))
          return t
        }
      }
      navigator.mediaDevices.getDisplayMedia = async constraints => {
        if (constraints.audio !== false || constraints.video.frameRate.ideal !== 60) throw Error('Unexpected capture constraints')
        window.captureCount++
        const canvas = document.createElement('canvas')
        canvas.width=320
        canvas.height=180
        const ctx=canvas.getContext('2d')
        let frame=0
        const paint=()=>{
          ctx.fillStyle=i?'#2020ec':'#ec2020'
          ctx.fillRect(0,0,320,180)
          ctx.fillStyle='white'
          ctx.fillRect(frame++ % 200,10,8,8)
        }
        paint()
        setInterval(paint,100)
        window.testCapture=canvas.captureStream(10)
        return window.testCapture
      }
    },{i,hosted})
    const page = await ctx.newPage()
    await page.goto(origin+'/r/'+ref)
    await page.getByRole('button',{name:'Start sharing'}).waitFor({timeout:10000})
    if (await page.evaluate(()=>window.captureCount !== 0)) throw Error('Capture before consent')
    return page
  }))
  stage='publish'
  await Promise.all(pages.map(p=>p.getByRole('button',{name:'Start sharing'}).click()))
  stage='remote playback'
  const results=await Promise.all(pages.map(measure))
  stage='stop'
  await pages[1].getByRole('button',{name:'Stop sharing'}).click()
  await pages[0].getByRole('article',{name:'Remote screen'}).waitFor({state:'detached',timeout:10000})
  if(await pages[1].evaluate(()=>window.testCapture.getTracks().some(t=>t.readyState!=='ended'))) throw Error('Capture remained live')
  stage='voice departure'
  // The Go driver delivers the event over the fixture's private voice authority.
  console.log('switch-publisher-channel')
  await pages[0].getByRole('heading',{name:'Player unavailable'}).waitFor({timeout:12000})
  await pages[1].getByRole('heading',{name:'No active screens'}).waitFor({timeout:10000})
  if(await pages[0].evaluate(()=>window.testCapture.getTracks().some(t=>t.readyState!=='ended'))) throw Error('Revoked capture remained live')
  console.log(JSON.stringify({browser:engine.name(),received:results,explicitStop:true,voiceDeparture:true}))
} catch {
  console.log('Failure during '+stage)
  process.exitCode=1
} finally {await browser?.close()}
