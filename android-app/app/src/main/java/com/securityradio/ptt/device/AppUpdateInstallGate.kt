package com.securityradio.ptt.device

import android.os.SystemClock

/**
 * Shared latch between [AppUpdater] and [InricoHardwareService].
 *
 * Touchless radios (e.g. IRC590) can't tap Android's system "Install" dialog, and
 * the PTT button uses a proprietary keycode the installer ignores. So when we
 * deliberately launch an update install we "arm" this gate; the accessibility
 * service then auto-clicks the installer's confirm button, but ONLY while armed,
 * so it never clicks through install dialogs we didn't trigger.
 */
object AppUpdateInstallGate {

    @Volatile
    private var activeUntilMs = 0L

    fun arm() {
        activeUntilMs = SystemClock.elapsedRealtime() + ARM_WINDOW_MS
    }

    fun isActive(): Boolean = SystemClock.elapsedRealtime() < activeUntilMs

    fun disarm() {
        activeUntilMs = 0L
    }

    private const val ARM_WINDOW_MS = 120_000L
}
