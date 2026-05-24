import Foundation

/// Opens a WebSocket to `/v1/voice/stream`, sends the `join` frame the server
/// expects, forwards captured PCM frames upstream, and pipes received binary
/// frames to `VoiceAudio` for playback. Half-duplex enforcement (one talker
/// per channel) is handled server-side; the client just streams while PTT is
/// held and trusts the air-state check for the UI indicator.
@MainActor
final class VoiceTransport {
    enum Permission: String { case listenOnly = "listen_only", talk, talkPriority = "talk_priority" }

    struct Joined { let channel: String; let permission: Permission; let unitId: String }

    var onJoined: ((Joined) -> Void)?
    var onError: ((String) -> Void)?
    /// Reports whether received audio is currently arriving (used for the RX
    /// indicator). True briefly after every binary frame, then false on idle.
    var onReceivingChange: ((Bool) -> Void)?

    private let baseURL: URL
    private let token: String
    private let session: URLSession
    private let audio: VoiceAudio
    private let unitId: String

    private var task: URLSessionWebSocketTask?
    private var currentChannel: String?
    private var lastReceivedAt: Date = .distantPast
    private var receivingTimer: Timer?
    /// Tracks transient reconnect attempts so the backoff delay grows on repeated
    /// failures and resets after the server confirms a successful `joined`.
    private var reconnectAttempts: Int = 0
    private var reconnectTask: Task<Void, Never>?

    init(baseURL: URL, token: String, unitId: String, audio: VoiceAudio, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.unitId = unitId
        self.audio = audio
        self.session = session
    }

    /// Opens the socket if needed and (re)joins the named channel. Safe to
    /// call repeatedly — Android re-sends `join` whenever channel changes.
    func join(channel: String) {
        currentChannel = channel
        // Any pending auto-reconnect is now superseded by this explicit join.
        // Without this cancellation a queued reconnect that captured an old
        // channel could fire AFTER a fresh join has already opened the socket,
        // racing in a second openSocket() and creating parallel WebSockets.
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
    }

    /// Send one captured 320-byte PCM16 frame upstream. No-op if not connected.
    nonisolated func sendCaptured(_ frame: Data) {
        Task { @MainActor [weak self] in
            self?.task?.send(.data(frame)) { _ in /* drop send errors; the next reconnect will heal */ }
        }
    }

    // MARK: - private

    private func openSocket() {
        var components = URLComponents(url: baseURL.appendingPathComponent("v1/voice/stream"), resolvingAgainstBaseURL: false)
        // Read the current scheme into a local first — Swift's exclusivity
        // checker rejects reading and writing `components` in the same
        // expression (overlapping access to a mutable optional).
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
                    // Auto-reconnect after a transient network blip. Without this the
                    // socket stays dead for the rest of the session and the operator
                    // has to change channel (or restart the app) to get voice back.
                    self.scheduleReconnect()
                }
            case .success(let message):
                Task { @MainActor in self.handle(message) }
                self.listen()
            }
        }
    }

    /// Re-opens the socket and re-sends the `join` frame for the active channel,
    /// with exponential backoff (1, 2, 4, 8, capped at 16 s). No-op if `disconnect()`
    /// has been called or we never joined a channel. Idempotent: repeated calls
    /// while a reconnect is already queued just leave the existing schedule alone.
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
            // Bail if the user disconnected or moved channels while we were waiting —
            // currentChannel may have been cleared or replaced. join(channel:) will
            // be re-invoked by the channel-change flow in that case.
            guard self.currentChannel == channel else { return }
            // Defensive: another flow (join(channel:) on a channel switch) may have
            // already reopened the socket between the cancellation check and here.
            // join(channel:) cancels the queued task, but if we're past the
            // cancellation point we still need to avoid double-opening.
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
            lastReceivedAt = Date()
            onReceivingChange?(true)
            audio.enqueueIncoming(data)
        @unknown default:
            break
        }
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
            // Server accepted us — the link is healthy, so any subsequent failure
            // should restart the backoff at the bottom of the ladder, not at 16 s.
            reconnectAttempts = 0
            onJoined?(Joined(channel: channel, permission: permission, unitId: unit))
        case "error":
            let code = (object["code"] as? String) ?? "unknown"
            onError?(code)
        default:
            break
        }
    }

    /// Flip the RX indicator off if no binary frame has arrived for ~300 ms.
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
