package com.securityradio.ptt.device

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import androidx.core.content.ContextCompat
import androidx.core.location.LocationListenerCompat
import androidx.core.location.LocationManagerCompat
import androidx.core.location.LocationRequestCompat
import com.securityradio.ptt.data.remote.LocationReportDto
import com.securityradio.ptt.data.remote.RadioApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
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
    /** Freshest position known — from a live update or a provider's cached fix. */
    @Volatile private var lastLocation: Location? = null
    /** Last position actually POSTed to the server, and when, so a parked radio
     *  stops re-uploading the same coordinates every cycle. */
    private var lastReported: Location? = null
    private var lastReportedAtMs: Long = 0L
    private var lastReportedChannel: String? = null
    private var postJob: Job? = null

    // Explicit object (not a lambda): pre-API-30 LocationListener has extra abstract
    // methods, so SAM conversion would risk an AbstractMethodError on Android 7.
    private val listener = object : LocationListenerCompat {
        override fun onLocationChanged(location: Location) {
            lastLocation = location
        }
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

    /** True when at least one location provider is enabled in Android settings. */
    fun isLocationEnabled(): Boolean {
        val lm = locationManager ?: return false
        return PROVIDERS.any { provider ->
            runCatching { lm.isProviderEnabled(provider) }.getOrDefault(false)
        }
    }

    @SuppressLint("MissingPermission") // hasPermission() is checked before any location call
    fun start() {
        if (running) return
        val lm = locationManager ?: return
        if (!hasPermission()) return
        running = true

        // Use a recent cached fix only — ancient last-known positions made the dispatch
        // map show radios 12–46 hours out of date.
        lastLocation = bestLastKnown(lm)

        val request = LocationRequestCompat.Builder(POST_INTERVAL_MS)
            .setMinUpdateIntervalMillis(POST_INTERVAL_MS)
            .setMinUpdateDistanceMeters(0f) // a parked radio must keep refreshing
            .build()
        val executor = ContextCompat.getMainExecutor(appContext)
        for (provider in PROVIDERS) {
            runCatching {
                if (lm.isProviderEnabled(provider)) {
                    LocationManagerCompat.requestLocationUpdates(lm, provider, request, executor, listener)
                }
            }
        }

        // Post on a fixed cadence rather than only when the OS delivers a fresh
        // fix: a stationary or indoor radio still has to stay visible on the map.
        postJob = scope.launch {
            while (isActive) {
                runCatching { postCurrentLocation(lm) }
                delay(POST_INTERVAL_MS)
            }
        }
    }

    fun stop() {
        running = false
        postJob?.cancel()
        postJob = null
        val lm = locationManager ?: return
        runCatching { LocationManagerCompat.removeUpdates(lm, listener) }
    }

    /** Posts the freshest known position; tops up from the location cache first. */
    private suspend fun postCurrentLocation(lm: LocationManager) {
        if (hasPermission()) {
            val cached = bestLastKnown(lm)
            val current = lastLocation
            if (cached != null && (current == null || cached.time > current.time)) {
                lastLocation = cached
            }
        }
        val location = lastLocation?.takeIf { isFreshEnough(it) } ?: return
        val unit = unitId.takeIf { it.isNotBlank() } ?: return
        if (!shouldReport(location)) return
        radioApi.reportLocation(
            LocationReportDto(
                unitId = unit,
                lat = location.latitude,
                lon = location.longitude,
                channel = channel,
                accuracyM = if (location.hasAccuracy()) location.accuracy.toDouble() else null,
                heading = if (location.hasBearing()) location.bearing.toDouble() else null,
                speedMps = if (location.hasSpeed()) location.speed.toDouble() else null,
            ),
        )
        // Only mark as reported after a POST that didn't throw, so a failed
        // upload is retried on the next cycle instead of being suppressed.
        lastReported = location
        lastReportedAtMs = System.currentTimeMillis()
        lastReportedChannel = channel
    }

    /**
     * Suppresses redundant uploads for a stationary radio. Reports when the
     * position has moved at least [MIN_MOVE_METERS] since the last upload, or
     * when [STATIONARY_KEEPALIVE_MS] has elapsed (a heartbeat so a parked radio
     * stays inside the dispatch map's stale window). A channel change always
     * reports so the map's per-channel filter stays correct.
     */
    private fun shouldReport(location: Location): Boolean {
        val previous = lastReported ?: return true
        if (channel != lastReportedChannel) return true
        val now = System.currentTimeMillis()
        if (now - lastReportedAtMs >= STATIONARY_KEEPALIVE_MS) return true
        if (previous.distanceTo(location) >= MIN_MOVE_METERS) return true
        return false
    }

    /** Most recent cached fix across providers, or null if none is recent enough. */
    @SuppressLint("MissingPermission") // callers check hasPermission()
    private fun bestLastKnown(lm: LocationManager): Location? {
        var best: Location? = null
        for (provider in PROVIDERS) {
            val loc = runCatching {
                if (lm.isProviderEnabled(provider)) lm.getLastKnownLocation(provider) else null
            }.getOrNull()
            if (loc != null && isFreshEnough(loc) && (best == null || loc.time > best.time)) {
                best = loc
            }
        }
        return best
    }

    private fun isFreshEnough(location: Location): Boolean {
        val ageMs = (System.currentTimeMillis() - location.time).coerceAtLeast(0L)
        return ageMs <= MAX_LOCATION_AGE_MS
    }

    private companion object {
        val PROVIDERS = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
        /** Cadence for both location-update requests and server posts. */
        const val POST_INTERVAL_MS = 60_000L
        /** A stationary radio still heartbeats its position this often so it stays
         *  inside the dispatch map's 5-min stale window without re-posting every
         *  cycle. Kept under [MAX_LOCATION_AGE_MS]. */
        const val STATIONARY_KEEPALIVE_MS = 4 * 60_000L
        /** Minimum movement since the last upload before a non-keepalive report. */
        const val MIN_MOVE_METERS = 25f
        /** Do not report fixes older than this — matches dispatch map "stale" window (5 min). */
        const val MAX_LOCATION_AGE_MS = 5 * 60_000L
    }
}
