package com.securityradio.ptt.device

/**
 * JNI bridge to the bundled libopus (BSD-3-Clause; see cpp/opus submodule).
 *
 * Mirrors the shape of [Codec2Native]:
 *  - `tryLoadLibrary` is idempotent and loads `libsecurityradiovocoder.so`
 *    (the same shared object that carries IMBE + Codec2), then calls
 *    `nativeInitEncoder` + `nativeInitDecoder` to allocate the libopus
 *    state. Either failure flips `loadedOk` to false and the registry
 *    falls back to IMBE on TX, same pattern as Codec2.
 *  - `encodeFrame` takes 320 samples of 16 kHz mono PCM-16 and returns
 *    the bare Opus packet (no magic prefix — [OpusEncoder] prepends it).
 *  - `decodeFrame` takes the bare Opus packet and returns 320 samples of
 *    16 kHz mono PCM-16. Single-frame, normal decode.
 *  - `decodeLostFrameFromNext` takes the **next** packet and uses its
 *    in-band FEC (LBRR) payload to reconstruct the previous lost frame.
 *    Caller must follow with a regular [decodeFrame] for that next
 *    packet's actual audio. Single-packet history only — Opus FEC does
 *    not buffer more than one frame back.
 *  - `resetEncoderForTalkSpurt` / `resetDecoderForTalkSpurt` recreate
 *    the encoder/decoder so LPC + pitch state from a prior transmission
 *    does not colour the next one (same pattern as Codec2 and the
 *    server recorder per-spurt decoders).
 *
 * Voice profile (must stay aligned with [OpusVoiceCodec] constants):
 *   sample rate 16 000 Hz · mono · 20 ms frames (320 samples) ·
 *   bitrate 32 kbps · OPUS_APPLICATION_VOIP · OPUS_SIGNAL_VOICE ·
 *   complexity 8 · in-band FEC ON, packet-loss-percent 10 · DTX OFF.
 *
 * The actual constants live inside `opus_jni.cpp` so they apply to every
 * caller (TX + RX go through the same native init); the Kotlin side just
 * passes PCM through.
 */
object OpusNative {

    @Volatile
    private var loadedOk = false

    /** True once libsecurityradiovocoder loaded AND both opus_encoder_create
     *  and opus_decoder_create returned non-null AND every encoder CTL took. */
    val isAvailable: Boolean get() = loadedOk

    /** Attempts to load the JNI shared object and initialise both directions.
     *  Idempotent — returns immediately if already loaded. Returns false on
     *  any failure; the registry falls back to IMBE on TX, and inbound Opus
     *  frames drop with a log instead of being played as garbage. */
    fun tryLoadLibrary(): Boolean {
        if (loadedOk) return true
        return try {
            System.loadLibrary("securityradiovocoder")
            // Encoder failure → cannot TX Opus. Decoder failure → cannot RX
            // Opus. We require both because the registry currently advertises
            // an encoder/decoder pair atomically; a partially-available codec
            // would surprise the relay's TX-codec picker.
            loadedOk = nativeInitEncoder() && nativeInitDecoder()
            loadedOk
        } catch (_: Throwable) {
            loadedOk = false
            false
        }
    }

    /** Encode one 20 ms frame: 320 samples @ 16 kHz mono PCM-16 → bare Opus
     *  packet (variable size, typically 80-160 bytes for the 32 kbps voice
     *  profile; up to 512 bytes per opus_jni.cpp's bound). The caller
     *  ([OpusEncoder.encodeFrame]) prepends the 2-byte wire magic.
     *  Returns null on size mismatch or codec failure. */
    fun encodeFrame(samples16k320: ShortArray): ByteArray? {
        if (!loadedOk || samples16k320.size != 320) return null
        return nativeEncode(samples16k320)
    }

    /** Decode one Opus packet (bare, no magic) → 320 samples @ 16 kHz mono.
     *  Returns null on codec failure or unexpected output length. */
    fun decodeFrame(packet: ByteArray): ShortArray? {
        if (!loadedOk || packet.isEmpty()) return null
        return nativeDecode(packet)
    }

    /** Use the LBRR (Low Bit-Rate Redundancy) payload embedded in `nextPacket`
     *  to reconstruct the *previous* (lost) frame. Returns 320 samples at
     *  16 kHz mono.
     *
     *  Single-frame recovery only: if two or more packets in a row were
     *  lost, only the immediately-prior frame can be recovered this way.
     *  After a successful call, the caller must follow up with a regular
     *  [decodeFrame] for `nextPacket` to play its actual audio.
     *
     *  Receiver-side wiring (jitter-buffer loss detection that triggers
     *  this call) is intentionally out of scope for the PR that introduces
     *  libopus and FEC encoding — it requires either an explicit wire
     *  sequence number (forbidden by the wire-format-stability rule) or
     *  an arrival-time heuristic with false-positive cost analysis. The
     *  hook is exposed here so a follow-up PR can light it up without
     *  retouching the JNI surface. */
    fun decodeLostFrameFromNext(nextPacket: ByteArray): ShortArray? {
        if (!loadedOk || nextPacket.isEmpty()) return null
        return nativeDecodeFec(nextPacket)
    }

    /** Fresh encoder for a new outbound talk-spurt. Drops any prior LPC /
     *  pitch / FEC LBRR state so a previous transmission's tail can't bleed
     *  into the first frame of this one. */
    fun resetEncoderForTalkSpurt() {
        if (!loadedOk) return
        nativeResetEncoder()
    }

    /** Fresh decoder for a new inbound talk-spurt. Mirrors the per-spurt
     *  recreate-decoder pattern Codec2 + the server recorder use. */
    fun resetDecoderForTalkSpurt() {
        if (!loadedOk) return
        nativeResetDecoder()
    }

    @JvmStatic private external fun nativeInitEncoder(): Boolean
    @JvmStatic private external fun nativeInitDecoder(): Boolean
    @JvmStatic private external fun nativeResetEncoder()
    @JvmStatic private external fun nativeResetDecoder()
    @JvmStatic private external fun nativeEncode(samples16k320: ShortArray): ByteArray?
    @JvmStatic private external fun nativeDecode(packet: ByteArray): ShortArray?
    @JvmStatic private external fun nativeDecodeFec(nextPacket: ByteArray): ShortArray?
}
