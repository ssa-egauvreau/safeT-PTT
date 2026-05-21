package com.securityradio.ptt.device

import android.content.Context
import com.securityradio.ptt.presentation.ThemeMode

/**
 * Persists user-facing shell preferences (themes, etc.).
 */
class RadioPreferences(context: Context) {

    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

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

    /**
     * On-device agency radio key. Binds this handset to one agency (tenant) on
     * the server. Blank means fall back to the key baked in at build time.
     */
    fun getAgencyRadioKey(): String =
        prefs.getString(KEY_AGENCY_RADIO_KEY, "").orEmpty()

    fun setAgencyRadioKey(key: String) {
        prefs.edit().putString(KEY_AGENCY_RADIO_KEY, key.trim()).apply()
    }

    fun getDeviceProfilePreference(): DeviceProfilePreference =
        prefs.getString(KEY_DEVICE_PROFILE, null)?.let { stored ->
            DeviceProfilePreference.entries.find { it.name == stored }
        } ?: DeviceProfilePreference.AUTO

    fun setDeviceProfilePreference(preference: DeviceProfilePreference) {
        prefs.edit().putString(KEY_DEVICE_PROFILE, preference.name).apply()
    }

    fun getAuthToken(): String = prefs.getString(KEY_AUTH_TOKEN, "").orEmpty()

    fun setAuthToken(token: String) {
        prefs.edit()
            .putString(KEY_AUTH_TOKEN, token.trim())
            .putLong(KEY_SESSION_INSTALL_TOKEN, currentInstallToken())
            .apply()
    }

    fun clearAuthSession() {
        prefs.edit()
            .remove(KEY_AUTH_TOKEN)
            .remove(KEY_SESSION_USERNAME)
            .remove(KEY_SESSION_AGENCY_SLUG)
            .remove(KEY_SESSION_AGENCY_NAME)
            .remove(KEY_SESSION_UNIT_ID)
            .remove(KEY_SESSION_DISPLAY_NAME)
            .remove(KEY_SESSION_INSTALL_TOKEN)
            .apply()
    }

    /**
     * Installing a new build keeps app data, so a stale session would resume
     * silently. Drop the session when the app's install timestamp no longer
     * matches the one saved at sign-in; a plain device reboot leaves it intact.
     */
    fun clearSessionIfReinstalled() {
        if (getAuthToken().isBlank()) return
        if (prefs.getLong(KEY_SESSION_INSTALL_TOKEN, 0L) != currentInstallToken()) {
            clearAuthSession()
        }
    }

    /** Timestamp of the last package install/update — changes on every new build. */
    @Suppress("DEPRECATION")
    private fun currentInstallToken(): Long = try {
        appContext.packageManager.getPackageInfo(appContext.packageName, 0).lastUpdateTime
    } catch (_: Exception) {
        0L
    }

    /** Unit id from the signed-in account (voice + presence + air must match this). */
    fun getSessionUnitId(): String = prefs.getString(KEY_SESSION_UNIT_ID, "").orEmpty()

    fun setSessionUnitId(unitId: String) {
        prefs.edit().putString(KEY_SESSION_UNIT_ID, unitId.trim().uppercase()).apply()
    }

    fun getSessionDisplayName(): String = prefs.getString(KEY_SESSION_DISPLAY_NAME, "").orEmpty()

    fun setSessionDisplayName(name: String) {
        prefs.edit().putString(KEY_SESSION_DISPLAY_NAME, name.trim()).apply()
    }

    /** Screen flipped 180° (IRC590 day/night key long-press). */
    fun isDisplayRotated180(): Boolean = prefs.getBoolean(KEY_DISPLAY_ROTATED_180, false)

    fun setDisplayRotated180(rotated: Boolean) {
        prefs.edit().putBoolean(KEY_DISPLAY_ROTATED_180, rotated).apply()
    }

    fun getSessionAgencySlug(): String = prefs.getString(KEY_SESSION_AGENCY_SLUG, "").orEmpty()

    fun setSessionAgencySlug(slug: String) {
        prefs.edit().putString(KEY_SESSION_AGENCY_SLUG, slug.trim().lowercase()).apply()
    }

    fun getSessionAgencyName(): String = prefs.getString(KEY_SESSION_AGENCY_NAME, "").orEmpty()

