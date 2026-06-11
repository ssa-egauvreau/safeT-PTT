package com.securityradio.ptt.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.securityradio.ptt.data.remote.AirStateDto
import com.securityradio.ptt.data.remote.ChannelsApi
import com.securityradio.ptt.data.remote.EmergencyDto
import com.securityradio.ptt.data.remote.InboxAlertDto
import com.securityradio.ptt.data.remote.PresenceHeartbeatDto
import com.securityradio.ptt.data.remote.RadioApi
import com.securityradio.ptt.data.remote.RadioTransmissionDto
import com.securityradio.ptt.data.remote.SessionUserDto
import com.securityradio.ptt.data.remote.TalkActivityDto
import com.securityradio.ptt.data.remote.TalkerSnapshotDto
import com.securityradio.ptt.device.ChannelSpeechHelper
import com.securityradio.ptt.device.CustomSoundDownloader
import com.securityradio.ptt.device.DeviceProfilePreference
import com.securityradio.ptt.device.DeviceProfileResolver
import com.securityradio.ptt.device.ResolvedDeviceProfile
import com.securityradio.ptt.device.HardwareAction
import com.securityradio.ptt.device.HardwareButtonEvent
import com.securityradio.ptt.device.HardwareButtonRelay
import com.securityradio.ptt.device.HardwareMappingRepository
import com.securityradio.ptt.device.BatteryStatusProbe
import com.securityradio.ptt.device.BluetoothStatusProbe
import com.securityradio.ptt.device.ConnectivityMonitor
import com.securityradio.ptt.device.ExternalMicMonitor
import com.securityradio.ptt.device.LastRxAudioRecorder
import com.securityradio.ptt.device.RxMessageHistory
import com.securityradio.ptt.device.RxMessageHistory.Entry as RxHistoryEntry
import android.app.Application
import com.securityradio.ptt.device.LocalUnitIdentifier
import com.securityradio.ptt.device.LocationReporter

