import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  AudioRegion,
  computeFrameEnergies,
  decodeWav,
  estimateEnergyThreshold,
  fixPauses,
  split,
  splitAll,
  trim,
} from "../src/index.js";

const fixturesDir = fileURLToPath(new URL("fixtures/", import.meta.url));
const bursts = decodeWav(readFileSync(`${fixturesDir}bursts_16k_mono.wav`));
const stereo = decodeWav(readFileSync(`${fixturesDir}bursts_16k_stereo.wav`));

/** Interleave planar channels and re-chunk with an awkward chunk size,
 * to feed the streaming path. */
async function* chunkStream(
  channelData: readonly Float32Array[],
  chunkSize: number,
): AsyncGenerator<Float32Array> {
  const channels = channelData.length;
  const interleaved = new Float32Array(channelData[0].length * channels);
  for (let i = 0; i < channelData[0].length; i++) {
    for (let c = 0; c < channels; c++) {
      interleaved[i * channels + c] = channelData[c][i];
    }
  }
  for (let at = 0; at < interleaved.length; at += chunkSize) {
    yield interleaved.subarray(at, Math.min(at + chunkSize, interleaved.length));
  }
}

describe("split", () => {
  it("yields identical events for in-memory and chunk-stream input", async () => {
    const memoryEvents = await splitAll(bursts);
    expect(memoryEvents.length).toBeGreaterThan(0);
    const streamEvents = await splitAll(
      chunkStream(bursts.channelData, 1234),
      { sampleRate: bursts.sampleRate },
    );
    expect(streamEvents.length).toBe(memoryEvents.length);
    streamEvents.forEach((event, i) => {
      expect(event.start).toBe(memoryEvents[i].start);
      expect(event.end).toBe(memoryEvents[i].end);
    });
  });

  it("handles interleaved multichannel chunk-stream input", async () => {
    const memoryEvents = await splitAll(stereo);
    const streamEvents = await splitAll(
      chunkStream(stereo.channelData, 999),
      { sampleRate: stereo.sampleRate, channels: 2 },
    );
    expect(streamEvents.length).toBe(memoryEvents.length);
    streamEvents.forEach((event, i) => {
      expect(event.start).toBe(memoryEvents[i].start);
      expect(event.channels).toBe(2);
    });
  });

  it("gives 'validator' absolute precedence over 'energyThreshold'", async () => {
    const estimated = await splitAll(bursts, { validator: "otsu" });
    const withIgnoredThreshold = await splitAll(bursts, {
      validator: "otsu",
      energyThreshold: 99,
    });
    expect(withIgnoredThreshold.map((e) => [e.start, e.end])).toEqual(
      estimated.map((e) => [e.start, e.end]),
    );
  });

  it("accepts a custom validator function", async () => {
    const samples = new Float32Array(16000); // 1 s of digital silence
    const events = await splitAll(samples, {
      sampleRate: 16000,
      validator: () => true,
      maxDur: null,
    });
    expect(events.length).toBe(1);
    expect(events[0].start).toBe(0);
    expect(events[0].duration).toBeCloseTo(1, 9);
  });

  it("streams events out before the input ends", async () => {
    let chunksDelivered = 0;
    async function* countingChunks() {
      for await (const chunk of chunkStream(bursts.channelData, 800)) {
        chunksDelivered += 1;
        yield chunk;
      }
    }
    const iterator = split(countingChunks(), {
      sampleRate: bursts.sampleRate,
    });
    const first = await iterator.next();
    expect(first.done).toBe(false);
    const totalChunks = Math.ceil(bursts.channelData[0].length / 800);
    // the first event ends at 1.6 s of the 4.25 s input: it must be
    // delivered well before the stream is exhausted
    expect(chunksDelivered).toBeLessThan(totalChunks / 2);
    await iterator.return();
  });

  it("calibrates estimation on chunk-stream input on the first 3 s", async () => {
    // reference: threshold estimated from the first ceil(3 / windowDur)
    // windows, clamped to the default floor of 40 dB
    const frameSamples = Math.floor(0.05 * bursts.sampleRate);
    const windowDur = frameSamples / bursts.sampleRate;
    const nFrames = Math.max(1, Math.ceil(3 / windowDur));
    const calibrationData = bursts.channelData.map((channel) =>
      channel.subarray(0, nFrames * frameSamples),
    );
    const threshold = Math.max(
      estimateEnergyThreshold(
        computeFrameEnergies(calibrationData, frameSamples),
      ),
      40,
    );
    const expected = await splitAll(bursts, { energyThreshold: threshold });
    expect(expected.length).toBeGreaterThan(0);

    const calibrated = await splitAll(chunkStream(bursts.channelData, 1234), {
      sampleRate: bursts.sampleRate,
      validator: "otsu",
    });
    expect(calibrated.map((e) => [e.start, e.end])).toEqual(
      expected.map((e) => [e.start, e.end]),
    );
  });

  it("replays the calibration audio, losing no events to calibration", async () => {
    const sr = 16000;
    const samples = new Float32Array(sr * 4);
    samples.fill(0.0005); // quiet but not digitally silent background
    samples.fill(0.3, sr, Math.floor(sr * 1.5)); // burst at 1.0-1.5 s
    const events = await splitAll(chunkStream([samples], 1000), {
      sampleRate: sr,
      validator: "otsu",
      maxTrailingSilence: 0,
    });
    expect(events.length).toBe(1);
    expect(events[0].start).toBeCloseTo(1.0, 5);
    expect(events[0].end).toBeCloseTo(1.5, 5);
  });

  it("falls back to minEnergyThreshold on a silent calibration window", async () => {
    const sr = 16000;
    const samples = new Float32Array(sr * 4); // digital silence
    samples.fill(0.3, Math.floor(sr * 3.2), Math.floor(sr * 3.7));
    const events = await splitAll(chunkStream([samples], 1000), {
      sampleRate: sr,
      validator: "otsu",
    });
    expect(events.length).toBe(1);
    expect(events[0].start).toBeCloseTo(3.2, 5);

    // a floor above the burst energy (~79.8 dB) must reject it
    const rejected = await splitAll(chunkStream([samples], 1000), {
      sampleRate: sr,
      validator: "otsu",
      minEnergyThreshold: 85,
    });
    expect(rejected.length).toBe(0);
  });

  it("validates calibrationDur and requires calibration data", async () => {
    await expect(
      splitAll(chunkStream(bursts.channelData, 800), {
        sampleRate: bursts.sampleRate,
        validator: "otsu",
        calibrationDur: 0,
      }),
    ).rejects.toThrow(/calibrationDur/);
    async function* empty(): AsyncGenerator<Float32Array> {}
    await expect(
      splitAll(empty(), { sampleRate: 16000, validator: "otsu" }),
    ).rejects.toThrow(/calibration/);
  });

  it("requires sampleRate for bare samples", async () => {
    await expect(splitAll(new Float32Array(1000))).rejects.toThrow(
      /sampleRate/,
    );
  });

  it("rejects unknown validator names", async () => {
    await expect(
      splitAll(bursts, { validator: "p0" }),
    ).rejects.toThrow(/unknown validator/);
    await expect(
      splitAll(bursts, { validator: "p100" }),
    ).rejects.toThrow(/unknown validator/);
  });

  it("validates duration parameters", async () => {
    await expect(splitAll(bursts, { minDur: 0 })).rejects.toThrow(RangeError);
    await expect(splitAll(bursts, { maxSilence: -1 })).rejects.toThrow(
      RangeError,
    );
    await expect(
      splitAll(bursts, { minDur: 2, maxDur: 1 }),
    ).rejects.toThrow(/minDur/);
    await expect(
      splitAll(bursts, { maxSilence: 5, maxDur: 5 }),
    ).rejects.toThrow(/maxSilence/);
  });
});

