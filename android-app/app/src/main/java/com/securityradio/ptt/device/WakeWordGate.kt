package com.securityradio.ptt.device

/**
 * Buffers the start of a PTT utterance and, on key-up, asks a [WakeWordSpotter] whether it opened
 * with the agency wake phrase — producing the `tx_meta` `wake` hint sent to the server. The wake
 * word is at the very start of a transmission, so only the first [maxBufferMs] of audio is kept.
 *
 * Wired into [VoiceRelayTransport] but **inert by default**: [enabled] is false and the
 * [StubWakeWordSpotter] returns MAYBE, so it changes nothing until a real model + the enable flag
 * land. Threading: [feed] runs on the mic-capture thread, [finishAndClassify] on the PTT-release
 * path — guarded by a lock.
 */
class WakeWordGate(
    private val spotter: WakeWordSpotter,
    private val wakeWordProvider: () -> String,
    private val enabled: Boolean = false,
    maxBufferMs: Int = 1_500,
) {
    private val maxBytes = (VoiceAudioSpecs.SAMPLE_RATE_HZ / 1000) * maxBufferMs * 2 // 16-bit mono
    private val lock = Any()
    private var buf = ByteArray(maxBytes)
    private var len = 0

    /** Append the start of the utterance. Cheap no-op when disabled or the leading window is full. */
    fun feed(pcm: ByteArray, length: Int) {
        if (!enabled || length <= 0) return
        synchronized(lock) {
            if (len >= maxBytes) return
            val take = minOf(length, maxBytes - len)
            System.arraycopy(pcm, 0, buf, len, take)
            len += take
        }
    }

    /**
     * Classify the buffered utterance and reset for the next one. Returns null when disabled or
     * nothing was buffered (caller then sends no hint → server transcribes as usual). Never throws.
     */
    fun finishAndClassify(): WakeHint? {
        if (!enabled) return null
        val snapshot: ByteArray
        val snapshotLen: Int
        synchronized(lock) {
            snapshot = buf
            snapshotLen = len
            // Hand off the filled buffer; allocate a fresh one for the next utterance.
            buf = ByteArray(maxBytes)
            len = 0
        }
        if (snapshotLen <= 0) return null
        return try {
            spotter.classify(snapshot, snapshotLen, wakeWordProvider())
        } catch (_: Throwable) {
            // A spotter failure must never break a transmission — fall back to "no hint".
            null
        }
    }

    /** Drop any buffered audio (busy-deny / teardown path, where the audio never made the air). */
    fun reset() {
        synchronized(lock) { len = 0 }
    }
}
