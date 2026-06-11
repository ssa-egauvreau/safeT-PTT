// JNI bridge around WhackerLink dvmvocoder (GPL-2.0). See cpp/dvmvocoder/README.txt
#include <mutex>
#include <new>

#include <jni.h>

#include "MBEDecoder.h"
#include "MBEEncoder.h"

using namespace vocoder;

namespace {

std::mutex gCodecMutex;

MBEEncoder* gEncoder = nullptr;
MBEDecoder* gDecoder = nullptr;

/** Allocate encoder / decoder instances (caller holds gCodecMutex). */
void ensureAllocatedLocked() {
    if (gEncoder != nullptr && gDecoder != nullptr) {
        return;
    }

    delete gEncoder;
    delete gDecoder;
    gEncoder = nullptr;
    gDecoder = nullptr;

    gEncoder = new (std::nothrow) MBEEncoder(ENCODE_88BIT_IMBE);
    if (gEncoder == nullptr) {
        return;
    }
    gEncoder->setGainAdjust(1.0f);

    gDecoder = new (std::nothrow) MBEDecoder(DECODE_88BIT_IMBE);
    if (gDecoder == nullptr) {
        delete gEncoder;
        gEncoder = nullptr;
        return;
    }
    // Enable the vocoder's built-in receive AGC. Without it, decoded IMBE
    // audio plays at the raw vocoder level (much quieter than uncompressed
    // PCM). The library otherwise leaves m_autoGain uninitialised.
    gDecoder->setAutoGain(true);
}

} // namespace

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM*, void*) { return JNI_VERSION_1_6; }

