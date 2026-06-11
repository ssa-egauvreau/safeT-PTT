// SPDX-License-Identifier: GPL-2.0-only
// WebAssembly bridge around the bundled dvmvocoder (GPL-2.0; see
// android-app/app/src/main/cpp/dvmvocoder). Browser counterpart of p25_jni.cpp.

#include <cstdint>
#include <new>

#include <emscripten/emscripten.h>

#include "MBEDecoder.h"
#include "MBEEncoder.h"

using namespace vocoder;

namespace {
MBEEncoder* gEncoder = nullptr;
MBEDecoder* gDecoder = nullptr;
// AMBE+2 half-rate (P25 Phase 2 / DMR vocoder rate): 49 voice bits @ 2450 bps
// carried in dvmvocoder's 9-byte DMR-interleaved codeword. Separate instances
// from IMBE — both vocoders keep frame-to-frame state.
MBEEncoder* gAmbeEncoder = nullptr;
MBEDecoder* gAmbeDecoder = nullptr;
} // namespace

extern "C" {

/** Allocates the IMBE encoder/decoder. Returns 1 on success. */
EMSCRIPTEN_KEEPALIVE
int imbe_init() {
  delete gEncoder;
  delete gDecoder;
  gEncoder = new (std::nothrow) MBEEncoder(ENCODE_88BIT_IMBE);
  gDecoder = new (std::nothrow) MBEDecoder(DECODE_88BIT_IMBE);
  if (gEncoder != nullptr) {
    gEncoder->setGainAdjust(1.0f);
  }
  // Intentionally leave gDecoder->autoGain at the constructor default (false).
  // Web + server run ImbeAgc on the decoded PCM, which is a 1:1 port of the
  // native autoGain ramp. Opting in here would stack two identical compressors
  // and over-drive loud talk-spurts.
  return (gEncoder != nullptr && gDecoder != nullptr) ? 1 : 0;
}

/** 160 PCM samples (8 kHz, int16) -> 11-byte IMBE codeword. */
EMSCRIPTEN_KEEPALIVE
int imbe_encode(int16_t* samples160, uint8_t* codeword11) {
  if (gEncoder == nullptr) {
    return 0;
  }
  gEncoder->encode(samples160, codeword11);
  return 1;
}

/** 11-byte IMBE codeword -> 160 PCM samples (8 kHz, int16). */
EMSCRIPTEN_KEEPALIVE
int imbe_decode(uint8_t* codeword11, int16_t* samples160) {
  if (gDecoder == nullptr) {
    return 0;
  }
  gDecoder->decode(codeword11, samples160);
  return 1;
}

// --- per-stream decoders -------------------------------------------------
// IMBE decoding keeps frame-to-frame history, so each concurrent digital
// stream needs its own decoder; a shared one corrupts interleaved traffic.

EMSCRIPTEN_KEEPALIVE
MBEDecoder* imbe_decoder_create() {
  // autoGain stays at the constructor default (false). See imbe_init() — the
  // server's recording pipeline (imbeServerCodec.ts) also runs ImbeAgc on the
  // decoded PCM, so the native ramp would duplicate it.
  return new (std::nothrow) MBEDecoder(DECODE_88BIT_IMBE);
}

EMSCRIPTEN_KEEPALIVE
void imbe_decoder_free(MBEDecoder* decoder) {
  delete decoder;
}

EMSCRIPTEN_KEEPALIVE
int imbe_decoder_decode(MBEDecoder* decoder, uint8_t* codeword11, int16_t* samples160) {
  if (decoder == nullptr) {
    return 0;
  }
  decoder->decode(codeword11, samples160);
  return 1;
}

// --- AMBE+2 half-rate (P25 Phase 2 vocoder rate) --------------------------
// Same shape as the IMBE entry points, but on dvmvocoder's DMR_AMBE mode:
// 160 PCM samples (8 kHz, 20 ms) <-> 9-byte DMR-interleaved AMBE codeword
// carrying 49 voice bits @ 2450 bps. This is the vocoder frame sdrtrunk's
// jmbe decodes as "AMBE 3600x2450" on P25 Phase 2 / DMR systems.

/** Allocates the AMBE encoder/decoder. Returns 1 on success. */
EMSCRIPTEN_KEEPALIVE
int ambe_init() {
  delete gAmbeEncoder;
  delete gAmbeDecoder;
  gAmbeEncoder = new (std::nothrow) MBEEncoder(ENCODE_DMR_AMBE);
  gAmbeDecoder = new (std::nothrow) MBEDecoder(DECODE_DMR_AMBE);
  // Like IMBE above: leave autoGain off — web + server run ImbeAgc on the
  // decoded PCM instead, so the native ramp would stack a second compressor.
  return (gAmbeEncoder != nullptr && gAmbeDecoder != nullptr) ? 1 : 0;
}

/** 160 PCM samples (8 kHz, int16) -> 9-byte AMBE codeword. */
EMSCRIPTEN_KEEPALIVE
int ambe_encode(int16_t* samples160, uint8_t* codeword9) {
  if (gAmbeEncoder == nullptr) {
    return 0;
  }
  gAmbeEncoder->encode(samples160, codeword9);
  return 1;
}

/** 9-byte AMBE codeword -> 160 PCM samples (8 kHz, int16). */
EMSCRIPTEN_KEEPALIVE
int ambe_decode(uint8_t* codeword9, int16_t* samples160) {
  if (gAmbeDecoder == nullptr) {
    return 0;
  }
  gAmbeDecoder->decode(codeword9, samples160);
  return 1;
}

// Per-stream AMBE decoders for the server recording path — AMBE decoding
// keeps frame-to-frame history exactly like IMBE, so each concurrent digital
// stream needs its own decoder.

EMSCRIPTEN_KEEPALIVE
MBEDecoder* ambe_decoder_create() {
  return new (std::nothrow) MBEDecoder(DECODE_DMR_AMBE);
}

EMSCRIPTEN_KEEPALIVE
void ambe_decoder_free(MBEDecoder* decoder) {
  delete decoder;
}

EMSCRIPTEN_KEEPALIVE
int ambe_decoder_decode(MBEDecoder* decoder, uint8_t* codeword9, int16_t* samples160) {
  if (decoder == nullptr) {
    return 0;
  }
  decoder->decode(codeword9, samples160);
  return 1;
}

} // extern "C"
