package com.securityradio.ptt.device

import com.securityradio.ptt.BuildConfig
import com.securityradio.ptt.data.remote.normalizeApiBaseUrl
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.Locale
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Per-window inbound voice-link counters reported every ~30 s.
 *
 * Mirrors the iOS / web reporters so all three clients post the same payload
 * schema to `POST /v1/telemetry/voice-link`. Counters only — no audio, no
 * transcript, no PCM. The dashboard reads aggregates back so dispatch can
 * answer "is this unit having voice quality problems?" with data instead of
 * trusting an end-user report.
 *
 * Lifecycle:
 *   - [start] arms a background coroutine that rolls the in-progress window
 *     into a queued snapshot every 30 s and POSTs the head.
 *   - [stop] cancels the loop. Counters carry across `stop()` / `start()`
 *     into the next window — no data lost across an app pause.
 *
 * Buffering:
 *   - Up to [MAX_BUFFERED_WINDOWS] (~2 minutes) of unsent windows in memory.
 *   - On a failed POST the head is left at the front of the queue and the
 *     next 30-second tick retries it. When the cap is exceeded the OLDEST
 *     queued window is dropped, not the newest — operators care about
 *     recent data first.
 *   - Idle windows (zero counters) are sent too so the dashboard can tell
 *     "this unit is alive but quiet" apart from "this unit fell off the air".
 *
 * Thread safety: counters are mutated from the WebSocket dispatch thread
 * (`VoiceRelayTransport.dispatchInboundVoice`) and from the jitter buffer
 * playout thread (`InboundJitterBuffer.playoutLoop`). All accesses go
 * through the synchronized counter helpers below; the snapshot path
 * captures the in-flight values under the same lock.
 */
object VoiceLinkTelemetryReporter {

    private const val TELEMETRY_INTERVAL_MS = 30_000L
    private const val MAX_BUFFERED_WINDOWS = 4
    private const val CLIENT_TYPE = "android"

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val running = AtomicBoolean(false)
    private var loopJob: Job? = null

    private val lock = ReentrantLock()
    /** In-progress window. Rolled into [queued] on every tick. */
    private var window: WindowCounters = WindowCounters(System.currentTimeMillis())
    private val queued = ArrayDeque<QueuedWindow>()
    private val inFlight = AtomicBoolean(false)

    @Volatile
    private var baseUrl: String? = null
    @Volatile
    private var apiKeyProvider: (() -> String) = { "" }
    @Volatile
    private var authTokenProvider: (() -> String) = { "" }
    @Volatile
    private var unitId: String? = null
    @Volatile
    private var channel: String? = null

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

    /**
     * Configures the POST destination + auth. Safe to call repeatedly; only
     * the latest values are used on the next POST.
     */
    fun configure(
        httpBaseUrl: String,
        authTokenProvider: () -> String,
        apiKeyProvider: () -> String,
    ) {
        this.baseUrl = normalizeApiBaseUrl(httpBaseUrl).trimEnd('/')
        this.authTokenProvider = authTokenProvider
        this.apiKeyProvider = apiKeyProvider
    }

    /**
     * Sets which unit/channel future reports are billed to. Calling with a
     * new identity closes the current window under the previous identity so
     * counters that were accumulated while on the prior channel are not
     * credited to the new one.
     */
    fun setIdentity(unitId: String?, channel: String?) {
        lock.withLock {
            val identityChanged = this.unitId != unitId || this.channel != channel
            if (identityChanged && this.unitId != null) {
                closeAndQueueWindowLocked()
            }
            this.unitId = unitId
            this.channel = channel
        }
    }

    fun start() {
        if (!running.compareAndSet(false, true)) return
        loopJob = scope.launch {
            while (running.get()) {
                delay(TELEMETRY_INTERVAL_MS)
                tick()
            }
        }
    }

    fun stop() {
        if (!running.compareAndSet(true, false)) return
        loopJob?.cancel()
        loopJob = null
    }

