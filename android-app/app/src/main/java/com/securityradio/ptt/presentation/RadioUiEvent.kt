package com.securityradio.ptt.presentation

/**
 * Explicit user or device intents for the radio shell. UI layers forward these to the ViewModel.
 */
sealed interface RadioUiEvent {
    data object ToggleDayNight : RadioUiEvent
    data class SetThemeMode(val mode: ThemeMode) : RadioUiEvent
    data object PttPressed : RadioUiEvent
    data object PttReleased : RadioUiEvent
    data object EmergencyToggle : RadioUiEvent
    data object ChannelUp : RadioUiEvent
    data object ChannelDown : RadioUiEvent
    data object RetryChannelSync : RadioUiEvent
    /** Open overlay to pick channels that participate in scan. */
    data object OpenScanPicker : RadioUiEvent
    data object CloseScanPicker : RadioUiEvent
    /** Toggle one channel in/out of scan list (excluding home channel — ignored server-side merge). */
    data class ToggleScanIncludeChannel(val catalogIndex: Int) : RadioUiEvent
    data class SoftKeyPressed(val index: Int) : RadioUiEvent

    data object OpenMappingSettings : RadioUiEvent
    data object CloseMappingSettings : RadioUiEvent
    data class StartListeningForMapping(val action: com.securityradio.ptt.device.HardwareAction) : RadioUiEvent
    data object StopListeningForMapping : RadioUiEvent
    data class ClearMapping(val action: com.securityradio.ptt.device.HardwareAction) : RadioUiEvent
    data class ResetMappingToDefault(val action: com.securityradio.ptt.device.HardwareAction) : RadioUiEvent

    data class UpdatePermissionState(
        val needsAudio: Boolean,
        val needsAccessibility: Boolean
    ) : RadioUiEvent
    data object RequestAudioPermission : RadioUiEvent
    data object OpenAccessibilitySettings : RadioUiEvent
    data object RequestIgnoreBatteryOptimizations : RadioUiEvent

    data object ToggleP25ImbeDigitalVoice : RadioUiEvent
    data object ToggleVoiceAnnounceChannelTune : RadioUiEvent
    data object PlayLastTransmission : RadioUiEvent
}
