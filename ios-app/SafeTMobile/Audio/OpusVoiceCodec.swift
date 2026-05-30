import Foundation
import os

/// Opus encoder + decoder backed by the bundled libopus (BSD-3-Clause; see
/// cpp/opus submodule pinned to v1.5.2) via the Swift bridging header.
/// This replaces the previous `AVAudioConverter`-based AudioToolbox path
/// so we can configure the encoder for **in-band FEC**
/// (`OPUS_SET_INBAND_FEC = 1`) and the **packet-loss-percentage hint**
/// (`OPUS_SET_PACKET_LOSS_PERC = 10`). The system AudioToolbox Opus
/// codec exposed only bitrate as a knob; libopus gives us the full
/// encoder surface plus the `opus_decode(..., decode_fec=1)` LBRR
/// recovery API.
///
/// libopus is shared with the Android NDK build at
/// `android-app/app/src/main/cpp/CMakeLists.txt` and the Emscripten
/// WASM build at `server/web-console/cpp/build-opus.sh`. All three end
/// points speak identical RFC 6716 Opus and keep the same wire format
/// (2-byte magic `0x4F 0x70` + opaque packet), so peers still on the
/// MediaCodec / AudioToolbox / WebCodecs paths decode our libopus
/// frames unchanged — and we decode theirs. LBRR data inside our
/// packets is transparent to receivers that aren't FEC-aware.
///
/// Voice profile (matches Android + web libopus paths):
///  - sample rate: 16 000 Hz
///  - channels: 1 (mono)
///  - frame size: 20 ms (320 samples)
///  - bitrate: 32 kbps
///  - application: OPUS_APPLICATION_VOIP
///  - signal hint: OPUS_SIGNAL_VOICE
///  - in-band FEC: ON (10 % packet-loss budget)
///  - complexity: 8
///  - DTX: OFF (would suppress LBRR-carrying packets)
///
/// Falls back to IMBE on TX via the registry if libopus failed to load.
/// Inbound Opus frames drop with a one-shot log on a not-ready decoder.

private let OPUS_SAMPLE_RATE: Int32 = 16_000
private let OPUS_CHANNELS: Int32 = 1
private let OPUS_FRAME_SAMPLES: Int = 320  // 20 ms @ 16 kHz
private let OPUS_BITRATE: Int32 = 32_000
private let OPUS_PACKET_LOSS_PERC: Int32 = 10
private let OPUS_COMPLEXITY: Int32 = 8
/// Generous upper bound on a 20 ms 32 kbps Opus packet. Measured ~80-160 B
/// for voice; 512 leaves headroom for FEC LBRR bloat and the rare CELT
/// burst. opus_encode returns the actual length.
private let OPUS_MAX_PACKET_BYTES: Int = 512

/// Apply the encoder voice profile to a freshly-created encoder. Returns
/// false if any CTL failed, so the caller can destroy the encoder and
/// report unavailable to the registry. Order mirrors `opus_jni.cpp`'s
/// `encoderApplyConfigLocked` and `opus_wasm.c`'s `opus_init_encoder` —
/// keep the three identical so all platforms emit byte-identical bitstreams.
///
/// libopus's `opus_encoder_ctl` is variadic and Swift can't call C
/// variadics, so each CTL goes through a non-variadic shim defined in
/// `SafeTMobile/Native/opus_swift_bridge.c` (declared in the bridging
/// header).
private func applyEncoderConfig(_ encoder: OpaquePointer) -> Bool {
    // CTL macros (OPUS_SIGNAL_VOICE, etc.) are imported as untyped Int
    // literals; cast to Int32 explicitly to match the C bridge's int arg.
    if opus_swift_encoder_set_signal(encoder, Int32(OPUS_SIGNAL_VOICE)) != Int32(OPUS_OK) { return false }
    if opus_swift_encoder_set_bitrate(encoder, OPUS_BITRATE) != Int32(OPUS_OK) { return false }
    if opus_swift_encoder_set_inband_fec(encoder, 1) != Int32(OPUS_OK) { return false }
    if opus_swift_encoder_set_packet_loss_perc(encoder, OPUS_PACKET_LOSS_PERC) != Int32(OPUS_OK) { return false }
    if opus_swift_encoder_set_complexity(encoder, OPUS_COMPLEXITY) != Int32(OPUS_OK) { return false }
    // DTX off — a DTX'd frame emits no packet, so there'd be nothing
    // on the wire to carry the next frame's LBRR. FEC and DTX are
    // mutually exclusive for our purposes.
    if opus_swift_encoder_set_dtx(encoder, 0) != Int32(OPUS_OK) { return false }
    return true
}

