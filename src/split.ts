/**
 * High-level API: split audio into events, trim leading/trailing
 * silence, normalize pauses. Environment-free — inputs are samples
 * (in-memory or streamed); the io layers (Node, browser) only provide
 * ways to obtain them.
 */

import { AudioRegion, concatRegions, makeSilence } from "./region.js";
import {
  computeFrameEnergies,
  estimateEnergyThreshold,
  windowEnergy,
  type ChannelSelection,
  type ThresholdMethod,
} from "./signal.js";
import { StreamTokenizer } from "./tokenizer.js";

const DEFAULT_ANALYSIS_WINDOW = 0.05;
const DEFAULT_ENERGY_THRESHOLD = 50;
const DEFAULT_CALIBRATION_DUR = 3;
const DEFAULT_MIN_ENERGY_THRESHOLD = 40;
const EPSILON = 1e-10;

/** One analysis window as planar per-channel samples. This is what a
 * custom validator function receives. */
export type AudioFrame = readonly Float32Array[];

/** Minimal structural type for a Web Audio `AudioBuffer`. */
export interface AudioBufferLike {
  numberOfChannels: number;
  sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

/**
 * Audio input accepted by {@link split}, {@link trim} and
 * {@link fixPauses}:
 *
 * - `Float32Array`: mono samples (requires `sampleRate` in options);
 * - `Float32Array[]`: planar channels of equal length (requires
 *   `sampleRate`);
 * - {@link AudioRegion} or any `{ channelData, sampleRate }` object;
 * - a Web Audio `AudioBuffer`;
 * - a sync or async iterable of `Float32Array` chunks of *interleaved*
 *   samples (requires `sampleRate`; `channels` defaults to 1). This is
 *   the streaming path: events are yielded while the input is still
 *   being read.
 */
export type AudioInput =
  | Float32Array
  | Float32Array[]
  | AudioRegion
  | { channelData: readonly Float32Array[]; sampleRate: number }
  | AudioBufferLike
  | Iterable<Float32Array>
  | AsyncIterable<Float32Array>;

export interface SplitOptions {
  /** Sample rate in Hz. Required when the input does not carry its
   * own (bare samples or chunk streams). */
  sampleRate?: number;
  /** Number of interleaved channels for chunk-stream input, default 1.
   * Ignored for in-memory input, which is planar. */
  channels?: number;
  /** Minimum duration in seconds of a detected event, default 0.2. */
  minDur?: number;
  /** Maximum duration in seconds of an event, default 5; longer events
   * are truncated. `null` or `Infinity` disables the limit. */
  maxDur?: number | null;
  /** Maximum duration of continuous silence allowed *within* an event,
   * default 0.3. Controls when an event ends. */
  maxSilence?: number;
  /** Silence in seconds to retain before each event (natural attack),
   * default 0. */
  maxLeadingSilence?: number;
  /** Trailing silence in seconds to keep at the end of each event.
   * `null` (default) keeps all trailing silence up to `maxSilence`;
   * `0` drops it; a value larger than `maxSilence` keeps collecting
   * past the event boundary (natural fadeout). */
  maxTrailingSilence?: number | null;
  /** Reject events shorter than `minDur` even when contiguous with a
   * truncated event, default false. */
  strictMinDur?: boolean;
  /** Duration in seconds of the analysis window, default 0.05. */
  analysisWindow?: number;
  /** Energy threshold in dB for detection, default 50. Used when no
   * `validator` is given. Same scale as Python auditok: dB relative to
   * int16 full scale. */
  energyThreshold?: number;
  /**
   * Frame validation strategy; if set, it is the whole story and
   * `energyThreshold` is overlooked. A string selects automatic
   * threshold estimation: `"otsu"`, `"percentile"` (alias of `"p10"`)
   * or `"pXX"` (noise floor read at the XXth percentile of window
   * energies, plus a 6 dB margin). For in-memory input the threshold
   * is estimated from the whole input before detection starts; for
   * chunk-stream input it is calibrated on the first `calibrationDur`
   * seconds (clamped to `minEnergyThreshold`), and the calibration
   * audio is replayed so no data is lost. A function is called with
   * each analysis window (planar per-channel samples) and returns
   * whether the window is valid.
   */
  validator?: string | ((frame: AudioFrame) => boolean);
  /** Duration in seconds of chunk-stream audio used to calibrate the
   * threshold when `validator` is an estimation string, default 3.
   * Ignored for in-memory input, which is estimated as a whole. */
  calibrationDur?: number;
  /** Lower bound in dB for a threshold calibrated on a chunk stream,
   * default 40. Guards against a too-quiet calibration window; also
   * used as the threshold when the calibration audio is digitally
   * silent (e.g., a muted microphone), so detection keeps running. */
  minEnergyThreshold?: number;
  /** Channel used for energy computation on multichannel audio:
   * `"any"` (default, maximum over channels), `"mix"` or a channel
   * index. */
  useChannel?: ChannelSelection;
}

interface InMemoryInput {
  kind: "memory";
  channelData: readonly Float32Array[];
  sampleRate: number;
}

interface StreamInput {
  kind: "stream";
  chunks: Iterable<Float32Array> | AsyncIterable<Float32Array>;
  sampleRate: number;
  channels: number;
}

type NormalizedInput = InMemoryInput | StreamInput;

function isAudioBufferLike(input: object): input is AudioBufferLike {
  return (
    typeof (input as AudioBufferLike).getChannelData === "function" &&
    typeof (input as AudioBufferLike).sampleRate === "number"
  );
}

function normalizeInput(
  input: AudioInput,
  options: SplitOptions,
): NormalizedInput {
  const optionRate = options.sampleRate;
  if (input instanceof Float32Array) {
    if (optionRate === undefined) {
      throw new TypeError("'sampleRate' is required for Float32Array input");
    }
    return { kind: "memory", channelData: [input], sampleRate: optionRate };
  }
  if (Array.isArray(input)) {
    if (optionRate === undefined) {
      throw new TypeError(
        "'sampleRate' is required for planar Float32Array[] input",
      );
    }
    const length = input[0]?.length;
    if (input.length === 0 || input.some((c) => c.length !== length)) {
      throw new RangeError(
        "planar input must be a non-empty array of equal-length " +
          "channels; to stream chunks, pass a generator or any " +
          "non-array iterable",
      );
    }
    return { kind: "memory", channelData: input, sampleRate: optionRate };
  }
  if (input instanceof AudioRegion) {
    return {
      kind: "memory",
      channelData: input.channelData,
      sampleRate: input.sampleRate,
    };
  }
  if (typeof input === "object" && input !== null) {
    if (isAudioBufferLike(input)) {
      const channelData = Array.from(
        { length: input.numberOfChannels },
        (_, c) => input.getChannelData(c),
      );
      return { kind: "memory", channelData, sampleRate: input.sampleRate };
    }
    const withData = input as {
      channelData?: readonly Float32Array[];
      sampleRate?: number;
    };
    if (withData.channelData !== undefined) {
      const sampleRate = withData.sampleRate ?? optionRate;
      if (sampleRate === undefined) {
        throw new TypeError("input has 'channelData' but no 'sampleRate'");
      }
      return { kind: "memory", channelData: withData.channelData, sampleRate };
    }
    if (
      Symbol.asyncIterator in input ||
      Symbol.iterator in input
    ) {
      if (optionRate === undefined) {
        throw new TypeError(
          "'sampleRate' is required for chunk-stream input",
        );
      }
      return {
        kind: "stream",
        chunks: input as Iterable<Float32Array> | AsyncIterable<Float32Array>,
        sampleRate: optionRate,
        channels: options.channels ?? 1,
      };
    }
  }
  throw new TypeError(
    "unsupported input; expected Float32Array, Float32Array[], " +
      "AudioRegion, { channelData, sampleRate }, AudioBuffer or an " +
      "iterable of Float32Array chunks",
  );
}

/** Analysis windows over in-memory planar data, as zero-copy views.
 * The final partial window, if any, is included. */
function* memoryFrames(
  channelData: readonly Float32Array[],
  frameSamples: number,
): Generator<AudioFrame> {
  const total = channelData[0].length;
  for (let start = 0; start < total; start += frameSamples) {
    const end = Math.min(start + frameSamples, total);
    yield channelData.map((channel) => channel.subarray(start, end));
  }
}

/** Analysis windows over a stream of interleaved chunks. The final
 * partial window, if any, is included. */
async function* streamFrames(
  chunks: Iterable<Float32Array> | AsyncIterable<Float32Array>,
  channels: number,
  frameSamples: number,
): AsyncGenerator<AudioFrame> {
  let frame = Array.from(
    { length: channels },
    () => new Float32Array(frameSamples),
  );
  let filled = 0; // samples per channel currently in `frame`
  let channelCursor = 0; // interleaving position within the current sample
  for await (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      frame[channelCursor][filled] = chunk[i];
      channelCursor += 1;
      if (channelCursor === channels) {
        channelCursor = 0;
        filled += 1;
        if (filled === frameSamples) {
          yield frame;
          frame = Array.from(
            { length: channels },
            () => new Float32Array(frameSamples),
          );
          filled = 0;
        }
      }
    }
  }
  if (filled > 0) {
    yield frame.map((channel) => channel.subarray(0, filled));
  }
}

