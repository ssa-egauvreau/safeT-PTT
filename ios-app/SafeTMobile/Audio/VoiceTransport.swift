import Foundation
import os

/// Opens a WebSocket to `/v1/voice/stream`, sends the `join` frame the server
/// expects, and relays voice. Uplink uses P25 IMBE (88-bit codewords) when the
/// native vocoder loads; otherwise clear PCM. Downlink auto-detects IMBE frames.
@MainActor
final class VoiceTransport {
    enum Permission: String { case listenOnly = "listen_only", talk, talkPriority = "talk_priority" }

    struct Joined { let channel: String; let permission: Permission; let unitId: String }

    var onJoined: ((Joined) -> Void)?
    var onError: ((String) -> Void)?
    var onBusy: ((String?) -> Void)?
    var onReceivingChange: ((Bool) -> Void)?

    private let baseURL: URL
    private let token: String
    private let session: URLSession
    private let audio: VoiceAudio
    private let unitId: String
    private let logger = Logger(subsystem: "com.safetptt.mobile", category: "voice")

    private var task: URLSessionWebSocketTask?
    private var currentChannel: String?
    private var lastReceivedAt: Date = .distantPast
    private var receivingTimer: Timer?
    private var reconnectAttempts: Int = 0
    private var reconnectTask: Task<Void, Never>?

    private let txConditioner = ImbeTxConditioner()
    private var pcmAcc = Data()
    private var pcmFrameScratch = Data(count: P25ImbeNative.Frames.pcm16kFrameBytes)
    private var lastConsumeNs: UInt64 = 0
    private var warnedClearTx = false
    private var uplinkActive = false

    private let imbeMagic: [UInt8] = [0xF5, 0xAB]
    private let listenPcmMagic: [UInt8] = [0xF6, 0xAC]

    init(baseURL: URL, token: String, unitId: String, audio: VoiceAudio, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.unitId = unitId
        self.audio = audio
        self.session = session
        _ = P25ImbeNative.initialize()
    }

    func join(channel: String) {
        currentChannel = channel
        reconnectTask?.cancel()
        reconnectTask = nil
        reconnectAttempts = 0
        if task == nil { openSocket() }
        sendJoinFrame()
    }

    func disconnect() {
        reconnectTask?.cancel()
        reconnectTask = nil
        receivingTimer?.invalidate()
        receivingTimer = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        currentChannel = nil
        reconnectAttempts = 0
        resetUplinkState()
    }

    /// Arms uplink processing for a fresh PTT key-up.
    func beginUplink() {
        uplinkActive = true
    }

    func resetUplinkState() {
        // Captured frames are bounced through `Task { @MainActor ... }`.
        // Disable uplink first so any queued post-release frames are dropped.
        uplinkActive = false
        pcmAcc.removeAll(keepingCapacity: true)
        txConditioner.reset()
        lastConsumeNs = 0
    }

    /// Send one captured PCM16 frame (320 bytes @ 16 kHz). Encodes to IMBE when available.
    nonisolated func sendCaptured(_ frame: Data) {
        Task { @MainActor [weak self] in
            self?.sendCapturedOnMain(frame)
        }
    }

    private func sendCapturedOnMain(_ frame: Data) {
        guard let task, !frame.isEmpty, uplinkActive else { return }

        let p25 = P25ImbeNative.isAvailable
        if !p25 {
            if !warnedClearTx {
                warnedClearTx = true
                logger.warning("P25 IMBE encoder unavailable — uplink clear PCM")
            }
            pcmAcc.removeAll(keepingCapacity: true)
            task.send(.data(frame)) { _ in }
            return
        }

        var side = Data(capacity: 2 + frame.count)
        side.append(listenPcmMagic[0])
        side.append(listenPcmMagic[1])
        side.append(frame)
        task.send(.data(side)) { _ in }

        let now = DispatchTime.now().uptimeNanoseconds
        if lastConsumeNs > 0, now - lastConsumeNs > 300_000_000 {
            txConditioner.reset()
        }
        lastConsumeNs = now

        pcmAcc.append(frame)
        let frameBytes = P25ImbeNative.Frames.pcm16kFrameBytes
        while pcmAcc.count >= frameBytes {
            pcmFrameScratch = pcmAcc.prefix(frameBytes)
            pcmAcc.removeFirst(frameBytes)

            txConditioner.conditionLe16(frame: &pcmFrameScratch)
            guard let imbeIn = P25ImbeNative.Frames.downsampleAvg16kToImbe(frame16k: pcmFrameScratch),
                  let codeword = P25ImbeNative.encodeFrame(samples8k160: imbeIn) else { continue }
            var packet = Data(capacity: 13)
            packet.append(imbeMagic[0])
            packet.append(imbeMagic[1])
            packet.append(codeword)
            task.send(.data(packet)) { _ in }
        }
    }

