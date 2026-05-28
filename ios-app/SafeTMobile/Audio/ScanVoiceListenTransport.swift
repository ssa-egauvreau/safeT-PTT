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

    private let imbeMagic: [UInt8] = [0xF5, 0xAB]
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
                imbeMagic: imbeMagic,
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
        private let imbeMagic: [UInt8]
        private let listenPcmMagic: [UInt8]
        private let onRx: (String) -> Void
        private let isAlive: (String) -> Bool

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
            imbeMagic: [UInt8],
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
            self.imbeMagic = imbeMagic
            self.listenPcmMagic = listenPcmMagic
            self.onRx = onRx
            self.isAlive = isAliveCheck
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

        private func sendJoin() {
            guard let task else { return }
            let join: [String: String] = [
                "type": "join",
                "channel": channelLabel,
                "unit_id": unitId,
                "client": "ios_scan",
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
                    Task { @MainActor in self.handle(message) }
                    self.listen()
                }
            }
        }

        @MainActor
        private func handle(_ message: URLSessionWebSocketTask.Message) {
            switch message {
            case .data(let payload):
                dispatchInboundVoice(payload)
            case .string(let text):
                // `busy`/`error` aren't actionable for a listen-only scan socket —
                // primary RX/TX signalling comes from the home channel's transport.
                // `joined` still matters: it confirms a reconnect succeeded, so
                // reset the backoff counter to avoid stale 30 s delays on the next
                // isolated drop.
                if isJoinedFrame(text) { reconnectAttempts = 0 }
            @unknown default:
                break
            }
        }

        private func dispatchInboundVoice(_ payload: Data) {
            // The server echoes the talker's own clear-PCM listen frames back
            // through this same socket as a `0xF6 0xAC` envelope — skip them.
            if payload.count >= 2,
               payload[payload.startIndex] == listenPcmMagic[0],
               payload[payload.startIndex + 1] == listenPcmMagic[1] {
                return
            }
            if payload.count == 13,
               payload[payload.startIndex] == imbeMagic[0],
               payload[payload.startIndex + 1] == imbeMagic[1] {
                guard P25ImbeNative.isAvailable || P25ImbeNative.initialize() else {
                    logger.warning("scan IMBE frame discarded — vocoder not loaded")
                    return
                }
                let codeword = payload.subdata(in: 2..<13)
                guard let pcm8k = P25ImbeNative.decodeCodeword11(codeword) else { return }
                let pcm16 = P25ImbeNative.Frames.upsampleDup8kToLe16Mono(pcm8k160: pcm8k)
                audio.enqueueIncoming(pcm16)
                onRx(channelLabel)
                return
            }
            // Clear-PCM payload from a peer that lacks the vocoder.
            audio.enqueueIncoming(payload)
            onRx(channelLabel)
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
            let delaySeconds = min(pow(2.0, Double(reconnectAttempts - 1)), 30.0)
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
