/**
 * auditok core: audio activity detection and segmentation over
 * Float32Array samples. Environment-free and dependency-free — this
 * entry point works in Node, browsers, workers and edge runtimes.
 *
 * Importing the package root (`import ... from "auditok"`) adds the
 * platform io helpers (file loading, microphone) on top of this core;
 * `import ... from "auditok/core"` gives exactly this module.
 */

export {
  split,
  splitAll,
  trim,
  fixPauses,
  type AudioInput,
  type AudioFrame,
  type AudioBufferLike,
  type SplitOptions,
} from "./split.js";
export { AudioRegion, makeSilence, concatRegions } from "./region.js";
export {
  StreamTokenizer,
  type FrameValidator,
  type Token,
  type StreamTokenizerOptions,
} from "./tokenizer.js";
export {
  calculateEnergy,
  windowEnergy,
  computeFrameEnergies,
  estimateEnergyThreshold,
  EPSILON,
  INT16_SCALE,
  SILENCE_ENERGY,
  type ChannelSelection,
  type ThresholdMethod,
  type ThresholdMethodOptions,
} from "./signal.js";
export {
  decodeWav,
  encodeWav,
  isWav,
  type DecodedAudio,
  type WavEncodeOptions,
} from "./wav.js";
