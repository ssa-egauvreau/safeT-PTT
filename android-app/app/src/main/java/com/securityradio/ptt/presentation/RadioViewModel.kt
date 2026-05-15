package com.securityradio.ptt.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.securityradio.ptt.data.remote.ChannelsApi
import com.securityradio.ptt.data.remote.TalkActivityDto
import com.securityradio.ptt.data.remote.TalkerSnapshotDto
import com.securityradio.ptt.device.LocalUnitIdentifier
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
    localUnitIdentifier: LocalUnitIdentifier,
) : ViewModel() {

    private var channelNames: List<String> = emptyList()
    private var channelIndex: Int = 0

    private var pttToneJob: Job? = null

    @Volatile
    private var pttMicLiveThisHold: Boolean = false

    private val timeFormatter: DateTimeFormatter =
        DateTimeFormatter.ofPattern("HH:mm", Locale.US)

    private val unitIdUpper: String = localUnitIdentifier.shortUnitId()

    private val _uiState = MutableStateFlow(RadioUiState.initial())
    val uiState: StateFlow<RadioUiState> = _uiState.asStateFlow()

    init {
        _uiState.update { it.copy(localShortUnitId = unitIdUpper) }
        viewModelScope.launch {
            while (isActive) {
                refreshClock()
                delay(CLOCK_TICK_MS)
            }
        }
        viewModelScope.launch {
            syncCatalog(playConnectSoundIfNetwork = true)
        }
        viewModelScope.launch {
            pollTalkHints()
        }
    }

    /** Menu / non-PTT control click sound (same as channel switch WAV). */
    fun playUiMenuSound() {
        soundPlayer.playChannelSwitch()
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
                soundPlayer.playChannelSwitch()
                _uiState.update { it.copy(displayNightMode = !it.displayNightMode) }
            }
            RadioUiEvent.RetryChannelSync -> {
                soundPlayer.playChannelSwitch()
                viewModelScope.launch { syncCatalog(playConnectSoundIfNetwork = false) }
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
            RadioUiEvent.OpenScanPicker -> {
                soundPlayer.playChannelSwitch()
                if (_uiState.value.channelCatalog.size > 1) {
                    _uiState.update { it.copy(scanPickerVisible = true) }
                }
            }
            RadioUiEvent.CloseScanPicker -> {
                soundPlayer.playChannelSwitch()
                _uiState.update { it.copy(scanPickerVisible = false) }
            }
            is RadioUiEvent.ToggleScanIncludeChannel -> toggleScanIncluded(event.catalogIndex)
            is RadioUiEvent.SoftKeyPressed -> {
                require(event.index in 0 until RadioUiState.SOFT_KEY_COUNT) {
                    "Soft key index out of bounds: ${event.index}"
                }
                when (event.index) {
                    4 -> bumpChannel(+1)
                    else -> {
                        soundPlayer.playChannelSwitch()
                        _uiState.update { state ->
                            when (event.index) {
                                0 -> state.copy(statusMessage = "PTT: HOLD LCD BAR")
                                1 -> state.copy(rssiExpanded = !state.rssiExpanded)
                                2 -> onScanSoftKeyToggle(state)
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
    }

    /** SCAN soft key toggles scan; first enable seeds selection to every channel except tuned home. */
    private fun onScanSoftKeyToggle(state: RadioUiState): RadioUiState {
        val turningOn = !state.scanActive
        val nextScanOn = turningOn
        val newIncludes = when {
            !nextScanOn -> state.scanIncludedChannelIndices
            channelNames.size <= 1 -> emptySet()
            else -> {
                val homeExcluded = channelIndex.coerceIn(0, channelNames.lastIndex)
                channelNames.indices.filter { it != homeExcluded }.toSet()
            }
        }
        return state.copy(
            scanActive = nextScanOn,
            scanIncludedChannelIndices = newIncludes,
            statusMessage = if (nextScanOn) "SCAN ON" else "SCAN OFF",
        )
    }

    private fun toggleScanIncluded(idx: Int) {
        soundPlayer.playChannelSwitch()
        if (idx !in channelNames.indices || idx == channelIndex.coerceIn(0, channelNames.lastIndex.coerceAtLeast(0))) {
            return
        }
        _uiState.update { s ->
            val next = if (idx in s.scanIncludedChannelIndices) {
                s.scanIncludedChannelIndices - idx
            } else {
                s.scanIncludedChannelIndices + idx
            }
            s.copy(scanIncludedChannelIndices = next)
        }
    }

    private fun onPttPressed() {
        pttMicCapture.stopCapture()
        pttMicLiveThisHold = false
        _uiState.update {
            it.copy(
                isPttPressed = true,
                pttBusyTone = false,
                statusMessage = "AIR: CHECKING",
                micHint = "MIC: STANDBY",
            )
        }

        pttToneJob?.cancel()
        pttToneJob = viewModelScope.launch {
            var audioPrevSample: Boolean? = null
            var audioStableCount = 0
            var audioCommittedBusy: Boolean? = null
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
                val micLive = pttMicLiveThisHold

                val statusHint = computePttStatus(
                    online = online,
                    useBusy = useBusy,
                    micGranted = mic,
                    micLive = micLive,
                    stableEnough = audioStableCount >= AIR_AUDIO_STABLE_POLLS,
                )

                _uiState.update { s ->
                    val nextMicHint = micHintForPtt(useBusy = useBusy, micGranted = mic, micLive = micLive)
                    s.copy(
                        pttBusyTone = useBusy,
                        statusMessage = statusHint,
                        micHint = nextMicHint,
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
                        pttMicCapture.stopCapture()
                        pttMicLiveThisHold = false
                        soundPlayer.startBusyLoop()
                    } else {
                        soundPlayer.stopBusyLoop()
                        if (!micLive) {
                            soundPlayer.playTalkPermitThen {
                                grantMicrophoneAfterVerification()
                            }
                        }
                    }
                    audioCommittedBusy = useBusy
                }
                delay(AIR_POLL_MS)
            }
        }
    }

    private fun computePttStatus(
        online: Boolean,
        useBusy: Boolean,
        micGranted: Boolean,
        micLive: Boolean,
        stableEnough: Boolean,
    ): String {
        return when {
            useBusy && !online -> "NO CONNECTION"
            useBusy -> "CHANNEL BUSY"
            micLive && micGranted -> "TX + MIC"
            micLive && !micGranted -> "TX (NO MIC)"
            !useBusy && !micLive && stableEnough -> "AIR: OK — PERMIT"
            else -> "AIR: CHECKING"
        }
    }

    private fun micHintForPtt(useBusy: Boolean, micGranted: Boolean, micLive: Boolean): String {
        return when {
            micLive && micGranted -> "MIC: MONITOR ON"
            micGranted && !micLive -> "MIC: STANDBY"
            !micGranted -> "MIC: ALLOW MIC"
            else -> "MIC: STANDBY"
        }
    }

    private fun grantMicrophoneAfterVerification() {
        viewModelScope.launch {
            val s = _uiState.value
            if (!s.isPttPressed || s.pttBusyTone) return@launch
            if (pttMicLiveThisHold) return@launch
            pttMicLiveThisHold = true
            if (s.micPermissionGranted) {
                pttMicCapture.startCapture()
            }
            _uiState.update { cur ->
                cur.copy(
                    statusMessage = if (cur.micPermissionGranted) "TX + MIC" else "TX (NO MIC)",
                    micHint = if (cur.micPermissionGranted) "MIC: MONITOR ON" else "MIC: ALLOW MIC",
                )
            }
        }
    }

    private fun onPttReleased() {
        pttMicLiveThisHold = false
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
            it.withTuning(channelNames, channelIndex).pruneScanSets().copy(statusMessage = "CHANNEL ${if (delta > 0) "+" else "-"}")
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
            state.withTuning(channelNames, channelIndex).pruneScanSets().copy(
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

    /** Remove scan picks that are invalid or duplicate the tuned home slot. */
    private fun RadioUiState.pruneScanSets(): RadioUiState {
        if (channelNames.isEmpty()) {
            return copy(
                scanIncludedChannelIndices = emptySet(),
                channelCatalog = emptyList(),
            )
        }
        val maxI = channelNames.lastIndex
        val homeIdx = channelIndex.coerceIn(0, maxI)
        val pruned = scanIncludedChannelIndices
            .filter { it in 0..maxI && it != homeIdx }
            .toSet()
        return copy(
            channelCatalog = channelNames,
            scanIncludedChannelIndices = pruned,
        )
    }

    private fun RadioUiState.withTuning(names: List<String>, index: Int): RadioUiState {
        if (names.isEmpty()) {
            return copy(
                channelLabel = "----",
                channelPosition = "-- / --",
                totalChannels = 0,
                displayLine2 = "OPERATIONS",
                channelCatalog = emptyList(),
            )
        }
        val safeIndex = index.coerceIn(0, names.lastIndex)
        val label = names[safeIndex]
        return copy(
            channelLabel = label,
            channelPosition = "%02d / %02d".format(safeIndex + 1, names.size),
            totalChannels = names.size,
            displayLine2 = "OPS: ${label.uppercase(Locale.US)}",
            channelCatalog = names,
        )
    }

    private suspend fun pollTalkHints() {
        while (isActive) {
            delay(TALK_ACTIVITY_POLL_MS)
            if (_uiState.value.networkLabel == "OFFLINE") {
                if (_uiState.value.rxAttributedLine.isNotEmpty()) {
                    _uiState.update { it.copy(rxAttributedLine = "") }
                }
                continue
            }
            val dto = try {
                channelsApi.talkActivity()
            } catch (_: Exception) {
                null
            }
            if (dto != null) {
                _uiState.update { s -> s.copy(rxAttributedLine = mergedRxAttributedLine(dto, s)) }
            } else if (_uiState.value.rxAttributedLine.isNotEmpty()) {
                _uiState.update { it.copy(rxAttributedLine = "") }
            }
        }
    }

    /**
     * Main channel keyed talk always wins when it matches tuned channel name.
     * Otherwise, if scan is on and server's scan segment matches one of the scanned channels,
     * show scan attribution (only when main is not active on tuned channel).
     */
    private fun mergedRxAttributedLine(dto: TalkActivityDto, s: RadioUiState): String {
        val tuned = s.channelLabel.trim()
        if (tuned.isEmpty() || tuned == "----") return ""

        val main = dto.main
        if (main != null && main.active && channelNamesMatch(main.channel, tuned)) {
            return formatTalker(main, "RX")
        }

        val scanSeg = dto.scan ?: return ""

        val includedNamesLower = s.scanIncludedChannelIndices
            .mapNotNull { ix -> s.channelCatalog.getOrNull(ix)?.trim()?.lowercase(Locale.US) }
            .toSet()

        val scanCh = scanSeg.channel.trim().lowercase(Locale.US)
        if (!scanSeg.active || scanCh.isEmpty() || !s.scanActive) return ""
        if (channelNamesMatch(scanSeg.channel, tuned)) return ""

        val scanIsOnSideChannel = scanCh in includedNamesLower
        return if (scanIsOnSideChannel) {
            formatTalker(scanSeg, "RX")
        } else {
            ""
        }
    }

    private fun channelNamesMatch(a: String, b: String): Boolean =
        a.trim().equals(b.trim(), ignoreCase = true)

    private fun formatTalker(t: TalkerSnapshotDto, prefix: String): String {
        val uid = t.unitId?.trim()?.takeIf { it.isNotEmpty() }?.uppercase(Locale.US) ?: "---"
        val un = t.username?.trim()?.takeIf { it.isNotEmpty() }
        return if (un != null) "$prefix: $uid • $un" else "$prefix: $uid"
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
        const val AIR_AUDIO_STABLE_POLLS = 2
        const val TALK_ACTIVITY_POLL_MS = 1200L
    }
}
