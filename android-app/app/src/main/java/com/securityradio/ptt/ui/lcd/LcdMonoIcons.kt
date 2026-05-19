package com.securityradio.ptt.ui.lcd

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathOperation
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * LCD glyphs stroke at a width proportional to the icon, so they read equally
 * bold whether drawn small on a phone status bar or large on a handset.
 */
private fun DrawScope.lcdStroke(ratio: Float): Stroke =
    Stroke(width = size.minDimension * ratio, cap = StrokeCap.Round)

/** Chunky status-bar glyphs (signal, GPS, Bluetooth, replay, volume, scan). */
private const val STATUS_STROKE = 0.13f

/** Finer detail glyphs (mic, emergency, channel list, day/night). */
private const val GLYPH_STROKE = 0.11f

@Composable
fun LcdSignalBarsIcon(
    bars: Int,
    maxBars: Int,
    colorActive: Color,
    colorInactive: Color,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier) {
        val gap = size.width / (maxBars * 5f)
        val barWidth = (size.width - gap * (maxBars - 1)) / maxBars
        repeat(maxBars) { index ->
            val active = index < bars.coerceIn(0, maxBars)
            val h = size.height * (0.4f + 0.2f * index).coerceAtMost(1f)
            val x = index * (barWidth + gap)
            drawRoundRect(
                color = if (active) colorActive else colorInactive,
                topLeft = Offset(x, size.height - h),
                size = Size(barWidth, h),
                cornerRadius = CornerRadius(barWidth * 0.3f, barWidth * 0.3f),
            )
        }
    }
}

@Composable
fun LcdGpsIcon(
    active: Color,
    muted: Color,
    locked: Boolean,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier) {
        val stroke = lcdStroke(STATUS_STROKE)
        val c = if (locked) active else muted
        val cx = size.width * 0.5f
        val cy = size.height * 0.5f
        val r = size.minDimension * 0.3f
        drawCircle(color = c, radius = r, style = stroke)
        drawLine(
            color = c,
            start = Offset(cx, cy - r * 1.3f),
            end = Offset(cx, cy + r * 1.3f),
            strokeWidth = stroke.width,
            cap = StrokeCap.Round,
        )
        drawLine(
            color = c,
            start = Offset(cx - r * 1.3f, cy),
            end = Offset(cx + r * 1.3f, cy),
            strokeWidth = stroke.width,
            cap = StrokeCap.Round,
        )
    }
}

@Composable
fun LcdScanIcon(
    active: Color,
    muted: Color,
    on: Boolean,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier) {
        val stroke = lcdStroke(STATUS_STROKE)
        val c = if (on) active else muted
        val w = size.width
        val h = size.height
        val path = Path().apply {
            moveTo(w * 0.16f, h * 0.6f)
            lineTo(w * 0.42f, h * 0.3f)
            lineTo(w * 0.58f, h * 0.7f)
            lineTo(w * 0.84f, h * 0.4f)
        }
        drawPath(path, color = c, style = stroke)
    }
}

@Composable
fun LcdMicIcon(
    color: Color,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier) {
        val stroke = lcdStroke(GLYPH_STROKE)
        val cx = size.width * 0.5f
        val bodyW = size.width * 0.4f
        val bodyH = size.height * 0.42f
        val top = size.height * 0.2f
        drawRoundRect(
            color = color,
            topLeft = Offset(cx - bodyW * 0.5f, top),
            size = Size(bodyW, bodyH),
            cornerRadius = CornerRadius(bodyW * 0.5f, bodyW * 0.5f),
            style = stroke,
        )
        drawLine(
            color = color,
            start = Offset(cx, top + bodyH),
            end = Offset(cx, size.height * 0.78f),
            strokeWidth = stroke.width,
            cap = StrokeCap.Round,
        )
        drawLine(
            color = color,
            start = Offset(cx - bodyW * 0.6f, size.height * 0.78f),
            end = Offset(cx + bodyW * 0.6f, size.height * 0.78f),
            strokeWidth = stroke.width,
            cap = StrokeCap.Round,
        )
    }
}

@Composable
fun LcdEmergencyGlyphIcon(
    color: Color,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier) {
        val stroke = lcdStroke(GLYPH_STROKE)
        val w = size.width
        val h = size.height
        val path = Path().apply {
            moveTo(w * 0.5f, h * 0.18f)
            lineTo(w * 0.78f, h * 0.82f)
            lineTo(w * 0.22f, h * 0.82f)
            close()
        }
        drawPath(path, color = color, style = stroke)
        drawLine(
            color = color,
            start = Offset(w * 0.5f, h * 0.38f),
            end = Offset(w * 0.5f, h * 0.58f),
            strokeWidth = stroke.width,
            cap = StrokeCap.Round,
        )
        drawLine(
            color = color,
            start = Offset(w * 0.5f, h * 0.64f),
            end = Offset(w * 0.5f, h * 0.68f),
            strokeWidth = stroke.width,
            cap = StrokeCap.Round,
        )
    }
}

@Composable
fun LcdListChannelIcon(
    color: Color,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier) {
        val stroke = lcdStroke(GLYPH_STROKE)
        val w = size.width
        val h = size.height
        repeat(3) { i ->
            val y = h * (0.28f + i * 0.2f)
            drawLine(
                color = color,
                start = Offset(w * 0.18f, y),
                end = Offset(w * 0.82f, y),
                strokeWidth = stroke.width,
                cap = StrokeCap.Round,
            )
        }
        drawLine(
            color = color,
            start = Offset(w * 0.72f, h * 0.22f),
            end = Offset(w * 0.72f, h * 0.78f),
            strokeWidth = stroke.width,
            cap = StrokeCap.Round,
        )
    }
}

