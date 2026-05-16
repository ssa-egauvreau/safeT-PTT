package com.securityradio.ptt.device

import java.nio.ByteOrder

/** JNI bridge to bundled dvmvocoder (GPL-2.0; see cpp/dvmvocoder/README.txt). */
object P25ImbeNative {

    @Volatile
    private var loadedOk = false

    /** True once [securityradiovocoder] JNI lib loaded and codecs allocated. */
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

    /** PCM @ 8 kHz, **exactly** 160 samples → 88-bit IMBE (11-byte codeword). */
    fun encodeFrame(samples8k160: ShortArray): ByteArray? {
        if (!loadedOk || samples8k160.size != 160) return null
        return nativeEncode(samples8k160)
    }

    fun decodeCodeword11(codeword11: ByteArray): ShortArray? {
        if (!loadedOk || codeword11.size != 11) return null
        return nativeDecode(codeword11)
    }

    @JvmStatic private external fun nativeInit(): Boolean
    @JvmStatic private external fun nativeEncode(samples8k160: ShortArray): ByteArray?
    @JvmStatic private external fun nativeDecode(codeword11: ByteArray): ShortArray?

    /** Framing helpers: 16 kHz capture ↔ 8 kHz IMBE engine. */
    object Frames {
        const val PCM_16K_FRAME_BYTES = 640
        private const val RATIO = 2

        private fun ByteArray.leShortAt(offset: Int): Short {
            val lo = this[offset].toInt() and 0xff
            val hi = this[offset + 1].toInt()
            val v = lo or (hi shl 8)
            return v.toShort()
        }

        /** Average pairs of 16 kHz samples → 160 samples for [encodeFrame]. */
        fun downsampleAvg16kToImbe(frame16kLittleEndian: ByteArray): ShortArray {
            require(frame16kLittleEndian.size >= PCM_16K_FRAME_BYTES)
            val out = ShortArray(160)
            for (i in 0 until 160) {
                val off = i * 2 * RATIO
                val a = frame16kLittleEndian.leShortAt(off).toLong()
                val b = frame16kLittleEndian.leShortAt(off + 2).toLong()
                out[i] = ((a + b) / RATIO).toInt().toShort()
            }
            return out
        }

        /** Duplicate each nominal 8 kHz sample → 16 kHz LE mono for playback. */
        fun upsampleDup8kToLe16Mono(pcm8k160: ShortArray): ByteArray {
            val out = ByteArray(320 * 2)
            val bb = java.nio.ByteBuffer.wrap(out).order(ByteOrder.LITTLE_ENDIAN)
            for (s in pcm8k160) {
                bb.putShort(s)
                bb.putShort(s)
            }
            return out
        }
    }
}