const PERCENTILE_VALIDATOR_RE = /^p([1-9][0-9]?)$/;

function parseValidatorName(name: string): {
  method: ThresholdMethod;
  percentile?: number;
} {
  if (name === "otsu") {
    return { method: "otsu" };
  }
  if (name === "percentile") {
    return { method: "percentile" };
  }
  const match = PERCENTILE_VALIDATOR_RE.exec(name);
  if (match !== null) {
    return { method: "percentile", percentile: Number(match[1]) };
  }
  throw new RangeError(
    `unknown validator '${name}'; expected "otsu", "percentile" or ` +
      `"pXX" with XX in [1, 99]`,
  );
}

/** Port of Python auditok's duration-to-window-count conversion. */
function durationToWindowCount(
  duration: number,
  windowDur: number,
  round: (x: number) => number,
  epsilon = 0,
): number {
  if (duration < 0) {
    throw new RangeError(`duration (${duration}) must be >= 0`);
  }
  if (duration === 0) {
    return 0;
  }
  return round(duration / windowDur + epsilon);
}

interface StreamCalibration {
  method: ThresholdMethod;
  percentile?: number;
  /** Number of analysis windows read for calibration. */
  nFrames: number;
  floor: number;
  useChannel: ChannelSelection;
  setThreshold(threshold: number): void;
}

