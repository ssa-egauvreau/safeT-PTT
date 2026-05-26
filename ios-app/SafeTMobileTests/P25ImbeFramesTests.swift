import XCTest
@testable import SafeTMobile

/// `P25ImbeNative.Frames` is the pure-Swift bridge between the 16 kHz LE16
/// frames the audio engine captures and the 8 kHz Int16 buffer the native
/// IMBE encoder expects. Off-by-one or endianness regressions here would
/// silently corrupt every uplink P25 frame, so the round-trip rules are
/// pinned down explicitly.
final class P25ImbeFramesTests: XCTestCase {
    // MARK: - downsampleAvg16kToImbe

    func test_downsample_returnsNil_whenFrameSmallerThanOneImbeFrame() {
        // Less than 640 bytes is not a complete 16 kHz IMBE input frame.
        XCTAssertNil(P25ImbeNative.Frames.downsampleAvg16kToImbe(frame16k: Data()))
        XCTAssertNil(P25ImbeNative.Frames.downsampleAvg16kToImbe(
            frame16k: Data(count: P25ImbeNative.Frames.pcm16kFrameBytes - 1)))
    }

    func test_downsample_returns160Samples_for640ByteFrame() {
        let frame = pcm16k(samples: Array(repeating: Int16(0), count: 320))
        let out = P25ImbeNative.Frames.downsampleAvg16kToImbe(frame16k: frame)
        XCTAssertEqual(out?.count, 160)
    }

    func test_downsample_averagesAdjacentSamplePairs() {
        // For each output sample i, out[i] = (in[2i] + in[2i+1]) / 2. Use a
        // ramp so any indexing error or endianness flip is immediately visible.
        let input: [Int16] = (0..<320).map { Int16($0 - 160) }
        let frame = pcm16k(samples: input)
        let out = P25ImbeNative.Frames.downsampleAvg16kToImbe(frame16k: frame)
        XCTAssertNotNil(out)
        for i in 0..<160 {
            let expected = Int16(clamping: (Int32(input[2 * i]) + Int32(input[2 * i + 1])) / 2)
            XCTAssertEqual(out?[i], expected,
                           "downsample mismatch at index \(i)")
        }
    }

    func test_downsample_doesNotOverflow_atInt16Extremes() {
        // Two full-scale samples must average to ±32767/0 without wrapping
        // through Int32 truncation.
        let input: [Int16] = Array(repeating: 32_767, count: 320)
        let out = P25ImbeNative.Frames.downsampleAvg16kToImbe(frame16k: pcm16k(samples: input))
        XCTAssertEqual(out, Array(repeating: Int16(32_767), count: 160))

        let lows: [Int16] = Array(repeating: -32_768, count: 320)
        let outLow = P25ImbeNative.Frames.downsampleAvg16kToImbe(frame16k: pcm16k(samples: lows))
        XCTAssertEqual(outLow, Array(repeating: Int16(-32_768), count: 160))
    }

    func test_downsample_decodesLittleEndianBytes() {
        // 0x0100 little-endian = 1, 0x00FF little-endian = 255. Mixing them
        // ensures the lo/hi order is preserved.
        let raw: [UInt8] = [
            0x01, 0x00, // sample 0 = 1
            0xFF, 0x00, // sample 1 = 255
            0x00, 0x01, // sample 2 = 256
            0x00, 0x01, // sample 3 = 256
        ]
        // Pad to a full IMBE frame so the guard passes.
        var frame = Data(raw)
        frame.append(Data(count: P25ImbeNative.Frames.pcm16kFrameBytes - raw.count))
        let out = P25ImbeNative.Frames.downsampleAvg16kToImbe(frame16k: frame)
        XCTAssertEqual(out?[0], 128) // (1 + 255) / 2
        XCTAssertEqual(out?[1], 256) // (256 + 256) / 2
    }

    // MARK: - upsampleDup8kToLe16Mono

    func test_upsample_produces640Bytes_from160Samples() {
        let pcm = Array(repeating: Int16(0), count: 160)
        let out = P25ImbeNative.Frames.upsampleDup8kToLe16Mono(pcm8k160: pcm)
        XCTAssertEqual(out.count, P25ImbeNative.Frames.pcm16kFrameBytes)
    }

    func test_upsample_duplicatesEachSample_inLittleEndian() {
        // Each 8 kHz sample becomes two identical 16 kHz LE16 samples
        // (zero-order hold). Verify both halves match for a range of values
        // that includes the sign bit and the high byte.
        let pcm: [Int16] = [0, 1, -1, 256, -256, 32_767, -32_768]
        // Pad so the function gets the 160-sample buffer it requires.
        var padded = pcm
        padded.append(contentsOf: Array(repeating: Int16(0), count: 160 - pcm.count))

        let bytes = Array(P25ImbeNative.Frames.upsampleDup8kToLe16Mono(pcm8k160: padded))

        for (index, sample) in pcm.enumerated() {
            let base = index * 4
            let first = Int16(bitPattern: UInt16(bytes[base]) | (UInt16(bytes[base + 1]) << 8))
            let second = Int16(bitPattern: UInt16(bytes[base + 2]) | (UInt16(bytes[base + 3]) << 8))
            XCTAssertEqual(first, sample, "first copy at index \(index)")
            XCTAssertEqual(second, sample, "duplicate copy at index \(index)")
        }
    }

    // MARK: - helpers

    private func pcm16k(samples: [Int16]) -> Data {
        var data = Data(count: samples.count * 2)
        data.withUnsafeMutableBytes { raw in
            guard let base = raw.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            for (i, sample) in samples.enumerated() {
                let le = UInt16(bitPattern: sample)
                base[i * 2] = UInt8(le & 0xff)
                base[i * 2 + 1] = UInt8((le >> 8) & 0xff)
            }
        }
        return data
    }
}
