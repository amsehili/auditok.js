/**
 * Node entry point: everything from the core, plus file loading
 * (native WAV parser, ffmpeg for everything else), microphone capture
 * through ffmpeg, and WAV saving. Zero npm runtime dependencies.
 */

import { readFile, writeFile } from "node:fs/promises";

import { AudioRegion } from "../region.js";
import {
  decodeWav,
  encodeWav,
  isWav,
  type WavEncodeOptions,
} from "../wav.js";
import { decodeFileStream, type FfmpegStreamOptions } from "./ffmpeg.js";

export * from "../index.js";
export {
  decodeFileStream,
  microphone,
  type AudioStream,
  type FfmpegStreamOptions,
  type MicrophoneOptions,
} from "./ffmpeg.js";

export interface LoadOptions extends FfmpegStreamOptions {
  /**
   * By default WAV files are parsed natively at their own sample rate
   * and channel count, and other formats are decoded with ffmpeg
   * (resampled to `sampleRate`, mixed to `channels`). Set to true to
   * force the ffmpeg path for WAV files too, e.g. to resample them.
   */
  forceFfmpeg?: boolean;
}

/**
 * Load an audio file into an {@link AudioRegion}. WAV files are parsed
 * natively; every other format is decoded with ffmpeg (which must be
 * on the PATH). To detect events while a large compressed file is
 * still being decoded, use {@link decodeFileStream} with `split`
 * instead of loading it fully.
 */
export async function load(
  path: string,
  options: LoadOptions = {},
): Promise<AudioRegion> {
  if (options.forceFfmpeg !== true) {
    const bytes = await readFile(path);
    if (isWav(bytes)) {
      const { channelData, sampleRate } = decodeWav(bytes);
      return new AudioRegion(channelData, sampleRate);
    }
  }
  const stream = decodeFileStream(path, options);
  const chunks: Float32Array[] = [];
  let total = 0;
  for await (const chunk of stream.chunks) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const { channels, sampleRate } = stream;
  const sampleCount = Math.floor(total / channels);
  const channelData = Array.from(
    { length: channels },
    () => new Float32Array(sampleCount),
  );
  let sample = 0;
  let channelCursor = 0;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length && sample < sampleCount; i++) {
      channelData[channelCursor][sample] = chunk[i];
      channelCursor += 1;
      if (channelCursor === channels) {
        channelCursor = 0;
        sample += 1;
      }
    }
  }
  return new AudioRegion(channelData, sampleRate);
}

/** Save a region (or any `{ channelData, sampleRate }`) as a WAV file. */
export async function save(
  path: string,
  audio: { channelData: readonly Float32Array[]; sampleRate: number },
  options?: WavEncodeOptions,
): Promise<void> {
  await writeFile(path, encodeWav(audio, options));
}
