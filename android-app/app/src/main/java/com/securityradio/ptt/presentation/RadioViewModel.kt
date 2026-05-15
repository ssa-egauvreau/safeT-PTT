package com.securityradio.ptt.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.securityradio.ptt.data.remote.ChannelsApi
import com.securityradio.ptt.domain.ChannelCatalogOrigin
import com.securityradio.ptt.domain.ChannelRepository
import com.securityradio.ptt.device.PttMicCapture
import com.securityradio.ptt.device.RadioUiSoundPlayer
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.Job
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
    private val pttMicCapture: PttMicCapture,
    private val channelsApi: ChannelsApi,
) : ViewModel() {

    private var channelNames: List<String> = emptyList()
    private var channelIndex: Int = 0

    private var pttToneJob: Job? = null

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

    fun onMicPermissionResult(granted: Boolean) {
        _uiState.update {
            it.copy(
                micPermissionGranted = granted,
                micHint = if (granted) "MIC: READY" else "MIC: DENIED",
            )
        }
    }

    fun onEvent(event: RadioUiEvent) {
        when (event) {
            RadioUiEvent.ToggleDayNight -> {
                _uiState.update { it.copy(displayNightMode = !it.displayNightMode) }
            }
            RadioUiEvent.RetryChannelSync -> {
                viewModelScope.launch { syncCatalog(playConnectSoundIfNetwork = true) }
            }
            RadioUiEvent.PttPressed -> onPttPressed()
            RadioUiEvent.PttReleased -> onPttReleased()
            RadioUiEvent.EmergencyToggle -> {
                val activating = !_uiState.value.isEmergencyActive
                if (activating) {
                    soundPlayer.playEmergencyAlert()
                }
                _uiState.update {
                    it.copy(
                        isEmergencyActive = activating,
                        statusMessage = if (activating) "EMERGENCY ACTIVE" else "EMERGENCY OFF",
                    )
                }
            }
            RadioUiEvent.ChannelUp -> bumpChannel(+1)
            RadioUiEvent.ChannelDown -> bumpChannel(-1)
            is RadioUiEvent.SoftKeyPressed -> {
                require(event.index in 0 until RadioUiState.SOFT_KEY_COUNT) {
                    "Soft key index out of bounds: ${event.index}"
                }
                when (event.index) {
                    4 -> bumpChannel(+1)
                    else -> _uiState.update { state ->
                        when (event.index) {
                            0 -> state.copy(statusMessage = "PTT: HOLD LCD BAR")
                            1 -> state.copy(rssiExpanded = !state.rssiExpanded)
                            2 -> state.copy(
                                scanActive = !state.scanActive,
                                statusMessage = if (!state.scanActive) "SCAN ON" else "SCAN OFF",
                            )
                            3 -> state.copy(
                                gpsActive = !state.gpsActive,
                                statusMessage = if (!state.gpsActive) "GPS ON" else "GPS OFF",
                            )
                            else -> state
                        }
                    }
                }
            }
        }
    }

    private fun onPttPressed() {
        val granted = _uiState.value.micPermissionGranted
        if (granted) {
            pttMicCapture.startCapture()
        }
        _uiState.update {
            it.copy(
                isPttPressed = true,
                pttBusyTone = false,
                statusMessage = if (granted) "TX + MIC" else "TX (NO MIC)",
                micHint = if (granted) "MIC: CAPTURING" else "MIC: ALLOW MIC",
            )
        }

        pttToneJob?.cancel()
        pttToneJob = viewModelScope.launch {
            var audioPrevSample: Boolean? = null
            var audioStableCount = 0
            var audioCommittedBusy: Boolean? = null
            /** At most one talk-permit cue per PTT hold (prevents repeated restarts if air flaps). */
            var talkPermitCuePlayedThisHold = false
            while (isActive && _uiState.value.isPttPressed) {
                val snapshot = _uiState.value
                val online = snapshot.networkLabel == "ONLINE"
                val occupied = if (online) {
                    try {
                        channelsApi.airState().occupied
                    } catch (_: Exception) {
                        true
                    }
                } else {
                    false
                }
                val useBusy = !online || occupied
                val mic = snapshot.micPermissionGranted
                _uiState.update { s ->
                    s.copy(
                        pttBusyTone = useBusy,
                        statusMessage = when {
                            useBusy && !online -> "NO CONNECTION"
                            useBusy -> "CHANNEL BUSY"
                            mic -> "TX + MIC"
                            else -> "TX (NO MIC)"
                        },
                    )
                }

                if (useBusy == audioPrevSample) {
                    audioStableCount++
                } else {
                    audioPrevSample = useBusy
                    audioStableCount = 1
                }
                if (audioStableCount >= AIR_AUDIO_STABLE_POLLS && audioCommittedBusy != useBusy) {
                    if (useBusy) {
                        soundPlayer.stopTalkPermitLoop()
                        soundPlayer.startBusyLoop()
                    } else {
                        soundPlayer.stopBusyLoop()
                        if (!talkPermitCuePlayedThisHold) {
                            soundPlayer.startTalkPermitLoop()
                            talkPermitCuePlayedThisHold = true
                        }
                    }
                    audioCommittedBusy = useBusy
                }
                delay(AIR_POLL_MS)
            }
        }
    }

    private fun onPttReleased() {
        pttToneJob?.cancel()
        pttToneJob = null
        pttMicCapture.stopCapture()
        soundPlayer.stopTalkPermitLoop()
        soundPlayer.stopBusyLoop()
        val granted = _uiState.value.micPermissionGranted
        _uiState.update {
            it.copy(
                isPttPressed = false,
                pttBusyTone = false,
                statusMessage = "RX IDLE",
                micHint = if (granted) "MIC: READY" else "MIC: ALLOW MIC",
            )
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
                displayLine2 = "OPERATIONS",
            )
        }
        val safeIndex = index.coerceIn(0, names.lastIndex)
        val label = names[safeIndex]
        return copy(
            channelLabel = label,
            channelPosition = "%02d / %02d".format(safeIndex + 1, names.size),
            totalChannels = names.size,
            displayLine2 = "OPS: ${label.uppercase(Locale.US)}",
        )
    }

    override fun onCleared() {
        pttToneJob?.cancel()
        pttMicCapture.release()
        soundPlayer.release()
        super.onCleared()
    }

    private companion object {
        const val CLOCK_TICK_MS = 1_000L
        const val AIR_POLL_MS = 400L
        /** Require this many matching air samples before playing a new busy/permit cue (reduces rapid flip-flop). */
        const val AIR_AUDIO_STABLE_POLLS = 2
    }
}
