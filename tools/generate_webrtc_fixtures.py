#!/usr/bin/env python3
"""Generate WebRTC-VAD parity fixtures from Python webrtcvad/auditok.

Records (a) raw frame decisions of the Python `webrtcvad` package —
which wraps the same C code as our libfvad WASM build, so decisions
must match bit for bit — and (b) events from Python
`auditok.split(..., validator="webrtc:N")`, for the JS test suite to
replay. Run from the repository root with a Python that has
auditok >= 0.5.1 (with the webrtcvad extra) and numpy:

    python tools/generate_webrtc_fixtures.py
"""

import base64
import json
import math
import wave
from pathlib import Path

import webrtcvad

from auditok import split

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "tests" / "fixtures"

# (rate, tone amplitude) synthetic sequences: tone / silence / faint
# tone. The exact int16 PCM is stored in the fixture so both sides
# read identical bytes (recomputing sines could round differently).
SYNTHETIC_RATES = [8000, 32000, 48000]


def synthetic_pcm(rate):
    samples = []
    for freq, amp, dur in [
        (300, 12000, 0.3),
        (0, 0, 0.3),
        (440, 9000, 0.2),
        (0, 0, 0.2),
        (220, 800, 0.3),
    ]:
        n = round(dur * rate)
        if freq == 0:
            samples.extend([0] * n)
        else:
            samples.extend(
                round(math.sin(2 * math.pi * freq * i / rate) * amp)
                for i in range(n)
            )
    import struct

    return struct.pack(f"<{len(samples)}h", *samples)


def read_wav_pcm(name):
    with wave.open(str(FIXTURES_DIR / name), "rb") as fp:
        assert fp.getnchannels() == 1 and fp.getsampwidth() == 2
        return fp.readframes(fp.getnframes()), fp.getframerate()


def decisions(pcm, rate, mode, subframe_ms):
    vad = webrtcvad.Vad(mode)
    subframe_bytes = int(subframe_ms / 1000 * rate) * 2
    n = len(pcm) // subframe_bytes
    return "".join(
        "1"
        if vad.is_speech(
            pcm[i * subframe_bytes : (i + 1) * subframe_bytes], rate
        )
        else "0"
        for i in range(n)
    )


def generate_frame_cases():
    cases = []
    bursts_pcm, bursts_rate = read_wav_pcm("bursts_16k_mono.wav")
    for mode in range(4):
        cases.append(
            {
                "source": "bursts_16k_mono.wav",
                "rate": bursts_rate,
                "mode": mode,
                "subframe_ms": 10,
                "decisions": decisions(bursts_pcm, bursts_rate, mode, 10),
            }
        )
    for subframe_ms in (20, 30):
        cases.append(
            {
                "source": "bursts_16k_mono.wav",
                "rate": bursts_rate,
                "mode": 1,
                "subframe_ms": subframe_ms,
                "decisions": decisions(
                    bursts_pcm, bursts_rate, 1, subframe_ms
                ),
            }
        )
    for rate in SYNTHETIC_RATES:
        pcm = synthetic_pcm(rate)
        cases.append(
            {
                "source": "synthetic",
                "rate": rate,
                "mode": 1,
                "subframe_ms": 10,
                "pcm_base64": base64.b64encode(pcm).decode(),
                "decisions": decisions(pcm, rate, 1, 10),
            }
        )
    return cases


SPLIT_CASES = [
    {"file": "bursts_16k_mono.wav", "mode": 1, "options": {}},
    {"file": "bursts_16k_mono.wav", "mode": 3, "options": {}},
    {
        "file": "bursts_16k_mono.wav",
        "mode": 1,
        "options": {"max_silence": 0.1},
    },
    {"file": "bursts_16k_stereo.wav", "mode": 1, "options": {}},
]


def generate_split_cases():
    cases = []
    for case in SPLIT_CASES:
        regions = list(
            split(
                str(FIXTURES_DIR / case["file"]),
                validator=f"webrtc:{case['mode']}",
                **case["options"],
            )
        )
        cases.append(
            {
                "file": case["file"],
                "mode": case["mode"],
                "options": case["options"],
                "events": [
                    {"start": region.start, "end": region.end}
                    for region in regions
                ],
            }
        )
    return cases


def main():
    fixtures = {
        "frame_cases": generate_frame_cases(),
        "split_cases": generate_split_cases(),
    }
    out = FIXTURES_DIR / "webrtc-parity.json"
    out.write_text(json.dumps(fixtures, indent=1))
    n_frames = sum(len(c["decisions"]) for c in fixtures["frame_cases"])
    print(
        f"wrote {out}: {len(fixtures['frame_cases'])} frame cases "
        f"({n_frames} subframe decisions), "
        f"{len(fixtures['split_cases'])} split cases"
    )


if __name__ == "__main__":
    main()
