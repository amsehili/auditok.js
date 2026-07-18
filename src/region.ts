/**
 * AudioRegion: a chunk of audio with a position in time. What `split`
 * yields and what `trim`/`fixPauses` return.
 */

import { encodeWav, type WavEncodeOptions } from "./wav.js";

export class AudioRegion {
  /** Planar samples, one Float32Array per channel, values nominally in
   * [-1, 1]. */
  readonly channelData: readonly Float32Array[];
  readonly sampleRate: number;
  /** Start time in seconds relative to the beginning of the input this
   * region was detected in (0 for regions built directly). */
  readonly start: number;

  constructor(
    channelData: readonly Float32Array[],
    sampleRate: number,
    start = 0,
  ) {
    if (channelData.length === 0) {
      throw new RangeError("'channelData' must contain at least one channel");
    }
    const length = channelData[0].length;
    for (const channel of channelData) {
      if (channel.length !== length) {
        throw new RangeError("all channels must have the same length");
      }
    }
    if (!(sampleRate > 0)) {
      throw new RangeError(`'sampleRate' must be > 0, given: ${sampleRate}`);
    }
    this.channelData = channelData;
    this.sampleRate = sampleRate;
    this.start = start;
  }

  get channels(): number {
    return this.channelData.length;
  }

  /** Number of samples per channel. */
  get sampleCount(): number {
    return this.channelData[0].length;
  }

  /** Duration in seconds. */
  get duration(): number {
    return this.sampleCount / this.sampleRate;
  }

  /** End time in seconds (`start + duration`). */
  get end(): number {
    return this.start + this.duration;
  }

  /** Encode the region as a WAV file (16-bit PCM by default). */
  toWav(options?: WavEncodeOptions): Uint8Array {
    return encodeWav(this, options);
  }
}

/** A region of digital silence of the given duration. */
export function makeSilence(
  duration: number,
  sampleRate = 16000,
  channels = 1,
): AudioRegion {
  const sampleCount = Math.round(duration * sampleRate);
  const channelData = Array.from(
    { length: channels },
    () => new Float32Array(sampleCount),
  );
  return new AudioRegion(channelData, sampleRate);
}

/**
 * Concatenate `regions` into one region, inserting `gap` (e.g. a
 * silence built with {@link makeSilence}) between consecutive regions.
 */
export function concatRegions(
  regions: readonly AudioRegion[],
  gap?: AudioRegion,
): AudioRegion {
  if (regions.length === 0) {
    throw new RangeError("'regions' must contain at least one region");
  }
  const { sampleRate, channels } = regions[0];
  const parts: (readonly Float32Array[])[] = [];
  let totalSamples = 0;
  regions.forEach((region, i) => {
    if (region.sampleRate !== sampleRate || region.channels !== channels) {
      throw new RangeError(
        "all regions must have the same sample rate and channel count",
      );
    }
    if (i > 0 && gap !== undefined) {
      parts.push(gap.channelData);
      totalSamples += gap.sampleCount;
    }
    parts.push(region.channelData);
    totalSamples += region.sampleCount;
  });
  const channelData = Array.from(
    { length: channels },
    () => new Float32Array(totalSamples),
  );
  let offset = 0;
  for (const part of parts) {
    for (let c = 0; c < channels; c++) {
      channelData[c].set(part[c], offset);
    }
    offset += part[0].length;
  }
  return new AudioRegion(channelData, sampleRate);
}
