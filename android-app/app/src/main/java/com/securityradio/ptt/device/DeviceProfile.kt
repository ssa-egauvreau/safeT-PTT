package com.securityradio.ptt.device

import android.os.Build
import java.util.Locale

/** User-selectable profile; [AUTO] picks a known handset from [Build.MODEL]. */
enum class DeviceProfilePreference(val label: String) {
    AUTO("Auto-detect"),
    RESPONSIVE("Responsive (default)"),
    UNIVERSAL("Universal touch cockpit"),
    S200("Inrico S200"),
    TM7_PLUS("Inrico TM-7 Plus"),
    IRC590("Inrico IRC590"),
}

/** Effective handset layout after resolving [DeviceProfilePreference]. */
enum class ResolvedDeviceProfile(val label: String) {
    RESPONSIVE("Responsive"),
    UNIVERSAL("Universal touch cockpit"),
    S200("Inrico S200"),
    TM7_PLUS("Inrico TM-7 Plus"),
    IRC590("Inrico IRC590"),
}

/**
 * Explicit layout rules for rugged handsets. When [ResolvedDeviceProfile.RESPONSIVE] is active,
 * [com.securityradio.ptt.ui.RadioScreen] still derives a policy from width breakpoints.
 */
data class RadioLayoutPolicy(
    val showSoftKeyRow: Boolean,
    val showStateBanner: Boolean,
    val showFullStatusBar: Boolean,
    val showChannelTunerButtons: Boolean,
    val showMainDetailLines: Boolean,
    val showRadiosOnlineLine: Boolean,
    val showScanConfigureLink: Boolean,
    val softKeysTwoRows: Boolean,
    val compactSpacing: Boolean,
    val compactPtt: Boolean,
    val minimalStatusBar: Boolean,
    /** Touch PTT bar (hardware PTT handsets hide this). */
    val showOnScreenPtt: Boolean = true,
    /** Touch emergency row (hardware emergency key handsets hide this). */
    val showOnScreenEmergency: Boolean = true,
    /** Large channel + talk line; minimal chrome (IRC590). */
    val handsetStatusDisplay: Boolean = false,
    /** Bottom strip of labels above the four physical hardware keys (TM-7 Plus). */
    val showHardwareKeyLegend: Boolean = false,
    /** TM-7 Plus is mains-powered — hide battery icon and percentage in the status row. */
    val showBatteryStatus: Boolean = true,
    /** IRC590: status icons, clock, and zone/channel/radios each on their own row. */
    val handsetToolbarMultiRow: Boolean = false,
    /**
     * Universal touch cockpit (#15): one full-screen layout with a centred circular PTT, a
     * long-press emergency badge, and on-screen channel up/down + replay + scan. When this flag is
     * set the standard column dispatch is bypassed in favour of [com.securityradio.ptt.ui.LcdUniversalCockpit].
     */
    val universalCockpit: Boolean = false,
)

object DeviceProfileResolver {

    fun resolve(preference: DeviceProfilePreference, model: String = Build.MODEL): ResolvedDeviceProfile {
        return when (preference) {
            DeviceProfilePreference.RESPONSIVE -> ResolvedDeviceProfile.RESPONSIVE
            DeviceProfilePreference.UNIVERSAL -> ResolvedDeviceProfile.UNIVERSAL
            DeviceProfilePreference.S200 -> ResolvedDeviceProfile.S200
            DeviceProfilePreference.TM7_PLUS -> ResolvedDeviceProfile.TM7_PLUS
            DeviceProfilePreference.IRC590 -> ResolvedDeviceProfile.IRC590
            DeviceProfilePreference.AUTO -> detectFromModel(model)
        }
    }

    fun layoutPolicy(profile: ResolvedDeviceProfile): RadioLayoutPolicy = when (profile) {
        ResolvedDeviceProfile.S200 -> RadioLayoutPolicy(
            showSoftKeyRow = true,
            showStateBanner = false,
            showFullStatusBar = true,
            showChannelTunerButtons = true,
            showMainDetailLines = false,
            showRadiosOnlineLine = false,
            showScanConfigureLink = false,
            softKeysTwoRows = false,
            compactSpacing = true,
            compactPtt = true,
            minimalStatusBar = false,
            showOnScreenPtt = true,
            showOnScreenEmergency = true,
            handsetStatusDisplay = false,
        )
        ResolvedDeviceProfile.TM7_PLUS -> RadioLayoutPolicy(
            showSoftKeyRow = false,
            showStateBanner = false,
            showFullStatusBar = false,
            showChannelTunerButtons = false,
            showMainDetailLines = false,
            showRadiosOnlineLine = true,
            showScanConfigureLink = false,
            softKeysTwoRows = false,
            compactSpacing = true,
            compactPtt = true,
            minimalStatusBar = true,
            showOnScreenPtt = false,
            showOnScreenEmergency = false,
            handsetStatusDisplay = true,
            showHardwareKeyLegend = true,
            showBatteryStatus = false,
            handsetToolbarMultiRow = false,
        )
        ResolvedDeviceProfile.IRC590 -> RadioLayoutPolicy(
            showSoftKeyRow = false,
            showStateBanner = false,
            showFullStatusBar = false,
            showChannelTunerButtons = false,
            showMainDetailLines = false,
            showRadiosOnlineLine = true,
            showScanConfigureLink = false,
            softKeysTwoRows = false,
            compactSpacing = true,
            compactPtt = true,
            minimalStatusBar = true,
            showOnScreenPtt = false,
            showOnScreenEmergency = false,
            handsetStatusDisplay = true,
            handsetToolbarMultiRow = true,
        )
        ResolvedDeviceProfile.RESPONSIVE -> responsivePolicy(isCompact = false, isUltraCompact = false)
        ResolvedDeviceProfile.UNIVERSAL -> RadioLayoutPolicy(
            // The cockpit is rendered as its own composable so the column-level toggles below are
            // mostly irrelevant — only universalCockpit is read.
            showSoftKeyRow = false,
            showStateBanner = false,
            showFullStatusBar = false,
            showChannelTunerButtons = false,
            showMainDetailLines = false,
            showRadiosOnlineLine = true,
            showScanConfigureLink = false,
            softKeysTwoRows = false,
            compactSpacing = true,
            compactPtt = true,
            minimalStatusBar = false,
            showOnScreenPtt = false,
            showOnScreenEmergency = false,
            handsetStatusDisplay = false,
            showHardwareKeyLegend = false,
            universalCockpit = true,
        )
    }

