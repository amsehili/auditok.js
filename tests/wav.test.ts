import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { decodeWav, encodeWav, isWav, makeSilence } from "../src/index.js";

const fixturesDir = fileURLToPath(new URL("fixtures/", import.meta.url));

describe("wav codec", () => {
  it("decodes a 16-bit PCM file written by Python", () => {
    const { channelData, sampleRate } = decodeWav(
      readFileSync(`${fixturesDir}bursts_16k_mono.wav`),
    );
    expect(sampleRate).toBe(16000);
    expect(channelData.length).toBe(1);
    expect(channelData[0].length).toBe(Math.round(4.25 * 16000));
  });

  it("decodes stereo into planar channels", () => {
    const { channelData } = decodeWav(
      readFileSync(`${fixturesDir}bursts_16k_stereo.wav`),
    );
    expect(channelData.length).toBe(2);
    expect(channelData[0].length).toBe(channelData[1].length);
  });

  it("roundtrips 16-bit PCM exactly on the int16 grid", () => {
    const samples = Float32Array.from(
      [-32768, -12345, -1, 0, 1, 999, 32767],
      (v) => v / 32768,
    );
    const decoded = decodeWav(
      encodeWav({ channelData: [samples], sampleRate: 8000 }),
    );
    expect(decoded.sampleRate).toBe(8000);
    expect(decoded.channelData[0]).toEqual(samples);
  });

  it("roundtrips float32 exactly", () => {
    const samples = Float32Array.from([0.1, -0.25, 0.5, -1, 1, 0.0001]);
    const decoded = decodeWav(
      encodeWav(
        { channelData: [samples], sampleRate: 44100 },
        { bitDepth: "float32" },
      ),
    );
    expect(decoded.channelData[0]).toEqual(samples);
  });

  it("roundtrips multichannel interleaving", () => {
    const ch0 = Float32Array.from([0.1, 0.2, 0.3, 0.4]);
    const ch1 = Float32Array.from([-0.1, -0.2, -0.3, -0.4]);
    const decoded = decodeWav(
      encodeWav(
        { channelData: [ch0, ch1], sampleRate: 16000 },
        { bitDepth: "float32" },
      ),
    );
    expect(decoded.channelData[0]).toEqual(ch0);
    expect(decoded.channelData[1]).toEqual(ch1);
  });

  it("identifies WAV data", () => {
    expect(isWav(makeSilence(0.1).toWav())).toBe(true);
    expect(isWav(new Uint8Array([1, 2, 3, 4]))).toBe(false);
  });

  it("rejects non-WAV data", () => {
    expect(() => decodeWav(new Uint8Array(100))).toThrow(/RIFF/);
  });
});
