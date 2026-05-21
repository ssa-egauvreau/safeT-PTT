package com.securityradio.ptt

import android.app.Activity
import android.content.Context
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.DisplayMetrics
import android.util.Log
import android.view.Display
import android.view.InputDevice
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import com.securityradio.ptt.BuildConfig
import com.securityradio.ptt.device.RadioPreferences

/**
 * Logs display/input routing on MP22-style dual-display firmware and mitigates focus flags
 * that can block touch on the physical panel.
 */
object Mp22DisplayInputDiagnostics {

    const val TAG = "SafeTInputDebug"

    private const val TOUCH_PROBE_DELAY_MS = 5_000L

    @Volatile
    private var receivedTouchEvent = false

    @Volatile
    private var touchWarningEmitted = false

    fun resetTouchProbe() {
        receivedTouchEvent = false
        touchWarningEmitted = false
    }

    fun setup(activity: Activity, onTouchNotReachable: () -> Unit) {
        if (!DisplayRouter.isMp22StyleDualDisplay(activity)) return
        resetTouchProbe()
        try {
            val displayId = currentActivityDisplayId(activity)
            Log.i(TAG, "MainActivity running on displayId=$displayId")
            logAllDisplays(activity)
            logInputDevices()

            clearNonInteractiveWindowFlags(activity)
            attachRootTouchListener(activity)

            Handler(Looper.getMainLooper()).postDelayed({
                if (!receivedTouchEvent && shouldWarnTouchNotReachable(activity, displayId)) {
                    emitTouchRoutingWarning(onTouchNotReachable)
                }
            }, TOUCH_PROBE_DELAY_MS)
        } catch (e: Exception) {
            Log.e(TAG, "Input/display diagnostics failed", e)
        }
    }

    /** Call from [Activity.onTouchEvent] so touches are counted even if the decor listener misses them. */
    fun recordTouchEvent(event: MotionEvent) {
        receivedTouchEvent = true
        if (BuildConfig.DEBUG) {
            Log.i(
                TAG,
                "Touch received: action=${event.actionMasked} x=${event.x} y=${event.y} " +
                    "rawX=${event.rawX} rawY=${event.rawY} source=${event.source}",
            )
        }
    }

    private fun shouldWarnTouchNotReachable(activity: Activity, launchDisplayId: Int): Boolean {
        val onPhysical = launchDisplayId == DisplayRouter.MP22_PHYSICAL_DISPLAY_ID
        val prefsPhysical = RadioPreferences(activity.applicationContext).isMp22UsePhysicalDisplay()
        return onPhysical || prefsPhysical
    }

    private fun emitTouchRoutingWarning(onTouchNotReachable: () -> Unit) {
        if (touchWarningEmitted) return
        touchWarningEmitted = true
        Log.w(
            TAG,
            "No touch events received after launch. SafeT may be visible on the physical " +
                "display but touch input is still routed to the virtual display.",
        )
        onTouchNotReachable()
    }

    private fun clearNonInteractiveWindowFlags(activity: Activity) {
        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE)
        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE)
    }

    private fun attachRootTouchListener(activity: Activity) {
        val root = activity.window?.decorView ?: return
        root.isFocusableInTouchMode = true
        root.requestFocus()
        root.setOnTouchListener { _, event ->
            recordTouchEvent(event)
            false
        }
    }

    private fun currentActivityDisplayId(activity: Activity): Int {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            activity.display?.displayId ?: Display.DEFAULT_DISPLAY
        } else {
            @Suppress("DEPRECATION")
            activity.windowManager.defaultDisplay?.displayId ?: Display.DEFAULT_DISPLAY
        }
    }

    private fun logAllDisplays(context: Context) {
        try {
            val manager = context.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager
            val displays = manager?.displays
            if (displays == null) {
                Log.i(TAG, "DisplayManager.getDisplays(): null")
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
        } catch (e: Exception) {
            Log.e(TAG, "Failed to log displays", e)
        }
    }

    private fun logInputDevices() {
        try {
            val ids = InputDevice.getDeviceIds()
            Log.i(TAG, "Input device count=${ids.size}")
            for (id in ids) {
                val device = InputDevice.getDevice(id) ?: continue
                val touchscreen =
                    device.sources and InputDevice.SOURCE_TOUCHSCREEN == InputDevice.SOURCE_TOUCHSCREEN
                Log.i(
                    TAG,
                    "InputDevice id=$id name=${device.name} descriptor=${device.descriptor} " +
                        "sources=${device.sources} touchscreen=$touchscreen " +
                        "keyboardType=${device.keyboardType}",
                )
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to log input devices", e)
        }
    }
}
