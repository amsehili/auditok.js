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
/**
 * Load audio in the browser into an {@link AudioRegion}. Accepts a
 * `File`/`Blob` (e.g. from a file input or drag-and-drop), an
 * `ArrayBuffer`/`Uint8Array`, or a URL string (fetched with CORS
 * rules applying).
 */
export async function load(source, options = {}) {
    let bytes;
    if (typeof source === "string") {
        const response = await fetch(source);
        if (!response.ok) {
            throw new Error(`failed to fetch '${source}': ${response.status}`);
        }
        bytes = await response.arrayBuffer();
    }
    else if (source instanceof Blob) {
        bytes = await source.arrayBuffer();
    }
    else if (source instanceof Uint8Array) {
        bytes = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
    }
    else {
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
    const channelData = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
    return new AudioRegion(channelData, buffer.sampleRate);
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
export async function microphone(options = {}) {
    const sampleRate = options.sampleRate ?? 16000;
    const media = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1 },
    });
    const context = new AudioContext({ sampleRate });
    const workletUrl = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "application/javascript" }));
    try {
        await context.audioWorklet.addModule(workletUrl);
    }
    finally {
        URL.revokeObjectURL(workletUrl);
    }
    const sourceNode = context.createMediaStreamSource(media);
    const captureNode = new AudioWorkletNode(context, "auditok-capture");
    sourceNode.connect(captureNode);
    const pending = [];
    let notify;
    let done = false;
    captureNode.port.onmessage = (event) => {
        pending.push(event.data);
        notify?.();
    };
    async function* chunks() {
        while (!done || pending.length > 0) {
            if (pending.length === 0) {
                await new Promise((resolve) => {
                    notify = resolve;
                });
                notify = undefined;
                continue;
            }
            yield pending.shift();
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
