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

    /** Whether scan was left on. Persisted so it survives reboots / app updates. */
    fun isScanActive(): Boolean = prefs.getBoolean(KEY_SCAN_ACTIVE, false)

    fun setScanActive(active: Boolean) {
        prefs.edit().putBoolean(KEY_SCAN_ACTIVE, active).apply()
    }

    /**
     * Scanned side-channels, stored by lowercased NAME (not catalog index) so the
     * selection survives a catalog reorder across an app update. Returns an empty
     * set when nothing was saved.
     */
    fun getScanChannelNames(): Set<String> =
        prefs.getStringSet(KEY_SCAN_CHANNELS, emptySet())?.toSet() ?: emptySet()

    fun setScanChannelNames(names: Set<String>) {
        // Pass a fresh copy: SharedPreferences must not be handed a set it keeps a
        // live reference to (mutating it later corrupts the stored value).
        prefs.edit().putStringSet(KEY_SCAN_CHANNELS, HashSet(names)).apply()
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
    /**
     * Operator chose "don't show again" on the accessibility-service setup prompt. Used on radios
     * where the service is enabled out-of-band (e.g. via ADB during provisioning) but the platform
     * still reports it as off, so the prompt would otherwise reappear on every resume.
     */
    fun isAccessibilityPromptSuppressed(): Boolean =
        prefs.getBoolean(KEY_ACCESSIBILITY_PROMPT_SUPPRESSED, false)

    fun setAccessibilityPromptSuppressed(suppressed: Boolean) {
        prefs.edit().putBoolean(KEY_ACCESSIBILITY_PROMPT_SUPPRESSED, suppressed).apply()
    }

    /** Agency supervised wake phrase (default "hey ai"), synced from the channel catalog so the
     *  on-device wake-word gate knows what to listen for even before a fresh catalog fetch. */
    fun getAiWakeWord(): String =
        prefs.getString(KEY_AI_WAKE_WORD, DEFAULT_AI_WAKE_WORD)?.ifBlank { DEFAULT_AI_WAKE_WORD }
            ?: DEFAULT_AI_WAKE_WORD

    fun setAiWakeWord(word: String) {
        prefs.edit().putString(KEY_AI_WAKE_WORD, word.trim().ifBlank { DEFAULT_AI_WAKE_WORD }).apply()
    }

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

    /**
     * When on (and a stereo output is connected): play the home channel in the
     * left ear and scan channels in the right ear instead of mono-mixing them.
     */
    fun isStereoChannelSplitEnabled(): Boolean =
        prefs.getBoolean(KEY_STEREO_CHANNEL_SPLIT, DEFAULT_STEREO_CHANNEL_SPLIT)

    fun setStereoChannelSplitEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_STEREO_CHANNEL_SPLIT, enabled).apply()
    }

    /** Left-ear (main channel) volume for the stereo split. 1.0 = unchanged. Range [0, 2]. */
    fun getStereoLeftVolume(): Float =
        prefs.getFloat(KEY_STEREO_LEFT_VOLUME, DEFAULT_STEREO_VOLUME)
            .coerceIn(MIN_STEREO_VOLUME, MAX_STEREO_VOLUME)

    fun setStereoLeftVolume(volume: Float) {
        prefs.edit().putFloat(KEY_STEREO_LEFT_VOLUME, volume.coerceIn(MIN_STEREO_VOLUME, MAX_STEREO_VOLUME)).apply()
    }

    /** Right-ear (scan channels) volume for the stereo split. 1.0 = unchanged. Range [0, 2]. */
    fun getStereoRightVolume(): Float =
        prefs.getFloat(KEY_STEREO_RIGHT_VOLUME, DEFAULT_STEREO_VOLUME)
            .coerceIn(MIN_STEREO_VOLUME, MAX_STEREO_VOLUME)

    fun setStereoRightVolume(volume: Float) {
        prefs.edit().putFloat(KEY_STEREO_RIGHT_VOLUME, volume.coerceIn(MIN_STEREO_VOLUME, MAX_STEREO_VOLUME)).apply()
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

    /** Software gain multiplier applied to inbound (RX) PCM before playout, so a
     *  "low / far away" radio can be boosted. 1.0 = no change. Range [0.5, 4.0].
     *  Set locally or pushed over the air by an admin (apply_audio_settings). */
    fun getRxGainMultiplier(): Float =
        prefs.getFloat(KEY_RX_GAIN_MULTIPLIER, DEFAULT_RX_GAIN_MULTIPLIER)
            .coerceIn(MIN_RX_GAIN, MAX_RX_GAIN)

    fun setRxGainMultiplier(multiplier: Float) {
        prefs.edit().putFloat(
            KEY_RX_GAIN_MULTIPLIER,
            multiplier.coerceIn(MIN_RX_GAIN, MAX_RX_GAIN),
        ).apply()
    }

    /** Persisted dispatcher pages (JSON array), so the inbox survives reboots. */
    fun getStoredPagesJson(): String = prefs.getString(KEY_PAGES_JSON, "[]") ?: "[]"

    fun setStoredPagesJson(json: String) {
        prefs.edit().putString(KEY_PAGES_JSON, json).apply()
    }

    /** Highest page id this radio has already ingested (inbox de-dupe across boots). */
    fun getLastPageId(): Long = prefs.getLong(KEY_LAST_PAGE_ID, 0L)

    fun setLastPageId(id: Long) {
        prefs.edit().putLong(KEY_LAST_PAGE_ID, id).apply()
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

    // -------------------------------------------------------------------------
    // Server-pushed audio config (set by an admin in the Audio Lab → Apply live)
    // -------------------------------------------------------------------------

    /**
     * Saves the agency-wide audio config fetched from /v1/audio/config.
     * Calling this overrides any local mic-audio settings until [clearServerAudioConfig] is called.
     */
    fun setServerAudioConfig(
        agcEnabled: Boolean,
        noiseSuppression: Boolean,
        gainMultiplier: Float,
        bypassMicProcessing: Boolean,
    ) {
        prefs.edit()
            .putBoolean(KEY_SERVER_AGC_ENABLED, agcEnabled)
            .putBoolean(KEY_SERVER_NOISE_SUPPRESSION, noiseSuppression)
            .putFloat(KEY_SERVER_GAIN_MULTIPLIER, gainMultiplier.coerceIn(MIN_MIC_GAIN, MAX_MIC_GAIN))
            .putBoolean(KEY_SERVER_BYPASS_MIC_PROCESSING, bypassMicProcessing)
            .putBoolean(KEY_SERVER_CONFIG_SET, true)
            .apply()
    }

    /** When true the TX conditioner skips expander + makeup AGC and Android's
     *  hardware DSP effects are off — matches the bridge mic chain. */
    fun getServerBypassMicProcessing(): Boolean =
        prefs.getBoolean(KEY_SERVER_BYPASS_MIC_PROCESSING, false)

    /** True when a server-pushed config is stored and should take precedence over local prefs. */
    fun hasServerAudioConfig(): Boolean = prefs.getBoolean(KEY_SERVER_CONFIG_SET, false)

    fun getServerAgcEnabled(): Boolean = prefs.getBoolean(KEY_SERVER_AGC_ENABLED, DEFAULT_MIC_AUTO_GAIN)

    fun getServerNoiseSuppression(): Boolean = prefs.getBoolean(KEY_SERVER_NOISE_SUPPRESSION, DEFAULT_MIC_NOISE_SUPPRESSION)

    fun getServerGainMultiplier(): Float =
        // Default to 1.0 (no change) when the key is missing — distinct from the
        // local-prefs default of MAX_MIC_GAIN. A partial SharedPreferences flush
        // could leave KEY_SERVER_CONFIG_SET=true with KEY_SERVER_GAIN_MULTIPLIER
        // never written; defaulting to MAX there would blast every transmission
        // at 3× until the next successful server refresh.
        prefs.getFloat(KEY_SERVER_GAIN_MULTIPLIER, 1.0f)
            .coerceIn(MIN_MIC_GAIN, MAX_MIC_GAIN)

    /** Removes the server-pushed config; device falls back to local per-user settings. */
    fun clearServerAudioConfig() {
        prefs.edit()
            .remove(KEY_SERVER_AGC_ENABLED)
            .remove(KEY_SERVER_NOISE_SUPPRESSION)
            .remove(KEY_SERVER_GAIN_MULTIPLIER)
            .remove(KEY_SERVER_BYPASS_MIC_PROCESSING)
            .putBoolean(KEY_SERVER_CONFIG_SET, false)
            .apply()
    }

    companion object {
        const val MIN_MIC_GAIN: Float = 0.5f
        const val MAX_MIC_GAIN: Float = 3.0f
        const val DEFAULT_MIC_GAIN_MULTIPLIER: Float = MAX_MIC_GAIN
        const val MIN_RX_GAIN: Float = 0.5f
        const val MAX_RX_GAIN: Float = 4.0f
        const val DEFAULT_RX_GAIN_MULTIPLIER: Float = 1.0f
        const val DEFAULT_MIC_NOISE_SUPPRESSION: Boolean = false
        const val DEFAULT_MIC_AUTO_GAIN: Boolean = false
        const val DEFAULT_STEREO_CHANNEL_SPLIT: Boolean = false
        const val MIN_STEREO_VOLUME: Float = 0.0f
        const val MAX_STEREO_VOLUME: Float = 2.0f
        const val DEFAULT_STEREO_VOLUME: Float = 1.0f

        private const val PREFS_NAME = "security_radio_prefs"
        private const val KEY_THEME = "theme_mode"
        private const val KEY_VOICE_ANNOUNCE_TUNING = "voice_announce_tune"
        private const val KEY_SCAN_ACTIVE = "scan_active"
        private const val KEY_SCAN_CHANNELS = "scan_channels"
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
        private const val KEY_ACCESSIBILITY_PROMPT_SUPPRESSED = "accessibility_prompt_suppressed"
        private const val KEY_AI_WAKE_WORD = "ai_wake_word"
        const val DEFAULT_AI_WAKE_WORD = "hey ai"
        private const val KEY_MIC_NOISE_SUPPRESSION = "mic_noise_suppression"
        private const val KEY_MIC_AUTO_GAIN = "mic_auto_gain"
        private const val KEY_STEREO_CHANNEL_SPLIT = "stereo_channel_split"
        private const val KEY_STEREO_LEFT_VOLUME = "stereo_left_volume"
        private const val KEY_STEREO_RIGHT_VOLUME = "stereo_right_volume"
        private const val KEY_MIC_GAIN_MULTIPLIER = "mic_gain_multiplier"
        private const val KEY_RX_GAIN_MULTIPLIER = "rx_gain_multiplier"
        private const val KEY_PAGES_JSON = "page_messages_json"
        private const val KEY_LAST_PAGE_ID = "page_messages_last_id"
        private const val KEY_MP22_USE_PHYSICAL_DISPLAY = "mp22_use_physical_display"
        private const val DEFAULT_VOICE_ANNOUNCE = true
        // Server-pushed audio config
        private const val KEY_SERVER_CONFIG_SET = "server_audio_config_set"
        private const val KEY_SERVER_AGC_ENABLED = "server_agc_enabled"
        private const val KEY_SERVER_NOISE_SUPPRESSION = "server_noise_suppression"
        private const val KEY_SERVER_GAIN_MULTIPLIER = "server_gain_multiplier"
        private const val KEY_SERVER_BYPASS_MIC_PROCESSING = "server_bypass_mic_processing"
    }
}
