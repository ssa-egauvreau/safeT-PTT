package com.securityradio.ptt.ui

import androidx.compose.animation.Crossfade
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
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.securityradio.ptt.device.HardwareAction
import com.securityradio.ptt.presentation.RadioUiEvent
import com.securityradio.ptt.presentation.RadioUiState
import com.securityradio.ptt.presentation.ThemeMode
import com.securityradio.ptt.presentation.isLcdNight
import com.securityradio.ptt.ui.lcd.LcdDayNightIcon
import com.securityradio.ptt.ui.lcd.LcdEmergencyGlyphIcon
import com.securityradio.ptt.ui.lcd.LcdGpsIcon
import com.securityradio.ptt.ui.lcd.LcdListChannelIcon
import com.securityradio.ptt.ui.lcd.LcdMicIcon
import com.securityradio.ptt.ui.lcd.LcdScanIcon
import com.securityradio.ptt.ui.lcd.LcdSignalBarsIcon
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

    Crossfade(
        targetState = isNight,
        animationSpec = tween(durationMillis = 210),
        label = "lcd_day_night",
        modifier = modifier.fillMaxSize(),
    ) { night ->
        val palette = if (night) RadioLcdPalette.night() else RadioLcdPalette.day()
        CompositionLocalProvider(LocalRadioLcdPalette provides palette) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(palette.lcdAlt)
                    .padding(horizontal = 8.dp, vertical = 8.dp),
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
        val isCompact = maxWidth < 420.dp
        val gap = if (isCompact) 6.dp else 8.dp
        val pttHeight = if (isCompact) 52.dp else 58.dp

        Column(
            modifier = Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(gap),
        ) {
            LcdStatusBar(
                state = state,
                lcdNightEffective = lcdNightEffective,
                onEvent = onEvent,
                onRequestMicPermission = onRequestMicPermission,
                styles = styles,
            )
            LcdDivider()
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth(),
            ) {
                LcdMainChannelBlock(
                    state = state,
                    onEvent = onEvent,
                    tunerEnabled = tunerEnabled,
                    styles = styles,
                    modifier = Modifier.fillMaxSize(),
                )
            }
            LcdDivider()
            LcdStateBanner(state = state, styles = styles)
            LcdPttBar(
                state = state,
                lcdNightEffective = lcdNightEffective,
                onEvent = onEvent,
                height = pttHeight,
                styles = styles,
            )
            LcdEmergencyRow(state = state, onEvent = onEvent, styles = styles)
            LcdSoftKeyRow(labels = state.softKeyLabels, state = state, onEvent = onEvent, styles = styles)
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
) {
    val p = RadioLcdTheme.palette
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(2.dp))
            .background(p.lcdSection)
            .border(1.dp, p.divider, RoundedCornerShape(2.dp))
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                text = state.systemTime.uppercase(Locale.US),
                style = styles.status,
                color = p.textPrimary,
            )
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                LcdSignalBarsIcon(
                    bars = state.signalBars,
                    maxBars = state.maxSignalBars,
                    colorActive = p.statusBlue,
                    colorInactive = p.textMuted.copy(alpha = 0.45f),
                    modifier = Modifier.size(width = 34.dp, height = 14.dp),
                )
                LcdGpsIcon(
                    active = p.statusGreen,
                    muted = p.textMuted,
                    locked = state.gpsActive,
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
        Row(
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
            val detail = if (state.rssiExpanded) {
                " · RSSI ${state.signalBars}/${state.maxSignalBars}"
            } else {
                ""
            }
            Text(
                text = linkLabel + detail,
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
    tunerEnabled: Boolean,
    styles: LcdTextStyles,
    modifier: Modifier = Modifier,
) {
    val p = RadioLcdTheme.palette
    val txBorder = when {
        state.isPttPressed && state.pttBusyTone -> p.txOverlayBusy
        state.isPttPressed -> p.txOverlayClear
        else -> p.divider
    }
    val borderW = if (state.isPttPressed) 3.dp else 1.dp
    val txWash = when {
        state.isPttPressed && state.pttBusyTone -> p.txOverlayBusy.copy(alpha = 0.18f)
        state.isPttPressed -> p.txOverlayClear.copy(alpha = 0.16f)
        else -> Color.Transparent
    }
    val talkLine = when {
        state.isPttPressed -> {
            val id = state.localShortUnitId.trim()
            if (id.isNotEmpty()) "TX: UNIT $id • YOU" else "TX: LOCAL MIC"
        }
        else -> state.rxAttributedLine
    }
    val talkColor = when {
        state.isPttPressed && state.pttBusyTone -> p.statusAmber
        state.isPttPressed -> p.statusGreen
        else -> p.statusBlue
    }
    Box(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(2.dp))
            .border(borderW, txBorder, RoundedCornerShape(2.dp))
            .background(p.lcdAlt),
    ) {
        if (txWash != Color.Transparent) {
            Box(
                modifier = Modifier
                    .matchParentSize()
                    .background(txWash),
            )
        }
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                LcdSegmentButton(
                    label = "CH-",
                    enabled = tunerEnabled,
                    onClick = { onEvent(RadioUiEvent.ChannelDown) },
                    styles = styles,
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
                )
            }
            Text(
                text = state.channelLabel.uppercase(Locale.US),
                style = styles.channel,
                color = p.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.fillMaxWidth(),
                textAlign = TextAlign.Center,
            )
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
            if (talkLine.isNotBlank()) {
                Text(
                    text = talkLine.uppercase(Locale.US),
                    style = styles.body.copy(fontWeight = FontWeight.Bold),
                    color = talkColor,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.fillMaxWidth(),
                    textAlign = TextAlign.Center,
                )
            }
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
            if (state.scanActive && state.channelCatalog.size > 1) {
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
) {
    val p = RadioLcdTheme.palette
    val interaction = remember { MutableInteractionSource() }
    Surface(
        onClick = { if (enabled) onClick() },
        enabled = enabled,
        modifier = Modifier
            .width(52.dp)
            .height(36.dp),
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
                if (state.gpsActive) append("GPS ACTIVE · ")
                append("CH ")
                append(state.channelLabel.uppercase(Locale.US))
            },
            p.statusEmergency,
        )
        state.isPttPressed && state.pttBusyTone -> Triple(
            state.statusMessage.uppercase(Locale.US),
            if (state.micPermissionGranted) "MIC ON" else "MIC OFF",
            p.statusAmber,
        )
        state.isPttPressed -> Triple(
            "TRANSMITTING",
            if (state.micPermissionGranted) "MIC LIVE" else "MIC BLOCKED",
            p.statusGreen,
        )
        state.scanActive -> Triple("SCANNING", "SCAN ON", p.statusAmber)
        state.gpsActive -> Triple("GPS LOCK", "TRACKING", p.statusBlue)
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
) {
    val p = RadioLcdTheme.palette
    val fill = when {
        state.isPttPressed && state.pttBusyTone -> p.pttBusyFill
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

@Composable
private fun LcdEmergencyRow(
    state: RadioUiState,
    onEvent: (RadioUiEvent) -> Unit,
    styles: LcdTextStyles,
) {
    val p = RadioLcdTheme.palette
    val interaction = remember { MutableInteractionSource() }
    Surface(
        onClick = { onEvent(RadioUiEvent.EmergencyToggle) },
        modifier = Modifier
            .fillMaxWidth()
            .height(44.dp),
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
                modifier = Modifier.size(18.dp),
            )
            Spacer(modifier = Modifier.width(10.dp))
            Text(
                text = if (state.isEmergencyActive) "EMERGENCY LATCHED" else "EMERGENCY (TAP)",
                style = styles.softKey,
                color = if (state.isEmergencyActive) Color.White else p.textOnButton,
            )
        }
    }
}

@Composable
private fun LcdSoftKeyRow(
    labels: List<String>,
    state: RadioUiState,
    onEvent: (RadioUiEvent) -> Unit,
    styles: LcdTextStyles,
) {
    val p = RadioLcdTheme.palette
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(46.dp)
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
            val active = when (index) {
                1 -> state.rssiExpanded
                2 -> state.scanActive
                3 -> state.gpsActive
                else -> false
            }
            val interaction = remember { MutableInteractionSource() }
            Surface(
                onClick = { onEvent(RadioUiEvent.SoftKeyPressed(index)) },
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
                            text = "DISPLAY — DAY / NIGHT",
                            style = styles.body.copy(fontWeight = FontWeight.Bold),
                            color = p.textPrimary,
                        )
                        Text(
                            text = "CURRENT: ${state.themeMode.label.uppercase(Locale.US)} · TOP-RIGHT SUN ICON ALSO CYCLES OVERRIDE",
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
