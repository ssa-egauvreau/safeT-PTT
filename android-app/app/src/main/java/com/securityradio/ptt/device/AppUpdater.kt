package com.securityradio.ptt.device

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.securityradio.ptt.data.remote.normalizeApiBaseUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * Over-the-air self-updater for the sideloaded handset fleet (no Play Store, no MDM).
 *
 * On launch and every [CHECK_INTERVAL_MS] while the radio screen is visible, polls
 * `/v1/app/android/version`. If the server advertises a higher [currentVersionCode]
 * it notifies the UI (available → downloading), downloads the APK, verifies SHA-256,
 * then prompts reboot. It hands the APK to Android's package installer. The fleet is
 * configured to auto-install with no in-app prompt (touchless radios), so
 * [InricoHardwareService] confirms the system installer dialog via [AppUpdateInstallGate].
 *
 * The downloaded APK must be signed with the same key as the installed build or
 * Android rejects the update. On API 26+ the app also needs the one-time
 * "install unknown apps" grant; without it we skip silently (granted at provisioning).
 */
class AppUpdater(
    private val context: Context,
    httpApiBaseUrl: String,
    private val currentVersionCode: Long,
) {

    private val baseUrl = normalizeApiBaseUrl(httpApiBaseUrl).trimEnd('/')
    private val prefs = context.getSharedPreferences("app_update_prefs", Context.MODE_PRIVATE)

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()

    data class Available(
        val versionCode: Long,
        val versionName: String,
        val apkUrl: String,
        val sha256: String,
    )

    /** Shown on the radio LCD after a verified APK download (install may finish after reboot). */
    data class UpdateNotice(
        val versionCode: Long,
        val versionName: String,
    )

    /** Live OTA phases for the radio LCD while a check or download is in progress. */
    sealed class UpdateProgress {
        data object Idle : UpdateProgress()
        data class Available(val versionName: String) : UpdateProgress()
        /** Bytes already on disk + total expected (the latter is null when the
         *  server response had no Content-Length header). UI formats as MB and,
         *  when total is known, a percentage. Emitted every ~250 ms during the
         *  download so the banner ticks visibly. */
        data class Downloading(
            val versionName: String,
            val bytesDownloaded: Long = 0L,
            val totalBytes: Long? = null,
        ) : UpdateProgress()
        data class Downloaded(val notice: UpdateNotice) : UpdateProgress()
        /** Re-firing the Android system installer for an APK that was already
         *  downloaded on a previous launch. The accessibility-service auto-
         *  confirm runs the same way as a fresh install. */
        data class Installing(val versionName: String) : UpdateProgress()
        /** A manual "check for updates" found that this build is already current. */
        data object UpToDate : UpdateProgress()
        /** A manual "check for updates" could not confirm the current published version. */
        data object CheckFailed : UpdateProgress()
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private var updateListener: ((UpdateNotice) -> Unit)? = null
    private var progressListener: ((UpdateProgress) -> Unit)? = null
    @Volatile
    private var checkInFlight: Boolean = false
    /** Whether this process has already run its forced launch check (set once per cold start). */
    private var launchCheckDone: Boolean = false

    fun setUpdateListener(listener: ((UpdateNotice) -> Unit)?) {
        updateListener = listener
    }

    fun setProgressListener(listener: ((UpdateProgress) -> Unit)?) {
        progressListener = listener
    }

    /**
     * If a newer build was downloaded but this process is still on an older [currentVersionCode],
     * returns the pending notice so the UI can prompt for reboot.
     */
    fun peekPendingUpdateNotice(): UpdateNotice? {
        val code = prefs.getLong(KEY_PENDING_VERSION_CODE, 0L)
        if (code <= currentVersionCode) {
            if (code > 0L) clearPendingUpdate()
            return null
        }
        val name = prefs.getString(KEY_PENDING_VERSION_NAME, null)?.trim().orEmpty()
        return UpdateNotice(versionCode = code, versionName = name.ifBlank { code.toString() })
    }

    fun clearPendingUpdate() {
        prefs.edit()
            .remove(KEY_PENDING_VERSION_CODE)
            .remove(KEY_PENDING_VERSION_NAME)
            .apply()
    }

    /**
     * Throttled background check → download → install. Safe to call on every launch.
     * [manual] = the operator tapped "check for updates", so report an "up to date" result when
     * there's no newer build (a launch/background check stays silent on Idle instead).
     */
    fun checkAndInstallAsync(force: Boolean = false, manual: Boolean = false) {
        Thread({ runCheck(force, manual) }, "app-updater").start()
    }

    /**
     * If a previously-downloaded update has now been installed (this process is running at or above
     * the pending version), returns its notice once and clears the pending marker — so the UI can
     * play a success chime / confirmation at the first launch on the new build.
     */
    fun takeInstalledUpdateNotice(): UpdateNotice? {
        val code = prefs.getLong(KEY_PENDING_VERSION_CODE, 0L)
        if (code in 1..currentVersionCode) {
            val name = prefs.getString(KEY_PENDING_VERSION_NAME, null)?.trim().orEmpty()
            clearPendingUpdate()
            return UpdateNotice(versionCode = code, versionName = name.ifBlank { code.toString() })
        }
        return null
    }

    /**
     * Update check tied to an app launch. The first call in a process is forced so every cold start
     * — a device reboot (the boot receiver relaunches the app) or the operator first opening the app
     * — always checks, regardless of the throttle. Later launches in the same process (e.g. an
     * Activity recreate) fall back to the throttled check so we don't poll on every config change.
     *
     * If a previously-downloaded APK is still pending (the accessibility
     * auto-confirm missed the system installer dialog on the prior run, or
     * the operator power-cycled in between), retry the install immediately
     * on this launch BEFORE the server poll so the "off and on again"
     * recovery the operator already tried actually does what they expect.
     */
    fun checkOnLaunch() {
        val forceThisLaunch = synchronized(this) {
            if (launchCheckDone) {
                false
            } else {
                launchCheckDone = true
                true
            }
        }
        forceRetryPendingInstall()
        checkAndInstallAsync(force = forceThisLaunch, manual = false)
    }

    /**
     * Re-fire the Android system installer for an APK already downloaded on
     * a previous run. Safe to call repeatedly — no-ops when there's no
     * pending APK on disk, when this process is already at or above the
     * pending version, or when the install-unknown-apps grant is missing.
     *
     * Used in two places:
     *  - [checkOnLaunch] retries automatically so a power-cycle by the
     *    operator finishes the install they expected.
     *  - A hardware-key handler ([HardwareAction.FORCE_INSTALL_UPDATE])
     *    lets the operator force the installer dialog from the radio
     *    screen when the auto-flow stalls.
     *
     * Returns true if an installer intent was fired, false otherwise — so
     * a manual trigger can show "no update pending" feedback instead of
     * silently doing nothing.
     */
    fun forceRetryPendingInstall(): Boolean {
        val notice = peekPendingUpdateNotice() ?: return false
        val apk = File(File(context.cacheDir, "updates"), "update.apk")
        if (!apk.exists() || apk.length() == 0L) {
            // The APK file was wiped (cache cleared, app re-installed) but
            // prefs still claim a pending version. Drop the stale marker so
            // the next server poll re-downloads cleanly.
            clearPendingUpdate()
            return false
        }
        if (!canInstall()) {
            Log.w(TAG, "forceRetryPendingInstall: install-unknown-apps not granted; skipping")
            return false
        }
        notifyProgress(UpdateProgress.Installing(notice.versionName))
        AppUpdateInstallGate.arm()
        return try {
            launchInstall(apk)
            true
        } catch (e: Exception) {
            AppUpdateInstallGate.disarm()
            Log.w(TAG, "forceRetryPendingInstall: install launch failed", e)
            false
        }
    }

    private fun runCheck(force: Boolean, manual: Boolean) {
        if (!beginCheck()) return
        try {
            if (!force && !throttleElapsed()) return
            markChecked()
            val available =
                when (val result = fetchVersionStatus()) {
                    is VersionStatus.UpdateAvailable -> result.available
                    VersionStatus.UpToDate -> {
                        notifyProgress(if (manual) UpdateProgress.UpToDate else UpdateProgress.Idle)
                        return
                    }
                    VersionStatus.Unknown -> {
                        notifyProgress(if (manual) UpdateProgress.CheckFailed else UpdateProgress.Idle)
                        return
                    }
                }
            if (!canInstall()) {
                Log.w(TAG, "Update ${available.versionName} ready but install-unknown-apps not granted")
                notifyProgress(UpdateProgress.Idle)
                return
            }
            notifyProgress(UpdateProgress.Available(available.versionName))
            notifyProgress(UpdateProgress.Downloading(available.versionName))
            val apk = downloadAndVerify(available) { bytes, total ->
                notifyProgress(UpdateProgress.Downloading(available.versionName, bytes, total))
            } ?: run {
                notifyProgress(UpdateProgress.Idle)
                return
            }
            markPendingUpdate(available)
            val notice =
                UpdateNotice(
                    versionCode = available.versionCode,
                    versionName = available.versionName,
                )
            notifyProgress(UpdateProgress.Downloaded(notice))
            AppUpdateInstallGate.arm()
            try {
                launchInstall(apk)
            } catch (e: Exception) {
                // Don't leave the auto-confirm window open if the installer never launched.
                AppUpdateInstallGate.disarm()
                Log.w(TAG, "install launch failed", e)
            }
        } catch (e: Exception) {
            Log.w(TAG, "update check failed", e)
            notifyProgress(if (manual) UpdateProgress.CheckFailed else UpdateProgress.Idle)
        } finally {
            endCheck()
        }
    }

    private fun beginCheck(): Boolean {
        synchronized(this) {
            if (checkInFlight) return false
            checkInFlight = true
            return true
        }
    }

    private fun endCheck() {
        synchronized(this) { checkInFlight = false }
    }

    private sealed class VersionStatus {
        data class UpdateAvailable(val available: Available) : VersionStatus()
        data object UpToDate : VersionStatus()
        data object Unknown : VersionStatus()
    }

    /** Blocking — checks the published build version. Call off the main thread. */
    private fun fetchVersionStatus(): VersionStatus {
        val request = Request.Builder().url("$baseUrl/v1/app/android/version").build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) return VersionStatus.Unknown
            val body = response.body?.string() ?: return VersionStatus.Unknown
            val json = JSONObject(body)
            val versionCode = json.optLong("versionCode", -1)
            if (versionCode < 0) return VersionStatus.Unknown
            if (versionCode <= currentVersionCode) return VersionStatus.UpToDate
            val url = json.optString("url")
            val sha256 = json.optString("sha256")
            if (url.isBlank() || sha256.isBlank()) return VersionStatus.Unknown
            return VersionStatus.UpdateAvailable(
                Available(
                    versionCode = versionCode,
                    versionName = json.optString("versionName", versionCode.toString()),
                    apkUrl = url,
                    sha256 = sha256,
                ),
            )
        }
    }

    private fun downloadAndVerify(
        available: Available,
        onProgress: ((bytesDownloaded: Long, totalBytes: Long?) -> Unit)? = null,
    ): File? {
        val fullUrl = resolveApkUrl(available.apkUrl) ?: return null
        val dir = File(context.cacheDir, "updates").apply { mkdirs() }
        val out = File(dir, "update.apk")

        // Short-circuit: if a prior run already downloaded this exact APK and
        // the install just hasn't confirmed yet (auto-confirm missed the
        // dialog, operator deferred, etc.), reuse the cached file. Without
        // this every 30-minute version poll re-downloads the same ~50 MB
        // APK as long as the install stays pending — devices in that state
        // were burning hundreds of MB/day of cellular re-downloading the
        // same bytes. Emit a synthetic "100 %" progress event so the banner
        // sees the file as complete rather than freezing at "DOWNLOADING…".
        if (out.exists() && out.length() > 0) {
            val cachedHash = sha256Hex(out)
            if (cachedHash.equals(available.sha256, ignoreCase = true)) {
                Log.i(TAG, "Reusing cached APK v${available.versionName} (hash matches; skipping network)")
                onProgress?.invoke(out.length(), out.length())
                return out
            }
        }

        val request = Request.Builder().url(fullUrl).build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) return null
            val body = response.body ?: return null
            // OkHttp gives -1 when the server didn't send Content-Length; coerce
            // to null so the progress payload can carry "unknown total" rather
            // than a fake "100 %" baseline.
            val totalRaw = body.contentLength()
            val total: Long? = if (totalRaw > 0) totalRaw else null
            // Stream straight to disk — never hold the whole APK in RAM on constrained radios.
            body.byteStream().use { input ->
                out.outputStream().use { output ->
                    copyWithProgress(input, output, total, onProgress)
                }
            }
        }
        val actual = sha256Hex(out)
        if (!actual.equals(available.sha256, ignoreCase = true)) {
            Log.w(TAG, "APK hash mismatch (expected ${available.sha256}, got $actual) — discarding")
            out.delete()
            return null
        }
        return out
    }

    /** Copy with periodic progress emission. Throttled to ~250 ms so the LCD
     *  banner ticks visibly without spamming the UI thread on a fast wifi link. */
    private fun copyWithProgress(
        input: java.io.InputStream,
        output: java.io.OutputStream,
        total: Long?,
        onProgress: ((bytesDownloaded: Long, totalBytes: Long?) -> Unit)?,
    ) {
        val buffer = ByteArray(8192)
        var copied = 0L
        var lastNotifyMs = 0L
        // Initial 0 % so the banner switches from "DOWNLOADING…" to "DOWNLOADING 0 %" fast.
        onProgress?.invoke(0L, total)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            output.write(buffer, 0, read)
            copied += read
            val now = System.currentTimeMillis()
            if (onProgress != null && now - lastNotifyMs >= PROGRESS_THROTTLE_MS) {
                onProgress(copied, total)
                lastNotifyMs = now
            }
        }
        // Final emission so the UI lands on "DOWNLOADING 100 %" before flipping to Downloaded.
        onProgress?.invoke(copied, total)
    }

    /** Absolute URLs pass through; a server-relative path resolves against the API host. */
    private fun resolveApkUrl(apkUrl: String): String? {
        apkUrl.toHttpUrlOrNull()?.let { return it.toString() }
        val base = baseUrl.toHttpUrlOrNull() ?: return null
        return base.resolve(apkUrl)?.toString()
    }

    private fun sha256Hex(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(8192)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xFF) }
    }

    fun canInstall(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()

    /**
     * Installs the downloaded APK via the [PackageInstaller] session API rather
     * than the legacy `ACTION_VIEW` package-archive intent. The old intent was
     * routed by some OEM builds through a Google Play "scan before install"
     * interstitial; on devices where the Play Store itself crashes that dialog
     * never resolved, and because the OTA re-fires the installer every launch the
     * device got stuck in a never-installing loop. The session API hands the APK
     * straight to the system package installer instead.
     *
     * The confirmation still comes from the system `packageinstaller` package, so
     * the touchless accessibility auto-confirm ([AppUpdateInstallGate] +
     * [InricoHardwareService]) drives it exactly as before. Status (incl. the
     * "user action needed" hand-off that shows the confirm dialog) is delivered
     * to [AppUpdateInstallReceiver].
     */
    private fun launchInstall(apk: File) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(
            PackageInstaller.SessionParams.MODE_FULL_INSTALL,
        ).apply { setAppPackageName(context.packageName) }
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            apk.inputStream().use { input ->
                session.openWrite("base.apk", 0, apk.length()).use { out ->
                    input.copyTo(out)
                    session.fsync(out)
                }
            }
            val statusIntent = Intent(context, AppUpdateInstallReceiver::class.java).apply {
                action = AppUpdateInstallReceiver.ACTION_INSTALL_STATUS
                setPackage(context.packageName)
            }
            val piFlags = PendingIntent.FLAG_UPDATE_CURRENT or
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
            val statusSender =
                PendingIntent.getBroadcast(context, sessionId, statusIntent, piFlags)
            session.commit(statusSender.intentSender)
        }
    }

    private fun throttleElapsed(): Boolean =
        System.currentTimeMillis() - prefs.getLong(KEY_LAST_CHECK, 0L) >= CHECK_INTERVAL_MS

    private fun markChecked() {
        prefs.edit().putLong(KEY_LAST_CHECK, System.currentTimeMillis()).apply()
    }

    private fun markPendingUpdate(available: Available) {
        prefs.edit()
            .putLong(KEY_PENDING_VERSION_CODE, available.versionCode)
            .putString(KEY_PENDING_VERSION_NAME, available.versionName)
            .apply()
    }

    private fun notifyUpdateDownloaded(available: Available) {
        val notice =
            UpdateNotice(
                versionCode = available.versionCode,
                versionName = available.versionName,
            )
        mainHandler.post { updateListener?.invoke(notice) }
    }

    private fun notifyProgress(progress: UpdateProgress) {
        mainHandler.post { progressListener?.invoke(progress) }
    }

    private companion object {
        const val TAG = "AppUpdater"
        const val KEY_LAST_CHECK = "last_check_ms"
        const val KEY_PENDING_VERSION_CODE = "pending_version_code"
        const val KEY_PENDING_VERSION_NAME = "pending_version_name"
        /** Minimum time between server version polls (launch + foreground periodic checks). */
        const val CHECK_INTERVAL_MS = 30L * 60 * 1000
        /** Throttle on Downloading progress emissions — keeps the UI thread from
         *  being flooded on a fast wifi link while still ticking visibly. */
        const val PROGRESS_THROTTLE_MS = 250L
    }
}
