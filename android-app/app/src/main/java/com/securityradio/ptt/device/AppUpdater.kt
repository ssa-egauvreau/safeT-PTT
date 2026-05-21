package com.securityradio.ptt.device

import android.content.Context
import android.content.Intent
import android.os.Build
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
 * On launch the app polls `/v1/app/android/version`; if the server advertises a
 * higher [currentVersionCode] it downloads the APK, verifies its SHA-256, and
 * hands it to Android's package installer. The fleet is configured to auto-install
 * with no in-app prompt (touchless radios), so [InricoHardwareService] confirms the
 * system installer dialog via [AppUpdateInstallGate].
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

    /** Throttled background check → download → install. Safe to call on every launch. */
    fun checkAndInstallAsync(force: Boolean = false) {
        Thread({ runCheck(force) }, "app-updater").start()
    }

    private fun runCheck(force: Boolean) {
        try {
            if (!force && !throttleElapsed()) return
            markChecked()
            val available = fetchAvailable() ?: return
            if (!canInstall()) {
                Log.w(TAG, "Update ${available.versionName} ready but install-unknown-apps not granted")
                return
            }
            val apk = downloadAndVerify(available) ?: return
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
        }
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

    private companion object {
        const val TAG = "AppUpdater"
        const val KEY_LAST_CHECK = "last_check_ms"
        const val CHECK_INTERVAL_MS = 6L * 60 * 60 * 1000 // poll at most every 6 hours
    }
}
