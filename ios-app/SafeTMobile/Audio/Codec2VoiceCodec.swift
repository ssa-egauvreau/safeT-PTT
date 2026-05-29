import Foundation
import os

/// Codec2 3200 bps encoder + decoder, wrapping the libcodec2 C API
/// (LGPL-2.1) via the Swift bridging header. libcodec2 is shared with
/// the Android NDK build — the iOS Xcode target compiles the same
/// slim vocoder source subset from android-app/app/src/main/cpp/codec2.
///
/// Mode 3200 was picked because:
///  - 20 ms frames (160 samples @ 8 kHz) match IMBE's cadence, so the
///    transport's existing 20 ms accumulator works unchanged.
///  - 3200 bps sounds substantially better than the lower-bitrate
///    Codec2 modes while preserving the "digital trunked radio"
///    character (close to AMBE+2 full-rate by ear).
///
/// Wire format: 2-byte magic (0xC2 0x01) + 8-byte codec2 codeword.
/// Both encode and decode run at 8 kHz; the transport's existing
/// post-decode chain handles the 8 kHz → 16 kHz upsample.
///
/// Falls back to IMBE via the registry if codec2_create returns null
/// (rare — usually means the libcodec2 source didn't compile in,
/// which surfaces as a link error at build time, not at runtime).

private let CODEC2_FRAME_SAMPLES = 160      // 20 ms @ 8 kHz
private let CODEC2_FRAME_BYTES   = 8        // 64 bits per frame

final class Codec2Encoder: VoiceEncoder {
    let codec: VoiceCodec = .codec2_3200

    private let logger = Logger(subsystem: "com.safetptt.mobile", category: "codec2")
    private let lock = NSLock()
    private var state: OpaquePointer?

    init() {
        state = Self.createState(logger: logger, role: "encoder")
    }

    deinit {
        if let s = state { codec2_destroy(s) }
    }

    var isReady: Bool { state != nil }

    func resetForTalkSpurt() {
        lock.lock()
        if let s = state { codec2_destroy(s) }
        state = Self.createState(logger: logger, role: "encoder")
        lock.unlock()
    }

    private static func createState(logger: Logger, role: String) -> OpaquePointer? {
        guard let s = codec2_create(Int32(CODEC2_MODE_3200)) else {
            logger.warning("codec2_create returned nil — Codec2 \(role) unavailable")
            return nil
        }
        if codec2_samples_per_frame(s) != Int32(CODEC2_FRAME_SAMPLES) ||
           codec2_bytes_per_frame(s)   != Int32(CODEC2_FRAME_BYTES) {
            logger.warning("Codec2 mode 3200 frame layout mismatch — disabling \(role)")
            codec2_destroy(s)
            return nil
        }
        return s
    }

    func encodeFrame(_ pcm16kLe640: Data) -> Data? {
        guard let s = state else { return nil }
        guard pcm16kLe640.count >= P25ImbeNative.Frames.pcm16kFrameBytes else { return nil }
        // Same 16 → 8 kHz path IMBE uses; mode 3200 also runs at 8 kHz.
        guard var pcm8k = P25ImbeNative.Frames.downsampleAvg16kToImbe(frame16k: pcm16kLe640) else {
            return nil
        }
        var codeword = [UInt8](repeating: 0, count: CODEC2_FRAME_BYTES)

        lock.lock(); defer { lock.unlock() }
        pcm8k.withUnsafeMutableBufferPointer { sp in
            codeword.withUnsafeMutableBufferPointer { cp in
                if let cpBase = cp.baseAddress, let spBase = sp.baseAddress {
                    codec2_encode(s, cpBase, spBase)
                }
            }
        }

        var framed = Data(capacity: 2 + CODEC2_FRAME_BYTES)
        framed.append(codec.magic0)
        framed.append(codec.magic1)
        framed.append(contentsOf: codeword)
        return framed
    }
}

final class Codec2Decoder: VoiceDecoder {
    let codec: VoiceCodec = .codec2_3200
    let nativeSampleRate: Int = 8000

    private let logger = Logger(subsystem: "com.safetptt.mobile", category: "codec2")
    private let lock = NSLock()
    private var state: OpaquePointer?

    init() {
        state = Codec2Encoder.createState(logger: logger, role: "decoder")
    }

    deinit {
        if let s = state { codec2_destroy(s) }
    }

    var isReady: Bool { state != nil }

    func resetForTalkSpurt() {
        lock.lock()
        if let s = state { codec2_destroy(s) }
        state = Codec2Encoder.createState(logger: logger, role: "decoder")
        lock.unlock()
    }

    func decodeFrame(_ framedBytes: Data) -> [Int16]? {
        guard let s = state else { return nil }
        // Magic (2 bytes) + codec2_3200 codeword (8 bytes) = 10 bytes.
        guard framedBytes.count == 2 + CODEC2_FRAME_BYTES else { return nil }
        let firstByte = framedBytes[framedBytes.startIndex]
        let secondByte = framedBytes[framedBytes.startIndex + 1]
        guard firstByte == codec.magic0, secondByte == codec.magic1 else { return nil }

        var codeword = [UInt8](repeating: 0, count: CODEC2_FRAME_BYTES)
        framedBytes.copyBytes(
            to: &codeword,
            from: (framedBytes.startIndex + 2)..<(framedBytes.startIndex + 2 + CODEC2_FRAME_BYTES)
        )

        var samples = [Int16](repeating: 0, count: CODEC2_FRAME_SAMPLES)

        lock.lock(); defer { lock.unlock() }
        samples.withUnsafeMutableBufferPointer { sp in
            codeword.withUnsafeMutableBufferPointer { cp in
                if let spBase = sp.baseAddress, let cpBase = cp.baseAddress {
                    codec2_decode(s, spBase, cpBase)
                }
            }
        }
        return samples
    }
}
