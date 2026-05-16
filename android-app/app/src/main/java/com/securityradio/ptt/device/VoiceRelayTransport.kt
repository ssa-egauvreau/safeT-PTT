package com.securityradio.ptt.device

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.toByteString
import java.util.Locale
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

fun httpApiBaseUrlToVoiceWebSocketUrl(httpBaseUrl: String): String {
    val u = httpBaseUrl.trim().trimEnd('/')
    val https = "https://"
    val http = "http://"
    val (scheme, remainder) = when {
        u.startsWith(https, ignoreCase = true) ->
            "wss://" to u.drop(https.length).trimStart('/')
        u.startsWith(http, ignoreCase = true) ->
            "ws://" to u.drop(http.length).trimStart('/')
        else -> "wss://" to u.trimStart('/')
    }
    return scheme + remainder + "/v1/voice/stream"
}

/**
 * Half-duplex voice path: uploads local PCM frames and plays peer PCM from the relay.
 *
 * Codec: PCM 16-bit signed LE, mono, 16000 Hz (aligned with Android capture).
 */
class VoiceRelayTransport(
    httpApiBaseUrl: String,
    private val apiKey: String,
    private val inbound: InboundVoicePlayer,
) : StreamingPcmSink {

    private val wsUrl = httpApiBaseUrlToVoiceWebSocketUrl(httpApiBaseUrl)

    private val client = OkHttpClient.Builder()
        .pingInterval(25L, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private val connectionLock = Any()
    private val webSocketRef = AtomicReference<WebSocket?>(null)
    private val socketReady = AtomicBoolean(false)

    private val wantOnline = AtomicBoolean(false)

    @Volatile
    private var pendingUnitId: String = ""

    @Volatile
    private var pendingChannelRaw: String = ""

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            socketReady.set(true)
            sendJoin(webSocket)
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            inbound.writePcm(bytes.toByteArray())
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            socketReady.set(false)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            socketReady.set(false)
            webSocketRef.compareAndSet(webSocket, null)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            socketReady.set(false)
            webSocketRef.compareAndSet(webSocket, null)
        }
    }

    /**
     * @param channelLabel current tuner label (must match REST channel names)
     */
    fun updateVoiceTarget(unitIdUpper: String, channelLabel: String, networkOnline: Boolean) {
        pendingUnitId = unitIdUpper.trim().uppercase(Locale.US)
        pendingChannelRaw = channelLabel.trim()
        wantOnline.set(
            networkOnline &&
                pendingChannelRaw.isNotEmpty() &&
                pendingChannelRaw != "----",
        )

        if (!wantOnline.get()) {
            disconnect()
            return
        }

        synchronized(connectionLock) {
            val existing = webSocketRef.get()
            if (existing != null) {
                sendJoin(existing)
            } else {
                openSocketLocked()
            }
        }
    }

    override fun consumePcm(buffer: ByteArray, length: Int) {
        if (!wantOnline.get() || length <= 0) return
        var ws = webSocketRef.get()
        if (ws == null || !socketReady.get()) {
            if (!wantOnline.get()) return
            synchronized(connectionLock) {
                if (!wantOnline.get()) return
                if (webSocketRef.get() == null) {
                    openSocketLocked()
                }
                ws = webSocketRef.get()
            }
            if (!socketReady.get()) return
        }
        val active = ws ?: return
        try {
            val copy = buffer.copyOfRange(0, length)
            active.send(copy.toByteString())
        } catch (_: Exception) {
        }
    }

    /** Stop outbound/inbound sockets and mute remote playback ([InboundVoicePlayer] stays reusable). */
    fun disconnect() {
        wantOnline.set(false)
        socketReady.set(false)
        webSocketRef.getAndSet(null)?.close(1001, "bye")
        inbound.stop()
    }

    /** Permanent teardown when discarding transport (normally unused — prefer [disconnect]). */
    fun shutdown() {
        disconnect()
        inbound.release()
    }

    private fun sendJoin(ws: WebSocket) {
        val uid = escapeJsonFragment(pendingUnitId)
        val ch = escapeJsonFragment(pendingChannelRaw)
        val json = """{"type":"join","unit_id":"$uid","channel":"$ch"}"""
        try {
            ws.send(json)
        } catch (_: Exception) {
        }
    }

    private fun openSocketLocked() {
        val rb = Request.Builder().url(wsUrl)
        val key = apiKey.trim()
        if (key.isNotEmpty()) {
            rb.header("X-Radio-Key", key)
        }
        val ws = client.newWebSocket(rb.build(), listener)
        webSocketRef.set(ws)
        socketReady.set(false)
    }

    private fun escapeJsonFragment(s: String): String =
        s.replace("\\", "\\\\").replace("\"", "\\\"")
}