    // MARK: - private

    private func openSocket() {
        var components = URLComponents(url: baseURL.appendingPathComponent("v1/voice/stream"), resolvingAgainstBaseURL: false)
        let currentScheme = components?.scheme
        components?.scheme = (currentScheme == "http") ? "ws" : "wss"
        components?.queryItems = [URLQueryItem(name: "token", value: token)]
        guard let url = components?.url else { return }

        let request = URLRequest(url: url)
        let task = session.webSocketTask(with: request)
        self.task = task
        task.resume()
        listen()
        startReceivingHeartbeat()
    }

    private func sendJoinFrame() {
        guard let channel = currentChannel, let task else { return }
        let join: [String: String] = [
            "type": "join",
            "channel": channel,
            "unit_id": unitId,
            "client": "ios",
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: join),
              let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { [weak self] error in
            if let error {
                Task { @MainActor in self?.onError?("join failed: \(error.localizedDescription)") }
            }
        }
    }

    private func listen() {
        guard let task else { return }
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                Task { @MainActor in
                    self.onError?(error.localizedDescription)
                    self.task = nil
                    self.scheduleReconnect()
                }
            case .success(let message):
                Task { @MainActor in self.handle(message) }
                self.listen()
            }
        }
    }

    private func scheduleReconnect() {
        guard let channel = currentChannel else { return }
        if reconnectTask != nil { return }
        reconnectAttempts += 1
        let delaySeconds = min(pow(2.0, Double(reconnectAttempts - 1)), 16.0)
        onError?("link lost — reconnecting in \(Int(delaySeconds))s")
        let nanoseconds = UInt64(delaySeconds * 1_000_000_000)
        reconnectTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: nanoseconds)
            guard let self, !Task.isCancelled else { return }
            self.reconnectTask = nil
            guard self.currentChannel == channel else { return }
            guard self.task == nil else { return }
            self.openSocket()
            self.sendJoinFrame()
        }
    }

    @MainActor
    private func handle(_ message: URLSessionWebSocketTask.Message) {
        switch message {
        case .string(let text):
            handleTextFrame(text)
        case .data(let data):
            dispatchInboundVoice(data)
        @unknown default:
            break
        }
    }

    private func dispatchInboundVoice(_ payload: Data) {
        if payload.count >= 2,
           payload[payload.startIndex] == listenPcmMagic[0],
           payload[payload.startIndex + 1] == listenPcmMagic[1] {
            return
        }
        if payload.count == 13,
           payload[payload.startIndex] == imbeMagic[0],
           payload[payload.startIndex + 1] == imbeMagic[1] {
            guard P25ImbeNative.isAvailable || P25ImbeNative.initialize() else {
                logger.warning("IMBE frame discarded — vocoder not loaded")
                return
            }
            let codeword = payload.subdata(in: 2..<13)
            guard let pcm8k = P25ImbeNative.decodeCodeword11(codeword) else { return }
            let pcm16 = P25ImbeNative.Frames.upsampleDup8kToLe16Mono(pcm8k160: pcm8k)
            lastReceivedAt = Date()
            onReceivingChange?(true)
            audio.enqueueIncoming(pcm16)
            return
        }
        lastReceivedAt = Date()
        onReceivingChange?(true)
        audio.enqueueIncoming(payload)
    }

    private func handleTextFrame(_ text: String) {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else { return }
        switch type {
        case "joined":
            let channel = (object["channel"] as? String) ?? ""
            let permRaw = (object["permission"] as? String) ?? "listen_only"
            let unit = (object["unit_id"] as? String) ?? unitId
            let permission = Permission(rawValue: permRaw) ?? .listenOnly
            reconnectAttempts = 0
            onJoined?(Joined(channel: channel, permission: permission, unitId: unit))
        case "busy":
            let holder = (object["unit_id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            onBusy?(holder?.isEmpty == true ? nil : holder)
        case "error":
            let code = (object["code"] as? String) ?? "unknown"
            onError?(code)
        default:
            break
        }
    }

    private func startReceivingHeartbeat() {
        receivingTimer?.invalidate()
        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                if Date().timeIntervalSince(self.lastReceivedAt) > 0.3 {
                    self.onReceivingChange?(false)
                }
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        receivingTimer = timer
    }
}
