// SPDX-License-Identifier: BSD-3-Clause
// WebAssembly bridge around the bundled libopus (BSD-3-Clause; see
// android-app/app/src/main/cpp/opus). Browser + Node counterpart of
// opus_jni.cpp.
//
// Exposes the encoder + decoder our voiceClient + recorder need:
//
//   _opus_init_encoder()                              → 1 ok, 0 failed
//   _opus_init_decoder()                              → 1 ok, 0 failed
//   _opus_reset_encoder()                             → 1 ok, 0 failed
//   _opus_reset_decoder()                             → 1 ok, 0 failed
//   _opus_encode_frame(pcmPtr, outPtr, outMax)        → packet length (>0) or <0 err
//   _opus_decode_frame(inPtr, inLen, pcmOutPtr)       → 320 samples or negative
//   _opus_decode_fec_frame(nextInPtr, nextLen, ...)   → 320 samples (LBRR recovery)
//
//   Per-talk-spurt factories used by the server recorder so concurrent
//   channels don't share state:
//
//   _opus_decoder_make()                              → OpusDecoder* (0 on failure)
//   _opus_decoder_release(dec)
//   _opus_decoder_run(dec, inPtr, inLen, pcmOutPtr)   → 320 samples or negative
//
// Voice profile: 16 kHz mono, 20 ms frames (320 samples), 32 kbps, VOIP
// application. **In-band FEC enabled** with a 10 % packet-loss budget
// so each encoded packet carries LBRR for the previous frame — the
// user-visible win versus the WebCodecs path this replaces, which
// exposed no FEC controls.
//
// The encoder + decoder profile and CTL order must stay byte-aligned
// with opus_jni.cpp (Android) and the Swift bridge (iOS) so all three
// platforms emit identical bitstreams. Wire format unchanged: 2-byte
// magic (0x4F 0x70) + raw Opus packet, per voiceCodecs.ts.

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten/emscripten.h>

#include "opus.h"

// Singleton encoder + decoder — one channel session at a time on a web
// console. The server recorder uses opus_decoder_make() for per-talk
// spurt decoders that live alongside this singleton.
static OpusEncoder* g_encoder = NULL;
static OpusDecoder* g_decoder = NULL;

#define OPUS_SAMPLE_RATE        16000
#define OPUS_CHANNELS               1
#define OPUS_FRAME_SAMPLES        320   /* 20 ms @ 16 kHz */
#define OPUS_BITRATE_BPS        32000
#define OPUS_PACKET_LOSS_PERC      10   /* sensible FEC budget */
#define OPUS_VOIP_COMPLEXITY        8   /* good quality, low CPU */

/** Apply the voice profile to a freshly-created encoder. Returns 1 on
 *  success, 0 if any CTL was rejected. Order must mirror opus_jni.cpp
 *  and OpusVoiceCodec.swift so all three platforms emit byte-identical
 *  bitstreams for the same input. */
static int apply_encoder_config(OpusEncoder* enc) {
    if (!enc) return 0;
    if (opus_encoder_ctl(enc, OPUS_SET_SIGNAL(OPUS_SIGNAL_VOICE)) != OPUS_OK) return 0;
    if (opus_encoder_ctl(enc, OPUS_SET_BITRATE(OPUS_BITRATE_BPS)) != OPUS_OK) return 0;
    if (opus_encoder_ctl(enc, OPUS_SET_INBAND_FEC(1)) != OPUS_OK) return 0;
    if (opus_encoder_ctl(enc, OPUS_SET_PACKET_LOSS_PERC(OPUS_PACKET_LOSS_PERC)) != OPUS_OK) return 0;
    if (opus_encoder_ctl(enc, OPUS_SET_COMPLEXITY(OPUS_VOIP_COMPLEXITY)) != OPUS_OK) return 0;
    // DTX off — a DTX'd frame emits no packet, so there'd be nothing on
    // the wire to carry the next frame's LBRR. FEC and DTX are mutually
    // exclusive for our purposes.
    if (opus_encoder_ctl(enc, OPUS_SET_DTX(0)) != OPUS_OK) return 0;
    return 1;
}

