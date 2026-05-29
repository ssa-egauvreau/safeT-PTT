package com.securityradio.ptt.device

/**
 * Codec2 3200 bps encoder + decoder, wrapping [Codec2Native] (libcodec2
 * via JNI) in the [VoiceEncoder] / [VoiceDecoder] interfaces so it slots
 * into [VoiceCodecRegistry] alongside IMBE and Opus.
 *
 * Mode 3200 was picked over the lower-bitrate Codec2 modes because:
 *  - 20 ms frames (160 samples @ 8 kHz) match IMBE's cadence, so the
 *    transport's existing 20 ms PCM accumulator works unchanged.
 *  - 3200 bps sounds substantially better than 2400 bps for speech
 *    while still preserving the "digital trunked radio" character
 *    operators expect (close to AMBE+2 full-rate by ear).
 *
 * Wire format: 2-byte magic (0xC2 0x01) + 8-byte codec2 codeword =
 * 10 bytes per 20 ms frame. Slightly smaller on the wire than IMBE
 * (13 bytes per 20 ms frame), so per-talker bandwidth drops by ~23 %.
 *
 * Both encode and decode operate at 8 kHz; the transport's existing
 * [PostDecodeChain] handles the 8 kHz → 16 kHz upsample (or the legacy
 * sample-duplicate fast path), and the encoder consumes 16 kHz capture
 * via the same `downsampleAvg16kToImbe` path IMBE uses.
 *
 * Falls back to IMBE on TX (via the registry) if `libsecurityradiovocoder`
 * fails to load codec2 — e.g. the submodule wasn't initialised at build
 * time, or codec2_create returned null. RX behavior mirrors: inbound
 * Codec2 frames drop with a one-shot log instead of being played as
 * garbage at the speaker.
 */

class Codec2Encoder : VoiceEncoder {
    override val codec: VoiceCodec = VoiceCodec.CODEC2_3200

    override val isReady: Boolean
        get() = Codec2Native.isAvailable || Codec2Native.tryLoadLibrary()

    override fun encodeFrame(pcm16kLe640: ByteArray): ByteArray? {
        if (!isReady) return null
        if (pcm16kLe640.size < P25ImbeNative.Frames.PCM_16K_FRAME_BYTES) return null
        // Same 16 → 8 kHz path IMBE uses; mode 3200 also runs at 8 kHz.
        val pcm8k160 = P25ImbeNative.Frames.downsampleAvg16kToImbe(pcm16kLe640)
        val codeword = Codec2Native.encodeFrame(pcm8k160) ?: return null
        val packet = ByteArray(2 + codeword.size)
        packet[0] = codec.magic0
        packet[1] = codec.magic1
        System.arraycopy(codeword, 0, packet, 2, codeword.size)
        return packet
    }

    override fun resetForTalkSpurt() {
        Codec2Native.resetEncoderForTalkSpurt()
    }
}

class Codec2Decoder : VoiceDecoder {
    override val codec: VoiceCodec = VoiceCodec.CODEC2_3200
    override val nativeSampleRate: Int = 8000

    override val isReady: Boolean
        get() = Codec2Native.isAvailable || Codec2Native.tryLoadLibrary()

    override fun decodeFrame(framedBytes: ByteArray): ShortArray? {
        if (!isReady) return null
        // Magic (2 bytes) + codec2_3200 codeword (8 bytes) = 10 bytes.
        if (framedBytes.size != 10) return null
        if (framedBytes[0] != codec.magic0 || framedBytes[1] != codec.magic1) return null
        val codeword = framedBytes.copyOfRange(2, 10)
        return Codec2Native.decodeCodeword8(codeword)
    }

    override fun resetForTalkSpurt() {
        Codec2Native.resetDecoderForTalkSpurt()
    }
}
