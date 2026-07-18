/**
 * Signal-level operations: window energy and automatic threshold
 * estimation.
 *
 * Samples are Float32Array values nominally in [-1, 1] (the Web Audio
 * convention). Energies are expressed in dB relative to 16-bit full
 * scale — samples are scaled by 32768 before the log — so thresholds
 * mean exactly the same thing as in Python auditok, and its
 * documentation transfers 1:1.
 */
export const EPSILON = 1e-10;
/** Amplitude scale applied before the log so that dB values are relative
 * to int16 full scale, like in Python auditok. */
export const INT16_SCALE = 32768;
/** Energy assigned to an all-zero (digitally silent) window:
 * 20 * log10(EPSILON) = -200 dB. A sentinel, not a measurement. */
export const SILENCE_ENERGY = 20 * Math.log10(EPSILON);
/**
 * Compute the energy of `samples` as
 * `20 * log10(sqrt(mean(x^2)))` with `x` on the int16 amplitude scale.
 * An all-zero window yields {@link SILENCE_ENERGY} (-200 dB).
 */
export function calculateEnergy(samples) {
    const n = samples.length;
    if (n === 0) {
        return SILENCE_ENERGY;
    }
    let sumSquares = 0;
    for (let i = 0; i < n; i++) {
        const x = samples[i];
        sumSquares += x * x;
    }
    const rms = Math.sqrt(sumSquares / n) * INT16_SCALE;
    return 20 * Math.log10(Math.max(rms, EPSILON));
}
function resolveChannelIndex(index, channels) {
    const selected = index < 0 ? index + channels : index;
    if (!Number.isInteger(index) || selected < 0 || selected >= channels) {
        throw new RangeError(`Selected channel must be >= -channels and < channels, given: ${index}`);
    }
    return selected;
}
function mixChannels(channelData, start, end) {
    const mixed = new Float32Array(end - start);
    for (const channel of channelData) {
        for (let i = start; i < end; i++) {
            mixed[i - start] += channel[i];
        }
    }
    const channels = channelData.length;
    for (let i = 0; i < mixed.length; i++) {
        mixed[i] /= channels;
    }
    return mixed;
}
/**
 * Energy of one analysis window given as planar channel data,
 * aggregated over channels according to `useChannel`.
 */
export function windowEnergy(channelData, useChannel = "any") {
    if (channelData.length === 1) {
        return calculateEnergy(channelData[0]);
    }
    if (useChannel === "any") {
        let maxEnergy = -Infinity;
        for (const channel of channelData) {
            const energy = calculateEnergy(channel);
            if (energy > maxEnergy) {
                maxEnergy = energy;
            }
        }
        return maxEnergy;
    }
    if (useChannel === "mix") {
        return calculateEnergy(mixChannels(channelData, 0, channelData[0].length));
    }
    const index = resolveChannelIndex(useChannel, channelData.length);
    return calculateEnergy(channelData[index]);
}
/**
 * Energy of each analysis window of `channelData`, one value per whole
 * window of `frameSamples` samples. A final partial window, if any, is
 * ignored. This is what automatic threshold estimation runs on; the
 * energy formula and channel aggregation are exactly those used by the
 * tokenizer's energy validator, so an estimated threshold means the
 * same thing at detection time.
 */
export function computeFrameEnergies(channelData, frameSamples, useChannel = "any") {
    if (!Number.isInteger(frameSamples) || frameSamples <= 0) {
        throw new RangeError(`'frameSamples' must be a positive integer, given: ${frameSamples}`);
    }
    const totalSamples = channelData[0]?.length ?? 0;
    const nFrames = Math.floor(totalSamples / frameSamples);
    const energies = new Float64Array(nFrames);
    for (let i = 0; i < nFrames; i++) {
        const start = i * frameSamples;
        const end = start + frameSamples;
        const frame = channelData.map((channel) => channel.subarray(start, end));
        energies[i] = windowEnergy(frame, useChannel);
    }
    return energies;
}
/** Equal-width histogram matching numpy.histogram: `bins` bins over
 * [min, max], the last bin including its right edge. */
function histogram(values, bins, min, max) {
    const hist = new Float64Array(bins);
    const edges = new Float64Array(bins + 1);
    for (let i = 0; i <= bins; i++) {
        edges[i] = min + ((max - min) * i) / bins;
    }
    const scale = bins / (max - min);
    for (let i = 0; i < values.length; i++) {
        let bin = Math.floor((values[i] - min) * scale);
        if (bin >= bins) {
            bin = bins - 1;
        }
        else if (bin < 0) {
            bin = 0;
        }
        hist[bin] += 1;
    }
    return { hist, edges };
}
/** Otsu's method: split the energy histogram in two classes maximizing
 * the between-class variance. Parameter-free; assumes the energy
 * distribution is roughly bimodal (background vs. activity). */
