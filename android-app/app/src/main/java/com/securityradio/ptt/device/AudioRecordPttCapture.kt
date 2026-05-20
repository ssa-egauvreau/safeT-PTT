package com.securityradio.ptt.device

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** Snapshot of the user's mic-tuning preferences read once at the start of each capture session. */
data class MicCaptureConfig(
    val noiseSuppression: Boolean,
    val autoGain: Boolean,
    /** Software gain multiplier applied to outgoing PCM. Ignored while [autoGain] is true. */
    val gainMultiplier: Float,
) {
    companion object {
        /** Matches the historical fixed behaviour: NS on, AGC on, no manual gain. */
        val DEFAULT = MicCaptureConfig(noiseSuppression = true, autoGain = true, gainMultiplier = 1.0f)
    }
}

/**
 * Capture mic PCM during PTT. Optional sidetone (local playback) and optional
 * upstream sink (e.g. [VoiceRelayTransport]) for relayed VoIP toward peers.
 *
 * [configProvider] is consulted at the start of each [startCapture] call so the user's
 * noise-suppression / gain settings apply on the next PTT without restarting the capture loop.
 */
class AudioRecordPttCapture(
    private val enableSidetone: Boolean = true,
    private val streamingSink: StreamingPcmSink? = null,
    private val configProvider: () -> MicCaptureConfig = { MicCaptureConfig.DEFAULT },
) : PttMicCapture {

    private val supervisor = SupervisorJob()
    private val scope = CoroutineScope(supervisor + Dispatchers.IO)

    @Volatile
    private var captureActive = false

    private var job: Job? = null
    private var audioRecord: AudioRecord? = null
    private var audioTrack: AudioTrack? = null
    private var noiseSuppressor: NoiseSuppressor? = null
    private var echoCanceler: AcousticEchoCanceler? = null
    private var autoGainControl: AutomaticGainControl? = null

    override fun startCapture() {
        synchronized(this) {
            stopCaptureInternal()
            val sampleRate = VoiceAudioSpecs.SAMPLE_RATE_HZ
            val channelConfigIn = AudioFormat.CHANNEL_IN_MONO
            val channelConfigOut = AudioFormat.CHANNEL_OUT_MONO
            val audioFormat = VoiceAudioSpecs.PCM_ENCODING
            val minBuffer = AudioRecord.getMinBufferSize(sampleRate, channelConfigIn, audioFormat)
            if (minBuffer <= 0) {
                return
            }

            val record = AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                sampleRate,
                channelConfigIn,
                audioFormat,
                minBuffer * 2,
            )
            if (record.state != AudioRecord.STATE_INITIALIZED) {
                record.release()
                return
            }
            val config = runCatching { configProvider() }.getOrDefault(MicCaptureConfig.DEFAULT)
            attachVoiceProcessing(record.audioSessionId, config)
            // Manual gain only matters when the user opted out of AutomaticGainControl. A 1.0
            // multiplier is a no-op so the int16 saturation pass is skipped at runtime.
            val manualGain = if (config.autoGain) 1.0f else config.gainMultiplier

            var track: AudioTrack? = null
            if (enableSidetone) {
                val trackBuffer = AudioTrack.getMinBufferSize(sampleRate, channelConfigOut, audioFormat)
                if (trackBuffer > 0) {
                    track =
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                            AudioTrack.Builder()
                                .setAudioAttributes(
                                    AudioAttributes.Builder()
                                        .setUsage(AudioAttributes.USAGE_MEDIA)
                                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                                        .build(),
                                )
                                .setAudioFormat(
                                    AudioFormat.Builder()
                                        .setSampleRate(sampleRate)
                                        .setEncoding(audioFormat)
                                        .setChannelMask(channelConfigOut)
                                        .build(),
                                )
                                .setBufferSizeInBytes(trackBuffer * 2)
                                .setTransferMode(AudioTrack.MODE_STREAM)
                                .build()
                        } else {
                            @Suppress("DEPRECATION")
                            AudioTrack(
                                VoiceAudioSpecs.LEGACY_STREAM_VOICE_COMMUNICATION,
                                sampleRate,
                                channelConfigOut,
                                audioFormat,
                                trackBuffer * 2,
                                AudioTrack.MODE_STREAM,
                            )
                        }
                    if (track.state == AudioTrack.STATE_INITIALIZED) {
                        track.setVolume(1f)
                        track.play()
                    } else {
                        track.release()
                        track = null
                    }
                }
            }

            audioRecord = record
            audioTrack = track
            record.startRecording()
            captureActive = true

            val buffer = ByteArray(minBuffer)
            job = scope.launch {
                while (isActive && captureActive && record.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                    val read = record.read(buffer, 0, buffer.size)
                    if (read > 0) {
                        if (manualGain != 1.0f) {
                            applyGainInPlace(buffer, read, manualGain)
                        }
                        streamingSink?.consumePcm(buffer, read)
                        val t = audioTrack
                        if (t != null && t.playState == AudioTrack.PLAYSTATE_PLAYING) {
                            t.write(buffer, 0, read)
                        }
                    }
                }
            }
        }
    }

    /**
     * Scales 16-bit little-endian PCM samples in place by [gain], with a soft-knee limiter so a
     * hot input doesn't hit the int16 ceiling as a hard clip (which sounds like a buzzy square
     * wave). Below ~0.85 of full-scale, samples pass through unchanged. Above the knee, the
     * excess is attenuated to 30 % of its size, then hard-capped at the ceiling as a final
     * safety net so wrap-around can't happen even with extreme gain.
     */
    private fun applyGainInPlace(buffer: ByteArray, len: Int, gain: Float) {
        var i = 0
        while (i + 1 < len) {
            val lo = buffer[i].toInt() and 0xFF
            val hi = buffer[i + 1].toInt() // signed sign-extend
            val sample = (hi shl 8) or lo
            val scaled = softLimitInt16((sample * gain).toInt())
            buffer[i] = (scaled and 0xFF).toByte()
            buffer[i + 1] = ((scaled shr 8) and 0xFF).toByte()
            i += 2
        }
    }

    private fun softLimitInt16(sample: Int): Int {
        if (sample in -SOFT_KNEE..SOFT_KNEE) return sample
        return if (sample > 0) {
            val compressed = SOFT_KNEE + (sample - SOFT_KNEE) * 3 / 10
            if (compressed > 32767) 32767 else compressed
        } else {
            val compressed = -SOFT_KNEE + (sample + SOFT_KNEE) * 3 / 10
            if (compressed < -32768) -32768 else compressed
        }
    }

    override fun stopCapture() {
        synchronized(this) {
            stopCaptureInternal()
        }
    }

    /**
     * Bind the platform voice-processing effects to the capture session when the device offers
     * them. Noise suppression and AGC respect the user's mic settings; echo cancellation is
     * always on (PTT half-duplex still benefits, and there's no use case for turning it off).
     * Mirrors the echoCancellation/noiseSuppression/autoGainControl constraints the web console
     * requests via getUserMedia.
     */
    private fun attachVoiceProcessing(sessionId: Int, config: MicCaptureConfig) {
        if (config.noiseSuppression && NoiseSuppressor.isAvailable()) {
            noiseSuppressor = runCatching {
                NoiseSuppressor.create(sessionId)?.also { it.setEnabled(true) }
            }.getOrNull()
        }
        if (AcousticEchoCanceler.isAvailable()) {
            echoCanceler = runCatching {
                AcousticEchoCanceler.create(sessionId)?.also { it.setEnabled(true) }
            }.getOrNull()
        }
        if (config.autoGain && AutomaticGainControl.isAvailable()) {
            autoGainControl = runCatching {
                AutomaticGainControl.create(sessionId)?.also { it.setEnabled(true) }
            }.getOrNull()
        }
    }

    private fun stopCaptureInternal() {
        captureActive = false
        job?.cancel()
        job = null
        noiseSuppressor?.runCatching { release() }
        noiseSuppressor = null
        echoCanceler?.runCatching { release() }
        echoCanceler = null
        autoGainControl?.runCatching { release() }
        autoGainControl = null
        audioRecord?.runCatching {
            if (recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                stop()
            }
            release()
        }
        audioRecord = null
        audioTrack?.runCatching {
            if (playState == AudioTrack.PLAYSTATE_PLAYING) {
                stop()
            }
            release()
        }
        audioTrack = null
    }

    override fun release() {
        stopCapture()
        supervisor.cancel()
    }

    private companion object {
        /** Soft-knee threshold for the manual gain limiter; ~0.85 of int16 full-scale. */
        const val SOFT_KNEE = 27800
    }
}
