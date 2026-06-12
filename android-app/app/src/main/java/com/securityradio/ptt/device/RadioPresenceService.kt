package com.securityradio.ptt.device

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.securityradio.ptt.DisplayRouterActivity
import com.securityradio.ptt.R

/**
 * Low-profile foreground anchor so OEM task killers are less likely to suspend the accessibility
 * PTT routing while another app is on screen.
 *
 * Also pins the radio link while running: a partial wake lock keeps the CPU
 * servicing the voice WebSocket with the screen off, and a low-latency Wi-Fi
 * lock opts out of Wi-Fi power-save batching. Without these, screen-off
 * handsets receive voice frames in power-managed bursts — heard as choppy RX
 * and counted as buffer underruns / PLC on the Link Health dashboard — and
 * the dedicated-handset deployments this app targets expect always-on radio
 * behaviour over standby battery life (the same trade commercial PTT apps
 * make with their "keep awake" mode).
 */
class RadioPresenceService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?) = null

    override fun onCreate() {
        super.onCreate()
        ensureNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFY_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else {
            startForeground(NOTIFY_ID, notification)
        }
        acquireRadioLocks()
        return START_STICKY
    }

    override fun onDestroy() {
        releaseRadioLocks()
        super.onDestroy()
    }

    private fun acquireRadioLocks() {
        if (wakeLock == null) {
            // String-keyed getSystemService: the Class-keyed overload needs API 23
            // and minSdk is 21.
            wakeLock = runCatching {
                (getSystemService(Context.POWER_SERVICE) as? PowerManager)
                    ?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "safeT:radioPresence")
                    ?.also {
                        it.setReferenceCounted(false)
                        // Held for the life of the service by design (no timeout):
                        // a sleeping CPU between voice frames is exactly the
                        // screen-off RX chop this lock exists to prevent.
                        it.acquire()
                    }
            }.getOrNull()
        }
        if (wifiLock == null) {
            wifiLock = runCatching {
                val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                } else {
                    @Suppress("DEPRECATION")
                    WifiManager.WIFI_MODE_FULL_HIGH_PERF
                }
                (applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager)
                    ?.createWifiLock(mode, "safeT:radioPresence")
                    ?.also {
                        it.setReferenceCounted(false)
                        it.acquire()
                    }
            }.getOrNull()
        }
    }

    private fun releaseRadioLocks() {
        runCatching { wakeLock?.takeIf { it.isHeld }?.release() }
        wakeLock = null
        runCatching { wifiLock?.takeIf { it.isHeld }?.release() }
        wifiLock = null
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.presence_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.presence_notification_text)
            setShowBadge(false)
        }
        nm.createNotificationChannel(channel)
    }

    private fun buildNotification(): android.app.Notification {
        var piFlags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            piFlags = piFlags or PendingIntent.FLAG_IMMUTABLE
        }
        val openPi = PendingIntent.getActivity(
            this,
            0,
            Intent(this, DisplayRouterActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            piFlags,
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.presence_notification_title))
            .setContentText(getString(R.string.presence_notification_text))
            .setSmallIcon(R.drawable.ic_radio_notification_small)
            .setOngoing(true)
            .setContentIntent(openPi)
            .setSilent(true)
            .apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                }
            }
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "radio_presence_bg"
        private const val NOTIFY_ID = 7901

        fun start(context: Context) {
            val appCtx = context.applicationContext
            ContextCompat.startForegroundService(appCtx, Intent(appCtx, RadioPresenceService::class.java))
        }
    }
}
