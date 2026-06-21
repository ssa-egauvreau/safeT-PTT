import Foundation
import os

/// Opens extra listen-only WebSockets to `/v1/voice/stream` for every channel
/// in the scan list while the main `VoiceTransport` stays on the tuned (home)
/// channel. Decoded IMBE frames are piped into the same `VoiceAudio` mixer so
/// the operator hears scan-channel traffic on the speaker. Mirrors the Android
/// `ScanVoiceListenTransport`.
@MainActor
final class ScanVoiceListenTransport {
    /// Called when a scan-channel produces a voice frame, with the channel
    /// label. The view-model uses it to surface a transient "SCAN: <ch>"
    /// banner in the display panel.
    var onScanRx: ((String) -> Void)?

    private let baseURL: URL
    private let token: String
    private let unitId: String
    private let audio: VoiceAudio
    private let session: URLSession
    private let logger = Logger(subsystem: "com.safetptt.mobile", category: "scan")

    private var connections: [String: ScanConnection] = [:]
    private var wantListen = false
    private var homeChannelKey = ""

    private let listenPcmMagic: [UInt8] = [0xF6, 0xAC]

    init(baseURL: URL, token: String, unitId: String, audio: VoiceAudio, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.unitId = unitId
        self.audio = audio
        self.session = session
    }

    /// Sync the open socket set with the desired (scan-active, scan-list, home)
    /// triple. Safe to call repeatedly — drops sockets that should no longer be
    /// listening, opens new ones for newly included channels.
    func updateScanListen(
        homeChannel: String?,
        scanChannels: Set<String>,
        networkOnline: Bool,
        scanActive: Bool
    ) {
        wantListen = networkOnline && scanActive && !unitId.isEmpty
        homeChannelKey = (homeChannel ?? "").lowercased()

        // Always strip the home channel — the primary VoiceTransport already
        // listens to it. Listening twice would just play every frame twice.
        let desired: [String: String] = wantListen
            ? scanChannels
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty && $0 != "----" && $0.lowercased() != homeChannelKey }
                .reduce(into: [:]) { acc, label in acc[label.lowercased()] = label }
            : [:]

