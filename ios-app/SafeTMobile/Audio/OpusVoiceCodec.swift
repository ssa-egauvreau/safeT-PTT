import AudioToolbox
import AVFoundation
import Foundation
import os

/// Opus encoder + decoder wrapping iOS's built-in `kAudioFormatOpus` codec
/// via `AVAudioConverter`. Available on iOS 16+, which matches the project's
/// deployment target.
///
/// Voice profile:
///  - sample rate: 16 000 Hz (matches existing uplink/downlink)
///  - channels: 1 (mono)
///  - frame size: 20 ms (320 samples) — matches the relay's 20 ms cadence
///  - bitrate: 32 kbps (was 20 — bumped after field reports of cutting-out
///    and robotic audio on loss. AudioToolbox doesn't expose Opus FEC
///    knobs, so we give the encoder more bits to fit harder voices
///    cleanly. ~12 kbps extra is negligible for this app's profile.)
///
/// Wire format: 2-byte magic (0x4F 0x70) + opaque Opus packet. Packet size
/// is variable per frame (DTX, complexity), so receivers identify the codec
/// by magic rather than length.
///
/// If iOS happens to lack Opus support on a given device (e.g. an OS version
/// older than 16 sneaks past the deployment target), `AVAudioConverter`'s
/// initializer returns nil and `isReady` stays false — the registry then
/// falls back to IMBE on TX and drops inbound Opus frames on RX.

private let OPUS_SAMPLE_RATE: Double = 16_000
private let OPUS_FRAME_SAMPLES: Int = 320  // 20 ms @ 16 kHz
private let OPUS_BITRATE: Int = 32_000

/// Source format: int16 mono 16 kHz LE (matches the wire PCM the encoder
/// consumes and the decoder produces).
private func makePcmFormat() -> AVAudioFormat? {
    return AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: OPUS_SAMPLE_RATE,
        channels: 1,
        interleaved: true
    )
}

/// Destination format: Opus mono 16 kHz. AudioToolbox infers bitrate from
/// the converter's `bitRate` property.
private func makeOpusFormat() -> AVAudioFormat? {
    var asbd = AudioStreamBasicDescription(
        mSampleRate: OPUS_SAMPLE_RATE,
        mFormatID: kAudioFormatOpus,
        mFormatFlags: 0,
        mBytesPerPacket: 0,
        mFramesPerPacket: UInt32(OPUS_FRAME_SAMPLES),
        mBytesPerFrame: 0,
        mChannelsPerFrame: 1,
        mBitsPerChannel: 0,
        mReserved: 0
    )
    return AVAudioFormat(streamDescription: &asbd)
}

final class OpusEncoder: VoiceEncoder {
    let codec: VoiceCodec = .opus

    private let logger = Logger(subsystem: "com.safetptt.mobile", category: "opus")
    private let lock = NSLock()
    private let converter: AVAudioConverter?
    private let pcmFormat: AVAudioFormat
    private let opusFormat: AVAudioFormat

    init() {
        guard let pcm = makePcmFormat(), let opus = makeOpusFormat() else {
            self.pcmFormat = AVAudioFormat(
                commonFormat: .pcmFormatInt16,
                sampleRate: OPUS_SAMPLE_RATE,
                channels: 1,
                interleaved: true
            )!
            self.opusFormat = self.pcmFormat
            self.converter = nil
            return
        }
        self.pcmFormat = pcm
        self.opusFormat = opus
        let c = AVAudioConverter(from: pcm, to: opus)
        if let c {
            c.bitRate = OPUS_BITRATE
        }
        self.converter = c
        if c == nil {
            // Most common cause: running on an iOS that didn't ship Opus
            // encode, or AudioToolbox refusing the format combination.
            // Registry treats us as unavailable; transport falls back to IMBE.
            logger.warning("Opus encoder unavailable on this device — falling back to IMBE on TX")
        }
    }

    var isReady: Bool { converter != nil }

    func resetForTalkSpurt() {
        lock.lock(); defer { lock.unlock() }
        converter?.reset()
    }