extern "C" JNIEXPORT jboolean JNICALL
Java_com_securityradio_ptt_device_P25ImbeNative_nativeInit(JNIEnv* /*env*/, jclass /*cls*/) {
    std::lock_guard<std::mutex> lock(gCodecMutex);
    delete gEncoder;
    delete gDecoder;
    gEncoder = nullptr;
    gDecoder = nullptr;
    ensureAllocatedLocked();
    return gEncoder != nullptr && gDecoder != nullptr ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT jbyteArray JNICALL Java_com_securityradio_ptt_device_P25ImbeNative_nativeEncode(JNIEnv* env,
                                                                                                   jclass /*cls*/,
                                                                                                   jshortArray jSamples8k160) {
    if (jSamples8k160 == nullptr) return nullptr;
    const jsize n = env->GetArrayLength(jSamples8k160);
    if (n != 160) return nullptr;

    int16_t samples[160];
    env->GetShortArrayRegion(jSamples8k160, 0, 160, reinterpret_cast<jshort*>(samples));

    uint8_t codeword[11]{};

    std::lock_guard<std::mutex> lock(gCodecMutex);
    if (gEncoder == nullptr) {
        ensureAllocatedLocked();
    }
    if (gEncoder == nullptr) return nullptr;

    gEncoder->encode(samples, codeword);

    jbyteArray out = env->NewByteArray(11);
    if (out == nullptr) return nullptr;
    env->SetByteArrayRegion(out, 0, 11, reinterpret_cast<const jbyte*>(codeword));
    return out;
}

extern "C" JNIEXPORT jshortArray JNICALL Java_com_securityradio_ptt_device_P25ImbeNative_nativeDecode(JNIEnv* env,
                                                                                                      jclass /*cls*/,
                                                                                                      jbyteArray jCodeword) {
    if (jCodeword == nullptr) return nullptr;
    if (env->GetArrayLength(jCodeword) != 11) return nullptr;

    uint8_t codeword[11]{};
    env->GetByteArrayRegion(jCodeword, 0, 11, reinterpret_cast<jbyte*>(codeword));

    int16_t samples[160];

    std::lock_guard<std::mutex> lock(gCodecMutex);
    if (gDecoder == nullptr) {
        ensureAllocatedLocked();
    }
    if (gDecoder == nullptr) return nullptr;

    gDecoder->decode(codeword, samples);

    jshortArray out = env->NewShortArray(160);
    if (out == nullptr) return nullptr;
    env->SetShortArrayRegion(out, 0, 160, reinterpret_cast<const jshort*>(samples));
    return out;
}

// --- AMBE+2 half-rate (P25 Phase 2 / DMR vocoder rate) ----------------------
// Same shape as the IMBE bridge above, on dvmvocoder's DMR_AMBE mode:
// 160 PCM samples (8 kHz, 20 ms) <-> 9-byte DMR-interleaved codeword carrying
// 49 voice bits @ 2450 bps. Separate encoder/decoder instances — both MBE
// vocoders keep frame-to-frame history.

namespace {

std::mutex gAmbeCodecMutex;

MBEEncoder* gAmbeEncoder = nullptr;
MBEDecoder* gAmbeDecoder = nullptr;

/** Allocate AMBE encoder / decoder instances (caller holds gAmbeCodecMutex). */
void ensureAmbeAllocatedLocked() {
    if (gAmbeEncoder != nullptr && gAmbeDecoder != nullptr) {
        return;
    }

    delete gAmbeEncoder;
    delete gAmbeDecoder;
    gAmbeEncoder = nullptr;
    gAmbeDecoder = nullptr;

    gAmbeEncoder = new (std::nothrow) MBEEncoder(ENCODE_DMR_AMBE);
    if (gAmbeEncoder == nullptr) {
        return;
    }
    gAmbeEncoder->setGainAdjust(1.0f);

    gAmbeDecoder = new (std::nothrow) MBEDecoder(DECODE_DMR_AMBE);
    if (gAmbeDecoder == nullptr) {
        delete gAmbeEncoder;
        gAmbeEncoder = nullptr;
        return;
    }
    // Same receive-AGC rationale as the IMBE decoder above.
    gAmbeDecoder->setAutoGain(true);
}

} // namespace

extern "C" JNIEXPORT jboolean JNICALL
Java_com_securityradio_ptt_device_P25AmbeNative_nativeInit(JNIEnv* /*env*/, jclass /*cls*/) {
    std::lock_guard<std::mutex> lock(gAmbeCodecMutex);
    delete gAmbeEncoder;
    delete gAmbeDecoder;
    gAmbeEncoder = nullptr;
    gAmbeDecoder = nullptr;
    ensureAmbeAllocatedLocked();
    return gAmbeEncoder != nullptr && gAmbeDecoder != nullptr ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT jbyteArray JNICALL Java_com_securityradio_ptt_device_P25AmbeNative_nativeEncode(JNIEnv* env,
                                                                                                     jclass /*cls*/,
                                                                                                     jshortArray jSamples8k160) {
    if (jSamples8k160 == nullptr) return nullptr;
    const jsize n = env->GetArrayLength(jSamples8k160);
    if (n != 160) return nullptr;

    int16_t samples[160];
    env->GetShortArrayRegion(jSamples8k160, 0, 160, reinterpret_cast<jshort*>(samples));

    uint8_t codeword[9]{};

    std::lock_guard<std::mutex> lock(gAmbeCodecMutex);
    if (gAmbeEncoder == nullptr) {
        ensureAmbeAllocatedLocked();
    }
    if (gAmbeEncoder == nullptr) return nullptr;

    gAmbeEncoder->encode(samples, codeword);

    jbyteArray out = env->NewByteArray(9);
    if (out == nullptr) return nullptr;
    env->SetByteArrayRegion(out, 0, 9, reinterpret_cast<const jbyte*>(codeword));
    return out;
}

extern "C" JNIEXPORT jshortArray JNICALL Java_com_securityradio_ptt_device_P25AmbeNative_nativeDecode(JNIEnv* env,
                                                                                                      jclass /*cls*/,
                                                                                                      jbyteArray jCodeword) {
    if (jCodeword == nullptr) return nullptr;
    if (env->GetArrayLength(jCodeword) != 9) return nullptr;

    uint8_t codeword[9]{};
    env->GetByteArrayRegion(jCodeword, 0, 9, reinterpret_cast<jbyte*>(codeword));

    int16_t samples[160];

    std::lock_guard<std::mutex> lock(gAmbeCodecMutex);
    if (gAmbeDecoder == nullptr) {
        ensureAmbeAllocatedLocked();
    }
    if (gAmbeDecoder == nullptr) return nullptr;

    gAmbeDecoder->decode(codeword, samples);

    jshortArray out = env->NewShortArray(160);
    if (out == nullptr) return nullptr;
    env->SetShortArrayRegion(out, 0, 160, reinterpret_cast<const jshort*>(samples));
    return out;
}
