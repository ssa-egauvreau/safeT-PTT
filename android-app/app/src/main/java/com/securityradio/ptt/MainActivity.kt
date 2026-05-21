package com.securityradio.ptt

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.Display
import android.provider.Settings
import android.util.Log
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.securityradio.ptt.device.HardwareAction
import com.securityradio.ptt.device.HardwareButtonEvent
import com.securityradio.ptt.device.HardwareButtonRelay
import com.securityradio.ptt.device.HardwareMappingRepository
import com.securityradio.ptt.device.InricoHardwareService
import com.securityradio.ptt.device.RadioPresenceService
import com.securityradio.ptt.presentation.LoginViewModel
import com.securityradio.ptt.presentation.LoginViewModelFactory
import com.securityradio.ptt.presentation.RadioUiEvent
import com.securityradio.ptt.presentation.RadioViewModel
import com.securityradio.ptt.presentation.RadioViewModelFactory
import com.securityradio.ptt.ui.LoginScreen
import com.securityradio.ptt.ui.RadioShell
import com.securityradio.ptt.ui.theme.RadioTheme

class MainActivity : ComponentActivity() {

    private var radioViewModel: RadioViewModel? = null
    private lateinit var repository: HardwareMappingRepository
    private lateinit var appGraph: com.securityradio.ptt.di.RadioAppGraph
    /**
     * eventTime (ms) of the last volume-knob ACTION_DOWN / ACTION_UP we forwarded
     * to super. The TM7+'s rotary volume knob fires several KEYCODE_VOLUME_UP / _DOWN
     * events per single detent click; without debouncing the OS sees the burst as a
     * "key held" gesture and fast-scrolls to the rail on one click. Separate
     * timestamps for DOWN and UP so the matching release for a real press isn't
     * accidentally dropped inside the DOWN window.
     */
    private var lastVolumeKnobDownAtMs: Long = 0L
    private var lastVolumeKnobUpAtMs: Long = 0L

