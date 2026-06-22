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

    /** Turn the keep-alive on (Bluetooth connected) or off (disconnected). */
    fun setActive(active: Boolean) {
        synchronized(lock) {
            if (active) start() else stop()
        }
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
                val n = t.write(FILL, 0, FILL.size)
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

        // 20 ms of inaudible low-level dither (±12 LSB ≈ -68 dBFS). Non-zero so the
        // A2DP stack never sees digital silence and suspends; still well below the
        // audible floor. Pitched a bit hotter than a token ±4 LSB because some
        // head-unit power management still suspends on near-silence, which is what
        // leaves the first syllable of the next sound clipped on key-up.
        val FILL = ByteArray(320).also { buf ->
            var seed = 0x9E3779B9.toInt()
            var i = 0
            while (i + 1 < buf.size) {
                seed = seed * 1103515245 + 12345
                val v = ((seed ushr 16) % 25) - 12 // [-12, 12]
                buf[i] = (v and 0xFF).toByte()
                buf[i + 1] = ((v shr 8) and 0xFF).toByte()
                i += 2
            }
        }
    }
}
