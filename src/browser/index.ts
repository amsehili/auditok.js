/**
 * Browser entry point: everything from the core, plus decoding of
 * compressed audio through the browser's own decoder
 * (`decodeAudioData` handles mp3/aac/ogg/flac/wav in every browser)
 * and microphone capture through getUserMedia + AudioWorklet. No
 * external assets, no dependencies.
 */

import { AudioRegion } from "../region.js";
import { decodeWav, isWav } from "../wav.js";

export * from "../index.js";

export interface BrowserLoadOptions {
  /** Target sample rate for compressed formats (the browser resamples
   * while decoding), default 16000. WAV files are parsed natively at
   * their own rate unless `forceDecode` is set. */
  sampleRate?: number;
  /** Decode WAV files through the browser decoder too (resampling them
   * to `sampleRate`) instead of parsing them natively. */
  forceDecode?: boolean;
}

/**
 * Load audio in the browser into an {@link AudioRegion}. Accepts a
 * `File`/`Blob` (e.g. from a file input or drag-and-drop), an
 * `ArrayBuffer`/`Uint8Array`, or a URL string (fetched with CORS
 * rules applying).
 */
export async function load(
  source: File | Blob | ArrayBuffer | Uint8Array | string,
  options: BrowserLoadOptions = {},
): Promise<AudioRegion> {
  let bytes: ArrayBuffer;
  if (typeof source === "string") {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`failed to fetch '${source}': ${response.status}`);
    }
    bytes = await response.arrayBuffer();
  } else if (source instanceof Blob) {
    bytes = await source.arrayBuffer();
  } else if (source instanceof Uint8Array) {
    bytes = source.buffer.slice(
      source.byteOffset,
      source.byteOffset + source.byteLength,
    ) as ArrayBuffer;
  } else {
    bytes = source;
  }

  if (options.forceDecode !== true && isWav(bytes)) {
    const { channelData, sampleRate } = decodeWav(bytes);
    return new AudioRegion(channelData, sampleRate);
  }

  const sampleRate = options.sampleRate ?? 16000;
  const context = new OfflineAudioContext({
    numberOfChannels: 1,
    length: 1,
    sampleRate,
  });
  const buffer = await context.decodeAudioData(bytes);
  const channelData = Array.from(
    { length: buffer.numberOfChannels },
    (_, c) => buffer.getChannelData(c),
  );
  return new AudioRegion(channelData, buffer.sampleRate);
}

export interface BrowserMicrophoneOptions {
  /** Sample rate of the capture AudioContext, default 16000. */
  sampleRate?: number;
}

export interface BrowserAudioStream {
  /** Mono Float32Array chunks — feed this to `split`. */
  chunks: AsyncIterable<Float32Array>;
  sampleRate: number;
  channels: 1;
  /** Stop the capture and release the microphone. */
  stop(): void;
}

const CAPTURE_WORKLET = `
class AuditokCapture extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      this.port.postMessage(input[0].slice());
    }
    return true;
  }
}
registerProcessor("auditok-capture", AuditokCapture);
`;

/**
 * Capture the microphone as a stream of mono Float32Array chunks via
 * an AudioWorklet (the worklet module is inlined — no asset files).
 * Must be called from a user gesture in most browsers. Call `stop()`
 * to release the microphone.
 */
export async function microphone(
  options: BrowserMicrophoneOptions = {},
): Promise<BrowserAudioStream> {
  const sampleRate = options.sampleRate ?? 16000;
  const media = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1 },
  });
  const context = new AudioContext({ sampleRate });
  const workletUrl = URL.createObjectURL(
    new Blob([CAPTURE_WORKLET], { type: "application/javascript" }),
  );
  try {
    await context.audioWorklet.addModule(workletUrl);
  } finally {
    URL.revokeObjectURL(workletUrl);
  }
  const sourceNode = context.createMediaStreamSource(media);
  const captureNode = new AudioWorkletNode(context, "auditok-capture");
  sourceNode.connect(captureNode);

  const pending: Float32Array[] = [];
  let notify: (() => void) | undefined;
  let done = false;
  captureNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
    pending.push(event.data);
    notify?.();
  };

  async function* chunks(): AsyncGenerator<Float32Array> {
    while (!done || pending.length > 0) {
      if (pending.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = undefined;
        continue;
      }
      yield pending.shift() as Float32Array;
    }
  }

  return {
    chunks: chunks(),
    sampleRate: context.sampleRate,
    channels: 1,
    stop() {
      done = true;
      captureNode.port.onmessage = null;
      sourceNode.disconnect();
      captureNode.disconnect();
      for (const track of media.getTracks()) {
        track.stop();
      }
      void context.close();
      notify?.();
    },
  };
}
