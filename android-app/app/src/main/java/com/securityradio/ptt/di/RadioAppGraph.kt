package com.securityradio.ptt.di

import android.app.Application
import android.util.Log
import com.securityradio.ptt.BuildConfig
import com.securityradio.ptt.data.RadioChannelGateway
import com.securityradio.ptt.data.StubChannelRepository
import com.securityradio.ptt.data.remote.AuthApi
import com.securityradio.ptt.data.remote.ChannelsApi
import com.securityradio.ptt.data.remote.NetworkModule
import com.securityradio.ptt.data.remote.RadioApi
import com.securityradio.ptt.device.AppUpdater
import com.securityradio.ptt.device.AssetRadioUiSoundPlayer
import com.securityradio.ptt.device.AudioRecordPttCapture
import com.securityradio.ptt.device.MicCaptureConfig
import com.securityradio.ptt.device.PostDecodeChain
import com.securityradio.ptt.data.remote.AudioPostDecodeDto
import com.securityradio.ptt.device.ChannelSpeechHelper
import com.securityradio.ptt.device.ConnectivityMonitor
import com.securityradio.ptt.device.ExternalMicMonitor
import com.securityradio.ptt.device.CustomSoundDownloader
import com.securityradio.ptt.device.CustomSoundStore
import com.securityradio.ptt.device.HardwareMappingRepository
import com.securityradio.ptt.device.InboundVoicePlayer
import com.securityradio.ptt.device.LastRxAudioRecorder
import com.securityradio.ptt.device.RxMessageHistory
import com.securityradio.ptt.device.LocalUnitIdentifier
import com.securityradio.ptt.device.LocationReporter
import com.securityradio.ptt.device.P25AmbeNative
import com.securityradio.ptt.device.P25ImbeNative
import com.securityradio.ptt.device.PttHapticFeedback
import com.securityradio.ptt.device.PttMicCapture
import com.securityradio.ptt.device.RadioPreferences
import com.securityradio.ptt.device.RadioUiSoundPlayer
import com.securityradio.ptt.device.ScanVoiceListenTransport
import com.securityradio.ptt.device.ServerReachabilityMonitor
import com.securityradio.ptt.device.VoiceRelayTransport
import com.securityradio.ptt.domain.ChannelRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

class RadioAppGraph(val application: Application) {

    init {
        P25ImbeNative.tryLoadLibrary()
        P25AmbeNative.tryLoadLibrary()
    }

    val radioPreferences = RadioPreferences(application)

    /** Background scope for fire-and-forget network tasks (audio config refresh, etc.). */
    private val bgScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** Over-the-air APK self-updater for the sideloaded fleet. */
    val appUpdater: AppUpdater = AppUpdater(
        context = application,
        httpApiBaseUrl = BuildConfig.API_BASE_URL,
        currentVersionCode = BuildConfig.VERSION_CODE.toLong(),
    )

    val pttHapticFeedback = PttHapticFeedback(application)

    val speechHelper = ChannelSpeechHelper(application, radioPreferences)

    val hardwareMappingRepository = HardwareMappingRepository(application, radioPreferences)

    val customSoundStore = CustomSoundStore(application)

    val soundPlayer: RadioUiSoundPlayer = AssetRadioUiSoundPlayer(application, customSoundStore)

    val localUnitIdentifier: LocalUnitIdentifier = LocalUnitIdentifier(application)

    /** Device internet up/down feed for the lost-link alert. */
    val connectivityMonitor: ConnectivityMonitor = ConnectivityMonitor(application).also { it.start() }

    /** Backend reachability feed; trips when API calls keep failing even though the OS says we're online. */
    val serverReachabilityMonitor: ServerReachabilityMonitor = ServerReachabilityMonitor()

    val externalMicMonitor: ExternalMicMonitor = ExternalMicMonitor(application).also { it.start() }

    /** Watches the output route for Bluetooth (keep link warm) and stereo capability (channel split). */
    val externalAudioOutputMonitor: ExternalAudioOutputMonitor =
        ExternalAudioOutputMonitor(application).also { it.start() }

