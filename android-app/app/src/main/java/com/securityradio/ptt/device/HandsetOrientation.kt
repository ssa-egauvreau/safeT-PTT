package com.securityradio.ptt.device

import android.app.Activity
import android.content.pm.ActivityInfo
import com.securityradio.ptt.DisplayRouter

/**
 * Pins the activity to a stable orientation so rugged handsets do not boot "sideways"
 * after firmware OTA or scrcpy display-off/reboot (sensor state can be wrong once).
 *
 * IRC590 and TM-7 Plus use a **horizontal** (landscape) panel. S200 and phones stay portrait.
 * MP22 dual-display units lock to whichever axis matches the active display.
 */
object HandsetOrientation {

    fun apply(activity: Activity) {
        val target = resolveOrientation(activity)
        if (activity.requestedOrientation != target) {
            activity.requestedOrientation = target
        }
    }

    private fun resolveOrientation(activity: Activity): Int {
        val prefs = RadioPreferences(activity.applicationContext)
        if (DisplayRouter.isMp22StyleDualDisplay(activity)) {
            return lockForDisplayMetrics(activity)
        }
        val resolved =
            DeviceProfileResolver.resolve(
                prefs.getDeviceProfilePreference(),
                android.os.Build.MODEL,
            )
        return when (resolved) {
            ResolvedDeviceProfile.IRC590,
            ResolvedDeviceProfile.TM7_PLUS,
            -> ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
            ResolvedDeviceProfile.S200,
            ResolvedDeviceProfile.RESPONSIVE,
            ResolvedDeviceProfile.UNIVERSAL,
            -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        }
    }

    /** Lock to portrait or landscape based on the current display's pixel aspect ratio. */
    private fun lockForDisplayMetrics(activity: Activity): Int {
        val metrics = activity.resources.displayMetrics
        return if (metrics.widthPixels > metrics.heightPixels) {
            ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        } else {
            ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        }
    }
}