@Composable
fun LcdBluetoothIcon(
    on: Boolean,
    active: Color,
    muted: Color,
    modifier: Modifier = Modifier,
) {
    val c = if (on) active else muted
    Canvas(modifier) {
        val stroke = lcdStroke(STATUS_STROKE)
        val w = size.width
        val h = size.height
        val stemX = w * 0.34f
        val midY = h * 0.5f
        drawCircle(color = c, radius = w * 0.12f, center = Offset(stemX, midY), style = stroke)
        val wing = Path().apply {
            moveTo(stemX + w * 0.1f, midY - h * 0.28f)
            lineTo(w * 0.92f, midY - h * 0.42f)
            lineTo(w * 0.78f, midY)
            lineTo(w * 0.92f, midY + h * 0.42f)
            lineTo(stemX + w * 0.1f, midY + h * 0.28f)
            close()
        }
        drawPath(wing, color = c, style = stroke)
    }
}

/** Circular arrow — a near-closed loop with a bold arrowhead, i.e. "an arrow in a circle". */
@Composable
fun LcdReplayIcon(
    ready: Color,
    muted: Color,
    hasBuffer: Boolean,
    modifier: Modifier = Modifier,
) {
    val c = if (hasBuffer) ready else muted
    Canvas(modifier) {
        val stroke = lcdStroke(STATUS_STROKE)
        val cx = size.width * 0.5f
        val cy = size.height * 0.5f
        val r = size.minDimension * 0.3f
        // Most of a circle, leaving a short gap that the arrowhead closes.
        val startAngle = 120f
        val sweep = 285f
        drawArc(
            color = c,
            startAngle = startAngle,
            sweepAngle = sweep,
            useCenter = false,
            topLeft = Offset(cx - r, cy - r),
            size = Size(r * 2, r * 2),
            style = stroke,
        )
        // Bold filled arrowhead at the arc end, tip pointing along the rotation.
        val endRad = (startAngle + sweep) * PI.toFloat() / 180f
        val ex = cx + cos(endRad) * r
        val ey = cy + sin(endRad) * r
        val tanX = -sin(endRad)
        val tanY = cos(endRad)
        val radX = cos(endRad)
        val radY = sin(endRad)
        val head = size.minDimension * 0.26f
        val arrow = Path().apply {
            moveTo(ex + tanX * head, ey + tanY * head)
            lineTo(ex - tanX * head * 0.35f + radX * head * 0.7f, ey - tanY * head * 0.35f + radY * head * 0.7f)
            lineTo(ex - tanX * head * 0.35f - radX * head * 0.7f, ey - tanY * head * 0.35f - radY * head * 0.7f)
            close()
        }
        drawPath(arrow, color = c)
    }
}

@Composable
fun LcdVolumeIcon(
    muted: Color,
    active: Color,
    isMuted: Boolean,
    modifier: Modifier = Modifier,
) {
    val c = if (isMuted) muted else active
    Canvas(modifier) {
        val stroke = lcdStroke(STATUS_STROKE)
        val w = size.width
        val h = size.height
        val speaker = Path().apply {
            moveTo(w * 0.14f, h * 0.38f)
            lineTo(w * 0.32f, h * 0.38f)
            lineTo(w * 0.5f, h * 0.2f)
            lineTo(w * 0.5f, h * 0.8f)
            lineTo(w * 0.32f, h * 0.62f)
            lineTo(w * 0.14f, h * 0.62f)
            close()
        }
        drawPath(speaker, color = c, style = stroke)
        if (!isMuted) {
            drawArc(
                color = c,
                startAngle = -55f,
                sweepAngle = 70f,
                useCenter = false,
                topLeft = Offset(w * 0.46f, h * 0.3f),
                size = Size(w * 0.3f, h * 0.4f),
                style = stroke,
            )
            drawArc(
                color = c,
                startAngle = -60f,
                sweepAngle = 80f,
                useCenter = false,
                topLeft = Offset(w * 0.5f, h * 0.18f),
                size = Size(w * 0.4f, h * 0.64f),
                style = stroke,
            )
        } else {
            drawLine(
                color = c,
                start = Offset(w * 0.6f, h * 0.32f),
                end = Offset(w * 0.9f, h * 0.72f),
                strokeWidth = stroke.width,
                cap = StrokeCap.Round,
            )
        }
    }
}

@Composable
fun LcdDayNightIcon(
    night: Boolean,
    color: Color,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier) {
        val stroke = lcdStroke(GLYPH_STROKE)
        val cx = size.width * 0.5f
        val cy = size.height * 0.5f
        val r = size.minDimension * 0.38f
        if (night) {
            // Crescent moon: a filled disc with an offset disc subtracted.
            val moon = Path().apply {
                addOval(Rect(cx - r, cy - r, cx + r, cy + r))
            }
            val biteR = r * 1.02f
            val biteCx = cx + r * 0.64f
            val biteCy = cy - r * 0.16f
            val bite = Path().apply {
                addOval(Rect(biteCx - biteR, biteCy - biteR, biteCx + biteR, biteCy + biteR))
            }
            drawPath(
                Path().apply { op(moon, bite, PathOperation.Difference) },
                color = color,
            )
        } else {
            // Sun: a filled disc with eight rays.
            drawCircle(
                color = color,
                radius = r * 0.6f,
                center = Offset(cx, cy),
            )
            repeat(8) { i ->
                val ang = i * 45f * PI.toFloat() / 180f
                val dx = cos(ang)
                val dy = sin(ang)
                drawLine(
                    color = color,
                    start = Offset(cx + dx * r * 0.8f, cy + dy * r * 0.8f),
                    end = Offset(cx + dx * r * 1.12f, cy + dy * r * 1.12f),
                    strokeWidth = stroke.width,
                    cap = StrokeCap.Round,
                )
            }
        }
    }
}
