package com.securityradio.ptt.ui

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.securityradio.ptt.device.DeviceProfilePreference
import com.securityradio.ptt.device.DeviceProfileResolver
import com.securityradio.ptt.device.HardwareAction
import com.securityradio.ptt.device.P25ImbeNative
import com.securityradio.ptt.device.RadioLayoutPolicy
import com.securityradio.ptt.device.ResolvedDeviceProfile
import com.securityradio.ptt.presentation.RxMessageHistoryItem
import com.securityradio.ptt.domain.ChannelPermission
import com.securityradio.ptt.presentation.RadioUiEvent
import com.securityradio.ptt.presentation.RadioUiState
import com.securityradio.ptt.presentation.ThemeMode
import com.securityradio.ptt.presentation.isLcdNight
import com.securityradio.ptt.ui.lcd.LcdBatteryIcon
import com.securityradio.ptt.ui.lcd.LcdBluetoothIcon
import com.securityradio.ptt.ui.lcd.LcdDayNightIcon
import com.securityradio.ptt.ui.lcd.LcdEmergencyGlyphIcon
import com.securityradio.ptt.ui.lcd.LcdGlobeIcon
import com.securityradio.ptt.ui.lcd.LcdGpsIcon
import com.securityradio.ptt.ui.lcd.LcdRadioIcon
import com.securityradio.ptt.ui.lcd.LcdPauseIcon
import com.securityradio.ptt.ui.lcd.LcdPlayIcon
import com.securityradio.ptt.ui.lcd.LcdReplayIcon
import com.securityradio.ptt.ui.lcd.LcdSettingsIcon
import com.securityradio.ptt.ui.lcd.LcdZoneIcon
import com.securityradio.ptt.ui.lcd.LcdSignalBarsIcon
import com.securityradio.ptt.ui.lcd.LcdVolumeIcon
import com.securityradio.ptt.ui.lcd.LcdListChannelIcon
import com.securityradio.ptt.ui.lcd.LcdMicIcon
import com.securityradio.ptt.ui.lcd.LcdScanIcon
import com.securityradio.ptt.ui.lcd.LcdTextStyles
import com.securityradio.ptt.ui.lcd.rememberLcdTextStyles
import com.securityradio.ptt.ui.theme.LocalRadioLcdPalette
import com.securityradio.ptt.ui.theme.RadioLcdPalette
import com.securityradio.ptt.ui.theme.RadioLcdTheme
import java.util.Locale

private val HANDSET_CLOCK_FONT_IRC590 = 44.sp
private val HANDSET_CLOCK_FONT_TM7 = 28.sp
private const val HANDSET_EMERGENCY_FLASH_LO = 0.38f
private const val HANDSET_EMERGENCY_FLASH_HI = 0.92f
private const val HANDSET_EMERGENCY_PANEL_LO = 0.42f
private const val HANDSET_EMERGENCY_PANEL_HI = 0.95f
private const val HANDSET_EMERGENCY_BORDER_LO = 0.65f
private const val HANDSET_EMERGENCY_WASH_LO = 0.28f
private const val HANDSET_EMERGENCY_WASH_HI = 0.92f
private const val HANDSET_IDLE_CHANNEL_MIN_SP = 28f
private const val HANDSET_IDLE_CHANNEL_MAX_SP = 64f
private const val HANDSET_IDLE_CHANNEL_MIN_SP_IRC590 = 40f
private const val HANDSET_IDLE_CHANNEL_MAX_SP_IRC590 = 82f

private fun handsetIdleChannelSpRange(profile: ResolvedDeviceProfile): ClosedFloatingPointRange<Float> =
    when (profile) {
        ResolvedDeviceProfile.IRC590 ->
            HANDSET_IDLE_CHANNEL_MIN_SP_IRC590..HANDSET_IDLE_CHANNEL_MAX_SP_IRC590
        else -> HANDSET_IDLE_CHANNEL_MIN_SP..HANDSET_IDLE_CHANNEL_MAX_SP
    }

/**
 * Outer frame: day / night LCD cross-fade and palette scope.
 */
@Composable
fun RadioShell(
    state: RadioUiState,
    onEvent: (RadioUiEvent) -> Unit,
    onRequestMicPermission: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val systemDark = isSystemInDarkTheme()
    val isNight = state.themeMode.isLcdNight(systemDark)

    LaunchedEffect(systemDark) {
        onEvent(RadioUiEvent.SystemDarkChanged(systemDark))
    }

    Crossfade(
        targetState = isNight,
        animationSpec = tween(durationMillis = 210),
        label = "lcd_day_night",
        modifier = modifier
            .fillMaxSize()
            .rotate(if (state.displayRotated180) 180f else 0f),
    ) { night ->
        val palette = if (night) RadioLcdPalette.night() else RadioLcdPalette.day()
        CompositionLocalProvider(LocalRadioLcdPalette provides palette) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .statusBarsPadding()
                    .background(palette.lcdMain),
            ) {
                RadioScreen(
                    state = state,
                    lcdNightEffective = night,
                    onEvent = onEvent,
                    onRequestMicPermission = onRequestMicPermission,
                )
            }
        }
    }
}

/**
 * Standalone tactical LCD layout. Data from [state]; interactions emit [RadioUiEvent].
 */
@Composable
fun RadioScreen(
    state: RadioUiState,
    lcdNightEffective: Boolean,
    onEvent: (RadioUiEvent) -> Unit,
    onRequestMicPermission: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val palette = RadioLcdTheme.palette
    val styles = rememberLcdTextStyles(palette)
    val tunerEnabled = !state.channelsLoading && state.totalChannels > 0

    BoxWithConstraints(modifier = modifier.fillMaxSize()) {
        val isCompactWidth = maxWidth < 420.dp
        val isUltraCompactWidth = maxWidth < 300.dp
        val layout = remember(state.resolvedDeviceProfile, isCompactWidth, isUltraCompactWidth) {
            if (state.resolvedDeviceProfile == ResolvedDeviceProfile.RESPONSIVE) {
                DeviceProfileResolver.responsivePolicy(isCompactWidth, isUltraCompactWidth)
            } else {
                DeviceProfileResolver.layoutPolicy(state.resolvedDeviceProfile)
            }
        }
        val gap = if (layout.compactSpacing) 4.dp else if (isCompactWidth) 6.dp else 8.dp
        val pttHeight = when {
            layout.compactPtt -> 44.dp
            isCompactWidth -> 52.dp
            else -> 58.dp
        }
        val emergencyHeight = if (layout.compactSpacing) 38.dp else 44.dp
        val emergencyFlashAlpha = rememberEmergencyFlashAlpha(state.isEmergencyActive)
        val handsetLocalEmergencyActive =
            layout.handsetStatusDisplay && state.isEmergencyActive
        val handsetEmergencyFlashColor =
            rememberHandsetLocalEmergencyFlashColor(handsetLocalEmergencyActive)

        Box(modifier = Modifier.fillMaxSize()) {
            if (handsetLocalEmergencyActive) {
                Box(
                    modifier = Modifier
                        .matchParentSize()
                        .background(handsetEmergencyFlashColor.copy(alpha = 0.68f)),
                )
            }
            Column(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(gap),
            ) {
            // Handset profiles (IRC590) merge the status icons into the main
            // channel box, so the separate top status bar is omitted here.
            if (!layout.handsetStatusDisplay) {
                LcdStatusBar(
                    state = state,
                    lcdNightEffective = lcdNightEffective,
                    onEvent = onEvent,
                    onRequestMicPermission = onRequestMicPermission,
                    styles = styles,
                    layout = layout,
                )
                LcdDivider()
            }
            if (state.connectivityBanner.isNotEmpty()) {
                LcdAlertBanner(
                    text = state.connectivityBanner,
                    accent = if (state.connectivityBanner == RadioUiState.BANNER_RECONNECTED) {
                        palette.statusGreen
                    } else {
                        palette.statusRed
                    },
                    styles = styles,
                )
            }
            if (state.replayBanner.isNotEmpty()) {
                Column(
                    modifier = Modifier.fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    LcdAlertBanner(
                        text = state.replayBanner,
                        accent = palette.statusAmber,
                        styles = styles,
                    )
                    if (state.replayTranscript.isNotBlank()) {
                        LcdReplayTranscriptBanner(
                            text = state.replayTranscript,
                            styles = styles,
                        )
                    }
                }
            }
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth(),
            ) {
                LcdMainChannelBlock(
                    state = state,
                    onEvent = onEvent,
                    onRequestMicPermission = onRequestMicPermission,
                    tunerEnabled = tunerEnabled,
                    styles = styles,
                    layout = layout,
                    emergencyFlashAlpha = emergencyFlashAlpha,
                    handsetEmergencyFlashColor = handsetEmergencyFlashColor,
                    modifier = Modifier.fillMaxSize(),
                )
            }
            if (!layout.handsetStatusDisplay) {
                LcdDivider()
            }
            if (layout.showStateBanner) {
                LcdStateBanner(state = state, styles = styles)
            }
            if (layout.showOnScreenPtt) {
                LcdPttBar(
                    state = state,
                    lcdNightEffective = lcdNightEffective,
                    onEvent = onEvent,
                    height = pttHeight,
                    styles = styles,
                    compact = layout.compactPtt,
                )
            }
            if (layout.showOnScreenEmergency) {
                LcdEmergencyRow(
                    state = state,
                    onEvent = onEvent,
                    styles = styles,
                    height = emergencyHeight,
                )
            }
            if (layout.showSoftKeyRow) {
                if (layout.softKeysTwoRows) {
                    LcdSoftKeyTwoRowStrip(
                        labels = state.softKeyLabels,
                        state = state,
                        onEvent = onEvent,
                        styles = styles,
                    )
                } else {
                    LcdSoftKeyRow(
                        labels = state.softKeyLabels,
                        state = state,
                        onEvent = onEvent,
                        styles = styles,
                        rowHeight = if (layout.compactSpacing) 40.dp else 46.dp,
                    )
                }
            }
            if (layout.showHardwareKeyLegend) {
                LcdHardwareKeyLegend(
                    onEvent = onEvent,
                    styles = styles,
                    night = lcdNightEffective,
                    rowHeight = if (layout.compactSpacing) 58.dp else 64.dp,
                )
            }
            }
        }
        if (state.resolvedDeviceProfile == ResolvedDeviceProfile.TM7_PLUS) {
            ScanChannelPickerFullScreen(state = state, onEvent = onEvent, styles = styles)
        } else {
            ScanChannelPickerDialog(state = state, onEvent = onEvent, styles = styles)
        }
        MessageHistoryScreen(state = state, onEvent = onEvent, styles = styles)
        HardwareMappingDialog(state = state, onEvent = onEvent, styles = styles)
        SetupRequiredDialog(state = state, onEvent = onEvent)
    }
}

@Composable
private fun LcdDivider() {
    val p = RadioLcdTheme.palette
    Spacer(
        modifier = Modifier
            .fillMaxWidth()
            .height(1.dp)
            .background(p.divider),
    )
}

