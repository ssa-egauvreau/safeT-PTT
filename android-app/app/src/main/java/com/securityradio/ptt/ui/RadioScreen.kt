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
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
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
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.securityradio.ptt.device.DeviceProfilePreference
import com.securityradio.ptt.device.DeviceProfileResolver
import com.securityradio.ptt.device.HardwareAction
import com.securityradio.ptt.device.P25ImbeNative
import com.securityradio.ptt.device.RadioLayoutPolicy
import com.securityradio.ptt.device.ResolvedDeviceProfile
import com.securityradio.ptt.presentation.RadioUiEvent
import com.securityradio.ptt.presentation.RadioUiState
import com.securityradio.ptt.presentation.ThemeMode
import com.securityradio.ptt.presentation.isLcdNight
import com.securityradio.ptt.ui.lcd.LcdBluetoothIcon
import com.securityradio.ptt.ui.lcd.LcdDayNightIcon
import com.securityradio.ptt.ui.lcd.LcdEmergencyGlyphIcon
import com.securityradio.ptt.ui.lcd.LcdGpsIcon
import com.securityradio.ptt.ui.lcd.LcdReplayIcon
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
                    .background(palette.lcdAlt)
                    .padding(start = 8.dp, end = 8.dp, top = 4.dp, bottom = 6.dp),
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .border(1.dp, palette.divider)
                        .background(palette.lcdMain)
                        .padding(horizontal = 8.dp, vertical = 8.dp),
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
                LcdConnectivityBanner(banner = state.connectivityBanner, styles = styles)
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
        ScanChannelPickerDialog(state = state, onEvent = onEvent)
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
                        hasBuffer = state.hasReplayBuffer,
                        modifier = Modifier
                            .size(24.dp)
                            .clickable { onEvent(RadioUiEvent.PlayLastTransmission) },
                    )
                    LcdVolumeIcon(
                        muted = p.textMuted,
                        active = p.statusGreen,
                        isMuted = state.listenVolumeMuted,
                        modifier = Modifier
                            .size(26.dp)
                            .clickable { onEvent(RadioUiEvent.ToggleListenVolume) },
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
                    style = styles.status,
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
                        active = p.statusAmber,
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
                    Text(
                        text = "BAT ${state.batteryPercent}%",
                        style = styles.status,
                        color = p.textSecondary,
                    )
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
        if (layout.minimalStatusBar) Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = state.systemTime.uppercase(Locale.US),
                style = styles.status,
                color = p.textPrimary,
            )
            Text(
                text = "BAT ${state.batteryPercent}%",
                style = styles.status,
                color = p.textSecondary,
            )
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

