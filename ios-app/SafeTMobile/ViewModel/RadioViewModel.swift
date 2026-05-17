import Foundation

/// Owns radio state, the server connection, presence/inbox polling, and GPS.
/// Voice transmit is not wired yet — PTT performs a channel-air check only.
@MainActor
final class RadioViewModel: ObservableObject {
    @Published private(set) var uiState = RadioUiState()

    private let api = RadioApiClient()
    private let locationReporter: LocationReporter
    private let unitId: String

    private var channelNames: [String] = []
    private var channelIndex = 0
    private var inboxSince = 0
    private var inboxPrimed = false

    private let clockFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter
    }()

    init() {
        unitId = LocalUnitIdentifier.shortUnitId()
        locationReporter = LocationReporter(api: api)
        locationReporter.configure(unitId: unitId)
        uiState.localShortUnitId = unitId

        locationReporter.onAuthorizationChange = { [weak self] authorized in
            Task { @MainActor in self?.handleLocationAuth(authorized) }
        }
        if uiState.gpsActive {
            locationReporter.start()
        }
        startClock()
        startPresencePolling()
        startInboxPolling()
        Task { await loadCatalog() }
    }

    func handle(_ event: RadioUiEvent) {
        switch event {
        case .retryChannelSync: Task { await loadCatalog() }
        case .channelUp: bumpChannel(1)
        case .channelDown: bumpChannel(-1)
        case .pttPressed: Task { await onPttPressed() }
        case .pttReleased: onPttReleased()
        case .emergencyToggle: toggleEmergency()
        case .toggleGps: toggleGps()
        }
    }

    // MARK: - catalog / tuning

    private var currentChannel: String? {
        channelNames.indices.contains(channelIndex) ? channelNames[channelIndex] : nil
    }

    private func loadCatalog() async {
        uiState.channelsLoading = true
        uiState.networkLabel = "SYNCING"
        uiState.statusMessage = "SYNCING CATALOG"
        do {
            let channels = try await api.channels()
            channelNames = channels.map(\.name)
            channelIndex = min(channelIndex, max(channelNames.count - 1, 0))
            uiState.channelsLoading = false
            uiState.channelSyncError = nil
            uiState.networkLabel = "ONLINE"
            applyTuning()
            uiState.statusMessage = "READY"
            locationReporter.setChannel(currentChannel)
            await pulsePresence()
        } catch {
            uiState.channelsLoading = false
            uiState.networkLabel = "OFFLINE"
            uiState.channelSyncError = "Channel sync failed"
            uiState.statusMessage = "SYNC FAILED"
        }
    }

    private func applyTuning() {
        guard !channelNames.isEmpty else {
            uiState.channelLabel = "----"
            uiState.channelPosition = "-- / --"
            uiState.displayLine2 = "OPERATIONS"
            return
        }
        let name = channelNames[channelIndex]
        uiState.channelLabel = name
        uiState.channelPosition = String(format: "%02ld / %02ld", channelIndex + 1, channelNames.count)
        uiState.displayLine2 = "OPS: " + name.uppercased()
    }

    private func bumpChannel(_ delta: Int) {
        guard !channelNames.isEmpty, !uiState.channelsLoading else { return }
        channelIndex = (channelIndex + delta + channelNames.count) % channelNames.count
        applyTuning()
        uiState.statusMessage = delta > 0 ? "CHANNEL +" : "CHANNEL -"
        uiState.radiosOnlineOnChannel = nil
        locationReporter.setChannel(currentChannel)
        Task { await pulsePresence() }
    }

    // MARK: - PTT (air check; voice transmit is a later milestone)

    private func onPttPressed() async {
        uiState.isPttPressed = true
        uiState.statusMessage = "AIR: CHECKING"
        guard uiState.networkLabel == "ONLINE" else {
            uiState.pttBusyTone = true
            uiState.statusMessage = "NO CONNECTION"
            return
        }
        do {
            let air = try await api.airState(channel: currentChannel)
            guard uiState.isPttPressed else { return }
            let busy = air.occupied && air.transmittingUnitId?.uppercased() != unitId
            uiState.pttBusyTone = busy
            uiState.statusMessage = busy ? "CHANNEL BUSY" : "CHANNEL CLEAR — VOICE PENDING"
        } catch {
            guard uiState.isPttPressed else { return }
            uiState.pttBusyTone = true
            uiState.statusMessage = "AIR CHECK FAILED"
        }
    }

    private func onPttReleased() {
        uiState.isPttPressed = false
        uiState.pttBusyTone = false
        uiState.statusMessage = "RX IDLE"
    }

    // MARK: - emergency / GPS

    /// Emergency is safety-critical: the local state is only confirmed once the
    /// server accepts it, and rolled back if the request fails.
    private func toggleEmergency() {
        let activating = !uiState.isEmergencyActive
        uiState.isEmergencyActive = activating
        uiState.statusMessage = activating ? "EMERGENCY — SENDING…" : "EMERGENCY — CLEARING…"
        let channel = currentChannel
        Task {
            do {
                try await api.setEmergency(
                    unitId: unitId,
                    channel: channel,
                    active: activating,
                    message: activating ? "Emergency activated" : nil
                )
                uiState.statusMessage = activating ? "EMERGENCY ACTIVE" : "EMERGENCY OFF"
            } catch {
                uiState.isEmergencyActive = !activating
                uiState.statusMessage = activating ? "EMERGENCY SEND FAILED" : "EMERGENCY CLEAR FAILED"
            }
        }
    }

    private func toggleGps() {
        let next = !uiState.gpsActive
        uiState.gpsActive = next
        if next {
            locationReporter.start()
            uiState.statusMessage = uiState.locationAuthorized ? "GPS ON" : "GPS — REQUESTING ACCESS…"
        } else {
            locationReporter.stop()
            uiState.statusMessage = "GPS OFF"
        }
    }

    /// Reflects the real CoreLocation authorization so the shell never claims
    /// GPS is on while location access is denied.
    private func handleLocationAuth(_ authorized: Bool) {
        uiState.locationAuthorized = authorized
        guard uiState.gpsActive else { return }
        uiState.statusMessage = authorized ? "GPS ON" : "GPS — NO LOCATION ACCESS"
    }

    // MARK: - polling loops

    private func startClock() {
        Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                self.uiState.systemTime = self.clockFormatter.string(from: Date())
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    private func startPresencePolling() {
        Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(12))
                guard let self else { return }
                await self.pulsePresence()
            }
        }
    }

    private func pulsePresence() async {
        guard uiState.networkLabel == "ONLINE", let channel = currentChannel else {
            uiState.radiosOnlineOnChannel = nil
            return
        }
        do {
            try await api.presenceHeartbeat(unitId: unitId, channel: channel)
            let count = try await api.presenceCount(channel: channel)
            uiState.radiosOnlineOnChannel = max(count, 0)
        } catch {
            uiState.radiosOnlineOnChannel = nil
        }
    }

    private func startInboxPolling() {
        Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard let self else { return }
                await self.pollInbox()
            }
        }
    }

    /// The first batch primes the cursor silently so old alerts don't replay on launch.
    private func pollInbox() async {
        guard uiState.networkLabel == "ONLINE" else { return }
        do {
            let response = try await api.inbox(unit: unitId, channel: currentChannel, since: inboxSince)
            if inboxPrimed {
                for alert in response.alerts where alert.fromUnit?.uppercased() != unitId {
                    handleInboundAlert(alert)
                }
            }
            inboxSince = max(response.lastId, inboxSince)
            inboxPrimed = true
        } catch {
            // Keep the last cursor; try again on the next tick.
        }
    }

    private func handleInboundAlert(_ alert: InboxAlert) {
        let from = alert.fromUnit ?? alert.fromName ?? "DISPATCH"
        if alert.kind.lowercased() == "emergency" {
            uiState.statusMessage = "EMERGENCY • " + from.uppercased()
        } else if let message = alert.message, !message.isEmpty {
            uiState.statusMessage = "PAGE: " + message.prefix(40).uppercased()
        } else {
            uiState.statusMessage = "PAGE • " + from.uppercased()
        }
    }
}
