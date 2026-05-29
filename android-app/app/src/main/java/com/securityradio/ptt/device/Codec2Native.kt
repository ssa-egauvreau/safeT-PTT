package com.securityradio.ptt.device

/**
 * JNI bridge to the bundled libcodec2 (LGPL-2.1; see cpp/codec2 submodule).
 *
 * Mirrors the shape of [P25ImbeNative]:
 *  - `nativeInit` allocates a singleton encoder + decoder for
 *    `CODEC2_MODE_3200` (3200 bps, 20 ms frames, 160 samples per frame
 *    at 8 kHz, 8 bytes per encoded codeword).
 *  - `encodeFrame` / `decodeCodeword8` wrap JNI with size checks. Call
 *    `resetEncoderForTalkSpurt` / `resetDecoderForTalkSpurt` at talk-spurt
 *    boundaries so LPC state from a prior transmission does not color the
 *    next one (same pattern as Opus flush and the server recorder).
 *
 * The shared object is the same `libsecurityradiovocoder.so` that
 * carries IMBE — see app/src/main/cpp/CMakeLists.txt.
 */
object Codec2Native {

    @Volatile
    private var loadedOk = false

    /** True once libsecurityradiovocoder loaded AND codec2_create returned a state. */
    val isAvailable: Boolean get() = loadedOk

    /** Attempts to load the JNI shared object and initialise the codec.
     *  Idempotent — returns immediately if already loaded. Returns false
     *  when either the .so is missing (HAVE_CODEC2 was off at build
     *  time) or codec2_create fails; the registry falls back to IMBE on
     *  TX in either case. */
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

    /** Encode one 20 ms frame: 160 samples @ 8 kHz → 8-byte codeword.
     *  Returns null on size mismatch or codec failure. */
    fun encodeFrame(samples8k160: ShortArray): ByteArray? {
        if (!loadedOk || samples8k160.size != 160) return null
        return nativeEncode(samples8k160)
    }

    /** Decode an 8-byte codeword → 160 samples @ 8 kHz.
     *  Returns null on size mismatch or codec failure. */
    fun decodeCodeword8(codeword8: ByteArray): ShortArray? {
        if (!loadedOk || codeword8.size != 8) return null
        return nativeDecode(codeword8)
    }

    /** Fresh LPC/pitch state for a new talk-spurt (TX). */
    fun resetEncoderForTalkSpurt() {
        if (!loadedOk) return
        nativeResetEncoder()
    }

    /** Fresh LPC/pitch state for a new inbound talk-spurt (RX). */
    fun resetDecoderForTalkSpurt() {
        if (!loadedOk) return
        nativeResetDecoder()
    }

    @JvmStatic private external fun nativeInit(): Boolean
    @JvmStatic private external fun nativeEncode(samples8k160: ShortArray): ByteArray?
    @JvmStatic private external fun nativeDecode(codeword8: ByteArray): ShortArray?
    @JvmStatic private external fun nativeResetEncoder()
    @JvmStatic private external fun nativeResetDecoder()
}
