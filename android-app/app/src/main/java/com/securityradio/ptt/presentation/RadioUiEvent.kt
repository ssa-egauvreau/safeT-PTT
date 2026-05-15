package com.securityradio.ptt.presentation

/**
 * Explicit user or device intents for the radio shell. UI layers forward these to the ViewModel.
 */
sealed interface RadioUiEvent {
    data object PttPressed : RadioUiEvent
    data object PttReleased : RadioUiEvent
    data object EmergencyPressed : RadioUiEvent
    data object EmergencyReleased : RadioUiEvent
    data object ChannelUp : RadioUiEvent
    data object ChannelDown : RadioUiEvent
    data object RetryChannelSync : RadioUiEvent
    data class SoftKeyPressed(val index: Int) : RadioUiEvent
}
