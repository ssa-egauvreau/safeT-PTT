// Exposes the bundled vocoders to Swift.
#pragma once

#include <stdbool.h>
#include <stdint.h>

// P25 IMBE (88-bit codeword, 20 ms frame @ 8 kHz, 160 samples).
bool p25_imbe_init(void);
bool p25_imbe_encode(const int16_t *samples8k160, uint8_t *codeword11_out);
bool p25_imbe_decode(const uint8_t *codeword11, int16_t *samples8k160_out);

// AMBE+2 half-rate — the P25 Phase 2 / DMR vocoder rate (49 voice bits @
// 2450 bps in a 9-byte DMR-interleaved codeword, 20 ms frame @ 8 kHz).
bool p25_ambe_init(void);
bool p25_ambe_encode(const int16_t *samples8k160, uint8_t *codeword9_out);
bool p25_ambe_decode(const uint8_t *codeword9, int16_t *samples8k160_out);

// libcodec2 mode 3200 (64-bit codeword, 20 ms frame @ 8 kHz, 160 samples).
// Forward-declare the C functions Codec2VoiceCodec.swift calls — keeps
// the bridging header light without dragging in codec2.h's full transitive
// includes. The OpaquePointer ABI on the Swift side matches `struct CODEC2 *`
// on the C side; size/alignment match because both sides treat it as a
// platform-width pointer.
struct CODEC2;
struct CODEC2 *codec2_create(int mode);
void codec2_destroy(struct CODEC2 *state);
void codec2_encode(struct CODEC2 *state,
                   unsigned char bytes[],
                   short speech_in[]);
void codec2_decode(struct CODEC2 *state,
                   short speech_out[],
                   const unsigned char bytes[]);
int codec2_samples_per_frame(struct CODEC2 *state);
int codec2_bytes_per_frame(struct CODEC2 *state);

#define CODEC2_MODE_3200 0

// libopus 1.5.2 (BSD-3-Clause). The full public header is small and
// well-bounded — include it directly so OpusVoiceCodec.swift gets the
// real opus_encode / opus_decode signatures and the integer constants
// (OPUS_OK, OPUS_APPLICATION_VOIP, ...) without us having to mirror
// them. opus.h's transitive includes are just opus_defines.h +
// opus_types.h + opus_custom.h, all from the same opus/include
// directory we put on HEADER_SEARCH_PATHS.
#include "opus.h"

// libopus's opus_encoder_ctl / opus_decoder_ctl are variadic, and Swift
// cannot call C variadic functions directly (only Objective-C variadic
// methods with NSObject args are bridged). These non-variadic shims live
// in SafeTMobile/Native/opus_swift_bridge.c and forward to the variadic
// CTL with the right OPUS_SET_*-macro arity. Return values match the
// underlying opus_encoder_ctl return — 0 (OPUS_OK) on success, negative
// OpusError on failure.
int opus_swift_encoder_set_signal(OpusEncoder *enc, int signal);
int opus_swift_encoder_set_bitrate(OpusEncoder *enc, int bitrate);
int opus_swift_encoder_set_inband_fec(OpusEncoder *enc, int enable);
int opus_swift_encoder_set_packet_loss_perc(OpusEncoder *enc, int perc);
int opus_swift_encoder_set_complexity(OpusEncoder *enc, int complexity);
int opus_swift_encoder_set_dtx(OpusEncoder *enc, int enable);
