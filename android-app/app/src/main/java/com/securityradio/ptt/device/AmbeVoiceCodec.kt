package com.securityradio.ptt.device

/**
 * AMBE+2 half-rate encoder + decoder (the P25 Phase 2 / DMR vocoder rate),
 * wrapping [P25AmbeNative] in the [VoiceEncoder] / [VoiceDecoder] interfaces
 * so it slots into [VoiceCodecRegistry] alongside IMBE, Codec2 and Opus.
 * Wire format: 2-byte magic (0xA2 0x45) + 9-byte DMR-interleaved codeword
 * (49 voice bits @ 2450 bps) = 11 bytes total per 20 ms frame.
 *
 * The encoder downsamples the uniform 16 kHz input to 8 kHz internally,
 * reusing [P25ImbeNative.Frames] — the AMBE engine runs at the same 8 kHz /
 * 160-sample cadence as IMBE. The decoder emits 8 kHz samples; the transport
 * layer upsamples + post-processes via the agency's [PostDecodeChain] before
 * playback.
 */

class AmbeEncoder : VoiceEncoder {
    override val codec: VoiceCodec = VoiceCodec.AMBE_2450
    override val isReady: Boolean
        get() = P25AmbeNative.isAvailable || P25AmbeNative.tryLoadLibrary()

    override fun encodeFrame(pcm16kLe640: ByteArray): ByteArray? {
        if (!P25AmbeNative.isAvailable) return null
        if (pcm16kLe640.size < P25ImbeNative.Frames.PCM_16K_FRAME_BYTES) return null
        val ambeIn = P25ImbeNative.Frames.downsampleAvg16kToImbe(pcm16kLe640)
        val codeword = P25AmbeNative.encodeFrame(ambeIn) ?: return null
        val packet = ByteArray(2 + codeword.size)
        packet[0] = codec.magic0
        packet[1] = codec.magic1
        System.arraycopy(codeword, 0, packet, 2, codeword.size)
        return packet
    }
}

class AmbeDecoder : VoiceDecoder {
    override val codec: VoiceCodec = VoiceCodec.AMBE_2450
    override val isReady: Boolean
        get() = P25AmbeNative.isAvailable || P25AmbeNative.tryLoadLibrary()
    override val nativeSampleRate: Int = 8000

    override fun decodeFrame(framedBytes: ByteArray): ShortArray? {
        if (!P25AmbeNative.isAvailable) return null
        if (framedBytes.size != 11) return null
        if (framedBytes[0] != codec.magic0 || framedBytes[1] != codec.magic1) return null
        val codeword = framedBytes.copyOfRange(2, 11)
        return P25AmbeNative.decodeCodeword9(codeword)
    }
}
