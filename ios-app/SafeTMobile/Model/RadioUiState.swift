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
    var radiosOnlineOnChannel: Int?
    var gpsActive = true
    var locationAuthorized = false
}
