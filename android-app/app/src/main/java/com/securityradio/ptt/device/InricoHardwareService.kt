package com.securityradio.ptt.device

import android.accessibilityservice.AccessibilityService
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent
import com.securityradio.ptt.RadioApplication

class InricoHardwareService : AccessibilityService() {

    private val repository by lazy {
        (application as RadioApplication).graph.hardwareMappingRepository
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}

    override fun onInterrupt() {}

    override fun onKeyEvent(event: KeyEvent): Boolean {
        val keyCode = event.keyCode

        // One raw sample per physical press for the mapping learner (avoid DOWN+UP duplicates).
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
            HardwareButtonRelay.sendRawKeyCode(keyCode)
        }

        val isPtt = repository.getMapping(HardwareAction.PTT).contains(keyCode)
        val isEmergency = repository.getMapping(HardwareAction.EMERGENCY).contains(keyCode)
        val isChanUp = repository.getMapping(HardwareAction.CHANNEL_UP).contains(keyCode)
        val isChanDown = repository.getMapping(HardwareAction.CHANNEL_DOWN).contains(keyCode)
        val isScanToggle = repository.getMapping(HardwareAction.SCAN_TOGGLE).contains(keyCode)
        val isPlayLast = repository.getMapping(HardwareAction.PLAY_LAST_TRANSMISSION).contains(keyCode)
        val isVolumeCheck = repository.getMapping(HardwareAction.VOLUME_CHECK).contains(keyCode)
        val isToggleDayNight = repository.getMapping(HardwareAction.TOGGLE_DAY_NIGHT).contains(keyCode)

        if (isPtt || isEmergency || isChanUp || isChanDown || isScanToggle || isPlayLast || isVolumeCheck ||
            isToggleDayNight
        ) {
            when (event.action) {
                KeyEvent.ACTION_DOWN -> {
                    if (event.repeatCount == 0) {
                        when {
                            isPtt -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.PttPressed)
                            isEmergency -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.EmergencyPressed)
                            isChanUp -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.ChannelUpPressed)
                            isChanDown -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.ChannelDownPressed)
                            isScanToggle -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.ScanTogglePressed)
                            isPlayLast -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.PlayLastTransmissionPressed)
                            isVolumeCheck -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.VolumeCheckPressed)
                            isToggleDayNight -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.ToggleDayNightPressed)
                        }
                    }
                }
                KeyEvent.ACTION_UP -> {
                    when {
                        isPtt -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.PttReleased)
                        isVolumeCheck -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.VolumeCheckReleased)
                    }
                }
            }
            return true
        }

        return super.onKeyEvent(event)
    }
}
