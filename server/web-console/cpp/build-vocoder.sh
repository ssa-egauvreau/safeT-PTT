#!/usr/bin/env bash
# Compiles the bundled GPL dvmvocoder + p25_wasm.cpp into self-contained
# WebAssembly ES modules — one for the browser console, one for the Node server.
#
# Requires Emscripten (emcc). The simplest way without installing it:
#   docker run --rm -v "$PWD":/src -w /src emscripten/emsdk \
#     bash server/web-console/cpp/build-vocoder.sh
#
# The generated modules are committed, so deploys need no toolchain.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
voc="$here/../../../android-app/app/src/main/cpp/dvmvocoder/vocoder"

build() {
  local environment="$1" out="$2"
  mkdir -p "$(dirname "$out")"
  emcc \
    -O3 -DNDEBUG \
    -I "$voc" -I "$voc/imbe" \
    "$voc"/imbe/*.cpp \
    "$voc"/*.cpp \
    "$voc"/*.c \
    "$here/p25_wasm.cpp" \
    -s MODULARIZE=1 \
    -s EXPORT_ES6=1 \
    -s SINGLE_FILE=1 \
    -s ENVIRONMENT="$environment" \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s EXPORTED_FUNCTIONS='["_imbe_init","_imbe_encode","_imbe_decode","_imbe_decoder_create","_imbe_decoder_decode","_imbe_decoder_free","_ambe_init","_ambe_encode","_ambe_decode","_ambe_decoder_create","_ambe_decoder_decode","_ambe_decoder_free","_malloc","_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["HEAP16","HEAPU8"]' \
    -o "$out"
  echo "Built $out"
}

# Browser console (P25 RX decode).
build "web,worker" "$here/../src/vendor/imbeModule.js"
# Node server (recorder decodes IMBE so digital transmissions are stored as PCM).
build "node" "$here/../../vocoder/imbeModule.mjs"
