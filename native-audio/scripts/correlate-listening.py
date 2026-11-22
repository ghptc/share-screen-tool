#!/usr/bin/env python3
"""Correlate listener markers with metadata in a +/-2 second window.

Markers reflect human reaction time, not sample-accurate glitch onsets.
No marker or a clean counter is not evidence of a listening pass.
"""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('directory', type=Path)
args = parser.parse_args()

def jsonl(name):
    path = args.directory / name
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()] if path.exists() else []

def document(name, default):
    path = args.directory / name
    return json.loads(path.read_text()) if path.exists() else default

events = jsonl('publisher.jsonl')
receivers = document('receivers.json', [])
host = document('host.json', {})
markers = jsonl('listening-markers.jsonl')
result = {'listeningValidated': False, 'note': __doc__, 'markers': markers, 'correlations': []}
for marker in markers:
    if marker['kind'] not in ('glitch', 'fail'):
        continue
    at = marker['unixMs']
    near = lambda row: abs(row.get('unixMs', -1) - at) <= 2000
    frames = [e for e in events if near(e)]
    def maximum(key):
        values = [e[key] for e in frames if key in e]
        return max(values) if values else None
    samples = [r for r in receivers if near(r)]
    packets = [e for e in frames if e['stage'] == 'rtp_write']
    gaps = [b['unixMs'] - a['unixMs'] for a, b in zip(packets, packets[1:])]
    browser_index = 0 if marker['browser'] == 'chromium' else 1
    selected = [r['browsers'][browser_index] for r in samples]
    result['correlations'].append({
        'marker': marker, 'windowMs': 2000,
        'maxPipeQueuedMs': maximum('pipeQueuedMsBeforeRead'),
        'maxEncodeMs': maximum('encoderMs'), 'maxScheduleLateMs': maximum('lateMs'),
        'maxSDKWriteMs': maximum('writeMs'),
        'maxRTPSendGapMs': max(gaps) if gaps else None,
        'sfuReceiverReports': [e for e in frames if e['stage'] == 'rtcp_receiver_report'],
        'receiverBefore': selected[0] if selected else None,
        'receiverAfter': selected[-1] if selected else None,
        'desktopVideoSamples': [r.get('publisherVideo') for r in samples],
        'hostSamples': [r for r in host.get('timeline', []) if near(r)],
        'pipeWireCounters': [r for r in host.get('pwTopTimestampedLines', []) if near(r)],
    })
print(json.dumps(result, indent=2))