@Composable
private fun LcdStatusBar(
    state: RadioUiState,
    lcdNightEffective: Boolean,
    onEvent: (RadioUiEvent) -> Unit,
    onRequestMicPermission: () -> Unit,
    styles: LcdTextStyles,
    layout: RadioLayoutPolicy,
) {
    val p = RadioLcdTheme.palette
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(2.dp))
            .background(p.lcdSection)
            .border(1.dp, p.divider, RoundedCornerShape(2.dp))
            .padding(
                horizontal = 8.dp,
                vertical = if (layout.minimalStatusBar) 10.dp else 6.dp,
            ),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .then(
                    if (layout.minimalStatusBar) {
                        Modifier.heightIn(min = 36.dp)
                    } else {
                        Modifier
                    },
                ),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            if (layout.minimalStatusBar) {
                val online = state.networkLabel == "ONLINE"
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                    modifier = Modifier.weight(1f),
                ) {
                    LcdSignalBarsIcon(
                        bars = if (online) 4 else 1,
                        maxBars = 4,
                        colorActive = if (online) p.statusGreen else p.statusAmber,
                        colorInactive = p.textMuted,
                        modifier = Modifier.size(26.dp, 18.dp),
                    )
                    LcdBluetoothIcon(
                        on = state.bluetoothOn,
                        active = p.statusBlue,
                        muted = p.textMuted,
                        modifier = Modifier.size(24.dp),
                    )
                    LcdGpsIcon(
                        active = p.statusGreen,
                        muted = p.textMuted,
                        locked = true,
                        modifier = Modifier.size(22.dp),
                    )
                    LcdReplayIcon(
                        ready = p.statusAmber,
                        muted = p.textMuted,
                        playing = state.replayBanner.isNotEmpty(),
                        modifier = Modifier
                            .size(24.dp)
                            .clickable { onEvent(RadioUiEvent.PlayLastTransmission) },
                    )
                    LcdVolumeIcon(
                        muted = p.textMuted,
                        active = p.statusGreen,
                        isMuted = !state.externalMicConnected,
                        modifier = Modifier.size(26.dp),
                    )
                }
                Text(
                    text = "SET",
                    style = styles.softKey.copy(fontSize = 13.sp),
                    color = p.statusBlue,
                    modifier = Modifier.clickable { onEvent(RadioUiEvent.OpenMappingSettings) },
                )
            } else {
                Text(
                    text = state.systemTime.uppercase(Locale.US),
                    style = styles.status.copy(fontWeight = FontWeight.Bold, fontSize = 22.sp),
                    color = p.textPrimary,
                )
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    LcdGpsIcon(
                        active = p.statusGreen,
                        muted = p.textMuted,
                        locked = true, // GPS reporting is always on
                        modifier = Modifier.size(14.dp),
                    )
                    LcdScanIcon(
                        active = rememberScanIconActiveColor(
                            scanActive = state.scanActive,
                            scanReceiving = state.scanBackgroundActive,
                        ),
                        muted = p.textMuted,
                        on = state.scanActive,
                        modifier = Modifier.size(16.dp, 12.dp),
                    )
                    val online = state.networkLabel == "ONLINE"
                    Text(
                        text = if (online) "NET" else "OFF",
                        style = styles.status,
                        color = if (online) p.statusGreen else p.statusAmber,
                    )
                    if (state.channelsLoading) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(14.dp),
                            strokeWidth = 2.dp,
                            color = p.materialPrimary,
                        )
                    }
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        LcdBatteryIcon(
                            percent = state.batteryPercent,
                            outline = p.textSecondary,
                            fillHigh = p.statusGreen,
                            fillLow = p.statusAmber,
                            fillCritical = p.statusRed,
                            modifier = Modifier.size(width = 24.dp, height = 12.dp),
                        )
                        Text(
                            text = "${state.batteryPercent}%",
                            style = styles.status.copy(fontWeight = FontWeight.Bold, fontSize = 18.sp),
                            color = p.textSecondary,
                        )
                    }
                    Box(
                        modifier = Modifier
                            .size(22.dp)
                            .clickable { onEvent(RadioUiEvent.OpenMappingSettings) },
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = "⚙",
                            style = styles.status.copy(fontSize = 16.sp),
                            color = p.textSecondary,
                        )
                    }
                    Box(
                        modifier = Modifier
                            .size(22.dp)
                            .clickable { onEvent(RadioUiEvent.ToggleDayNight) },
                        contentAlignment = Alignment.Center,
                    ) {
                        LcdDayNightIcon(
                            night = lcdNightEffective,
                            color = p.textSecondary,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                }
            }
        }
        if (layout.minimalStatusBar) Box(
            modifier = Modifier.fillMaxWidth(),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = state.systemTime.uppercase(Locale.US),
                style = styles.status.copy(fontWeight = FontWeight.Bold, fontSize = 24.sp),
                color = p.textPrimary,
            )
            Row(
                modifier = Modifier.align(Alignment.CenterEnd),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                LcdBatteryIcon(
                    percent = state.batteryPercent,
                    outline = p.textSecondary,
                    fillHigh = p.statusGreen,
                    fillLow = p.statusAmber,
                    fillCritical = p.statusRed,
                    modifier = Modifier.size(width = 36.dp, height = 18.dp),
                )
                Text(
                    text = "${state.batteryPercent}%",
                    style = styles.status.copy(fontWeight = FontWeight.Bold, fontSize = 28.sp),
                    color = p.textSecondary,
                )
            }
        }
        if (layout.showFullStatusBar) Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val linkLabel = when (state.networkLabel.uppercase(Locale.US)) {
                "ONLINE" -> "LINK: ONLINE"
                "OFFLINE" -> "LINK: OFFLINE"
                "LOCAL" -> "LINK: LOCAL"
                "SYNCING" -> "LINK: SYNC"
                else -> "LINK: ${state.networkLabel.uppercase(Locale.US)}"
            }
            Text(
                text = linkLabel,
                style = styles.status,
                color = p.textMuted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
        }
        if (!state.micPermissionGranted || state.channelSyncError != null) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (!state.micPermissionGranted) {
                    Text(
                        text = "ALLOW MIC",
                        style = styles.softKey,
                        color = p.statusBlue,
                        modifier = Modifier.clickable { onRequestMicPermission() },
                    )
                }
                if (state.channelSyncError != null) {
                    Text(
                        text = "RETRY SYNC",
                        style = styles.softKey,
                        color = p.statusAmber,
                        modifier = Modifier.clickable { onEvent(RadioUiEvent.RetryChannelSync) },
                    )
                }
            }
        }
    }
}

/** Pulsing alpha for local emergency — always composed so the animation never sticks static. */
@Composable
private fun rememberEmergencyFlashAlpha(active: Boolean): Float {
    val transition = rememberInfiniteTransition(label = "local_emergency_flash")
    val anim by transition.animateFloat(
        initialValue = 0.25f,
        targetValue = 0.92f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 500),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "emergency_flash_alpha",
    )
    return if (active) anim else 0f
}

/** Alternates orange ↔ red while the local emergency button is held (TM7 / IRC590). */
@Composable
private fun rememberHandsetLocalEmergencyFlashColor(active: Boolean): Color {
    val p = RadioLcdTheme.palette
    val transition = rememberInfiniteTransition(label = "handset_local_emergency_color")
    val phase by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 600),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "handset_local_emergency_phase",
    )
    return if (active) {
        lerp(p.statusEmergency, p.statusRed, phase)
    } else {
        Color.Transparent
    }
}

/** Throbbing alpha for the 10-33 "emergency traffic only" channel band; 0f when off. */
@Composable
private fun rememberTen33PulseAlpha(active: Boolean): Float {
    if (!active) return 0f
    val transition = rememberInfiniteTransition(label = "ten33_band_pulse")
    val phase by transition.animateFloat(
        initialValue = 0.28f,
        targetValue = 0.78f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 700),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "ten33_band_pulse_alpha",
    )
    return phase
}

/** Orange when scan is on; pulses while a scan channel is receiving. */
@Composable
private fun rememberScanIconActiveColor(scanActive: Boolean, scanReceiving: Boolean): Color {
    val p = RadioLcdTheme.palette
    if (!scanActive) return p.statusAmber
    if (!scanReceiving) return p.statusAmber
    val transition = rememberInfiniteTransition(label = "scan_rx_icon_flash")
    val flash by transition.animateFloat(
        initialValue = 0.42f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 450),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "scan_rx_icon_flash_alpha",
    )
    return p.statusAmber.copy(alpha = flash.coerceIn(0.42f, 1f))
}