        let stale = connections.keys.filter { desired[$0] == nil }
        for key in stale {
            connections.removeValue(forKey: key)?.close()
        }
        for (key, label) in desired where connections[key] == nil {
            let conn = ScanConnection(
                channelLabel: label,
                baseURL: baseURL,
                token: token,
                unitId: unitId,
                audio: audio,
                session: session,
                logger: logger,
                listenPcmMagic: listenPcmMagic
            ) { [weak self] ch in
                self?.onScanRx?(ch)
            } isAliveCheck: { [weak self] key in
                // `dict[key]` already returns `ScanConnection?`; the outer `?.`
                // produces `ScanConnection??` and a `!= nil` on that is `true`
                // whenever `self` is alive — even after the entry was removed.
                // Flatten with `??` so a missing key correctly reads as dead.
                (self?.connections[key] ?? nil) != nil
            }
            connections[key] = conn
            conn.open()
        }
    }

    func disconnect() {
        wantListen = false
        for (_, conn) in connections { conn.close() }
        connections.removeAll()
    }

    /// Cancels backoff timers and immediately reopens any dropped scan sockets.
    /// Called when the network path monitor reports connectivity returned.
    func retryNow() {
        for (_, conn) in connections { conn.retryNow() }
    }

    // MARK: - per-channel connection

    @MainActor
    fileprivate final class ScanConnection {
        let channelLabel: String
        private let channelKey: String
        private let baseURL: URL
        private let token: String
        private let unitId: String
        private let audio: VoiceAudio
        private let session: URLSession
        private let logger: Logger
        private let listenPcmMagic: [UInt8]
        private let onRx: (String) -> Void
        private let isAlive: (String) -> Bool

        /// Per-connection off-main decode pipeline. Each scan channel gets its
        /// own decoder (and thus its own serial queue + isolated vocoder state),
        /// so concurrent scan traffic neither corrupts a shared decoder nor
        /// runs on the (background-throttled) main actor. `nonisolated` so the
        /// background URLSession completion can hand it frames directly.
        private nonisolated let inboundDecoder: InboundVoiceDecoder

        private var task: URLSessionWebSocketTask?
        private var closed = false
        private var reconnectAttempts = 0
        private var reconnectTask: Task<Void, Never>?

        init(
            channelLabel: String,
            baseURL: URL,
            token: String,
            unitId: String,
            audio: VoiceAudio,
            session: URLSession,
            logger: Logger,
            listenPcmMagic: [UInt8],
            onRx: @escaping (String) -> Void,
            isAliveCheck: @escaping (String) -> Bool
        ) {
            self.channelLabel = channelLabel
            self.channelKey = channelLabel.lowercased()
            self.baseURL = baseURL
            self.token = token
            self.unitId = unitId
            self.audio = audio
            self.session = session
            self.logger = logger
            self.listenPcmMagic = listenPcmMagic
            self.onRx = onRx
            self.isAlive = isAliveCheck
            self.inboundDecoder = InboundVoiceDecoder(
                channelLabel: channelLabel,
                audio: audio,
                listenPcmMagic: listenPcmMagic,
                logger: logger
            )
            // Fires only when a decoded frame actually won the scan arbitration
            // slot, so the "scanning" banner stops flapping between channels.
            inboundDecoder.setOnPlayed { [onRx, channelLabel] in onRx(channelLabel) }
        }

        func open() {
            guard !closed, task == nil else { return }
            var components = URLComponents(
                url: baseURL.appendingPathComponent("v1/voice/stream"),
                resolvingAgainstBaseURL: false
            )
            let currentScheme = components?.scheme
            components?.scheme = (currentScheme == "http") ? "ws" : "wss"
            components?.queryItems = [URLQueryItem(name: "token", value: token)]
            guard let url = components?.url else { return }
            let ws = session.webSocketTask(with: URLRequest(url: url))
            task = ws
            ws.resume()
            listen()
            sendJoin()
        }

        func close() {
            closed = true
            reconnectTask?.cancel()
            reconnectTask = nil
            task?.cancel(with: .goingAway, reason: nil)
            task = nil
        }

        func retryNow() {
            guard !closed, task == nil else { return }
            reconnectTask?.cancel()
            reconnectTask = nil
            reconnectAttempts = 0
            open()
        }

        private func sendJoin() {
            guard let task else { return }
            // Scan sockets are listen-only — advertise decode caps so the
            // server's join logging accurately reflects what this client can
            // hear. The relay never asks a scan socket to TX.
            let caps = inboundDecoder.decodableCaps()
            let join: [String: Any] = [
                "type": "join",
                "channel": channelLabel,
                "unit_id": unitId,
                "client": "ios_scan",
                "caps": caps,
            ]
            guard let data = try? JSONSerialization.data(withJSONObject: join),
                  let text = String(data: data, encoding: .utf8) else { return }
            task.send(.string(text)) { _ in }
        }

        private func listen() {
            guard let task else { return }
            task.receive { [weak self] result in
                guard let self else { return }
                switch result {
                case .failure:
                    Task { @MainActor in
                        self.task = nil
                        self.scheduleReconnect()
                    }
                case .success(let message):
                    // Voice (binary) frames decode + play OFF the main actor via
                    // the per-connection InboundVoiceDecoder, so a throttled main
                    // run loop (app backgrounded) can't starve scan playout. The
                    // decoder skips the `0xF6 0xAC` clear-PCM echo itself and
                    // routes playout through `VoiceAudio.enqueueScan` arbitration.
                    // Signalling (text) frames and the receive re-arm stay on the
                    // main actor — `listen()` touches `task`, and re-arming there
                    // was a data race against main-thread teardown.
                    if case .data(let payload) = message {
                        self.inboundDecoder.submit(payload)
                    } else if case .string(let text) = message {
                        Task { @MainActor in
                            if self.isJoinedFrame(text) { self.reconnectAttempts = 0 }
                        }
                    }
                    Task { @MainActor in self.listen() }
                }
            }
        }

        private func isJoinedFrame(_ text: String) -> Bool {
            guard let data = text.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = object["type"] as? String else { return false }
            return type == "joined"
        }

        private func scheduleReconnect() {
            guard !closed, isAlive(channelKey) else { return }
            if reconnectTask != nil { return }
            reconnectAttempts += 1
            let delaySeconds = VoiceTiming.backoffDelaySeconds(attempt: reconnectAttempts, cap: 30)
            let nanoseconds = UInt64(delaySeconds * 1_000_000_000)
            reconnectTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: nanoseconds)
                guard let self, !Task.isCancelled, !self.closed, self.isAlive(self.channelKey) else { return }
                self.reconnectTask = nil
                guard self.task == nil else { return }
                self.open()
            }
        }
    }
}
