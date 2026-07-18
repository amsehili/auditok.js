# auditok-webrtcvad

The **WebRTC voice activity detector** as a frame validator for
[auditok](https://github.com/amsehili/auditok.js): detect *speech*
specifically, rather than any acoustic activity, and let auditok's
tokenizer turn the frame decisions into events with proper duration and
silence semantics — the JS counterpart of Python auditok's
`validator="webrtc:N"`.

This is [libfvad](https://github.com/dpirch/libfvad) — the standalone,
BSD-licensed extraction of WebRTC's VAD, a small GMM over frequency
sub-band energies with online noise adaptation — compiled once to a
~30 KB WebAssembly binary embedded in the package. No model downloads, no
native modules, no dependencies; the same file runs in Node and every
browser. It wraps the identical C code as Python's `webrtcvad` package,
and the test suite verifies frame decisions match it bit for bit.

## Install

```sh
npm install auditok auditok-webrtcvad
```

The main `auditok` package stays a few KB of plain JS; this add-on is the
explicit opt-in for the WASM blob.

## Usage

```js
import { split } from "auditok";
import { createWebrtcValidator } from "auditok-webrtcvad";

const validator = await createWebrtcValidator({ sampleRate: 16000, mode: 1 });
for await (const event of split(audio, { validator, maxSilence: 0.1 })) {
  console.log(`speech: ${event.start.toFixed(2)}s -> ${event.end.toFixed(2)}s`);
}
validator.destroy(); // optional; also released on garbage collection
```

Options of `createWebrtcValidator`:

- `sampleRate` (required): 8000, 16000, 32000 or 48000 Hz — a WebRTC VAD
  requirement; must match the audio given to `split`.
- `mode` (default 1): aggressiveness 0–3. Higher rejects more audio as
  non-speech; 0–1 suit far-field or noisy audio, 2 clean close-talk audio.
- `subframeDur` (default 0.01): the VAD consumes 10, 20 or 30 ms
  subframes; the `analysisWindow` used with `split` should be a multiple.
- `aggregation` (default `"majority"`): how subframe decisions combine
  into a window decision (`"majority"`, `"any"`, `"all"`).
- `useChannel` (default `"mix"`): channel index or `"mix"` for
  multichannel audio.

The VAD is **stateful** (it adapts its noise model and applies a decision
hangover): use a fresh validator per stream or file, or call `.reset()`
between unrelated inputs. As a frame validator it typically works best
with a smaller `maxSilence` than auditok's 0.3 s default — try `0.1`.

For raw per-subframe decisions (the equivalent of Python's
`webrtcvad.Vad`), use the lower-level `WebrtcVad` class.

## Rebuilding the WASM binary

`src/fvad-wasm.ts` is generated and committed; users and CI never need a
C toolchain. To rebuild it (e.g. to bump the pinned libfvad commit), run
`tools/build-fvad-wasm.sh` from the repository root (requires docker).

## License

MIT (wrapper) and BSD-3-Clause (libfvad / WebRTC — see
`LICENSE.libfvad`).
