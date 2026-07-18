import { describe, expect, it } from "vitest";

import {
  calculateEnergy,
  computeFrameEnergies,
  estimateEnergyThreshold,
  SILENCE_ENERGY,
  windowEnergy,
} from "../src/index.js";

/** Int16-scale sample values as Float32Array in [-1, 1]. */
function fromInt16(values: number[]): Float32Array {
  return Float32Array.from(values, (v) => v / 32768);
}

describe("calculateEnergy", () => {
  // reference values from the Python test suite
  it("matches Python auditok on a known mono window", () => {
    expect(calculateEnergy(fromInt16([300, 320, 400, 600]))).toBeCloseTo(
      52.506639194632434,
      10,
    );
  });

  it("clips an all-zero window to the -200 dB sentinel", () => {
    const energy = calculateEnergy(new Float32Array(160));
    expect(energy).toBe(SILENCE_ENERGY);
    expect(energy).toBeCloseTo(-200, 9);
  });

  it("handles stereo aggregation like Python auditok", () => {
    const ch0 = fromInt16([300, 320, 400, 600]); // 52.5066...
    const ch1 = fromInt16([150, 160, 200, 300]); // 46.4860...
    expect(windowEnergy([ch0, ch1], "any")).toBeCloseTo(
      52.506639194632434,
      10,
    );
    expect(windowEnergy([ch0, ch1], 1)).toBeCloseTo(46.48603928135281, 10);
    expect(windowEnergy([ch0, ch1], -1)).toBeCloseTo(46.48603928135281, 10);
    // "mix" averages samples before computing the energy
    const mixed = fromInt16([225, 240, 300, 450]);
    expect(windowEnergy([ch0, ch1], "mix")).toBeCloseTo(
      calculateEnergy(mixed),
      10,
    );
  });

  it("rejects out-of-range channel indices", () => {
    const frame = [new Float32Array(4), new Float32Array(4)];
    expect(() => windowEnergy(frame, 2)).toThrow(RangeError);
    expect(() => windowEnergy(frame, -3)).toThrow(RangeError);
  });
});

describe("computeFrameEnergies", () => {
  it("drops the final partial window", () => {
    const samples = new Float32Array(1000).fill(0.1);
    expect(computeFrameEnergies([samples], 300)).toHaveLength(3);
  });

  it("returns an empty array for input shorter than one window", () => {
    expect(computeFrameEnergies([new Float32Array(10)], 100)).toHaveLength(0);
  });
});

describe("estimateEnergyThreshold", () => {
  it("places the threshold between the modes of a bimodal distribution", () => {
    // deterministic pseudo-noise around 20 dB and activity around 60 dB
    const energies: number[] = [];
    for (let i = 0; i < 500; i++) {
      energies.push(20 + 2 * Math.sin(i * 12.9898));
    }
    for (let i = 0; i < 300; i++) {
      energies.push(60 + 3 * Math.sin(i * 78.233));
    }
    for (const method of ["otsu", "percentile"] as const) {
      const threshold = estimateEnergyThreshold(energies, method);
      expect(threshold).toBeGreaterThan(20);
      expect(threshold).toBeLessThan(69);
    }
    const otsu = estimateEnergyThreshold(energies, "otsu");
    expect(otsu).toBeGreaterThan(25);
    expect(otsu).toBeLessThan(55);
  });

  it("supports percentile and margin arguments", () => {
    const energies = Array.from({ length: 100 }, (_, i) => i);
    expect(
      estimateEnergyThreshold(energies, "percentile", {
        percentile: 50,
        margin: 3,
      }),
    ).toBeCloseTo(49.5 + 3, 10);
  });

  it("ignores digital-silence sentinel windows", () => {
    const energies = [30, 32, 31, 60, 62, 61];
    const padded = [...Array(50).fill(SILENCE_ENERGY), ...energies];
    expect(estimateEnergyThreshold(padded)).toBe(
      estimateEnergyThreshold(energies),
    );
  });

  it("handles degenerate inputs like Python auditok", () => {
    // constant energies: nothing to separate, return the single value
    expect(estimateEnergyThreshold(Array(10).fill(42))).toBe(42);
    // entirely digitally silent: nothing to detect, no finite threshold
    expect(estimateEnergyThreshold(Array(10).fill(SILENCE_ENERGY))).toBe(
      Infinity,
    );
    expect(() => estimateEnergyThreshold([])).toThrow(RangeError);
    expect(() =>
      estimateEnergyThreshold([1, 2], "unknown" as never),
    ).toThrow(RangeError);
  });
});
