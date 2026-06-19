package com.securityradio.ptt.presentation

import com.securityradio.ptt.device.DeviceProfilePreference
import com.securityradio.ptt.device.RadioPreferences
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

/** Which tab of the message-history screen is showing. */
enum class MessageHistoryTab { Messages, Transcriptions }

/** A dispatcher page/message delivered to this radio (text + optional picture). */
data class PageMessage(
    val id: Long,
    val timeLabel: String,
    val fromLabel: String,
    val message: String,
    val targetedToMe: Boolean,
    val hasImage: Boolean,
    val read: Boolean,
    /** Label of the reply this radio sent back (ACK / canned), or null. */
    val responded: String? = null,
)

/**
 * Immutable snapshot of the radio shell. The [RadioViewModel] is the single source of truth.
 */
data class RadioUiState(
    val systemTime: String,
    val networkLabel: String,
    val batteryPercent: Int,
    val zoneLabel: String,
    /**
     * True while zone-select mode is active (hold channel-up on TM-7 Plus, hold replay on IRC590,
     * or tap the zone label). Channel up/down then steps [zoneLabel] through the zones instead of
     * tuning; the same hold/tap commits and tunes the first channel of the chosen zone.
     */
    val zoneSelectActive: Boolean = false,
    /** Distinct zones in the catalog; the zone tap affordance is hidden when there is only one. */
    val zoneCount: Int = 1,
    val channelLabel: String,
    /**
     * What the display paints for the tuned channel: the zone number rides in front of the
     * raw [channelLabel] ("1 GREEN 1" for Green 1 in zone 1). Logic (joins, scan matching,
     * RX attribution) keeps using [channelLabel].
     */
    val channelDisplayLabel: String = "",
    /** True when the AI dispatcher is enabled on the tuned channel — the shell shows an AI badge. */
    val aiDispatchEnabled: Boolean = false,
    val channelPosition: String,
    val totalChannels: Int,
    /** Channel names from catalog (for scan picker labels). */
    val channelCatalog: List<String>,
    /** Parallel to [channelCatalog]: zone-number-prefixed labels for display. */
    val channelCatalogDisplay: List<String> = emptyList(),
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
    /**
     * Compact codec badge for the tuned channel ("IMBE", "AMBE+2", …), from the
     * relay's joined ack / codec_change push. Empty until the first join ack.
     */
    val channelCodecLabel: String = "",
    val isPttPressed: Boolean,
    /**
     * True only while keyed AND actually on the air: talk-permit verified, mic
     * capture running, and the voice socket ready to carry frames. The green
     * "TRANSMITTING" UI keys off this, not [isPttPressed], so the operator
     * can't read a dead link or the pre-permit gap as "I'm on the air".
     */
    val pttOnAir: Boolean = false,
    val isEmergencyActive: Boolean,
    val pttBusyTone: Boolean,
    val statusMessage: String,
    /**
     * When non-null, the app version to flash in the zone/channel display area for a few seconds at
     * launch (IRC590 / TM-7 Plus only). Cleared back to null afterwards.
     */
    val versionBanner: String? = null,
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
     * True while every desired scan-channel WebSocket is up. Flips false only
     * after a connection that was once known-good has dropped, so the scan
     * icon doesn't flash red during the normal initial-connect window after
     * toggling scan on. Drives the broken-link icon colour — gives the
     * operator a visible signal when scan is silently failing (e.g. after a
     * network blip leaves the server-side session dead while our TCP side
     * still thinks the socket is alive).
     */
    val scanLinkHealthy: Boolean = true,

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
    /** Android has not granted location access — dispatch map will not update. */
    val needsLocationPermission: Boolean = false,
    /** Permission granted but system Location/GPS is turned off. */
    val needsGpsEnabled: Boolean = false,

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

    /**
     * OTA status for the radio LCD: available/downloading progress, then reboot-to-install
     * after the APK is verified. Cleared once [android.os.Build.VERSION_CODE] matches pending.
     */
    val appUpdateBanner: String = "",
    /**
     * True while an OTA update is downloading/installing — drives the full-screen
     * "DOWNLOADING UPDATE — DO NOT TURN OFF DEVICE" banner.
     */
    val updateInstalling: Boolean = false,
    /**
     * Set on the first launch after a verified OTA install completes; carries the
     * version name (e.g. "1.2.3"). Drives a green full-screen "UPDATE INSTALLED
     * SUCCESSFULLY" overlay that persists until any hardware button is pressed
     * (or the overlay is tapped). Cleared back to null after dismissal.
     */
    val updateInstalledNotice: String? = null,

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

    /** True once the operator dismisses the full-screen "setup required" prompt this session. */
    val setupDialogDismissed: Boolean = false,

    /** Full-screen scrollable list of recent RX messages (long-press replay on TM7). */
    val messageHistoryVisible: Boolean = false,
    val rxMessageHistory: List<RxMessageHistoryItem> = emptyList(),
    /** Id of the history row currently playing audio, if any. */
    val historyPlayingId: Long? = null,
    /** True when [historyPlayingId] is set but playback is paused. */
    val historyPlaybackPaused: Boolean = false,
    /** Which tab of the history screen is active (Messages | Transcriptions). */
    val messageHistoryTab: MessageHistoryTab = MessageHistoryTab.Transcriptions,
    /** Dispatcher pages/messages delivered to this radio, newest first. */
    val pageMessages: List<PageMessage> = emptyList(),
    /** Count of unread pages — drives the REPLAY badge. */
    val unreadMessageCount: Int = 0,
    /** Lazily-loaded page picture attachments, keyed by page id (raw bytes). */
    val pageImages: Map<Long, ByteArray> = emptyMap(),

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
    val micNoiseSuppressionEnabled: Boolean = false,
    /** Mirror of [com.securityradio.ptt.device.RadioPreferences.isMicAutoGainEnabled]. */
    val micAutoGainEnabled: Boolean = false,
    /** Mirror of [com.securityradio.ptt.device.RadioPreferences.getMicGainMultiplier]. */
    val micGainMultiplier: Float = RadioPreferences.MAX_MIC_GAIN,

    /** MP22 dual-display firmware detected (virtual Display 0 + physical Display 1). */
    val mp22DualDisplay: Boolean = false,
    /** MP22: user finished PC setup and wants the app on the physical panel. */
    val mp22UsePhysicalDisplay: Boolean = false,
    /** MP22: which display this activity is on (0 = virtual, 1 = physical). */
    val mp22CurrentDisplayId: Int = 0,
    /** MP22: on physical display but no touch reached the app (virtual display may still own input). */
    val mp22TouchNotReachable: Boolean = false,
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
            channelDisplayLabel = "----",
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
            needsLocationPermission = false,
            needsGpsEnabled = false,
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
