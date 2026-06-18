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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.zIndex
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Brush
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
import com.securityradio.ptt.BuildConfig
import com.securityradio.ptt.device.AccessibilitySettingsLauncher
import com.securityradio.ptt.device.DeviceProfilePreference
import com.securityradio.ptt.device.DeviceProfileResolver
import com.securityradio.ptt.device.HardwareAction
import com.securityradio.ptt.device.P25ImbeNative
import com.securityradio.ptt.device.RadioLayoutPolicy
import com.securityradio.ptt.device.RadioPreferences
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
import kotlinx.coroutines.withTimeoutOrNull

private val HANDSET_CLOCK_FONT_IRC590 = 44.sp
private val HANDSET_ZONE_LINE_SP_IRC590 = 30.sp
private val HANDSET_PERMISSION_LISTEN_SP_IRC590 = 32.sp
private val HANDSET_PERMISSION_PRIORITY_SP_IRC590 = 24.sp
private val HANDSET_ZONE_LINE_SP_DEFAULT = 26.sp
private val HANDSET_CLOCK_FONT_TM7 = 38.sp
private const val HANDSET_EMERGENCY_FLASH_LO = 0.38f
private const val HANDSET_EMERGENCY_FLASH_HI = 0.92f
/** Hold duration that arms emergency from the universal-cockpit EMER button. */
private const val EMERGENCY_LONG_PRESS_MS: Long = 1500
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

        // The rugged handsets (IRC590 / TM-7 Plus) render their main display at 24–82 sp; the
        // shared LCD chrome styles (10.5–30 sp) are unreadably small on them, so the full-screen
        // update overlays scale up on those profiles. The progress line is the one the operator
        // actually watches ("DOWNLOADING 45%"), so it gets the larger bump.
        val overlayLarge = layout.handsetStatusDisplay
        val overlayTitleStyle =
            if (overlayLarge) {
                styles.channel.copy(fontWeight = FontWeight.Bold, fontSize = 36.sp, lineHeight = 40.sp)
            } else {
                styles.channel.copy(fontWeight = FontWeight.Bold)
            }
        val overlaySubtitleStyle =
            if (overlayLarge) {
                styles.zone.copy(fontWeight = FontWeight.Bold, fontSize = 22.sp, lineHeight = 26.sp)
            } else {
                styles.zone.copy(fontWeight = FontWeight.Bold)
            }
        val overlayDetailStyle =
            if (overlayLarge) {
                styles.status.copy(fontWeight = FontWeight.Bold, fontSize = 28.sp, lineHeight = 32.sp)
            } else {
                styles.status
            }

        Box(modifier = Modifier.fillMaxSize()) {
            if (state.updateInstalling) {
                Box(
                    modifier = Modifier
                        .matchParentSize()
                        .zIndex(50f)
                        .background(palette.statusAmber)
                        .padding(28.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text(
                            text = "DOWNLOADING UPDATE",
                            style = overlayTitleStyle,
                            color = Color.Black,
                            textAlign = TextAlign.Center,
                        )
                        Text(
                            text = "DO NOT TURN OFF DEVICE",
                            style = overlaySubtitleStyle,
                            color = Color.Black,
                            textAlign = TextAlign.Center,
                        )
                        if (state.appUpdateBanner.isNotEmpty()) {
                            Text(
                                text = state.appUpdateBanner,
                                style = overlayDetailStyle,
                                color = Color.Black.copy(alpha = 0.8f),
                                textAlign = TextAlign.Center,
                            )
                        }
                    }
                }
            }
            if (handsetLocalEmergencyActive) {
                Box(
                    modifier = Modifier
                        .matchParentSize()
                        .background(handsetEmergencyFlashColor.copy(alpha = 0.68f)),
                )
            }
            state.updateInstalledNotice?.let { version ->
                // Persistent post-install confirmation overlay. Z-ordered above the regular UI so
                // operators see it regardless of which profile / screen they're on. Cleared by any
                // hardware-key press (via RadioViewModel) or by tapping the overlay.
                Box(
                    modifier = Modifier
                        .matchParentSize()
                        .zIndex(51f)
                        .background(palette.statusGreen)
                        .clickable { onEvent(RadioUiEvent.DismissUpdateInstalledNotice) }
                        .padding(28.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        Text(
                            text = "UPDATE INSTALLED SUCCESSFULLY",
                            style = overlayTitleStyle,
                            color = Color.Black,
                            textAlign = TextAlign.Center,
                        )
                        Text(
                            text = "v$version",
                            style = overlayDetailStyle,
                            color = Color.Black,
                            textAlign = TextAlign.Center,
                        )
                        Text(
                            text = "PUSH ANY BUTTON TO CLOSE THIS MESSAGE",
                            style = overlaySubtitleStyle,
                            color = Color.Black.copy(alpha = 0.8f),
                            textAlign = TextAlign.Center,
                        )
                    }
                }
            }
            if (layout.universalCockpit) {
                LcdUniversalCockpit(
                    state = state,
                    lcdNightEffective = lcdNightEffective,
                    onEvent = onEvent,
                    onRequestMicPermission = onRequestMicPermission,
                    styles = styles,
                    layout = layout,
                )
            } else {
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
                    large = layout.handsetStatusDisplay,
                )
            }
            if (state.appUpdateBanner.isNotEmpty()) {
                LcdAlertBanner(
                    text = state.appUpdateBanner,
                    accent = palette.statusAmber,
                    styles = styles,
                    large = layout.handsetStatusDisplay,
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
                        large = layout.handsetStatusDisplay,
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

/**
 * Universal touch cockpit (#15): a single mobile-friendly layout that fits any phone screen,
 * built around a big centred circular PTT. Channel name large at the top, channel up/down /
 * replay / scan / long-press-emergency along the bottom; the standard bottom hardware-key legend
 * is hidden since this layout has its own on-screen counterparts.
 */
@Composable
private fun LcdUniversalCockpit(
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
            .fillMaxSize()
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        LcdStatusBar(
            state = state,
            lcdNightEffective = lcdNightEffective,
            onEvent = onEvent,
            onRequestMicPermission = onRequestMicPermission,
            styles = styles,
            layout = layout,
        )
        if (state.connectivityBanner.isNotEmpty()) {
            LcdAlertBanner(
                text = state.connectivityBanner,
                accent = if (state.connectivityBanner == RadioUiState.BANNER_RECONNECTED) {
                    p.statusGreen
                } else {
                    p.statusRed
                },
                styles = styles,
            )
        }
        if (state.appUpdateBanner.isNotEmpty()) {
            LcdAlertBanner(
                text = state.appUpdateBanner,
                accent = p.statusAmber,
                styles = styles,
            )
        }
        if (state.replayBanner.isNotEmpty()) {
            LcdAlertBanner(text = state.replayBanner, accent = p.statusAmber, styles = styles)
            if (state.replayTranscript.isNotBlank()) {
                LcdReplayTranscriptBanner(text = state.replayTranscript, styles = styles)
            }
        }
        if (state.scanBackgroundActive && state.scanBackgroundChannel.isNotBlank()) {
            UniversalCockpitScanBanner(state = state, styles = styles)
        }
        UniversalCockpitMainPanel(
            state = state,
            onEvent = onEvent,
            styles = styles,
            modifier = Modifier.weight(1f).fillMaxWidth(),
        )
        UniversalCockpitControlsRow(
            state = state,
            onEvent = onEvent,
            styles = styles,
        )
    }
}

@Composable
private fun UniversalCockpitScanBanner(state: RadioUiState, styles: LcdTextStyles) {
    val p = RadioLcdTheme.palette
    val bannerColor = rememberScanIconActiveColor(scanActive = true, scanReceiving = true)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(2.dp))
            .background(p.lcdSection)
            .border(1.dp, p.statusAmber.copy(alpha = 0.6f), RoundedCornerShape(2.dp))
            .padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        LcdScanIcon(
            on = true,
            active = bannerColor,
            muted = p.textMuted,
            modifier = Modifier.size(20.dp),
        )
        Text(
            text = "SCAN RX · ${state.scanBackgroundChannel.uppercase(Locale.US)}",
            style = styles.status.copy(fontWeight = FontWeight.Bold, fontSize = 14.sp),
            color = p.statusAmber,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** Rainbow "AI DISPATCH" pill shown under the channel name when the tuned channel runs the AI dispatcher. */
@Composable
private fun AiDispatchBadge(visible: Boolean, styles: LcdTextStyles) {
    if (!visible) return
    val rainbow = Brush.horizontalGradient(
        listOf(
            Color(0xFFFF5F6D),
            Color(0xFFFFC371),
            Color(0xFF38F9D7),
            Color(0xFF7F7FD5),
            Color(0xFFFF5F6D),
        ),
    )
    Box(
        modifier = Modifier
            .background(rainbow, RoundedCornerShape(50))
            .padding(horizontal = 12.dp, vertical = 3.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = "✦ AI DISPATCH",
            style = styles.status.copy(fontWeight = FontWeight.Bold, fontSize = 12.sp),
            color = Color(0xFF0B0B12),
            maxLines = 1,
        )
    }
}

@Composable
private fun UniversalCockpitMainPanel(
    state: RadioUiState,
    onEvent: (RadioUiEvent) -> Unit,
    styles: LcdTextStyles,
    modifier: Modifier = Modifier,
) {
    val p = RadioLcdTheme.palette
    val ten33Alpha = rememberTen33PulseAlpha(state.channelTen33)
    val channelText = state.channelDisplayLabel.ifBlank { state.channelLabel }.uppercase(Locale.US)
    // Strip the "RX:" prefix so the centre status line reads naturally; the chrome and the talker
    // line share rxAttributedLine but the cockpit doesn't paint a wash, just text.
    val talker = state.rxAttributedLine.trimStart().removePrefix("RX:").trim()
    val statusLine = when {
        state.isEmergencyActive -> "EMERGENCY ACTIVE"
        state.isPttPressed && state.pttBusyTone -> "CHANNEL BUSY"
        // Keyed but not on the air yet (air check / permit tone / link not
        // ready) — say so instead of green-lighting a dead transmission.
        state.isPttPressed && !state.pttOnAir -> "WAITING FOR AIR"
        state.isPttPressed -> "TRANSMITTING"
        state.remoteEmergencyUnit != null -> "EMERGENCY · ${state.remoteEmergencyUnit}"
        talker.isNotEmpty() -> talker
        else -> ""
    }
    val statusColor = when {
        state.isEmergencyActive || state.remoteEmergencyUnit != null -> p.statusEmergency
        state.isPttPressed && state.pttBusyTone -> p.statusRed
        state.isPttPressed && !state.pttOnAir -> p.statusAmber
        state.isPttPressed -> p.statusGreen
        else -> p.rxHighlight
    }
    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(14.dp, Alignment.CenterVertically),
    ) {
        if (state.zoneCount > 1) {
            // Zone chip: tap to enter zone-select (CH +/- then steps zones), tap again to commit.
            Text(
                text = state.zoneLabel.uppercase(Locale.US),
                style = styles.status.copy(fontWeight = FontWeight.Bold, fontSize = 16.sp),
                color = if (state.zoneSelectActive) p.statusAmber else p.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { onEvent(RadioUiEvent.ToggleZoneSelect) },
            )
        }
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .then(
                    if (state.channelTen33) {
                        Modifier
                            .background(p.statusAmber.copy(alpha = ten33Alpha))
                            .border(2.dp, p.statusAmber, RoundedCornerShape(4.dp))
                    } else {
                        Modifier
                    },
                )
                .padding(vertical = 8.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = channelText,
                style = styles.channel.copy(fontSize = 52.sp, lineHeight = 56.sp),
                color = p.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
            )
        }
        AiDispatchBadge(visible = state.aiDispatchEnabled, styles = styles)
        if (state.channelCodecLabel.isNotBlank()) {
            Text(
                text = state.channelCodecLabel.uppercase(Locale.US),
                style = styles.status.copy(fontWeight = FontWeight.SemiBold, fontSize = 13.sp),
                color = p.textMuted,
                maxLines = 1,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (statusLine.isNotEmpty()) {
            Text(
                text = statusLine,
                style = styles.body.copy(fontWeight = FontWeight.SemiBold, fontSize = 18.sp),
                color = statusColor,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        UniversalCockpitPttCircle(state = state, onEvent = onEvent, styles = styles)
    }
}

@Composable
private fun UniversalCockpitPttCircle(
    state: RadioUiState,
    onEvent: (RadioUiEvent) -> Unit,
    styles: LcdTextStyles,
) {
    val p = RadioLcdTheme.palette
    val fill = when {
        state.isPttPressed && state.pttBusyTone -> p.statusRed
        state.isPttPressed && !state.pttOnAir -> p.statusAmber
        state.isPttPressed -> p.statusGreen
        else -> p.pttIdleFill
    }
    val foreground = when {
        state.isPttPressed && state.pttBusyTone -> p.textOnButton
        state.isPttPressed -> Color.Black.copy(alpha = 0.9f)
        else -> p.textOnButton
    }
    val label = when {
        state.isPttPressed && state.pttBusyTone -> "BUSY"
        state.isPttPressed && !state.pttOnAir -> "WAIT"
        state.isPttPressed -> "TX"
        else -> "PTT"
    }
    Box(
        modifier = Modifier
            .size(200.dp)
            .clip(CircleShape)
            .background(fill)
            .border(3.dp, p.divider, CircleShape)
            .pointerInput(Unit) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    onEvent(RadioUiEvent.PttPressed)
                    waitForUpOrCancellation()
                    onEvent(RadioUiEvent.PttReleased)
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            LcdMicIcon(color = foreground, modifier = Modifier.size(48.dp))
            Text(
                text = label,
                style = styles.softKey.copy(fontSize = 26.sp, fontWeight = FontWeight.Bold),
                color = foreground,
            )
            if (!state.isPttPressed) {
                Text(
                    text = "HOLD TO TALK",
                    style = styles.status,
                    color = foreground.copy(alpha = 0.85f),
                )
            }
        }
    }
}

@Composable
private fun UniversalCockpitControlsRow(
    state: RadioUiState,
    onEvent: (RadioUiEvent) -> Unit,
    styles: LcdTextStyles,
) {
    val p = RadioLcdTheme.palette
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(72.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        UniversalCockpitButton(
            label = "CH-",
            onClick = { onEvent(RadioUiEvent.ChannelDown) },
            modifier = Modifier.weight(1f),
            styles = styles,
        )
        UniversalCockpitButton(
            label = "CH+",
            onClick = { onEvent(RadioUiEvent.ChannelUp) },
            modifier = Modifier.weight(1f),
            styles = styles,
        )
        UniversalCockpitButton(
            label = "REPLAY",
            onClick = { onEvent(RadioUiEvent.PlayLastTransmission) },
            onLongClick = { onEvent(RadioUiEvent.ToggleMessageHistory) },
            modifier = Modifier.weight(1f),
            styles = styles,
            accent = if (state.replayBanner.isNotEmpty()) p.statusAmber else null,
        )
        UniversalCockpitButton(
            label = if (state.scanActive) "SCAN •" else "SCAN",
            // Tap = plain on/off toggle (no picker overlay). Long-press opens the picker only
            // when scan is already on, mirroring the documented cockpit interaction; long-press
            // when off enables scan AND opens the picker so the user can pick channels.
            onClick = {
                if (state.scanActive) onEvent(RadioUiEvent.DisableScan)
                else onEvent(RadioUiEvent.ToggleScanSoftKey)
            },
            onLongClick = {
                if (state.scanActive) onEvent(RadioUiEvent.OpenScanPicker)
                else onEvent(RadioUiEvent.ToggleScanLongPress)
            },
            modifier = Modifier.weight(1f),
            styles = styles,
            accent = if (state.scanActive) p.statusAmber else null,
        )
        UniversalCockpitButton(
            label = if (state.isEmergencyActive) "ALARM" else "EMER",
            // Long-press only with a 1.5s hold — single-tap intentionally inert and the longer
            // threshold makes a glancing thumb on a touchscreen unable to accidentally key
            // emergency. Matches the Android handset's hardware-button safety pattern.
            onLongClick = { onEvent(RadioUiEvent.EmergencyToggle) },
            longPressTimeoutMs = EMERGENCY_LONG_PRESS_MS,
            modifier = Modifier.weight(1f),
            styles = styles,
            accent = if (state.isEmergencyActive) p.statusEmergency else p.statusRed.copy(alpha = 0.72f),
            longPressHint = if (!state.isEmergencyActive) "HOLD 1.5s" else null,
        )
    }
}

@Composable
private fun UniversalCockpitButton(
    label: String,
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    onLongClick: (() -> Unit)? = null,
    styles: LcdTextStyles,
    accent: Color? = null,
    longPressHint: String? = null,
    /**
     * Override Compose's default ~500ms long-press timeout. The EMER button passes a longer
     * hold so a glancing thumb cannot accidentally fire emergency on a touchscreen.
     */
    longPressTimeoutMs: Long? = null,
) {
    val p = RadioLcdTheme.palette
    val fill = accent ?: p.softKeyInactiveFill
    val textColor = if (accent != null) p.textOnButton else p.textPrimary
    val gestureModifier = when {
        onLongClick != null && longPressTimeoutMs != null ->
            // Custom hold-detection because detectTapGestures only honours the platform
            // long-press threshold (~500ms). Tricky bit: waitForUpOrCancellation() returns null
            // both on a real release AND on a system-driven gesture cancellation (finger drifts
            // off, another modifier consumes the pointer, etc.). withTimeoutOrNull adds a third
            // null path on actual timeout. We use elapsed wall-clock time to distinguish:
            //   - released != null  → genuine release, fire onClick
            //   - released == null, elapsed ≥ timeout → real long press, fire onLongClick
            //   - released == null, elapsed < timeout → canceled, fire nothing
            Modifier.pointerInput(onClick, onLongClick, longPressTimeoutMs) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    val downAt = System.currentTimeMillis()
                    val released = withTimeoutOrNull(longPressTimeoutMs) {
                        waitForUpOrCancellation()
                    }
                    val elapsed = System.currentTimeMillis() - downAt
                    when {
                        released != null -> onClick?.invoke()
                        elapsed >= longPressTimeoutMs -> {
                            onLongClick()
                            // Drain the eventual release so the gesture stream isn't left stuck.
                            waitForUpOrCancellation()
                        }
                        // else: gesture canceled before the threshold — intentionally do nothing.
                    }
                }
            }
        onClick != null && onLongClick != null ->
            Modifier.pointerInput(onClick, onLongClick) {
                detectTapGestures(
                    onTap = { onClick() },
                    onLongPress = { onLongClick() },
                )
            }
        onClick != null ->
            Modifier.pointerInput(onClick) {
                detectTapGestures(onTap = { onClick() })
            }
        onLongClick != null ->
            Modifier.pointerInput(onLongClick) {
                detectTapGestures(onLongPress = { onLongClick() })
            }
        else -> Modifier
    }
    Box(
        modifier = modifier
            .fillMaxHeight()
            .clip(RoundedCornerShape(6.dp))
            .background(fill)
            .border(1.dp, p.divider, RoundedCornerShape(6.dp))
            .then(gestureModifier),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                text = label,
                style = styles.softKey.copy(fontWeight = FontWeight.Bold, fontSize = 16.sp),
                color = textColor,
                maxLines = 1,
            )
            if (longPressHint != null) {
                Text(
                    text = longPressHint,
                    style = styles.status.copy(fontSize = 10.sp),
                    color = textColor.copy(alpha = 0.85f),
                )
            }
        }
    }
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
                            linkHealthy = state.scanLinkHealthy,
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

