/**
 * Parity of the libfvad WASM build with Python webrtcvad (which wraps
 * the same C code — decisions must match bit for bit), and of
 * `split` + createWebrtcValidator with Python auditok's
 * `validator="webrtc:N"`. Fixtures come from
 * tools/generate_webrtc_fixtures.py.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { decodeWav, splitAll } from "../../src/index.js";
import { createWebrtcValidator, WebrtcVad } from "../src/index.js";

const fixturesDir = fileURLToPath(
  new URL("../../tests/fixtures/", import.meta.url),
);

interface FrameCase {
  source: string;
  rate: number;
  mode: number;
  subframe_ms: number;
  pcm_base64?: string;
  decisions: string;
}

interface SplitCase {
  file: string;
  mode: number;
  options: { max_silence?: number };
  events: { start: number; end: number }[];
}

const parity = JSON.parse(
  readFileSync(`${fixturesDir}webrtc-parity.json`, "utf8"),
) as { frame_cases: FrameCase[]; split_cases: SplitCase[] };

function int16FromFixture(testCase: FrameCase): Int16Array {
  if (testCase.pcm_base64 !== undefined) {
    const bytes = Buffer.from(testCase.pcm_base64, "base64");
    return new Int16Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength / 2,
    );
  }
  const { channelData } = decodeWav(
    readFileSync(`${fixturesDir}${testCase.source}`),
  );
  // fixture WAVs are 16-bit: scaling back is exact
  return Int16Array.from(channelData[0], (v) => v * 32768);
}

describe("frame-decision parity with Python webrtcvad", () => {
  it.each(
    parity.frame_cases.map(
      (c, i) => [i, c.source, c.rate, c.mode, c.subframe_ms, c] as const,
    ),
  )(
    "case %i: %s @%i Hz mode %i, %i ms subframes",
    async (_i, _src, _rate, _mode, _ms, testCase) => {
      const samples = int16FromFixture(testCase);
      const vad = await WebrtcVad.create(
        testCase.mode,
        testCase.rate as 8000 | 16000 | 32000 | 48000,
      );
      const subframeSamples = Math.floor(
        (testCase.subframe_ms / 1000) * testCase.rate,
      );
      let decisions = "";
      const n = Math.floor(samples.length / subframeSamples);
      for (let s = 0; s < n; s++) {
        const subframe = samples.subarray(
          s * subframeSamples,
          (s + 1) * subframeSamples,
        );
        decisions += vad.isSpeech(subframe) ? "1" : "0";
      }
      vad.destroy();
      expect(decisions).toBe(testCase.decisions);
    },
  );
});

describe("split parity with Python auditok validator='webrtc:N'", () => {
  it.each(
    parity.split_cases.map(
      (c, i) => [i, c.file, c.mode, JSON.stringify(c.options), c] as const,
    ),
  )("case %i: %s mode %i %s", async (_i, file, mode, _opts, testCase) => {
    const audio = decodeWav(readFileSync(`${fixturesDir}${file}`));
    const validator = await createWebrtcValidator({
      sampleRate: audio.sampleRate as 16000,
      mode,
    });
    const events = await splitAll(audio, {
      validator,
      ...(testCase.options.max_silence !== undefined
        ? { maxSilence: testCase.options.max_silence }
        : {}),
    });
    validator.destroy();
    expect(events.length).toBe(testCase.events.length);
    events.forEach((event, k) => {
      expect(event.start).toBeCloseTo(testCase.events[k].start, 9);
      expect(event.end).toBeCloseTo(testCase.events[k].end, 9);
    });
  });
});

describe("WebrtcVad API", () => {
  it("rejects invalid parameters", async () => {
    await expect(WebrtcVad.create(1, 44100 as never)).rejects.toThrow(
      /sample rate/,
    );
    await expect(WebrtcVad.create(7, 16000)).rejects.toThrow(/mode/);
    await expect(
      createWebrtcValidator({ sampleRate: 16000, subframeDur: 0.05 as never }),
    ).rejects.toThrow(/subframeDur/);
    await expect(
      createWebrtcValidator({
        sampleRate: 16000,
        aggregation: "sum" as never,
      }),
    ).rejects.toThrow(/aggregation/);
  });

  it("rejects invalid subframe lengths", async () => {
    const vad = await WebrtcVad.create(1, 16000);
    expect(() => vad.isSpeech(new Int16Array(123))).toThrow(
      /subframe length/,
    );
    vad.destroy();
  });

  it("reset() reproduces decisions from a fresh state", async () => {
    const testCase = parity.frame_cases[0];
    const samples = int16FromFixture(testCase).subarray(0, 160 * 40);
    const vad = await WebrtcVad.create(testCase.mode, 16000);
    const run = () => {
      let out = "";
      for (let s = 0; s < 40; s++) {
        out += vad.isSpeech(samples.subarray(s * 160, (s + 1) * 160))
          ? "1"
          : "0";
      }
      return out;
    };
    const first = run();
    vad.reset();
    expect(run()).toBe(first);
    vad.destroy();
  });

  it("throws after destroy()", async () => {
    const vad = await WebrtcVad.create(1, 16000);
    vad.destroy();
    expect(() => vad.isSpeech(new Int16Array(160))).toThrow(/destroyed/);
  });

  it("a window shorter than one subframe is not valid", async () => {
    const validator = await createWebrtcValidator({ sampleRate: 16000 });
    expect(validator([new Float32Array(100)])).toBe(false);
    validator.destroy();
  });
});
