package com.securityradio.ptt.device

/**
 * Plays short UI cues from packaged assets. Implementations must be safe if files are missing.
 *
 * Busy tone ([startBusyLoop]) loops while air is unavailable. Talk permit plays **once** after the
 * server grants the channel ([playTalkPermitThen]); microphone capture should begin **after**
 * `onFinished` runs (implementations invoke it on the main thread).
 */
interface RadioUiSoundPlayer {
    fun playChannelSwitch()
    fun playTalkPermitThen(onFinished: () -> Unit)
    fun stopTalkPermitLoop()
    fun startBusyLoop()
    fun stopBusyLoop()
    /** One-shot busy/alert tone — used as the periodic lost-link alert. */
    fun playBusyTone()
    fun playEmergencyAlert()
    /** One-shot beep at the current volume level (legacy / screen). */
    fun playVolumeCheck()
    /** Loop volume-check WAV while the hardware key is held (IRC590 key 232). */
    fun startVolumeCheckLoop()
    fun stopVolumeCheckLoop()
    fun release()
}
