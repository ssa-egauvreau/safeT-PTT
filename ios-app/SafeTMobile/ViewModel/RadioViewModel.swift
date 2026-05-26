import AVFoundation
import Foundation
import os

/// Owns radio state, the server connection, presence/inbox polling, GPS, and
/// the half-duplex voice transport (mic capture + WebSocket + playback).
@MainActor
final class RadioViewModel: ObservableObject {
    @Published private(set) var uiState = RadioUiState()

    private let api: RadioApiClient
    private let locationReporter: LocationReporter
    private let user: AuthenticatedUser
    private let voiceAudio: VoiceAudio
    private let voiceTransport: VoiceTransport
    private let sounds = RadioSounds()
    private let unitId: String
    /// `os.Logger` for radio-state events. Visible in Console.app on a Mac
    /// (filter on subsystem == com.safetptt.mobile) and in the Xcode debug
    /// console. Use this rather than print() so log lines survive Release
    /// builds and are queryable by category.
    private let logger = Logger(subsystem: "com.safetptt.mobile", category: "radio")

    private var channelNames: [String] = []
    private var channelIndex = 0
    private var inboxSince = 0
    private var inboxPrimed = false
    private var voiceStarted = false

    private let clockFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter
    }()

    init(user: AuthenticatedUser, token: String) {
        self.user = user
        unitId = user.radioUnitId
        api = RadioApiClient(token: token)
        voiceAudio = VoiceAudio()
        voiceTransport = VoiceTransport(
            baseURL: RadioConfig.apiBaseURL,
            token: token,
            unitId: unitId,
            audio: voiceAudio
        )
        locationReporter = LocationReporter(api: api)
        locationReporter.configure(unitId: unitId)

        uiState.localShortUnitId = unitId
        uiState.operatorDisplayName = user.displayName
        uiState.agencyName = user.agencyName ?? ""

        locationReporter.onAuthorizationChange = { [weak self] authorized in
            Task { @MainActor in self?.handleLocationAuth(authorized) }
        }
        if uiState.gpsActive {
            locationReporter.start()
        }
        wireVoiceCallbacks()
        startClock()
        startPresencePolling()
        startInboxPolling()
        Task { await loadCatalog() }
    }

    deinit {
        Task { @MainActor [voiceTransport, voiceAudio] in
            voiceTransport.disconnect()
            voiceAudio.stop()
        }
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
            await startVoiceIfNeeded()
            if let channel = currentChannel {
                voiceTransport.join(channel: channel)
            }
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
        sounds.play(.channelSwitch)
        uiState.statusMessage = delta > 0 ? "CHANNEL +" : "CHANNEL -"
        uiState.radiosOnlineOnChannel = nil
        uiState.canTransmit = false
        locationReporter.setChannel(currentChannel)
        if let channel = currentChannel {
            voiceTransport.join(channel: channel)
        }
        Task { await pulsePresence() }
    }

    // MARK: - voice glue

    private func wireVoiceCallbacks() {
        voiceAudio.onCapturedFrame = { [weak self] frame in
            self?.voiceTransport.sendCaptured(frame)
        }
        voiceTransport.onJoined = { [weak self] joined in
            guard let self else { return }
            self.uiState.canTransmit = joined.permission != .listenOnly
            self.uiState.statusMessage = joined.permission == .listenOnly ? "MONITOR ONLY" : "READY"
        }
        voiceTransport.onError = { [weak self] code in
            self?.uiState.statusMessage = "LINK: \(code.uppercased())"
        }
        voiceTransport.onReceivingChange = { [weak self] receiving in
            self?.uiState.isReceivingAudio = receiving
        }
        voiceTransport.onBusy = { [weak self] holder in
            guard let self, self.uiState.isPttPressed else { return }
            let peer = holder?.uppercased()
            if peer == nil || peer != self.unitId {
                let msg = peer.map { "CHANNEL BUSY — \($0)" } ?? "CHANNEL BUSY"
                self.enterBusy(msg)
                self.voiceAudio.stopCapture()
                self.voiceTransport.resetUplinkState()
                self.uiState.isTransmitting = false
            }
        }
    }

    private func startVoiceIfNeeded() async {
        guard !voiceStarted else { return }
        let granted = await AudioSessionManager.requestRecordPermission()
        guard granted else {
            uiState.statusMessage = "MIC DENIED — VOICE OFF"
            return
        }
        do {
            try voiceAudio.start()
            voiceStarted = true
        } catch {
            uiState.statusMessage = "AUDIO INIT FAILED"
        }
    }

    // MARK: - PTT

    private func onPttPressed() async {
        uiState.isPttPressed = true
        guard uiState.networkLabel == "ONLINE" else {
            enterBusy("NO CONNECTION")
            return
        }
        guard uiState.canTransmit else {
            enterBusy("LISTEN ONLY ON THIS CHANNEL")
            return
        }
        // startVoiceIfNeeded() can leave the audio engine inert (mic denied, audio init
        // throw, etc.). Without this guard the UI would say "ON AIR" while no PCM is
        // actually being captured or sent — confusing the operator and silently dropping
        // their transmission.
        guard voiceStarted else {
            enterBusy("VOICE UNAVAILABLE")
            return
        }
        uiState.statusMessage = "AIR: CHECKING"
        do {
            let air = try await api.airState(channel: currentChannel)
            guard uiState.isPttPressed else { return }
            let busy = air.occupied && air.transmittingUnitId?.uppercased() != unitId
            if busy {
                enterBusy("CHANNEL BUSY")
                return
            }
            // Air is clear — play the permit beep, then start capturing. The beep
            // overlaps the first ~250 ms of mic capture; that's how Android does
            // it too, and the listener side hasn't started decoding yet anyway.
            guard voiceAudio.startCapture() else {
                // Route/format failures can leave capture inert (no tap installed).
                // Do not show "ON AIR" when no mic frames are actually flowing.
                voiceTransport.resetUplinkState()
                uiState.isTransmitting = false
                enterBusy("VOICE UNAVAILABLE")
                return
            }
            sounds.play(.pttPermit)
            uiState.statusMessage = P25ImbeNative.isAvailable ? "ON AIR · IMBE" : "ON AIR · CLEAR PCM"
            uiState.isTransmitting = true
            voiceTransport.beginUplink()
            voiceAudio.startCapture()
        } catch {
            guard uiState.isPttPressed else { return }
            enterBusy("AIR CHECK FAILED")
        }
    }

    /// Single funnel for the "PTT denied" UX so the busy beep, the busy-tone
    /// flag, and the status message stay in sync no matter which guard tripped.
    private func enterBusy(_ message: String) {
        uiState.pttBusyTone = true
        uiState.statusMessage = message
        sounds.play(.busy)
    }

    private func onPttReleased() {
        uiState.isPttPressed = false
        uiState.pttBusyTone = false
        // Cut the busy cue immediately when PTT is released. Without this,
        // releasing PTT before the ~2s busy clip finishes leaves audio still
        // playing while the status strip already says "RX IDLE", which masks
        // any subsequent cues (channel switch, next PTT) and confuses the
        // operator. Safe to call unconditionally — stop() is a no-op when the
        // cue isn't playing.
        sounds.stop(.busy)
        if uiState.isTransmitting {
            voiceAudio.stopCapture()
            uiState.isTransmitting = false
        }
        // Always drop any fractional IMBE accumulator tail so a denied/aborted
        // key-up cannot leak stale audio into the next transmission.
        voiceTransport.resetUplinkState()
        uiState.statusMessage = "RX IDLE"
    }

    // MARK: - emergency / GPS

    /// Emergency is safety-critical: the local state is only confirmed once the
    /// server accepts it, and rolled back if the request fails.
    private func toggleEmergency() {
        let activating = !uiState.isEmergencyActive
        uiState.isEmergencyActive = activating
        uiState.statusMessage = activating ? "EMERGENCY — SENDING…" : "EMERGENCY — CLEARING…"
        // Local feedback fires immediately on the activating edge — the
        // operator should hear the alert tone whether or not the server call
        // round-trips. The Task below will roll back the UI state if the
        // request fails, but the tone has already played as confirmation.
        if activating {
            sounds.play(.emergency)
        }
        let channel = currentChannel
        // Log the outbound call up front so we can correlate the request with
        // any failure that follows. Operator reports of "I pressed emergency
        // and nothing happened" are otherwise un-debuggable — the failure path
        // historically just showed "EMERGENCY SEND FAILED" with no hint at
        // whether it was network, auth, or a server 500.
        logger.notice(
            "emergency request unit=\(self.unitId, privacy: .public) channel=\(channel ?? "<none>", privacy: .public) active=\(activating)"
        )
        Task {
            do {
                try await api.setEmergency(
                    unitId: unitId,
                    channel: channel,
                    active: activating,
                    message: activating ? "Emergency activated" : nil
                )
                logger.notice(
                    "emergency OK unit=\(self.unitId, privacy: .public) active=\(activating)"
                )
                uiState.statusMessage = activating ? "EMERGENCY ACTIVE" : "EMERGENCY OFF"
            } catch {
                let detail = String(describing: error)
                logger.error(
                    "emergency FAILED unit=\(self.unitId, privacy: .public) active=\(activating) error=\(detail, privacy: .public)"
                )
                uiState.isEmergencyActive = !activating
                let prefix = activating ? "EMERGENCY SEND FAILED" : "EMERGENCY CLEAR FAILED"
                // Surface a short error hint in the status strip so an operator
                // sees something actionable without needing Console.app.
                uiState.statusMessage = "\(prefix) — \(shortErrorTag(error))"
            }
        }
    }

    /// Compact, fixed-width error tag for the status strip. Keeps the message
    /// readable on the small operator display while still distinguishing the
    /// common failure modes (HTTP 4xx/5xx vs no network vs timeout).
    private func shortErrorTag(_ error: Error) -> String {
        if let radio = error as? RadioApiError {
            switch radio {
            case .invalidURL: return "BAD URL"
            case .badStatus(let code): return "HTTP \(code)"
            }
        }
        if let urlError = error as? URLError {
            switch urlError.code {
            case .notConnectedToInternet: return "OFFLINE"
            case .timedOut: return "TIMEOUT"
            case .cannotFindHost, .cannotConnectToHost: return "NO HOST"
            default: return "NET \(urlError.code.rawValue)"
            }
        }
        return "ERR"
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