    private val micPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        radioViewModel?.onMicPermissionResult(granted)
        checkAllPermissions()
    }

    private val notificationsPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) {
        RadioPresenceService.start(this)
        checkAllPermissions()
    }

    private val locationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { result ->
        val granted = result[Manifest.permission.ACCESS_FINE_LOCATION] == true ||
            result[Manifest.permission.ACCESS_COARSE_LOCATION] == true
        radioViewModel?.onLocationPermissionResult(granted)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        runCatching { enableEdgeToEdge() }.onFailure {
            Log.w("MainActivity", "enableEdgeToEdge unsupported; continuing without edge-to-edge", it)
        }
        appGraph = (application as RadioApplication).graph
        repository = appGraph.hardwareMappingRepository
        // A new build from Android Studio keeps app data; drop any session that
        // predates this install so it doesn't silently resume.
        appGraph.radioPreferences.clearSessionIfReinstalled()

        setContent {
            RadioTheme {
                var showRadio by remember { mutableStateOf(appGraph.radioPreferences.isLoggedIn()) }
                var sessionExpiredNotice by remember { mutableStateOf(false) }

                if (!showRadio) {
                    val loginVm: LoginViewModel = viewModel(factory = LoginViewModelFactory(appGraph))
                    LoginScreen(
                        viewModel = loginVm,
                        notice = if (sessionExpiredNotice) {
                            "Your session ended on the server. Please sign in again."
                        } else {
                            null
                        },
                        onSignedIn = {
                            sessionExpiredNotice = false
                            showRadio = true
                        },
                    )
                } else {
                    val radioVm: RadioViewModel = viewModel(factory = RadioViewModelFactory(appGraph))
                    LaunchedEffect(radioVm) {
                        radioViewModel = radioVm
                    }
                    val state by radioVm.uiState.collectAsStateWithLifecycle()

                    LaunchedEffect(Unit) {
                        checkAllPermissions()
                    }

                    LaunchedEffect(radioVm) {
                        radioVm.wakeUiSignals.collect {
                            bringRadioToForeground()
                        }
                    }

                    LaunchedEffect(Unit) {
                        appGraph.authExpired.collect {
                            appGraph.signOut()
                            radioViewModel = null
                            sessionExpiredNotice = true
                            showRadio = false
                        }
                    }

                    RadioShell(
                        state = state,
                        onEvent = { event ->
                            when (event) {
                                RadioUiEvent.RequestAudioPermission -> {
                                    micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                                }
                                RadioUiEvent.RequestLocationPermission -> {
                                    locationPermissionLauncher.launch(
                                        arrayOf(
                                            Manifest.permission.ACCESS_FINE_LOCATION,
                                            Manifest.permission.ACCESS_COARSE_LOCATION,
                                        ),
                                    )
                                }
                                RadioUiEvent.OpenGpsSettings -> openGpsSettings()
                                RadioUiEvent.OpenLocationSettings -> openAppSettings()
                                RadioUiEvent.RequestIgnoreBatteryOptimizations -> requestIgnoreBatteryOptimizations()
                                RadioUiEvent.OpenAccessibilitySettings -> {
                                    val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                                    startActivity(intent)
                                }
                                RadioUiEvent.RequestOverlayPermission -> requestOverlayPermission()
                                RadioUiEvent.SignOut -> {
                                    appGraph.signOut()
                                    radioViewModel = null
                                    showRadio = false
                                }
                                else -> radioVm.onEvent(event)
                            }
                        },
                        onRequestMicPermission = {
                            radioVm.playUiMenuSound()
                            micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                        },
                    )
                }
            }
        }

        RadioPresenceService.start(this)
    }

    override fun onStart() {
        super.onStart()
        radioViewModel?.setMainRadioScreenVisible(true)
        reportMp22DisplayToViewModel()
    }

    override fun onStop() {
        radioViewModel?.setMainRadioScreenVisible(false)
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        checkAllPermissions()
        radioViewModel?.onOverlayPermissionResult(canDrawOverlays())
        reportMp22DisplayToViewModel()
    }

    private fun reportMp22DisplayToViewModel() {
        val displayId =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                display?.displayId ?: Display.DEFAULT_DISPLAY
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                @Suppress("DEPRECATION")
                windowManager.defaultDisplay?.displayId ?: Display.DEFAULT_DISPLAY
            } else {
                Display.DEFAULT_DISPLAY
            }
        radioViewModel?.refreshMp22DisplayState(displayId)
    }

    private fun bringRadioToForeground() {
        DisplayRouter.startMainActivity(this)
    }

    private fun requestIgnoreBatteryOptimizations() {
        try {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:${packageName}")
            }
            startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            try {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            } catch (_: ActivityNotFoundException) {
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.fromParts("package", packageName, null)
                })
            }
        }
    }

    private fun checkAllPermissions() {
        val audioGranted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.RECORD_AUDIO,
        ) == PackageManager.PERMISSION_GRANTED

        val accessibilityEnabled = isAccessibilityServiceEnabled(this, InricoHardwareService::class.java)

        radioViewModel?.onMicPermissionResult(audioGranted)
        val locationGranted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.ACCESS_FINE_LOCATION,
        ) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.ACCESS_COARSE_LOCATION,
            ) == PackageManager.PERMISSION_GRANTED
        radioViewModel?.onLocationPermissionResult(locationGranted)
        val needsGps =
            locationGranted && !appGraph.locationReporter.isLocationEnabled()
        radioViewModel?.onEvent(
            RadioUiEvent.UpdatePermissionState(
                needsAudio = !audioGranted,
                needsAccessibility = !accessibilityEnabled,
                needsLocation = !locationGranted,
                needsGpsEnabled = needsGps,
            ),
        )

        if (Build.VERSION.SDK_INT >= 33) {
            val notifGranted = ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
            if (!notifGranted) {
                val prefs = getSharedPreferences("radio_startup_prefs", MODE_PRIVATE)
                val key = "requested_post_notifications_v1"
                if (!prefs.getBoolean(key, false)) {
                    prefs.edit().putBoolean(key, true).apply()
                    notificationsPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                }
            }
        }

        if (!locationGranted) {
            locationPermissionLauncher.launch(
                arrayOf(
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION,
                ),
            )
        }

        val overlayGranted = canDrawOverlays()
        radioViewModel?.onOverlayPermissionResult(overlayGranted)
        if (!overlayGranted && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val prefs = getSharedPreferences("radio_startup_prefs", MODE_PRIVATE)
            val key = "requested_overlay_v1"
            if (!prefs.getBoolean(key, false)) {
                prefs.edit().putBoolean(key, true).apply()
                requestOverlayPermission()
            }
        }

        RadioPresenceService.start(this)
    }

    private fun canDrawOverlays(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
        return Settings.canDrawOverlays(this)
    }

    private fun requestOverlayPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        try {
            val intent = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:$packageName"),
            )
            startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            openAppSettings()
        }
    }

    private fun openAppSettings() {
        try {
            startActivity(
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.fromParts("package", packageName, null)
                },
            )
        } catch (_: ActivityNotFoundException) {
        }
    }

    private fun openGpsSettings() {
        try {
            startActivity(Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS))
        } catch (_: ActivityNotFoundException) {
            openAppSettings()
        }
    }

    private fun isAccessibilityServiceEnabled(context: Context, service: Class<*>): Boolean {
        val expectedComponentName = android.content.ComponentName(context, service)
        val enabledServices = Settings.Secure.getString(
            context.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ) ?: return false
        val colonSplitter = android.text.TextUtils.SimpleStringSplitter(':')
        colonSplitter.setString(enabledServices)
        while (colonSplitter.hasNext()) {
            val componentNameString = colonSplitter.next()
            val enabledService = android.content.ComponentName.unflattenFromString(componentNameString)
            if (enabledService != null && enabledService == expectedComponentName) {
                return true
            }
        }
        return false
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (event?.repeatCount == 0) {
            HardwareButtonRelay.sendRawKeyCode(keyCode)
        }

        val isPtt = repository.getMapping(HardwareAction.PTT).contains(keyCode)
        val isEmergency = repository.getMapping(HardwareAction.EMERGENCY).contains(keyCode)
        val isChanUp = repository.getMapping(HardwareAction.CHANNEL_UP).contains(keyCode)
        val isChanDown = repository.getMapping(HardwareAction.CHANNEL_DOWN).contains(keyCode)
        val isScanToggle = repository.getMapping(HardwareAction.SCAN_TOGGLE).contains(keyCode)
        val isPlayLast = repository.getMapping(HardwareAction.PLAY_LAST_TRANSMISSION).contains(keyCode)
        val isVolumeCheck = repository.getMapping(HardwareAction.VOLUME_CHECK).contains(keyCode)
        val isToggleDayNight = repository.getMapping(HardwareAction.TOGGLE_DAY_NIGHT).contains(keyCode)

        // TM7+ rotary volume-knob handling: the firmware fires multiple key events per single
        // detent click, which the OS volume controller interprets as a held key and fast-scrolls
        // to max/min on one click. Let the OS handle the volume adjustment (it knows the right
        // stream, slider UI, and per-OEM quirks) but drop the burst tail so it only sees a single
        // press per detent. The earlier attempt that called AudioManager.adjustSuggestedStreamVolume
        // ourselves interacted badly with the Inrico firmware — which evidently watches that API
        // for Zello-style apps and synthesizes channel-change broadcasts when it fires.
        if (event != null && isSystemVolumeKey(keyCode)) {
            val now = event.eventTime
            if (now - lastVolumeKnobDownAtMs < VOLUME_KNOB_DEBOUNCE_MS) {
                return true
            }
            lastVolumeKnobDownAtMs = now
            if (isVolumeCheck) {
                HardwareButtonRelay.sendEvent(HardwareButtonEvent.VolumeCheckTapped)
            }
            return super.onKeyDown(keyCode, event)
        }

        if (isPtt || isEmergency || isChanUp || isChanDown || isScanToggle || isPlayLast || isVolumeCheck ||
            isToggleDayNight
        ) {
            if (event?.repeatCount == 0) {
                when {
                    isPtt -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.PttPressed)
                    isEmergency -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.EmergencyPressed)
                    isChanUp -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.ChannelUpPressed)
                    isChanDown -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.ChannelDownPressed)
                    isScanToggle -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.ScanTogglePressed)
                    isPlayLast -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.PlayLastTransmissionPressed)
                    isVolumeCheck -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.VolumeCheckPressed)
                    isToggleDayNight -> HardwareButtonRelay.sendEvent(HardwareButtonEvent.ToggleDayNightPressed)
                }
            }
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
        // Symmetric debounce for ACTION_UP on the volume knob: drop the burst tail so the OS
        // sees one clean press/release pair per detent. Releasing the event to super lets the
        // OS clear its "key is held" state — without that, a subsequent press could re-enter
        // fast-scroll. (Tracked with a separate timestamp from the DOWN debounce so the matching
        // UP for a real press is never dropped just because it's within the same window.)
        if (event != null && isSystemVolumeKey(keyCode)) {
            val now = event.eventTime
            if (now - lastVolumeKnobUpAtMs < VOLUME_KNOB_DEBOUNCE_MS) {
                return true
            }
            lastVolumeKnobUpAtMs = now
            return super.onKeyUp(keyCode, event)
        }
        when {
            repository.getMapping(HardwareAction.PTT).contains(keyCode) -> {
                HardwareButtonRelay.sendEvent(HardwareButtonEvent.PttReleased)
                return true
            }
            !isSystemVolumeKey(keyCode) &&
                repository.getMapping(HardwareAction.VOLUME_CHECK).contains(keyCode) -> {
                HardwareButtonRelay.sendEvent(HardwareButtonEvent.VolumeCheckReleased)
                return true
            }
            repository.getMapping(HardwareAction.TOGGLE_DAY_NIGHT).contains(keyCode) -> {
                HardwareButtonRelay.sendEvent(HardwareButtonEvent.ToggleDayNightReleased)
                return true
            }
            repository.getMapping(HardwareAction.PLAY_LAST_TRANSMISSION).contains(keyCode) -> {
                HardwareButtonRelay.sendEvent(HardwareButtonEvent.PlayLastTransmissionReleased)
                return true
            }
        }
        return super.onKeyUp(keyCode, event)
    }

    /** KEYCODE_VOLUME_UP / KEYCODE_VOLUME_DOWN — the OS volume rocker/knob. */
    private fun isSystemVolumeKey(keyCode: Int): Boolean =
        keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN

    private companion object {
        // Wide enough to collapse the TM7+'s multi-event-per-detent burst into one
        // adjustment, narrow enough that a fast user spin still registers each detent.
        const val VOLUME_KNOB_DEBOUNCE_MS = 120L
    }
}