import com.securityradio.ptt.device.PttHapticFeedback
import com.securityradio.ptt.device.PttMicCapture
import com.securityradio.ptt.DisplayRouter
import com.securityradio.ptt.device.AppUpdater
import com.securityradio.ptt.device.RadioPreferences
import com.securityradio.ptt.device.RadioUiSoundPlayer
import com.securityradio.ptt.BuildConfig
import com.securityradio.ptt.device.ServerReachabilityMonitor
import com.securityradio.ptt.device.VoiceControlEvent
import com.securityradio.ptt.device.ScanVoiceListenTransport
import com.securityradio.ptt.device.VoiceRelayTransport
import com.securityradio.ptt.domain.ChannelCatalogOrigin
import com.securityradio.ptt.domain.ChannelPermission
import com.securityradio.ptt.domain.ChannelRepository
import android.os.SystemClock
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class RadioViewModel(
    private val application: Application,
    private val channelRepository: ChannelRepository,
    private val soundPlayer: RadioUiSoundPlayer,
    private val pttMicCapture: PttMicCapture,
    private val pttHapticFeedback: PttHapticFeedback,
    private val channelsApi: ChannelsApi,
    private val radioApi: RadioApi,
    private val localUnitIdentifier: LocalUnitIdentifier,
    private val hardwareMappingRepository: HardwareMappingRepository,
    private val radioPreferences: RadioPreferences,
    private val speechHelper: ChannelSpeechHelper,
    private val voiceRelay: VoiceRelayTransport,
    private val scanVoiceListen: ScanVoiceListenTransport,
    private val scanRxActivity: kotlinx.coroutines.flow.SharedFlow<String>,
    private val locationReporter: LocationReporter,
    private val customSoundDownloader: CustomSoundDownloader,
    private val lastRxAudioRecorder: LastRxAudioRecorder,
    private val rxMessageHistory: RxMessageHistory,
    private val connectivityMonitor: ConnectivityMonitor,
    private val serverReachabilityMonitor: ServerReachabilityMonitor,
    private val externalMicMonitor: ExternalMicMonitor,
    private val appUpdater: AppUpdater,
) : ViewModel() {

    @Volatile
    private var locationPermissionGranted: Boolean = false

    private val _wakeUiRequests = MutableSharedFlow<String>(extraBufferCapacity = 24)
    /** Emits reasons why the tactical UI might need to reorder to the foreground while not visible. */
    val wakeUiSignals: SharedFlow<String> = _wakeUiRequests.asSharedFlow()

    @Volatile
    private var mainRadioUiVisible: Boolean = false

    private var appUpdatePollJob: Job? = null

    private var lastWakeEmittedAtMs: Long = 0L

    /** Keeps the "MOVED TO" banner on screen past the immediate re-join "VOICE ON" ack. */
    private var moveBannerUntilMs: Long = 0L

    private var channelNames: List<String> = emptyList()
    private var channelIndex: Int = 0

    /** Per-channel permissions from the portal, keyed lowercased; missing == [ChannelPermission.TALK]. */
    private var channelPermissions: Map<String, ChannelPermission> = emptyMap()

    /** Agency tone-set version last seen; a change triggers a custom-tone re-pull. */
    private var lastSoundsVersion: String? = null

    private var pttToneJob: Job? = null
    private var mappingJob: Job? = null

    /** Lost-link alert loop (busy tone + cycling banner) and the RECONNECTED auto-clear. */
    private var offlineJob: Job? = null
    private var reconnectClearJob: Job? = null

    /** Clears the replay banner once the replayed clip has finished playing. */
    private var replayJob: Job? = null
    /** Bumped on each new replay so a stale timer cannot clear a fresh banner. */
    private var replayBannerGeneration = 0

    /** Null until the first connectivity reading; used to fire on edges only. */
    private var lastConnectivityOnline: Boolean? = null

    /** Resolved device dark-mode, reported by the Compose layer; flips [ThemeMode.AUTO] correctly. */
    @Volatile
    private var systemDark: Boolean = false

    /** Day/night hardware key: hold timer and whether this hold already flipped the screen. */
    private var dayNightHoldJob: Job? = null
    @Volatile
    private var dayNightFlippedThisHold: Boolean = false
    @Volatile
    private var dayNightScanToggledThisHold: Boolean = false

    private var replayHoldJob: Job? = null
    @Volatile
    private var replayHistoryToggledThisHold: Boolean = false
    private var historyPlayJob: Job? = null
    private var historyTranscriptPollJob: Job? = null

    /** Clears the scan-RX banner after voice activity stops. */
    private var scanRxBannerClearJob: Job? = null

    @Volatile
    private var pttMicLiveThisHold: Boolean = false

    /** Post-release capture drain (see [onPttReleased]); cancelled by a re-key. */
    private var pttReleaseDrainJob: Job? = null

    /** Monotonic key-up counter so a stale release-drain can't stop a newer hold's mic. */
    private var pttHoldGeneration: Long = 0L

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

    /** Plays the update-alert jingle only once per download (not on every progress tick). */
    private var updateJinglePlayed = false

    init {
        if (radioPreferences.isLoggedIn() && radioPreferences.getSessionUnitId().isBlank()) {
            val fromUsername = radioPreferences.getSessionUsername().trim().uppercase(Locale.US)
            if (fromUsername.isNotEmpty()) {
                radioPreferences.setSessionUnitId(fromUsername)
                localUnitIdentifier.setShortUnitId(fromUsername)
            }
        }
        if (radioPreferences.isLoggedIn() && radioPreferences.getSessionDisplayName().isBlank()) {
            val fromUsername = radioPreferences.getSessionUsername().trim()
            if (fromUsername.isNotEmpty()) {
                radioPreferences.setSessionDisplayName(fromUsername)
            }
        }
        locationReporter.configure(unitIdUpper)
        val audioManager =
            application.getSystemService(android.content.Context.AUDIO_SERVICE) as? android.media.AudioManager
        val externalMicAtStart =
            audioManager?.let { ExternalMicMonitor.hasExternalMicInput(it) } ?: false
        _uiState.update {
            it.copy(
                localShortUnitId = unitIdUpper,
                sessionDisplayName = radioPreferences.getSessionDisplayName(),
                sessionUsername = radioPreferences.getSessionUsername(),
                sessionAgencyName = radioPreferences.getSessionAgencyName().ifBlank {
                    radioPreferences.getSessionAgencySlug()
                },
                externalMicConnected = externalMicAtStart,
                batteryPercent = BatteryStatusProbe.percent(application),
                bluetoothOn = BluetoothStatusProbe.isBluetoothOn(application),
                hardwareMappings = hardwareMappingRepository.getAllMappings(),
                themeMode = radioPreferences.getThemeMode(),
                announceChannelNameOnTune = radioPreferences.isAnnounceChannelOnTuneEnabled(),
                displayRotated180 = radioPreferences.isDisplayRotated180(),
                agencyRadioKey = radioPreferences.getAgencyRadioKey(),
                deviceProfilePreference = radioPreferences.getDeviceProfilePreference(),
                resolvedDeviceProfile = DeviceProfileResolver.resolve(radioPreferences.getDeviceProfilePreference()),
                micNoiseSuppressionEnabled = radioPreferences.isNoiseSuppressionEnabled(),
                micAutoGainEnabled = radioPreferences.isMicAutoGainEnabled(),
                micGainMultiplier = radioPreferences.getMicGainMultiplier(),
                mp22DualDisplay = DisplayRouter.isMp22StyleDualDisplay(application),
                mp22UsePhysicalDisplay = radioPreferences.isMp22UsePhysicalDisplay(),
            )
        }
        // First launch after a verified OTA install: play the distinctive 2-tone ack (NOT the PTT
        // permit tone — that sounded like keying up) and raise a persistent green overlay that
        // operators dismiss by pressing any hardware button or tapping the overlay.
        appUpdater.takeInstalledUpdateNotice()?.let { installed ->
            soundPlayer.playUpdateInstalled()
            _uiState.update { it.copy(updateInstalledNotice = installed.versionName) }
        }
        refreshAppUpdateBanner()
        appUpdater.setProgressListener { progress -> onAppUpdateProgress(progress) }
        // Flash the app version in the zone/channel display for a few seconds at launch, on the
        // rugged handset profiles only (IRC590 / TM-7 Plus).
        val launchProfile = uiState.value.resolvedDeviceProfile
        if (launchProfile == ResolvedDeviceProfile.IRC590 || launchProfile == ResolvedDeviceProfile.TM7_PLUS) {
            _uiState.update { it.copy(versionBanner = "v${BuildConfig.VERSION_NAME}") }
            viewModelScope.launch {
                delay(VERSION_BANNER_MS)
                _uiState.update { it.copy(versionBanner = null) }
            }
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
            pollSoundsVersion()
        }
        viewModelScope.launch {
            syncCatalog(playConnectSoundIfNetwork = true)
        }
        viewModelScope.launch {
            pollChannelCatalog()
        }
        viewModelScope.launch {
            pollProfile()
        }
        viewModelScope.launch {
            pollTalkHints()
        }
        viewModelScope.launch {
            scanRxActivity.collect { channel -> onScanVoiceHeard(channel) }
        }
        viewModelScope.launch {
            voiceRelay.controlEvents.collect { event ->
                val hint: String? = when (event) {
                    is VoiceControlEvent.Joined ->
                        // A dispatcher move re-joins the target channel immediately after, so the
                        // "VOICE ON" ack would otherwise stomp the "MOVED TO" banner before the
                        // operator can read it. Hold the banner for a short window after a move.
                        if (SystemClock.elapsedRealtime() < moveBannerUntilMs) {
                            null
                        } else {
                            "VOICE ON ${event.channel.uppercase(Locale.US)}"
                        }
                    is VoiceControlEvent.Error -> voiceErrorHint(event.code)
                    is VoiceControlEvent.Busy -> {
                        val peer = event.holderUnit?.trim()?.uppercase(Locale.US)
                        if (peer != null) "CHANNEL BUSY — $peer" else "CHANNEL BUSY"
                    }
                    is VoiceControlEvent.Moved -> {
                        // Dispatcher retuned this radio (Live Channel Control). Tune to the target
                        // channel, speak the move, and keep the banner up past the re-join ack.
                        val by = event.by?.trim()?.takeIf { it.isNotEmpty() }
                        tuneToChannelByName(event.channel)
                        soundPlayer.playChannelSwitch {
                            speechHelper.speakMoved(event.channel, by)
                        }
                        moveBannerUntilMs = SystemClock.elapsedRealtime() + MOVE_BANNER_MS
                        val dest = event.channel.uppercase(Locale.US)
                        if (by != null) "MOVED TO $dest BY ${by.uppercase(Locale.US)}" else "MOVED TO $dest"
                    }
                    // Internal uplink-mode signal (AI dispatch wants clear PCM); the transport acts
                    // on it directly, so there's no operator-facing banner to show.
                    is VoiceControlEvent.AiDispatchPcm -> null
                    // Channel codec changed (admin flipped IMBE/Codec2/Opus). The transport
                    // already swapped its TX encoder; no operator-facing banner — the change
                    // is informational and the talker hears identical audio either way.
                    is VoiceControlEvent.CodecChanged -> null
                    // Relay pushed the channel's talker the moment their first frame hit
                    // the air — paint the attribution now instead of waiting for the next
                    // talk-activity poll (which lagged the audio by up to ~1.2 s).
                    is VoiceControlEvent.AirClaimed -> {
                        onRemoteAirClaimed(event)
                        null
                    }
                    is VoiceControlEvent.AirReleased -> {
                        onRemoteAirReleased(event)
                        null
                    }
                }
                if (hint != null) {
                    _uiState.update { it.copy(statusMessage = hint) }
                }
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
                // "Push any button to close" — clear the post-install banner BEFORE routing the
                // event so the press also performs its normal action (PTT, channel up, etc.).
                if (_uiState.value.updateInstalledNotice != null) {
                    _uiState.update { it.copy(updateInstalledNotice = null) }
                }
                enqueueBackgroundWakeIfNeeded("hardware_action")
                when (event) {
                    HardwareButtonEvent.PttPressed -> onPttPressed()
                    HardwareButtonEvent.PttReleased -> onPttReleased()
                    HardwareButtonEvent.EmergencyPressed -> toggleEmergency()
                    HardwareButtonEvent.ChannelUpPressed -> bumpChannel(+1)
                    HardwareButtonEvent.ChannelDownPressed -> bumpChannel(-1)
                    HardwareButtonEvent.ScanTogglePressed -> {
                        _uiState.update { s -> onScanSoftKeyToggle(s) }
                        reconcileVoiceTransport()
                    }
                    HardwareButtonEvent.PlayLastTransmissionPressed -> onPlayLastKeyDown()
                    HardwareButtonEvent.PlayLastTransmissionReleased -> onPlayLastKeyUp()
                    HardwareButtonEvent.VolumeCheckPressed -> soundPlayer.startVolumeCheckLoop()
                    HardwareButtonEvent.VolumeCheckReleased -> soundPlayer.stopVolumeCheckLoop()
                    HardwareButtonEvent.VolumeCheckTapped -> soundPlayer.playVolumeCheck()
                    HardwareButtonEvent.ToggleDayNightPressed -> onDayNightKeyDown()
                    HardwareButtonEvent.ToggleDayNightReleased -> onDayNightKeyUp()
                    HardwareButtonEvent.ForceInstallUpdatePressed -> onForceInstallUpdateKey()
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
        viewModelScope.launch {
            while (isActive) {
                delay(STATUS_REFRESH_MS)
                val bt = BluetoothStatusProbe.isBluetoothOn(application)
                val battery = BatteryStatusProbe.percent(application)
                val snap = _uiState.value
                if (bt != snap.bluetoothOn || battery != snap.batteryPercent) {
                    _uiState.update { it.copy(bluetoothOn = bt, batteryPercent = battery) }
                }
                refreshLocationSetupState()
            }
        }
        viewModelScope.launch {
            combine(
                connectivityMonitor.online,
                serverReachabilityMonitor.reachable,
            ) { osOnline, serverReachable -> osOnline && serverReachable }
                .distinctUntilChanged()
                .collect { online -> onConnectivityChanged(online) }
        }
        viewModelScope.launch {
            // StateFlow dedupes via Operator Fusion — no explicit
            // `.distinctUntilChanged()` needed (kotlinx-coroutines flags that
            // as a deprecation error on a StateFlow).
            scanVoiceListen.linkHealthy.collect { healthy ->
                if (_uiState.value.scanLinkHealthy != healthy) {
                    _uiState.update { it.copy(scanLinkHealthy = healthy) }
                }
            }
        }
        viewModelScope.launch {
            externalMicMonitor.connected.collect { connected ->
                if (_uiState.value.externalMicConnected != connected) {
                    _uiState.update { it.copy(externalMicConnected = connected) }
                }
            }
        }
    }

    /**
     * Reacts to device internet coming and going. The first reading only seeds the
     * baseline (so a normal online start makes no noise); later edges drive the
     * lost-link alert and the reconnect chime.
     */
    private fun onConnectivityChanged(online: Boolean) {
        val previous = lastConnectivityOnline
        lastConnectivityOnline = online
        if (previous == online) return
        if (!online) {
            startOfflineHandling()
        } else if (previous != null) {
            onConnectionRestored()
        }
    }

    /** Cycles NO CONNECTION / RECONNECTING and re-sounds the busy tone until link returns. */
    private fun startOfflineHandling() {
        reconnectClearJob?.cancel()
        reconnectClearJob = null
        offlineJob?.cancel()
        _uiState.update { it.copy(networkLabel = "OFFLINE") }
        offlineJob = viewModelScope.launch {
            soundPlayer.stopBusyLoop()
            soundPlayer.playBusyAlert()
            var sinceToneMs = 0L
            var showNoConnection = true
            while (isActive) {
                val banner = if (showNoConnection) {
                    RadioUiState.BANNER_NO_CONNECTION
                } else {
                    RadioUiState.BANNER_RECONNECTING
                }
                _uiState.update { it.copy(connectivityBanner = banner) }
                showNoConnection = !showNoConnection
                delay(OFFLINE_BANNER_CYCLE_MS)
                sinceToneMs += OFFLINE_BANNER_CYCLE_MS
                if (sinceToneMs >= OFFLINE_TONE_INTERVAL_MS) {
                    soundPlayer.playBusyAlert()
                    sinceToneMs = 0L
                }
            }
        }
    }

    /** Link returned: stop the alert, sound the channel tone, flash RECONNECTED briefly. */
    private fun onConnectionRestored() {
        offlineJob?.cancel()
        offlineJob = null
        soundPlayer.stopBusyAlert()
        soundPlayer.stopBusyLoop()
        soundPlayer.playChannelSwitch()
        _uiState.update { it.copy(connectivityBanner = RadioUiState.BANNER_RECONNECTED) }
        reconnectClearJob?.cancel()
        reconnectClearJob = viewModelScope.launch {
            delay(RECONNECTED_BANNER_MS)
            _uiState.update {
                if (it.connectivityBanner == RadioUiState.BANNER_RECONNECTED) {
                    it.copy(connectivityBanner = "")
                } else {
                    it
                }
            }
        }
        viewModelScope.launch { syncCatalog(playConnectSoundIfNetwork = false) }
    }

    /** Menu / non-PTT control click sound (same as channel switch WAV). */
    fun playUiMenuSound() {
        soundPlayer.playChannelSwitch()
    }

    /** Called on launch and when a verified APK is already waiting for reboot. */
    fun refreshAppUpdateBanner() {
        val notice = appUpdater.peekPendingUpdateNotice()
        if (notice == null) {
            return
        }
        applyAppUpdateDownloadedBanner(notice.versionName)
    }

    fun onAppUpdateProgress(progress: AppUpdater.UpdateProgress) {
        when (progress) {
            AppUpdater.UpdateProgress.Idle -> {
                if (appUpdater.peekPendingUpdateNotice() == null) {
                    _uiState.update { it.copy(appUpdateBanner = "", updateInstalling = false) }
                }
            }
            is AppUpdater.UpdateProgress.Available -> {
                startUpdateInProgress()
                applyAppUpdateAvailableBanner(progress.versionName)
            }
            is AppUpdater.UpdateProgress.Downloading -> {
                startUpdateInProgress()
                applyAppUpdateDownloadingBanner(
                    progress.versionName,
                    progress.bytesDownloaded,
                    progress.totalBytes,
                )
            }
            is AppUpdater.UpdateProgress.Downloaded ->
                onAppUpdateDownloaded(progress.notice)
            is AppUpdater.UpdateProgress.Installing -> {
                _uiState.update { it.copy(updateInstalling = true) }
                applyAppUpdateInstallingBanner(progress.versionName)
            }
            AppUpdater.UpdateProgress.UpToDate -> showUpToDate()
            AppUpdater.UpdateProgress.CheckFailed -> showUpdateCheckFailed()
        }
    }

    /** First time an update download starts, raise the full-screen banner and play the alert jingle. */
    private fun startUpdateInProgress() {
        _uiState.update { it.copy(updateInstalling = true) }
        if (!updateJinglePlayed) {
            updateJinglePlayed = true
            soundPlayer.playChannelSwitch()
        }
    }

    private fun showUpToDate() {
        val msg = "UP TO DATE — ON THE LATEST VERSION"
        _uiState.update { it.copy(statusMessage = msg) }
        viewModelScope.launch {
            delay(VERSION_BANNER_MS)
            _uiState.update { if (it.statusMessage == msg) it.copy(statusMessage = "") else it }
        }
    }

    private fun showUpdateCheckFailed() {
        val msg = "UPDATE CHECK FAILED"
        _uiState.update { it.copy(statusMessage = msg) }
        viewModelScope.launch {
            delay(VERSION_BANNER_MS)
            _uiState.update { if (it.statusMessage == msg) it.copy(statusMessage = "") else it }
        }
    }

    fun onAppUpdateDownloaded(notice: AppUpdater.UpdateNotice) {
        if (notice.versionCode <= BuildConfig.VERSION_CODE.toLong()) {
            appUpdater.clearPendingUpdate()
            _uiState.update { it.copy(appUpdateBanner = "", updateInstalling = false) }
            return
        }
        // Keep the full-screen "do not turn off" banner up through the install/reboot.
        _uiState.update { it.copy(updateInstalling = true) }
        applyAppUpdateDownloadedBanner(notice.versionName)
    }

    private fun applyAppUpdateAvailableBanner(versionName: String) {
        val label = versionLabel(versionName)
        _uiState.update {
            it.copy(
                appUpdateBanner = "UPDATE $label AVAILABLE — DOWNLOADING...",
                statusMessage = "DOWNLOADING UPDATE",
            )
        }
    }

    private fun applyAppUpdateDownloadingBanner(
        versionName: String,
        bytesDownloaded: Long = 0L,
        totalBytes: Long? = null,
    ) {
        val label = versionLabel(versionName)
        val progressSuffix = formatDownloadProgress(bytesDownloaded, totalBytes)
        _uiState.update {
            it.copy(
                appUpdateBanner = "UPDATE $label DOWNLOADING$progressSuffix",
                statusMessage = "DOWNLOADING UPDATE$progressSuffix",
            )
        }
    }

    /**
     * Format the bytes-downloaded counter as a short suffix for the banner.
     * Returns ` 12.4 MB / 38.1 MB · 32%` when total is known, ` 12.4 MB` when
     * not, and `…` while we have no bytes yet so the banner stays moving
     * even on a slow start.
     */
    private fun formatDownloadProgress(bytesDownloaded: Long, totalBytes: Long?): String {
        if (bytesDownloaded <= 0L) return "…"
        val mb = bytesDownloaded.toDouble() / 1_000_000.0
        val mbStr = if (mb >= 10.0) "%.0f".format(mb) else "%.1f".format(mb)
        if (totalBytes == null || totalBytes <= 0L) {
            return " $mbStr MB"
        }
        val totalMb = totalBytes.toDouble() / 1_000_000.0
        val totalStr = if (totalMb >= 10.0) "%.0f".format(totalMb) else "%.1f".format(totalMb)
        val pct = ((bytesDownloaded.toDouble() / totalBytes.toDouble()) * 100).toInt()
            .coerceIn(0, 100)
        return " $mbStr / $totalStr MB · $pct%"
    }

    private fun applyAppUpdateDownloadedBanner(versionName: String) {
        // The download just finished — `AppUpdater` arms the install gate and
        // fires the system installer next. Frame this as "installing" (not
        // "reboot") because operators were power-cycling the device on the old
        // "REBOOT TO INSTALL" wording even though that does nothing on its
        // own. checkOnLaunch() now also retries the installer on the next
        // start so a power cycle still helps — but the right action is to
        // wait for the auto-install or trigger FORCE_INSTALL_UPDATE.
        applyAppUpdateInstallingBanner(versionName)
    }

    private fun applyAppUpdateInstallingBanner(versionName: String) {
        val label = versionLabel(versionName)
        _uiState.update {
            it.copy(
                appUpdateBanner = "INSTALLING UPDATE $label — DO NOT POWER OFF",
                statusMessage = "INSTALLING UPDATE",
            )
        }
    }

    /**
     * Operator pressed the FORCE_INSTALL_UPDATE hardware key. If a download
     * is pending, re-fire the installer and play the channel-switch tone
     * so the operator gets audible feedback that the action registered.
     * If there's nothing to install, play the "busy" tone — the same
     * "you tried but no" cue used elsewhere — so the key feels alive.
     */
    private fun onForceInstallUpdateKey() {
        val fired = appUpdater.forceRetryPendingInstall()
        if (fired) {
            soundPlayer.playChannelSwitch()
        } else {
            soundPlayer.playBusyAlert()
        }
    }

    private fun versionLabel(versionName: String): String =
        versionName.trim().ifBlank { "NEW" }

    /** MP22: track which display the activity is on (for setup vs radio screen hints). */
    fun refreshMp22DisplayState(displayId: Int) {
        if (!DisplayRouter.isMp22StyleDualDisplay(application)) return
        _uiState.update {
            it.copy(
                mp22DualDisplay = true,
                mp22UsePhysicalDisplay = radioPreferences.isMp22UsePhysicalDisplay(),
                mp22CurrentDisplayId = displayId,
                mp22TouchNotReachable = false,
            )
        }
    }

    fun setMp22TouchNotReachable(notReachable: Boolean) {
        if (!DisplayRouter.isMp22StyleDualDisplay(application)) return
        _uiState.update { it.copy(mp22TouchNotReachable = notReachable) }
    }

    /** Call from MainActivity onStart / onStop while this screen is tied to that activity. */
    fun setMainRadioScreenVisible(visible: Boolean) {
        mainRadioUiVisible = visible
        if (visible) {
            startAppUpdatePolling()
        } else {
            appUpdatePollJob?.cancel()
            appUpdatePollJob = null
        }
    }

    private fun startAppUpdatePolling() {
        appUpdatePollJob?.cancel()
        appUpdatePollJob =
            viewModelScope.launch {
                while (isActive) {
                    appUpdater.checkAndInstallAsync(force = false)
                    delay(APP_UPDATE_POLL_MS)
                }
            }
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

    /** Day/night control: flips the *displayed* theme so one press always changes the screen. */
    private fun applyDayNightToggle() {
        soundPlayer.playChannelSwitch()
        val currentlyNight = _uiState.value.themeMode.isLcdNight(systemDark)
        val nextMode = if (currentlyNight) ThemeMode.DAY else ThemeMode.NIGHT
        radioPreferences.setThemeMode(nextMode)
        _uiState.update { it.copy(themeMode = nextMode) }
    }

    /** Day/night hardware key pressed: IRC590 hold flips display; TM7 hold toggles scan. */
    private fun onDayNightKeyDown() {
        dayNightFlippedThisHold = false
        dayNightScanToggledThisHold = false
        dayNightHoldJob?.cancel()
        val profile = _uiState.value.resolvedDeviceProfile
        dayNightHoldJob = viewModelScope.launch {
            delay(
                when (profile) {
                    ResolvedDeviceProfile.IRC590 -> DAY_NIGHT_HOLD_FLIP_MS
                    ResolvedDeviceProfile.TM7_PLUS -> TM7_HOLD_ACTION_MS
                    else -> TM7_HOLD_ACTION_MS
                },
            )
            when (profile) {
                ResolvedDeviceProfile.IRC590 -> {
                    dayNightFlippedThisHold = true
                    flipDisplay180()
                }
                ResolvedDeviceProfile.TM7_PLUS -> {
                    dayNightScanToggledThisHold = true
                    onTm7ScanLongPressToggle()
                }
                else -> Unit
            }
        }
    }

    /** Day/night hardware key released: quick tap toggles theme unless a long-press action fired. */
    private fun onDayNightKeyUp() {
        dayNightHoldJob?.cancel()
        dayNightHoldJob = null
        if (dayNightFlippedThisHold || dayNightScanToggledThisHold) {
            dayNightFlippedThisHold = false
            dayNightScanToggledThisHold = false
            return
        }
        applyDayNightToggle()
    }

    private fun onPlayLastKeyDown() {
        replayHistoryToggledThisHold = false
        replayHoldJob?.cancel()
        if (_uiState.value.resolvedDeviceProfile != ResolvedDeviceProfile.TM7_PLUS) {
            return
        }
        replayHoldJob = viewModelScope.launch {
            delay(TM7_HOLD_ACTION_MS)
            replayHistoryToggledThisHold = true
            toggleMessageHistory()
        }
    }

    private fun onPlayLastKeyUp() {
        replayHoldJob?.cancel()
        replayHoldJob = null
        if (replayHistoryToggledThisHold) {
            replayHistoryToggledThisHold = false
            return
        }
        playLastTransmission()
    }

    private fun onTm7ScanLongPressToggle() {
        soundPlayer.playChannelSwitch()
        val next = onScanSoftKeyToggle(_uiState.value)
        val showPicker = next.scanActive && next.channelCatalog.size > 1
        _uiState.update {
            next.copy(
                scanPickerVisible = showPicker,
                statusMessage = if (next.scanActive) "SCAN ON" else "SCAN OFF",
            )
        }
        reconcileVoiceTransport()
    }

    private fun disableScan() {
        soundPlayer.playChannelSwitch()
        scanRxBannerClearJob?.cancel()
        _uiState.update {
            it.copy(
                scanActive = false,
                scanPickerVisible = false,
                scanIncludedChannelIndices = emptySet(),
                scanBackgroundActive = false,
                scanBackgroundChannel = "",
                statusMessage = "SCAN OFF",
            )
        }
        reconcileVoiceTransport()
    }

    private fun onScanVoiceHeard(channelName: String) {
        val label = channelName.trim().uppercase(Locale.US)
        if (label.isEmpty()) return
        val snap = _uiState.value
        if (!snap.scanActive) return
        val included = snap.scanIncludedChannelIndices
            .mapNotNull { ix -> snap.channelCatalog.getOrNull(ix)?.trim() }
            .any { channelNamesMatch(it, channelName) }
        if (!included) return
        if (channelNamesMatch(channelName, snap.channelLabel)) return
        scanRxBannerClearJob?.cancel()
        _uiState.update {
            it.copy(
                scanBackgroundActive = true,
                scanBackgroundChannel = label,
                statusMessage = "SCAN RX · $label",
            )
        }
        scanRxBannerClearJob = viewModelScope.launch {
            delay(SCAN_RX_BANNER_HOLD_MS)
            _uiState.update { s ->
                if (s.scanBackgroundChannel.equals(label, ignoreCase = true)) {
                    s.copy(
                        scanBackgroundActive = false,
                        scanBackgroundChannel = "",
                        statusMessage = if (s.scanActive) "SCAN ON" else "SCAN OFF",
                    )
                } else {
                    s
                }
            }
        }
    }

    /** Rotates the whole LCD 180° (IRC590 day/night key long-press) and persists it. */
    private fun flipDisplay180() {
        val next = !_uiState.value.displayRotated180
        radioPreferences.setDisplayRotated180(next)
        soundPlayer.playChannelSwitch()
        _uiState.update {
            it.copy(
                displayRotated180 = next,
                statusMessage = if (next) "DISPLAY FLIPPED 180" else "DISPLAY UPRIGHT",
            )
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
            RadioUiEvent.ToggleDayNight -> applyDayNightToggle()
            is RadioUiEvent.SystemDarkChanged -> {
                systemDark = event.dark
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
            RadioUiEvent.ToggleScanLongPress -> onTm7ScanLongPressToggle()
            RadioUiEvent.DisableScan -> disableScan()
            RadioUiEvent.ToggleScanSoftKey -> {
                soundPlayer.playChannelSwitch()
                _uiState.update { onScanSoftKeyToggle(it) }
                reconcileVoiceTransport()
            }
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
                        if (event.index == 2) {
                            reconcileVoiceTransport()
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
            RadioUiEvent.CheckForUpdates -> {
                soundPlayer.playChannelSwitch()
                _uiState.update { it.copy(statusMessage = "CHECKING FOR UPDATES…") }
                appUpdater.checkAndInstallAsync(force = true, manual = true)
                viewModelScope.launch {
                    delay(VERSION_BANNER_MS)
                    _uiState.update {
                        if (it.statusMessage == "CHECKING FOR UPDATES…") it.copy(statusMessage = "") else it
                    }
                }
            }
            RadioUiEvent.DismissSetupDialog -> {
                _uiState.update { it.copy(setupDialogDismissed = true) }
            }
            RadioUiEvent.DismissUpdateInstalledNotice -> {
                _uiState.update { it.copy(updateInstalledNotice = null) }
            }
            is RadioUiEvent.SelectSettingsTab -> {
                val targetIndex = event.index.coerceIn(0, 3)
                // Leaving the BUTTONS tab while a mapping session is armed would otherwise
                // capture the next physical keypress silently and write it to the previously
                // selected action — cancel the listener so the user has to re-arm explicitly.
                val leavingButtonsTab =
                    targetIndex != 0 && _uiState.value.currentlyMappingAction != null
                if (leavingButtonsTab) {
                    mappingJob?.cancel()
                }
                _uiState.update {
                    it.copy(
                        settingsTabIndex = targetIndex,
                        currentlyMappingAction = if (leavingButtonsTab) null else it.currentlyMappingAction,
                    )
                }
            }
            is RadioUiEvent.SetMicNoiseSuppression -> {
                radioPreferences.setNoiseSuppressionEnabled(event.enabled)
                _uiState.update { it.copy(micNoiseSuppressionEnabled = event.enabled) }
            }
            is RadioUiEvent.SetMicAutoGain -> {
                radioPreferences.setMicAutoGainEnabled(event.enabled)
                _uiState.update { it.copy(micAutoGainEnabled = event.enabled) }
            }
            is RadioUiEvent.SetMicGainMultiplier -> {
                val clamped = event.multiplier
                    .coerceIn(RadioPreferences.MIN_MIC_GAIN, RadioPreferences.MAX_MIC_GAIN)
                radioPreferences.setMicGainMultiplier(clamped)
                _uiState.update { it.copy(micGainMultiplier = clamped) }
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
                        needsAccessibilityService = event.needsAccessibility,
                        needsLocationPermission = event.needsLocation,
                        needsGpsEnabled = event.needsGpsEnabled,
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
            RadioUiEvent.ToggleMessageHistory -> toggleMessageHistory()
            RadioUiEvent.CloseMessageHistory -> closeMessageHistory()
            is RadioUiEvent.PlayHistoryMessage -> playHistoryMessage(event.entryId)
            is RadioUiEvent.SaveAgencyRadioKey -> {
                val key = event.key.trim()
                radioPreferences.setAgencyRadioKey(key)
                // REST picks up the key per request; voice must drop its socket
                // to stop using the previous agency's key on the live stream.
                voiceRelay.reconnect()
                // The new agency has its own tone set — pull it now, and forget
                // the previous agency's version so the next poll re-baselines.
                lastSoundsVersion = null
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
            RadioUiEvent.RequestLocationPermission -> Unit
            RadioUiEvent.OpenLocationSettings -> Unit
            RadioUiEvent.OpenGpsSettings -> Unit
            RadioUiEvent.MoveMp22ToPhysicalDisplay -> {
                soundPlayer.playChannelSwitch()
                DisplayRouter.moveToPhysicalDisplay(application)
            }
            RadioUiEvent.MoveMp22ToVirtualSetupDisplay -> {
                soundPlayer.playChannelSwitch()
                DisplayRouter.moveToVirtualSetupDisplay(application)
            }
            RadioUiEvent.SignOut -> Unit // Handled in MainActivity (clears session and shows login)
        }
    }

    fun onOverlayPermissionResult(granted: Boolean) {
        _uiState.update { it.copy(needsOverlayPermission = !granted) }
    }

    private fun toggleMessageHistory() {
        soundPlayer.playChannelSwitch()
        if (_uiState.value.messageHistoryVisible) {
            closeMessageHistory()
        } else {
            openMessageHistory()
        }
    }

    private fun openMessageHistory() {
        rxMessageHistory.stopReplay()
        _uiState.update {
            it.copy(
                messageHistoryVisible = true,
                rxMessageHistory = emptyList(),
                historyPlayingId = null,
                historyPlaybackPaused = false,
                statusMessage = "MESSAGE HISTORY",
            )
        }
        viewModelScope.launch {
            val items = buildHistoryItems()
            if (!_uiState.value.messageHistoryVisible) return@launch
            _uiState.update { it.copy(rxMessageHistory = items) }
            startHistoryTranscriptPolling()
        }
    }

    private fun closeMessageHistory() {
        historyTranscriptPollJob?.cancel()
        historyTranscriptPollJob = null
        rxMessageHistory.stopReplay()
        historyPlayJob?.cancel()
        cancelReplayBanner()
        _uiState.update {
            it.copy(
                messageHistoryVisible = false,
                historyPlayingId = null,
                historyPlaybackPaused = false,
                statusMessage = "",
            )
        }
    }

    private suspend fun fetchServerTransmissions(): List<RadioTransmissionDto> =
        try {
            radioApi.recentTransmissions(limit = 80).transmissions
        } catch (_: Exception) {
            emptyList()
        }

    private suspend fun buildHistoryItems(): List<RxMessageHistoryItem> {
        val fmt = SimpleDateFormat("HH:mm", Locale.US)
        val online = _uiState.value.networkLabel == "ONLINE"
        val serverTx = fetchServerTransmissions()
        return rxMessageHistory.snapshot().map { entry ->
            val who = entry.caption.trim()
            RxMessageHistoryItem(
                id = entry.id,
                timeLabel = fmt.format(Date(entry.capturedAtMs)),
                channelName = entry.channelName.ifBlank { "—" },
                caption = who,
                transcript = TransmissionTranscriptMatcher.resolveTranscript(entry, serverTx, online),
                durationMs = entry.durationMs,
            )
        }
    }

    private fun startHistoryTranscriptPolling() {
        historyTranscriptPollJob?.cancel()
        historyTranscriptPollJob = viewModelScope.launch {
            var attempts = 0
            while (isActive && _uiState.value.messageHistoryVisible && attempts < 24) {
                delay(if (attempts == 0) 1_500L else 2_500L)
                attempts++
                if (!_uiState.value.messageHistoryVisible) break
                val items = buildHistoryItems()
                _uiState.update { it.copy(rxMessageHistory = items) }
                val stillPending = items.any { row ->
                    row.transcript.equals("Transcribing…", ignoreCase = true) ||
                        row.transcript.contains("waiting for transcript", ignoreCase = true) ||
                        row.transcript.contains("Loading transcript", ignoreCase = true)
                }
                if (!stillPending) break
            }
        }
    }

    private suspend fun refreshHistoryTranscriptForEntry(entryId: Long) {
        if (!_uiState.value.messageHistoryVisible) return
        val serverTx = fetchServerTransmissions()
        val entry = rxMessageHistory.snapshot().firstOrNull { it.id == entryId } ?: return
        val transcript = TransmissionTranscriptMatcher.resolveTranscript(
            entry,
            serverTx,
            _uiState.value.networkLabel == "ONLINE",
        )
        _uiState.update { state ->
            if (!state.messageHistoryVisible) return@update state
            state.copy(
                rxMessageHistory = state.rxMessageHistory.map { row ->
                    if (row.id == entryId) row.copy(transcript = transcript) else row
                },
            )
        }
    }

    private fun playHistoryMessage(entryId: Long) {
        when {
            rxMessageHistory.isPlaying(entryId) -> {
                rxMessageHistory.pauseReplay()
                historyPlayJob?.cancel()
                _uiState.update {
                    it.copy(historyPlaybackPaused = true, statusMessage = "PAUSED")
                }
                return
            }
            rxMessageHistory.isPaused(entryId) -> {
                rxMessageHistory.resumeReplay()
                _uiState.update {
                    it.copy(historyPlaybackPaused = false, statusMessage = "REPLAY AUDIO")
                }
                return
            }
        }
        rxMessageHistory.stopReplay()
        historyPlayJob?.cancel()
        val durationMs = rxMessageHistory.play(entryId) {
            viewModelScope.launch {
                replayJob?.cancel()
                _uiState.update {
                    it.copy(
                        replayBanner = "",
                        historyPlayingId = null,
                        historyPlaybackPaused = false,
                    )
                }
            }
        }
        if (durationMs <= 0L) {
            soundPlayer.playChannelSwitch()
            _uiState.update {
                it.copy(
                    statusMessage = "NO AUDIO FOR MESSAGE",
                    historyPlayingId = null,
                    historyPlaybackPaused = false,
                )
            }
            return
        }
        val label = _uiState.value.rxMessageHistory.firstOrNull { it.id == entryId }?.caption.orEmpty()
        val banner =
            if (label.isNotBlank()) "REPLAY  $label" else "REPLAYING MESSAGE"
        _uiState.update {
            it.copy(
                historyPlayingId = entryId,
                historyPlaybackPaused = false,
                statusMessage = "REPLAY AUDIO",
            )
        }
        showReplayBanner(banner, durationMs)
        viewModelScope.launch { pollHistoryEntryTranscript(entryId) }
    }

    private suspend fun pollHistoryEntryTranscript(entryId: Long) {
        repeat(12) {
            refreshHistoryTranscriptForEntry(entryId)
            val row = _uiState.value.rxMessageHistory.firstOrNull { it.id == entryId }
            val pending =
                row?.transcript.equals("Transcribing…", ignoreCase = true) == true ||
                    row?.transcript?.contains("waiting for transcript", ignoreCase = true) == true ||
                    row?.transcript?.contains("Loading transcript", ignoreCase = true) == true
            if (!pending) return
            delay(2_500)
        }
    }

    private fun playLastTransmission() {
        if (_uiState.value.messageHistoryVisible) {
            closeMessageHistory()
            return
        }
        val durationMs = lastRxAudioRecorder.playLast()
        if (durationMs > 0L) {
            showReplayBanner(replayBannerText(_uiState.value), durationMs)
            viewModelScope.launch { loadReplayTranscript(durationMs) }
            return
        }
        soundPlayer.playChannelSwitch()
        cancelReplayBanner()
        _uiState.update { it.copy(statusMessage = "NO LAST RX AUDIO") }
    }

    /** Shows the replay banner and schedules dismiss; only the latest replay generation may clear it. */
    private suspend fun loadReplayTranscript(playbackDurationMs: Long, attempt: Int = 0) {
        if (attempt > 12) return
        val snap = _uiState.value
        if (snap.replayBanner.isEmpty()) return
        val local = rxMessageHistory.snapshot().firstOrNull()
        val serverTx = fetchServerTransmissions()
        val transcript =
            TransmissionTranscriptMatcher.resolveReplayTranscript(
                channelLabel = snap.channelLabel,
                durationMs = playbackDurationMs,
                caption = snap.lastRxReplayCaption,
                capturedAtMs = System.currentTimeMillis(),
                serverTx = serverTx,
                localEntry = local,
            )
        if (transcript.isBlank()) return
        _uiState.update { state ->
            if (state.replayBanner.isEmpty()) state
            else state.copy(replayTranscript = transcript)
        }
        val pending =
            transcript == "Transcribing…" ||
                transcript.contains("waiting for transcript", ignoreCase = true)
        if (pending) {
            delay(2_500)
            if (_uiState.value.replayBanner.isEmpty()) return
            loadReplayTranscript(playbackDurationMs, attempt + 1)
        }
    }

    private fun showReplayBanner(text: String, durationMs: Long) {
        replayJob?.cancel()
        val generation = ++replayBannerGeneration
        _uiState.update {
            it.copy(statusMessage = "REPLAY AUDIO", replayBanner = text, replayTranscript = "")
        }
        val dismissAfterMs = maxOf(
            durationMs.coerceAtLeast(250L) + REPLAY_BANNER_PAD_MS,
            REPLAY_BANNER_MIN_MS,
        )
        replayJob = viewModelScope.launch {
            delay(dismissAfterMs)
            dismissReplayBanner(clearHistoryPlayingId = true, expectedGeneration = generation)
        }
    }

    private fun dismissReplayBanner(clearHistoryPlayingId: Boolean, expectedGeneration: Int) {
        if (expectedGeneration != replayBannerGeneration) return
        _uiState.update { state ->
            state.copy(
                replayBanner = "",
                replayTranscript = "",
                historyPlayingId = if (clearHistoryPlayingId) null else state.historyPlayingId,
                historyPlaybackPaused = if (clearHistoryPlayingId) false else state.historyPlaybackPaused,
            )
        }
    }

    private fun cancelReplayBanner() {
        ++replayBannerGeneration
        replayJob?.cancel()
        replayJob = null
        _uiState.update {
            it.copy(
                replayBanner = "",
                replayTranscript = "",
                historyPlayingId = null,
                historyPlaybackPaused = false,
            )
        }
    }

    /** "Who was talking" caption for the replay banner, from the last RX attribution. */
    private fun replayBannerText(state: RadioUiState): String {
        val who = state.lastRxReplayCaption.trim()
            .removePrefix("RX:")
            .removePrefix("RX")
            .trim()
        return if (who.isNotEmpty()) "REPLAY  $who" else "REPLAYING LAST MESSAGE"
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

    /** SCAN soft key toggles scan; enabling starts with no side channels until the user picks them. */
    private fun onScanSoftKeyToggle(state: RadioUiState): RadioUiState {
        val turningOn = !state.scanActive
        val nextScanOn = turningOn
        val newIncludes = if (nextScanOn) emptySet() else state.scanIncludedChannelIndices
        val status = when {
            !nextScanOn -> "SCAN OFF"
            newIncludes.isEmpty() -> "SCAN ON — PICK CHANNELS"
            else -> "SCAN ON"
        }
        return state.copy(
            scanActive = nextScanOn,
            scanIncludedChannelIndices = newIncludes,
            scanBackgroundActive = if (nextScanOn) state.scanBackgroundActive else false,
            scanBackgroundChannel = if (nextScanOn) state.scanBackgroundChannel else "",
            statusMessage = status,
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
        reconcileVoiceTransport()
    }

    private fun onPttPressed() {
        // Refuse PTT locally on listen-only channels: no relay attempt, no
        // talk-permit tone, just the busy alert and a clear status line. The
        // server would reject anyway, but doing it here keeps the UX honest.
        if (currentPermission() == ChannelPermission.LISTEN_ONLY) {
            pttToneJob?.cancel()
            soundPlayer.startBusyLoop()
            _uiState.update { snap ->
                snap.copy(
                    isPttPressed = true,
                    pttOnAir = false,
                    pttBusyTone = true,
                    statusMessage = "LISTEN ONLY",
                    micHint = "MIC: LISTEN ONLY",
                    activeTalkUnitId = "",
                    activeTalkDisplayName = "",
                )
            }
            return
        }
        // A re-key during the post-release drain window owns the mic again —
        // invalidate the pending drain so it can't stop the new hold's capture.
        pttHoldGeneration += 1
        pttReleaseDrainJob?.cancel()
        pttReleaseDrainJob = null
        pttMicCapture.stopCapture()
        pttMicLiveThisHold = false
        _uiState.update { snap ->
            val (talkUnit, talkName) = localTalkAttribution(snap)
            snap.copy(
                isPttPressed = true,
                pttOnAir = false,
                pttBusyTone = false,
                statusMessage = "AIR: CHECKING",
                micHint = "MIC: STANDBY",
                activeTalkUnitId = talkUnit,
                activeTalkDisplayName = talkName,
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
                val txReady = voiceRelay.isTransmitPathReady()

                val statusHint = computePttStatus(
                    online = online,
                    useBusy = useBusy,
                    micGranted = mic,
                    micLive = micLive,
                    txReady = txReady,
                    stableEnough = audioStableCount >= AIR_AUDIO_STABLE_POLLS,
                    busyPeerUnit = busyPeerHighlight,
                )

                _uiState.update { s ->
                    val nextMicHint = micHintForPtt(micGranted = mic, micLive = micLive)
                    s.copy(
                        pttBusyTone = useBusy,
                        // Green only when audio is genuinely leaving the radio:
                        // permit verified, mic capturing, and the socket ready.
                        pttOnAir = micLive && mic && !useBusy && txReady,
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
                        voiceRelay.releaseTransmitHold()
                        pttMicLiveThisHold = false
                        _uiState.update { it.copy(pttOnAir = false) }
                        if (online) {
                            soundPlayer.startBusyLoop()
                        } else {
                            soundPlayer.stopBusyLoop()
                        }
                    } else {
                        soundPlayer.stopBusyLoop()
                        if (!micLive) {
                            soundPlayer.playTalkPermitThen(
                                onFinished = { grantMicrophoneAfterVerification() },
                                onStarted = {
                                    pulsePttTransmitHapticIfEligible()
                                    prewarmMicDuringPermitTone()
                                },
                            )
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
        txReady: Boolean,
        stableEnough: Boolean,
        busyPeerUnit: String? = null,
    ): String {
        return when {
            useBusy && !online -> "NO CONNECTION"
            useBusy -> {
                val peer = busyPeerUnit?.trim()?.takeIf { it.isNotEmpty() }?.uppercase(Locale.US)
                if (peer != null) "CHANNEL BUSY — $peer" else "CHANNEL BUSY"
            }
            // Mic is live but the voice socket can't carry frames — the REST
            // air probe and the relay WebSocket are separate paths, so call
            // this state out instead of letting it read as on-air.
            micLive && !txReady -> "LINK CONNECTING"
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
        if (air.transmittingYields) return false
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

    /** 100 ms vibrate, 100 ms after permit audio starts (all devices with a vibrator). */
    private fun pulsePttTransmitHapticIfEligible() {
        if (!pttHapticFeedback.hasVibrator()) return
        val s = _uiState.value
        if (s.networkLabel == "ONLINE" && s.micPermissionGranted) {
            pttHapticFeedback.pulseTransmitGranted()
        }
    }

    /**
     * Spin the mic up while the talk-permit tone is still playing — capture
     * starts gated (read-and-discard, no sidetone) so nothing ships during
     * the tone, but AudioRecord init + voice-effect attach + the first device
     * buffer fill all complete before the tone ends. Without this, capture
     * began only after the tone and operators lost the first syllable to
     * startup latency.
     */
    private fun prewarmMicDuringPermitTone() {
        viewModelScope.launch {
            val s = _uiState.value
            if (!s.isPttPressed || s.pttBusyTone || !s.micPermissionGranted) return@launch
            if (pttMicLiveThisHold) return@launch
            pttMicCapture.startCapture(holdUplink = true)
        }
    }

    private fun grantMicrophoneAfterVerification() {
        viewModelScope.launch {
            val s = _uiState.value
            if (!s.isPttPressed || s.pttBusyTone) return@launch
            if (pttMicLiveThisHold) return@launch
            pttMicLiveThisHold = true
            if (s.micPermissionGranted) {
                if (pttMicCapture.isCapturing) {
                    // Pre-warmed during the permit tone — open the gate; audio
                    // flows from this exact instant.
                    pttMicCapture.setUplinkHold(false)
                } else {
                    pttMicCapture.startCapture()
                }
            }
            val txReady = voiceRelay.isTransmitPathReady()
            _uiState.update { cur ->
                cur.copy(
                    pttOnAir = txReady && cur.micPermissionGranted,
                    statusMessage = when {
                        !txReady -> "LINK CONNECTING"
                        cur.micPermissionGranted -> "TX + MIC"
                        else -> "TX (NO MIC)"
                    },
                    micHint = if (cur.micPermissionGranted) "MIC: MONITOR ON" else "MIC: ALLOW MIC",
                )
            }
        }
    }

    private fun onPttReleased() {
        val micWasLive = pttMicLiveThisHold
        pttMicLiveThisHold = false
        pttToneJob?.cancel()
        pttToneJob = null
        soundPlayer.stopTalkPermitLoop()
        soundPlayer.stopBusyLoop()
        val granted = _uiState.value.micPermissionGranted
        _uiState.update {
            it.copy(
                isPttPressed = false,
                pttOnAir = false,
                pttBusyTone = false,
                statusMessage = "RX IDLE",
                micHint = if (granted) "MIC: READY" else "MIC: ALLOW MIC",
                activeTalkUnitId = "",
                activeTalkDisplayName = "",
            )
        }
        if (!micWasLive) {
            // Never made the air this hold — nothing buffered worth draining.
            pttMicCapture.stopCapture()
            voiceRelay.releaseTransmitHold()
            return
        }
        // Operators were losing the last ~0.5 s of every transmission: the
        // word spoken at release is still in the AudioRecord pipeline, and the
        // old immediate stop discarded it (plus the staged fractional frame).
        // Keep capturing briefly so it drains through the encoder, then flush
        // the partial frame and release the air. A re-key bumps the
        // generation and cancels this job, so it can't stop a newer hold's mic.
        val generation = pttHoldGeneration
        pttReleaseDrainJob?.cancel()
        pttReleaseDrainJob = viewModelScope.launch {
            delay(TX_RELEASE_TAIL_MS)
            if (generation != pttHoldGeneration) return@launch
            pttMicCapture.stopCapture()
            voiceRelay.finishTransmitHold()
        }
    }

    private fun toggleEmergency() {
        val activating = !_uiState.value.isEmergencyActive
        if (activating) {
            soundPlayer.playEmergencyAlert()
        }
        _uiState.update { snap ->
            val (talkUnit, talkName) = if (activating) {
                localTalkAttribution(snap)
            } else {
                "" to ""
            }
            snap.copy(
                isEmergencyActive = activating,
                statusMessage = if (activating) "EMERGENCY ACTIVE" else "EMERGENCY OFF",
                activeTalkUnitId = talkUnit,
                activeTalkDisplayName = talkName,
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
        if (granted) {
            locationReporter.start()
        } else {
            locationReporter.stop()
        }
        refreshLocationSetupState()
    }

    private fun refreshLocationSetupState() {
        val needsLocation = !locationReporter.hasPermission()
        val needsGps =
            locationReporter.hasPermission() && !locationReporter.isLocationEnabled()
        val snap = _uiState.value
        if (
            snap.needsLocationPermission != needsLocation ||
            snap.needsGpsEnabled != needsGps
        ) {
            _uiState.update {
                it.copy(
                    needsLocationPermission = needsLocation,
                    needsGpsEnabled = needsGps,
                )
            }
        }
        if (locationReporter.hasPermission() && locationReporter.isLocationEnabled()) {
            locationReporter.start()
        }
    }

    /**
     * Tunes to a channel by name (used by dispatcher live-move). A just-created
     * channel — e.g. an emergency channel — may not be in this radio's catalog
     * yet, so it's appended so the knob can land on it; a later catalog sync
     * reconciles the list.
     */
    private fun tuneToChannelByName(name: String) {
        val trimmed = name.trim()
        if (trimmed.isEmpty()) {
            return
        }
        var idx = channelNames.indexOfFirst { it.equals(trimmed, ignoreCase = true) }
        if (idx < 0) {
            channelNames = channelNames + trimmed
            idx = channelNames.lastIndex
        }
        channelIndex = idx
        _uiState.update {
            it.withTuning(channelNames, channelIndex).pruneScanSets().copy(
                currentChannelPermission = currentPermission(),
            )
        }
        viewModelScope.launch { pulsePresenceHeartbeatAndCount(expectOnline = true) }
        reconcileVoiceTransport()
    }

    private fun bumpChannel(delta: Int) {
        if (channelNames.isEmpty() || _uiState.value.channelsLoading) {
            return
        }
        channelIndex = (channelIndex + delta + channelNames.size) % channelNames.size
        val tunedLabel = channelNames[channelIndex]
        // Beep first, then announce the channel name — the TTS engine ran in parallel before, so
        // the spoken name and the beep overlapped. The callback fires on the main thread after
        // the WAV ends, which sequences them naturally.
        soundPlayer.playChannelSwitch {
            speechHelper.speakChannelTuneIfEnabled(tunedLabel)
        }
        _uiState.update {
            it.withTuning(channelNames, channelIndex).pruneScanSets().copy(
                statusMessage = "CHANNEL ${if (delta > 0) "+" else "-"}",
                currentChannelPermission = currentPermission(),
            )
        }
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
        channelPermissions = catalog.permissions
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
                currentChannelPermission = currentPermission(),
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

    /** Align voice WebSockets with tuned channel, scan list, and link state. */
    private fun reconcileVoiceTransport() {
        val s = _uiState.value
        voiceRelay.updateVoiceTarget(
            unitIdUpper = unitIdUpper,
            channelLabel = s.channelLabel,
            networkOnline = s.networkLabel == "ONLINE",
        )
        val scanNames = if (s.scanActive) {
            s.scanIncludedChannelIndices
                .mapNotNull { ix -> s.channelCatalog.getOrNull(ix)?.trim() }
                .filter { it.isNotEmpty() }
                .toSet()
        } else {
            emptySet()
        }
        scanVoiceListen.updateScanListen(
            unitIdUpper = unitIdUpper,
            homeChannel = s.channelLabel,
            scanChannels = scanNames,
            networkOnline = s.networkLabel == "ONLINE",
            scanActive = s.scanActive,
        )
        locationReporter.setChannel(s.channelLabel)
    }

    /**
     * Polls the server for pages and dispatch emergencies addressed to this unit/channel.
     * The first batch is consumed silently to prime the cursor — only later alerts notify.
     */
    /**
     * Picks up channel-list changes pushed from the control portal without
     * waiting for a restart — new channels appear on the knob within a few
     * seconds of being assigned, and channels removed on the portal drop off.
     * Silent: the catalog is only re-applied when the names actually change.
     */
    private suspend fun pollChannelCatalog() {
        while (currentCoroutineContext().isActive) {
            delay(CATALOG_POLL_MS)
            // Config refresh only matters when someone is looking at the radio.
            // Off-screen the catalog re-syncs on the next foreground tick; skip
            // the network call to save cellular data.
            if (!mainRadioUiVisible) continue
            if (_uiState.value.channelsLoading) continue
            val fresh = try {
                channelRepository.loadCatalog()
            } catch (_: Exception) {
                null
            } ?: continue
            if (fresh.origin != ChannelCatalogOrigin.NETWORK) continue
            val sameNames = fresh.channels == channelNames
            val samePermissions = fresh.permissions == channelPermissions
            if (sameNames && samePermissions) continue
            applyCatalogChange(fresh.channels, fresh.permissions)
        }
    }

    /**
     * Picks up display-name and unit-id edits made on the portal — handsets
     * stay in sync without a sign-out / sign-in. A disabled or deleted account
     * comes back as 401 from this endpoint and the existing authExpired flow
     * then signs the radio out for us.
     */
    private suspend fun pollProfile() {
        while (currentCoroutineContext().isActive) {
            delay(PROFILE_POLL_MS)
            // Display-name / unit-id edits are rare and only need to show when
            // the screen is up; skip the poll off-screen to save data.
            if (!mainRadioUiVisible) continue
            val me = try {
                radioApi.me()
            } catch (_: Exception) {
                null
            } ?: continue
            applyProfileUpdate(me.user)
        }
    }

    /** Apply a portal-side profile change to local prefs and downstream services. */
    private fun applyProfileUpdate(user: SessionUserDto) {
        val newDisplay = user.displayName.trim()
        val newUnit = user.unitId?.trim()?.uppercase(Locale.US).orEmpty()
        val currentDisplay = radioPreferences.getSessionDisplayName()
        val currentUnit = radioPreferences.getSessionUnitId()
        if (newDisplay == currentDisplay && newUnit == currentUnit) return
        if (newDisplay.isNotEmpty()) {
            radioPreferences.setSessionDisplayName(newDisplay)
        }
        if (newUnit.isNotEmpty()) {
            radioPreferences.setSessionUnitId(newUnit)
            localUnitIdentifier.setShortUnitId(newUnit)
        }
        val refreshed = unitIdUpper
        _uiState.update {
            it.copy(
                localShortUnitId = refreshed,
                sessionDisplayName = radioPreferences.getSessionDisplayName(),
                sessionUsername = radioPreferences.getSessionUsername(),
                sessionAgencyName = radioPreferences.getSessionAgencyName().ifBlank {
                    radioPreferences.getSessionAgencySlug()
                },
            )
        }
        locationReporter.configure(refreshed)
        reconcileVoiceTransport()
    }

    /** Replace the live catalog and permissions, keeping the tuned channel if it still exists. */
    private fun applyCatalogChange(
        incoming: List<String>,
        incomingPermissions: Map<String, ChannelPermission>,
    ) {
        if (incoming.isEmpty()) return
        val tunedName = channelNames
            .getOrNull(channelIndex.coerceIn(0, channelNames.lastIndex.coerceAtLeast(0)))
        channelNames = incoming
        channelPermissions = incomingPermissions
        channelIndex = tunedName
            ?.let { name -> incoming.indexOfFirst { it.equals(name, ignoreCase = true) } }
            ?.takeIf { it >= 0 }
            ?: channelIndex.coerceIn(0, incoming.lastIndex)
        _uiState.update {
            it.withTuning(channelNames, channelIndex).pruneScanSets().copy(
                channelSourceLabel = "NETWORK",
                channelSyncError = null,
                networkLabel = "ONLINE",
                displayLine3 = "CHANNELS: NETWORK OK",
                currentChannelPermission = currentPermission(),
            )
        }
        reconcileVoiceTransport()
        pulsePresenceFromCurrentState(clearWhenOffline = false)
    }

    /** Lookup the tuned channel's permission; defaults to TALK when nothing matches. */
    private fun currentPermission(): ChannelPermission {
        if (channelNames.isEmpty()) return ChannelPermission.TALK
        val name = channelNames[channelIndex.coerceIn(0, channelNames.lastIndex)]
        return channelPermissions[name.lowercase(Locale.US)] ?: ChannelPermission.TALK
    }

    private fun permissionsForCatalog(names: List<String>): List<ChannelPermission> =
        names.map { name ->
            channelPermissions[name.trim().lowercase(Locale.US)] ?: ChannelPermission.TALK
        }

    /**
     * Watches the agency's tone-set version and re-pulls the custom tones when
     * an admin uploads or removes one, so a running handset never keeps stale
     * tones until the next restart. The first reading just sets the baseline —
     * startup already pulls the tones once.
     */
    private suspend fun pollSoundsVersion() {
        while (currentCoroutineContext().isActive) {
            delay(SOUNDS_VERSION_POLL_MS)
            // Tone-set changes are very rare; only check while on-screen.
            if (!mainRadioUiVisible) continue
            val version = withContext(Dispatchers.IO) {
                runCatching { customSoundDownloader.fetchVersion() }.getOrNull()
            } ?: continue
            val previous = lastSoundsVersion
            lastSoundsVersion = version
            if (previous != null && previous != version) {
                customSoundDownloader.refreshAsync()
            }
        }
    }

    private suspend fun pollInbox() {
        var since = 0L
        var primed = false
        while (currentCoroutineContext().isActive) {
            delay(if (mainRadioUiVisible) INBOX_POLL_MS else INBOX_BG_POLL_MS)
            if (_uiState.value.networkLabel != "ONLINE") continue
            val channel = _uiState.value.channelLabel.trim().takeUnless { it.isEmpty() || it == "----" }
            val response = try {
                radioApi.inbox(unit = unitIdUpper, channel = channel, since = since)
            } catch (_: Exception) {
                null
            } ?: continue
            val ten33Active = channel != null && response.ten33.any {
                channelNamesMatch(it, channel)
            }
            val wasTen33 = _uiState.value.channelTen33
            if (ten33Active != wasTen33) {
                _uiState.update { snap ->
                    snap.copy(
                        channelTen33 = ten33Active,
                        // Marker tones could leave RX/talker hints on screen; clear when 10-33 ends.
                        rxAttributedLine =
                            if (wasTen33 && !ten33Active) "" else snap.rxAttributedLine,
                        activeTalkUnitId =
                            if (wasTen33 && !ten33Active) "" else snap.activeTalkUnitId,
                        activeTalkDisplayName =
                            if (wasTen33 && !ten33Active) "" else snap.activeTalkDisplayName,
                        rxFromScan = if (wasTen33 && !ten33Active) false else snap.rxFromScan,
                    )
                }
            }
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
                channelCatalogPermissions = emptyList(),
            )
        }
        val maxI = channelNames.lastIndex
        val homeIdx = channelIndex.coerceIn(0, maxI)
        val pruned = scanIncludedChannelIndices
            .filter { it in 0..maxI && it != homeIdx }
            .toSet()
        return copy(
            channelCatalog = channelNames,
            channelCatalogPermissions = permissionsForCatalog(channelNames),
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
                channelCatalogPermissions = emptyList(),
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
            channelCatalogPermissions = permissionsForCatalog(names),
        )
    }

    private suspend fun pollTalkHints() {
        while (currentCoroutineContext().isActive) {
            val snapBefore = _uiState.value
            val visible = mainRadioUiVisible
            val fastPoll =
                visible &&
                    (
                        snapBefore.rxAttributedLine.isNotEmpty() ||
                            snapBefore.activeTalkUnitId.isNotEmpty() ||
                            snapBefore.isPttPressed
                        )
            delay(
                when {
                    fastPoll -> TALK_ACTIVITY_FAST_POLL_MS
                    visible -> TALK_ACTIVITY_POLL_MS
                    else -> TALK_ACTIVITY_BG_POLL_MS
                },
            )
            if (_uiState.value.networkLabel == "OFFLINE") {
                if (_uiState.value.rxAttributedLine.isNotEmpty() ||
                    _uiState.value.activeTalkUnitId.isNotEmpty()
                ) {
                    _uiState.update {
                        it.copy(
                            rxAttributedLine = "",
                            activeTalkUnitId = "",
                            activeTalkDisplayName = "",
                        )
                    }
                }
                continue
            }
            val snap = _uiState.value
            val chParam =
                snap.channelLabel.trim().takeUnless { it.isEmpty() || it == "----" }
            val scanParam = if (snap.scanActive) {
                snap.scanIncludedChannelIndices
                    .mapNotNull { ix -> snap.channelCatalog.getOrNull(ix)?.trim() }
                    .filter { name ->
                        name.isNotEmpty() &&
                            !channelNamesMatch(name, snap.channelLabel)
                    }
                    .joinToString(",")
                    .takeIf { it.isNotEmpty() }
            } else {
                null
            }
            val dto = try {
                channelsApi.talkActivity(home = chParam, scan = scanParam)
            } catch (_: Exception) {
                null
            }
            val air = try {
                channelsApi.airState(channel = chParam)
            } catch (_: Exception) {
                null
            }
            // Home-channel attribution wins; scan-side attribution is a separate fall-back so
            // the UI can tell which one drove the display and suppress the blue RX overlay for
            // scan-only traffic (#8). Yellow SCAN RX banner uses scanBackgroundActive separately.
            val homeAirLine = rxLineFromLiveVoice(air, snap)
            val scanAirLine = rxLineFromScanAir(snap)
            val mockHomeLine = dto?.let { mockMainAttribution(it, snap) }.orEmpty()
            val mockScanLine = dto?.let { mockScanAttribution(it, snap) }.orEmpty()
            val homeLine = homeAirLine.ifBlank { mockHomeLine }
            val scanLine = scanAirLine.ifBlank { mockScanLine }
            val merged = homeLine.ifBlank { scanLine }
            val mergedFromScan = homeLine.isBlank() && scanLine.isNotBlank()
            val (talkUnit, talkName) = resolveActiveTalkAttribution(snap, air, dto)

            if (merged.isNotEmpty() ||
                snap.rxAttributedLine.isNotEmpty() ||
                mergedFromScan != snap.rxFromScan ||
                talkUnit != snap.activeTalkUnitId ||
                talkName != snap.activeTalkDisplayName
            ) {
                val wakingFromIdle =
                    snap.rxAttributedLine.isEmpty() &&
                    snap.activeTalkUnitId.isEmpty() &&
                    (merged.isNotEmpty() || talkUnit.isNotEmpty())
                if (wakingFromIdle) {
                    enqueueBackgroundWakeIfNeeded("rx_talk_activity")
                }
                val replayCaption = nextReplayCaption(snap, merged)
                lastRxAudioRecorder.noteRxContext(
                    channelName = snap.channelLabel,
                    caption = replayCaption.ifBlank { merged },
                    unitId = talkUnit,
                    displayName = talkName,
                )
                val scanBg = scanBackgroundFromActivity(dto, snap)
                _uiState.update {
                    it.copy(
                        rxAttributedLine = merged,
                        rxFromScan = mergedFromScan,
                        lastRxReplayCaption = replayCaption,
                        activeTalkUnitId = talkUnit,
                        activeTalkDisplayName = talkName,
                        scanBackgroundActive = scanBg.first,
                        scanBackgroundChannel = scanBg.second,
                    )
                }
            }
        }
    }

    /** Relay push: another unit keyed our channel — show the talker immediately.
     *  The talk-activity poll stays running as the fallback/refresher (scan
     *  channels, units on older servers, missed frames). */
    private fun onRemoteAirClaimed(event: VoiceControlEvent.AirClaimed) {
        val snap = _uiState.value
        if (snap.isPttPressed || snap.isEmergencyActive) return
        if (event.channel.isNotEmpty() && !channelNamesMatch(event.channel, snap.channelLabel)) return
        val unit = event.unitId.trim().uppercase(Locale.US)
        if (unit.isEmpty() || unit == snap.localShortUnitId.trim().uppercase(Locale.US)) return
        val name = event.displayName?.trim().orEmpty()
        val line = if (name.isNotEmpty()) "RX: $unit • $name" else "RX: $unit • VOICE"
        if (snap.rxAttributedLine.isEmpty() && snap.activeTalkUnitId.isEmpty()) {
            enqueueBackgroundWakeIfNeeded("rx_air_claimed")
        }
        lastRxAudioRecorder.noteRxContext(
            channelName = snap.channelLabel,
            caption = line,
            unitId = unit,
            displayName = name,
        )
        _uiState.update {
            it.copy(
                rxAttributedLine = line,
                rxFromScan = false,
                activeTalkUnitId = unit,
                activeTalkDisplayName = name,
            )
        }
    }

    /** Relay push: the talker on our channel unkeyed — clear the talker line
     *  immediately instead of letting it linger (~0.9 s TTL + up to ~1.2 s
     *  poll) after the audio stopped. */
    private fun onRemoteAirReleased(event: VoiceControlEvent.AirReleased) {
        val snap = _uiState.value
        if (snap.isPttPressed || snap.isEmergencyActive) return
        // Attribution currently shown came from a scan channel, not this one.
        if (snap.rxFromScan) return
        if (event.channel.isNotEmpty() && !channelNamesMatch(event.channel, snap.channelLabel)) return
        if (snap.activeTalkUnitId.isEmpty() && snap.rxAttributedLine.isEmpty()) return
        _uiState.update {
            it.copy(
                rxAttributedLine = "",
                activeTalkUnitId = "",
                activeTalkDisplayName = "",
            )
        }
    }

    private fun localTalkAttribution(snap: RadioUiState): Pair<String, String> {
        val unit = snap.localShortUnitId.trim().uppercase(Locale.US)
        val name = snap.sessionDisplayName.trim()
        return unit to name
    }

    private fun resolveActiveTalkAttribution(
        snap: RadioUiState,
        air: AirStateDto?,
        talkActivity: TalkActivityDto?,
    ): Pair<String, String> {
        if (snap.isEmergencyActive) {
            val (unit, name) = localTalkAttribution(snap)
            return unit to name.ifBlank { "YOU" }
        }
        if (snap.isPttPressed && !snap.pttBusyTone) {
            return localTalkAttribution(snap)
        }
        val txUnit =
            air?.transmittingUnitId?.trim()?.uppercase(Locale.US)?.takeIf { it.isNotEmpty() }
                ?: return "" to ""
        val local = snap.localShortUnitId.trim().uppercase(Locale.US)
        if (txUnit == local) return "" to ""
        // Secondary line is the talker's display name (resolved server-side from
        // their account); never fall back to the raw username.
        return txUnit to air.transmittingDisplayName?.trim().orEmpty()
    }

    private fun talkActivityDisplayName(
        dto: TalkActivityDto?,
        tunedChannel: String,
        unitUpper: String,
    ): String {
        val main = dto?.main ?: return ""
        if (!main.active || !channelNamesMatch(main.channel, tunedChannel)) return ""
        val uid = main.unitId?.trim()?.uppercase(Locale.US) ?: return ""
        if (uid != unitUpper) return ""
        return main.username?.trim().orEmpty()
    }

    /** First active side-channel air state while scan is on (home channel polled separately). */
    private suspend fun rxLineFromScanAir(snap: RadioUiState): String {
        if (!snap.scanActive) return ""
        val tuned = snap.channelLabel.trim()
        for (ix in snap.scanIncludedChannelIndices) {
            val ch = snap.channelCatalog.getOrNull(ix)?.trim().orEmpty()
            if (ch.isEmpty() || channelNamesMatch(ch, tuned)) continue
            val air = try {
                channelsApi.airState(channel = ch)
            } catch (_: Exception) {
                null
            }
            val line = rxLineFromLiveVoice(air, snap)
            if (line.isNotBlank()) return line
        }
        return ""
    }

    /** Attribution from relay live PCM (“on air”); overrides mock talk-activity when non-empty. */
    private fun rxLineFromLiveVoice(air: AirStateDto?, snap: RadioUiState): String {
        val tx =
            air?.transmittingUnitId?.trim()?.uppercase(Locale.US)?.takeIf { it.isNotEmpty() }
                ?: return ""
        val local = snap.localShortUnitId.trim().uppercase(Locale.US)
        if (tx == local) return ""
        val name = air.transmittingDisplayName?.trim()?.takeIf { it.isNotEmpty() }
        return if (name != null) "RX: $tx • $name" else "RX: $tx • VOICE"
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
    /** True when scan hears traffic on a side channel while the home channel is tuned. */
    private fun scanBackgroundFromActivity(dto: TalkActivityDto?, s: RadioUiState): Pair<Boolean, String> {
        if (!s.scanActive || dto == null) return false to ""
        val tuned = s.channelLabel.trim()
        val scanSeg = dto.scan ?: return false to ""
        if (!scanSeg.active) return false to ""
        val scanCh = scanSeg.channel.trim()
        if (scanCh.isEmpty() || channelNamesMatch(scanCh, tuned)) return false to ""
        val includedNamesLower = s.scanIncludedChannelIndices
            .mapNotNull { ix -> s.channelCatalog.getOrNull(ix)?.trim()?.lowercase(Locale.US) }
            .toSet()
        val activeOnSide = scanCh.lowercase(Locale.US) in includedNamesLower
        return (activeOnSide to scanCh.uppercase(Locale.US))
    }

    /** RX attribution for the tuned home channel only (talk-activity main segment). */
    private fun mockMainAttribution(dto: TalkActivityDto, s: RadioUiState): String {
        val tuned = s.channelLabel.trim()
        if (tuned.isEmpty() || tuned == "----") return ""
        val main = dto.main
        if (main != null && main.active && channelNamesMatch(main.channel, tuned)) {
            // Without `release_air` on PTT release the relay can still show us on
            // air briefly via TTL; suppress local echo either way.
            if (isLocalUnitTalker(s, main)) return ""
            return formatTalker(main, "RX")
        }
        return ""
    }

    /** RX attribution for a side-channel scan hit (talk-activity scan segment). */
    private fun mockScanAttribution(dto: TalkActivityDto, s: RadioUiState): String {
        val tuned = s.channelLabel.trim()
        if (tuned.isEmpty() || tuned == "----") return ""

        val scanSeg = dto.scan ?: return ""
        val scanCh = scanSeg.channel.trim().lowercase(Locale.US)
        if (!scanSeg.active || scanCh.isEmpty() || !s.scanActive) return ""
        if (channelNamesMatch(scanSeg.channel, tuned)) return ""

        val includedNamesLower = s.scanIncludedChannelIndices
            .mapNotNull { ix -> s.channelCatalog.getOrNull(ix)?.trim()?.lowercase(Locale.US) }
            .toSet()

        val scanIsOnSideChannel = scanCh in includedNamesLower
        return if (scanIsOnSideChannel && !isLocalUnitTalker(s, scanSeg)) {
            formatTalker(scanSeg, "RX")
        } else {
            ""
        }
    }

    private fun isLocalUnitTalker(s: RadioUiState, talker: TalkerSnapshotDto): Boolean {
        val talkerUid = talker.unitId?.trim()?.uppercase(Locale.US).orEmpty()
        if (talkerUid.isEmpty()) return false
        val local = s.localShortUnitId.trim().uppercase(Locale.US)
        return local.isNotEmpty() && talkerUid == local
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
        appUpdatePollJob?.cancel()
        appUpdater.setProgressListener(null)
        // Voice and GPS intentionally keep running after the UI is gone — a
        // foreground service holds the process, like a radio left in a pocket.
        // pttMicCapture and soundPlayer are process-scoped singletons whose
        // release() permanently cancels a coroutine scope; calling it here
        // left a later Activity unable to capture or transmit. Only stop any
        // in-progress capture — never tear the shared singletons down.
        pttToneJob?.cancel()
        pttReleaseDrainJob?.cancel()
        pttMicCapture.stopCapture()
        super.onCleared()
    }

    private companion object {
        const val CLOCK_TICK_MS = 1_000L
        const val VERSION_BANNER_MS = 5_000L
        /** How long the "MOVED TO" banner survives the immediate re-join "VOICE ON" ack. */
        const val MOVE_BANNER_MS = 6_000L
        const val AIR_POLL_MS = 250L
        const val AIR_AUDIO_STABLE_POLLS = 1

        /** Post-release mic drain: keeps capturing briefly so the final word's
         *  buffered audio reaches the relay instead of being cut off. Sized to
         *  cover AudioRecord's internal buffer (~40–80 ms) plus the syllable
         *  still being voiced as the thumb comes off the button. */
        const val TX_RELEASE_TAIL_MS = 400L
        const val TALK_ACTIVITY_POLL_MS = 1200L
        /** Faster refresh while someone appears on air (clears stale talker sooner). */
        const val TALK_ACTIVITY_FAST_POLL_MS = 400L
        /** Backgrounded (screen off / another app on top) talk-activity cadence.
         *  Voice still arrives over the relay WebSocket; this poll only drives the
         *  on-screen talker text + RX screen-wake, so it slows hard off-screen to
         *  cut cellular data (the dominant state for a belt-worn handset). */
        const val TALK_ACTIVITY_BG_POLL_MS = 5_000L
        const val WAKE_DEBOUNCE_MS = 700L
        const val PRESENCE_POLL_MS = 12_000L
        const val INBOX_POLL_MS = 2_000L
        /** Backgrounded inbox cadence. Kept short enough that emergency pages /
         *  10-33 markers still surface within a few seconds while off-screen. */
        const val INBOX_BG_POLL_MS = 5_000L
        const val STATUS_REFRESH_MS = 2_000L
        const val SOUNDS_VERSION_POLL_MS = 300_000L
        /** Foreground OTA poll while the radio screen is visible (matches [AppUpdater.CHECK_INTERVAL_MS]). */
        const val APP_UPDATE_POLL_MS = 30L * 60 * 1000
        const val CATALOG_POLL_MS = 120_000L
        const val PROFILE_POLL_MS = 120_000L
        const val OFFLINE_BANNER_CYCLE_MS = 2_000L
        const val OFFLINE_TONE_INTERVAL_MS = 15_000L
        const val RECONNECTED_BANNER_MS = 2_000L
        const val DAY_NIGHT_HOLD_FLIP_MS = 2_000L
        const val TM7_HOLD_ACTION_MS = 800L
        const val SCAN_RX_BANNER_HOLD_MS = 3_000L
        /** Extra time so the banner stays up until async AudioTrack playback actually ends. */
        const val REPLAY_BANNER_PAD_MS = 200L
        const val REPLAY_BANNER_MIN_MS = 2_000L
    }
}
