package com.securityradio.ptt.device

/**
 * Plays short UI cues from packaged assets. Implementations must be safe if files are missing.
 *
 * Busy tone ([startBusyLoop]) loops while the channel is busy or listen-only and PTT is held.
 * [playBusyAlert] plays 1.5s of the same clip for lost-link (repeats every 15s while offline).
 * Talk permit plays **once** after the
 * server grants the channel ([playTalkPermitThen]); microphone capture should begin **after**
 * `onFinished` runs (implementations invoke it on the main thread).
 */
interface RadioUiSoundPlayer {
    /**
     * @param onFinished Optional: invoked on the main thread when the beep ends. Pair with TTS so the
     * channel-name announcement starts AFTER the beep instead of stomping it.
     */
    fun playChannelSwitch(onFinished: (() -> Unit)? = null)
    /**
     * @param onStarted Invoked when the permit WAV actually begins playback (same moment as audio).
     * @param onFinished Invoked when playback ends; start microphone capture here.
     */
    fun playTalkPermitThen(onFinished: () -> Unit, onStarted: (() -> Unit)? = null)
    fun stopTalkPermitLoop()
    fun startBusyLoop()
    fun stopBusyLoop()
    /** Plays ~1.5s of the busy clip for no-connection / lost-link (not looped). */
    fun playBusyAlert()
    /** Stops a lost-link alert mid-play; also called when connectivity returns. */
    fun stopBusyAlert()
    fun playEmergencyAlert()
    /** Distinct two-tone chirp for an incoming page/message — deliberately unlike
     *  [playChannelSwitch] so a page isn't mistaken for a channel change. */
    fun playPage()
    /** Rising chime confirming an action succeeded (reply sent, key saved). */
    fun playSuccess()
    /** Low descending blip signalling a failed action (send failed, etc.). */
    fun playError()
    /** Positive 2-tone "success" chirp for the post-OTA-install confirmation banner. Deliberately
     *  unlike [playChannelSwitch] / [playTalkPermitThen] so the operator can tell that the sound
     *  means "update finished", not "you're keyed up". */
    fun playUpdateInstalled()
    /** One-shot beep at the current volume level (legacy / screen). */
    fun playVolumeCheck()
    /** Loop volume-check WAV while the hardware key is held (IRC590 key 232). */
    fun startVolumeCheckLoop()
    fun stopVolumeCheckLoop()
    fun release()
}
