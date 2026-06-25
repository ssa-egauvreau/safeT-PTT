package com.securityradio.ptt.device

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Build

/**
 * Keeps the Bluetooth (A2DP) audio route awake while a Bluetooth output is
 * connected, so it never drops into sleep between sounds.
 *
 * The problem this solves: on a Bluetooth speaker/head unit the A2DP link
 * suspends after a moment of silence to save power. The next sound — the
 * channel-change beep, the spoken channel name (TTS), the PTT tone, or inbound
 * voice — then has to wake the link, and its first ~100–300 ms are swallowed
 * (you hear only the tail of the channel name, no beep, no PTT tone). Those
 * sounds each come from their own short-lived AudioTrack, so keeping the voice
 * playout track warm did nothing for them.
 *
 * This runs ONE always-on output that streams inaudible low-level dither
 * (~-72 dBFS) to the media route whenever Bluetooth is connected. Continuous
 * (non-silent) audio keeps the A2DP stack from ever suspending, so every other
 * sound starts instantly and clean. It records nothing and never touches the
 * microphone path, so it does not interfere with PTT transmit (the app captures
 * from the built-in mic, not Bluetooth SCO). Battery is a non-issue — the
 * target is a car-powered head unit.
 */
class BluetoothKeepAlive {

    private val lock = Any()
    private var track: AudioTrack? = null
    private var thread: Thread? = null

    @Volatile
    private var running = false

    /**
     * Wall-clock deadline (ms) up to which the loop streams the hotter wake burst
     * instead of the quiet idle dither. Set by [wakeBurst].
     */
    @Volatile
    private var burstUntilMs = 0L

    /** Turn the keep-alive on (Bluetooth connected) or off (disconnected). */
    fun setActive(active: Boolean) {
        synchronized(lock) {
            if (active) start() else stop()
        }
    }

    /** True while a Bluetooth output is connected and the keep-alive stream is running. */
    fun isActive(): Boolean = running

    /**
     * Marks the next ~[BURST_MS] ms to stream [BURST] instead of [FILL]. Currently both are silent
     * (see [BURST]) so this is effectively a no-op kept wired for a future tuned deep-sleep burst.
     * No-op when Bluetooth isn't connected.
     */
    fun wakeBurst() {
        if (!running) return
        burstUntilMs = System.currentTimeMillis() + BURST_MS
    }

    private fun start() {
        if (running) return
        val t = buildTrack() ?: return
        track = t
        running = true
        thread = Thread({ loop(t) }, "bt-keepalive").apply {
            isDaemon = true
            start()
        }
    }

    private fun stop() {
        running = false
        thread?.interrupt()
        thread = null
        track?.let { t ->
            runCatching { if (t.playState == AudioTrack.PLAYSTATE_PLAYING) t.stop() }
            runCatching { t.release() }
        }
        track = null
    }

    private fun loop(t: AudioTrack) {
        try {
            // MODE_STREAM write blocks until the track buffer has room, which paces
            // the loop at real time — no manual sleep needed.
            while (running) {
                val buf = if (System.currentTimeMillis() < burstUntilMs) BURST else FILL
                val n = t.write(buf, 0, buf.size)
                if (n < 0) break
            }
        } catch (_: Exception) {
            // Track died (route change / release); stop() will rebuild on next setActive.
        } finally {
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
        val bufBytes = maxOf(minBuf, FILL.size * 4)
        val t =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                AudioTrack.Builder()
                    .setAudioAttributes(
                        // Match the voice/UI sound route (media) so we keep the same
                        // A2DP stream warm that those sounds will use.
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
        // 8 kHz mono is plenty to hold the link open and keeps the stream light.
        const val SAMPLE_RATE_HZ = 8_000

        // Digital SILENCE (all zeros). Field testing on a sensitive head unit showed it
        // reproduced even -68 dBFS dither as audible static — meaning its amp never
        // actually sleeps, so the keep-alive doesn't need to emit any *signal*. Keeping
        // the AudioTrack in the PLAYING state (continuously streaming zeros) is what holds
        // the A2DP link warm on the common stacks; the link needs an active stream, not
        // noise. The anti-clipping work is carried by the inbound jitter cushion. Streaming
        // zeros stays inaudible while still keeping the track — and therefore the link —
        // active.
        val FILL = ByteArray(320) // zeros — silent keep-alive

        /** How long a [wakeBurst] streams [BURST] before falling back to [FILL]. */
        const val BURST_MS = 420L

        // The wake burst is SILENT (zeros), same as [FILL]. A non-zero "inaudible" burst was tried
        // to wake head units whose amp deep-sleeps, but field units reproduced it as an audible buzz
        // before every tone (PTT / volume / channel) — these amps are "always on", so they don't
        // need an energy nudge and the continuous silent keep-alive already holds the link. Kept as
        // a separate constant (and wakeBurst() wired) so a real deep-sleep head unit could re-enable
        // a tuned, low-level burst later WITHOUT it ever buzzing on always-on amps by default.
        val BURST = ByteArray(320) // zeros — silent (no audible wake buzz)
    }
}
