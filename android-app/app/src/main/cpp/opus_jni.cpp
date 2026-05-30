// JNI bridge for libopus (xiph.org, BSD-3-Clause). See cpp/opus submodule.
//
// Exposes the encoder + decoder the Kotlin OpusNative class needs:
//   - nativeInitEncoder() / nativeInitDecoder() → bool
//   - nativeEncode(short[320] pcm16k) → byte[N]            (variable size)
//   - nativeDecode(byte[N] packet) → short[320]            (regular decode)
//   - nativeDecodeFec(byte[N] nextPacket) → short[320]     (FEC recovery)
//   - nativeResetEncoder() / nativeResetDecoder()
//
// Voice profile: 16 kHz mono, 20 ms frames (320 samples), 32 kbps, VOIP
// application. Matches the iOS AudioToolbox + web WebCodecs paths and
// the bundled libopus on every other platform. **In-band FEC is enabled
// with a 10 % expected packet loss hint** so each encoded frame carries
// LBRR (low-bitrate redundancy) for the previous frame — the user-visible
// win versus the system MediaCodec path which exposes no FEC controls.
//
// One singleton encoder + decoder instance lives for the app lifetime,
// same pattern as codec2_jni.cpp. Both directions are guarded by a
// dedicated mutex (libopus is not internally thread-safe).
//
// FEC recovery contract: opus_decode(packet, len, pcm, frame_size=320,
// fec=1) reconstructs the *previous* frame from the LBRR data embedded
// in `packet`. Call it ONLY when the prior frame is known to be lost,
// otherwise the decoder emits a stale copy of audio that was already
// played. Single-packet gaps only — Opus FEC carries one frame of
// history, not arbitrary lookback.

#include <mutex>
#include <new>
#include <cstdint>

#include <jni.h>

extern "C" {
#include "opus.h"
}

namespace {

std::mutex gOpusMutex;

OpusEncoder* gEncoder = nullptr;
OpusDecoder* gDecoder = nullptr;

constexpr int OPUS_SAMPLE_RATE   = 16000;
constexpr int OPUS_CHANNELS      = 1;
constexpr int OPUS_FRAME_SAMPLES = 320;   // 20 ms @ 16 kHz
constexpr int OPUS_BITRATE       = 32000; // matches iOS + web
constexpr int OPUS_PACKET_LOSS_PERC = 10; // sensible FEC redundancy budget
constexpr int OPUS_COMPLEXITY    = 8;     // good quality, low CPU for rugged handsets
/** Generous bound on a 20 ms 32 kbps Opus packet. libopus measured at
 *  ~80-160 bytes for voice; 512 leaves headroom for FEC LBRR bloat and
 *  the rare full-rate frame. opus_encode returns the actual length. */
constexpr int OPUS_MAX_PACKET_BYTES = 512;

bool encoderApplyConfigLocked(OpusEncoder* enc) {
    if (enc == nullptr) return false;
    // Order matches the encoder-config block in the spec and the iOS +
    // web implementations. Any CTL failure means the configuration didn't
    // take; fail the whole init so the registry falls back to IMBE rather
    // than silently shipping the wrong profile.
    if (opus_encoder_ctl(enc, OPUS_SET_SIGNAL(OPUS_SIGNAL_VOICE)) != OPUS_OK) return false;
    if (opus_encoder_ctl(enc, OPUS_SET_BITRATE(OPUS_BITRATE)) != OPUS_OK) return false;
    if (opus_encoder_ctl(enc, OPUS_SET_INBAND_FEC(1)) != OPUS_OK) return false;
    if (opus_encoder_ctl(enc, OPUS_SET_PACKET_LOSS_PERC(OPUS_PACKET_LOSS_PERC)) != OPUS_OK) return false;
    if (opus_encoder_ctl(enc, OPUS_SET_COMPLEXITY(OPUS_COMPLEXITY)) != OPUS_OK) return false;
    // DTX off — interacts badly with FEC because a DTX'd frame produces
    // no packet, leaving nothing to carry the LBRR for the next frame.
    if (opus_encoder_ctl(enc, OPUS_SET_DTX(0)) != OPUS_OK) return false;
    return true;
}

/** Allocate encoder only. Caller must hold gOpusMutex. */
bool ensureEncoderLocked() {
    if (gEncoder != nullptr) return true;
    int err = 0;
    OpusEncoder* enc = opus_encoder_create(OPUS_SAMPLE_RATE, OPUS_CHANNELS,
                                            OPUS_APPLICATION_VOIP, &err);
    if (err != OPUS_OK || enc == nullptr) {
        if (enc != nullptr) opus_encoder_destroy(enc);
        return false;
    }
    if (!encoderApplyConfigLocked(enc)) {
        opus_encoder_destroy(enc);
        return false;
    }
    gEncoder = enc;
    return true;
}

/** Allocate decoder only. Caller must hold gOpusMutex. */
bool ensureDecoderLocked() {
    if (gDecoder != nullptr) return true;
    int err = 0;
    OpusDecoder* dec = opus_decoder_create(OPUS_SAMPLE_RATE, OPUS_CHANNELS, &err);
    if (err != OPUS_OK || dec == nullptr) {
        if (dec != nullptr) opus_decoder_destroy(dec);
        return false;
    }
    gDecoder = dec;
    return true;
}

void destroyEncoderLocked() {
    if (gEncoder != nullptr) {
        opus_encoder_destroy(gEncoder);
        gEncoder = nullptr;
    }
}

void destroyDecoderLocked() {
    if (gDecoder != nullptr) {
        opus_decoder_destroy(gDecoder);
        gDecoder = nullptr;
    }
}

}  // namespace

