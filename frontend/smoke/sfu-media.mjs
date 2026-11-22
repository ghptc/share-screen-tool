// Run by TestTwoBrowserMedia. Only aggregate measurements go to stdout.
import { chromium, firefox } from 'playwright'
import { readFileSync } from 'node:fs'
const {origin, keys, hosted} = JSON.parse(readFileSync(0, 'utf8'))
const engine = process.env.E2E_BROWSER === 'firefox' ? firefox : chromium
let browser
let stage = 'launch'
try {
  browser = await engine.launch({headless:true, chromiumSandbox:true})
  const pages = await Promise.all(keys.map(async value => {
    const ctx = await browser.newContext()
    await ctx.addCookies([{name:'test-peer', value, url:origin, httpOnly:true, sameSite:'Strict'}])
    const page = await ctx.newPage()
    await page.goto(origin)
    return page
  }))
  stage = 'publish'
  await Promise.all(pages.map((page,i) => page.evaluate(async ({i,hosted}) => {
    const {publish,subscribe} = await import('/peer.js')
    const config = {iceServers:hosted ? [{urls:'stun:stun.cloudflare.com:3478'}] : []}
    const pc = new RTCPeerConnection(config)
    const canvas = document.createElement('canvas')
    canvas.width=320; canvas.height=180
    const ctx=canvas.getContext('2d')
    let frame=0
    const paint=()=>{ctx.fillStyle=i?'#2020ec':'#ec2020'; ctx.fillRect(0,0,320,180); ctx.fillStyle='white';ctx.fillRect(frame++ % 200,10,8,8)}
    paint();setInterval(paint,100)
    const send=async(op,data)=>{
      const r=await fetch('/signal/'+op,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
      if(!r.ok) throw Error('signaling failed')
      return r.json()
    }
    const stream=canvas.captureStream(10)
    const tx=pc.addTransceiver.bind(pc)
    // Force VP8 so the local packet forwarder never transcodes either direction.
    pc.addTransceiver=(...args)=>{const t=tx(...args);t.setCodecPreferences(RTCRtpSender.getCapabilities('video').codecs.filter(c=>c.mimeType.toLowerCase()==='video/vp8'));return t}
    await publish(pc,stream.getVideoTracks()[0],send,{maxBitrate:160000,maxFramerate:10})
    window.pub=pc
    window.receive=async()=>{
      const rx=new RTCPeerConnection(config),video=document.createElement('video')
      video.muted=true;video.autoplay=true;video.playsInline=true;document.body.append(video)
      window.rx=rx
      await subscribe(rx,'other',video,send)
      await video.play()
    }
  },{i,hosted})))
  await Promise.all(pages.map(page=>page.waitForFunction(()=>window.pub.connectionState==='connected',null,{timeout:12000})))
  stage = 'subscribe'
  await Promise.all(pages.map(page=>page.evaluate(()=>window.receive())))
  stage = 'remote playback'
  const results=await Promise.all(pages.map(async(page,i)=>{
    const deadline=Date.now()+14000
    while(Date.now()<deadline){
      const measure=await page.evaluate(async i=>{
      const stats=Array.from((await window.rx.getStats()).values())
      const v=stats.find(s=>s.type==='inbound-rtp'&&s.kind==='video')
      const video=document.querySelector('video')
      if(!v || !(v.framesDecoded>=12) || !v.bytesReceived || video.videoWidth!==320) return false
      const probe=document.createElement('canvas').getContext('2d')
      probe.drawImage(video,0,0,1,1)
      const [r,,b]=probe.getImageData(0,0,1,1).data
      if(i ? r-b<100 : b-r<100) return false
      return {frames:v.framesDecoded,bytes:v.bytesReceived,width:video.videoWidth,height:video.videoHeight}
      },i)
      if(measure) return measure
      await new Promise(resolve=>setTimeout(resolve,100))
    }
    throw Error("No decoded remote video")
  }))
  console.log(JSON.stringify({browser:engine.name(),received:results}))
} catch {
  console.log('Failure during '+stage)
  process.exitCode=1
} finally {await browser?.close()}
