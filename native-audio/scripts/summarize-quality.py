#!/usr/bin/env python3
"""Summarize metadata-only quality runs; never reads media files."""
import json,sys,statistics,collections
from pathlib import Path

def distribution(values):
 if not values:return None
 v=sorted(values)
 return {'count':len(v),'mean':statistics.mean(v),'p50':statistics.median(v),'p95':v[int((len(v)-1)*.95)],'p99':v[int((len(v)-1)*.99)],'max':v[-1]}
def counter_delta(first,last,key):
 if first.get('id')!=last.get('id') or key not in first or key not in last:return None
 return last[key]-first[key] if last[key]>=first[key] else None

def summarize(directory):
 p=Path(directory);events=[json.loads(line) for line in (p/'publisher.jsonl').read_text().splitlines()]
 packets=[r for r in events if r['stage']=='rtp_write'];steady=[r for r in packets if r['elapsedMs']>5000]
 gaps=[b['elapsedMs']-a['elapsedMs'] for a,b in zip(steady,steady[1:])]
 timestamps=collections.Counter((b['timestamp']-a['timestamp'])%2**32 for a,b in zip(steady,steady[1:]))
 pcm=[r for r in events if r['stage']=='pcm_read'];enc=[r for r in events if r['stage']=='encode']
 result={'directory':str(p),'rtpPackets':len(packets),'steadySendGapMs':distribution(gaps),'under5ms':sum(v<5 for v in gaps),'over35ms':sum(v>35 for v in gaps),'rtpTimestampDeltas':dict(timestamps),'rtpErrors':sum(r['error'] for r in packets),'clockRebases':len([r for r in events if r['stage']=='clock_rebase']),'encoderMs':distribution([r['encoderMs'] for r in enc]),'pcmBytes':sum(r['bytes'] for r in pcm),'routing':json.loads((p/'routing.json').read_text()),'receivers':[]}
 frames=[r for r in events if r['stage']=='pcm_frame'];writes=[r for r in events if r['stage']=='sample_write']
 result['pipeQueuedMsBeforeRead']=distribution([r['pipeQueuedMsBeforeRead'] for r in pcm if 'pipeQueuedMsBeforeRead' in r])
 result['pcmFrameReadMs']=distribution([r['readMs'] for r in frames])
 result['localCaptureRMS']=distribution([r['rms'] for r in frames if 'rms' in r])
 result['deliveredMediaMinusWallMs']=distribution([r['mediaMinusWallMs'] for r in frames])
 result['sdkWriteMs']=distribution([r['writeMs'] for r in writes if 'writeMs' in r])
 result['pacerWaitMs']=distribution([r['pacerWaitMs'] for r in writes if 'pacerWaitMs' in r])
 result['scheduleLateMs']=distribution([r['lateMs'] for r in writes])
 rr=[r for r in events if r['stage']=='rtcp_receiver_report']
 result['sfuFeedback']={'reports':len(rr),'maxTotalLost':max((r['totalLost'] for r in rr),default=None),'jitterMs':distribution([r['jitterSamples']/48 for r in rr])}
 result['sequenceDeltas']=dict(collections.Counter((b['sequence']-a['sequence'])%65536 for a,b in zip(steady,steady[1:])))
 binding=[r for r in events if r['stage']=='publication_bound'];starts=[r for r in events if r['stage']=='capture_started']
 result['captureStartAfterBind']=starts[0]['elapsedMs']>=binding[0]['elapsedMs'] if starts and binding else None
 source=[r for r in pcm if r['elapsedMs']>5000]
 if len(source)>1:
  frames=sum(r['bytes'] for r in source[1:])/4;elapsed=source[-1]['elapsedMs']-source[0]['elapsedMs'];result['measuredPCMFramesPerSecond']=frames*1000/elapsed
 if len(steady)>1:
  media=(len(steady)-1)*20;wall=steady[-1]['elapsedMs']-steady[0]['elapsedMs'];result['sendMediaMinusWallMs']=media-wall;result['sendClockPPM']=(media-wall)/wall*1e6
 receiver_records=json.loads((p/'receivers.json').read_text())
 result['phases']={}
 for phase in sorted(set(r.get('phase','unspecified') for r in receiver_records)):
  selected=[r for r in receiver_records if r.get('phase','unspecified')==phase]
  result['phases'][phase]=[]
  for index in range(2):
   samples=[r['browsers'][index] for r in selected]
   stats=[b['stats'][0] for b in samples if b['stats']]
   delays=[]
   for a,b in zip(stats,stats[1:]):
    count=(b.get('emitted') or 0)-(a.get('emitted') or 0)
    if a['id']==b['id'] and count>0 and b.get('delay',0)>=a.get('delay',0):delays.append((b['delay']-a['delay'])/count*1000)
   def delta(key):
    return counter_delta(stats[0],stats[-1],key) if len(stats)>1 else None
   result['phases'][phase].append({'browser':['chromium','firefox'][index],'bufferMs':distribution(delays),'concealedDelta':delta('concealed'),'lostDelta':delta('lost'),'insertedDelta':delta('inserted'),'removedDelta':delta('removed'),'rms':distribution([b['waveform']['rms'] for b in samples]),'elementCounts':sorted(set(len(b['elements']) for b in samples)),'inboundAudioCounts':sorted(set(len(b['stats']) for b in samples))})
 for index,browser in enumerate(['chromium','firefox']):
  rows=[r['browsers'][index]['stats'][0] for r in json.loads((p/'receivers.json').read_text()) if r['browsers'][index]['stats']]
  interval_buffer=[]
  for a,b in zip(rows,rows[1:]):
   emitted=(b.get('emitted') or 0)-(a.get('emitted') or 0)
   if emitted>0 and a['id']==b['id'] and 'delay' in a and 'delay' in b and b['delay']>=a['delay']:interval_buffer.append((b['delay']-a['delay'])/emitted*1000)
  if not rows:
   result['receivers'].append({'browser':browser,'error':'No inbound audio stats'})
   continue
  samples=[r['browsers'][index] for r in receiver_records]
  poll_gaps=[b['observedAtMs']-a['observedAtMs'] for a,b in zip(samples,samples[1:]) if 'observedAtMs' in a and 'observedAtMs' in b]
  result.setdefault('receiverObservationGapsMs',{})[browser]=distribution(poll_gaps)
  first,last=rows[0],rows[-1]
  result['receivers'].append({'browser':browser,'first':first,'last':last,'jitterMs':distribution([r['jitter']*1000 for r in rows if 'jitter' in r]),'bufferMs':distribution(interval_buffer),'concealedDelta':counter_delta(first,last,'concealed'),'insertedDelta':counter_delta(first,last,'inserted'),'removedDelta':counter_delta(first,last,'removed')})
 return result
for directory in sys.argv[1:]:print(json.dumps(summarize(directory),indent=2))
