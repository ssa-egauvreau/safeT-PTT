package com.securityradio.ptt.device

import android.content.Context
import android.os.Build
import android.speech.tts.TextToSpeech
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

/**
 * TextToSpeech for channel tune cues and replaying recent RX captions.
 *
 * Replay currently speaks the attribution line text (until Step B captures real waveform audio).
 */
class ChannelSpeechHelper(
    context: Context,
    private val preferences: RadioPreferences,
) {
    private val appCtx = context.applicationContext
    private val ready = AtomicBoolean(false)

    private val tts: TextToSpeech = TextToSpeech(appCtx, TextToSpeech.OnInitListener { status ->
        if (status == TextToSpeech.SUCCESS) {
            ready.set(true)
            tts.setLanguage(Locale.US)
        }
    })

    fun speakChannelTuneIfEnabled(channelDisplayName: String) {
        if (!preferences.isAnnounceChannelOnTuneEnabled()) return
        if (!ready.get()) return
        val utter = channelDisplayName.trim()
        if (utter.isEmpty() || utter == "----") return
        speak(utter, flush = false)
    }

    /**
     * Spoken when the operator changes zones (hold channel-up / channel-down): announce the ZONE
     * name, not the landed channel's name. Gated on the same tune-announce preference, and flushes
     * so the channel-tune cue for the same retune can't also speak.
     */
    fun speakZoneIfEnabled(zoneSpokenName: String) {
        if (!preferences.isAnnounceChannelOnTuneEnabled()) return
        if (!ready.get()) return
        val utter = zoneSpokenName.trim()
        if (utter.isEmpty()) return
        speak(utter, flush = true)
    }

    /**
     * A dispatcher live-move is an unsolicited retune the operator did not initiate, so it is always
     * announced (independent of the tune-announce preference) and flushes any queued tune speech.
     */
    fun speakMoved(channelDisplayName: String, by: String?) {
        if (!ready.get()) return
        val channel = channelDisplayName.trim()
        if (channel.isEmpty() || channel == "----") return
        val mover = by?.trim().orEmpty()
        val phrase = if (mover.isEmpty()) "Moved to $channel" else "Moved to $channel by $mover"
        speak(phrase, flush = true)
    }

    fun speakLastTransmissionSummary(text: String) {
        if (!ready.get()) return
        val line = text.trim()
        if (line.isEmpty()) return
        speak("Last message. $line", flush = true)
    }

    private fun speak(text: String, flush: Boolean) {
        val utteranceId = Integer.toHexString(text.hashCode())
        val mode =
            if (flush) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            tts.speak(text, mode, null, utteranceId)
        } else {
            @Suppress("DEPRECATION")
            val legacyMode =
                if (flush) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
            tts.speak(text, legacyMode, null)
        }
    }

    fun release() {
        tts.stop()
        tts.shutdown()
        ready.set(false)
    }
}
