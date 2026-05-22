package com.securityradio.ptt.presentation

/**
 * Explicit user or device intents for the radio shell. UI layers forward these to the ViewModel.
 */
sealed interface RadioUiEvent {
    data object ToggleDayNight : RadioUiEvent
    data class SetThemeMode(val mode: ThemeMode) : RadioUiEvent
    /** UI layer reports the resolved system dark-mode so AUTO can be flipped correctly. */
    data class SystemDarkChanged(val dark: Boolean) : RadioUiEvent
    data object PttPressed : RadioUiEvent
    data object PttReleased : RadioUiEvent
    data object EmergencyToggle : RadioUiEvent
    data object ChannelUp : RadioUiEvent
    data object ChannelDown : RadioUiEvent
    data object RetryChannelSync : RadioUiEvent
    /** Open overlay to pick channels that participate in scan. */
    /** TM7 day/night long-press: toggle scan and open channel picker when enabling. */
    data object ToggleScanLongPress : RadioUiEvent
    /** Plain scan-on/off toggle (no picker overlay). Used by the universal cockpit SCAN tap. */
    data object ToggleScanSoftKey : RadioUiEvent
    /** Turn scan off and close all scan listen sockets. */
    data object DisableScan : RadioUiEvent
    data object OpenScanPicker : RadioUiEvent
    data object CloseScanPicker : RadioUiEvent
    /** Toggle one channel in/out of scan list (excluding home channel — ignored server-side merge). */
    data class ToggleScanIncludeChannel(val catalogIndex: Int) : RadioUiEvent
    data class SoftKeyPressed(val index: Int) : RadioUiEvent

    data object OpenMappingSettings : RadioUiEvent
    data object CloseMappingSettings : RadioUiEvent
    /** Manual OTA update check from the Device settings page. */
    data object CheckForUpdates : RadioUiEvent
    /** Which tab is selected inside the settings screen (BUTTONS / DEVICE / AUDIO / ACCOUNT). */
    data class SelectSettingsTab(val index: Int) : RadioUiEvent
    data class StartListeningForMapping(val action: com.securityradio.ptt.device.HardwareAction) : RadioUiEvent
    data object StopListeningForMapping : RadioUiEvent
    data class ClearMapping(val action: com.securityradio.ptt.device.HardwareAction) : RadioUiEvent
    data class ResetMappingToDefault(val action: com.securityradio.ptt.device.HardwareAction) : RadioUiEvent

    /** Mic tuning panel (AUDIO settings tab). */
    data class SetMicNoiseSuppression(val enabled: Boolean) : RadioUiEvent
    data class SetMicAutoGain(val enabled: Boolean) : RadioUiEvent
    data class SetMicGainMultiplier(val multiplier: Float) : RadioUiEvent

    data class UpdatePermissionState(
        val needsAudio: Boolean,
        val needsAccessibility: Boolean,
        val needsLocation: Boolean = false,
        val needsGpsEnabled: Boolean = false,
    ) : RadioUiEvent
    data object RequestAudioPermission : RadioUiEvent
    data object RequestLocationPermission : RadioUiEvent
    data object OpenAccessibilitySettings : RadioUiEvent
    data object OpenLocationSettings : RadioUiEvent
    data object OpenGpsSettings : RadioUiEvent
    data object RequestIgnoreBatteryOptimizations : RadioUiEvent
    data object DismissSetupDialog : RadioUiEvent


    data object ToggleVoiceAnnounceChannelTune : RadioUiEvent
    data object PlayLastTransmission : RadioUiEvent
    /** Long-press replay: open history, or close if already open (TM7). */
    data object ToggleMessageHistory : RadioUiEvent
    data object CloseMessageHistory : RadioUiEvent
    data class PlayHistoryMessage(val entryId: Long) : RadioUiEvent
    /** Bind this handset to an agency (tenant) by its radio key; blank clears the override. */
    data class SaveAgencyRadioKey(val key: String) : RadioUiEvent

    data class SetDeviceProfilePreference(val preference: com.securityradio.ptt.device.DeviceProfilePreference) : RadioUiEvent

    data object RequestOverlayPermission : RadioUiEvent

    data object SignOut : RadioUiEvent

    /** MP22 only: move app to physical Display 1 (hardware keys; scrcpy cannot control it on Android 8.1). */
    data object MoveMp22ToPhysicalDisplay : RadioUiEvent

    /** MP22 only: move app back to virtual Display 0 for PC/scrcpy setup. */
    data object MoveMp22ToVirtualSetupDisplay : RadioUiEvent
}