describe("trim", () => {
  it("keeps audio from the first to the last detection", async () => {
    const events = await splitAll(bursts, { maxDur: null });
    const first = events[0];
    const last = events[events.length - 1];
    const trimmed = await trim(bursts);
    expect(trimmed.start).toBe(first.start);
    expect(trimmed.duration).toBeCloseTo(last.end - first.start, 9);
  });

  it("works on chunk-stream input in a single pass", async () => {
    const fromMemory = await trim(bursts);
    const fromStream = await trim(chunkStream(bursts.channelData, 1000), {
      sampleRate: bursts.sampleRate,
    });
    expect(fromStream.start).toBe(fromMemory.start);
    expect(fromStream.sampleCount).toBe(fromMemory.sampleCount);
    expect(fromStream.channelData[0]).toEqual(fromMemory.channelData[0]);
  });

  it("returns an empty region when nothing is detected", async () => {
    const silent = new Float32Array(16000);
    const trimmed = await trim(silent, { sampleRate: 16000 });
    expect(trimmed.duration).toBe(0);
  });

  it("does not accept maxDur", async () => {
    await expect(
      // @ts-expect-error maxDur is rejected by the types too
      trim(bursts, { maxDur: 1 }),
    ).rejects.toThrow(TypeError);
  });
});

describe("fixPauses", () => {
  it("joins events with the requested silence duration", async () => {
    const events = await splitAll(bursts, { maxDur: null });
    const gap = 0.2;
    const fixed = await fixPauses(bursts, gap);
    const expectedSamples =
      events.reduce((sum, e) => sum + e.sampleCount, 0) +
      (events.length - 1) * Math.round(gap * bursts.sampleRate);
    expect(fixed.sampleCount).toBe(expectedSamples);
    // inserted gaps are digital silence
    const firstGapStart = events[0].sampleCount;
    const slice = fixed.channelData[0].subarray(
      firstGapStart,
      firstGapStart + Math.round(gap * bursts.sampleRate),
    );
    expect(slice.every((v) => v === 0)).toBe(true);
  });

  it("returns an empty region when nothing is detected", async () => {
    const silent = new Float32Array(16000);
    const fixed = await fixPauses(silent, 0.5, { sampleRate: 16000 });
    expect(fixed.duration).toBe(0);
  });
});

describe("AudioRegion", () => {
  it("exposes timing and shape", () => {
    const region = new AudioRegion([new Float32Array(8000)], 16000, 1.5);
    expect(region.duration).toBeCloseTo(0.5, 12);
    expect(region.end).toBeCloseTo(2.0, 12);
    expect(region.channels).toBe(1);
    expect(region.sampleCount).toBe(8000);
  });

  it("rejects mismatched channel lengths", () => {
    expect(
      () => new AudioRegion([new Float32Array(10), new Float32Array(9)], 8000),
    ).toThrow(RangeError);
  });
});
