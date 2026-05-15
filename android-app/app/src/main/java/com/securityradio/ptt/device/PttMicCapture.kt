package com.securityradio.ptt.device

/**
 * Captures microphone PCM while the operator holds PTT. Audio is not transmitted yet; buffers are discarded.
 */
interface PttMicCapture {
    fun startCapture()
    fun stopCapture()
    fun release()
}
