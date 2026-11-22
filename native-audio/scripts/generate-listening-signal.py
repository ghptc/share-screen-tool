#!/usr/bin/env python3
"""Generate an original, deterministic 30-second stereo listening fixture.

Continuous quiet carrier plus changing notes; smooth five-second markers.
No silence or hard discontinuities are intentional. No external media is used.
"""
import argparse
import hashlib
import math
import struct
import wave
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('output', type=Path)
args = parser.parse_args()
rate = 48000
notes = [220, 275, 330, 440, 330, 275]
with args.output.open('xb') as target:
    with wave.open(target, 'wb') as audio:
        audio.setparams((2, 2, rate, 0, 'NONE', 'not compressed'))
        for second in range(30):
            chunk = bytearray()
            for frame in range(rate):
                t = second + frame / rate
                phase = frame / rate
                envelope = math.sin(math.pi * phase) ** 2
                marker = .025 * math.sin(2 * math.pi * 880 * t) * math.sin(math.pi * phase / .25) ** 2 if second % 5 == 0 and phase < .25 else 0
                # Integer-Hz carriers and zero note envelopes make the loop continuous.
                left = .035 * math.sin(2 * math.pi * 197 * t) + .045 * envelope * math.sin(2 * math.pi * notes[second % 6] * t) + marker
                right = .035 * math.sin(2 * math.pi * 203 * t) + .045 * envelope * math.sin(2 * math.pi * notes[second % 6] * t) + marker
                chunk.extend(struct.pack('<hh', round(left * 32767), round(right * 32767)))
            audio.writeframes(chunk)
print(hashlib.sha256(args.output.read_bytes()).hexdigest(), args.output)
