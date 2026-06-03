import AVFoundation
import Combine
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
    private let scanTransport: ScanVoiceListenTransport
    private let sounds = RadioSounds()
    private let unitId: String
    /// Cancels the "SCAN: <ch>" banner after voice activity on the scan
    /// channel goes quiet.
    private var scanBannerClearTask: Task<Void, Never>?
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
    private var pttAirPollTask: Task<Void, Never>?
    private var hardwarePtt: HardwarePttController?
    private var hardwarePttCancellable: AnyCancellable?
    private var remotePttObserver: NSObjectProtocol?
    private var lastReceivedAudio = Data()

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
        scanTransport = ScanVoiceListenTransport(
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
        locationReporter.start()
        wireVoiceCallbacks()
        NetworkPathMonitor.shared.onChange = { [weak self] reachable in
            Task { @MainActor in
                guard reachable, let self else { return }
                self.voiceTransport.retryNow()
                self.scanTransport.retryNow()
            }
        }

        hardwarePtt = HardwarePttController(
            onPress: { [weak self] in self?.handle(.pttPressed) },
            onRelease: { [weak self] in self?.handle(.pttReleased) }
        )
        let store = SettingsStore.shared
        if store.hardwarePttEnabled { hardwarePtt?.enable() }
        hardwarePttCancellable = store.$hardwarePttEnabled
            .receive(on: RunLoop.main)
            .sink { [weak self] enabled in
                if enabled { self?.hardwarePtt?.enable() } else { self?.hardwarePtt?.disable() }
            }

        remotePttObserver = NotificationCenter.default.addObserver(
            forName: .safetPttRemote,
            object: nil,
            queue: nil
        ) { [weak self] note in
            let action = (note.userInfo?["action"] as? String) ?? ""
            Task { @MainActor in
                guard let self else { return }
                if action == "press" { self.handle(.pttPressed) }
                else if action == "release" { self.handle(.pttReleased) }
            }
        }
        scanTransport.onScanRx = { [weak self] channel in
            self?.handleScanRx(channel: channel)
        }
        startClock()
        startPresencePolling()
        startInboxPolling()
        startTalkHintsPolling()
        startCatalogRefreshPolling()
        Task { await loadCatalog() }
    }

    deinit {
        if let observer = remotePttObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        // Tear the Live Activity down synchronously so a quick re-login
        // (which constructs a fresh RVM and calls `startOrUpdate`) can't race
        // with the prior RVM's async end(). Calling `end()` from MainActor
        // here is safe — deinit may be called off-main, but
        // RadioLiveActivityController.end() flips its currentActivity to nil
        // synchronously inside the Task we dispatch below.
        Task { @MainActor [voiceTransport, voiceAudio, scanTransport] in
            voiceTransport.disconnect()
            scanTransport.disconnect()
            voiceAudio.stop()
            if #available(iOS 16.2, *) {
                RadioLiveActivityController.shared.end()
            }
            // Drop the network callback so a stale `[weak self]` capture
            // doesn't keep firing into a half-torn-down VM after deinit. The
            // RootView's `.id(user.id)` switch can otherwise leave the
            // singleton pointing at a deallocated closure.
            NetworkPathMonitor.shared.onChange = nil
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
        case .toggleScan: toggleScan()
        case .setScanChannels(let channels): setScanChannels(channels)
        }
    }

    func replay() {
        guard !lastReceivedAudio.isEmpty else { return }
        voiceAudio.enqueueIncoming(lastReceivedAudio)
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
            uiState.channelCatalog = channelNames
            // Only stamp the connection start on the rising edge — `loadCatalog()`
            // runs every 15s from the polling loop, and resetting `connectionStartedAt`
            // unconditionally would snap the "Connected · Ns" counter back to 0
            // every refresh.
            if uiState.connectionStartedAt == nil { uiState.connectionStartedAt = Date() }
            uiState.isReconnecting = false
            if #available(iOS 16.2, *), let channel = channelNames.indices.contains(channelIndex) ? channelNames[channelIndex] : channelNames.first {
                RadioLiveActivityController.shared.startOrUpdate(
                    channel: channel,
                    callsign: nil,
                    stateLabel: "IDLE"
                )
            }
            // Drop any scan entries that no longer exist in the catalog so the
            // picker / transport never tries to listen to a removed channel.
            let validKeys = Set(channelNames.map { $0.lowercased() })
            uiState.scanIncludedChannels = uiState.scanIncludedChannels.intersection(validKeys)
            applyTuning()
            uiState.statusMessage = "READY"
            locationReporter.setChannel(currentChannel)
            await startVoiceIfNeeded()
            if let channel = currentChannel {
                voiceTransport.join(channel: channel)
            }
            refreshScanTransport()
            await pulsePresence()
        } catch {
            uiState.channelsLoading = false
            uiState.networkLabel = "OFFLINE"
            uiState.channelSyncError = "Channel sync failed"
            uiState.statusMessage = "SYNC FAILED"
            uiState.connectionStartedAt = nil
            refreshScanTransport()
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
            if #available(iOS 16.2, *) {
                RadioLiveActivityController.shared.startOrUpdate(
                    channel: channel,
                    callsign: nil,
                    stateLabel: "IDLE"
                )
            }
        }
        // The home channel is excluded from the scan listen set, so a tune
        // change has to refresh the transport even if the scan list itself
        // didn't change.
        refreshScanTransport()
        Task { await pulsePresence() }
    }

    // MARK: - voice glue

    private func wireVoiceCallbacks() {
        voiceAudio.onCapturedFrame = { [weak self] frame, captureSessionId in
            self?.voiceTransport.sendCaptured(frame, captureSessionId: captureSessionId)
        }
        voiceAudio.onEnqueuedIncoming = { [weak self] pcm16 in
            guard let self else { return }
            self.lastReceivedAudio.append(pcm16)
            let maxBytes = 320 * 150
            if self.lastReceivedAudio.count > maxBytes {
                let excess = self.lastReceivedAudio.count - maxBytes
                self.lastReceivedAudio.removeFirst(excess)
            }
        }
        voiceTransport.onJoined = { [weak self] joined in
            guard let self else { return }
            self.uiState.canTransmit = joined.permission != .listenOnly
            self.uiState.statusMessage = joined.permission == .listenOnly ? "MONITOR ONLY" : "READY"
            // Only stamp the connection start on (re)connect — set it when
            // we don't have one yet, OR when we were just reconnecting (the
            // transition out of the amber pill is the natural "reset clock"
            // moment). Steady-state `joined` frames must NOT reset the timer.
            if self.uiState.connectionStartedAt == nil || self.uiState.isReconnecting {
                self.uiState.connectionStartedAt = Date()
            }
            self.uiState.isReconnecting = false
        }
        voiceTransport.onError = { [weak self] code in
            guard let self else { return }
            self.uiState.statusMessage = "LINK: \(code.uppercased())"
            // Don't flip isReconnecting here — server-pushed `error` frames
            // are normal traffic and would latch the amber pill forever.
            // The transport raises `onLinkLost` only when the socket has
            // actually dropped, which is where the pill belongs.
        }
        voiceTransport.onLinkLost = { [weak self] in
            self?.uiState.isReconnecting = true
        }
        voiceTransport.onReceivingChange = { [weak self] receiving in
            guard let self else { return }
            self.uiState.isReceivingAudio = receiving
            if #available(iOS 16.2, *), let channel = self.currentChannel {
                if receiving {
                    let callsign = self.uiState.activeTalkUnitId.isEmpty ? nil : self.uiState.activeTalkUnitId
                    RadioLiveActivityController.shared.startOrUpdate(
                        channel: channel,
                        callsign: callsign,
                        stateLabel: "RX"
                    )
                } else if !self.uiState.isTransmitting {
                    RadioLiveActivityController.shared.startOrUpdate(
                        channel: channel,
                        callsign: nil,
                        stateLabel: "IDLE"
                    )
                }
            }
        }
        voiceTransport.onBusy = { [weak self] holder in
            guard let self, self.uiState.isPttPressed else { return }
            let peer = holder?.uppercased()
            if peer == nil || peer != self.unitId {
                let msg = peer.map { "CHANNEL BUSY — \($0)" } ?? "CHANNEL BUSY"
                self.enterBusy(msg)
                self.voiceAudio.stopCapture()
                self.voiceTransport.stopUplinkCapture()
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
        startPttAirPolling()
        do {
            let air = try await api.airState(channel: currentChannel)
            guard uiState.isPttPressed else { return }
            let busy = channelBusyForLocalPtt(air)
            if busy {
                let peer = air.transmittingUnitId?.uppercased() ?? ""
                enterBusy(peer.isEmpty ? "CHANNEL BUSY" : "CHANNEL BUSY — \(peer)")
                return
            }
            // Air is clear — play the permit beep, then start capturing. The beep
            // overlaps the first ~250 ms of mic capture; that's how Android does
            // it too, and the listener side hasn't started decoding yet anyway.
            sounds.play(.pttPermit)
            uiState.statusMessage = P25ImbeNative.isAvailable ? "ON AIR · IMBE" : "ON AIR · CLEAR PCM"
            uiState.isTransmitting = true
            if #available(iOS 16.2, *), let channel = currentChannel {
                RadioLiveActivityController.shared.startOrUpdate(
                    channel: channel,
                    callsign: uiState.localShortUnitId,
                    stateLabel: "TX"
                )
            }
            guard let captureSessionId = voiceAudio.startCapture() else {
                uiState.isTransmitting = false
                enterBusy("VOICE UNAVAILABLE")
                voiceTransport.stopUplinkCapture()
                return
            }
            voiceTransport.startUplinkCapture(sessionId: captureSessionId)
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
        pttAirPollTask?.cancel()
        pttAirPollTask = nil
        uiState.isPttPressed = false
        uiState.pttBusyTone = false
        uiState.activeTalkUnitId = ""
        uiState.activeTalkDisplayName = ""
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
        // Always tear down uplink state so a denied/aborted key-up cannot leak
        // stale PCM/IMBE data into the next transmission.
        voiceTransport.stopUplinkCapture()
        uiState.statusMessage = "RX IDLE"
        if #available(iOS 16.2, *), let channel = currentChannel {
            RadioLiveActivityController.shared.startOrUpdate(
                channel: channel,
                callsign: nil,
                stateLabel: "IDLE"
            )
        }
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

    private func handleLocationAuth(_ authorized: Bool) {
        uiState.locationAuthorized = authorized
        if !authorized {
            uiState.statusMessage = "GPS — NO LOCATION ACCESS"
        }
    }

    // MARK: - scan

    private func toggleScan() {
        uiState.scanActive.toggle()
        if !uiState.scanActive {
            uiState.scanRxChannel = nil
            scanBannerClearTask?.cancel()
            scanBannerClearTask = nil
        }
        uiState.statusMessage = uiState.scanActive ? scanStatusMessage() : "SCAN OFF"
        refreshScanTransport()
    }

    private func setScanChannels(_ channels: Set<String>) {
        let valid = Set(channelNames.map { $0.lowercased() })
        uiState.scanIncludedChannels = channels.intersection(valid)
        if uiState.scanActive {
            uiState.statusMessage = scanStatusMessage()
        }
        refreshScanTransport()
    }

    private func refreshScanTransport() {
        let labels = Set(channelNames.filter {
            uiState.scanIncludedChannels.contains($0.lowercased())
        })
        scanTransport.updateScanListen(
            homeChannel: currentChannel,
            scanChannels: labels,
            networkOnline: uiState.networkLabel == "ONLINE",
            scanActive: uiState.scanActive
        )
    }

    /// `SCAN ON` with the count of channels actually being listened to
    /// (excluding the home channel, which is already on the primary socket).
    private func scanStatusMessage() -> String {
        let home = currentChannel?.lowercased()
        let listening = uiState.scanIncludedChannels.filter { $0 != home }.count
        return listening > 0 ? "SCAN ON · \(listening) CH" : "SCAN ON · PICK CHANNELS"
    }

    private func handleScanRx(channel: String) {
        guard uiState.scanActive else { return }
        uiState.scanRxChannel = channel
        scanBannerClearTask?.cancel()
        scanBannerClearTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(800))
            guard let self, !Task.isCancelled else { return }
            if self.uiState.scanRxChannel == channel {
                self.uiState.scanRxChannel = nil
            }
        }
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

    private func startCatalogRefreshPolling() {
        Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(VoiceTiming.catalogPollSeconds))
                guard let self else { return }
                if self.uiState.networkLabel == "ONLINE" {
                    await self.loadCatalog()
                }
            }
        }
    }

    private func startTalkHintsPolling() {
        Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let snap = self.uiState
                let fast =
                    !snap.rxAttributedLine.isEmpty ||
                    !snap.activeTalkUnitId.isEmpty ||
                    snap.isPttPressed
                let delay = fast
                    ? VoiceTiming.talkActivityFastPollSeconds
                    : VoiceTiming.talkActivityPollSeconds
                try? await Task.sleep(for: .seconds(delay))
                await self.pollTalkHints()
            }
        }
    }

    private func pollTalkHints() async {
        guard uiState.networkLabel == "ONLINE" else {
            if !uiState.rxAttributedLine.isEmpty || !uiState.activeTalkUnitId.isEmpty {
                uiState.rxAttributedLine = ""
                uiState.activeTalkUnitId = ""
                uiState.activeTalkDisplayName = ""
                uiState.rxFromScan = false
            }
            return
        }
        let tuned = currentChannel?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !tuned.isEmpty, tuned != "----" else { return }

        let scanParam: String? = {
            guard uiState.scanActive else { return nil }
            let home = tuned.lowercased()
            let names = uiState.scanIncludedChannels
                .filter { $0 != home }
                .sorted()
            return names.isEmpty ? nil : names.joined(separator: ",")
        }()

        let air = try? await api.airState(channel: tuned)
        let dto = try? await api.talkActivity(home: tuned, scan: scanParam)

        let homeAirLine = rxLineFromLiveVoice(air: air)
        let mockHome = mockMainAttribution(dto: dto, tuned: tuned)
        let homeLine = homeAirLine.isEmpty ? mockHome : homeAirLine
        let scanLine = mockScanAttribution(dto: dto, tuned: tuned)
        let merged = homeLine.isEmpty ? scanLine : homeLine
        let mergedFromScan = homeLine.isEmpty && !scanLine.isEmpty
        let (talkUnit, talkName) = resolveActiveTalkAttribution(air: air)

        if merged != uiState.rxAttributedLine ||
            mergedFromScan != uiState.rxFromScan ||
            talkUnit != uiState.activeTalkUnitId ||
            talkName != uiState.activeTalkDisplayName {
            uiState.rxAttributedLine = merged
            uiState.rxFromScan = mergedFromScan
            uiState.activeTalkUnitId = talkUnit
            uiState.activeTalkDisplayName = talkName
        }
    }

    private func startPttAirPolling() {
        pttAirPollTask?.cancel()
        pttAirPollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                guard self.uiState.isPttPressed else { return }
                if self.uiState.networkLabel == "ONLINE", let ch = self.currentChannel {
                    if let air = try? await self.api.airState(channel: ch) {
                        if self.channelBusyForLocalPtt(air), self.uiState.isPttPressed {
                            let peer = air.transmittingUnitId?.uppercased() ?? ""
                            self.enterBusy(peer.isEmpty ? "CHANNEL BUSY" : "CHANNEL BUSY — \(peer)")
                            self.voiceAudio.stopCapture()
                            self.voiceTransport.stopUplinkCapture()
                            self.uiState.isTransmitting = false
                        }
                    }
                }
                try? await Task.sleep(for: .seconds(VoiceTiming.airPollWhilePttSeconds))
            }
        }
    }

    private func channelBusyForLocalPtt(_ air: AirState) -> Bool {
        guard air.occupied else { return false }
        if air.transmittingYields == true { return false }
        let peer = air.transmittingUnitId?.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() ?? ""
        return !peer.isEmpty && peer != unitId.uppercased()
    }

    private func resolveActiveTalkAttribution(air: AirState?) -> (String, String) {
        if uiState.isEmergencyActive {
            return (unitId.uppercased(), uiState.operatorDisplayName)
        }
        if uiState.isPttPressed && !uiState.pttBusyTone {
            return (unitId.uppercased(), uiState.operatorDisplayName)
        }
        guard let tx = air?.transmittingUnitId?.trimmingCharacters(in: .whitespacesAndNewlines).uppercased(),
              !tx.isEmpty else {
            return ("", "")
        }
        if tx == unitId.uppercased() { return ("", "") }
        let name = air?.transmittingDisplayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return (tx, name)
    }

    private func rxLineFromLiveVoice(air: AirState?) -> String {
        guard let tx = air?.transmittingUnitId?.trimmingCharacters(in: .whitespacesAndNewlines).uppercased(),
              !tx.isEmpty else { return "" }
        if tx == unitId.uppercased() { return "" }
        if uiState.channelTen33 { return "" }
        let name = air?.transmittingDisplayName?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let name, !name.isEmpty {
            return "RX: \(tx) • \(name)"
        }
        return "RX: \(tx) • VOICE"
    }

    private func mockMainAttribution(dto: TalkActivity?, tuned: String) -> String {
        guard let main = dto?.main, main.active, channelsMatch(main.channel, tuned) else { return "" }
        if isLocalTalker(unitId: main.unitId) { return "" }
        return formatTalker(snapshot: main, prefix: "RX")
    }

    private func mockScanAttribution(dto: TalkActivity?, tuned: String) -> String {
        guard uiState.scanActive, let scan = dto?.scan, scan.active else { return "" }
        let scanCh = scan.channel.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !scanCh.isEmpty, !channelsMatch(scanCh, tuned) else { return "" }
        let included = uiState.scanIncludedChannels.contains(scanCh.lowercased())
        guard included, !isLocalTalker(unitId: scan.unitId) else { return "" }
        return formatTalker(snapshot: scan, prefix: "RX")
    }

    private func formatTalker(snapshot: TalkerSnapshot, prefix: String) -> String {
        let uid = snapshot.unitId?.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() ?? "---"
        let un = snapshot.username?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let un, !un.isEmpty {
            return "\(prefix): \(uid) • \(un)"
        }
        return "\(prefix): \(uid)"
    }

    private func isLocalTalker(unitId raw: String?) -> Bool {
        let talker = raw?.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() ?? ""
        return !talker.isEmpty && talker == unitId.uppercased()
    }

    private func channelsMatch(_ a: String, _ b: String) -> Bool {
        a.trimmingCharacters(in: .whitespacesAndNewlines)
            .caseInsensitiveCompare(b.trimmingCharacters(in: .whitespacesAndNewlines)) == .orderedSame
    }

    private func startPresencePolling() {
        Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(VoiceTiming.presencePollSeconds))
                guard let self else { return }
                await self.pulsePresence()
            }
        }
    }

    private func pulsePresence() async {
        guard uiState.networkLabel == "ONLINE", let channel = currentChannel else {
            uiState.radiosOnlineOnChannel = nil
            uiState.unitsOnChannel = []
            return
        }
        do {
            try await api.presenceHeartbeat(unitId: unitId, channel: channel)
            let count = try await api.presenceCount(channel: channel)
            uiState.radiosOnlineOnChannel = max(count, 0)

            let allUnits = try await api.positions()
            let channelUnits = allUnits
                .filter { $0.channelName?.lowercased() == channel.lowercased() }
                .compactMap(\.displayName)
                .sorted()
            uiState.unitsOnChannel = channelUnits
        } catch {
            uiState.radiosOnlineOnChannel = nil
            uiState.unitsOnChannel = []
        }
    }

    private func startInboxPolling() {
        Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(VoiceTiming.inboxPollSeconds))
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
            let ten33Active = currentChannel.map { ch in
                response.ten33.contains { channelsMatch($0, ch) }
            } ?? false
            if ten33Active != uiState.channelTen33 {
                let was = uiState.channelTen33
                uiState.channelTen33 = ten33Active
                if was && !ten33Active {
                    uiState.rxAttributedLine = ""
                    uiState.activeTalkUnitId = ""
                    uiState.activeTalkDisplayName = ""
                    uiState.rxFromScan = false
                }
            }
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
