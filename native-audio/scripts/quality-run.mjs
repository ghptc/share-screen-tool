// Explicit PipeWire diagnostic. Real media/desktop modes are not listening validation.
// Stores metadata only, never media; defaults to a synthetic tone for regression checks.
import { verifyPlaybackLinks, verifyCaptureLinks } from './verify-routing.mjs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync, mkdirSync, writeFileSync, appendFileSync, createWriteStream } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
const require=createRequire(new URL('../../frontend/package.json',import.meta.url))
const {chromium,firefox}=require('@playwright/test')
const sink=process.env.QUALITY_CAPTURE_SINK,output=process.env.QUALITY_PLAYBACK_SINK
if(!sink||!output||sink===output)throw new Error('Explicit distinct QUALITY_CAPTURE_SINK and QUALITY_PLAYBACK_SINK are required')
const mediaFile=process.env.QUALITY_MEDIA_FILE
const desktopAudio=process.env.QUALITY_DESKTOP_AUDIO==='1'
if(desktopAudio&&mediaFile)throw new Error('Choose desktop audio or a media file')
const listening=process.env.QUALITY_LISTENING==='1'
const realScreen=process.env.QUALITY_REAL_SCREEN==='1'
if(listening&&(!realScreen||!mediaFile||desktopAudio))throw new Error('Listening mode requires QUALITY_REAL_SCREEN=1 and a local QUALITY_MEDIA_FILE')
if((mediaFile||desktopAudio)&&process.env.QUALITY_ASSERT_STABLE==='1')throw new Error('Tone stability assertions cannot validate real media; use listening comparison and measured diagnostics')
const seconds=Number(process.env.QUALITY_SECONDS||180),base=process.env.E2E_BASE_URL||'http://localhost:5173'
if(!Number.isFinite(seconds)||seconds<15||seconds>600)throw new Error('QUALITY_SECONDS must be 15..600 seconds; use 180 for sustained validation')
const helperPath=resolve(process.env.QUALITY_HELPER||new URL('../whiterun-audio',import.meta.url).pathname)
const dir=resolve(process.env.QUALITY_RESULT_DIR||`frontend/test-results/audio-quality-${Date.now()}`);mkdirSync(dir,{recursive:true,mode:0o700})
const inventory=JSON.parse(execFileSync('pw-dump',{encoding:'utf8'}))
const sourceNode=inventory.find(n=>n.info?.props?.['node.name']===sink&&n.info.props['media.class']==='Audio/Sink')
const outputNode=inventory.find(n=>n.info?.props?.['node.name']===output&&n.info.props['media.class']==='Audio/Sink')
if(!sourceNode||!outputNode)throw new Error('Both selected output sinks must exist')
const pulseSinks=JSON.parse(execFileSync('pactl',['-f','json','list','sinks'],{encoding:'utf8'}))
const outputIndex=pulseSinks.find(s=>s.name===output)?.index
if(outputIndex===undefined)throw new Error('Playback sink unavailable through Pulse API')
if(listening&&(!outputNode.info.props['node.name'].startsWith('alsa_output.')||/aloop|loopback/i.test(output)))throw new Error('Listening mode requires a separate physical ALSA output')
const before=new Set(JSON.parse(execFileSync('pactl',['-f','json','list','sink-inputs'],{encoding:'utf8'})).map(s=>s.index))
const browsers=[],children=[],pages=[]
let publisher,helper,stderr='',helperExit=null,stopping=false,hostDone
const markers=[]
const runStartedUnixMs=Date.now()
writeFileSync(resolve(dir,'attempt.json'),JSON.stringify({runStartedUnixMs,listening,realScreen,sourceSHA256:mediaFile?createHash('sha256').update(readFileSync(mediaFile)).digest('hex'):null,listeningValidated:false},null,2))
try{
 for(const engine of [chromium,firefox])browsers.push(await engine.launch({headless:!realScreen,env:{...process.env,PULSE_SINK:output},chromiumSandbox:true}))
 for(let i=0;i<3;i++){
  const context=await browsers[i===2?1:0].newContext()
  await context.addInitScript(({realScreen})=>{
   const peers=[];const Native=RTCPeerConnection;window.RTCPeerConnection=class extends Native{constructor(c){super(c);peers.push(this)}};window.__qualityPeers=peers
   const original=navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices)
   if(realScreen){navigator.mediaDevices.getDisplayMedia=async options=>{const stream=await original(options);window.__qualityScreen=stream.getVideoTracks()[0];return stream};return}
   navigator.mediaDevices.getDisplayMedia=async()=>{const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;const c=canvas.getContext('2d');c.fillRect(0,0,160,90);const timer=setInterval(()=>{c.fillStyle=Date.now()%2?'green':'navy';c.fillRect(0,0,160,90)},100);const stream=canvas.captureStream(10);const raw=stream.getVideoTracks()[0],stop=raw.stop.bind(raw);window.__qualityScreen=raw;raw.stop=()=>{clearInterval(timer);stop()};return stream}
  },{realScreen})
  pages.push(await context.newPage())
  if(realScreen)pages.at(-1).setDefaultTimeout(120000)
 }
 publisher=pages[0];await publisher.goto(new URL('/rooms', base).href)
 await publisher.getByLabel('Display name').fill('Quality source')
 await publisher.getByLabel('Room title',{exact:true}).fill((mediaFile||desktopAudio)?'Real desktop media investigation':'Synthetic tone diagnostic only')
 const key=process.env.E2E_OPERATOR_KEY||readFileSync(new URL('../../.env',import.meta.url),'utf8').match(/^LOCAL_ADMIN_KEY=(.+)$/m)?.[1]
 await publisher.getByLabel('Local operator key').fill(key)
 await publisher.getByRole('button',{name:'Create and join room'}).click()
 await publisher.getByLabel('Share invitation').waitFor()
 const invitation=await publisher.getByLabel('Share invitation').inputValue()
 for(let i=1;i<pages.length;i++){await pages[i].goto(invitation);await pages[i].getByLabel('Display name').fill(i===1?'Chromium quality listener':'Firefox quality listener');await pages[i].getByRole('button',{name:'Join room',exact:true}).click();await pages[i].getByRole('button',{name:'Leave room'}).waitFor()}
 if(realScreen)console.log('ACTION_REQUIRED: Select the actual desktop in the normal sharing picker. Pause unrelated audio sources manually; no application routes will be changed.')
 await publisher.getByRole('button',{name:'Start sharing',exact:true}).click()
 await publisher.waitForFunction(()=>window.__qualityScreen?.readyState==='live')
 const screenSettings=await publisher.evaluate(()=>window.__qualityScreen.getSettings())
 writeFileSync(resolve(dir,'screen.json'),JSON.stringify({unixMs:Date.now(),settings:screenSettings,realScreen},null,2))
 if(listening&&screenSettings.displaySurface!=='monitor')throw new Error('Choose an entire desktop monitor in the picker for this listening test')
 // Optional reproducible file (looped) or regression tone targets the selected output.
 // Desktop mode leaves existing source applications untouched.
 if(!desktopAudio){
 const sourceArgs=mediaFile?['-stream_loop','-1','-re','-i',resolve(mediaFile),'-vn']:['-re','-f','lavfi','-i','sine=frequency=997:sample_rate=48000']
 const generator=spawn('ffmpeg',['-hide_banner','-loglevel','error',...sourceArgs,'-ar','48000','-ac','2','-f','s16le','pipe:1'],{stdio:['ignore','pipe','pipe']});children.push(generator)
 const tone=spawn('pw-cat',['--playback','--raw','--target',String(sourceNode.info.props['object.serial']),'--rate','48000','--channels','2','--format','s16','-'],{stdio:['pipe','ignore','pipe']});children.push(tone);generator.stdout.pipe(tone.stdin);tone.stdin.on('error',error=>{if(!stopping)console.error('TONE_PIPE_ERROR',error.message)})
 for(const child of [generator,tone])child.stderr.on('data',data=>process.stderr.write(data))
 }
 await publisher.getByRole('button',{name:'Pair native audio helper'}).click()
 const pair=await publisher.getByLabel('One-time native audio pairing JSON').inputValue()
 helper=spawn(helperPath,['--start','--allow-mixed-monitor','--sink',sink,'--timing-json',resolve(dir,'publisher.jsonl')],{stdio:['pipe','pipe','pipe']});children.push(helper)
 helper.stderr.on('data',data=>{stderr+=data;process.stderr.write(data)})
 helper.on('exit',(code,signal)=>{helperExit={code,signal}});helper.stdin.end(pair+'\n')
 for(const page of pages.slice(1)){await page.getByRole('slider',{name:'Volume for Quality source'}).fill(listening?'0':'5');await page.getByRole('button',{name:'Unmute Quality source'}).click();await page.waitForFunction(()=>{const audio=document.querySelector('.stream-audio audio');return audio&&!audio.paused&&!audio.muted&&audio.readyState>=2})}
 for(const page of pages.slice(1)){
  await page.evaluate(()=>{
   const button=document.createElement('button');button.textContent='Start diagnostic waveform measurement'
   button.onclick=async()=>{const context=new AudioContext();await context.resume();const source=context.createMediaStreamSource(document.querySelector('.stream-audio audio').srcObject);const analyser=context.createAnalyser();analyser.fftSize=4096;source.connect(analyser);window.__qualityWave={context,analyser}}
   document.body.append(button)
  })
  await page.getByRole('button',{name:'Start diagnostic waveform measurement'}).click()
  await page.waitForFunction(()=>window.__qualityWave?.context.state==='running')
  await page.evaluate(()=>{
   const audio=document.querySelector('.stream-audio audio')
   window.__qualityPlaybackEvents=[]
   for(const event of ['waiting','stalled','playing','pause','ended','error'])audio.addEventListener(event,()=>{
    // Bounded metadata history; media events are not proof of acoustic continuity.
    const events=window.__qualityPlaybackEvents
    if(events.length>=128)events.shift()
    events.push({event,unixMs:Date.now(),atMs:performance.now(),mediaTime:audio.currentTime})
   })
  })
 }
 await new Promise(r=>setTimeout(r,1000))
 const newStreams=JSON.parse(execFileSync('pactl',['-f','json','list','sink-inputs'],{encoding:'utf8'})).filter(s=>!before.has(s.index)&&/chrom|firefox/i.test(s.properties?.['application.process.binary']||s.properties?.['application.name']||''))
 console.log('VERIFIED_OUTPUT_STREAMS',JSON.stringify(newStreams.map(s=>({index:s.index,sink:s.sink,binary:s.properties['application.process.binary']}))))
 if(!newStreams.some(s=>/chrom/i.test(s.properties['application.process.binary']||''))||!newStreams.some(s=>/firefox/i.test(s.properties['application.process.binary']||''))||newStreams.some(s=>s.sink!==outputIndex))throw new Error('Did not verify both new browser playback streams on the distinct requested sink')
 const verifiedLinks=verifyPlaybackLinks(JSON.parse(execFileSync('pw-dump',{encoding:'utf8'})),newStreams,output)
 const routing={unixMs:Date.now(),verifiedLinks,capture:{name:sink,id:sourceNode.id,serial:sourceNode.info.props['object.serial']},playback:{name:output,id:outputNode.id,serial:outputNode.info.props['object.serial']},browserStreams:newStreams.map(s=>({index:s.index,sink:s.sink,binary:s.properties['application.process.binary'],muted:s.mute,corked:s.corked}))}
 writeFileSync(resolve(dir,'routing.json'),JSON.stringify(routing,null,2))
 if(listening){
  for(let i=1;i<pages.length;i++){
   await pages[i].exposeBinding('__markListening',(_source,kind)=>{
    const marker={unixMs:Date.now(),browser:i===1?'chromium':'firefox',kind}
    markers.push(marker);appendFileSync(resolve(dir,'listening-markers.jsonl'),JSON.stringify(marker)+'\n')
   })
   await pages[i].evaluate(()=>{
    for(const [label,kind] of [['Mark audible glitch','glitch'],['Confirm source audible','audible'],['Mark listening pass','pass'],['Mark listening failure','fail']]){
     const button=document.createElement('button');button.textContent=label;button.onclick=()=>window.__markListening(kind);document.body.append(button)
    }
   })
  }
  // Both outputs were verified at volume zero. Only one receiver is audible at a time.
  await pages[1].getByRole('slider',{name:'Volume for Quality source'}).fill('50')
  await pages[2].getByRole('button',{name:'Mute Quality source',exact:true}).click()
  await pages[1].bringToFront()
  console.log('LISTEN: Chromium first half, Firefox second half. Use Mark audible glitch immediately when heard; reaction time is part of the timestamp uncertainty.')
 }
 const hostFile=createWriteStream(resolve(dir,'host.json'),{flags:'wx',mode:0o600})
 const host=spawn('python3',[new URL('./inspect-host.py',import.meta.url).pathname,'--seconds',String(Math.min(600,Math.ceil(seconds)))],{stdio:['ignore','pipe','pipe']});children.push(host)
 host.stdout.pipe(hostFile,{end:false});host.stderr.on('data',data=>process.stderr.write(data))
 hostDone=new Promise(resolveDone=>{host.on('close',code=>hostFile.end(()=>resolveDone(code)));host.on('error',()=>hostFile.end(()=>resolveDone(-1)))})
 const rows=[],started=Date.now();let videoMinimized=false,firefoxListening=false,lastRouteCheck=0
 writeFileSync(resolve(dir,'measurement-start.json'),JSON.stringify({unixMs:started,runStartedUnixMs}))
 while(Date.now()-started<seconds*1000){
  if(helperExit)throw new Error(`Helper ended prematurely: ${JSON.stringify(helperExit)}`)
  if(listening&&!firefoxListening&&Date.now()-started>=seconds*500){
   await pages[1].getByRole('button',{name:'Mute Quality source',exact:true}).click()
   await pages[2].getByRole('slider',{name:'Volume for Quality source'}).fill('50')
   await pages[2].getByRole('button',{name:'Unmute Quality source',exact:true}).click()
   await pages[2].bringToFront();firefoxListening=true
   appendFileSync(resolve(dir,'listening-markers.jsonl'),JSON.stringify({unixMs:Date.now(),kind:'receiver-switch',browser:'firefox'})+'\n')
  }
  if(Date.now()-lastRouteCheck>=2000){
   const active=JSON.parse(execFileSync('pactl',['-f','json','list','sink-inputs'],{encoding:'utf8'})).filter(s=>!before.has(s.index)&&/chrom|firefox/i.test(s.properties?.['application.process.binary']||''))
   if(!active.length||active.some(s=>s.sink!==outputIndex))throw new Error('Receiver routing changed during measurement')
   const graph=JSON.parse(execFileSync('pw-dump',{encoding:'utf8'}))
   const links=verifyPlaybackLinks(graph,active,output)
   const capture=verifyCaptureLinks(graph,sink)
   appendFileSync(resolve(dir,'routing-timeline.jsonl'),JSON.stringify({unixMs:Date.now(),links,capture})+'\n');lastRouteCheck=Date.now()
  }
  if(!listening&&!videoMinimized&&Date.now()-started>=seconds*500){await publisher.evaluate(()=>{window.__qualityScreen.enabled=false});videoMinimized=true}
  const record={unixMs:Date.now(),listeningBrowser:listening?(firefoxListening?'firefox':'chromium'):null,elapsedMs:Date.now()-started,phase:videoMinimized?'video-minimized':'video-enabled',browsers:[]}
  for(let i=1;i<pages.length;i++)record.browsers.push(await pages[i].evaluate(async()=>{
   const rows=[],transport=[],playout=[]
   for(const peer of window.__qualityPeers){if(peer.connectionState==='closed')continue;const stats=await peer.getStats();stats.forEach(r=>{if(r.type==='candidate-pair'&&r.nominated)transport.push({timestamp:r.timestamp,state:r.state,currentRoundTripTime:r.currentRoundTripTime,availableOutgoingBitrate:r.availableOutgoingBitrate,bytesSent:r.bytesSent,bytesReceived:r.bytesReceived});if(r.type==='media-playout')playout.push({timestamp:r.timestamp,kind:r.kind,synthesizedSamplesDuration:r.synthesizedSamplesDuration,synthesizedSamplesEvents:r.synthesizedSamplesEvents,totalSamplesCount:r.totalSamplesCount,totalPlayoutDelay:r.totalPlayoutDelay});if(r.type==='inbound-rtp'&&(r.kind==='audio'||r.mediaType==='audio'))rows.push({id:r.id,ssrc:r.ssrc,timestamp:r.timestamp,lastPacketReceivedTimestamp:r.lastPacketReceivedTimestamp,concealmentEvents:r.concealmentEvents,packets:r.packetsReceived,bytes:r.bytesReceived,lost:r.packetsLost,jitter:r.jitter,delay:r.jitterBufferDelay,emitted:r.jitterBufferEmittedCount,targetDelay:r.jitterBufferTargetDelay,concealed:r.concealedSamples,silentConcealed:r.silentConcealedSamples,inserted:r.insertedSamplesForDeceleration,removed:r.removedSamplesForAcceleration,energy:r.totalAudioEnergy,samples:r.totalSamplesReceived,duration:r.totalSamplesDuration,codec:stats.get(r.codecId)?.mimeType})})}
   const waveform=window.__qualityWave;const values=new Float32Array(4096);waveform.analyser.getFloatTimeDomainData(values);let real=0,imag=0,power=0;for(let i=0;i<values.length;i++){const angle=2*Math.PI*997*i/waveform.context.sampleRate;real+=values[i]*Math.cos(angle);imag-=values[i]*Math.sin(angle);power+=values[i]*values[i]}
   return {unixMs:Date.now(),transport,playout,observedAtMs:performance.now(),playbackEvents:[...window.__qualityPlaybackEvents],stats:rows,waveform:{sampleRate:waveform.context.sampleRate,contextState:waveform.context.state,rms:Math.sqrt(power/values.length),coherence:power?2*(real*real+imag*imag)/(values.length*power):0},elements:[...document.querySelectorAll('.stream-audio audio')].map(a=>({muted:a.muted,volume:a.volume,paused:a.paused,ready:a.readyState,time:a.currentTime}))}
  }))
  record.publisherVideo=await publisher.evaluate(async()=>{
   const rows=[]
   for(const peer of window.__qualityPeers){if(peer.connectionState==='closed')continue;const stats=await peer.getStats();stats.forEach(r=>{if(r.type==='outbound-rtp'&&r.kind==='video')rows.push({timestamp:r.timestamp,framesEncoded:r.framesEncoded,framesSent:r.framesSent,bytesSent:r.bytesSent,totalEncodeTime:r.totalEncodeTime,qualityLimitationReason:r.qualityLimitationReason,frameWidth:r.frameWidth,frameHeight:r.frameHeight})})}
   return {unixMs:Date.now(),enabled:window.__qualityScreen.enabled,state:window.__qualityScreen.readyState,stats:rows}
  })
  rows.push(record);writeFileSync(resolve(dir,'receivers.json'),JSON.stringify(rows))
  if(rows.length%120===0)console.log(JSON.stringify({progressSeconds:Math.round(record.elapsedMs/1000),receivers:record.browsers.map(b=>b.stats)}))
  await new Promise(r=>setTimeout(r,250))
 }
 const hostExit=await hostDone
 if(hostExit!==0)throw new Error('Host diagnostics failed; preserve the partial result directory')
 await publisher.getByRole('button',{name:'Stop sharing',exact:true}).click()
 await new Promise(r=>setTimeout(r,2500))
 if(!helperExit)throw new Error('Helper did not stop with screen')
 writeFileSync(resolve(dir,'run.json'),JSON.stringify({seconds,runStartedUnixMs,measurementStartedUnixMs:started,listening,markers,screenSettings,source:desktopAudio?{kind:'live-desktop',reproducible:false}:mediaFile?{kind:'real-media-file',sha256:createHash('sha256').update(readFileSync(mediaFile)).digest('hex')}:{kind:'synthetic-tone'},screen:realScreen?'desktop-portal':'synthetic-canvas',listeningValidated:false,packetArrivalTimestampsCollected:false,acousticContinuityMeasured:false,statsPollTargetMs:250,helper:helperPath,routing,helperExit,browsers:browsers.map(b=>b.version()),records:rows.length},null,2))
 const summary=JSON.parse(execFileSync('python3',[new URL('./summarize-quality.py',import.meta.url).pathname,dir],{encoding:'utf8'}))
 writeFileSync(resolve(dir,'summary.json'),JSON.stringify(summary,null,2))
 if(process.env.QUALITY_ASSERT_STABLE==='1'){
  if(summary.captureStartAfterBind!==true)throw new Error('Capture did not start after publication binding')
  if(summary.under5ms||summary.over35ms||summary.rtpErrors||Object.keys(summary.rtpTimestampDeltas).some(delta=>delta!=='960'))throw new Error('RTP cadence/timestamp regression; inspect summary.json')
  for(const receiver of summary.receivers)if(receiver.last.lost!==receiver.first.lost||receiver.concealedDelta>0)throw new Error('Receiver loss/concealment grew during the tone run')
  for(const row of rows)for(const browser of row.browsers)if(browser.waveform.rms<.00001||browser.waveform.coherence<.95||browser.elements.some(a=>a.paused||a.muted||a.ready<2))throw new Error('Decoded tone/playback continuity regression')
 }
 console.log('RESULT_DIRECTORY',dir)
}catch(error){writeFileSync(resolve(dir,'failure.json'),JSON.stringify({unixMs:Date.now(),message:error.message,listeningValidated:false}));console.error('QUALITY_FAILURE',error.stack);throw error}finally{
 stopping=true
 for(const child of children)if(child.exitCode===null)child.kill('SIGTERM')
 for(const page of pages){try{if(await page.getByRole('button',{name:'Leave room'}).count())await page.getByRole('button',{name:'Leave room'}).click()}catch(error){console.error('Cleanup:',error.message)}}
 for(const page of pages.slice(1)){try{await page.evaluate(()=>window.__qualityWave?.context.close())}catch(error){console.error('Waveform cleanup:',error.message)}}
 for(const browser of browsers)await browser.close()
}
