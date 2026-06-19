package com.securityradio.ptt.device

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log

/**
 * Receives [PackageInstaller] session status callbacks for OTA self-updates
 * (see [AppUpdater.launchInstall]).
 *
 * The important case is [PackageInstaller.STATUS_PENDING_USER_ACTION]: the system
 * needs the user to confirm the install, handing back an Intent that launches the
 * confirm dialog. We start it (keeping the auto-confirm gate armed) so the
 * touchless accessibility service can click through it on radios with no
 * touchscreen — exactly as it did for the legacy ACTION_VIEW installer.
 */
class AppUpdateInstallReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = confirmIntent(intent)
                if (confirm == null) {
                    Log.w(TAG, "Pending user action but no confirm intent supplied")
                    return
                }
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                // Re-arm so the accessibility auto-confirm clicks the dialog even
                // if the original arm window lapsed during the session write.
                AppUpdateInstallGate.arm()
                try {
                    context.startActivity(confirm)
                } catch (e: Exception) {
                    AppUpdateInstallGate.disarm()
                    Log.w(TAG, "Could not launch install confirm dialog", e)
                }
            }

            PackageInstaller.STATUS_SUCCESS -> {
                AppUpdateInstallGate.disarm()
                Log.i(TAG, "OTA install succeeded")
            }

            else -> {
                AppUpdateInstallGate.disarm()
                val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
                Log.w(TAG, "OTA install failed (status=$status): ${msg ?: "no message"}")
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun confirmIntent(intent: Intent): Intent? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        } else {
            intent.getParcelableExtra(Intent.EXTRA_INTENT)
        }

    companion object {
        const val ACTION_INSTALL_STATUS = "com.securityradio.ptt.OTA_INSTALL_STATUS"
        private const val TAG = "AppUpdateInstall"
    }
}