    // --- counter recording (call sites in VoiceRelayTransport / Inbound) --

    fun recordFrameReceived(codec: String, bytes: Int) {
        lock.withLock {
            window.framesReceived += 1
            window.bytesReceived += bytes.coerceAtLeast(0)
            val entry = window.codecBreakdown.getOrPut(codec) { CodecCounters() }
            entry.framesReceived += 1
        }
    }

    /**
     * Uplink accounting — every app-level byte this handset puts on the voice
     * socket (vocoded frames, clear PCM, recorder sideband) so the admin
     * data-usage column reflects both directions.
     */
    fun recordBytesSent(bytes: Int) {
        lock.withLock {
            window.bytesSent += bytes.coerceAtLeast(0)
        }
    }

    fun recordFrameDecoded(codec: String) {
        lock.withLock {
            window.framesDecoded += 1
            val entry = window.codecBreakdown.getOrPut(codec) { CodecCounters() }
            entry.framesDecoded += 1
        }
    }

    fun recordDecodeFailure() {
        lock.withLock {
            window.decodeFailures += 1
        }
    }

    fun recordPlcSynthesized() {
        lock.withLock {
            window.plcFramesSynthesized += 1
        }
    }

    fun recordBufferUnderrun() {
        lock.withLock {
            window.bufferUnderruns += 1
        }
    }

    fun recordBufferDepth(frames: Int) {
        lock.withLock {
            if (frames > window.maxBufferDepthFrames) {
                window.maxBufferDepthFrames = frames
            }
        }
    }

    fun recordTalkSpurtStart() {
        lock.withLock {
            window.talkSpurtsStarted += 1
        }
    }

    fun recordTalkSpurtEnd() {
        lock.withLock {
            window.talkSpurtsEnded += 1
        }
    }

    // --- internal --------------------------------------------------------

    private fun tick() {
        val identity = lock.withLock {
            val u = unitId ?: return
            // Identity captured under the lock so the queue read below sees
            // a consistent (unit, channel) for the just-closed window.
            closeAndQueueWindowLocked()
            u
        }
        if (identity.isBlank()) return
        flush()
    }

    private fun closeAndQueueWindowLocked() {
        val closedAt = System.currentTimeMillis()
        val u = unitId ?: return
        queued.addLast(
            QueuedWindow(
                unitId = u,
                channel = channel,
                counters = window,
                closedAtMs = closedAt,
            ),
        )
        window = WindowCounters(closedAt)
        // Pre-cap so a long offline period doesn't unbounded-grow memory.
        while (queued.size > MAX_BUFFERED_WINDOWS) {
            queued.removeFirst()
        }
    }

    private fun flush() {
        if (!inFlight.compareAndSet(false, true)) return
        try {
            val url = baseUrl ?: return
            val endpoint = "$url/v1/telemetry/voice-link"
            while (true) {
                val head = lock.withLock { queued.firstOrNull() } ?: break
                val ok = postWindow(endpoint, head)
                if (!ok) break
                lock.withLock {
                    // Defend against a concurrent identity change that already
                    // shifted the queue while the POST was inflight.
                    if (queued.isNotEmpty() && queued.first() === head) {
                        queued.removeFirst()
                    }
                }
            }
        } finally {
            inFlight.set(false)
        }
    }

    private fun postWindow(endpoint: String, w: QueuedWindow): Boolean {
        val bodyJson = buildReportBody(w)
        val requestBuilder = Request.Builder()
            .url(endpoint)
            .post(bodyJson.toRequestBody("application/json".toMediaType()))
        val token = authTokenProvider().trim()
        val key = apiKeyProvider().trim()
        if (token.isNotEmpty()) {
            requestBuilder.header("Authorization", "Bearer $token")
        } else if (key.isNotEmpty()) {
            requestBuilder.header("X-Radio-Key", key)
        }
        return try {
            httpClient.newCall(requestBuilder.build()).execute().use { response ->
                // 2xx + 202 (DB-less soft-accept) both drain the queue; only
                // 5xx / network errors retain the head for retry. 4xx other
                // than 429 means the client is permanently misshapen — drop
                // the head so we don't burn retries on a bad payload.
                when {
                    response.isSuccessful -> true
                    response.code == 429 -> false
                    response.code in 400..499 -> true
                    else -> false
                }
            }
        } catch (_: Exception) {
            false
        }
    }

