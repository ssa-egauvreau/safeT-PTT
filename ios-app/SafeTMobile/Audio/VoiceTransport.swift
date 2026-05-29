import Foundation
import os

/// Opens a WebSocket to `/v1/voice/stream`, sends the `join` frame the server
/// expects, and relays voice.
///
/// Uplink uses whichever codec the channel's `joined` reply asks for (default
/// IMBE), via `VoiceCodecRegistry`. The registry falls back to IMBE if the
/// requested codec's native lib hasn't loaded; if even IMBE isn't available,
/// the uplink ships clear PCM. Downlink dispatches each inbound frame to the
/// right decoder by its leading magic bytes, so a channel can mix codecs
/// mid-stream (e.g. during a `codec_change` roll-out) without any client-side
/// signaling.
@MainActor
final class VoiceTransport {
    enum Permission: String { case listenOnly = "listen_only", talk, talkPriority = "talk_priority" }

    struct Joined { let channel: String; let permission: Permission; let unitId: String; let codec: VoiceCodec }

    var onJoined: ((Joined) -> Void)?
    var onError: ((String) -> Void)?
    var onBusy: ((String?) -> Void)?
    var onReceivingChange: ((Bool) -> Void)?
    /// Admin flipped the channel's transmit codec; the encoder swaps on the
    /// next frame. UI can surface the change via this callback.
    var onCodecChange: ((VoiceCodec) -> Void)?

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
    /// Tracks the codec the last frame was encoded with so a mid-stream
    /// codec change can drop any fractional PCM in the accumulator (the next
    /// encoder expects a fresh frame boundary, possibly at a different
    /// frame size).
    private var lastTxCodec: VoiceCodec?
    // Each PTT key-up/key-down pair gets a unique capture session id from
    // VoiceAudio. We only accept frames for the currently armed session so
    // late frames from a prior key-up cannot repopulate `pcmAcc`.
    // `internal` (default) visibility so `@testable import SafeTMobile` can
    // assert the gate state directly — the property is read-only outside this
    // file in practice.
    var activeCaptureSessionId: UInt64?

    /// Registry of every voice codec this client can encode + decode (IMBE,
    /// Codec2, Opus — same wire format as Android and the web console).
    private let codecRegistry: VoiceCodecRegistry = {
        let registry = VoiceCodecRegistry()
        registry.registerEncoder(ImbeEncoder())
        registry.registerDecoder(ImbeDecoder())
        registry.registerEncoder(Codec2Encoder())
        registry.registerDecoder(Codec2Decoder())
        registry.registerEncoder(OpusEncoder())
        registry.registerDecoder(OpusDecoder())
        return registry
    }()

    /// Codec the channel asked us to TX with. Updated by the joined reply and
    /// by codec_change push messages; the registry resolves it to an actual
    /// ready encoder (falling back to IMBE if the requested lib is missing).
    private var currentTxCodec: VoiceCodec = .default

    private let listenPcmMagic: [UInt8] = [0xF6, 0xAC]