/** Read the first `nFrames` analysis windows of a stream, estimate the
 * energy threshold from them (clamped to `floor`), then replay them and
 * continue with the rest — no data is lost to calibration. Mirrors
 * Python auditok's live calibration. */
async function* calibrateFrames(
  frames: AsyncGenerator<AudioFrame>,
  calibration: StreamCalibration,
): AsyncGenerator<AudioFrame> {
  // manual iteration: a `break` out of for-await would close `frames`
  const iterator = frames[Symbol.asyncIterator]();
  const buffered: AudioFrame[] = [];
  const energies: number[] = [];
  while (buffered.length < calibration.nFrames) {
    const { value, done } = await iterator.next();
    if (done === true) {
      break;
    }
    buffered.push(value);
    energies.push(windowEnergy(value, calibration.useChannel));
  }
  if (buffered.length === 0) {
    throw new Error(
      "no audio data could be read for energy threshold calibration",
    );
  }
  const estimate = estimateEnergyThreshold(
    energies,
    calibration.method,
    calibration.percentile === undefined
      ? {}
      : { percentile: calibration.percentile },
  );
  // an infinite estimate means the calibration window is digitally
  // silent (e.g., a muted microphone): fall back to the floor and
  // keep listening
  calibration.setThreshold(
    Number.isFinite(estimate)
      ? Math.max(estimate, calibration.floor)
      : calibration.floor,
  );
  yield* buffered;
  while (true) {
    const { value, done } = await iterator.next();
    if (done === true) {
      return;
    }
    yield value;
  }
}