@Composable
private fun LcdMainChannelBlock(
    state: RadioUiState,
    onEvent: (RadioUiEvent) -> Unit,
    onRequestMicPermission: () -> Unit,
    tunerEnabled: Boolean,
    styles: LcdTextStyles,
    layout: RadioLayoutPolicy,
    emergencyFlashAlpha: Float,
    handsetEmergencyFlashColor: Color,
    modifier: Modifier = Modifier,
) {
    val p = RadioLcdTheme.palette
    val chrome = channelDisplayChrome(
        state = state,
        p = p,
        emergencyFlashAlpha = emergencyFlashAlpha,
        handsetLayout = layout.handsetStatusDisplay,
        localEmergencyFlashColor = handsetEmergencyFlashColor.takeIf { state.isEmergencyActive },
    )
    if (layout.handsetStatusDisplay) {
        LcdHandsetFillChannelBlock(
            state = state,
            chrome = chrome,
            emergencyFlashAlpha = emergencyFlashAlpha,
            handsetEmergencyFlashColor = handsetEmergencyFlashColor,
            showBatteryStatus = layout.showBatteryStatus,
            handsetToolbarMultiRow = layout.handsetToolbarMultiRow,
            onEvent = onEvent,
            onRequestMicPermission = onRequestMicPermission,
            styles = styles,
            modifier = modifier,
        )
        return
    }
    val talkLine = channelTalkLine(state)
    val channelStyle = styles.channel
    val zoneStyle = styles.status
    val talkStyle = styles.body.copy(fontWeight = FontWeight.Bold)
    Box(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(2.dp))
            .border(chrome.borderWidth, chrome.borderColor, RoundedCornerShape(2.dp))
            .background(p.lcdAlt),
    ) {
        if (chrome.washColor != Color.Transparent) {
            Box(
                modifier = Modifier
                    .matchParentSize()
                    .background(chrome.washColor),
            )
        }
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 10.dp, vertical = if (layout.handsetStatusDisplay) 12.dp else 8.dp),
            verticalArrangement = if (layout.handsetStatusDisplay) {
                Arrangement.Center
            } else {
                Arrangement.spacedBy(6.dp)
            },
        ) {
            if (layout.showChannelTunerButtons) Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                LcdSegmentButton(
                    label = "CH-",
                    enabled = tunerEnabled,
                    onClick = { onEvent(RadioUiEvent.ChannelDown) },
                    styles = styles,
                    compact = layout.compactSpacing,
                )
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    LcdListChannelIcon(color = p.textMuted, modifier = Modifier.size(14.dp))
                    Text(
                        text = state.zoneLabel.uppercase(Locale.US),
                        style = styles.zone,
                        color = p.textSecondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        text = state.channelPosition.uppercase(Locale.US),
                        style = styles.status,
                        color = p.textMuted,
                    )
                }
                LcdSegmentButton(
                    label = "CH+",
                    enabled = tunerEnabled,
                    onClick = { onEvent(RadioUiEvent.ChannelUp) },
                    styles = styles,
                    compact = layout.compactSpacing,
                )
            }
            if (!layout.showChannelTunerButtons) {
                Text(
                    text = "${state.zoneLabel} · ${state.channelPosition}".uppercase(Locale.US),
                    style = zoneStyle,
                    color = p.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.fillMaxWidth(),
                    textAlign = TextAlign.Center,
                )
            }
            Text(
                text = state.channelLabel.uppercase(Locale.US),
                style = channelStyle,
                color = chrome.channelTextColor,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.fillMaxWidth(),
                textAlign = TextAlign.Center,
            )
            val remoteEmergency = state.remoteEmergencyUnit?.trim()?.takeIf { it.isNotEmpty() }
            if (remoteEmergency != null && !state.isEmergencyActive) {
                Text(
                    text = "EMERGENCY • UNIT $remoteEmergency",
                    style = talkStyle,
                    color = p.statusEmergency,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = if (layout.handsetStatusDisplay) 10.dp else 4.dp),
                    textAlign = TextAlign.Center,
                )
            }
            if (layout.showRadiosOnlineLine) {
                val radiosLine = state.radiosOnlineOnChannel?.let { n ->
                    "RADIOS ONLINE · $n"
                } ?: "RADIOS ONLINE —"
                Text(
                    text = radiosLine.uppercase(Locale.US),
                    style = styles.status,
                    color = if (state.radiosOnlineOnChannel != null) p.textSecondary else p.textMuted,
                    maxLines = 1,
                    modifier = Modifier.fillMaxWidth(),
                    textAlign = TextAlign.Center,
                )
            }
            val talkUnit = state.activeTalkUnitId.trim().uppercase(Locale.US)
            if (talkUnit.isNotEmpty()) {
                LcdTalkerAttribution(
                    unitId = talkUnit,
                    displayName = state.activeTalkDisplayName,
                    unitColor = chrome.talkLineColor,
                    nameColor = chrome.talkLineColor.copy(alpha = 0.88f),
                    modifier = Modifier.fillMaxWidth(),
                )
            } else if (talkLine.isNotBlank()) {
                Text(
                    text = talkLine.uppercase(Locale.US),
                    style = talkStyle,
                    color = chrome.talkLineColor,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.fillMaxWidth(),
                    textAlign = TextAlign.Center,
                )
            }
            if (layout.showMainDetailLines) {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    LcdBodyLine(text = state.displayLine1, styles = styles)
                    LcdBodyLine(text = state.displayLine2, styles = styles)
                    LcdBodyLine(text = state.displayLine3, styles = styles)
                }
                Text(
                    text = state.micHint.uppercase(Locale.US),
                    style = if (state.currentChannelPermission == ChannelPermission.LISTEN_ONLY) {
                        styles.status.copy(
                            fontWeight = FontWeight.Bold,
                            fontSize = 16.sp,
                            lineHeight = 19.sp,
                        )
                    } else {
                        styles.status
                    },
                    color = if (state.currentChannelPermission == ChannelPermission.LISTEN_ONLY) {
                        p.statusRed
                    } else {
                        p.textMuted
                    },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (layout.showScanConfigureLink && state.scanActive && state.channelCatalog.size > 1) {
                Text(
                    text = "CONFIGURE SCAN LIST",
                    style = styles.body,
                    color = p.statusBlue,
                    modifier = Modifier
                        .clickable { onEvent(RadioUiEvent.OpenScanPicker) }
                        .fillMaxWidth(),
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

/** Unit id + display name for the large handset talker block (TX, RX, or emergency). */
private fun handsetTalkAttribution(state: RadioUiState): Pair<String, String> {
    if (state.isEmergencyActive) {
        val unit = state.activeTalkUnitId.ifBlank { state.localShortUnitId }.trim().uppercase(Locale.US)
        val name = state.activeTalkDisplayName.trim().ifBlank { "YOU" }
        return unit to name
    }
    if (state.isPttPressed) {
        val unit = state.localShortUnitId.trim().uppercase(Locale.US)
        val name = state.sessionDisplayName.trim().ifBlank { "YOU" }
        return unit to name
    }
    if (state.activeTalkUnitId.isNotBlank()) {
        return state.activeTalkUnitId.trim().uppercase(Locale.US) to state.activeTalkDisplayName.trim()
    }
    if (!state.isEmergencyActive && state.remoteEmergencyUnit != null) {
        return state.remoteEmergencyUnit.trim().uppercase(Locale.US) to ""
    }
    val rx = state.rxAttributedLine.trim()
    if (rx.isNotEmpty()) {
        val colon = rx.indexOf(':')
        if (colon > 0) {
            val after = rx.substring(colon + 1).trim()
            val sep = after.indexOf('•').takeUnless { it < 0 } ?: after.length
            val unit = after.substring(0, sep).trim().uppercase(Locale.US)
            val name = after.substring(sep).removePrefix("•").trim()
            if (unit.isNotEmpty()) return unit to name
        }
    }
    return "" to ""
}

@Composable
private fun LcdHandsetFillChannelBlock(
    state: RadioUiState,
    chrome: ChannelDisplayChrome,
    emergencyFlashAlpha: Float,
    handsetEmergencyFlashColor: Color,
    showBatteryStatus: Boolean,
    handsetToolbarMultiRow: Boolean,
    onEvent: (RadioUiEvent) -> Unit,
    onRequestMicPermission: () -> Unit,
    styles: LcdTextStyles,
    modifier: Modifier = Modifier,
) {
    val p = RadioLcdTheme.palette
    val panelBackground =
        if (state.isEmergencyActive) {
            handsetEmergencyFlashColor.copy(alpha = 0.96f)
        } else {
            p.lcdAlt
        }
    val zoneValue = state.zoneLabel.filter { it.isDigit() }
        .ifEmpty { state.zoneLabel.trim().uppercase(Locale.US) }
    val channelValue = state.channelPosition.replace(" ", "")
    val radiosValue = state.radiosOnlineOnChannel?.toString() ?: "—"
    val (talkUnit, talkName) = handsetTalkAttribution(state)
    val talkColor = chrome.talkLineColor
    val showEmergencyBanner = state.remoteEmergencyUnit != null && !state.isEmergencyActive
    val showTalkPanel =
        talkUnit.isNotEmpty() ||
            state.isPttPressed ||
            state.rxAttributedLine.isNotBlank() ||
            state.isEmergencyActive

    val emergencyBorderColor =
        if (state.isEmergencyActive) handsetEmergencyFlashColor else chrome.borderColor
    val emergencyBorderWidth = if (state.isEmergencyActive) 3.dp else chrome.borderWidth
    Box(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(2.dp))
            .border(emergencyBorderWidth, emergencyBorderColor, RoundedCornerShape(2.dp))
            .background(panelBackground),
    ) {
        if (!state.isEmergencyActive && chrome.washColor != Color.Transparent) {
            Box(
                modifier = Modifier
                    .matchParentSize()
                    .background(chrome.washColor),
            )
        }
        val showWarnings = !state.micPermissionGranted || state.channelSyncError != null
        val handsetEdgeToEdge = state.resolvedDeviceProfile == ResolvedDeviceProfile.IRC590
        val handsetPadH = if (handsetEdgeToEdge) 0.dp else 8.dp
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(start = handsetPadH, end = handsetPadH, top = 6.dp, bottom = 8.dp),
        ) {
            LcdHandsetToolbar(
                state = state,
                showBatteryStatus = showBatteryStatus,
                multiRowLayout = handsetToolbarMultiRow,
                emergencyFlashAlpha = emergencyFlashAlpha,
                zoneValue = zoneValue,
                channelValue = channelValue,
                radiosValue = radiosValue,
                radiosKnown = state.radiosOnlineOnChannel != null,
                onEvent = onEvent,
                styles = styles,
            )
            if (showWarnings) {
                Spacer(modifier = Modifier.height(4.dp))
                LcdHandsetWarningRow(
                    state = state,
                    onEvent = onEvent,
                    onRequestMicPermission = onRequestMicPermission,
                    styles = styles,
                )
            }
            if (!showEmergencyBanner) {
                LcdPermissionBadge(permission = state.currentChannelPermission, styles = styles)
            }
            val scanRxLive =
                state.scanBackgroundActive && state.scanBackgroundChannel.isNotBlank()
            val remoteEmergencyLive = showEmergencyBanner
            val showHandsetTalker =
                showTalkPanel &&
                    !remoteEmergencyLive &&
                    (!scanRxLive || state.isPttPressed || state.isEmergencyActive)
            val homeChannelLarge = !showHandsetTalker
            val channelBlockWeight =
                when {
                    remoteEmergencyLive || homeChannelLarge ->
                        if (state.resolvedDeviceProfile == ResolvedDeviceProfile.IRC590) 2.55f else 2.25f
                    else -> 0.48f
                }
            val channelBlockMaxHeight =
                if (showHandsetTalker) 52.dp else null
            BoxWithConstraints(
                modifier = Modifier
                    .weight(channelBlockWeight)
                    .fillMaxWidth()
                    .then(
                        if (channelBlockMaxHeight != null) {
                            Modifier.heightIn(max = channelBlockMaxHeight)
                        } else {
                            Modifier
                        },
                    ),
                contentAlignment = Alignment.Center,
            ) {
                if (remoteEmergencyLive) {
                    LcdHandsetRemoteEmergencyBlock(
                        channelName = state.channelLabel,
                        unitId = talkUnit,
                        channelColor = chrome.channelTextColor,
                        emergencyColor = p.statusEmergency,
                        deviceProfile = state.resolvedDeviceProfile,
                        styles = styles,
                        modifier = Modifier.fillMaxSize(),
                    )
                } else {
                    val channelText = state.channelLabel.uppercase(Locale.US)
                    val density = LocalDensity.current
                    val blockMaxHeight = maxHeight
                    val blockMaxWidth = maxWidth
                    Column(
                        modifier = Modifier.fillMaxSize(),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center,
                    ) {
                        val ten33Alpha = rememberTen33PulseAlpha(state.channelTen33)
                        Box(
                            modifier = (
                                if (homeChannelLarge) {
                                    Modifier
                                        .weight(1f)
                                        .fillMaxWidth()
                                } else {
                                    Modifier.fillMaxWidth()
                                }
                            ).then(
                                if (state.channelTen33) {
                                    Modifier
                                        .background(p.statusAmber.copy(alpha = ten33Alpha))
                                        .border(2.dp, p.statusAmber, RoundedCornerShape(2.dp))
                                } else {
                                    Modifier
                                }
                            ),
                            contentAlignment = Alignment.Center,
                        ) {
                            val idleChannelRange = handsetIdleChannelSpRange(state.resolvedDeviceProfile)
                            val irc590Idle = state.resolvedDeviceProfile == ResolvedDeviceProfile.IRC590
                            val channelFont = with(density) {
                                val heightFactor = if (homeChannelLarge) {
                                    if (irc590Idle) 1f else 0.96f
                                } else {
                                    0.88f
                                }
                                val widthFactor = when {
                                    homeChannelLarge && irc590Idle -> 0.34f
                                    homeChannelLarge -> 0.42f
                                    else -> 0.5f
                                }
                                val boxH =
                                    if (homeChannelLarge) {
                                        blockMaxHeight *
                                            if (scanRxLive) {
                                                if (irc590Idle) 0.76f else 0.72f
                                            } else {
                                                if (irc590Idle) 1.02f else 0.96f
                                            }
                                    } else {
                                        blockMaxHeight * heightFactor
                                    }
                                val byHeight = boxH
                                val byWidth = blockMaxWidth /
                                    (channelText.length.coerceAtLeast(3) * widthFactor)
                                minOf(byHeight, byWidth).toSp()
                            }.value.let { raw ->
                                if (homeChannelLarge) {
                                    raw.coerceIn(idleChannelRange.start, idleChannelRange.endInclusive)
                                } else {
                                    raw.coerceIn(16f, 24f)
                                }
                            }.sp
                            Text(
                                text = channelText,
                                style = styles.channel.copy(
                                    fontSize = channelFont,
                                    lineHeight = (channelFont.value * 1.05f).sp,
                                ),
                                color = chrome.channelTextColor,
                                maxLines = if (homeChannelLarge) 1 else 2,
                                overflow = TextOverflow.Ellipsis,
                                softWrap = !homeChannelLarge,
                                textAlign = TextAlign.Center,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 4.dp),
                            )
                        }
                        if (scanRxLive) {
                            LcdHandsetScanRxStrip(
                                channelName = state.scanBackgroundChannel,
                                unitId = talkUnit,
                                displayName = talkName,
                                styles = styles,
                                modifier = Modifier.padding(top = 2.dp, bottom = 4.dp),
                            )
                        }
                    }
                }
                if (!remoteEmergencyLive) {
                    LcdSettingsIcon(
                        color = p.statusBlue,
                        modifier = Modifier
                            .align(Alignment.BottomEnd)
                            .padding(bottom = 4.dp)
                            .size(28.dp)
                            .clickable { onEvent(RadioUiEvent.OpenMappingSettings) },
                    )
                }
            }
            if (showHandsetTalker) {
                LcdHandsetTalkerBlock(
                    unitId = talkUnit.ifBlank { state.localShortUnitId.trim().uppercase(Locale.US) },
                    displayName = when {
                        talkName.isNotBlank() -> talkName
                        state.isPttPressed -> "TRANSMITTING"
                        else -> ""
                    },
                    unitColor = talkColor,
                    nameColor = talkColor.copy(alpha = 0.9f),
                    styles = styles,
                    modifier = Modifier
                        .weight(3.65f)
                        .fillMaxWidth()
                        .heightIn(min = 96.dp),
                )
            }
        }
    }
}

/** Per-channel permission tag — only shown when the channel isn't plain TALK. */
@Composable
private fun LcdPermissionBadge(
    permission: ChannelPermission,
    styles: LcdTextStyles,
    modifier: Modifier = Modifier,
) {
    if (permission == ChannelPermission.TALK) return
    val p = RadioLcdTheme.palette
    val (label, color, fontSp) = when (permission) {
        ChannelPermission.LISTEN_ONLY -> Triple("LISTEN ONLY", p.statusRed, 28.sp)
        ChannelPermission.TALK_PRIORITY -> Triple("PRIORITY", p.statusAmber, 20.sp)
        else -> return
    }
    Text(
        text = label,
        style = styles.status.copy(
            fontWeight = FontWeight.Bold,
            fontSize = fontSp,
            lineHeight = (fontSp.value * 1.08f).sp,
        ),
        color = color,
        textAlign = TextAlign.Center,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
    )
}

