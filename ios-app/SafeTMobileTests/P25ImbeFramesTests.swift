import XCTest
@testable import SafeTMobile

/// Tests for the pure PCM-rate-conversion helpers used on the IMBE uplink
/// (16 kHz mic → 8 kHz codec) and downlink (8 kHz codec → 16 kHz speaker)
/// paths. These helpers feed directly into the same IMBE accumulator whose
/// stale-tail leak was the subject of the PR adding an unconditional
/// `resetUplinkState()` call — getting the framing math wrong here would
/// either silently truncate audio or smear samples between iterations even
/// when the accumulator *is* reset.
final class P25ImbeFramesTests: XCTestCase {
    // MARK: - downsampleAvg16kToImbe

    func test_downsample_rejectsShortInput() {
        XCTAssertNil(P25ImbeNative.Frames.downsampleAvg16kToImbe(frame16k: Data()))
        XCTAssertNil(P25ImbeNative.Frames.downsampleAvg16kToImbe(frame16k: Data(count: 639)))
    }

    func test_downsample_acceptsExact640Bytes_returns160Samples() throws {
        let frame = Data(count: P25ImbeNative.Frames.pcm16kFrameBytes)
        let out = try XCTUnwrap(P25ImbeNative.Frames.downsampleAvg16kToImbe(frame16k: frame))
        XCTAssertEqual(out.count, 160)
        XCTAssertTrue(out.allSatisfy { $0 == 0 })
    }

    /// Each output sample must be the truncated mean of the corresponding
    /// adjacent 16 kHz input pair. Pair (2i, 2i+1) = (10i, 10i + 4) gives a
    /// deterministic expected output of 10i + 2.
    func test_downsample_averagesAdjacentSamplePairs() throws {
        var data = Data(count: P25ImbeNative.Frames.pcm16kFrameBytes)
        data.withUnsafeMutableBytes { raw in
            guard let base = raw.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            for i in 0..<160 {
                Self.writeLe(base + i * 4, Int16(i * 10))
                Self.writeLe(base + i * 4 + 2, Int16(i * 10 + 4))
            }
        }
        let out = try XCTUnwrap(P25ImbeNative.Frames.downsampleAvg16kToImbe(frame16k: data))
        for i in 0..<160 {
            XCTAssertEqual(out[i], Int16(i * 10 + 2), "pair \(i) should average to \(i * 10 + 2)")
        }
    }

    /// The averaging must happen in signed 32-bit math; an unsigned add would
    /// wrap and yield wildly wrong values for full-scale negative samples.
    func test_downsample_averagesUsingSignedExtendedMath() throws {
        var data = Data(count: P25ImbeNative.Frames.pcm16kFrameBytes)
        data.withUnsafeMutableBytes { raw in
            guard let base = raw.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            // (Int16.min, Int16.max) → (-32768 + 32767) / 2 = 0 (truncated toward zero)
            Self.writeLe(base, Int16.min)
            Self.writeLe(base + 2, Int16.max)
            // (Int16.min, Int16.min) stays Int16.min
            Self.writeLe(base + 4, Int16.min)
            Self.writeLe(base + 6, Int16.min)
            // (Int16.max, Int16.max) stays Int16.max
            Self.writeLe(base + 8, Int16.max)
            Self.writeLe(base + 10, Int16.max)
            // (-1000, 1000) → 0
            Self.writeLe(base + 12, Int16(-1000))
            Self.writeLe(base + 14, Int16(1000))
        }
        let out = try XCTUnwrap(P25ImbeNative.Frames.downsampleAvg16kToImbe(frame16k: data))
        XCTAssertEqual(out[0], 0)
        XCTAssertEqual(out[1], Int16.min)
        XCTAssertEqual(out[2], Int16.max)
        XCTAssertEqual(out[3], 0)
    }

    /// The helper must read only the first 640 bytes even if a longer buffer
    /// is supplied — the VoiceTransport accumulator hands it a 640-byte
    /// prefix slice every iteration and any over-read would corrupt the next
    /// IMBE frame.
    func test_downsample_ignoresBytesPastFirstFrame() throws {
        var data = Data(count: P25ImbeNative.Frames.pcm16kFrameBytes)
        data.withUnsafeMutableBytes { raw in
            guard let base = raw.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            for i in 0..<160 {
                Self.writeLe(base + i * 4, Int16(i))
                Self.writeLe(base + i * 4 + 2, Int16(i))
            }
        }
        let referenceOut = try XCTUnwrap(P25ImbeNative.Frames.downsampleAvg16kToImbe(frame16k: data))

        var extended = data
        extended.append(Data(repeating: 0xff, count: 256))
        let extendedOut = try XCTUnwrap(P25ImbeNative.Frames.downsampleAvg16kToImbe(frame16k: extended))

        XCTAssertEqual(referenceOut, extendedOut)
    }

    // MARK: - upsampleDup8kToLe16Mono

    func test_upsample_producesExactly640Bytes() {
        let pcm = [Int16](repeating: 0, count: 160)
        let out = P25ImbeNative.Frames.upsampleDup8kToLe16Mono(pcm8k160: pcm)
        XCTAssertEqual(out.count, 640)
        XCTAssertTrue(out.allSatisfy { $0 == 0 })
    }

    /// Each 8 kHz input sample must appear twice consecutively in the 16 kHz
    /// output, encoded little-endian.
    func test_upsample_duplicatesEachSampleInLittleEndian() {
        var pcm = [Int16](repeating: 0, count: 160)
        pcm[0] = 0x1234
        pcm[1] = -1
        pcm[159] = Int16.min

        let out = P25ImbeNative.Frames.upsampleDup8kToLe16Mono(pcm8k160: pcm)
        XCTAssertEqual(out.count, 640)

        // Sample 0 = 0x1234 → little-endian [0x34, 0x12] repeated twice
        XCTAssertEqual(out[0], 0x34)
        XCTAssertEqual(out[1], 0x12)
        XCTAssertEqual(out[2], 0x34)
        XCTAssertEqual(out[3], 0x12)

        // Sample 1 = -1 → 0xffff → [0xff, 0xff] repeated twice
        XCTAssertEqual(out[4], 0xff)
        XCTAssertEqual(out[5], 0xff)
        XCTAssertEqual(out[6], 0xff)
        XCTAssertEqual(out[7], 0xff)

        // Sample 159 = Int16.min = 0x8000 → [0x00, 0x80] repeated twice at offset 636
        XCTAssertEqual(out[636], 0x00)
        XCTAssertEqual(out[637], 0x80)
        XCTAssertEqual(out[638], 0x00)
        XCTAssertEqual(out[639], 0x80)
    }

    // MARK: - helpers

    private static func writeLe(_ ptr: UnsafeMutablePointer<UInt8>, _ value: Int16) {
        let le = UInt16(bitPattern: value)
        ptr[0] = UInt8(le & 0xff)
        ptr[1] = UInt8((le >> 8) & 0xff)
    }
}
