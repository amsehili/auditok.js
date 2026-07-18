/**
 * High-level API: split audio into events, trim leading/trailing
 * silence, normalize pauses. Environment-free — inputs are samples
 * (in-memory or streamed); the io layers (Node, browser) only provide
 * ways to obtain them.
 */
import { AudioRegion, concatRegions, makeSilence } from "./region.js";
import { computeFrameEnergies, estimateEnergyThreshold, windowEnergy, } from "./signal.js";
import { StreamTokenizer } from "./tokenizer.js";
const DEFAULT_ANALYSIS_WINDOW = 0.05;
const DEFAULT_ENERGY_THRESHOLD = 50;
const EPSILON = 1e-10;
function isAudioBufferLike(input) {
    return (typeof input.getChannelData === "function" &&
        typeof input.sampleRate === "number");
}
function normalizeInput(input, options) {
    const optionRate = options.sampleRate;
    if (input instanceof Float32Array) {
        if (optionRate === undefined) {
            throw new TypeError("'sampleRate' is required for Float32Array input");
        }
        return { kind: "memory", channelData: [input], sampleRate: optionRate };
    }
    if (Array.isArray(input)) {
        if (optionRate === undefined) {
            throw new TypeError("'sampleRate' is required for planar Float32Array[] input");
        }
        const length = input[0]?.length;
        if (input.length === 0 || input.some((c) => c.length !== length)) {
            throw new RangeError("planar input must be a non-empty array of equal-length " +
                "channels; to stream chunks, pass a generator or any " +
                "non-array iterable");
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
            const channelData = Array.from({ length: input.numberOfChannels }, (_, c) => input.getChannelData(c));
            return { kind: "memory", channelData, sampleRate: input.sampleRate };
        }
        const withData = input;
        if (withData.channelData !== undefined) {
            const sampleRate = withData.sampleRate ?? optionRate;
            if (sampleRate === undefined) {
                throw new TypeError("input has 'channelData' but no 'sampleRate'");
            }
            return { kind: "memory", channelData: withData.channelData, sampleRate };
        }
        if (Symbol.asyncIterator in input ||
            Symbol.iterator in input) {
            if (optionRate === undefined) {
                throw new TypeError("'sampleRate' is required for chunk-stream input");
            }
            return {
                kind: "stream",
                chunks: input,
                sampleRate: optionRate,
                channels: options.channels ?? 1,
            };
        }
    }
    throw new TypeError("unsupported input; expected Float32Array, Float32Array[], " +
        "AudioRegion, { channelData, sampleRate }, AudioBuffer or an " +
        "iterable of Float32Array chunks");
}
/** Analysis windows over in-memory planar data, as zero-copy views.
 * The final partial window, if any, is included. */
function* memoryFrames(channelData, frameSamples) {
    const total = channelData[0].length;
    for (let start = 0; start < total; start += frameSamples) {
        const end = Math.min(start + frameSamples, total);
        yield channelData.map((channel) => channel.subarray(start, end));
    }
}
/** Analysis windows over a stream of interleaved chunks. The final
 * partial window, if any, is included. */