final class OpusEncoder: VoiceEncoder {
    let codec: VoiceCodec = .opus

    private let logger = Logger(subsystem: "com.safetptt.mobile", category: "opus")
    private let lock = NSLock()
    private var state: OpaquePointer?

    init() {
        state = Self.createEncoderState(logger: logger)
    }

    deinit {
        if let s = state { opus_encoder_destroy(s) }
    }

    var isReady: Bool { state != nil }

    func resetForTalkSpurt() {
        lock.lock(); defer { lock.unlock() }
        if let s = state { opus_encoder_destroy(s) }
        state = Self.createEncoderState(logger: logger)
    }

    fileprivate static func createEncoderState(logger: Logger) -> OpaquePointer? {
        var err: Int32 = 0
        // Cast the libopus C macros to Int32 explicitly — Clang imports
        // them as untyped Int literals; the underlying C API takes `int`
        // (= Int32 on iOS) and a literal-Int mismatch would surface as a
        // Swift compile error rather than a runtime ABI issue.
        guard let enc = opus_encoder_create(OPUS_SAMPLE_RATE,
                                            OPUS_CHANNELS,
                                            Int32(OPUS_APPLICATION_VOIP),
                                            &err),
              err == Int32(OPUS_OK)
        else {
            logger.warning("opus_encoder_create failed — Opus encoder unavailable, registry falls back to IMBE on TX")
            return nil
        }
        if !applyEncoderConfig(enc) {
            logger.warning("opus_encoder_ctl rejected the voice profile — Opus encoder unavailable")
            opus_encoder_destroy(enc)
            return nil
        }
        return enc
    }

    func encodeFrame(_ pcm16kLe640: Data) -> Data? {
        guard let s = state else { return nil }
        guard pcm16kLe640.count == OPUS_FRAME_SAMPLES * 2 else { return nil }

        // PCM-16 LE bytes → Int16 array for the libopus C API.
        var samples = [Int16](repeating: 0, count: OPUS_FRAME_SAMPLES)
        pcm16kLe640.withUnsafeBytes { raw in
            let src = raw.bindMemory(to: UInt8.self)
            for i in 0..<OPUS_FRAME_SAMPLES {
                let lo = Int32(src[2 * i])
                let hi = Int32(Int8(bitPattern: src[2 * i + 1])) << 8
                samples[i] = Int16(truncatingIfNeeded: lo | hi)
            }
        }

        var outBuf = [UInt8](repeating: 0, count: OPUS_MAX_PACKET_BYTES)
        var packetLen: Int32 = 0

        lock.lock()
        samples.withUnsafeBufferPointer { spIn in
            outBuf.withUnsafeMutableBufferPointer { spOut in
                guard let inBase = spIn.baseAddress, let outBase = spOut.baseAddress else { return }
                packetLen = opus_encode(s,
                                        inBase,
                                        Int32(OPUS_FRAME_SAMPLES),
                                        outBase,
                                        Int32(OPUS_MAX_PACKET_BYTES))
            }
        }
        lock.unlock()

        guard packetLen > 0 else {
            logger.warning("opus_encode returned \(packetLen) — dropping frame")
            return nil
        }

        var framed = Data(capacity: 2 + Int(packetLen))
        framed.append(codec.magic0)
        framed.append(codec.magic1)
        // Slice off the unused tail of outBuf since opus_encode only
        // populates `packetLen` bytes; copying the whole 512-byte capacity
        // would smuggle silent padding into the wire frame.
        framed.append(contentsOf: outBuf.prefix(Int(packetLen)))
        return framed
    }
}

