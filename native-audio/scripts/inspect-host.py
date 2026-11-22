#!/usr/bin/env python3
"""Read-only host evidence. No audio, command lines, environment or credentials.

Run on the desktop host during the failure; stdout is metadata-only JSON.
CPU is percent of one core. schedstat wait is summed across surviving threads.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import tempfile
import threading
import shutil

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--seconds', type=int, default=15)
parser.add_argument('--binary', type=Path, default=Path(__file__).resolve().parents[1] / 'whiterun-audio')
args = parser.parse_args()
if not 1 <= args.seconds <= 600:
    parser.error('--seconds must be 1..600')

def digest(path):
    with open(path, 'rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()

def processes():
    rows = {}
    for proc in Path('/proc').glob('[0-9]*'):
        try:
            name = (proc / 'comm').read_text().strip()
            if not any(word in name.lower() for word in ('whiterun', 'pw-cat', 'ffmpeg', 'pipewire', 'chrom', 'firefox', 'livekit', 'web content')):
                continue
            stat = (proc / 'stat').read_text().rsplit(')', 1)[1].split()
            threads = {}
            for task in (proc / 'task').iterdir():
                try:
                    threads[task.name] = list(map(int, (task / 'schedstat').read_text().split()))
                except (OSError, ValueError):
                    pass
            row = {'pid': int(proc.name), 'name': name, 'startTicks': int(stat[19]), 'cpuTicks': int(stat[11]) + int(stat[12]), 'threads': threads}
            if name.startswith('whiterun'):
                row['executable'] = os.readlink(proc / 'exe')
                row['sha256'] = digest(proc / 'exe')
            rows[proc.name] = row
        except (OSError, ValueError):
            continue
    return rows

def graph():
    raw = json.loads(subprocess.check_output(['pw-dump'], timeout=5))
    rows = []
    for obj in raw:
        info = obj.get('info', {})
        props = info.get('props', {})
        if obj['type'].endswith(':Node'):
            keys = ['node.name', 'media.class', 'node.rate', 'audio.rate', 'audio.channels', 'application.name', 'application.process.id', 'object.serial']
            rows.append({'id': obj['id'], 'type': 'node', 'state': info.get('state'), 'props': {k: props[k] for k in keys if k in props}, 'format': info.get('params', {}).get('Format')})
        elif obj['type'].endswith(':Link'):
            rows.append({'id': obj['id'], 'type': 'link', **{k: info.get(k) for k in ['output-node-id', 'input-node-id', 'output-port-id', 'input-port-id', 'state']}})
    return rows

def gpu():
    rows = []
    for path in Path('/sys/class/drm').glob('card*/device/gpu_busy_percent'):
        try: rows.append({'device': str(path.parent.parent.name), 'busyPercent': int(path.read_text())})
        except (OSError, ValueError): pass
    if shutil.which('nvidia-smi'):
        try:
            query = subprocess.run(['nvidia-smi', '--query-gpu=index,utilization.gpu,utilization.memory,utilization.encoder,utilization.decoder', '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=2)
            rows.append({'provider': 'nvidia-smi', 'columns': ['index', 'gpuPercent', 'memoryPercent', 'encoderPercent', 'decoderPercent'], 'csv': query.stdout.strip(), 'error': query.stderr.strip() or None, 'returncode': query.returncode})
        except (OSError, subprocess.TimeoutExpired) as error: rows.append({'provider': 'nvidia-smi', 'error': str(error)})
    return rows or [{'error': 'No accessible GPU utilization provider'}]

result = {'startedUnixMs': time.time_ns() // 1000000, 'binary': str(args.binary), 'binarySHA256': digest(args.binary), 'graphBefore': graph()}
before = processes()
started = time.monotonic()
# Sample underruns throughout the CPU/scheduler observation, not afterwards.
# A file prevents a full subprocess stdout pipe from blocking pw-top.
top_output = tempfile.TemporaryFile(mode='w+t')
top_error = tempfile.TemporaryFile(mode='w+t')
top_lines = []
def collect_top():
    for line in top.stdout:
        top_lines.append({'unixMs': time.time_ns() // 1000000, 'line': line.rstrip()})
        top_output.write(line)

try:
    top = subprocess.Popen(['pw-top', '-b', '-n', str(args.seconds + 1)], stdout=subprocess.PIPE, stderr=top_error, text=True)
    top_reader = threading.Thread(target=collect_top, daemon=True)
    top_reader.start()
except OSError as error:
    top = None
    result['pwTopError'] = str(error)
timeline = []
observed_helpers = {}
result['graphSamples'] = []
previous = before
for _ in range(args.seconds):
    time.sleep(max(0, started + _ + 1 - time.monotonic()))
    current = processes()
    sample = {'unixMs': time.time_ns() // 1000000, 'systemCPUTicks': Path('/proc/stat').read_text().splitlines()[0], 'gpu': gpu(), 'elapsedSeconds': time.monotonic() - started, 'processes': []}
    for pid, row in current.items():
        if 'sha256' in row:
            observed_helpers[(pid, row['startTicks'])] = {k: row[k] for k in ('pid', 'startTicks', 'executable', 'sha256')}
        old = previous.get(pid)
        if old and old['startTicks'] == row['startTicks']:
            waits = [v[1] - old['threads'][tid][1] for tid, v in row['threads'].items() if tid in old['threads']]
            sample['processes'].append({'pid': row['pid'], 'name': row['name'], 'cpuSeconds': (row['cpuTicks'] - old['cpuTicks']) / os.sysconf('SC_CLK_TCK'), 'schedulerWaitMsSurvivingThreads': sum(waits) / 1e6, 'maxThreadSchedulerWaitMs': max(waits, default=0) / 1e6})
    timeline.append(sample)
    if len(timeline) % 5 == 0:
        result['graphSamples'].append({'unixMs': time.time_ns() // 1000000, 'elapsedSeconds': time.monotonic() - started, 'graph': graph()})
    previous = current
result['timeline'] = timeline
result['observedHelpers'] = [{**row, 'matchesDiskBinary': row['sha256'] == result['binarySHA256']} for row in observed_helpers.values()]
after = current
elapsed = time.monotonic() - started
result['seconds'] = elapsed
result['processes'] = []
for pid, row in after.items():
    previous = before.get(pid)
    current_threads = row.pop('threads')
    if previous and previous['startTicks'] == row['startTicks']:
        row['cpuPercentOneCore'] = (row['cpuTicks'] - previous['cpuTicks']) / os.sysconf('SC_CLK_TCK') / elapsed * 100
        waits = [v[1] - previous['threads'][tid][1] for tid, v in current_threads.items() if tid in previous['threads']]
        row['schedulerWaitMsSurvivingThreads'] = sum(waits) / 1e6
        row['maxThreadSchedulerWaitMs'] = max(waits, default=0) / 1e6
    if 'sha256' in row:
        row['matchesDiskBinary'] = row['sha256'] == result['binarySHA256']
    result['processes'].append(row)
result['graphAfter'] = graph()
if top is not None:
    try:
        top.wait(timeout=2)
    except subprocess.TimeoutExpired:
        top.terminate()
        top.wait(timeout=2)
    top_reader.join(timeout=3)
    result['pwTopTimestampedLines'] = top_lines
    top_output.seek(0)
    top_error.seek(0)
    result['pwTop'] = top_output.read()
    result['pwTopError'] = top_error.read()
top_output.close()
top_error.close()
print(json.dumps(result, indent=2))