    val rxMessageHistory = RxMessageHistory()

    val lastRxAudioRecorder = LastRxAudioRecorder(messageHistory = rxMessageHistory)

    private val _scanRxActivity = MutableSharedFlow<String>(extraBufferCapacity = 16)

    /** Emits the scan channel label whenever scan listen sockets deliver voice. */
    val scanRxActivity: SharedFlow<String> = _scanRxActivity.asSharedFlow()

    private val inboundVoicePlayer = InboundVoicePlayer(
        lastRxRecorder = lastRxAudioRecorder,
        // Read on every inbound chunk so an admin-pushed RX-gain change (or a
        // local volume setting) takes effect live without rebuilding the player.
        listenGainProvider = { radioPreferences.getRxGainMultiplier() },
        onScanRxActivity = { channel -> _scanRxActivity.tryEmit(channel) },
        // Split home-left / scan-right only when the user enabled it AND a
        // stereo-capable output is actually connected (a mono speaker has no
        // second ear). Read live so toggling the setting or plugging in a
        // headset takes effect on the next inbound chunk without a rebuild.
        stereoSplitProvider = {
            radioPreferences.isStereoChannelSplitEnabled() &&
                externalAudioOutputMonitor.stereoCapable.value
        },
        // Hold the AudioTrack warm while a Bluetooth output is connected so the
        // link doesn't sleep and clip the start of the next transmission.
        keepWarmProvider = { externalAudioOutputMonitor.bluetoothConnected.value },
    )

    private val authTokenProvider: () -> String = { radioPreferences.getAuthToken() }

    /**
     * Legacy handset key when not signed in. After login, [authTokenProvider] is used instead.
     */
    private val radioApiKeyProvider: () -> String = {
        if (radioPreferences.getAuthToken().isNotBlank()) {
            ""
        } else {
            radioPreferences.getAgencyRadioKey().ifBlank { BuildConfig.RADIO_API_KEY }
        }
    }

    private val _authExpired = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    /**
     * Emits when the server rejects the stored token (HTTP 401). The UI should
     * sign out and return to the login screen instead of failing silently.
     */
    val authExpired: SharedFlow<Unit> = _authExpired.asSharedFlow()

    val authApi: AuthApi = NetworkModule.authApi(BuildConfig.API_BASE_URL)

    /** Pulls the agency's custom radio tones; refreshed at startup and on key change. */
    val customSoundDownloader = CustomSoundDownloader(
        httpApiBaseUrl = BuildConfig.API_BASE_URL,
        authTokenProvider = authTokenProvider,
        apiKeyProvider = radioApiKeyProvider,
        store = customSoundStore,
    )

    /**
     * Latest agency post-decode processor, or null when no shaping is in
     * effect. Rebuilt whenever [refreshAudioConfigAsync] fetches a new
     * config and a non-null `postDecode` block arrives. Both voice
     * transports read it through their `postDecodeProcessorProvider`
     * closure so the rebuild swaps live without recreating the transport.
     */
    private val postDecodeProcessor =
        java.util.concurrent.atomic.AtomicReference<PostDecodeChain.Processor?>(null)

    /**
     * Latest raw post-decode config, or null when no shaping/cue is in effect.
     * Held separately from [postDecodeProcessor] because the transport needs
     * the config even when there is no DSP processor to build (e.g. a
     * roger-beep-only config, which the cue path consumes directly): it drives
     * the wideband (Opus) routing decision and the end-of-TX cue synthesis on
     * `air_released`. Rebuilt alongside the processor by [refreshAudioConfigAsync].
     */
    private val postDecodeConfig =
        java.util.concurrent.atomic.AtomicReference<PostDecodeChain.Config?>(null)

