package com.securityradio.ptt.device

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Extra listen-only voice sockets for scan channels while the main [VoiceRelayTransport]
 * stays on the tuned (home) channel. RX PCM is mixed into the same [InboundVoicePlayer].
 */
class ScanVoiceListenTransport(
    httpApiBaseUrl: String,
    private val authTokenProvider: () -> String,
    private val apiKeyProvider: () -> String,
    private val inbound: InboundVoicePlayer,
    /** When non-null, decoded scan-channel IMBE runs through the agency
     *  post-decode chain (same as the primary RX). Null = legacy fast path. */
    private val postDecodeProcessorProvider: () -> PostDecodeChain.Processor? = { null },
) {
    /** Per-scan-channel boundary state for the post-decode chain reset.
     *  Each tuned-in scan channel has its own talker; resetting per-channel
     *  on a talk-spurt boundary keeps biquad ring isolated from other
     *  channels' transmissions. Keyed by channel label. */
    private val scanLastInboundNs = java.util.concurrent.ConcurrentHashMap<String, Long>()
    private val scanTalkSpurtGapNs = 300_000_000L

    /**
     * Apply the agency post-decode chain to a scan-channel IMBE frame, or
     * fall back to the legacy duplicate upsample when no shaping is set.
     *
     * Each scan channel has independent talk-spurt boundary detection — a
     * gap > [scanTalkSpurtGapNs] between frames on the same channel resets
     * the processor's filter state for that channel so a previous talker's
     * biquad ring stays out of the next talker's first frame.
     *
     * NB: all scan channels share one processor instance. That's
     * intentional — a single tuned admin preset is one filter response,
     * and the per-channel timestamp keys are only used to decide WHEN to
     * call `processor.reset()`, not WHICH processor to use.
     */
    private fun applyPostDecodeOrDup(channelLabel: String, pcm8k160: ShortArray): ByteArray {
        val processor = postDecodeProcessorProvider()
            ?: return P25ImbeNative.Frames.upsampleDup8kToLe16Mono(pcm8k160)
        val now = System.nanoTime()
        val prev = scanLastInboundNs.put(channelLabel, now) ?: 0L
        if (prev == 0L || now - prev > scanTalkSpurtGapNs) {
            processor.reset()
        }
        return processor.process(pcm8k160)
    }
    private val wsBaseUrl = httpApiBaseUrlToVoiceWebSocketUrl(httpApiBaseUrl)

    private val client = OkHttpClient.Builder()
        .pingInterval(25L, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private val reconnectExecutor: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "scan-voice-reconnect").apply { isDaemon = true }
        }

    private val imbeWsMagic = byteArrayOf(0xF5.toByte(), 0xAB.toByte())

    /** Lowercase channel label → live socket. */
    private val channels = ConcurrentHashMap<String, ScanChannelConnection>()

    @Volatile
    private var pendingUnitId: String = ""

    @Volatile
    private var wantListen: Boolean = false

    fun updateScanListen(
        unitIdUpper: String,
        homeChannel: String,
        scanChannels: Set<String>,
        networkOnline: Boolean,
        scanActive: Boolean,
    ) {
        pendingUnitId = unitIdUpper.trim().uppercase(Locale.US)
        val home = homeChannel.trim()
        wantListen = networkOnline && scanActive && pendingUnitId.isNotEmpty()
        val desiredByKey: Map<String, String> = if (wantListen) {
            scanChannels
                .map { it.trim() }
                .filter { ch ->
                    ch.isNotEmpty() &&
                        ch != "----" &&
                        !ch.equals(home, ignoreCase = true)
                }
                .associateBy { it.lowercase(Locale.US) }
        } else {
            emptyMap()
        }

        val stale = channels.keys.filter { it !in desiredByKey.keys }
        for (key in stale) {
            channels.remove(key)?.close()
        }
        if (!wantListen) {
            for ((_, conn) in channels) {
                conn.close()
            }
            channels.clear()
            return
        }
        for ((key, label) in desiredByKey) {
            channels.computeIfAbsent(key) {
                ScanChannelConnection(channelLabel = label)
            }?.ensureConnected()
        }
    }

    fun disconnect() {
        wantListen = false
        for ((_, conn) in channels) {
            conn.close()
        }
        channels.clear()
    }

    fun shutdown() {
        disconnect()
        reconnectExecutor.shutdownNow()
    }

    private inner class ScanChannelConnection(
        private val channelLabel: String,
    ) {
        private val channelKey = channelLabel.lowercase(Locale.US)
        private val socketReady = AtomicBoolean(false)
        private val reconnectAttempt = AtomicInteger(0)
        private val reconnectPending = AtomicBoolean(false)
        @Volatile
        private var webSocket: WebSocket? = null

        private val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                socketReady.set(true)
                reconnectAttempt.set(0)
                sendJoin(webSocket)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                dispatchInboundVoice(bytes.toByteArray())
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                socketReady.set(false)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                socketReady.set(false)
                if (this@ScanChannelConnection.webSocket === webSocket) {
                    this@ScanChannelConnection.webSocket = null
                }
                scheduleReconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                socketReady.set(false)
                if (this@ScanChannelConnection.webSocket === webSocket) {
                    this@ScanChannelConnection.webSocket = null
                }
                scheduleReconnect()
            }
        }

        fun ensureConnected() {
            if (!wantListen) return
            if (webSocket != null && socketReady.get()) return
            if (webSocket != null) return
            openSocket()
        }

        fun close() {
            socketReady.set(false)
            reconnectPending.set(false)
            webSocket?.close(1001, "scan_off")
            webSocket = null
        }

        private fun openSocket() {
            val token = authTokenProvider().trim()
            val url = if (token.isNotEmpty()) {
                val sep = if (wsBaseUrl.contains("?")) "&" else "?"
                "$wsBaseUrl${sep}token=${java.net.URLEncoder.encode(token, Charsets.UTF_8.name())}"
            } else {
                wsBaseUrl
            }
            val rb = Request.Builder().url(url)
            if (token.isEmpty()) {
                val key = apiKeyProvider().trim()
                if (key.isNotEmpty()) {
                    rb.header("X-Radio-Key", key)
                }
            }
            val ws = client.newWebSocket(rb.build(), listener)
            webSocket = ws
            socketReady.set(false)
        }

        private fun sendJoin(ws: WebSocket) {
            val uid = pendingUnitId.replace("\\", "\\\\").replace("\"", "\\\"")
            val ch = channelLabel.replace("\\", "\\\\").replace("\"", "\\\"")
            val json =
                """{"type":"join","unit_id":"$uid","channel":"$ch","client":"android_scan"}"""
            try {
                ws.send(json)
            } catch (_: Exception) {
            }
        }

        private fun scheduleReconnect() {
            if (!wantListen) return
            if (!channels.containsKey(channelKey)) return
            if (!reconnectPending.compareAndSet(false, true)) return
            val attempt = reconnectAttempt.getAndIncrement()
            val delaySeconds = when {
                attempt <= 0 -> 1L
                attempt >= 5 -> 30L
                else -> 1L shl attempt
            }
            try {
                reconnectExecutor.schedule(
                    {
                        reconnectPending.set(false)
                        if (wantListen && channels.containsKey(channelKey)) {
                            if (webSocket == null) {
                                openSocket()
                            }
                        }
                    },
                    delaySeconds,
                    TimeUnit.SECONDS,
                )
            } catch (_: RejectedExecutionException) {
                reconnectPending.set(false)
            }
        }

        private fun dispatchInboundVoice(payload: ByteArray) {
            if (payload.size == 13 &&
                payload[0] == imbeWsMagic[0] &&
                payload[1] == imbeWsMagic[1]
            ) {
                if (!P25ImbeNative.isAvailable && !P25ImbeNative.tryLoadLibrary()) {
                    return
                }
                val codeword = payload.copyOfRange(2, 13)
                val pcm8k160 = P25ImbeNative.decodeCodeword11(codeword) ?: return
                val pcm16 = applyPostDecodeOrDup(channelLabel, pcm8k160)
                inbound.writePcmFromScan(channelLabel, pcm16)
                return
            }
            inbound.writePcmFromScan(channelLabel, payload)
        }
    }
}
