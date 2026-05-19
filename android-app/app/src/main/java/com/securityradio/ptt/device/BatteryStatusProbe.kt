package com.securityradio.ptt.device

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager

/** Best-effort battery charge percentage for the status bar. */
object BatteryStatusProbe {

    /** Current charge as 0-100; falls back to the sticky battery broadcast, then 100. */
    fun percent(context: Context): Int {
        readFromBatteryManager(context)?.let { return it }
        return readFromStickyBroadcast(context) ?: 100
    }

    private fun readFromBatteryManager(context: Context): Int? {
        return try {
            val bm = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
                ?: return null
            bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY).takeIf { it in 0..100 }
        } catch (_: Exception) {
            null
        }
    }

    private fun readFromStickyBroadcast(context: Context): Int? {
        return try {
            val intent = context.registerReceiver(
                null,
                IntentFilter(Intent.ACTION_BATTERY_CHANGED),
            ) ?: return null
            val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
            if (level >= 0 && scale > 0) (level * 100 / scale) else null
        } catch (_: Exception) {
            null
        }
    }
}
