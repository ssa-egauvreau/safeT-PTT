#!/usr/bin/env bash
# Compiles the bundled libopus (BSD-3-Clause; see android-app/app/src/main/cpp/opus
# submodule pinned to v1.5.2) plus the cpp/opus_wasm.c bridge into
# self-contained WebAssembly ES modules — one for the browser console,
# one for the Node server recorder.
#
# Requires Emscripten (emcc). The simplest way without installing it:
#   docker run --rm -v "$PWD":/src -w /src emscripten/emsdk \
#     bash server/web-console/cpp/build-opus.sh
#
# The generated modules are committed (matches the Codec2 + IMBE vendor
# pattern at server/web-console/cpp/build-vocoder.sh) so deploys need no
# toolchain. Re-run this when the cpp/opus submodule ref is bumped.
#
# Source enumeration matches the Android NDK CMakeLists block and the
# iOS XcodeGen spec in ios-app/project.yml — keep all three in sync.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
opus="$here/../../../android-app/app/src/main/cpp/opus"

if [[ ! -f "$opus/include/opus.h" ]]; then
  echo "libopus submodule missing at $opus — run \`git submodule update --init --recursive\`" >&2
  exit 1
fi

# Slim enumeration: drop projection/multistream/mapping_matrix (we are
# mono), fixed-point SILK (we are floating point), and arch-specific
# SIMD .c files (autotools wires those via a CPU-detection RTCD; the
# stubs are not buildable in isolation).
OPUS_CORE=(
  "$opus/src/opus.c"
  "$opus/src/opus_decoder.c"
  "$opus/src/opus_encoder.c"
  "$opus/src/extensions.c"
  "$opus/src/repacketizer.c"
  "$opus/src/analysis.c"
  "$opus/src/mlp.c"
  "$opus/src/mlp_data.c"
)
OPUS_CELT=(
  "$opus/celt/bands.c"
  "$opus/celt/celt.c"
  "$opus/celt/celt_encoder.c"
  "$opus/celt/celt_decoder.c"
  "$opus/celt/cwrs.c"
  "$opus/celt/entcode.c"
  "$opus/celt/entdec.c"
  "$opus/celt/entenc.c"
  "$opus/celt/kiss_fft.c"
  "$opus/celt/laplace.c"
  "$opus/celt/mathops.c"
  "$opus/celt/mdct.c"
  "$opus/celt/modes.c"
  "$opus/celt/pitch.c"
  "$opus/celt/celt_lpc.c"
  "$opus/celt/quant_bands.c"
  "$opus/celt/rate.c"
  "$opus/celt/vq.c"
)
# silk/*.c and silk/float/*.c — globbed because the lists are large and
# stable. fixed/ stays excluded (we are -DFLOATING_POINT-free actually,
# but the SILK code uses the float wrappers via OPUS_BUILD).
OPUS_SILK=("$opus"/silk/*.c)
OPUS_SILK_FLOAT=("$opus"/silk/float/*.c)

build() {
  local environment="$1" out="$2"
  mkdir -p "$(dirname "$out")"
  emcc \
    -O3 -DNDEBUG \
    -DOPUS_BUILD -DUSE_ALLOCA -DVAR_ARRAYS -DHAVE_LRINTF \
    -DPACKAGE_VERSION='"1.5.2"' \
    -I "$opus/include" -I "$opus/celt" -I "$opus/silk" -I "$opus/silk/float" \
    "${OPUS_CORE[@]}" "${OPUS_CELT[@]}" "${OPUS_SILK[@]}" "${OPUS_SILK_FLOAT[@]}" \
    "$here/opus_wasm.c" \
    -s MODULARIZE=1 \
    -s EXPORT_ES6=1 \
    -s SINGLE_FILE=1 \
    -s ENVIRONMENT="$environment" \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s EXPORTED_FUNCTIONS='["_opus_init_encoder","_opus_init_decoder","_opus_reset_encoder","_opus_reset_decoder","_opus_encode_frame","_opus_decode_frame","_opus_decode_fec_frame","_opus_decoder_make","_opus_decoder_release","_opus_decoder_run","_malloc","_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["HEAP16","HEAPU8"]' \
    -o "$out"
  echo "Built $out ($(stat -c%s "$out" 2>/dev/null || stat -f%z "$out") bytes)"
}

# Browser console (web Opus encode + decode for voiceClient).
build "web,worker" "$here/../src/vendor/opusModule.js"
# Node server (recorder decodes Opus so digital transmissions are stored as PCM).
build "node" "$here/../../vocoder/opusModule.mjs"