/** Zone / channel position / radios — top toolbar, right-aligned. */
@Composable
private fun LcdHandsetMetaRow(
    zoneValue: String,
    channelValue: String,
    radiosValue: String,
    radiosKnown: Boolean,
    styles: LcdTextStyles,
    modifier: Modifier = Modifier,
) {
    val p = RadioLcdTheme.palette
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        LcdHandsetStat(value = zoneValue, valueColor = p.textSecondary, styles = styles, compact = true) {
            LcdZoneIcon(color = p.textSecondary, modifier = Modifier.size(22.dp))
        }
        LcdHandsetStat(value = channelValue, valueColor = p.textSecondary, styles = styles, compact = true) {
            LcdRadioIcon(color = p.textSecondary, modifier = Modifier.size(24.dp))
        }
        LcdHandsetStat(
            value = radiosValue,
            valueColor = if (radiosKnown) p.statusGreen else p.textMuted,
            styles = styles,
            compact = true,
        ) {
            LcdGlobeIcon(
                color = if (radiosKnown) p.statusGreen else p.textMuted,
                modifier = Modifier.size(24.dp),
            )
        }
    }
}

/** One handset stat — an icon with its number — for zone, channel position and radios online. */
@Composable
private fun LcdHandsetStat(
    value: String,
    valueColor: Color,
    styles: LcdTextStyles,
    compact: Boolean = false,
    valueFontSize: TextUnit? = null,
    modifier: Modifier = Modifier,
    icon: @Composable () -> Unit,
) {
    val fontSize = valueFontSize ?: if (compact) 16.sp else 27.sp
    val gap = if (compact) 4.dp else 7.dp
    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(gap),
    ) {
        icon()
        Text(
            text = value,
            style = styles.status.copy(fontWeight = FontWeight.Bold, fontSize = fontSize),
            color = valueColor,
            maxLines = 1,
        )
    }
}

/** Status toolbar — TM7: one row; IRC590: icons row, clock row, zone/channel/radios row. */
@Composable
private fun LcdHandsetToolbar(
    state: RadioUiState,
    showBatteryStatus: Boolean,
    multiRowLayout: Boolean,
    emergencyFlashAlpha: Float,
    zoneValue: String,
    channelValue: String,
    radiosValue: String,
    radiosKnown: Boolean,
    onEvent: (RadioUiEvent) -> Unit,
    styles: LcdTextStyles,
    modifier: Modifier = Modifier,
) {
    if (multiRowLayout) {
        LcdHandsetToolbarIrc590(
            state = state,
            showBatteryStatus = showBatteryStatus,
            emergencyFlashAlpha = emergencyFlashAlpha,
            zoneValue = zoneValue,
            channelValue = channelValue,
            radiosValue = radiosValue,
            radiosKnown = radiosKnown,
            onEvent = onEvent,
            styles = styles,
            modifier = modifier,
        )
    } else {
        LcdHandsetToolbarTm7(
            state = state,
            emergencyFlashAlpha = emergencyFlashAlpha,
            zoneValue = zoneValue,
            channelValue = channelValue,
            radiosValue = radiosValue,
            radiosKnown = radiosKnown,
            onEvent = onEvent,
            styles = styles,
            modifier = modifier,
        )
    }
}

@Composable
private fun LcdHandsetToolbarStatusIcons(
    state: RadioUiState,
    online: Boolean,
    scanReceiving: Boolean,
    iconSize: Dp,
    signalWidth: Dp,
    signalHeight: Dp,
    onEvent: (RadioUiEvent) -> Unit,
    modifier: Modifier = Modifier,
    edgeToEdge: Boolean = false,
    showScanIcon: Boolean = true,
) {
    val p = RadioLcdTheme.palette
    val scanIconColor = rememberScanIconActiveColor(
        scanActive = state.scanActive,
        scanReceiving = scanReceiving,
    )
    val arrangement =
        if (edgeToEdge) Arrangement.SpaceBetween else Arrangement.spacedBy(6.dp)
    Row(
        modifier = modifier.then(
            if (edgeToEdge) Modifier.fillMaxWidth() else Modifier,
        ),
        horizontalArrangement = arrangement,
        verticalAlignment = Alignment.CenterVertically,
    ) {
    LcdSignalBarsIcon(
        bars = if (online) 4 else 1,
        maxBars = 4,
        colorActive = if (online) p.statusGreen else p.statusAmber,
        colorInactive = p.textMuted,
        modifier = Modifier.size(signalWidth, signalHeight),
    )
    LcdBluetoothIcon(
        on = state.bluetoothOn,
        active = p.statusBlue,
        muted = p.textMuted,
        modifier = Modifier.size(iconSize),
    )
    LcdGpsIcon(
        active = p.statusGreen,
        muted = p.textMuted,
        locked = true,
        modifier = Modifier.size(iconSize),
    )
    if (showScanIcon) {
        LcdScanIcon(
            on = state.scanActive,
            active = scanIconColor,
            muted = p.textMuted,
            modifier = Modifier
                .size(iconSize)
                .pointerInput(state.scanActive) {
                    detectTapGestures(
                        onTap = {
                            if (state.scanActive) {
                                onEvent(RadioUiEvent.DisableScan)
                            } else {
                                onEvent(RadioUiEvent.ToggleScanLongPress)
                            }
                        },
                        onLongPress = {
                            if (state.scanActive) {
                                onEvent(RadioUiEvent.OpenScanPicker)
                            }
                        },
                    )
                },
        )
    }
    LcdReplayIcon(
        ready = p.statusAmber,
        muted = p.textMuted,
        playing = state.replayBanner.isNotEmpty(),
        modifier = Modifier
            .size(iconSize)
            .pointerInput(Unit) {
                detectTapGestures(
                    onTap = { onEvent(RadioUiEvent.PlayLastTransmission) },
                    onLongPress = { onEvent(RadioUiEvent.ToggleMessageHistory) },
                )
            },
    )
    LcdVolumeIcon(
        muted = p.textMuted,
        active = p.statusGreen,
        isMuted = !state.externalMicConnected,
        modifier = Modifier.size(iconSize),
    )
    }
}

@Composable
private fun LcdHandsetToolbarIrc590(
    state: RadioUiState,
    showBatteryStatus: Boolean,
    emergencyFlashAlpha: Float,
    zoneValue: String,
    channelValue: String,
    radiosValue: String,
    radiosKnown: Boolean,
    onEvent: (RadioUiEvent) -> Unit,
    styles: LcdTextStyles,
    modifier: Modifier = Modifier,
) {
    val p = RadioLcdTheme.palette
    val online = state.networkLabel == "ONLINE"
    val scanReceiving = state.scanBackgroundActive
    val accentOnEmergency = if (state.isEmergencyActive) Color.White else p.textPrimary
    val rowPad = 3.dp
    val statusIconCount = 5

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(rowPad),
    ) {
        BoxWithConstraints(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp),
        ) {
            val batteryReserve = if (showBatteryStatus) 92.dp else 0.dp
            val statusWidth = (maxWidth - batteryReserve).coerceAtLeast(0.dp)
            val squareSize = minOf(statusWidth / statusIconCount, maxHeight * 0.9f)
                .coerceIn(38.dp, 58.dp)
            val signalWidth = squareSize * 1.22f
            val signalHeight = squareSize * 0.78f
            val batteryW = (maxHeight * 0.55f).coerceIn(36.dp, 48.dp)
            val batteryH = batteryW * 0.5f
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                LcdHandsetToolbarStatusIcons(
                    state = state,
                    online = online,
                    scanReceiving = scanReceiving,
                    iconSize = squareSize,
                    signalWidth = signalWidth,
                    signalHeight = signalHeight,
                    onEvent = onEvent,
                    modifier = Modifier.weight(1f),
                    edgeToEdge = true,
                    showScanIcon = false,
                )
                if (showBatteryStatus) {
                    val batteryTextSp = (squareSize.value * 0.54f).coerceIn(20f, 26f).sp
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        LcdBatteryIcon(
                            percent = state.batteryPercent,
                            outline = if (state.isEmergencyActive) Color.White else p.textSecondary,
                            fillHigh = p.statusGreen,
                            fillLow = p.statusAmber,
                            fillCritical = p.statusRed,
                            modifier = Modifier.size(width = batteryW, height = batteryH),
                        )
                        Text(
                            text = "${state.batteryPercent}%",
                            style = styles.status.copy(
                                fontWeight = FontWeight.Bold,
                                fontSize = batteryTextSp,
                                lineHeight = (batteryTextSp.value * 1.1f).sp,
                            ),
                            color = if (state.isEmergencyActive) Color.White else p.textSecondary,
                            maxLines = 1,
                        )
                    }
                }
            }
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 50.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = state.systemTime.uppercase(Locale.US),
                style = styles.status.copy(
                    fontWeight = FontWeight.Bold,
                    fontSize = HANDSET_CLOCK_FONT_IRC590,
                    lineHeight = (HANDSET_CLOCK_FONT_IRC590.value * 1.08f).sp,
                ),
                color = accentOnEmergency,
                maxLines = 1,
                textAlign = TextAlign.Center,
            )
        }
        BoxWithConstraints(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 36.dp),
        ) {
            val statIconSize = minOf(maxWidth / 3.15f, maxHeight * 0.82f).coerceIn(28.dp, 40.dp)
            val statFontSize = (statIconSize.value * 0.58f).coerceIn(17f, 24f).sp
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    modifier = Modifier.weight(1f),
                    contentAlignment = Alignment.Center,
                ) {
                    LcdHandsetStat(
                        value = zoneValue,
                        valueColor = p.textSecondary,
                        styles = styles,
                        compact = true,
                        valueFontSize = statFontSize,
                    ) {
                        LcdZoneIcon(color = p.textSecondary, modifier = Modifier.size(statIconSize))
                    }
                }
                Box(
                    modifier = Modifier.weight(1f),
                    contentAlignment = Alignment.Center,
                ) {
                    LcdHandsetStat(
                        value = channelValue,
                        valueColor = p.textSecondary,
                        styles = styles,
                        compact = true,
                        valueFontSize = statFontSize,
                    ) {
                        LcdRadioIcon(color = p.textSecondary, modifier = Modifier.size(statIconSize))
                    }
                }
                Box(
                    modifier = Modifier.weight(1f),
                    contentAlignment = Alignment.Center,
                ) {
                    LcdHandsetStat(
                        value = radiosValue,
                        valueColor = if (radiosKnown) p.statusGreen else p.textMuted,
                        styles = styles,
                        compact = true,
                        valueFontSize = statFontSize,
                    ) {
                        LcdGlobeIcon(
                            color = if (radiosKnown) p.statusGreen else p.textMuted,
                            modifier = Modifier.size(statIconSize),
                        )
                    }
                }
            }
        }
        LcdHandsetToolbarScanBanner(state = state, styles = styles)
    }
}

@Composable
private fun LcdHandsetToolbarTm7(
    state: RadioUiState,
    @Suppress("UNUSED_PARAMETER") emergencyFlashAlpha: Float,
    zoneValue: String,
    channelValue: String,
    radiosValue: String,
    radiosKnown: Boolean,
    onEvent: (RadioUiEvent) -> Unit,
    styles: LcdTextStyles,
    modifier: Modifier = Modifier,
) {
    val p = RadioLcdTheme.palette
    val online = state.networkLabel == "ONLINE"
    val scanReceiving = state.scanBackgroundActive
    val accentOnEmergency = if (state.isEmergencyActive) Color.White else p.textPrimary
    val iconSize = 26.dp
    val iconGap = 5.dp
    val signalWidth = 34.dp
    val signalHeight = 22.dp
    val timeFontSize = HANDSET_CLOCK_FONT_TM7
    val minHeight = 40.dp

    Column(modifier = modifier) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = minHeight),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(
                modifier = Modifier.weight(1f, fill = false),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(iconGap),
            ) {
                LcdHandsetToolbarStatusIcons(
                    state = state,
                    online = online,
                    scanReceiving = scanReceiving,
                    iconSize = iconSize,
                    signalWidth = signalWidth,
                    signalHeight = signalHeight,
                    onEvent = onEvent,
                )
            }
            Text(
                text = state.systemTime.uppercase(Locale.US),
                style = styles.status.copy(fontWeight = FontWeight.Bold, fontSize = timeFontSize),
                color = accentOnEmergency,
                maxLines = 1,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .weight(1f)
                    .padding(horizontal = 4.dp),
            )
            LcdHandsetMetaRow(
                zoneValue = zoneValue,
                channelValue = channelValue,
                radiosValue = radiosValue,
                radiosKnown = radiosKnown,
                styles = styles,
            )
        }
        LcdHandsetToolbarScanBanner(state = state, styles = styles)
    }
}

