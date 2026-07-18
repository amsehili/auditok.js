/**
 * Environment-free WAV (RIFF) codec: works in Node and in the browser
 * without an AudioContext. Decodes PCM 8/16/24/32-bit integer and
 * 32-bit IEEE float (including WAVE_FORMAT_EXTENSIBLE); encodes 16-bit
 * PCM or 32-bit float.
 */
const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
function toDataView(data) {
    if (data instanceof ArrayBuffer) {
        return new DataView(data);
    }
    return new DataView(data.buffer, data.byteOffset, data.byteLength);
}
/** True if `data` starts with a RIFF/WAVE header. */
export function isWav(data) {
    const view = toDataView(data);
    return (view.byteLength >= 12 &&
        view.getUint32(0, false) === 0x52494646 && // "RIFF"
        view.getUint32(8, false) === 0x57415645 // "WAVE"
    );
}
/** Decode a WAV file into planar Float32Array channels in [-1, 1]. */
export function decodeWav(data) {
    const view = toDataView(data);
    if (!isWav(data)) {
        throw new Error("not a RIFF/WAVE file");
    }
    let format = 0;
    let channels = 0;
    let sampleRate = 0;
    let bitsPerSample = 0;
    let dataOffset = -1;
    let dataLength = 0;
    let offset = 12;
    while (offset + 8 <= view.byteLength) {
        const chunkId = view.getUint32(offset, false);
        const chunkSize = view.getUint32(offset + 4, true);
        const body = offset + 8;
        if (chunkId === 0x666d7420) {
            // "fmt "
            format = view.getUint16(body, true);
            channels = view.getUint16(body + 2, true);
            sampleRate = view.getUint32(body + 4, true);
            bitsPerSample = view.getUint16(body + 14, true);
            if (format === WAVE_FORMAT_EXTENSIBLE && chunkSize >= 40) {
                // sub-format GUID starts with the actual format code
                format = view.getUint16(body + 24, true);
            }
        }
        else if (chunkId === 0x64617461) {
            // "data"
            dataOffset = body;
            dataLength = Math.min(chunkSize, view.byteLength - body);
        }
        offset = body + chunkSize + (chunkSize % 2); // chunks are word-aligned
    }
    if (channels === 0 || sampleRate === 0) {
        throw new Error("invalid WAV file: no fmt chunk");
    }
    if (dataOffset < 0) {
        throw new Error("invalid WAV file: no data chunk");
    }
    const bytesPerSample = bitsPerSample / 8;
    if (!((format === WAVE_FORMAT_PCM && [8, 16, 24, 32].includes(bitsPerSample)) ||
        (format === WAVE_FORMAT_IEEE_FLOAT && bitsPerSample === 32))) {
        throw new Error(`unsupported WAV format: format code ${format}, ` +
            `${bitsPerSample} bits per sample`);
    }
    const frameCount = Math.floor(dataLength / (bytesPerSample * channels));
    const channelData = Array.from({ length: channels }, () => new Float32Array(frameCount));
    for (let i = 0; i < frameCount; i++) {
        for (let c = 0; c < channels; c++) {
            const at = dataOffset + (i * channels + c) * bytesPerSample;
            let value;
            if (format === WAVE_FORMAT_IEEE_FLOAT) {
                value = view.getFloat32(at, true);
            }
            else if (bitsPerSample === 8) {
                value = (view.getUint8(at) - 128) / 128;
            }
            else if (bitsPerSample === 16) {
                value = view.getInt16(at, true) / 32768;
            }
            else if (bitsPerSample === 24) {
                const raw = view.getUint8(at) |
                    (view.getUint8(at + 1) << 8) |
                    (view.getInt8(at + 2) << 16);
                value = raw / 8388608;
            }
            else {
                value = view.getInt32(at, true) / 2147483648;
            }
            channelData[c][i] = value;
        }
    }
    return { channelData, sampleRate };
}
/** Encode planar Float32Array channels as a WAV file. */
export function encodeWav(audio, options = {}) {
    const { channelData, sampleRate } = audio;
    const bitDepth = options.bitDepth ?? 16;
    const float = bitDepth === "float32";
    const bytesPerSample = float ? 4 : 2;
    const channels = channelData.length;
    const frameCount = channelData[0]?.length ?? 0;
    const dataSize = frameCount * channels * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    view.setUint32(0, 0x52494646, false); // "RIFF"
    view.setUint32(4, 36 + dataSize, true);
    view.setUint32(8, 0x57415645, false); // "WAVE"
    view.setUint32(12, 0x666d7420, false); // "fmt "
    view.setUint32(16, 16, true);
    view.setUint16(20, float ? WAVE_FORMAT_IEEE_FLOAT : WAVE_FORMAT_PCM, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * bytesPerSample, true);
    view.setUint16(32, channels * bytesPerSample, true);
    view.setUint16(34, float ? 32 : 16, true);
    view.setUint32(36, 0x64617461, false); // "data"
    view.setUint32(40, dataSize, true);
    let at = 44;
    for (let i = 0; i < frameCount; i++) {
        for (let c = 0; c < channels; c++) {
            const value = channelData[c][i];
            if (float) {
                view.setFloat32(at, value, true);
            }
            else {
                // symmetric scale, clamped to the int16 range: values on the
                // int16 grid (v / 32768) roundtrip exactly
                const scaled = Math.round(value * 32768);
                view.setInt16(at, Math.max(-32768, Math.min(32767, scaled)), true);
            }
            at += bytesPerSample;
        }
    }
    return new Uint8Array(buffer);
}