extern "C" JNIEXPORT jboolean JNICALL
Java_com_securityradio_ptt_device_OpusNative_nativeInitEncoder(JNIEnv* /*env*/, jclass /*cls*/) {
    std::lock_guard<std::mutex> lock(gOpusMutex);
    destroyEncoderLocked();
    return ensureEncoderLocked() ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_securityradio_ptt_device_OpusNative_nativeInitDecoder(JNIEnv* /*env*/, jclass /*cls*/) {
    std::lock_guard<std::mutex> lock(gOpusMutex);
    destroyDecoderLocked();
    return ensureDecoderLocked() ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT void JNICALL
Java_com_securityradio_ptt_device_OpusNative_nativeResetEncoder(JNIEnv* /*env*/, jclass /*cls*/) {
    std::lock_guard<std::mutex> lock(gOpusMutex);
    destroyEncoderLocked();
    ensureEncoderLocked();
}

extern "C" JNIEXPORT void JNICALL
Java_com_securityradio_ptt_device_OpusNative_nativeResetDecoder(JNIEnv* /*env*/, jclass /*cls*/) {
    std::lock_guard<std::mutex> lock(gOpusMutex);
    destroyDecoderLocked();
    ensureDecoderLocked();
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_securityradio_ptt_device_OpusNative_nativeEncode(JNIEnv* env, jclass /*cls*/,
                                                          jshortArray jSamples) {
    if (jSamples == nullptr) return nullptr;
    if (env->GetArrayLength(jSamples) != OPUS_FRAME_SAMPLES) return nullptr;

    int16_t samples[OPUS_FRAME_SAMPLES];
    env->GetShortArrayRegion(jSamples, 0, OPUS_FRAME_SAMPLES,
                             reinterpret_cast<jshort*>(samples));

    uint8_t packet[OPUS_MAX_PACKET_BYTES];

    int packet_len;
    {
        std::lock_guard<std::mutex> lock(gOpusMutex);
        if (!ensureEncoderLocked()) {
            return nullptr;
        }
        packet_len = opus_encode(gEncoder, samples, OPUS_FRAME_SAMPLES,
                                  packet, OPUS_MAX_PACKET_BYTES);
    }
    if (packet_len <= 0) return nullptr;

    jbyteArray out = env->NewByteArray(packet_len);
    if (out == nullptr) return nullptr;
    env->SetByteArrayRegion(out, 0, packet_len,
                            reinterpret_cast<const jbyte*>(packet));
    return out;
}

extern "C" JNIEXPORT jshortArray JNICALL
Java_com_securityradio_ptt_device_OpusNative_nativeDecode(JNIEnv* env, jclass /*cls*/,
                                                          jbyteArray jPacket) {
    if (jPacket == nullptr) return nullptr;
    jsize packet_len = env->GetArrayLength(jPacket);
    if (packet_len <= 0) return nullptr;

    // Stack-allocated bound matches the encoder's OPUS_MAX_PACKET_BYTES.
    // Inbound packets larger than this are dropped — they cannot be valid
    // 20 ms 32 kbps Opus and would indicate either a wire-format mismatch
    // or a malicious peer.
    if (packet_len > OPUS_MAX_PACKET_BYTES) return nullptr;

    uint8_t packet[OPUS_MAX_PACKET_BYTES];
    env->GetByteArrayRegion(jPacket, 0, packet_len,
                            reinterpret_cast<jbyte*>(packet));

    int16_t samples[OPUS_FRAME_SAMPLES];
    int decoded;
    {
        std::lock_guard<std::mutex> lock(gOpusMutex);
        if (!ensureDecoderLocked()) {
            return nullptr;
        }
        decoded = opus_decode(gDecoder, packet, packet_len,
                              samples, OPUS_FRAME_SAMPLES, /*decode_fec=*/0);
    }
    if (decoded != OPUS_FRAME_SAMPLES) return nullptr;

    jshortArray out = env->NewShortArray(OPUS_FRAME_SAMPLES);
    if (out == nullptr) return nullptr;
    env->SetShortArrayRegion(out, 0, OPUS_FRAME_SAMPLES,
                             reinterpret_cast<const jshort*>(samples));
    return out;
}

extern "C" JNIEXPORT jshortArray JNICALL
Java_com_securityradio_ptt_device_OpusNative_nativeDecodeFec(JNIEnv* env, jclass /*cls*/,
                                                             jbyteArray jNextPacket) {
    if (jNextPacket == nullptr) return nullptr;
    jsize packet_len = env->GetArrayLength(jNextPacket);
    if (packet_len <= 0 || packet_len > OPUS_MAX_PACKET_BYTES) return nullptr;

    uint8_t packet[OPUS_MAX_PACKET_BYTES];
    env->GetByteArrayRegion(jNextPacket, 0, packet_len,
                            reinterpret_cast<jbyte*>(packet));

    int16_t samples[OPUS_FRAME_SAMPLES];
    int decoded;
    {
        std::lock_guard<std::mutex> lock(gOpusMutex);
        if (!ensureDecoderLocked()) {
            return nullptr;
        }
        // FEC-decode the *previous* (lost) frame from the LBRR embedded in
        // `packet`. The decoder's internal state stays aligned: after this
        // call, the caller must still nativeDecode(packet) to play the
        // actual current frame.
        decoded = opus_decode(gDecoder, packet, packet_len,
                              samples, OPUS_FRAME_SAMPLES, /*decode_fec=*/1);
    }
    if (decoded != OPUS_FRAME_SAMPLES) return nullptr;

    jshortArray out = env->NewShortArray(OPUS_FRAME_SAMPLES);
    if (out == nullptr) return nullptr;
    env->SetShortArrayRegion(out, 0, OPUS_FRAME_SAMPLES,
                             reinterpret_cast<const jshort*>(samples));
    return out;
}
