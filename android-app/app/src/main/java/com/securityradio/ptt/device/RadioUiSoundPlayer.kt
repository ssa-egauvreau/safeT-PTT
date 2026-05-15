package com.securityradio.ptt.device

/**
 * Plays short UI cues from packaged assets. Implementations must be safe if files are missing.
 */
interface RadioUiSoundPlayer {
    fun playChannelSwitch()
    fun startTalkPermitLoop()
    fun stopTalkPermitLoop()
    fun playEmergencyAlert()
    fun release()
}
