package com.securityradio.ptt.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

class RadioViewModel : ViewModel() {

    private val channelNames: List<String> = (1..16).map { idx -> "CH %02d".format(idx) }
    private var channelIndex: Int = 0

    private val timeFormatter: DateTimeFormatter =
        DateTimeFormatter.ofPattern("HH:mm", Locale.US)

    private val _uiState = MutableStateFlow(RadioUiState.initial().withChannel(channelNames, channelIndex))
    val uiState: StateFlow<RadioUiState> = _uiState.asStateFlow()

    init {
        viewModelScope.launch {
            while (isActive) {
                refreshClock()
                delay(CLOCK_TICK_MS)
            }
        }
    }

    fun onEvent(event: RadioUiEvent) {
        when (event) {
            RadioUiEvent.PttPressed -> _uiState.update { it.copy(isPttPressed = true, statusMessage = "TX REQUESTED") }
            RadioUiEvent.PttReleased -> _uiState.update { it.copy(isPttPressed = false, statusMessage = "RX IDLE") }
            RadioUiEvent.EmergencyPressed -> _uiState.update {
                it.copy(isEmergencyActive = true, statusMessage = "EMERGENCY ACTIVE")
            }
            RadioUiEvent.EmergencyReleased -> _uiState.update {
                it.copy(isEmergencyActive = false, statusMessage = "EMERGENCY CLEARED")
            }
            RadioUiEvent.ChannelUp -> {
                channelIndex = (channelIndex + 1) % channelNames.size
                _uiState.update { it.withChannel(channelNames, channelIndex).copy(statusMessage = "CHANNEL +") }
            }
            RadioUiEvent.ChannelDown -> {
                channelIndex = (channelIndex - 1 + channelNames.size) % channelNames.size
                _uiState.update { it.withChannel(channelNames, channelIndex).copy(statusMessage = "CHANNEL -") }
            }
            is RadioUiEvent.SoftKeyPressed -> {
                require(event.index in 0 until RadioUiState.SOFT_KEY_COUNT) {
                    "Soft key index out of bounds: ${event.index}"
                }
                _uiState.update { state ->
                    val label = state.softKeyLabels[event.index]
                    state.copy(statusMessage = "SOFT KEY: $label")
                }
            }
        }
    }

    private fun refreshClock() {
        val label = LocalTime.now().format(timeFormatter)
        _uiState.update { it.copy(systemTime = label) }
    }

    private fun RadioUiState.withChannel(names: List<String>, index: Int): RadioUiState {
        val safeIndex = index.coerceIn(0, names.lastIndex.coerceAtLeast(0))
        val label = names.getOrElse(safeIndex) { "CH --" }
        return copy(
            channelLabel = label,
            channelPosition = "%02d / %02d".format(safeIndex + 1, names.size),
            displayLine2 = "TALKGROUP: $label",
        )
    }

    private companion object {
        const val CLOCK_TICK_MS = 1_000L
    }
}