    /// Agency-pushed RX shaping (presence bell, soft saturation, shelves,
    /// upsample mode). `nil` when no admin has pushed shaping or when the
    /// `/v1/audio/config` fetch hasn't landed yet — RX takes the legacy
    /// duplicate 8 → 16 kHz upsample with no biquads. Rebuilt by
    /// `refreshAudioConfig()` on every connect / reconnect so admin
    /// changes pick up without restarting the app.
    private var postDecodeProcessor: PostDecodeChain.Processor?
    /// Last inbound voice frame timestamp (seconds, monotonic clock). Used
    /// only to detect a talk-spurt boundary on RX so the post-decode chain
    /// can reset its biquad state before the next talker's first frame.
    private var lastInboundVoiceAt: TimeInterval = 0
    /// Treat > 300 ms gap between inbound voice frames as a new talk-spurt.
    /// Matches the Android `scanTalkSpurtGapNs` for the same reason.
    private let talkSpurtGapSeconds: TimeInterval = VoiceTiming.talkSpurtGapSeconds
    /// Agency flag: minimal TX chain (HPF/LPF only), matching bridge / web bypass.
    private var bypassMicProcessing = false

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
        stopUplinkCapture()
    }

    func startUplinkCapture(sessionId: UInt64) {
        activeCaptureSessionId = sessionId
        resetUplinkState()
    }

    func stopUplinkCapture() {
        activeCaptureSessionId = nil
        codecRegistry.txEncoder(for: currentTxCodec)?.resetForTalkSpurt()
        releaseTransmitHold()
        resetUplinkState()
    }

    /// PTT released — clear `/v1/air` immediately for peers (Android/web parity).
    func releaseTransmitHold() {
        pcmAcc.removeAll(keepingCapacity: true)
        guard let task else { return }
        task.send(.string(Self.releaseAirJSON)) { _ in }
    }

    func resetUplinkState() {
        pcmAcc.removeAll(keepingCapacity: true)
        txConditioner.reset()
        lastConsumeNs = 0
    }

    /// Send one captured PCM16 frame (320 bytes @ 16 kHz). Encodes to IMBE when available.
    nonisolated func sendCaptured(_ frame: Data, captureSessionId: UInt64) {
        Task { @MainActor [weak self] in
            self?.sendCapturedOnMain(frame, captureSessionId: captureSessionId)
        }
    }

    private func sendCapturedOnMain(_ frame: Data, captureSessionId: UInt64) {
        guard let task, !frame.isEmpty else { return }
        guard activeCaptureSessionId == captureSessionId else { return }

        let encoder = codecRegistry.txEncoder(for: currentTxCodec)
        reconcileAccumulatorForCodecToggle(encoder?.codec)

        guard let encoder else {
            // No vocoder encoder is ready and the registry has no fallback.
            // Peers hear non-vocoded audio; logged once per process so the
            // "everything sounds raw on the dispatch portal" case is visible.
            if !warnedClearTx {
                warnedClearTx = true
                logger.warning("No voice encoder available — uplink clear PCM")
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
            encoder.resetForTalkSpurt()
        }
        lastConsumeNs = now

        pcmAcc.append(frame)
        let frameBytes = P25ImbeNative.Frames.pcm16kFrameBytes
        while pcmAcc.count >= frameBytes {
            pcmFrameScratch = pcmAcc.prefix(frameBytes)
            pcmAcc.removeFirst(frameBytes)

            txConditioner.conditionLe16(frame: &pcmFrameScratch, bypassExpanderAgc: bypassMicProcessing)
            guard let packet = encoder.encodeFrame(pcmFrameScratch) else { continue }
            task.send(.data(packet)) { _ in }
        }
    }

    /// Discard any fractional staged PCM on a mid-stream codec change so the
    /// next encoder sees a clean 20 ms boundary (frame sizes may differ).
    /// `current` is nil when the registry has no encoder ready and uplink is
    /// falling back to clear PCM.
    private func reconcileAccumulatorForCodecToggle(_ current: VoiceCodec?) {
        let prev = lastTxCodec
        if prev != nil, prev != current {
            pcmAcc.removeAll(keepingCapacity: true)
        }
        lastTxCodec = current
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
        // Fetch agency audio config in parallel. RX falls back to the legacy
        // duplicate-upsample path until this lands; once the processor is
        // built, the next inbound IMBE frame picks it up automatically.
        Task { [weak self] in await self?.refreshAudioConfig() }
    }

    /// Fetches the agency-pushed audio config and rebuilds
    /// `postDecodeProcessor` from its `postDecode` block. Best-effort: a
    /// failed request leaves whatever was previously cached intact (or nil
    /// on first connect), so a transient server hiccup just keeps RX on the
    /// legacy fast path instead of crashing the listener.
    private func refreshAudioConfig() async {
        let apiBase = baseURL
        let client = RadioApiClient(baseURL: apiBase, token: token)
        do {
            let response = try await client.audioConfig()
            let next: PostDecodeChain.Processor?
            if let pd = response.config?.postDecode {
                let cfg = pd.toConfig()
                next = cfg.isNoOp ? nil : PostDecodeChain.Processor(config: cfg)
            } else {
                next = nil
            }
            await MainActor.run {
                self.postDecodeProcessor = next
                self.bypassMicProcessing = response.config?.bypassMicProcessing ?? false
                self.lastInboundVoiceAt = 0
            }
        } catch {
            logger.warning("audio config refresh failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Run an IMBE-decoded 8 kHz frame through the agency post-decode chain
    /// when configured; otherwise fall back to the legacy duplicate-upsample
    /// path. Resets the processor's biquad state at every talk-spurt boundary
    /// so a previous talker's filter ring can't bleed into the next talker's
    /// first frame.
    private func applyPostDecodeOrDup(_ pcm8k: [Int16]) -> Data {
        guard let processor = postDecodeProcessor else {
            return P25ImbeNative.Frames.upsampleDup8kToLe16Mono(pcm8k160: pcm8k)
        }
        return processor.process(pcm8k160: pcm8k)
    }

    private func sendJoinFrame() {
        guard let channel = currentChannel, let task else { return }
        // Re-check encodable codecs at every join (not just once at construction)
        // because some native libs (IMBE) may load lazily on first RX frame.
        let caps = codecRegistry.encodableCodecs().map { $0.wireId }
        let join: [String: Any] = [
            "type": "join",
            "channel": channel,
            "unit_id": unitId,
            "client": "ios",
            "caps": caps,
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
        // Clear-PCM sideband — not for playback (server-only recording path).
        if payload.count >= 2,
           payload[payload.startIndex] == listenPcmMagic[0],
           payload[payload.startIndex + 1] == listenPcmMagic[1] {
            return
        }
        if payload.count >= 2,
           let decoder = codecRegistry.decoder(forMagic: payload[payload.startIndex], payload[payload.startIndex + 1]) {
            let now = ProcessInfo.processInfo.systemUptime
            let newSpurt = lastInboundVoiceAt == 0 || (now - lastInboundVoiceAt) > talkSpurtGapSeconds
            lastInboundVoiceAt = now
            if newSpurt {
                decoder.resetForTalkSpurt()
                if decoder.nativeSampleRate == 8000 {
                    postDecodeProcessor?.reset()
                }
            }
            // Lazy-load IMBE on first frame so peers stay audible even before
            // this radio opens the PTT screen. Other codecs load (or fail to
            // load) eagerly with their own native libs.
            if decoder.codec == .imbe, !P25ImbeNative.isAvailable, !P25ImbeNative.initialize() {
                logger.warning("IMBE frame discarded — vocoder not loaded")
                return
            }
            guard decoder.isReady else {
                logger.warning("Inbound \(decoder.codec.wireId, privacy: .public) frame dropped — decoder native lib not loaded")
                return
            }
            guard let samples = decoder.decodeFrame(payload) else { return }
            let pcm16 = renderDecoded(samples, nativeRate: decoder.nativeSampleRate)
            lastReceivedAt = Date()
            onReceivingChange?(true)
            audio.enqueueIncoming(pcm16)
            return
        }
        // Unknown magic — legacy clear PCM path (soundboard tone-out, etc.).
        lastReceivedAt = Date()
        onReceivingChange?(true)
        audio.enqueueIncoming(payload)
    }

    /// Brings a decoder's native-rate output to the playback rate (16 kHz mono
    /// PCM-16 LE). 8 kHz output (IMBE, Codec2) runs through the existing
    /// post-decode chain or duplicate-upsample fast path; 16 kHz output (Opus)
    /// is shipped to the player unchanged since the chain's polyphase upsample
    /// and presence-bell shaping are tuned for vocoded 8 kHz input.
    private func renderDecoded(_ samples: [Int16], nativeRate: Int) -> Data {
        if nativeRate == 8000 {
            return applyPostDecodeOrDup(samples)
        }
        return shortLeMonoBytes(samples)
    }

    private func shortLeMonoBytes(_ samples: [Int16]) -> Data {
        var out = Data(count: samples.count * 2)
        out.withUnsafeMutableBytes { raw in
            guard let base = raw.baseAddress else { return }
            let bytes = base.assumingMemoryBound(to: UInt8.self)
            for (i, s) in samples.enumerated() {
                let le = UInt16(bitPattern: s)
                bytes[i * 2] = UInt8(le & 0xff)
                bytes[i * 2 + 1] = UInt8((le >> 8) & 0xff)
            }
        }
        return out
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
            let codec = VoiceCodec.fromWireId(object["codec"] as? String) ?? .default
            currentTxCodec = codec
            reconnectAttempts = 0
            onJoined?(Joined(channel: channel, permission: permission, unitId: unit, codec: codec))
        case "codec_change":
            // Admin flipped this channel's codec while we were connected. The
            // next encoded frame goes through the new codec; the inbound path
            // picks the right decoder per frame from magic bytes so it needs
            // no further signaling.
            if let codec = VoiceCodec.fromWireId(object["codec"] as? String) {
                currentTxCodec = codec
                codecRegistry.encoder(for: codec)?.resetForTalkSpurt()
                onCodecChange?(codec)
            } else {
                logger.warning("codec_change frame with unknown codec")
            }
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

    /// Relay control frame — must match server `voiceRelay.ts` and Android/web clients.
    static let releaseAirJSON = "{\"type\":\"release_air\"}"

    private func startReceivingHeartbeat() {
        receivingTimer?.invalidate()
        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                if Date().timeIntervalSince(self.lastReceivedAt) > VoiceTiming.talkSpurtGapSeconds {
                    self.onReceivingChange?(false)
                }
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        receivingTimer = timer
    }
}
