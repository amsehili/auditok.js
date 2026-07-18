/**
 * ffmpeg-backed decoding and capture for Node. ffmpeg is the single
 * external tool auditok relies on outside WAV files — the same policy
 * as the Python package: it decodes every compressed format and also
 * captures audio devices, so the package itself keeps zero runtime
 * dependencies.
 */

import { spawn } from "node:child_process";

export interface FfmpegStreamOptions {
  /** Output sample rate in Hz (ffmpeg resamples), default 16000. */
  sampleRate?: number;
  /** Output channel count (ffmpeg up/downmixes), default 1. */
  channels?: number;
  /** ffmpeg executable, default "ffmpeg" (must be on PATH). */
  ffmpegPath?: string;
}

export interface AudioStream {
  /** Interleaved Float32Array chunks — feed this to `split`. */
  chunks: AsyncIterable<Float32Array>;
  sampleRate: number;
  channels: number;
  /** Stop reading and terminate ffmpeg (for device capture). */
  stop(): void;
}

function runFfmpeg(
  inputArgs: string[],
  options: FfmpegStreamOptions,
): AudioStream {
  const sampleRate = options.sampleRate ?? 16000;
  const channels = options.channels ?? 1;
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    ...inputArgs,
    "-f",
    "f32le",
    "-acodec",
    "pcm_f32le",
    "-ac",
    String(channels),
    "-ar",
    String(sampleRate),
    "-",
  ];
  const child = spawn(ffmpegPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => {
    stderr += text;
  });
  let stopped = false;

  async function* chunks(): AsyncGenerator<Float32Array> {
    // carry bytes that don't end on a float32 boundary to the next chunk
    let carry: Buffer = Buffer.alloc(0);
    try {
      for await (const data of child.stdout) {
        const buffer =
          carry.length > 0 ? Buffer.concat([carry, data as Buffer]) : (data as Buffer);
        const usable = buffer.length - (buffer.length % 4);
        carry = buffer.subarray(usable);
        if (usable === 0) {
          continue;
        }
        const samples = new Float32Array(usable / 4);
        for (let i = 0; i < samples.length; i++) {
          samples[i] = buffer.readFloatLE(i * 4);
        }
        yield samples;
      }
    } finally {
      child.kill("SIGKILL");
    }
    const exitCode: number | null = await new Promise((resolve) => {
      if (child.exitCode !== null || stopped) {
        resolve(child.exitCode);
      } else {
        child.once("close", resolve);
      }
    });
    if (!stopped && exitCode !== 0) {
      throw new Error(
        `ffmpeg exited with code ${exitCode}: ${stderr.trim()}`,
      );
    }
  }

  return {
    chunks: chunks(),
    sampleRate,
    channels,
    stop() {
      stopped = true;
      child.kill("SIGTERM");
    },
  };
}

/**
 * Decode an audio file with ffmpeg into a stream of interleaved
 * Float32Array chunks. Handles every format ffmpeg can read (mp3, ogg,
 * flac, aac, video containers, ...), with optional resampling and
 * channel mixing. The stream starts as soon as ffmpeg produces data,
 * so `split` can emit events while the file is still being decoded.
 */
export function decodeFileStream(
  path: string,
  options: FfmpegStreamOptions = {},
): AudioStream {
  return runFfmpeg(["-i", path], options);
}

export interface MicrophoneOptions extends FfmpegStreamOptions {
  /**
   * Capture device. Defaults per platform: `"default"` with PulseAudio
   * on Linux, `":default"` with AVFoundation on macOS. On Windows
   * (DirectShow) there is no default: pass the device name shown by
   * `ffmpeg -list_devices true -f dshow -i dummy`, without the
   * `audio=` prefix.
   */
  device?: string;
}

/**
 * Capture the microphone through ffmpeg's device support (PulseAudio /
 * AVFoundation / DirectShow). Returns a stream of interleaved
 * Float32Array chunks; call `stop()` to end the capture.
 */
export function microphone(options: MicrophoneOptions = {}): AudioStream {
  let inputArgs: string[];
  const { device } = options;
  switch (process.platform) {
    case "linux":
      inputArgs = ["-f", "pulse", "-i", device ?? "default"];
      break;
    case "darwin":
      inputArgs = ["-f", "avfoundation", "-i", device ?? ":default"];
      break;
    case "win32":
      if (device === undefined) {
        throw new Error(
          "on Windows, pass the capture device name (see " +
            "`ffmpeg -list_devices true -f dshow -i dummy`)",
        );
      }
      inputArgs = ["-f", "dshow", "-i", `audio=${device}`];
      break;
    default:
      throw new Error(
        `microphone capture is not supported on platform ` +
          `'${process.platform}'`,
      );
  }
  return runFfmpeg(inputArgs, options);
}
