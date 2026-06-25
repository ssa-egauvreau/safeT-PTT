package com.securityradio.ptt.device

/**
 * On-device wake-word gate hint for a PTT transmission. Sent to the server in a `tx_meta` control
 * frame so a supervised-channel clip the device is confident did NOT open with the agency wake
 * phrase can skip the paid cloud transcription lane (still transcribed locally + still run past the
 * server's authoritative wake-word check, so nothing is ever dropped).
 *
 * Because the server stays authoritative, the device only needs to be **recall-safe**: a real wake
 * word must never be classified [NONE]. False positives (a non-request marked [CLEAR]/[MAYBE]) cost
 * nothing — the server discards them.
 */
enum class WakeHint(val wire: String) {
    CLEAR("clear"),
    MAYBE("maybe"),
    NONE("none"),
}

/**
 * Classifies whether a PTT utterance opened with the agency wake phrase. Implementations run a small
 * keyword-spotter (e.g. an openWakeWord TFLite model) over the utterance's leading audio.
 *
 * See `docs/ai-dispatch-wake-word-on-device.md` for the model-training recipe and the recall-safe
 * threshold strategy.
 */
interface WakeWordSpotter {
    /**
     * @param pcm16 little-endian 16-bit mono PCM at [VoiceAudioSpecs.SAMPLE_RATE_HZ] (16 kHz),
     *   covering the start of the utterance.
     * @param length valid bytes in [pcm16].
     * @param wakeWord the agency's configured phrase (e.g. "hey ai").
     */
    fun classify(pcm16: ByteArray, length: Int, wakeWord: String): WakeHint

    fun close() {}
}

/**
 * Inert default until a trained model is integrated: always returns [WakeHint.MAYBE], which the
 * server treats as "transcribe normally". So the gate is a no-op and nothing is ever dropped — the
 * real openWakeWord-backed implementation replaces this once its `.tflite` model is in place.
 */
class StubWakeWordSpotter : WakeWordSpotter {
    override fun classify(pcm16: ByteArray, length: Int, wakeWord: String): WakeHint = WakeHint.MAYBE
}
