package com.securityradio.ptt.device

import android.os.SystemClock

/**
 * Store-and-forward queue for scan-channel audio.
 *
 * A traditional scanner drops whatever it can't play right now; this instead
 * holds it. Only ONE scan transmission is audible at a time — when another scan
 * channel keys up while one is playing, its audio is buffered as a separate
 * transmission and played, in full and in arrival order, after the current one
 * finishes. The home channel still wins: forwarding pauses while it's receiving
 * (in mono mode) and resumes where it left off.
 *
 * A single pacer thread drains the active transmission at real time (one decoded
 * frame per its own duration), so the downstream [InboundJitterBuffer] is fed at
 * the same rate it consumes and never overflows its cap and drops a backlog.
 *
 * Thread-safety: [submit] is called from the per-channel scan WebSocket threads;
 * [playChunk] is invoked on the private pacer thread. All queue state is guarded
 * by [lock].
 */
class ScanForwardQueue(
    /** elapsedRealtime ms until which the home channel holds the floor (0 = never). */
    private val homeHoldUntilProvider: () -> Long,
    /** Plays one decoded PCM16 frame now (gain + enqueue to the jitter buffer). */
    private val playChunk: (channel: String, chunk: ByteArray) -> Unit,
    /** Fired with the channel currently being forwarded (drives the scan banner). */
    private val onForwarding: (channel: String) -> Unit,
) {
    private class Transmission(val channel: String) {
        val chunks = ArrayDeque<ByteArray>()
        var lastAppendMs = SystemClock.elapsedRealtime()
    }

    private val lock = Any()
    /** Queued transmissions not yet started, in arrival order. */
    private val pending = ArrayDeque<Transmission>()
    /** The transmission currently being forwarded, or null between transmissions. */
    private var current: Transmission? = null

    @Volatile private var released = false
    private var thread: Thread? = null

    /** Buffer a scan frame for its channel. Never blocks the WebSocket thread. */
    fun submit(channelName: String, chunk: ByteArray) {
        if (released) return
        val ch = channelName.trim()
        if (ch.isEmpty() || chunk.isEmpty()) return
        synchronized(lock) {
            startThreadLocked()
            val now = SystemClock.elapsedRealtime()
            val cur = current
            if (cur != null && cur.channel.equals(ch, ignoreCase = true)) {
                // Live continuation of the transmission already playing.
                cur.chunks.addLast(chunk)
                cur.lastAppendMs = now
                trimTransmissionLocked(cur)
                return
            }
            // Append to this channel's in-progress pending transmission, or start a
            // new one when there is none or the previous one has gone quiet (a gap
            // ends a transmission and the next keying is a separate one).
            var t = pending.lastOrNull { it.channel.equals(ch, ignoreCase = true) }
            if (t == null || now - t.lastAppendMs > TALK_SPURT_GAP_MS) {
                t = Transmission(ch)
                pending.addLast(t)
                trimQueueLocked()
            }
            t.chunks.addLast(chunk)
            t.lastAppendMs = now
            trimTransmissionLocked(t)
        }
    }

    private fun startThreadLocked() {
        if (thread != null || released) return
        val t = Thread({ pump() }, "scan-forward-pacer")
        t.isDaemon = true
        thread = t
        t.start()
    }

    /** Drop the oldest pending transmissions when the backlog gets too deep. */
    private fun trimQueueLocked() {
        while (pending.size > MAX_PENDING) {
            pending.removeFirst()
        }
    }

    /** Cap a single transmission so one stuck channel can't grow without bound. */
    private fun trimTransmissionLocked(t: Transmission) {
        while (t.chunks.size > MAX_CHUNKS_PER_TX) {
            t.chunks.removeFirst()
        }
    }

    private fun pump() {
        var nextDeadline = SystemClock.elapsedRealtime()
        while (!released && !Thread.currentThread().isInterrupted) {
            val sleep = nextDeadline - SystemClock.elapsedRealtime()
            if (sleep > 0) {
                try {
                    Thread.sleep(sleep)
                } catch (_: InterruptedException) {
                    return
                }
            }

            var play: Pair<String, ByteArray>? = null
            var advanceMs = FRAME_MS
            synchronized(lock) {
                val now = SystemClock.elapsedRealtime()
                // Home channel priority (mono mode): hold scan until it's done.
                if (now < homeHoldUntilProvider()) {
                    return@synchronized
                }
                var cur = current
                if (cur == null) {
                    cur = pending.removeFirstOrNull()
                    current = cur
                }
                val active = cur ?: return@synchronized
                val chunk = active.chunks.removeFirstOrNull()
                if (chunk == null) {
                    // Out of buffered audio. If the channel has gone quiet past the
                    // talk-spurt gap the transmission is finished — advance to the
                    // next queued one; otherwise wait for more frames.
                    if (now - active.lastAppendMs > TALK_SPURT_GAP_MS) {
                        current = null
                    }
                    return@synchronized
                }
                play = active.channel to chunk
                // Pace by the frame's real duration so variable frame sizes still
                // play out at the right rate and the jitter buffer isn't flooded.
                advanceMs = (chunk.size.toLong() / 2L) / SAMPLES_PER_MS
            }

            nextDeadline += if (advanceMs > 0) advanceMs else FRAME_MS
            val p = play
            if (p != null) {
                onForwarding(p.first)
                playChunk(p.first, p.second)
            }
        }
    }

    fun stop() {
        synchronized(lock) {
            pending.clear()
            current = null
        }
    }

    fun release() {
        released = true
        thread?.interrupt()
        thread = null
        stop()
    }

    private companion object {
        /** 16 kHz mono PCM16 → 16 samples per millisecond. */
        const val SAMPLES_PER_MS = 16L
        const val FRAME_MS = 20L
        /** A > 300 ms gap ends a transmission (matches the jitter buffer / relay). */
        const val TALK_SPURT_GAP_MS = 300L
        /** Backlog cap — drop the oldest queued transmissions beyond this. */
        const val MAX_PENDING = 6
        /** Per-transmission cap (~30 s of 20 ms frames) so one channel can't grow unbounded. */
        const val MAX_CHUNKS_PER_TX = 1_500
    }
}
