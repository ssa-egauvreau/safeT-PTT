package com.securityradio.ptt.device

/**
 * On-wire voice codec identity, mirrored from the server's voiceCodecs.ts so the
 * two ends agree byte-for-byte. Every voice frame the relay forwards starts with
 * the codec's [magic0]/[magic1] pair, which is how receivers route the frame to
 * the right decoder when channels can use different codecs.
 *
 * IMBE keeps its existing 0xF5 0xAB so older clients that predate this enum
 * stay on-wire compatible without any change.
 */
enum class VoiceCodec(
    /** Server-side identifier used in REST + WebSocket control messages. */
    val wireId: String,
    val magic0: Byte,
    val magic1: Byte,
) {
    IMBE("imbe", 0xF5.toByte(), 0xAB.toByte()),
    CODEC2_3200("codec2_3200", 0xC2.toByte(), 0x01.toByte()),
    OPUS("opus", 0x4F.toByte(), 0x70.toByte()),
    AMBE_2450("ambe_2450", 0xA2.toByte(), 0x45.toByte());

    /** Compact badge for channel displays ("IMBE", "C2 3200", "OPUS", "AMBE+2"). */
    val displayLabel: String
        get() = when (this) {
            IMBE -> "IMBE"
            CODEC2_3200 -> "C2 3200"
            OPUS -> "OPUS"
            AMBE_2450 -> "AMBE+2"
        }

    companion object {
        /** Fallback for any control message that omits or mangles the codec. */
        val DEFAULT: VoiceCodec = IMBE

        /** Resolve a codec from the `codec` / `caps` strings the server sends. */
        fun fromWireId(value: String?): VoiceCodec? {
            if (value.isNullOrEmpty()) return null
            return entries.firstOrNull { it.wireId == value }
        }

        /** Resolve a codec from the first two bytes of an inbound voice frame. */
        fun fromMagic(b0: Byte, b1: Byte): VoiceCodec? =
            entries.firstOrNull { it.magic0 == b0 && it.magic1 == b1 }
    }
}
