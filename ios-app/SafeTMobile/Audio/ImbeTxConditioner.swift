import Foundation

/// Transmit-side conditioning for P25 IMBE uplink (mirrors web imbeTxConditioner.ts / Android).
final class ImbeTxConditioner {
    private let fs = 16_000.0
    private let hpf: Biquad
    private let lpf: Biquad
    private var env = 0.0
    private var floor = ImbeTxConditioner.floorMin
    private var gateGain = 0.0
    private var agcGain = 1.0
    private var agcTarget = 1.0

    init() {
        hpf = Biquad(kind: .highPass, fc: Self.hpfHz, q: Self.filterQ, fs: fs)
        lpf = Biquad(kind: .lowPass, fc: Self.lpfHz, q: Self.filterQ, fs: fs)
    }

    func reset() {
        hpf.reset()
        lpf.reset()
        env = 0
        floor = Self.floorMin
        gateGain = 0
        agcGain = 1
        agcTarget = 1
    }

    func conditionLe16(frame: inout Data) {
        guard frame.count >= 2 else { return }
        var speechSq = 0.0
        var speechN = 0
        var peakAbs = 0.0

        frame.withUnsafeMutableBytes { raw in
            guard let bytes = raw.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            // Use raw.count (the buffer-pointer's own length) rather than
            // frame.count — re-reading the inout `frame` inside this closure
            // is a second access while withUnsafeMutableBytes already holds
            // an exclusive one, which Swift rejects under -enforce-exclusivity=checked.
            let sampleCount = raw.count / 2
            for i in 0..<sampleCount {
                let off = i * 2
                let lo = UInt16(bytes[off])
                let hi = UInt16(bytes[off + 1])
                let sample = Double(Int16(bitPattern: lo | (hi << 8)))

                let filtered = lpf.process(hpf.process(sample))
                let level = abs(filtered)

                env += (level - env) * (level > env ? Self.envAttack : Self.envRelease)
                floor += (env - floor) * (env < floor ? Self.floorDown : Self.floorUp)
                floor = min(max(floor, Self.floorMin), Self.floorMax)

                let openThresh = max(Self.gateAbsMin, floor * Self.gateOpenRatio)
                let gateTarget: Double
                if env >= openThresh {
                    gateTarget = 1
                    speechSq += filtered * filtered
                    speechN += 1
                } else {
                    let r = env / openThresh
                    gateTarget = max(Self.gateFloorGain, r * r)
                }
                gateGain += (gateTarget - gateGain) * (gateTarget > gateGain ? Self.gateOpenCoef : Self.gateCloseCoef)
                agcGain += (agcTarget - agcGain) * Self.agcRamp
                if level > peakAbs { peakAbs = level }

                let limited = Self.softLimit(filtered * agcGain * gateGain)
                let out = Int16(clamping: Int(limited.rounded()))
                let le = UInt16(bitPattern: out)
                bytes[off] = UInt8(le & 0xff)
                bytes[off + 1] = UInt8((le >> 8) & 0xff)
            }
        }

        updateAgcTarget(speechSq: speechSq, speechN: speechN, peakAbs: peakAbs)
    }

    private func updateAgcTarget(speechSq: Double, speechN: Int, peakAbs: Double) {
        guard speechN >= Self.minSpeechSamples else { return }
        let rms = sqrt(speechSq / Double(speechN))
        var target = rms > 1 ? Self.targetRms / rms : Self.maxGain
        target = min(target, Self.maxGain)
        let peakLimit = peakAbs > 1 ? Self.peakCeil / peakAbs : Self.maxGain
        target = min(target, peakLimit)
        target = max(target, 1)
        if target < agcTarget {
            agcTarget = target
        } else {
            agcTarget += min(target - agcTarget, Self.agcUpFraction * agcTarget)
        }
    }

    private static func softLimit(_ sample: Double) -> Double {
        if sample > softKnee {
            let compressed = softKnee + (sample - softKnee) * 0.3
            return min(compressed, 32_760)
        }
        if sample < -softKnee {
            let compressed = -softKnee + (sample + softKnee) * 0.3
            return max(compressed, -32_760)
        }
        return sample
    }

    private final class Biquad {
        enum Kind { case highPass, lowPass }
        private let b0, b1, b2, a1, a2: Double
        private var z1 = 0.0
        private var z2 = 0.0

        init(kind: Kind, fc: Double, q: Double, fs: Double) {
            let w0 = 2 * Double.pi * fc / fs
            let cw = cos(w0)
            let sw = sin(w0)
            let alpha = sw / (2 * q)
            let nb0: Double
            let nb1: Double
            let nb2: Double
            switch kind {
            case .highPass:
                nb0 = (1 + cw) / 2
                nb1 = -(1 + cw)
                nb2 = (1 + cw) / 2
            case .lowPass:
                nb0 = (1 - cw) / 2
                nb1 = 1 - cw
                nb2 = (1 - cw) / 2
            }
            let a0 = 1 + alpha
            b0 = nb0 / a0
            b1 = nb1 / a0
            b2 = nb2 / a0
            a1 = (-2 * cw) / a0
            a2 = (1 - alpha) / a0
        }

        func process(_ x: Double) -> Double {
            let y = b0 * x + z1
            z1 = b1 * x - a1 * y + z2
            z2 = b2 * x - a2 * y
            return y
        }

        func reset() {
            z1 = 0
            z2 = 0
        }
    }

    private static let hpfHz = 180.0
    private static let lpfHz = 3400.0
    private static let filterQ = 0.707
    private static let envAttack = 0.03
    private static let envRelease = 0.0008
    private static let floorUp = 0.00006
    private static let floorDown = 0.001
    private static let floorMin = 60.0
    private static let floorMax = 5000.0
    private static let gateOpenRatio = 3.0
    private static let gateAbsMin = 180.0
    private static let gateFloorGain = 0.1
    private static let gateOpenCoef = 0.05
    private static let gateCloseCoef = 0.0015
    private static let targetRms = 6000.0
    private static let maxGain = 6.0
    private static let peakCeil = 30_000.0
    private static let agcRamp = 0.01
    private static let agcUpFraction = 0.1
    private static let minSpeechSamples = 32
    private static let softKnee = 27_800.0
}
