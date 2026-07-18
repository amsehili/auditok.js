#!/usr/bin/env python3
"""Generate cross-implementation parity fixtures from Python auditok.

Runs the Python StreamTokenizer over a matrix of string inputs and the
Python `split` over synthesized WAV files, and records the expected
outputs as JSON. The JS test suite replays the same inputs through the
JS port and compares. Run from the repository root with a Python that
has auditok >= 0.5.1 and numpy:

    python tools/generate_fixtures.py
"""

import json
import wave
from pathlib import Path

import numpy as np

import auditok
from auditok import split
from auditok.core import StreamTokenizer
from auditok.signal import compute_frame_energies, estimate_energy_threshold
from auditok.util import StringDataSource

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "tests" / "fixtures"
SAMPLING_RATE = 16000

TOKENIZER_PARAMS = [
    {"min_length": 3, "max_length": 4, "max_continuous_silence": 0},
    {
        "min_length": 3,
        "max_length": 4,
        "max_continuous_silence": 0,
        "mode": StreamTokenizer.STRICT_MIN_LENGTH,
    },
    {"min_length": 5, "max_length": 10, "max_continuous_silence": 0},
    {"min_length": 5, "max_length": 10, "max_continuous_silence": 1},
    {"min_length": 6, "max_length": 20, "max_continuous_silence": 2},
    {"min_length": 1, "max_length": 1, "max_continuous_silence": 0},
    {"min_length": 4, "max_length": 5, "max_continuous_silence": 2},
    {"min_length": 3, "max_length": None, "max_continuous_silence": 2},
    {
        "min_length": 3,
        "max_length": None,
        "max_continuous_silence": 1,
        "max_trailing_silence": 0,
    },
    {
        "min_length": 3,
        "max_length": 10,
        "max_continuous_silence": 2,
        "max_trailing_silence": 0,
    },
    {
        "min_length": 3,
        "max_length": 10,
        "max_continuous_silence": 3,
        "max_trailing_silence": 1,
    },
    {
        "min_length": 3,
        "max_length": 10,
        "max_continuous_silence": 1,
        "max_trailing_silence": 4,
    },
    {
        "min_length": 3,
        "max_length": 10,
        "max_continuous_silence": 0,
        "max_trailing_silence": 3,
    },
    {
        "min_length": 3,
        "max_length": 10,
        "max_continuous_silence": 2,
        "max_leading_silence": 3,
    },
    {
        "min_length": 3,
        "max_length": 10,
        "max_continuous_silence": 2,
        "max_leading_silence": 2,
        "max_trailing_silence": 1,
    },
    {
        "min_length": 3,
        "max_length": 8,
        "max_continuous_silence": 2,
        "init_min": 3,
        "init_max_silence": 2,
    },
    {
        "min_length": 3,
        "max_length": 8,
        "max_continuous_silence": 2,
        "init_min": 3,
        "init_max_silence": 0,
    },
]

TOKENIZER_INPUTS = [
    "aaaAAAABBbbb",
    "aaaAAAaaaBBbbbb",
    "AAAAAAAAAAAAAAAAAAAA",
    "aaaaaaaaaaaaaaaaaaaa",
    "aaAAaaAAaaAAaaAAaaAA",
    "AAaAAaAAaAAaAA",
    "aaaaAAAAAaaAAAAAaaaaaAAAAAaaaa",
    "AaaaAaaaAaaaAaaaAaaa",
    "aaaAAAAAAAAAAAAaaaaaaaAAAAAAAAAAAaaaAaaa",
    "AAAAaaaaAAAAaaaaAAAA",
    "aAaAaAaAaAaAaA",
    "A",
    "a",
    "aA",
    "Aa",
    "aaAAAaaaaAAAAAaaAAaaaaaAAAAAAAAAAAAAaaaaaaaAAAAAaa",
]


def upper_case_validator(frame):
    return frame.isupper()


def generate_tokenizer_cases():
    cases = []
    for params in TOKENIZER_PARAMS:
        for text in TOKENIZER_INPUTS:
            kwargs = dict(params)
            if kwargs["max_length"] is None:
                kwargs["max_length"] = float("inf")
            tokenizer = StreamTokenizer(upper_case_validator, **kwargs)
            tokens = tokenizer.tokenize(StringDataSource(text))
            cases.append(
                {
                    "params": params,
                    "input": text,
                    "tokens": [
                        {"data": "".join(data), "start": start, "end": end}
                        for data, start, end in tokens
                    ],
                }
            )
    return cases


def sine(freq, duration, amplitude):
    t = np.arange(round(duration * SAMPLING_RATE)) / SAMPLING_RATE
    return (np.sin(2 * np.pi * freq * t) * amplitude).astype(np.int16)


def noise(duration, amplitude, rng):
    n = round(duration * SAMPLING_RATE)
    return (rng.randn(n) * amplitude).clip(-32768, 32767).astype(np.int16)


def zeros(duration):
    return np.zeros(round(duration * SAMPLING_RATE), dtype=np.int16)


def write_wav(path, samples, channels=1):
    with wave.open(str(path), "wb") as fp:
        fp.setnchannels(channels)
        fp.setsampwidth(2)
        fp.setframerate(SAMPLING_RATE)
        fp.writeframes(samples.tobytes())


