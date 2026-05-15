package com.securityradio.ptt.device

/**
 * Plays short UI cues from packaged assets. Implementations must be safe if files are missing.
 *
 * Talk permit ([startTalkPermitLoop]) is **one shot** when air is available. Busy tone ([startBusyLoop])
 * **loops** while air is busy; call the matching stop when PTT is released.
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
