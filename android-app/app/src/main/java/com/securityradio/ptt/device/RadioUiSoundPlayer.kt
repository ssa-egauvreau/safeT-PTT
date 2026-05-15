package com.securityradio.ptt.device

/**
 * Plays short UI cues from packaged assets. Implementations must be safe if files are missing.
 *
 * PTT air-state cues use **single playback** (no looping): [startTalkPermitLoop] and [startBusyLoop]
 * each start one non-looping clip; call the matching stop when PTT is released.
 */
interface RadioUiSoundPlayer {
    fun playChannelSwitch()
    fun startTalkPermitLoop()
    fun stopTalkPermitLoop()
    fun startBusyLoop()
    fun stopBusyLoop()
    fun playEmergencyAlert()
    fun release()
}