    func encodeFrame(_ pcm16kLe640: Data) -> Data? {
        guard pcm16kLe640.count == OPUS_FRAME_SAMPLES * 2 else { return nil }
        lock.lock(); defer { lock.unlock() }
        guard let converter else { return nil }

        guard let inputBuffer = AVAudioPCMBuffer(
            pcmFormat: pcmFormat,
            frameCapacity: AVAudioFrameCount(OPUS_FRAME_SAMPLES)
        ) else { return nil }
        inputBuffer.frameLength = AVAudioFrameCount(OPUS_FRAME_SAMPLES)
        guard let int16Channel = inputBuffer.int16ChannelData?[0] else { return nil }
        pcm16kLe640.withUnsafeBytes { raw in
            let src = raw.bindMemory(to: Int16.self)
            for i in 0..<OPUS_FRAME_SAMPLES {
                int16Channel[i] = src[i]
            }
        }

        // Opus packets at 20 kbps wideband fit comfortably under 256 B; 512 B
        // is generous headroom for upper-bound packets at FEC redundancy.
        // AVAudioCompressedBuffer's initializer is non-failable on iOS.
        let outputBuffer = AVAudioCompressedBuffer(
            format: opusFormat,
            packetCapacity: 1,
            maximumPacketSize: 512
        )

        var error: NSError?
        var supplied = false
        let status = converter.convert(to: outputBuffer, error: &error) { _, inputStatus in
            if supplied {
                inputStatus.pointee = .endOfStream
                return nil
            }
            supplied = true
            inputStatus.pointee = .haveData
            return inputBuffer
        }
        if status != .haveData {
            return nil
        }

        let packetCount = Int(outputBuffer.packetCount)
        guard packetCount >= 1, let descriptions = outputBuffer.packetDescriptions else { return nil }
        let firstPacketBytes = Int(descriptions[0].mDataByteSize)
        guard firstPacketBytes > 0, firstPacketBytes <= 512 else { return nil }

        var framed = Data(capacity: 2 + firstPacketBytes)
        framed.append(codec.magic0)
        framed.append(codec.magic1)
        let dataPtr = outputBuffer.data.assumingMemoryBound(to: UInt8.self)
        let offset = Int(descriptions[0].mStartOffset)
        framed.append(dataPtr.advanced(by: offset), count: firstPacketBytes)
        return framed
    }
}

final class OpusDecoder: VoiceDecoder {
    let codec: VoiceCodec = .opus
    let nativeSampleRate: Int = 16000

    private let logger = Logger(subsystem: "com.safetptt.mobile", category: "opus")
    private let lock = NSLock()
    private let converter: AVAudioConverter?
    private let pcmFormat: AVAudioFormat
    private let opusFormat: AVAudioFormat

    init() {
        guard let pcm = makePcmFormat(), let opus = makeOpusFormat() else {
            self.pcmFormat = AVAudioFormat(
                commonFormat: .pcmFormatInt16,
                sampleRate: OPUS_SAMPLE_RATE,
                channels: 1,
                interleaved: true
            )!
            self.opusFormat = self.pcmFormat
            self.converter = nil
            return
        }
        self.pcmFormat = pcm
        self.opusFormat = opus
        self.converter = AVAudioConverter(from: opus, to: pcm)
        if self.converter == nil {
            logger.warning("Opus decoder unavailable on this device — inbound Opus frames will drop")
        }
    }

    var isReady: Bool { converter != nil }

    func decodeFrame(_ framedBytes: Data) -> [Int16]? {
        guard framedBytes.count > 2 else { return nil }
        let firstByte = framedBytes[framedBytes.startIndex]
        let secondByte = framedBytes[framedBytes.startIndex + 1]
        guard firstByte == codec.magic0, secondByte == codec.magic1 else { return nil }
        let payload = framedBytes.subdata(in: framedBytes.startIndex + 2..<framedBytes.endIndex)
        let payloadSize = payload.count
        guard payloadSize > 0 else { return nil }

        lock.lock(); defer { lock.unlock() }
        guard let converter else { return nil }

        let compressedBuffer = AVAudioCompressedBuffer(
            format: opusFormat,
            packetCapacity: 1,
            maximumPacketSize: payloadSize
        )
        compressedBuffer.byteLength = UInt32(payloadSize)
        compressedBuffer.packetCount = 1
        payload.withUnsafeBytes { raw in
            guard let src = raw.baseAddress else { return }
            memcpy(compressedBuffer.data, src, payloadSize)
        }
        if let descs = compressedBuffer.packetDescriptions {
            descs[0] = AudioStreamPacketDescription(
                mStartOffset: 0,
                mVariableFramesInPacket: 0,
                mDataByteSize: UInt32(payloadSize)
            )
        }

        guard let pcmBuffer = AVAudioPCMBuffer(
            pcmFormat: pcmFormat,
            frameCapacity: AVAudioFrameCount(OPUS_FRAME_SAMPLES)
        ) else { return nil }

        var error: NSError?
        var supplied = false
        let status = converter.convert(to: pcmBuffer, error: &error) { _, inputStatus in
            if supplied {
                inputStatus.pointee = .endOfStream
                return nil
            }
            supplied = true
            inputStatus.pointee = .haveData
            return compressedBuffer
        }
        if status != .haveData { return nil }
        let frames = Int(pcmBuffer.frameLength)
        guard frames > 0, let int16Channel = pcmBuffer.int16ChannelData?[0] else { return nil }
        return Array(UnsafeBufferPointer(start: int16Channel, count: frames))
    }
}