    fun responsivePolicy(isCompact: Boolean, isUltraCompact: Boolean): RadioLayoutPolicy {
        if (isUltraCompact) {
            return RadioLayoutPolicy(
                showSoftKeyRow = false,
                showStateBanner = false,
                showFullStatusBar = false,
                showChannelTunerButtons = false,
                showMainDetailLines = false,
                showRadiosOnlineLine = false,
                showScanConfigureLink = false,
                softKeysTwoRows = false,
                compactSpacing = true,
                compactPtt = true,
                minimalStatusBar = true,
            )
        }
        return RadioLayoutPolicy(
            showSoftKeyRow = true,
            showStateBanner = true,
            showFullStatusBar = true,
            showChannelTunerButtons = true,
            showMainDetailLines = true,
            showRadiosOnlineLine = true,
            showScanConfigureLink = true,
            softKeysTwoRows = false,
            compactSpacing = isCompact,
            compactPtt = isCompact,
            minimalStatusBar = false,
        )
    }

    fun defaultKeyCodes(profile: ResolvedDeviceProfile, action: HardwareAction): Set<Int> = when (profile) {
        ResolvedDeviceProfile.IRC590 -> irc590Defaults(action)
        ResolvedDeviceProfile.TM7_PLUS -> tm7PlusDefaults(action)
        ResolvedDeviceProfile.S200,
        ResolvedDeviceProfile.RESPONSIVE,
        ResolvedDeviceProfile.UNIVERSAL,
        -> s200StyleDefaults(action)
    }

    private fun detectFromModel(model: String): ResolvedDeviceProfile {
        val m = model.uppercase(Locale.US)
        return when {
            m.contains("IRC590") || m.contains("IRC-590") -> ResolvedDeviceProfile.IRC590
            m.contains("TM-7") || m.contains("TM7") -> ResolvedDeviceProfile.TM7_PLUS
            m.contains("S200") || m.contains("S-200") -> ResolvedDeviceProfile.S200
            else -> ResolvedDeviceProfile.RESPONSIVE
        }
    }

    /** Inrico S-200 / TM-7 Plus factory-style defaults. */
    private fun s200StyleDefaults(action: HardwareAction): Set<Int> = when (action) {
        HardwareAction.PTT -> setOf(229)
        HardwareAction.EMERGENCY -> setOf(141)
        HardwareAction.CHANNEL_UP -> setOf(230)
        HardwareAction.CHANNEL_DOWN -> setOf(232)
        HardwareAction.SCAN_TOGGLE -> setOf(137)
        HardwareAction.PLAY_LAST_TRANSMISSION -> emptySet()
        HardwareAction.VOLUME_CHECK -> emptySet()
        HardwareAction.TOGGLE_DAY_NIGHT -> emptySet()
    }

    /** IRC590 programmable side keys (Inrico key codes). */
    private fun irc590Defaults(action: HardwareAction): Set<Int> = when (action) {
        HardwareAction.PTT -> setOf(229)
        HardwareAction.EMERGENCY -> setOf(233)
        HardwareAction.CHANNEL_UP -> setOf(235)
        HardwareAction.CHANNEL_DOWN -> setOf(234)
        HardwareAction.SCAN_TOGGLE -> emptySet()
        HardwareAction.PLAY_LAST_TRANSMISSION -> setOf(232)
        HardwareAction.VOLUME_CHECK -> setOf(231)
        HardwareAction.TOGGLE_DAY_NIGHT -> setOf(230)
    }

    /** Inrico TM-7 Plus hardware keys (emergency key + four programmable keys). */
    private fun tm7PlusDefaults(action: HardwareAction): Set<Int> = when (action) {
        HardwareAction.PTT -> setOf(229)
        HardwareAction.EMERGENCY -> setOf(135)
        HardwareAction.CHANNEL_UP -> setOf(132)
        HardwareAction.CHANNEL_DOWN -> setOf(131)
        HardwareAction.SCAN_TOGGLE -> setOf(23)
        HardwareAction.PLAY_LAST_TRANSMISSION -> setOf(133)
        HardwareAction.VOLUME_CHECK -> setOf(24, 25)
        HardwareAction.TOGGLE_DAY_NIGHT -> setOf(134)
    }
}
