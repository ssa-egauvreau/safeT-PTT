package com.securityradio.ptt.device

import android.media.AudioFormat

/** Shared PCM format for uplink/downlink (mono 16 kHz PCM16). */
object VoiceAudioSpecs {
    const val SAMPLE_RATE_HZ = 16_000
    val PCM_ENCODING: Int = AudioFormat.ENCODING_PCM_16BIT

    /**
     * Legacy [AudioTrack] stream type before [AudioTrack.Builder] (API 23+): same value as Android’s
     * voice communication stream (`AudioManager.STREAM_VOICE_COMMUNICATION`, i.e. 11). Stored as `Int`
     * because newer platform stubs sometimes omit the `AudioManager` constant for Kotlin callers.
     */
    const val LEGACY_STREAM_VOICE_COMMUNICATION: Int = 11
}
