import Foundation

/// One selectable channel in the tuning order, carrying its zone grouping for
/// the zone/channel dropdown and the Motorola-style "zone number in front of
/// channel" display. Mirrors the Android `ChannelZone` / channel display logic.
struct ChannelOption: Identifiable, Equatable {
    /// Position in the tuning order (the index `RadioViewModel.channelIndex` uses).
    let index: Int
    let name: String
    let zoneNumber: Int?
    let zoneName: String?

    var id: Int { index }

    /// Zone-prefixed channel label for the main display, e.g. "1 GREEN 1".
    /// Falls back to the bare channel name when the channel isn't zoned.
    var displayLabel: String {
        if let zoneNumber { return "\(zoneNumber) \(name)" }
        return name
    }

    /// Section heading for the dropdown, e.g. "ZONE 1 · PATROL", "ZONE 1", or
    /// "UNGROUPED".
    var zoneHeader: String {
        let trimmed = zoneName?.trimmingCharacters(in: .whitespacesAndNewlines)
        switch (zoneNumber, trimmed) {
        case let (z?, n?) where !n.isEmpty: return "ZONE \(z) · \(n.uppercased())"
        case let (z?, _): return "ZONE \(z)"
        case let (nil, n?) where !n.isEmpty: return n.uppercased()
        default: return "UNGROUPED"
        }
    }
}

/// Immutable-ish snapshot of the radio shell. `RadioViewModel` is the source of truth.
struct RadioUiState {
    var systemTime = "--:--"
    var networkLabel = "SYNCING"
    var displayLine1 = "safeT PTT"
    var displayLine2 = "OPERATIONS"
    /// Plain channel name (no zone prefix) — the canonical key used for scan /
    /// air / presence lookups and accessibility.
    var channelLabel = "----"
    /// Zone-prefixed channel name for the big display, e.g. "1 GREEN 1". Equal to
    /// `channelLabel` when the tuned channel isn't grouped into a zone.
    var channelDisplayLabel = "----"
    /// Zone heading line shown above the channel, e.g. "ZONE 1 · PATROL". Empty
    /// when the tuned channel isn't zoned.
    var zoneLabel = ""
    /// Every tunable channel with its zone grouping — drives the zone/channel
    /// dropdown picker.
    var channels: [ChannelOption] = []
    /// Index into `channels` of the currently tuned channel.
    var channelIndex = 0
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
    /// Live mic level (0–1, peak) while transmitting — drives the XMIT-box audio
    /// visualizer. Zero when not transmitting.
    var txLevel: Float = 0
    /// The server's permission grant for the current channel — gates the mic.
    /// Defaults false (pessimistic) until a channel is tuned / the voice socket
    /// acks, so it must NOT drive the listen-only UI on its own (that would grey
    /// the PTT during normal startup). Use `isListenOnly` for the greyed-out UI.
    var canTransmit = false
    /// True only when the tuned channel is *affirmatively* listen-only (its
    /// permission is `listen_only`). Drives the greyed-out, non-interactive PTT
    /// bar. Stays false while a channel is still loading so the bar reads
    /// "HOLD TO TALK" rather than falsely claiming monitor-only.
    var isListenOnly = false

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
    /// Compact codec badge for the tuned channel ("IMBE", "AMBE+2", …), from
    /// the relay's joined ack / codec_change push. Empty until the first ack.
    var channelCodecLabel = ""
    /// Dispatcher 10-33 emergency-traffic marker on the tuned channel.
    var channelTen33 = false

    /// Timestamp the current voice link came up; used to render "Connected · Ns"
    /// in the network pill. Nil when not connected.
    var connectionStartedAt: Date?
    /// True after an `onError` and before the next `onJoined` — pill shows
    /// "Reconnecting" rather than the elapsed-seconds counter.
    var isReconnecting = false
}