    val voiceRelay: VoiceRelayTransport = VoiceRelayTransport(
        httpApiBaseUrl = BuildConfig.API_BASE_URL,
        authTokenProvider = authTokenProvider,
        apiKeyProvider = radioApiKeyProvider,
        inbound = inboundVoicePlayer,
        bypassMicProcessingProvider = {
            radioPreferences.hasServerAudioConfig() &&
                radioPreferences.getServerBypassMicProcessing()
        },
        postDecodeProcessorProvider = { postDecodeProcessor.get() },
        postDecodeConfigProvider = { postDecodeConfig.get() },
    )

    val scanVoiceListen: ScanVoiceListenTransport = ScanVoiceListenTransport(
        httpApiBaseUrl = BuildConfig.API_BASE_URL,
        authTokenProvider = authTokenProvider,
        apiKeyProvider = radioApiKeyProvider,
        inbound = inboundVoicePlayer,
        postDecodeProcessorProvider = { postDecodeProcessor.get() },
    )

    /** Sidetone off; PCM also flows to [voiceRelay]. */
    val pttMicCapture: PttMicCapture = AudioRecordPttCapture(
        enableSidetone = false,
        streamingSink = voiceRelay,
        // Server-pushed config (from Audio Lab → "Apply live") takes precedence over
        // per-device settings when an admin has set it.  Falls back to local user prefs
        // if no server config has been fetched yet.
        configProvider = {
            if (radioPreferences.hasServerAudioConfig()) {
                // bypassMicProcessing overrides the hardware DSP flags to off
                // regardless of agcEnabled / noiseSuppression — the bridge
                // sounds clean because nothing processes its mic input.
                val bypass = radioPreferences.getServerBypassMicProcessing()
                MicCaptureConfig(
                    noiseSuppression = !bypass && radioPreferences.getServerNoiseSuppression(),
                    autoGain = !bypass && radioPreferences.getServerAgcEnabled(),
                    gainMultiplier = radioPreferences.getServerGainMultiplier(),
                )
            } else {
                MicCaptureConfig(
                    noiseSuppression = radioPreferences.isNoiseSuppressionEnabled(),
                    autoGain = radioPreferences.isMicAutoGainEnabled(),
                    gainMultiplier = radioPreferences.getMicGainMultiplier(),
                )
            }
        },
    )

    private val stubChannelRepository = StubChannelRepository()

    val channelsApi: ChannelsApi = NetworkModule.channelsApi(
        baseUrl = BuildConfig.API_BASE_URL,
        authTokenProvider = authTokenProvider,
        apiKeyProvider = radioApiKeyProvider,
        onUnauthorized = { _authExpired.tryEmit(Unit) },
    )

    val radioApi: RadioApi = NetworkModule.radioApi(
        baseUrl = BuildConfig.API_BASE_URL,
        authTokenProvider = authTokenProvider,
        apiKeyProvider = radioApiKeyProvider,
        onUnauthorized = { _authExpired.tryEmit(Unit) },
    )

    /**
     * Fetches the agency-wide audio config from the server and persists it so
     * [pttMicCapture]'s configProvider picks it up on the next PTT key-down.
     * Skips the call when there's no auth session yet — the endpoint requires an
     * agency member, so calling it pre-login would just produce a 401 we'd
     * silently swallow. Real failures (deserialization, server 5xx, persistent
     * network outages) are logged at warn level so they're visible in production
     * logcat.
     */
    fun refreshAudioConfigAsync() {
        if (!radioPreferences.isLoggedIn()) {
            return
        }
        bgScope.launch {
            try {
                val response = radioApi.audioConfig()
                val cfg = response.config
                if (cfg != null) {
                    radioPreferences.setServerAudioConfig(
                        agcEnabled = cfg.agcEnabled,
                        noiseSuppression = cfg.noiseSuppression,
                        gainMultiplier = cfg.gainMultiplier,
                        bypassMicProcessing = cfg.bypassMicProcessing,
                    )
                    // Rebuild the post-decode processor + raw config under the
                    // new config. Server-side `derivePostDecodeBlock` already
                    // returns `null` when nothing is in effect; a non-no-op
                    // Config gets a processor, while the raw config is always
                    // cached so the cue path (roger beep / squelch tail) and
                    // the wideband routing can read it even when there is no
                    // DSP processor to build.
                    val newConfig = cfg.postDecode?.toConfigOrNull()
                    postDecodeConfig.set(newConfig)
                    val newProcessor =
                        newConfig?.let { if (it.isNoOp()) null else PostDecodeChain.Processor(it) }
                    postDecodeProcessor.set(newProcessor)
                }
                // If the server has no config (cfg == null), leave whatever was cached — don't
                // clear it so the device keeps working if the server is momentarily unreachable.
            } catch (e: Exception) {
                Log.w("RadioAppGraph", "Audio config refresh failed: ${e.message}")
            }
        }
    }