EMSCRIPTEN_KEEPALIVE
int opus_init_encoder(void) {
    int err = 0;
    if (g_encoder) { opus_encoder_destroy(g_encoder); g_encoder = NULL; }
    g_encoder = opus_encoder_create(OPUS_SAMPLE_RATE, OPUS_CHANNELS,
                                     OPUS_APPLICATION_VOIP, &err);
    if (err != OPUS_OK || !g_encoder) {
        if (g_encoder) { opus_encoder_destroy(g_encoder); g_encoder = NULL; }
        return 0;
    }
    if (!apply_encoder_config(g_encoder)) {
        opus_encoder_destroy(g_encoder);
        g_encoder = NULL;
        return 0;
    }
    return 1;
}

EMSCRIPTEN_KEEPALIVE
int opus_init_decoder(void) {
    int err = 0;
    if (g_decoder) { opus_decoder_destroy(g_decoder); g_decoder = NULL; }
    g_decoder = opus_decoder_create(OPUS_SAMPLE_RATE, OPUS_CHANNELS, &err);
    if (err != OPUS_OK || !g_decoder) {
        if (g_decoder) { opus_decoder_destroy(g_decoder); g_decoder = NULL; }
        return 0;
    }
    return 1;
}

EMSCRIPTEN_KEEPALIVE
int opus_reset_encoder(void) { return opus_init_encoder(); }

EMSCRIPTEN_KEEPALIVE
int opus_reset_decoder(void) { return opus_init_decoder(); }

/** Encode one 20 ms frame. `pcm_in_320` points at 320 int16 mono samples;
 *  the encoder writes a variable-size Opus packet to `out_buf` (bounded
 *  by `out_buf_max`). Returns the byte length of the packet (>0) or a
 *  negative opus_int32 error code. */
EMSCRIPTEN_KEEPALIVE
int opus_encode_frame(int16_t* pcm_in_320, uint8_t* out_buf, int out_buf_max) {
    if (!g_encoder) return -1;
    return opus_encode(g_encoder, pcm_in_320, OPUS_FRAME_SAMPLES, out_buf, out_buf_max);
}

/** Decode one Opus packet to 320 samples of 16 kHz mono PCM-16 at
 *  `pcm_out_320`. Returns the sample count actually written (320 on
 *  success) or a negative opus_int32 error code. */
EMSCRIPTEN_KEEPALIVE
int opus_decode_frame(uint8_t* in_buf, int in_len, int16_t* pcm_out_320) {
    if (!g_decoder) return -1;
    return opus_decode(g_decoder, in_buf, in_len, pcm_out_320, OPUS_FRAME_SAMPLES, 0);
}

/** Reconstruct the previous (lost) frame from the LBRR data inside
 *  `next_packet`. Returns 320 samples or a negative error. The caller
 *  must follow with a regular opus_decode_frame(next_packet, ...) to
 *  play the actual audio of the new packet — opus_decode is stateful. */
EMSCRIPTEN_KEEPALIVE
int opus_decode_fec_frame(uint8_t* next_packet, int next_len, int16_t* pcm_out_320) {
    if (!g_decoder) return -1;
    return opus_decode(g_decoder, next_packet, next_len, pcm_out_320, OPUS_FRAME_SAMPLES, 1);
}

// --- per-talk-spurt decoders ---------------------------------------------
// The server recorder allocates a dedicated decoder per channel talk-spurt
// because opus_decoder_create state holds frame-to-frame history (the
// LBRR window in particular). A shared decoder would corrupt interleaved
// channels' decoded audio.

EMSCRIPTEN_KEEPALIVE
OpusDecoder* opus_decoder_make(void) {
    int err = 0;
    OpusDecoder* d = opus_decoder_create(OPUS_SAMPLE_RATE, OPUS_CHANNELS, &err);
    if (err != OPUS_OK) {
        if (d) opus_decoder_destroy(d);
        return NULL;
    }
    return d;
}

EMSCRIPTEN_KEEPALIVE
void opus_decoder_release(OpusDecoder* dec) {
    if (dec) opus_decoder_destroy(dec);
}

EMSCRIPTEN_KEEPALIVE
int opus_decoder_run(OpusDecoder* dec, uint8_t* in_buf, int in_len, int16_t* pcm_out_320) {
    if (!dec) return -1;
    return opus_decode(dec, in_buf, in_len, pcm_out_320, OPUS_FRAME_SAMPLES, 0);
}
