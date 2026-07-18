/**
 * WebRTC voice activity detection for auditok: libfvad (the
 * standalone extraction of WebRTC's VAD — a GMM over frequency
 * sub-band energies with online noise adaptation) compiled to a
 * single ~30 KB WebAssembly binary, embedded in this module. Runs
 * unchanged in Node and browsers; no assets, no dependencies.
 *
 * The main entry point is {@link createWebrtcValidator}, which
 * returns a frame-validator function for auditok's `split` — the same
 * role `validator="webrtc:N"` plays in Python auditok.
 */

import { FVAD_WASM_BASE64, LIBFVAD_COMMIT } from "./fvad-wasm.js";

export { LIBFVAD_COMMIT };

export const WEBRTC_SAMPLE_RATES = [8000, 16000, 32000, 48000] as const;
export const WEBRTC_SUBFRAME_DURATIONS = [0.01, 0.02, 0.03] as const;

export type WebrtcSampleRate = (typeof WEBRTC_SAMPLE_RATES)[number];
export type WebrtcSubframeDuration =
  (typeof WEBRTC_SUBFRAME_DURATIONS)[number];
export type WebrtcAggregation = "majority" | "any" | "all";

interface FvadExports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  fvad_new(): number;
  fvad_free(handle: number): void;
  fvad_reset(handle: number): void;
  fvad_set_mode(handle: number, mode: number): number;
  fvad_set_sample_rate(handle: number, rate: number): number;
  fvad_process(handle: number, ptr: number, samples: number): number;
  malloc(bytes: number): number;
  free(ptr: number): void;
}

