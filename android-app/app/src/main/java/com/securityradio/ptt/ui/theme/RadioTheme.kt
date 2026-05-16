package com.securityradio.ptt.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val ShellBackground = Color(0xFF0C0D10)
private val ShellSurface = Color(0xFF15171C)
private val AccentAmber = Color(0xFFFFB74D)
private val AccentRed = Color(0xFFE53935)
private val DisplayGreen = Color(0xFF6EE7B7)
private val MutedText = Color(0xFFB0B4BC)

private val RadioDarkScheme = darkColorScheme(
    primary = AccentAmber,
    onPrimary = Color(0xFF1B1204),
    secondary = DisplayGreen,
    onSecondary = Color(0xFF04120C),
    tertiary = AccentRed,
    onTertiary = Color.White,
    background = ShellBackground,
    onBackground = Color(0xFFE6E8EE),
    surface = ShellSurface,
    onSurface = Color(0xFFE6E8EE),
    surfaceVariant = Color(0xFF1F2229),
    onSurfaceVariant = MutedText,
    outline = Color(0xFF3A3F4A),
    error = AccentRed,
    onError = Color.White,
)

@Composable
fun RadioTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = RadioDarkScheme,
        typography = Typography(),
        content = content,
    )
}
