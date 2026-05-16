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
    }
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