function decodeWasm(): ArrayBuffer {
  const env = globalThis as {
    Buffer?: { from(s: string, e: string): Uint8Array };
    atob?: (s: string) => string;
  };
  if (env.Buffer !== undefined) {
    const decoded = env.Buffer.from(FVAD_WASM_BASE64, "base64");
    const bytes = new Uint8Array(decoded.length);
    bytes.set(decoded);
    return bytes.buffer;
  }
  if (env.atob === undefined) {
    throw new Error("no base64 decoder available in this environment");
  }
  const binary = env.atob(FVAD_WASM_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

let exportsPromise: Promise<FvadExports> | undefined;

/** Instantiate (once) the embedded WASM module and return its exports.
 * All VAD instances share the one WebAssembly instance. */
function loadFvad(): Promise<FvadExports> {
  exportsPromise ??= (async () => {
    // the standalone-emscripten build imports a few WASI stubs it
    // never actually calls (no I/O happens); satisfy them with no-ops
    const wasi = { fd_close: () => 0, fd_write: () => 0, fd_seek: () => 0 };
    const module = await WebAssembly.compile(decodeWasm());
    const instance = await WebAssembly.instantiate(module, {
      wasi_snapshot_preview1: wasi,
    });
    const fvad = instance.exports as unknown as FvadExports;
    fvad._initialize?.();
    return fvad;
  })();
  return exportsPromise;
}

const cleanupRegistry =
  typeof FinalizationRegistry !== "undefined"
    ? new FinalizationRegistry<() => void>((release) => release())
    : undefined;

/** The largest subframe webrtc accepts: 30 ms at 48 kHz. */
const MAX_SUBFRAME_SAMPLES = 1440;

/**
 * Low-level stateful VAD instance over 16-bit PCM subframes — the
 * JS equivalent of the `webrtcvad.Vad` class. Prefer
 * {@link createWebrtcValidator} unless you need raw frame decisions.
 */
export class WebrtcVad {
  private readonly fvad: FvadExports;
  private readonly handle: number;
  private readonly bufferPtr: number;
  private readonly mode: number;
  private readonly sampleRate: number;
  private readonly release: () => void;
  private destroyed = false;

  private constructor(
    fvad: FvadExports,
    handle: number,
    bufferPtr: number,
    mode: number,
    sampleRate: number,
  ) {
    this.fvad = fvad;
    this.handle = handle;
    this.bufferPtr = bufferPtr;
    this.mode = mode;
    this.sampleRate = sampleRate;
    this.release = () => {
      fvad.fvad_free(handle);
      fvad.free(bufferPtr);
    };
    cleanupRegistry?.register(this, this.release, this);
  }

  /**
   * Create a VAD with the given aggressiveness `mode` (0 to 3, higher
   * rejects more audio as non-speech) and sample rate (8000, 16000,
   * 32000 or 48000 Hz).
   *
   * The VAD is stateful — it adapts its noise model to the audio it
   * has seen and applies a short decision hangover. Use a fresh
   * instance per stream or file.
   */
  static async create(
    mode: number,
    sampleRate: WebrtcSampleRate,
  ): Promise<WebrtcVad> {
    const fvad = await loadFvad();
    const handle = fvad.fvad_new();
    if (handle === 0) {
      throw new Error("fvad_new failed");
    }
    if (fvad.fvad_set_sample_rate(handle, sampleRate) !== 0) {
      fvad.fvad_free(handle);
      throw new RangeError(
        `WebRTC VAD requires a sample rate in ` +
          `[${WEBRTC_SAMPLE_RATES.join(", ")}], given: ${sampleRate}`,
      );
    }
    if (fvad.fvad_set_mode(handle, mode) !== 0) {
      fvad.fvad_free(handle);
      throw new RangeError(`'mode' must be 0, 1, 2 or 3, given: ${mode}`);
    }
    const bufferPtr = fvad.malloc(MAX_SUBFRAME_SAMPLES * 2);
    return new WebrtcVad(fvad, handle, bufferPtr, mode, sampleRate);
  }

  /**
   * Classify one subframe of 16-bit PCM samples as speech or not.
   * The subframe must contain exactly 10, 20 or 30 ms of audio at the
   * configured sample rate.
   */
  isSpeech(samples: Int16Array): boolean {
    if (this.destroyed) {
      throw new Error("this WebrtcVad has been destroyed");
    }
    // the view must be recreated on each call: growing WASM memory
    // detaches previously created views
    new Int16Array(
      this.fvad.memory.buffer,
      this.bufferPtr,
      samples.length,
    ).set(samples);
    const decision = this.fvad.fvad_process(
      this.handle,
      this.bufferPtr,
      samples.length,
    );
    if (decision < 0) {
      throw new RangeError(
        `invalid subframe length ${samples.length}: webrtc accepts ` +
          `exactly 10, 20 or 30 ms of audio per call`,
      );
    }
    return decision === 1;
  }

  /** Reset the internal state (noise model, hangover) for reuse on a
   * new, unrelated stream. */
  reset(): void {
    if (!this.destroyed) {
      // fvad_reset also reverts mode and sample rate to their
      // defaults: re-apply the configured values
      this.fvad.fvad_reset(this.handle);
      this.fvad.fvad_set_sample_rate(this.handle, this.sampleRate);
      this.fvad.fvad_set_mode(this.handle, this.mode);
    }
  }

  /** Free the WASM-side state. Called automatically on garbage
   * collection, but deterministic release is better in long-running
   * apps that create many instances. */
  destroy(): void {
    if (!this.destroyed) {
      this.destroyed = true;
      cleanupRegistry?.unregister(this);
      this.release();
    }
  }
}

export interface WebrtcValidatorOptions {
  /** Sample rate of the audio to validate: 8000, 16000, 32000 or
   * 48000 Hz (a WebRTC VAD requirement). Must match the audio passed
   * to `split`. */
  sampleRate: WebrtcSampleRate;
  /** Aggressiveness, 0 to 3, default 1. Higher values reject more
   * audio as non-speech; 0 or 1 suit far-field or noisy audio, 2
   * clean close-talk audio. */
  mode?: number;
  /** Duration of the subframes fed to the VAD: 0.01 (default), 0.02
   * or 0.03 s. The `analysisWindow` used with `split` should be a
   * multiple of this value. */
  subframeDur?: WebrtcSubframeDuration;
  /** How subframe decisions combine into a window decision:
   * "majority" (default), "any" or "all". */
  aggregation?: WebrtcAggregation;
  /** Channel used on multichannel audio: a channel index or "mix"
   * (default — average of all channels). The energy validator's
   * "any" semantics are not supported: they would need one stateful
   * VAD per channel. */
  useChannel?: number | "mix";
}

/** What {@link createWebrtcValidator} returns: a frame validator for
 * auditok's `split({ validator })`, with lifecycle helpers. */
export type WebrtcValidator = ((
  frame: readonly Float32Array[],
) => boolean) & {
  /** Reset the VAD state to reuse the validator on a new stream. */
  reset(): void;
  /** Free the WASM-side state (also happens on garbage collection). */
  destroy(): void;
};

/**
 * Create a frame validator backed by the WebRTC VAD, for use as
 * `split(audio, { validator })` — the JS counterpart of Python
 * auditok's `validator="webrtc:N"`. Only windows classified as
 * *speech* are considered valid, and auditok's tokenizer turns those
 * frame decisions into events with proper duration and silence
 * semantics.
 *
 * The validator is stateful: create a fresh one per stream or file
 * (or call `.reset()` between unrelated inputs).
 */
export async function createWebrtcValidator(
  options: WebrtcValidatorOptions,
): Promise<WebrtcValidator> {
  const {
    sampleRate,
    mode = 1,
    subframeDur = 0.01,
    aggregation = "majority",
    useChannel = "mix",
  } = options;
  if (!WEBRTC_SUBFRAME_DURATIONS.includes(subframeDur)) {
    throw new RangeError(
      `'subframeDur' must be one of ` +
        `[${WEBRTC_SUBFRAME_DURATIONS.join(", ")}] (a WebRTC VAD ` +
        `requirement), given: ${subframeDur}`,
    );
  }
  if (!["majority", "any", "all"].includes(aggregation)) {
    throw new RangeError(
      `'aggregation' must be "majority", "any" or "all", given: ` +
        `'${aggregation}'`,
    );
  }
  if (useChannel !== "mix" && !Number.isInteger(useChannel)) {
    throw new RangeError(
      `'useChannel' must be a channel index or "mix", given: ${useChannel}`,
    );
  }
  const vad = await WebrtcVad.create(mode, sampleRate);
  const subframeSamples = Math.floor(subframeDur * sampleRate);
  const pcm = new Int16Array(MAX_SUBFRAME_SAMPLES);

  const validator = ((frame: readonly Float32Array[]) => {
    let mono: Float32Array;
    if (frame.length === 1) {
      mono = frame[0];
    } else if (useChannel === "mix") {
      mono = new Float32Array(frame[0].length);
      for (const channel of frame) {
        for (let i = 0; i < mono.length; i++) {
          mono[i] += channel[i];
        }
      }
      for (let i = 0; i < mono.length; i++) {
        mono[i] /= frame.length;
      }
    } else {
      const index =
        (useChannel as number) < 0
          ? (useChannel as number) + frame.length
          : (useChannel as number);
      if (index < 0 || index >= frame.length) {
        throw new RangeError(
          `channel index ${useChannel} out of range for ` +
            `${frame.length}-channel audio`,
        );
      }
      mono = frame[index];
    }

    const subframes = Math.floor(mono.length / subframeSamples);
    if (subframes === 0) {
      return false;
    }
    // process every subframe even when the aggregate is already
    // decided: the VAD is stateful and must see all the audio
    let speechCount = 0;
    for (let s = 0; s < subframes; s++) {
      const from = s * subframeSamples;
      for (let i = 0; i < subframeSamples; i++) {
        // same conversion as Python auditok: scale to the int16
        // range, clip, truncate toward zero
        const scaled = mono[from + i] * 32768;
        pcm[i] = Math.trunc(Math.max(-32768, Math.min(32767, scaled)));
      }
      if (vad.isSpeech(pcm.subarray(0, subframeSamples))) {
        speechCount += 1;
      }
    }
    if (aggregation === "any") {
      return speechCount > 0;
    }
    if (aggregation === "all") {
      return speechCount === subframes;
    }
    return speechCount * 2 >= subframes;
  }) as WebrtcValidator;

  validator.reset = () => vad.reset();
  validator.destroy = () => vad.destroy();
  return validator;
}
