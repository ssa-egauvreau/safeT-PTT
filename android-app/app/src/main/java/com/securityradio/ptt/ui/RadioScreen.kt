package com.securityradio.ptt.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.securityradio.ptt.presentation.RadioUiEvent
import com.securityradio.ptt.presentation.RadioUiState

/**
 * Outer chrome for the handset shell: safe padding and background.
 */
@Composable
fun RadioShell(
    state: RadioUiState,
    onEvent: (RadioUiEvent) -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 12.dp, vertical = 10.dp),
        ) {
            RadioScreen(state = state, onEvent = onEvent)
        }
    }
}

/**
 * Stateless APX-inspired radio layout. All data flows from [state]; interactions emit [RadioUiEvent].
 */
@Composable
fun RadioScreen(
    state: RadioUiState,
    onEvent: (RadioUiEvent) -> Unit,
    modifier: Modifier = Modifier,
) {
    BoxWithConstraints(modifier = modifier.fillMaxSize()) {
        val isCompact = maxWidth < 420.dp
        val gutter = if (isCompact) 8.dp else 14.dp
        val pttSize = if (isCompact) 96.dp else 120.dp

        Column(
            modifier = Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(gutter),
        ) {
            StatusStrip(state = state)
            RadioFaceplate(
                state = state,
                onEvent = onEvent,
                modifier = Modifier.weight(1f),
            )
            SoftKeyRow(
                labels = state.softKeyLabels,
                onEvent = onEvent,
            )
            ControlDeck(
                state = state,
                onEvent = onEvent,
                pttSize = pttSize,
            )
        }
    }
}

@Composable
private fun StatusStrip(state: RadioUiState) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.65f))
            .border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(10.dp))
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column {
            Text(
                text = state.systemTime,
                style = MaterialTheme.typography.titleMedium,
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = state.networkLabel,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(
                text = "BAT ${state.batteryPercent}%",
                style = MaterialTheme.typography.labelLarge,
                fontFamily = FontFamily.Monospace,
            )
            SignalRow(bars = state.signalBars, maxBars = state.maxSignalBars)
        }
    }
}

@Composable
private fun SignalRow(bars: Int, maxBars: Int) {
    Row(horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.CenterVertically) {
        repeat(maxBars) { index ->
            val active = index < bars.coerceIn(0, maxBars)
            val color = if (active) MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.outline
            val barHeight = (14 - index * 2).coerceAtLeast(4).dp
            Box(
                modifier = Modifier
                    .size(width = 8.dp, height = barHeight)
                    .clip(RoundedCornerShape(2.dp))
                    .background(color),
            )
        }
    }
}

@Composable
private fun RadioFaceplate(
    state: RadioUiState,
    onEvent: (RadioUiEvent) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        ChannelRocker(
            onEvent = onEvent,
            modifier = Modifier
                .widthIn(min = 56.dp, max = 72.dp)
                .fillMaxHeight(),
        )
        CenterDisplay(
            state = state,
            modifier = Modifier
                .weight(1f)
                .fillMaxHeight(),
        )
        EmergencyColumn(
            state = state,
            onEvent = onEvent,
            modifier = Modifier
                .widthIn(min = 72.dp, max = 88.dp)
                .fillMaxHeight(),
        )
    }
}

@Composable
private fun ChannelRocker(
    onEvent: (RadioUiEvent) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surface)
            .border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(12.dp))
            .padding(vertical = 6.dp),
        verticalArrangement = Arrangement.SpaceEvenly,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        HardwareKey(
            label = "CH+",
            onPress = { onEvent(RadioUiEvent.ChannelUp) },
        )
        Text(
            text = "CH",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        HardwareKey(
            label = "CH-",
            onPress = { onEvent(RadioUiEvent.ChannelDown) },
        )
    }
}

@Composable
private fun HardwareKey(
    label: String,
    onPress: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val interaction = remember { MutableInteractionSource() }
    Surface(
        onClick = onPress,
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 6.dp, vertical = 4.dp),
        shape = RoundedCornerShape(8.dp),
        color = MaterialTheme.colorScheme.surfaceVariant,
        interactionSource = interaction,
    ) {
        Text(
            text = label,
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 10.dp),
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
            maxLines = 1,
        )
    }
}

