package com.securityradio.ptt.device

/**
 * Per-codec uplink encoder. Implementations take a uniform 20 ms frame of
 * capture-rate PCM (16 kHz mono PCM-16 little-endian = 640 bytes) and return
 * the WebSocket payload for that frame — codec magic bytes followed by the
 * codec's own packet — ready to ship.
 *
 * The encoder is opaque to whatever the codec does internally: IMBE and
 * Codec2 downsample to 8 kHz first, Opus stays at 16 kHz. Callers always
 * pass the same uniform input.
 */
interface VoiceEncoder {
    val codec: VoiceCodec

    /** True when the underlying codec library is loaded and usable. A codec
     *  whose native lib failed to load reports false so the registry can
     *  fall back to IMBE on TX without throwing. */
    val isReady: Boolean

    /**
     * Encode one 20 ms frame of 16 kHz mono PCM-16 LE (640 bytes / 320 samples).
     * Returns the framed WebSocket payload (magic bytes prepended), or null if
     * the encoder is not ready or the input is malformed.
     */
    fun encodeFrame(pcm16kLe640: ByteArray): ByteArray?

    /** Reset internal state at the start of a new talk-spurt. Default no-op
     *  for codecs that hold no per-spurt state. */
    fun resetForTalkSpurt() {}
}

/**
 * Per-codec downlink decoder. Implementations take an inbound WebSocket
 * payload (the codec's magic bytes followed by its packet) and return
 * decoded samples at the codec's native sample rate; the transport layer
 * then upsamples / post-processes to the playback rate.
 *
 * Returning [nativeSampleRate] lets the caller decide whether to apply
 * the existing 8-kHz post-decode chain (HPF / EQ / polyphase upsample)
 * or pass 16-kHz output through unmodified.
 */
interface VoiceDecoder {
    val codec: VoiceCodec
    val isReady: Boolean

    /** Sample rate of [decodeFrame]'s output. IMBE / Codec2 = 8000, Opus = 16000. */
    val nativeSampleRate: Int

    /**
     * Decode one framed inbound voice payload. Returns native-rate mono
     * samples, or null if the frame is malformed or the codec is not ready.
     */
    fun decodeFrame(framedBytes: ByteArray): ShortArray?

    /** Reset decoder state at an inbound talk-spurt boundary (Opus overrides). */
    fun resetForTalkSpurt() {}
}