@Composable
private fun LcdMainChannelBlock(
    state: RadioUiState,
    onEvent: (RadioUiEvent) -> Unit,
    onRequestMicPermission: () -> Unit,
    tunerEnabled: Boolean,
    styles: LcdTextStyles,
    layout: RadioLayoutPolicy,
    modifier: Modifier = Modifier,
) {
    val p = RadioLcdTheme.palette
    // The flash animation is always running; its value is only applied while an
    // emergency is active. Driving it unconditionally avoids any conditional-
    // composition gap that could leave the orange wash static.
    val emergencyTransition = rememberInfiniteTransition(label = "local_emergency_flash")
    val emergencyFlashAnim by emergencyTransition.animateFloat(
        initialValue = 0.28f,
        targetValue = 0.72f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 550),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "emergency_flash_alpha",
    )
    val emergencyFlash = if (state.isEmergencyActive) emergencyFlashAnim else 0f
    val chrome = channelDisplayChrome(state, p, emergencyFlash)
    if (layout.handsetStatusDisplay) {
        LcdHandsetFillChannelBlock(
            state = state,
            chrome = chrome,
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
                    style = styles.status,
                    color = p.textMuted,
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

@Composable
private fun LcdHandsetFillChannelBlock(
    state: RadioUiState,
    chrome: ChannelDisplayChrome,
    onEvent: (RadioUiEvent) -> Unit,
    onRequestMicPermission: () -> Unit,
    styles: LcdTextStyles,
    modifier: Modifier = Modifier,
) {
    val p = RadioLcdTheme.palette
    val zoneLine = "${state.zoneLabel} · ${state.channelPosition}".uppercase(Locale.US)
    val radiosLine = state.radiosOnlineOnChannel?.let { n ->
        "RADIOS ONLINE · $n"
    } ?: "RADIOS ONLINE —"
    val talkUnit = when {
        state.isEmergencyActive ->
            state.activeTalkUnitId.ifBlank { state.localShortUnitId }.trim().uppercase(Locale.US)
        state.activeTalkUnitId.isNotBlank() -> state.activeTalkUnitId.trim().uppercase(Locale.US)
        !state.isEmergencyActive && state.remoteEmergencyUnit != null ->
            state.remoteEmergencyUnit.trim().uppercase(Locale.US)
        else -> ""
    }
    val talkName = when {
        state.isEmergencyActive -> state.activeTalkDisplayName.trim()
        state.activeTalkUnitId.isNotBlank() -> state.activeTalkDisplayName.trim()
        else -> ""
    }
    val talkColor = chrome.talkLineColor
    val showEmergencyBanner = state.remoteEmergencyUnit != null && !state.isEmergencyActive

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
        val hasTalk = talkUnit.isNotEmpty()
        val showWarnings = !state.micPermissionGranted || state.channelSyncError != null
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 14.dp),
        ) {
            LcdHandsetToolbar(
                state = state,
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
            Spacer(modifier = Modifier.height(6.dp))
            LcdDivider()
            Spacer(modifier = Modifier.height(6.dp))
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    text = zoneLine,
                    style = styles.status.copy(fontWeight = FontWeight.Bold, fontSize = 24.sp),
                    color = p.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = radiosLine.uppercase(Locale.US),
                    style = styles.status.copy(fontWeight = FontWeight.Bold, fontSize = 24.sp),
                    color = if (state.radiosOnlineOnChannel != null) p.textSecondary else p.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            BoxWithConstraints(
                modifier = Modifier
                    .weight(if (hasTalk) 2.35f else 3.1f)
                    .fillMaxWidth(),
                contentAlignment = Alignment.Center,
            ) {
                val channelText = state.channelLabel.uppercase(Locale.US)
                val density = LocalDensity.current
                // Scale the channel name to fill the block — height-capped, then
                // narrowed if the label is long so a wide name still fits.
                val channelFont = with(density) {
                    val byHeight = constraints.maxHeight * 0.82f
                    val byWidth = constraints.maxWidth /
                        (channelText.length.coerceAtLeast(3) * 0.66f)
                    minOf(byHeight, byWidth).toSp()
                }.value.coerceIn(40f, 190f).sp
                Text(
                    text = channelText,
                    style = styles.channel.copy(
                        fontSize = channelFont,
                        lineHeight = (channelFont.value * 1.05f).sp,
                    ),
                    color = chrome.channelTextColor,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (state.channelTen33) {
                    LcdEmergencyGlyphIcon(
                        color = p.statusAmber,
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .size(24.dp),
                    )
                }
            }
            if (hasTalk) {
                if (showEmergencyBanner) {
                    Text(
                        text = "EMERGENCY",
                        style = styles.status.copy(fontWeight = FontWeight.Bold, fontSize = 12.sp),
                        color = p.statusEmergency,
                        maxLines = 1,
                        modifier = Modifier.fillMaxWidth(),
                        textAlign = TextAlign.Center,
                    )
                    Spacer(modifier = Modifier.height(2.dp))
                }
                LcdHandsetTalkerBlock(
                    unitId = talkUnit,
                    displayName = talkName,
                    unitColor = talkColor,
                    nameColor = talkColor.copy(alpha = 0.9f),
                    styles = styles,
                    modifier = Modifier
                        .weight(1.45f)
                        .fillMaxWidth(),
                )
            }
        }
    }
}

/** Status icons + clock / battery / SET, spread edge to edge across the handset screen. */
@Composable
private fun LcdHandsetToolbar(
    state: RadioUiState,
    onEvent: (RadioUiEvent) -> Unit,
    styles: LcdTextStyles,
    modifier: Modifier = Modifier,
) {
    val p = RadioLcdTheme.palette
    val online = state.networkLabel == "ONLINE"
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 40.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            LcdSignalBarsIcon(
                bars = if (online) 4 else 1,
                maxBars = 4,
                colorActive = if (online) p.statusGreen else p.statusAmber,
                colorInactive = p.textMuted,
                modifier = Modifier.size(46.dp, 32.dp),
            )
            LcdBluetoothIcon(
                on = state.bluetoothOn,
                active = p.statusBlue,
                muted = p.textMuted,
                modifier = Modifier.size(36.dp),
            )
            LcdGpsIcon(
                active = p.statusGreen,
                muted = p.textMuted,
                locked = true,
                modifier = Modifier.size(36.dp),
            )
            LcdReplayIcon(
                ready = p.statusAmber,
                muted = p.textMuted,
                hasBuffer = state.hasReplayBuffer,
                modifier = Modifier
                    .size(38.dp)
                    .clickable { onEvent(RadioUiEvent.PlayLastTransmission) },
            )
            LcdVolumeIcon(
                muted = p.textMuted,
                active = p.statusGreen,
                isMuted = state.listenVolumeMuted,
                modifier = Modifier
                    .size(40.dp)
                    .clickable { onEvent(RadioUiEvent.ToggleListenVolume) },
            )
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                text = state.systemTime.uppercase(Locale.US),
                style = styles.status.copy(fontWeight = FontWeight.Bold, fontSize = 18.sp),
                color = p.textPrimary,
            )
            Text(
                text = "BAT ${state.batteryPercent}%",
                style = styles.status.copy(fontWeight = FontWeight.Bold, fontSize = 18.sp),
                color = p.textSecondary,
            )
            Text(
                text = "SET",
                style = styles.softKey.copy(fontWeight = FontWeight.Bold, fontSize = 16.sp),
                color = p.statusBlue,
                modifier = Modifier.clickable { onEvent(RadioUiEvent.OpenMappingSettings) },
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
        val unitSp = with(density) {
            val cap = if (hasName) maxH.value * 0.42f else maxH.value * 0.55f
            cap.coerceIn(30f, 48f).sp
        }
        val nameSp = with(density) {
            val cap = maxH.value * 0.28f
            cap.coerceIn(14f, 22f).sp
        }
        Column(
            modifier = Modifier.fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                text = unitId.uppercase(Locale.US),
                style = styles.channel.copy(
                    fontSize = unitSp,
                    lineHeight = (unitSp.value * 1.05f).sp,
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
                        fontWeight = FontWeight.Normal,
                        fontSize = nameSp,
                        lineHeight = (nameSp.value * 1.1f).sp,
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
): ChannelDisplayChrome {
    return when {
        state.isEmergencyActive -> ChannelDisplayChrome(
            borderColor = p.statusEmergency,
            borderWidth = 3.dp,
            washColor = p.statusEmergency.copy(alpha = emergencyFlashAlpha.coerceIn(0.2f, 0.75f)),
            channelTextColor = p.statusEmergency,
            talkLineColor = p.statusEmergency,
        )
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
            borderColor = p.divider,
            borderWidth = 1.dp,
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

/** Lost-link strip: red while NO CONNECTION / RECONNECTING, green on RECONNECTED. */
@Composable
private fun LcdConnectivityBanner(
    banner: String,
    styles: LcdTextStyles,
) {
    val p = RadioLcdTheme.palette
    val accent = if (banner == RadioUiState.BANNER_RECONNECTED) p.statusGreen else p.statusRed
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
            text = banner,
            style = styles.banner,
            color = accent,
            maxLines = 1,
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
            Text(
                text = title,
                style = styles.banner,
                color = accent,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = subtitle,
                style = styles.status,
                color = p.textMuted,
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
        LcdLegendKey(onClick = { onEvent(RadioUiEvent.PlayLastTransmission) }) {
            LcdReplayIcon(
                ready = p.textOnButton,
                muted = p.textOnButton,
                hasBuffer = true,
                modifier = Modifier.size(34.dp),
            )
        }
        LcdLegendSeparator(p.divider)
        LcdLegendKey(onClick = { onEvent(RadioUiEvent.ToggleDayNight) }) {
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
    content: @Composable () -> Unit,
) {
    val p = RadioLcdTheme.palette
    val interaction = remember { MutableInteractionSource() }
    Surface(
        onClick = onClick,
        modifier = Modifier
            .weight(1f)
            .fillMaxHeight(),
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
private fun ScanChannelPickerDialog(
    state: RadioUiState,
    onEvent: (RadioUiEvent) -> Unit,
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
                modifier = Modifier.heightIn(max = 380.dp),
            ) {
                itemsIndexed(state.channelCatalog) { index, label ->
                    val isHome = index == homeIdx
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Checkbox(
                            checked = index in state.scanIncludedChannelIndices,
                            enabled = !isHome,
                            onCheckedChange = { if (!isHome) onEvent(RadioUiEvent.ToggleScanIncludeChannel(index)) },
                        )
                        Column(Modifier.weight(1f)) {
                            Text(
                                text = label.uppercase(Locale.US),
                                color = if (isHome) p.textMuted else p.textPrimary,
                            )
                            if (isHome) {
                                Text(
                                    text = "HOME — PRIORITY RX",
                                    fontSize = 10.sp,
                                    color = p.statusBlue,
                                )
                            }
                        }
                    }
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
                            text = "LEGACY RADIO KEY (OPTIONAL)",
                            style = styles.body.copy(fontWeight = FontWeight.Bold),
                            color = p.textPrimary,
                        )
                        Text(
                            text = if (state.agencyRadioKey.isBlank()) {
                                "Not used while signed in. Only needed for older setups without username/password."
                            } else {
                                "Legacy override — sign out to use key-based access instead of your account."
                            },
                            style = styles.status,
                            color = p.textMuted,
                        )
                        var agencyKeyDraft by remember(state.agencyRadioKey) {
                            mutableStateOf(state.agencyRadioKey)
                        }
                        OutlinedTextField(
                            value = agencyKeyDraft,
                            onValueChange = { agencyKeyDraft = it },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                            label = { Text("AGENCY RADIO KEY") },
                        )
                        TextButton(
                            onClick = { onEvent(RadioUiEvent.SaveAgencyRadioKey(agencyKeyDraft)) },
                            modifier = Modifier.fillMaxWidth(),
                            enabled = agencyKeyDraft.trim() != state.agencyRadioKey,
                            colors = ButtonDefaults.textButtonColors(
                                containerColor = p.softKeyInactiveFill,
                                contentColor = p.textPrimary,
                            ),
                        ) {
                            Text("SAVE AGENCY KEY".uppercase(Locale.US))
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