/** Orange when scan is on; pulses while a scan channel is receiving; red
 *  when scan is on but the side-channel sockets are silently broken (e.g.
 *  a network blip left zombie WebSockets the server has already given up on
 *  — see [ScanVoiceListenTransport.linkHealthy]). */
@Composable
private fun rememberScanIconActiveColor(
    scanActive: Boolean,
    scanReceiving: Boolean,
    linkHealthy: Boolean = true,
): Color {
    val p = RadioLcdTheme.palette
    if (!scanActive) return p.statusAmber
    if (!linkHealthy) return p.statusRed
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
                    modifier = if (state.zoneCount > 1) {
                        Modifier.clickable { onEvent(RadioUiEvent.ToggleZoneSelect) }
                    } else {
                        Modifier
                    },
                ) {
                    LcdListChannelIcon(color = p.textMuted, modifier = Modifier.size(14.dp))
                    Text(
                        text = state.zoneLabel.uppercase(Locale.US),
                        style = styles.zone,
                        color = if (state.zoneSelectActive) p.statusAmber else p.textSecondary,
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
                    color = if (state.zoneSelectActive) p.statusAmber else p.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .fillMaxWidth()
                        .then(
                            if (state.zoneCount > 1) {
                                Modifier.clickable { onEvent(RadioUiEvent.ToggleZoneSelect) }
                            } else {
                                Modifier
                            },
                        ),
                    textAlign = TextAlign.Center,
                )
            }
            Text(
                // At launch the version flashes here for a few seconds (IRC590 / TM-7 Plus).
                text = (state.versionBanner ?: state.channelDisplayLabel.ifBlank { state.channelLabel })
                    .uppercase(Locale.US),
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
            (state.rxAttributedLine.isNotBlank() && !state.channelTen33) ||
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
            if (state.mp22DualDisplay && !state.mp22UsePhysicalDisplay) {
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "PC SETUP (virtual screen) — open Settings → MOVE TO PHYSICAL RADIO SCREEN when done",
                    style = styles.status.copy(fontWeight = FontWeight.Bold, fontSize = 14.sp),
                    color = p.statusAmber,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (state.mp22DualDisplay && state.mp22TouchNotReachable) {
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "SafeT is on the physical display but touch input is not reaching the app. " +
                        "Use hardware keys, or open on the PC setup (virtual) screen.",
                    style = styles.status.copy(fontWeight = FontWeight.Bold, fontSize = 13.sp),
                    color = p.statusAmber,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            val isIrc590Handset = state.resolvedDeviceProfile == ResolvedDeviceProfile.IRC590
            if (!showEmergencyBanner && !isIrc590Handset) {
                LcdPermissionBadge(
                    permission = state.currentChannelPermission,
                    deviceProfile = state.resolvedDeviceProfile,
                    styles = styles,
                )
            }
            if (!showEmergencyBanner && !isIrc590Handset) {
                LcdHandsetZonePositionLine(
                    zoneValue = zoneValue,
                    channelValue = channelValue,
                    deviceProfile = state.resolvedDeviceProfile,
                    styles = styles,
                    codecLabel = state.channelCodecLabel,
                    zoneSelectActive = state.zoneSelectActive,
                    onZoneTap = if (state.zoneCount > 1) {
                        { onEvent(RadioUiEvent.ToggleZoneSelect) }
                    } else {
                        null
                    },
                )
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
                        channelName = state.channelDisplayLabel.ifBlank { state.channelLabel },
                        unitId = talkUnit,
                        channelColor = chrome.channelTextColor,
                        emergencyColor = p.statusEmergency,
                        deviceProfile = state.resolvedDeviceProfile,
                        styles = styles,
                        modifier = Modifier.fillMaxSize(),
                    )
                } else {
                    val channelText =
                        state.channelDisplayLabel.ifBlank { state.channelLabel }.uppercase(Locale.US)
                    val density = LocalDensity.current
                    val blockMaxHeight = maxHeight
                    val blockMaxWidth = maxWidth
                    val irc590IdleLayout =
                        isIrc590Handset && homeChannelLarge && !remoteEmergencyLive
                    Column(
                        modifier = Modifier.fillMaxSize(),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center,
                    ) {
                        if (irc590IdleLayout) {
                            LcdHandsetIrc590ChannelMetaHeader(
                                state = state,
                                zoneValue = zoneValue,
                                channelValue = channelValue,
                                styles = styles,
                                onZoneTap = if (state.zoneCount > 1) {
                                    { onEvent(RadioUiEvent.ToggleZoneSelect) }
                                } else {
                                    null
                                },
                            )
                        }
                        val ten33Alpha = rememberTen33PulseAlpha(state.channelTen33)
                        Box(
                            modifier = (
                                if (homeChannelLarge && !irc590IdleLayout) {
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
                            // While 10-33 is on, the channel name sits inside a pulsing amber
                            // band that hits alpha ~0.78 at peak. The default light textPrimary
                            // washes out against that — force a dark color so the name stays
                            // readable through the brightest part of the pulse.
                            val channelTextColor =
                                if (state.channelTen33) {
                                    Color.Black.copy(alpha = 0.92f)
                                } else {
                                    chrome.channelTextColor
                                }
                            Text(
                                text = channelText,
                                style = styles.channel.copy(
                                    fontSize = channelFont,
                                    lineHeight = (channelFont.value * 1.05f).sp,
                                ),
                                color = channelTextColor,
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
                        state.isPttPressed && !state.pttOnAir -> "WAITING FOR AIR"
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

private fun handsetZonePositionLabel(
    zoneValue: String,
    channelValue: String,
    codecLabel: String = "",
): String {
    val zone = zoneValue.trim()
    val channel = channelValue.trim()
    val base = when {
        zone.isNotEmpty() && channel.isNotEmpty() -> "ZONE $zone · $channel"
        zone.isNotEmpty() -> "ZONE $zone"
        channel.isNotEmpty() -> channel
        else -> ""
    }
    // Codec badge rides the zone/position meta line so operators can see at a
    // glance which vocoder the tuned channel runs.
    val codec = codecLabel.trim()
    val joined = when {
        base.isNotEmpty() && codec.isNotEmpty() -> "$base · $codec"
        codec.isNotEmpty() -> codec
        else -> base
    }
    return joined.uppercase(Locale.US)
}

/** Zone + channel index between the permission badge and the large channel name. */
@Composable
private fun LcdHandsetZonePositionLine(
    zoneValue: String,
    channelValue: String,
    deviceProfile: ResolvedDeviceProfile,
    styles: LcdTextStyles,
    codecLabel: String = "",
    zoneSelectActive: Boolean = false,
    onZoneTap: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val label = handsetZonePositionLabel(zoneValue, channelValue, codecLabel)
    if (label.isEmpty()) return
    val p = RadioLcdTheme.palette
    val fontSp =
        when (deviceProfile) {
            ResolvedDeviceProfile.IRC590 -> HANDSET_ZONE_LINE_SP_IRC590
            else -> HANDSET_ZONE_LINE_SP_DEFAULT
        }
    Text(
        text = label,
        style = styles.status.copy(
            fontWeight = FontWeight.Bold,
            fontSize = fontSp,
            lineHeight = (fontSp.value * 1.12f).sp,
        ),
        color = if (zoneSelectActive) p.statusAmber else p.textSecondary,
        textAlign = TextAlign.Center,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = modifier
            .fillMaxWidth()
            .then(if (onZoneTap != null) Modifier.clickable(onClick = onZoneTap) else Modifier)
            .padding(
                top = 0.dp,
                bottom = if (deviceProfile == ResolvedDeviceProfile.IRC590) 0.dp else 2.dp,
            ),
    )
}

/** IRC590: clock centered above permission + zone, flush on the large channel name. */
@Composable
private fun LcdHandsetIrc590ChannelMetaHeader(
    state: RadioUiState,
    zoneValue: String,
    channelValue: String,
    styles: LcdTextStyles,
    onZoneTap: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val p = RadioLcdTheme.palette
    val accentOnEmergency = if (state.isEmergencyActive) Color.White else p.textPrimary
    Column(
        modifier = modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(0.dp),
    ) {
        Text(
            text = state.systemTime.uppercase(Locale.US),
            style = styles.status.copy(
                fontWeight = FontWeight.Bold,
                fontSize = HANDSET_CLOCK_FONT_IRC590,
                lineHeight = (HANDSET_CLOCK_FONT_IRC590.value * 1.05f).sp,
            ),
            color = accentOnEmergency,
            maxLines = 1,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
        LcdPermissionBadge(
            permission = state.currentChannelPermission,
            deviceProfile = ResolvedDeviceProfile.IRC590,
            styles = styles,
            compactVertical = true,
        )
        LcdHandsetZonePositionLine(
            zoneValue = zoneValue,
            channelValue = channelValue,
            deviceProfile = ResolvedDeviceProfile.IRC590,
            styles = styles,
            codecLabel = state.channelCodecLabel,
            zoneSelectActive = state.zoneSelectActive,
            onZoneTap = onZoneTap,
        )
    }
}

/** Per-channel permission tag — only shown when the channel isn't plain TALK. */
@Composable
private fun LcdPermissionBadge(
    permission: ChannelPermission,
    styles: LcdTextStyles,
    deviceProfile: ResolvedDeviceProfile = ResolvedDeviceProfile.TM7_PLUS,
    compactVertical: Boolean = false,
    modifier: Modifier = Modifier,
) {
    if (permission == ChannelPermission.TALK) return
    val p = RadioLcdTheme.palette
    val irc590 = deviceProfile == ResolvedDeviceProfile.IRC590
    val (label, color, fontSp) = when (permission) {
        ChannelPermission.LISTEN_ONLY -> Triple(
            "LISTEN ONLY",
            p.statusRed,
            if (irc590) HANDSET_PERMISSION_LISTEN_SP_IRC590 else 28.sp,
        )
        ChannelPermission.TALK_PRIORITY -> Triple(
            "PRIORITY",
            p.statusAmber,
            if (irc590) HANDSET_PERMISSION_PRIORITY_SP_IRC590 else 20.sp,
        )
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
            .padding(vertical = if (compactVertical) 0.dp else 2.dp),
    )
}

/** Radios-online stat for the toolbar (zone + channel index are above the channel name). */
@Composable
private fun LcdHandsetMetaRow(
    radiosValue: String,
    radiosKnown: Boolean,
    styles: LcdTextStyles,
    modifier: Modifier = Modifier,
) {
    val p = RadioLcdTheme.palette
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
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

/** Status toolbar — TM7: icons, globe, clock in one bar; IRC590: icon row only (clock/zone above channel). */
@Composable
private fun LcdHandsetToolbar(
    state: RadioUiState,
    showBatteryStatus: Boolean,
    multiRowLayout: Boolean,
    emergencyFlashAlpha: Float,
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
        linkHealthy = state.scanLinkHealthy,
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

/** IRC590 top row: status icons + radios online, evenly spaced; battery larger than the rest. */
@Composable
private fun LcdHandsetToolbarIrc590TopRow(
    state: RadioUiState,
    online: Boolean,
    scanReceiving: Boolean,
    radiosValue: String,
    radiosKnown: Boolean,
    showBatteryStatus: Boolean,
    onEvent: (RadioUiEvent) -> Unit,
    styles: LcdTextStyles,
    modifier: Modifier = Modifier,
) {
    val p = RadioLcdTheme.palette
    val scanIconColor = rememberScanIconActiveColor(
        scanActive = state.scanActive,
        scanReceiving = scanReceiving,
        linkHealthy = state.scanLinkHealthy,
    )
    val accentOnEmergency = if (state.isEmergencyActive) Color.White else p.textSecondary
    BoxWithConstraints(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp),
    ) {
        val slotCount = if (showBatteryStatus) 7f else 6f
        val iconSize = minOf(maxWidth / slotCount, maxHeight * 0.88f).coerceIn(36.dp, 54.dp)
        val signalWidth = iconSize * 1.22f
        val signalHeight = iconSize * 0.78f
        val radiosFontSp = (iconSize.value * 0.52f).coerceIn(17f, 24f).sp
        val batteryIconW = iconSize * 1.45f
        val batteryIconH = batteryIconW * 0.5f
        val batteryTextSp = (iconSize.value * 0.72f).coerceIn(24f, 34f).sp
        val radiosLabel = radiosValue.ifBlank { "—" }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceEvenly,
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
            LcdHandsetStat(
                value = radiosLabel,
                valueColor = if (radiosKnown) p.statusGreen else p.textMuted,
                styles = styles,
                compact = true,
                valueFontSize = radiosFontSp,
            ) {
                LcdGlobeIcon(
                    color = if (radiosKnown) p.statusGreen else p.textMuted,
                    modifier = Modifier.size(iconSize),
                )
            }
            if (showBatteryStatus) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    LcdBatteryIcon(
                        percent = state.batteryPercent,
                        outline = if (state.isEmergencyActive) Color.White else accentOnEmergency,
                        fillHigh = p.statusGreen,
                        fillLow = p.statusAmber,
                        fillCritical = p.statusRed,
                        modifier = Modifier.size(width = batteryIconW, height = batteryIconH),
                    )
                    Text(
                        text = "${state.batteryPercent}%",
                        style = styles.status.copy(
                            fontWeight = FontWeight.Bold,
                            fontSize = batteryTextSp,
                            lineHeight = (batteryTextSp.value * 1.1f).sp,
                        ),
                        color = if (state.isEmergencyActive) Color.White else accentOnEmergency,
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

@Composable
private fun LcdHandsetToolbarIrc590(
    state: RadioUiState,
    showBatteryStatus: Boolean,
    emergencyFlashAlpha: Float,
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

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(rowPad),
    ) {
        LcdHandsetToolbarIrc590TopRow(
            state = state,
            online = online,
            scanReceiving = scanReceiving,
            radiosValue = radiosValue,
            radiosKnown = radiosKnown,
            showBatteryStatus = showBatteryStatus,
            onEvent = onEvent,
            styles = styles,
        )
        LcdHandsetToolbarScanBanner(state = state, styles = styles)
    }
}

/** TM7 status bar: icons + radios globe + large centered clock (no channel index row). */
@Composable
private fun LcdHandsetToolbarTm7TopRow(
    state: RadioUiState,
    online: Boolean,
    scanReceiving: Boolean,
    radiosValue: String,
    radiosKnown: Boolean,
    onEvent: (RadioUiEvent) -> Unit,
    styles: LcdTextStyles,
    modifier: Modifier = Modifier,
) {
    val p = RadioLcdTheme.palette
    val accentOnEmergency = if (state.isEmergencyActive) Color.White else p.textPrimary
    val iconSize = 26.dp
    val signalWidth = 34.dp
    val signalHeight = 22.dp
    val radiosFontSp = 18.sp
    val radiosLabel = radiosValue.ifBlank { "—" }

    BoxWithConstraints(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp),
    ) {
        Row(
            modifier = Modifier
                .align(Alignment.CenterStart)
                .fillMaxWidth(0.62f),
            horizontalArrangement = Arrangement.spacedBy(5.dp),
            verticalAlignment = Alignment.CenterVertically,
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
            LcdHandsetStat(
                value = radiosLabel,
                valueColor = if (radiosKnown) p.statusGreen else p.textMuted,
                styles = styles,
                compact = true,
                valueFontSize = radiosFontSp,
            ) {
                LcdGlobeIcon(
                    color = if (radiosKnown) p.statusGreen else p.textMuted,
                    modifier = Modifier.size(iconSize),
                )
            }
        }
        Text(
            text = state.systemTime.uppercase(Locale.US),
            style = styles.status.copy(
                fontWeight = FontWeight.Bold,
                fontSize = HANDSET_CLOCK_FONT_TM7,
                lineHeight = (HANDSET_CLOCK_FONT_TM7.value * 1.08f).sp,
            ),
            color = accentOnEmergency,
            maxLines = 1,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .align(Alignment.Center)
                .fillMaxWidth(),
        )
    }
}

@Composable
private fun LcdHandsetToolbarTm7(
    state: RadioUiState,
    @Suppress("UNUSED_PARAMETER") emergencyFlashAlpha: Float,
    @Suppress("UNUSED_PARAMETER") channelValue: String,
    radiosValue: String,
    radiosKnown: Boolean,
    onEvent: (RadioUiEvent) -> Unit,
    styles: LcdTextStyles,
    modifier: Modifier = Modifier,
) {
    val online = state.networkLabel == "ONLINE"
    val scanReceiving = state.scanBackgroundActive
    val rowPad = 3.dp

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(rowPad),
    ) {
        LcdHandsetToolbarTm7TopRow(
            state = state,
            online = online,
            scanReceiving = scanReceiving,
            radiosValue = radiosValue,
            radiosKnown = radiosKnown,
            onEvent = onEvent,
            styles = styles,
        )
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
                // Handset-only strip: match the handsets' display scale, not the 10.5 sp chrome.
                style = styles.status.copy(fontWeight = FontWeight.Bold, fontSize = 20.sp, lineHeight = 24.sp),
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
        // Handset-only row: these are tap targets on small rugged screens — the 11.5 sp
        // soft-key style was both unreadable and nearly untappable there.
        if (!state.micPermissionGranted) {
            Text(
                text = "ALLOW MIC",
                style = styles.softKey.copy(fontSize = 20.sp, lineHeight = 24.sp),
                color = p.statusBlue,
                modifier = Modifier
                    .clickable { onRequestMicPermission() }
                    .padding(vertical = 4.dp),
            )
        }
        if (state.channelSyncError != null) {
            Text(
                text = "RETRY SYNC",
                style = styles.softKey.copy(fontSize = 20.sp, lineHeight = 24.sp),
                color = p.statusAmber,
                modifier = Modifier
                    .clickable { onEvent(RadioUiEvent.RetryChannelSync) }
                    .padding(vertical = 4.dp),
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
        state.isPttPressed && !state.pttOnAir -> ChannelDisplayChrome(
            borderColor = p.statusAmber,
            borderWidth = 3.dp,
            washColor = p.statusAmber.copy(alpha = 0.12f),
            channelTextColor = p.statusAmber,
            talkLineColor = p.statusAmber,
        )
        state.isPttPressed -> ChannelDisplayChrome(
            borderColor = p.statusGreen,
            borderWidth = 3.dp,
            washColor = p.statusGreen.copy(alpha = 0.18f),
            channelTextColor = p.statusGreen,
            talkLineColor = p.statusGreen,
        )
        state.rxAttributedLine.isNotBlank() && !state.rxFromScan && !state.channelTen33 ->
            ChannelDisplayChrome(
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
        // Scan-only RX is shown via the yellow SCAN RX banner; suppress the home-channel talk
        // line so the channel area doesn't read "RX: …" for traffic on a side channel.
        state.rxFromScan -> ""
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
    // IRC590 / TM-7 Plus: the 14 sp chrome banner is unreadable next to their 24–82 sp
    // display text, so handset layouts render the strip at handset scale.
    large: Boolean = false,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(2.dp))
            .background(accent.copy(alpha = 0.14f))
            .border(1.dp, accent, RoundedCornerShape(2.dp))
            .padding(horizontal = 10.dp, vertical = if (large) 8.dp else 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        Text(
            text = text,
            style = if (large) styles.banner.copy(fontSize = 22.sp, lineHeight = 26.sp) else styles.banner,
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
        state.isPttPressed && !state.pttOnAir -> Triple(
            "WAITING FOR AIR",
            state.statusMessage.uppercase(Locale.US),
            p.statusAmber,
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
        state.isPttPressed && !state.pttOnAir -> p.statusAmber
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
        LcdLegendKey(
            onClick = { onEvent(RadioUiEvent.ChannelUp) },
            // Mirrors the physical channel-up key: hold toggles zone-select mode.
            onLongClick = { onEvent(RadioUiEvent.ToggleZoneSelect) },
        ) {
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
    val baseModifier = Modifier
        .weight(1f)
        .fillMaxHeight()
    val cellShape = RoundedCornerShape(0.dp)
    // The clickable Surface(onClick = ...) and a manual detectTapGestures cannot share the same
    // node: Surface's internal pointerInput consumes the tap before the manual one sees it. That
    // is why TM7+'s on-screen REPLAY and DAY/NIGHT keys were inert — they had an onLongClick set,
    // which routed through a no-op Surface.onClick and a detached gesture handler. Drop down to a
    // non-clickable Surface and own both gestures when long-press is in play.
    if (onLongClick != null) {
        Surface(
            modifier = baseModifier.pointerInput(onClick, onLongClick) {
                detectTapGestures(
                    onTap = { onClick() },
                    onLongPress = { onLongClick() },
                )
            },
            shape = cellShape,
            color = p.softKeyInactiveFill,
        ) {
            Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) {
                content()
            }
        }
    } else {
        Surface(
            onClick = onClick,
            modifier = baseModifier,
            shape = cellShape,
            color = p.softKeyInactiveFill,
            interactionSource = interaction,
        ) {
            Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) {
                content()
            }
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
                        label = state.channelCatalogDisplay.getOrNull(index) ?: label,
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
                        style = styles.status.copy(fontWeight = FontWeight.Bold, fontSize = 16.sp, lineHeight = 19.sp),
                        color = p.textSecondary,
                    )
                    Text(
                        text = item.channelName.uppercase(Locale.US),
                        style = styles.status.copy(fontWeight = FontWeight.Bold, fontSize = 16.sp, lineHeight = 19.sp),
                        color = p.statusBlue,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                // The caption is already formatted by LastRxAudioRecorder as either
                // "RX: UNIT • NAME" / "RX: UNIT" / "RX: NAME" — strip the "RX:" prefix
                // so the row reads like a who-said-it tag rather than a status line.
                val talker = item.caption.trimStart().removePrefix("RX:").trim()
                if (talker.isNotEmpty()) {
                    Text(
                        text = talker,
                        style = styles.status.copy(fontWeight = FontWeight.SemiBold, fontSize = 18.sp, lineHeight = 22.sp),
                        color = p.textPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                // RxMessageHistory currently sets transcript = caption as a placeholder until a
                // real Whisper transcript is wired in. Skip the big body if it would just echo
                // the speaker line we already rendered above.
                val transcriptText = item.transcript.trim()
                val isCaptionEcho = transcriptText.isNotEmpty() &&
                    transcriptText == item.caption.trim()
                if (transcriptText.isNotEmpty() && !isCaptionEcho) {
                    Text(
                        text = transcriptText,
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
                        label = state.channelCatalogDisplay.getOrNull(index) ?: label,
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
    val tabs = listOf("BUTTONS", "DEVICE", "AUDIO", "ACCOUNT")
    val selectedTab = state.settingsTabIndex.coerceIn(0, tabs.lastIndex)

    Dialog(
        onDismissRequest = { onEvent(RadioUiEvent.CloseMappingSettings) },
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(
            modifier = Modifier.fillMaxSize(),
            color = p.lcdAlt,
        ) {
            Column(modifier = Modifier.fillMaxSize().statusBarsPadding()) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        text = "SETTINGS",
                        style = styles.body.copy(fontWeight = FontWeight.Bold, fontSize = 20.sp),
                        color = p.textPrimary,
                    )
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        state.lastDetectedKey?.let {
                            Text(
                                text = "LAST KEY: $it",
                                style = styles.status,
                                color = p.statusBlue,
                                modifier = Modifier.padding(end = 12.dp),
                            )
                        }
                        TextButton(onClick = { onEvent(RadioUiEvent.CloseMappingSettings) }) {
                            Text("DONE", color = p.statusBlue)
                        }
                    }
                }
                HorizontalDivider(color = p.divider)
                TabRow(selectedTabIndex = selectedTab) {
                    tabs.forEachIndexed { idx, label ->
                        Tab(
                            selected = selectedTab == idx,
                            onClick = { onEvent(RadioUiEvent.SelectSettingsTab(idx)) },
                            text = {
                                Text(
                                    text = label,
                                    style = styles.body.copy(fontWeight = FontWeight.Bold),
                                )
                            },
                        )
                    }
                }
                Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                    when (selectedTab) {
                        0 -> ButtonMappingTab(state, onEvent, styles, p)
                        1 -> DeviceSettingsTab(state, onEvent, styles, p)
                        2 -> AudioSettingsTab(state, onEvent, styles, p)
                        else -> AccountSettingsTab(state, onEvent, styles, p)
                    }
                }
            }
        }
    }
}

@Composable
private fun ButtonMappingTab(
    state: RadioUiState,
    onEvent: (RadioUiEvent) -> Unit,
    styles: LcdTextStyles,
    p: RadioLcdPalette,
) {
    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item {
            Text(
                text = "Map this handset's physical buttons to radio actions. Press ADD then the key.",
                style = styles.status,
                color = p.textMuted,
            )
        }
        itemsIndexed(HardwareAction.entries) { _, action ->
            val codes = state.hardwareMappings[action] ?: emptySet()
            val isListening = state.currentlyMappingAction == action
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .border(1.dp, p.divider, RoundedCornerShape(4.dp))
                    .background(if (isListening) p.statusBlue.copy(alpha = 0.1f) else Color.Transparent)
                    .padding(8.dp),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = action.label.uppercase(Locale.US),
                        style = styles.body.copy(fontWeight = FontWeight.Bold),
                        color = p.textPrimary,
                    )
                    if (isListening) {
                        Text(
                            text = "PRESS BUTTON...",
                            style = styles.status,
                            color = p.statusAmber,
                        )
                    }
                }
                Text(
                    text = if (codes.isEmpty()) "NO KEYS MAPPED" else "KEYS: ${codes.joinToString(", ")}",
                    style = styles.status,
                    color = p.textMuted,
                    modifier = Modifier.padding(vertical = 4.dp),
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    TextButton(
                        onClick = {
                            if (isListening) onEvent(RadioUiEvent.StopListeningForMapping)
                            else onEvent(RadioUiEvent.StartListeningForMapping(action))
                        },
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.textButtonColors(
                            containerColor = if (isListening) p.statusAmber else p.softKeyInactiveFill,
                            contentColor = p.textOnButton,
                        ),
                    ) {
                        Text(if (isListening) "STOP" else "ADD")
                    }
                    TextButton(
                        onClick = { onEvent(RadioUiEvent.ResetMappingToDefault(action)) },
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.textButtonColors(
                            containerColor = p.softKeyInactiveFill,
                            contentColor = p.textOnButton,
                        ),
                    ) {
                        Text("DEFAULT")
                    }
                    TextButton(
                        onClick = { onEvent(RadioUiEvent.ClearMapping(action)) },
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.textButtonColors(
                            containerColor = p.softKeyInactiveFill,
                            contentColor = p.textOnButton,
                        ),
                    ) {
                        Text("CLEAR")
                    }
                }
            }
        }
    }
}

@Composable
private fun DeviceSettingsTab(
    state: RadioUiState,
    onEvent: (RadioUiEvent) -> Unit,
    styles: LcdTextStyles,
    p: RadioLcdPalette,
) {
    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            SettingsSectionHeader("DISPATCH MAP (GPS)", styles, p)
            Text(
                text = when {
                    state.needsLocationPermission ->
                        "Location is not allowed — the console map cannot show a current position for this radio."
                    state.needsGpsEnabled ->
                        "Location permission is on, but Android GPS/Location is turned off."
                    else ->
                        "GPS reporting is active. Your position updates on the dispatch map about every 15 seconds."
                },
                style = styles.status,
                color = p.textMuted,
                modifier = Modifier.padding(bottom = 4.dp),
            )
            if (state.needsLocationPermission) {
                TextButton(
                    onClick = { onEvent(RadioUiEvent.RequestLocationPermission) },
                    modifier = Modifier.fillMaxWidth(),
                    colors = ButtonDefaults.textButtonColors(
                        containerColor = p.softKeyInactiveFill,
                        contentColor = p.textOnButton,
                    ),
                ) {
                    Text("ALLOW LOCATION ACCESS".uppercase(Locale.US))
                }
            }
            if (state.needsGpsEnabled) {
                TextButton(
                    onClick = { onEvent(RadioUiEvent.OpenGpsSettings) },
                    modifier = Modifier.fillMaxWidth(),
                    colors = ButtonDefaults.textButtonColors(
                        containerColor = p.softKeyInactiveFill,
                        contentColor = p.textOnButton,
                    ),
                ) {
                    Text("TURN ON GPS IN ANDROID SETTINGS".uppercase(Locale.US))
                }
            }
        }
        item { HorizontalDivider(color = p.divider) }
        if (state.mp22DualDisplay) {
            item {
                SettingsSectionHeader("MP22 — PC SETUP vs RADIO SCREEN", styles, p)
                Text(
                    text = when {
                        state.mp22TouchNotReachable ->
                            "Touch is not reaching SafeT on this screen — input may still be on the virtual display. " +
                                "Use hardware keys here, or switch to PC setup screen for scrcpy."
                        state.mp22UsePhysicalDisplay && state.mp22CurrentDisplayId != 1 ->
                            "Moving to the physical radio screen… Use hardware keys (PTT, channel) on the device."
                        state.mp22UsePhysicalDisplay ->
                            "On the physical screen (Display 1). PC/scrcpy cannot click here on Android 8.1 — use radio buttons."
                        state.mp22CurrentDisplayId == 0 ->
                            "On the virtual screen (Display 0). Set up login and settings with scrcpy, then tap the button below."
                        else ->
                            "Dual-display MP22 detected. Use virtual screen for PC control, then move to physical for daily use."
                    },
                    style = styles.status,
                    color = p.textMuted,
                    modifier = Modifier.padding(bottom = 6.dp),
                )
                if (!state.mp22UsePhysicalDisplay) {
                    TextButton(
                        onClick = { onEvent(RadioUiEvent.MoveMp22ToPhysicalDisplay) },
                        modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.textButtonColors(
                            containerColor = p.statusGreen.copy(alpha = 0.2f),
                            contentColor = p.statusGreen,
                        ),
                    ) {
                        Text("MOVE TO PHYSICAL RADIO SCREEN".uppercase(Locale.US))
                    }
                } else {
                    TextButton(
                        onClick = { onEvent(RadioUiEvent.MoveMp22ToVirtualSetupDisplay) },
                        modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.textButtonColors(
                            containerColor = p.softKeyInactiveFill,
                            contentColor = p.textPrimary,
                        ),
                    ) {
                        Text("OPEN ON PC SETUP SCREEN (VIRTUAL)".uppercase(Locale.US))
                    }
                }
            }
            item { HorizontalDivider(color = p.divider) }
        }
        item {
            SettingsSectionHeader("SOFTWARE", styles, p)
            Text(
                text = "VERSION ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})".uppercase(Locale.US),
                style = styles.status,
                color = p.textMuted,
                modifier = Modifier.padding(bottom = 4.dp),
            )
            TextButton(
                onClick = { onEvent(RadioUiEvent.CheckForUpdates) },
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.textButtonColors(
                    containerColor = p.softKeyInactiveFill,
                    contentColor = p.textPrimary,
                ),
            ) {
                Text("CHECK FOR UPDATES".uppercase(Locale.US))
            }
        }
        item { HorizontalDivider(color = p.divider) }
        item {
            SettingsSectionHeader("HANDSET LAYOUT", styles, p)
            Text(
                text = "ACTIVE: ${state.resolvedDeviceProfile.label.uppercase(Locale.US)} · " +
                    "OVERRIDE: ${state.deviceProfilePreference.label.uppercase(Locale.US)}",
                style = styles.status,
                color = p.textMuted,
                modifier = Modifier.padding(bottom = 4.dp),
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
        }
        item { HorizontalDivider(color = p.divider) }
        item {
            SettingsSectionHeader("DISPLAY — DAY / NIGHT", styles, p)
            Text(
                text = "CURRENT: ${state.themeMode.label.uppercase(Locale.US)} · " +
                    "SUN ICON / KEY TOGGLES DAY OR NIGHT",
                style = styles.status,
                color = p.textMuted,
                modifier = Modifier.padding(bottom = 4.dp),
            )
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
        }
        item { HorizontalDivider(color = p.divider) }
        item {
            SettingsSectionHeader("DISPLAY OVER OTHER APPS", styles, p)
            Text(
                text = if (state.needsOverlayPermission) {
                    "Required on some rugged radios so the tactical screen can return on top after PTT."
                } else {
                    "Granted — the radio UI can draw over other apps when needed."
                },
                style = styles.status,
                color = p.textMuted,
                modifier = Modifier.padding(bottom = 4.dp),
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
        }
        item { HorizontalDivider(color = p.divider) }
        item {
            SettingsSectionHeader("BACKGROUND POWER", styles, p)
            Text(
                text = "Open the battery screen and exempt this app if the manufacturer lets you. " +
                    "OEMs still may stop background work.",
                style = styles.status,
                color = p.textMuted,
                modifier = Modifier.padding(bottom = 4.dp),
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
        }
    }
}

@Composable
private fun AudioSettingsTab(
    state: RadioUiState,
    onEvent: (RadioUiEvent) -> Unit,
    styles: LcdTextStyles,
    p: RadioLcdPalette,
) {
    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            SettingsSectionHeader("MICROPHONE", styles, p)
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Checkbox(
                    checked = state.micNoiseSuppressionEnabled,
                    onCheckedChange = { onEvent(RadioUiEvent.SetMicNoiseSuppression(it)) },
                )
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = "NOISE SUPPRESSION",
                        style = styles.body.copy(fontWeight = FontWeight.Bold),
                        color = p.textPrimary,
                    )
                    Text(
                        text = "Reduce background noise on outgoing voice using the Android NoiseSuppressor effect.",
                        style = styles.status,
                        color = p.textMuted,
                    )
                }
            }
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Checkbox(
                    checked = state.micAutoGainEnabled,
                    onCheckedChange = { onEvent(RadioUiEvent.SetMicAutoGain(it)) },
                )
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = "AUTO-SET RECORDING LEVEL",
                        style = styles.body.copy(fontWeight = FontWeight.Bold),
                        color = p.textPrimary,
                    )
                    Text(
                        text = "Let Android pick the best mic level automatically (overrides the slider).",
                        style = styles.status,
                        color = p.textMuted,
                    )
                }
            }
            Column(modifier = Modifier.padding(top = 12.dp)) {
                val sliderEnabled = !state.micAutoGainEnabled
                val sliderColor = if (sliderEnabled) p.textPrimary else p.textMuted
                Text(
                    text = "RECORDING VOLUME",
                    style = styles.body.copy(fontWeight = FontWeight.Bold),
                    color = sliderColor,
                )
                Text(
                    text = if (sliderEnabled) {
                        "Boost or reduce mic level (${"%.1f".format(state.micGainMultiplier)}×). " +
                            "1.0× is unchanged; 3.0× is hot."
                    } else {
                        "Disabled while AUTO-SET is on."
                    },
                    style = styles.status,
                    color = p.textMuted,
                )
                Slider(
                    value = state.micGainMultiplier,
                    onValueChange = { onEvent(RadioUiEvent.SetMicGainMultiplier(it)) },
                    valueRange = RadioPreferences.MIN_MIC_GAIN..RadioPreferences.MAX_MIC_GAIN,
                    steps = 24,
                    enabled = sliderEnabled,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        item { HorizontalDivider(color = p.divider) }
        item {
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
        }
        item { HorizontalDivider(color = p.divider) }
        item {
            SettingsSectionHeader("P25-STYLE DIGITAL VOICE (IMBE)", styles, p)
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
        item { HorizontalDivider(color = p.divider) }
        item {
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
        }
    }
}

@Composable
private fun AccountSettingsTab(
    state: RadioUiState,
    onEvent: (RadioUiEvent) -> Unit,
    styles: LcdTextStyles,
    p: RadioLcdPalette,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        SettingsSectionHeader("ACCOUNT", styles, p)
        val signedInUsername = state.sessionUsername.trim()
        val signedInAgency = state.sessionAgencyName.trim()
        if (signedInUsername.isNotEmpty()) {
            Text(
                text = "USERNAME: ${signedInUsername.uppercase(Locale.US)}",
                style = styles.status.copy(fontWeight = FontWeight.Bold),
                color = p.textPrimary,
            )
        }
        if (signedInAgency.isNotEmpty()) {
            Text(
                text = "AGENCY: ${signedInAgency.uppercase(Locale.US)}",
                style = styles.status.copy(fontWeight = FontWeight.Bold),
                color = p.textPrimary,
            )
        }
        Text(
            text = "Sign out clears the saved token on this device and returns to the login screen.",
            style = styles.status,
            color = p.textMuted,
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
    }
}

@Composable
private fun SettingsSectionHeader(label: String, styles: LcdTextStyles, p: RadioLcdPalette) {
    Text(
        text = label,
        style = styles.body.copy(fontWeight = FontWeight.Bold),
        color = p.textPrimary,
        modifier = Modifier.padding(bottom = 4.dp),
    )
}

@Composable
fun SetupRequiredDialog(
    state: RadioUiState,
    onEvent: (RadioUiEvent) -> Unit,
) {
    if (
        state.setupDialogDismissed ||
            (!state.needsAudioPermission &&
                !state.needsAccessibilityService &&
                !state.needsLocationPermission &&
                !state.needsGpsEnabled)
    ) {
        return
    }
    val p = RadioLcdTheme.palette

    Dialog(
        onDismissRequest = { onEvent(RadioUiEvent.DismissSetupDialog) },
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(modifier = Modifier.fillMaxSize(), color = p.lcdAlt) {
            Column(modifier = Modifier.fillMaxSize().statusBarsPadding()) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        text = "SETUP REQUIRED",
                        color = p.textPrimary,
                        fontWeight = FontWeight.Bold,
                        fontSize = 20.sp,
                    )
                    TextButton(onClick = { onEvent(RadioUiEvent.DismissSetupDialog) }) {
                        Text("CLOSE", color = p.statusBlue)
                    }
                }
                HorizontalDivider(color = p.divider)
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth()
                        .verticalScroll(rememberScrollState())
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    Text(
                        text = "The radio requires permissions to function correctly.",
                        color = p.textSecondary
                    )

                if (state.needsLocationPermission) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("• LOCATION (GPS)", fontWeight = FontWeight.Bold, color = p.textPrimary)
                        Text(
                            text = "Required so your radio shows on the dispatch map with a current position.",
                            fontSize = 12.sp,
                            color = p.textMuted,
                        )
                        TextButton(
                            onClick = { onEvent(RadioUiEvent.RequestLocationPermission) },
                            colors = androidx.compose.material3.ButtonDefaults.textButtonColors(
                                containerColor = p.softKeyInactiveFill,
                            ),
                        ) {
                            Text("ALLOW LOCATION", color = p.textOnButton)
                        }
                    }
                }

                if (state.needsGpsEnabled) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("• TURN ON GPS", fontWeight = FontWeight.Bold, color = p.textPrimary)
                        Text(
                            text = "Location permission is granted, but phone GPS is off. Turn on Location in Android settings.",
                            fontSize = 12.sp,
                            color = p.textMuted,
                        )
                        TextButton(
                            onClick = { onEvent(RadioUiEvent.OpenGpsSettings) },
                            colors = androidx.compose.material3.ButtonDefaults.textButtonColors(
                                containerColor = p.softKeyInactiveFill,
                            ),
                        ) {
                            Text("OPEN LOCATION SETTINGS", color = p.textOnButton)
                        }
                    }
                }
                
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
                    val context = androidx.compose.ui.platform.LocalContext.current
                    val component = android.content.ComponentName(
                        context,
                        com.securityradio.ptt.device.InricoHardwareService::class.java,
                    )
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("• ACCESSIBILITY SERVICE", fontWeight = FontWeight.Bold, color = p.textPrimary)
                        Text(
                            "Required for physical PTT and Emergency buttons in the background.",
                            fontSize = 12.sp,
                            color = p.textMuted,
                        )
                        if (AccessibilitySettingsLauncher.prefersAdbEnableHint(context)) {
                            Text(
                                "TM-7 Plus on Android 10: Settings often shows an empty list. " +
                                    "Tap the button below first; if there is no toggle, run these two commands " +
                                    "on your PC (USB debugging or scrcpy):",
                                fontSize = 12.sp,
                                color = p.textMuted,
                            )
                            Text(
                                AccessibilitySettingsLauncher.adbEnableBlock(context, component),
                                fontSize = 11.sp,
                                color = p.textPrimary,
                                fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                            )
                        }
                        TextButton(
                            onClick = { onEvent(RadioUiEvent.OpenAccessibilitySettings) },
                            colors = androidx.compose.material3.ButtonDefaults.textButtonColors(containerColor = p.softKeyInactiveFill)
                        ) {
                            Text("OPEN ACCESSIBILITY SETTINGS", color = p.textOnButton)
                        }
                    }
                }
                }
            }
        }
    }
}
