package com.securityradio.ptt.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.securityradio.ptt.data.remote.AirStateDto
import com.securityradio.ptt.data.remote.ChannelsApi
import com.securityradio.ptt.data.remote.EmergencyDto
import com.securityradio.ptt.data.remote.InboxAlertDto
import com.securityradio.ptt.data.remote.PresenceHeartbeatDto
import com.securityradio.ptt.data.remote.RadioApi
import com.securityradio.ptt.data.remote.TalkActivityDto
import com.securityradio.ptt.data.remote.TalkerSnapshotDto
import com.securityradio.ptt.device.ChannelSpeechHelper
import com.securityradio.ptt.device.CustomSoundDownloader
import com.securityradio.ptt.device.DeviceProfilePreference
import com.securityradio.ptt.device.DeviceProfileResolver
import com.securityradio.ptt.device.HardwareAction
import com.securityradio.ptt.device.HardwareButtonEvent
import com.securityradio.ptt.device.HardwareButtonRelay
import com.securityradio.ptt.device.HardwareMappingRepository
import com.securityradio.ptt.device.LocalUnitIdentifier
import com.securityradio.ptt.device.LocationReporter

import com.securityradio.ptt.device.PttMicCapture
import com.securityradio.ptt.device.RadioPreferences
import com.securityradio.ptt.device.RadioUiSoundPlayer
import com.securityradio.ptt.device.VoiceControlEvent
import com.securityradio.ptt.device.VoiceRelayTransport
import com.securityradio.ptt.domain.ChannelCatalogOrigin
import com.securityradio.ptt.domain.ChannelRepository
import android.os.SystemClock
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class RadioViewModel(
    private val channelRepository: ChannelRepository,
    private val soundPlayer: RadioUiSoundPlayer,
    private val pttMicCapture: PttMicCapture,
    private val channelsApi: ChannelsApi,
    private val radioApi: RadioApi,
    private val localUnitIdentifier: LocalUnitIdentifier,
    private val hardwareMappingRepository: HardwareMappingRepository,
    private val radioPreferences: RadioPreferences,
    private val speechHelper: ChannelSpeechHelper,
    private val voiceRelay: VoiceRelayTransport,
    private val locationReporter: LocationReporter,
    private val customSoundDownloader: CustomSoundDownloader,
) : ViewModel() {

    @Volatile
    private var locationPermissionGranted: Boolean = false

    private val _wakeUiRequests = MutableSharedFlow<String>(extraBufferCapacity = 24)
    /** Emits reasons why the tactical UI might need to reorder to the foreground while not visible. */
    val wakeUiSignals: SharedFlow<String> = _wakeUiRequests.asSharedFlow()

    @Volatile
    private var mainRadioUiVisible: Boolean = false

    private var lastWakeEmittedAtMs: Long = 0L

    private var channelNames: List<String> = emptyList()
    private var channelIndex: Int = 0

    private var pttToneJob: Job? = null
    private var mappingJob: Job? = null

    @Volatile
    private var pttMicLiveThisHold: Boolean = false

    /** API 21–25 path: avoids java.time (`LocalTime`), which requires desugaring below API 26. */
    private val clockFormat = SimpleDateFormat("HH:mm", Locale.US)

    private val unitIdUpper: String
        get() {
            val session = radioPreferences.getSessionUnitId().trim().uppercase(Locale.US)
            if (session.isNotEmpty()) return session
            return localUnitIdentifier.shortUnitId()
        }

    private val _uiState = MutableStateFlow(RadioUiState.initial())
    val uiState: StateFlow<RadioUiState> = _uiState.asStateFlow()

    init {
        if (radioPreferences.isLoggedIn() && radioPreferences.getSessionUnitId().isBlank()) {
            val fromUsername = radioPreferences.getSessionUsername().trim().uppercase(Locale.US)
            if (fromUsername.isNotEmpty()) {
                radioPreferences.setSessionUnitId(fromUsername)
                localUnitIdentifier.setShortUnitId(fromUsername)
            }
        }
        locationReporter.configure(unitIdUpper)
        _uiState.update {
            it.copy(
                localShortUnitId = unitIdUpper,
                hardwareMappings = hardwareMappingRepository.getAllMappings(),
                themeMode = radioPreferences.getThemeMode(),
                announceChannelNameOnTune = radioPreferences.isAnnounceChannelOnTuneEnabled(),
                agencyRadioKey = radioPreferences.getAgencyRadioKey(),
                deviceProfilePreference = radioPreferences.getDeviceProfilePreference(),
                resolvedDeviceProfile = DeviceProfileResolver.resolve(radioPreferences.getDeviceProfilePreference()),
            )
        }
        viewModelScope.launch {
            while (isActive) {
                refreshClock()
                delay(CLOCK_TICK_MS)
            }
        }
        viewModelScope.launch {
            pollInbox()
        }
        viewModelScope.launch {
            syncCatalog(playConnectSoundIfNetwork = true)
        }
        viewModelScope.launch {
            pollTalkHints()
        }
        viewModelScope.launch {
            voiceRelay.controlEvents.collect { event ->
                val hint = when (event) {
                    is VoiceControlEvent.Joined ->
                        "VOICE ON ${event.channel.uppercase(Locale.US)}"
                    is VoiceControlEvent.Error -> voiceErrorHint(event.code)
                    is VoiceControlEvent.Busy -> {
                        val peer = event.holderUnit?.trim()?.uppercase(Locale.US)
                        if (peer != null) "CHANNEL BUSY — $peer" else "CHANNEL BUSY"
                    }
                }
                _uiState.update { it.copy(statusMessage = hint) }
            }
        }
        viewModelScope.launch {
            HardwareButtonRelay.rawKeyCodes.collect { keyCode ->
                enqueueBackgroundWakeIfNeeded("hardware_raw")
                _uiState.update { it.copy(lastDetectedKey = keyCode) }
            }
        }
        viewModelScope.launch {
            HardwareButtonRelay.events.collect { event ->
                enqueueBackgroundWakeIfNeeded("hardware_action")
                when (event) {
                    HardwareButtonEvent.PttPressed -> onPttPressed()
                    HardwareButtonEvent.PttReleased -> onPttReleased()
                    HardwareButtonEvent.EmergencyPressed -> toggleEmergency()
                    HardwareButtonEvent.ChannelUpPressed -> bumpChannel(+1)
                    HardwareButtonEvent.ChannelDownPressed -> bumpChannel(-1)
                    HardwareButtonEvent.ScanTogglePressed -> {
                        _uiState.update { s -> onScanSoftKeyToggle(s) }
                    }
                    HardwareButtonEvent.PlayLastTransmissionPressed -> playLastTransmission()
                    HardwareButtonEvent.VolumeCheckPressed -> soundPlayer.playVolumeCheck()
                }
            }
        }
        viewModelScope.launch {
            while (isActive) {
                delay(PRESENCE_POLL_MS)
                pulsePresenceFromCurrentState(clearWhenOffline = true)
                reconcileVoiceTransport()
            }
        }
    }

    /** Menu / non-PTT control click sound (same as channel switch WAV). */
    fun playUiMenuSound() {
        soundPlayer.playChannelSwitch()
    }

    /** Call from MainActivity onStart / onStop while this screen is tied to that activity. */
    fun setMainRadioScreenVisible(visible: Boolean) {
        mainRadioUiVisible = visible
    }

    private fun enqueueBackgroundWakeIfNeeded(reason: String) {
        viewModelScope.launch {
            emitWakeDebouncedIfBackground(reason)
        }
    }

    private suspend fun emitWakeDebouncedIfBackground(reason: String) {
        if (mainRadioUiVisible) return
        val now = SystemClock.elapsedRealtime()
        if (now - lastWakeEmittedAtMs < WAKE_DEBOUNCE_MS) return
        lastWakeEmittedAtMs = now
        _wakeUiRequests.emit(reason)
    }

    private fun cycleThemeMode(current: ThemeMode): ThemeMode = when (current) {
        ThemeMode.AUTO -> ThemeMode.DAY
        ThemeMode.DAY -> ThemeMode.NIGHT
        ThemeMode.NIGHT -> ThemeMode.AUTO
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
                val nextMode = cycleThemeMode(_uiState.value.themeMode)
                radioPreferences.setThemeMode(nextMode)
                _uiState.update { it.copy(themeMode = nextMode) }
            }
            is RadioUiEvent.SetThemeMode -> {
                soundPlayer.playChannelSwitch()
                radioPreferences.setThemeMode(event.mode)
                _uiState.update { it.copy(themeMode = event.mode) }
            }
            RadioUiEvent.RetryChannelSync -> {
                soundPlayer.playChannelSwitch()
                viewModelScope.launch { syncCatalog(playConnectSoundIfNetwork = false) }
            }
            RadioUiEvent.PttPressed -> onPttPressed()
            RadioUiEvent.PttReleased -> onPttReleased()
            RadioUiEvent.EmergencyToggle -> toggleEmergency()
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
                    3 -> Unit // soft key 3 unused — GPS reporting is always on
                    4 -> bumpChannel(+1)
                    else -> {
                        soundPlayer.playChannelSwitch()
                        _uiState.update { state ->
                            when (event.index) {
                                0 -> state.copy(statusMessage = "PTT: HOLD LCD BAR")
                                1 -> state.copy(mappingSettingsVisible = true)
                                2 -> onScanSoftKeyToggle(state)
                                else -> state
                            }
                        }
                    }
                }
            }
            RadioUiEvent.OpenMappingSettings -> {
                soundPlayer.playChannelSwitch()
                _uiState.update { it.copy(mappingSettingsVisible = true) }
            }
            RadioUiEvent.CloseMappingSettings -> {
                soundPlayer.playChannelSwitch()
                _uiState.update { it.copy(mappingSettingsVisible = false, currentlyMappingAction = null) }
                mappingJob?.cancel()
            }
            is RadioUiEvent.StartListeningForMapping -> {
                soundPlayer.playChannelSwitch()
                startMappingSession(event.action)
            }
            RadioUiEvent.StopListeningForMapping -> {
                _uiState.update { it.copy(currentlyMappingAction = null) }
                mappingJob?.cancel()
            }
            is RadioUiEvent.ClearMapping -> {
                soundPlayer.playChannelSwitch()
                hardwareMappingRepository.setMapping(event.action, emptySet())
                _uiState.update { it.copy(hardwareMappings = hardwareMappingRepository.getAllMappings()) }
            }
            is RadioUiEvent.ResetMappingToDefault -> {
                soundPlayer.playChannelSwitch()
                hardwareMappingRepository.resetToDefault(event.action)
                _uiState.update { it.copy(hardwareMappings = hardwareMappingRepository.getAllMappings()) }
            }
            is RadioUiEvent.UpdatePermissionState -> {
                _uiState.update { 
                    it.copy(
                        needsAudioPermission = event.needsAudio,
                        needsAccessibilityService = event.needsAccessibility
                    )
                }
            }
            RadioUiEvent.RequestAudioPermission -> {
                // Handled in Activity via side effect or observation if needed, 
                // but we can just trigger the launcher.
            }
            RadioUiEvent.OpenAccessibilitySettings -> {
                // Handled in Activity
            }
            RadioUiEvent.RequestIgnoreBatteryOptimizations -> {
                // Handled in Activity
            }
            RadioUiEvent.ToggleVoiceAnnounceChannelTune -> {
                soundPlayer.playChannelSwitch()
                val next = !_uiState.value.announceChannelNameOnTune
                radioPreferences.setAnnounceChannelOnTuneEnabled(next)
                _uiState.update { it.copy(announceChannelNameOnTune = next) }
            }
            RadioUiEvent.PlayLastTransmission -> playLastTransmission()
            is RadioUiEvent.SaveAgencyRadioKey -> {
                val key = event.key.trim()
                radioPreferences.setAgencyRadioKey(key)
                // REST picks up the key per request; voice must drop its socket
                // to stop using the previous agency's key on the live stream.
                voiceRelay.reconnect()
                // The new agency has its own tone set — pull it now.
                customSoundDownloader.refreshAsync()
                _uiState.update {
                    it.copy(
                        agencyRadioKey = key,
                        statusMessage = if (key.isBlank()) "AGENCY KEY CLEARED" else "AGENCY KEY SAVED",
                    )
                }
                soundPlayer.playChannelSwitch()
            }
            is RadioUiEvent.SetDeviceProfilePreference -> {
                soundPlayer.playChannelSwitch()
                radioPreferences.setDeviceProfilePreference(event.preference)
                _uiState.update {
                    it.copy(
                        deviceProfilePreference = event.preference,
                        resolvedDeviceProfile = DeviceProfileResolver.resolve(event.preference),
                        hardwareMappings = hardwareMappingRepository.getAllMappings(),
                    )
                }
            }
            RadioUiEvent.RequestOverlayPermission -> Unit
            RadioUiEvent.SignOut -> Unit // Handled in MainActivity (clears session and shows login)
        }
    }

    fun onOverlayPermissionResult(granted: Boolean) {
        _uiState.update { it.copy(needsOverlayPermission = !granted) }
    }

    private fun playLastTransmission() {
        val caption = _uiState.value.lastRxReplayCaption
        if (caption.isBlank()) {
            soundPlayer.playChannelSwitch()
            _uiState.update { it.copy(statusMessage = "NO LAST RX") }
            return
        }
        speechHelper.speakLastTransmissionSummary(caption)
        _uiState.update { it.copy(statusMessage = "REPLAY LAST") }
    }

    private fun startMappingSession(action: HardwareAction) {
        mappingJob?.cancel()
        _uiState.update { it.copy(currentlyMappingAction = action) }
        mappingJob = viewModelScope.launch {
            HardwareButtonRelay.rawKeyCodes.collect { keyCode ->
                val currentMappings = hardwareMappingRepository.getMapping(action)
                if (keyCode in currentMappings) {
                    soundPlayer.playChannelSwitch()
                    _uiState.update {
                        it.copy(
                            currentlyMappingAction = null,
                            lastDetectedKey = keyCode,
                            statusMessage = "KEY $keyCode ALREADY ON ${action.label.uppercase(Locale.US)} — CLEAR OR PICK ANOTHER",
                        )
                    }
                    mappingJob?.cancel()
                    return@collect
                }
                val nextMappings = currentMappings + keyCode
                hardwareMappingRepository.setMapping(action, nextMappings)
                _uiState.update {
                    it.copy(
                        hardwareMappings = hardwareMappingRepository.getAllMappings(),
                        currentlyMappingAction = null,
                        lastDetectedKey = keyCode,
                        statusMessage = "MAPPED ${action.label.uppercase(Locale.US)} ← $keyCode",
                    )
                }
                soundPlayer.playChannelSwitch()
                mappingJob?.cancel()
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
                val chParam =
                    snapshot.channelLabel.trim().takeUnless { it.isEmpty() || it == "----" }
                val air: AirStateDto? = if (online) {
                    try {
                        channelsApi.airState(channel = chParam)
                    } catch (_: Exception) {
                        null
                    }
                } else {
                    null
                }
                val occupiedForTransmit = channelBusyBlockingLocalPtt(online, air)
                val useBusy = !online || occupiedForTransmit
                val busyPeerHighlight = peerUnitIfBusyDueToVoice(online, air, occupiedForTransmit)
                val mic = snapshot.micPermissionGranted
                val micLive = pttMicLiveThisHold

                val statusHint = computePttStatus(
                    online = online,
                    useBusy = useBusy,
                    micGranted = mic,
                    micLive = micLive,
                    stableEnough = audioStableCount >= AIR_AUDIO_STABLE_POLLS,
                    busyPeerUnit = busyPeerHighlight,
                )

                _uiState.update { s ->
                    val nextMicHint = micHintForPtt(micGranted = mic, micLive = micLive)
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
        busyPeerUnit: String? = null,
    ): String {
        return when {
            useBusy && !online -> "NO CONNECTION"
            useBusy -> {
                val peer = busyPeerUnit?.trim()?.takeIf { it.isNotEmpty() }?.uppercase(Locale.US)
                if (peer != null) "CHANNEL BUSY — $peer" else "CHANNEL BUSY"
            }
            micLive && micGranted -> "TX + MIC"
            micLive -> "TX (NO MIC)"
            stableEnough -> "AIR: OK — PERMIT"
            else -> "AIR: CHECKING"
        }
    }

    /**
     * True when we should block local TX over the relay. When offline, the caller combines this with
     * `!online` for the full PTT gate. When online but the air probe fails, treat as busy.
     */
    private fun channelBusyBlockingLocalPtt(online: Boolean, air: AirStateDto?): Boolean {
        if (!online) return false
        if (air == null) return true
        return isAirBusyForThisUnit(air)
    }

    /** Server says occupied; if the slot names another unit than us, busy; env-only lacks [transmittingUnitId]. */
    private fun isAirBusyForThisUnit(air: AirStateDto): Boolean {
        if (!air.occupied) return false
        val tx =
            air.transmittingUnitId?.trim()?.uppercase(Locale.US)?.takeIf { it.isNotEmpty() }
                ?: return true
        return tx != unitIdUpper
    }

    /** Peer unit id shown on HUD while PTT is held and relay reports another keyed station. */
    private fun peerUnitIfBusyDueToVoice(
        online: Boolean,
        air: AirStateDto?,
        occupiedForTransmit: Boolean,
    ): String? {
        if (!online || air == null || !occupiedForTransmit) return null
        val peer =
            air.transmittingUnitId?.trim()?.uppercase(Locale.US)?.takeIf { it.isNotEmpty() }
                ?: return null
        return peer.takeIf { it != unitIdUpper }
    }

    private fun micHintForPtt(micGranted: Boolean, micLive: Boolean): String {
        return when {
            micLive && micGranted -> "MIC: MONITOR ON"
            micGranted -> "MIC: STANDBY"
            else -> "MIC: ALLOW MIC"
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

    private fun toggleEmergency() {
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
        val channel = _uiState.value.channelLabel.trim().takeUnless { it.isEmpty() || it == "----" }
        viewModelScope.launch {
            runCatching {
                radioApi.emergency(
                    EmergencyDto(
                        unitId = unitIdUpper,
                        channel = channel,
                        active = activating,
                        message = if (activating) "Emergency activated" else null,
                    ),
                )
            }
        }
    }

    /** Called from the activity once the OS location-permission result is known. */
    fun onLocationPermissionResult(granted: Boolean) {
        locationPermissionGranted = granted
        // GPS position reporting is always on — start it as soon as permission allows.
        if (granted) locationReporter.start()
    }

    private fun bumpChannel(delta: Int) {
        if (channelNames.isEmpty() || _uiState.value.channelsLoading) {
            return
        }
        channelIndex = (channelIndex + delta + channelNames.size) % channelNames.size
        soundPlayer.playChannelSwitch()
        val tunedLabel = channelNames[channelIndex]
        _uiState.update {
            it.withTuning(channelNames, channelIndex).pruneScanSets().copy(statusMessage = "CHANNEL ${if (delta > 0) "+" else "-"}")
        }
        speechHelper.speakChannelTuneIfEnabled(tunedLabel)
        viewModelScope.launch { pulsePresenceHeartbeatAndCount(expectOnline = true) }
        reconcileVoiceTransport()
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

        if (networkLabel == "ONLINE") {
            pulsePresenceFromCurrentState(clearWhenOffline = false)
        }
        reconcileVoiceTransport()
    }

    /** Fire-and-forget presence refresh aligned with catalog / link changes. */
    private fun pulsePresenceFromCurrentState(clearWhenOffline: Boolean) {
        viewModelScope.launch {
            pulsePresenceHeartbeatAndCount(
                clearWhenOffline = clearWhenOffline,
                expectOnline = false,
            )
        }
    }

    /** Align Voice WebSocket relay with tuned channel / link state (half-duplex PCM). */
    private fun reconcileVoiceTransport() {
        val s = _uiState.value
        voiceRelay.updateVoiceTarget(
            unitIdUpper = unitIdUpper,
            channelLabel = s.channelLabel,
            networkOnline = s.networkLabel == "ONLINE",
        )
        locationReporter.setChannel(s.channelLabel)
    }

    /**
     * Polls the server for pages and dispatch emergencies addressed to this unit/channel.
     * The first batch is consumed silently to prime the cursor — only later alerts notify.
     */
    private suspend fun pollInbox() {
        var since = 0L
        var primed = false
        while (currentCoroutineContext().isActive) {
            delay(INBOX_POLL_MS)
            if (_uiState.value.networkLabel != "ONLINE") continue
            val channel = _uiState.value.channelLabel.trim().takeUnless { it.isEmpty() || it == "----" }
            val response = try {
                radioApi.inbox(unit = unitIdUpper, channel = channel, since = since)
            } catch (_: Exception) {
                null
            } ?: continue
            if (primed) {
                response.alerts
                    .filter { it.fromUnit?.trim()?.uppercase(Locale.US) != unitIdUpper }
                    .forEach { handleInboundAlert(it) }
            }
            since = if (response.lastId > since) response.lastId else since
            primed = true
        }
    }

    private fun handleInboundAlert(alert: InboxAlertDto) {
        val from = alert.fromUnit?.trim()?.takeIf { it.isNotEmpty() }
            ?: alert.fromName?.trim()?.takeIf { it.isNotEmpty() }
            ?: "DISPATCH"
        val fromUpper = from.uppercase(Locale.US)
        if (alert.kind.equals("emergency", ignoreCase = true)) {
            if (alert.active) {
                soundPlayer.playEmergencyAlert()
                _uiState.update {
                    it.copy(
                        statusMessage = "EMERGENCY • $fromUpper",
                        remoteEmergencyUnit = fromUpper,
                    )
                }
                enqueueBackgroundWakeIfNeeded("inbox_emergency")
            } else {
                _uiState.update { state ->
                    val clearedRemote =
                        if (state.remoteEmergencyUnit?.equals(fromUpper, ignoreCase = true) == true) {
                            null
                        } else {
                            state.remoteEmergencyUnit
                        }
                    state.copy(remoteEmergencyUnit = clearedRemote)
                }
            }
        } else {
            soundPlayer.playChannelSwitch()
            val message = alert.message?.trim()?.takeIf { it.isNotEmpty() }
            val line = if (message != null) {
                "PAGE: ${message.take(40).uppercase(Locale.US)}"
            } else {
                "PAGE • ${from.uppercase(Locale.US)}"
            }
            _uiState.update { it.copy(statusMessage = line) }
            enqueueBackgroundWakeIfNeeded("inbox_page")
        }
    }

    /**
     * Heartbeat tuned channel then read population; skips when offline/loading/[----].
     * @param clearWhenOffline when true (periodic poll), drop count to null off-link.
     */
    private suspend fun pulsePresenceHeartbeatAndCount(clearWhenOffline: Boolean = true, expectOnline: Boolean = false) {
        val snap = _uiState.value
        if (snap.channelsLoading || snap.channelLabel.isBlank() || snap.channelLabel == "----") return
        if (snap.networkLabel != "ONLINE") {
            if (clearWhenOffline && snap.radiosOnlineOnChannel != null) {
                _uiState.update { it.copy(radiosOnlineOnChannel = null) }
            }
            return
        }
        val channel = snap.channelLabel.trim()
        try {
            channelsApi.presenceHeartbeat(PresenceHeartbeatDto(unitId = unitIdUpper, channel = channel))
            val dto = channelsApi.presenceCount(channel)
            _uiState.update { it.copy(radiosOnlineOnChannel = dto.count.coerceAtLeast(0)) }
        } catch (_: Exception) {
            if (!expectOnline) {
                _uiState.update { it.copy(radiosOnlineOnChannel = null) }
            }
        }
    }

    private fun refreshClock() {
        val label = clockFormat.format(Date())
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
        while (currentCoroutineContext().isActive) {
            delay(TALK_ACTIVITY_POLL_MS)
            if (_uiState.value.networkLabel == "OFFLINE") {
                if (_uiState.value.rxAttributedLine.isNotEmpty()) {
                    _uiState.update { it.copy(rxAttributedLine = "") }
                }
                continue
            }
            val snap = _uiState.value
            val chParam =
                snap.channelLabel.trim().takeUnless { it.isEmpty() || it == "----" }
            val dto = try {
                channelsApi.talkActivity()
            } catch (_: Exception) {
                null
            }
            val air = try {
                channelsApi.airState(channel = chParam)
            } catch (_: Exception) {
                null
            }
            val voiceLine = rxLineFromLiveVoice(air, snap)
            val mockLine = dto?.let { mergedRxAttributedLine(it, snap) }.orEmpty()
            val merged = voiceLine.ifBlank { mockLine }

            if (merged.isNotEmpty() || snap.rxAttributedLine.isNotEmpty()) {
                val wakingFromIdle = snap.rxAttributedLine.isEmpty() && merged.isNotEmpty()
                if (wakingFromIdle) {
                    enqueueBackgroundWakeIfNeeded("rx_talk_activity")
                }
                val replayCaption = nextReplayCaption(snap, merged)
                _uiState.update {
                    it.copy(rxAttributedLine = merged, lastRxReplayCaption = replayCaption)
                }
            }
        }
    }

    /** Attribution from relay live PCM (“on air”); overrides mock talk-activity when non-empty. */
    private fun rxLineFromLiveVoice(air: AirStateDto?, snap: RadioUiState): String {
        val tx =
            air?.transmittingUnitId?.trim()?.uppercase(Locale.US)?.takeIf { it.isNotEmpty() }
                ?: return ""
        val local = snap.localShortUnitId.trim().uppercase(Locale.US)
        if (tx == local) return ""
        return "RX: $tx • VOICE"
    }

    /** Keep prior caption unless a new attribution clearly refers to another handset. */
    private fun nextReplayCaption(snap: RadioUiState, mergedLine: String): String {
        if (mergedLine.isBlank() || !rxAttributionIsOtherUnit(mergedLine, snap.localShortUnitId)) {
            return snap.lastRxReplayCaption
        }
        return mergedLine
    }

    /** True when the RX line carries a unit id different from ours (handles "RX: UNIT • …"). */
    private fun rxAttributionIsOtherUnit(line: String, localShortUnitUpper: String): Boolean {
        val local = localShortUnitUpper.trim().uppercase(Locale.US)
        if (local.isEmpty()) return true
        val trimmed = line.trim()
        val colon = trimmed.indexOf(':')
        if (colon <= 0) return true
        val afterColon = trimmed.substring(colon + 1).trim()
        val sep = afterColon.indexOf('•').takeUnless { it < 0 } ?: afterColon.length
        val unitToken = afterColon.substring(0, sep).trim().uppercase(Locale.US)
        val normalizedLocal = local.removePrefix("UNIT").trim().removePrefix("UNIT ").trim().ifBlank { local }
        return unitToken.isNotEmpty() &&
            unitToken != local &&
            unitToken != "UNIT-$local" &&
            !unitToken.endsWith(local) &&
            !(unitToken == "UNIT $local" || unitToken == normalizedLocal)
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

    private fun voiceErrorHint(code: String): String = when (code) {
        "not_a_member" -> "VOICE BLOCKED — ASK ADMIN TO ASSIGN THIS CHANNEL"
        "unknown_channel" -> "VOICE — CHANNEL NOT ON SERVER"
        "bad_join" -> "VOICE — COULD NOT JOIN CHANNEL"
        "channel_lookup_failed" -> "VOICE — SERVER CHANNEL CHECK FAILED"
        else -> "VOICE ERROR — ${code.uppercase(Locale.US)}"
    }

    override fun onCleared() {
        // Voice and GPS intentionally keep running after the UI is gone — a
        // foreground service holds the process, like a radio left in a pocket.
        // pttMicCapture and soundPlayer are process-scoped singletons whose
        // release() permanently cancels a coroutine scope; calling it here
        // left a later Activity unable to capture or transmit. Only stop any
        // in-progress capture — never tear the shared singletons down.
        pttToneJob?.cancel()
        pttMicCapture.stopCapture()
        super.onCleared()
    }

    private companion object {
        const val CLOCK_TICK_MS = 1_000L
        const val AIR_POLL_MS = 250L
        const val AIR_AUDIO_STABLE_POLLS = 1
        const val TALK_ACTIVITY_POLL_MS = 1200L
        const val WAKE_DEBOUNCE_MS = 700L
        const val PRESENCE_POLL_MS = 12_000L
        const val INBOX_POLL_MS = 5_000L
    }
}
