import { frontend } from './built-frontend'
import { test, expect, firefox, type BrowserContext, type Page, type WebSocketRoute } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Capture is generated, not desktop/PipeWire audio. Everything after capture is real.
async function generatedAudio(context: BrowserContext) {
  await frontend(context, process.env.E2E_BASE_URL || 'http://localhost:5173')
  await context.addInitScript(() => {
    const peers: RTCPeerConnection[] = []
    const NativePeer = window.RTCPeerConnection
    window.RTCPeerConnection = class extends NativePeer {
      constructor(configuration?: RTCConfiguration) { super(configuration); peers.push(this) }
    }
    const state = { calls: 0, streams: [] as MediaStream[], peers, contexts: [] as AudioContext[] }
    Object.assign(window, { __audioTest: state })
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async (options: DisplayMediaStreamOptions) => {
      state.calls++
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
      const ctx = canvas.getContext('2d')!
      let frame = 0
      const timer = setInterval(() => { ctx.fillStyle = frame++ % 2 ? 'navy' : 'green'; ctx.fillRect(0, 0, 320, 180) }, 100)
      ctx.fillRect(0, 0, 320, 180)
      const stream = canvas.captureStream(10)
      const video = stream.getVideoTracks()[0], stopVideo = video.stop.bind(video)
      video.stop = () => { clearInterval(timer); stopVideo() }
      if (options.audio) {
        const videoSettings = video.getSettings.bind(video)
        video.getSettings = () => ({ ...videoSettings(), displaySurface: 'browser' })
        const audio = new AudioContext(); state.contexts.push(audio)
        const oscillator = audio.createOscillator(), gain = audio.createGain(), destination = audio.createMediaStreamDestination()
        gain.gain.value = .025; oscillator.frequency.value = 440
        oscillator.connect(gain).connect(destination); oscillator.start(); await audio.resume()
        const track = destination.stream.getAudioTracks()[0], stop = track.stop.bind(track)
        const audioSettings = track.getSettings.bind(track)
        track.getSettings = () => ({ ...audioSettings(), restrictOwnAudio: true })
        let stopped = false
        track.stop = () => { if (stopped) return; stopped = true; stop(); oscillator.stop(); void audio.close() }
        stream.addTrack(track)
      }
      state.streams.push(stream); return stream
    } })
  })
}
async function audioStats(page: Page) {
  return page.evaluate(async () => {
    const state = (window as unknown as { __audioTest: { peers: RTCPeerConnection[] } }).__audioTest
    const result: { packets: number; energy: number; codec: string }[] = []
    for (const peer of state.peers) {
      if (peer.connectionState === 'closed') continue
      const stats = await peer.getStats()
      stats.forEach(report => {
        if (report.type === 'inbound-rtp' && (report.kind === 'audio' || report.mediaType === 'audio')) result.push({ packets: report.packetsReceived ?? 0, energy: report.totalAudioEnergy ?? 0, codec: stats.get(report.codecId)?.mimeType ?? 'unknown' })
      })
    }
    return result
  })
}
async function create(page: Page, baseURL: string) {
  await page.goto(new URL('/rooms', baseURL).href)
  await page.getByLabel('Display name').fill('Alice audio')
  await page.getByLabel('Room title', { exact: true }).fill('Generated audio transport')
  const key = process.env.E2E_OPERATOR_KEY || readFileSync(new URL('../../.env', import.meta.url), 'utf8').match(/^LOCAL_ADMIN_KEY=(.+)$/m)?.[1] || ''
  await page.getByLabel('Local operator key').fill(key)
  await page.getByRole('button', { name: 'Create and join room' }).click()
  await expect(page.getByRole('heading', { name: 'Participants (1)' })).toBeVisible()
}
async function join(page: Page, link: string, name: string) {
  await page.goto(link); await page.getByLabel('Display name').fill(name)
  await page.getByRole('button', { name: 'Join room', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Leave room' })).toBeVisible()
}
async function publish(page: Page) {
  await page.getByRole('checkbox', { name: 'Share audio from a browser tab' }).check()
  await page.getByRole('button', { name: 'Start sharing' }).click()
  await expect(page.getByLabel('Audio capture status')).toContainText('Screen-capture audio published')
}

test('generated Opus through real SFU: two publishers, independent playback, reconnect and cleanup', async ({ browser, baseURL, browserName }) => {
  const remoteBrowser = process.env.E2E_REMOTE_BROWSER === 'firefox' ? await firefox.launch({ headless: true }) : null
  const contexts = [await browser.newContext(), await (remoteBrowser || browser).newContext(), await browser.newContext()]
  for (const context of contexts) await generatedAudio(context)
  const [alice, bob, viewer] = await Promise.all(contexts.map(context => context.newPage()))
  const sockets: { client: WebSocketRoute; server: WebSocketRoute }[] = []
  await bob.routeWebSocket('ws://127.0.0.1:*/**', client => { sockets.push({ client, server: client.connectToServer() }) })
  try {
    await create(alice, baseURL!)
    const publisher = await alice.getByLabel('Screen publisher invitation').inputValue()
    const invitation = await alice.getByLabel('Share invitation').inputValue()
    await join(bob, publisher, 'Bob audio'); await join(viewer, invitation, 'Listener')
    await publish(alice); await publish(bob)
    await expect(viewer.locator('audio')).toHaveCount(2)
    await expect(viewer.getByRole('button', { name: 'Unmute Alice audio' })).toBeEnabled()
    await expect(viewer.getByRole('button', { name: 'Unmute Bob audio' })).toBeEnabled()
    expect(await viewer.locator('audio').evaluateAll(elements => elements.every(element => element.muted))).toBe(true)
    await expect.poll(async () => (await audioStats(viewer)).filter(report => report.packets > 5).length).toBe(2)
    await viewer.getByRole('button', { name: 'Unmute Alice audio' }).click()
    await viewer.getByRole('button', { name: 'Unmute Bob audio' }).click()
    await expect.poll(async () => (await audioStats(viewer)).filter(report => report.energy > 0).length).toBe(2)
    await expect.poll(() => viewer.locator('audio').evaluateAll(elements => elements.every(element => !element.paused && element.readyState >= 2))).toBe(true)
    console.log('Generated audio RTP evidence', JSON.stringify({ publisher: browserName, secondPublisher: remoteBrowser ? 'firefox' : browserName, received: await audioStats(viewer) }))
    await viewer.getByRole('slider', { name: 'Volume for Alice audio' }).fill('24')
    expect(await viewer.getByLabel('Alice audio audio playback').evaluate(element => (element as HTMLAudioElement).volume)).toBe(.24)
    expect(await viewer.getByLabel('Bob audio audio playback').evaluate(element => (element as HTMLAudioElement).volume)).toBe(1)
    await viewer.getByRole('button', { name: 'Mute Bob audio' }).click()
    expect(await viewer.getByLabel('Bob audio audio playback').evaluate(element => (element as HTMLAudioElement).muted)).toBe(true)
    expect(await viewer.getByLabel('Alice audio audio playback').evaluate(element => (element as HTMLAudioElement).muted)).toBe(false)
    const before = sockets.length, socket = sockets[sockets.length - 1]
    await socket.client.close({ code: 1012, reason: 'Audio reconnect test' }); await socket.server.close({ code: 1012 })
    await expect.poll(() => sockets.length).toBeGreaterThan(before)
    await expect(bob.getByText('Connection:', { exact: false })).toHaveText('Connection: connected')
    expect(await bob.evaluate(() => (window as unknown as { __audioTest: { calls: number } }).__audioTest.calls)).toBe(1)
    await expect(viewer.locator('audio')).toHaveCount(2)
    const packets = (await audioStats(viewer)).reduce((sum, report) => sum + report.packets, 0)
    await expect.poll(async () => (await audioStats(viewer)).reduce((sum, report) => sum + report.packets, 0)).toBeGreaterThan(packets)
    await bob.getByRole('button', { name: 'Stop sharing' }).click()
    await expect(viewer.locator('audio')).toHaveCount(1)
    expect(await bob.evaluate(() => (window as unknown as { __audioTest: { streams: MediaStream[] } }).__audioTest.streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true)
    await publish(bob)
    await expect(viewer.locator('audio')).toHaveCount(2)
    await bob.getByRole('button', { name: 'Leave room' }).click()
    await expect(viewer.locator('audio')).toHaveCount(1)
    await alice.getByRole('button', { name: 'Stop sharing' }).click()
    await expect(viewer.locator('audio')).toHaveCount(0)
    await viewer.getByRole('button', { name: 'Leave room' }).click()
    await alice.getByRole('button', { name: 'Leave room' }).click()
  } finally {
    for (const socket of sockets) await socket.server.close().catch(() => {})
    for (const context of contexts) await context.close()
    await remoteBrowser?.close()
  }
})

test('native pairing: real SFU association, audio-only grants, rejection and screen lifecycle revocation', async ({browser,baseURL})=>{
 const first=await browser.newContext(),second=await browser.newContext()
 await generatedAudio(first);await generatedAudio(second)
 const owner=await first.newPage(),viewer=await second.newPage()
 try {
  await create(owner,baseURL!)
  await join(viewer,await owner.getByLabel('Share invitation').inputValue(),'Native listener')
  await owner.getByRole('button',{name:'Start sharing'}).click()
  await expect(owner.getByRole('button',{name:'Stop sharing',exact:true})).toBeEnabled()
  await owner.getByRole('button',{name:'Pair native audio helper'}).click()
  const pair=JSON.parse(await owner.getByLabel('One-time native audio pairing JSON').inputValue())
  const claim=await second.request.post(`${pair.apiUrl}/native-audio/claim`,{data:{code:pair.code}})
  expect(claim.status()).toBe(200)
  const credentials=await claim.json()
  const claims=JSON.parse(Buffer.from(credentials.token.split('.')[1],'base64url').toString())
  expect(claims.video.canPublishSources).toEqual(['screen_share_audio'])
  expect(claims.video.canSubscribe).toBe(false)
  expect(claims.exp-claims.iat).toBe(30)
  expect(claims.sub).toMatch(/^native-audio-/)
  expect((await second.request.post(`${pair.apiUrl}/native-audio/claim`,{data:{code:pair.code}})).status()).toBe(403)
  // Browser-generated stand-in for the helper: tests grants/association/SFU,
  // not native capture. Production helper is a separate Go process.
  const rejectedSources=await viewer.evaluate(async (credentials)=>{
   const sdk=await import('/node_modules/.vite/deps/livekit-client.js')
   const room=new sdk.Room();await room.connect(credentials.serverUrl,credentials.token)
   const audio=new AudioContext();const destination=audio.createMediaStreamDestination();const oscillator=audio.createOscillator();oscillator.connect(destination);oscillator.start()
   const raw=destination.stream.getAudioTracks()[0]
   await room.localParticipant.publishTrack(new sdk.LocalAudioTrack(raw),{source:sdk.Track.Source.ScreenShareAudio})
   Object.assign(window,{__nativeStandIn:{room,audio,oscillator}})
   const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90
   canvas.getContext('2d')!.fillRect(0,0,160,90)
   const video=canvas.captureStream(5).getVideoTracks()[0]
   const mic=audio.createMediaStreamDestination().stream.getAudioTracks()[0]
   const rejected:string[]=[]
   try{await room.localParticipant.publishTrack(new sdk.LocalAudioTrack(mic),{source:sdk.Track.Source.Microphone})}catch{rejected.push('microphone')}finally{mic.stop()}
   try{await room.localParticipant.publishTrack(new sdk.LocalVideoTrack(video),{source:sdk.Track.Source.Camera})}catch{rejected.push('camera')}finally{video.stop()}
   return rejected
  },credentials)
  expect(rejectedSources).toEqual(['microphone','camera'])
  await expect(viewer.getByRole('button',{name:'Unmute Alice audio'})).toBeEnabled()
  await expect(viewer.locator('audio')).toHaveCount(1)
  await expect(viewer.getByText('Same-headset listening:', {exact:false})).toBeVisible()
  await expect(viewer.locator('dt').filter({hasText:/^Audio element attached to this track$/}).locator('xpath=following-sibling::dd[1]')).toHaveText('yes')
  await expect(viewer.locator('dt').filter({hasText:/^Audio publisher identity$/}).locator('xpath=following-sibling::dd[1]')).toHaveText(claims.sub)
  await expect(owner.locator('audio')).toHaveCount(0)
  const unauthorized=await second.request.post(`${pair.apiUrl}/native-audio/sessions`,{data:{screen:'arbitrary'}})
  expect(unauthorized.status()).toBe(403)
  await owner.getByRole('button',{name:'Stop sharing',exact:true}).click()
  await expect(viewer.locator('audio')).toHaveCount(0)
  await expect.poll(()=>viewer.evaluate(()=>(window as any).__nativeStandIn.room.state)).toBe('disconnected')
  expect((await second.request.post(`${pair.apiUrl}/native-audio/${credentials.session}/lease`,{headers:{Authorization:`Bearer ${credentials.lease}`},data:{}})).status()).toBe(403)
  await owner.getByRole('button',{name:'Leave room'}).click();await viewer.getByRole('button',{name:'Leave room'}).click()
 }finally{await first.close();await second.close()}
})


test('actual PipeWire monitors through native Go helpers and real SFU to browser', async ({browser,baseURL})=>{
 test.skip(!process.env.NATIVE_AUDIO_SINK,'Explicit NATIVE_AUDIO_SINK is required: captures the named output monitor and plays a quiet native-player tone')
 const contexts=[await browser.newContext(),await browser.newContext(),await browser.newContext()]
 for(const context of contexts)await generatedAudio(context)
 const [alice,bob,viewer]=await Promise.all(contexts.map(context=>context.newPage()))
 const children:ChildProcess[]=[]
 const sockets:{client:WebSocketRoute;server:WebSocketRoute}[]=[]
 await alice.routeWebSocket('ws://127.0.0.1:*/**',client=>{sockets.push({client,server:client.connectToServer()})})
 try{
  await create(alice,baseURL!)
  await join(bob,await alice.getByLabel('Screen publisher invitation').inputValue(),'Bob native')
  await join(viewer,await alice.getByLabel('Share invitation').inputValue(),'Native listener')
  for(const page of [alice,bob]){
   await page.getByRole('button',{name:'Start sharing'}).click()
   await expect(page.getByRole('button',{name:'Stop sharing',exact:true})).toBeEnabled()
   await page.getByRole('button',{name:'Pair native audio helper'}).click()
   const pair=await page.getByLabel('One-time native audio pairing JSON').inputValue()
   const helper=spawn(fileURLToPath(new URL('../../native-audio/whiterun-audio',import.meta.url)),['--start','--allow-mixed-monitor','--sink',process.env.NATIVE_AUDIO_SINK!],{stdio:['pipe','pipe','pipe']})
   children.push(helper)
   let errors='';helper.stderr?.on('data',data=>{errors+=String(data)})
   helper.stdin?.end(pair+'\n')
   await expect.poll(()=>errors.includes('Publishing selected audio')? 'published':helper.exitCode!==null?`exit ${helper.exitCode}: ${errors.slice(-500)}`:'waiting',{timeout:25000}).toBe('published')
  }
  await expect(viewer.locator('audio')).toHaveCount(2)
  // Redirect only this test browser's playback using its PULSE_SINK environment.
  // Native player explicitly targets the selected monitored sink; no global route changes.
  const nodes=JSON.parse(execFileSync('pw-dump',{encoding:'utf8'}))
  const sink=nodes.find((node:any)=>node.info?.props?.['node.name']===process.env.NATIVE_AUDIO_SINK&&node.info.props['media.class']==='Audio/Sink')
  if(!sink)throw new Error('Explicit native capture sink is unavailable')
  // Target the PipeWire node explicitly: SDL/FFplay can ignore PULSE_SINK.
  const player=spawn('pw-cat',['--playback','--raw','--target',String(sink.info.props['object.serial']),'--rate','48000','--channels','2','--format','s16','-'],{stdio:['pipe','ignore','pipe']})
  children.push(player)
  player.stderr?.on('data',data=>console.error('Generated tone source:',String(data)))
  player.stdin?.on('error',error=>console.error('Generated tone pipe:',error.message))
  const tone=Buffer.alloc(48000*2*2*5)
  for(let i=0;i<48000*5;i++){const sample=Math.round(200*Math.sin(2*Math.PI*523*i/48000));tone.writeInt16LE(sample,i*4);tone.writeInt16LE(sample,i*4+2)}
  player.stdin?.end(tone)
  await viewer.getByRole('button',{name:'Unmute Alice audio'}).click()
  await viewer.getByRole('button',{name:'Unmute Bob native'}).click()
  await expect.poll(async()=> (await audioStats(viewer)).filter(report=>report.packets>10&&report.energy>0).length,{timeout:20000}).toBe(2)
  await expect.poll(()=>viewer.locator('audio').evaluateAll(elements=>elements.every(element=>!element.paused&&element.readyState>=2))).toBe(true)
  await expect(viewer.getByText('audio/opus',{exact:true})).toHaveCount(2)
  console.log('ACTUAL PipeWire capture + Go helper + SFU decode evidence',JSON.stringify({sink:process.env.NATIVE_AUDIO_SINK,received:await audioStats(viewer),note:'Native player test tone through actual sink monitor; screen video generated; physical hearing not asserted'}))
  const before=sockets.length,socket=sockets[sockets.length-1]
  await socket.client.close({code:1012,reason:'Native audio owner signaling recovery'});await socket.server.close({code:1012})
  await expect.poll(()=>sockets.length).toBeGreaterThan(before)
  await expect(alice.getByText('Connection:',{exact:false})).toHaveText('Connection: connected')
  expect(children[0].exitCode).toBeNull();expect(children[1].exitCode).toBeNull()
  const packets=(await audioStats(viewer)).reduce((sum,report)=>sum+report.packets,0)
  await expect.poll(async()=>(await audioStats(viewer)).reduce((sum,report)=>sum+report.packets,0)).toBeGreaterThan(packets)
  await alice.getByRole('button',{name:'Stop sharing',exact:true}).click()
  await expect(viewer.locator('audio')).toHaveCount(1)
  await expect.poll(()=>children[0].exitCode,{timeout:15000}).not.toBeNull()
  children[1].kill('SIGINT')
  await expect(viewer.locator('audio')).toHaveCount(0)
  await expect.poll(()=>children[1].exitCode,{timeout:15000}).not.toBeNull()
  await expect(viewer.getByRole('article')).toHaveCount(1)
  await bob.getByRole('button',{name:'Stop sharing',exact:true}).click()
  for(const page of [alice,bob,viewer])await page.getByRole('button',{name:'Leave room'}).click()
 }finally{
  for(const socket of sockets)await socket.server.close().catch(()=>{})
  for(const child of children)if(child.exitCode===null)child.kill('SIGTERM')
  for(const context of contexts)await context.close()
 }
})
