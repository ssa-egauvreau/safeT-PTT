import Foundation

/// Immutable-ish snapshot of the radio shell. `RadioViewModel` is the source of truth.
struct RadioUiState {
    var systemTime = "--:--"
    var networkLabel = "SYNCING"
    var displayLine1 = "safeT PTT"
    var displayLine2 = "OPERATIONS"
    var channelLabel = "----"
    var channelPosition = "-- / --"
    var statusMessage = "STARTING"
    var isPttPressed = false
    var pttBusyTone = false
    var isEmergencyActive = false
    var channelsLoading = true
    var channelSyncError: String?
    var localShortUnitId = ""
    var operatorDisplayName = ""
    var agencyName = ""
    var radiosOnlineOnChannel: Int?
    /// Display names of units on the current channel
    var unitsOnChannel: [String] = []
    /// True when the system has been granted location permission.
    /// GPS is always on by design — there is no user toggle.
    var locationAuthorized = false
    /// True while the speaker is playing audio received from another unit.
    var isReceivingAudio = false
    /// True while the mic is hot and frames are being streamed to the server.
    var isTransmitting = false
    /// The server's permission grant for the current channel — gates the mic.
    var canTransmit = false

    // MARK: - scan

    /// Every channel the user is authorized for — drives the scan picker
    /// (the tuned/home channel is implicit and excluded from scan).
    var channelCatalog: [String] = []
    /// True when scan is armed — extra listen sockets are open for the
    /// channels in `scanIncludedChannels`.
    var scanActive = false
    /// Lowercased channel labels included in scan. Lowercase so picker
    /// toggles and transport-side lookups stay case-insensitive.
    var scanIncludedChannels: Set<String> = []
    /// Last channel name that produced scan-channel RX traffic — shown as a
    /// transient banner in the display panel.
    var scanRxChannel: String?
    /// Live RX attribution line (e.g. "RX: UNIT • Name") from `/v1/air` + talk-activity.
    var rxAttributedLine = ""
    var rxFromScan = false
    var activeTalkUnitId = ""
    var activeTalkDisplayName = ""
    /// Dispatcher 10-33 emergency-traffic marker on the tuned channel.
    var channelTen33 = false

    /// Timestamp the current voice link came up; used to render "Connected · Ns"
    /// in the network pill. Nil when not connected.
    var connectionStartedAt: Date?
    /// True after an `onError` and before the next `onJoined` — pill shows
    /// "Reconnecting" rather than the elapsed-seconds counter.
    var isReconnecting = false
}
