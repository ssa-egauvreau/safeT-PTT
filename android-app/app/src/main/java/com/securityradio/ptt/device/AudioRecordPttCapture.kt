package com.securityradio.ptt.device

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Lightweight [AudioRecord] loop for PTT. Intended to run only while the app is in the foreground.
 * Captured audio is discarded until a transport layer is added.
 */
class AudioRecordPttCapture : PttMicCapture {

    private val supervisor = SupervisorJob()
    private val scope = CoroutineScope(supervisor + Dispatchers.IO)

    @Volatile
    private var captureActive = false

    private var job: Job? = null
    private var audioRecord: AudioRecord? = null

    override fun startCapture() {
        synchronized(this) {
            stopCaptureInternal()
            val sampleRate = 16_000
            val channelConfig = AudioFormat.CHANNEL_IN_MONO
            val audioFormat = AudioFormat.ENCODING_PCM_16BIT
            val minBuffer = AudioRecord.getMinBufferSize(sampleRate, channelConfig, audioFormat)
            if (minBuffer <= 0) {
                return
            }

            val record = AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                sampleRate,
                channelConfig,
                audioFormat,
                minBuffer * 2,
            )
            if (record.state != AudioRecord.STATE_INITIALIZED) {
                record.release()
                return
            }

            audioRecord = record
            record.startRecording()
            captureActive = true

            val buffer = ByteArray(minBuffer)
            job = scope.launch {
                while (isActive && captureActive && record.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                    record.read(buffer, 0, buffer.size)
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
    }

    override fun release() {
        stopCapture()
        supervisor.cancel()
    }
}
