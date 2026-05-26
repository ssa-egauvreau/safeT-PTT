package com.securityradio.ptt.device

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Transmit-side conditioning for the P25 IMBE (vocoder) uplink.
 *
 * IMBE is an 8 kHz, ~5 kbps speech codec with no comfort-noise model: it spends
 * its bit budget encoding whatever the mic picks up, so steady room/handling
 * noise rides along with every transmission and quiet talkers stay quiet. This
 * stage runs on the 16 kHz mic frames *before* the 8 kHz downsample and:
 *   1. high-passes out low-frequency rumble / engine / handling thumps,
 *   2. band-limits to the speech band (also the anti-alias filter for 8 kHz),
 *   3. ducks background between words via an adaptive noise-floor expander,
 *   4. lifts the spoken voice toward a consistent level (makeup AGC).
 *
 * One instance per transmit stream; call [reset] at key-up so each talk-spurt
 * re-learns its own noise floor and opens from silence. Mirrors the web
 * console's imbeTxConditioner.ts so both clients sound alike.
 */
class ImbeTxConditioner {

    /** Transposed-direct-form-II biquad; RBJ-cookbook high/low-pass coefficients. */
    private class Biquad(kind: Kind, fc: Double, q: Double) {
        enum class Kind { HIGH_PASS, LOW_PASS }

        private val b0: Double
        private val b1: Double
        private val b2: Double
        private val a1: Double
        private val a2: Double
        private var z1 = 0.0
        private var z2 = 0.0

        init {
            val w0 = 2.0 * PI * fc / FS
            val cw = cos(w0)
            val sw = sin(w0)
            val alpha = sw / (2.0 * q)
            val nb0: Double
            val nb1: Double
            val nb2: Double
            if (kind == Kind.HIGH_PASS) {
                nb0 = (1.0 + cw) / 2.0
                nb1 = -(1.0 + cw)
                nb2 = (1.0 + cw) / 2.0
            } else {
                nb0 = (1.0 - cw) / 2.0
                nb1 = 1.0 - cw
                nb2 = (1.0 - cw) / 2.0
            }
            val a0 = 1.0 + alpha
            b0 = nb0 / a0
            b1 = nb1 / a0
            b2 = nb2 / a0
            a1 = (-2.0 * cw) / a0
            a2 = (1.0 - alpha) / a0
        }

        fun process(x: Double): Double {
            val y = b0 * x + z1
            z1 = b1 * x - a1 * y + z2
            z2 = b2 * x - a2 * y
            return y
        }

        fun reset() {
            z1 = 0.0
            z2 = 0.0
        }
    }

    private val hpf = Biquad(Biquad.Kind.HIGH_PASS, HPF_HZ, FILTER_Q)
    private val lpf = Biquad(Biquad.Kind.LOW_PASS, LPF_HZ, FILTER_Q)
    private var env = 0.0
    private var floor = FLOOR_MIN
    private var gateGain = 0.0 // start closed so pre-speech noise is squelched
    private var agcGain = 1.0
    private var agcTarget = 1.0

    /** Clears all adaptive state; call at key-up so each transmission starts fresh. */
    fun reset() {
        hpf.reset()
        lpf.reset()
        env = 0.0
        floor = FLOOR_MIN
        gateGain = 0.0
        agcGain = 1.0
        agcTarget = 1.0
    }

    /**
     * Conditions [len] bytes of 16 kHz mono PCM-16 little-endian in place.
     *
     * When [bypassExpanderAgc] is true, only the HPF (rumble cut) and LPF
     * (IMBE anti-alias) run, plus the soft limit. The expander/noise-gate and
     * makeup AGC are skipped — closest match to how a hardware P25 radio's mic
     * chain sounds (and to how our radio-bridge captures audio with browser
     * AGC/NS off).
     */
    fun conditionLe16(frame: ByteArray, len: Int, bypassExpanderAgc: Boolean = false) {
        if (bypassExpanderAgc) {
            var i = 0
            while (i + 1 < len) {
                val lo = frame[i].toInt() and 0xFF
                val hi = frame[i + 1].toInt()
                val sample = ((hi shl 8) or lo).toDouble()
                val out = softLimit(lpf.process(hpf.process(sample)))
                frame[i] = (out and 0xFF).toByte()
                frame[i + 1] = ((out shr 8) and 0xFF).toByte()
                i += 2
            }
            return
        }

        var speechSq = 0.0
        var speechN = 0
        var peakAbs = 0.0

        var i = 0
        while (i + 1 < len) {
            val lo = frame[i].toInt() and 0xFF
            val hi = frame[i + 1].toInt() // signed sign-extend
            val sample = ((hi shl 8) or lo).toDouble()

            val filtered = lpf.process(hpf.process(sample))
            val level = abs(filtered)

            env += (level - env) * (if (level > env) ENV_ATTACK else ENV_RELEASE)
            floor += (env - floor) * (if (env < floor) FLOOR_DOWN else FLOOR_UP)
            if (floor < FLOOR_MIN) {
                floor = FLOOR_MIN
            } else if (floor > FLOOR_MAX) {
                floor = FLOOR_MAX
            }

            val openThresh = max(GATE_ABS_MIN, floor * GATE_OPEN_RATIO)
            val gateTarget: Double
            if (env >= openThresh) {
                gateTarget = 1.0
                speechSq += filtered * filtered
                speechN++
            } else {
                val r = env / openThresh
                gateTarget = max(GATE_FLOOR_GAIN, r * r)
            }
            gateGain += (gateTarget - gateGain) *
                (if (gateTarget > gateGain) GATE_OPEN_COEF else GATE_CLOSE_COEF)

            agcGain += (agcTarget - agcGain) * AGC_RAMP

            if (level > peakAbs) {
                peakAbs = level
            }
            val out = softLimit(filtered * agcGain * gateGain)
            frame[i] = (out and 0xFF).toByte()
            frame[i + 1] = ((out shr 8) and 0xFF).toByte()
            i += 2
        }

        updateAgcTarget(speechSq, speechN, peakAbs)
    }