@Composable
private fun CenterDisplay(
    state: RadioUiState,
    modifier: Modifier = Modifier,
) {
    val lcdGradient = Brush.verticalGradient(
        colors = listOf(
            Color(0xFF0F1A14),
            Color(0xFF050806),
        ),
    )
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(16.dp))
            .background(lcdGradient)
            .border(1.dp, Color(0xFF223027), RoundedCornerShape(16.dp))
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.SpaceBetween,
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = state.zoneLabel,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.secondary.copy(alpha = 0.8f),
                fontFamily = FontFamily.Monospace,
            )
            Text(
                text = state.channelPosition,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.secondary.copy(alpha = 0.8f),
                fontFamily = FontFamily.Monospace,
            )
        }
        Text(
            text = state.channelLabel,
            style = MaterialTheme.typography.headlineSmall,
            color = MaterialTheme.colorScheme.secondary,
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.Bold,
        )
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            LcdLine(text = state.displayLine1, fontSize = 18.sp)
            LcdLine(text = state.displayLine2, fontSize = 16.sp)
            LcdLine(text = state.displayLine3, fontSize = 15.sp)
        }
        Text(
            text = state.statusMessage,
            style = MaterialTheme.typography.labelSmall,
            color = if (state.isEmergencyActive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.secondary,
            fontFamily = FontFamily.Monospace,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun LcdLine(text: String, fontSize: TextUnit) {
    Text(
        text = text,
        style = MaterialTheme.typography.bodyMedium.copy(fontSize = fontSize),
        color = MaterialTheme.colorScheme.secondary,
        fontFamily = FontFamily.Monospace,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

@Composable
private fun EmergencyColumn(
    state: RadioUiState,
    onEvent: (RadioUiEvent) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.fillMaxHeight(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = "SOS",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        MomentaryButton(
            label = "EMER",
            baseColor = MaterialTheme.colorScheme.error,
            contentColor = Color.White,
            active = state.isEmergencyActive,
            onPress = { onEvent(RadioUiEvent.EmergencyPressed) },
            onRelease = { onEvent(RadioUiEvent.EmergencyReleased) },
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
        )
    }
}

@Composable
private fun MomentaryButton(
    label: String,
    baseColor: Color,
    contentColor: Color,
    active: Boolean,
    onPress: () -> Unit,
    onRelease: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(12.dp)
    Box(
        modifier = modifier
            .clip(shape)
            .background(if (active) baseColor.copy(alpha = 0.95f) else baseColor.copy(alpha = 0.75f))
            .border(1.dp, baseColor, shape)
            .pointerInput(Unit) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    onPress()
                    waitForUpOrCancellation()
                    onRelease()
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.titleMedium,
            color = contentColor,
            fontWeight = FontWeight.Black,
        )
    }
}

@Composable
private fun SoftKeyRow(
    labels: List<String>,
    onEvent: (RadioUiEvent) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        labels.forEachIndexed { index, label ->
            val interaction = remember { MutableInteractionSource() }
            Surface(
                onClick = { onEvent(RadioUiEvent.SoftKeyPressed(index)) },
                modifier = Modifier
                    .weight(1f)
                    .height(48.dp),
                shape = RoundedCornerShape(10.dp),
                color = MaterialTheme.colorScheme.surface,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
                interactionSource = interaction,
            ) {
                Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) {
                    Text(
                        text = label,
                        style = MaterialTheme.typography.labelLarge,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

@Composable
private fun ControlDeck(
    state: RadioUiState,
    onEvent: (RadioUiEvent) -> Unit,
    pttSize: Dp,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                text = if (state.isPttPressed) "TRANSMITTING" else "RECEIVE",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontFamily = FontFamily.Monospace,
            )
            Text(
                text = "Hold PTT to request airtime",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        PttButton(
            engaged = state.isPttPressed,
            onEvent = onEvent,
            modifier = Modifier.size(pttSize),
        )
    }
}

@Composable
private fun PttButton(
    engaged: Boolean,
    onEvent: (RadioUiEvent) -> Unit,
    modifier: Modifier = Modifier,
) {
    val base = MaterialTheme.colorScheme.primary
    val color = if (engaged) base else base.copy(alpha = 0.65f)
    Box(
        modifier = modifier
            .clip(CircleShape)
            .background(
                brush = Brush.radialGradient(
                    colors = listOf(color, color.copy(alpha = 0.55f)),
                ),
            )
            .border(2.dp, base.copy(alpha = 0.9f), CircleShape)
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
        Text(
            text = "PTT",
            style = MaterialTheme.typography.titleLarge,
            color = MaterialTheme.colorScheme.onPrimary,
            fontWeight = FontWeight.Black,
        )
    }
}