    fun onAuthSessionChanged() {
        voiceRelay.reconnect()
        customSoundDownloader.refreshAsync()
        refreshAudioConfigAsync()
    }

    fun signOut() {
        radioPreferences.clearAuthSession()
        // Drop any agency-pushed audio config so a re-login under a different
        // agency doesn't transmit the previous agency's gain/noise settings on
        // the first PTT before refreshAudioConfigAsync() completes.
        radioPreferences.clearServerAudioConfig()
        voiceRelay.disconnect()
        scanVoiceListen.disconnect()
    }

    val locationReporter: LocationReporter = LocationReporter(application, radioApi)

    val channelRepository: ChannelRepository = RadioChannelGateway(
        api = channelsApi,
        localFallback = stubChannelRepository,
        serverReachabilityMonitor = serverReachabilityMonitor,
    )

    init {
        // Pull this agency's custom tones in the background on startup.
        customSoundDownloader.refreshAsync()
        // Pull the admin-pushed audio config (if any) so the next PTT uses it.
        refreshAudioConfigAsync()
    }
}

/**
 * Convert the wire DTO from `/v1/audio/config` into the strongly-typed
 * [PostDecodeChain.Config] the processor consumes. Returns null when the
 * DTO has no upsample mode field — a guard against an entirely-empty
 * object slipping past Gson's defaults. Optional fields fall back to the
 * Config dataclass's own defaults so server-side omissions match the
 * documented "feature off" semantics.
 */
private fun AudioPostDecodeDto.toConfigOrNull(): PostDecodeChain.Config? {
    val mode = PostDecodeChain.UpsampleMode.fromString(upsampleMode)
    return PostDecodeChain.Config(
        upsampleMode = mode,
        hpfEnabled = hpfEnabled ?: false,
        hpfHz = hpfHz ?: 250f,
        lpfEnabled = lpfEnabled ?: false,
        lpfHz = lpfHz ?: 3300f,
        lowShelfEnabled = lowShelfEnabled ?: false,
        lowShelfHz = lowShelfHz ?: 200f,
        lowShelfDb = lowShelfDb ?: 0f,
        highShelfEnabled = highShelfEnabled ?: false,
        highShelfHz = highShelfHz ?: 2500f,
        highShelfDb = highShelfDb ?: 0f,
        presenceEnabled = presenceEnabled ?: false,
        presenceHz = presenceHz ?: 2200f,
        presenceDb = presenceDb ?: 0f,
        presenceQ = presenceQ ?: 1.0f,
        saturationAmount = saturationAmount ?: 0f,
        wideband = wideband ?: false,
        compressorEnabled = compressorEnabled ?: false,
        compressorThresholdDb = compressorThresholdDb ?: -24f,
        compressorRatio = compressorRatio ?: 3.0f,
        compressorAttackMs = compressorAttackMs ?: 5f,
        compressorReleaseMs = compressorReleaseMs ?: 80f,
        compressorMakeupDb = compressorMakeupDb ?: 0f,
        rogerBeepEnabled = rogerBeepEnabled ?: false,
        rogerBeepHz = rogerBeepHz ?: 1200f,
        rogerBeepMs = rogerBeepMs ?: 120f,
        squelchTailEnabled = squelchTailEnabled ?: false,
        squelchTailMs = squelchTailMs ?: 90f,
        squelchTailLevel = squelchTailLevel ?: 0.05f,
    )
}