    /** Visible for tests / debug logging. Pure builder of the JSON wire body. */
    internal fun buildReportBody(w: QueuedWindow): String {
        val obj = JSONObject()
        obj.put("unitId", w.unitId)
        if (w.channel != null) obj.put("channel", w.channel)
        obj.put("clientType", CLIENT_TYPE)
        // App version rides along so safeT Control can show each unit's build and
        // flag out-of-date radios (drives the fleet OTA view).
        obj.put("appVersionName", BuildConfig.VERSION_NAME)
        obj.put("appVersionCode", BuildConfig.VERSION_CODE)
        val counters = JSONObject()
        counters.put("framesReceived", w.counters.framesReceived)
        counters.put("framesDecoded", w.counters.framesDecoded)
        counters.put("decodeFailures", w.counters.decodeFailures)
        counters.put("plcFramesSynthesized", w.counters.plcFramesSynthesized)
        counters.put("bufferUnderruns", w.counters.bufferUnderruns)
        counters.put("maxBufferDepthFrames", w.counters.maxBufferDepthFrames)
        counters.put("talkSpurtsStarted", w.counters.talkSpurtsStarted)
        counters.put("talkSpurtsEnded", w.counters.talkSpurtsEnded)
        counters.put("bytesReceived", w.counters.bytesReceived)
        counters.put("bytesSent", w.counters.bytesSent)
        counters.put("wallMsObservation", (w.closedAtMs - w.counters.windowOpenedAtMs).coerceAtLeast(0))
        obj.put("counters", counters)
        val codecBreakdown = JSONObject()
        for ((codec, c) in w.counters.codecBreakdown) {
            val entry = JSONObject()
            entry.put("framesReceived", c.framesReceived)
            entry.put("framesDecoded", c.framesDecoded)
            codecBreakdown.put(codec, entry)
        }
        obj.put("codecBreakdown", codecBreakdown)
        obj.put("clientTs", java.text.SimpleDateFormat(
            "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
            Locale.US,
        ).apply {
            timeZone = java.util.TimeZone.getTimeZone("UTC")
        }.format(java.util.Date(w.closedAtMs)))
        return obj.toString()
    }

    // Visible for tests
    internal data class CodecCounters(
        var framesReceived: Int = 0,
        var framesDecoded: Int = 0,
    )

    // Visible for tests
    internal class WindowCounters(val windowOpenedAtMs: Long) {
        var framesReceived: Int = 0
        var framesDecoded: Int = 0
        var decodeFailures: Int = 0
        var plcFramesSynthesized: Int = 0
        var bufferUnderruns: Int = 0
        var maxBufferDepthFrames: Int = 0
        var talkSpurtsStarted: Int = 0
        var talkSpurtsEnded: Int = 0
        var bytesReceived: Int = 0
        var bytesSent: Int = 0
        val codecBreakdown: MutableMap<String, CodecCounters> = LinkedHashMap()
    }

    // Visible for tests
    internal data class QueuedWindow(
        val unitId: String,
        val channel: String?,
        val counters: WindowCounters,
        val closedAtMs: Long,
    )

    // Visible for tests: snapshot for assertions.
    internal fun queuedSizeForTest(): Int = lock.withLock { queued.size }
    internal fun currentWindowFramesReceivedForTest(): Int = lock.withLock { window.framesReceived }
    internal fun resetForTest() {
        lock.withLock {
            queued.clear()
            window = WindowCounters(System.currentTimeMillis())
            unitId = null
            channel = null
        }
    }

}
