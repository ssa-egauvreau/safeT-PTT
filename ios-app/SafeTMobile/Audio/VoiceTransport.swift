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
    /// Raw post-decode config cached alongside the processor. Drives the
    /// wideband (Opus) routing decision and the end-of-TX cue synthesis on
    /// `air_released` — the cue path needs it even when there is no DSP
    /// processor to build (e.g. a roger-beep-only config). `nil` when no
    /// shaping/cue is configured.
    private var postDecodeConfig: PostDecodeChain.Config?
    /// Fixed Opus-only voicing (see `PostDecodeChain.Config.opusVoiceShaping`).
    /// Built on the first Opus frame so IMBE/Codec2-only channels never pay for
    /// it; reset at talk-spurt boundaries so a prior talker's biquad ring can't
    /// bleed into the next talker's first frame. Independent of the agency
    /// `postDecodeProcessor`, so the 8 kHz vocoders keep playing raw.
    private var opusVoiceProcessor: PostDecodeChain.Processor?
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
            let nextConfig: PostDecodeChain.Config? = response.config?.postDecode?.toConfig()
            let next: PostDecodeChain.Processor?
            if let cfg = nextConfig {
                next = cfg.isNoOp ? nil : PostDecodeChain.Processor(config: cfg)
            } else {
                next = nil
            }
            await MainActor.run {
                self.postDecodeProcessor = next
                self.postDecodeConfig = nextConfig
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
            // Voice-link telemetry: count every inbound voice frame + its
            // decoded outcome below. Decoder codec wire id ("imbe" / "opus"
            // / "codec2_3200") feeds the per-codec breakdown the admin
            // dashboard renders.
            let telemetryCodec = decoder.codec.wireId
            VoiceLinkTelemetryReporter.shared.recordFrameReceived(codec: telemetryCodec, bytes: payload.count)
            if newSpurt {
                decoder.resetForTalkSpurt()
                // Reset the post-decode chain on every talk-spurt boundary,
                // regardless of codec: the 8 kHz path and the Opus wideband
                // path share the same biquad / compressor state, so a previous
                // talker's filter ring must not bleed into the next talker's
                // first frame on either path.
                postDecodeProcessor?.reset()
                opusVoiceProcessor?.reset()
                VoiceLinkTelemetryReporter.shared.recordTalkSpurtStart()
            }
            // Lazy-load IMBE on first frame so peers stay audible even before
            // this radio opens the PTT screen. Other codecs load (or fail to
            // load) eagerly with their own native libs.
            if decoder.codec == .imbe, !P25ImbeNative.isAvailable, !P25ImbeNative.initialize() {
                VoiceLinkTelemetryReporter.shared.recordDecodeFailure()
                logger.warning("IMBE frame discarded — vocoder not loaded")
                return
            }
            guard decoder.isReady else {
                VoiceLinkTelemetryReporter.shared.recordDecodeFailure()
                logger.warning("Inbound \(decoder.codec.wireId, privacy: .public) frame dropped — decoder native lib not loaded")
                return
            }
            guard let samples = decoder.decodeFrame(payload) else {
                VoiceLinkTelemetryReporter.shared.recordDecodeFailure()
                return
            }
            VoiceLinkTelemetryReporter.shared.recordFrameDecoded(codec: telemetryCodec)
            let pcm16 = renderDecoded(samples, nativeRate: decoder.nativeSampleRate)
            lastReceivedAt = Date()
            onReceivingChange?(true)
            audio.enqueueIncoming(pcm16)
            return
        }
        // Unknown magic — legacy clear PCM path (soundboard tone-out, etc.).
        // Telemetry counts these as `raw_pcm` so an operator can spot a peer
        // whose vocoder failed to engage.
        VoiceLinkTelemetryReporter.shared.recordFrameReceived(codec: "raw_pcm", bytes: payload.count)
        lastReceivedAt = Date()
        onReceivingChange?(true)
        audio.enqueueIncoming(payload)
    }

    /// Brings a decoder's native-rate output to the playback rate (16 kHz mono
    /// PCM-16 LE). 8 kHz output (IMBE, Codec2) runs through the existing
    /// post-decode chain or duplicate-upsample fast path; 16 kHz output (Opus)
    /// runs through the same chain's wideband entry point (no upsample) when the
    /// agency enabled `wideband`, otherwise plays unshaped.
    private func renderDecoded(_ samples: [Int16], nativeRate: Int) -> Data {
        if nativeRate == 8000 {
            return applyPostDecodeOrDup(samples)
        }
        return applyWidebandOrPassthrough(samples)
    }

    /// Opus (16 kHz) RX shaping: when the agency enabled `wideband` AND a
    /// processor exists, run the decoded frame through the same
    /// biquad → compressor → saturation tail as the 8 kHz path but skipping the
    /// upsample (the input is already 16 kHz). Otherwise play unshaped — today's
    /// behaviour. Opus frames are not 160 samples; the wideband path is
    /// length-agnostic.
    private func applyWidebandOrPassthrough(_ samples: [Int16]) -> Data {
        if let processor = postDecodeProcessor, postDecodeConfig?.wideband == true {
            return processor.processWideband(pcm16k: samples)
        }
        // No agency wideband chain: apply the fixed "warm radio voice" Opus
        // shaping so Opus sounds full and clear rather than thin. Opus path
        // only — the 8 kHz vocoders (IMBE/Codec2) play raw via applyPostDecodeOrDup.
        let proc: PostDecodeChain.Processor
        if let existing = opusVoiceProcessor {
            proc = existing
        } else {
            proc = PostDecodeChain.Processor(config: .opusVoiceShaping)
            opusVoiceProcessor = proc
        }
        return proc.processWideband(pcm16k: samples)
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
        case "air_released":
            // Another unit on this channel just unkeyed. Synthesize the
            // close-side end-of-TX cue (roger beep / squelch tail) locally and
            // inject it into playout. No-op unless the agency enabled at least
            // one of the cue flags.
            playEndOfTxCue(messageChannel: object["channel"] as? String)
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