    private fun updateAgcTarget(speechSq: Double, speechN: Int, peakAbs: Double) {
        if (speechN < MIN_SPEECH_SAMPLES) {
            return // no speech this frame — hold gain steady
        }
        val rms = sqrt(speechSq / speechN)
        var target = if (rms > 1.0) TARGET_RMS / rms else MAX_GAIN
        if (target > MAX_GAIN) {
            target = MAX_GAIN
        }
        // Never let makeup gain push the loudest sample past the soft-limit knee.
        val peakLimit = if (peakAbs > 1.0) PEAK_CEIL / peakAbs else MAX_GAIN
        if (target > peakLimit) {
            target = peakLimit
        }
        if (target < 1.0) {
            target = 1.0
        }
        agcTarget = if (target < agcTarget) {
            target // drop instantly to stay clear of clipping
        } else {
            agcTarget + min(target - agcTarget, AGC_UP_FRACTION * agcTarget)
        }
    }

    private fun softLimit(sample: Double): Int {
        val s = when {
            sample > SOFT_KNEE -> {
                val compressed = SOFT_KNEE + (sample - SOFT_KNEE) * 0.3
                if (compressed > 32760.0) 32760.0 else compressed
            }
            sample < -SOFT_KNEE -> {
                val compressed = -SOFT_KNEE + (sample + SOFT_KNEE) * 0.3
                if (compressed < -32760.0) -32760.0 else compressed
            }
            else -> sample
        }
        return s.toInt()
    }

    private companion object {
        const val FS = 16000.0

        // Speech-band shaping. 180 Hz high-pass kills HVAC/engine rumble and
        // handling thumps; 3.4 kHz low-pass is both the telephone-band edge and
        // the anti-alias filter for the downstream 8 kHz IMBE rate.
        const val HPF_HZ = 180.0
        const val LPF_HZ = 3400.0
        const val FILTER_Q = 0.707

        // Envelope follower (instantaneous level), in int16 sample units.
        const val ENV_ATTACK = 0.03 // ~2 ms — react to onsets fast
        const val ENV_RELEASE = 0.0008 // ~80 ms — smooth decay so word tails survive

        // Adaptive noise-floor tracker: rises slowly toward steady noise, falls
        // quicker so it re-locks after a loud passage without chasing speech.
        const val FLOOR_UP = 0.00006
        const val FLOOR_DOWN = 0.001
        const val FLOOR_MIN = 60.0
        const val FLOOR_MAX = 5000.0

        // Noise gate / downward expander. Speech is "present" once the envelope
        // sits a few dB above the noise floor; below that the signal is squelched
        // toward GATE_FLOOR_GAIN (a soft -20 dB, not a hard mute, to avoid pumping).
        const val GATE_OPEN_RATIO = 3.0
        const val GATE_ABS_MIN = 180.0
        const val GATE_FLOOR_GAIN = 0.1
        const val GATE_OPEN_COEF = 0.05 // fast open (~1-2 ms)
        const val GATE_CLOSE_COEF = 0.0015 // slow close (~40 ms)

        // Makeup AGC: pull the speech RMS toward a target without exceeding a
        // peak that would clip after gain. Adapts gently up, instantly down.
        const val TARGET_RMS = 6000.0
        const val MAX_GAIN = 6.0
        const val PEAK_CEIL = 30000.0
        const val AGC_RAMP = 0.01 // per-sample glide of applied gain toward target
        const val AGC_UP_FRACTION = 0.1 // per-frame cap on upward target movement
        const val MIN_SPEECH_SAMPLES = 32

        const val SOFT_KNEE = 27800.0 // ~0.85 full-scale; soft-limit excess above this
    }
}
