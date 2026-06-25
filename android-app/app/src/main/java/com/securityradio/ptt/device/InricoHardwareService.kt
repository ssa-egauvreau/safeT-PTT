package com.securityradio.ptt.device

import android.accessibilityservice.AccessibilityService
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import com.securityradio.ptt.RadioApplication

class InricoHardwareService : AccessibilityService() {

    private val repository by lazy {
        (application as RadioApplication).graph.hardwareMappingRepository
    }

    /**
     * Auto-confirm the system "Install" dialog during an OTA update. Touchless radios can't tap it
     * and the PTT keycode is proprietary, so while [AppUpdateInstallGate] is armed (i.e. we just
     * launched an update install) we click the installer's confirm button. The armed window keeps
     * this from ever clicking install dialogs the user didn't trigger.
     */
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null || !AppUpdateInstallGate.isActive()) return
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            event.eventType != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
        ) {
            return
        }
        val pkg = event.packageName?.toString() ?: return
        if (!pkg.contains("packageinstaller", ignoreCase = true)) return
        val root = rootInActiveWindow ?: return
        if (clickConfirmButton(root)) {
            AppUpdateInstallGate.disarm()
        }
    }

    private fun clickConfirmButton(root: AccessibilityNodeInfo): Boolean {
        for (label in CONFIRM_LABELS) {
            val matches = root.findAccessibilityNodeInfosByText(label) ?: continue
            for (node in matches) {
                val text = node.text?.toString()?.trim().orEmpty()
                // Exact label match only, so prose like "Do you want to install…" never triggers.
                if (CONFIRM_LABELS.any { it.equals(text, ignoreCase = true) } && clickNodeOrAncestor(node)) {
                    return true
                }
            }
        }
        return false
    }

    private fun clickNodeOrAncestor(start: AccessibilityNodeInfo?): Boolean {
        var node = start
        var depth = 0
        while (node != null && depth < 5) {
            if (node.isClickable) {
                return node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            }
            node = node.parent
            depth++
        }
        return false
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        isRunning = true
    }

    override fun onDestroy() {
        isRunning = false
        super.onDestroy()
    }

    override fun onInterrupt() {}

    override fun onKeyEvent(event: KeyEvent): Boolean {
        val keyCode = event.keyCode

        // One raw sample per physical press for the mapping learner (avoid DOWN+UP duplicates).
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
            HardwareButtonRelay.sendRawKeyCode(keyCode)
        }

        // Never intercept the hardware volume knob from this service — let it
        // propagate to MainActivity, which owns debounce + optional volume-check beep.
        if (keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) {
            return super.onKeyEvent(event)
        }

        val isPtt = repository.getMapping(HardwareAction.PTT).contains(keyCode)
        val isEmergency = repository.getMapping(HardwareAction.EMERGENCY).contains(keyCode)
        val isChanUp = repository.getMapping(HardwareAction.CHANNEL_UP).contains(keyCode)
        val isChanDown = repository.getMapping(HardwareAction.CHANNEL_DOWN).contains(keyCode)
        val isScanToggle = repository.getMapping(HardwareAction.SCAN_TOGGLE).contains(keyCode)
        val isPlayLast = repository.getMapping(HardwareAction.PLAY_LAST_TRANSMISSION).contains(keyCode)
        val isVolumeCheck = repository.getMapping(HardwareAction.VOLUME_CHECK).contains(keyCode)
        val isToggleDayNight = repository.getMapping(HardwareAction.TOGGLE_DAY_NIGHT).contains(keyCode)
        val isForceInstallUpdate = repository.getMapping(HardwareAction.FORCE_INSTALL_UPDATE).contains(keyCode)

        if (isPtt || isEmergency || isChanUp || isChanDown || isScanToggle || isPlayLast || isVolumeCheck ||
            isToggleDayNight || isForceInstallUpdate
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
                            isForceInstallUpdate -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.ForceInstallUpdatePressed)
                        }
                    }
                }
                KeyEvent.ACTION_UP -> {
                    when {
                        isPtt -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.PttReleased)
                        isVolumeCheck -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.VolumeCheckReleased)
                        isToggleDayNight ->
                            HardwareButtonRelay.sendEvent(HardwareButtonEvent.ToggleDayNightReleased)
                        isPlayLast ->
                            HardwareButtonRelay.sendEvent(HardwareButtonEvent.PlayLastTransmissionReleased)
                        isChanUp ->
                            HardwareButtonRelay.sendEvent(HardwareButtonEvent.ChannelUpReleased)
                        isChanDown ->
                            HardwareButtonRelay.sendEvent(HardwareButtonEvent.ChannelDownReleased)
                    }
                }
            }
            return true
        }

        return super.onKeyEvent(event)
    }

    companion object {
        /**
         * True whenever the OS has this accessibility service bound and running. This is the most
         * reliable "is it enabled?" signal: it is set the moment the system connects the service,
         * regardless of how it was enabled (Settings toggle or an `adb settings put` that may have
         * written the component in short `pkg/.Class` form the Settings.Secure string match misses).
         */
        @Volatile
        var isRunning: Boolean = false
            private set

        /** Positive confirm-button labels on the system installer (never "Cancel"/"Settings"). */
        private val CONFIRM_LABELS = listOf("Install", "Update", "Continue", "OK")
    }
}
