package com.securityradio.ptt.presentation

/**
 * Immutable snapshot of the radio shell. The [RadioViewModel] is the single source of truth.
 */
data class RadioUiState(
    val systemTime: String,
    val networkLabel: String,
    val batteryPercent: Int,
    val signalBars: Int,
    val maxSignalBars: Int,
    val zoneLabel: String,
    val channelLabel: String,
    val channelPosition: String,
    val totalChannels: Int,
    val displayLine1: String,
    val displayLine2: String,
    val displayLine3: String,
    val softKeyLabels: List<String>,
    val isPttPressed: Boolean,
    val isEmergencyActive: Boolean,
    val statusMessage: String,
    val channelsLoading: Boolean,
    val channelSyncError: String?,
    val channelSourceLabel: String,
    val micPermissionGranted: Boolean,
    val micHint: String,
) {
    init {
        require(softKeyLabels.size == SOFT_KEY_COUNT) {
            "Expected $SOFT_KEY_COUNT soft key labels, got ${softKeyLabels.size}"
        }
    }

    companion object {
        const val SOFT_KEY_COUNT = 4

        fun initial(): RadioUiState = RadioUiState(
            systemTime = "--:--",
            networkLabel = "SYNCING",
            batteryPercent = 100,
            signalBars = 0,
            maxSignalBars = 5,
            zoneLabel = "ZONE 1",
            channelLabel = "----",
            channelPosition = "-- / --",
            totalChannels = 0,
            displayLine1 = "ENTERPRISE PTT",
            displayLine2 = "PRIVATE MODE",
            displayLine3 = "CHANNELS: LOADING",
            softKeyLabels = listOf("MENU", "SCAN", "GPS", "EXIT"),
            isPttPressed = false,
            isEmergencyActive = false,
            statusMessage = "STARTING",
            channelsLoading = true,
            channelSyncError = null,
            channelSourceLabel = "---",
            micPermissionGranted = false,
            micHint = "MIC: ALLOW ACCESS",
        )
    }
}
