#!/bin/sh
# Rebuild webrtcvad/src/fvad-wasm.ts: compile libfvad to standalone
# WebAssembly with dockerized emscripten and embed it as base64.
# Only needed when bumping the pinned libfvad commit or the
# emscripten version — the generated file is committed.
#
# Requires: docker, git, node. Run from the repository root.
set -eu

LIBFVAD_REPO=https://github.com/dpirch/libfvad
LIBFVAD_COMMIT=532ab666c20d3cfda38bca63abbb0f152706c369
EMSDK_IMAGE=emscripten/emsdk:3.1.61
OUT=webrtcvad/src/fvad-wasm.ts

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

git clone --quiet "$LIBFVAD_REPO" "$workdir/libfvad"
git -C "$workdir/libfvad" checkout --quiet "$LIBFVAD_COMMIT"
cp "$workdir/libfvad/LICENSE" webrtcvad/LICENSE.libfvad

docker run --rm -v "$workdir":/work -w /work "$EMSDK_IMAGE" sh -c '
  emcc -O3 --no-entry \
    -s STANDALONE_WASM=1 \
    -s EXPORTED_FUNCTIONS=_fvad_new,_fvad_free,_fvad_reset,_fvad_set_mode,_fvad_set_sample_rate,_fvad_process,_malloc,_free \
    -I libfvad/include -I libfvad/src \
    libfvad/src/fvad.c libfvad/src/signal_processing/*.c libfvad/src/vad/*.c \
    -o fvad.wasm'

WASM="$workdir/fvad.wasm" COMMIT="$LIBFVAD_COMMIT" IMAGE="$EMSDK_IMAGE" \
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const wasm = readFileSync(process.env.WASM);
const b64 = wasm.toString("base64");
const lines = [];
for (let i = 0; i < b64.length; i += 76) {
  lines.push(`  "${b64.slice(i, i + 76)}"`);
}
writeFileSync(
  "webrtcvad/src/fvad-wasm.ts",
  [
    "// GENERATED FILE - do not edit; rebuild with tools/build-fvad-wasm.sh",
    `// libfvad commit ${process.env.COMMIT}, ${process.env.IMAGE}`,
    "",
    `export const LIBFVAD_COMMIT = "${process.env.COMMIT}";`,
    "",
    "export const FVAD_WASM_BASE64 =",
    lines.join(" +\n") + ";",
    "",
  ].join("\n"),
);
console.log(`wrote webrtcvad/src/fvad-wasm.ts (${wasm.length} wasm bytes)`);
'
