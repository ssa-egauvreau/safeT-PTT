package com.securityradio.ptt.device

import android.content.Context
import com.securityradio.ptt.presentation.ThemeMode

/**
 * Persists user-facing shell preferences (themes, etc.).
 */
class RadioPreferences(context: Context) {

    private val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun getThemeMode(): ThemeMode =
        prefs.getString(KEY_THEME, null)?.let { ThemeMode.entries.find { mode -> mode.name == it } } ?: ThemeMode.AUTO

    fun setThemeMode(mode: ThemeMode) {
        prefs.edit().putString(KEY_THEME, mode.name).apply()
    }

    fun isAnnounceChannelOnTuneEnabled(): Boolean =
        prefs.getBoolean(KEY_VOICE_ANNOUNCE_TUNING, DEFAULT_VOICE_ANNOUNCE)

    fun setAnnounceChannelOnTuneEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_VOICE_ANNOUNCE_TUNING, enabled).apply()
    }

    fun isP25ImbeDigitalVoiceEnabled(): Boolean =
        prefs.getBoolean(KEY_P25_IMBE_VOICE, DEFAULT_P25_IMBE_VOICE)

    fun setP25ImbeDigitalVoiceEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_P25_IMBE_VOICE, enabled).apply()
    }

    private companion object {
        const val PREFS_NAME = "security_radio_prefs"
        const val KEY_THEME = "theme_mode"
        const val KEY_VOICE_ANNOUNCE_TUNING = "voice_announce_tune"
        const val KEY_P25_IMBE_VOICE = "p25_imbe_digital_voice"
        const val DEFAULT_VOICE_ANNOUNCE = true
        const val DEFAULT_P25_IMBE_VOICE = false
    }
}