interface TokenizationPlan {
  normalized: NormalizedInput;
  frameSamples: number;
  windowDur: number;
  tokenizer: StreamTokenizer<AudioFrame>;
  calibration?: StreamCalibration;
}

function planTokenization(
  input: AudioInput,
  options: SplitOptions,
): TokenizationPlan {
  const {
    minDur = 0.2,
    maxDur = 5,
    maxSilence = 0.3,
    maxLeadingSilence = 0,
    maxTrailingSilence = null,
    strictMinDur = false,
    analysisWindow = DEFAULT_ANALYSIS_WINDOW,
    useChannel = "any",
  } = options;

  if (minDur <= 0) {
    throw new RangeError(`'minDur' (${minDur}) must be > 0`);
  }
  const effectiveMaxDur =
    maxDur === null || maxDur === Infinity ? Infinity : maxDur;
  if (effectiveMaxDur <= 0) {
    throw new RangeError(`'maxDur' (${maxDur}) must be > 0`);
  }
  if (maxSilence < 0) {
    throw new RangeError(`'maxSilence' (${maxSilence}) must be >= 0`);
  }
  if (analysisWindow <= 0) {
    throw new RangeError(
      `'analysisWindow' (${analysisWindow}) must be > 0`,
    );
  }

  const normalized = normalizeInput(input, options);
  const { sampleRate } = normalized;
  const frameSamples = Math.floor(analysisWindow * sampleRate);
  if (frameSamples === 0) {
    throw new RangeError(
      `too small 'analysisWindow' (${analysisWindow}) for sampling rate ` +
        `(${sampleRate}); it should cover at least one sample`,
    );
  }
  const windowDur = frameSamples / sampleRate;

  let validator: (frame: AudioFrame) => boolean;
  let calibration: StreamCalibration | undefined;
  const givenValidator = options.validator;
  if (typeof givenValidator === "function") {
    validator = givenValidator;
  } else {
    let threshold: number;
    if (typeof givenValidator === "string") {
      const { method, percentile } = parseValidatorName(givenValidator);
      if (normalized.kind === "memory") {
        const energies = computeFrameEnergies(
          normalized.channelData,
          frameSamples,
          useChannel,
        );
        threshold = estimateEnergyThreshold(
          energies,
          method,
          percentile === undefined ? {} : { percentile },
        );
      } else {
        // chunk stream: calibrate on the first `calibrationDur`
        // seconds; `threshold` is assigned by `calibrateFrames` before
        // the tokenizer sees any frame
        const calibrationDur =
          options.calibrationDur ?? DEFAULT_CALIBRATION_DUR;
        if (calibrationDur <= 0) {
          throw new RangeError(
            `'calibrationDur' (${calibrationDur}) must be > 0`,
          );
        }
        threshold = NaN;
        calibration = {
          method,
          percentile,
          nFrames: Math.max(1, Math.ceil(calibrationDur / windowDur)),
          floor:
            options.minEnergyThreshold ?? DEFAULT_MIN_ENERGY_THRESHOLD,
          useChannel,
          setThreshold: (value) => {
            threshold = value;
          },
        };
      }
    } else if (givenValidator === undefined) {
      threshold = options.energyThreshold ?? DEFAULT_ENERGY_THRESHOLD;
    } else {
      throw new TypeError(
        "'validator' must be a string naming an estimation method or a " +
          "function",
      );
    }
    validator = (frame) => windowEnergy(frame, useChannel) >= threshold;
  }

  const minLength = durationToWindowCount(minDur, windowDur, Math.ceil);
  const maxLength =
    effectiveMaxDur === Infinity
      ? Infinity
      : durationToWindowCount(effectiveMaxDur, windowDur, Math.floor, EPSILON);
  const maxContinuousSilence = durationToWindowCount(
    maxSilence,
    windowDur,
    Math.floor,
    EPSILON,
  );
  const maxLeadingSilenceFrames = durationToWindowCount(
    maxLeadingSilence,
    windowDur,
    Math.floor,
    EPSILON,
  );
  const maxTrailingSilenceFrames =
    maxTrailingSilence === null || maxTrailingSilence === undefined
      ? null
      : durationToWindowCount(
          maxTrailingSilence,
          windowDur,
          Math.floor,
          EPSILON,
        );

  if (minLength > maxLength) {
    throw new RangeError(
      `'minDur' (${minDur} sec.) results in ${minLength} analysis ` +
        `window(s) which is higher than the number of analysis windows ` +
        `for 'maxDur' (${maxLength})`,
    );
  }
  if (maxContinuousSilence >= maxLength) {
    throw new RangeError(
      `'maxSilence' (${maxSilence} sec.) results in ` +
        `${maxContinuousSilence} analysis window(s) which is higher or ` +
        `equal to the number of analysis windows for 'maxDur' ` +
        `(${maxLength})`,
    );
  }

  const tokenizer = new StreamTokenizer<AudioFrame>(validator, {
    minLength,
    maxLength,
    maxContinuousSilence,
    maxLeadingSilence: maxLeadingSilenceFrames,
    maxTrailingSilence: maxTrailingSilenceFrames,
    strictMinLength: strictMinDur,
  });

  return { normalized, frameSamples, windowDur, tokenizer, calibration };
}

