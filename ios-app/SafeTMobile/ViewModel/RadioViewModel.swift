import AVFoundation
import Combine
import Foundation
import os
import WidgetKit

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
    /// Full channel records (zone grouping + permission) parallel to
    /// `channelNames`, kept so tuning can surface the zone prefix and the PTT
    /// permission gate without a second fetch.
    private var channelDTOs: [ChannelDTO] = []
    private var channelIndex = 0
    private var inboxSince = 0
    private var inboxPrimed = false
    /// Consecutive generic-401 catalog failures. Two in a row are treated as a
    /// definitive token rejection (expired / rotated secret) — see loadCatalog.
    private var consecutiveUnauthorized = 0
    /// Bumped on every emergency toggle so an out-of-order request completion
    /// (rapid double-tap) can't apply a stale result to this safety-critical state.
    private var emergencyGeneration = 0
    /// True once the persisted scan picks have been restored into the catalog
    /// (only on the first catalog load, so later refreshes don't clobber edits).
    private var scanRestored = false
    private var voiceStarted = false
    private var pttAirPollTask: Task<Void, Never>?

    /// Live-transcript poll state. `transcriptPrimed` suppresses surfacing a
    /// pre-existing transcript on (re)start / channel switch; `lastShownTranscriptId`
    /// dedupes; `liveTranscriptClearTask` fades the banner after a while.
    private var transcriptPrimed = false
    private var lastShownTranscriptId = 0
    private var liveTranscriptClearTask: Task<Void, Never>?

    /// Post-release capture drain (see `onPttReleased`); cancelled by a re-key.
    private var pttReleaseDrainTask: Task<Void, Never>?

    /// Monotonic key-up counter so a stale release-drain can't stop a newer hold's mic.
    private var pttHoldGeneration: UInt64 = 0
    private var hardwarePtt: HardwarePttController?
    private var hardwarePttCancellable: AnyCancellable?
    private var volumeCancellable: AnyCancellable?
    private var boostCancellable: AnyCancellable?
    private var routeCancellable: AnyCancellable?
    private var remotePttObserver: NSObjectProtocol?
    /// Ownership token for the NetworkPathMonitor callback — lets deinit clear
    /// only OUR registration, never a successor view-model's.
    private var networkCallbackToken = 0
    private var lastReceivedAudio = Data()

    private static let widgetDefaults = UserDefaults(suiteName: "group.com.safetptt.mobile")

    /// Post-release mic drain (Android parity): keeps capturing briefly so the
    /// final word's buffered audio reaches the relay instead of being cut off.
    private static let txReleaseTailNanoseconds: UInt64 = 400_000_000
    /// Settle guard added on top of the permit tone's own length when muting the
    /// uplink at key-up, so the tone's acoustic tail / output latency can't bleed
    /// onto the air. See onPttPressed.
    private static let permitTailGuardSeconds: TimeInterval = 0.15
    /// Larger guard when the output is Bluetooth: A2DP/HFP latency keeps the tone
    /// sounding in the earpiece well after the phone finishes it, so the mic has to
    /// wait longer for the full tone to clear before transmitting.
    private static let permitTailGuardBluetoothSeconds: TimeInterval = 0.3

    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

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
        uiState.pageMessages = loadPersistedPages()

        locationReporter.onAuthorizationChange = { [weak self] authorized in
            Task { @MainActor in self?.handleLocationAuth(authorized) }
        }
        locationReporter.start()
        wireVoiceCallbacks()
        networkCallbackToken = NetworkPathMonitor.shared.setCallback { [weak self] reachable in
            Task { @MainActor in
                guard reachable, let self else { return }
                self.voiceTransport.retryNow()
                self.scanTransport.retryNow()
                // Connectivity is back — resync the REST side right away too
                // instead of waiting for the next 15 s catalog tick.
                if !self.uiState.channelsLoading, self.uiState.networkLabel != "ONLINE" {
                    await self.loadCatalog()
                }
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
        startTranscriptPolling()
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
        Task { @MainActor [voiceTransport, voiceAudio, scanTransport, networkCallbackToken] in
            voiceTransport.disconnect()
            scanTransport.disconnect()
            voiceAudio.stop()
            if #available(iOS 16.2, *) {
                RadioLiveActivityController.shared.end()
            }
            // Drop OUR network callback (token-guarded) so a stale `[weak self]`
            // capture doesn't keep firing after deinit. Token-guarded because a
            // session handoff (silent re-auth / RootView `.id` switch) registers
            // the successor VM's callback before this async teardown runs — an
            // unconditional clear would disconnect the new VM.
            NetworkPathMonitor.shared.clearCallback(token: networkCallbackToken)
        }
    }

    func handle(_ event: RadioUiEvent) {
        switch event {
        case .retryChannelSync: Task { await loadCatalog() }
        case .channelUp: bumpChannel(1)
        case .channelDown: bumpChannel(-1)
        case .zoneUp: bumpZone(1)
        case .zoneDown: bumpZone(-1)
        case .selectChannel(let index): selectChannel(index)
        case .pttPressed: Task { await onPttPressed() }
        case .pttReleased: onPttReleased()
        case .emergencyToggle: toggleEmergency()
        case .toggleScan: toggleScan()
        case .setScanChannels(let channels): setScanChannels(channels)
        case .loadPageImage(let id): loadPageImage(id)
        case .respondToPage(let id, let response): respondToPage(id: id, response: response)
        case .markPagesRead: markPagesRead()
        }
    }

    func replay() {
        guard !lastReceivedAudio.isEmpty else { return }
        voiceAudio.replayAudio(lastReceivedAudio)
    }

    // MARK: - app lifecycle (Live Activity)

    /// Keep the Live Activity alive when the app leaves the foreground so the
    /// Dynamic Island keeps showing the channel + who is talking while the app
    /// runs in the background. The `audio` background mode keeps the voice
    /// socket — and the RX `air_claimed`/`air_released` handlers — live, and
    /// `Activity.update` works locally from those handlers without push tokens
    /// (the app is never suspended while audio is active). We just refresh to
    /// the current state on the way out; an activity stranded by a real process
    /// kill is reaped at next launch by `endOrphanedActivities()`.
    func endLiveActivityForBackground() {
        if #available(iOS 16.2, *) { refreshLiveActivity() }
    }

    /// Re-sync the Live Activity on return to the foreground.
    func reassertLiveActivity() {
        if #available(iOS 16.2, *) { refreshLiveActivity() }
    }

    /// Push the current channel / TX-RX-IDLE state / active talker (and the
    /// scanned channel a talker is on) to the Dynamic Island. Safe to call from
    /// the RX handlers, PTT edges, and scene transitions — `startOrUpdate`
    /// requests the activity once and updates it in place thereafter.
    @available(iOS 16.2, *)
    private func refreshLiveActivity() {
        guard let channel = currentChannel else { return }
        let stateLabel: String
        let callsign: String?
        if uiState.isTransmitting {
            stateLabel = "TX"
            callsign = uiState.localShortUnitId
        } else if uiState.isReceivingAudio || !uiState.activeTalkUnitId.isEmpty
                    || !uiState.rxAttributedLine.isEmpty || uiState.scanRxChannel != nil {
            // Home-channel voice, a poll-attributed talker, or live traffic on
            // a scanned channel all count as RX — the island should never sit
            // on IDLE while the speaker is playing someone.
            stateLabel = "RX"
            callsign = uiState.activeTalkUnitId.isEmpty ? nil : uiState.activeTalkUnitId
        } else {
            stateLabel = "IDLE"
            callsign = nil
        }
        let info = liveActivityTalkerInfo()
        RadioLiveActivityController.shared.startOrUpdate(
            channel: channel,
            callsign: callsign,
            stateLabel: stateLabel,
            talker: stateLabel == "IDLE" ? nil : info.talker,
            scanChannel: stateLabel == "IDLE" ? nil : info.scanChannel
        )
    }

    /// Derive the active-talker label and — when the traffic is on a scanned
    /// channel rather than the tuned one — the scanned channel name for the
    /// Live Activity, from the same state the in-app RX display uses.
    private func liveActivityTalkerInfo() -> (talker: String?, scanChannel: String?) {
        let unit = uiState.activeTalkUnitId
        let name = uiState.activeTalkDisplayName
        let talker: String?
        if !unit.isEmpty {
            talker = name.isEmpty ? unit : "\(unit) · \(name)"
        } else if !uiState.rxAttributedLine.isEmpty {
            talker = uiState.rxAttributedLine
        } else {
            talker = nil
        }
        // Surface the scanned channel whenever scan audio is what's playing.
        // `scanRxChannel` is set the instant a scan frame reaches the speaker,
        // independent of the slower poll attribution.
        let scanChannel: String?
        if let ch = uiState.scanRxChannel, !ch.isEmpty {
            scanChannel = ch
        } else {
            scanChannel = nil
        }
        return (talker, scanChannel)
    }

    // MARK: - widget data

    private func updateWidgetData() {
        let d = Self.widgetDefaults ?? .standard
        d.set(uiState.channelLabel, forKey: "widget.channelName")
        d.set(uiState.radiosOnlineOnChannel ?? 0, forKey: "widget.usersCount")
        let status: String
        if uiState.isTransmitting { status = "TX" }
        else if uiState.isReceivingAudio { status = "RX" }
        else if uiState.networkLabel == "ONLINE" { status = "IDLE" }
        else { status = "OFFLINE" }
        d.set(status, forKey: "widget.statusLabel")
        WidgetCenter.shared.reloadTimelines(ofKind: "RadioWidget")
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
            channelDTOs = channels
            channelNames = channels.map(\.name)
            channelIndex = min(channelIndex, max(channelNames.count - 1, 0))
            rebuildChannelOptions()
            uiState.channelsLoading = false
            uiState.channelSyncError = nil
            consecutiveUnauthorized = 0
            uiState.networkLabel = "ONLINE"
            uiState.channelCatalog = channelNames
            // Only stamp the connection start on the rising edge — `loadCatalog()`
            // runs every 15s from the polling loop, and resetting `connectionStartedAt`
            // unconditionally would snap the "Connected · Ns" counter back to 0
            // every refresh.
            if uiState.connectionStartedAt == nil { uiState.connectionStartedAt = Date() }
            uiState.isReconnecting = false
            // Drop any scan entries that no longer exist in the catalog so the
            // picker / transport never tries to listen to a removed channel.
            let validKeys = Set(channelNames.map { $0.lowercased() })
            if !scanRestored {
                // First catalog load: restore the operator's persisted scan picks
                // (and armed state) so they survive a relaunch — mirrors Android.
                scanRestored = true
                let saved = SettingsStore.shared.savedScanChannels.intersection(validKeys)
                uiState.scanIncludedChannels = saved
                uiState.scanActive = SettingsStore.shared.savedScanActive && !saved.isEmpty
            } else {
                uiState.scanIncludedChannels = uiState.scanIncludedChannels.intersection(validKeys)
            }
            applyTuning()
            // Re-derive the Live Activity from CURRENT state rather than
            // forcing "IDLE". This runs from the 15 s catalog poll — the old
            // hard-coded IDLE write kept stomping the island back to idle even
            // while someone was actively talking (the "island always says
            // idle" bug).
            if #available(iOS 16.2, *) { refreshLiveActivity() }
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
            // Auth handling: a DEFINITIVE session-invalid error (account
            // disabled, superseded console session, agency disabled) reports
            // an auth rejection immediately. A generic 401 (`unauthorized`) is
            // what an EXPIRED or secret-rotated token produces — the server
            // can't tell us more — but a single one is also what a proxy blip
            // can look like, so it only counts as a rejection after two in a
            // row. Rejections trigger the shell's silent re-auth (see
            // RadioScreen.onChange(authRejectionCount)) instead of stranding
            // the operator on a permanently broken radio.
            if let apiError = error as? RadioApiError, apiError.isTerminalSession {
                consecutiveUnauthorized = 0
                uiState.authRejectionCount += 1
                uiState.statusMessage = "SIGN IN REQUIRED"
                uiState.channelSyncError = "Session expired — signing in again"
            } else if let apiError = error as? RadioApiError, apiError.status == 401 {
                consecutiveUnauthorized += 1
                if consecutiveUnauthorized >= 2 {
                    uiState.authRejectionCount += 1
                    uiState.statusMessage = "SIGN IN REQUIRED"
                    uiState.channelSyncError = "Session expired — signing in again"
                } else {
                    uiState.channelSyncError = "Channel sync failed"
                    uiState.statusMessage = "SYNC FAILED"
                }
            } else {
                consecutiveUnauthorized = 0
                uiState.channelSyncError = "Channel sync failed"
                uiState.statusMessage = "SYNC FAILED"
            }
            uiState.connectionStartedAt = nil
            refreshScanTransport()
        }
    }

    private func applyTuning() {
        guard !channelNames.isEmpty else {
            uiState.channelLabel = "----"
            uiState.channelDisplayLabel = "----"
            uiState.zoneLabel = ""
            uiState.channelPosition = "-- / --"
            uiState.displayLine2 = "OPERATIONS"
            updateWidgetData()
            return
        }
        let name = channelNames[channelIndex]
        let dto = channelDTOs.indices.contains(channelIndex) ? channelDTOs[channelIndex] : nil
        uiState.channelLabel = name
        uiState.channelIndex = channelIndex
        if let zoneNumber = dto?.zoneNumber {
            uiState.channelDisplayLabel = "\(zoneNumber) \(name)"
        } else {
            uiState.channelDisplayLabel = name
        }
        uiState.zoneLabel = zoneHeaderLabel(dto)
        // Seed the PTT gate from the channel's permission so a listen-only
        // channel shows the mic greyed out the instant it's tuned — before the
        // voice socket's `joined` ack arrives to confirm it. `isListenOnly` only
        // goes true when the permission is *affirmatively* listen_only (not when
        // it's merely unknown), so a still-loading channel doesn't grey the PTT.
        uiState.canTransmit = permissionAllowsTalk(dto?.permission)
        uiState.isListenOnly = dto?.permission?.lowercased() == "listen_only"
        uiState.channelPosition = String(format: "%02ld / %02ld", channelIndex + 1, channelNames.count)
        uiState.displayLine2 = "OPS: " + name.uppercased()
        updateWidgetData()
    }

    /// Builds the zone/channel dropdown options from the current catalog.
    private func rebuildChannelOptions() {
        uiState.channels = channelDTOs.enumerated().map { index, dto in
            ChannelOption(
                index: index,
                name: dto.name,
                zoneNumber: dto.zoneNumber,
                zoneName: dto.zone,
                aiDispatchEnabled: dto.aiDispatchEnabled ?? false,
                aiDispatchMode: AiDispatchMode(serverValue: dto.aiDispatchMode)
            )
        }
    }

    /// Zone heading for the display, mirroring `ChannelOption.zoneHeader` so the
    /// shell and the dropdown read identically. Empty when the channel is
    /// ungrouped (no zone number and no zone name).
    private func zoneHeaderLabel(_ dto: ChannelDTO?) -> String {
        let trimmed = dto?.zone?.trimmingCharacters(in: .whitespacesAndNewlines)
        switch (dto?.zoneNumber, trimmed) {
        case let (z?, n?) where !n.isEmpty: return "ZONE \(z) · \(n.uppercased())"
        case let (z?, _): return "ZONE \(z)"
        case let (nil, n?) where !n.isEmpty: return n.uppercased()
        default: return ""
        }
    }

    /// Server permission → can-key. Only "listen_only" blocks transmit; an
    /// absent/unknown value is treated as talk-capable and refined by the voice
    /// socket's `joined` ack.
    private func permissionAllowsTalk(_ permission: String?) -> Bool {
        guard let permission else { return true }
        return permission.lowercased() != "listen_only"
    }

    private func bumpChannel(_ delta: Int) {
        guard !channelNames.isEmpty, !uiState.channelsLoading else { return }
        // Cycle only within the zone the current channel belongs to — channel
        // ▲/▼ should stay inside the active zone; crossing zones is the job of
        // the zone ▲/▼ buttons. Fall back to the whole catalog when zone info
        // isn't available (single-zone / ungrouped catalogs).
        let chans = uiState.channels
        let currentZone = chans.first(where: { $0.index == channelIndex })?.zoneNumber
        let zoneIndices = chans
            .filter { $0.zoneNumber == currentZone }
            .map(\.index)
            .sorted()
        guard zoneIndices.count > 1, let pos = zoneIndices.firstIndex(of: channelIndex) else {
            // No usable zone grouping — fall back to full-catalog wrap.
            let target = (channelIndex + delta + channelNames.count) % channelNames.count
            tuneTo(target, announce: delta > 0 ? "CHANNEL +" : "CHANNEL -")
            return
        }
        let target = zoneIndices[(pos + delta + zoneIndices.count) % zoneIndices.count]
        tuneTo(target, announce: delta > 0 ? "CHANNEL +" : "CHANNEL -")
    }

    /// Step to the first channel of the next / previous zone bank. No-op when the
    /// catalog has only one zone (or none). Mirrors the Android zone stepping.
    private func bumpZone(_ delta: Int) {
        guard !uiState.channelsLoading, !uiState.channels.isEmpty else { return }
        let chans = uiState.channels
        // Ordered distinct zones as they appear in the catalog (nil = ungrouped).
        var zoneOrder: [Int?] = []
        for c in chans where !zoneOrder.contains(where: { $0 == c.zoneNumber }) {
            zoneOrder.append(c.zoneNumber)
        }
        guard zoneOrder.count > 1 else { return }
        let currentZone = chans.first(where: { $0.index == channelIndex })?.zoneNumber
        guard let pos = zoneOrder.firstIndex(where: { $0 == currentZone }) else { return }
        let targetZone = zoneOrder[(pos + delta + zoneOrder.count) % zoneOrder.count]
        if let target = chans.first(where: { $0.zoneNumber == targetZone }) {
            tuneTo(target.index, announce: delta > 0 ? "ZONE +" : "ZONE -")
        }
    }

    /// Absolute tune from the zone/channel dropdown picker.
    private func selectChannel(_ index: Int) {
        guard !channelNames.isEmpty, !uiState.channelsLoading else { return }
        guard channelNames.indices.contains(index), index != channelIndex else { return }
        tuneTo(index, announce: "CHANNEL SET")
    }

    /// Shared tuning path for both ▲/▼ stepping and dropdown selection. Re-points
    /// the index, refreshes the display (which re-seeds the PTT gate from the new
    /// channel's permission), rejoins the voice channel, and re-primes presence.
    private func tuneTo(_ index: Int, announce: String) {
        channelIndex = index
        applyTuning()
        sounds.play(.channelSwitch)
        uiState.statusMessage = announce
        uiState.radiosOnlineOnChannel = nil
        // Drop the previous channel's transcript banner and re-prime so the new
        // channel doesn't immediately flash an old transcript.
        liveTranscriptClearTask?.cancel()
        uiState.liveTranscript = ""
        uiState.liveTranscriptWho = ""
        transcriptPrimed = false
        // The inbox is channel-scoped; reset its high-water cursor so pages for
        // the newly tuned channel aren't skipped by a cursor left high from the
        // previous channel.
        inboxSince = 0
        inboxPrimed = false
        // The talker attribution belongs to the channel we just left — clear it
        // so neither the display nor the Live Activity carries it over.
        uiState.rxAttributedLine = ""
        uiState.rxFromScan = false
        uiState.activeTalkUnitId = ""
        uiState.activeTalkDisplayName = ""
        locationReporter.setChannel(currentChannel)
        if let channel = currentChannel {
            voiceTransport.join(channel: channel)
        }
        if #available(iOS 16.2, *) { refreshLiveActivity() }
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
        voiceAudio.playbackVolume = SettingsStore.shared.playbackVolume
        volumeCancellable = SettingsStore.shared.$playbackVolume
            .receive(on: RunLoop.main)
            .sink { [weak self] vol in self?.voiceAudio.playbackVolume = vol }
        voiceAudio.playbackBoost = Self.boostGain(fromDb: SettingsStore.shared.rxBoostDb)
        boostCancellable = SettingsStore.shared.$rxBoostDb
            .receive(on: RunLoop.main)
            .sink { [weak self] db in self?.voiceAudio.playbackBoost = Self.boostGain(fromDb: db) }
        routeCancellable = SettingsStore.shared.$audioRoute
            .receive(on: RunLoop.main)
            .sink { AudioSessionManager.applyRoute($0) }
        voiceTransport.onJoined = { [weak self] joined in
            guard let self else { return }
            // The joined ack names the channel's TX codec — drive the badge.
            self.uiState.channelCodecLabel = joined.codec.displayLabel
            self.uiState.canTransmit = joined.permission != .listenOnly
            self.uiState.isListenOnly = joined.permission == .listenOnly
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
        // Admin flipped the channel's codec while we were connected — refresh
        // the badge. The transport already swapped its TX encoder.
        voiceTransport.onCodecChange = { [weak self] codec in
            self?.uiState.channelCodecLabel = codec.displayLabel
        }
        voiceTransport.onReceivingChange = { [weak self] receiving in
            guard let self else { return }
            self.uiState.isReceivingAudio = receiving
            if #available(iOS 16.2, *) { self.refreshLiveActivity() }
            self.updateWidgetData()
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
        // Relay pushed the channel's talker the moment their first frame hit
        // the air — paint the attribution now instead of waiting for the next
        // talk-activity poll (which lagged the audio by up to ~1.2 s). The
        // poll stays running as the fallback/refresher.
        voiceTransport.onAirClaimed = { [weak self] channel, unit, displayName in
            guard let self else { return }
            if self.uiState.isPttPressed || self.uiState.isEmergencyActive { return }
            if let cur = self.currentChannel, !channel.isEmpty,
               channel.caseInsensitiveCompare(cur) != .orderedSame { return }
            let unitUpper = unit.uppercased()
            if unitUpper.isEmpty || unitUpper == self.unitId { return }
            self.uiState.activeTalkUnitId = unitUpper
            self.uiState.activeTalkDisplayName = displayName ?? ""
            if #available(iOS 16.2, *) { self.refreshLiveActivity() }
        }
        voiceTransport.onAirReleased = { [weak self] channel in
            guard let self else { return }
            if self.uiState.isPttPressed || self.uiState.isEmergencyActive { return }
            if let cur = self.currentChannel, !channel.isEmpty,
               channel.caseInsensitiveCompare(cur) != .orderedSame { return }
            self.uiState.activeTalkUnitId = ""
            self.uiState.activeTalkDisplayName = ""
            if #available(iOS 16.2, *) { self.refreshLiveActivity() }
        }
    }

    /// dB → linear gain for the RX loudness boost, clamped to the setting's
    /// 0–12 dB range.
    private static func boostGain(fromDb db: Float) -> Float {
        powf(10.0, max(0, min(db, 12)) / 20.0)
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
        // A re-key during the post-release drain window owns the mic again —
        // invalidate the pending drain so it can't stop the new hold's capture.
        pttHoldGeneration &+= 1
        pttReleaseDrainTask?.cancel()
        pttReleaseDrainTask = nil
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
        // The REST air probe rides plain HTTPS — it can succeed while the voice
        // WebSocket is still reconnecting, in which case captured frames would
        // silently drop. Don't key up on a dead link.
        guard voiceTransport.isTransmitPathReady else {
            enterBusy("LINK CONNECTING")
            return
        }
        // Instant key-up: permit beep + green + capture immediately so PTT feels
        // like a hardware radio, then validate the channel wasn't already busy in
        // the background (below). startPttAirPolling keeps watching for
        // mid-transmission collisions, and the relay arbitrates server-side — so
        // the worst case of an optimistic key is a brief (~1 s) overlap that the
        // busy check then cuts.
        sounds.play(.pttPermit)
        guard let captureSessionId = voiceAudio.startCapture() else {
            enterBusy("VOICE UNAVAILABLE")
            voiceTransport.stopUplinkCapture()
            return
        }
        voiceTransport.startUplinkCapture(sessionId: captureSessionId)
        // Keep the permit tone (and its acoustic tail) off the air: mute the uplink
        // for the tone's length plus a short settle guard — but ONLY when the tone
        // actually sounded (permitToneSeconds is 0 when UI sounds are off), so we
        // never clip the operator's real speech for a tone they never heard. Capture
        // is already live, so the first words right after the tone still transmit,
        // matching how a real radio's mic opens after the chirp instead of during it.
        let permitToneSeconds = sounds.permitToneSeconds()
        if permitToneSeconds > 0 {
            // On Bluetooth the tone is still sounding in the earpiece after the
            // phone finishes it (A2DP/HFP latency), so wait longer for it to clear.
            let guardSeconds = AudioSessionManager.isBluetoothOutput
                ? Self.permitTailGuardBluetoothSeconds
                : Self.permitTailGuardSeconds
            voiceTransport.holdUplink(forSeconds: permitToneSeconds + guardSeconds)
        }
        uiState.statusMessage = P25ImbeNative.isAvailable ? "ON AIR · IMBE" : "ON AIR · CLEAR PCM"
        uiState.isTransmitting = true
        updateWidgetData()
        if #available(iOS 16.2, *) { refreshLiveActivity() }
        startPttAirPolling()

        // Background busy validation. If the channel was already taken when we
        // keyed, abort to a busy tone and tear the uplink down. A failed probe
        // (transient network blip) is intentionally ignored — the link is up, the
        // relay arbitrates, and the air poll keeps watching, so we don't cut a
        // live transmission over a one-off error.
        do {
            let air = try await api.airState(channel: currentChannel)
            guard uiState.isPttPressed, uiState.isTransmitting else { return }
            if channelBusyForLocalPtt(air) {
                let peer = air.transmittingUnitId?.uppercased() ?? ""
                enterBusy(peer.isEmpty ? "CHANNEL BUSY" : "CHANNEL BUSY — \(peer)")
                voiceAudio.stopCapture()
                voiceTransport.stopUplinkCapture()
                uiState.isTransmitting = false
            }
        } catch {
            // Ignored deliberately — see above.
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
            uiState.isTransmitting = false
            updateWidgetData()
            // Operators were losing the last ~0.5 s of every transmission: the
            // word spoken at release is still in the capture pipeline, and the
            // old immediate stop discarded it (plus the staged fractional
            // frame). Keep capturing briefly so it drains through the encoder,
            // then flush the partial frame and release the air. A re-key bumps
            // the generation and cancels this task.
            pttHoldGeneration &+= 1
            let generation = pttHoldGeneration
            pttReleaseDrainTask?.cancel()
            pttReleaseDrainTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: Self.txReleaseTailNanoseconds)
                guard let self, !Task.isCancelled, generation == self.pttHoldGeneration else { return }
                self.voiceAudio.stopCapture()
                self.voiceTransport.finishUplinkCapture()
            }
        } else {
            // Denied/aborted key-up — tear down immediately so stale PCM/IMBE
            // data can't leak into the next transmission.
            voiceAudio.stopCapture()
            voiceTransport.stopUplinkCapture()
        }
        uiState.statusMessage = "RX IDLE"
        // Derive rather than force IDLE — another unit may already be talking
        // the moment we unkey.
        if #available(iOS 16.2, *) { refreshLiveActivity() }
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
        emergencyGeneration &+= 1
        let gen = emergencyGeneration
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
                // A newer toggle superseded this request — don't clobber its state.
                guard gen == emergencyGeneration else { return }
                uiState.statusMessage = activating ? "EMERGENCY ACTIVE" : "EMERGENCY OFF"
            } catch {
                let detail = String(describing: error)
                logger.error(
                    "emergency FAILED unit=\(self.unitId, privacy: .public) active=\(activating) error=\(detail, privacy: .public)"
                )
                guard gen == emergencyGeneration else { return }
                sounds.play(.error)
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
            case .badStatus(let status, _): return "HTTP \(status)"
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
        persistScan()
        refreshScanTransport()
    }

    private func setScanChannels(_ channels: Set<String>) {
        let valid = Set(channelNames.map { $0.lowercased() })
        uiState.scanIncludedChannels = channels.intersection(valid)
        if uiState.scanActive {
            uiState.statusMessage = scanStatusMessage()
        }
        persistScan()
        refreshScanTransport()
    }

    /// Persist the current scan picks + armed state so they survive relaunch.
    private func persistScan() {
        SettingsStore.shared.saveScanSelection(
            channels: uiState.scanIncludedChannels,
            active: uiState.scanActive
        )
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
        let isNew = uiState.scanRxChannel != channel
        uiState.scanRxChannel = channel
        if isNew, #available(iOS 16.2, *) { refreshLiveActivity() }
        scanBannerClearTask?.cancel()
        scanBannerClearTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(800))
            guard let self, !Task.isCancelled else { return }
            if self.uiState.scanRxChannel == channel {
                self.uiState.scanRxChannel = nil
                if #available(iOS 16.2, *) { self.refreshLiveActivity() }
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
                // Refresh while ONLINE *and* retry while OFFLINE. The poll used
                // to skip whenever the label wasn't ONLINE — but a failed sync
                // sets OFFLINE, so a single blip permanently stopped catalog /
                // presence / inbox polling until the operator tapped RETRY SYNC.
                // Only an in-flight load is skipped.
                if !self.uiState.channelsLoading {
                    await self.loadCatalog()
                }
            }
        }
    }

    /// Polls for the latest received transmission's Whisper transcript and shows
    /// it as a transient banner on the radio display — the live-transcript feature.
    private func startTranscriptPolling() {
        Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                guard let self else { return }
                await self.pollLiveTranscript()
            }
        }
    }

    private func pollLiveTranscript() async {
        guard uiState.networkLabel == "ONLINE",
              let ch = currentChannel,
              !ch.isEmpty, ch != "----" else { return }
        guard let rows = try? await api.transmissions(limit: 8, channel: ch) else { return }
        // Newest first; the most recent COMPLETED transcript from someone else.
        let me = unitId.uppercased()
        guard let latest = rows.sorted(by: { $0.id > $1.id }).first(where: { tx in
            tx.transcriptStatus.lowercased() == "done"
                && !(tx.transcript ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && (tx.unitId?.uppercased() ?? "") != me
        }) else { return }

        if !transcriptPrimed {
            // First poll after a (re)start or channel switch: record the
            // high-water mark so we don't surface an old, pre-existing transcript.
            transcriptPrimed = true
            lastShownTranscriptId = max(lastShownTranscriptId, latest.id)
            return
        }
        guard latest.id > lastShownTranscriptId else { return }
        lastShownTranscriptId = latest.id

        let who = (latest.unitId ?? latest.displayName ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        uiState.liveTranscriptWho = who
        uiState.liveTranscript = (latest.transcript ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        liveTranscriptClearTask?.cancel()
        liveTranscriptClearTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(20))
            guard !Task.isCancelled, let self else { return }
            self.uiState.liveTranscript = ""
            self.uiState.liveTranscriptWho = ""
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
            // The poll is the fallback attribution path (bridge/SDR traffic and
            // anything the WS air_claimed push missed) — keep the Dynamic
            // Island in step with it, not just with the push path.
            if #available(iOS 16.2, *) { refreshLiveActivity() }
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
            // Drop the name when it just repeats the unit id (bridges/SDR feeds
            // often carry the same string, which read as "27 AI • 27 AI").
            if name.caseInsensitiveCompare(tx) == .orderedSame { return "RX: \(tx)" }
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
        // Drop the name when it just repeats the unit id (deduped like Android).
        if let un, !un.isEmpty, un.caseInsensitiveCompare(uid) != .orderedSame {
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
            let cutoff = Date().addingTimeInterval(-600) // 10-minute activity window
            let channelKey = channel.lowercased()
            let names = allUnits
                .filter { $0.channelName?.lowercased() == channelKey }
                .filter { pos in
                    // Parse updatedAt; fall back to including the entry if unparseable
                    let date = Self.isoFormatter.date(from: pos.updatedAt)
                        ?? ISO8601DateFormatter().date(from: pos.updatedAt)
                    return date.map { $0 > cutoff } ?? true
                }
                .compactMap(\.displayName)
            // Dedupe via Set (O(1)/name) rather than the previous O(n²)
            // `result.contains` scan, then sort for stable display order.
            uiState.unitsOnChannel = Array(Set(names)).sorted()
            updateWidgetData()
        } catch {
            uiState.radiosOnlineOnChannel = nil
            uiState.unitsOnChannel = []
        }
    }

    private func startInboxPolling() {
        Task { [weak self] in
            while !Task.isCancelled {
                // Poll fast while the AI cue is live so it animates fluidly; idle
                // back to the slow cadence to keep the radio's poll load low.
                let interval = self?.uiState.aiActivity != nil
                    ? VoiceTiming.inboxFastPollSeconds
                    : VoiceTiming.inboxPollSeconds
                try? await Task.sleep(for: .seconds(interval))
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
            // Mirror the live AI-dispatcher cue. The server clears (returns nil)
            // a few seconds after she's done talking, so the overlay auto-dismisses
            // simply by following the inbox.
            let nextAi: AiActivityUi? = response.aiActivity.map { ai in
                AiActivityUi(
                    phase: ai.phase.lowercased() == "speaking" ? .speaking : .thinking,
                    forYou: ai.forYou,
                    text: ai.text ?? "",
                    displayText: ai.displayText ?? "",
                    plate: ai.plate ?? "",
                    vin: ai.vin ?? "",
                    tag: ai.tag ?? ""
                )
            }
            if nextAi != uiState.aiActivity {
                uiState.aiActivity = nextAi
            }
        } catch {
            // Keep the last cursor; try again on the next tick.
        }
    }

    private func handleInboundAlert(_ alert: InboxAlert) {
        let from = (alert.fromUnit ?? alert.fromName ?? "DISPATCH")
        if alert.kind.lowercased() == "emergency" {
            uiState.statusMessage = "EMERGENCY • " + from.uppercased()
            return
        }
        // Page: store it in the inbox (deduped by id) so the Pages tab can show
        // it, and surface a status-line hint.
        if uiState.pageMessages.contains(where: { $0.id == alert.id }) { return }
        let page = PageMessage(
            id: alert.id,
            timeLabel: pageTimeLabel(alert.createdAt),
            fromLabel: from.uppercased(),
            message: alert.message ?? "",
            targetedToMe: alert.targetUnit?.uppercased() == unitId.uppercased(),
            hasImage: alert.hasImage ?? false,
            read: false,
            responded: nil
        )
        uiState.pageMessages.insert(page, at: 0)
        if uiState.pageMessages.count > 100 {
            uiState.pageMessages = Array(uiState.pageMessages.prefix(100))
        }
        persistPages()
        sounds.play(.page)
        let preview = page.message.isEmpty ? page.fromLabel : page.message
        uiState.statusMessage = "PAGE: " + preview.prefix(40).uppercased()
    }

    // MARK: - pages inbox

    private var pagesDefaultsKey: String { "safet.pages.\(unitId.uppercased())" }

    private func pageTimeLabel(_ iso: String?) -> String {
        if let iso, let date = Self.isoFormatter.date(from: iso) {
            return clockFormatter.string(from: date)
        }
        return clockFormatter.string(from: Date())
    }

    private func loadPersistedPages() -> [PageMessage] {
        guard let data = UserDefaults.standard.data(forKey: pagesDefaultsKey),
              let pages = try? JSONDecoder().decode([PageMessage].self, from: data) else {
            return []
        }
        return pages
    }

    private func persistPages() {
        if let data = try? JSONEncoder().encode(uiState.pageMessages) {
            UserDefaults.standard.set(data, forKey: pagesDefaultsKey)
        }
    }

    /// Lazily fetch a page's picture attachment (only pages with `hasImage`).
    private func loadPageImage(_ id: Int) {
        guard uiState.pageImages[id] == nil else { return }
        Task { [weak self] in
            guard let self else { return }
            if let data = try? await self.api.alertImage(id: id), !data.isEmpty {
                self.uiState.pageImages[id] = data
            }
        }
    }

    /// Send an ACK / reply to a page; optimistically marks it answered locally.
    private func respondToPage(id: Int, response: String) {
        let reply = String(response.trimmingCharacters(in: .whitespacesAndNewlines).prefix(60))
        guard !reply.isEmpty else { return }
        if let idx = uiState.pageMessages.firstIndex(where: { $0.id == id }) {
            uiState.pageMessages[idx].responded = reply
            uiState.pageMessages[idx].read = true
            persistPages()
        }
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.api.respondToAlert(id: id, unit: self.unitId, response: reply)
                self.sounds.play(.success)
                self.uiState.statusMessage = "REPLY SENT: " + reply.uppercased()
            } catch {
                self.sounds.play(.error)
                self.uiState.statusMessage = "REPLY FAILED — RETRY"
            }
        }
    }

    private func markPagesRead() {
        guard uiState.pageMessages.contains(where: { !$0.read }) else { return }
        uiState.pageMessages = uiState.pageMessages.map { page in
            var page = page
            page.read = true
            return page
        }
        persistPages()
    }
}
