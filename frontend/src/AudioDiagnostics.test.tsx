import {act,render,screen} from '@testing-library/react'
import {expect,test,vi} from 'vitest'
import type {TrackPublication} from 'livekit-client'
import AudioDiagnostics from './AudioDiagnostics'
test('reports actual inbound audio counters and negotiated codec without inventing an initial bitrate',async()=>{
 const report=new Map([['codec',{mimeType:'audio/opus'}],['audio',{id:'audio',type:'inbound-rtp',kind:'audio',codecId:'codec',packetsReceived:41,packetsLost:2,totalAudioEnergy:.25,bytesReceived:900,timestamp:1000}]])
 const track={getRTCStatsReport:vi.fn().mockResolvedValue(report)} as unknown as TrackPublication['audioTrack']
 render(<AudioDiagnostics track={track} connected/>);
 expect(await screen.findByText('audio/opus')).toBeInTheDocument();expect(screen.getByText('41')).toBeInTheDocument();expect(screen.getByText('0.25')).toBeInTheDocument();expect(screen.getByText('Audio RTP bitrate').nextElementSibling).toHaveTextContent('Unavailable')
})
test('missing receiver data remains unavailable',()=>{render(<AudioDiagnostics track={undefined} connected={false}/>);expect(screen.getAllByText('Unavailable')).toHaveLength(10)})


test('jitter and buffering intervals expose delayed audio despite zero packet loss',async()=>{
 vi.useFakeTimers()
 try{
  const report=(timestamp:number,bytes:number,delay:number,emitted:number)=>new Map([['codec',{mimeType:'audio/opus'}],['audio',{id:'audio',type:'inbound-rtp',kind:'audio',codecId:'codec',packetsReceived:100,packetsLost:0,totalAudioEnergy:2,bytesReceived:bytes,timestamp,jitter:.025,jitterBufferDelay:delay,jitterBufferEmittedCount:emitted,concealedSamples:960}]])
  const track={getRTCStatsReport:vi.fn().mockResolvedValueOnce(report(1000,1000,2,100)).mockResolvedValueOnce(report(3000,5000,6,300)).mockResolvedValue(report(5000,100,.2,10))} as unknown as TrackPublication['audioTrack']
  render(<AudioDiagnostics track={track} connected/>);
  await act(async()=>{})
  await act(async()=>{await vi.advanceTimersByTimeAsync(2000)})
  expect(screen.getByText('25.0 ms')).toBeInTheDocument()
  expect(screen.getByText('20.0 ms')).toBeInTheDocument()
  expect(screen.getByText('16.0 kb/s')).toBeInTheDocument()
  expect(screen.getByText('960')).toBeInTheDocument()
  await act(async()=>{await vi.advanceTimersByTimeAsync(2000)})
  expect(screen.getByText('Audio RTP bitrate').nextElementSibling).toHaveTextContent('Unavailable')
  expect(screen.getByText('Receiver jitter buffer (sample interval)').nextElementSibling).toHaveTextContent('Unavailable')
 }finally{vi.useRealTimers()}
})

test('reports actual media-element attachment, mute, volume and pause independently of RTP reception',async()=>{
 const raw={enabled:true,muted:false,readyState:'live'}
 class Stream { getAudioTracks(){return [raw]} }
 vi.stubGlobal('MediaStream',Stream)
 try{
  const element=document.createElement('audio')
  Object.defineProperty(element,'srcObject',{value:new Stream(),configurable:true})
  Object.defineProperty(element,'paused',{value:false,configurable:true})
  Object.defineProperty(element,'readyState',{value:4,configurable:true})
  element.muted=false;element.volume=.25
  const track={mediaStreamTrack:raw,getRTCStatsReport:vi.fn().mockResolvedValue(undefined)} as unknown as TrackPublication['audioTrack']
  render(<AudioDiagnostics track={track} connected audio={{current:element}} publication={{isSubscribed:true,isMuted:false,isEnabled:true} as TrackPublication}/>)
  await act(async()=>{})
  expect(screen.getByText('Audio element attached to this track').nextElementSibling).toHaveTextContent('yes')
  expect(screen.getByText('Element muted / volume').nextElementSibling).toHaveTextContent('no / 25%')
  expect(screen.getByText('Element paused / ready state').nextElementSibling).toHaveTextContent('no / 4')
  act(()=>{element.muted=true;element.dispatchEvent(new Event('volumechange'))})
  expect(screen.getByText('Element muted / volume').nextElementSibling).toHaveTextContent('yes / 25%')
 }finally{vi.unstubAllGlobals()}
})
