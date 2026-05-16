package com.securityradio.ptt.device

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.Build
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Capture mic PCM during PTT. Optional sidetone (local playback) and optional
 * upstream sink (e.g. [VoiceRelayTransport]) for relayed VoIP toward peers.
 */
class AudioRecordPttCapture(
    private val enableSidetone: Boolean = true,
    private val streamingSink: StreamingPcmSink? = null,
) : PttMicCapture {

    private val supervisor = SupervisorJob()
    private val scope = CoroutineScope(supervisor + Dispatchers.IO)

    @Volatile
    private var captureActive = false

    private var job: Job? = null
    private var audioRecord: AudioRecord? = null
    private var audioTrack: AudioTrack? = null

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

    override fun stopCapture() {
        synchronized(this) {
            stopCaptureInternal()
        }
    }

    private fun stopCaptureInternal() {
        captureActive = false
        job?.cancel()
        job = null
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
}