function framesToRegion(
  frames: readonly AudioFrame[],
  sampleRate: number,
  start: number,
): AudioRegion {
  const channels = frames[0].length;
  let totalSamples = 0;
  for (const frame of frames) {
    totalSamples += frame[0].length;
  }
  const channelData = Array.from(
    { length: channels },
    () => new Float32Array(totalSamples),
  );
  let offset = 0;
  for (const frame of frames) {
    for (let c = 0; c < channels; c++) {
      channelData[c].set(frame[c], offset);
    }
    offset += frame[0].length;
  }
  return new AudioRegion(channelData, sampleRate, start);
}

/**
 * Split audio into events. Returns an async generator of
 * {@link AudioRegion} objects, yielded as soon as each event's end is
 * decided — for chunk-stream input, while the input is still being
 * read.
 */
export async function* split(
  input: AudioInput,
  options: SplitOptions = {},
): AsyncGenerator<AudioRegion, void, void> {
  const { normalized, frameSamples, windowDur, tokenizer, calibration } =
    planTokenization(input, options);
  let frames: Generator<AudioFrame> | AsyncGenerator<AudioFrame>;
  if (normalized.kind === "memory") {
    frames = memoryFrames(normalized.channelData, frameSamples);
  } else {
    frames = streamFrames(normalized.chunks, normalized.channels, frameSamples);
    if (calibration !== undefined) {
      frames = calibrateFrames(frames, calibration);
    }
  }
  for await (const token of tokenizer.tokenize(frames)) {
    yield framesToRegion(
      token.frames,
      normalized.sampleRate,
      token.start * windowDur,
    );
  }
}

/** Like {@link split}, but collects all events into an array. */
export async function splitAll(
  input: AudioInput,
  options: SplitOptions = {},
): Promise<AudioRegion[]> {
  const regions: AudioRegion[] = [];
  for await (const region of split(input, options)) {
    regions.push(region);
  }
  return regions;
}

