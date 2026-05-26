import XCTest
@testable import SafeTMobile

/// Coverage for the IMBE TX pipeline data transforms added with the
/// cross-platform P25 vocoder. These helpers run on every captured frame
/// during PTT, and a regression in their length / averaging contract would
/// either corrupt uplink audio or, worse, leak the trailing half-frame from
/// the previous transmission once the buffer is reset on busy/abort.
final class P25ImbeFramesTests: XCTestCase {
    // MARK: - downsampleAvg16kToImbe

    /// 320 samples @ 16 kHz must average down to exactly 160 samples
    /// (the IMBE 20 ms frame size at 8 kHz). Anything else means the IMBE
    /// encoder will reject the buffer and the air-channel will go silent.
    func test_downsample_returns160Samples_for640ByteFrame() throws {
        let pcm = makeLE16Bytes(samples: Array(repeating: Int16(0), count: 320))
        let out = try XCTUnwrap(P25ImbeNative.Frames.downsampleAvg16kToImbe(frame16k: pcm))
        XCTAssertEqual(out.count, 160)
    }

    func test_downsample_returnsNil_whenFrameTooShort() {
        let short = Data(count: P25ImbeNative.Frames.pcm16kFrameBytes - 2)
        XCTAssertNil(P25ImbeNative.Frames.downsampleAvg16kToImbe(frame16k: short))
    }

    /// Pairs are averaged: (s[2i] + s[2i+1]) / 2. Verified against a known
    /// pattern so a future change to a different decimator (drop-one, FIR)
    /// is caught — both would still produce 160 samples and silently
    /// detune the spectrum.
    func test_downsample_averagesAdjacentSamples() throws {
        var samples: [Int16] = []
        for i in 0..<320 {
            samples.append(Int16(i * 10 - 1600))
        }
        let out = try XCTUnwrap(
            P25ImbeNative.Frames.downsampleAvg16kToImbe(frame16k: makeLE16Bytes(samples: samples))
        )
        for i in 0..<160 {
            let expected = Int16((Int32(samples[2 * i]) + Int32(samples[2 * i + 1])) / 2)
            XCTAssertEqual(out[i], expected, "downsample index \(i)")
        }
    }

    /// Negative samples must be averaged as signed values (Int32 widen),
    /// not as raw unsigned bytes. Catches the classic "averaged via UInt16
    /// and wrapped" regression.
    func test_downsample_handlesNegativeSamples() throws {
        let samples = Array(repeating: Int16(-30_000), count: 320)
        let out = try XCTUnwrap(
            P25ImbeNative.Frames.downsampleAvg16kToImbe(frame16k: makeLE16Bytes(samples: samples))
        )
        XCTAssertEqual(out, Array(repeating: Int16(-30_000), count: 160))
    }

    // MARK: - upsampleDup8kToLe16Mono

    /// The decoder produces 160 samples @ 8 kHz; the playback engine
    /// expects 320 samples @ 16 kHz LE16 (640 bytes). The duplication
    /// upsampler is the cheapest fill that preserves frame boundaries —
    /// changing it without updating the audio session sample rate would
    /// cause receive audio to play at half speed.
    func test_upsample_produces640Bytes_for160SampleInput() {
        let out = P25ImbeNative.Frames.upsampleDup8kToLe16Mono(pcm8k160: Array(repeating: 0, count: 160))
        XCTAssertEqual(out.count, 640)
    }

    func test_upsample_duplicatesEachSampleInLittleEndian() {
        let input: [Int16] = [0x0102, -1, 0x7FFF, Int16.min]
        let padded = input + Array(repeating: Int16(0), count: 160 - input.count)
        let out = P25ImbeNative.Frames.upsampleDup8kToLe16Mono(pcm8k160: padded)
        XCTAssertEqual([out[0], out[1], out[2], out[3]], [0x02, 0x01, 0x02, 0x01], "0x0102 duplicated, LE byte order")
        XCTAssertEqual([out[4], out[5], out[6], out[7]], [0xFF, 0xFF, 0xFF, 0xFF], "-1 (0xFFFF) duplicated")
        XCTAssertEqual([out[8], out[9], out[10], out[11]], [0xFF, 0x7F, 0xFF, 0x7F], "Int16.max duplicated")
        XCTAssertEqual([out[12], out[13], out[14], out[15]], [0x00, 0x80, 0x00, 0x80], "Int16.min duplicated")
    }

    // MARK: - helpers

    private func makeLE16Bytes(samples: [Int16]) -> Data {
        var out = Data(capacity: samples.count * 2)
        for sample in samples {
            let le = UInt16(bitPattern: sample)
            out.append(UInt8(le & 0xff))
            out.append(UInt8((le >> 8) & 0xff))
        }
        return out
    }
}
