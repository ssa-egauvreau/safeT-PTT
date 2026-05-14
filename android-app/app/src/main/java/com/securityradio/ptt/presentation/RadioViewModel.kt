package com.securityradio.ptt.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.securityradio.ptt.domain.ChannelCatalogOrigin
import com.securityradio.ptt.domain.ChannelRepository
import com.securityradio.ptt.device.RadioUiSoundPlayer
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

class RadioViewModel(
    private val channelRepository: ChannelRepository,
    private val soundPlayer: RadioUiSoundPlayer,
) : ViewModel() {

    private var channelNames: List<String> = emptyList()
    private var channelIndex: Int = 0

    private val timeFormatter: DateTimeFormatter =
        DateTimeFormatter.ofPattern("HH:mm", Locale.US)

    private val _uiState = MutableStateFlow(RadioUiState.initial())
    val uiState: StateFlow<RadioUiState> = _uiState.asStateFlow()

    init {
        viewModelScope.launch {
            while (isActive) {
                refreshClock()
                delay(CLOCK_TICK_MS)
            }
        }
        viewModelScope.launch {
            syncCatalog(playConnectSoundIfNetwork = true)
        }
    }

    fun onEvent(event: RadioUiEvent) {
        when (event) {
            RadioUiEvent.RetryChannelSync -> {
                viewModelScope.launch { syncCatalog(playConnectSoundIfNetwork = true) }
            }
            RadioUiEvent.PttPressed -> {
                soundPlayer.startTalkPermitLoop()
                _uiState.update { it.copy(isPttPressed = true, statusMessage = "TX PERMIT") }
            }
            RadioUiEvent.PttReleased -> {
                soundPlayer.stopTalkPermitLoop()
                _uiState.update { it.copy(isPttPressed = false, statusMessage = "RX IDLE") }
            }
            RadioUiEvent.EmergencyPressed -> {
                soundPlayer.playEmergencyAlert()
                _uiState.update {
                    it.copy(isEmergencyActive = true, statusMessage = "EMERGENCY ACTIVE")
                }
            }
            RadioUiEvent.EmergencyReleased -> {
                _uiState.update {
                    it.copy(isEmergencyActive = false, statusMessage = "EMERGENCY CLEARED")
                }
            }
            RadioUiEvent.ChannelUp -> bumpChannel(+1)
            RadioUiEvent.ChannelDown -> bumpChannel(-1)
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

    private fun bumpChannel(delta: Int) {
        if (channelNames.isEmpty() || _uiState.value.channelsLoading) {
            return
        }
        channelIndex = (channelIndex + delta + channelNames.size) % channelNames.size
        soundPlayer.playChannelSwitch()
        _uiState.update {
            it.withTuning(channelNames, channelIndex).copy(statusMessage = "CHANNEL ${if (delta > 0) "+" else "-"}")
        }
    }

    private suspend fun syncCatalog(playConnectSoundIfNetwork: Boolean) {
        _uiState.update {
            it.copy(
                channelsLoading = true,
                channelSyncError = null,
                networkLabel = "SYNCING",
                displayLine3 = "CHANNELS: LOADING",
                statusMessage = "SYNCING CATALOG",
            )
        }

        val catalog = channelRepository.loadCatalog()
        channelNames = catalog.channels
        if (channelNames.isNotEmpty()) {
            channelIndex = channelIndex.coerceIn(0, channelNames.lastIndex)
        } else {
            channelIndex = 0
        }

        val sourceLabel = when (catalog.origin) {
            ChannelCatalogOrigin.NETWORK -> "NETWORK"
            ChannelCatalogOrigin.LOCAL_FALLBACK -> "LOCAL"
        }

        val networkLabel = when {
            catalog.origin == ChannelCatalogOrigin.NETWORK -> "ONLINE"
            catalog.errorMessage != null -> "OFFLINE"
            else -> "LOCAL"
        }

        val detailLine = when {
            catalog.errorMessage != null -> "SYNC: ${catalog.errorMessage.take(52)}"
            catalog.origin == ChannelCatalogOrigin.NETWORK -> "CHANNELS: NETWORK OK"
            else -> "CHANNELS: LOCAL LIST"
        }

        _uiState.update { state ->
            state.withTuning(channelNames, channelIndex).copy(
                channelsLoading = false,
                channelSyncError = catalog.errorMessage,
                channelSourceLabel = sourceLabel,
                networkLabel = networkLabel,
                displayLine3 = detailLine,
                statusMessage = if (catalog.errorMessage != null) {
                    "FALLBACK CATALOG"
                } else {
                    "READY"
                },
            )
        }

        if (playConnectSoundIfNetwork &&
            catalog.origin == ChannelCatalogOrigin.NETWORK &&
            channelNames.isNotEmpty()
        ) {
            soundPlayer.playChannelSwitch()
        }
    }

    private fun refreshClock() {
        val label = LocalTime.now().format(timeFormatter)
        _uiState.update { it.copy(systemTime = label) }
    }

    private fun RadioUiState.withTuning(names: List<String>, index: Int): RadioUiState {
        if (names.isEmpty()) {
            return copy(
                channelLabel = "----",
                channelPosition = "-- / --",
                totalChannels = 0,
                displayLine2 = "TALKGROUP: ----",
            )
        }
        val safeIndex = index.coerceIn(0, names.lastIndex)
        val label = names[safeIndex]
        return copy(
            channelLabel = label,
            channelPosition = "%02d / %02d".format(safeIndex + 1, names.size),
            totalChannels = names.size,
            displayLine2 = "TALKGROUP: $label",
        )
    }

    override fun onCleared() {
        soundPlayer.release()
        super.onCleared()
    }

    private companion object {
        const val CLOCK_TICK_MS = 1_000L
    }
}