type TrimFixPausesOptions = Omit<SplitOptions, "maxDur" | "strictMinDur">;

function rejectFixedOptions(
  options: SplitOptions,
  functionName: string,
): void {
  for (const name of ["maxDur", "strictMinDur"] as const) {
    if (name in options) {
      throw new TypeError(
        `${functionName}() does not accept '${name}'; events are never ` +
          `truncated`,
      );
    }
  }
}

/**
 * Detect audio activity in `input` and return the audio between the
 * start of the first detection and the end of the last, removing
 * leading and trailing silence. Chunk-stream input is read once and
 * recorded as it is consumed. Returns an empty region (zero duration)
 * if no activity is detected.
 */
export async function trim(
  input: AudioInput,
  options: TrimFixPausesOptions = {},
): Promise<AudioRegion> {
  rejectFixedOptions(options, "trim");
  const normalized = normalizeInput(input, options);

  let source: AudioInput = input;
  const recorded: Float32Array[] = [];
  if (normalized.kind === "stream") {
    const chunkSource = normalized.chunks;
    source = (async function* record() {
      for await (const chunk of chunkSource) {
        recorded.push(chunk);
        yield chunk;
      }
    })();
  }

  let first: AudioRegion | undefined;
  let last: AudioRegion | undefined;
  for await (const region of split(source, {
    ...options,
    maxDur: null,
    strictMinDur: false,
  })) {
    first ??= region;
    last = region;
  }

  const { sampleRate } = normalized;
  let channelData: readonly Float32Array[];
  if (normalized.kind === "memory") {
    channelData = normalized.channelData;
  } else {
    let total = 0;
    for (const chunk of recorded) {
      total += chunk.length;
    }
    const { channels } = normalized;
    const sampleCount = Math.floor(total / channels);
    const planar = Array.from(
      { length: channels },
      () => new Float32Array(sampleCount),
    );
    let sample = 0;
    let channelCursor = 0;
    for (const chunk of recorded) {
      for (let i = 0; i < chunk.length && sample < sampleCount; i++) {
        planar[channelCursor][sample] = chunk[i];
        channelCursor += 1;
        if (channelCursor === channels) {
          channelCursor = 0;
          sample += 1;
        }
      }
    }
    channelData = planar;
  }

  if (first === undefined || last === undefined) {
    return new AudioRegion(
      channelData.map(() => new Float32Array(0)),
      sampleRate,
    );
  }
  const from = Math.round(first.start * sampleRate);
  const to = Math.min(
    Math.round(last.end * sampleRate),
    channelData[0].length,
  );
  return new AudioRegion(
    channelData.map((channel) => channel.slice(from, to)),
    sampleRate,
    first.start,
  );
}

/**
 * Normalize pauses: detect events (never truncated) and join them
 * with exactly `silenceDuration` seconds of silence between them.
 * Events shorter than `minDur` are discarded. Returns an empty region
 * (zero duration) if no events are detected.
 */
export async function fixPauses(
  input: AudioInput,
  silenceDuration: number,
  options: TrimFixPausesOptions = {},
): Promise<AudioRegion> {
  rejectFixedOptions(options, "fixPauses");
  if (silenceDuration < 0) {
    throw new RangeError(
      `'silenceDuration' (${silenceDuration}) must be >= 0`,
    );
  }
  const regions = await splitAll(input, {
    ...options,
    maxDur: null,
    strictMinDur: false,
  });
  if (regions.length === 0) {
    const normalized = normalizeInput(input, options);
    const channels =
      normalized.kind === "memory"
        ? normalized.channelData.length
        : normalized.channels;
    return new AudioRegion(
      Array.from({ length: channels }, () => new Float32Array(0)),
      normalized.sampleRate,
    );
  }
  const gap = makeSilence(
    silenceDuration,
    regions[0].sampleRate,
    regions[0].channels,
  );
  return concatRegions(regions, gap);
}
