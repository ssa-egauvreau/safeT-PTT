package com.securityradio.ptt.device

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.content.FileProvider
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
        data class Downloading(val versionName: String) : UpdateProgress()
        data class Downloaded(val notice: UpdateNotice) : UpdateProgress()
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private var updateListener: ((UpdateNotice) -> Unit)? = null
    private var progressListener: ((UpdateProgress) -> Unit)? = null
    @Volatile
    private var checkInFlight: Boolean = false

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

    /** Throttled background check → download → install. Safe to call on every launch. */
    fun checkAndInstallAsync(force: Boolean = false) {
        Thread({ runCheck(force) }, "app-updater").start()
    }

    private fun runCheck(force: Boolean) {
        if (!beginCheck()) return
        try {
            if (!force && !throttleElapsed()) return
            markChecked()
            val available = fetchAvailable() ?: run {
                notifyProgress(UpdateProgress.Idle)
                return
            }
            if (!canInstall()) {
                Log.w(TAG, "Update ${available.versionName} ready but install-unknown-apps not granted")
                notifyProgress(UpdateProgress.Idle)
                return
            }
            notifyProgress(UpdateProgress.Available(available.versionName))
            notifyProgress(UpdateProgress.Downloading(available.versionName))
            val apk = downloadAndVerify(available) ?: run {
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
            notifyProgress(UpdateProgress.Idle)
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

    /** Blocking — returns the published build only if it's newer than this one. Call off the main thread. */
    fun fetchAvailable(): Available? {
        val request = Request.Builder().url("$baseUrl/v1/app/android/version").build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) return null
            val body = response.body?.string() ?: return null
            val json = JSONObject(body)
            val versionCode = json.optLong("versionCode", -1)
            val url = json.optString("url")
            val sha256 = json.optString("sha256")
            if (versionCode <= currentVersionCode || url.isBlank() || sha256.isBlank()) {
                return null
            }
            return Available(
                versionCode = versionCode,
                versionName = json.optString("versionName", versionCode.toString()),
                apkUrl = url,
                sha256 = sha256,
            )
        }
    }

    private fun downloadAndVerify(available: Available): File? {
        val fullUrl = resolveApkUrl(available.apkUrl) ?: return null
        val dir = File(context.cacheDir, "updates").apply { mkdirs() }
        val out = File(dir, "update.apk")
        val request = Request.Builder().url(fullUrl).build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) return null
            val body = response.body ?: return null
            // Stream straight to disk — never hold the whole APK in RAM on constrained radios.
            body.byteStream().use { input ->
                out.outputStream().use { output -> input.copyTo(output) }
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

    private fun launchInstall(apk: File) {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apk)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        context.startActivity(intent)
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
    }
}
