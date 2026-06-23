package com.securityradio.ptt.device

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.UserManager
import com.securityradio.ptt.DisplayRouter

/**
 * Restarts the foreground anchor after reboot; best-effort resumes the radio UI (OEMs may block this).
 *
 * IMPORTANT — first-boot crash guard (Enrico/Inrico TM7 on Android 11): this app stores its state in
 * the default, credential-encrypted SharedPreferences ([RadioPreferences]), which Android does NOT
 * make available until the user has unlocked the device for the first time after a reboot. If we let
 * the boot receiver spin up the process during *direct boot* (the LOCKED_BOOT_COMPLETED phase, before
 * unlock), [com.securityradio.ptt.RadioApplication.onCreate] builds the app graph, touches those
 * prefs, and the OS throws — which surfaces as the "safeT stopped working / wait or force close"
 * dialog on every cold boot. So we only do any work once the user is unlocked, and we never start the
 * foreground service or activity from a locked boot.
 */
class RadioBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        // Never act while the device is still locked (direct boot). The app is not direct-boot aware,
        // so any startup here crashes against unavailable credential-encrypted storage.
        val userManager = context.getSystemService(Context.USER_SERVICE) as? UserManager
        if (userManager != null && !userManager.isUserUnlocked) {
            return
        }
        when (intent?.action) {
            Intent.ACTION_BOOT_COMPLETED,
            "android.intent.action.QUICKBOOT_POWERON",
            Intent.ACTION_MY_PACKAGE_REPLACED,
            Intent.ACTION_USER_PRESENT,
            -> launchRadio(context)
            else -> return
        }
    }

    private fun launchRadio(context: Context) {
        try {
            RadioPresenceService.start(context)
        } catch (_: Throwable) {
            /* Some OEMs / boot states reject background foreground-service starts; ignore. */
        }
        try {
            DisplayRouter.startMainActivity(context)
        } catch (_: Throwable) {
            /* Some OEMs block background startup; the presence notification can still open MainActivity. */
        }
    }
}
