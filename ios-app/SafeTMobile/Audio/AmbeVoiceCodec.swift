import Foundation

/// AMBE+2 half-rate encoder + decoder (the P25 Phase 2 / DMR vocoder rate),
/// wrapping `P25AmbeNative` in the `VoiceEncoder` / `VoiceDecoder` protocols
/// so it slots into `VoiceCodecRegistry` alongside IMBE, Codec2 and Opus.
/// Wire format: 2-byte magic (0xA2 0x45) + 9-byte DMR-interleaved codeword
/// (49 voice bits @ 2450 bps) = 11 bytes total per 20 ms frame.

final class AmbeEncoder: VoiceEncoder {
    let codec: VoiceCodec = .ambe_2450
    var isReady: Bool { P25AmbeNative.isAvailable }

    func encodeFrame(_ pcm16kLe640: Data) -> Data? {
        guard isReady else { return nil }
        guard pcm16kLe640.count >= P25ImbeNative.Frames.pcm16kFrameBytes else { return nil }
        guard let ambeIn = P25ImbeNative.Frames.downsampleAvg16kToImbe(frame16k: pcm16kLe640),
              let codeword = P25AmbeNative.encodeFrame(samples8k160: ambeIn) else { return nil }
        var packet = Data(capacity: 2 + codeword.count)
        packet.append(codec.magic0)
        packet.append(codec.magic1)
        packet.append(codeword)
        return packet
    }
}

final class AmbeDecoder: VoiceDecoder {
    let codec: VoiceCodec = .ambe_2450
    var isReady: Bool { P25AmbeNative.isAvailable }
    let nativeSampleRate: Int = 8000

    func decodeFrame(_ framedBytes: Data) -> [Int16]? {
        guard isReady else { return nil }
        guard framedBytes.count == 11 else { return nil }
        let firstByte = framedBytes[framedBytes.startIndex]
        let secondByte = framedBytes[framedBytes.startIndex + 1]
        guard firstByte == codec.magic0, secondByte == codec.magic1 else { return nil }
        let codeword = framedBytes.subdata(in: framedBytes.startIndex + 2..<framedBytes.startIndex + 11)
        return P25AmbeNative.decodeCodeword9(codeword)
    }
}
