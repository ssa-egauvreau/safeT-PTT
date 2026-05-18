package com.securityradio.ptt.device

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.SystemClock
import androidx.core.content.ContextCompat
import androidx.core.location.LocationListenerCompat
import androidx.core.location.LocationManagerCompat
import androidx.core.location.LocationRequestCompat
import com.securityradio.ptt.data.remote.LocationReportDto
import com.securityradio.ptt.data.remote.RadioApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.util.Locale

/**
 * Reports the handset's GPS position to the server so it shows on the dispatch map.
 * Uses the platform LocationManager (no Google Play Services) so it works on the
 * rugged Sonim/Inrico handsets that lack Play Services.
 */
class LocationReporter(
    context: Context,
    private val radioApi: RadioApi,
) {
    private val appContext = context.applicationContext
    private val locationManager =
        appContext.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Volatile private var unitId: String = ""
    @Volatile private var channel: String? = null
    @Volatile private var running = false
    private var lastPostAtMs = 0L

    // Explicit object (not a lambda): pre-API-30 LocationListener has extra abstract
    // methods, so SAM conversion would risk an AbstractMethodError on Android 7.
    private val listener = object : LocationListenerCompat {
        override fun onLocationChanged(location: Location) = onLocation(location)
    }

    fun configure(unitId: String) {
        this.unitId = unitId.trim().uppercase(Locale.US)
    }

    fun setChannel(channel: String?) {
        this.channel = channel?.trim()?.takeIf { it.isNotEmpty() && it != "----" }
    }

    fun hasPermission(): Boolean {
        val fine = ContextCompat.checkSelfPermission(appContext, Manifest.permission.ACCESS_FINE_LOCATION)
        val coarse = ContextCompat.checkSelfPermission(appContext, Manifest.permission.ACCESS_COARSE_LOCATION)
        return fine == PackageManager.PERMISSION_GRANTED || coarse == PackageManager.PERMISSION_GRANTED
    }

    @SuppressLint("MissingPermission") // hasPermission() is checked immediately below
    fun start() {
        if (running) return
        val lm = locationManager ?: return
        if (!hasPermission()) return
        val request = LocationRequestCompat.Builder(MIN_INTERVAL_MS)
            .setMinUpdateIntervalMillis(MIN_INTERVAL_MS)
            .setMinUpdateDistanceMeters(MIN_DISTANCE_M)
            .build()
        val executor = ContextCompat.getMainExecutor(appContext)
        var registered = false
        for (provider in PROVIDERS) {
            runCatching {
                if (lm.isProviderEnabled(provider)) {
                    LocationManagerCompat.requestLocationUpdates(lm, provider, request, executor, listener)
                    registered = true
                }
            }
        }
        // Stay "not running" when no provider was available, so a later start()
        // can retry once the user enables location services.
        running = registered
    }

    fun stop() {
        if (!running) return
        running = false
        val lm = locationManager ?: return
        runCatching { LocationManagerCompat.removeUpdates(lm, listener) }
    }

    private fun onLocation(location: Location) {
        val now = SystemClock.elapsedRealtime()
        if (now - lastPostAtMs < MIN_POST_INTERVAL_MS) return
        val unit = unitId.takeIf { it.isNotBlank() } ?: return
        lastPostAtMs = now
        val report = LocationReportDto(
            unitId = unit,
            lat = location.latitude,
            lon = location.longitude,
            channel = channel,
            accuracyM = if (location.hasAccuracy()) location.accuracy.toDouble() else null,
            heading = if (location.hasBearing()) location.bearing.toDouble() else null,
            speedMps = if (location.hasSpeed()) location.speed.toDouble() else null,
        )
        scope.launch {
            runCatching { radioApi.reportLocation(report) }
        }
    }

    private companion object {
        val PROVIDERS = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
        const val MIN_INTERVAL_MS = 15_000L
        // No distance filter: a parked (stationary) radio must keep refreshing its
        // position on the time interval, or its dispatch-map marker goes stale.
        const val MIN_DISTANCE_M = 0f
        const val MIN_POST_INTERVAL_MS = 12_000L
    }
}
