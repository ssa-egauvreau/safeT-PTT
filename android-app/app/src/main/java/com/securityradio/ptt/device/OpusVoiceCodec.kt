package com.securityradio.ptt.device

import android.util.Log

/**
 * Opus encoder + decoder backed by the bundled libopus (BSD-3-Clause; see
 * cpp/opus submodule pinned to v1.5.2) via [OpusNative]. This replaces
 * the previous `MediaCodec("audio/opus")` path so we can configure the
 * encoder for **in-band FEC** (`OPUS_SET_INBAND_FEC = 1`) and the
 * **packet-loss-percentage hint** (`OPUS_SET_PACKET_LOSS_PERC = 10`) —
 * the proper fix for the field-reported "voice cuts out and gets
 * robotic on lossy links" complaint that PR #217 worked around by
 * enlarging the jitter buffer and bumping the bitrate to 32 kbps.
 *
 * The system MediaCodec Opus path exposed bitrate as its only knob.
 * libopus gives us the full encoder configuration surface plus the
 * `opus_decode(..., fec=1)` LBRR-recovery API.
 *
 * Voice profile (matches iOS libopus and web WASM libopus paths):
 *  - sample rate: 16 000 Hz
 *  - channels: 1 (mono)
 *  - frame size: 20 ms (320 samples)
 *  - bitrate: 32 kbps
 *  - application: OPUS_APPLICATION_VOIP
 *  - signal hint: OPUS_SIGNAL_VOICE
 *  - in-band FEC: ON (10 % packet-loss budget)
 *  - DTX: OFF (would suppress LBRR-carrying packets)
 *  - complexity: 8 (good quality, low CPU for rugged handsets)
 *
 * Actual CTL values live inside `opus_jni.cpp` so encoder + decoder
 * stay aligned with iOS + web by sharing one C-level definition.
 *
 * Wire format: 2-byte magic (0x4F 0x70) + opaque Opus packet.
 * **Unchanged** versus the MediaCodec path. RFC 6716 defines a single
 * on-wire packet format for all Opus implementations, so old peers
 * still on MediaCodec / AVAudioConverter / WebCodecs decode our libopus
 * frames identically — and we decode theirs. The on-wire LBRR data is
 * transparent to receivers that aren't FEC-aware.
 *
 * Falls back to IMBE on TX (via the registry) if libopus failed to load
 * — e.g. the submodule wasn't initialised at build time, or
 * opus_encoder_create returned an error. Inbound Opus frames drop with
 * a one-shot log on a not-ready decoder, same pattern as Codec2.
 */

private const val TAG = "OpusVoiceCodec"
private const val FRAME_SAMPLES = 320            // 20 ms @ 16 kHz
private const val FRAME_BYTES = FRAME_SAMPLES * 2 // PCM-16

class OpusEncoder : VoiceEncoder {
    override val codec: VoiceCodec = VoiceCodec.OPUS

    override val isReady: Boolean
        get() = OpusNative.isAvailable || OpusNative.tryLoadLibrary()

    override fun resetForTalkSpurt() {
        OpusNative.resetEncoderForTalkSpurt()
    }

    override fun encodeFrame(pcm16kLe640: ByteArray): ByteArray? {
        if (!isReady) return null
        if (pcm16kLe640.size != FRAME_BYTES) return null

        // PCM-16 LE → ShortArray for the JNI boundary. We always receive a
        // 640-byte LE buffer from the capture worklet, so a straight cast
        // would be a byte-order mismatch on big-endian; build the ShortArray
        // explicitly so the wire format stays endian-stable.
        //
        // Both bytes are masked to 0xFF before assembly because Kotlin
        // `Byte.toInt()` sign-extends — `0xAB.toByte().toInt() == -85`,
        // which would smear high bits into the upper word.
        val samples = ShortArray(FRAME_SAMPLES)
        var i = 0
        var off = 0
        while (i < FRAME_SAMPLES) {
            val lo = pcm16kLe640[off].toInt() and 0xFF
            val hi = pcm16kLe640[off + 1].toInt() and 0xFF
            samples[i] = ((hi shl 8) or lo).toShort()
            off += 2
            i++
        }

        val opusBytes = OpusNative.encodeFrame(samples) ?: return null
        if (opusBytes.isEmpty()) {
            Log.w(TAG, "libopus encode returned empty packet — dropping frame")
            return null
        }

        // Prepend the 2-byte wire magic. Same layout as the legacy MediaCodec
        // path so receivers identifying by magic continue to dispatch this
        // frame to their Opus decoder unchanged.
        val packet = ByteArray(2 + opusBytes.size)
        packet[0] = codec.magic0
        packet[1] = codec.magic1
        System.arraycopy(opusBytes, 0, packet, 2, opusBytes.size)
        return packet
    }
}

class OpusDecoder : VoiceDecoder {
    override val codec: VoiceCodec = VoiceCodec.OPUS
    override val nativeSampleRate: Int = 16_000

    override val isReady: Boolean
        get() = OpusNative.isAvailable || OpusNative.tryLoadLibrary()

    override fun resetForTalkSpurt() {
        OpusNative.resetDecoderForTalkSpurt()
    }

    override fun decodeFrame(framedBytes: ByteArray): ShortArray? {
        if (!isReady) return null
        if (framedBytes.size < 3) return null
        if (framedBytes[0] != codec.magic0 || framedBytes[1] != codec.magic1) return null

        // Strip the 2-byte magic and hand the bare Opus packet to libopus.
        val payload = framedBytes.copyOfRange(2, framedBytes.size)
        return OpusNative.decodeFrame(payload)
    }

    /** Reconstruct the previous (lost) frame from the LBRR data embedded
     *  in `nextFramedBytes`. Returns 320 samples of 16 kHz mono PCM-16,
     *  or null if FEC was unavailable on the prior packet (e.g. the
     *  sender never enabled in-band FEC) or the call failed.
     *
     *  This is exposed for the receiver-side jitter buffer to wire up
     *  in a follow-up change once we have a reliable loss-detection
     *  signal. The encoder side is enabled today so the LBRR data is
     *  already on the wire for any FEC-aware peer to recover. */
    fun decodeLostFrameFromNext(nextFramedBytes: ByteArray): ShortArray? {
        if (!isReady) return null
        if (nextFramedBytes.size < 3) return null
        if (nextFramedBytes[0] != codec.magic0 || nextFramedBytes[1] != codec.magic1) return null
        val payload = nextFramedBytes.copyOfRange(2, nextFramedBytes.size)
        return OpusNative.decodeLostFrameFromNext(payload)
    }
}