@Composable
private fun LcdHandsetToolbarScanBanner(
    state: RadioUiState,
    styles: LcdTextStyles,
) {
    val p = RadioLcdTheme.palette
    if (state.scanBackgroundActive && state.scanBackgroundChannel.isNotBlank()) {
        return
    }
    if (state.scanActive && state.scanBackgroundChannel.isNotBlank()) {
        val bannerScanColor = rememberScanIconActiveColor(
            scanActive = true,
            scanReceiving = true,
        )
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 2.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            LcdScanIcon(
                on = true,
                active = bannerScanColor,
                muted = p.textMuted,
                modifier = Modifier.size(20.dp),
            )
            Spacer(modifier = Modifier.width(6.dp))
            Text(
                text = "SCAN RX · ${state.scanBackgroundChannel}",
                style = styles.status.copy(fontWeight = FontWeight.Bold, fontSize = 14.sp),
                color = p.statusAmber,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun LcdHandsetWarningRow(
    state: RadioUiState,
    onEvent: (RadioUiEvent) -> Unit,
    onRequestMicPermission: () -> Unit,
    styles: LcdTextStyles,
    modifier: Modifier = Modifier,
) {
    val p = RadioLcdTheme.palette
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (!state.micPermissionGranted) {
            Text(
                text = "ALLOW MIC",
                style = styles.softKey,
                color = p.statusBlue,
                modifier = Modifier.clickable { onRequestMicPermission() },
            )
        }
        if (state.channelSyncError != null) {
            Text(
                text = "RETRY SYNC",
                style = styles.softKey,
                color = p.statusAmber,
                modifier = Modifier.clickable { onEvent(RadioUiEvent.RetryChannelSync) },
            )
        }
    }
}

private fun handsetScanRxLabel(
    channelName: String,
    unitId: String,
    displayName: String,
): String {
    val channel = channelName.trim().uppercase(Locale.US)
    val unit = unitId.trim().uppercase(Locale.US)
    val name = displayName.trim()
    val who =
        when {
            unit.isNotEmpty() && name.isNotEmpty() -> "$unit • $name"
            unit.isNotEmpty() -> unit
            name.isNotEmpty() -> name.uppercase(Locale.US)
            else -> ""
        }
    return if (who.isNotEmpty()) "SCAN RX · $channel — $who" else "SCAN RX · $channel"
}

private fun handsetScaledLineSp(
    density: Density,
    maxHeight: Dp,
    maxWidth: Dp,
    text: String,
    heightFraction: Float,
    minSp: Float,
    maxSp: Float,
    widthCharsPerSp: Float = 0.48f,
): TextUnit {
    return with(density) {
        val byHeight = maxHeight.value * heightFraction
        val byWidth = maxWidth.value / (text.length.coerceAtLeast(2) * widthCharsPerSp)
        minOf(byHeight, byWidth).coerceIn(minSp, maxSp).sp
    }
}

/** Remote unit emergency — large channel, EMERGENCY, and unit id (TM7 / IRC590). */
@Composable
private fun LcdHandsetRemoteEmergencyBlock(
    channelName: String,
    unitId: String,
    channelColor: Color,
    emergencyColor: Color,
    deviceProfile: ResolvedDeviceProfile,
    styles: LcdTextStyles,
    modifier: Modifier = Modifier,
) {
    val idleChannelRange = handsetIdleChannelSpRange(deviceProfile)
    val channel = channelName.trim().uppercase(Locale.US)
    val unit = unitId.trim().uppercase(Locale.US)
    val density = LocalDensity.current
    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = 4.dp, vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        BoxWithConstraints(
            modifier = Modifier
                .weight(0.30f)
                .fillMaxWidth(),
            contentAlignment = Alignment.Center,
        ) {
            val channelSp =
                handsetScaledLineSp(
                    density = density,
                    maxHeight = maxHeight,
                    maxWidth = maxWidth,
                    text = channel,
                    heightFraction = 0.88f,
                    minSp = 20f,
                    maxSp = idleChannelRange.endInclusive * 0.55f,
                    widthCharsPerSp = 0.42f,
                )
            Text(
                text = channel,
                style = styles.channel.copy(
                    fontWeight = FontWeight.Bold,
                    fontSize = channelSp,
                    lineHeight = (channelSp.value * 1.05f).sp,
                ),
                color = channelColor,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        BoxWithConstraints(
            modifier = Modifier
                .weight(0.20f)
                .fillMaxWidth(),
            contentAlignment = Alignment.Center,
        ) {
            val emergencySp =
                handsetScaledLineSp(
                    density = density,
                    maxHeight = maxHeight,
                    maxWidth = maxWidth,
                    text = "EMERGENCY",
                    heightFraction = 0.88f,
                    minSp = 18f,
                    maxSp = 40f,
                )
            Text(
                text = "EMERGENCY",
                style = styles.channel.copy(
                    fontWeight = FontWeight.Bold,
                    fontSize = emergencySp,
                    lineHeight = (emergencySp.value * 1.05f).sp,
                ),
                color = emergencyColor,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        BoxWithConstraints(
            modifier = Modifier
                .weight(0.42f)
                .fillMaxWidth(),
            contentAlignment = Alignment.Center,
        ) {
            val unitSp =
                handsetScaledLineSp(
                    density = density,
                    maxHeight = maxHeight,
                    maxWidth = maxWidth,
                    text = unit.ifEmpty { "—" },
                    heightFraction = 0.92f,
                    minSp = idleChannelRange.start,
                    maxSp = idleChannelRange.endInclusive,
                    widthCharsPerSp = 0.5f,
                )
            Text(
                text = unit.ifEmpty { "—" },
                style = styles.channel.copy(
                    fontWeight = FontWeight.Bold,
                    fontSize = unitSp,
                    lineHeight = (unitSp.value * 1.05f).sp,
                ),
                color = emergencyColor,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/** Amber scan traffic line under the large home channel name. */
@Composable
private fun LcdHandsetScanRxStrip(
    channelName: String,
    unitId: String,
    displayName: String,
    styles: LcdTextStyles,
    modifier: Modifier = Modifier,
) {
    val p = RadioLcdTheme.palette
    val scanColor = rememberScanIconActiveColor(scanActive = true, scanReceiving = true)
    val label = handsetScanRxLabel(channelName, unitId, displayName)
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        LcdScanIcon(
            on = true,
            active = scanColor,
            muted = p.textMuted,
            modifier = Modifier.size(22.dp),
        )
        Spacer(modifier = Modifier.width(6.dp))
        Text(
            text = label,
            style = styles.status.copy(
                fontWeight = FontWeight.Bold,
                fontSize = 17.sp,
                lineHeight = 21.sp,
            ),
            color = scanColor,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
            modifier = Modifier.weight(1f, fill = false),
        )
    }
}

@Composable
private fun LcdHandsetTalkerBlock(
    unitId: String,
    displayName: String,
    unitColor: Color,
    nameColor: Color,
    styles: LcdTextStyles,
    modifier: Modifier = Modifier,
) {
    BoxWithConstraints(
        modifier = modifier.fillMaxWidth(),
        contentAlignment = Alignment.Center,
    ) {
        val density = LocalDensity.current
        val maxH = maxHeight
        val hasName = displayName.isNotBlank()
        val lineCount = if (hasName) 2 else 1
        val lineSp = with(density) {
            val cap = maxH.value / (lineCount * 1.15f)
            cap.coerceIn(26f, 48f).sp
        }
        Column(
            modifier = Modifier.fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                text = unitId.uppercase(Locale.US),
                style = styles.body.copy(
                    fontWeight = FontWeight.Bold,
                    fontSize = lineSp,
                    lineHeight = (lineSp.value * 1.08f).sp,
                ),
                color = unitColor,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
            if (hasName) {
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = displayName.uppercase(Locale.US),
                    style = styles.body.copy(
                        fontWeight = FontWeight.Bold,
                        fontSize = lineSp,
                        lineHeight = (lineSp.value * 1.08f).sp,
                    ),
                    color = nameColor,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

@Composable
private fun LcdTalkerAttribution(
    unitId: String,
    displayName: String,
    unitColor: Color,
    nameColor: Color,
    modifier: Modifier = Modifier,
) {
    val styles = rememberLcdTextStyles(RadioLcdTheme.palette)
    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            text = unitId.uppercase(Locale.US),
            style = styles.channel.copy(fontSize = 52.sp, lineHeight = 54.sp),
            color = unitColor,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
        if (displayName.isNotBlank()) {
            Text(
                text = displayName.uppercase(Locale.US),
                style = styles.body.copy(fontWeight = FontWeight.Normal, fontSize = 26.sp, lineHeight = 28.sp),
                color = nameColor,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

private data class ChannelDisplayChrome(
    val borderColor: Color,
    val borderWidth: Dp,
    val washColor: Color,
    val channelTextColor: Color,
    val talkLineColor: Color,
)

private fun channelDisplayChrome(
    state: RadioUiState,
    p: RadioLcdPalette,
    emergencyFlashAlpha: Float,
    handsetLayout: Boolean = false,
    localEmergencyFlashColor: Color? = null,
): ChannelDisplayChrome {
    return when {
        state.isEmergencyActive -> {
            val flash = localEmergencyFlashColor ?: p.statusEmergency
            val washAlpha =
                if (handsetLayout) {
                    emergencyFlashAlpha.coerceIn(HANDSET_EMERGENCY_WASH_LO, HANDSET_EMERGENCY_WASH_HI)
                } else {
                    emergencyFlashAlpha.coerceIn(0.2f, 0.75f)
                }
            val handsetText = Color.White.copy(
                alpha = (0.8f + emergencyFlashAlpha * 0.2f).coerceIn(0.8f, 1f),
            )
            ChannelDisplayChrome(
                borderColor = if (handsetLayout) flash else p.statusEmergency,
                borderWidth = 3.dp,
                washColor = flash.copy(alpha = washAlpha),
                channelTextColor = if (handsetLayout) handsetText else flash,
                talkLineColor = if (handsetLayout) handsetText else flash,
            )
        }
        state.isPttPressed && state.pttBusyTone -> ChannelDisplayChrome(
            borderColor = p.statusRed,
            borderWidth = 3.dp,
            washColor = p.statusRed.copy(alpha = 0.2f),
            channelTextColor = p.statusRed,
            talkLineColor = p.statusRed,
        )
        state.isPttPressed -> ChannelDisplayChrome(
            borderColor = p.statusGreen,
            borderWidth = 3.dp,
            washColor = p.statusGreen.copy(alpha = 0.18f),
            channelTextColor = p.statusGreen,
            talkLineColor = p.statusGreen,
        )
        state.rxAttributedLine.isNotBlank() -> ChannelDisplayChrome(
            borderColor = p.rxHighlight,
            borderWidth = 2.dp,
            washColor = p.rxHighlight.copy(alpha = 0.14f),
            channelTextColor = p.textPrimary,
            talkLineColor = p.rxHighlight,
        )
        state.remoteEmergencyUnit != null -> ChannelDisplayChrome(
            borderColor = p.statusEmergency.copy(alpha = 0.65f),
            borderWidth = 2.dp,
            washColor = p.statusEmergency.copy(alpha = 0.1f),
            channelTextColor = p.textPrimary,
            talkLineColor = p.statusEmergency,
        )
        else -> ChannelDisplayChrome(
            borderColor = if (handsetLayout) Color.Transparent else p.divider,
            borderWidth = if (handsetLayout) 0.dp else 1.dp,
            washColor = Color.Transparent,
            channelTextColor = p.textPrimary,
            talkLineColor = p.textSecondary,
        )
    }
}

private fun channelTalkLine(state: RadioUiState): String {
    return when {
        state.isEmergencyActive -> {
            val id = state.localShortUnitId.trim()
            if (id.isNotEmpty()) "EMERGENCY • UNIT $id • YOU" else "EMERGENCY • YOU"
        }
        state.isPttPressed -> {
            val id = state.localShortUnitId.trim()
            if (id.isNotEmpty()) "TX: UNIT $id • YOU" else "TX: LOCAL MIC"
        }
        else -> state.rxAttributedLine
    }
}

@Composable
private fun LcdBodyLine(
    text: String,
    styles: LcdTextStyles,
) {
    val p = RadioLcdTheme.palette
    Text(
        text = text.uppercase(Locale.US),
        style = styles.body,
        color = p.textSecondary,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

@Composable
private fun LcdSegmentButton(
    label: String,
    enabled: Boolean,
    onClick: () -> Unit,
    styles: LcdTextStyles,
    compact: Boolean = false,
) {
    val p = RadioLcdTheme.palette
    val interaction = remember { MutableInteractionSource() }
    Surface(
        onClick = { if (enabled) onClick() },
        enabled = enabled,
        modifier = Modifier
            .width(if (compact) 44.dp else 52.dp)
            .height(if (compact) 30.dp else 36.dp),
        shape = RoundedCornerShape(2.dp),
        color = if (enabled) p.softKeyInactiveFill else p.softKeyInactiveFill.copy(alpha = 0.35f),
        border = BorderStroke(1.dp, p.divider),
        interactionSource = interaction,
    ) {
        Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) {
            Text(
                text = label.uppercase(Locale.US),
                style = styles.softKey,
                color = if (enabled) p.textOnButton else p.textMuted,
            )
        }
    }
}

/** Full-width alert strip — lost-link status and last-message replay both use it. */
@Composable
private fun LcdAlertBanner(
    text: String,
    accent: Color,
    styles: LcdTextStyles,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(2.dp))
            .background(accent.copy(alpha = 0.14f))
            .border(1.dp, accent, RoundedCornerShape(2.dp))
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        Text(
            text = text,
            style = styles.banner,
            color = accent,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** Whisper transcript shown under the replay caption while audio plays. */
@Composable
private fun LcdReplayTranscriptBanner(
    text: String,
    styles: LcdTextStyles,
) {
    val p = RadioLcdTheme.palette
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(2.dp))
            .background(p.lcdAlt)
            .border(1.dp, p.textMuted.copy(alpha = 0.5f), RoundedCornerShape(2.dp))
            .padding(horizontal = 10.dp, vertical = 8.dp),
    ) {
        Text(
            text = text,
            style = styles.body.copy(
                fontWeight = FontWeight.Medium,
                fontSize = 18.sp,
                lineHeight = 24.sp,
            ),
            color = p.textPrimary,
            maxLines = 4,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun LcdStateBanner(
    state: RadioUiState,
    styles: LcdTextStyles,
) {
    val p = RadioLcdTheme.palette
    val (title, subtitle, accent) = deriveBanner(state, p)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(2.dp))
            .background(p.lcdSection)
            .border(1.dp, p.divider, RoundedCornerShape(2.dp))
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        when {
            state.isEmergencyActive -> LcdEmergencyGlyphIcon(color = accent, modifier = Modifier.size(18.dp))
            state.isPttPressed -> LcdMicIcon(color = accent, modifier = Modifier.size(16.dp))
            else -> Spacer(modifier = Modifier.width(4.dp))
        }
        Column(modifier = Modifier.weight(1f)) {
            val listenOnlyBanner =
                state.currentChannelPermission == ChannelPermission.LISTEN_ONLY &&
                    !state.isEmergencyActive &&
                    !state.isPttPressed
            Text(
                text = title,
                style = if (listenOnlyBanner) {
                    styles.banner.copy(
                        fontSize = 22.sp,
                        lineHeight = 26.sp,
                        fontWeight = FontWeight.Bold,
                    )
                } else {
                    styles.banner
                },
                color = accent,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = subtitle,
                style = if (listenOnlyBanner) {
                    styles.status.copy(
                        fontSize = 13.sp,
                        lineHeight = 16.sp,
                        fontWeight = FontWeight.Medium,
                    )
                } else {
                    styles.status
                },
                color = if (listenOnlyBanner) accent.copy(alpha = 0.85f) else p.textMuted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

private fun deriveBanner(state: RadioUiState, p: RadioLcdPalette): Triple<String, String, Color> {
    return when {
        state.isEmergencyActive -> Triple(
            "EMERGENCY",
            buildString {
                append("GPS ACTIVE · ")
                append("CH ")
                append(state.channelLabel.uppercase(Locale.US))
            },
            p.statusEmergency,
        )
        state.isPttPressed && state.pttBusyTone -> Triple(
            state.statusMessage.uppercase(Locale.US),
            if (state.micPermissionGranted) "MIC ON" else "MIC OFF",
            p.statusRed,
        )
        state.isPttPressed -> Triple(
            "TRANSMITTING",
            if (state.micPermissionGranted) "MIC LIVE" else "MIC BLOCKED",
            p.statusGreen,
        )
        state.scanActive -> Triple("SCANNING", "SCAN ON", p.statusAmber)
        state.networkLabel == "OFFLINE" && !state.channelsLoading -> Triple(
            "NO SIGNAL",
            state.statusMessage.uppercase(Locale.US),
            p.statusAmber,
        )
        state.currentChannelPermission == ChannelPermission.LISTEN_ONLY -> Triple(
            "LISTEN ONLY",
            "RX ONLY ON THIS CHANNEL",
            p.statusRed,
        )
        state.currentChannelPermission == ChannelPermission.TALK_PRIORITY -> Triple(
            "PRIORITY",
            "PRE-EMPTS NON-PRIORITY",
            p.statusAmber,
        )
        else -> Triple(
            state.statusMessage.uppercase(Locale.US),
            state.displayLine3.uppercase(Locale.US),
            p.textSecondary,
        )
    }
}

@Composable
private fun LcdPttBar(
    state: RadioUiState,
    lcdNightEffective: Boolean,
    onEvent: (RadioUiEvent) -> Unit,
    height: Dp,
    styles: LcdTextStyles,
    compact: Boolean = false,
) {
    val p = RadioLcdTheme.palette
    val fill = when {
        state.isPttPressed && state.pttBusyTone -> p.statusRed
        state.isPttPressed -> p.pttTransmitFill
        else -> p.pttIdleFill
    }
    val border = p.divider
    val label = when {
        state.isPttPressed && state.pttBusyTone -> "BUSY"
        state.isPttPressed -> "PTT"
        else -> "PTT"
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(height)
            .clip(RoundedCornerShape(2.dp))
            .border(1.dp, border, RoundedCornerShape(2.dp))
            .background(
                when {
                    state.isPttPressed && state.pttBusyTone -> fill
                    state.isPttPressed -> fill.copy(alpha = 0.92f)
                    else -> fill
                },
            )
            .pointerInput(Unit) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    onEvent(RadioUiEvent.PttPressed)
                    waitForUpOrCancellation()
                    onEvent(RadioUiEvent.PttReleased)
                }
            }
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        LcdMicIcon(
            color = when {
                state.isPttPressed && state.pttBusyTone -> p.textOnButton
                state.isPttPressed && lcdNightEffective -> Color.White.copy(alpha = 0.92f)
                state.isPttPressed -> Color.Black.copy(alpha = 0.85f)
                else -> p.textOnButton
            },
            modifier = Modifier.size(18.dp),
        )
        Spacer(modifier = Modifier.width(10.dp))
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                text = label,
                style = styles.softKey.copy(fontSize = 14.sp),
                color = when {
                    state.isPttPressed && state.pttBusyTone -> p.textOnButton
                    state.isPttPressed && lcdNightEffective -> Color.White.copy(alpha = 0.95f)
                    state.isPttPressed -> Color.Black.copy(alpha = 0.9f)
                    else -> p.textOnButton
                },
            )
            if (!compact) {
                Text(
                    text = "HOLD TO TRANSMIT",
                    style = styles.status,
                    color = when {
                        state.isPttPressed && state.pttBusyTone -> p.textOnButton.copy(alpha = 0.85f)
                        state.isPttPressed && lcdNightEffective -> Color.White.copy(alpha = 0.72f)
                        state.isPttPressed -> Color.Black.copy(alpha = 0.65f)
                        else -> p.textOnButton.copy(alpha = 0.9f)
                    },
                )
            }
        }
    }
}

@Composable
private fun LcdEmergencyRow(
    state: RadioUiState,
    onEvent: (RadioUiEvent) -> Unit,
    styles: LcdTextStyles,
    height: Dp = 44.dp,
) {
    val p = RadioLcdTheme.palette
    val interaction = remember { MutableInteractionSource() }
    Surface(
        onClick = { onEvent(RadioUiEvent.EmergencyToggle) },
        modifier = Modifier
            .fillMaxWidth()
            .height(height),
        shape = RoundedCornerShape(2.dp),
        color = if (state.isEmergencyActive) {
            p.statusEmergency.copy(alpha = 0.95f)
        } else {
            p.softKeyInactiveFill
        },
        border = BorderStroke(
            1.dp,
            if (state.isEmergencyActive) p.statusEmergency else p.divider,
        ),
        interactionSource = interaction,
    ) {
        Row(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Center,
        ) {
            LcdEmergencyGlyphIcon(
                color = if (state.isEmergencyActive) Color.White else p.textOnButton,
                modifier = Modifier.size(if (height < 42.dp) 16.dp else 18.dp),
            )
            Spacer(modifier = Modifier.width(10.dp))
            Text(
                text = if (state.isEmergencyActive) {
                    "EMERGENCY LATCHED"
                } else if (height < 42.dp) {
                    "EMERGENCY"
                } else {
                    "EMERGENCY (TAP)"
                },
                style = styles.softKey,
                color = if (state.isEmergencyActive) Color.White else p.textOnButton,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun LcdSoftKeyTwoRowStrip(
    labels: List<String>,
    state: RadioUiState,
    onEvent: (RadioUiEvent) -> Unit,
    styles: LcdTextStyles,
) {
    val top = labels.take(3)
    val bottom = labels.drop(3)
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        LcdSoftKeyRow(labels = top, state = state, onEvent = onEvent, styles = styles, rowHeight = 36.dp)
        LcdSoftKeyRow(labels = bottom, state = state, onEvent = onEvent, styles = styles, rowHeight = 36.dp, indexOffset = 3)
    }
}

@Composable
private fun LcdSoftKeyRow(
    labels: List<String>,
    state: RadioUiState,
    onEvent: (RadioUiEvent) -> Unit,
    styles: LcdTextStyles,
    rowHeight: Dp = 46.dp,
    indexOffset: Int = 0,
) {
    val p = RadioLcdTheme.palette
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(rowHeight)
            .clip(RoundedCornerShape(2.dp))
            .border(1.dp, p.divider, RoundedCornerShape(2.dp))
            .background(p.lcdSection),
    ) {
        labels.forEachIndexed { index, label ->
            if (index > 0) {
                Spacer(
                    modifier = Modifier
                        .fillMaxHeight()
                        .width(1.dp)
                        .background(p.divider),
                )
            }
            val globalIndex = index + indexOffset
            val active = when (globalIndex) {
                1 -> state.mappingSettingsVisible
                2 -> state.scanActive
                else -> false
            }
            val interaction = remember { MutableInteractionSource() }
            Surface(
                onClick = { onEvent(RadioUiEvent.SoftKeyPressed(globalIndex)) },
                modifier = Modifier
                    .weight(1f)
                    .fillMaxHeight(),
                shape = RoundedCornerShape(0.dp),
                color = if (active) p.softKeyActiveFill else p.softKeyInactiveFill,
                interactionSource = interaction,
            ) {
                Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) {
                    Text(
                        text = label.uppercase(Locale.US),
                        style = styles.softKey,
                        color = p.textOnButton,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

/**
 * Bottom legend for the TM-7 Plus's four physical hardware keys (left to right:
 * channel down, channel up, replay, day/night). The boxes sit above the keys
 * and double as touch targets for the same actions.
 */
@Composable
private fun LcdHardwareKeyLegend(
    onEvent: (RadioUiEvent) -> Unit,
    styles: LcdTextStyles,
    night: Boolean,
    rowHeight: Dp = 46.dp,
) {
    val p = RadioLcdTheme.palette
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(rowHeight)
            .clip(RoundedCornerShape(2.dp))
            .border(1.dp, p.divider, RoundedCornerShape(2.dp))
            .background(p.lcdSection),
    ) {
        LcdLegendKey(onClick = { onEvent(RadioUiEvent.ChannelDown) }) {
            LcdLegendLabel(text = "CH-", styles = styles, color = p.textOnButton)
        }
        LcdLegendSeparator(p.divider)
        LcdLegendKey(onClick = { onEvent(RadioUiEvent.ChannelUp) }) {
            LcdLegendLabel(text = "CH+", styles = styles, color = p.textOnButton)
        }
        LcdLegendSeparator(p.divider)
        LcdLegendKey(
            onClick = { onEvent(RadioUiEvent.PlayLastTransmission) },
            onLongClick = { onEvent(RadioUiEvent.ToggleMessageHistory) },
        ) {
            LcdReplayIcon(
                ready = p.textOnButton,
                muted = p.textOnButton,
                playing = true,
                modifier = Modifier.size(34.dp),
            )
        }
        LcdLegendSeparator(p.divider)
        LcdLegendKey(
            onClick = { onEvent(RadioUiEvent.ToggleDayNight) },
            onLongClick = { onEvent(RadioUiEvent.ToggleScanLongPress) },
        ) {
            LcdDayNightIcon(
                night = night,
                color = p.textOnButton,
                modifier = Modifier.size(34.dp),
            )
        }
    }
}

/** One equal-width cell of [LcdHardwareKeyLegend]; also a touch target. */
@Composable
private fun RowScope.LcdLegendKey(
    onClick: () -> Unit,
    onLongClick: (() -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val p = RadioLcdTheme.palette
    val interaction = remember { MutableInteractionSource() }
    val gestureModifier =
        if (onLongClick != null) {
            Modifier.pointerInput(onLongClick) {
                detectTapGestures(
                    onTap = { onClick() },
                    onLongPress = { onLongClick() },
                )
            }
        } else {
            Modifier
        }
    Surface(
        onClick = if (onLongClick == null) onClick else ({ }),
        modifier = Modifier
            .weight(1f)
            .fillMaxHeight()
            .then(gestureModifier),
        shape = RoundedCornerShape(0.dp),
        color = p.softKeyInactiveFill,
        interactionSource = interaction,
    ) {
        Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) {
            content()
        }
    }
}

@Composable
private fun LcdLegendSeparator(color: Color) {
    Spacer(
        modifier = Modifier
            .fillMaxHeight()
            .width(1.dp)
            .background(color),
    )
}

/** Channel-step label (CH- / CH+) sized to fill the legend cell. */
@Composable
private fun LcdLegendLabel(text: String, styles: LcdTextStyles, color: Color) {
    BoxWithConstraints(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        val density = LocalDensity.current
        val font = with(density) {
            val byHeight = constraints.maxHeight * 0.74f
            val byWidth = constraints.maxWidth / (text.length.coerceAtLeast(2) * 0.66f)
            minOf(byHeight, byWidth).toSp()
        }.value.coerceIn(18f, 64f).sp
        Text(
            text = text,
            style = styles.softKey.copy(fontSize = font, fontWeight = FontWeight.Bold),
            color = color,
            maxLines = 1,
        )
    }
}

@Composable
private fun ScanPickerChannelRow(
    label: String,
    selected: Boolean,
    isHome: Boolean,
    permission: ChannelPermission,
    rowHeight: Dp,
    onToggle: () -> Unit,
    styles: LcdTextStyles,
) {
    val p = RadioLcdTheme.palette
    Surface(
        onClick = { if (!isHome) onToggle() },
        color = when {
            isHome -> p.lcdAlt
            selected -> p.softKeyActiveFill
            else -> p.softKeyInactiveFill
        },
        shape = RoundedCornerShape(4.dp),
        modifier = Modifier
            .fillMaxWidth()
            .height(rowHeight),
    ) {
        Row(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier.size(rowHeight * 0.72f),
                contentAlignment = Alignment.Center,
            ) {
                Checkbox(
                    checked = selected,
                    enabled = !isHome,
                    onCheckedChange = { if (!isHome) onToggle() },
                    modifier = Modifier.size(rowHeight * 0.62f),
                )
            }
            Spacer(modifier = Modifier.width(8.dp))
            BoxWithConstraints(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxHeight(),
                contentAlignment = Alignment.CenterStart,
            ) {
                val density = LocalDensity.current
                val upper = label.uppercase(Locale.US)
                val titleSp = with(density) {
                    val byHeight = maxHeight.value * 0.58f
                    val byWidth = maxWidth.value / (upper.length.coerceAtLeast(4) * 0.52f)
                    minOf(byHeight, byWidth).coerceIn(20f, 34f).sp
                }
                Column(
                    modifier = Modifier.fillMaxWidth(),
                    verticalArrangement = Arrangement.Center,
                ) {
                    Text(
                        text = upper,
                        style = styles.body.copy(
                            fontWeight = FontWeight.Bold,
                            fontSize = titleSp,
                            lineHeight = (titleSp.value * 1.05f).sp,
                        ),
                        color = when {
                            isHome -> p.textMuted
                            selected -> p.statusAmber
                            else -> p.textPrimary
                        },
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (isHome) {
                        Text(
                            text = "HOME — PRIORITY RX",
                            style = styles.status.copy(
                                fontWeight = FontWeight.Bold,
                                fontSize = (titleSp.value * 0.42f).coerceIn(11f, 14f).sp,
                            ),
                            color = p.statusBlue,
                            maxLines = 1,
                        )
                    } else if (permission == ChannelPermission.LISTEN_ONLY) {
                        Text(
                            text = "LISTEN ONLY",
                            style = styles.status.copy(
                                fontWeight = FontWeight.Bold,
                                fontSize = (titleSp.value * 0.52f).coerceIn(16f, 22f).sp,
                                lineHeight = (titleSp.value * 0.58f).coerceIn(18f, 24f).sp,
                            ),
                            color = p.statusRed,
                            maxLines = 1,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ScanChannelPickerFullScreen(
    state: RadioUiState,
    onEvent: (RadioUiEvent) -> Unit,
    styles: LcdTextStyles,
) {
    if (!state.scanPickerVisible || state.channelCatalog.isEmpty()) return
    val p = RadioLcdTheme.palette
    val homeIdx = state.channelCatalog.indexOfFirst {
        it.equals(state.channelLabel.trim(), ignoreCase = true)
    }
    BackHandler { onEvent(RadioUiEvent.CloseScanPicker) }
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(p.lcdMain),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 10.dp, vertical = 8.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "SCAN CHANNELS",
                    style = styles.body.copy(fontWeight = FontWeight.Bold, fontSize = 18.sp),
                    color = p.textPrimary,
                )
                Text(
                    text = if (state.scanActive) "TURN SCAN OFF" else "SCAN OFF",
                    style = styles.status.copy(fontWeight = FontWeight.Bold, fontSize = 14.sp),
                    color = if (state.scanActive) p.statusAmber else p.textMuted,
                    modifier = Modifier.clickable {
                        if (state.scanActive) {
                            onEvent(RadioUiEvent.DisableScan)
                        }
                    },
                )
            }
            Text(
                text = "Tap a channel to scan it. Home channel always has priority.",
                style = styles.status.copy(fontSize = 12.sp),
                color = p.textMuted,
                modifier = Modifier.padding(top = 4.dp, bottom = 6.dp),
                maxLines = 2,
            )
            val rowHeight = 72.dp
            LazyColumn(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                itemsIndexed(state.channelCatalog) { index, label ->
                    val isHome = index == homeIdx
                    val selected = index in state.scanIncludedChannelIndices
                    val permission =
                        state.channelCatalogPermissions.getOrNull(index) ?: ChannelPermission.TALK
                    ScanPickerChannelRow(
                        label = label,
                        selected = selected,
                        isHome = isHome,
                        permission = permission,
                        rowHeight = rowHeight,
                        onToggle = { onEvent(RadioUiEvent.ToggleScanIncludeChannel(index)) },
                        styles = styles,
                    )
                }
            }
            TextButton(
                onClick = { onEvent(RadioUiEvent.CloseScanPicker) },
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 40.dp),
                colors = ButtonDefaults.textButtonColors(contentColor = p.statusBlue),
            ) {
                Text("DONE", style = styles.softKey.copy(fontWeight = FontWeight.Bold, fontSize = 16.sp))
            }
        }
    }
}

@Composable
private fun MessageHistoryScreen(
    state: RadioUiState,
    onEvent: (RadioUiEvent) -> Unit,
    styles: LcdTextStyles,
) {
    if (!state.messageHistoryVisible) return
    val p = RadioLcdTheme.palette
    BackHandler { onEvent(RadioUiEvent.CloseMessageHistory) }
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(p.lcdMain),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 10.dp, vertical = 8.dp),
        ) {
            if (state.rxMessageHistory.isEmpty()) {
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth(),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = "No messages yet.",
                        style = styles.body,
                        color = p.textMuted,
                    )
                }
            } else {
                LazyColumn(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(
                        items = state.rxMessageHistory,
                        key = { it.id },
                    ) { item ->
                        MessageHistoryRow(
                            item = item,
                            playing = state.historyPlayingId == item.id && !state.historyPlaybackPaused,
                            paused = state.historyPlayingId == item.id && state.historyPlaybackPaused,
                            onPlay = { onEvent(RadioUiEvent.PlayHistoryMessage(item.id)) },
                            styles = styles,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun MessageHistoryRow(
    item: RxMessageHistoryItem,
    playing: Boolean,
    paused: Boolean,
    onPlay: () -> Unit,
    styles: LcdTextStyles,
) {
    val p = RadioLcdTheme.palette
    val active = playing || paused
    Surface(
        color = if (active) p.softKeyActiveFill else p.lcdAlt,
        shape = RoundedCornerShape(4.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(10.dp),
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Surface(
                onClick = onPlay,
                shape = RoundedCornerShape(4.dp),
                color = if (active) p.statusAmber else p.softKeyInactiveFill,
                modifier = Modifier.size(56.dp),
            ) {
                Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) {
                    if (playing) {
                        LcdPauseIcon(
                            color = Color.White,
                            modifier = Modifier.size(32.dp),
                        )
                    } else {
                        LcdPlayIcon(
                            color = if (paused) Color.White else p.textOnButton,
                            modifier = Modifier.size(32.dp),
                        )
                    }
                }
            }
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = item.timeLabel,
                        style = styles.status.copy(fontWeight = FontWeight.Bold, fontSize = 14.sp),
                        color = p.textSecondary,
                    )
                    Text(
                        text = item.channelName.uppercase(Locale.US),
                        style = styles.status.copy(fontWeight = FontWeight.Bold, fontSize = 14.sp),
                        color = p.statusBlue,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Text(
                    text = item.transcript,
                    style = styles.body.copy(
                        fontWeight = FontWeight.Medium,
                        fontSize = 24.sp,
                        lineHeight = 30.sp,
                    ),
                    color = p.textPrimary,
                    maxLines = 8,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun ScanChannelPickerDialog(
    state: RadioUiState,
    onEvent: (RadioUiEvent) -> Unit,
    styles: LcdTextStyles,
) {
    if (!state.scanPickerVisible || state.channelCatalog.isEmpty()) return
    val p = RadioLcdTheme.palette
    val homeIdx = state.channelCatalog.indexOfFirst {
        it.equals(state.channelLabel.trim(), ignoreCase = true)
    }
    AlertDialog(
        onDismissRequest = { onEvent(RadioUiEvent.CloseScanPicker) },
        title = {
            Text(
                text = "SCAN CHANNEL LIST",
                color = p.textPrimary,
            )
        },
        text = {
            LazyColumn(
                modifier = Modifier.heightIn(max = 480.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                itemsIndexed(state.channelCatalog) { index, label ->
                    val isHome = index == homeIdx
                    val selected = index in state.scanIncludedChannelIndices
                    val permission =
                        state.channelCatalogPermissions.getOrNull(index) ?: ChannelPermission.TALK
                    ScanPickerChannelRow(
                        label = label,
                        selected = selected,
                        isHome = isHome,
                        permission = permission,
                        rowHeight = 64.dp,
                        onToggle = { onEvent(RadioUiEvent.ToggleScanIncludeChannel(index)) },
                        styles = styles,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onEvent(RadioUiEvent.CloseScanPicker) }) {
                Text("DONE", color = p.statusBlue)
            }
        },
    )
}

@Composable
fun HardwareMappingDialog(
    state: RadioUiState,
    onEvent: (RadioUiEvent) -> Unit,
    styles: LcdTextStyles,
) {
    if (!state.mappingSettingsVisible) return
    val p = RadioLcdTheme.palette

    AlertDialog(
        onDismissRequest = { onEvent(RadioUiEvent.CloseMappingSettings) },
        title = {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "BUTTON MAPPING",
                    color = p.textPrimary,
                )
                state.lastDetectedKey?.let {
                    Text(
                        text = "LAST KEY: $it",
                        style = styles.status,
                        color = p.statusBlue
                    )
                }
            }
        },
        text = {
            LazyColumn(
                modifier = Modifier.heightIn(max = 560.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item {
                    Column(
                        modifier = Modifier.fillMaxWidth(),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            text = "ACCOUNT",
                            style = styles.body.copy(fontWeight = FontWeight.Bold),
                            color = p.textPrimary,
                        )
                        TextButton(
                            onClick = { onEvent(RadioUiEvent.SignOut) },
                            modifier = Modifier.fillMaxWidth(),
                            colors = ButtonDefaults.textButtonColors(
                                containerColor = p.softKeyInactiveFill,
                                contentColor = p.statusAmber,
                            ),
                        ) {
                            Text("SIGN OUT".uppercase(Locale.US))
                        }
                        HorizontalDivider(color = p.divider)
                        Text(
                            text = "HANDSET LAYOUT",
                            style = styles.body.copy(fontWeight = FontWeight.Bold),
                            color = p.textPrimary,
                        )
                        Text(
                            text = "ACTIVE: ${state.resolvedDeviceProfile.label.uppercase(Locale.US)} · " +
                                "OVERRIDE: ${state.deviceProfilePreference.label.uppercase(Locale.US)}",
                            style = styles.status,
                            color = p.textMuted,
                        )
                        DeviceProfilePreference.entries.forEach { preference ->
                            val selected = state.deviceProfilePreference == preference
                            TextButton(
                                onClick = { onEvent(RadioUiEvent.SetDeviceProfilePreference(preference)) },
                                modifier = Modifier.fillMaxWidth(),
                                colors = ButtonDefaults.textButtonColors(
                                    containerColor = if (selected) {
                                        p.statusBlue.copy(alpha = 0.16f)
                                    } else {
                                        p.softKeyInactiveFill
                                    },
                                    contentColor = if (selected) p.statusGreen else p.textPrimary,
                                ),
                            ) {
                                Text(preference.label.uppercase(Locale.US))
                            }
                        }
                        HorizontalDivider(color = p.divider)
                        Text(
                            text = "DISPLAY OVER OTHER APPS",
                            style = styles.body.copy(fontWeight = FontWeight.Bold),
                            color = p.textPrimary,
                        )
                        Text(
                            text = if (state.needsOverlayPermission) {
                                "Required on some rugged radios so the tactical screen can return on top after PTT."
                            } else {
                                "Granted — the radio UI can draw over other apps when needed."
                            },
                            style = styles.status,
                            color = p.textMuted,
                        )
                        if (state.needsOverlayPermission) {
                            TextButton(
                                onClick = { onEvent(RadioUiEvent.RequestOverlayPermission) },
                                modifier = Modifier.fillMaxWidth(),
                                colors = ButtonDefaults.textButtonColors(
                                    containerColor = p.softKeyInactiveFill,
                                    contentColor = p.textOnButton,
                                ),
                            ) {
                                Text("OPEN OVERLAY PERMISSION".uppercase(Locale.US))
                            }
                        }
                        HorizontalDivider(color = p.divider)
                        Text(
                            text = "DISPLAY — DAY / NIGHT",
                            style = styles.body.copy(fontWeight = FontWeight.Bold),
                            color = p.textPrimary,
                        )
                        Text(
                            text = "CURRENT: ${state.themeMode.label.uppercase(Locale.US)} · SUN ICON / KEY TOGGLES DAY OR NIGHT",
                            style = styles.status,
                            color = p.textMuted,
                        )
                        HorizontalDivider(color = p.divider)
                        ThemeMode.entries.forEach { mode ->
                            val selected = state.themeMode == mode
                            TextButton(
                                onClick = { onEvent(RadioUiEvent.SetThemeMode(mode)) },
                                modifier = Modifier.fillMaxWidth(),
                                colors = ButtonDefaults.textButtonColors(
                                    containerColor = if (selected) {
                                        p.statusBlue.copy(alpha = 0.16f)
                                    } else {
                                        p.softKeyInactiveFill
                                    },
                                    contentColor = if (selected) p.statusGreen else p.textPrimary,
                                ),
                            ) {
                                Text(mode.label.uppercase(Locale.US))
                            }
                        }
                        HorizontalDivider(color = p.divider)
                        Text(
                            text = "BACKGROUND POWER",
                            style = styles.body.copy(fontWeight = FontWeight.Bold),
                            color = p.textPrimary,
                        )
                        Text(
                            text = "Open the battery screen and exempt this app if the manufacturer lets you. OEMs still may stop background work.",
                            style = styles.status,
                            color = p.textMuted,
                        )
                        TextButton(
                            onClick = { onEvent(RadioUiEvent.RequestIgnoreBatteryOptimizations) },
                            modifier = Modifier.fillMaxWidth(),
                            colors = ButtonDefaults.textButtonColors(
                                containerColor = p.softKeyInactiveFill,
                                contentColor = p.textOnButton,
                            ),
                        ) {
                            Text("IGNORE BATTERY SAVER PROMPT FOR THIS APP".uppercase(Locale.US))
                        }
                        HorizontalDivider(color = p.divider)
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Checkbox(
                                checked = state.announceChannelNameOnTune,
                                onCheckedChange = { onEvent(RadioUiEvent.ToggleVoiceAnnounceChannelTune) },
                            )
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = "SPOKEN CHANNEL ON TUNE",
                                    style = styles.body.copy(fontWeight = FontWeight.Bold),
                                    color = p.textPrimary,
                                )
                                Text(
                                    text = "Speak channel name aloud when switching (e.g. Green 2).",
                                    style = styles.status,
                                    color = p.textMuted,
                                )
                            }
                        }
                        HorizontalDivider(color = p.divider)
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 4.dp),
                        ) {
                            Text(
                                text = "P25-STYLE DIGITAL VOICE (IMBE)",
                                style = styles.body.copy(fontWeight = FontWeight.Bold),
                                color = p.textPrimary,
                            )
                            Text(
                                text = if (P25ImbeNative.isAvailable) {
                                    "Always on when the native vocoder is loaded: transmit uses 88-bit IMBE codewords. " +
                                        "GPL-2.0 codec (dvmvocoder) is bundled in the app binary."
                                } else {
                                    "Native codec did not load (check build ABI or reinstall); voice stays clear PCM until it loads."
                                },
                                style = styles.status,
                                color = p.textMuted,
                            )
                        }
                        HorizontalDivider(color = p.divider)
                        TextButton(
                            onClick = { onEvent(RadioUiEvent.PlayLastTransmission) },
                            modifier = Modifier.fillMaxWidth(),
                            colors = ButtonDefaults.textButtonColors(
                                containerColor = p.softKeyInactiveFill,
                                contentColor = p.textPrimary,
                            ),
                        ) {
                            Text("PLAY LAST MESSAGE (SCREEN)".uppercase(Locale.US))
                        }
                        HorizontalDivider(color = p.divider)
                        Text(
                            text = "HARDWARE KEYS",
                            style = styles.body.copy(fontWeight = FontWeight.Bold),
                            color = p.textPrimary,
                        )
                    }
                }
                itemsIndexed(HardwareAction.entries) { _, action ->
                    val codes = state.hardwareMappings[action] ?: emptySet()
                    val isListening = state.currentlyMappingAction == action

                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .border(1.dp, p.divider, RoundedCornerShape(4.dp))
                            .background(if (isListening) p.statusBlue.copy(alpha = 0.1f) else Color.Transparent)
                            .padding(8.dp)
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = action.label.uppercase(Locale.US),
                                style = styles.body.copy(fontWeight = FontWeight.Bold),
                                color = p.textPrimary
                            )
                            if (isListening) {
                                Text(
                                    text = "PRESS BUTTON...",
                                    style = styles.status,
                                    color = p.statusAmber
                                )
                            }
                        }
                        
                        Text(
                            text = if (codes.isEmpty()) "NO KEYS MAPPED" else "KEYS: ${codes.joinToString(", ")}",
                            style = styles.status,
                            color = p.textMuted,
                            modifier = Modifier.padding(vertical = 4.dp)
                        )

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            TextButton(
                                onClick = {
                                    if (isListening) onEvent(RadioUiEvent.StopListeningForMapping)
                                    else onEvent(RadioUiEvent.StartListeningForMapping(action))
                                },
                                modifier = Modifier.weight(1f),
                                colors = androidx.compose.material3.ButtonDefaults.textButtonColors(
                                    containerColor = if (isListening) p.statusAmber else p.softKeyInactiveFill,
                                    contentColor = p.textOnButton
                                )
                            ) {
                                Text(if (isListening) "STOP" else "ADD")
                            }
                            TextButton(
                                onClick = { onEvent(RadioUiEvent.ResetMappingToDefault(action)) },
                                modifier = Modifier.weight(1f),
                                colors = androidx.compose.material3.ButtonDefaults.textButtonColors(
                                    containerColor = p.softKeyInactiveFill,
                                    contentColor = p.textOnButton
                                )
                            ) {
                                Text("DEFAULT")
                            }
                            TextButton(
                                onClick = { onEvent(RadioUiEvent.ClearMapping(action)) },
                                modifier = Modifier.weight(1f),
                                colors = androidx.compose.material3.ButtonDefaults.textButtonColors(
                                    containerColor = p.softKeyInactiveFill,
                                    contentColor = p.textOnButton
                                )
                            ) {
                                Text("CLEAR")
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onEvent(RadioUiEvent.CloseMappingSettings) }) {
                Text("DONE", color = p.statusBlue)
            }
        },
    )
}

@Composable
fun SetupRequiredDialog(
    state: RadioUiState,
    onEvent: (RadioUiEvent) -> Unit,
) {
    if (!state.needsAudioPermission && !state.needsAccessibilityService) return
    val p = RadioLcdTheme.palette

    AlertDialog(
        onDismissRequest = { /* Force setup */ },
        title = {
            Text(
                text = "SETUP REQUIRED",
                color = p.textPrimary,
            )
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text(
                    text = "The radio requires permissions to function correctly.",
                    color = p.textSecondary
                )
                
                if (state.needsAudioPermission) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("• MICROPHONE ACCESS", fontWeight = FontWeight.Bold, color = p.textPrimary)
                        Text("Required for transmitting voice over the radio.", fontSize = 12.sp, color = p.textMuted)
                        TextButton(
                            onClick = { onEvent(RadioUiEvent.RequestAudioPermission) },
                            colors = androidx.compose.material3.ButtonDefaults.textButtonColors(containerColor = p.softKeyInactiveFill)
                        ) {
                            Text("GRANT MICROPHONE", color = p.textOnButton)
                        }
                    }
                }

                if (state.needsAccessibilityService) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("• ACCESSIBILITY SERVICE", fontWeight = FontWeight.Bold, color = p.textPrimary)
                        Text("Required for physical PTT & Emergency buttons to work in background.", fontSize = 12.sp, color = p.textMuted)
                        TextButton(
                            onClick = { onEvent(RadioUiEvent.OpenAccessibilitySettings) },
                            colors = androidx.compose.material3.ButtonDefaults.textButtonColors(containerColor = p.softKeyInactiveFill)
                        ) {
                            Text("ENABLE SERVICE", color = p.textOnButton)
                        }
                    }
                }
            }
        },
        confirmButton = {}
    )
}
