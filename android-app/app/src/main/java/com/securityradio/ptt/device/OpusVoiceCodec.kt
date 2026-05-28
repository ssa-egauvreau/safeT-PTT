package com.securityradio.ptt.device

/**
 * Opus encoder + decoder — placeholder.
 *
 * Reports [isReady] = false until a real Opus codec lib lands. The
 * registry falls back to IMBE on TX while Opus is unavailable, and
 * inbound Opus frames drop with a log instead of being played as
 * garbage at the speaker. iOS and web ship a working Opus encoder +
 * decoder in this PR; Android Opus is staged behind one of these
 * vendoring choices:
 *
 *  - Concentus (pure-Java Opus port) — single jar, no NDK. Best fast
 *    path. Add via JitPack with a verified ref (a previous attempt at
 *    `com.github.lostromb:concentus:1.0.2` failed to resolve on the
 *    Android PR CI; pin to a real commit/tag from
 *    https://github.com/lostromb/concentus before re-enabling).
 *
 *  - libopus via NDK — lowest CPU, matches the dvmvocoder build
 *    pattern. Vendor the C source under
 *    `android-app/app/src/main/cpp/opus/` and wire it through the
 *    existing CMake setup; add a JNI bridge mirroring P25ImbeNative.
 *
 * Voice profile to use when this is wired up:
 *  - sample rate: 16 000 Hz (matches existing 16 kHz uplink/downlink)
 *  - channels: 1 (mono)
 *  - frame size: 20 ms (320 samples) — matches the relay's 20 ms cadence
 *  - bitrate: 16-24 kbps
 *  - application: VOIP
 *  - FEC + DTX: enabled for resilience to single-frame loss
 *
 * Wire format: 2-byte magic (0x4F 0x70) + opaque Opus packet. Packet
 * size varies per frame (DTX, complexity), so receivers identify the
 * codec by magic, not by length.
 */

class OpusEncoder : VoiceEncoder {
    override val codec: VoiceCodec = VoiceCodec.OPUS
    override val isReady: Boolean get() = false

    override fun encodeFrame(pcm16kLe640: ByteArray): ByteArray? = null
}

class OpusDecoder : VoiceDecoder {
    override val codec: VoiceCodec = VoiceCodec.OPUS
    override val isReady: Boolean get() = false
    override val nativeSampleRate: Int = 16000

    override fun decodeFrame(framedBytes: ByteArray): ShortArray? = null
}
