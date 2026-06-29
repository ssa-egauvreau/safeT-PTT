package com.securityradio.ptt.device

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Build

/**
 * On-demand Bluetooth (A2DP) route waker.
 *
 * The problem this solves: on a Bluetooth speaker/head unit the A2DP link
 * suspends after a moment of silence to save power. The next sound — the
 * channel-change beep, the spoken channel name (TTS), the PTT/talk-permit tone,
 * or inbound voice — then has to wake the link, and its first ~100–300 ms are
 * swallowed (you hear only the tail of the channel name, no beep, no PTT tone).
 * Those sounds each come from their own short-lived AudioTrack, so keeping the
 * voice playout track warm did nothing for them.
 *
 * Previously this streamed continuous (silent) dither to hold the link warm
 * forever. That was abandoned: holding the route powered the whole time left the
 * **silent** channel of a stereo split (e.g. the home/left ear while only scan
 * plays on the right) reproducing the head-unit amp's noise floor as a constant
 * static buzz — and on some units the silent stream still failed to keep the
 * PTT tone from clipping anyway. So the route is now allowed to sleep when idle
 * (no idle buzz), and we instead fire a short **wake burst** right before a
 * sound so the amp is up by the time it plays.
 *
 * [wakeBurst] streams a brief, low-level (target-inaudible) energy burst — not
 * pure digital zeros: a slept amp on this device class needs an actual signal to
 * resume, and zeros were observed to leave the tone clipped. The burst is gated
 * by the callers to fire ONLY when the route is likely cold (no recent UI sound
 * AND no inbound voice traffic) so it never plays while audio is already flowing.
 * It records nothing and never touches the microphone path, so it does not
 * interfere with PTT transmit (the app captures from the built-in mic, not
 * Bluetooth SCO).
 */
class BluetoothKeepAlive {

    private val lock = Any()
    private var track: AudioTrack? = null
    private var thread: Thread? = null

    /** True while a Bluetooth output is connected (set by [setActive]). */
    @Volatile
    private var connected = false

    /**
     * Wall-clock deadline (ms) up to which the burst loop keeps streaming before it
     * stops the track and lets the route sleep again. Extended by [wakeBurst].
     */
    @Volatile
    private var burstUntilMs = 0L

    /** Record whether a Bluetooth output is connected. Stops any in-flight burst on disconnect. */
    fun setActive(active: Boolean) {
        synchronized(lock) {
            connected = active
            if (!active) stopBurst()
        }
    }

    /** True while a Bluetooth output is connected — gates whether a wake burst is needed at all. */
    fun isActive(): Boolean = connected

    /**
     * Spin the A2DP route up with a short (~[BURST_MS] ms) low-level burst so a head unit whose
     * amp sleeps on silence is awake by the time the next tone plays. The route is allowed to
     * sleep again once the burst window passes — we no longer hold it warm continuously. No-op
     * when no Bluetooth output is connected.
     */
    fun wakeBurst() {
        synchronized(lock) {
            if (!connected) return
            burstUntilMs = System.currentTimeMillis() + BURST_MS
            if (thread == null) startBurstLoop()
        }
    }

    /** Caller holds [lock]. */
    private fun startBurstLoop() {
        val t = buildTrack() ?: return
        track = t
        thread = Thread({ burstLoop(t) }, "bt-wake-burst").apply {
            isDaemon = true
            start()
        }
    }

    /** Caller holds [lock]. */
    private fun stopBurst() {
        burstUntilMs = 0L
        thread?.interrupt()
        thread = null
        track?.let { t ->
            runCatching { if (t.playState == AudioTrack.PLAYSTATE_PLAYING) t.stop() }
            runCatching { t.release() }
        }
        track = null
    }

