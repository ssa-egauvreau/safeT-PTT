package com.securityradio.ptt.device

/**
 * Captures microphone PCM while the operator holds PTT.
 *
 * [AudioRecordPttCapture] can mirror audio locally (sidetone) and forward PCM to [StreamingPcmSink].
 */
interface PttMicCapture {
    /**
     * Begin a capture session. With [holdUplink] the session starts gated:
     * PCM is read and discarded (no sink, no sidetone) until
     * [setUplinkHold] (false) opens the gate. Used to pre-warm the mic while
     * the talk-permit tone is still playing, so audio flows the instant the
     * tone ends instead of losing the first syllable to AudioRecord init +
     * buffer fill.
     */
    fun startCapture(holdUplink: Boolean = false)

    fun stopCapture()
    fun release()

    /** True while a capture session is running (including a held pre-warm). */
    val isCapturing: Boolean get() = false

    /** Open/close the uplink gate of a running session. No-op by default. */
    fun setUplinkHold(held: Boolean) {}
}
