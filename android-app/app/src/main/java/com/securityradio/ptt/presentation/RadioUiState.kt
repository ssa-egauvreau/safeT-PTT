package com.securityradio.ptt.presentation

import com.securityradio.ptt.device.DeviceProfilePreference
import com.securityradio.ptt.device.ResolvedDeviceProfile
import com.securityradio.ptt.domain.ChannelPermission

/** One row in the RX message-history screen. */
data class RxMessageHistoryItem(
    val id: Long,
    val timeLabel: String,
    val channelName: String,
    val caption: String,
    val transcript: String,
    val durationMs: Long,
)

/**
 * Immutable snapshot of the radio shell. The [RadioViewModel] is the single source of truth.
 */
data class RadioUiState(
    val systemTime: String,
    val networkLabel: String,
    val batteryPercent: Int,
    val zoneLabel: String,
    val channelLabel: String,
    val channelPosition: String,
    val totalChannels: Int,
    /** Channel names from catalog (for scan picker labels). */
    val channelCatalog: List<String>,
    /** Parallel to [channelCatalog] — permission for each row in the scan picker. */
    val channelCatalogPermissions: List<ChannelPermission> = emptyList(),
    /** Indices into [channelCatalog] included in scan when [scanActive] is true (never includes home channel). */
    val scanIncludedChannelIndices: Set<Int>,
    /** Multi-select picker for scan list. */
    val scanPickerVisible: Boolean,
    val displayLine1: String,
    val displayLine2: String,
    val displayLine3: String,
    val softKeyLabels: List<String>,
    val isPttPressed: Boolean,
    val isEmergencyActive: Boolean,
    val pttBusyTone: Boolean,
    val statusMessage: String,
    val channelsLoading: Boolean,
    val channelSyncError: String?,
    val channelSourceLabel: String,
    val micPermissionGranted: Boolean,
    val micHint: String,
    /** Stable short unit id for TX line (persisted). */
    val localShortUnitId: String,
    /** Signed-in operator display name (shown under unit id while keyed). */
    val sessionDisplayName: String,
    /** Portal username for settings / account display. */
    val sessionUsername: String = "",
    /** Agency name from sign-in (settings account tab). */
    val sessionAgencyName: String = "",
    /** Unit id shown large on the main LCD while keyed (TX/RX/emergency). */
    val activeTalkUnitId: String,
    /** Display name under [activeTalkUnitId] (smaller type). */
    val activeTalkDisplayName: String,
    /** Server hint: formatted RX attribution when someone else is keyed (main channel wins over scan). */
    val rxAttributedLine: String,
    /** Another unit's emergency on this channel (from inbox); shown in orange on the main LCD. */
    val remoteEmergencyUnit: String?,
    /** UI toggle for the scan row (soft key). */
    val scanActive: Boolean,

    /**
     * Day / night **preference**: [ThemeMode.AUTO] follows the device light/dark setting in the Compose layer.
     */
    val themeMode: ThemeMode,
    
    /** Hardware button mapping settings. */
    val mappingSettingsVisible: Boolean,
    val hardwareMappings: Map<com.securityradio.ptt.device.HardwareAction, Set<Int>>,
    val currentlyMappingAction: com.securityradio.ptt.device.HardwareAction?,

    /** Setup / Permission state. */
    val needsAudioPermission: Boolean,
    val needsAccessibilityService: Boolean,

    /** Debug / mapping: last intercepted Android keyCode for the HUD. */
    val lastDetectedKey: Int?,

    /** Other radios reporting presence on the currently tuned channel (`null` when unknown). */
    val radiosOnlineOnChannel: Int?,

    /** Announce channel name aloud when changing tuning (TextToSpeech). */
    val announceChannelNameOnTune: Boolean,
    /** Last RX attribution caption (UI / logging; replay uses recorded PCM). */
    val lastRxReplayCaption: String,
    /** Agency radio key configured on this device; blank means use the build-time key. */
    val agencyRadioKey: String,

    /** Settings override for rugged handset layouts. */
    val deviceProfilePreference: DeviceProfilePreference,
    /** Effective profile after auto-detect (when preference is [DeviceProfilePreference.AUTO]). */
    val resolvedDeviceProfile: ResolvedDeviceProfile,

    /** Android "display over other apps" — needed on some OEMs to return the radio UI to the front. */
    val needsOverlayPermission: Boolean,

    /** Wired / USB / Bluetooth headset mic present (status-bar speaker icon). */
    val externalMicConnected: Boolean,
    /** Bluetooth radio enabled (status icon). */
    val bluetoothOn: Boolean,
    /**
     * Lost-link banner text: blank when the link is healthy, otherwise one of
     * [BANNER_NO_CONNECTION] / [BANNER_RECONNECTING] / [BANNER_RECONNECTED].
     */
    val connectivityBanner: String,

    /** Non-blank while the last RX is replaying; holds the "who was talking" caption. */
    val replayBanner: String,
    /** Whisper transcript for quick replay (shown under [replayBanner]). */
    val replayTranscript: String = "",

    /** Screen flipped 180° (IRC590 day/night key long-press). */
    val displayRotated180: Boolean,

    /** Dispatcher has flagged the tuned channel 10-33 (emergency traffic only). */
    val channelTen33: Boolean = false,

    /** Talk permission for the currently tuned channel; drives the on-screen badge + local PTT gate. */
    val currentChannelPermission: ChannelPermission = ChannelPermission.TALK,

    /** Full-screen scrollable list of recent RX messages (long-press replay on TM7). */
    val messageHistoryVisible: Boolean = false,
    val rxMessageHistory: List<RxMessageHistoryItem> = emptyList(),
    /** Id of the history row currently playing audio, if any. */
    val historyPlayingId: Long? = null,
    /** True when [historyPlayingId] is set but playback is paused. */
    val historyPlaybackPaused: Boolean = false,

    /** Scan traffic on a monitored channel while tuned elsewhere (scan icon pulse). */
    val scanBackgroundActive: Boolean = false,
    val scanBackgroundChannel: String = "",

    /**
     * True when [rxAttributedLine] came from a scan side-channel rather than the tuned home
     * channel. The home-channel RX chrome (blue wash) is suppressed in this case — scan-only
     * traffic gets the yellow SCAN RX banner and nothing else.
     */
    val rxFromScan: Boolean = false,

    /** 0 = Buttons, 1 = Device, 2 = Audio, 3 = Account. Persisted only in memory across opens. */
    val settingsTabIndex: Int = 0,
    /** Mirror of [com.securityradio.ptt.device.RadioPreferences.isNoiseSuppressionEnabled]. */
    val micNoiseSuppressionEnabled: Boolean = true,
    /** Mirror of [com.securityradio.ptt.device.RadioPreferences.isMicAutoGainEnabled]. */
    val micAutoGainEnabled: Boolean = true,
    /** Mirror of [com.securityradio.ptt.device.RadioPreferences.getMicGainMultiplier]. */
    val micGainMultiplier: Float = 1.0f,
) {
    init {
        require(softKeyLabels.size == SOFT_KEY_COUNT) {
            "Expected $SOFT_KEY_COUNT soft key labels, got ${softKeyLabels.size}"
        }
    }

    companion object {
        const val SOFT_KEY_COUNT = 5

        const val BANNER_NO_CONNECTION = "NO CONNECTION"
        const val BANNER_RECONNECTING = "RECONNECTING"
        const val BANNER_RECONNECTED = "RECONNECTED"

        fun initial(): RadioUiState = RadioUiState(
            systemTime = "--:--",
            networkLabel = "SYNCING",
            batteryPercent = 100,
            zoneLabel = "ZONE 01",
            channelLabel = "----",
            channelPosition = "-- / --",
            totalChannels = 0,
            channelCatalog = emptyList(),
            channelCatalogPermissions = emptyList(),
            scanIncludedChannelIndices = emptySet(),
            scanPickerVisible = false,
            displayLine1 = "SUNSET SAFETY AGENCY",
            displayLine2 = "OPERATIONS",
            displayLine3 = "CHANNELS: LOADING",
            softKeyLabels = listOf("PTT", "MENU", "SCAN", "", "CHAN"),
            isPttPressed = false,
            isEmergencyActive = false,
            pttBusyTone = false,
            statusMessage = "STARTING",
            channelsLoading = true,
            channelSyncError = null,
            channelSourceLabel = "---",
            micPermissionGranted = false,
            micHint = "MIC: ALLOW ACCESS",
            localShortUnitId = "",
            sessionDisplayName = "",
            sessionUsername = "",
            sessionAgencyName = "",
            activeTalkUnitId = "",
            activeTalkDisplayName = "",
            rxAttributedLine = "",
            remoteEmergencyUnit = null,
            scanActive = false,
            themeMode = ThemeMode.AUTO,
            mappingSettingsVisible = false,
            hardwareMappings = emptyMap(),
            currentlyMappingAction = null,
            needsAudioPermission = false,
            needsAccessibilityService = false,
            lastDetectedKey = null,
            radiosOnlineOnChannel = null,
            announceChannelNameOnTune = true,
            lastRxReplayCaption = "",
            agencyRadioKey = "",
            deviceProfilePreference = DeviceProfilePreference.AUTO,
            resolvedDeviceProfile = ResolvedDeviceProfile.RESPONSIVE,
            needsOverlayPermission = false,
            externalMicConnected = false,
            bluetoothOn = false,
            connectivityBanner = "",
            replayBanner = "",
            replayTranscript = "",
            displayRotated180 = false,
        )
    }
}