def build_audio_files():
    rng = np.random.RandomState(42)

    # background noise well below the default 50 dB threshold, tone
    # bursts well above it
    bursts = np.concatenate(
        [
            noise(0.5, 30, rng),
            sine(400, 0.8, 8000),
            noise(0.6, 30, rng),
            sine(300, 1.2, 5000),
            noise(0.4, 30, rng),
            sine(500, 0.25, 6000),
            noise(0.5, 30, rng),
        ]
    )
    write_wav(FIXTURES_DIR / "bursts_16k_mono.wav", bursts)

    # digitally silent padding around one burst: exercises the -200 dB
    # sentinel exclusion in threshold estimation
    silence_padded = np.concatenate(
        [zeros(1.0), sine(440, 0.5, 4000), zeros(1.0)]
    )
    write_wav(FIXTURES_DIR / "silence_padded_16k_mono.wav", silence_padded)

    # stereo: quiet noise on channel 0, activity on channel 1 only
    left = noise(4.0, 30, rng)
    right = np.concatenate(
        [
            noise(0.7, 30, rng),
            sine(350, 1.0, 7000),
            noise(0.8, 30, rng),
            sine(450, 0.9, 6000),
            noise(0.6, 30, rng),
        ]
    )
    n = min(len(left), len(right))
    stereo = np.empty(2 * n, dtype=np.int16)
    stereo[0::2] = left[:n]
    stereo[1::2] = right[:n]
    write_wav(FIXTURES_DIR / "bursts_16k_stereo.wav", stereo, channels=2)

    # entirely digitally silent
    write_wav(FIXTURES_DIR / "all_silent_16k_mono.wav", zeros(2.0))


SPLIT_CASES = [
    {"file": "bursts_16k_mono.wav", "options": {}},
    {
        "file": "bursts_16k_mono.wav",
        "options": {
            "energy_threshold": 60,
            "min_dur": 0.3,
            "max_silence": 0.2,
        },
    },
    {"file": "bursts_16k_mono.wav", "options": {"max_dur": 0.5}},
    {"file": "bursts_16k_mono.wav", "options": {"validator": "otsu"}},
    {"file": "bursts_16k_mono.wav", "options": {"validator": "p20"}},
    {
        "file": "bursts_16k_mono.wav",
        "options": {
            "max_leading_silence": 0.1,
            "max_trailing_silence": 0.1,
        },
    },
    {"file": "bursts_16k_mono.wav", "options": {"max_trailing_silence": 0}},
    {
        "file": "bursts_16k_mono.wav",
        "options": {"min_dur": 0.3, "max_silence": 0.5, "max_dur": 10},
    },
    {"file": "silence_padded_16k_mono.wav", "options": {}},
    {"file": "silence_padded_16k_mono.wav", "options": {"validator": "otsu"}},
    {"file": "bursts_16k_stereo.wav", "options": {}},
    {"file": "bursts_16k_stereo.wav", "options": {"use_channel": "mix"}},
    {"file": "bursts_16k_stereo.wav", "options": {"use_channel": 0}},
    {"file": "bursts_16k_stereo.wav", "options": {"validator": "otsu"}},
    {"file": "all_silent_16k_mono.wav", "options": {}},
    {"file": "all_silent_16k_mono.wav", "options": {"validator": "otsu"}},
]

THRESHOLD_CASES = [
    {"file": "bursts_16k_mono.wav", "method": "otsu"},
    {"file": "bursts_16k_mono.wav", "method": "percentile", "percentile": 20},
    {"file": "silence_padded_16k_mono.wav", "method": "otsu"},
    {"file": "bursts_16k_stereo.wav", "method": "otsu"},
]


def generate_split_cases():
    cases = []
    for case in SPLIT_CASES:
        path = FIXTURES_DIR / case["file"]
        regions = list(split(str(path), **case["options"]))
        cases.append(
            {
                "file": case["file"],
                "options": case["options"],
                "events": [
                    {"start": region.start, "end": region.end}
                    for region in regions
                ],
            }
        )
    return cases


def generate_threshold_cases():
    cases = []
    for case in THRESHOLD_CASES:
        path = FIXTURES_DIR / case["file"]
        region = auditok.load(str(path))
        energies = compute_frame_energies(
            bytes(region), region.sw, region.ch, round(0.05 * region.sr)
        )
        kwargs = (
            {"percentile": case["percentile"]} if "percentile" in case else {}
        )
        threshold = estimate_energy_threshold(
            energies, method=case["method"], **kwargs
        )
        cases.append(
            {
                "file": case["file"],
                "method": case["method"],
                **kwargs,
                "threshold": threshold,
            }
        )
    return cases


def main():
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    build_audio_files()
    fixtures = {
        "auditok_version": auditok.__version__,
        "tokenizer_cases": generate_tokenizer_cases(),
        "split_cases": generate_split_cases(),
        "threshold_cases": generate_threshold_cases(),
    }
    out = FIXTURES_DIR / "parity.json"
    out.write_text(json.dumps(fixtures, indent=1))
    n_tokens = len(fixtures["tokenizer_cases"])
    n_split = len(fixtures["split_cases"])
    print(f"wrote {out}: {n_tokens} tokenizer cases, {n_split} split cases")


if __name__ == "__main__":
    main()
