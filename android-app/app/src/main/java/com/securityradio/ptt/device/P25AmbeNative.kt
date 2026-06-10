package com.securityradio.ptt.device

/**
 * JNI bridge to the bundled dvmvocoder's AMBE+2 half-rate mode (GPL-2.0; see
 * cpp/dvmvocoder/README.txt) — the P25 Phase 2 / DMR vocoder rate: 49 voice
 * bits @ 2450 bps in a 9-byte DMR-interleaved codeword per 20 ms frame.
 *
 * Shares `libsecurityradiovocoder.so` with [P25ImbeNative]; the 16 kHz ↔ 8 kHz
 * framing helpers live there too ([P25ImbeNative.Frames]).
 */
object P25AmbeNative {

    @Volatile
    private var loadedOk = false

    /** True once the JNI lib loaded and the AMBE codec pair allocated. */
    val isAvailable: Boolean get() = loadedOk

    fun tryLoadLibrary(): Boolean {
        if (loadedOk) return true
        return try {
            System.loadLibrary("securityradiovocoder")
            loadedOk = nativeInit()
            loadedOk
        } catch (_: Throwable) {
            loadedOk = false
            false
        }
    }

    /** PCM @ 8 kHz, **exactly** 160 samples → 9-byte AMBE codeword. */
    fun encodeFrame(samples8k160: ShortArray): ByteArray? {
        if (!loadedOk || samples8k160.size != 160) return null
        return nativeEncode(samples8k160)
    }

    fun decodeCodeword9(codeword9: ByteArray): ShortArray? {
        if (!loadedOk || codeword9.size != 9) return null
        return nativeDecode(codeword9)
    }

    @JvmStatic private external fun nativeInit(): Boolean
    @JvmStatic private external fun nativeEncode(samples8k160: ShortArray): ByteArray?
    @JvmStatic private external fun nativeDecode(codeword9: ByteArray): ShortArray?
}
