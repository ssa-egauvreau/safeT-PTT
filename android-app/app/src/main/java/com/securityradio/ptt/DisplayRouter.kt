package com.securityradio.ptt

import android.app.ActivityOptions
import android.content.Context
import android.content.Intent
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.DisplayMetrics
import android.util.Log
import android.view.Display
import com.securityradio.ptt.device.RadioPreferences

/**
 * Routes app startup on MP22 / some Inrico firmware where Display 0 is virtual (PC mirror +
 * scrcpy control on Android 8.1) and Display 1 is the built-in physical panel (hardware keys).
 *
 * Normal phones and IRC590 are unaffected.
 */
object DisplayRouter {

    const val TAG = "SafeTDisplayRouter"
    const val MP22_PHYSICAL_DISPLAY_ID = 1

    private const val MP22_RETRY_DELAY_MS = 1_000L
    private const val MP22_VIRTUAL_DISPLAY_ID = 0

    /** Avoid reusing a stale task on Display 0 when moving to the physical panel. */
    private const val PHYSICAL_LAUNCH_FLAGS =
        Intent.FLAG_ACTIVITY_NEW_TASK or
            Intent.FLAG_ACTIVITY_CLEAR_TASK or
            Intent.FLAG_ACTIVITY_MULTIPLE_TASK

    fun startMainActivity(context: Context) {
        val appContext = context.applicationContext
        try {
            val displays = loadDisplays(appContext)
            logDisplays(displays)
            val physicalId = resolveMp22PhysicalDisplayId(displays)
            if (physicalId == null) {
                Log.i(TAG, "Normal display setup — launching MainActivity on default display.")
                appContext.startActivity(mainActivityIntent(appContext))
                return
            }
            val prefs = RadioPreferences(appContext)
            if (prefs.isMp22UsePhysicalDisplay()) {
                Log.i(TAG, "MP22-style setup detected — launching MainActivity on display $physicalId.")
                val intent = mainActivityIntentForPhysicalDisplay(appContext)
                launchOnDisplay(appContext, intent, physicalId)
                scheduleMp22PhysicalRetry(appContext, physicalId)
            } else {
                Log.i(TAG, "MP22 PC setup mode — launching MainActivity on virtual display 0.")
                val intent = mainActivityIntent(appContext)
                launchOnDisplay(appContext, intent, MP22_VIRTUAL_DISPLAY_ID)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Display routing failed; falling back to normal launch.", e)
            try {
                appContext.startActivity(mainActivityIntent(appContext))
            } catch (_: Throwable) {
                /* best effort */
            }
        }
    }

    /** After PC/scrcpy setup on the virtual display, move the app to the physical radio screen. */
    fun moveToPhysicalDisplay(context: Context) {
        val appContext = context.applicationContext
        RadioPreferences(appContext).setMp22UsePhysicalDisplay(true)
        startMainActivity(appContext)
    }

    /** Re-open on the virtual display so scrcpy (Android 8.1) can type and tap again. */
    fun moveToVirtualSetupDisplay(context: Context) {
        val appContext = context.applicationContext
        RadioPreferences(appContext).setMp22UsePhysicalDisplay(false)
        startMainActivity(appContext)
    }

    fun isMp22StyleDualDisplay(context: Context): Boolean {
        return try {
            resolveMp22PhysicalDisplayId(loadDisplays(context.applicationContext)) != null
        } catch (_: Throwable) {
            false
        }
    }

    private fun mainActivityIntent(context: Context): Intent =
        Intent(context, MainActivity::class.java).apply {
            addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP,
            )
        }

    private fun mainActivityIntentForPhysicalDisplay(context: Context): Intent =
        Intent(context, MainActivity::class.java).apply {
            addFlags(PHYSICAL_LAUNCH_FLAGS)
        }

    private fun loadDisplays(context: Context): Array<Display> {
        val manager = context.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager
            ?: return emptyArray()
        return try {
            manager.displays ?: emptyArray()
        } catch (_: Throwable) {
            emptyArray()
        }
    }

    /**
     * MP22-style layout: Display 0 is virtual, Display 1 is the built-in panel.
     * Returns the physical display id to launch on, or null when this does not apply.
     */
    fun resolveMp22PhysicalDisplayId(displays: Array<Display>): Int? {
        if (displays.size < 2) return null
        val display0 = findDisplayById(displays, MP22_VIRTUAL_DISPLAY_ID) ?: return null
        val display1 = findDisplayById(displays, MP22_PHYSICAL_DISPLAY_ID) ?: return null
        if (!displayLooksVirtual(display0) || !displayLooksPhysical(display1)) {
            return null
        }
        return display1.displayId
    }

    fun findDisplayById(displays: Array<Display>, displayId: Int): Display? {
        for (display in displays) {
            if (display != null && display.displayId == displayId) {
                return display
            }
        }
        return null
    }

    private fun displayLooksVirtual(display: Display): Boolean {
        val name = display.name?.lowercase().orEmpty()
        return name.contains("virtual") || name.contains("defaultvirtualdisplay")
    }

    private fun displayLooksPhysical(display: Display): Boolean {
        val name = display.name?.lowercase().orEmpty()
        return name.contains("built") ||
            name.contains("screen") ||
            name.contains("lcd") ||
            name.contains("panel") ||
            name.contains("local")
    }

    private fun launchOnDisplay(context: Context, intent: Intent, displayId: Int) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val options = ActivityOptions.makeBasic()
            options.launchDisplayId = displayId
            context.startActivity(intent, options.toBundle())
        } else {
            context.startActivity(intent)
        }
    }

    private fun scheduleMp22PhysicalRetry(context: Context, displayId: Int) {
        Handler(Looper.getMainLooper()).postDelayed({
            try {
                Log.i(TAG, "Retrying MainActivity launch on display $displayId.")
                val retry = mainActivityIntentForPhysicalDisplay(context)
                launchOnDisplay(context, retry, displayId)
            } catch (e: Exception) {
                Log.e(TAG, "Delayed display $displayId launch failed", e)
            }
        }, MP22_RETRY_DELAY_MS)
    }

    private fun logDisplays(displays: Array<Display>) {
        if (displays.isEmpty()) {
            Log.i(TAG, "Display count=0")
            return
        }
        Log.i(TAG, "Display count=${displays.size}")
        val metrics = DisplayMetrics()
        for (display in displays) {
            if (display == null) continue
            try {
                @Suppress("DEPRECATION")
                display.getRealMetrics(metrics)
            } catch (_: Throwable) {
                metrics.widthPixels = 0
                metrics.heightPixels = 0
            }
            Log.i(
                TAG,
                "Display id=${display.displayId} name=${display.name} flags=${display.flags} " +
                    "state=${display.state} size=${metrics.widthPixels}x${metrics.heightPixels}",
            )
        }
    }
}