final class OpusDecoder: VoiceDecoder {
    let codec: VoiceCodec = .opus
    let nativeSampleRate: Int = 16000

    private let logger = Logger(subsystem: "com.safetptt.mobile", category: "opus")
    private let lock = NSLock()
    private var state: OpaquePointer?

    init() {
        state = Self.createDecoderState(logger: logger)
    }

    deinit {
        if let s = state { opus_decoder_destroy(s) }
    }

    var isReady: Bool { state != nil }

    func resetForTalkSpurt() {
        lock.lock(); defer { lock.unlock() }
        if let s = state { opus_decoder_destroy(s) }
        state = Self.createDecoderState(logger: logger)
    }

    fileprivate static func createDecoderState(logger: Logger) -> OpaquePointer? {
        var err: Int32 = 0
        guard let dec = opus_decoder_create(OPUS_SAMPLE_RATE, OPUS_CHANNELS, &err),
              err == Int32(OPUS_OK)
        else {
            logger.warning("opus_decoder_create failed — inbound Opus frames will drop")
            return nil
        }
        return dec
    }

    func decodeFrame(_ framedBytes: Data) -> [Int16]? {
        guard state != nil else { return nil }
        guard framedBytes.count > 2 else { return nil }
        let firstByte = framedBytes[framedBytes.startIndex]
        let secondByte = framedBytes[framedBytes.startIndex + 1]
        guard firstByte == codec.magic0, secondByte == codec.magic1 else { return nil }

        let payload = framedBytes.subdata(in: framedBytes.startIndex + 2..<framedBytes.endIndex)
        return decodeBarePacket(payload, fec: false)
    }

    /// Reconstruct the previous (lost) frame from the LBRR data embedded
    /// in `nextFramedBytes`. Returns 320 samples of 16 kHz mono PCM-16
    /// when the prior sender enabled in-band FEC, or nil if FEC wasn't
    /// available (sender on a non-FEC path) or the call failed.
    ///
    /// This is exposed for the receiver-side jitter buffer to wire up
    /// in a follow-up change once a reliable loss-detection signal is
    /// available. The encoder side already emits LBRR on the wire today
    /// for FEC-aware peers to recover.
    func decodeLostFrameFromNext(_ nextFramedBytes: Data) -> [Int16]? {
        guard state != nil else { return nil }
        guard nextFramedBytes.count > 2 else { return nil }
        let firstByte = nextFramedBytes[nextFramedBytes.startIndex]
        let secondByte = nextFramedBytes[nextFramedBytes.startIndex + 1]
        guard firstByte == codec.magic0, secondByte == codec.magic1 else { return nil }

        let payload = nextFramedBytes.subdata(in: nextFramedBytes.startIndex + 2..<nextFramedBytes.endIndex)
        return decodeBarePacket(payload, fec: true)
    }

    /// Shared decode path. `fec=true` calls `opus_decode` with `decode_fec=1`
    /// so the LBRR data in `payload` reconstructs the *previous* (lost)
    /// frame; otherwise normal decode of `payload` as the current frame.
    private func decodeBarePacket(_ payload: Data, fec: Bool) -> [Int16]? {
        guard let s = state else { return nil }
        guard payload.count > 0 else { return nil }

        var samples = [Int16](repeating: 0, count: OPUS_FRAME_SAMPLES)
        var decoded: Int32 = 0

        lock.lock()
        payload.withUnsafeBytes { raw in
            guard let src = raw.bindMemory(to: UInt8.self).baseAddress else { return }
            samples.withUnsafeMutableBufferPointer { sp in
                guard let outBase = sp.baseAddress else { return }
                decoded = opus_decode(s, src, Int32(payload.count),
                                      outBase, Int32(OPUS_FRAME_SAMPLES),
                                      fec ? Int32(1) : Int32(0))
            }
        }
        lock.unlock()

        guard decoded == Int32(OPUS_FRAME_SAMPLES) else {
            return nil
        }
        return samples
    }
}
