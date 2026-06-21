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
    /// Relay push: another unit keyed this channel — instant talker attribution.
    var onAirClaimed: ((_ channel: String, _ unitId: String, _ displayName: String?) -> Void)?
    /// Relay push: the talker on this channel unkeyed — clear the talker line.
    var onAirReleased: ((_ channel: String) -> Void)?
    var onReceivingChange: ((Bool) -> Void)?
    /// Fires only when the underlying socket link actually dropped (i.e.
    /// we're about to schedule a reconnect). UI uses this to enter the
    /// "Reconnecting" pill state — it must NOT fire on every server-pushed
    /// `error` frame, since transient errors during normal operation would
    /// then latch the pill amber forever.
    var onLinkLost: (() -> Void)?
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
    /// Codec2, Opus, AMBE+2 — same wire format as Android and the web console).
    private let codecRegistry: VoiceCodecRegistry = {
        let registry = VoiceCodecRegistry()
        registry.registerEncoder(ImbeEncoder())
        registry.registerDecoder(ImbeDecoder())
        registry.registerEncoder(Codec2Encoder())
        registry.registerDecoder(Codec2Decoder())
        registry.registerEncoder(OpusEncoder())
        registry.registerDecoder(OpusDecoder())
        registry.registerEncoder(AmbeEncoder())
        registry.registerDecoder(AmbeDecoder())
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
    /// Raw post-decode config kept on the main actor for the end-of-TX cue
    /// synthesis on `air_released` — the cue path needs it even when there is no
    /// DSP processor to build (e.g. a roger-beep-only config). RX shaping itself
    /// is owned by `inboundDecoder`. `nil` when no shaping/cue is configured.
    private var postDecodeConfig: PostDecodeChain.Config?
    /// Agency flag: minimal TX chain (HPF/LPF only), matching bridge / web bypass.
    private var bypassMicProcessing = false

    /// Off-main decode pipeline for the home channel. Voice frames are decoded
    /// and played out on its private serial queue so background main-thread
    /// throttling can't starve playout (the screen-off "robotic"/cutout bug).
    /// `nonisolated` so the background URLSession completion can hand it frames
    /// without hopping to the main actor first.
    private nonisolated let inboundDecoder: InboundVoiceDecoder

    init(baseURL: URL, token: String, unitId: String, audio: VoiceAudio, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.unitId = unitId
        self.audio = audio
        self.session = session
        let logger = self.logger
        self.inboundDecoder = InboundVoiceDecoder(
            channelLabel: nil,
            audio: audio,
            listenPcmMagic: listenPcmMagic,
            logger: logger
        )
        _ = P25ImbeNative.initialize()
        _ = P25AmbeNative.initialize()
        inboundDecoderSetReceivingCallback()
    }

    /// Wire the decoder's play-out callback to the receiving indicator. Done
    /// after `init` stores `self` so the closure can capture it.
    private func inboundDecoderSetReceivingCallback() {
        inboundDecoder.setOnPlayed { [weak self] in
            self?.lastReceivedAt = Date()
            self?.onReceivingChange?(true)
        }
    }

    func join(channel: String) {
        currentChannel = channel
        reconnectTask?.cancel()
        reconnectTask = nil
        reconnectAttempts = 0
        if task == nil { openSocket() }
        sendJoinFrame()
        // Voice-link telemetry: re-point the singleton at this backend, set
        // the (unit, channel) identity for the upcoming windows, and start
        // the 30 s POST loop. Idempotent — configure() and start() are
        // safe to call multiple times.
        VoiceLinkTelemetryReporter.shared.configure(
            baseURL: baseURL,
            tokenProvider: { [weak self] in self?.token ?? "" },
            radioKeyProvider: { "" },
        )
        VoiceLinkTelemetryReporter.shared.setIdentity(unitId: unitId, channel: channel)
        VoiceLinkTelemetryReporter.shared.start()
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
        // Voice-link telemetry: stop POSTing on disconnect. Counters in the
        // in-flight window are carried over to the next start(), so a quick
        // disconnect / reconnect cycle doesn't lose data.
        VoiceLinkTelemetryReporter.shared.stop()
    }

    /// Cancels any pending backoff and reopens the socket immediately. Used by
    /// the network-path monitor when connectivity returns. No-op when there's
    /// no channel joined or the socket is already up.
    func retryNow() {
        guard task == nil, currentChannel != nil else { return }
        reconnectTask?.cancel()
        reconnectTask = nil
        reconnectAttempts = 0
        openSocket()
        sendJoinFrame()
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

    /// Orderly end of a talk-spurt: encode + ship the staged fractional frame
    /// (zero-padded to a full 20 ms) instead of discarding it, then release
    /// the air. `stopUplinkCapture` stays the discard path for busy-deny /
    /// teardown, where the staged audio never made the air to begin with.
    func finishUplinkCapture() {
        activeCaptureSessionId = nil
        flushUplinkTail()
        codecRegistry.txEncoder(for: currentTxCodec)?.resetForTalkSpurt()
        if let task {
            task.send(.string("{\"type\":\"release_air\"}")) { _ in }
        }
        resetUplinkState()
    }

    /// Encode whatever PCM is staged short of a frame boundary, padded with
    /// silence, so the operator's final syllable makes the air.
    private func flushUplinkTail() {
        let staged = pcmAcc
        pcmAcc.removeAll(keepingCapacity: true)
        guard !staged.isEmpty, let task else { return }
        guard let encoder = codecRegistry.txEncoder(for: currentTxCodec) else { return }
        let frameBytes = P25ImbeNative.Frames.pcm16kFrameBytes
        var padded = Data(staged.prefix(frameBytes))
        if padded.count < frameBytes {
            padded.append(Data(count: frameBytes - padded.count))
        }
        pcmFrameScratch = padded
        txConditioner.conditionLe16(frame: &pcmFrameScratch, bypassExpanderAgc: bypassMicProcessing)
        guard let packet = encoder.encodeFrame(pcmFrameScratch) else { return }
        task.send(.data(packet)) { _ in }
        VoiceLinkTelemetryReporter.shared.recordBytesSent(packet.count)
    }

    /// True when the voice socket exists and a channel is joined — i.e. a
    /// frame handed to `sendCaptured` right now would actually reach the
    /// relay. The PTT UI gates its green "ON AIR" state on this so a dead
    /// link can't show the operator as transmitting.
    var isTransmitPathReady: Bool { task != nil && currentChannel != nil }

    /// PTT released — clear `/v1/air` immediately for peers (Android/web parity).
    func releaseTransmitHold() {
        pcmAcc.removeAll(keepingCapacity: true)
        guard let task else { return }
        let payload = "{\"type\":\"release_air\"}"
        task.send(.string(payload)) { _ in }
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
            VoiceLinkTelemetryReporter.shared.recordBytesSent(frame.count)
            return
        }

        var side = Data(capacity: 2 + frame.count)
        side.append(listenPcmMagic[0])
        side.append(listenPcmMagic[1])
        side.append(frame)
        task.send(.data(side)) { _ in }
        VoiceLinkTelemetryReporter.shared.recordBytesSent(side.count)

        let now = DispatchTime.now().uptimeNanoseconds
        if lastConsumeNs > 0, now - lastConsumeNs > 300_000_000 {
            txConditioner.reset()
            encoder.resetForTalkSpurt()
        }
        lastConsumeNs = now

        pcmAcc.append(frame)
        let frameBytes = P25ImbeNative.Frames.pcm16kFrameBytes
        while pcmAcc.count >= frameBytes {
            // Copy into a fresh, zero-based Data (NOT a slice of pcmAcc). The
            // conditioner and the native IMBE encoder reach into this buffer via
            // withUnsafe[Mutable]Bytes + manual pointer indexing; handing them an
            // offset slice that still aliases pcmAcc's storage corrupts pcmAcc's
            // backing header, which later traps in flushUplinkTail's removeAll.
            // `Data(_:)` forces a uniquely-owned contiguous copy (same guard
            // flushUplinkTail already applies to its staged tail frame).
            pcmFrameScratch = Data(pcmAcc.prefix(frameBytes))
            pcmAcc.removeFirst(frameBytes)

            txConditioner.conditionLe16(frame: &pcmFrameScratch, bypassExpanderAgc: bypassMicProcessing)
            guard let packet = encoder.encodeFrame(pcmFrameScratch) else { continue }
            task.send(.data(packet)) { _ in }
            VoiceLinkTelemetryReporter.shared.recordBytesSent(packet.count)
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
            let nextConfig: PostDecodeChain.Config? = response.config?.postDecode?.toConfig()
            let next: PostDecodeChain.Processor?
            if let cfg = nextConfig {
                next = cfg.isNoOp ? nil : PostDecodeChain.Processor(config: cfg)
            } else {
                next = nil
            }
            await MainActor.run {
                // Keep the config on the main actor for the end-of-TX cue
                // synthesis (playEndOfTxCue); hand the built processor to the
                // off-main decoder, which owns all RX shaping now.
                self.postDecodeConfig = nextConfig
                self.bypassMicProcessing = response.config?.bypassMicProcessing ?? false
                self.inboundDecoder.updateConfig(processor: next, wideband: nextConfig?.wideband ?? false)
            }
        } catch {
            logger.warning("audio config refresh failed: \(error.localizedDescription, privacy: .public)")
        }
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
                // Voice (binary) frames decode + play OFF the main actor via the
                // serial InboundVoiceDecoder, so a throttled main run loop (app
                // backgrounded / screen off) can't starve playout. Signalling
                // (text) frames and the receive re-arm still hop to the main
                // actor — `listen()` touches `task` and re-arming there was a
                // data race against main-thread PTT teardown (a crash-on-release
                // cause).
                if case .data(let payload) = message {
                    self.inboundDecoder.submit(payload)
                } else if case .string(let text) = message {
                    Task { @MainActor in self.handleTextFrame(text) }
                }
                Task { @MainActor in self.listen() }
            }
        }
    }

    private func scheduleReconnect() {
        guard let channel = currentChannel else { return }
        if reconnectTask != nil { return }
        reconnectAttempts += 1
        let delaySeconds = VoiceTiming.backoffDelaySeconds(attempt: reconnectAttempts, cap: 16)
        onError?("link lost — reconnecting in \(Int(delaySeconds))s")
        // Fire onLinkLost only here — this is the one site that knows the
        // socket actually dropped. Generic `error` frames pushed by the
        // server during normal operation must not flip the Reconnecting pill.
        onLinkLost?()
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
        case "air_claimed":
            // The relay pushes the talker the moment their first frame claims
            // the channel, so the UI can attribute the audio immediately
            // instead of waiting (up to ~1.2 s) for its next talk-activity poll.
            let claimUnit = ((object["unit_id"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !claimUnit.isEmpty {
                let claimName = ((object["display_name"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                onAirClaimed?((object["channel"] as? String) ?? "", claimUnit, claimName.isEmpty ? nil : claimName)
            }
        case "air_released":
            // Another unit on this channel just unkeyed. Synthesize the
            // close-side end-of-TX cue (roger beep / squelch tail) locally and
            // inject it into playout. No-op unless the agency enabled at least
            // one of the cue flags.
            playEndOfTxCue(messageChannel: object["channel"] as? String)
            onAirReleased?((object["channel"] as? String) ?? "")
        case "error":
            let code = (object["code"] as? String) ?? "unknown"
            onError?(code)
        default:
            break
        }
    }

    /// Build + play the close-side end-of-TX cue when the relay reports another
    /// unit unkeyed. Pinned + identical to the web / Android cue. No-op unless
    /// the agency enabled the roger beep and/or squelch tail.
    private func playEndOfTxCue(messageChannel: String? = nil) {
        guard let cfg = postDecodeConfig, cfg.rogerBeepEnabled || cfg.squelchTailEnabled else {
            return
        }
        // Defense-in-depth: if a dispatcher "move" raced the release, an
        // air_released for the channel we just left could arrive after we
        // re-joined elsewhere. The relay personalises the message with the
        // recipient's own channel name, so a mismatch means it's stale — skip.
        // Fail open: only skip on a clear non-empty mismatch so a normalisation
        // difference can never mute a legitimate cue.
        if let mc = messageChannel, !mc.isEmpty,
           let cur = currentChannel, !cur.isEmpty,
           mc.caseInsensitiveCompare(cur) != .orderedSame {
            return
        }
        let cue = PostDecodeChain.endOfTxCue(cfg)
        if cue.isEmpty { return }
        // Inject in <=20 ms (640-byte) frames, not as one ~210 ms entry: a single
        // large entry becomes the jitter buffer's lastGoodFrame and, since it's
        // the tail of the queue, the next playout tick underruns and PLC re-emits
        // a faded copy of the WHOLE cue — a stuttering echo that also stalls the
        // 20 ms cadence. Frame-sized chunks keep PLC + pacing normal (mirrors the
        // web track:true path bypassing PLC).
        let cueFrameBytes = 640  // 20 ms of 16 kHz mono PCM16
        var off = 0
        while off < cue.count {
            let end = min(off + cueFrameBytes, cue.count)
            audio.enqueueIncoming(cue.subdata(in: off..<end))
            off = end
        }
    }

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