    private fun burstLoop(t: AudioTrack) {
        try {
            // MODE_STREAM write blocks until the track buffer has room, which paces the loop at
            // real time — one BURST buffer is ~20 ms, so the deadline is honoured within a frame.
            while (true) {
                if (System.currentTimeMillis() >= burstUntilMs) {
                    synchronized(lock) {
                        // Re-check under the lock: a wakeBurst() may have just extended the window.
                        if (System.currentTimeMillis() >= burstUntilMs && track === t) {
                            track = null
                            thread = null
                            return
                        }
                    }
                }
                val n = t.write(BURST, 0, BURST.size)
                if (n < 0) break
            }
        } catch (_: Exception) {
            // Track died (route change / release); the next wakeBurst rebuilds it.
        } finally {
            synchronized(lock) {
                if (track === t) {
                    track = null
                    thread = null
                }
            }
            runCatching { if (t.playState == AudioTrack.PLAYSTATE_PLAYING) t.stop() }
            runCatching { t.release() }
        }
    }

    private fun buildTrack(): AudioTrack? {
        val minBuf = AudioTrack.getMinBufferSize(
            SAMPLE_RATE_HZ,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minBuf <= 0) return null
        val bufBytes = maxOf(minBuf, BURST.size * 4)
        val t =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                AudioTrack.Builder()
                    .setAudioAttributes(
                        // Match the voice/UI sound route (media) so we wake the same A2DP
                        // stream those sounds will use.
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                            .build(),
                    )
                    .setAudioFormat(
                        AudioFormat.Builder()
                            .setSampleRate(SAMPLE_RATE_HZ)
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                            .build(),
                    )
                    .setBufferSizeInBytes(bufBytes)
                    .setTransferMode(AudioTrack.MODE_STREAM)
                    .build()
            } else {
                @Suppress("DEPRECATION")
                AudioTrack(
                    3, // STREAM_MUSIC
                    SAMPLE_RATE_HZ,
                    AudioFormat.CHANNEL_OUT_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    bufBytes,
                    AudioTrack.MODE_STREAM,
                )
            }
        if (t.state != AudioTrack.STATE_INITIALIZED) {
            t.release()
            return null
        }
        t.play()
        return t
    }

    private companion object {
        // 8 kHz mono is plenty to wake the link and keeps the stream light.
        const val SAMPLE_RATE_HZ = 8_000

        /** How long a [wakeBurst] keeps streaming before it stops and lets the route sleep again.
         *  Must comfortably cover the caller's pre-sound lead plus the head unit's resume latency,
         *  so the route is still up when the (held) tone finally starts and takes over. */
        const val BURST_MS = 350L

        /**
         * Peak sample amplitude of the wake burst (16-bit scale, max 32767). Low enough to aim for
         * inaudible, high enough to register as real signal on an amp that ignores digital silence.
         * Pure zeros were tried and left the PTT tone clipped on a sleeping head unit, so the burst
         * carries a little energy. If it's audible as a faint hiss on a given unit, lower this; if
         * the tone still clips, raise it. ~96/32767 ≈ -50 dBFS.
         */
        const val WAKE_BURST_AMPLITUDE = 96

        // 20 ms of flat low-level noise at 8 kHz mono PCM16 = 160 samples = 320 bytes. Looped by the
        // burst thread for the whole burst window. Broadband noise wakes amps more reliably than a
        // pure tone; a deterministic LCG keeps it reproducible (no Math.random at runtime). No
        // edge fade: at ~-50 dBFS the start/stop step is inaudible, and fading a looped buffer would
        // only impose a ~50 Hz amplitude modulation.
        val BURST: ByteArray = buildBurstBuffer()

        private fun buildBurstBuffer(): ByteArray {
            val samples = 160
            val out = ByteArray(samples * 2)
            var rng = 0x2545F491L // arbitrary non-zero LCG seed
            for (i in 0 until samples) {
                rng = (rng * 6364136223846793005L + 1442695040888963407L)
                // Top bit of the LCG state as a balanced ±1 sign; magnitude held at the amplitude.
                val sign = if ((rng ushr 63) == 0L) 1 else -1
                val v = sign * WAKE_BURST_AMPLITUDE
                out[i * 2] = (v and 0xFF).toByte()
                out[i * 2 + 1] = ((v shr 8) and 0xFF).toByte()
            }
            return out
        }
    }
}