async function* streamFrames(chunks, channels, frameSamples) {
    let frame = Array.from({ length: channels }, () => new Float32Array(frameSamples));
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
                    frame = Array.from({ length: channels }, () => new Float32Array(frameSamples));
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
function parseValidatorName(name) {
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
    throw new RangeError(`unknown validator '${name}'; expected "otsu", "percentile" or ` +
        `"pXX" with XX in [1, 99]`);
}
/** Port of Python auditok's duration-to-window-count conversion. */
function durationToWindowCount(duration, windowDur, round, epsilon = 0) {
    if (duration < 0) {
        throw new RangeError(`duration (${duration}) must be >= 0`);
    }
    if (duration === 0) {
        return 0;
    }
    return round(duration / windowDur + epsilon);
}
function planTokenization(input, options) {
    const { minDur = 0.2, maxDur = 5, maxSilence = 0.3, maxLeadingSilence = 0, maxTrailingSilence = null, strictMinDur = false, analysisWindow = DEFAULT_ANALYSIS_WINDOW, useChannel = "any", } = options;
    if (minDur <= 0) {
        throw new RangeError(`'minDur' (${minDur}) must be > 0`);
    }
    const effectiveMaxDur = maxDur === null || maxDur === Infinity ? Infinity : maxDur;
    if (effectiveMaxDur <= 0) {
        throw new RangeError(`'maxDur' (${maxDur}) must be > 0`);
    }
    if (maxSilence < 0) {
        throw new RangeError(`'maxSilence' (${maxSilence}) must be >= 0`);
    }
    if (analysisWindow <= 0) {
        throw new RangeError(`'analysisWindow' (${analysisWindow}) must be > 0`);
    }
    const normalized = normalizeInput(input, options);
    const { sampleRate } = normalized;
    const frameSamples = Math.floor(analysisWindow * sampleRate);
    if (frameSamples === 0) {
        throw new RangeError(`too small 'analysisWindow' (${analysisWindow}) for sampling rate ` +
            `(${sampleRate}); it should cover at least one sample`);
    }
    const windowDur = frameSamples / sampleRate;
    let validator;
    const givenValidator = options.validator;
    if (typeof givenValidator === "function") {
        validator = givenValidator;
    }
    else {
        let threshold;
        if (typeof givenValidator === "string") {
            const { method, percentile } = parseValidatorName(givenValidator);
            if (normalized.kind !== "memory") {
                throw new Error("automatic threshold estimation needs to read the whole input " +
                    "before detection starts, which is not possible for " +
                    "chunk-stream input; collect the stream first or pass a " +
                    "fixed 'energyThreshold'");
            }
            const energies = computeFrameEnergies(normalized.channelData, frameSamples, useChannel);
            threshold = estimateEnergyThreshold(energies, method, percentile === undefined ? {} : { percentile });
        }
        else if (givenValidator === undefined) {
            threshold = options.energyThreshold ?? DEFAULT_ENERGY_THRESHOLD;
        }
        else {
            throw new TypeError("'validator' must be a string naming an estimation method or a " +
                "function");
        }
        validator = (frame) => windowEnergy(frame, useChannel) >= threshold;
    }
    const minLength = durationToWindowCount(minDur, windowDur, Math.ceil);
    const maxLength = effectiveMaxDur === Infinity
        ? Infinity
        : durationToWindowCount(effectiveMaxDur, windowDur, Math.floor, EPSILON);
    const maxContinuousSilence = durationToWindowCount(maxSilence, windowDur, Math.floor, EPSILON);
    const maxLeadingSilenceFrames = durationToWindowCount(maxLeadingSilence, windowDur, Math.floor, EPSILON);
    const maxTrailingSilenceFrames = maxTrailingSilence === null || maxTrailingSilence === undefined
        ? null
        : durationToWindowCount(maxTrailingSilence, windowDur, Math.floor, EPSILON);
    if (minLength > maxLength) {
        throw new RangeError(`'minDur' (${minDur} sec.) results in ${minLength} analysis ` +
            `window(s) which is higher than the number of analysis windows ` +
            `for 'maxDur' (${maxLength})`);
    }
    if (maxContinuousSilence >= maxLength) {
        throw new RangeError(`'maxSilence' (${maxSilence} sec.) results in ` +
            `${maxContinuousSilence} analysis window(s) which is higher or ` +
            `equal to the number of analysis windows for 'maxDur' ` +
            `(${maxLength})`);
    }
    const tokenizer = new StreamTokenizer(validator, {
        minLength,
        maxLength,
        maxContinuousSilence,
        maxLeadingSilence: maxLeadingSilenceFrames,
        maxTrailingSilence: maxTrailingSilenceFrames,
        strictMinLength: strictMinDur,
    });
    return { normalized, frameSamples, windowDur, tokenizer };
}
function framesToRegion(frames, sampleRate, start) {
    const channels = frames[0].length;
    let totalSamples = 0;
    for (const frame of frames) {
        totalSamples += frame[0].length;
    }
    const channelData = Array.from({ length: channels }, () => new Float32Array(totalSamples));
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
export async function* split(input, options = {}) {
    const { normalized, frameSamples, windowDur, tokenizer } = planTokenization(input, options);
    const frames = normalized.kind === "memory"
        ? memoryFrames(normalized.channelData, frameSamples)
        : streamFrames(normalized.chunks, normalized.channels, frameSamples);
    for await (const token of tokenizer.tokenize(frames)) {
        yield framesToRegion(token.frames, normalized.sampleRate, token.start * windowDur);
    }
}
/** Like {@link split}, but collects all events into an array. */
export async function splitAll(input, options = {}) {
    const regions = [];
    for await (const region of split(input, options)) {
        regions.push(region);
    }
    return regions;
}
function rejectFixedOptions(options, functionName) {
    for (const name of ["maxDur", "strictMinDur"]) {
        if (name in options) {
            throw new TypeError(`${functionName}() does not accept '${name}'; events are never ` +
                `truncated`);
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
export async function trim(input, options = {}) {
    rejectFixedOptions(options, "trim");
    const normalized = normalizeInput(input, options);
    let source = input;
    const recorded = [];
    if (normalized.kind === "stream") {
        const chunkSource = normalized.chunks;
        source = (async function* record() {
            for await (const chunk of chunkSource) {
                recorded.push(chunk);
                yield chunk;
            }
        })();
    }
    let first;
    let last;
    for await (const region of split(source, {
        ...options,
        maxDur: null,
        strictMinDur: false,
    })) {
        first ?? (first = region);
        last = region;
    }
    const { sampleRate } = normalized;
    let channelData;
    if (normalized.kind === "memory") {
        channelData = normalized.channelData;
    }
    else {
        let total = 0;
        for (const chunk of recorded) {
            total += chunk.length;
        }
        const { channels } = normalized;
        const sampleCount = Math.floor(total / channels);
        const planar = Array.from({ length: channels }, () => new Float32Array(sampleCount));
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
        return new AudioRegion(channelData.map(() => new Float32Array(0)), sampleRate);
    }
    const from = Math.round(first.start * sampleRate);
    const to = Math.min(Math.round(last.end * sampleRate), channelData[0].length);
    return new AudioRegion(channelData.map((channel) => channel.slice(from, to)), sampleRate, first.start);
}
/**
 * Normalize pauses: detect events (never truncated) and join them
 * with exactly `silenceDuration` seconds of silence between them.
 * Events shorter than `minDur` are discarded. Returns an empty region
 * (zero duration) if no events are detected.
 */
export async function fixPauses(input, silenceDuration, options = {}) {
    rejectFixedOptions(options, "fixPauses");
    if (silenceDuration < 0) {
        throw new RangeError(`'silenceDuration' (${silenceDuration}) must be >= 0`);
    }
    const regions = await splitAll(input, {
        ...options,
        maxDur: null,
        strictMinDur: false,
    });
    if (regions.length === 0) {
        const normalized = normalizeInput(input, options);
        const channels = normalized.kind === "memory"
            ? normalized.channelData.length
            : normalized.channels;
        return new AudioRegion(Array.from({ length: channels }, () => new Float32Array(0)), normalized.sampleRate);
    }
    const gap = makeSilence(silenceDuration, regions[0].sampleRate, regions[0].channels);
    return concatRegions(regions, gap);
}
