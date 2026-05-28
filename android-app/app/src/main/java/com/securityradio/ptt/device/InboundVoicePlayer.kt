package com.securityradio.ptt.device

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Build
import android.os.SystemClock

/**
 * Plays PCM16 mono 16 kHz streamed from peers through the relay.
 *
 * Home-channel RX takes priority over scan listen sockets so two WebSockets
 * cannot interleave samples into one [AudioTrack] (which causes harsh clipping).
 *
 * Inbound PCM is handed to an [InboundJitterBuffer] rather than written
 * directly to AudioTrack so that bursty arrival (the relay forwards frames
 * the instant they arrive over WebSocket, with no smoothing) is paced out at
 * a steady cadence and isolated network stalls produce a short fade-to-silence
 * via PLC instead of a hard cutout.
 */
class InboundVoicePlayer(
    private val lastRxRecorder: LastRxAudioRecorder? = null,
    private val listenGainProvider: () -> Float = { 1f },
    private val onScanRxActivity: ((channelName: String) -> Unit)? = null,
) {

    @Volatile
    private var released: Boolean = false

    @Volatile
    private var mainRxHoldUntilMs: Long = 0L

    @Volatile
    private var activeScanChannel: String? = null

    @Volatile
    private var scanRxHoldUntilMs: Long = 0L

    private val jitterBuffer = InboundJitterBuffer(trackFactory = ::createTrack)

    /** PCM from the tuned (home) channel WebSocket. */
    fun writePcmFromMain(chunk: ByteArray) {
        if (chunk.isNotEmpty()) {
            mainRxHoldUntilMs = SystemClock.elapsedRealtime() + MAIN_RX_HOLD_MS
        }
        writePcm(chunk, recordForReplay = true)
    }

    /** PCM from a scan listen socket — suppressed while home channel is active. */
    fun writePcmFromScan(channelName: String, chunk: ByteArray) {
        if (released || chunk.isEmpty()) return
        val now = SystemClock.elapsedRealtime()
        if (now < mainRxHoldUntilMs) return
        val ch = channelName.trim()
        if (ch.isEmpty()) return
        val held = activeScanChannel
        if (held != null && !held.equals(ch, ignoreCase = true) && now < scanRxHoldUntilMs) {
            return
        }
        activeScanChannel = ch
        scanRxHoldUntilMs = now + SCAN_RX_HOLD_MS
        onScanRxActivity?.invoke(ch)
        writePcm(chunk, recordForReplay = false)
    }

    private fun writePcm(chunk: ByteArray, recordForReplay: Boolean) {
        if (released || chunk.isEmpty()) return
        if (recordForReplay) {
            lastRxRecorder?.onInboundPcm(chunk)
        }
        val gain = listenGainProvider().coerceIn(0f, 1f)
        if (gain <= 0f) return
        val out = if (gain >= 0.999f) {
            chunk
        } else {
            scalePcm16(chunk, gain)
        }
        jitterBuffer.enqueue(out)
    }

    private fun scalePcm16(chunk: ByteArray, gain: Float): ByteArray {
        val out = ByteArray(chunk.size)
        var i = 0
        while (i + 1 < chunk.size) {
            val sample = (chunk[i].toInt() and 0xFF) or (chunk[i + 1].toInt() shl 8)
            val scaled = (sample.toShort() * gain).toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
            out[i] = (scaled and 0xFF).toByte()
            out[i + 1] = ((scaled shr 8) and 0xFF).toByte()
            i += 2
        }
        return out
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
                        // USAGE_MEDIA, not USAGE_VOICE_COMMUNICATION: the voice-communication
                        // route is inaudible on the loudspeaker of many rugged LTE handsets,
                        // which left received voice silent. The media path is reliably audible.
                        //
                        // CONTENT_TYPE_MUSIC, not _SPEECH: a SPEECH content type makes some OEM
                        // audio HALs run speech post-processing (noise reduction) on the OUTPUT,
                        // which mangled received radio audio. MUSIC opts the received stream out of
                        // that device-side enhancement; the mic-side NoiseSuppressor is unaffected.
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
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
                    VoiceAudioSpecs.LEGACY_STREAM_MUSIC,
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
        jitterBuffer.stop()
        mainRxHoldUntilMs = 0L
        activeScanChannel = null
        scanRxHoldUntilMs = 0L
    }

    /** Permanently stop playback; instance must not be used after release. */
    fun release() {
        released = true
        jitterBuffer.release()
    }

    private companion object {
        const val MAIN_RX_HOLD_MS = 400L
        const val SCAN_RX_HOLD_MS = 400L
    }
}
