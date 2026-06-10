// C bridge around WhackerLink dvmvocoder (GPL-2.0). Shared with Android JNI glue.
// Vocoder sources live under android-app/app/src/main/cpp/dvmvocoder/vocoder.

#include <cstring>
#include <mutex>
#include <new>

#include "MBEDecoder.h"
#include "MBEEncoder.h"

using namespace vocoder;

namespace {

std::mutex gCodecMutex;
MBEEncoder* gEncoder = nullptr;
MBEDecoder* gDecoder = nullptr;

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
    gDecoder->setAutoGain(true);
}

} // namespace

extern "C" {

bool p25_imbe_init(void) {
    std::lock_guard<std::mutex> lock(gCodecMutex);
    delete gEncoder;
    delete gDecoder;
    gEncoder = nullptr;
    gDecoder = nullptr;
    ensureAllocatedLocked();
    return gEncoder != nullptr && gDecoder != nullptr;
}

bool p25_imbe_encode(const int16_t* samples8k160, uint8_t* codeword11_out) {
    if (samples8k160 == nullptr || codeword11_out == nullptr) {
        return false;
    }
    uint8_t codeword[11]{};
    std::lock_guard<std::mutex> lock(gCodecMutex);
    if (gEncoder == nullptr) {
        ensureAllocatedLocked();
    }
    if (gEncoder == nullptr) {
        return false;
    }
    gEncoder->encode(const_cast<int16_t*>(samples8k160), codeword);
    std::memcpy(codeword11_out, codeword, 11);
    return true;
}

bool p25_imbe_decode(const uint8_t* codeword11, int16_t* samples8k160_out) {
    if (codeword11 == nullptr || samples8k160_out == nullptr) {
        return false;
    }
    uint8_t codeword[11]{};
    std::memcpy(codeword, codeword11, 11);
    int16_t samples[160]{};
    std::lock_guard<std::mutex> lock(gCodecMutex);
    if (gDecoder == nullptr) {
        ensureAllocatedLocked();
    }
    if (gDecoder == nullptr) {
        return false;
    }
    gDecoder->decode(codeword, samples);
    std::memcpy(samples8k160_out, samples, sizeof(samples));
    return true;
}

} // extern "C"

// --- AMBE+2 half-rate (P25 Phase 2 / DMR vocoder rate) ----------------------
// Same shape as the IMBE bridge above, on dvmvocoder's DMR_AMBE mode:
// 160 PCM samples (8 kHz, 20 ms) <-> 9-byte DMR-interleaved codeword carrying
// 49 voice bits @ 2450 bps. Separate encoder/decoder instances — both MBE
// vocoders keep frame-to-frame history.

namespace {

std::mutex gAmbeCodecMutex;
MBEEncoder* gAmbeEncoder = nullptr;
MBEDecoder* gAmbeDecoder = nullptr;

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
    gAmbeDecoder->setAutoGain(true);
}

} // namespace

extern "C" {

bool p25_ambe_init(void) {
    std::lock_guard<std::mutex> lock(gAmbeCodecMutex);
    delete gAmbeEncoder;
    delete gAmbeDecoder;
    gAmbeEncoder = nullptr;
    gAmbeDecoder = nullptr;
    ensureAmbeAllocatedLocked();
    return gAmbeEncoder != nullptr && gAmbeDecoder != nullptr;
}

bool p25_ambe_encode(const int16_t* samples8k160, uint8_t* codeword9_out) {
    if (samples8k160 == nullptr || codeword9_out == nullptr) {
        return false;
    }
    uint8_t codeword[9]{};
    std::lock_guard<std::mutex> lock(gAmbeCodecMutex);
    if (gAmbeEncoder == nullptr) {
        ensureAmbeAllocatedLocked();
    }
    if (gAmbeEncoder == nullptr) {
        return false;
    }
    gAmbeEncoder->encode(const_cast<int16_t*>(samples8k160), codeword);
    std::memcpy(codeword9_out, codeword, 9);
    return true;
}

bool p25_ambe_decode(const uint8_t* codeword9, int16_t* samples8k160_out) {
    if (codeword9 == nullptr || samples8k160_out == nullptr) {
        return false;
    }
    uint8_t codeword[9]{};
    std::memcpy(codeword, codeword9, 9);
    int16_t samples[160]{};
    std::lock_guard<std::mutex> lock(gAmbeCodecMutex);
    if (gAmbeDecoder == nullptr) {
        ensureAmbeAllocatedLocked();
    }
    if (gAmbeDecoder == nullptr) {
        return false;
    }
    gAmbeDecoder->decode(codeword, samples);
    std::memcpy(samples8k160_out, samples, sizeof(samples));
    return true;
}

} // extern "C"