function estimateThresholdOtsu(energies, bins = 128) {
    let min = Infinity;
    let max = -Infinity;
    for (const e of energies) {
        if (e < min)
            min = e;
        if (e > max)
            max = e;
    }
    const { hist, edges } = histogram(energies, bins, min, max);
    const centers = new Float64Array(bins);
    for (let i = 0; i < bins; i++) {
        centers[i] = (edges[i] + edges[i + 1]) / 2;
    }
    let total = 0;
    let totalMass = 0;
    for (let i = 0; i < bins; i++) {
        total += hist[i];
        totalMass += hist[i] * centers[i];
    }
    // between-class variance at each split point (split after bin i)
    const betweenVar = new Float64Array(bins - 1);
    let weight0 = 0;
    let cumMass = 0;
    for (let i = 0; i < bins - 1; i++) {
        weight0 += hist[i];
        cumMass += hist[i] * centers[i];
        const weight1 = total - weight0;
        if (weight0 === 0 || weight1 === 0) {
            betweenVar[i] = -1; // matches numpy's nan_to_num(nan=-1)
            continue;
        }
        const mu0 = cumMass / weight0;
        const mu1 = (totalMass - cumMass) / weight1;
        betweenVar[i] = weight0 * weight1 * (mu0 - mu1) ** 2;
    }
    let best = -Infinity;
    for (let i = 0; i < betweenVar.length; i++) {
        if (betweenVar[i] > best)
            best = betweenVar[i];
    }
    // empty bins between the two modes make the between-class variance
    // exactly flat over the gap; take the middle of the plateau (max
    // margin) rather than the leftmost point
    const candidates = [];
    for (let i = 0; i < betweenVar.length; i++) {
        if (betweenVar[i] === best)
            candidates.push(i);
    }
    const split = candidates[(candidates.length - 1) >> 1];
    return edges[split + 1];
}
/** Linear-interpolation percentile, matching numpy.percentile. */
function percentileOf(sorted, percentile) {
    const rank = ((sorted.length - 1) * percentile) / 100;
    const lo = Math.floor(rank);
    const frac = rank - lo;
    if (lo + 1 >= sorted.length) {
        return sorted[sorted.length - 1];
    }
    return sorted[lo] + frac * (sorted[lo + 1] - sorted[lo]);
}
/** Noise floor (low percentile of window energies) plus a margin. */
function estimateThresholdPercentile(energies, percentile, margin) {
    const sorted = [...energies].sort((a, b) => a - b);
    return percentileOf(sorted, percentile) + margin;
}
/**
 * Estimate an energy threshold from analysis-window energies (as
 * returned by {@link computeFrameEnergies}). The returned value is on
 * the same dB scale as `energyThreshold` and can be passed to `split`
 * directly.
 *
 * All-zero windows carry the -200 dB silence sentinel and are excluded
 * from the estimate; if nothing else remains the input is entirely
 * digitally silent and the function returns `Infinity` (every window
 * must fail validation — there is nothing to detect).
 */
export function estimateEnergyThreshold(frameEnergies, method = "otsu", options = {}) {
    if (frameEnergies.length === 0) {
        throw new RangeError("Cannot estimate an energy threshold from an empty energy array " +
            "(input audio shorter than one analysis window?)");
    }
    const energies = [];
    for (let i = 0; i < frameEnergies.length; i++) {
        if (frameEnergies[i] > SILENCE_ENERGY) {
            energies.push(frameEnergies[i]);
        }
    }
    if (energies.length === 0) {
        // the input is entirely digitally silent: there is no energy
        // distribution to estimate from and nothing to detect
        return Infinity;
    }
    let min = Infinity;
    let max = -Infinity;
    for (const e of energies) {
        if (e < min)
            min = e;
        if (e > max)
            max = e;
    }
    if (min === max) {
        return min;
    }
    if (method === "otsu") {
        return estimateThresholdOtsu(energies);
    }
    if (method === "percentile") {
        return estimateThresholdPercentile(energies, options.percentile ?? 10, options.margin ?? 6);
    }
    throw new RangeError(`Unknown threshold estimation method '${method}', expected ` +
        `"otsu" or "percentile"`);
}
