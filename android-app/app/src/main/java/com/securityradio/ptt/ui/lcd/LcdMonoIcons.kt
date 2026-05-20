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
        // The Bluetooth rune, traced as one continuous stroke: two crossing
        // wings, the central spine, and the pointed top and bottom tips.
        val rune = Path().apply {
            moveTo(w * 0.28f, h * 0.35f)
            lineTo(w * 0.72f, h * 0.65f)
            lineTo(w * 0.5f, h * 0.85f)
            lineTo(w * 0.5f, h * 0.15f)
            lineTo(w * 0.72f, h * 0.35f)
            lineTo(w * 0.28f, h * 0.65f)
        }
        drawPath(rune, color = c, style = stroke)
    }
}

/** Circular arrow — a near-closed loop with a bold arrowhead, i.e. "an arrow in a circle". */
@Composable
fun LcdReplayIcon(
    ready: Color,
    muted: Color,
    playing: Boolean,
    modifier: Modifier = Modifier,
) {
    val c = if (playing) ready else muted
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

/** Speaker glyph: green when [isMuted] is false (e.g. external mic connected), gray when true. */
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

/** Bold "Z" — the zone marker. */
@Composable
fun LcdZoneIcon(
    color: Color,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier) {
        val stroke = lcdStroke(STATUS_STROKE)
        val w = size.width
        val h = size.height
        val z = Path().apply {
            moveTo(w * 0.22f, h * 0.26f)
            lineTo(w * 0.78f, h * 0.26f)
            lineTo(w * 0.22f, h * 0.74f)
            lineTo(w * 0.78f, h * 0.74f)
        }
        drawPath(z, color = color, style = stroke)
    }
}

/** Handheld radio — body, antenna, screen and key — for the channel-position marker. */
@Composable
fun LcdRadioIcon(
    color: Color,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier) {
        val stroke = lcdStroke(STATUS_STROKE)
        val w = size.width
        val h = size.height
        drawRoundRect(
            color = color,
            topLeft = Offset(w * 0.3f, h * 0.34f),
            size = Size(w * 0.4f, h * 0.58f),
            cornerRadius = CornerRadius(w * 0.09f, w * 0.09f),
            style = stroke,
        )
        drawLine(
            color = color,
            start = Offset(w * 0.42f, h * 0.34f),
            end = Offset(w * 0.42f, h * 0.1f),
            strokeWidth = stroke.width,
            cap = StrokeCap.Round,
        )
        drawLine(
            color = color,
            start = Offset(w * 0.38f, h * 0.5f),
            end = Offset(w * 0.62f, h * 0.5f),
            strokeWidth = stroke.width,
            cap = StrokeCap.Round,
        )
        drawCircle(color = color, radius = w * 0.06f, center = Offset(w * 0.5f, h * 0.72f))
    }
}

/** Globe — circle with an equator line and a meridian ellipse — for radios online. */
@Composable
fun LcdGlobeIcon(
    color: Color,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier) {
        val stroke = lcdStroke(STATUS_STROKE)
        val cx = size.width * 0.5f
        val cy = size.height * 0.5f
        val r = size.minDimension * 0.36f
        drawCircle(color = color, radius = r, style = stroke)
        drawLine(
            color = color,
            start = Offset(cx - r, cy),
            end = Offset(cx + r, cy),
            strokeWidth = stroke.width,
        )
        drawOval(
            color = color,
            topLeft = Offset(cx - r * 0.5f, cy - r),
            size = Size(r, r * 2),
            style = stroke,
        )
    }
}

/** Horizontal battery: outline, terminal nub, charge bar that fills with [percent]. */
@Composable
fun LcdBatteryIcon(
    percent: Int,
    outline: Color,
    fillHigh: Color,
    fillLow: Color,
    fillCritical: Color,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier) {
        val stroke = lcdStroke(STATUS_STROKE)
        val w = size.width
        val h = size.height
        val pct = percent.coerceIn(0, 100)
        val bodyRight = w * 0.86f
        val bodyTop = h * 0.1f
        val bodyBottom = h * 0.9f
        val cornerR = h * 0.16f
        drawRoundRect(
            color = outline,
            topLeft = Offset(0f, bodyTop),
            size = Size(bodyRight, bodyBottom - bodyTop),
            cornerRadius = CornerRadius(cornerR, cornerR),
            style = stroke,
        )
        drawRoundRect(
            color = outline,
            topLeft = Offset(bodyRight, h * 0.3f),
            size = Size(w - bodyRight, h * 0.4f),
            cornerRadius = CornerRadius(cornerR * 0.5f, cornerR * 0.5f),
        )
        val inset = stroke.width
        val innerLeft = inset
        val innerTop = bodyTop + inset
        val innerRight = bodyRight - inset
        val innerBottom = bodyBottom - inset
        val span = (innerRight - innerLeft) * (pct / 100f)
        if (span > 0f) {
            val fillColor = when {
                pct < 10 -> fillCritical
                pct < 25 -> fillLow
                else -> fillHigh
            }
            drawRoundRect(
                color = fillColor,
                topLeft = Offset(innerLeft, innerTop),
                size = Size(span, innerBottom - innerTop),
                cornerRadius = CornerRadius(cornerR * 0.45f, cornerR * 0.45f),
            )
        }
    }
}

/** Gear — opens handset settings / button mapping. */
@Composable
fun LcdSettingsIcon(
    color: Color,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier) {
        val stroke = lcdStroke(STATUS_STROKE)
        val cx = size.width * 0.5f
        val cy = size.height * 0.5f
        val rOuter = size.minDimension * 0.34f
        val rInner = size.minDimension * 0.17f
        val teeth = 8
        val toothDepth = size.minDimension * 0.1f
        val path = Path()
        for (i in 0 until teeth * 2) {
            val angle = (i * PI.toFloat() / teeth) - PI.toFloat() / 2f
            val r = if (i % 2 == 0) rOuter + toothDepth else rOuter
            val x = cx + cos(angle) * r
            val y = cy + sin(angle) * r
            if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        path.close()
        drawPath(path, color = color, style = stroke)
        drawCircle(color = color, radius = rInner, center = Offset(cx, cy), style = stroke)
    }
}

/** Filled play triangle for message history. */
@Composable
fun LcdPlayIcon(
    color: Color,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier) {
        val w = size.width
        val h = size.height
        val pad = size.minDimension * 0.18f
        val path = Path().apply {
            moveTo(w * 0.28f, pad)
            lineTo(w * 0.28f, h - pad)
            lineTo(w - pad, h * 0.5f)
            close()
        }
        drawPath(path, color = color)
    }
}
