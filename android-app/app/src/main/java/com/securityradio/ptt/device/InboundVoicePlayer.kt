package com.securityradio.ptt.device

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Build

/**
 * Plays PCM16 mono 16 kHz streamed from peers through the relay.
 */
class InboundVoicePlayer {

    private val lock = Any()
    private var track: AudioTrack? = null
    @Volatile
    private var released: Boolean = false

    fun writePcm(chunk: ByteArray) {
        if (released || chunk.isEmpty()) return
        synchronized(lock) {
            if (released) return
            var t = track
            if (t == null) {
                t = createTrack() ?: return
                track = t
            }
            t.write(chunk, 0, chunk.size)
        }
    }

    private fun createTrack(): AudioTrack? {
        val minBuf = AudioTrack.getMinBufferSize(
            VoiceAudioSpecs.SAMPLE_RATE_HZ,
            AudioFormat.CHANNEL_OUT_MONO,
            VoiceAudioSpecs.PCM_ENCODING,
        )
        if (minBuf <= 0) return null
        /** Extra slack reduces underruns on handset speaker routing with bursty decode output. */
        val bufBytes = maxOf(minBuf * 4, minBuf + 8192)
        val t =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                AudioTrack.Builder()
                    .setAudioAttributes(
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build(),
                    )
                    .setAudioFormat(
                        AudioFormat.Builder()
                            .setSampleRate(VoiceAudioSpecs.SAMPLE_RATE_HZ)
                            .setEncoding(VoiceAudioSpecs.PCM_ENCODING)
                            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                            .build(),
                    )
                    .setBufferSizeInBytes(bufBytes)
                    .setTransferMode(AudioTrack.MODE_STREAM)
                    .build()
            } else {
                @Suppress("DEPRECATION")
                AudioTrack(
                    VoiceAudioSpecs.LEGACY_STREAM_VOICE_COMMUNICATION,
                    VoiceAudioSpecs.SAMPLE_RATE_HZ,
                    AudioFormat.CHANNEL_OUT_MONO,
                    VoiceAudioSpecs.PCM_ENCODING,
                    bufBytes,
                    AudioTrack.MODE_STREAM,
                )
            }
        if (t.state != AudioTrack.STATE_INITIALIZED) {
            t.release()
            return null
        }
        t.play()
        return t
    }

    fun stop() {
        synchronized(lock) {
            track?.run {
                try {
                    if (playState == AudioTrack.PLAYSTATE_PLAYING) {
                        pause()
                        flush()
                    }
                } catch (_: Exception) {
                }
                release()
            }
            track = null
        }
    }

    /** Permanently stop playback; instance must not be used after release. */
    fun release() {
        released = true
        stop()
    }
}