    fun setSessionAgencyName(name: String) {
        prefs.edit().putString(KEY_SESSION_AGENCY_NAME, name.trim()).apply()
    }

    fun getSessionUsername(): String = prefs.getString(KEY_SESSION_USERNAME, "").orEmpty()

    fun setSessionUsername(username: String) {
        prefs.edit().putString(KEY_SESSION_USERNAME, username.trim()).apply()
    }

    fun isLoggedIn(): Boolean = getAuthToken().isNotBlank()

    /** Bind Android's NoiseSuppressor audio effect to the mic capture session. */
    fun isNoiseSuppressionEnabled(): Boolean =
        prefs.getBoolean(KEY_MIC_NOISE_SUPPRESSION, DEFAULT_MIC_NOISE_SUPPRESSION)

    fun setNoiseSuppressionEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_MIC_NOISE_SUPPRESSION, enabled).apply()
    }

    /** When on: hand mic levelling to Android's AutomaticGainControl; manual gain ignored. */
    fun isMicAutoGainEnabled(): Boolean =
        prefs.getBoolean(KEY_MIC_AUTO_GAIN, DEFAULT_MIC_AUTO_GAIN)

    fun setMicAutoGainEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_MIC_AUTO_GAIN, enabled).apply()
    }

    /** Software gain multiplier applied to outgoing PCM. 1.0 = no change. Range [0.5, 3.0]. */
    fun getMicGainMultiplier(): Float =
        prefs.getFloat(KEY_MIC_GAIN_MULTIPLIER, DEFAULT_MIC_GAIN_MULTIPLIER)
            .coerceIn(MIN_MIC_GAIN, MAX_MIC_GAIN)

    fun setMicGainMultiplier(multiplier: Float) {
        prefs.edit().putFloat(
            KEY_MIC_GAIN_MULTIPLIER,
            multiplier.coerceIn(MIN_MIC_GAIN, MAX_MIC_GAIN),
        ).apply()
    }

    /**
     * MP22 dual-display: false = virtual Display 0 (PC/scrcpy can type); true = physical Display 1
     * (hardware keys). IRC590 and normal devices ignore this.
     */
    fun isMp22UsePhysicalDisplay(): Boolean =
        prefs.getBoolean(KEY_MP22_USE_PHYSICAL_DISPLAY, true)

    fun setMp22UsePhysicalDisplay(usePhysical: Boolean) {
        prefs.edit().putBoolean(KEY_MP22_USE_PHYSICAL_DISPLAY, usePhysical).apply()
    }

    companion object {
        const val MIN_MIC_GAIN: Float = 0.5f
        const val MAX_MIC_GAIN: Float = 3.0f
        const val DEFAULT_MIC_GAIN_MULTIPLIER: Float = 1.0f
        const val DEFAULT_MIC_NOISE_SUPPRESSION: Boolean = true
        const val DEFAULT_MIC_AUTO_GAIN: Boolean = true

        private const val PREFS_NAME = "security_radio_prefs"
        private const val KEY_THEME = "theme_mode"
        private const val KEY_VOICE_ANNOUNCE_TUNING = "voice_announce_tune"
        private const val KEY_AGENCY_RADIO_KEY = "agency_radio_key"
        private const val KEY_DEVICE_PROFILE = "device_profile_preference"
        private const val KEY_AUTH_TOKEN = "auth_token"
        private const val KEY_SESSION_AGENCY_SLUG = "session_agency_slug"
        private const val KEY_SESSION_AGENCY_NAME = "session_agency_name"
        private const val KEY_SESSION_USERNAME = "session_username"
        private const val KEY_SESSION_UNIT_ID = "session_unit_id"
        private const val KEY_SESSION_DISPLAY_NAME = "session_display_name"
        private const val KEY_SESSION_INSTALL_TOKEN = "session_install_token"
        private const val KEY_DISPLAY_ROTATED_180 = "display_rotated_180"
        private const val KEY_MIC_NOISE_SUPPRESSION = "mic_noise_suppression"
        private const val KEY_MIC_AUTO_GAIN = "mic_auto_gain"
        private const val KEY_MIC_GAIN_MULTIPLIER = "mic_gain_multiplier"
        private const val KEY_MP22_USE_PHYSICAL_DISPLAY = "mp22_use_physical_display"
        private const val DEFAULT_VOICE_ANNOUNCE = true
    }
}
